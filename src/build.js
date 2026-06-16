// build.js — renders the live data into the locked Guardian Times HTML template.
// Keeps the exact design from the finalised front-end; only the CONTENT is dynamic.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

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

function chip(tag) {
  return tag ? `<span class="chip">${esc(tag)}</span>` : '';
}

function articleHTML(item, { lead = false } = {}) {
  const tag = item.watchTags?.[0] || '';
  const link = esc(item.link);
  const head = lead
    ? `<h3 class="hl"><a href="${link}" target="_blank" rel="noopener">${esc(item.headline)}</a></h3>`
    : `<h3 class="hl"><a href="${link}" target="_blank" rel="noopener">${esc(item.headline)}</a></h3>`;
  const soWhat = item.soWhat
    ? `<div class="sowhat"><b>So what for you</b>${esc(item.soWhat)}</div>` : '';
  return `
      <article${lead ? ' class="lead"' : ''}>
        <div class="eyebrow"><span class="src">${esc(item.source)}</span><span class="dot"></span><span class="time">${timeAgo(item.published)}</span>${chip(tag)}</div>
        ${head}
        <div class="summary">${lead ? '<p>' + esc(item.summary) + '</p>' : esc(item.summary)}</div>
        ${soWhat}
        <a class="readmore" href="${link}" target="_blank" rel="noopener">Read at ${esc(item.source)} <span class="arr">&rarr;</span></a>
      </article>`;
}

function sectionPage(id, num, title, kicker, lede, items, { active = false } = {}) {
  if (!items.length) {
    return `<section class="page${active ? ' active' : ''}" id="page-${id}">
      <div class="section-head"><span class="pgnum">${num}</span><h2>${title}</h2><span class="kicker">${kicker}</span></div>
      <p class="lede">${lede}</p>
      <p class="watch-empty">No stories in this section in the current window.</p></section>`;
  }
  const [lead, ...rest] = items;
  const restHTML = rest.map((it) => articleHTML(it)).join('');
  return `<section class="page${active ? ' active' : ''}" id="page-${id}">
      <div class="section-head"><span class="pgnum">${num}</span><h2>${title}</h2><span class="kicker">${kicker}</span></div>
      <p class="lede">${lede}</p>
      ${articleHTML(lead, { lead: true })}
      <div class="grid cols-2">${restHTML}</div>
    </section>`;
}

function knowledgePage(num, mechanism, myths) {
  const mech = mechanism
    ? `<div class="knowledge-card">
        <div class="eyebrow"><span class="src">Mechanism of the day</span><span class="dot"></span><span class="tier ${mechanism.tier === 'Frontier' ? 'frontier' : 'foundations'}">${esc(mechanism.tier)}</span></div>
        <h3>${esc(mechanism.title)}</h3>
        <div class="summary">${mechanism.body.split(/\n+/).map((p) => '<p>' + esc(p) + '</p>').join('')}</div>
        <div class="kpoints">${(mechanism.points || []).slice(0, 3).map((p) => `<div class="kpoint"><div class="kn">${esc(p.n)}</div><div class="kl">${esc(p.l)}</div></div>`).join('')}</div>
      </div>` : '';
  const mythHTML = (myths || []).map((m) =>
    `<div class="myth"><div class="x">&times;</div><div><div class="mtag">Myth &middot; ${esc(m.tag)}</div><div class="mt">${esc(m.claim)}</div><div class="summary">${esc(m.correction)}</div></div></div>`
  ).join('');
  return `<section class="page" id="page-knowledge">
      <div class="section-head"><span class="pgnum">${num}</span><h2>The Knowledge Desk</h2><span class="kicker">Learn what others won't</span></div>
      <p class="lede">A mechanism explained in full and the misconceptions worth unlearning — born from today's news, built from first principles.</p>
      ${mech}
      ${mythHTML ? `<div class="section-head" style="border-bottom:1px solid var(--line);padding-top:8px"><h2 style="font-size:22px">What the consensus gets wrong</h2></div>${mythHTML}` : ''}
    </section>`;
}

function watchPage(num, items) {
  const tags = ['IT', 'Banks', 'Metals', 'GIFT', 'Eternal', 'Shriram'];
  const labels = { IT: 'IT & Tech', Banks: 'Banks & NBFCs', Metals: 'Metals & Energy', GIFT: 'GIFT City / Funds', Eternal: 'Eternal', Shriram: 'Shriram Finance' };
  const controls = tags.map((t) => `<button class="watch-tag" data-tag="${t}">${labels[t]}</button>`).join('');
  const feed = items.map((it) => `
    <article data-tags="${(it.watchTags || []).join(',')}">
      <div class="eyebrow"><span class="src">${esc(it.source)}</span><span class="dot"></span><span class="time">${timeAgo(it.published)}</span>${chip(it.watchTags?.[0])}</div>
      <h3 class="hl"><a href="${esc(it.link)}" target="_blank" rel="noopener">${esc(it.headline)}</a></h3>
      <div class="summary">${esc(it.summary)}</div>
    </article>`).join('');
  return `<section class="page" id="page-watch">
      <div class="section-head"><span class="pgnum">${num}</span><h2>My Watch</h2><span class="kicker">Your universe, tagged</span></div>
      <p class="lede">Stories touching your holdings, tracked names and sectors. Tap a tag to narrow the feed.</p>
      <div class="watch-controls">${controls}</div>
      <div id="watch-feed">${feed || ''}</div>
      <div class="watch-empty" id="watch-empty" style="display:none">No stories match the selected tags. Clear a filter to see the full feed.</div>
    </section>`;
}

/**
 * Build the full HTML. `data` shape:
 * { macro, sector, india, global, compliance, watch: [...items], mechanism, myths, ticker, runTime }
 */
export function buildHTML(data) {
  const tpl = fs.readFileSync(path.join(__dirname, 'template.html'), 'utf8');

  const pages = [
    sectionPage('macro', '01', 'Macroeconomy &amp; Policy', 'Forces moving the whole market', 'Central banks, growth, inflation, oil, and the flow of foreign capital.', data.macro, { active: true }),
    sectionPage('sector', '02', 'Sectoral Currents', 'Where the money is rotating', 'Which sectors are catching the bid and which are bleeding.', data.sector),
    sectionPage('india', '03', 'Indian Markets &amp; Stocks', 'FII flows · the big moves', 'Index-moving flows, restructurings, enforcement and the stock-specific events that matter.', data.india),
    sectionPage('global', '04', 'Global Equities', 'Megacaps that move sentiment', 'The US tape sets the risk mood worldwide — with read-through to Indian IT and the rupee.', data.global),
    knowledgePage('05', data.mechanism, data.myths),
    sectionPage('compliance', '06', 'Compliance &amp; Regulation', 'SEBI · RBI · AMC moves', 'The regulatory changes that reshape how products are built, sold and reported.', data.compliance),
    watchPage('07', data.watch),
  ].join('\n');

  return tpl
    .replace('__LOGO__', LOGO)
    .replace('__TICKER__', data.ticker || '')
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
