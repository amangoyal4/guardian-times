// feeds.js — the master feed list for Guardian Times.
// `section` is a HINT for routing; the router also uses keyword rules, so a feed
// can contribute stories to several pages. `weight` nudges ordering (higher = more likely to lead).
// To disable a feed without deleting it, set enabled:false.

export const FEEDS = [
  // ---- Indian markets & business ----
  { id: 'et-markets',     name: 'Economic Times — Markets', url: 'https://economictimes.indiatimes.com/markets/rssfeeds/1977021501.cms', section: 'india',      region: 'in', weight: 3, enabled: true },
  { id: 'bs-markets',     name: 'Business Standard — Markets', url: 'https://www.business-standard.com/rss/markets-106.rss',               section: 'india',      region: 'in', weight: 3, enabled: false }, // 403 — server blocks automated fetchers
  { id: 'mint-markets',   name: 'Livemint — Markets',       url: 'https://www.livemint.com/rss/markets',                                   section: 'india',      region: 'in', weight: 3, enabled: true },
  { id: 'mc-business',    name: 'Moneycontrol — Business',  url: 'https://www.moneycontrol.com/rss/business.xml',                          section: 'india',      region: 'in', weight: 2, enabled: true },
  { id: 'bl-markets',     name: 'Hindu BusinessLine',       url: 'https://www.thehindubusinessline.com/markets/feeder/default.rss',        section: 'india',      region: 'in', weight: 2, enabled: true },
  { id: 'fe-markets',     name: 'Financial Express — Market', url: 'https://www.financialexpress.com/market/feed/',                        section: 'india',      region: 'in', weight: 2, enabled: false }, // malformed XML on all endpoints
  { id: 'bt-money',       name: 'Business Today',           url: 'https://www.businesstoday.in/rssfeeds/?id=225',                          section: 'india',      region: 'in', weight: 2, enabled: true },

  // ---- Regulators / compliance ----
  { id: 'rbi-press',      name: 'RBI — Press Releases',     url: 'https://www.rbi.org.in/pressreleases_rss.xml',                           section: 'compliance', region: 'in', weight: 3, enabled: true },
  { id: 'sebi-press',     name: 'SEBI — Press Releases',    url: 'https://www.sebi.gov.in/sebirss.xml',                                    section: 'compliance', region: 'in', weight: 3, enabled: true },
  { id: 'nse-circ',       name: 'NSE — Circulars',          url: 'https://nsearchives.nseindia.com/content/RSS/Circulars.xml',              section: 'compliance', region: 'in', weight: 2, enabled: true },

  // ---- Global markets & economy ----
  { id: 'wsj-markets',    name: 'WSJ — Markets',            url: 'https://feeds.content.dowjones.io/public/rss/RSSMarketsMain',            section: 'global',     region: 'global', weight: 3, enabled: true },
  { id: 'wsj-world',      name: 'WSJ — World',              url: 'https://feeds.content.dowjones.io/public/rss/RSSWorldNews',              section: 'macro',      region: 'global', weight: 2, enabled: true },
  { id: 'bbg-markets',    name: 'Bloomberg — Markets',      url: 'https://feeds.bloomberg.com/markets/news.rss',                           section: 'global',     region: 'global', weight: 3, enabled: true },
  { id: 'bbg-econ',       name: 'Bloomberg — Economics',    url: 'https://feeds.bloomberg.com/economics/news.rss',                         section: 'macro',      region: 'global', weight: 3, enabled: true },
  { id: 'ft-home',        name: 'Financial Times — Home',   url: 'https://www.ft.com/rss/home',                                            section: 'global',     region: 'global', weight: 2, enabled: true },
  { id: 'guardian-biz',   name: 'The Guardian — Business',  url: 'https://www.theguardian.com/uk/business/rss',                            section: 'global',     region: 'global', weight: 2, enabled: true }, // Reuters public RSS discontinued; Guardian Business as global-wire replacement
  { id: 'cnbc-finance',   name: 'CNBC — Finance',           url: 'https://www.cnbc.com/id/10000664/device/rss/rss.html',                   section: 'global',     region: 'global', weight: 2, enabled: true },
  { id: 'mw-top',         name: 'MarketWatch — Top',        url: 'https://feeds.content.dowjones.io/public/rss/mw_topstories',             section: 'global',     region: 'global', weight: 2, enabled: true },
  { id: 'economist-fin',  name: 'Economist — Finance',      url: 'https://www.economist.com/finance-and-economics/rss.xml',                section: 'macro',      region: 'global', weight: 2, enabled: true },
  { id: 'investing-news', name: 'Investing.com — News',     url: 'https://www.investing.com/rss/news.rss',                                 section: 'global',     region: 'global', weight: 1, enabled: true },
];
