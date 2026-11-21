"""Small HTTP client connecting the Streamlit UI to the existing FastAPI vision API.

Only the backend makes OpenAI requests; the UI never reads the OpenAI API key.
"""
from __future__ import annotations

import requests

MAX_UPLOAD_BYTES = 5 * 1024 * 1024
SCORE_NAMES = ("grandeur", "energy", "brightness", "density", "warmth")


class BackendError(RuntimeError):
    """An actionable error safe to show to the person using the UI."""


def analyze_with_backend(
    image_data: bytes,
    filename: str,
    api_base_url: str = "http://127.0.0.1:8000",
    timeout: float = 65.0,
) -> dict:
    """POST the original photograph to /api/analyze and validate its five scores."""
    if not image_data:
        raise BackendError("Choose a nonempty photograph first.")
    if len(image_data) > MAX_UPLOAD_BYTES:
        raise BackendError("The backend accepts photographs no larger than 5 MiB.")

    url = api_base_url.rstrip("/") + "/api/analyze"
    try:
        response = requests.post(
            url,
            files={"file": (filename or "photograph.png", image_data, "application/octet-stream")},
            timeout=timeout,
        )
    except requests.exceptions.Timeout as exc:
        raise BackendError("The vision API timed out. Check the backend terminal.") from exc
    except requests.exceptions.ConnectionError as exc:
        raise BackendError(
            "Cannot reach the vision backend. Start FastAPI on port 8000 "
            "(or configure SONIC_API_URL)."
        ) from exc
    except requests.exceptions.RequestException as exc:
        raise BackendError("Could not contact the vision backend.") from exc

    if response.status_code != 200:
        try:
            detail = response.json().get("detail", "Analysis was unsuccessful.")
        except (ValueError, AttributeError):
            detail = "Analysis was unsuccessful."
        if not isinstance(detail, str):
            detail = "Analysis was unsuccessful."
        raise BackendError(f"Vision API returned HTTP {response.status_code}: {detail[:300]}")

    try:
        result = response.json()
    except ValueError as exc:
        raise BackendError("The backend did not return valid JSON.") from exc
    if not isinstance(result, dict):
        raise BackendError("The backend returned an unexpected response.")
    if not isinstance(result.get("scene"), str) or not isinstance(result.get("description"), str):
        raise BackendError("The backend response lacks a scene or description.")

    scores = result.get("scores")
    explanations = result.get("explanations")
    if not isinstance(scores, dict) or not isinstance(explanations, dict):
        raise BackendError("The backend response lacks visual scores or explanations.")
    for name in SCORE_NAMES:
        value = scores.get(name)
        if (not isinstance(value, (int, float)) or isinstance(value, bool)
                or not 0 <= value <= 1):
            raise BackendError(f"The backend returned an invalid {name} score.")
        if not isinstance(explanations.get(name), str):
            raise BackendError(f"The backend response lacks a {name} explanation.")
    return result
