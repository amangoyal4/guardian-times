// fetcher.js — pulls every feed, normalises items, filters to last N hours, dedupes.
// Resilience-first: one bad feed never crashes the run; it's logged and skipped.

import Parser from 'rss-parser';
import { FEEDS } from './feeds.js';

const parser = new Parser({
  timeout: 20000,
  headers: {
    // Many publishers block default fetchers. A real browser UA gets through most.
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
    'Accept': 'application/rss+xml, application/xml, text/xml, */*',
  },
});

const stripHtml = (s = '') =>
  s.replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();

const cleanText = (s = '', max = 600) => {
  const t = stripHtml(s);
  return t.length > max ? t.slice(0, max) + '…' : t;
};

// Tidy a headline: drop the trailing " - publisher.com" / " - Publisher Name"
// that Google-News-proxied feeds bolt on, and normalise "Rs" to ₹. This makes
// the fallback (non-AI) edition read cleanly and helps dedupe match real dupes.
function cleanTitle(raw = '', source = '') {
  let t = stripHtml(raw).trim();
  t = t.replace(/\s+[-–—|]\s*[A-Za-z0-9.]+\.(com|in|org|net|co)\b.*$/i, ''); // " - financialexpress.com"
  if (source) {
    const esc = source.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    t = t.replace(new RegExp(`\\s+[-–—|]\\s*${esc}\\s*$`, 'i'), ''); // " - Business Standard"
  }
  t = t.replace(/\bRs\.?\s?(?=\d)/g, '₹'); // Rs 32,000 -> ₹32,000
  return t.trim();
}

// Normalise one raw RSS item into our internal shape.
function normalise(item, feed) {
  const link = item.link || item.guid || '';
  const published = item.isoDate || item.pubDate || null;
  const source = feed.name.split(' — ')[0]; // "Business Standard — Markets" -> "Business Standard"
  return {
    feedId: feed.id,
    source,
    sectionHint: feed.section,
    region: feed.region,
    weight: feed.weight || 1,
    title: cleanTitle(item.title || '', source),
    link: link.trim(),
    published: published ? new Date(published) : null,
    rawSummary: cleanText(item.contentSnippet || item.content || item.summary || item.description || ''),
  };
}

// Fetch a single feed. Returns { feed, ok, items, error }.
async function fetchOne(feed) {
  try {
    const data = await parser.parseURL(feed.url);
    const items = (data.items || []).map((it) => normalise(it, feed)).filter((x) => x.title && x.link);
    return { feed, ok: true, items, error: null };
  } catch (err) {
    return { feed, ok: false, items: [], error: err.message || String(err) };
  }
}

// Words that carry no topical signal — excluded from the similarity fingerprint
// so "Sensex jumps 500 pts" and "Sensex surges 500 points" still collide.
const STOP = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'of', 'to', 'in', 'on', 'for', 'at', 'by',
  'with', 'from', 'as', 'is', 'are', 'was', 'were', 'be', 'been', 'it', 'its', 'this',
  'that', 'these', 'those', 'has', 'have', 'had', 'will', 'would', 'can', 'could',
  'after', 'over', 'amid', 'says', 'say', 'said', 'new', 'up', 'down', 'pts', 'points',
  'crore', 'lakh', 'cr', 'rs', 'per', 'cent', 'percent', 'how', 'why', 'what', 'set',
  // generic market verbs/nouns that add noise without distinguishing a story
  'close', 'closes', 'hit', 'hits', 'fresh', 'record', 'high', 'highs', 'low', 'lows',
  'posts', 'post', 'rises', 'rise', 'jump', 'jumps', 'surge', 'surges', 'gains', 'gain',
  'falls', 'fall', 'ends', 'end', 'settles', 'settle',
]);

// A normalised token-set "fingerprint" of a headline: lowercase, strip punctuation,
// drop stopwords and 1-2 char fragments. Numbers are kept — they're strong signals.
function fingerprint(title = '') {
  return new Set(
    title
      .toLowerCase()
      .replace(/[^a-z0-9 ]+/g, ' ')
      .split(/\s+/)
      .filter((w) => w.length > 2 && !STOP.has(w))
  );
}

// Containment overlap: |A∩B| / |smaller set|. More robust than Jaccard when two
// papers cover the same story at different headline lengths (one terse, one verbose).
function containment(a, b) {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const w of a) if (b.has(w)) inter++;
  return inter / Math.min(a.size, b.size);
}

// De-dup: drop items whose link, OR whose headline is topically near-identical to
// one we've already kept (cross-source "same story, different paper"). Items are
// assumed PRE-SORTED best-first (weight then recency) so the strongest source's
// copy survives. `seenLinks` carries the previous edition's links to exclude.
const SIM_THRESHOLD = 0.6; // ≥60% of the shorter headline's tokens shared ⇒ same story
function dedupe(items, seenLinks = new Set()) {
  const out = [];
  const seenLinkKeys = new Set();
  const kept = []; // { fp } for every item we've accepted, for similarity checks
  for (const it of items) {
    const linkKey = it.link.split('?')[0].replace(/\/$/, '');
    if (seenLinks.has(linkKey) || seenLinkKeys.has(linkKey)) continue;

    const fp = fingerprint(it.title);
    // Tiny headlines can't be fingerprinted reliably — fall back to exact title.
    if (fp.size < 3) {
      const exact = it.title.toLowerCase().trim();
      if (kept.some((k) => k.exact === exact)) continue;
      seenLinkKeys.add(linkKey);
      kept.push({ fp, exact });
      out.push(it);
      continue;
    }

    let dup = false;
    for (const k of kept) {
      if (k.fp.size >= 3 && containment(fp, k.fp) >= SIM_THRESHOLD) { dup = true; break; }
    }
    if (dup) continue;

    seenLinkKeys.add(linkKey);
    kept.push({ fp, exact: it.title.toLowerCase().trim() });
    out.push(it);
  }
  return out;
}

/**
 * Fetch all enabled feeds, filter to last `hours`, dedupe.
 * @param {object} opts
 * @param {number} opts.hours      recency window (default 24)
 * @param {Set<string>} opts.seenLinks  links from the previous edition to exclude
 * @returns {Promise<{items: object[], health: object[]}>}
 */
export async function fetchAll({ hours = 24, seenLinks = new Set() } = {}) {
  // Skip hard-paywalled sources entirely — every link in the paper must open free.
  const enabled = FEEDS.filter((f) => f.enabled && !f.paywall);
  const skipped = FEEDS.filter((f) => f.enabled && f.paywall).length;
  console.log(`\n📡 Fetching ${enabled.length} free feeds… (${skipped} paywalled sources skipped)\n`);

  const results = await Promise.all(enabled.map(fetchOne));

  // ---- health table ----
  const health = [];
  console.log('  FEED HEALTH CHECK');
  console.log('  ' + '─'.repeat(58));
  for (const r of results) {
    const mark = r.ok ? '✓' : '✗';
    const detail = r.ok ? `${r.items.length} items` : `FAIL: ${r.error}`;
    console.log(`  ${mark}  ${r.feed.name.padEnd(34)} ${detail}`);
    health.push({ id: r.feed.id, name: r.feed.name, ok: r.ok, count: r.items.length, error: r.error });
  }
  console.log('  ' + '─'.repeat(58));
  const okCount = results.filter((r) => r.ok).length;
  console.log(`  ${okCount}/${enabled.length} feeds live\n`);

  // ---- combine, recency-filter, dedupe ----
  const cutoff = Date.now() - hours * 3600 * 1000;
  let all = results.flatMap((r) => r.items);

  const withDate = all.filter((it) => it.published && it.published.getTime() >= cutoff);
  const noDate = all.filter((it) => !it.published); // keep undated items as a fallback pool

  // Prefer dated-and-recent; fall back to undated only if recent pool is thin.
  let pool = withDate;
  if (pool.length < 12) {
    console.log(`  ⚠ Only ${pool.length} dated items in last ${hours}h — including ${noDate.length} undated as fallback.`);
    pool = [...withDate, ...noDate];
  }

  // Sort BEST-FIRST before dedup so the highest-weight (most authoritative) source's
  // copy of a shared story is the one we keep; tie-break on recency.
  pool.sort((a, b) => {
    const w = (b.weight || 1) - (a.weight || 1);
    if (w !== 0) return w;
    return (b.published?.getTime() || 0) - (a.published?.getTime() || 0);
  });

  const deduped = dedupe(pool, seenLinks);

  // Final display order: newest first (undated sink to the bottom).
  deduped.sort((a, b) => (b.published?.getTime() || 0) - (a.published?.getTime() || 0));

  console.log(`  → ${deduped.length} unique stories in window (from ${all.length} raw items)\n`);
  return { items: deduped, health };
}
