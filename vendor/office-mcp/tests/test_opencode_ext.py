"""Fork tests: msg path helpers, embedded OOXML roundtrip, compat read/edit."""

from __future__ import annotations

import io
import os
import struct
import sys
import zipfile

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from opencode_ext import embedded as emb
from opencode_ext import msg as msgmod
from opencode_ext import compat


def make_ole10native(filename: str, payload: bytes) -> bytes:
    filepath = f"C:\\temp\\{filename}".encode() + b"\x00"
    head = struct.pack("<I", 0) + b"\x00\x00" + filename.encode() + b"\x00" + filepath
    head += struct.pack("<I", 0) + struct.pack("<I", len(payload))
    total = struct.pack("<I", len(head) + len(payload) - 4)
    return total + head[4:] + payload


def make_xlsx_with_embedding(path: str, inner_name: str, inner_data: bytes) -> None:
    from openpyxl import Workbook

    wb = Workbook()
    wb.active["A1"] = "hello embedded test"
    wb.save(path)
    # inject embeddings/*.bin as Ole10Native-carrying OLE? For headless test we
    # store the raw native block; list_embedded must still surface it.
    native = make_ole10native(inner_name, inner_data)
    with zipfile.ZipFile(path, "a") as zf:
        zf.writestr("xl/embeddings/oleObject1.bin", native)


def test_parse_ole10native_roundtrip() -> None:
    payload = "embedded-doc-bytes".encode()
    name, out = emb.parse_ole10native(make_ole10native("note.txt", payload))
    assert name == "note.txt"
    assert out == payload


def test_embedded_list_and_extract_xlsx(tmp_path) -> None:
    xlsx = str(tmp_path / "sample.xlsx")
    make_xlsx_with_embedding(xlsx, "inner.txt", "inner-bytes".encode())
    entries = emb.list_embedded(xlsx)
    assert len(entries) == 1
    assert entries[0]["container"] == "ooxml"
    out = emb.extract_embedded(xlsx, 0, str(tmp_path / "out"))
    assert os.path.isfile(out)
    assert open(out, "rb").read() == "inner-bytes".encode()


def test_embedded_empty_for_plain_xlsx(tmp_path) -> None:
    from openpyxl import Workbook

    xlsx = str(tmp_path / "plain.xlsx")
    wb = Workbook()
    wb.active["A1"] = "plain"
    wb.save(xlsx)
    assert emb.list_embedded(xlsx) == []


def test_compat_read_write_docx_xlsx_pptx(tmp_path) -> None:
    import docx
    from openpyxl import Workbook
    from pptx import Presentation

    d = str(tmp_path / "a.docx")
    doc = docx.Document()
    doc.add_paragraph("hello docx world")
    doc.save(d)
    assert "hello docx world" in compat.read_document_local(d)

    x = str(tmp_path / "b.xlsx")
    wb = Workbook()
    wb.active["A1"] = "hello xlsx world"
    wb.save(x)
    assert "hello xlsx world" in compat.read_document_local(x)

    p = str(tmp_path / "c.pptx")
    prs = Presentation()
    slide = prs.slides.add_slide(prs.slide_layouts[6])
    slide.shapes.add_textbox(0, 0, 100000, 100000).text_frame.text = "hello pptx world"
    prs.save(p)
    assert "hello pptx world" in compat.read_document_local(p)

    res = compat.edit_document_local(d, [{"op": "replace", "find": "world", "replace": "fork"}])
    assert res[0]["applied"] is True
    assert "hello docx fork" in compat.read_document_local(d)


def test_msg_path_helpers(tmp_path, monkeypatch) -> None:
    monkeypatch.setenv("OPCODE_WEBUI_REPOS", str(tmp_path))
    resolved = msgmod.resolve_path("myrepo/a.msg").replace("\\", "/")
    assert resolved.endswith("myrepo/a.msg")
    d = msgmod.default_attachment_dir("/tmp/mail/report.msg")
    assert d.endswith("report_msg")
    assert msgmod._human_size(2048) == "2.0 KB"


def test_resolve_path_heals_doubled_repo_segment(tmp_path, monkeypatch) -> None:
    # repos/doc-reader/doc-reader/chat_uploads/image.png → 한 겹 벗기기
    real = tmp_path / "doc-reader" / "chat_uploads"
    real.mkdir(parents=True)
    (real / "image.png").write_bytes(b"fake")
    monkeypatch.setenv("OPCODE_WEBUI_REPOS", str(tmp_path))
    doubled = msgmod.resolve_path("doc-reader/doc-reader/chat_uploads/image.png").replace("\\", "/")
    assert doubled.endswith("doc-reader/chat_uploads/image.png")
    assert not doubled.endswith("doc-reader/doc-reader/chat_uploads/image.png")
    # 정상 단일 경로는 그대로
    single = msgmod.resolve_path("doc-reader/chat_uploads/image.png").replace("\\", "/")
    assert single.endswith("doc-reader/chat_uploads/image.png")


def test_resolve_path_prefers_existing_primary(tmp_path, monkeypatch) -> None:
    # 진짜로 이중 디렉터리가 있으면 primary를 유지한다 (치유 오판 방지)
    nested = tmp_path / "doc-reader" / "doc-reader"
    nested.mkdir(parents=True)
    (nested / "a.txt").write_bytes(b"x")
    monkeypatch.setenv("OPCODE_WEBUI_REPOS", str(tmp_path))
    got = msgmod.resolve_path("doc-reader/doc-reader/a.txt").replace("\\", "/")
    assert got.endswith("doc-reader/doc-reader/a.txt")
