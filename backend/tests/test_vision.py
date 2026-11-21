"""Exercise the real OpenAI SDK through an offline HTTP transport."""

import base64
import json

import httpx
import pytest
from fastapi.testclient import TestClient
from openai import OpenAI

from app.main import create_app
from app.models import VisualAnalysis
from app.vision import DEFAULT_MODEL, get_vision_service, OpenAIVisionService, UnavailableVisionService
from test_api import FIXTURE_ANALYSIS, make_image, upload
from app import vision


@pytest.fixture(autouse=True)
def clear_cooldowns():
    vision._cooldowns.clear()
    yield
    vision._cooldowns.clear()


def provider_response(text=None, status="completed", refusal=False):
    content = (
        {"type": "refusal", "refusal": "Declined"}
        if refusal else
        {"type": "output_text", "text": text if text is not None else json.dumps(FIXTURE_ANALYSIS),
         "annotations": []}
    )
    return {
        "id": "resp_test", "object": "response", "created_at": 0,
        "status": status, "model": DEFAULT_MODEL,
        "output": [{"id": "msg_test", "type": "message", "role": "assistant",
                    "status": "completed", "content": [content]}],
    }


@pytest.fixture
def connect_provider(monkeypatch):
    """All provider calls use MockTransport, even if a local .env has a key."""
    monkeypatch.setenv("OPENAI_API_KEY", "test-only-key")
    monkeypatch.setenv("VISION_MODEL", DEFAULT_MODEL)
    captured = []

    def connect(payload=None, status_code=200, error=None, headers=None):
        def handler(request):
            captured.append(request)
            if error:
                raise error("Synthetic connection failure", request=request)
            return httpx.Response(status_code, json=payload, headers=headers, request=request)

        def client_factory(**kwargs):
            assert kwargs["timeout"] == 45.0
            assert kwargs["max_retries"] == 0
            return OpenAI(**kwargs, http_client=httpx.Client(
                transport=httpx.MockTransport(handler),
            ))

        monkeypatch.setattr("app.vision.OpenAI", client_factory)
        return captured

    return connect


@pytest.mark.parametrize("image_format,mime", [
    ("JPEG", "image/jpeg"), ("PNG", "image/png"), ("WEBP", "image/webp"),
])
def test_real_sdk_request_and_validated_response(connect_provider, image_format, mime):
    captured = connect_provider(provider_response())
    data = make_image(image_format)
    with TestClient(create_app()) as client:
        result = upload(client, data)
    assert result.status_code == 200
    assert result.json() == FIXTURE_ANALYSIS
    assert len(captured) == 1
    request = captured[0]
    assert str(request.url) == "https://api.openai.com/v1/responses"
    assert request.headers["authorization"] == "Bearer test-only-key"
    body = json.loads(request.content)
    assert body["store"] is False
    assert body["model"] == DEFAULT_MODEL
    assert body["text"]["format"]["strict"] is True
    assert body["text"]["format"]["schema"] == VisualAnalysis.model_json_schema()
    image_url = body["input"][0]["content"][1]["image_url"]
    prefix, encoded = image_url.split(",", 1)
    assert prefix == f"data:{mime};base64"
    assert base64.b64decode(encoded) == data


@pytest.mark.parametrize("status_code,expected_status,expected_detail", [
    (400, 502, "OpenAI rejected the analysis request. Check model compatibility and server configuration."),
    (401, 503, "OpenAI rejected the API credentials. Check OPENAI_API_KEY."),
    (403, 503, "OpenAI model access failed. Check VISION_MODEL and project permissions."),
    (404, 503, "OpenAI model access failed. Check VISION_MODEL and project permissions."),
    (429, 503, "OpenAI rejected the request with an unclassified quota or rate restriction. Check API usage, billing and limits; automatic retry is disabled."),
    (500, 503, "Vision provider is unavailable."),
    (503, 503, "Vision provider is unavailable."),
])
def test_provider_http_errors_are_sanitized(connect_provider, status_code, expected_status, expected_detail):
    captured = connect_provider({"error": {"message": "SECRET upstream detail",
                                         "type": "api_error"}}, status_code)
    with TestClient(create_app()) as client:
        response = upload(client, make_image())
    assert response.status_code == expected_status
    assert response.json() == {"detail": expected_detail}
    assert len(captured) == 1


@pytest.mark.parametrize("error,status_code", [
    (httpx.ReadTimeout, 504), (httpx.ConnectError, 503),
])
def test_transport_failures(connect_provider, error, status_code):
    connect_provider(error=error)
    with TestClient(create_app()) as client:
        response = upload(client, make_image())
    assert response.status_code == status_code
    assert "Synthetic" not in response.text


@pytest.mark.parametrize("payload", [
    provider_response(text="not json"),
    provider_response(text="{}"),
    provider_response(text=json.dumps({**FIXTURE_ANALYSIS, "scores": {
        **FIXTURE_ANALYSIS["scores"], "warmth": 2,
    }})),
    provider_response(status="incomplete"),
    provider_response(refusal=True),
    {**provider_response(), "output": []},
    {**provider_response(), "output": None},
    {**provider_response(), "output": [{"type": "message", "content": None}]},
])
def test_invalid_provider_output_never_becomes_analysis(connect_provider, payload):
    connect_provider(payload)
    with TestClient(create_app()) as client:
        response = upload(client, make_image())
    assert response.status_code == 502
    assert response.json() == {"detail": "Vision provider did not return a valid analysis."}


@pytest.mark.parametrize("key", ["", "   ", "your-openai-api-key"])
def test_missing_or_placeholder_key(monkeypatch, key):
    monkeypatch.setenv("OPENAI_API_KEY", key)
    assert isinstance(get_vision_service(), UnavailableVisionService)


def test_model_configuration(monkeypatch):
    monkeypatch.setenv("OPENAI_API_KEY", "test-only-key")
    monkeypatch.setenv("VISION_MODEL", "custom-vision-model")
    monkeypatch.setenv("OPENAI_VISION_MODEL", "legacy-model")
    service = get_vision_service()
    assert isinstance(service, OpenAIVisionService)
    assert service.model == "custom-vision-model"


def test_invalid_upload_never_reaches_openai(connect_provider):
    captured = connect_provider(provider_response())
    with TestClient(create_app()) as client:
        assert upload(client, b"not an image").status_code == 400
    assert captured == []

@pytest.mark.parametrize("code", ["insufficient_quota"])
def test_quota_failure_is_actionable_and_sanitized(connect_provider, code, caplog):
    connect_provider({"error": {
        "code": code, "message": "SECRET provider body", "type": "quota_error",
    }}, 429)
    with TestClient(create_app()) as client:
        response = upload(client, make_image())
    assert response.status_code == 503
    assert response.json() == {
        "detail": "OpenAI API quota is exhausted. Check the API project's billing and credits."
    }
    assert "quota_exhausted" in caplog.text
    assert "SECRET" not in caplog.text
    assert "test-only-key" not in caplog.text


def test_legacy_model_configuration(monkeypatch):
    monkeypatch.setenv("OPENAI_API_KEY", "test-only-key")
    monkeypatch.delenv("VISION_MODEL", raising=False)
    monkeypatch.setenv("OPENAI_VISION_MODEL", "legacy-model")
    assert get_vision_service().model == "legacy-model"


def test_default_model_configuration(monkeypatch):
    monkeypatch.setenv("OPENAI_API_KEY", "test-only-key")
    monkeypatch.setenv("VISION_MODEL", " ")
    monkeypatch.delenv("OPENAI_VISION_MODEL", raising=False)
    assert get_vision_service().model == DEFAULT_MODEL

@pytest.mark.parametrize("headers,delay", [
    ({"Retry-After": "12"}, 12),
    ({"retry-after-ms": "1500"}, 2),
    ({"Retry-After": "2", "retry-after-ms": "3500"}, 4),
    ({}, 60),
])
def test_temporary_limit_honours_interval_without_retry(connect_provider, headers, delay):
    captured = connect_provider({"error": {
        "code": "rate_limit_exceeded", "type": "tokens", "message": "Rate limit reached."
    }}, 429, headers=headers)
    with TestClient(create_app()) as client:
        first = upload(client, make_image())
        second = upload(client, make_image())
    assert first.status_code == second.status_code == 429
    assert int(first.headers["Retry-After"]) == delay
    assert 1 <= int(second.headers["Retry-After"]) <= delay
    assert len(captured) == 1


def test_cooldown_expiry(connect_provider, monkeypatch):
    clock = [100.0]
    monkeypatch.setattr(vision.time, "monotonic", lambda: clock[0])
    captured = connect_provider({"error": {"code": "rate_limit_exceeded"}}, 429,
                                headers={"Retry-After": "5"})
    with TestClient(create_app()) as client:
        assert upload(client, make_image()).status_code == 429
        clock[0] = 106.0
        assert upload(client, make_image()).status_code == 429
    assert len(captured) == 2


@pytest.mark.parametrize("body,expected_reason", [
    ({"type": "insufficient_quota", "message": "Quota unavailable"}, "quota_exhausted"),
    ({"code": "billing_hard_limit_reached"}, "spending_limit"),
    ({"type": "project_spend_limit_exceeded"}, "spending_limit"),
    ({"code": "insufficient_credits"}, "credits_exhausted"),
    ({"message": "You have run out of credits."}, "credits_exhausted"),
    ({"message": "You exceeded your current quota, please check your plan and billing details."}, "quota_exhausted"),
    ({"code": "rate_limit_exceeded", "message": "Organisation spending limit reached."}, "spending_limit"),
])
def test_billing_never_retries_or_advises_wait(connect_provider, body, expected_reason):
    captured = connect_provider({"error": body}, 429, headers={"Retry-After": "10"})
    with TestClient(create_app()) as client:
        response = upload(client, make_image())
    assert response.status_code == 503
    assert response.json()["detail"] == vision.VisionProviderUnavailable.ERRORS[expected_reason][1]
    assert "Retry-After" not in response.headers
    assert len(captured) == 1
    assert not vision._cooldowns


def test_safe_diagnostics():
    from app.provider_errors import provider_error_details
    from openai import RateLimitError

    secret = "sk-example-secret"
    request = httpx.Request("POST", "https://api.openai.com/v1/responses")
    response = httpx.Response(429, request=request, headers={"Retry-After": "7"})
    error = RateLimitError("hidden", response=response, body={"error": {
        "code": "insufficient_quota", "type": "quota_error",
        "message": f"Key {secret} Bearer hidden-token data:image/png;base64,ABCDEFG org-example"
    }})
    details = provider_error_details(error, secret)
    assert details["status"] == 429
    assert details["code"] == "insufficient_quota"
    assert details["type"] == "quota_error"
    assert details["retry_after"] == 7
    assert all(value not in details["message"] for value in [
        secret, "hidden-token", "ABCDEFG", "org-example",
    ])


@pytest.mark.parametrize("value", ["bad", "-2", "inf", "nan"])
def test_invalid_retry_header(value):
    from app.provider_errors import retry_interval
    assert retry_interval({"retry-after": value}) is None


def test_retry_http_date():
    from datetime import datetime, timedelta, timezone
    from email.utils import format_datetime
    from app.provider_errors import retry_interval
    value = format_datetime(datetime.now(timezone.utc) + timedelta(seconds=120), usegmt=True)
    assert 119 <= retry_interval({"retry-after": value}) <= 120


def test_running_revision_header():
    from app.main import BACKEND_REVISION
    with TestClient(create_app()) as client:
        response = client.get("/api/health")
    assert response.json() == {"status": "ok"}
    assert response.headers["X-Backend-Revision"] == BACKEND_REVISION
