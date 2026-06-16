// check-feeds.js — quick standalone test of every feed. Run: npm run feeds:check
// Use this FIRST after deploying, to see which of the 20 feeds actually work from a real server.
import Parser from 'rss-parser';
import { FEEDS } from '../src/feeds.js';

const parser = new Parser({
  timeout: 20000,
  headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36' },
});

const ok = [], bad = [];
for (const f of FEEDS.filter((x) => x.enabled)) {
  try {
    const d = await parser.parseURL(f.url);
    const n = (d.items || []).length;
    console.log(`✓  ${f.name.padEnd(34)} ${n} items`);
    ok.push(f.id);
  } catch (e) {
    console.log(`✗  ${f.name.padEnd(34)} ${e.message}`);
    bad.push(f.id);
  }
}
console.log(`\n${ok.length} live, ${bad.length} failed.`);
if (bad.length) console.log(`Failed: ${bad.join(', ')} — set enabled:false for these in src/feeds.js`);
