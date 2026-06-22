// article.js — best-effort full-text fetch for a SMALL number of lead stories.
//
// Why this exists (Option B, the legal way):
// A publisher's article often carries a graph/pictograph whose figures include
// HISTORICAL/past data — a metric across several quarters or years — that the
// 600-char RSS snippet we normally hold does NOT contain. To re-create that data
// as OUR OWN clean house-style chart we need those numbers. The legal route is to
// read the PUBLIC ARTICLE TEXT and extract the FACTS (numbers, names, dates) —
// facts are not copyrightable — then render our own SVG. We NEVER copy the
// publisher's prose and NEVER download, hotlink or republish their chart images.
// "Their data, our chart" — facts in, original expression out.
//
// Resilience-first: any failure (timeout, block, 404) returns '' so the build
// silently falls back to the RSS snippet. Run only for leads to keep it cheap.

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

// Minimal HTML-entity decode for the handful that survive tag-stripping.
function decodeEntities(s = '') {
  return s
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#0?39;|&rsquo;|&lsquo;|&apos;/gi, "'")
    .replace(/&ldquo;|&rdquo;/gi, '"')
    .replace(/&mdash;/gi, '—')
    .replace(/&ndash;/gi, '–')
    .replace(/&hellip;/gi, '…')
    .replace(/&#(\d+);/g, (_, n) => {
      try { return String.fromCodePoint(+n); } catch { return ' '; }
    });
}

// Strip an HTML document down to readable body text. Prefers the <article> block
// when present (cuts nav/footer/related-links chrome), else falls back to <body>.
function htmlToText(html = '', maxChars = 6000) {
  let h = html;
  // kill the non-content noise first
  h = h
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<svg[\s\S]*?<\/svg>/gi, ' ');

  // prefer the main article container if the page exposes one
  const art = h.match(/<article[\s\S]*?<\/article>/i);
  if (art && art[0].length > 400) h = art[0];

  const text = decodeEntities(
    h
      .replace(/<(p|div|br|li|h[1-6]|tr|figcaption)[^>]*>/gi, '\n') // block tags → newline
      .replace(/<[^>]+>/g, ' ') // remaining tags → space
  )
    .replace(/[ \t]+/g, ' ')
    .replace(/\n[ \t]*/g, '\n')
    .replace(/\n{2,}/g, '\n')
    .trim();

  return text.length > maxChars ? text.slice(0, maxChars) : text;
}

/**
 * Fetch one article and return clean body text (or '' on any failure).
 * @param {string} url
 * @param {object} opts  { maxChars=6000, timeoutMs=9000 }
 */
export async function fetchArticleText(url, { maxChars = 6000, timeoutMs = 9000 } = {}) {
  if (!url || !/^https?:\/\//i.test(url)) return '';
  try {
    const res = await fetch(url, {
      redirect: 'follow',
      signal: AbortSignal.timeout(timeoutMs),
      headers: {
        'User-Agent': UA,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-IN,en;q=0.9',
      },
    });
    if (!res.ok) return '';
    const ctype = res.headers.get('content-type') || '';
    if (!/text\/html|application\/xhtml/i.test(ctype)) return '';
    const html = await res.text();
    const text = htmlToText(html, maxChars);
    // Guard: if extraction is too thin to be a real article body, treat as miss
    // so the caller keeps the (often longer) RSS snippet instead.
    return text.length >= 400 ? text : '';
  } catch {
    return '';
  }
}

/**
 * Attach `.fullText` to the LEAD items in `items` (mutates in place). Best-effort,
 * parallel, and bounded — only leads get fetched, so this is a handful of requests.
 * Anything that fails just leaves `.fullText` undefined and the story falls back to
 * its RSS snippet.
 * @param {object[]} items     the flat list about to be summarised
 * @param {Set<string>} leadLinks  links flagged as section leads
 */
export async function attachFullText(items, leadLinks, opts = {}) {
  const leads = items.filter((it) => leadLinks.has(it.link));
  if (!leads.length) return;
  let got = 0;
  await Promise.all(
    leads.map(async (it) => {
      const t = await fetchArticleText(it.link, opts);
      if (t) { it.fullText = t; got++; }
    })
  );
  console.log(`  📰 full-text enrichment: ${got}/${leads.length} lead articles fetched for richer charts`);
}
