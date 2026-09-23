# office-mcp fork (opencode-webui)

Upstream: https://github.com/JulianPoleszczuk/office-mcp @ `421b1a6`
(`add Unsplash image search and insertion for PowerPoint by BerkantACUN`).

This copy lives in `vendor/office-mcp` so portable builds can ship it.
Only the files below differ from upstream; everything else (`server.py`
tool logic, `bridge/`, upstream `tests/`) is verbatim.

## Fork changes

- Bridge default port `8765` → `8766`
  (`server.py` `BRIDGE_PORT`, `bridge/main.py` `DEFAULT_PORT`).
  Reason: the existing doc-converter already listens on `8765`
  (`DOC_CONVERTER_PORT`). Env overrides still win
  (`OFFICE_BRIDGE_PORT` / `OFFICE_BRIDGE_HOST`).
- New package `opencode_ext/` (our-only features):
  - `msg.py` — Outlook `.msg` reading + attachment handling ported from
    `backend/scripts/doc_converter.py` (no COM needed, `extract-msg`).
    Tools: `msg_read`, `msg_list_attachments`, `msg_extract_attachment`.
  - `embedded.py` — list / extract files embedded as OLE packages inside
    `xlsx/xls/pptx/ppt/docx/doc` (OOXML `*/embeddings/*` + legacy OLE
    streams via `olefile`, best-effort `Ole10Native` native-name recovery).
    Tools: `embedded_list`, `embedded_extract`.
    Live documents open in Office: save first (`xl_save` / `ppt_save` /
    `doc_save`), then list — COM live enumeration is future work.
  - `compat.py` — drop-in `read_document` / `edit_document` /
    `download_attachment` (local-first: OOXML via python libs, `.msg` via
    `extract-msg`, `.pdf` via `pypdf`; legacy `.doc/.xls/.ppt` via COM when
    available, else backend fallback when `OPCODE_WEBUI_BACKEND` is set).
    This keeps existing chat/preview flows working during gradual migration.
- `server.py` registers the 8 new tools above (all return
  `{"ok": true/false, ...}` like upstream) and keeps the 129 upstream
  `ppt_*` / `xl_*` / `doc_*` tools untouched.
- `tests/test_opencode_ext.py` — fork tests (no Office needed).
- `requirements.txt` — upstream + `extract-msg`, `olefile`, `python-docx`,
  `openpyxl`, `python-pptx`, `pypdf`, `Pillow`.

## Resync with upstream

1. `git remote add upstream https://github.com/JulianPoleszczuk/office-mcp.git`
   (in a scratch clone, not here).
2. Merge upstream into the scratch clone, re-apply the port + `opencode_ext`
   import/tool-registration hunk in `server.py` (marked `OPENCODE-FORK`).
3. Copy back, run `python -m pytest -q` in `vendor/office-mcp`
   (367 upstream + fork tests, no Office needed).
