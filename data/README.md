# Library videos — how the marketing team adds videos

The Library's video grid is driven by a **Google Sheet** (recommended, for marketing)
or a **JSON file** (fallback, for developers). The title, channel and highest-quality
thumbnail are pulled **automatically from the posted video** — so marketing usually
just pastes a link.

## The golden rule: never upload raw video files

Whatever the size or shape of the video — landscape interview, vertical reel, square
clip — **upload it to the firm's unlisted YouTube or Vimeo channel first**, then use
only the **link**. YouTube/Vimeo handle every size, resolution, aspect ratio, mobile
playback, thumbnails and bandwidth automatically and for free. The video on the
platform is the single source of truth: its **title and thumbnail there are exactly
what appears in the paper**, at full quality.

- **Unlisted** = not searchable/public, but anyone with the link can watch. Perfect
  for client-facing IP that shouldn't be fully public.

## The process (per video)

1. **Upload** the video to the firm's unlisted YouTube/Vimeo. Give it the title you
   want and (on YouTube) set a good HD thumbnail — this is what the paper will show.
2. **Copy the link** (e.g. `https://youtu.be/XXXXXXXXXXX`).
3. **Add a row** to the Google Sheet: paste the link in `url`, add a `date` (controls
   ordering), and optionally a one-line `blurb`. Leave `title`/`thumbnail` blank —
   they're pulled from the video automatically at highest quality.
4. **Done.** The next morning's edition (7 AM) shows it — or ask the dev to trigger a
   build to show it immediately. Up to 6 newest videos display.

**Because the paper rebuilds daily and re-reads the video each time, it stays in sync
automatically:** rename the video or change its thumbnail on YouTube and the paper
updates next morning; remove the row and it disappears. No stale data, ever.

## One-time setup (developer, ~5 min)

1. Create a Google Sheet with headers in row 1 (case-insensitive; `url` is the only
   required one): `url`, `date`, `blurb`, `title`, `source`, `duration`, `thumb`.
2. **File → Share → Publish to web → (this sheet) → Comma-separated values (.csv) →
   Publish.** Copy the URL.
3. GitHub repo → **Settings → Secrets and variables → Actions → Variables → New
   repository variable**: name `LIBRARY_SHEET_CSV_URL`, value = that CSV URL.

If no sheet URL is set, the grid reads `library-videos.json` in this folder instead
(same fields; `[]` = no videos). The sheet always wins when configured, and any sheet
error falls back to the JSON so the build never breaks.

## Fields

| Field | Required | Notes |
|---|---|---|
| `url` | ✅ | The unlisted YouTube/Vimeo link. Everything else can be derived from it. |
| `date` | recommended | `YYYY-MM-DD`. Newest shows first; up to 6 videos display. |
| `blurb` | — | 1–2 line description under the title (the one thing worth writing yourself). |
| `title` | — | **Auto-pulled from the posted video.** Fill only to override it. |
| `thumbnail` (`thumb`) | — | **Auto-pulled at highest resolution** (YouTube maxres; Vimeo high-res). Fill only to force a custom image (e.g. a landscape crop for a vertical video). |
| `source` | — | Channel label. **Auto-pulled** (the YouTube/Vimeo channel name); set it to override, e.g. "Guardian Capital". |
| `duration` | — | Auto for Vimeo. For YouTube, add it here if you want the `12:30` tag shown. |

## How different video sizes are handled

Nothing to do. Each card is a fixed 16:9 tile and the thumbnail is centre-cropped to
fill it, so vertical, square and landscape videos all sit neatly in the same grid.
For a vertical video where the auto-crop cuts something important, put a landscape
image URL in the `thumbnail` column for that row.
