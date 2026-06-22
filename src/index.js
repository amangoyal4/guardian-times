// index.js — the orchestrator. Run: node src/index.js
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { fetchAll, dedupeBuckets } from './fetcher.js';
import { routeAll } from './router.js';
import {
  summariseAll, selectStories, generateMechanism, generateExplainers, generateMyths,
  curateLibrary,
} from './summarize.js';
import { fetchMarket } from './market.js';
import { fetchLibrary } from './library.js';
import { buildHTML, writeEdition } from './build.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const STATE_FILE = path.join(__dirname, '..', 'archive', 'seen.json');
// Library has its own rolling seen-state so videos/podcasts shown in recent
// editions rotate OUT — without this the same evergreen videos resurface daily
// (the feeds change slowly). Kept separate from the news seen.json.
const LIB_STATE = path.join(__dirname, '..', 'archive', 'seen-library.json');

// How many stories to carry per section after the editorial cut (~24 total,
// India-first). Now that the build runs ONCE a day it gets the full free-tier daily
// quota, so we carry more news. The Knowledge Desk + curation run first (see main),
// so if the quota throttles, only the tail-end story summaries degrade to raw
// headlines — and even those keep clean titles + free links. Raise further only with
// paid billing on the Gemini key.
const PER_SECTION = { macro: 6, india: 8, sector: 5, global: 5, compliance: 4 };
// larger pool handed to the AI editor so it has room to choose
const POOL = 40;

function loadSeen() {
  try { return new Set(JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'))); }
  catch { return new Set(); }
}
function saveSeen(links) {
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  // keep last ~500 links so the dedup window doesn't grow forever
  fs.writeFileSync(STATE_FILE, JSON.stringify([...links].slice(-500)));
}

// ---- Library anti-repetition: rolling seen-state for videos + podcasts ----
// A stable key per item. YouTube items key on the videoId (the watch link carries
// a ?v= query that must NOT be stripped); everything else keys on the link sans
// fragment. Used to push recently-shown items to the back of the candidate pool.
function libKey(x) {
  if (x?.videoId) return `yt:${x.videoId}`;
  const m = (x?.link || '').match(/[?&]v=([^&]+)/);
  if (m) return `yt:${m[1]}`;
  return (x?.link || '').split('#')[0];
}
function loadSeenLib() {
  try { return new Set(JSON.parse(fs.readFileSync(LIB_STATE, 'utf8'))); }
  catch { return new Set(); }
}
function saveSeenLib(prev, library) {
  fs.mkdirSync(path.dirname(LIB_STATE), { recursive: true });
  const fresh = [
    ...(library?.videos || []).map(libKey),
    ...(library?.podcast ? [libKey(library.podcast)] : []),
  ].filter(Boolean);
  // keep last ~150 keys: enough to rotate a few weeks of editions out, small
  // enough that the pool never starves of "unseen" candidates.
  const merged = [...prev, ...fresh];
  fs.writeFileSync(LIB_STATE, JSON.stringify(merged.slice(-150)));
}
// Reorder the candidate pool so items NOT shown recently come first, preserving
// recency order within each partition. The curator (and its fallback) then
// naturally favour fresh content, while still being able to reach back to a
// recently-shown item if the unseen pool is thin.
function preferUnseen({ videos = [], podcasts = [] } = {}, seen) {
  const split = (arr) => {
    const unseen = [], shown = [];
    for (const x of arr) (seen.has(libKey(x)) ? shown : unseen).push(x);
    return [...unseen, ...shown];
  };
  return { videos: split(videos), podcasts: split(podcasts) };
}

// Procedural noise with no decision value — auction notices/results and daily
// filler. Removed before the AI editor even sees them (cheap, deterministic).
const NOISE = new RegExp([
  'variable rate (repo|reverse repo)', '\\bvrr\\b', '\\bvrrr\\b',
  '(t-bill|treasury bill|g-sec|g\\u2013sec|gsec|sdl|state development loan|dated securities?) auction',
  'auction (of|result|cut-?off|notification)', 'full auction result', 'omo (purchase|sale)',
  "ahead of market", 'things (to know|that will decide)', 'stocks? to watch',
  'quick wrap', 'market wrap', 'trading guide', 'stocks? to buy', '\\d+ stocks?',
  'market talk', 'roundup', "here'?s what", 'what to watch',
  // Pre-market index "preview" filler — these are recurring daily noise (often
  // several near-identical copies from different papers that even contradict each
  // other: "cautious"/"flat"/"gap-down"). No lasting decision value. NOTE: this
  // targets the GIFT NIFTY index signal, NOT genuine GIFT City / IFSCA regulatory
  // news (which says "GIFT City"/"IFSC", never "GIFT Nifty").
  'gift\\s*nifty',
  'signals?\\s+(a\\s+)?(flat|cautious|gap-?up|gap-?down|positive|negative|subdued|muted|tepid|weak|strong|higher|lower|range-?bound)',
  '(flat|gap-?up|gap-?down|cautious|tepid|muted|subdued|range-?bound)\\s+(open|opening|start)',
  '(sensex|nifty|markets?|d-?street|dalal street)[^.]{0,25}(gap-?up|gap-?down)',
  // US regulatory micro-filings — insider-sale/ownership notices that leak in via
  // global wires. Pure noise for this audience.
  '\\bform\\s?144\\b', '\\bform\\s?4\\b', '\\bform\\s?8-?k\\b', '\\b13[fdg]\\b',
  'schedule 13[dg]', 'sec filing',
].join('|'), 'i');

// generic wrappers — sink them within ranking even if not hard-dropped
const JUNK = /(market talk|roundup|what to watch|things to know|here's what|stocks to watch)/i;

// IRRELEVANT non-financial noise that leaks in from the wider wires and has NO
// decision value for an Indian wealth/PMS audience. These slipped into the live
// edition (e.g. "AI-Powered GTA 6 Beta Scams Target Gamers", "UK Companies House
// Strikes Off 50 Film Production Firms", "Ebbw Vale: Brexit's Unfulfilled Promise")
// because they carry stray finance-ish tokens (scam, firms, companies) that the
// keyword router can't tell apart from real market news. Hard-drop them before the
// editor even sees them. Kept deliberately specific so it never eats real stories.
const IRRELEVANT = new RegExp([
  // consumer-tech / gaming / scams aimed at the public, not markets
  '\\bgta\\s?6?\\b', 'grand theft auto', 'video\\s?game', '\\bgamers?\\b', '\\bgaming\\b',
  'beta scam', 'phishing', 'romance scam', 'crypto scam', 'giveaway scam', 'whatsapp scam',
  // company-registry / administrative filler (UK Companies House strike-offs etc.)
  // NB: deliberately NOT a bare "strikes off" — a REGULATOR striking off a rule/
  // entity is real compliance news; we anchor on the registry/film-firm context.
  'companies house', 'dissolved compan', 'dormant compan',
  'film production', 'production firm', 'shell compan',
  // regional political / human-interest colour with no market read-through
  'brexit', 'ebbw vale', "unfulfilled promise", 'cost of living crisis',
  // lifestyle / celebrity / entertainment that occasionally rides finance feeds
  'box office', 'celebrity', 'royal family', 'football', 'cricket score', 'horoscope', 'astrolog',
].join('|'), 'i');

// War / geopolitics / diplomacy as GENERAL news has no place here — but the same
// event with a clear MONEY angle (oil spiking on a conflict, the rupee sliding,
// defence orders) absolutely does. So drop a headline only when it reads as pure
// geopolitics AND carries no financial signal. The AI editor-cut applies the same
// "is the financial impact the primary context?" judgement; this is the deterministic
// backstop for when the AI falls back (e.g. quota throttle).
const WAR = /(\bwar\b|warfare|missile|air\s?strike|drone strike|\btroops?\b|ceasefire|militar(?:y|ia)|nuclear (?:talks|deal|programme|program|weapon)|negotiator|diplomat|pentagon|\bnato\b|airbase|warship|hostage|invasion|\bcoup\b|peace talks)/i;
const FIN = /(stock|share|equit|market|index|nifty|sensex|rupee|dollar|currency|\boil\b|crude|brent|gold|metal|yield|bond|inflation|\bgdp\b|\brate\b|earnings|\bipo\b|\bfund\b|investor|tariff|export|import|commodit|price|rally|plunge|surge|\btrade\b|\bfii\b|\bdii\b|revenue|profit|defen[cs]e (?:stock|order|deal|contract))/i;
const isPureGeopolitics = (t = '') => WAR.test(t) && !FIN.test(t);

function score(it) {
  const t = it.published?.getTime() || 0;
  return t + it.weight * 3.6e6 - (JUNK.test(it.title) ? 1e15 : 0);
}

// Indian stories first (newest + higher feed weight within each region block).
function rank(items) {
  return [...items].sort((a, b) => {
    if (!!a.isIndian !== !!b.isIndian) return a.isIndian ? -1 : 1;
    return score(b) - score(a);
  });
}

async function main() {
  const t0 = Date.now();
  const seen = loadSeen();

  // 1) FETCH
  const { items, health } = await fetchAll({ hours: 24, seenLinks: seen });

  // 2) ROUTE + TAG, then drop hard procedural noise
  const routed = routeAll(items).filter(
    (it) => !NOISE.test(it.title) && !IRRELEVANT.test(it.title) && !isPureGeopolitics(it.title),
  );

  // 3) BUILD CANDIDATE POOLS (ranked, generous) per section
  const pools = { macro: [], sector: [], india: [], global: [], compliance: [] };
  for (const it of routed) (pools[it.section] || pools.india).push(it);
  for (const k of Object.keys(pools)) pools[k] = rank(pools[k]).slice(0, POOL);

  // 4) EDITORIAL CUT — AI picks the important stories; ranking is the fallback
  const byLinkAll = new Map(routed.map((it) => [it.link, it]));
  const picks = await selectStories(pools, Math.max(...Object.values(PER_SECTION)));
  const buckets = {};
  for (const k of Object.keys(pools)) {
    if (picks && picks[k]?.length) {
      const chosen = picks[k].map((id) => byLinkAll.get(id)).filter(Boolean);
      buckets[k] = rank(chosen).slice(0, PER_SECTION[k]);
    } else {
      buckets[k] = pools[k].slice(0, PER_SECTION[k]);
    }
  }

  // lead stories (first of each section) get the longer AI treatment + chart
  const leadIds = new Set(Object.values(buckets).map((arr) => arr[0]?.link).filter(Boolean));

  // 5) KNOWLEDGE DESK FIRST — mechanism + explainers + myth-busters.
  // These need only the selected headlines (available pre-summary), so we run
  // them BEFORE the bulk of story summaries. On the free tier the daily quota is
  // the ceiling; spending it on the high-value desk + curation first means a
  // throttle only degrades tail-end story summaries, never the Knowledge Desk.
  // Sequential (not Promise.all) to stay under the per-minute limit.
  const topAll = rank([...new Set(Object.values(buckets).flat())]).slice(0, 14);
  // Kick off the Library RSS fetch now (network-only) so it overlaps with the AI
  // calls below; we await it just before curating.
  const libraryPromise = fetchLibrary();
  const mechanism = await generateMechanism(topAll);
  const explainers = await generateExplainers(topAll);
  const myths = await generateMyths(topAll);
  // Library curation — ONE Gemini call, kept in the protected pre-summary block so a
  // quota throttle degrades only tail story summaries; it falls back to a recency
  // pick with feed descriptions if the AI is unavailable. We reorder the pool so
  // items shown in recent editions sink to the back (anti-repetition), then record
  // today's picks after the build.
  const seenLib = loadSeenLib();
  const library = await curateLibrary(preferUnseen(await libraryPromise, seenLib));

  // 6) SUMMARISE selected stories, and fetch market data in parallel
  const flat = [...new Set(Object.values(buckets).flat())];
  const [summarised, market] = await Promise.all([
    summariseAll(flat, { leadIds }),
    fetchMarket(),
  ]);
  const byLink = new Map(summarised.map((s) => [s.link, s]));
  const remap = (arr) => arr.map((it) => byLink.get(it.link) || it);
  for (const k of Object.keys(buckets)) buckets[k] = remap(buckets[k]);

  // 6b) FINAL CROSS-SECTION DEDUP on the AI-rewritten headlines. Fetch-time dedup ran
  // on raw titles and the editor-cut dedups only within a section, so the same story
  // filed in two sections (or rewritten into near-identical headlines) can survive to
  // here. This last pass spans all sections in display order, keeping the first copy.
  const SECTION_ORDER = ['macro', 'sector', 'india', 'global', 'compliance'];
  const beforeCt = Object.values(buckets).reduce((n, a) => n + a.length, 0);
  const dedupedBuckets = dedupeBuckets(buckets, SECTION_ORDER);
  for (const k of Object.keys(buckets)) buckets[k] = dedupedBuckets[k] || [];
  const afterCt = Object.values(buckets).reduce((n, a) => n + a.length, 0);
  if (afterCt < beforeCt) console.log(`  ✂ cross-section dedup removed ${beforeCt - afterCt} near-duplicate(s)`);

  // 7) BUILD + WRITE
  const html = buildHTML({
    ...buckets, market, mechanism, explainers, myths, library,
    runTime: new Date().toUTCString(),
  });
  const stamp = writeEdition(html, PUBLIC_DIR);

  // 8) persist dedup state + health log
  const allLinks = new Set([...seen, ...summarised.map((s) => s.link.split('?')[0].replace(/\/$/, ''))]);
  saveSeen(allLinks);
  saveSeenLib(seenLib, library); // record today's Library picks so they rotate out
  fs.writeFileSync(path.join(PUBLIC_DIR, 'health.json'), JSON.stringify({ ts: new Date().toISOString(), health }, null, 2));

  const counts = Object.entries(buckets).map(([k, v]) => `${k}:${v.length}`).join(' ');
  console.log(`✅ Edition ${stamp} built — ${counts} — ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}

main().catch((e) => { console.error('FATAL:', e); process.exit(1); });
