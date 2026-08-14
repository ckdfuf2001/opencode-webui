import json
import os
import urllib.error
import urllib.parse
import urllib.request

from fastmcp import FastMCP

BACKEND = os.environ.get("OPCODE_WEBUI_BACKEND", "http://127.0.0.1:5001")
WORKSPACE = os.environ.get("OPCODE_WEBUI_WORKSPACE", os.path.join(os.getcwd(), "workspace"))

mcp = FastMCP(
    "opencode-doc-reader",
    instructions=(
        "Use read_document to extract the text content of office, PDF and Outlook email files "
        "(docx, doc, xlsx, xls, pptx, ppt, pdf, msg), including DRM-protected files. "
        "For Outlook MSG emails the extracted text lists attachments and any HTTP(S) links found in the "
        "message; use download_attachment (with the 0-based Attachments index) to save an attachment to disk. "
        "Use edit_document to modify office files (docx/doc/xlsx/xls/pptx/ppt) in place. "
        "Pass absolute file paths on this machine when possible."
    ),
)


def _resolve(path_value):
    if os.path.isabs(path_value):
        return path_value
    return os.path.join(os.path.abspath(WORKSPACE), path_value)


@mcp.tool()
def read_document(path: str) -> str:
    """Extract readable text from an Office/PDF/Outlook MSG file (docx, doc, xlsx, xls, pptx, ppt, pdf, msg). Returns the document text for analysis. Accepts an absolute path or a path relative to the workspace."""
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
    return body.get("text", "")


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
