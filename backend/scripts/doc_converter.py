import hashlib
import json
import os
import sys
import tempfile
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse

CACHE_DIR = os.path.join(tempfile.gettempdir(), "opencode-doc-conv")
os.makedirs(CACHE_DIR, exist_ok=True)

DOC_EXTS = {".docx", ".doc"}
XLS_EXTS = {".xlsx", ".xls"}
PPT_EXTS = {".pptx", ".ppt"}
SUPPORTED_EXTS = DOC_EXTS | XLS_EXTS | PPT_EXTS


def cache_path(source_path):
    try:
        st = os.stat(source_path)
        key = f"{st.st_mtime_ns}:{st.st_size}:{os.path.abspath(source_path)}"
    except OSError:
        key = os.path.abspath(source_path)
    digest = hashlib.sha256(key.encode("utf-8")).hexdigest()
    return os.path.join(CACHE_DIR, digest + ".pdf")


def _export(source_path, tmp_path):
    import win32com.client

    ext = os.path.splitext(source_path)[1].lower()
    if ext in DOC_EXTS:
        app = win32com.client.DispatchEx("Word.Application")
        try:
            app.Visible = False
            app.DisplayAlerts = False
            doc = app.Documents.Open(source_path, ReadOnly=True)
            try:
                doc.SaveAs(tmp_path, FileFormat=17)
            finally:
                doc.Close(False)
        finally:
            app.Quit()
    elif ext in XLS_EXTS:
        app = win32com.client.DispatchEx("Excel.Application")
        try:
            app.Visible = False
            app.DisplayAlerts = False
            wb = app.Workbooks.Open(source_path, ReadOnly=True)
            try:
                for ws in wb.Worksheets:
                    ws.PageSetup.PrintHeadings = True
                    ws.PageSetup.PrintGridlines = True
                    ws.PageSetup.Zoom = False
                    ws.PageSetup.FitToPagesWide = 1
                    ws.PageSetup.FitToPagesTall = False
                wb.ExportAsFixedFormat(0, tmp_path)
            finally:
                wb.Close(False)
        finally:
            app.Quit()
    elif ext in PPT_EXTS:
        app = win32com.client.DispatchEx("PowerPoint.Application")
        try:
            pres = app.Presentations.Open(source_path, ReadOnly=True, WithWindow=False)
            try:
                pres.SaveAs(tmp_path, 32)
            finally:
                pres.Close()
        finally:
            app.Quit()


def convert(source_path, refresh=False):
    ext = os.path.splitext(source_path)[1].lower()
    if ext not in SUPPORTED_EXTS:
        raise ValueError(f"Unsupported document type: {ext}")

    out_path = cache_path(source_path)
    if refresh:
        try:
            os.remove(out_path)
        except OSError:
            pass
    if os.path.exists(out_path):
        return out_path, True

    import pythoncom

    tmp_path = out_path[:-4] + ".conv.pdf"
    pythoncom.CoInitialize()
    try:
        _export(source_path, tmp_path)
    finally:
        pythoncom.CoUninitialize()

    if not os.path.exists(tmp_path):
        raise RuntimeError("Conversion produced no output")
    os.replace(tmp_path, out_path)
    return out_path, False


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        sys.stderr.write("[doc-converter] " + (fmt % args) + "\n")

    def _json(self, code, obj):
        body = json.dumps(obj).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        parsed = urlparse(self.path)
        if parsed.path == "/health":
            self._json(200, {"ok": True})
        else:
            self._json(404, {"error": "Not found"})

    def do_POST(self):
        parsed = urlparse(self.path)
        if parsed.path != "/convert":
            self._json(404, {"error": "Not found"})
            return
        try:
            length = int(self.headers.get("Content-Length") or 0)
            payload = json.loads(self.rfile.read(length) or b"{}")
            source_path = payload.get("path")
            if not source_path or not os.path.isfile(source_path):
                self._json(400, {"error": "Invalid path"})
                return
            refresh = bool(payload.get("refresh"))
            pdf_path, cached = convert(source_path, refresh)
            self._json(200, {"pdfPath": pdf_path, "cached": cached})
        except Exception as exc:
            self._json(500, {"error": str(exc)})


def main():
    port = int(os.environ.get("DOC_CONVERTER_PORT", "8765"))
    server = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    server.serve_forever()


if __name__ == "__main__":
    main()
