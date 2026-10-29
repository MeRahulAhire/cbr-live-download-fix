# CBR Live Download — standalone Chrome extension

Downloads original image-sequence frames during rendering against the existing Cloud Blender Render API. No backend or frontend changes are required. See `../API-AND-WEBSOCKET-ANALYSIS.md` for the full protocol analysis and reliability limits.

## Install and use

1. Open `chrome://extensions`, enable **Developer mode**, click **Load unpacked**, and select this `extension` directory (the directory containing manifest.json).
2. Open your running Cloud Blender Render GPU instance in the same Chrome profile. If protected, use its share link first.
3. Click the extension action. A dedicated download tab opens with the current origin filled in. Correct it if needed; local development API is `http://localhost:4000`.
4. Click **Connect**, grant access to that host, then **Choose folder & start**. Chrome prompts for a folder once; frames go into a new `CBR-...` subfolder.
5. Start rendering from the original app, or attach during an existing render. Newly announced frames save automatically. Keep the download tab open and the computer awake.

Default mode follows live preview completion events. To collect frames that already existed or were missed during a disconnect, enable the optional recovery checkbox. It checks file size and Last-Modified repeatedly, but cannot guarantee a paused writer has finished. For fully authoritative recovery the server needs a completed-frame manifest.

Pause stops starting new transfers; active transfers finish and subsequent live events remain queued. Resume continues. Failed downloads are visible in the activity log and can be retried. A session deduplicates filenames, so use a newly opened download tab for each render job. Reloading or closing the tab clears the queue; it does not delete saved files. Never treat a failed/aborted file's mere existence as a completed download.

## Development

Socket.IO is bundled locally; there are no remotely loaded scripts. The packaged vendor file is included for unpacked installation. To reproduce it:

```powershell
npm ci --ignore-scripts --no-audit --no-fund
npm run build
npm test
```

Only `socket.io-client` 4.8.1 and its dependencies are needed. No application build or Rust toolchain is needed for the extension.

## Scope and troubleshooting

- Images only (including PNG, JPEG, EXR, TIFF and other common Blender image formats); no video splitting, nested compositor paths or in-session replacement of already saved filenames.
- Downloads stream to disk rather than buffering whole images. Two simultaneous transfers and up to three automatic attempts limit pressure on the server.
- A transfer is marked saved only after byte-count/metadata checks and a successful writable close. These are not cryptographic integrity checks.
- HTTP 401/403: open the shared instance URL in this profile, then reconnect. Cookie restrictions or proxy authentication may need adjustment; the extension does not ask for the secret token.
- Connection errors: confirm the URL is the GPU instance, not the project's landing page. Version 0.1.1 connects directly over WebSocket at `/socket.io/`, bypassing the polling/upgrade path that returned HTTP 400 on the reported Runpod instance. The proxy must support WebSocket. If it still fails, inspect the WebSocket handshake in the download tab's DevTools Network panel; a generic browser error alone does not establish an authentication or proxy cause.
- No live frames: the backend only emits `live_base64` when preview generation succeeds. A failed preview worker, unsupported image decoder or missed event requires recovery/manual download.
- Each extension connection adds server-side watcher/telemetry work in the current implementation; avoid opening multiple sessions unnecessarily.
- This initial implementation has automated logic tests but has not been verified against a live GPU deployment in Chrome. Validate with a short test render before customer rollout.

## Acceptance check on your instance

1. Authenticate, connect, choose an empty destination, and render 5–10 PNG frames. Confirm files arrive before the job ends and compare their byte counts/content with direct server downloads.
2. Pause mid-render, confirm active writes finish but queued files wait, then resume.
3. Disconnect and reconnect the network; verify an error is shown and recovery/manual download accounts for missed frames.
4. Try an EXR sequence, a revoked folder permission, interrupted transfer, cancelled render, and a new job reusing frame names in a new session.
5. Confirm browser reload/close behavior is understood: monitoring stops and a new session is required.
