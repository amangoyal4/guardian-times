# Live Library + "new video" notification — spec for the app team

The newspaper's Library section refreshes its videos **live** from a Google Sheet in
the browser (no server, no rebuild). When it detects a video that was added since the
last daily build, it **emits a message** the host app can turn into a push/in-app
notification. The newspaper cannot show a native notification itself — that part is
the app's job. This document is everything you need to wire it up.

## What the page emits

The page only ever emits for a **published** video — a row whose "Publish" box is
ticked in the sheet. Draft/half-filled rows are invisible to the page and never fire,
so you'll never receive a notification for an unfinished video.

As soon as a newly-published Library video is detected (once per device, deduped via
`localStorage`), the page fires the **same payload** on four channels — listen on
whichever matches your wrapper:

```json
{
  "type": "new_library_video",
  "title": "Women usually live longer than men…",
  "platform": "YouTube",
  "url": "https://www.youtube.com/shorts/w8qeKOJAdos",
  "thumbnail": "https://i.ytimg.com/vi/w8qeKOJAdos/maxresdefault.jpg"
}
```

| Wrapper | How to receive |
|---|---|
| **React Native WebView** | `onMessage={e => JSON.parse(e.nativeEvent.data)}` — page calls `window.ReactNativeWebView.postMessage(json)` |
| **iOS WKWebView** | Add a script-message handler named **`guardian`**: `userContentController.add(self, name: "guardian")`; the page calls `window.webkit.messageHandlers.guardian.postMessage(obj)` |
| **Android (WebView + JS interface)** | `webView.addJavascriptInterface(obj, "GuardianApp")` exposing `onNewVideo(String json)` — the page calls `window.GuardianApp.onNewVideo(json)` |
| **Plain web / PWA** | `document.addEventListener('guardian:new-video', e => e.detail)` |

## What the app does with it

1. Receive the payload on your channel.
2. Fire a **local notification** (title = "New from Guardian Capital", body = `title`,
   optional image = `thumbnail`).
3. On tap, open the Library (or deep-link to `url`).

For a **server-driven push** (reaches users who don't have the app open), the app
backend would instead poll or subscribe to the sheet and send via FCM/APNs — the page
hook only covers users currently viewing the paper. Either is fine; the page emit is
the zero-backend option.

## Dedup

The page already prevents repeats **per device** (`localStorage` key `gcb_lib_seen`).
If you want cross-device dedup (so a user isn't notified on phone *and* tablet), track
delivered `url`s on your backend as well.

## Nothing to change on the newspaper side

The emit is live now and inert until you implement a receiver — so you can build and
test the app side independently, with no coordination needed.
