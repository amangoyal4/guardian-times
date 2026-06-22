// router.js — classifies each story by TOPIC and REGION, then maps to a section.
//
// Design:
//   1. REGION  — is this an Indian story or a global one? Decided by counting strong
//      India/global tokens in the text, falling back to the feed's own region.
//   2. TOPIC   — compliance / macro / sector / equity, by weighted keyword scoring
//      (regulatory, macro and sector signals outweigh generic market/equity words).
//   3. SECTION — compliance→compliance, macro→macro, sector→sector,
//      equity→india if Indian else global.
// Ranking (in index.js) then floats Indian stories to the top of every mixed section.

// ---- region tokens (text is lowercased and space-padded before matching) ----
const INDIA_TOKENS = [
  ' india', 'indian', ' nifty', 'sensex', ' bse', ' nse ', ' sebi', ' rbi', 'rupee', '₹',
  ' crore', ' lakh', 'dalal street', 'd-street', ' fii', ' dii', ' nbfc', ' amfi', ' ifsca',
  'gift city', 'mumbai', 'new delhi', 'bengaluru', 'reserve bank of india', 'psu bank',
  // major Indian names that signal an India story even in a global feed
  'infosys', ' tcs', 'reliance', 'hdfc', 'icici', 'adani', ' tata', 'wipro', ' sbi', 'bajaj',
  'zomato', 'paytm', 'vedanta', 'jsw', 'hindalco', 'maruti', 'mahindra',
];
const GLOBAL_TOKENS = [
  ' u.s.', ' us ', ' fed ', 'fomc', 'federal reserve', ' ecb', ' boj', 'bank of england',
  'wall street', 's&p 500', 'nasdaq', 'dow jones', ' dow ', 'treasury', 'eurozone', 'euro zone',
  'nikkei', ' ftse', 'hang seng', 'britain', 'germany', 'france', ' china', 'beijing',
  'washington', ' london', 'brussels',
  // global mega-caps that signal a global story even in an Indian feed
  'nvidia', ' apple', 'microsoft', 'tesla', 'amazon', ' meta ', ' google', 'spacex', 'openai',
  'anthropic', 'alphabet', 'stmicro',
];

// ---- topic keyword sets (weighted; regulatory/macro/sector beat generic equity) ----
const TOPICS = [
  { name: 'compliance', weight: 3, kws: ['circular', 'master circular', 'penalt', ' fine', ' ban ', 'banned', 'insider trading', 'fraud', 'enforcement', 'show-cause', 'show cause', 'settlement order', 'adjudicat', 'lending norms', 'disclosure norms', 'listing norms', 'margin norms', 'prudential norms', 'f&o norms', 'aif norms', 'investment norms', 'exposure norms', 'delisting norms', 'guidelines', 'regulation', 'regulator', 'disclosure requirement', 'regulatory framework', 'disclosure framework', 'winding-up', 'winding up', ' kyc', ' sebi ', ' probe', 'investigat', 'crackdown', 'sanction'] },
  { name: 'macro', weight: 3, kws: ['repo rate', 'rate cut', 'rate hike', 'interest rate', 'monetary policy', ' mpc', 'inflation', ' cpi', ' wpi', 'retail inflation', ' gdp', ' gva', 'fiscal deficit', 'current account', 'trade deficit', 'trade balance', 'bond yield', 'g-sec', ' gilt', 'forex reserves', 'industrial production', ' iip', ' pmi', 'unemployment', 'jobs report', 'payroll', ' fed ', 'fomc', 'federal reserve', ' ecb', 'central bank', ' opec', 'crude oil', ' brent', 'tariff', 'liquidity', 'money market', 'money-market', 'call money', 'durable liquidity', 'systemic liquidity', 'ways and means'] },
  { name: 'sector', weight: 2, kws: ['sectoral', 'auto stocks', 'auto sales', 'two-wheeler', 'passenger vehicle', ' pharma', ' fmcg', ' realty', 'real estate', 'metal stocks', 'banking stocks', 'bank stocks', 'it stocks', ' telecom', 'energy stocks', 'power stocks', ' cement', 'capital goods', ' defence', 'infra stocks', 'infrastructure sector', 'sector rotation', 'semiconductor', 'chipmaker', 'sector index', 'industry-wide', 'across the sector',
    // sectoral indices are unambiguous sector stories
    'nifty pharma', 'nifty bank', 'bank nifty', 'nifty realty', 'nifty it', 'nifty auto', 'nifty metal', 'nifty fmcg', 'nifty psu', 'nifty energy', 'nifty financial', 'nifty media'] },
  { name: 'equity', weight: 1, kws: ['sensex', 'nifty', ' stock', 'shares', 'share price', ' ipo', ' qip', 'dividend', 'buyback', 'earnings', 'results', ' q1', ' q2', ' q3', ' q4', 'block deal', 'bulk deal', ' fii', ' dii', 'listing', 'debut', ' m&a', 'acquisition', 'merger', ' stake', 'demerger', 'nasdaq', ' dow', 's&p', 'rally', 'surge', 'jumps', 'plunge', 'tumble', 'valuation', 'market cap', 'bond sale', 'offering'] },
];

// A genuine SECTOR story moves a whole industry/theme together — typically a
// sectoral index or an explicitly sector-wide phrase. These are unambiguous.
const SECTOR_INDEX = /(nifty (pharma|bank|realty|it|auto|metal|fmcg|psu|energy|financial|media)|bank nifty|sectoral|sector index|sector rotation|across the sector|industry-wide|sector-wide)/i;
// A SINGLE-COMPANY action. When a headline is one company doing one of these, it
// is an equity (india/global) story even if it name-drops a sector word like
// "cement"/"pharma"/"realty" — e.g. "Dalmia Bharat Targets 110-130 MTPA Cement
// Capacity" or "Tech Mahindra Leases 4 Lakh Sq Ft". Without this, such items get
// mis-filed into Sector by the keyword scorer whenever the AI editor-cut is down.
const COMPANY_ACTION = /(\btargets?\b|\bleases?\b|\bwins?\b|\bbags?\b|\bsecures?\b|\bq[1-4]\b|\bresults?\b|earnings|\bipo\b|\bqip\b|\blists?\b|\bdebut\b|\bstake\b|acquir|\bmerg|demerg|\braises?\b|\bappoints?\b|board approv|order win|bond sale|buyback|\bdividend\b|\bexpansion\b|\bcapacity\b|\bplant\b|\bfunding\b)/i;

function pad(text) {
  return ' ' + text.toLowerCase().replace(/\s+/g, ' ') + ' ';
}

function countHits(t, tokens) {
  let n = 0;
  for (const tok of tokens) if (t.includes(tok)) n++;
  return n;
}

// Is this an Indian story? Token counts override the feed's nominal region.
function detectIndian(t, feedRegion) {
  const ind = countHits(t, INDIA_TOKENS);
  const glo = countHits(t, GLOBAL_TOKENS);
  if (ind > glo) return true;
  if (glo > ind) return false;
  return feedRegion === 'in';
}

// Highest weighted topic score wins; default to equity when nothing matches.
function detectTopic(t) {
  let best = 'equity', bestScore = 0;
  for (const { name, weight, kws } of TOPICS) {
    const score = countHits(t, kws) * weight;
    if (score > bestScore) { bestScore = score; best = name; }
  }
  return best;
}

export function routeItem(item) {
  const t = pad(`${item.title} ${item.rawSummary}`);
  const isIndian = detectIndian(t, item.region);
  let topic = detectTopic(t);

  // Single-company action that only happens to mention a sector word is an equity
  // story, not a sector story — unless the headline is genuinely about a sectoral
  // index / industry-wide move. Classify on the TITLE so a stray sector word in the
  // feed blurb can't drag a single company into Sector.
  if (topic === 'sector' && COMPANY_ACTION.test(item.title) && !SECTOR_INDEX.test(t)) {
    topic = 'equity';
  }

  let section;
  if (topic === 'compliance') section = 'compliance';
  else if (topic === 'macro') section = 'macro';
  else if (topic === 'sector') section = 'sector';
  else section = isIndian ? 'india' : 'global';

  return { ...item, section, isIndian };
}

export function routeAll(items) {
  return items.map(routeItem);
}
