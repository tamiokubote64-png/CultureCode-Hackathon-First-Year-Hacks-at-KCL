"""Run one opt-in live request and print only sanitised provider diagnostics."""

import argparse
import json
import os
from pathlib import Path

from fastapi import HTTPException
from openai import APIError

from .main import BACKEND_REVISION, MAX_FILE_BYTES, validate_image
from .provider_errors import classify_provider_error, provider_error_details
from .vision import (
    VisionInvalidResponse, VisionProviderTimeout, VisionProviderUnavailable,
    get_vision_service,
)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--image", required=True, type=Path)
    args = parser.parse_args()
    service = get_vision_service()
    print(json.dumps({
        "backend_revision": BACKEND_REVISION,
        "env_file_exists": (Path(__file__).resolve().parents[1] / ".env").is_file(),
        "api_key_available": bool(os.getenv("OPENAI_API_KEY", "").strip()),
        "model": getattr(service, "model", None),
    }))
    try:
        with args.image.open("rb") as image:
            data = image.read(MAX_FILE_BYTES + 1)
    except OSError:
        print("Cannot read the requested image file.")
        return 1
    if not data or len(data) > MAX_FILE_BYTES:
        print("Image must be nonempty and at most 5 MiB.")
        return 1
    try:
        image_format = validate_image(data)
        analysis = service.analyze(data, image_format)
    except HTTPException as exc:
        print(json.dumps({"image_status": exc.status_code, "detail": exc.detail}))
        return 1
    except (VisionProviderUnavailable, VisionProviderTimeout, VisionInvalidResponse) as failure:
        underlying = failure.__cause__
        if isinstance(underlying, APIError):
            details = provider_error_details(underlying, os.getenv("OPENAI_API_KEY", ""))
            details["category"] = classify_provider_error(details)
            print(json.dumps(details))
        else:
            print(json.dumps({"category": getattr(failure, "reason", "invalid_or_incomplete_response"),
                              "detail": str(failure)}))
        return 1
    print(json.dumps({"status": "success", "scores": analysis.scores.model_dump(),
                      "all_explanations_present": all(analysis.explanations.model_dump().values())}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
