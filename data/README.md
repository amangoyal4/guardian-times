# Library videos — your own IP videos

The Library section's video grid is driven entirely by **`library-videos.json`** in
this folder. No YouTube auto-fetching, no AI — you control exactly what shows.

## How to add a video ("the backend")

1. Upload the video somewhere that gives a shareable link — **unlisted YouTube** or
   **Vimeo** are easiest (free hosting, reliable playback). The video does **not** need
   to be public; unlisted is fine.
2. Add an entry to the array in `library-videos.json`:

```json
{
  "title": "Guardian Capital — Q1 FY26 Market Outlook",
  "blurb": "One or two sentences on what the viewer will learn.",
  "url": "https://www.youtube.com/watch?v=XXXXXXXXXXX",
  "source": "Guardian Capital",
  "date": "2026-07-10",
  "duration": "12:30"
}
```

3. Commit the file. The **next morning's build** (7 AM) picks it up automatically —
   or ask Claude to trigger a build to show it immediately.

## Fields

| Field | Required | Notes |
|---|---|---|
| `title` | ✅ | Shown as the headline. |
| `url` | ✅ | The video link — unlisted YouTube or Vimeo. |
| `blurb` | — | 1–2 line description under the title. |
| `source` | — | Label shown above the title. Defaults to **Guardian Capital**. |
| `date` | — | `YYYY-MM-DD`. Newest videos show first; up to 6 are shown. |
| `duration` | — | Display string like `12:30`. |
| `thumb` | — | Thumbnail URL. **YouTube thumbnails auto-generate** from the link, so you only need this for **Vimeo** or other hosts (right-click the video's thumbnail → copy image address). |

The two entries currently in the file are **examples** — replace them with your real
videos. If the file is empty (`[]`), the video grid simply shows nothing (the podcast
still appears).
