// seed-library.js — fetch the Library candidate pool and write it to
// archive/library-pool.json. Run LOCALLY (a residential IP — YouTube's Atom feeds
// don't block it the way they intermittently block GitHub's datacenter IPs). The
// committed cache is the fallback the daily CI build reuses whenever its own
// YouTube fetch comes back empty, so the Library is never blank.
//   Run:  node scripts/seed-library.js
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { fetchLibrary } from '../src/library.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(__dirname, '..', 'archive', 'library-pool.json');

const pool = await fetchLibrary();
if (!pool.videos.length) {
  console.error('✗ Got 0 videos — not overwriting the cache. Try again in a minute.');
  process.exit(1);
}
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(pool));
console.log(`✅ Seeded ${OUT} — ${pool.videos.length} videos, ${pool.podcasts.length} podcasts`);
process.exit(0);
