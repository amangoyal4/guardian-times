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

// High-quality Indian-markets finance channels (verified live 2026-06-17).
const YT_CHANNELS = [
  { name: 'Markets by Zerodha', channelId: 'UCXbKJML9pVclFHLFzpvBgWw' },
  { name: 'Zerodha Varsity',    channelId: 'UCQXwgooTlP6tk2a-u6vgyUA' },
  { name: 'CA Rachana Ranade',  channelId: 'UCe3qdG0A_gr-sEdat5y2twQ' },
  { name: 'Akshat Shrivastava', channelId: 'UCqW8jxh4tH1Z1sWPbkGWL4g' },
  { name: 'Finshots',           channelId: 'UC8uj-UFGDzAx3RfPzeRqnyA' },
  { name: 'ET Money',           channelId: 'UCxv9T8da7658T9R8LQT_3PQ' },
  { name: 'Capitalmind',        channelId: 'UCM9JulVK4nShhpiMWlEuIGA' },
];

// Thoughtful finance/investing podcasts — Indian + global (verified live 2026-06-17).
const PODCASTS = [
  { name: 'WTF is with Nikhil Kamath', rss: 'https://feeds.hubhopper.com/664690fdea0d7a6f61a052da119934d3.rss' },
  { name: 'Acquired',                  rss: 'https://feeds.transistor.fm/acquired' },
  { name: 'Paisa Vaisa',               rss: 'https://www.omnycontent.com/d/playlist/e0dce4b3-2eb8-48cb-822c-af1d00e03e20/b3d9fccc-662e-4aa7-a14a-af4e0097d44b/e2ba1850-2b92-4a77-b08f-af4e0097d46c/podcast.rss' },
  { name: 'The Knowledge Project',     rss: 'https://feeds.megaphone.fm/FSMI7575968096' },
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

async function fetchChannel(ch) {
  try {
    const data = await parser.parseURL(YT_FEED(ch.channelId));
    return (data.items || []).slice(0, 4).map((it) => ({
      channel: ch.name,
      title: stripHtml(it.title || ''),
      link: it.link || '',
      videoId: it.videoId || '',
      thumb: ytThumb(it),
      published: it.isoDate || it.pubDate || null,
      rawDesc: cleanDesc(ytDescription(it)),
    })).filter((v) => v.title && v.link);
  } catch (err) {
    console.log(`    ⚠ YouTube feed failed: ${ch.name} (${err.message})`);
    return [];
  }
}

async function fetchPodcast(p) {
  try {
    const data = await parser.parseURL(p.rss);
    const it = (data.items || [])[0];
    if (!it) return null;
    return {
      show: p.name,
      title: stripHtml(it.title || ''),
      link: it.link || it.enclosure?.url || '',
      published: it.isoDate || it.pubDate || null,
      duration: it.itunes?.duration || '',
      image: it.itunes?.image || data.itunes?.image || data.image?.url || '',
      rawDesc: cleanDesc(it.contentSnippet || it.content || it.summary || it.description || '', 480),
    };
  } catch (err) {
    console.log(`    ⚠ Podcast feed failed: ${p.name} (${err.message})`);
    return null;
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
  console.log('\n📚 Fetching Library (YouTube + podcasts, keyless RSS)…');
  const [vidLists, pods] = await Promise.all([
    Promise.all(YT_CHANNELS.map(fetchChannel)),
    Promise.all(PODCASTS.map(fetchPodcast)),
  ]);

  const cutoff = Date.now() - days * 24 * 3600 * 1000;
  const videos = vidLists.flat()
    .filter((v) => { const t = v.published ? new Date(v.published).getTime() : 0; return t === 0 || t >= cutoff; })
    .sort((a, b) => (new Date(b.published).getTime() || 0) - (new Date(a.published).getTime() || 0));

  const podcasts = pods.filter(Boolean)
    .sort((a, b) => (new Date(b.published).getTime() || 0) - (new Date(a.published).getTime() || 0));

  const liveChannels = vidLists.filter((l) => l.length).length;
  console.log(`   ${videos.length} recent videos from ${liveChannels}/${YT_CHANNELS.length} channels · ${podcasts.length}/${PODCASTS.length} podcasts live`);
  return { videos, podcasts };
}
