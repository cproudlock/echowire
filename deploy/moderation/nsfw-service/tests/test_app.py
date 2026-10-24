import base64
import io
import os
import sys

import pytest
from fastapi.testclient import TestClient
from PIL import Image

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import app as service  # noqa: E402


def jpeg_b64(color=(120, 90, 60), size=(64, 64)) -> str:
    buffer = io.BytesIO()
    Image.new("RGB", size, color).save(buffer, format="JPEG")
    return base64.b64encode(buffer.getvalue()).decode()


class FakeClassifier:
    name = "fake"

    def __init__(self, value=0.25, fail=False):
        self.value = value
        self.fail = fail
        self.calls = []

    def predict(self, images):
        self.calls.append(len(images))
        if self.fail:
            raise RuntimeError("boom")
        return [self.value] * len(images)


def client(classifier=None) -> TestClient:
    return TestClient(service.create_app(classifier or FakeClassifier()))


def test_nsfw_index_matches_by_name_not_position():
    assert service.nsfw_index(["NSFW", "SFW"]) == 0
    assert service.nsfw_index(["SFW", " nsfw "]) == 1
    with pytest.raises(ValueError):
        service.nsfw_index(["safe", "unsafe"])


def test_single_image_returns_the_probability_key_the_proxy_reads():
    response = client(FakeClassifier(0.9)).post("/predict/image", json={"base64_data": jpeg_b64()})
    assert response.status_code == 200
    assert response.json()["nsfw_probability"] == pytest.approx(0.9)


def test_batch_returns_one_prediction_per_frame_in_order():
    fake = FakeClassifier(0.4)
    body = {"images": [{"base64_data": jpeg_b64()} for _ in range(3)]}
    response = client(fake).post("/predict/images", json=body)
    assert response.status_code == 200
    assert response.json()["predictions"] == [{"nsfw_probability": 0.4}] * 3
    assert fake.calls == [3]


@pytest.mark.parametrize("payload", ["!!!not base64!!!", base64.b64encode(b"plain text").decode()])
def test_bad_frames_are_400(payload):
    response = client().post("/predict/image", json={"base64_data": payload})
    assert response.status_code == 400


def test_empty_batch_and_oversized_batch_are_rejected():
    assert client().post("/predict/images", json={"images": []}).status_code == 400
    too_many = {"images": [{"base64_data": jpeg_b64()} for _ in range(service.MAX_FRAMES + 1)]}
    assert client().post("/predict/images", json=too_many).status_code == 413


def test_oversized_frame_is_413(monkeypatch):
    monkeypatch.setattr(service, "MAX_FRAME_BYTES", 10)
    response = client().post("/predict/image", json={"base64_data": jpeg_b64()})
    assert response.status_code == 413


def test_classifier_failure_is_a_500_not_a_fake_clean_score():
    response = client(FakeClassifier(fail=True)).post("/predict/image", json={"base64_data": jpeg_b64()})
    assert response.status_code == 500
    assert "nsfw_probability" not in response.json()


def test_healthz_reports_counters():
    c = client()
    c.post("/predict/image", json={"base64_data": jpeg_b64()})
    body = c.get("/healthz").json()
    assert body["ok"] is True and body["frames"] == 1 and body["errors"] == 0


@pytest.mark.skipif(os.environ.get("NSFW_REAL_MODEL") != "1", reason="set NSFW_REAL_MODEL=1 to load the real model")
def test_real_model_scores_a_plain_image_as_safe():
    classifier = service.TimmClassifier()
    plain = Image.new("RGB", (400, 300), (200, 220, 240))
    (probability,) = classifier.predict([plain])
    assert 0.0 <= probability <= 1.0
    assert probability < 0.5
