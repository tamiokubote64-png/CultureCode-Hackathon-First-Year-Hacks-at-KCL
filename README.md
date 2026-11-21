# Sonic Postcodes — Photo to Music

Upload a city or street image, receive five grounded visual scores from a Python FastAPI vision service, and hear a 20–30 second composition generated locally in the browser with Tone.js.

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
