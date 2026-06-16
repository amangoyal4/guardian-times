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

// Normalise one raw RSS item into our internal shape.
function normalise(item, feed) {
  const link = item.link || item.guid || '';
  const published = item.isoDate || item.pubDate || null;
  return {
    feedId: feed.id,
    source: feed.name.split(' — ')[0], // "Business Standard — Markets" -> "Business Standard"
    sectionHint: feed.section,
    region: feed.region,
    weight: feed.weight || 1,
    title: stripHtml(item.title || '').trim(),
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

// De-dup: drop items whose link OR very-similar title we've already seen
// (within this run AND against the previous edition's links passed in `seenLinks`).
function dedupe(items, seenLinks = new Set()) {
  const out = [];
  const titleKeys = new Set();
  for (const it of items) {
    const linkKey = it.link.split('?')[0].replace(/\/$/, '');
    const titleKey = it.title.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().slice(0, 60);
    if (seenLinks.has(linkKey) || titleKeys.has(titleKey)) continue;
    titleKeys.add(titleKey);
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
  const enabled = FEEDS.filter((f) => f.enabled);
  console.log(`\n📡 Fetching ${enabled.length} feeds…\n`);

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

  const deduped = dedupe(pool, seenLinks);

  // newest first (undated sink to the bottom)
  deduped.sort((a, b) => (b.published?.getTime() || 0) - (a.published?.getTime() || 0));

  console.log(`  → ${deduped.length} unique stories in window (from ${all.length} raw items)\n`);
  return { items: deduped, health };
}
