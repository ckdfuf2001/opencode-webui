import json
import os
import urllib.error
import urllib.parse
import urllib.request

from fastmcp import FastMCP

BACKEND = os.environ.get("OPCODE_WEBUI_BACKEND", "http://127.0.0.1:5001")
WORKSPACE = os.environ.get("OPCODE_WEBUI_WORKSPACE", os.path.join(os.getcwd(), "workspace"))
# 채팅 상대경로 루트. 백엔드가 OPCODE_WEBUI_REPOS(= workspace/repos)로 넘긴다.
# 있으면 여기를 루트로 쓰고, 없으면 workspace 루트 + 레포 매핑(구 동작)으로 폴백한다.
REPOS = os.environ.get("OPCODE_WEBUI_REPOS", "")

mcp = FastMCP(
    "opencode-doc-reader",
    instructions=(
        "Use read_document to extract the text content of office, PDF, image and Outlook email files "
        "(docx, doc, xlsx, xls, pptx, ppt, pdf, msg, png, jpg, jpeg, bmp, tiff, webp), including DRM-protected files. "
        "For images (png/jpg etc): if you can view images directly, do that first and skip this tool — "
        "use read_document on an image only when direct viewing fails or isn't available. "
        "When used on images it runs lightweight local OCR (Pillow + pytesseract) and returns text plus word-level boxes "
        "as JSON {text, boxes:[{text,left,top,width,height,conf}]} — no LLM needed, but Tesseract engine must be installed. "
        "For Outlook MSG emails the extracted text lists attachments and any HTTP(S) links found in the "
        "message; use download_attachment (with the 0-based Attachments index) to save an attachment to disk. "
        "Use edit_document to modify office files (docx/doc/xlsx/xls/pptx/ppt) in place. "
        "Pass absolute file paths on this machine when possible."
    ),
)


def _resolve(path_value):
    if os.path.isabs(path_value):
        return path_value
    rel = str(path_value).replace("\\", "/").lstrip("/")
    # 1순위: repos 루트 (aaa/chat_uploads/... → repos/aaa/chat_uploads/...)
    if REPOS and os.path.isdir(REPOS):
        repos_base = os.path.abspath(REPOS)
        if rel == "repos":
            return repos_base
        if rel.startswith("repos/"):
            return os.path.join(repos_base, rel[len("repos/"):])
        return os.path.join(repos_base, rel)
    ws = os.path.abspath(WORKSPACE)
    # 2순위(구 동작): 첫 세그먼트가 repos/ 아래 실재 레포명이면 repos/에 붙인다.
    # 채팅 상대경로는 레포 기준(aaa/chat_uploads/..., aaa/src/...)이므로
    # 백엔드도 구형 workspace형 절대경로를 해석하지만, 신규 호출은 정상형으로 보낸다.
    first = rel.split("/", 1)[0]
    repos = os.path.join(ws, "repos")
    if first == "repos":
        return os.path.join(ws, rel)
    if first and os.path.isdir(os.path.join(repos, first)):
        return os.path.join(repos, rel)
    return os.path.join(ws, path_value)


@mcp.tool()
def read_document(path: str) -> str:
    """Extract readable text from an Office/PDF/Image/Outlook MSG file (docx, doc, xlsx, xls, pptx, ppt, pdf, msg, png, jpg, jpeg, bmp, tiff, webp). For images returns OCR text plus word boxes as JSON — only use on images when direct viewing fails or isn't available. Accepts an absolute path or a path relative to the workspace."""
    target = _resolve(path)
    payload = json.dumps({"path": target}).encode("utf-8")
    req = urllib.request.Request(
        f"{BACKEND}/api/preview/extract",
        data=payload,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=180) as resp:
            body = json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        try:
            detail = json.loads(exc.read().decode("utf-8"))
            error = detail.get("error", str(exc))
        except Exception:
            error = str(exc)
        return f"Error reading document: {error}"
    except Exception as exc:
        return f"Error reading document: {exc}"
    text = body.get("text", "")
    # 이미지 OCR이면 박스 JSON도 함께 반환
    ocr = body.get("ocr")
    if ocr and isinstance(ocr, dict) and ocr.get("boxes"):
        try:
            return text + "\n\n[OCR boxes JSON]\n" + json.dumps(ocr, ensure_ascii=False, indent=2)
        except Exception:
            return text
    return text


@mcp.tool()
def download_attachment(path: str, index: int, destination: str = "") -> str:
    """Save an attachment of an Outlook MSG email to disk. path is the .msg file (absolute or workspace-relative). index is the 0-based position shown in read_document's Attachments list. destination is an optional folder (absolute or workspace-relative); by default the attachment is saved into a subfolder of the email's folder named after the email file with dots replaced by underscores (e.g. report.msg -> report_msg). Returns the saved file path."""
    target = _resolve(path)
    try:
        index = int(index)
        if index < 0:
            return "Error downloading attachment: index must be 0 or greater"
    except (TypeError, ValueError):
        return "Error downloading attachment: invalid index"
    if destination:
        dest_dir = _resolve(destination)
    else:
        dest_dir = os.path.join(os.path.dirname(target), os.path.basename(target).replace(".", "_"))
    os.makedirs(dest_dir, exist_ok=True)
    url = f"{BACKEND}/api/preview/attachment?path={urllib.parse.quote(target)}&index={index}"
    try:
        with urllib.request.urlopen(urllib.request.Request(url), timeout=180) as resp:
            data = resp.read()
            disposition = resp.headers.get("Content-Disposition", "")
            name = ""
            if "filename*=UTF-8''" in disposition:
                name = urllib.parse.unquote(disposition.split("filename*=UTF-8''")[1].split(";")[0].strip())
            if not name:
                name = os.path.basename(target)
            out_path = os.path.join(dest_dir, name)
            with open(out_path, "wb") as f:
                f.write(data)
            return f"Saved attachment to {out_path} ({len(data)} bytes)"
    except urllib.error.HTTPError as exc:
        try:
            detail = json.loads(exc.read().decode("utf-8"))
            error = detail.get("error", str(exc))
        except Exception:
            error = str(exc)
        return f"Error downloading attachment: {error}"
    except Exception as exc:
        return f"Error downloading attachment: {exc}"


def _post(payload):
    req = urllib.request.Request(
        f"{BACKEND}/api/preview/edit",
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=300) as resp:
            return json.loads(resp.read().decode("utf-8")), None
    except urllib.error.HTTPError as exc:
        try:
            detail = json.loads(exc.read().decode("utf-8"))
            return None, detail.get("error", str(exc))
        except Exception:
            return None, str(exc)
    except Exception as exc:
        return None, str(exc)


@mcp.tool()
def edit_document(path: str, operations: list) -> str:
    """Edit an Office document (docx/doc/xlsx/xls/pptx/ppt) in place and save it. operations is a JSON list of edit operations, applied in order. Supported ops:
      - {"op":"replace","find":str,"replace":str,"occurrence":n}  replace text (occurrence: 0/none = all, or the nth match)
      - {"op":"insert_after","find":str,"text":str,"occurrence":n}  insert text right after the matched paragraph/cell (default 1st match)
      - {"op":"insert_before","find":str,"text":str,"occurrence":n}  insert text right before the matched paragraph/cell
      - {"op":"append","text":str}   add a paragraph/row/slide with the text at the end of the document
      - {"op":"prepend","text":str}  add text at the very beginning
      - {"op":"delete","find":str,"occurrence":n}  remove the matched text
    Returns a per-operation applied summary."""
    target = _resolve(path)
    body, err = _post({"path": target, "operations": operations})
    if err:
        return f"Error editing document: {err}"
    results = body.get("results", [])
    summary = ", ".join(
        f"{r.get('op')}={'ok' if r.get('applied') else 'no-match'}" for r in results
    )
    return f"Edited {body.get('fileName', target)}. {summary}"


if __name__ == "__main__":
    mcp.run(transport="stdio")
