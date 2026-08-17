# AcePoint

An English-language tennis progress tracker with personal accounts, match scoring, emoji-based satisfaction ratings, post-match reflection, monthly trends, a match calendar, SMART goals, training plans, and movement analysis.

## Run locally

```bash
python3 server.py
```

Open `http://127.0.0.1:4173`. New users should choose **Create account**, then sign in with their own email and password.

## Connect JSONBin

The website can sync accounts, matches, goals, training plans, and movement-analysis reports to a private JSONBin while retaining a SQLite backup in `data/tennis.db`. If JSONBin is temporarily unavailable, the local server can read the backup and retry syncing when data changes.

1. Create a private JSONBin and initialise it with `{}`.
2. Create an Access Key limited to `Bins Read` and `Bins Update`.
3. Copy `.env.example` to `.env`, then enter `JSONBIN_BIN_ID` and `JSONBIN_ACCESS_KEY`.
4. Restart `server.py`. After signing in, the storage indicator should show **JSONBin synced**.

The key is read only by the backend and is never included in browser code or API responses. Do not commit or share `.env`.

Movement Analysis runs in the browser with MediaPipe Tasks Vision and WebAssembly. A Web Worker performs pose inference away from the interface thread while the page samples decoded video frames, follows the selected player, and reviews multiple distinct movement windows. Each finding is attached to its own timestamp, replay range, annotated evidence frame, and confidence. It does **not** detect the ball or infer contact.

Reports sync with the account record. Original videos are stored in IndexedDB on the device that performed the analysis, because JSONBin is not suitable for large video binaries. Opening the same report on another device shows its saved findings and evidence frames, but not the original source video.

## Netlify deployment

Netlify publishes the frontend through `netlify.toml` and provides `/api/accounts` and `/api/storage-status` through Netlify Functions. Add these variables in **Project configuration → Environment variables**:

- `JSONBIN_BIN_ID`
- `JSONBIN_ACCESS_KEY` (recommended) or `JSONBIN_MASTER_KEY`

Redeploy after saving the variables. Accounts, matches, goals, calendar entries, training plans, and analysis reports will sync directly to JSONBin. Video analysis needs no Python deployment or proxy: Netlify serves `client-analyzer.js` and `pose-worker.js`, and the pose model runs on the user’s device.
