"""Offline tests for the Streamlit-to-FastAPI HTTP boundary."""
import unittest
from unittest.mock import patch

import requests

from ui_backend_client import BackendError, MAX_UPLOAD_BYTES, analyze_with_backend


class FakeResponse:
    def __init__(self, status_code, payload):
        self.status_code = status_code
        self.payload = payload

    def json(self):
        return self.payload


GOOD_ANALYSIS = {
    "scene": "City street",
    "description": "A busy city avenue",
    "scores": {
        "grandeur": 0.9,
        "energy": 0.8,
        "brightness": 0.7,
        "density": 0.6,
        "warmth": 0.5,
    },
    "explanations": {
        "grandeur": "Large buildings",
        "energy": "Traffic",
        "brightness": "Daylight",
        "density": "Many objects",
        "warmth": "Mixed colours",
    },
}


class UIBackendClientTests(unittest.TestCase):
    @patch("ui_backend_client.requests.post")
    def test_success_sends_file_field_and_returns_analysis(self, post):
        post.return_value = FakeResponse(200, GOOD_ANALYSIS)
        result = analyze_with_backend(b"image-bytes", "photo.jpg")
        self.assertEqual(result, GOOD_ANALYSIS)
        self.assertEqual(post.call_args.kwargs["files"]["file"][0], "photo.jpg")
        self.assertTrue(post.call_args.args[0].endswith("/api/analyze"))

    @patch("ui_backend_client.requests.post")
    def test_backend_error_is_explained(self, post):
        post.return_value = FakeResponse(503, {"detail": "Vision provider is unavailable."})
        with self.assertRaisesRegex(BackendError, "HTTP 503"):
            analyze_with_backend(b"image-bytes", "photo.png")

    @patch("ui_backend_client.requests.post")
    def test_connection_failure_has_startup_guidance(self, post):
        post.side_effect = requests.exceptions.ConnectionError()
        with self.assertRaisesRegex(BackendError, "Start FastAPI"):
            analyze_with_backend(b"image-bytes", "photo.jpg")

    @patch("ui_backend_client.requests.post")
    def test_invalid_score_is_rejected(self, post):
        data = {**GOOD_ANALYSIS, "scores": {**GOOD_ANALYSIS["scores"], "energy": 1.5}}
        post.return_value = FakeResponse(200, data)
        with self.assertRaisesRegex(BackendError, "energy"):
            analyze_with_backend(b"image-bytes", "photo.jpg")

    @patch("ui_backend_client.requests.post")
    def test_oversize_is_rejected_before_network_call(self, post):
        with self.assertRaisesRegex(BackendError, "5 MiB"):
            analyze_with_backend(b"x" * (MAX_UPLOAD_BYTES + 1), "photo.png")
        post.assert_not_called()


if __name__ == "__main__":
    unittest.main()
