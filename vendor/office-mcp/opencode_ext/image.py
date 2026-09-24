"""Image reading with word-level OCR boxes (file-based, no Office needed).

Ported from backend/scripts/doc_converter.py so the office-mcp fork keeps
our unique image behavior: Pillow + pytesseract text plus per-word boxes
``{"text": str, "boxes": [{text, left, top, width, height, conf}]}``,
bundled-tesseract-first resolution, kor tessdata priority,
kor+eng+equ language chain, low-res 2x upscale (boxes scaled back),
and a Pillow-only describe fallback when no OCR engine exists.
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


def _env_roots() -> list[str]:
    """명시 루트 (OPCODE_WEBUI_ROOT, 설치 루트 = bin/ 보유 dir).

    백엔드가 doc-reader MCP entry env로 내려준다. frozen-exe 위치 추측보다
    우선한다 — CWD·번들 위치와 무관하게 확정되기 때문.
    """
    root = (os.environ.get("OPCODE_WEBUI_ROOT") or "").strip().strip("\"'")
    if not root:
        return []
    ap = os.path.abspath(root)
    return [ap] if os.path.isdir(ap) else []


def _frozen_roots() -> list[str]:
    """PyInstaller onefile anchor dirs.

    Frozen exe는 <root>/scripts/*.exe 로 나가고, __file__ 기준 탐색은
    번들 임시폴더(_MEI*)를 가리켜 실패한다. exe 위치 기준으로
    <root>/bin/tesseract 를 찾는다. dev(python 실행)에서는 빈 목록.
    """
    import sys

    if not getattr(sys, "frozen", False):
        return []
    exe_dir = os.path.dirname(os.path.abspath(sys.executable))
    return [os.path.abspath(os.path.join(exe_dir, ".."))]


def resolve_bundled_tesseract() -> str | None:
    """Return bundled bin/tesseract/tesseract.exe when present.

    Checked relative to this file first (vendor/office-mcp/opencode_ext),
    then the frozen exe location (portable release/scripts/*.exe),
    then the historical checkout locations.
    """
    candidates = []
    for root in _env_roots():
        candidates.append(os.path.join(root, "bin", "tesseract", "tesseract.exe"))
    candidates += [
        os.path.join(_HERE, "..", "..", "..", "bin", "tesseract", "tesseract.exe"),
        os.path.join(_HERE, "..", "..", "..", "release", "bin", "tesseract", "tesseract.exe"),
    ]
    for root in _frozen_roots():
        candidates.append(os.path.join(root, "bin", "tesseract", "tesseract.exe"))
    candidates += [
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
    candidates = []
    for root in _env_roots():
        candidates.append(os.path.join(root, "bin", "tesseract", "tessdata"))
    candidates.append(os.path.join(_HERE, "..", "..", "..", "bin", "tesseract", "tessdata"))
    for root in _frozen_roots():
        candidates.append(os.path.join(root, "bin", "tesseract", "tessdata"))
    candidates.append(os.path.join(os.getcwd(), "bin", "tesseract", "tessdata"))
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
        import sys

        hint = bundled or "PATH"
        searched = os.pathsep.join(
            [os.path.dirname(os.path.abspath(sys.executable)), os.getcwd()]
            if getattr(sys, "frozen", False)
            else [os.getcwd()]
        )
        raise RuntimeError(
            f"Tesseract OCR engine not found (tried {hint}). "
            "Run `npm run tesseract:install` or install Tesseract "
            "(https://github.com/UB-Mannheim/tesseract/wiki) and ensure "
            "`tesseract` is in PATH. Bundled path: bin/tesseract/tesseract.exe "
            f"(searched from: {searched})"
        ) from exc
    img = Image.open(source_path)
    if img.mode not in ("RGB", "L"):
        img = img.convert("RGB")
    # 저해상도 업스케일 (backend/scripts/doc_converter.py와 동일):
    # 긴 변 2000px 미만이면 2x LANCZOS (상한 5000px). boxes는 원본 좌표로 역보정.
    w0, h0 = img.size
    scale = 1.0
    if max(w0, h0) < 2000:
        scale = min(2.0, 5000.0 / max(w0, h0))
        if scale > 1.01:
            img = img.resize((int(w0 * scale + 0.5), int(h0 * scale + 0.5)), Image.LANCZOS)
        else:
            scale = 1.0
    # kor+eng+equ를 먼저 시도 (equ=수식/기호. 낱개 통합 파일은 없으므로 조합).
    # equ만 없고 kor는 있으면 다음 체인으로 폴백한다.
    lang_used = "eng"
    for lang in ("kor+eng+equ", "kor+eng", "eng"):
        try:
            cfg = "--oem 1 --psm 6" if "kor" in lang else "--oem 3 --psm 6"
            data = pytesseract.image_to_data(img, lang=lang, config=cfg, output_type=Output.DICT)
            lang_used = lang
            break
        except Exception as exc:
            msg = str(exc).lower()
            is_load_error = "failed loading language" in msg or "traineddata" in msg
            if is_load_error and "+equ" in lang:
                continue
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
                # 업스케일했으면 원본 좌표로 역보정
                "text": t,
                "left": int(data["left"][i] / scale),
                "top": int(data["top"][i] / scale),
                "width": int(data["width"][i] / scale),
                "height": int(data["height"][i] / scale),
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
    reads degrade instead of failing outright. 실패 사유를 꼬리에 붙여
    (File not found와 엔진 부재를 구분) 다음 진단을 가능하게 한다.
    """
    try:
        result = read_image(source_path)
    except RuntimeError as exc:
        reason = str(exc).split("\n")[0][:200]
        return f"{describe_image(source_path)} (OCR unavailable: {reason})" if reason else describe_image(source_path)
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
