// library.js — the "Library" desk: curated finance YouTube videos + a podcast of
// the day. Keyless RSS, same resilience-first pattern as the news fetcher: a dead
// feed is logged and skipped, never fatal.
//   • YouTube channels expose a public Atom feed at
//     youtube.com/feeds/videos.xml?channel_id=UC…  (no API key, no quota).
//   • Podcasts expose a standard RSS feed (the same one Apple Podcasts ingests).
// Channel IDs and podcast feeds were resolved and VERIFIED live 2026-06-17.
// To add/remove a source, edit the lists below — a wrong id just yields an empty
// feed (skipped), it never crashes the run.

import Parser from 'rss-parser';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// The Library's videos are OUR OWN IP videos, listed in this manifest (edited via the
// repo — see data/README.md). No YouTube auto-fetch. Each entry → one video card.
const VIDEO_MANIFEST = path.join(__dirname, '..', 'data', 'library-videos.json');

// Pull the 11-char YouTube id from any watch/share/embed URL (for the auto thumbnail).
function ytIdFromUrl(url = '') {
  const m = String(url).match(/(?:v=|youtu\.be\/|\/embed\/|\/shorts\/|\/live\/)([A-Za-z0-9_-]{11})/);
  return m ? m[1] : '';
}

// Load our IP videos from the manifest, normalised to the card shape, newest first.
// Map ONE raw video record ({title, url, blurb, source, date, duration, thumb})
// — from the JSON manifest OR the marketing Google Sheet — into a Library card.
// Videos are hosted on YouTube/Vimeo (any size/aspect ratio; the host normalises
// playback), so we only need a link + thumbnail. YouTube thumbnails derive from
// the 11-char id; Vimeo/other hosts supply `thumb` explicitly.
function mapVideoRecord(v) {
  const id = ytIdFromUrl(v.url);
  return {
    channel: v.source || 'Guardian Capital',
    title: v.title ? String(v.title) : '',
    link: v.url,
    videoId: id,
    // hqdefault is the safe sync default; enrichVideos() upgrades YouTube to the
    // highest available resolution and pulls the real posted title/thumb.
    thumb: v.thumb || (id ? `https://i.ytimg.com/vi/${id}/hqdefault.jpg` : ''),
    blurb: v.blurb || '',
    published: v.date || null,
    duration: v.duration || '',
    orientation: isPortraitUrl(v.url) ? 'portrait' : 'landscape',
    // Track what the sheet/manifest set explicitly so enrichment only fills gaps
    // (an explicit value is always an intentional override of the posted metadata).
    _titleSet: !!v.title,
    _thumbSet: !!v.thumb,
    _channelSet: !!v.source,
  };
}
const byNewest = (a, b) => (new Date(b.published || 0).getTime() || 0) - (new Date(a.published || 0).getTime() || 0);

// ---- Auto-pull posted metadata (title + highest-quality thumbnail) ----
// oEmbed is free and keyless for both YouTube and Vimeo. It returns the EXACT
// posted title, the channel, and a thumbnail — so the paper always matches what's
// live on the platform, and marketing need only paste a URL.
// Which platform a link is on — used for the card label and to decide whether we
// can auto-pull metadata. YouTube / Vimeo / TikTok expose keyless oEmbed; Instagram,
// LinkedIn and Facebook do NOT (they require an approved API app), so those rely on
// the title + thumbnail the sheet provides.
// Vertical formats (9:16) — YouTube Shorts, Instagram Reels, all of TikTok. These
// render "contained" so the tall frame shows fully instead of being cropped into
// the landscape tile. Vimeo verticals are caught later from the oEmbed dimensions.
function isPortraitUrl(url = '') {
  return /youtube\.com\/shorts\//i.test(url) || /instagram\.com\/reels?\//i.test(url) || /tiktok\.com/i.test(url);
}

function platformOf(url = '') {
  if (/youtube\.com|youtu\.be/i.test(url)) return 'YouTube';
  if (/vimeo\.com/i.test(url)) return 'Vimeo';
  if (/tiktok\.com/i.test(url)) return 'TikTok';
  if (/instagram\.com/i.test(url)) return 'Instagram';
  if (/linkedin\.com/i.test(url)) return 'LinkedIn';
  if (/facebook\.com|fb\.watch/i.test(url)) return 'Facebook';
  return 'Video';
}

async function fetchOembed(url) {
  let endpoint = '';
  if (/youtube\.com|youtu\.be/i.test(url)) endpoint = `https://www.youtube.com/oembed?url=${encodeURIComponent(url)}&format=json`;
  else if (/vimeo\.com/i.test(url)) endpoint = `https://vimeo.com/api/oembed.json?url=${encodeURIComponent(url)}`;
  else if (/tiktok\.com/i.test(url)) endpoint = `https://www.tiktok.com/oembed?url=${encodeURIComponent(url)}`;
  else return null; // Instagram / LinkedIn / Facebook: no keyless oEmbed — use sheet values
  try {
    const r = await fetch(endpoint, { redirect: 'follow' });
    if (!r.ok) return null;
    return await r.json();
  } catch { return null; }
}

// YouTube's maxresdefault (1280×720) exists only when a HD thumbnail was set/generated
// (true for proper uploads). We verify it exists and fall back to hqdefault so a card
// never shows a broken image.
async function bestYouTubeThumb(id) {
  const max = `https://i.ytimg.com/vi/${id}/maxresdefault.jpg`;
  try { const r = await fetch(max, { method: 'HEAD' }); if (r.ok) return max; } catch {}
  return `https://i.ytimg.com/vi/${id}/sddefault.jpg`;
}

const fmtSeconds = (s) => {
  s = Math.round(Number(s) || 0);
  const m = Math.floor(s / 60), ss = String(s % 60).padStart(2, '0');
  return m ? `${m}:${ss}` : `0:${ss}`;
};

// Enrich each video with the real posted title + best thumbnail, keeping any
// explicit sheet/manifest overrides. Runs at build time over the ~6 shown videos.
async function enrichVideos(videos) {
  return Promise.all(videos.map(async (v) => {
    const platform = platformOf(v.link);
    const o = await fetchOembed(v.link); // null for Instagram / LinkedIn / Facebook
    const out = { ...v, platform };
    if (!v._titleSet && o?.title) out.title = o.title;                          // posted title (YT/Vimeo/TikTok)
    if (!v._channelSet) out.channel = o?.author_name || v.channel || platform;  // channel, else platform label
    if (!v._thumbSet) {
      if (v.videoId) out.thumb = await bestYouTubeThumb(v.videoId);             // highest-res YouTube
      else if (o?.thumbnail_url) out.thumb = o.thumbnail_url;                   // Vimeo/TikTok thumbnail
    }
    if (!v.duration && typeof o?.duration === 'number') out.duration = fmtSeconds(o.duration);
    // Refine orientation from real oEmbed dimensions (catches vertical Vimeo, etc.)
    // when the URL alone didn't already mark it portrait.
    if (out.orientation !== 'portrait' && o?.width && o?.height && o.height > o.width) out.orientation = 'portrait';
    // Platforms we can't auto-fetch need the sheet to supply title + thumbnail;
    // warn loudly (in the build log) so an incomplete row is easy to spot and fix.
    if (!out.title) console.log(`  ⚠ Library: ${platform} link has no title — add a "title" in the sheet: ${v.link}`);
    if (!out.thumb) console.log(`  ⚠ Library: ${platform} link has no thumbnail — add a "thumbnail" image URL in the sheet: ${v.link}`);
    return out;
  }));
}

export function loadLibraryVideos() {
  let arr = [];
  try { arr = JSON.parse(fs.readFileSync(VIDEO_MANIFEST, 'utf8')); }
  catch (e) { console.log(`  ⚠ Library manifest not read (${e.message}) — video grid will be empty.`); }
  if (!Array.isArray(arr)) return [];
  return arr.filter((v) => v && v.url).map(mapVideoRecord).sort(byNewest);
}

// Minimal RFC-4180 CSV parser: handles quoted fields, embedded commas, escaped
// quotes ("") and newlines inside quotes. Enough for a Google-Sheet export.
function parseCsv(text) {
  const rows = [];
  let row = [], field = '', inQ = false;
  const s = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inQ) {
      if (c === '"') { if (s[i + 1] === '"') { field += '"'; i++; } else inQ = false; }
      else field += c;
    } else if (c === '"') inQ = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else field += c;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((c) => c.trim() !== ''));
}

// Marketing "backend": a shared Google Sheet, published to the web as CSV. Set the
// published-CSV URL as env/secret LIBRARY_SHEET_CSV_URL. Marketing adds a row per
// video (columns matched by header, case-insensitive: title, url, blurb, source,
// date, duration, thumb) — no code, no git. Falls back to the JSON manifest if the
// sheet is unset or unreachable, so the build never breaks on a bad/empty sheet.
// Accept ANY form of Google Sheets URL and read it as CSV, so marketing keeps a
// normal editable sheet (no CSV file to manage):
//  - a normal sheet URL  …/spreadsheets/d/<ID>/edit#gid=<GID>  → rewritten to the
//    live CSV export endpoint (needs the sheet shared "anyone with link can view");
//  - a Publish-to-web CSV URL (…/pub?output=csv) or an export URL → used as-is;
//  - any other URL → tried as-is.
function toCsvUrl(url = '') {
  if (/output=csv|format=csv/i.test(url)) return url;
  const m = url.match(/docs\.google\.com\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
  if (m) {
    const gid = (url.match(/[#&?]gid=(\d+)/) || [])[1] || '0';
    return `https://docs.google.com/spreadsheets/d/${m[1]}/export?format=csv&gid=${gid}`;
  }
  return url;
}

export async function fetchSheetVideos() {
  if (!process.env.LIBRARY_SHEET_CSV_URL) return null; // not configured — caller uses the manifest
  const url = toCsvUrl(process.env.LIBRARY_SHEET_CSV_URL.trim());
  try {
    const res = await fetch(url, { redirect: 'follow' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const rows = parseCsv(await res.text());
    if (rows.length < 2) return [];
    const header = rows[0].map((h) => h.trim().toLowerCase());
    // Accept common header aliases so a slightly-differently-named column still works.
    const col = (...names) => { for (const n of names) { const i = header.indexOf(n); if (i >= 0) return i; } return -1; };
    const ci = {
      title: col('title', 'name'),
      url: col('url', 'link', 'video', 'video url'),
      blurb: col('blurb', 'description', 'desc', 'caption'),
      source: col('source', 'channel', 'label'),
      date: col('date', 'published', 'posted'),
      duration: col('duration', 'length'),
      thumb: col('thumbnail', 'thumb', 'thumbnail url', 'image', 'cover'),
    };
    if (ci.url < 0) throw new Error('sheet needs at least a "url" header column');
    const get = (r, i) => (i >= 0 ? (r[i] || '').trim() : '');
    return rows.slice(1)
      .map((r) => ({ title: get(r, ci.title), url: get(r, ci.url), blurb: get(r, ci.blurb), source: get(r, ci.source), date: get(r, ci.date), duration: get(r, ci.duration), thumb: get(r, ci.thumb) }))
      .filter((v) => v.url)
      .map(mapVideoRecord)
      .sort(byNewest);
  } catch (e) {
    console.log(`  ⚠ Library Google Sheet unreachable (${e.message}) — falling back to JSON manifest.`);
    return null;
  }
}

const parser = new Parser({
  timeout: 20000,
  headers: {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
    'Accept': 'application/rss+xml, application/atom+xml, application/xml, text/xml, */*',
  },
  // YouTube's Atom feed carries the thumbnail/description inside <media:group> and
  // the id in <yt:videoId>; tell rss-parser to surface them.
  customFields: { item: [['media:group', 'mediaGroup'], ['yt:videoId', 'videoId']] },
});

// High-quality finance channels — Indian markets + global investing educators
// (all verified live 2026-06-17). A wrong id just yields an empty feed (skipped).
const YT_CHANNELS = [
  { name: 'Markets by Zerodha', channelId: 'UCXbKJML9pVclFHLFzpvBgWw' },
  { name: 'Zerodha Varsity',    channelId: 'UCQXwgooTlP6tk2a-u6vgyUA' },
  { name: 'CA Rachana Ranade',  channelId: 'UCe3qdG0A_gr-sEdat5y2twQ' },
  { name: 'Akshat Shrivastava', channelId: 'UCqW8jxh4tH1Z1sWPbkGWL4g' },
  { name: 'Finshots',           channelId: 'UC8uj-UFGDzAx3RfPzeRqnyA' },
  { name: 'ET Money',           channelId: 'UCxv9T8da7658T9R8LQT_3PQ' },
  { name: 'Capitalmind',        channelId: 'UCM9JulVK4nShhpiMWlEuIGA' },
  // Global investing educators (verified 2026-06-17)
  { name: 'Bloomberg Originals', channelId: 'UCUMZ7gohGI9HcU9VNsr2FJQ' },
  { name: 'The Plain Bagel',     channelId: 'UCFCEuCsyWP0YkP3CZ3Mr01Q' },
  { name: 'Ben Felix',           channelId: 'UCDXTQ8nWmx_EhZ2v-kp7QxA' },
];

// Thoughtful finance/investing podcasts — Indian + global (verified live 2026-06-17).
const PODCASTS = [
  { name: 'WTF is with Nikhil Kamath', rss: 'https://feeds.hubhopper.com/664690fdea0d7a6f61a052da119934d3.rss' },
  { name: 'Acquired',                  rss: 'https://feeds.transistor.fm/acquired' },
  { name: 'Paisa Vaisa',               rss: 'https://www.omnycontent.com/d/playlist/e0dce4b3-2eb8-48cb-822c-af1d00e03e20/b3d9fccc-662e-4aa7-a14a-af4e0097d44b/e2ba1850-2b92-4a77-b08f-af4e0097d46c/podcast.rss' },
  { name: 'The Knowledge Project',     rss: 'https://feeds.megaphone.fm/FSMI7575968096' },
  { name: 'Odd Lots',                  rss: 'https://www.omnycontent.com/d/playlist/e73c998e-6e60-432f-8610-ae210140c5b1/8a94442e-5a74-4fa2-8b8d-ae27003a8d6b/982f5071-765c-403d-969d-ae27003a8d83/podcast.rss' },
  { name: 'Rational Reminder',         rss: 'https://rationalreminder.libsyn.com/rss' },
];

// Long-form business/finance PODCASTS that live primarily on YouTube (verified
// live 2026-06-19, recent within the month). These feed the SAME podcast pool as
// the RSS shows above — so the "podcast of the day" can be a YouTube episode. The
// YouTube Atom feed carries no episode list filtering, so Shorts are dropped by
// title and only items inside the time window are kept (see fetchYtPodcast).
const YT_PODCASTS = [
  { name: 'Figuring Out · Raj Shamani', channelId: 'UCzwCEE_PchiBULMnAJqhGVg' },
  { name: 'Founder Thesis',             channelId: 'UChwUqkuczHA_d-TV3n0LN9w' },
  { name: 'The Morning Context',        channelId: 'UCYAZQvp_LMnL_IAVB8L-rOQ' },
];

const YT_FEED = (id) => `https://www.youtube.com/feeds/videos.xml?channel_id=${id}`;

const stripHtml = (s = '') =>
  s.replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();

// Video/episode descriptions are link-and-timestamp dumps. Keep the meaningful
// lead prose: drop URLs, hashtags, timestamps and the usual promo boilerplate.
function cleanDesc(s = '', max = 320) {
  let t = stripHtml(s)
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/#[^\s#]+/g, ' ')
    .replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2190}-\u{21FF}]/gu, ' ') // emoji/dingbats
    .replace(/\b\d{1,2}:\d{2}(?::\d{2})?\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  // Cut at the usual promo/boilerplate hinge so the fallback never shows ad copy.
  t = t.split(/(?:subscribe|follow us|chapters?:|timestamps?:|open (?:a |your )|use code|sign up|download the|join (?:wisdom|our|my|the )|------|======|====)/i)[0].trim();
  // If the lead was pure promo and nothing meaningful survives, drop it.
  if (t.length < 25) return '';
  return t.length > max ? t.slice(0, max).replace(/\s+\S*$/, '') + '…' : t;
}

// hqdefault always exists for a valid video id (unlike maxresdefault); prefer the
// id-derived URL, fall back to the media:thumbnail attribute.
function ytThumb(item) {
  const id = item.videoId || ((item.link || '').match(/[?&]v=([^&]+)/) || [])[1];
  if (id) return `https://i.ytimg.com/vi/${id}/hqdefault.jpg`;
  const t = item?.mediaGroup?.['media:thumbnail'];
  return (Array.isArray(t) ? t[0] : t)?.$?.url || '';
}

function ytDescription(item) {
  let d = item?.mediaGroup?.['media:description'];
  if (Array.isArray(d)) d = d[0];
  if (d && typeof d === 'object') d = d._ || d['#text'] || '';
  return d || item.contentSnippet || item.content || '';
}

// Is this video a YouTube SHORT? The channel Atom feed carries no duration, so we
// use YouTube's own routing: requesting youtube.com/shorts/<id> returns 200 for a
// real Short but 303-redirects to /watch for a normal long-form video. A HEAD with
// manual redirect handling tells them apart without downloading anything. Best
// effort: on any error/timeout we treat it as NOT a short (keep it) so the filter
// can only ever remove genuine Shorts, never silently drop real videos.
async function isShort(id) {
  if (!id) return false;
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 8000);
    const r = await fetch(`https://www.youtube.com/shorts/${id}`, {
      method: 'HEAD',
      redirect: 'manual',
      signal: ctrl.signal,
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
    });
    clearTimeout(t);
    return r.status === 200; // 200 = Short; 303 redirect to /watch = normal video
  } catch {
    return false;
  }
}

// ---- YouTube Data API (key-based) ----
// The Atom feeds above are keyless but get BLOCKED from CI datacenter IPs, which
// froze the Library on a stale cache ("never updates"). The Data API uses the key
// and works fine from CI, and—unlike Atom—returns real durations, so we can drop
// Shorts/clips precisely. We use it when YOUTUBE_API_KEY is set, falling back to the
// Atom path otherwise (e.g. local runs without a key).
const YT_API_KEY = process.env.YOUTUBE_API_KEY;
const YT_API = 'https://www.googleapis.com/youtube/v3';
const isoToSec = (d = '') => { const m = /PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/.exec(d) || []; return (+m[1] || 0) * 3600 + (+m[2] || 0) * 60 + (+m[3] || 0); };
// Parse an iTunes duration: "1234" (secs), "12:34" (m:s) or "1:02:33" (h:m:s) -> seconds.
const durToSec = (d = '') => { d = String(d).trim(); if (!d) return 0; if (/^\d+$/.test(d)) return +d; const p = d.split(':').map(Number); if (p.some(Number.isNaN)) return 0; return p.length === 3 ? p[0] * 3600 + p[1] * 60 + p[2] : p.length === 2 ? p[0] * 60 + p[1] : 0; };

// Durations for a batch of video ids (videos.list, 1 quota unit / 50 ids).
async function apiDurations(ids) {
  const out = {};
  for (let i = 0; i < ids.length; i += 50) {
    try {
      const p = new URLSearchParams({ part: 'contentDetails', id: ids.slice(i, i + 50).join(','), key: YT_API_KEY });
      const res = await fetch(`${YT_API}/videos?${p}`, { signal: AbortSignal.timeout(15000) });
      if (!res.ok) continue;
      const data = await res.json();
      for (const it of data.items || []) out[it.id] = isoToSec(it.contentDetails?.duration);
    } catch { /* skip batch */ }
  }
  return out;
}

// Recent uploads of a channel via the uploads playlist (UC… → UU…). Drops Shorts and
// anything under `minSec`, keeps items within `days`, newest first, up to `max`.
async function apiChannelVideos(channelId, { days, minSec, max }) {
  const uploads = 'UU' + channelId.slice(2);
  const cutoff = Date.now() - days * 24 * 3600 * 1000;
  const p = new URLSearchParams({ part: 'snippet', playlistId: uploads, maxResults: '15', key: YT_API_KEY });
  const res = await fetch(`${YT_API}/playlistItems?${p}`, { signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`playlistItems ${res.status}`);
  const data = await res.json();
  let items = (data.items || [])
    .map((it) => { const s = it.snippet || {}; return {
      videoId: s.resourceId?.videoId,
      title: stripHtml(s.title || ''),
      published: s.publishedAt || null,
      rawDesc: cleanDesc(s.description || ''),
    }; })
    .filter((v) => v.videoId && v.title && v.title !== 'Private video' && v.title !== 'Deleted video' && !/#?\bshorts?\b/i.test(v.title))
    .filter((v) => { const t = v.published ? new Date(v.published).getTime() : 0; return t === 0 || t >= cutoff; });
  if (!items.length) return [];
  const durMap = await apiDurations(items.map((v) => v.videoId));
  items = items.filter((v) => (durMap[v.videoId] || 0) >= minSec);
  return items.slice(0, max).map((v) => ({ ...v, durationSec: durMap[v.videoId] || 0 }));
}

async function fetchChannel(ch, days = 5) {
  const cutoff = Date.now() - days * 24 * 3600 * 1000;
  // Preferred: Data API (reliable from CI + real durations).
  if (YT_API_KEY) {
    try {
      const vids = await apiChannelVideos(ch.channelId, { days, minSec: 180, max: 4 });
      return vids.map((v) => ({
        channel: ch.name, title: v.title,
        link: `https://www.youtube.com/watch?v=${v.videoId}`,
        videoId: v.videoId, thumb: `https://i.ytimg.com/vi/${v.videoId}/hqdefault.jpg`,
        published: v.published, rawDesc: v.rawDesc,
      }));
    } catch (err) {
      console.log(`    ⚠ YouTube API channel failed: ${ch.name} (${err.message}) — trying Atom`);
    }
  }
  try {
    const data = await parser.parseURL(YT_FEED(ch.channelId));
    // Take a wider window than we need, drop Shorts, then keep the freshest few —
    // so a channel that just posted three Shorts still yields real long-form videos.
    const cand = (data.items || []).slice(0, 8).map((it) => ({
      channel: ch.name,
      title: stripHtml(it.title || ''),
      link: it.link || '',
      videoId: it.videoId || '',
      thumb: ytThumb(it),
      published: it.isoDate || it.pubDate || null,
      rawDesc: cleanDesc(ytDescription(it)),
    })).filter((v) => v.title && v.link && !/#?\bshorts?\b/i.test(v.title)
      && (v.published ? new Date(v.published).getTime() >= cutoff : false)); // last `days` only
    // Drop YouTube Shorts (≤ ~3 min vertical clips) — a learning library wants
    // long-form teaching, not Shorts. Probe in parallel; best-effort (see isShort).
    const shortFlags = await Promise.all(cand.map((v) => isShort(v.videoId)));
    return cand.filter((_, i) => shortFlags[i] !== true).slice(0, 4);
  } catch (err) {
    console.log(`    ⚠ YouTube feed failed: ${ch.name} (${err.message})`);
    return [];
  }
}

// A podcast pick need NOT be the absolute latest — anything within the window is a
// fair candidate. Return up to 2 recent episodes per show so the curator has range.
async function fetchPodcast(p, days) {
  const cutoff = Date.now() - days * 24 * 3600 * 1000;
  try {
    const data = await parser.parseURL(p.rss);
    return (data.items || [])
      .map((it) => ({
        show: p.name,
        title: stripHtml(it.title || ''),
        link: it.link || it.enclosure?.url || '',
        published: it.isoDate || it.pubDate || null,
        duration: it.itunes?.duration || '',
        image: it.itunes?.image || data.itunes?.image || data.image?.url || '',
        rawDesc: cleanDesc(it.contentSnippet || it.content || it.summary || it.description || '', 480),
        source: 'podcast',
      }))
      .filter((e) => e.title && e.link)
      // Drop trailers / promo clips (e.g. a 35-second "coming soon"); a podcast of the
      // day should be a full episode. Keep episodes of unknown length (many feeds omit it).
      .filter((e) => { const s = durToSec(e.duration); return s === 0 || s >= 600; })
      .filter((e) => { const t = e.published ? new Date(e.published).getTime() : 0; return t === 0 || t >= cutoff; })
      .slice(0, 2);
  } catch (err) {
    console.log(`    ⚠ Podcast feed failed: ${p.name} (${err.message})`);
    return [];
  }
}

// A YouTube long-form show treated as a podcast. Same shape as an RSS episode so
// it drops straight into the podcast pool. Shorts are filtered by title; only
// items inside the window survive.
async function fetchYtPodcast(ch, days) {
  const cutoff = Date.now() - days * 24 * 3600 * 1000;
  // Preferred: Data API — only FULL episodes (≥ 15 min), never a clip/Short.
  if (YT_API_KEY) {
    try {
      const vids = await apiChannelVideos(ch.channelId, { days, minSec: 900, max: 2 });
      return vids.map((v) => ({
        show: ch.name, title: v.title,
        link: `https://www.youtube.com/watch?v=${v.videoId}`,
        videoId: v.videoId, published: v.published,
        duration: String(v.durationSec || ''),
        image: `https://i.ytimg.com/vi/${v.videoId}/hqdefault.jpg`,
        rawDesc: cleanDesc(v.rawDesc, 480), source: 'youtube',
      }));
    } catch (err) {
      console.log(`    ⚠ YouTube API podcast failed: ${ch.name} (${err.message}) — trying Atom`);
    }
  }
  try {
    const data = await parser.parseURL(YT_FEED(ch.channelId));
    const cand = (data.items || [])
      .map((it) => ({
        show: ch.name,
        title: stripHtml(it.title || ''),
        link: it.link || '',
        videoId: it.videoId || '',
        published: it.isoDate || it.pubDate || null,
        duration: '',
        image: ytThumb(it),
        rawDesc: cleanDesc(ytDescription(it), 480),
        source: 'youtube',
      }))
      .filter((e) => e.title && e.link && !/#?\bshorts?\b/i.test(e.title))
      .filter((e) => { const t = e.published ? new Date(e.published).getTime() : 0; return t === 0 || t >= cutoff; });
    // Long-form shows shouldn't be Shorts, but probe anyway so a stray Short clip
    // never sneaks into the podcast-of-the-day pool.
    const shortFlags = await Promise.all(cand.map((e) => isShort(e.videoId)));
    return cand.filter((_, i) => shortFlags[i] !== true).slice(0, 2);
  } catch (err) {
    console.log(`    ⚠ YouTube podcast feed failed: ${ch.name} (${err.message})`);
    return [];
  }
}

// Pick n videos maximising channel variety: round-robin across channels, each
// channel contributing its newest unused video first.
export function diverseVideos(videos, n) {
  const byChannel = new Map();
  for (const v of videos) {
    if (!byChannel.has(v.channel)) byChannel.set(v.channel, []);
    byChannel.get(v.channel).push(v);
  }
  const queues = [...byChannel.values()];
  const out = [];
  let added = true;
  while (out.length < n && added) {
    added = false;
    for (const q of queues) {
      if (q.length) { out.push(q.shift()); added = true; if (out.length >= n) break; }
    }
  }
  return out;
}

/**
 * Fetch the Library candidate pool: recent videos across curated channels and the
 * latest episode of each curated podcast. Pure RSS — no Gemini here.
 * @returns {Promise<{videos: object[], podcasts: object[]}>}
 */
export async function fetchLibrary({ days = 45 } = {}) {
  console.log('\n📚 Building Library (our IP videos from manifest + podcast of the day)…');
  // Videos = our own IP, from the manifest (no YouTube fetch). Podcast = auto-fetched.
  const [rssPods, ytPods] = await Promise.all([
    Promise.all(PODCASTS.map((p) => fetchPodcast(p, days))),
    Promise.all(YT_PODCASTS.map((c) => fetchYtPodcast(c, days))),
  ]);

  // Videos come from the marketing Google Sheet when configured (LIBRARY_SHEET_CSV_URL),
  // otherwise the JSON manifest. Sheet failure falls back to the manifest automatically.
  const sheetVideos = await fetchSheetVideos();
  const rawVideos = sheetVideos ?? loadLibraryVideos();
  const source = sheetVideos ? 'Google Sheet' : 'manifest';
  // Pull the real posted title + highest-quality thumbnail for the ones we'll show.
  const videos = await enrichVideos(rawVideos.slice(0, 6));
  const podcasts = [...rssPods.flat(), ...ytPods.flat()]
    .filter(Boolean)
    .sort((a, b) => (new Date(b.published).getTime() || 0) - (new Date(a.published).getTime() || 0));

  console.log(`   ${videos.length} IP video(s) from ${source} · ${podcasts.length} podcast episodes live`);
  return { videos, podcasts };
}
