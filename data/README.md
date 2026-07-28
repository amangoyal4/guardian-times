# Library videos — how the marketing team adds videos

The Library's video grid can be driven by a **Google Sheet** (recommended, for the
marketing team) or a **JSON file** (fallback, for developers). No code or git needed
for the sheet path.

## The golden rule: never upload raw video files

Whatever the size or shape of the video — landscape interview, vertical reel, square
clip — **upload it to the firm's unlisted YouTube or Vimeo channel first**, then use
only the **link**. YouTube/Vimeo handle every size, resolution, aspect ratio, mobile
playback, thumbnails and bandwidth automatically and for free. The Library shows a
tidy, uniform card (a 16:9 tile, thumbnail auto-cropped) no matter the source size,
and clicking plays the video at its native size on the host.

- **Unlisted** = not searchable/public, but anyone with the link can watch. Perfect
  for client-facing IP that shouldn't be fully public.

## Option A — Google Sheet (recommended for marketing)

**One-time setup (developer, ~5 min):**
1. Create a Google Sheet with these column headers in row 1 (order doesn't matter,
   names are case-insensitive): `title`, `url`, `blurb`, `source`, `date`,
   `duration`, `thumb`.
2. In Google Sheets: **File → Share → Publish to web → (this sheet) → Comma-separated
   values (.csv) → Publish**. Copy the URL it gives you.
3. In the GitHub repo: **Settings → Secrets and variables → Actions → Variables →
   New repository variable**, name `LIBRARY_SHEET_CSV_URL`, value = that CSV URL.

**Adding a video (marketing, any time):**
1. Upload the video to the firm's unlisted YouTube/Vimeo. Copy the share link.
2. Add a new row to the sheet:

| title | url | blurb | source | date | duration | thumb |
|---|---|---|---|---|---|---|
| Q1 FY26 Market Outlook | https://youtu.be/XXXXXXXXXXX | One line on what viewers learn. | Guardian Capital | 2026-07-28 | 12:30 | |

3. That's it. The next morning's edition (7 AM) shows it automatically — or ask the
   dev to trigger a build to show it immediately.

## Option B — JSON file (developer fallback)

If no sheet URL is configured, the grid reads `library-videos.json` in this folder
(an array of the same fields). Edit, commit, next build picks it up. `[]` = no videos.

## Fields

| Field | Required | Notes |
|---|---|---|
| `title` | ✅ | The headline shown on the card. |
| `url` | ✅ | The video link — unlisted YouTube or Vimeo. |
| `blurb` | — | 1–2 line description under the title. |
| `source` | — | Label above the title. Defaults to **Guardian Capital**. |
| `date` | — | `YYYY-MM-DD`. Newest shows first; up to 6 videos display. |
| `duration` | — | Display string like `12:30`. |
| `thumb` | — | Thumbnail URL. **YouTube auto-generates** from the link, so only needed for **Vimeo / vertical videos** (right-click the video's thumbnail → Copy image address). |

## How different video sizes are handled

You don't need to do anything. Each card is a fixed 16:9 tile and the thumbnail is
centre-cropped to fill it, so vertical, square and landscape videos all sit neatly in
the same grid. For a vertical video where the auto-crop cuts something important, add
a custom `thumb` (a landscape-friendly image) in that row.
