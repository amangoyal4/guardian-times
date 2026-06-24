// fund-managers.js — latest YouTube INTERVIEWS of tracked PMS / mutual-fund managers.
//
// Interviews live on news/finance channels (ET Now, CNBC-TV18, Zerodha, Mint…), not
// the managers' own channels — so we SEARCH YouTube by name via the YouTube Data API
// (needs YOUTUBE_API_KEY). For each manager we take their most recent interview within
// the last 30 days; we then rank by TIER (1 before 2 before 3) and, within a tier, by
// recency, and keep the top 10. Because the rule is deterministic (latest-in-30-days
// per manager), the list only changes when a genuinely NEW interview appears or an old
// one ages past 30 days. Best-effort: any failure returns [] so the caller can fall
// back to the cached pool; the section simply hides if there's nothing.

const API_KEY = process.env.YOUTUBE_API_KEY;
const SEARCH = 'https://www.googleapis.com/youtube/v3/search';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Tiered watch-list. Tier drives priority; the name is the search query.
export const MANAGERS = [
  // Tier 1 — highest priority
  { name: 'Kenneth Andrade', firm: 'Old Bridge Capital', tier: 1 },
  { name: 'Manish Sonthalia', firm: 'M Capital', tier: 1 },
  { name: 'Jigar Mistry', firm: 'Buoyant Capital', tier: 1 },
  { name: 'Aditya Khemka', firm: 'InCred PMS', tier: 1 },
  { name: 'Trilok Chandra', firm: 'Ambit Asset Management', tier: 1 },
  { name: 'Sanjay Doshi', firm: 'Turtle Wealth Management', tier: 1 },
  { name: 'Ajay Khandelwal', firm: 'Khandwala Securities PMS', tier: 1 },
  { name: 'Rajeev Thakkar', firm: 'PPFAS Mutual Fund', tier: 1 },
  { name: 'Saurabh Mukherjea', firm: 'Marcellus Investment Managers', tier: 1 },
  { name: 'Samir Arora', firm: 'Helios Capital Management', tier: 1 },
  { name: 'Samit Vartak', firm: 'SageOne Investment Managers', tier: 1 },
  // Tier 2 — established, highly respected
  { name: 'Sankaran Naren', firm: 'ICICI Prudential Mutual Fund', tier: 2 },
  { name: 'Harsha Upadhyaya', firm: 'Kotak Mahindra Asset Management', tier: 2 },
  { name: 'Shreyash Devalkar', firm: 'Axis Mutual Fund', tier: 2 },
  { name: 'Manish Gunwani', firm: 'Bandhan AMC', tier: 2 },
  { name: 'Jinesh Gopani', firm: 'Axis Mutual Fund', tier: 2 },
  { name: 'Aniruddha Naha', firm: 'PGIM India Mutual Fund', tier: 2 },
  { name: 'Chirag Setalvad', firm: 'HDFC Mutual Fund', tier: 2 },
  { name: 'R. Srinivasan', firm: 'SBI Mutual Fund', tier: 2 },
  { name: 'Mittul Kalawadia', firm: 'ICICI Prudential Mutual Fund', tier: 2 },
  { name: 'Gopal Agrawal', firm: 'Mirae Asset Mutual Fund', tier: 2 },
  { name: 'Shridatta Bhandwaldar', firm: 'Canara Robeco Mutual Fund', tier: 2 },
  // Tier 3 — renowned & emerging, worth tracking
  { name: 'Prashant Khemka', firm: 'WhiteOak Capital', tier: 3 },
  { name: 'Sunil Singhania', firm: 'Abakkus Asset Manager', tier: 3 },
  { name: 'Vikas Khemani', firm: 'Carnelian Asset Advisors', tier: 3 },
  { name: 'Rakshit Ranjan', firm: 'Marcellus Investment Managers', tier: 3 },
  { name: 'Sohini Andani', firm: 'SBI Mutual Fund', tier: 3 },
  { name: 'Ashutosh Bhargava', firm: 'Nippon India Mutual Fund', tier: 3 },
  { name: 'Chandraprakash Padiyar', firm: 'Tata Asset Management', tier: 3 },
  { name: 'Anish Tawakley', firm: '360 ONE Asset Management', tier: 3 },
  { name: 'Srinivasan Ramamurthy', firm: 'Baroda BNP Paribas Mutual Fund', tier: 3 },
  { name: 'Rajesh Kothari', firm: 'AlfAccurate Advisors', tier: 3 },
  { name: 'Pawan Bharaddia', firm: 'Equitree Capital', tier: 3 },
];

async function searchLatest(m, publishedAfter) {
  const params = new URLSearchParams({
    part: 'snippet', type: 'video', order: 'date', maxResults: '4',
    regionCode: 'IN', relevanceLanguage: 'en', publishedAfter,
    q: `${m.name} interview`, key: API_KEY,
  });
  const res = await fetch(`${SEARCH}?${params}`, { signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`YT ${res.status}: ${(await res.text()).slice(0, 120)}`);
  const data = await res.json();
  const items = data.items || [];
  // Keep only results that plausibly feature this manager (surname in the title),
  // then take the most recent (results are already date-ordered).
  const surname = m.name.replace(/^[A-Z]\.\s*/, '').split(' ').pop().toLowerCase();
  const hit = items.find((it) => (it.snippet?.title || '').toLowerCase().includes(surname));
  if (!hit?.id?.videoId) return null;
  const s = hit.snippet;
  return {
    manager: m.name, firm: m.firm, tier: m.tier,
    videoId: hit.id.videoId,
    title: s.title,
    channel: s.channelTitle,
    published: s.publishedAt,
    thumb: s.thumbnails?.medium?.url || s.thumbnails?.default?.url || '',
    link: `https://www.youtube.com/watch?v=${hit.id.videoId}`,
  };
}

/**
 * Latest interviews for the watch-list. Tier-priority, one per manager, last `days`,
 * top `want`. Returns [] (caller falls back to cache) if the key is missing / API fails.
 */
export async function fetchManagerInterviews({ days = 30, want = 10, gapMs = 120 } = {}) {
  if (!API_KEY) { console.log('  ⚠ YOUTUBE_API_KEY not set — Fund Manager Interviews skipped.'); return []; }
  const publishedAfter = new Date(Date.now() - days * 86400000).toISOString();
  const found = [];
  let errors = 0;
  for (const m of MANAGERS) { // already in tier order
    try {
      const v = await searchLatest(m, publishedAfter);
      if (v) found.push(v);
    } catch (e) {
      if (++errors <= 2) console.log(`    ⚠ YT search failed (${m.name}): ${e.message}`);
    }
    await sleep(gapMs); // be polite to the API
  }
  // Tier first, then most-recent within a tier.
  found.sort((a, b) => a.tier - b.tier || new Date(b.published) - new Date(a.published));
  const seen = new Set();
  const out = [];
  for (const v of found) {
    if (seen.has(v.videoId)) continue; // a shared panel video can match two managers
    seen.add(v.videoId);
    out.push(v);
    if (out.length >= want) break;
  }
  console.log(`  🎙 Fund-manager interviews: ${out.length}/${want} (from ${found.length} found, ${errors} search errors)`);
  return out;
}
