# Library videos — how the marketing team adds videos

The Library's video grid is driven by a **Google Sheet** (recommended) or a **JSON
file** (developer fallback). For YouTube/Vimeo/TikTok the title, channel and HD
thumbnail are pulled **automatically** from the posted video. A video only appears
(and only fires a notification) once its **Publish** box is ticked — so you can take
your time filling a row without anything going live half-built.

Import **`library-videos-template.csv`** into Google Sheets to start (correct
columns + example rows, including the Publish column).

## The golden rule: never upload raw video files

Upload the video — any size, including vertical Shorts/Reels — to the firm's unlisted
YouTube/Vimeo/TikTok, then use only the **link**. The host handles size, playback and
thumbnails. Cards are thumbnail + link only; clicking opens the platform.

## The process (per video)

1. **Upload/post** the video. For Instagram/LinkedIn/Facebook, also grab a thumbnail
   image and host it somewhere public to get an image URL.
2. **Add a row** with **Publish = FALSE** (unticked) while you work: paste the `url`,
   set a `date`, write a `blurb`. For YouTube/Vimeo/TikTok that's all. For IG/LI/FB,
   also add `title` + `thumbnail`.
3. **When the row is complete, tick Publish (TRUE).** *Only now* does it go live and
   send the notification. Take 5, 10, 30 minutes to prepare — nothing fires until the
   tick. Editing or copy-pasting draft rows triggers nothing.
4. It appears **on the next page refresh** (live), and is baked into the 7 AM edition.

**Ordering:** videos show **newest `date` first** (up to 6). To put one on top, give
it the latest date — row position in the sheet does not decide order.

**To take a video down:** untick Publish (or delete the row). It disappears on the
next refresh.

## One-time setup (developer, ~5 min)

1. Import `library-videos-template.csv` into a new Google Sheet. Tip: make the
   Publish column a checkbox (**Insert → Checkbox**).
2. **File → Share → Publish to web → CSV → Publish.** Copy the URL.
3. Repo → **Settings → Secrets and variables → Actions** → set `LIBRARY_SHEET_CSV_URL`.

No sheet URL set → the grid reads `library-videos.json` here instead. Any sheet error
falls back to the JSON so the build never breaks.

## Fields (columns)

| Column | Required | Notes |
|---|---|---|
| `publish` | ✅ | `TRUE`/ticked = live; `FALSE`/blank = hidden draft. (If the sheet has no publish column at all, every row is treated as live.) |
| `url` | ✅ | The video link, any supported platform. |
| `date` | recommended | `YYYY-MM-DD` (or `26-Jul-2026`). Newest shows first. |
| `blurb` | — | 1–2 line description under the title. |
| `title` | Auto for YT/Vimeo/TikTok; **required for IG/LI/FB** | Fill to override the auto title. |
| `thumbnail` | Auto for YT/Vimeo/TikTok; **required for IG/LI/FB** | A public image URL. |
| `source` | — | Card label. Defaults to the channel name (auto) or platform. |
| `duration` | — | Auto for Vimeo/TikTok; add for YouTube/IG/LI to show the `12:30` tag. |

## Different video sizes / Shorts

Handled automatically. Landscape videos fill the 16:9 card; vertical Shorts/Reels/
TikTok show upright on a dark letterbox tile (not cropped). Nothing to configure.
