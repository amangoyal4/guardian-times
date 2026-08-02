// charts.js — dependency-free SVG charts. Explanatory by design: every chart
// carries data points to interpret (start/end, high/low, % change, a caption).

const esc = (s = '') => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const COL = { ink: '#16161a', line: '#e4e2dc', muted: '#74747f', accent: '#9a2a2a', teal: '#1d4e5f', pos: '#1a6e4b', neg: '#a8312a', gold: '#9c7b3f' };

const fmt = (n, dp = 2) =>
  Number(n).toLocaleString('en-IN', { minimumFractionDigits: dp, maximumFractionDigits: dp });

// Format a value with its unit in the NATURAL order: number first, scale/percent
// after (36.7bn, 15.8%, 500cr), with a leading currency symbol kept in front
// (₹500cr, $36.7bn). Fixes the earlier "$bn36.7"/"%15.8" bug where the whole unit
// was prepended.
const fmtVal = (n, unit = '', dp = 2) => {
  const num = fmt(n, dp);
  const u = String(unit).trim();
  if (!u) return num;
  const m = u.match(/^([₹$])\s*(.*)$/); // leading currency symbol → keep it in front
  if (m) return `${m[1]}${num}${m[2]}`; // $36.7bn, ₹500cr, $100
  return `${num}${u}`;                  // 15.8%, 36.7bn, 36.7cr
};

/**
 * Line chart from a numeric series (e.g. a 1-month price history).
 * opts: { title, series:[n], unit, dp, caption, source }
 */
export function lineChart({ title, series = [], unit = '', dp = 2, caption = '', source = '' }) {
  const pts = series.filter((x) => x != null && !Number.isNaN(x));
  if (pts.length < 2) return '';

  const W = 600, H = 200, padL = 56, padR = 16, padT = 18, padB = 26;
  const min = Math.min(...pts), max = Math.max(...pts);
  const range = max - min || 1;
  const x = (i) => padL + (i / (pts.length - 1)) * (W - padL - padR);
  const y = (v) => padT + (1 - (v - min) / range) * (H - padT - padB);

  const first = pts[0], last = pts[pts.length - 1];
  const up = last >= first;
  const stroke = up ? COL.pos : COL.neg;
  const chgPct = first ? ((last - first) / first) * 100 : 0;

  const line = pts.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
  const area = `${line} L${x(pts.length - 1).toFixed(1)},${(H - padB).toFixed(1)} L${x(0).toFixed(1)},${(H - padB).toFixed(1)} Z`;

  // horizontal gridlines at min, mid, max with value labels
  const grid = [max, (max + min) / 2, min].map((v) => {
    const yy = y(v).toFixed(1);
    return `<line x1="${padL}" y1="${yy}" x2="${W - padR}" y2="${yy}" stroke="${COL.line}" stroke-width="1"/>` +
      `<text x="${padL - 8}" y="${(+yy + 3).toFixed(1)}" text-anchor="end" font-size="11" fill="${COL.muted}" font-family="'IBM Plex Mono',monospace">${fmtVal(v, unit, dp)}</text>`;
  }).join('');

  const lastX = x(pts.length - 1), lastY = y(last);
  const cap = caption || `${pts.length} sessions`;
  const chgTxt = `${chgPct >= 0 ? '+' : ''}${chgPct.toFixed(2)}% over window`;

  return `
      <figure>
        <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(title)}">
          <defs><linearGradient id="g-${slug(title)}" x1="0" x2="0" y1="0" y2="1">
            <stop offset="0" stop-color="${stroke}" stop-opacity="0.16"/>
            <stop offset="1" stop-color="${stroke}" stop-opacity="0"/>
          </linearGradient></defs>
          ${grid}
          <path d="${area}" fill="url(#g-${slug(title)})"/>
          <path d="${line}" fill="none" stroke="${stroke}" stroke-width="2" stroke-linejoin="round"/>
          <circle cx="${lastX.toFixed(1)}" cy="${lastY.toFixed(1)}" r="3.5" fill="${stroke}"/>
          <text x="${(lastX - 4).toFixed(1)}" y="${(lastY - 8).toFixed(1)}" text-anchor="end" font-size="12" font-weight="600" fill="${COL.ink}" font-family="'IBM Plex Mono',monospace">${fmtVal(last, unit, dp)}</text>
        </svg>
        <figcaption class="chart-cap"><span>${esc(title)} · ${esc(cap)}</span><span style="color:${up ? COL.pos : COL.neg};font-weight:600">${chgTxt}</span></figcaption>
      </figure>`;
}

/**
 * Horizontal bar chart for comparisons (e.g. figures stated in an article).
 * opts: { title, series:[{label,value}], unit, dp, note }
 */
export function barChart({ title, series = [], unit = '', dp = 0, note = '' }) {
  const data = series.filter((d) => d && d.value != null && !Number.isNaN(+d.value)).map((d) => ({ label: String(d.label), value: +d.value }));
  if (data.length < 2) return '';

  const max = Math.max(...data.map((d) => Math.abs(d.value))) || 1;
  const rowH = 30, padT = 14, padB = 8, W = 600, labelW = 150, barMax = W - labelW - 70;
  const H = padT + padB + data.length * rowH;

  const rows = data.map((d, i) => {
    const yy = padT + i * rowH, cy = yy + rowH / 2 + 4;
    const w = (Math.abs(d.value) / max) * barMax;
    const col = d.value < 0 ? COL.neg : COL.teal;
    const lbl = fmtVal(d.value, unit, dp);
    // Place the value label just after the bar; if that would run off the right
    // edge (the longest bar), tuck it INSIDE the bar end in white so it's never
    // clipped/missing (this is why the biggest bar previously showed no number).
    const outsideX = labelW + w + 6;
    const fits = outsideX + lbl.length * 7.2 <= W - 2;
    const valTxt = fits
      ? `<text x="${outsideX.toFixed(1)}" y="${cy}" font-size="12" font-weight="600" fill="${COL.ink}" font-family="'IBM Plex Mono',monospace">${lbl}</text>`
      : `<text x="${(labelW + w - 6).toFixed(1)}" y="${cy}" text-anchor="end" font-size="12" font-weight="600" fill="#fff" font-family="'IBM Plex Mono',monospace">${lbl}</text>`;
    return `
      <text x="0" y="${cy}" font-size="12.5" fill="${COL.ink}" font-family="'Inter',sans-serif">${esc(d.label.slice(0, 26))}</text>
      <rect x="${labelW}" y="${yy + 6}" width="${w.toFixed(1)}" height="${rowH - 14}" rx="2" fill="${col}"/>
      ${valTxt}`;
  }).join('');

  return `
      <figure>
        <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(title)}">${rows}</svg>
        <figcaption class="chart-cap"><span>${esc(title)}</span>${note ? `<span>${esc(note)}</span>` : ''}</figcaption>
      </figure>`;
}

// Render an AI-produced story chart spec. Returns '' if the spec is unusable.
export function storyChart(chart) {
  if (!chart || typeof chart !== 'object') return '';
  const { type, title, unit = '', dp, series, note } = chart;
  if (!Array.isArray(series) || series.length < 2) return '';
  if (type === 'line') {
    // series may be [{label,value}] or [n]; coerce to numbers
    const nums = series.map((s) => (typeof s === 'object' ? +s.value : +s)).filter((n) => !Number.isNaN(n));
    return lineChart({ title: title || 'Trend', series: nums, unit, dp: dp ?? 2, caption: note || 'from reported figures' });
  }
  return barChart({ title: title || 'Comparison', series, unit, dp: dp ?? 0, note: note || 'from reported figures' });
}

function slug(s = '') { return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '').slice(0, 12) || 'c'; }
