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

// Summarise ONE story into headline + summary + "so what".
async function summariseStory(item, { lead = false } = {}) {
  const prompt = `${HOUSE}

Rewrite this raw news item into Guardian Times editorial. Return ONLY JSON, no markdown:
{
  "headline": "a sharp, specific headline that makes a professional want to read — not clickbait, ${lead ? '14-22' : '8-16'} words",
  "summary": "${lead ? '3-4' : '2-3'} sentences, your own words, conveying what actually happened and why it matters. Never copy the source text.",
  "soWhat": "${lead ? 'one tight paragraph' : 'one sentence'} on the investment implication for an Indian investor — the analytical 'so what'. ${lead ? '' : 'Keep it to a single sentence.'}"
}

RAW ITEM:
Title: ${item.title}
Source: ${item.source}
Text: ${item.rawSummary || '(no description in feed)'}`;

  try {
    const out = extractJson(await callGemini(prompt, { maxTokens: lead ? 700 : 400 }));
    return {
      ...item,
      headline: out.headline || item.title,
      summary: out.summary || item.rawSummary,
      soWhat: out.soWhat || '',
      aiGenerated: true,
    };
  } catch (err) {
    console.log(`    ⚠ summary fallback for "${item.title.slice(0, 40)}…" (${err.message})`);
    return { ...item, headline: item.title, summary: item.rawSummary, soWhat: '', aiGenerated: false };
  }
}

// Generate the Knowledge Desk "mechanism of the day" from the day's lead stories.
export async function generateMechanism(topItems) {
  const context = topItems.slice(0, 8).map((i) => `- ${i.headline || i.title}`).join('\n');
  const prompt = `${HOUSE}

From today's lead stories below, pick ONE genuinely non-obvious financial MECHANISM worth teaching from first principles — the plumbing most people never learn (tax mechanics, market microstructure, capital-structure detail, a valuation lever). It must connect to one of the stories.

Return ONLY JSON:
{
  "tier": "Foundations" or "Frontier",
  "title": "the mechanism, as a sharp question or statement (8-16 words)",
  "body": "3-4 short paragraphs explaining the mechanism step by step, first principles, precise. Use plain text; mark step labels like 'Step 1 —'.",
  "points": [ {"n":"short stat/label","l":"≤8-word gloss"}, {"n":"...","l":"..."}, {"n":"...","l":"..."} ]
}

TODAY'S STORIES:
${context}`;
  try {
    return extractJson(await callGemini(prompt, { maxTokens: 1200 }));
  } catch (err) {
    console.log(`  ⚠ mechanism generation failed (${err.message}); using fallback.`);
    return null;
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
