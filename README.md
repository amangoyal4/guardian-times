# Guardian Times — News Engine

A personalised financial newspaper that builds itself. It fetches RSS feeds, filters to the last 24 hours, summarises each story in your house style with Google's Gemini (free tier), routes everything into seven sections, and writes a static `index.html` — then GitHub Actions publishes it to the web twice a day and on demand.

```
RSS feeds → fetch (24h, dedup) → route + tag → Gemini summarise → build HTML → GitHub Pages
```

---

## What you need (one-time)

1. A **GitHub account** (you have this).
2. A free **Gemini API key** — https://aistudio.google.com/apikey (no credit card).

That's it. Everything else is in this repo.

---

## Setup — step by step

### 1. Put this folder in a new GitHub repo
Create a repo (e.g. `guardian-times`), and push these files to it.

### 2. Add your Gemini key as a secret
In the repo: **Settings → Secrets and variables → Actions → New repository secret**
- Name: `GEMINI_API_KEY`
- Value: *(paste your key)*

The key lives only in GitHub's encrypted secrets — never in the code.

### 3. Turn on Pages
**Settings → Pages → Build and deployment → Source: GitHub Actions.**

### 4. Run it once, by hand
**Actions tab → "Build Guardian Times" → Run workflow.**
This is also your **manual Refresh** — hit it any time you want a fresh edition.

When it finishes, your paper is live at `https://<your-username>.github.io/<repo>/`.

### 5. From then on it runs itself
The schedule fires twice daily (07:00 and 19:00 IST). Adjust the times in `.github/workflows/build.yml` (cron is in UTC).

---

## IMPORTANT: check your feeds first

The 20 feeds in `src/feeds.js` are configured but **not yet verified against the live internet** (they were set up in an environment that couldn't reach news sites). Premium outlets (WSJ, Bloomberg, FT, Economist, Reuters, Investing.com) often block automated fetchers or need different endpoints, so expect a few to fail on the first run.

**Run the health check first** (locally, with Node 18+):
```bash
npm install
npm run feeds:check
```
It prints a ✓/✗ for every feed. For any ✗, open `src/feeds.js` and set `enabled: false` on that line (or fix the URL). The engine also logs this same table on every build, and writes `public/health.json`, so you can always see which sources are live.

The build is resilient: a dead feed is skipped, never fatal. Even if several premium feeds fail, the Indian feeds (ET, Moneycontrol, BusinessLine, FE, Business Today) plus RBI/SEBI will carry the paper.

---

## Run locally (optional)
```bash
npm install
export GEMINI_API_KEY=your_key_here   # Windows: set GEMINI_API_KEY=...
npm run build
# open public/index.html
```

---

## Customising

| What | Where |
|---|---|
| Add/remove/disable feeds | `src/feeds.js` |
| Your watchlist (My Watch tags) | `WATCHLIST` in `src/router.js` |
| Section routing keywords | `SECTION_RULES` in `src/router.js` |
| House style / prompts | `HOUSE` and prompts in `src/summarize.js` |
| Stories per section | `PER_SECTION` in `src/index.js` |
| Recency window | `hours` in `src/index.js` (default 24) |
| Schedule | cron in `.github/workflows/build.yml` |
| Design / layout | `src/template.html` (the locked front-end) |
| Gemini model | `GEMINI_MODEL` env (default `gemini-2.5-flash`) |

---

## Notes & honest limits

- **Freshness** is "as fresh as the last run + as fresh as the feeds publish." Real `pubDate` timestamps drive the 24h filter, but the page only rebuilds on the schedule or a manual run — it's a twice-daily edition, not a live ticker.
- **Links** always point to the original publisher. Paywalled outlets stay paywalled when you click through — no engine can change that. You get a correct link + an original summary every time.
- **The ticker** (Sensex/Nifty levels) is a placeholder until a quotes feed is wired in — a good next addition.
- **Free-tier privacy**: Gemini's free tier may use prompts for training. You're only sending public headlines, which is fine — but don't pipe anything confidential through it. Switch to a paid tier when you need that.
- **Email** is intentionally not built yet (web-first). Adding it later is a small module: render the same data to an HTML email and send via an email API. The data layer is already separated from the HTML, so it slots in cleanly.

---

## Next steps after it's live
1. Run `feeds:check`, disable the dead feeds.
2. Tune `WATCHLIST` to your real holdings.
3. Watch a couple of editions, adjust `SECTION_RULES` if anything lands in the wrong section.
4. When happy: add a live quotes feed for the ticker, then the email module.
