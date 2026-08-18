# AcePoint

AcePoint is an English-language tennis journal for match records, trends, calendar entries, SMART goals, training plans, and on-device movement analysis.

## Private cross-device storage

Movement analysis still runs locally in the browser with MediaPipe Tasks Vision/WebAssembly. Once processing finishes, AcePoint saves the report to the authenticated account and uploads the original video in 4 MB chunks. The browser keeps an IndexedDB copy as a local-first fallback.

Production storage uses two private, site-wide Netlify Blob stores:

- `acepoint-accounts-v2`: one JSON account document per SHA-256 email identifier. Password hashes and session versions are never returned by account APIs.
- `acepoint-private-videos-v1`: owner-scoped manifests and chunks under `<account-id>/<analysis-id>/…`.

`/api/account` and every `/api/videos/*` mutation require a signed Bearer session. The server derives the storage key from that session and confirms the analysis belongs to the account. Playback uses a video-only ticket scoped to one analysis and expiring after 10 minutes. Raw Blob keys are never exposed.

Existing JSONBin accounts are migrated into the private account store on their first successful login. The old collection-wide `/api/accounts` endpoint has been removed.

## Run locally

```bash
npm install
python3 server.py
```

Open `http://127.0.0.1:4173`. Local development uses SQLite for account JSON and `data/private-videos/` for owner-scoped videos while exposing the same authenticated API as production.

## Netlify configuration

Set these environment variables for all production deploys:

- `ACEPOINT_SESSION_SECRET`: a new random value of at least 24 characters. Do not expose it in browser code.
- `JSONBIN_BIN_ID` and `JSONBIN_ACCESS_KEY`: temporarily retained only to migrate existing accounts on first login.

Netlify automatically supplies the site identity needed by `@netlify/blobs` inside Functions. Run `npm run build` for the deploy output.

## Verification

```bash
npm test
npm run build
python3 -m py_compile server.py
```

With the local server on port 4189, `node tests/integration-local.mjs` verifies that a second session for the same account can replay the saved video while another account receives `404` for playback tickets and deletion.
