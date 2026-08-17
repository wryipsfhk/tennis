# AcePoint

An English-language tennis progress tracker with personal accounts, match scoring, emoji-based satisfaction ratings, post-match reflection, monthly trends, a match calendar, SMART goals, training plans, and movement analysis.

## Run locally

```bash
python3 -m venv .venv
.venv/bin/pip install -r backend-requirements.txt
.venv/bin/python server.py
```

Open `http://127.0.0.1:4173`. New users should choose **Create account**, then sign in with their own email and password.

## Connect JSONBin

The website can sync accounts, matches, goals, training plans, and movement-analysis reports to a private JSONBin while retaining a SQLite backup in `data/tennis.db`. If JSONBin is temporarily unavailable, the local server can read the backup and retry syncing when data changes.

1. Create a private JSONBin and initialise it with `{}`.
2. Create an Access Key limited to `Bins Read` and `Bins Update`.
3. Copy `.env.example` to `.env`, then enter `JSONBIN_BIN_ID` and `JSONBIN_ACCESS_KEY`.
4. Restart `server.py`. After signing in, the storage indicator should show **JSONBin synced**.

The key is read only by the backend and is never included in browser code or API responses. Do not commit or share `.env`.

Movement Analysis uses MediaPipe and OpenCV on the local Python server. Analyzer v7 aggregates player detections across several frames, follows the selected player, and reviews multiple distinct body-motion windows. Each finding contains its own evidence frame, timestamp, replay range, joint-visibility checks, and confidence. It does **not** detect the ball or infer contact.

Large source videos and analysis frames remain in the local `data/` directory. JSONBin stores their report metadata, names, and paths—not the video binary files.

## Netlify deployment

Netlify publishes the frontend through `netlify.toml` and provides `/api/accounts` and `/api/storage-status` through Netlify Functions. Add these variables in **Project configuration → Environment variables**:

- `JSONBIN_BIN_ID`
- `JSONBIN_ACCESS_KEY` (recommended) or `JSONBIN_MASTER_KEY`

Redeploy after saving the variables. Accounts, matches, goals, calendar entries, and training plans will sync directly to JSONBin.

### Video-analysis deployment is separate

Netlify serves the static frontend and JavaScript functions; it cannot run this long-lived OpenCV/MediaPipe Python server. Deploy `server.py`, `analyzer.py`, `backend-requirements.txt`, and the writable `data/uploads` plus `data/analysis` directories to a Python host with persistent storage. Then proxy these three frontend paths to that service:

- `/api/analysis-capabilities`
- `/api/prepare-analysis`
- `/api/analyze-match`

Use `.venv/bin/python server.py` as the start command locally. On a host, set `HOST=0.0.0.0`; the server reads the platform’s `PORT` value. Keep JSONBin keys server-side.

Until that service and proxy exist, the Movement Analysis page intentionally shows **Video analysis backend is offline**. Match records, trends, calendar, goals, training plans, and JSONBin sign-in continue to work on Netlify.
