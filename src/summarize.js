// summarize.js — turns raw stories into Guardian Capital Brief editorial via Gemini.
// Hybrid tier: Gemini 2.5 Pro (+ "thinking") for the reasoning-heavy editor's cut
// and Mechanism of the Day; Gemini 2.5 Flash for the high-volume summaries + audio
// script. ~3× cheaper than full Pro with near-identical quality.
// Handles rate limits with exponential backoff. Falls back to raw text if the API is unavailable.

import { diverseVideos } from './library.js';

// Hybrid model routing — the cost/quality sweet spot:
//   • PRO   handles the reasoning-heavy pieces where quality visibly shows:
//           the editor's story selection and the Mechanism of the Day.
//           It also writes the LEAD stories' summaries (the marquee items with
//           the fuller analysis that readers scrutinise most).
//   • FLASH handles the high-volume, low-divergence work: the long-tail story
//           summaries and the audio briefing script (Flash reads nearly the
//           same here at ~5× lower cost).
// This lands total spend around a third of full-Pro with almost no perceptible
// quality loss. Override either via env if needed.
const PRO   = process.env.GEMINI_MODEL       || 'gemini-2.5-pro';
const FLASH = process.env.GEMINI_FLASH_MODEL || 'gemini-2.5-flash';
const MODEL = PRO; // default for callGemini calls that don't name a model
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
// `maxTokens` is the budget for the VISIBLE answer; `thinking` is a separate
// budget for the model's internal reasoning. Gemini 2.5 draws thinking tokens
// from maxOutputTokens, so we send (answer + thinking) as the cap — otherwise a
// rich think pass eats the whole budget and the visible answer returns empty.
// (Gemini 2.5 Pro cannot turn thinking off; Flash can, via thinking: 0.)
async function callGemini(prompt, { maxTokens = 1024, tries = 4, thinking = 256, temperature = 0.4, model = MODEL } = {}) {
  if (!API_KEY) throw new Error('GEMINI_API_KEY not set');
  if (circuitOpen) throw new Error('Gemini circuit open (sustained rate limiting)');
  let delay = 2000;
  let saw429 = false;
  for (let attempt = 1; attempt <= tries; attempt++) {
    try {
      const res = await fetch(ENDPOINT(model), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: {
            temperature,
            maxOutputTokens: maxTokens + thinking,
            thinkingConfig: { thinkingBudget: thinking },
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

const HOUSE = `You are the editor of "The Guardian Capital Brief", a sophisticated daily financial newspaper read each morning by intelligent Indian readers who follow markets and money — from everyday investors to seasoned professionals. Write for that GENERAL audience: sharp and substantive, but never pitched at, or addressed to, any one group.
Voice: precise, first-principles, analytical, confident, clean prose — the register of the FT or The Economist, never hype, never filler, never hedging. Lead with the most important fact. Every sentence must earn its place by adding new information. Prefer concrete figures and named entities over adjectives. Avoid clichés ("in a significant development", "it remains to be seen", "only time will tell", "sent shockwaves"). Indian-English spelling. Currency in ₹ where Indian, $ where global; write large numbers the Indian way (₹ crore/lakh) for Indian figures.
ACCURACY IS ABSOLUTE: reproduce every figure — exchange rates, index levels, prices, percentages, dates — EXACTLY as it appears in the source. NEVER "correct", round, or substitute a number from your own training/memory, even if it looks wrong or surprising to you. Market and currency levels move over time and YOUR MEMORY IS STALE — e.g. the rupee is far weaker than you recall; if the source says the rupee is at 95 to the dollar, write 95, never 83. The source article is the single source of truth; trust it over what you think you know.`;

// Summarise ONE story into headline + summary + "so what" (+ optional chart for leads).
async function summariseStory(item, { lead = false } = {}) {
  // For leads we may have fetched the FULL article text (see article.js). That body
  // usually contains the historical/comparative figures a publisher prints in its
  // graphs/pictographs — the very numbers the short RSS snippet drops. Using it lets
  // us re-create that data as OUR OWN clean house-style chart (legal: facts in,
  // original SVG out; we never copy their image).
  const hasFull = item.fullText && item.fullText.length > 200;

  // Any story MAY carry a chart, but only when the news itself has a real data
  // story to tell — a comparison or trend the reader should interpret. Most
  // stories will (correctly) have no chart; a decorative chart is worse than none.
  const chartSpec = `,
  "chart": null in MOST cases. Include a chart object ONLY IF the provided text states 2-6 concrete, comparable numeric figures that genuinely reveal something (a trend over time, a before/after, a ranking, a breakdown) — NOT a single number, NOT a price quote, NOT vague mentions. ${hasFull ? 'PREFER a "line" time-series when the article body gives a metric across several periods (quarters/years) — those historical trends are the most valuable charts; reconstruct the full series from the figures stated in the body. ' : ''}The chart must EXPLAIN the story, not decorate it. Shape:
    { "type":"bar" (for comparisons/rankings) or "line" (for a time trend), "title":"≤6-word title", "unit":"₹cr" or "%" or "$" or "", "dp":0, "series":[ {"label":"≤14 chars","value":number}, ... 2-6 entries ], "note":"a full, specific sentence (≤22 words) explaining what the chart shows and what the reader should conclude from it" }
    STRICT: use ONLY numbers explicitly present in the provided text (headline, snippet, or full article body when given) — NEVER invent, estimate, extrapolate, or recall figures from memory. If the figures don't form a genuine comparison or trend, set "chart": null.`;
  const sourceBlock = hasFull
    ? `RAW ITEM:
Title: ${item.title}
Source: ${item.source}
Full article body (use this to extract figures for the chart — including any historical or year-on-year series the headline omits; do NOT copy its wording into the summary):
${item.fullText}`
    : `RAW ITEM:
Title: ${item.title}
Source: ${item.source}
Text: ${item.rawSummary || '(no description in feed)'}`;
  const prompt = `${HOUSE}

Rewrite this raw news item into Guardian Capital Brief editorial — substantive, specific, and tight. Reason about what actually matters before you write. Return ONLY JSON, no markdown:
{
  "headline": "a sharp, specific headline that makes a reader want to read — not clickbait, carries the actual news (who + what + the key number), ${lead ? '14-22' : '8-16'} words",
  "summary": "${lead ? '4-5' : '3-4'} sentences, your own words. Open with the single most important fact. Then the key numbers/specifics, WHY it happened, and the read-through. Be concrete and information-dense — name the figures, the players, the cause, the magnitude. Where the feed text is thin, add the context a reader needs (but NEVER invent specific numbers). Never copy the source wording, never waffle, never hedge.",
  "soWhat": "${lead ? 'two or three sentences' : 'one or two sentences'} of genuine analysis — the 'so what' the source won't tell them: who is affected and which way, the second-order effect, and the specific thing to watch next. WRITE THE INSIGHT DIRECTLY, for a GENERAL audience. NEVER name or address any reader group ANYWHERE in the text (not just the opening) — BANNED: 'For wealth and PMS/AIF professionals…', 'For investment professionals…', 'For investors…', 'For advisors…', 'For traders…', and every 'For [audience], this…' construction. Just state what it means, plainly. Be concrete and news-specific — name the actual sectors, companies, instruments, or exposures affected and the real mechanism; ban vague filler like 'monitor developments', 'warrants close monitoring', 'in the coming quarters'. Not a restatement of the summary."
}

${sourceBlock}`;

  try {
    // Lead stories (the marquee items readers scrutinise, with the fuller
    // analysis) get Pro's sharper writing + "so what"; the long tail runs on
    // Flash. Selection and Mechanism are already Pro elsewhere.
    const out = extractJson(await callGemini(prompt, lead
      ? { maxTokens: 1500, thinking: 1100, temperature: 0.45, model: PRO }
      : { maxTokens: 900, thinking: 600, temperature: 0.45, model: FLASH }));
    return {
      ...item,
      headline: out.headline || item.title,
      summary: out.summary || item.rawSummary,
      soWhat: out.soWhat || '',
      chart: null, // charts removed
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
export async function selectStories(bySection, perSection = 8, { recentlyCovered = '' } = {}) {
  // Build a compact catalogue. CRITICAL: reference each story by a SHORT INTEGER
  // id, never its full URL. Earlier versions tagged lines with the raw link and
  // asked the model to echo links back; with ~40 selections that output ran past
  // maxTokens and truncated mid-JSON (no closing brace), so extractJson threw
  // "no JSON in response" and the whole editor cut fell back to the dumb keyword
  // router — the root cause of stories landing in the wrong section. Tiny integer
  // ids keep the response small enough to always complete.
  const sections = ['macro', 'sector', 'india', 'global', 'compliance'];
  const idToLink = new Map();
  const lines = [];
  let nextId = 1;
  for (const sec of sections) {
    const items = bySection[sec] || [];
    if (!items.length) continue;
    lines.push(`\n## ${sec.toUpperCase()}`);
    for (const it of items.slice(0, 30)) {
      const id = nextId++;
      idToLink.set(id, it.link);
      lines.push(`${id}. ${it.isIndian ? 'IN' : 'GL'}${it.paywalled ? ' [PAID]' : ''} (${it.source}) ${it.title}`);
    }
  }
  const catalogue = lines.join('\n');

  const prompt = `${HOUSE}

You are doing the morning EDITORIAL CUT for today's edition. Below is the candidate pool, grouped under the section each story was PROVISIONALLY filed in by an automated classifier. Each line starts with a numeric id, then region (IN/GL), source and headline. The provisional filing is OFTEN WRONG — your job includes RE-FILING each story into the correct section.

Your job: select the most IMPORTANT, decision-relevant stories a serious reader must know, PLACE EACH IN THE CORRECT SECTION, and RUTHLESSLY DROP procedural noise.

SECTION DEFINITIONS — re-file every story by what it is ACTUALLY about, ignoring where it was provisionally placed:
- macro = the economy & markets at large: interest rates, inflation, GDP, fiscal/trade data, currency (rupee/dollar), bond yields, banking-system liquidity & money-market rates, forex reserves & CROSS-BORDER FLOWS (FCNR(B)/NRI deposits, FPI/FII debt & equity flows, ECBs), commodities (crude/gold), central-bank action & RBI operations/data. NOT single companies.
- sector = a whole INDUSTRY or theme moving together (autos, pharma, banks, IT, realty, metals, defence, semiconductors). NOT a single company — one company's IPO/order/result is NOT a sector story.
- india = a specific INDIAN company or Indian single-stock / IPO / listing / order win / earnings / M&A / market-index move.
- global = "Global Markets": a NON-INDIAN company, market/index (Wall Street, Nasdaq, a US/EU/Asian stock) or a global MARKET/ECONOMIC development with real read-through to investors. A story about a global event whose angle is its impact ON India is usually macro or india, not global.
- compliance = a STATUTORY / REGULATORY BODY acting in its rule-making or enforcement capacity — and NOTHING ELSE. Qualifying bodies: SEBI, RBI, IRDAI, PFRDA, AMFI, MCA / IBBI / NFRA, the CCI, GST Council / CBDT / CBIC, or a stock exchange issuing a regulatory circular. Qualifying actions: circulars, master directions, consultation papers, new or changed norms/rules/frameworks, penalties, fines, bans, debarments, settlement/adjudication orders, enforcement. The story is about the RULE-MAKER or ENFORCER acting. EXCLUDE absolutely: a company simply doing an IPO or reporting earnings (→ india); AND all ordinary crime / law-enforcement news — arrests, police FIRs, ED/CBI raids, money-laundering cases, individual court verdicts, fraud-by-a-person stories. Those are NOT compliance even when finance-flavoured. If a crime item genuinely moves a listed stock, file it under india/global; otherwise DROP it. ALSO EXCLUDE (these are MACRO, not compliance): banking-system & deposit/forex FLOWS such as FCNR(B)/NRI deposit inflows, liquidity, money-market or FPI/FII flows, forex reserves, and routine RBI operations/data — compliance is ONLY when a regulator ISSUES a rule, norm, circular, penalty or order, never a description of money moving. If nothing in the pool is a genuine regulator action, leave compliance EMPTY — never pad it.

Examples of correct re-filing: "Banking liquidity falls, money-market rates rise" → macro (not india). "FCNR(B) inflows may miss initial estimates" / "NRI deposits surge" → macro (NOT compliance — it's a flow, not a regulator action). "Turtlemint IPO opens" → india (not sector). "Pharma sector faces US tariff overhang" → sector (a whole industry). "Asian equities hit record highs" → global (not macro). "NSE FY26 earnings ahead of IPO" → india (not compliance). "SEBI reworks margin-trading rules" → compliance. The SAME underlying theme (e.g. FCNR/deposit flows) must appear in ONE section only — never in both macro and compliance.

RUTHLESSLY DROP procedural noise:
- routine auction notices and results (RBI VRR/repo/reverse-repo auctions, T-bill / G-Sec / SDL auction announcements or cut-offs, "full auction result")
- "Ahead of Market: N things", "things to know before", "quick wrap", "market wrap", generic daily roundups, "stocks to watch" lists
- horoscope-style technical calls ("5 stocks to buy", "trading guide") with no real news
- ordinary CRIME / police-blotter news — arrests, FIRs, ED/CBI raids, court verdicts on individuals, money-laundering cases. These are NOT compliance and usually not worth a slot at all; drop them unless one genuinely moves a listed stock (then file under india/global, never compliance)
- pre-market index "previews" ("GIFT Nifty signals a flat/gap-down open", "Sensex to open higher") — daily filler, drop them all
- WAR / GEOPOLITICS / DIPLOMACY as general news — DROP unless the PRIMARY context of the headline is a concrete FINANCIAL or MARKET impact. DROP pure political/military/diplomatic items (e.g. "VP pulls out of Iran meeting", "Pentagon needs $80bn for the war", "Macron releases Hindi message for Modi", troop movements, summits, election politics). KEEP only when the money angle leads (e.g. "Brent jumps 8% as Iran conflict threatens Hormuz oil flows", "rupee slides on war-driven dollar surge", "defence stocks rally on fresh orders"). If you would not trade or reallocate on it, drop it.
- near-duplicates: keep the single best version of the same story. This applies ACROSS THE WHOLE EDITION, not just within one section — if the SAME underlying event appears in more than one section (e.g. an IPO in both 'india' and 'sector', or a pre-market preview in both 'macro' and 'india'), keep it ONCE in the single most relevant section and drop the rest. Two stories about the same company/IPO/event on the same day are duplicates even if the headlines are worded differently.

Selection rules:
- FREE-TO-READ PRIORITY: lines marked [PAID] open a subscription/registration wall when clicked. This paper must be MAJORLY free to read. So: (a) when a [PAID] story and a free (unmarked) story cover the SAME event, ALWAYS pick the free one; (b) select a [PAID] story ONLY when it is genuinely important AND not available from a free source; (c) NEVER select more than 2 [PAID] stories in the ENTIRE edition across ALL sections combined. Prefer a free story even if a [PAID] headline looks marginally sharper. Fill sections from the free pool first.
- Each section: build a SUBSTANTIAL but DIVERSE slate — aim for a good number of stories, but a slightly shorter, varied section BEATS a fuller one padded with repeats or near-identical themes. The bar is "genuinely useful for a serious reader to know" and DISTINCT from the other stories you've picked. Fill up to ${perSection} with genuinely different stories; leave a slot empty rather than add a same-theme repeat, a routine daily-ticker item, or a story that just re-states something already covered in recent editions (see RECENTLY COVERED below). Never pad with banned noise (roundups, previews, tip-sheets, "stocks to watch"). Compliance is often legitimately thin — leave it short rather than padding it.
- FILL SECTOR PROPERLY — it keeps coming out too thin, so AIM FOR AT LEAST 5-6 sector stories (not 2-3). Sector = INDUSTRY-level news: a sector's earnings/demand/margin trend, a policy/tariff/subsidy hitting an industry, a theme moving a group of companies (defence, PSU, realty, IT, pharma, autos, metals, banks, FMCG, cement, semiconductors, telecom, renewables, capital goods, chemicals, aviation). Hunt the WHOLE pool (including stories provisionally filed under india/macro) for these and re-file them here. PREFER genuine whole-industry stories; but when those are scarce, INCLUDE the most sector-DEFINING single-company or thematic stories and file them by their INDUSTRY read-through (e.g. a leading bank's strategy shift as a banking-sector signal, a big pharma's US-tariff exposure as a pharma-sector story, a major telco's capex as a telecom-sector story). Only leave sector short if the pool genuinely has nothing industry-relevant. Do NOT pad it with generic single-stock earnings/orders that carry no wider sector angle.
- MACRO MUST BE DIVERSE — not a daily market ticker. The rupee's level, crude's move, bond yields / banking liquidity, and the Sensex/Nifty move are all INTERCONNECTED and recur EVERY day; include AT MOST 2 such "daily market level" items total, and only when there is a real NEW development (a policy decision, a broken level, a fresh driver) — never just today's number. Fill the rest of macro with genuinely DIFFERENT developments: RBI/policy action, inflation/GDP/trade/IIP data prints, fiscal and tax, banking-system structural news, commodities beyond crude, or global macro with a specific India read-through. A macro section that is five reworded versions of "rupee/crude/bonds moved today" is a FAILURE of this job.
- Place each chosen id under the section its CONTENT belongs to (per the definitions above), NOT where it was provisionally filed.
- Within a section, order Indian stories first (IN), then global (GL); within each, MOST IMPORTANT FIRST — the lead (first) story of each section gets the longest treatment, so make it the single most consequential item, not merely the newest.
- Use ONLY the numeric ids that appear below. Do not invent ids. Put each id in at most ONE section.

Return ONLY JSON, no markdown. Use the bare integers (not strings):
{ "macro":[1,2], "sector":[3], "india":[4,5], "global":[6], "compliance":[7] }
${recentlyCovered ? `
RECENTLY COVERED (headlines from the last few editions — the reader has ALREADY seen these):
${recentlyCovered}

FRESHNESS: this paper is read EVERY morning. Do NOT re-select a story that merely re-states a theme already covered above — especially the recurring macro cluster (rupee level, crude move, bond yields/liquidity, index moves). Pick such a theme again ONLY if today's story carries a genuinely NEW, material development, not just an updated number. Actively favour topics, sectors and angles that do NOT appear above — reward the reader with something new each day.
` : ''}
CANDIDATE POOL:
${catalogue}`;

  try {
    // This is the run's most important call: it routes the WHOLE pool into sections,
    // so its reasoning budget directly drives categorisation quality. thinking 3072
    // (restored from a cost-trimmed 1400 on 2026-08-02 after mis-filings like FCNR in
    // compliance + a thin sector) gives it room to route ~150 candidates carefully and
    // dedupe across sections. Heavy `tries` keeps it off the keyword-router fallback.
    const out = extractJson(await callGemini(prompt, { maxTokens: 1800, thinking: 3072, temperature: 0.3, tries: 6 }));
    const valid = {};
    for (const sec of sections) {
      const ids = Array.isArray(out[sec]) ? out[sec] : [];
      // Map the model's integer ids back to story links; drop anything unknown.
      valid[sec] = ids
        .map((id) => idToLink.get(Number(id)))
        .filter(Boolean);
    }
    // Guard against a degenerate response (e.g. all sections empty) — treat it as
    // a failure so the caller keeps its own ranking rather than blanking the paper.
    const total = Object.values(valid).reduce((n, a) => n + a.length, 0);
    if (!total) throw new Error('editor returned no usable ids');
    return valid;
  } catch (err) {
    console.log(`  ⚠ editor cut failed (${err.message}); falling back to ranking.`);
    return null;
  }
}

// Generate the Knowledge Desk "mechanism of the day" from the day's lead stories.
export async function generateMechanism(topItems) {
  const context = topItems.slice(0, 12).map((i) => `- ${i.headline || i.title}`).join('\n');
  const prompt = `${HOUSE}

From today's lead stories below, pick ONE genuinely non-obvious financial MECHANISM worth teaching from first principles — the plumbing most professionals never actually learn (tax mechanics, market microstructure, capital-structure detail, a valuation lever, settlement/clearing, an arbitrage). It must connect to at least one of today's stories.

Teach it the way a great desk-head would, EXHAUSTIVELY: precise, first-principles, with the actual numbers, the worked example, the lever that matters, AND the second- and third-order consequences. Avoid platitudes and filler. The reader is an intelligent general reader who wants to understand deeply — assume curiosity and the basics of following markets, not professional expertise; still give them the deep layer beneath, the part that changes how they think.

Return ONLY JSON:
{
  "tier": "Foundations" or "Frontier",
  "title": "the mechanism, as a sharp question or statement (8-16 words)",
  "hook": "1-2 sentences on why this matters TODAY, tied to a specific story",
  "body": "7-9 substantial paragraphs explaining the mechanism step by step from first principles. Be concrete and rigorous: include at least one fully worked numerical example with ₹/% figures carried through end to end, name each cause-and-effect link explicitly, cover the second- AND third-order consequences, contrast it with the common (wrong) intuition, and note the edge case where it breaks. Write for an intelligent general reader — assume curiosity and the basics, deliver the deep layer clearly. Use plain text; mark step labels like 'Step 1 —'. Separate paragraphs with a blank line.",
  "takeaway": "2-3 sentences: the practical lesson the reader applies, and the specific signal to watch",
  "points": [ {"n":"short stat/label","l":"≤8-word gloss"}, {"n":"...","l":"..."}, {"n":"...","l":"..."}, {"n":"...","l":"..."} ]
}

TODAY'S STORIES:
${context}`;
  try {
    // maxTokens stays 3400 so the written mechanism keeps its full depth/length;
    // only the internal reasoning cap is trimmed 2600→2000 (reasoning quality
    // saturates well before 2k here). Reader-facing quality is unchanged.
    return extractJson(await callGemini(prompt, { maxTokens: 3400, thinking: 2600, temperature: 0.5 }));
  } catch (err) {
    console.log(`  ⚠ mechanism generation failed (${err.message}); using fallback.`);
    return null;
  }
}

// Generate 2 deeper concept explainers ("things to learn") for the Knowledge Desk.
export async function generateExplainers(topItems) {
  const context = topItems.slice(0, 16).map((i) => `- ${i.headline || i.title}`).join('\n');
  const prompt = `${HOUSE}

From today's themes, write FOUR substantial EXPLAINERS that expand the reader's knowledge base — concepts, instruments, frameworks, or financial-jargon worth genuinely understanding, each tied to today's news but teaching something durable (not just recapping the news). Make all four DIFFERENT from each other (mix instrument / tax / macro / market-structure), and make each reward a professional with a real "I didn't fully get that before" moment.

Return ONLY JSON:
{ "explainers": [
  { "tag":"one word, e.g. Instrument/Tax/Macro/Structure", "title":"the concept (6-12 words)", "body":"3 tight, information-dense paragraphs explaining it from first principles with a concrete worked example carrying real ₹/% figures; plain text, blank line between paragraphs.", "why":"≤20-word line on why it matters now" },
  { ...second, different concept... },
  { ...third, different concept... },
  { ...fourth, different concept... }
] }

TODAY'S THEMES:
${context}`;
  try {
    return extractJson(await callGemini(prompt, { maxTokens: 3200, thinking: 2200, temperature: 0.5 })).explainers || [];
  } catch (err) {
    console.log(`  ⚠ explainers generation failed (${err.message}).`);
    return [];
  }
}

// Generate 3 "consensus gets wrong" myth-busters from the day's themes.
export async function generateMyths(topItems) {
  const context = topItems.slice(0, 14).map((i) => `- ${i.headline || i.title}`).join('\n');
  const prompt = `${HOUSE}

From today's themes, write 5 "what the consensus gets wrong" entries — common misconceptions a professional should unlearn, each tied to today's news. Make them genuinely non-obvious, not strawmen: the kind of belief a competent practitioner actually holds. Each correction must name the REAL mechanism and, where possible, the figure or example that proves it.
Return ONLY JSON: { "myths": [ {"tag":"one word e.g. Flows/Valuation/Credit","claim":"the wrong belief in quotes","correction":"2-3 sentence correction with the real mechanism and a concrete proof point"}, ... x5 ] }

THEMES:
${context}`;
  try {
    return extractJson(await callGemini(prompt, { maxTokens: 1800, thinking: 1400, temperature: 0.5 })).myths || [];
  } catch {
    return [];
  }
}

/**
 * Write the spoken MORNING AUDIO BRIEFING script — a ~8-minute broadcast covering
 * ONLY the most important stories, written for the EAR (not a readout of every
 * headline). Returns plain spoken text (numbers/symbols already spelled out) ready
 * for TTS; '' on failure so the caller falls back to the per-story Web Speech script.
 * @param {object[]} items  the top stories (already summarised), most important first
 */
export async function generateBriefingScript(items, { weekday = '' } = {}) {
  if (!items || !items.length) return '';
  const lines = items
    .map((it, i) => `${i + 1}. [${it.section}] ${it.headline || it.title}${it.summary ? ` — ${it.summary}` : ''}`)
    .join('\n');
  const prompt = `${HOUSE}

Write the script for today's spoken MORNING AUDIO BRIEFING — read aloud by a clear, measured Indian news anchor to a busy, intelligent listener. This is for the EAR, not the page.

SELECT the 10 most important stories from the list below — the ones that genuinely move money — ordered most-consequential first.

STRUCTURE the script EXACTLY like this:
1. A short greeting that ANNOUNCES THE COUNT — for example: "Good morning, and welcome to The Guardian Capital Brief. Here are today's ten key highlights." Do NOT name a specific weekday or date anywhere in the script — say "today", never "Tuesday"/"the third of July" etc. (you cannot know the correct date, so naming one WILL be wrong).
2. Then go through all ten IN ORDER. For EACH one:
   a. Announce it by number, spelled as a word: "Highlight one." … "Highlight two." … through "Highlight ten." (each as its own short sentence).
   b. State the HEADLINE as one clear spoken sentence.
   c. Then SUMMARISE the story in two to three spoken sentences — the key facts, the main figure, and a crisp line on why it matters.
3. A short, gracious sign-off at the very end.

HOW TO WRITE IT (spoken English):
- Clear, natural sentences a news anchor would actually say.
- Spell EVERYTHING the way it is SPOKEN. Numbers, currency and symbols become words: "five hundred crore rupees" not "₹500 cr"; "up three point two per cent" not "+3.2%"; "the first quarter of financial year twenty-six" not "Q1FY26". Never emit the characters ₹, $, %, &, or shorthand like "bps", "YoY", "Q1FY26".
- Target 1500 to 1900 words (about eight to nine minutes spoken). Plain text only — NO markdown, NO bullet points, NO numerals like "1." — the ONLY labels allowed are the spoken "Highlight one/two/… ten". Just the words to be read aloud.

Return the spoken script text, then on its OWN line the exact delimiter @@TITLES@@, then a JSON array of the 10 highlights' CRISP WRITTEN titles in the SAME order as Highlight one to ten — each ≤6 words, normal written form (you MAY use ₹, %, cr, $ and figures like 6.5%), e.g. ["Nabard pulls ₹8,000cr bond","Comex gold jumps $61","RBI cuts repo rate 25bps"]. Nothing after the array. (The delimiter and array are metadata — they are NOT part of the spoken script.)

TODAY'S STORIES (most important first):
${lines}`;
  try {
    const raw = ((await callGemini(prompt, { maxTokens: 4600, thinking: 1600, temperature: 0.6, model: FLASH })) || '').replace(/```/g, '');
    const parts = raw.split(/@@TITLES@@/);
    let titles = [];
    if (parts[1]) {
      try { titles = JSON.parse(parts[1].trim().replace(/^[^[]*/, '').replace(/[^\]]*$/, '')).map((s) => String(s).trim()).filter(Boolean); } catch {}
    }
    return { text: parts[0].trim(), titles };
  } catch (err) {
    console.log(`  ⚠ briefing script generation failed (${err.message}); audio falls back to per-story readout.`);
    return { text: '', titles: [] };
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
export async function curateLibrary({ videos = [], podcasts = [] } = {}, { pickVideos = 6 } = {}) {
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
- the ONE best, most substantive podcast episode for a thoughtful investor. It need NOT be the very newest — pick the most rewarding episode in the pool. STRONGLY prefer episodes about markets, investing, business, the economy, companies or money; SKIP pure entertainment, celebrity, politics or generic self-help episodes even if they are recent.

For each pick write a tight 1-2 sentence editorial blurb (your own words) on what the viewer/listener will actually LEARN — concrete, never hype.

Return ONLY JSON, no markdown:
{ "videos": [ {"id":"v0","blurb":"..."}, ... ${pickVideos} entries ], "podcast": {"id":"p0","blurb":"..."} }
Use ONLY ids that appear below.

VIDEOS:
${vLines.join('\n')}

PODCASTS:
${pLines.join('\n')}`;

  try {
    const out = extractJson(await callGemini(prompt, { maxTokens: 1600, thinking: 1200, temperature: 0.4 }));
    const vById = new Map(vPool.map((v, i) => [`v${i}`, v]));
    const pById = new Map(pPool.map((p, i) => [`p${i}`, p]));

    // Cap how many videos any one channel can contribute, so a single prolific
    // channel can't crowd out variety even if the model over-picks from it.
    const perChannel = Math.max(2, Math.ceil(pickVideos / 3));
    const channelCount = new Map();
    const picked = (out.videos || [])
      .map((x) => { const v = vById.get(x.id); return v ? { ...v, blurb: (x.blurb || v.rawDesc || '').trim() } : null; })
      .filter(Boolean)
      .filter((v) => {
        const n = channelCount.get(v.channel) || 0;
        if (n >= perChannel) return false;
        channelCount.set(v.channel, n + 1);
        return true;
      })
      .slice(0, pickVideos);

    // Top up with diverse recency picks if the model returned fewer than asked
    // (under-pick OR channel-cap trimming). Respect the same per-channel cap.
    if (picked.length < pickVideos) {
      const have = new Set(picked.map((v) => v.link));
      for (const v of diverseVideos(videos, pickVideos * 3)) {
        if (picked.length >= pickVideos) break;
        if (have.has(v.link)) continue;
        const n = channelCount.get(v.channel) || 0;
        if (n >= perChannel) continue;
        picked.push({ ...v, blurb: v.rawDesc || '' });
        have.add(v.link);
        channelCount.set(v.channel, n + 1);
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
 * A small inter-call gap keeps us polite to the paid-tier RPM limit (no longer
 * the 6.5s the free tier needed). `leadIds` get the longer treatment.
 */
export async function summariseAll(items, { leadIds = new Set(), gapMs = 1500 } = {}) {
  const out = [];
  console.log(`\n✍  Summarising ${items.length} stories — lead stories on ${PRO}, the rest on ${FLASH} (selection + mechanism also on ${PRO})…`);
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const lead = leadIds.has(item.link);
    out.push(await summariseStory(item, { lead }));
    if (i < items.length - 1) await sleep(gapMs); // stay polite to paid-tier RPM
  }
  console.log(`   done (${out.filter((x) => x.aiGenerated).length}/${out.length} AI-written)\n`);
  return out;
}
