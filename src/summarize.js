// summarize.js — turns raw stories into Guardian Times editorial via Gemini (free tier).
// Handles rate limits with exponential backoff. Falls back to raw text if the API is unavailable.

const MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
const API_KEY = process.env.GEMINI_API_KEY;
const ENDPOINT = (model) =>
  `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${API_KEY}`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- low-level call with backoff on 429/5xx ----
async function callGemini(prompt, { maxTokens = 700, tries = 5 } = {}) {
  if (!API_KEY) throw new Error('GEMINI_API_KEY not set');
  let delay = 1000;
  for (let attempt = 1; attempt <= tries; attempt++) {
    try {
      const res = await fetch(ENDPOINT(MODEL), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0.4, maxOutputTokens: maxTokens },
        }),
      });
      if (res.status === 429 || res.status >= 500) {
        console.log(`    rate/again (${res.status}) — backoff ${delay}ms`);
        await sleep(delay); delay *= 2; continue;
      }
      if (!res.ok) throw new Error(`Gemini ${res.status}: ${await res.text()}`);
      const data = await res.json();
      const text = data?.candidates?.[0]?.content?.parts?.map((p) => p.text).join('') || '';
      return text.trim();
    } catch (err) {
      if (attempt === tries) throw err;
      await sleep(delay); delay *= 2;
    }
  }
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
  // Only lead stories get the optional explanatory chart, to keep prompts tight.
  const chartSpec = lead
    ? `,
  "chart": null OR — ONLY IF this item states concrete, comparable numeric figures — an object:
    { "type":"bar" or "line", "title":"≤6-word title", "unit":"₹cr" or "%" or "$" or "", "dp":0, "series":[ {"label":"≤14 chars","value":number}, ... 2-6 entries ], "note":"≤12-word takeaway the reader should draw" }
    STRICT: use ONLY numbers explicitly present in the item text. NEVER invent or estimate figures. If there are no concrete figures, set "chart": null.`
    : '';
  const prompt = `${HOUSE}

Rewrite this raw news item into Guardian Times editorial. Return ONLY JSON, no markdown:
{
  "headline": "a sharp, specific headline that makes a professional want to read — not clickbait, ${lead ? '14-22' : '8-16'} words",
  "summary": "${lead ? '3-4' : '2-3'} sentences, your own words, conveying what actually happened and why it matters. Never copy the source text.",
  "soWhat": "${lead ? 'one tight paragraph' : 'one sentence'} on the investment implication for an Indian investor — the analytical 'so what'. ${lead ? '' : 'Keep it to a single sentence.'}"${chartSpec}
}

RAW ITEM:
Title: ${item.title}
Source: ${item.source}
Text: ${item.rawSummary || '(no description in feed)'}`;

  try {
    const out = extractJson(await callGemini(prompt, { maxTokens: lead ? 900 : 400 }));
    return {
      ...item,
      headline: out.headline || item.title,
      summary: out.summary || item.rawSummary,
      soWhat: out.soWhat || '',
      chart: lead ? out.chart || null : null,
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
    for (const it of items.slice(0, 40)) {
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

Teach it the way a great desk-head would: precise, first-principles, with the actual numbers and the lever that matters. Avoid platitudes. The reader is an Indian wealth/PMS/AIF professional — they already know the basics; give them the layer beneath.

Return ONLY JSON:
{
  "tier": "Foundations" or "Frontier",
  "title": "the mechanism, as a sharp question or statement (8-16 words)",
  "hook": "1 sentence on why this matters TODAY, tied to a story",
  "body": "4-6 substantial paragraphs explaining the mechanism step by step from first principles. Be concrete: use worked examples with ₹/% figures, name the cause-and-effect, and the second-order consequence. Use plain text; mark step labels like 'Step 1 —'. Separate paragraphs with a blank line.",
  "takeaway": "1-2 sentences: the practical lesson the reader applies",
  "points": [ {"n":"short stat/label","l":"≤8-word gloss"}, {"n":"...","l":"..."}, {"n":"...","l":"..."} ]
}

TODAY'S STORIES:
${context}`;
  try {
    return extractJson(await callGemini(prompt, { maxTokens: 1800 }));
  } catch (err) {
    console.log(`  ⚠ mechanism generation failed (${err.message}); using fallback.`);
    return null;
  }
}

// Generate 2 deeper concept explainers ("things to learn") for the Knowledge Desk.
export async function generateExplainers(topItems) {
  const context = topItems.slice(0, 12).map((i) => `- ${i.headline || i.title}`).join('\n');
  const prompt = `${HOUSE}

From today's themes, write TWO short EXPLAINERS that expand the reader's knowledge base — concepts, instruments, or frameworks worth genuinely understanding, each tied to today's news but teaching something durable (not just recapping the news). Pick concepts that are DIFFERENT from each other and reward a professional with a real "I didn't fully get that before" moment.

Return ONLY JSON:
{ "explainers": [
  { "tag":"one word, e.g. Instrument/Tax/Macro/Structure", "title":"the concept (6-12 words)", "body":"2-3 tight paragraphs explaining it from first principles with a concrete example; plain text, blank line between paragraphs.", "why":"≤18-word line on why it matters now" },
  { ... second, on a different concept ... }
] }

TODAY'S THEMES:
${context}`;
  try {
    return extractJson(await callGemini(prompt, { maxTokens: 1400 })).explainers || [];
  } catch (err) {
    console.log(`  ⚠ explainers generation failed (${err.message}).`);
    return [];
  }
}

// Generate 3 "consensus gets wrong" myth-busters from the day's themes.
export async function generateMyths(topItems) {
  const context = topItems.slice(0, 10).map((i) => `- ${i.headline || i.title}`).join('\n');
  const prompt = `${HOUSE}

From today's themes, write 3 "what the consensus gets wrong" entries — common misconceptions a professional should unlearn, tied to today's news.
Return ONLY JSON: { "myths": [ {"tag":"one word e.g. Flows/Valuation/Credit","claim":"the wrong belief in quotes","correction":"1-2 sentence correction"}, ... x3 ] }

THEMES:
${context}`;
  try {
    return extractJson(await callGemini(prompt, { maxTokens: 700 })).myths || [];
  } catch {
    return [];
  }
}

/**
 * Summarise a routed, ranked set of stories.
 * Spaces calls to respect free-tier RPM. `leadIds` get the longer treatment.
 */
export async function summariseAll(items, { leadIds = new Set(), gapMs = 4500 } = {}) {
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
