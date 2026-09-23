"""Image OCR tests (ported behavior from backend/scripts/doc_converter.py)."""

from __future__ import annotations

import json
import os
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from opencode_ext import image as imgmod


def _make_png(path: str, text: str = "Hello OCR 123") -> str:
    from PIL import Image, ImageDraw

    im = Image.new("RGB", (600, 120), "white")
    ImageDraw.Draw(im).text((20, 40), text, fill="black")
    im.save(path)
    return path


def test_resolve_bundled_tesseract() -> None:
    exe = imgmod.resolve_bundled_tesseract()
    assert exe is None or os.path.isfile(exe)


def test_describe_image_no_engine_needed(tmp_path) -> None:
    p = _make_png(str(tmp_path / "d.png"))
    desc = imgmod.describe_image(p)
    assert desc.startswith("[image: PNG 600x120 RGB,")
    assert "B" in desc


def test_read_image_text_and_boxes(tmp_path) -> None:
    p = _make_png(str(tmp_path / "ocr.png"))
    try:
        result = imgmod.read_image(p)
    except RuntimeError as exc:
        pytest.skip(f"no OCR engine in this environment: {exc}")
    assert "Hello" in result["text"] and "123" in result["text"]
    assert isinstance(result["boxes"], list) and len(result["boxes"]) >= 2
    for b in result["boxes"]:
        assert set(b) >= {"text", "left", "top", "width", "height", "conf"}


def test_read_image_text_shape(tmp_path) -> None:
    p = _make_png(str(tmp_path / "shape.png"))
    try:
        out = imgmod.read_image_text(p)
    except RuntimeError as exc:
        pytest.skip(f"no OCR engine in this environment: {exc}")
    assert "Hello" in out
    assert "[OCR boxes JSON]" in out
    payload = json.loads(out.split("[OCR boxes JSON]\n", 1)[1])
    assert payload["boxes"] and payload["text"]


def test_compat_image_branch(tmp_path) -> None:
    from opencode_ext import compat

    p = _make_png(str(tmp_path / "compat.png"))
    try:
        out = compat.read_document_local(p)
    except RuntimeError as exc:
        pytest.skip(f"no OCR engine in this environment: {exc}")
    assert "Hello" in out
