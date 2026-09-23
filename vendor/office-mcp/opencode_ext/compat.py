"""Drop-in compat for the old doc-reader tools.

``read_document`` / ``edit_document`` / ``download_attachment`` first try a
local file-based implementation (modern OOXML via python libs, .msg via
extract_msg, .pdf via pypdf — no Office needed). Legacy ``.doc/.xls/.ppt``
fall back to COM when pywin32 + Office exist, otherwise to the
opencode-webui backend (``OPCODE_WEBUI_BACKEND``) when configured — that is
the gradual-migration path until preview/converter move fully to office-mcp.
"""

from __future__ import annotations

import json
import os
import urllib.parse
import urllib.request
from typing import Any

from opencode_ext.embedded import list_embedded
from opencode_ext.msg import (
    default_attachment_dir,
    extract_attachment_bytes,
    read_msg,
    resolve_path,
)

MODERN_EXTS = {".docx", ".xlsx", ".pptx"}
LEGACY_EXTS = {".doc", ".xls", ".ppt"}
PDF_EXTS = {".pdf"}
MSG_EXTS = {".msg"}
IMAGE_EXTS = {".png", ".jpg", ".jpeg", ".bmp", ".tiff", ".tif", ".webp"}


def _backend() -> str:
    return os.environ.get("OPCODE_WEBUI_BACKEND", "")


def _backend_extract(target: str) -> str | None:
    base = _backend()
    if not base:
        return None
    try:
        payload = json.dumps({"path": target}).encode("utf-8")
        req = urllib.request.Request(
            f"{base}/api/preview/extract",
            data=payload,
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=180) as resp:
            body = json.loads(resp.read().decode("utf-8"))
        return body.get("text", "")
    except Exception:
        return None


def _extract_pdf_text(path: str) -> str:
    try:
        from pypdf import PdfReader
    except ImportError:
        from PyPDF2 import PdfReader  # type: ignore[no-redef]
    reader = PdfReader(path)
    pages = [(p.extract_text() or "").strip() for p in reader.pages]
    return "\n\n".join(t for t in pages if t)


def _extract_docx_text(path: str) -> str:
    import docx

    doc = docx.Document(path)
    parts = [p.text for p in doc.paragraphs if p.text and p.text.strip()]
    for table in doc.tables:
        for row in table.rows:
            parts.append("\t".join(c.text for c in row.cells))
    return "\n".join(parts)


def _extract_xlsx_text(path: str) -> str:
    from openpyxl import load_workbook

    wb = load_workbook(path, read_only=True, data_only=True)
    try:
        lines: list[str] = []
        for ws in wb.worksheets:
            lines.append(f"[Sheet: {ws.title}]")
            for row in ws.iter_rows(values_only=True):
                vals = [str(v) for v in row if v is not None and str(v).strip()]
                if vals:
                    lines.append("\t".join(vals))
        return "\n".join(lines)
    finally:
        wb.close()


def _extract_pptx_text(path: str) -> str:
    from pptx import Presentation

    prs = Presentation(path)
    lines: list[str] = []
    for i, slide in enumerate(prs.slides, 1):
        lines.append(f"[Slide {i}]")
        for shape in slide.shapes:
            if shape.has_text_frame and shape.text_frame.text.strip():
                lines.append(shape.text_frame.text)
            if shape.has_table:
                for row in shape.table.rows:
                    lines.append("\t".join(c.text for c in row.cells))
    return "\n".join(lines)


def _extract_image_text(path: str) -> str:
    try:
        from PIL import Image
        import pytesseract
    except ImportError as exc:
        return f"[image: {os.path.basename(path)}] (OCR deps missing: {exc})"
    try:
        pytesseract.get_tesseract_version()
    except Exception as exc:
        return f"[image: {os.path.basename(path)}] (Tesseract engine not found: {exc})"
    img = Image.open(path)
    if img.mode not in ("RGB", "L"):
        img = img.convert("RGB")
    for lang in ("kor+eng", "eng"):
        try:
            return pytesseract.image_to_string(img, lang=lang).strip()
        except Exception as exc:
            if "kor" in str(exc).lower() and lang != "eng":
                continue
            raise
    return ""


def _extract_legacy_com_text(path: str) -> str:
    import win32com.client  # type: ignore[import]

    ext = os.path.splitext(path)[1].lower()
    if ext == ".doc":
        app = win32com.client.DispatchEx("Word.Application")
        try:
            app.Visible = False
            doc = app.Documents.Open(path, ReadOnly=True)
            try:
                return doc.Content.Text
            finally:
                doc.Close(False)
        finally:
            app.Quit()
    if ext == ".xls":
        app = win32com.client.DispatchEx("Excel.Application")
        try:
            app.Visible = False
            wb = app.Workbooks.Open(path, ReadOnly=True)
            try:
                lines = []
                for ws in wb.Worksheets:
                    lines.append(f"[Sheet: {ws.Name}]")
                    used = ws.UsedRange
                    for r in range(1, used.Rows.Count + 1):
                        vals = []
                        for c in range(1, used.Columns.Count + 1):
                            try:
                                v = used.Cells(r, c).Value
                            except Exception:
                                v = None
                            if v is not None:
                                vals.append(str(v))
                        if any(v.strip() for v in vals):
                            lines.append("\t".join(vals))
                return "\n".join(lines)
            finally:
                wb.Close(False)
        finally:
            app.Quit()
    app = win32com.client.DispatchEx("PowerPoint.Application")
    try:
        pres = app.Presentations.Open(path, ReadOnly=True, WithWindow=False)
        try:
            lines = []
            for i, slide in enumerate(pres.Slides, 1):
                lines.append(f"[Slide {i}]")
                for shape in slide.Shapes:
                    if shape.HasTextFrame and shape.TextFrame.HasText:
                        lines.append(shape.TextFrame.TextRange.Text)
            return "\n".join(lines)
        finally:
            pres.Close()
    finally:
        app.Quit()


def _embedded_summary(path: str) -> str:
    try:
        entries = list_embedded(path)
    except Exception:
        return ""
    if not entries:
        return ""
    lines = [f"Embedded objects: {len(entries)}"]
    for e in entries:
        size = e.get("size") or 0
        lines.append(f"- [{e['index']}] {e.get('name')} ({size} bytes, {e.get('container')})")
    lines.append("Use embedded_list / embedded_extract for control.")
    return "\n".join(lines)


def read_document_local(path: str) -> str:
    target = resolve_path(path)
    if not os.path.isfile(target):
        raise FileNotFoundError(f"File not found: {target}")
    ext = os.path.splitext(target)[1].lower()
    if ext in MSG_EXTS:
        data = read_msg(target)
        return data["text"]
    if ext in PDF_EXTS:
        return _extract_pdf_text(target)
    if ext == ".docx":
        text = _extract_docx_text(target)
    elif ext == ".xlsx":
        text = _extract_xlsx_text(target)
    elif ext == ".pptx":
        text = _extract_pptx_text(target)
    elif ext in IMAGE_EXTS:
        # 예전 read_document 형태 유지: OCR 텍스트 + 박스 JSON.
        # 엔진이 없으면 describe 폴백 (에러 대신 이미지 정보 반환).
        from opencode_ext.image import read_image_text

        return read_image_text(target)
    elif ext in LEGACY_EXTS:
        try:
            text = _extract_legacy_com_text(target)
        except Exception as exc:
            fallback = _backend_extract(target)
            if fallback:
                return fallback
            raise RuntimeError(f"Legacy {ext} needs Office/COM or backend: {exc}") from exc
    else:
        raise ValueError(f"Unsupported document type: {ext}")
    summary = _embedded_summary(target)
    if summary:
        text = (text + "\n\n" + summary) if text else summary
    return text or "(Empty document)"


def read_document_text(path: str) -> str:
    """Local first, backend fallback (gradual migration)."""
    try:
        return read_document_local(path)
    except Exception as local_exc:
        fallback = _backend_extract(resolve_path(path))
        if fallback:
            return fallback
        raise local_exc


# ---- edit (modern OOXML via python libs; legacy via COM) ----

def _replace_in_runs(runs: Any, find: str, repl: str, occurrence: int) -> int:
    concat = "".join(r.text for r in runs)
    if find not in concat:
        return 0
    positions: list[tuple[int, int]] = []
    start = 0
    while True:
        i = concat.find(find, start)
        if i == -1:
            break
        positions.append((i, i + len(find)))
        start = i + len(find)
    targets = [positions[occurrence - 1]] if occurrence else positions
    if occurrence and not (0 < occurrence <= len(positions)):
        return 0
    pos, done = 0, 0
    for r in runs:
        rstart, rend = pos, pos + len(r.text)
        segs: list[str] = []
        cursor = rstart
        for (s, e) in targets:
            if s >= rend or e <= rstart or s < rstart:
                if s < rstart and e > rstart:
                    cursor = max(cursor, e)
                continue
            if s > cursor:
                segs.append(r.text[cursor - rstart:s - rstart])
            segs.append(repl)
            cursor = e
            done += 1
        if cursor < rend:
            segs.append(r.text[cursor - rstart:])
        r.text = "".join(segs)
        pos = rend
    return done


def _edit_docx(path: str, operations: list[dict[str, Any]]) -> list[dict[str, Any]]:
    import docx

    doc = docx.Document(path)

    def all_paras() -> list[Any]:
        paras = list(doc.paragraphs)

        def walk(tables: Any) -> None:
            for table in tables:
                for row in table.rows:
                    for cell in row.cells:
                        paras.extend(cell.paragraphs)
                        walk(cell.tables)

        walk(doc.tables)
        return paras

    results = []
    for op in operations:
        kind, applied = op.get("op"), False
        if kind in ("replace", "delete"):
            find = op.get("find", "")
            repl = "" if kind == "delete" else op.get("replace", "")
            occ = op.get("occurrence") or 0
            if find:
                for p in all_paras():
                    if p.runs and find in p.text:
                        applied = _replace_in_runs(p.runs, find, repl, occ) > 0 or applied
        elif kind in ("insert_after", "insert_before"):
            find = op.get("find", "")
            idx = op.get("occurrence") or 1
            if find:
                for p in all_paras():
                    if find in p.text:
                        idx -= 1
                        if idx == 0:
                            if kind == "insert_after":
                                from docx.oxml.ns import qn
                                from docx.text.paragraph import Paragraph

                                new_p = p._p.makeelement(qn("w:p"), {})
                                p._p.addnext(new_p)
                                Paragraph(new_p, p._parent).add_run(op.get("text", ""))
                            else:
                                p.insert_paragraph_before(op.get("text", ""))
                            applied = True
                            break
        elif kind == "append":
            doc.add_paragraph(op.get("text", ""))
            applied = True
        elif kind == "prepend":
            if doc.paragraphs:
                doc.paragraphs[0].insert_paragraph_before(op.get("text", ""))
                applied = True
        results.append({"op": kind, "applied": applied})
    doc.save(path)
    return results


def _edit_xlsx(path: str, operations: list[dict[str, Any]]) -> list[dict[str, Any]]:
    from openpyxl import load_workbook

    wb = load_workbook(path)
    results = []
    for op in operations:
        kind, applied = op.get("op"), False
        if kind in ("replace", "delete"):
            find = op.get("find", "")
            repl = "" if kind == "delete" else op.get("replace", "")
            if find:
                for ws in wb.worksheets:
                    for row in ws.iter_rows():
                        for cell in row:
                            if isinstance(cell.value, str) and find in cell.value:
                                cell.value = cell.value.replace(find, repl)
                                applied = True
        elif kind in ("insert_after", "insert_before"):
            find = op.get("find", "")
            idx = op.get("occurrence") or 1
            if find:
                for ws in wb.worksheets:
                    for row in ws.iter_rows():
                        for cell in row:
                            if isinstance(cell.value, str) and find in cell.value:
                                idx -= 1
                                if idx == 0:
                                    r, c = cell.row, cell.column
                                    if kind == "insert_after":
                                        ws.insert_rows(r + 1)
                                        ws.cell(row=r + 1, column=c, value=op.get("text", ""))
                                    else:
                                        ws.insert_rows(r)
                                        ws.cell(row=r, column=c, value=op.get("text", ""))
                                    applied = True
                                    break
                        if applied:
                            break
                    if applied:
                        break
        elif kind == "append":
            wb.worksheets[0].append([op.get("text", "")])
            applied = True
        elif kind == "prepend":
            ws = wb.worksheets[0]
            ws.insert_rows(1)
            ws.cell(row=1, column=1, value=op.get("text", ""))
            applied = True
        results.append({"op": kind, "applied": applied})
    wb.save(path)
    return results


def _edit_pptx(path: str, operations: list[dict[str, Any]]) -> list[dict[str, Any]]:
    from pptx import Presentation
    from pptx.util import Inches

    prs = Presentation(path)
    frames = [s.text_frame for sl in prs.slides for s in sl.shapes if s.has_text_frame]
    results = []
    for op in operations:
        kind, applied = op.get("op"), False
        if kind in ("replace", "delete"):
            find = op.get("find", "")
            repl = "" if kind == "delete" else op.get("replace", "")
            if find:
                for tf in frames:
                    for para in tf.paragraphs:
                        if para.runs and find in "".join(r.text for r in para.runs):
                            applied = _replace_in_runs(para.runs, find, repl, op.get("occurrence") or 0) > 0 or applied
        elif kind in ("insert_after", "insert_before"):
            find = op.get("find", "")
            idx = op.get("occurrence") or 1
            if find:
                for tf in frames:
                    for para in tf.paragraphs:
                        if find in "".join(r.text for r in para.runs):
                            idx -= 1
                            if idx == 0:
                                para.insert_paragraph_before(op.get("text", ""))
                                applied = True
                                break
                    if applied:
                        break
        elif kind == "append":
            layout = prs.slide_layouts[6] if len(prs.slide_layouts) > 6 else prs.slide_layouts[0]
            slide = prs.slides.add_slide(layout)
            slide.shapes.add_textbox(Inches(0.5), Inches(0.5), Inches(9), Inches(5)).text_frame.text = op.get("text", "")
            applied = True
        elif kind == "prepend":
            if frames and frames[0].paragraphs:
                frames[0].paragraphs[0].insert_paragraph_before(op.get("text", ""))
                applied = True
        results.append({"op": kind, "applied": applied})
    prs.save(path)
    return results


def edit_document_local(path: str, operations: list[dict[str, Any]]) -> list[dict[str, Any]]:
    target = resolve_path(path)
    if not os.path.isfile(target):
        raise FileNotFoundError(f"File not found: {target}")
    ext = os.path.splitext(target)[1].lower()
    if ext == ".docx":
        return _edit_docx(target, operations)
    if ext == ".xlsx":
        return _edit_xlsx(target, operations)
    if ext == ".pptx":
        return _edit_pptx(target, operations)
    if ext in LEGACY_EXTS:
        base = _backend()
        if base:
            payload = json.dumps({"path": target, "operations": operations}).encode("utf-8")
            req = urllib.request.Request(
                f"{base}/api/preview/edit",
                data=payload,
                headers={"Content-Type": "application/json"},
                method="POST",
            )
            with urllib.request.urlopen(req, timeout=300) as resp:
                body = json.loads(resp.read().decode("utf-8"))
            return body.get("results", [])
        raise RuntimeError(f"Legacy {ext} editing needs the backend converter (no local COM path in fork phase 1)")
    raise ValueError(f"Unsupported document type: {ext}")


def download_attachment_local(path: str, index: int, destination: str = "") -> str:
    target = resolve_path(path)
    if not os.path.isfile(target):
        # backend fallback for workspace-odd paths
        base = _backend()
        if base:
            dest_dir = resolve_path(destination) if destination else os.path.join(
                os.path.dirname(target), os.path.basename(target).replace(".", "_"))
            os.makedirs(dest_dir, exist_ok=True)
            url = f"{base}/api/preview/attachment?path={urllib.parse.quote(target)}&index={index}"
            with urllib.request.urlopen(urllib.request.Request(url), timeout=180) as resp:
                data = resp.read()
                disp = resp.headers.get("Content-Disposition", "")
                name = urllib.parse.unquote(disp.split("filename*=UTF-8''")[1].split(";")[0].strip()) if "filename*=UTF-8''" in disp else os.path.basename(target)
            out = os.path.join(dest_dir, name)
            with open(out, "wb") as f:
                f.write(data)
            return out
        raise FileNotFoundError(f"File not found: {target}")
    name, data, _mime = extract_attachment_bytes(target, int(index))
    if data is None:
        raise IndexError(f"Attachment #{index} not found")
    dest_dir = resolve_path(destination) if destination else default_attachment_dir(target)
    os.makedirs(dest_dir, exist_ok=True)
    out = os.path.join(dest_dir, name)
    with open(out, "wb") as f:
        f.write(data)
    return out
