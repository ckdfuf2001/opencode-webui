import json
import os
import urllib.request

from fastmcp import FastMCP

BACKEND = os.environ.get("OPCODE_WEBUI_BACKEND", "http://127.0.0.1:5001")
WORKSPACE = os.environ.get("OPCODE_WEBUI_WORKSPACE", os.path.join(os.getcwd(), "workspace"))

mcp = FastMCP(
    "opencode-doc-reader",
    instructions=(
        "Use read_document to extract the text content of office and PDF files "
        "(docx, doc, xlsx, xls, pptx, ppt, pdf), including DRM-protected files. "
        "Pass the absolute file path on this machine."
    ),
)


def _resolve(path_value):
    if os.path.isabs(path_value):
        return path_value
    return os.path.join(os.path.abspath(WORKSPACE), path_value)


@mcp.tool()
def read_document(path: str) -> str:
    """Extract readable text from an Office/PDF file (docx, doc, xlsx, xls, pptx, ppt, pdf). Returns the document text for analysis. Accepts an absolute path or a path relative to the workspace."""
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


if __name__ == "__main__":
    mcp.run(transport="stdio")
