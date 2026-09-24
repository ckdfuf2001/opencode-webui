"""Outlook .msg support (file-based, no COM needed).

Ported from backend/scripts/doc_converter.py so the office-mcp fork keeps
our unique msg + attachment handling. Public helpers return plain Python
types; the MCP wrappers in server.py turn them into {"ok": ...} replies.
"""

from __future__ import annotations

import os
import re
from typing import Any


def resolve_path(path_value: str) -> str:
    """Resolve workspace-relative paths like the old doc-reader did.

    Absolute paths pass through. Relative paths are resolved against
    OPCODE_WEBUI_REPOS (preferred), OPCODE_WEBUI_WORKSPACE, or cwd.
    """
    if os.path.isabs(path_value):
        return path_value
    rel = str(path_value).replace("\\", "/").lstrip("/")
    repos = os.environ.get("OPCODE_WEBUI_REPOS", "")
    if repos and os.path.isdir(repos):
        base = os.path.abspath(repos)
        if rel == "repos":
            return base
        if rel.startswith("repos/"):
            return os.path.join(base, rel[len("repos/"):])
        return os.path.join(base, rel)
    ws = os.path.abspath(os.environ.get("OPCODE_WEBUI_WORKSPACE", os.getcwd()))
    repos_dir = os.path.join(ws, "repos")
    if rel.startswith("repos/"):
        return os.path.join(ws, rel)
    first = rel.split("/", 1)[0]
    if first and os.path.isdir(os.path.join(repos_dir, first)):
        return os.path.join(repos_dir, rel)
    return os.path.join(ws, path_value)


def _clean(value: Any) -> str:
    return (str(value) if value is not None else "").replace("\x00", "").strip()


def _human_size(num: int) -> str:
    if not num:
        return ""
    size: float = float(num)
    for unit in ("B", "KB", "MB", "GB"):
        if size < 1024:
            return f"{size:.0f} {unit}" if unit == "B" else f"{size:.1f} {unit}"
        size /= 1024
    return f"{size:.1f} TB"


def _attachment_meta(att: Any) -> dict[str, Any]:
    try:
        name = _clean(getattr(att, "longFilename", None) or getattr(att, "shortFilename", None))
    except Exception:
        name = ""
    if not name:
        try:
            name = _clean(getattr(att, "displayName", None))
        except Exception:
            name = ""
    size = 0
    try:
        data = getattr(att, "data", None)
        if isinstance(data, bytes):
            size = len(data)
    except Exception:
        size = 0
    try:
        cid = _clean(getattr(att, "cid", None))
    except Exception:
        cid = ""
    try:
        mime = _clean(getattr(att, "mimetype", None))
    except Exception:
        mime = ""
    return {"name": name or "attachment", "size": size, "cid": cid, "mime": mime}


def list_attachments(source_path: str) -> list[dict[str, Any]]:
    import extract_msg

    msg = extract_msg.Message(source_path)
    try:
        return [_attachment_meta(a) for a in (list(getattr(msg, "attachments", None) or []))]
    finally:
        try:
            msg.close()
        except Exception:
            pass


def read_msg(source_path: str) -> dict[str, Any]:
    """Return structured msg content: headers, body, attachments, links."""
    import extract_msg

    msg = extract_msg.Message(source_path)
    try:
        sender = _clean(getattr(msg, "sender", None))
        to = _clean(getattr(msg, "to", None))
        cc = _clean(getattr(msg, "cc", None))
        subject = _clean(getattr(msg, "subject", None))
        try:
            date = _clean(getattr(msg, "date", None))
        except Exception:
            date = ""
        try:
            atts = [_attachment_meta(a) for a in (list(getattr(msg, "attachments", None) or []))]
        except Exception:
            atts = []

        html = ""
        try:
            raw_html = getattr(msg, "htmlBody", None)
            if isinstance(raw_html, bytes):
                html = raw_html.decode("utf-8", errors="replace").replace("\x00", "").strip()
            else:
                html = _clean(raw_html)
        except Exception:
            html = ""
        body = ""
        try:
            body = _clean(getattr(msg, "body", None))
        except Exception:
            body = ""
        if not body and html:
            body = re.sub(r"\s+", " ", re.sub(r"<[^>]+>", " ", html)).strip()

        links: list[str] = []
        if html:
            links += re.findall(r"""(?:href|src)\s*=\s*["']?([^"'\s>]+)["']?""", html, flags=re.IGNORECASE)
        if body:
            links += re.findall(r"https?://[^\s<\"']+", body)
        links = [link for link in links if not link.startswith(("cid:", "data:", "#", "mailto:"))]
        unique_links: list[str] = []
        seen: set[str] = set()
        for link in links:
            if link not in seen:
                seen.add(link)
                unique_links.append(link)

        lines: list[str] = []
        if sender:
            lines.append(f"From: {sender}")
        if to:
            lines.append(f"To: {to}")
        if cc:
            lines.append(f"CC: {cc}")
        if subject:
            lines.append(f"Subject: {subject}")
        if date:
            lines.append(f"Date: {date}")
        if atts:
            lines.append(f"Attachments: {len(atts)}")
            for att in atts:
                size = _human_size(int(att.get("size") or 0))
                lines.append(f"- {att['name']}" + (f" ({size})" if size else ""))
        if unique_links:
            lines.append(f"Links: {len(unique_links)}")
            for link in unique_links:
                lines.append(f"- {link}")
        if body:
            lines.append("Body:")
            lines.append(body)
        text = "\n".join(lines) or "(Empty email message)"
        return {
            "from": sender,
            "to": to,
            "cc": cc,
            "subject": subject,
            "date": date,
            "body": body,
            "text": text,
            "attachments": atts,
            "links": unique_links,
        }
    finally:
        try:
            msg.close()
        except Exception:
            pass


def default_attachment_dir(source_path: str) -> str:
    base = os.path.basename(source_path).replace(".", "_")
    return os.path.join(os.path.dirname(os.path.abspath(source_path)), base)


def extract_attachment_bytes(source_path: str, index: int) -> tuple[str, bytes | None, str]:
    """Return (filename, data, mime) for the index-th msg attachment."""
    import extract_msg

    msg = extract_msg.Message(source_path)
    try:
        atts = list(getattr(msg, "attachments", None) or [])
        if not atts or not (0 <= index < len(atts)):
            return "", None, ""
        att = atts[index]
        try:
            name = _clean(getattr(att, "longFilename", None) or getattr(att, "shortFilename", None))
        except Exception:
            name = ""
        if not name:
            try:
                name = _clean(getattr(att, "displayName", None))
            except Exception:
                name = ""
        data = None
        try:
            raw = getattr(att, "data", None)
            if isinstance(raw, bytes):
                data = raw
        except Exception:
            data = None
        try:
            mime = _clean(getattr(att, "mimetype", None))
        except Exception:
            mime = ""
        return name or "attachment", data, mime
    finally:
        try:
            msg.close()
        except Exception:
            pass
