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

const VIDEOS = 'https://www.googleapis.com/youtube/v3/videos';
// Minimum length for a "real" interview — drops Shorts and sub-clips. 3 minutes keeps
// substantive conversations while excluding the 30–60s reels the user doesn't want.
const MIN_SECONDS = 180;

// ISO-8601 duration ("PT12M34S") -> seconds.
function isoToSec(d = '') {
  const m = /PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/.exec(d) || [];
  return (+m[1] || 0) * 3600 + (+m[2] || 0) * 60 + (+m[3] || 0);
}

// videos.list for a batch -> { id: { sec, lang, channel } } (duration, audio language,
// channel). NO view count — that would reward old videos and bury the fresh ones.
async function fetchVideoMeta(ids) {
  const out = {};
  try {
    const p = new URLSearchParams({ part: 'contentDetails,snippet', id: ids.join(','), key: API_KEY });
    const res = await fetch(`${VIDEOS}?${p}`, { signal: AbortSignal.timeout(15000) });
    if (!res.ok) return out;
    const data = await res.json();
    for (const it of data.items || []) {
      out[it.id] = {
        sec: isoToSec(it.contentDetails?.duration),
        lang: (it.snippet?.defaultAudioLanguage || it.snippet?.defaultLanguage || '').toLowerCase(),
        channel: it.snippet?.channelTitle || '',
      };
    }
  } catch { /* leave empty */ }
  return out;
}

// Any Indian-script (Devanagari etc.) in the title ⇒ a Hindi/regional video.
const INDIC = /[ऀ-෿]/;
// Credible finance channels — quality comes from the SOURCE, not view count.
const REPUTABLE = /\bet now\b|et markets|cnbc|moneycontrol|livemint|\bmint\b|zerodha|\bgroww\b|ndtv profit|bloomberg|economic times|business standard|\bbq\b|value research|outlook|forbes|the core|finshots|capitalmind|\bnse\b|\bbse\b|et alpha/i;

async function searchLatest(m, publishedAfter) {
  const params = new URLSearchParams({
    part: 'snippet', type: 'video', order: 'date', maxResults: '12',
    regionCode: 'IN', relevanceLanguage: 'en', publishedAfter, // ENGLISH only
    // Search the NAME alone (no forced "interview" keyword) so podcasts, "in
    // conversation with…" and exclusive sit-downs all qualify; the surname-in-title +
    // credible-channel + length filters below keep quality high.
    q: m.name, key: API_KEY,
  });
  const res = await fetch(`${SEARCH}?${params}`, { signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`YT ${res.status}: ${(await res.text()).slice(0, 120)}`);
  const data = await res.json();
  const surname = m.name.replace(/^[A-Z]\.\s*/, '').split(' ').pop().toLowerCase();
  // Plausibly features this manager (surname in title) AND not a Hindi/regional video
  // (no Indic script anywhere in the title).
  const cands = (data.items || []).filter((it) => it.id?.videoId
    && (it.snippet?.title || '').toLowerCase().includes(surname)
    && !INDIC.test(it.snippet?.title || ''));
  if (!cands.length) return null;
  const meta = await fetchVideoMeta(cands.map((c) => c.id.videoId));
  // Eligible = long enough + English audio (unknown audio allowed). `cands` are already
  // most-recent-first, so `eligible` stays recency-ordered.
  const eligible = cands.filter((c) => { const x = meta[c.id.videoId]; return x && x.sec >= MIN_SECONDS && (!x.lang || x.lang.startsWith('en')); });
  if (!eligible.length) return null;
  // Quality WITHOUT sacrificing freshness: take the NEWEST interview from a credible
  // channel; only if none qualifies, fall back to the newest eligible.
  const hit = eligible.find((c) => REPUTABLE.test(meta[c.id.videoId]?.channel || '')) || eligible[0];
  const s = hit.snippet;
  return {
    manager: m.name, firm: m.firm, tier: m.tier,
    videoId: hit.id.videoId,
    title: s.title,
    channel: s.channelTitle,
    published: s.publishedAt,
    thumb: s.thumbnails?.medium?.url || s.thumbnails?.default?.url || '',
    link: `https://www.youtube.com/watch?v=${hit.id.videoId}`,
    durationSec: meta[hit.id.videoId]?.sec || 0,
  };
}

/**
 * Latest interviews for the watch-list. Tier-priority, one per manager, last `days`,
 * top `want`. Returns [] (caller falls back to cache) if the key is missing / API fails.
 */
export async function fetchManagerInterviews({ days = 30, want = 8, gapMs = 120 } = {}) {
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
