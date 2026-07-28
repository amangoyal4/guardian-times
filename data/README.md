# Library videos — how the marketing team adds videos

The Library's video grid is driven by a **Google Sheet** (recommended, for marketing)
or a **JSON file** (fallback, for developers). For YouTube, Vimeo and TikTok the
title, channel and highest-quality thumbnail are pulled **automatically from the
posted video** — marketing just pastes a link. Instagram, LinkedIn and Facebook need
a title + thumbnail supplied in the sheet (those platforms block auto-fetch).

Import **`library-videos-template.csv`** (in this folder) into Google Sheets to start
— it has the right columns and one example row per platform.

## What auto-fills, by platform

| Platform | Paste just the link? | Notes |
|---|---|---|
| **YouTube** | ✅ Yes | Title, channel, maxres (HD) thumbnail auto. |
| **Vimeo** | ✅ Yes | Title, channel, high-res thumbnail, duration auto. |
| **TikTok** | ✅ Yes | Title, author, thumbnail auto. |
| **Instagram** | ⚠ Add title + thumbnail | Meta blocks keyless fetch; supply both in the sheet. |
| **LinkedIn** | ⚠ Add title + thumbnail | No public thumbnail access; supply both. |
| **Facebook** | ⚠ Add title + thumbnail | Same as Instagram. |

**Tip for Instagram/LinkedIn:** the zero-effort option is to also upload the clip to
the firm's **unlisted YouTube** and use *that* link — then everything auto-fills and
you skip the manual title/thumbnail. Use the native IG/LinkedIn link only if you
specifically want the card to open that platform.

## The process (per video)

1. **Upload/post** the video. For IG/LinkedIn, also grab a thumbnail image (a
   screenshot or cover) and host it somewhere public (your website/CDN) to get an
   image URL.
2. **Copy the video link.**
3. **Add a row** to the sheet: paste the link in `url`, add a `date` (ordering) and a
   one-line `blurb`. For YouTube/Vimeo/TikTok that's it. For IG/LinkedIn/Facebook,
   also fill `title` and `thumbnail`.
4. **Done.** The next morning's edition shows it (up to 6 newest). The paper re-reads
   each video every build, so renaming/re-thumbnailing on YouTube/Vimeo/TikTok updates
   the paper automatically; removing a row removes the video.

## One-time setup (developer, ~5 min)

1. Import `library-videos-template.csv` into a new Google Sheet.
2. **File → Share → Publish to web → (this sheet) → Comma-separated values (.csv) →
   Publish.** Copy the URL.
3. GitHub repo → **Settings → Secrets and variables → Actions → Variables → New
   repository variable**: name `LIBRARY_SHEET_CSV_URL`, value = that CSV URL.

If no sheet URL is set, the grid reads `library-videos.json` in this folder instead
(same fields; `[]` = no videos). The sheet always wins when configured, and any sheet
error falls back to the JSON so the build never breaks. The build log warns about any
row missing a required title/thumbnail.

## Fields (columns)

| Column | Required | Notes |
|---|---|---|
| `url` | ✅ | The video link, any supported platform. |
| `date` | recommended | `YYYY-MM-DD`. Newest shows first; up to 6 display. |
| `blurb` | — | 1–2 line description under the title. |
| `title` | Auto for YT/Vimeo/TikTok; **required for IG/LinkedIn/FB** | Fill to override the auto title. |
| `thumbnail` | Auto for YT/Vimeo/TikTok; **required for IG/LinkedIn/FB** | A public image URL. |
| `source` | — | Card label. Defaults to the channel name (auto) or platform. |
| `duration` | — | Auto for Vimeo/TikTok. Add for YouTube/IG/LinkedIn if you want the `12:30` tag. |

## How different video sizes are handled

Nothing to do. Each card is a fixed 16:9 tile and the thumbnail is centre-cropped to
fill it, so vertical, square and landscape videos all sit neatly in the same grid.
For a vertical video where the auto-crop cuts something important, put a landscape
image URL in the `thumbnail` column for that row.
