"""HTTP API and bounded image validation for Sonic Postcodes."""

import os
import hashlib
from io import BytesIO
from pathlib import Path
from typing import Annotated

from fastapi import Depends, FastAPI, File, HTTPException, Response, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from dotenv import load_dotenv
from PIL import Image, UnidentifiedImageError

from .models import VisualAnalysis
from .vision import (
    VisionInvalidResponse, VisionProviderTimeout, VisionProviderUnavailable,
    VisionService, get_vision_service,
)

# Only load this backend's .env; existing shell variables take precedence.
load_dotenv(Path(__file__).resolve().parents[1] / ".env", override=False)

MAX_FILE_BYTES = 5 * 1024 * 1024
MAX_IMAGE_PIXELS = 20_000_000
SUPPORTED_FORMATS = frozenset({"JPEG", "PNG", "WEBP"})
BACKEND_REVISION = hashlib.sha256(b"".join(
    path.read_bytes() for path in sorted(Path(__file__).parent.glob("*.py"))
)).hexdigest()[:16]


def validate_image(image_bytes: bytes) -> str:
    """Verify structure and fully decode a single-frame image before analysis."""
    try:
        with Image.open(BytesIO(image_bytes)) as image:
            image_format = image.format
            if image_format not in SUPPORTED_FORMATS:
                raise HTTPException(415, "Supported image formats are JPEG, PNG, and WebP.")
            if image.width * image.height > MAX_IMAGE_PIXELS:
                raise HTTPException(413, "Image exceeds the 20 megapixel limit.")
            if getattr(image, "n_frames", 1) != 1:
                raise HTTPException(415, "Animated images are not supported.")
            image.verify()

        # verify() invalidates the original image; reopen to detect decode errors.
        with Image.open(BytesIO(image_bytes)) as image:
            image.load()
        return image_format
    except Image.DecompressionBombError as exc:
        raise HTTPException(413, "Image exceeds the safe pixel limit.") from exc
    except (UnidentifiedImageError, OSError, SyntaxError, ValueError) as exc:
        raise HTTPException(400, "Invalid or corrupted image.") from exc


def create_app() -> FastAPI:
    application = FastAPI(title="Sonic Postcodes Vision API")
    if os.getenv("APP_ENV", "development").lower() == "development":
        application.add_middleware(
            CORSMiddleware,
            allow_origins=["http://localhost:5173", "http://127.0.0.1:5173"],
            allow_methods=["GET", "POST"],
            allow_headers=["Content-Type"],
        )

    @application.get("/api/health")
    def health(response: Response) -> dict[str, str]:
        response.headers["X-Backend-Revision"] = BACKEND_REVISION
        return {"status": "ok"}

    @application.post("/api/analyze", response_model=VisualAnalysis)
    def analyze(
        file: Annotated[UploadFile, File()],
        vision_service: Annotated[VisionService, Depends(get_vision_service)],
    ) -> VisualAnalysis:
        # Sync endpoints run in a worker thread, including Pillow and provider work.
        try:
            image_bytes = file.file.read(MAX_FILE_BYTES + 1)
        finally:
            file.file.close()
        if not image_bytes:
            raise HTTPException(400, "Image file is empty.")
        if len(image_bytes) > MAX_FILE_BYTES:
            raise HTTPException(413, "Image file exceeds the 5 MB limit.")
        image_format = validate_image(image_bytes)
        try:
            return vision_service.analyze(image_bytes, image_format)
        except VisionProviderUnavailable as exc:
            headers = {"Retry-After": str(exc.retry_after)} if exc.retry_after is not None else None
            raise HTTPException(exc.status_code, exc.public_message, headers=headers) from exc
        except VisionProviderTimeout as exc:
            raise HTTPException(504, "Vision provider timed out. Please try again.") from exc
        except VisionInvalidResponse as exc:
            raise HTTPException(502, "Vision provider did not return a valid analysis.") from exc

    return application


app = create_app()
