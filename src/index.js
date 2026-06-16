// index.js — the orchestrator. Run: node src/index.js
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { fetchAll } from './fetcher.js';
import { routeAll } from './router.js';
import { summariseAll, generateMechanism, generateMyths } from './summarize.js';
import { buildHTML, writeEdition } from './build.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const STATE_FILE = path.join(__dirname, '..', 'archive', 'seen.json');

// how many stories to carry per section (lead + supporting)
const PER_SECTION = { macro: 6, india: 6, sector: 6, global: 6, compliance: 7 };
const WATCH_MAX = 12;

function loadSeen() {
  try { return new Set(JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'))); }
  catch { return new Set(); }
}
function saveSeen(links) {
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  // keep last ~500 links so the dedup window doesn't grow forever
  fs.writeFileSync(STATE_FILE, JSON.stringify([...links].slice(-500)));
}

function rank(items) {
  // newest + higher feed weight float up
  return [...items].sort((a, b) => {
    const ta = a.published?.getTime() || 0, tb = b.published?.getTime() || 0;
    return (tb + b.weight * 3.6e6) - (ta + a.weight * 3.6e6);
  });
}

async function main() {
  const t0 = Date.now();
  const seen = loadSeen();

  // 1) FETCH
  const { items, health } = await fetchAll({ hours: 24, seenLinks: seen });

  // 2) ROUTE + TAG
  const routed = routeAll(items);

  // 3) BUCKET + RANK + TRIM
  const buckets = { macro: [], sector: [], india: [], global: [], compliance: [] };
  for (const it of routed) (buckets[it.section] || buckets.india).push(it);
  for (const k of Object.keys(buckets)) buckets[k] = rank(buckets[k]).slice(0, PER_SECTION[k]);

  const watch = rank(routed.filter((it) => it.watchTags.length)).slice(0, WATCH_MAX);

  // lead stories (first of each section) get the longer AI treatment
  const leadIds = new Set(Object.values(buckets).map((arr) => arr[0]?.link).filter(Boolean));

  // 4) SUMMARISE  (one flat list so we can pace the API once)
  const flat = [...new Set([...Object.values(buckets).flat(), ...watch])];
  const summarised = await summariseAll(flat, { leadIds });
  const byLink = new Map(summarised.map((s) => [s.link, s]));
  const remap = (arr) => arr.map((it) => byLink.get(it.link) || it);

  for (const k of Object.keys(buckets)) buckets[k] = remap(buckets[k]);
  const watchOut = remap(watch);

  // 5) KNOWLEDGE DESK
  const topAll = rank(summarised).slice(0, 10);
  const [mechanism, myths] = await Promise.all([generateMechanism(topAll), generateMyths(topAll)]);

  // 6) TICKER (static placeholder text until a quotes feed is added)
  const ticker = [
    'Sensex —', 'Nifty —', 'USD/INR —', '10Y G-Sec —', 'Brent —', 'Gold —',
  ].map((s) => `<span>${s}</span>`).join('');

  // 7) BUILD + WRITE
  const html = buildHTML({
    ...buckets, watch: watchOut, mechanism, myths, ticker,
    runTime: new Date().toUTCString(),
  });
  const stamp = writeEdition(html, PUBLIC_DIR);

  // 8) persist dedup state + health log
  const allLinks = new Set([...seen, ...summarised.map((s) => s.link.split('?')[0].replace(/\/$/, ''))]);
  saveSeen(allLinks);
  fs.writeFileSync(path.join(PUBLIC_DIR, 'health.json'), JSON.stringify({ ts: new Date().toISOString(), health }, null, 2));

  const counts = Object.entries(buckets).map(([k, v]) => `${k}:${v.length}`).join(' ');
  console.log(`✅ Edition ${stamp} built — ${counts} watch:${watchOut.length} — ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}

main().catch((e) => { console.error('FATAL:', e); process.exit(1); });
