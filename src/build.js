// build.js — renders the live data into the locked Guardian Times HTML template.
// Keeps the exact design from the finalised front-end; only the CONTENT is dynamic.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { lineChart, storyChart } from './charts.js';
import { tickerHTML } from './market.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOGO = fs.readFileSync(path.join(__dirname, 'logo_b64.txt'), 'utf8').trim();

const esc = (s = '') =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

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
        <div class="eyebrow"><span class="src">${esc(item.source)}</span><span class="dot"></span><span class="time">${timeAgo(item.published)}</span></div>
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
        <div class="kpoints">${(mechanism.points || []).slice(0, 3).map((p) => `<div class="kpoint"><div class="kn">${esc(p.n)}</div><div class="kl">${esc(p.l)}</div></div>`).join('')}</div>
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

/**
 * Build the full HTML. `data` shape:
 * { macro, sector, india, global, compliance, market, mechanism, explainers, myths, runTime }
 */
export function buildHTML(data) {
  const tpl = fs.readFileSync(path.join(__dirname, 'template.html'), 'utf8');
  const ticker = data.market ? tickerHTML(data.market) : '';

  const pages = [
    sectionPage('macro', '01', 'Macroeconomy &amp; Policy', 'Forces moving the whole market', 'Central banks, growth, inflation, oil, and the flow of foreign capital.', data.macro, { active: true, prepend: marketDashboard(data.market) }),
    sectionPage('sector', '02', 'Sectoral Currents', 'Where the money is rotating', 'Which sectors are catching the bid and which are bleeding.', data.sector),
    sectionPage('india', '03', 'Indian Markets &amp; Stocks', 'FII flows · the big moves', 'Index-moving flows, restructurings, enforcement and the stock-specific events that matter.', data.india),
    sectionPage('global', '04', 'Global Equities', 'Megacaps that move sentiment', 'The US tape sets the risk mood worldwide — with read-through to Indian IT and the rupee.', data.global),
    knowledgePage('05', data.mechanism, data.explainers, data.myths),
    sectionPage('compliance', '06', 'Compliance &amp; Regulation', 'SEBI · RBI · AMC moves', 'The regulatory changes that reshape how products are built, sold and reported.', data.compliance),
  ].join('\n');

  return tpl
    .replace('__LOGO__', LOGO)
    .replace('__TICKER__', ticker)
    .replace('__PAGES__', pages)
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
