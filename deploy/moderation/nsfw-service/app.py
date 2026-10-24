"""NSFW classifier service for the echowire media proxy.

Implements the small HTTP contract that fluxer_media_proxy/src/nsfw.rs calls:

    POST /predict/image   {"base64_data": "<b64>"}                  -> {"nsfw_probability": 0.0..1.0}
    POST /predict/images  {"images": [{"base64_data": "<b64>"}...]} -> {"predictions": [{"nsfw_probability": ...}]}

The media proxy sends JPEG frames (at most three, each at most 1 MiB) and decides
by itself whether a probability crosses FLUXER_MEDIA_PROXY_NSFW_THRESHOLD, so this
service only has to return an honest probability. It never stores or logs image
bytes.

The proxy treats any failure here as "scan unavailable" and rejects the upload,
so this service must stay up and fast. /healthz is for the container check.
"""

from __future__ import annotations

import asyncio
import base64
import binascii
import io
import logging
import os
import threading
from typing import Protocol

from fastapi import FastAPI, HTTPException
from PIL import Image, UnidentifiedImageError
from pydantic import BaseModel, Field

MODEL_ID = os.environ.get("NSFW_MODEL_ID", "hf_hub:Marqo/nsfw-image-detection-384")
MAX_FRAMES = int(os.environ.get("NSFW_MAX_FRAMES", "8"))
MAX_FRAME_BYTES = int(os.environ.get("NSFW_MAX_FRAME_BYTES", str(1024 * 1024)))
MAX_CONCURRENT = int(os.environ.get("NSFW_MAX_CONCURRENT", "2"))
TORCH_THREADS = int(os.environ.get("NSFW_TORCH_THREADS", "0"))

logger = logging.getLogger("nsfw-service")


class Classifier(Protocol):
    name: str

    def predict(self, images: list[Image.Image]) -> list[float]:
        """Return the NSFW probability, 0.0 to 1.0, for each image."""
        ...


def nsfw_index(label_names: list[str]) -> int:
    """Index of the NSFW class in the model's label list, matched by name."""
    for index, label in enumerate(label_names):
        if label.strip().lower() == "nsfw":
            return index
    raise ValueError(f"model has no NSFW label, labels are {label_names!r}")


class TimmClassifier:
    """The Marqo timm model, loaded once and run on CPU."""

    def __init__(self, model_id: str = MODEL_ID) -> None:
        import timm
        import torch

        if TORCH_THREADS > 0:
            torch.set_num_threads(TORCH_THREADS)
        self._torch = torch
        self.name = model_id
        self._model = timm.create_model(model_id, pretrained=True).eval()
        data_config = timm.data.resolve_model_data_config(self._model)
        self._transform = timm.data.create_transform(**data_config, is_training=False)
        self._nsfw = nsfw_index(list(self._model.pretrained_cfg["label_names"]))
        self._lock = threading.Lock()

    def predict(self, images: list[Image.Image]) -> list[float]:
        batch = self._torch.stack([self._transform(image.convert("RGB")) for image in images])
        with self._lock, self._torch.inference_mode():
            probabilities = self._model(batch).softmax(dim=-1)
        return [float(row[self._nsfw]) for row in probabilities]


class Frame(BaseModel):
    base64_data: str = Field(min_length=1)


class BatchRequest(BaseModel):
    images: list[Frame]


def decode_frame(encoded: str) -> Image.Image:
    try:
        raw = base64.b64decode(encoded, validate=True)
    except (binascii.Error, ValueError) as err:
        raise HTTPException(status_code=400, detail="frame is not valid base64") from err
    if not raw:
        raise HTTPException(status_code=400, detail="frame is empty")
    if len(raw) > MAX_FRAME_BYTES:
        raise HTTPException(status_code=413, detail="frame is too large")
    try:
        image = Image.open(io.BytesIO(raw))
        image.load()
    except (UnidentifiedImageError, OSError, Image.DecompressionBombError) as err:
        raise HTTPException(status_code=400, detail="frame is not a readable image") from err
    return image


def create_app(classifier: Classifier) -> FastAPI:
    app = FastAPI(title="echowire nsfw service", docs_url=None, redoc_url=None, openapi_url=None)
    gate = asyncio.Semaphore(MAX_CONCURRENT)
    counters = {"requests": 0, "frames": 0, "errors": 0}

    async def classify(images: list[Image.Image]) -> list[float]:
        async with gate:
            try:
                return await asyncio.to_thread(classifier.predict, images)
            except Exception:
                counters["errors"] += 1
                logger.exception("classification failed")
                raise HTTPException(status_code=500, detail="classification failed") from None

    @app.get("/healthz")
    async def healthz() -> dict[str, object]:
        return {"ok": True, "model": classifier.name, **counters}

    @app.post("/predict/image")
    async def predict_image(frame: Frame) -> dict[str, object]:
        counters["requests"] += 1
        counters["frames"] += 1
        (probability,) = await classify([decode_frame(frame.base64_data)])
        return {"nsfw_probability": probability, "model": classifier.name}

    @app.post("/predict/images")
    async def predict_images(request: BatchRequest) -> dict[str, object]:
        if not request.images:
            raise HTTPException(status_code=400, detail="no images")
        if len(request.images) > MAX_FRAMES:
            raise HTTPException(status_code=413, detail="too many images")
        counters["requests"] += 1
        counters["frames"] += len(request.images)
        probabilities = await classify([decode_frame(frame.base64_data) for frame in request.images])
        return {
            "predictions": [{"nsfw_probability": probability} for probability in probabilities],
            "model": classifier.name,
        }

    return app


def build_default_app() -> FastAPI:
    logging.basicConfig(level=os.environ.get("LOG_LEVEL", "INFO"))
    return create_app(TimmClassifier())
