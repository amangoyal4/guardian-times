// summarize.js — turns raw stories into Guardian Times editorial via Gemini (free tier).
// Handles rate limits with exponential backoff. Falls back to raw text if the API is unavailable.

import { diverseVideos } from './library.js';

const MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
const API_KEY = process.env.GEMINI_API_KEY;
const ENDPOINT = (model) =>
  `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${API_KEY}`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- rate-limit circuit breaker ----
// On the free tier, once the API starts hard-throttling it rarely recovers
// within a run. Rather than grind through hundreds of 429 backoffs (a single
// run was observed taking 70 minutes), we trip a breaker after a few calls
// exhaust their retries on 429 — every subsequent call then fails instantly
// and the caller falls back. One success closes the breaker again.
let rateLimitStrikes = 0;
let circuitOpen = false;
const STRIKE_LIMIT = 3;

// ---- low-level call with backoff on 429/5xx ----
async function callGemini(prompt, { maxTokens = 700, tries = 4 } = {}) {
  if (!API_KEY) throw new Error('GEMINI_API_KEY not set');
  if (circuitOpen) throw new Error('Gemini circuit open (sustained rate limiting)');
  let delay = 2000;
  let saw429 = false;
  for (let attempt = 1; attempt <= tries; attempt++) {
    try {
      const res = await fetch(ENDPOINT(MODEL), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: {
            temperature: 0.4,
            maxOutputTokens: maxTokens,
            // gemini-2.5-* default to "thinking", and thinking tokens are drawn
            // from maxOutputTokens — leaving the text empty. Disable it so the
            // whole budget goes to the actual answer.
            thinkingConfig: { thinkingBudget: 0 },
          },
        }),
      });
      if (res.status === 429 || res.status >= 500) {
        saw429 = true;
        console.log(`    rate/again (${res.status}) — backoff ${delay}ms`);
        await sleep(delay); delay *= 2; continue;
      }
      if (!res.ok) throw new Error(`Gemini ${res.status}: ${await res.text()}`);
      const data = await res.json();
      const text = data?.candidates?.[0]?.content?.parts?.map((p) => p.text).join('') || '';
      if (!text.trim()) throw new Error('empty response from model');
      rateLimitStrikes = 0; // a clean success resets the breaker
      return text.trim();
    } catch (err) {
      if (attempt === tries) throw err;
      await sleep(delay); delay *= 2;
    }
  }
  // Exhausted all retries on 429/5xx without ever returning — fail cleanly so
  // the caller falls back instead of receiving undefined, and count a strike.
  if (saw429 && ++rateLimitStrikes >= STRIKE_LIMIT) {
    circuitOpen = true;
    console.log('    ⚡ rate-limit circuit OPEN — skipping remaining AI calls this run.');
  }
  throw new Error('Gemini: exhausted retries (rate-limited)');
}

function extractJson(text) {
  const cleaned = text.replace(/```json|```/g, '').trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start === -1 || end === -1) throw new Error('no JSON in response');
  return JSON.parse(cleaned.slice(start, end + 1));
}

const HOUSE = `You are the editor of "Guardian Times", a sophisticated personalised financial newspaper for an Indian investment professional (wealth/PMS/AIF advisory).
Voice: precise, first-principles, analytical, clean prose — never hype, never filler. Indian-English spelling. Currency in ₹ where Indian, $ where global.`;

// Summarise ONE story into headline + summary + "so what" (+ optional chart for leads).
async function summariseStory(item, { lead = false } = {}) {
  // Any story MAY carry a chart, but only when the news itself has a real data
  // story to tell — a comparison or trend the reader should interpret. Most
  // stories will (correctly) have no chart; a decorative chart is worse than none.
  const chartSpec = `,
  "chart": null in MOST cases. Include a chart object ONLY IF this item states 2-6 concrete, comparable numeric figures that genuinely reveal something (a trend over time, a before/after, a ranking, a breakdown) — NOT a single number, NOT a price quote, NOT vague mentions. The chart must EXPLAIN the story, not decorate it. Shape:
    { "type":"bar" (for comparisons/rankings) or "line" (for a time trend), "title":"≤6-word title", "unit":"₹cr" or "%" or "$" or "", "dp":0, "series":[ {"label":"≤14 chars","value":number}, ... 2-6 entries ], "note":"a full, specific sentence (≤22 words) explaining what the chart shows and what the reader should conclude from it" }
    STRICT: use ONLY numbers explicitly present in the item text — NEVER invent, estimate, or extrapolate. If the figures don't form a genuine comparison or trend, set "chart": null.`;
  const prompt = `${HOUSE}

Rewrite this raw news item into Guardian Times editorial — substantive and specific, never padded. Return ONLY JSON, no markdown:
{
  "headline": "a sharp, specific headline that makes a professional want to read — not clickbait, ${lead ? '14-22' : '8-16'} words",
  "summary": "${lead ? '4-5' : '3-4'} sentences, your own words. Cover WHAT happened, the key numbers/specifics, WHY it happened, and the read-through. Be concrete and information-dense — name the figures, the players, the cause. Never copy the source text, never waffle.",
  "soWhat": "${lead ? 'two or three sentences' : 'one or two sentences'} on the investment implication for an Indian wealth/PMS/AIF professional — the analytical 'so what': who is affected, which way, and what to watch."${chartSpec}
}

RAW ITEM:
Title: ${item.title}
Source: ${item.source}
Text: ${item.rawSummary || '(no description in feed)'}`;

  try {
    const out = extractJson(await callGemini(prompt, { maxTokens: lead ? 1200 : 800 }));
    return {
      ...item,
      headline: out.headline || item.title,
      summary: out.summary || item.rawSummary,
      soWhat: out.soWhat || '',
      chart: out.chart || null,
      aiGenerated: true,
    };
  } catch (err) {
    console.log(`    ⚠ summary fallback for "${item.title.slice(0, 40)}…" (${err.message})`);
    return { ...item, headline: item.title, summary: item.rawSummary, soWhat: '', chart: null, aiGenerated: false };
  }
}

/**
 * Editor pass: from a routed pool, pick the genuinely important stories per
 * section and DROP procedural noise (auction notices/results, "ahead of market",
 * "quick wrap", routine roundups). One Gemini call; falls back to null on failure
 * so the caller can keep its own ranking.
 * Returns { macro:[link,...], sector:[...], india:[...], global:[...], compliance:[...] }.
 */
export async function selectStories(bySection, perSection = 8) {
  // Build a compact, id-tagged catalogue the model can reference by link.
  const sections = ['macro', 'sector', 'india', 'global', 'compliance'];
  const lines = [];
  for (const sec of sections) {
    const items = bySection[sec] || [];
    if (!items.length) continue;
    lines.push(`\n## ${sec.toUpperCase()}`);
    for (const it of items.slice(0, 24)) {
      lines.push(`[${it.link}] ${it.isIndian ? 'IN' : 'GL'} (${it.source}) ${it.title}`);
    }
  }
  const catalogue = lines.join('\n');

  const prompt = `${HOUSE}

You are doing the morning EDITORIAL CUT for today's edition. Below is the candidate pool, grouped by section, each line tagged with its [id], region (IN/GL), source and headline.

Your job: for EACH section, select the most IMPORTANT, decision-relevant stories a wealth/PMS professional must know — and RUTHLESSLY DROP procedural noise. Specifically DROP:
- routine auction notices and results (RBI VRR/repo/reverse-repo auctions, T-bill / G-Sec / SDL auction announcements or cut-offs, "full auction result")
- "Ahead of Market: N things", "things to know before", "quick wrap", "market wrap", generic daily roundups, "stocks to watch" lists
- horoscope-style technical calls ("5 stocks to buy", "trading guide") with no real news
- near-duplicates: keep the single best version of the same story

Selection rules:
- Each section: pick up to ${perSection}, fewer if the pool is thin — quality over filling slots.
- Within a section, order Indian stories first (IN), then global (GL); within each, most important first.
- A story must stay in the section it was filed under.
- Use ONLY ids that appear below. Do not invent ids.

Return ONLY JSON, no markdown:
{ "macro":["id",...], "sector":["id",...], "india":["id",...], "global":["id",...], "compliance":["id",...] }

CANDIDATE POOL:
${catalogue}`;

  try {
    const out = extractJson(await callGemini(prompt, { maxTokens: 1500 }));
    const valid = {};
    for (const sec of sections) valid[sec] = Array.isArray(out[sec]) ? out[sec] : [];
    return valid;
  } catch (err) {
    console.log(`  ⚠ editor cut failed (${err.message}); falling back to ranking.`);
    return null;
  }
}

// Generate the Knowledge Desk "mechanism of the day" from the day's lead stories.
export async function generateMechanism(topItems) {
  const context = topItems.slice(0, 10).map((i) => `- ${i.headline || i.title}`).join('\n');
  const prompt = `${HOUSE}

From today's lead stories below, pick ONE genuinely non-obvious financial MECHANISM worth teaching from first principles — the plumbing most professionals never actually learn (tax mechanics, market microstructure, capital-structure detail, a valuation lever, settlement/clearing, an arbitrage). It must connect to at least one of today's stories.

Teach it the way a great desk-head would, EXHAUSTIVELY: precise, first-principles, with the actual numbers, the worked example, the lever that matters, AND the second- and third-order consequences. Avoid platitudes and filler. The reader is an Indian wealth/PMS/AIF professional — they already know the basics; give them the deep layer beneath, the part that changes how they act.

Return ONLY JSON:
{
  "tier": "Foundations" or "Frontier",
  "title": "the mechanism, as a sharp question or statement (8-16 words)",
  "hook": "1-2 sentences on why this matters TODAY, tied to a specific story",
  "body": "6-8 substantial paragraphs explaining the mechanism step by step from first principles. Be concrete and rigorous: include at least one fully worked numerical example with ₹/% figures carried through, name each cause-and-effect link explicitly, cover the second- AND third-order consequences, and note where the textbook intuition breaks. Use plain text; mark step labels like 'Step 1 —'. Separate paragraphs with a blank line.",
  "takeaway": "2-3 sentences: the practical lesson the reader applies, and the specific signal to watch",
  "points": [ {"n":"short stat/label","l":"≤8-word gloss"}, {"n":"...","l":"..."}, {"n":"...","l":"..."}, {"n":"...","l":"..."} ]
}

TODAY'S STORIES:
${context}`;
  try {
    return extractJson(await callGemini(prompt, { maxTokens: 2800 }));
  } catch (err) {
    console.log(`  ⚠ mechanism generation failed (${err.message}); using fallback.`);
    return null;
  }
}

// Generate 2 deeper concept explainers ("things to learn") for the Knowledge Desk.
export async function generateExplainers(topItems) {
  const context = topItems.slice(0, 14).map((i) => `- ${i.headline || i.title}`).join('\n');
  const prompt = `${HOUSE}

From today's themes, write FOUR substantial EXPLAINERS that expand the reader's knowledge base — concepts, instruments, frameworks, or financial-jargon worth genuinely understanding, each tied to today's news but teaching something durable (not just recapping the news). Make all four DIFFERENT from each other (mix instrument / tax / macro / market-structure), and make each reward a professional with a real "I didn't fully get that before" moment.

Return ONLY JSON:
{ "explainers": [
  { "tag":"one word, e.g. Instrument/Tax/Macro/Structure", "title":"the concept (6-12 words)", "body":"2-3 tight, information-dense paragraphs explaining it from first principles with a concrete worked example; plain text, blank line between paragraphs.", "why":"≤20-word line on why it matters now" },
  { ...second, different concept... },
  { ...third, different concept... },
  { ...fourth, different concept... }
] }

TODAY'S THEMES:
${context}`;
  try {
    return extractJson(await callGemini(prompt, { maxTokens: 2600 })).explainers || [];
  } catch (err) {
    console.log(`  ⚠ explainers generation failed (${err.message}).`);
    return [];
  }
}

// Generate 3 "consensus gets wrong" myth-busters from the day's themes.
export async function generateMyths(topItems) {
  const context = topItems.slice(0, 12).map((i) => `- ${i.headline || i.title}`).join('\n');
  const prompt = `${HOUSE}

From today's themes, write 5 "what the consensus gets wrong" entries — common misconceptions a professional should unlearn, each tied to today's news. Make them genuinely non-obvious, not strawmen.
Return ONLY JSON: { "myths": [ {"tag":"one word e.g. Flows/Valuation/Credit","claim":"the wrong belief in quotes","correction":"2-3 sentence correction with the real mechanism"}, ... x5 ] }

THEMES:
${context}`;
  try {
    return extractJson(await callGemini(prompt, { maxTokens: 1200 })).myths || [];
  } catch {
    return [];
  }
}

/**
 * Curate the LIBRARY desk: from the fetched RSS pool, pick the most knowledge-rich
 * Indian-markets videos (diverse across channels) and the single best podcast
 * episode, writing a tight editorial blurb for each. ONE Gemini call; on any
 * failure it falls back to a deterministic recency+diversity pick using the feeds'
 * own (cleaned) descriptions — so a quota throttle never blanks the section.
 * @returns {Promise<{videos: object[], podcast: object|null}>}
 */
export async function curateLibrary({ videos = [], podcasts = [] } = {}, { pickVideos = 5 } = {}) {
  const fallback = () => ({
    videos: diverseVideos(videos, pickVideos).map((v) => ({ ...v, blurb: v.rawDesc || '' })),
    podcast: podcasts[0] ? { ...podcasts[0], blurb: podcasts[0].rawDesc || '' } : null,
  });
  if (!videos.length && !podcasts.length) return { videos: [], podcast: null };

  const vPool = videos.slice(0, 24);
  const pPool = podcasts.slice(0, 8);
  const vLines = vPool.map((v, i) => `[v${i}] (${v.channel}) ${v.title} :: ${v.rawDesc.slice(0, 160)}`);
  const pLines = pPool.map((p, i) => `[p${i}] (${p.show}) ${p.title} :: ${p.rawDesc.slice(0, 200)}`);

  const prompt = `${HOUSE}

You are curating today's LIBRARY desk — the best finance learning to watch and listen to. From the candidate YouTube videos and podcast episodes below (each tagged with an [id], its channel/show, title and blurb), choose:
- the ${pickVideos} MOST genuinely knowledge-rich videos a serious Indian investment professional would gain from — either directly India-markets-relevant OR durable global investing/finance wisdom (valuation, portfolio construction, market structure, macro, behavioural finance). Favour depth and teaching over news recaps or shorts; pick DIFFERENT channels where possible for variety, and aim for a mix of Indian and global perspectives.
- the ONE best, most substantive podcast episode of the day for a thoughtful investor.

For each pick write a tight 1-2 sentence editorial blurb (your own words) on what the viewer/listener will actually LEARN — concrete, never hype.

Return ONLY JSON, no markdown:
{ "videos": [ {"id":"v0","blurb":"..."}, ... ${pickVideos} entries ], "podcast": {"id":"p0","blurb":"..."} }
Use ONLY ids that appear below.

VIDEOS:
${vLines.join('\n')}

PODCASTS:
${pLines.join('\n')}`;

  try {
    const out = extractJson(await callGemini(prompt, { maxTokens: 1100 }));
    const vById = new Map(vPool.map((v, i) => [`v${i}`, v]));
    const pById = new Map(pPool.map((p, i) => [`p${i}`, p]));

    const picked = (out.videos || [])
      .map((x) => { const v = vById.get(x.id); return v ? { ...v, blurb: (x.blurb || v.rawDesc || '').trim() } : null; })
      .filter(Boolean)
      .slice(0, pickVideos);

    // Top up with diverse recency picks if the model returned fewer than asked.
    if (picked.length < pickVideos) {
      const have = new Set(picked.map((v) => v.link));
      for (const v of diverseVideos(videos, pickVideos * 2)) {
        if (picked.length >= pickVideos) break;
        if (!have.has(v.link)) { picked.push({ ...v, blurb: v.rawDesc || '' }); have.add(v.link); }
      }
    }

    let podcast = null;
    const pPick = out.podcast?.id && pById.get(out.podcast.id);
    if (pPick) podcast = { ...pPick, blurb: (out.podcast.blurb || pPick.rawDesc || '').trim() };
    else if (podcasts[0]) podcast = { ...podcasts[0], blurb: podcasts[0].rawDesc || '' };

    if (!picked.length && !podcast) return fallback();
    return { videos: picked, podcast };
  } catch (err) {
    console.log(`  ⚠ library curation failed (${err.message}); using recency fallback.`);
    return fallback();
  }
}

/**
 * Summarise a routed, ranked set of stories.
 * Spaces calls to respect free-tier RPM. `leadIds` get the longer treatment.
 */
export async function summariseAll(items, { leadIds = new Set(), gapMs = 6500 } = {}) {
  const out = [];
  console.log(`\n✍  Summarising ${items.length} stories via ${MODEL}…`);
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const lead = leadIds.has(item.link);
    out.push(await summariseStory(item, { lead }));
    if (i < items.length - 1) await sleep(gapMs); // stay under free-tier RPM
  }
  console.log(`   done (${out.filter((x) => x.aiGenerated).length}/${out.length} AI-written)\n`);
  return out;
}
