// build.js — renders the live data into the locked Guardian Times HTML template.
// Keeps the exact design from the finalised front-end; only the CONTENT is dynamic.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { lineChart, storyChart } from './charts.js';
import { tickerHTML } from './market.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOGO = fs.readFileSync(path.join(__dirname, 'logo_b64.txt'), 'utf8').trim();

// Escapes the 5 HTML-significant chars. The quote escapes matter because esc() is
// also used inside double-quoted attributes (href/src) — without them a feed-supplied
// URL containing a quote could break out of the attribute.
const esc = (s = '') =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

// ---------- small render helpers ----------
function timeAgo(d) {
  if (!d) return 'recent';
  const h = Math.round((Date.now() - new Date(d).getTime()) / 3.6e6);
  if (h < 1) return 'just now';
  if (h < 24) return `~${h}h ago`;
  return `~${Math.round(h / 24)}d ago`;
}

function articleHTML(item, { lead = false } = {}) {
  const link = esc(item.link);
  const head = `<h3 class="hl"><a href="${link}" target="_blank" rel="noopener">${esc(item.headline)}</a></h3>`;
  const soWhat = item.soWhat
    ? `<div class="sowhat"><b>So what for you</b>${esc(item.soWhat)}</div>` : '';
  // Any story carries an explanatory chart when the AI judged the news had real
  // data worth interpreting (a trend/comparison) — not just leads, never decorative.
  const chart = item.chart ? storyChart(item.chart) : '';
  return `
      <article${lead ? ' class="lead"' : ''}>
        <div class="eyebrow"><span class="src">${esc(item.source)}</span></div>
        ${head}
        <div class="summary">${lead ? '<p>' + esc(item.summary) + '</p>' : esc(item.summary)}</div>
        ${chart}
        ${soWhat}
        <a class="readmore" href="${link}" target="_blank" rel="noopener">Read at ${esc(item.source)} <span class="arr">&rarr;</span></a>
      </article>`;
}

// A compact 1-month line chart per live instrument — the market at a glance.
function marketDashboard(market) {
  if (!market?.instruments?.length) return '';
  const cards = market.instruments
    .filter((i) => i.ok && Array.isArray(i.series) && i.series.length > 1)
    .map((i) => lineChart({
      title: i.label,
      series: i.series,
      unit: i.unit,
      dp: i.dp,
      caption: '1-month',
    }))
    .join('');
  if (!cards) return '';
  return `<div class="market-dash">
      <div class="md-head"><span class="md-label">Markets &middot; one-month trend</span><span class="md-sub">live · Yahoo Finance</span></div>
      <div class="md-grid">${cards}</div>
    </div>`;
}

function sectionPage(id, num, title, kicker, lede, items, { active = false, prepend = '' } = {}) {
  if (!items.length) {
    return `<section class="page${active ? ' active' : ''}" id="page-${id}">
      <div class="section-head"><span class="pgnum">${num}</span><h2>${title}</h2><span class="kicker">${kicker}</span></div>
      <p class="lede">${lede}</p>
      ${prepend}
      <p class="watch-empty">No stories in this section in the current window.</p></section>`;
  }
  const [lead, ...rest] = items;
  const restHTML = rest.map((it) => articleHTML(it)).join('');
  return `<section class="page${active ? ' active' : ''}" id="page-${id}">
      <div class="section-head"><span class="pgnum">${num}</span><h2>${title}</h2><span class="kicker">${kicker}</span></div>
      <p class="lede">${lede}</p>
      ${prepend}
      ${articleHTML(lead, { lead: true })}
      <div class="grid cols-2">${restHTML}</div>
    </section>`;
}

function paras(text = '') {
  return text.split(/\n{1,}/).map((p) => p.trim()).filter(Boolean)
    .map((p) => '<p>' + esc(p) + '</p>').join('');
}

function knowledgePage(num, mechanism, explainers, myths) {
  const mech = mechanism
    ? `<div class="knowledge-card">
        <div class="eyebrow"><span class="src">Mechanism of the day</span><span class="dot"></span><span class="tier ${mechanism.tier === 'Frontier' ? 'frontier' : 'foundations'}">${esc(mechanism.tier || 'Foundations')}</span></div>
        <h3>${esc(mechanism.title)}</h3>
        ${mechanism.hook ? `<p class="kd-hook">${esc(mechanism.hook)}</p>` : ''}
        <div class="summary">${paras(mechanism.body)}</div>
        ${mechanism.takeaway ? `<div class="kd-takeaway"><b>The takeaway</b>${esc(mechanism.takeaway)}</div>` : ''}
        <div class="kpoints">${(mechanism.points || []).slice(0, 4).map((p) => `<div class="kpoint"><div class="kn">${esc(p.n)}</div><div class="kl">${esc(p.l)}</div></div>`).join('')}</div>
      </div>` : '';

  const explHTML = (explainers || []).length
    ? `<div class="section-head" style="border-bottom:1px solid var(--line);padding-top:8px"><h2 style="font-size:22px">Things worth understanding</h2></div>
       <div class="grid cols-2">${(explainers || []).map((e) => `
        <article class="explainer">
          <div class="eyebrow"><span class="src">Explainer</span><span class="dot"></span><span class="chip">${esc(e.tag || 'Concept')}</span></div>
          <h3 class="hl">${esc(e.title)}</h3>
          <div class="summary">${paras(e.body)}</div>
          ${e.why ? `<div class="kd-why"><b>Why it matters now</b>${esc(e.why)}</div>` : ''}
        </article>`).join('')}</div>`
    : '';

  const mythHTML = (myths || []).map((m) =>
    `<div class="myth"><div class="x">&times;</div><div><div class="mtag">Myth &middot; ${esc(m.tag)}</div><div class="mt">${esc(m.claim)}</div><div class="summary">${esc(m.correction)}</div></div></div>`
  ).join('');

  return `<section class="page" id="page-knowledge">
      <div class="section-head"><span class="pgnum">${num}</span><h2>The Knowledge Desk</h2><span class="kicker">Learn what others won't</span></div>
      <p class="lede">A mechanism explained in full, concepts worth mastering, and the misconceptions worth unlearning — born from today's news, built from first principles.</p>
      ${mech}
      ${explHTML}
      ${mythHTML ? `<div class="section-head" style="border-bottom:1px solid var(--line);padding-top:8px"><h2 style="font-size:22px">What the consensus gets wrong</h2></div>${mythHTML}` : ''}
    </section>`;
}

// Pretty-print an iTunes duration (either total seconds, or HH:MM:SS / MM:SS).
function fmtDur(d = '') {
  if (!d) return '';
  if (/^\d+$/.test(d)) {
    const s = +d; const h = Math.floor(s / 3600); const m = Math.round((s % 3600) / 60);
    return h ? `${h}h ${m}m` : `${m} min`;
  }
  const p = d.split(':').map(Number);
  if (p.length === 3) return p[0] ? `${p[0]}h ${p[1]}m` : `${p[1]} min`;
  if (p.length === 2) return `${p[0]} min`;
  return '';
}

// Fund Manager Interviews — latest YouTube interviews of the tracked PMS/MF managers,
// priority names first. Reuses the Library card styling.
function managersPage(num, managers) {
  const head = `<div class="section-head"><span class="pgnum">${num}</span><h2>Fund Manager Interviews</h2><span class="kicker">From the people who run the money</span></div>
      <p class="lede">The latest interviews of India&rsquo;s most-watched PMS and mutual-fund managers &mdash; refreshed only when a new conversation appears, priority names first.</p>`;
  if (!managers || !managers.length) {
    return `<section class="page" id="page-managers">
      ${head}
      <p class="watch-empty">No new manager interviews in the last 30 days &mdash; this updates the moment a fresh one lands.</p></section>`;
  }
  const cards = managers.map((v) => `
      <article class="lib-card">
        <a class="lib-thumb" href="${esc(v.link)}" target="_blank" rel="noopener">
          ${v.thumb ? `<img loading="lazy" src="${esc(v.thumb)}" alt="">` : ''}
          <span class="lib-play">&#9658;</span>
        </a>
        <div class="lib-body">
          <div class="eyebrow"><span class="src">${esc(v.manager)}</span><span class="dot"></span><span class="chip">${esc(v.firm)}</span></div>
          <h3 class="hl"><a href="${esc(v.link)}" target="_blank" rel="noopener">${esc(v.title)}</a></h3>
          <div class="eyebrow"><span class="src">${esc(v.channel)}</span><span class="dot"></span><span class="time">${timeAgo(v.published)}</span></div>
          <a class="readmore" href="${esc(v.link)}" target="_blank" rel="noopener">Watch on YouTube <span class="arr">&rarr;</span></a>
        </div>
      </article>`).join('');
  return `<section class="page" id="page-managers">
      ${head}
      <div class="lib-grid">${cards}</div>
    </section>`;
}

// The Library desk — curated finance videos to watch + a podcast to hear.
function libraryPage(num, library) {
  const videos = library?.videos || [];
  const podcast = library?.podcast || null;
  const head = `<div class="section-head"><span class="pgnum">${num}</span><h2>The Library</h2><span class="kicker">Watch &middot; Listen &middot; Learn</span></div>
      <p class="lede">Beyond the headlines — the finest finance teaching to watch and hear today, curated from India's best markets channels and the world's most thoughtful investing podcasts.</p>`;

  if (!videos.length && !podcast) {
    return `<section class="page" id="page-library">
      ${head}
      <p class="watch-empty">The Library is quiet today — the video and podcast feeds returned nothing in the window.</p></section>`;
  }

  const vidCards = videos.map((v) => `
      <article class="lib-card">
        <a class="lib-thumb" href="${esc(v.link)}" target="_blank" rel="noopener">
          ${v.thumb ? `<img loading="lazy" src="${esc(v.thumb)}" alt="">` : ''}
          <span class="lib-play">&#9658;</span>
        </a>
        <div class="lib-body">
          <div class="eyebrow"><span class="src">${esc(v.channel)}</span><span class="dot"></span><span class="time">${timeAgo(v.published)}</span></div>
          <h3 class="hl"><a href="${esc(v.link)}" target="_blank" rel="noopener">${esc(v.title)}</a></h3>
          ${v.blurb ? `<div class="summary">${esc(v.blurb)}</div>` : ''}
          <a class="readmore" href="${esc(v.link)}" target="_blank" rel="noopener">Watch on YouTube <span class="arr">&rarr;</span></a>
        </div>
      </article>`).join('');

  const dur = podcast ? fmtDur(podcast.duration) : '';
  const podHTML = podcast ? `
      <div class="section-head" style="border-bottom:1px solid var(--line);padding-top:8px"><h2 style="font-size:22px">Podcast of the day</h2></div>
      <div class="pod-feature">
        ${podcast.image ? `<a class="pod-art" href="${esc(podcast.link)}" target="_blank" rel="noopener"><img loading="lazy" src="${esc(podcast.image)}" alt=""></a>` : ''}
        <div class="pod-body">
          <div class="eyebrow"><span class="src">${esc(podcast.show)}</span><span class="dot"></span><span class="time">${timeAgo(podcast.published)}</span>${dur ? `<span class="dot"></span><span class="time">${esc(dur)}</span>` : ''}</div>
          <h3 class="hl"><a href="${esc(podcast.link)}" target="_blank" rel="noopener">${esc(podcast.title)}</a></h3>
          ${podcast.blurb ? `<div class="summary">${esc(podcast.blurb)}</div>` : ''}
          <a class="readmore" href="${esc(podcast.link)}" target="_blank" rel="noopener">Listen <span class="arr">&rarr;</span></a>
        </div>
      </div>` : '';

  return `<section class="page" id="page-library">
      ${head}
      <div class="lib-grid">${vidCards}</div>
      ${podHTML}
    </section>`;
}

// Turn on-screen financial text into something a TTS voice reads like a human news
// anchor rather than a teleprompter. Display text is never touched — this only
// shapes the words the spoken-briefing receives, expanding the symbols, currency
// and finance shorthand ("₹500 cr", "3.2% YoY", "Q1FY25", "F&O", "(NSE: INFY)")
// that otherwise come out as robotic gibberish.
function speechify(s = '') {
  const UNIT = { cr: 'crore', lk: 'lakh', bn: 'billion', mn: 'million', tn: 'trillion' };
  const unit = (u) => (u ? (UNIT[u.toLowerCase()] || u.toLowerCase()) : '');
  let t = ' ' + String(s).replace(/\s+/g, ' ') + ' ';
  t = t
    // drop exchange/ticker parentheticals — they read as gibberish
    .replace(/\((?:NSE|BSE|NYSE|NASDAQ)[:\s][^)]*\)/gi, ' ')
    // finance shorthand spelled out (before the generic '&' swap below)
    .replace(/\bM&A\b/gi, 'mergers and acquisitions')
    .replace(/\bF&O\b/gi, 'futures and options')
    .replace(/\bP\/E\b/gi, 'price to earnings')
    .replace(/\bR&D\b/gi, 'research and development')
    .replace(/\bH1B\b/gi, 'H 1 B')
    // currency + amount → natural spoken order ("₹500 cr" → "500 crore rupees").
    // Units are matched LONGEST-FIRST so "cr" can't bite the front off "crore",
    // and the Indian compound "lakh crore"/"thousand crore" stays intact.
    .replace(/₹\s?([\d,.]+)\s*(lakh crore|thousand crore|crore|cr|lakh|lk|billion|bn|million|mn|trillion|tn)?/gi,
      (m, n, u) => `${n}${u ? ' ' + unit(u) : ''} rupees `)
    .replace(/(?:\bRs\.?|\bINR)\s?([\d,.]+)\s*(lakh crore|thousand crore|crore|cr|lakh|lk|billion|bn|million|mn|trillion|tn)?/gi,
      (m, n, u) => `${n}${u ? ' ' + unit(u) : ''} rupees `)
    .replace(/\$\s?([\d,.]+)\s*(trillion|tn|billion|bn|million|mn)?/gi,
      (m, n, u) => `${n}${u ? ' ' + unit(u) : ''} dollars `)
    // symbols
    .replace(/%/g, ' percent')
    .replace(/&/g, ' and ')
    // reporting periods / ratios ("Q1FY25" → "first quarter fiscal year 25")
    .replace(/\bQ([1-4])(?=FY)/gi, (m, q) => ['first', 'second', 'third', 'fourth'][q - 1] + ' quarter ')
    .replace(/\bQ([1-4])\b/gi, (m, q) => ['first', 'second', 'third', 'fourth'][q - 1] + ' quarter')
    .replace(/\bH([12])\b/g, (m, h) => (h === '1' ? 'first' : 'second') + ' half')
    .replace(/\bFY\s?(\d{2,4})\b/gi, 'fiscal year $1')
    .replace(/\bbps\b/gi, 'basis points')
    .replace(/\bY-?o-?Y\b/gi, 'year on year')
    .replace(/\bQ-?o-?Q\b/gi, 'quarter on quarter')
    .replace(/\bM-?o-?M\b/gi, 'month on month')
    // numeric ranges "5–7" → "5 to 7"
    .replace(/(\d)\s?[–—]\s?(\d)/g, '$1 to $2')
    .replace(/\s+/g, ' ')
    .trim();
  return t;
}

// Assemble the spoken "morning briefing" script the in-browser AI voice reads.
// Plain text only (no HTML) — every story's headline + summary, in display order,
// announced section by section, with light connective tissue so it flows like a
// read briefing instead of a flat list. Returned as an array of {label,text}
// segments so the player can show which section it's currently reading. Generated
// at build time from summaries already in hand, so it costs ZERO extra Gemini calls.
function buildAudioScript(data) {
  const sections = [
    ['Macroeconomy and Policy', data.macro],
    ['Sectoral Currents', data.sector],
    ['Indian Markets and Stocks', data.india],
    ['Global Markets', data.global],
    ['Compliance and Regulation', data.compliance],
  ];
  const clean = (s = '') => speechify(String(s).replace(/\s+/g, ' ').trim());
  const segments = [];
  const total = sections.reduce((n, [, arr]) => n + (arr?.length || 0), 0);
  const live = sections.filter(([, arr]) => arr && arr.length).length;
  segments.push({
    label: 'Briefing',
    text: `Good morning, and welcome to your Guardian Times briefing. Here are today's ${total} ${total === 1 ? 'story' : 'stories'} across ${live} ${live === 1 ? 'section' : 'sections'}. Let's begin.`,
  });
  let first = true;
  for (const [name, items] of sections) {
    if (!items || !items.length) continue;
    // A spoken lead-in rather than a bare label — "We begin with…", then "Turning to…".
    const lead = first ? `First, ${name}.` : `Turning now to ${name}.`;
    first = false;
    segments.push({ label: name, text: lead });
    for (const it of items) {
      const head = clean(it.headline || it.title);
      const summ = clean(it.summary);
      if (!head && !summ) continue;
      // End the headline with a full stop so the voice pauses before the summary.
      const headSpoken = head ? (/[.!?]$/.test(head) ? head : head + '.') : '';
      segments.push({ label: name, text: `${headSpoken} ${summ}`.trim() });
    }
  }
  segments.push({ label: 'Briefing', text: 'And that brings your briefing to a close. Wishing you a profitable day ahead.' });
  return segments;
}

/**
 * Build the full HTML. `data` shape:
 * { macro, sector, india, global, compliance, market, mechanism, explainers, myths, library, runTime }
 */
export function buildHTML(data) {
  const tpl = fs.readFileSync(path.join(__dirname, 'template.html'), 'utf8');
  const ticker = data.market ? tickerHTML(data.market) : '';

  const pages = [
    sectionPage('macro', '01', 'Macroeconomy &amp; Policy', 'Forces moving the whole market', 'Central banks, growth, inflation, oil, and the flow of foreign capital.', data.macro, { active: true, prepend: marketDashboard(data.market) }),
    sectionPage('sector', '02', 'Sectoral Currents', 'Where the money is rotating', 'Which sectors are catching the bid and which are bleeding.', data.sector),
    sectionPage('india', '03', 'Indian Markets &amp; Stocks', 'FII flows · the big moves', 'Index-moving flows, restructurings, enforcement and the stock-specific events that matter.', data.india),
    sectionPage('global', '04', 'Global Markets', 'Forces that move world sentiment', 'The US tape and global developments with real market read-through to Indian IT, the rupee and commodities.', data.global),
    knowledgePage('05', data.mechanism, data.explainers, data.myths),
    sectionPage('compliance', '06', 'Compliance &amp; Regulation', 'SEBI · RBI · AMC moves', 'The regulatory changes that reshape how products are built, sold and reported.', data.compliance),
    managersPage('07', data.managers),
    libraryPage('08', data.library),
  ].join('\n');

  // Spoken-briefing data. PREFERRED: a real MP3 (data.audioFile) voiced from the AI
  // briefing script — the page plays it with a natural Indian anchor voice + real
  // seek. FALLBACK (no MP3): the browser's Web Speech voice reads segments. We build
  // those segments from the AI script when we have it (so even the fallback reads the
  // good ~8-min script), else from the per-story readout. Neutralise '<' so a feed-
  // supplied "</script>" inside text can't close the data block early.
  const scriptText = (data.audioScript || '').trim();
  const segments = scriptText
    ? scriptText.split(/\n{1,}/).map((p) => p.trim()).filter(Boolean).map((p) => ({ label: 'Briefing', text: speechify(p) }))
    : buildAudioScript(data);
  const audioJson = JSON.stringify(segments).replace(/</g, '\\u003c');
  const audioFile = data.audioFile ? esc(data.audioFile) : '';

  return tpl
    .replace('__LOGO__', LOGO)
    .replace('__TICKER__', ticker)
    .replace('__PAGES__', pages)
    .replace('__AUDIODATA__', audioJson)
    .replace('__BRIEFINGAUDIO__', audioFile)
    .replace('__RUNTIME__', data.runTime || new Date().toUTCString());
}

export function writeEdition(html, outDir) {
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'index.html'), html);
  // also archive a timestamped copy
  const archDir = path.join(outDir, '..', 'archive');
  fs.mkdirSync(archDir, { recursive: true });
  const stamp = new Date().toISOString().slice(0, 13).replace(/[:T]/g, '-');
  fs.writeFileSync(path.join(archDir, `edition-${stamp}.html`), html);
  return stamp;
}
