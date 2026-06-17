// index.js — the orchestrator. Run: node src/index.js
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { fetchAll } from './fetcher.js';
import { routeAll } from './router.js';
import {
  summariseAll, selectStories, generateMechanism, generateExplainers, generateMyths,
} from './summarize.js';
import { fetchMarket } from './market.js';
import { buildHTML, writeEdition } from './build.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const STATE_FILE = path.join(__dirname, '..', 'archive', 'seen.json');

// How many stories to carry per section after the editorial cut (~24 total,
// India-first). Now that the build runs ONCE a day it gets the full free-tier daily
// quota, so we carry more news. The Knowledge Desk + curation run first (see main),
// so if the quota throttles, only the tail-end story summaries degrade to raw
// headlines — and even those keep clean titles + free links. Raise further only with
// paid billing on the Gemini key.
const PER_SECTION = { macro: 5, india: 7, sector: 4, global: 4, compliance: 4 };
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

// Procedural noise with no decision value — auction notices/results and daily
// filler. Removed before the AI editor even sees them (cheap, deterministic).
const NOISE = new RegExp([
  'variable rate (repo|reverse repo)', '\\bvrr\\b', '\\bvrrr\\b',
  '(t-bill|treasury bill|g-sec|g\\u2013sec|gsec|sdl|state development loan|dated securities?) auction',
  'auction (of|result|cut-?off|notification)', 'full auction result', 'omo (purchase|sale)',
  "ahead of market", 'things (to know|that will decide)', 'stocks? to watch',
  'quick wrap', 'market wrap', 'trading guide', 'stocks? to buy', '\\d+ stocks?',
  'market talk', 'roundup', "here'?s what", 'what to watch',
].join('|'), 'i');

// generic wrappers — sink them within ranking even if not hard-dropped
const JUNK = /(market talk|roundup|what to watch|things to know|here's what|stocks to watch)/i;

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
  const routed = routeAll(items).filter((it) => !NOISE.test(it.title));

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
  const mechanism = await generateMechanism(topAll);
  const explainers = await generateExplainers(topAll);
  const myths = await generateMyths(topAll);

  // 6) SUMMARISE selected stories, and fetch market data in parallel
  const flat = [...new Set(Object.values(buckets).flat())];
  const [summarised, market] = await Promise.all([
    summariseAll(flat, { leadIds }),
    fetchMarket(),
  ]);
  const byLink = new Map(summarised.map((s) => [s.link, s]));
  const remap = (arr) => arr.map((it) => byLink.get(it.link) || it);
  for (const k of Object.keys(buckets)) buckets[k] = remap(buckets[k]);

  // 7) BUILD + WRITE
  const html = buildHTML({
    ...buckets, market, mechanism, explainers, myths,
    runTime: new Date().toUTCString(),
  });
  const stamp = writeEdition(html, PUBLIC_DIR);

  // 8) persist dedup state + health log
  const allLinks = new Set([...seen, ...summarised.map((s) => s.link.split('?')[0].replace(/\/$/, ''))]);
  saveSeen(allLinks);
  fs.writeFileSync(path.join(PUBLIC_DIR, 'health.json'), JSON.stringify({ ts: new Date().toISOString(), health }, null, 2));

  const counts = Object.entries(buckets).map(([k, v]) => `${k}:${v.length}`).join(' ');
  console.log(`✅ Edition ${stamp} built — ${counts} — ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}

main().catch((e) => { console.error('FATAL:', e); process.exit(1); });
