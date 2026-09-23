"""Image reading with word-level OCR boxes (file-based, no Office needed).

Ported from backend/scripts/doc_converter.py so the office-mcp fork keeps
our unique image behavior: Pillow + pytesseract text plus per-word boxes
``{"text": str, "boxes": [{text, left, top, width, height, conf}]}``,
bundled-tesseract-first resolution, kor tessdata priority, and a
Pillow-only describe fallback when no OCR engine exists.
Public helpers return plain Python types; the MCP wrappers in server.py
turn them into {"ok": ...} replies.
"""

from __future__ import annotations

import json
import os
import tempfile
from typing import Any

IMAGE_EXTS = {".png", ".jpg", ".jpeg", ".bmp", ".tiff", ".tif", ".webp"}

_HERE = os.path.dirname(os.path.abspath(__file__))


def resolve_bundled_tesseract() -> str | None:
    """Return bundled bin/tesseract/tesseract.exe when present.

    Checked relative to this file first (vendor/office-mcp/opencode_ext/),
    then the historical checkout locations.
    """
    candidates = [
        os.path.join(_HERE, "..", "..", "..", "bin", "tesseract", "tesseract.exe"),
        os.path.join(_HERE, "..", "..", "..", "release", "bin", "tesseract", "tesseract.exe"),
        os.path.join(os.getcwd(), "bin", "tesseract", "tesseract.exe"),
        os.path.join(os.getcwd(), "release", "bin", "tesseract", "tesseract.exe"),
        os.path.join(tempfile.gettempdir(), "tesseract-ocr", "tesseract.exe"),
    ]
    for p in candidates:
        ap = os.path.abspath(p)
        if os.path.isfile(ap):
            return ap
    return None


def _use_bundled_tessdata() -> None:
    """Point TESSDATA_PREFIX at bundled kor data when available.

    Must be the tessdata directory itself — pointing at its parent makes
    Tesseract fail with "Failed loading language" (measured before).
    """
    candidates = [
        os.path.join(_HERE, "..", "..", "..", "bin", "tesseract", "tessdata"),
        os.path.join(os.getcwd(), "bin", "tesseract", "tessdata"),
    ]
    for p in candidates:
        ap = os.path.abspath(p)
        if os.path.isdir(ap) and os.path.isfile(os.path.join(ap, "kor.traineddata")):
            os.environ["TESSDATA_PREFIX"] = ap
            return


def describe_image(source_path: str) -> str:
    """Pillow-only image summary (works without any OCR engine)."""
    from PIL import Image

    try:
        size_bytes = os.path.getsize(source_path)
    except OSError:
        size_bytes = 0
    if size_bytes >= 1024 * 1024:
        size_str = f"{size_bytes / (1024 * 1024):.1f}MB"
    elif size_bytes >= 1024:
        size_str = f"{size_bytes / 1024:.1f}KB"
    else:
        size_str = f"{size_bytes}B"
    try:
        with Image.open(source_path) as img:
            fmt = img.format or os.path.splitext(source_path)[1].lstrip(".").upper() or "IMAGE"
            w, h = img.size
            mode = img.mode
    except Exception:
        fmt, w, h, mode = (
            os.path.splitext(source_path)[1].lstrip(".").upper() or "IMAGE",
            0,
            0,
            "?",
        )
    dims = f"{w}x{h}" if w and h else "unknown size"
    return f"[image: {fmt} {dims} {mode}, {size_str}]"


def read_image(source_path: str) -> dict[str, Any]:
    """OCR an image file.

    Returns {"text": str, "boxes": [...], "lang": str}.
    Raises RuntimeError with install guidance when no OCR engine exists.
    """
    try:
        from PIL import Image
        import pytesseract
        from pytesseract import Output
    except ImportError as exc:
        raise RuntimeError(
            f"OCR deps missing: {exc}. pip install Pillow pytesseract"
        ) from exc
    bundled = resolve_bundled_tesseract()
    if bundled:
        pytesseract.pytesseract.tesseract_cmd = bundled
    _use_bundled_tessdata()
    try:
        pytesseract.get_tesseract_version()
    except Exception as exc:
        hint = bundled or "PATH"
        raise RuntimeError(
            f"Tesseract OCR engine not found (tried {hint}). "
            "Run `npm run tesseract:install` or install Tesseract "
            "(https://github.com/UB-Mannheim/tesseract/wiki) and ensure "
            "`tesseract` is in PATH. Bundled path: bin/tesseract/tesseract.exe"
        ) from exc
    img = Image.open(source_path)
    if img.mode not in ("RGB", "L"):
        img = img.convert("RGB")
    # kor+eng를 먼저 시도 — kor 데이터가 없으면 eng로 숨기지 않고 명확한 에러로 안내
    lang_used = "eng"
    for lang in ("kor+eng", "eng"):
        try:
            cfg = "--oem 1 --psm 6" if "kor" in lang else "--oem 3 --psm 6"
            data = pytesseract.image_to_data(img, lang=lang, config=cfg, output_type=Output.DICT)
            lang_used = lang
            break
        except Exception as exc:
            msg = str(exc).lower()
            if "kor" in msg or "traineddata" in msg or "failed loading language" in msg:
                raise RuntimeError(
                    "Korean OCR data (kor.traineddata) not found. Run "
                    "`npm run tesseract:install` or install the Tesseract "
                    "kor language pack."
                ) from exc
            if lang == "eng":
                raise RuntimeError(f"OCR failed: {exc}") from exc
            continue
    boxes: list[dict[str, Any]] = []
    texts: list[str] = []
    n = len(data.get("text", []))
    for i in range(n):
        t = (data["text"][i] or "").strip()
        if not t:
            continue
        try:
            conf = float(data["conf"][i])
        except Exception:
            conf = -1
        boxes.append(
            {
                "text": t,
                "left": int(data["left"][i]),
                "top": int(data["top"][i]),
                "width": int(data["width"][i]),
                "height": int(data["height"][i]),
                "conf": conf,
            }
        )
        texts.append(t)
    if texts:
        full_text = " ".join(texts)
    else:
        full_text = pytesseract.image_to_string(img, lang=lang_used, config="--oem 3 --psm 6").strip()
    return {"text": full_text, "boxes": boxes, "lang": lang_used}


def read_image_text(source_path: str) -> str:
    """Old read_document shape for images: text plus boxes JSON.

    Falls back to describe_image() when no OCR engine exists so image
    reads degrade instead of failing outright.
    """
    try:
        result = read_image(source_path)
    except RuntimeError:
        return describe_image(source_path)
    text = result.get("text", "")
    boxes = result.get("boxes", [])
    if boxes:
        try:
            return text + "\n\n[OCR boxes JSON]\n" + json.dumps(
                {"text": text, "boxes": boxes}, ensure_ascii=False, indent=2
            )
        except Exception:
            return text
    return text if text else describe_image(source_path)
