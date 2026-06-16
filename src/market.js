// market.js — keyless market data via Yahoo Finance's chart API.
// Returns live levels (for the ticker) and ~1mo daily series (for charts).
// Resilience-first: a failed symbol is skipped, never fatal.

const UA = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
  'Accept': 'application/json',
};

// label, Yahoo symbol, decimals, unit prefix/suffix
const INSTRUMENTS = [
  { key: 'sensex', label: 'Sensex',  sym: '^BSESN', dp: 0, unit: '' },
  { key: 'nifty',  label: 'Nifty',   sym: '^NSEI',  dp: 0, unit: '' },
  { key: 'usdinr', label: 'USD/INR', sym: 'INR=X',  dp: 2, unit: '' },
  { key: 'brent',  label: 'Brent',   sym: 'BZ=F',   dp: 2, unit: '$' },
  { key: 'gold',   label: 'Gold',    sym: 'GC=F',   dp: 0, unit: '$' },
  { key: 'spx',    label: 'S&P 500', sym: '^GSPC',  dp: 0, unit: '' },
];

async function fetchOne(inst) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(inst.sym)}?interval=1d&range=1mo`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15000);
  try {
    const res = await fetch(url, { headers: UA, signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const j = await res.json();
    const r = j?.chart?.result?.[0];
    const closes = (r?.indicators?.quote?.[0]?.close || []).filter((x) => x != null);
    if (closes.length < 2) throw new Error('no series');
    const last = r.meta?.regularMarketPrice ?? closes[closes.length - 1];
    // Day-over-day vs the prior daily close. meta.chartPreviousClose is unreliable
    // for futures (it can return the pre-window close), so use the series instead.
    const prev = closes[closes.length - 2];
    const chg = last - prev;
    const pct = prev ? (chg / prev) * 100 : 0;
    return { ...inst, last, prev, chg, pct, series: closes, ok: true };
  } catch (err) {
    return { ...inst, ok: false, error: err.message };
  } finally {
    clearTimeout(timer);
  }
}

const fmt = (n, dp) => Number(n).toLocaleString('en-IN', { minimumFractionDigits: dp, maximumFractionDigits: dp });

/**
 * @returns {Promise<{instruments: object[], byKey: Object}>}
 */
export async function fetchMarket() {
  console.log('\n📈 Fetching market data (Yahoo, keyless)…');
  const instruments = await Promise.all(INSTRUMENTS.map(fetchOne));
  const live = instruments.filter((i) => i.ok);
  console.log(`   ${live.length}/${INSTRUMENTS.length} instruments live: ${live.map((i) => i.label).join(', ')}`);
  const byKey = Object.fromEntries(instruments.map((i) => [i.key, i]));
  return { instruments, byKey, fmt };
}

// HTML for the masthead ticker (one <span> per live instrument).
export function tickerHTML({ instruments }) {
  return instruments
    .filter((i) => i.ok)
    .map((i) => {
      const cls = i.chg > 0 ? 'pos' : i.chg < 0 ? 'neg' : '';
      const arrow = i.chg > 0 ? '▲' : i.chg < 0 ? '▼' : '';
      const val = `${i.unit}${fmt(i.last, i.dp)}`;
      const pct = `${i.pct >= 0 ? '+' : ''}${i.pct.toFixed(2)}%`;
      return `<span>${i.label} <b>${val}</b> <span class="${cls}">${arrow}${pct}</span></span>`;
    })
    .join('');
}

export { INSTRUMENTS, fmt };
