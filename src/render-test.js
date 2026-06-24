// render-test.js — local smoke test: real market data + mock stories, NO Gemini.
// Run: node src/render-test.js  → writes preview/index.html (gitignored, never
// touches the tracked public/ that the build bot commits).
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { fetchMarket } from './market.js';
import { buildHTML } from './build.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PREVIEW_DIR = path.join(__dirname, '..', 'preview');

const now = Date.now();
const mk = (o) => ({
  link: 'https://example.com/' + Math.random().toString(36).slice(2),
  source: 'Economic Times', published: new Date(now - 3 * 3.6e6),
  summary: 'A two to three sentence original summary that conveys what happened and why it matters to an Indian investment professional reading the morning edition.',
  soWhat: 'The investment implication, stated in a single tight sentence.',
  chart: null, ...o,
});

const macro = [
  mk({ headline: 'FPI inflows into G-Secs hit record ₹32,000 crore in June', source: 'Financial Express',
    chart: { type: 'bar', title: 'FPI G-Sec inflows', unit: '₹cr', dp: 0,
      series: [{ label: 'Apr', value: 8200 }, { label: 'May', value: 19400 }, { label: 'Jun', value: 32000 }],
      note: 'Inflows accelerating into the FAR window' } }),
  mk({ headline: 'Crude tumbles from $113 to $83 as US-Iran deal nears', source: 'Livemint' }),
  mk({ headline: 'Rupee extends winning streak to third day, settles at 94.56/$', source: 'Economic Times' }),
];
const sector = [
  mk({ headline: 'InvIT distributions top ₹91,000 crore as market expands', source: 'Economic Times' }),
  mk({ headline: 'Nifty Realty index surges 2.26% on rate-cut hopes', source: 'Business Standard' }),
];
const india = [
  mk({ headline: 'Turtlemint sets ₹144-152 band for ₹883-crore public issue', source: 'Business Standard' }),
  mk({ headline: '70 large EM funds remain underweight on India, says Jefferies', source: 'Financial Express' }),
];
const global = [
  mk({ headline: 'Treasury yields seen unlikely to return to pre-war levels soon', source: 'WSJ', isIndian: false }),
  mk({ headline: 'Nvidia extends rally as AI-compute demand outruns supply', source: 'Bloomberg', isIndian: false }),
];
const compliance = [
  mk({ headline: "SEBI eases AIF winding-up norms, introduces 'inoperative fund' status", source: 'Hindu BusinessLine' }),
  mk({ headline: 'SEBI imposes ₹6.04 crore penalty on NSE over April 2024 glitch', source: 'Business Standard' }),
];

const mechanism = {
  tier: 'Frontier', title: 'How the FAR window quietly reprices the entire G-Sec curve',
  hook: "Today's record FPI G-Sec inflow is not just demand — it changes who sets the long-end yield.",
  body: 'Step 1 — The Fully Accessible Route (FAR) lets foreigners buy specified G-Secs with no quota.\n\nStep 2 — Index inclusion forces passive funds to buy regardless of price, compressing term premium.\n\nStep 3 — A lower long-end yield cheapens corporate borrowing benchmarked to the G-Sec curve.\n\nStep 4 — The second-order effect: duration risk migrates to foreign hands, raising rupee sensitivity to global rate shocks.',
  takeaway: 'Watch FAR flows as a leading indicator for the 10Y, not a lagging one.',
  points: [{ n: '₹32,000cr', l: 'June FPI G-Sec inflow' }, { n: 'FAR', l: 'no-quota access route' }, { n: '10Y', l: 'most repriced tenor' }],
};
const explainers = [
  { tag: 'Instrument', title: 'What an InvIT actually distributes — and why it is not a dividend', body: 'An InvIT passes through cash flows from infrastructure assets.\n\nDistributions blend interest, dividend and capital return, each taxed differently in the unitholder’s hands.', why: 'Mis-reading the split overstates post-tax yield by 100-200 bps.' },
  { tag: 'Macro', title: 'Why a falling rupee can coexist with record foreign inflows', body: 'Bond inflows and equity outflows can net to rupee weakness even as headline FPI looks strong.\n\nThe direction of the basic balance, not gross flows, sets the currency.', why: 'Gross FPI headlines mislead on currency direction.' },
];
const myths = [
  { tag: 'Flows', claim: '"FII selling always means the market falls"', correction: 'DII and retail SIP flows have repeatedly absorbed FII selling since 2021; net flow, not FII flow, matters.' },
  { tag: 'Valuation', claim: '"A low P/E means a stock is cheap"', correction: 'P/E ignores capital structure and growth; EV/EBITDA and ROIC tell you far more about real value.' },
  { tag: 'Credit', claim: '"AAA-rated means risk-free"', correction: 'Ratings lag fundamentals; spread widening often precedes downgrades by quarters.' },
];

const vid = (channel, title, videoId, blurb, hrsAgo) => ({
  channel, title, link: `https://www.youtube.com/watch?v=${videoId}`, videoId,
  thumb: `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
  published: new Date(now - hrsAgo * 3.6e6).toISOString(), blurb,
});
const library = {
  videos: [
    vid('Markets by Zerodha', 'The finances of Indian states, explained', 'dQw4w9WgXcQ', 'Breaks down how state finances actually work — own-tax revenue, devolution and the borrowing limits that constrain capex.', 6),
    vid('Zerodha Varsity', 'How to analyse con-call transcripts using AI', 'dQw4w9WgXcQ', 'A practical workflow for mining management commentary for guidance, capex and margin signals before the Street reprices them.', 30),
    vid('CA Rachana Ranade', 'Can El Niño impact India’s economy?', 'dQw4w9WgXcQ', 'Connects monsoon risk to food inflation, rural demand and the RBI’s rate path in one clean causal chain.', 26),
    vid('Akshat Shrivastava', 'High GDP, flat market: the curious case of India', 'dQw4w9WgXcQ', 'Why nominal growth and index returns can diverge for years — earnings concentration, valuation and the float that actually moves.', 28),
    vid('Capitalmind', 'NRIs & OCIs investing in India: the tax mistake', 'dQw4w9WgXcQ', 'The TDS and capital-gains traps that can quietly cost overseas investors half their gains, and how to structure around them.', 50),
  ],
  podcast: {
    show: 'Acquired', title: 'Vanguard', link: 'https://www.acquired.fm/episodes/vanguard',
    published: new Date(now - 40 * 3.6e6).toISOString(), duration: '10800',
    image: 'https://img.transistor.fm/placeholder.jpg',
    blurb: 'The origin of index investing told as a business story — how Bogle’s mutual-ownership structure made low cost a permanent moat.',
  },
};

const managers = [
  { manager: 'Saurabh Mukherjea', firm: 'Marcellus Investment Managers', tier: 1, title: 'Why quality compounders still win in this market', channel: 'ET Now', published: new Date(now - 2 * 3.6e6 * 24).toISOString(), thumb: 'https://i.ytimg.com/vi/dQw4w9WgXcQ/mqdefault.jpg', link: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' },
  { manager: 'Kenneth Andrade', firm: 'Old Bridge Capital', tier: 1, title: 'Where the next cycle of value is hiding', channel: 'CNBC-TV18', published: new Date(now - 5 * 3.6e6 * 24).toISOString(), thumb: 'https://i.ytimg.com/vi/dQw4w9WgXcQ/mqdefault.jpg', link: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' },
];

const market = await fetchMarket();
const html = buildHTML({ macro, sector, india, global, compliance, market, mechanism, explainers, myths, library, managers, runTime: new Date().toUTCString() });
fs.mkdirSync(PREVIEW_DIR, { recursive: true });
fs.writeFileSync(path.join(PREVIEW_DIR, 'index.html'), html);
console.log('\n✅ render-test wrote preview/index.html');
