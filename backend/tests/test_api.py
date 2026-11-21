"""All successful analyses here are synthetic fixtures, never live AI output."""

from io import BytesIO
from unittest.mock import Mock

import pytest
from fastapi.testclient import TestClient
from PIL import Image
from pydantic import ValidationError

from app.main import MAX_FILE_BYTES, create_app
from app.models import VisualAnalysis, VisualScores
from app.vision import get_vision_service

SCORE_NAMES = ("grandeur", "energy", "brightness", "density", "warmth")
FIXTURE_ANALYSIS = {
    "scene": "Synthetic test scene",
    "description": "A fixture used only to test the response contract.",
    "scores": dict.fromkeys(SCORE_NAMES, 0.5),
    "explanations": dict.fromkeys(SCORE_NAMES, "Synthetic test explanation."),
}


def make_image(image_format="PNG", size=(16, 16)):
    output = BytesIO()
    with Image.new("RGB", size, (120, 80, 40)) as image:
        image.save(output, format=image_format)
    return output.getvalue()


@pytest.fixture
def api(monkeypatch):
    monkeypatch.setenv("APP_ENV", "development")
    application = create_app()
    service = Mock()
    service.analyze.return_value = VisualAnalysis.model_validate(FIXTURE_ANALYSIS)
    application.dependency_overrides[get_vision_service] = lambda: service
    with TestClient(application) as client:
        yield client, service


def upload(client, data, name="image.png", content_type="image/png"):
    return client.post("/api/analyze", files={"file": (name, data, content_type)})


def test_health(api):
    client, _ = api
    response = client.get("/api/health")
    assert response.status_code == 200
    assert response.json() == {"status": "ok"}


@pytest.mark.parametrize("image_format", ["JPEG", "PNG", "WEBP"])
def test_success_and_exact_contract(api, image_format):
    client, service = api
    data = make_image(image_format)
    # Actual contents determine format, even with misleading client metadata.
    response = upload(client, data, "wrong.txt", "text/plain")
    assert response.status_code == 200
    assert response.json() == FIXTURE_ANALYSIS
    service.analyze.assert_called_once_with(data, image_format)


@pytest.mark.parametrize("image_format", ["GIF", "BMP", "TIFF"])
def test_unsupported_format(api, image_format):
    client, service = api
    assert upload(client, make_image(image_format)).status_code == 415
    service.analyze.assert_not_called()


@pytest.mark.parametrize("data", [b"not an image", make_image()[:40], make_image("JPEG")[:-20]])
def test_corrupted_image(api, data):
    client, service = api
    assert upload(client, data).status_code == 400
    service.analyze.assert_not_called()


def test_empty_image(api):
    client, service = api
    assert upload(client, b"").status_code == 400
    service.analyze.assert_not_called()


def test_missing_image(api):
    client, service = api
    assert client.post("/api/analyze").status_code == 422
    service.analyze.assert_not_called()


def test_file_too_large(api):
    client, service = api
    assert upload(client, b"x" * (MAX_FILE_BYTES + 1)).status_code == 413
    service.analyze.assert_not_called()


def test_exact_file_limit(api):
    client, _ = api
    data = make_image()
    assert upload(client, data + b"\0" * (MAX_FILE_BYTES - len(data))).status_code == 200


def test_pixel_limit(api, monkeypatch):
    client, service = api
    monkeypatch.setattr("app.main.MAX_IMAGE_PIXELS", 100)
    assert upload(client, make_image(size=(11, 10))).status_code == 413
    service.analyze.assert_not_called()


def test_pillow_bomb_guard(api, monkeypatch):
    client, service = api
    data = make_image()
    monkeypatch.setattr(Image, "MAX_IMAGE_PIXELS", 10)
    assert upload(client, data).status_code == 413
    service.analyze.assert_not_called()


def test_animated_image(api):
    client, service = api
    output = BytesIO()
    with Image.new("RGB", (8, 8), "red") as first, Image.new("RGB", (8, 8), "blue") as second:
        first.save(output, format="PNG", save_all=True, append_images=[second])
    assert upload(client, output.getvalue()).status_code == 415
    service.analyze.assert_not_called()


def test_missing_provider(monkeypatch):
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    with TestClient(create_app()) as client:
        response = upload(client, make_image())
    assert response.status_code == 503
    assert response.json() == {
        "detail": "OpenAI API key is not configured. Set OPENAI_API_KEY in backend/.env."
    }


@pytest.mark.parametrize("field", SCORE_NAMES)
@pytest.mark.parametrize("value", [-0.01, 1.01, float("nan"), float("inf")])
def test_scores_reject_invalid_values(field, value):
    scores = dict.fromkeys(SCORE_NAMES, 0.5)
    scores[field] = value
    with pytest.raises(ValidationError):
        VisualScores(**scores)


@pytest.mark.parametrize("value", [0.0, 1.0])
def test_scores_accept_boundaries(value):
    assert VisualScores(**dict.fromkeys(SCORE_NAMES, value)).grandeur == value


@pytest.mark.parametrize("origin", ["http://localhost:5173", "http://127.0.0.1:5173"])
def test_local_cors(api, origin):
    client, _ = api
    response = client.options("/api/analyze", headers={
        "Origin": origin, "Access-Control-Request-Method": "POST",
    })
    assert response.status_code == 200
    assert response.headers["access-control-allow-origin"] == origin


def test_untrusted_cors(api):
    client, _ = api
    response = client.get("/api/health", headers={"Origin": "https://example.com"})
    assert "access-control-allow-origin" not in response.headers


def test_production_cors_disabled(monkeypatch):
    monkeypatch.setenv("APP_ENV", "production")
    with TestClient(create_app()) as client:
        response = client.get("/api/health", headers={"Origin": "http://localhost:5173"})
    assert "access-control-allow-origin" not in response.headers
