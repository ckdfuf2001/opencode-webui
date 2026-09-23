"""opencode-webui fork extensions for office-mcp.

File-based tools that work without a running Office instance:

- ``msg``: Outlook .msg reading + attachment handling (our unique feature,
  ported from backend/scripts/doc_converter.py so the fork keeps it).
- ``embedded``: list / extract files embedded as OLE packages inside
  xlsx/xls/pptx/ppt/docx/doc (OOXML embeddings + legacy OLE streams).
- ``compat``: drop-in ``read_document`` / ``edit_document`` /
  ``download_attachment`` that first try the local implementation and fall
  back to the opencode-webui backend (gradual migration) when
  OPCODE_WEBUI_BACKEND is set.
"""

from opencode_ext.msg import (
    default_attachment_dir,
    extract_attachment_bytes,
    list_attachments,
    read_msg,
    resolve_path,
)
from opencode_ext.embedded import extract_embedded, list_embedded

__all__ = [
    "default_attachment_dir",
    "extract_attachment_bytes",
    "extract_embedded",
    "list_attachments",
    "list_embedded",
    "read_msg",
    "resolve_path",
]
