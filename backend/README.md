# Sonic Postcodes — Visual Intelligence backend

Python image-validation API for KCL First Year Hacks 2026. This backend is independent of the frontend and music engine. Python 3.10+ is required.

## Setup and run

Run these commands from this `backend/` directory:

```powershell
python -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install -r requirements.txt
python -m uvicorn app.main:app --reload --port 8000
```

On macOS/Linux, activate with `source .venv/bin/activate` instead.
Interactive API docs: http://127.0.0.1:8000/docs

```powershell
python -m pytest -v
```

Tests need no API key. All successful analysis outputs in tests are synthetic fixtures.

## API contract

- `GET /api/health` returns `{"status": "ok"}`. This indicates API liveness, not provider readiness.
- `POST /api/analyze` accepts multipart/form-data with the image field named `file`.
- JPEG, PNG and WebP are detected from actual bytes, regardless of filename or MIME type.
- Maximum file size is 5 MB, defined here as 5 × 1024 × 1024 bytes (5 MiB), inclusive.
- Images are limited to 20 million pixels and one frame. Animated images are rejected.
- Pillow verifies structure and fully decodes the image before passing it to the service.

```sh
curl -F "file=@street.jpg" http://127.0.0.1:8000/api/analyze
```

The fixed successful response has `scene` and `description` strings, `scores` with
`grandeur`, `energy`, `brightness`, `density`, `warmth` (finite numbers in [0, 1]),
and `explanations` with the same five keys containing strings.

| Status | Meaning |
| --- | --- |
| 400 | Empty, invalid, or corrupted image |
| 413 | File or decoded pixel limit exceeded |
| 415 | Recognized unsupported format, or animated image |
| 422 | Missing multipart file field or invalid request shape |
| 429 | Temporary OpenAI rate limit; wait before retrying |
| 502 | Provider refusal, incomplete response, or invalid analysis |
| 503 | Vision provider unavailable |
| 504 | Vision provider timeout |

Errors use FastAPI's `detail` field. Unrecognizable bytes return 400; a recognized
image in an unsupported format such as GIF returns 415.

## Vision provider integration

OpenAI is connected through the Responses API with image input and strict structured
output derived from the existing Pydantic schema. Results are validated again locally.
The default model is `gpt-6.1-terra`; set `VISION_MODEL` to another model
supporting both image input and structured outputs if required by your account.

1. Create an API key at https://platform.openai.com/api-keys and ensure your API
   project has access to the selected model and available billing/credits.
2. In this backend directory, copy `.env.example` to `.env` if you do not already
   have a .env file. Open .env in your editor and replace only the API key placeholder.
   Never paste your key into chat, frontend code, screenshots or Git.
3. Install requirements using the setup command above, then restart Uvicorn.
4. At http://127.0.0.1:8000/docs upload an image. A successful live request returns
   200 with the five scores and explanations.

Valid uploads are sent to OpenAI and may incur API charges. The application sends
`store=False`, does not save uploads, and does not log keys, images or provider
response bodies. This flag does not replace OpenAI's API data-retention policies.
Missing/placeholder keys return 503 with configuration guidance. Authentication,
exhausted quota and model-access errors return 503 with distinct fixed messages.
Temporary rate limits return 429; incompatible requests return 502.
Only explicit rate-limit evidence is classified as temporary. Quota/billing evidence
in error code, type or message takes precedence. An unexplained 429 returns 503 with
an unknown-restriction message; it does not tell the user that waiting fixes billing.
Server logs include only error type, status and a safe category, never raw responses.
Timeouts return 504; refusal, incomplete or invalid output returns 502.
There are no fabricated fallback scores. Scores are subjective visual impressions.

The provider uses a 45-second SDK timeout and no automatic retries. SDK timeouts
apply to network operations, not a strict total request deadline.
For confirmed temporary limits, the API returns a numeric `Retry-After` header and
blocks subsequent calls for that key/model until the interval expires. It accepts
provider seconds, HTTP-date and millisecond intervals, or uses 60 seconds if absent.
This cooldown is per process; multiple workers do not share it and already in-flight
requests are not cancelled. Quota/billing errors never trigger automatic retries.
The synchronous service runs in FastAPI's worker thread and closes its client after
each request. Tests use dependency overrides or an offline HTTP mock transport;
they make no live OpenAI requests and require no real credentials.

Official references: [vision inputs](https://developers.openai.com/api/docs/guides/images-vision),
[structured outputs](https://developers.openai.com/api/docs/guides/structured-outputs),
and [model capabilities](https://developers.openai.com/api/docs/models/gpt-6.1-terra).

## Configuration and deployment

`.env.example` contains placeholders only. The app loads this backend's `.env`
on startup; shell/deployment variables take precedence. Restart after changing .env.
The previous `OPENAI_VISION_MODEL` setting remains a fallback; `VISION_MODEL` takes
precedence when nonempty. Credentials are read only on the server.

If an upload reports exhausted quota, check the OpenAI API project's billing/credits
and spending limits. Restarting Uvicorn or replacing image files will not add quota.
Successful model-metadata access alone does not prove generation quota is available.

## Safe live diagnosis

Run one deliberate live request (may incur API charges) from the backend directory:

```powershell
python -m app.diagnose_vision --image "C:\path\to\city.png"
```

This reports HTTP status, error code/type, sanitised message and parsed retry interval
when a provider exception is available. It never prints request headers or image
data. API keys and common account identifiers are redacted. A successful call cannot
identify the cause of a historical 429 whose original error body was not retained.
An insufficient-quota error alone may not distinguish prepaid credit exhaustion
from other account limits; check billing and limits in the OpenAI API dashboard.

`GET /api/health` retains its existing JSON and adds `X-Backend-Revision`, a hash of
the loaded backend source files. Compare it with the diagnostic command's revision
to detect a stale running server. Restart Uvicorn after .env changes.

Reference: [OpenAI error codes](https://developers.openai.com/api/docs/guides/error-codes)
and [rate limits](https://developers.openai.com/api/docs/guides/rate-limits).

`APP_ENV` defaults to `development`, permitting only http://localhost:5173 and
http://127.0.0.1:5173. Set `APP_ENV=production` to disable cross-origin access.
No wildcard origins or credentials are enabled.

Application reads are bounded to the file limit plus one byte. FastAPI parses multipart
uploads into spooled temporary files before the endpoint runs. For public deployment,
also enforce a total request-body limit at your proxy (allowing multipart overhead),
request timeouts and concurrency limits to bound incoming traffic and temporary disk use.
No database, frontend code, or music generation is included.
