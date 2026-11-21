# Sonic Postcodes — Offline Photo to Music

**No vision API, API key, FastAPI server, or cloud inference is required by default.** The browser extracts visual features from an uploaded photograph and sends five approximate scores to the existing Tone.js soundtrack engine.

## Run the no-key version (Windows PowerShell)

Open a terminal in the repository root:

```powershell
cd frontend
npm ci
npm run dev
```

Open the Vite **Local** address (normally http://127.0.0.1:5173/), upload a JPG, PNG or WebP, click **Analyze photograph**, then **Play composition**. Select **Offline · on-device (no API key)** (selected automatically). Only the frontend terminal is required.

**Important limitations:** brightness, colour warmth, texture density, visual busyness (energy proxy), and vertical-edge scale (grandeur proxy) are measured from pixels. This is **not semantic AI vision**. It cannot reliably recognise landmarks, buildings, crowds, motion, geography, or weather. It should not be represented as doing so. No photo is sent to any server in offline mode. Vite can be built with `npm run build`, and static assets can be hosted without a backend after build; downloading the app and packages initially requires internet.

## Optional original AI-powered mode

Choose **OpenAI vision API (optional, requires FastAPI)** in the dropdown. Start the existing Python backend separately using `backend/README.md` and configure `backend/.env` with your own key. This retains the original AI-generated scene summaries if needed, but is not necessary for music playback.

## Architecture

- `frontend/src/analysis/local.ts`: Canvas-based on-device feature measurements; returns the existing `VisualAnalysis` schema.
- `frontend/src/main.ts`: photo upload, mode dropdown, local/remote analysis, score explanations, and player controls.
- `frontend/src/audio/compose.ts` and `engine.ts`: unchanged deterministic soundtrack and Tone.js playback.
- `backend/`: optional, untouched Python vision API.

## Verify

```powershell
cd frontend
npm ci
npm run build
npm run dev
```

Try a bright and a dim photo: the brightness score should differ. Play, Stop and Replay should work. Try analysis with the backend stopped: **Offline** mode should still work. The local heuristic metrics are subjective musical controls rather than calibrated physical measurements.

---

# Sonic Postcodes — Photo to Music

Upload a city or street image, receive five grounded visual scores from a Python FastAPI vision service, and hear a 20–30 second composition generated locally in the browser with Tone.js.

## Description 

The application relies on the user uploading an image of an environment (eg. coast, countryside , city...). After the user uploads this, the image is studied and analysed from which a soundtrack is created to represent the environment almost as if the person receiving the postcard was there themselves. 

## Run locally (Windows PowerShell)

Open **two terminals** at the repository root.

**Terminal 1 — Python vision service**

```powershell
cd backend
python -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install -r requirements.txt
Copy-Item .env.example .env
# Edit backend/.env and replace OPENAI_API_KEY with your real key.
python -m uvicorn app.main:app --reload --port 8000
```

**Terminal 2 — browser frontend**

```powershell
cd frontend
npm ci
npm run dev
```

Open http://127.0.0.1:5173. Choose JPG/PNG/WebP (max 5 MiB), Analyze, then press Play. If you instead open the Vite page at localhost:5173, the Vite API proxy still works.

The frontend calls relative `/api/analyze`; Vite proxies that to FastAPI on port 8000. API credentials stay only in `backend/.env`. Do **not** add them to frontend files or commit them.

## Tests

```powershell
cd backend
python -m pytest -v
```

```powershell
cd frontend
npm run build
```

Backend unit tests use synthetic images/mocked providers and do not need API credits. A real photo analysis needs a valid OpenAI API key, model access, and billing. The API never fabricates scores on provider failure. The music engine does not make external AI calls.

## Architecture

1. `frontend/src/main.ts`: image picker, client validation, API request, results, accessible errors, music controls.
2. `backend/app/main.py`: `POST /api/analyze`, validates uploaded image before analysis.
3. `backend/app/vision.py`: calls the image-capable provider, returns structured `VisualAnalysis`.
4. `frontend/src/types/analysis.ts`: shared contract of scene, description, and five 0–1 scores + explanations.
5. `frontend/src/audio/compose.ts`: deterministic scene-to-music mapping (grandeur, energy, brightness, density, warmth).
6. `frontend/src/audio/engine.ts`: Tone.js playback, Stop, Replay, automatic completion.

The existing root-level `ui.py` remains an optional separate Streamlit experiment; the intended integrated browser app is in `frontend/`.

## Troubleshooting

- **Network or 502 proxy error**: start FastAPI on port 8000 and visit http://127.0.0.1:8000/api/health.
- **503 / missing API key**: set `OPENAI_API_KEY` in `backend/.env` then restart FastAPI.
- **429 / quota issues**: read the backend error, check the API project quota or rate limit, do not expose credentials.
- **No sound**: click Play explicitly and confirm the browser tab/system audio is not muted.
- **Image rejected**: use JPEG, PNG or WebP no larger than 5 MiB; the server also validates actual file content.

For provider implementation, diagnostics and limits, see [backend/README.md](backend/README.md).
