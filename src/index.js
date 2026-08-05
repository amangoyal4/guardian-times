// index.js — the orchestrator. Run: node src/index.js
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { fetchAll, dedupeBuckets } from './fetcher.js';
import { routeAll } from './router.js';
import {
  summariseAll, selectStories, generateMechanism, generateExplainers, generateMyths,
  curateLibrary, generateBriefingScript,
} from './summarize.js';
import { fetchMarket } from './market.js';
import { fetchLibrary } from './library.js';
import { attachFullText } from './article.js';
import { synthesizeBriefing } from './tts.js';
import { fetchManagerInterviews } from './fund-managers.js';
import { buildHTML, writeEdition } from './build.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const STATE_FILE = path.join(__dirname, '..', 'archive', 'seen.json');
// Rolling record of the last few editions' headlines — fed back into the editor's
// cut so recurring macro themes (rupee/crude/bonds) don't repeat day after day.
const RECENT_FILE = path.join(__dirname, '..', 'archive', 'recent-coverage.json');
// Library has its own rolling seen-state so videos/podcasts shown in recent
// editions rotate OUT — without this the same evergreen videos resurface daily
// (the feeds change slowly). Kept separate from the news seen.json.
const LIB_STATE = path.join(__dirname, '..', 'archive', 'seen-library.json');
// Last-good Library candidate pool. YouTube's Atom feeds are flaky from CI
// datacenter IPs (intermittent 429/403 → 0 videos), which left the Library blank
// some days. We cache the pool on every good fetch and reuse it when a fetch comes
// back empty, so the desk always has content; the rotation logic still varies the
// picks day to day. The cache can also be SEEDED locally (where YouTube isn't
// blocked) and committed — see scripts/seed-library.js.
const LIB_POOL = path.join(__dirname, '..', 'archive', 'library-pool.json');
// Last-good Fund Manager interviews — reused if the YouTube Data API fails a run.
const MGR_POOL = path.join(__dirname, '..', 'archive', 'managers-pool.json');

// How many stories to carry per section after the editorial cut (~24 total,
// India-first). Now that the build runs ONCE a day it gets the full free-tier daily
// quota, so we carry more news. The Knowledge Desk + curation run first (see main),
// so if the quota throttles, only the tail-end story summaries degrade to raw
// headlines — and even those keep clean titles + free links. Raise further only with
// paid billing on the Gemini key.
// macro trimmed 9→6: it's the section that recurs (rupee/crude/bonds), so a
// tighter, more DIVERSE macro reads fresher and trims cost. Other sections carry
// genuinely distinct daily news, so they stay fuller.
const PER_SECTION = { macro: 6, india: 10, sector: 8, global: 6, compliance: 5 };
// larger pool handed to the AI editor so it has room to choose
const POOL = 50;

function loadSeen() {
  try { return new Set(JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'))); }
  catch { return new Set(); }
}
function saveSeen(links) {
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  // keep last ~500 links so the dedup window doesn't grow forever
  fs.writeFileSync(STATE_FILE, JSON.stringify([...links].slice(-500)));
}

// ---- Cross-day THEME memory (anti-repetition) ----
// seen.json dedups by LINK, but the same macro THEME (rupee level, crude move,
// bond yields) returns every day via a NEW link, so link-dedup can't catch it —
// that's why macro felt like the same paper each morning. We record the headlines
// each edition actually ran (macro + global emphasised, since those recur most)
// and feed the last few days back into the editor's cut so it can deliberately
// avoid re-running a theme unless there's genuinely new information.
function loadRecent() {
  try { return JSON.parse(fs.readFileSync(RECENT_FILE, 'utf8')); }
  catch { return []; }
}
function saveRecent(prev, buckets) {
  fs.mkdirSync(path.dirname(RECENT_FILE), { recursive: true });
  const hs = (arr) => (arr || []).map((x) => x.headline || x.title).filter(Boolean);
  const today = { macro: hs(buckets.macro), global: hs(buckets.global), india: hs(buckets.india), sector: hs(buckets.sector) };
  const merged = [...prev, today].slice(-4); // last 4 editions is enough to spot "same all week"
  fs.writeFileSync(RECENT_FILE, JSON.stringify(merged));
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
// Force the Library to ROTATE day to day. Reordering alone wasn't enough — the AI
// curator kept re-picking its same favourites — so we now HARD-EXCLUDE recently-shown
// items whenever a healthy unseen pool remains, only falling back to shown items when
// the unseen pool is too thin to fill the desk. With ~40 videos in the window and 6
// shown per day, this yields ~a week of fresh libraries before anything recurs.
function preferUnseen({ videos = [], podcasts = [] } = {}, seen) {
  const split = (arr, keepMin) => {
    const unseen = [], shown = [];
    for (const x of arr) (seen.has(libKey(x)) ? shown : unseen).push(x);
    return unseen.length >= keepMin ? unseen : [...unseen, ...shown];
  };
  return { videos: split(videos, 10), podcasts: split(podcasts, 2) };
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
  // Daily tip-sheet / preview filler. These all appeared in a live edition on
  // 2026-07-20 and are exactly what the AI editor is told to drop — but the
  // deterministic list had no pattern for them, so they sailed through when the
  // AI fell back. Anchored tightly so real news is never caught.
  'pre-?market', 'trade setup', 'stocks? in news', 'watch\\s?list',
  'stock (recommendations?|picks?)', 'recommends? (a |the )?(one|two|three|four|five|six|\\d+) stocks?',
  'week ahead', 'buy or sell', 'hot stocks?', 'technical (view|picks?)',
  '(top|best) \\d+ (stocks?|picks?)', 'golden rules?',
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

// Ordinary CRIME / police-blotter & personality news. The AI editor is explicitly
// told to drop these, but there was NO deterministic pattern for them — which is
// how "Andrew, Tristan Tate arrested on new charges of rape, trafficking" reached
// a live edition (2026-07-20) once the AI fell back on a quota failure.
// Deliberately anchored on VIOLENT / PERSONAL crime and individual court outcomes,
// NOT on financial-regulatory enforcement: a SEBI penalty, an RBI fine, a debarment
// or a settlement order is real compliance news and must still get through.
const CRIME = new RegExp([
  // "arrested"/"shooting" need care: markets copy uses them as metaphors
  // ("RBI arrested the rupee slide", "gold shooting higher"). The lookahead keeps
  // the crime sense and lets the metaphor through.
  '\\barrested\\b(?!\\s+(the|a|an|its|his|her|their)\\b)', '\\barrests\\b',
  'mass shooting', 'shooting incident', '\\bshot dead\\b',
  '\\brape\\b', '\\brapist\\b', '\\bsex(ual)? (assault|abuse|misconduct|offence)',
  '\\btrafficking\\b', '\\bmolest', '\\bmurder', '\\bhomicide\\b', '\\bmanslaughter\\b',
  '\\bkidnap', '\\bextradit', '\\bjailed\\b', '\\bsentenced to\\b', '\\bconvicted\\b',
  '\\bpaedophil', '\\bpedophil', '\\bstabb', '\\bassaulted\\b',
].join('|'), 'i');

// TEMPORARY topic mute (user request 2026-08-04): no FCNR / NRI-deposit news for a
// month. REMOVE THIS BLOCK after ~2026-09-04 to let the topic back in.
const TEMP_MUTE = /\bfcnr\b|fcnr\s*\(b\)|foreign\s+currency\s+non-?resident|\bnri\b\s+deposit/i;

// STALE-ARTICLE guard. Some feeds re-surface OLD articles with a fresh pubDate, so the
// recency window alone can't catch them (e.g. a Dec-2025 RBI MPC piece appearing in
// Aug 2026). But many news URLs embed the article's OWN date — .../december-2025-...,
// .../2025/03/... — so if the URL clearly encodes a date older than ~75 days, drop it.
// Only fires on explicit month-year or /YYYY/MM/ patterns, so bare-year slugs like
// "budget-2025" (legit current commentary) are NOT dropped.
const MONTHS = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
function urlDate(url = '') {
  const u = url.toLowerCase();
  let m = u.match(/\/(20\d{2})[/\-](0[1-9]|1[0-2])[/\-]/); // /2025/03/ or /2025-03-
  if (m) return Date.UTC(+m[1], +m[2] - 1, 1);
  m = u.match(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*[-_](20\d{2})\b/); // december-2025
  if (m) return Date.UTC(+m[2], MONTHS[m[1]], 1);
  m = u.match(/\b(20\d{2})[-_](jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\b/); // 2025-december
  if (m) return Date.UTC(+m[1], MONTHS[m[2]], 1);
  return null;
}
const isStaleByUrl = (url) => { const t = urlDate(url); return t ? (Date.now() - t) > 75 * 86400 * 1000 : false; };

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
  // Paywalled stories sink below every free story (penalty >> the 48h recency
  // spread) but stay above hard JUNK — so the deterministic fallback ordering,
  // section leads, and mechanism input are all free-first too.
  return t + it.weight * 3.6e6 - (JUNK.test(it.title) ? 1e15 : 0) - (it.paywalled ? 1e10 : 0);
}

// Indian stories first (newest + higher feed weight within each region block).
function rank(items) {
  return [...items].sort((a, b) => {
    if (!!a.isIndian !== !!b.isIndian) return a.isIndian ? -1 : 1;
    return score(b) - score(a);
  });
}

// Host Instagram/LinkedIn/Facebook thumbnails LOCALLY (public/thumbs/) so they can't
// expire (their signed CDN URLs 403 within ~2h). Key resilience rules, learned the
// hard way:
//   • CAPTURE-ONCE-AND-KEEP: the file is named by a hash of the video link, so once
//     an image is saved it is REUSED on every later build and never re-fetched — a
//     flaky source (microlink is unreliable) or an expired URL can no longer lose it.
//   • NEVER prune a thumbnail whose video is still in the edition. Pruning only
//     removes files for videos that have dropped out (true orphans). (The earlier bug
//     pruned good thumbs whenever that day's fetch failed.)
//   • Best-effort fetch with retries; if it can't be captured, the card shows the
//     branded placeholder — for a GUARANTEED image, put a thumbnail URL in the sheet.
async function localizeThumbs(videos, dir) {
  const NEEDS = /Instagram|LinkedIn|Facebook/i; // platforms whose thumbnails must be re-hosted
  const tdir = path.join(dir, 'thumbs');
  fs.mkdirSync(tdir, { recursive: true });
  const keep = new Set();
  for (const v of videos || []) {
    if (!NEEDS.test(v.platform || '')) continue; // YouTube/Vimeo hosts are durable — leave as-is
    const name = `lib-${crypto.createHash('md5').update(v.link).digest('hex').slice(0, 12)}.jpg`;
    const fpath = path.join(tdir, name);
    if (fs.existsSync(fpath)) { v.thumb = `thumbs/${name}`; keep.add(name); continue; } // reuse — capture-once
    if (v.thumb && /^https?:/i.test(v.thumb)) {
      let ok = false;
      for (let t = 0; t < 3 && !ok; t++) {
        try {
          const res = await fetch(v.thumb, { redirect: 'follow' });
          if (res.ok) {
            const buf = Buffer.from(await res.arrayBuffer());
            if (buf.length > 500) { fs.writeFileSync(fpath, buf); v.thumb = `thumbs/${name}`; keep.add(name); ok = true; }
          }
        } catch {}
        if (!ok) await new Promise((r) => setTimeout(r, 800));
      }
      if (!ok) { v.thumb = ''; console.log(`   ⚠ couldn't capture ${v.platform} thumbnail — placeholder (add a thumbnail URL in the sheet for a guaranteed image)`); }
    } else {
      v.thumb = ''; // no source at all → placeholder
    }
  }
  // Prune ONLY orphans (files whose video is no longer shown). Never touch a kept one.
  try { for (const f of fs.readdirSync(tdir)) if (/^lib-.*\.jpg$/.test(f) && !keep.has(f)) fs.unlinkSync(path.join(tdir, f)); } catch {}
}

async function main() {
  const t0 = Date.now();
  const seen = loadSeen();

  // 1) FETCH
  // Fetch a 48h window. Macro/Sector/Compliance (slow-moving) use the full window for
  // depth; India single-stocks and Global are trimmed back to 24h below to stay fresh.
  const { items, health } = await fetchAll({ hours: 48, seenLinks: seen });

  // 2) ROUTE + TAG, then drop hard procedural noise
  const routed = routeAll(items).filter(
    (it) =>
      !NOISE.test(it.title) &&
      !IRRELEVANT.test(it.title) &&
      !CRIME.test(it.title) &&
      !TEMP_MUTE.test(it.title) &&
      !isStaleByUrl(it.link) &&
      !isPureGeopolitics(it.title),
  );

  // 3) BUILD CANDIDATE POOLS (ranked, generous) per section
  const pools = { macro: [], sector: [], india: [], global: [], compliance: [] };
  const NOW = Date.now();
  const FRESH_MS = 24 * 3600 * 1000; // India stocks + Global must stay last-24h fresh
  for (const it of routed) {
    const sec = pools[it.section] ? it.section : 'india';
    if ((sec === 'india' || sec === 'global') && it.published && (NOW - it.published.getTime()) > FRESH_MS) continue;
    pools[sec].push(it);
  }
  for (const k of Object.keys(pools)) pools[k] = rank(pools[k]).slice(0, POOL);

  // 4) EDITORIAL CUT — AI picks the important stories; ranking is the fallback.
  // Feed the last few editions' macro/global headlines in so the cut can avoid
  // re-running the same recurring themes (the "same news every day" problem).
  const recent = loadRecent();
  const recentDigest = recent
    .flatMap((e) => [...(e.macro || []), ...(e.global || [])])
    .slice(-50)
    .map((h) => `- ${h}`)
    .join('\n');
  const byLinkAll = new Map(routed.map((it) => [it.link, it]));
  const picks = await selectStories(pools, Math.max(...Object.values(PER_SECTION)), { recentlyCovered: recentDigest });
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
  const topAll = rank([...new Set(Object.values(buckets).flat())]).slice(0, 18);
  // Kick off the Library RSS fetch now (network-only) so it overlaps with the AI
  // calls below; we await it just before curating.
  const libraryPromise = fetchLibrary();
  // Fund-manager interviews fetch (YouTube Data API) — network-only, runs in parallel.
  const managersPromise = fetchManagerInterviews();
  const mechanism = await generateMechanism(topAll);
  // Knowledge Desk is Mechanism-only now (removes the explainers + myths AI calls to
  // trim cost and keep the desk focused). Pass empty arrays so the section renders
  // just the mechanism (knowledgePage handles empty gracefully).
  const explainers = [];
  const myths = [];
  // Library curation — ONE Gemini call, kept in the protected pre-summary block so a
  // quota throttle degrades only tail story summaries; it falls back to a recency
  // pick with feed descriptions if the AI is unavailable. We reorder the pool so
  // items shown in recent editions sink to the back (anti-repetition), then record
  // today's picks after the build.
  const libPool = await libraryPromise;
  // Library is our OWN curated IP videos (Google Sheet / manifest). Podcast of the day
  // was removed 2026-07-28. Show the newest few.
  const library = {
    videos: (libPool.videos || []).slice(0, 6),
  };
  // Instagram/LinkedIn/Facebook thumbnails are SIGNED CDN URLs that expire within
  // hours — embedding them means the image 403s by the time a reader opens the page
  // (→ placeholder). So download those images at build time and host them on our own
  // site (public/thumbs/), which never expires. YouTube (i.ytimg) URLs are durable
  // and left as-is.
  await localizeThumbs(library.videos, PUBLIC_DIR);

  // Fund Manager Interviews — resilient like the Library: cache the last-good set and
  // reuse it if the YouTube Data API returns nothing (or the key is missing) this run.
  let managers = await managersPromise;
  if (managers.length) {
    try { fs.writeFileSync(MGR_POOL, JSON.stringify(managers)); } catch {}
  } else {
    try {
      const cached = JSON.parse(fs.readFileSync(MGR_POOL, 'utf8'));
      if (cached.length) { managers = cached; console.log(`   ↻ Fund-manager feed empty — reusing last-good (${cached.length} interviews)`); }
    } catch {}
  }

  // 6) SUMMARISE selected stories, and fetch market data in parallel.
  // Lead stories first get their FULL article text fetched (best-effort) so the
  // chart engine can re-create the publisher's graph data — including the historical
  // figures the RSS snippet drops — as our own house-style SVG. Article fetch
  // overlaps with the market fetch; summaries run once enrichment is done.
  const flat = [...new Set(Object.values(buckets).flat())];
  const [summarised, market] = await Promise.all([
    attachFullText(flat, leadIds).then(() => summariseAll(flat, { leadIds })),
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

  // 6c) MORNING AUDIO BRIEFING — important stories only (~8 min), AI-scripted for the
  // ear, then voiced by a natural Indian anchor (Gemini TTS) into a single MP3 the
  // page plays. Best-effort: if the script or the voice fails, the page falls back to
  // the browser's Web Speech voice reading whatever script we have. We take the top
  // few per section (the editor's most important picks) and let the script writer
  // curate down to the ~10-13 that truly matter.
  const BRIEF_ORDER = ['macro', 'india', 'sector', 'global', 'compliance'];
  const briefingInput = BRIEF_ORDER.flatMap((s) => (buckets[s] || []).slice(0, 4));
  const weekday = new Date().toLocaleDateString('en-GB', { weekday: 'long', timeZone: 'Asia/Kolkata' });
  const { text: audioScript, titles: chapterTitles } = await generateBriefingScript(briefingInput, { weekday });
  let audioFile = '';
  let audioTiming = null; // per-chunk timing for accurate audio chapters (null → word estimate)
  if (audioScript) {
    const voice = await synthesizeBriefing(audioScript);
    if (voice && voice.mp3) {
      fs.mkdirSync(PUBLIC_DIR, { recursive: true });
      fs.writeFileSync(path.join(PUBLIC_DIR, 'briefing.mp3'), voice.mp3);
      audioFile = `briefing.mp3?v=${Date.now()}`; // cache-bust so today's voice isn't stale-cached
      audioTiming = voice.timing || null;
    }
  }

  // 7) BUILD + WRITE
  const html = buildHTML({
    ...buckets, market, mechanism, explainers, myths, library, managers,
    audioScript, audioFile, chapterTitles, audioTiming,
    runTime: new Date().toUTCString(),
  });
  const stamp = writeEdition(html, PUBLIC_DIR);

  // 8) persist dedup state + health log
  const allLinks = new Set([...seen, ...summarised.map((s) => s.link.split('?')[0].replace(/\/$/, ''))]);
  saveSeen(allLinks);
  saveRecent(recent, buckets); // record today's headlines for tomorrow's anti-repetition
  fs.writeFileSync(path.join(PUBLIC_DIR, 'health.json'), JSON.stringify({ ts: new Date().toISOString(), health }, null, 2));

  const counts = Object.entries(buckets).map(([k, v]) => `${k}:${v.length}`).join(' ');
  console.log(`✅ Edition ${stamp} built — ${counts} — ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}

// Force a clean exit once the build's work is done. main() writes every file
// synchronously before it resolves, so exiting here is safe — and it prevents the
// process from hanging on a lingering open handle (e.g. an undici keep-alive
// socket or a pending fetch timer), which previously left the CI step "running"
// for ~27 min after the edition was already built, so commit/deploy never ran.
main()
  .then(() => process.exit(0))
  .catch((e) => { console.error('FATAL:', e); process.exit(1); });
