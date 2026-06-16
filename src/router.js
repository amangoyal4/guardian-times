// router.js — sorts each story into a section, and tags watchlist hits for My Watch.
// Pure keyword + source rules; tune the lists freely.

// ---- your personal watchlist (edit freely) ----
export const WATCHLIST = {
  IT:      ['infosys', 'tcs', 'wipro', 'hcl tech', 'tech mahindra', 'eternal', 'zomato', 'nvidia', ' ai ', 'data centre', 'data center', 'cloud'],
  Banks:   ['hdfc bank', 'icici', 'axis bank', 'sbi', 'kotak', 'indusind', 'yes bank', 'nbfc', 'shriram', 'bajaj finance', 'muthoot', 'bank credit'],
  Metals:  ['vedanta', 'tata steel', 'jsw', 'hindalco', 'sail', 'coal india', 'ongc', 'oil india', 'crude', 'aluminium', 'steel'],
  GIFT:    ['gift city', 'ifsca', 'aif', 'alternative investment', 'pms', 'mutual fund', 'fpi', 'g-sec', 'gilt'],
  Eternal: ['eternal', 'zomato', 'blinkit'],
  Shriram: ['shriram'],
};

// ---- section keyword rules (checked in order; first strong match wins) ----
const SECTION_RULES = [
  { section: 'compliance', kws: ['sebi', 'rbi ', 'circular', 'regulation', 'regulator', 'compliance', 'master circular', 'penalty', 'banned', 'ban order', 'insider trading', 'fraud', 'amfi', 'ifsca', 'guidelines', 'notification'] },
  { section: 'macro',      kws: ['inflation', 'cpi', 'gdp', 'repo rate', 'fed ', 'fomc', 'monetary policy', 'rate cut', 'rate hike', 'fiscal', 'rupee', 'bond yield', 'g-sec', 'opec', 'crude oil', 'current account', 'trade deficit', 'unemployment', 'jobs report', 'central bank'] },
  { section: 'india',      kws: ['sensex', 'nifty', 'fii', 'dii', 'demerger', 'ipo', 'qip', 'dividend', 'bonus', 'stake', 'results', 'earnings', 'q1', 'q2', 'q3', 'q4', 'bse', 'nse', 'block deal'] },
  { section: 'global',     kws: ['s&p 500', 'nasdaq', 'dow', 'wall street', 'nvidia', 'apple', 'microsoft', 'tesla', 'amazon', 'meta', 'treasury', 'ecb', 'european', 'china', 'us stocks'] },
  { section: 'sector',     kws: ['sector', 'auto', 'pharma', 'fmcg', 'realty', 'metals', 'banking sector', 'it sector', 'telecom', 'energy', 'power', 'cement'] },
];

const VALID_SECTIONS = ['macro', 'sector', 'india', 'global', 'compliance'];

function scoreSection(text, region) {
  const t = ' ' + text.toLowerCase() + ' ';
  for (const rule of SECTION_RULES) {
    if (rule.kws.some((k) => t.includes(k))) return rule.section;
  }
  // fall back on region: global-region undated business news -> global, else india
  return region === 'global' ? 'global' : 'india';
}

export function routeItem(item) {
  const text = `${item.title} ${item.rawSummary}`;
  // start from the keyword classification, but let a strong feed hint win when keywords are weak
  let section = scoreSection(text, item.region);
  if (!VALID_SECTIONS.includes(section)) section = item.sectionHint || 'india';

  // watchlist tags
  const tlc = text.toLowerCase();
  const tags = [];
  for (const [tag, kws] of Object.entries(WATCHLIST)) {
    if (kws.some((k) => tlc.includes(k))) tags.push(tag);
  }

  return { ...item, section, watchTags: tags };
}

export function routeAll(items) {
  return items.map(routeItem);
}
