"""Embedded OLE/package objects inside Excel / PowerPoint / Word files.

File-based implementation (no COM needed) so it works headless in chat:

- Modern OOXML (``.xlsx`` / ``.pptx`` / ``.docx`` are ZIPs): entries under
  ``*/embeddings/*`` and ``*/oleObjects/*`` are listed. Each ``.bin`` is
  usually an OLE container holding the real file (Ole10Native / PACKAGE
  stream). We parse the native payload when possible, otherwise return the
  raw ``.bin`` bytes with a magic-based extension guess.
- Legacy OLE (``.xls`` / ``.ppt`` / ``.doc`` compound files): streams are
  enumerated with ``olefile`` and embedded candidates (Ole10Native, PACKAGE,
  object-pool storages) are listed / extracted.

Live documents open in Office should be saved first (``xl_save`` /
``ppt_save`` / ``doc_save``), then listed here — COM live enumeration is a
future step, the file route already covers the chat use-case.
"""

from __future__ import annotations

import io
import os
import struct
import zipfile
from typing import Any


def _read_cstring(buf: bytes, pos: int) -> tuple[str, int]:
    end = buf.find(b"\x00", pos)
    if end == -1:
        return "", len(buf)
    try:
        return buf[pos:end].decode("utf-8", errors="replace"), end + 1
    except Exception:
        return "", end + 1


def parse_ole10native(data: bytes) -> tuple[str, bytes] | None:
    """Best-effort Ole10Native extraction. Returns (filename, payload)."""
    try:
        if len(data) < 12:
            return None
        pos = 4  # DWORD total size
        # flags (WORD) + string sizes vary by producer; strings are NUL-terminated
        if pos + 2 <= len(data):
            pos += 2
        filename, pos = _read_cstring(data, pos)
        _filepath, pos = _read_cstring(data, pos)
        # skip DWORD unknown / command length area, then DWORD data size
        if pos + 8 <= len(data):
            pos += 4
            (size,) = struct.unpack_from("<I", data, pos)
            pos += 4
            if 0 < size <= len(data) - pos:
                payload = data[pos:pos + size]
                return filename or "embedded", payload
        # fallback: payload is the tail after the strings
        if pos < len(data):
            return filename or "embedded", data[pos:]
        return None
    except Exception:
        return None


def _guess_ext(data: bytes, name_hint: str = "") -> str:
    hint = (name_hint or "").lower()
    for ext in (".docx", ".xlsx", ".pptx", ".pdf", ".msg", ".zip", ".png", ".jpg", ".txt"):
        if hint.endswith(ext):
            return ext
    if data[:4] == b"PK\x03\x04":
        # peek inner content types for office docs
        try:
            with zipfile.ZipFile(io.BytesIO(data)) as zf:
                names = set(zf.namelist())
                if "word/document.xml" in names:
                    return ".docx"
                if "xl/workbook.xml" in names:
                    return ".xlsx"
                if "ppt/presentation.xml" in names:
                    return ".pptx"
        except Exception:
            pass
        return ".zip"
    if data[:5] == b"%PDF-":
        return ".pdf"
    if data[:8] == b"\xD0\xCF\x11\xE0\xA1\xB1\x1A\xE1":
        return ".ole"
    if data[:2] == b"\xFF\xD8":
        return ".jpg"
    if data[:8] == b"\x89PNG\r\n\x1a\n":
        return ".png"
    return ".bin"


def _inspect_ole_payload(data: bytes) -> dict[str, Any]:
    """Inspect .bin bytes with olefile when available (never raises)."""
    info: dict[str, Any] = {"is_ole": False, "streams": [], "native_name": ""}
    try:
        import olefile
    except Exception:
        return info
    try:
        if not olefile.isOleFile(io.BytesIO(data)):
            return info
        info["is_ole"] = True
        with olefile.OleFileIO(io.BytesIO(data)) as ole:
            streams = ["/".join(p) for p in ole.listdir(streams=True, storages=True)]
            info["streams"] = streams[:50]
            for cand in ("ole10native", "\x01ole10native"):
                match = next((s for s in streams if s.lower().endswith(cand)), "")
                if match:
                    try:
                        raw = ole.openstream(match).read()
                    except Exception:
                        raw = b""
                    parsed = parse_ole10native(raw)
                    if parsed:
                        info["native_name"] = parsed[0]
                    break
    except Exception:
        pass
    return info


def _ooxml_prog_ids(zf: zipfile.ZipFile) -> dict[str, str]:
    """Map oleObject bin path -> progId from drawing rels (best effort)."""
    progs: dict[str, str] = {}
    try:
        for name in zf.namelist():
            low = name.lower()
            if low.endswith(".xml") and "oleobject" in low:
                try:
                    xml = zf.read(name).decode("utf-8", errors="replace")
                except Exception:
                    continue
                import re

                for m in re.finditer(
                    r'<oleObject[^>]*progId="([^"]+)"[^>]*>(.*?)</oleObject>|'
                    r'<oleObject[^>]*>(.*?)</oleObject>',
                    xml,
                    flags=re.IGNORECASE | re.DOTALL,
                ):
                    prog = m.group(1) or ""
                    # link embedded bin via r:id -> rels lookup omitted (name match fallback)
                    if prog:
                        progs[name] = prog
    except Exception:
        pass
    return progs


def list_embedded(source_path: str) -> list[dict[str, Any]]:
    """List embedded objects. Each entry has a stable 0-based ``index``."""
    if not os.path.isfile(source_path):
        raise FileNotFoundError(f"File not found: {source_path}")
    if zipfile.is_zipfile(source_path):
        return _list_ooxml(source_path)
    return _list_ole(source_path)


def _list_ooxml(source_path: str) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    with zipfile.ZipFile(source_path) as zf:
        progs = _ooxml_prog_ids(zf)
        prog_default = next(iter(progs.values()), "") if progs else ""
        for name in zf.namelist():
            low = name.lower()
            if "embeddings/" not in low and "oleobject" not in low:
                continue
            if name.endswith("/"):
                continue
            try:
                info = zf.getinfo(name)
            except KeyError:
                continue
            # oleObject XML descriptors themselves are not payloads
            if low.endswith(".xml") or low.endswith(".rels"):
                continue
            try:
                data = zf.read(name)
            except Exception:
                data = b""
            inspected = _inspect_ole_payload(data) if data else {"is_ole": False, "streams": [], "native_name": ""}
            out.append(
                {
                    "index": len(out),
                    "name": inspected.get("native_name") or os.path.basename(name),
                    "zip_path": name,
                    "size": len(data),
                    "container": "ooxml",
                    "prog": prog_default,
                    "is_ole": bool(inspected.get("is_ole")),
                    "streams": inspected.get("streams", []),
                }
            )
    return out


def _list_ole(source_path: str) -> list[dict[str, Any]]:
    try:
        import olefile
    except Exception as exc:
        raise RuntimeError(f"olefile is required for legacy OLE embedded listing: {exc}") from exc
    if not olefile.isOleFile(source_path):
        return []
    out: list[dict[str, Any]] = []
    with olefile.OleFileIO(source_path) as ole:
        for path_parts in ole.listdir(streams=True, storages=False):
            full = "/".join(path_parts)
            low = full.lower()
            # embedded candidates: native/package streams or object-pool entries
            if not (
                "ole10native" in low
                or "package" in low
                or "contents" in low
                or "compobj" in low
                or low.startswith("mbd")
                or "ole" in low
            ):
                continue
            try:
                size = ole.get_size(full)
            except Exception:
                size = 0
            out.append(
                {
                    "index": len(out),
                    "name": path_parts[-1],
                    "zip_path": full,  # ole stream path (same key used for extract)
                    "size": int(size or 0),
                    "container": "ole",
                    "prog": "",
                    "is_ole": False,
                    "streams": [],
                }
            )
    return out


def extract_embedded(source_path: str, index: int, destination_dir: str) -> str:
    """Extract the index-th embedded object into destination_dir. Returns path."""
    entries = list_embedded(source_path)
    if not entries or not (0 <= index < len(entries)):
        raise IndexError(f"Embedded object #{index} not found (found {len(entries)})")
    entry = entries[index]
    os.makedirs(destination_dir, exist_ok=True)

    if entry["container"] == "ooxml":
        with zipfile.ZipFile(source_path) as zf:
            raw = zf.read(entry["zip_path"])
        payload_name = ""
        payload = raw
        inspected = _inspect_ole_payload(raw)
        if inspected.get("is_ole"):
            try:
                import olefile

                with olefile.OleFileIO(io.BytesIO(raw)) as ole:
                    streams = ["/".join(p) for p in ole.listdir(streams=True, storages=False)]
                    native_stream = next((s for s in streams if s.lower().endswith("ole10native")), "")
                    if native_stream:
                        parsed = parse_ole10native(ole.openstream(native_stream).read())
                        if parsed:
                            payload_name, payload = parsed
                    elif streams:
                        # PACKAGE / CONTENTS single-stream payload
                        payload = ole.openstream(streams[0]).read()
            except Exception:
                payload = raw
        else:
            # Some producers store a bare Ole10Native block (not an OLE
            # container). Accept it only when parsing shrinks the payload
            # with a plausible filename — avoids false positives on .bin blobs.
            try:
                parsed = parse_ole10native(raw)
            except Exception:
                parsed = None
            if parsed and parsed[0] and 0 < len(parsed[1]) < len(raw):
                payload_name, payload = parsed
        base = payload_name or entry["name"] or f"embedded_{index}"
        base = os.path.basename(base)
        if "." not in base:
            base += _guess_ext(payload, entry["name"])
        out_path = os.path.join(destination_dir, base)
        # avoid overwrite: suffix counter
        stem, ext = os.path.splitext(out_path)
        counter = 1
        while os.path.exists(out_path):
            counter += 1
            out_path = f"{stem}_{counter}{ext}"
        with open(out_path, "wb") as f:
            f.write(payload)
        return out_path

    # legacy OLE stream
    try:
        import olefile
    except Exception as exc:
        raise RuntimeError(f"olefile is required for legacy OLE embedded extraction: {exc}") from exc
    with olefile.OleFileIO(source_path) as ole:
        raw = ole.openstream(entry["zip_path"]).read()
    parsed = parse_ole10native(raw) if b"\x00" in raw[:512] else None
    if parsed:
        fname, payload = parsed
    else:
        fname, payload = entry["name"], raw
    base = os.path.basename(fname) or f"embedded_{index}"
    if "." not in base:
        base += _guess_ext(payload, base)
    out_path = os.path.join(destination_dir, base)
    stem, ext = os.path.splitext(out_path)
    counter = 1
    while os.path.exists(out_path):
        counter += 1
        out_path = f"{stem}_{counter}{ext}"
    with open(out_path, "wb") as f:
        f.write(payload)
    return out_path


def default_embedded_dir(source_path: str) -> str:
    base = os.path.basename(source_path).replace(".", "_") + "_embedded"
    return os.path.join(os.path.dirname(os.path.abspath(source_path)), base)
