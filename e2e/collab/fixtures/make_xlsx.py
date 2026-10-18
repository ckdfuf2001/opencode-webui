"""
공동편집 검증용 XLSX fixture 생성기.

가이드 4번: 시트 2개, 차트, PNG 그림, 메모, 조건부서식 2개, 데이터 유효성,
병합, 틀고정, defined name를 넣는다. fixture 자체의 census에 0인 항목이 있으면
X0a가 실패 처리한다.

사용: python e2e/collab/fixtures/make_xlsx.py
출력: e2e/collab/fixtures/collab-features.xlsx (커밋 대상)
"""

import base64
import os
import struct
import zlib

from openpyxl import Workbook
from openpyxl.chart import BarChart, Reference
from openpyxl.comments import Comment
from openpyxl.drawing.image import Image as XLImage
from openpyxl.formatting.rule import CellIsRule, FormulaRule
from openpyxl.styles import Font, PatternFill
from openpyxl.worksheet.datavalidation import DataValidation
from openpyxl.worksheet.table import Table, TableStyleInfo
from openpyxl.workbook.defined_name import DefinedName

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "collab-features.xlsx")


def _png(width: int, height: int, rgb: tuple[int, int, int]) -> bytes:
    """외부 파일 의존 없이 쓰는 최소 PNG (테스트 픽셀 하나)."""

    def chunk(tag: bytes, data: bytes) -> bytes:
        return (
            struct.pack(">I", len(data))
            + tag
            + data
            + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)
        )

    raw = b"".join(b"\x00" + bytes(rgb) * width for _ in range(height))
    return (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0))
        + chunk(b"IDAT", zlib.compress(raw, 9))
        + chunk(b"IEND", b"")
    )


def build() -> str:
    wb = Workbook()

    # --- 시트 1: 데이터 + 차트 + 그림 + 메모 + 조건부서식 2 + 유효성 + 병합 + 틀고정 ---
    ws = wb.active
    ws.title = "Data"

    ws["A1"] = "Item"
    ws["B1"] = "Amount"
    ws["C1"] = "Note"
    for c in ("A1", "B1", "C1"):
        ws[c].font = Font(bold=True, color="FFFFFF")
        ws[c].fill = PatternFill("solid", fgColor="305496")

    rows = [
        ("Alpha", 120, "first"),
        ("Bravo", 80, "second"),
        ("Charlie", 200, "third"),
        ("Delta", 45, "fourth"),
        ("Echo", 160, "fifth"),
    ]
    for i, (name, amount, note) in enumerate(rows, start=2):
        ws[f"A{i}"] = name
        ws[f"B{i}"] = amount
        ws[f"C{i}"] = note
    last = 1 + len(rows)

    # 조건부서식 2개 (요구사항: 정확히 2)
    ws.conditional_formatting.add(
        f"B2:B{last}",
        CellIsRule(operator="greaterThan", formula=["100"], font=Font(bold=True, color="006100")),
    )
    ws.conditional_formatting.add(
        f"A2:A{last}",
        FormulaRule(formula=[f'ISNUMBER(SEARCH("a",A2))'], fill=PatternFill("solid", fgColor="C6EFCE")),
    )

    # 데이터 유효성
    dv = DataValidation(type="list", formula1='"Low,Medium,High"', allow_blank=True)
    ws.add_data_validation(dv)
    dv.add(f"C2:C{last}")

    # 병합
    ws.merge_cells("A1:A1")  # 단일 셀 병합은 무의미하므로 헤더 옆에 실제 병합을 둔다
    ws.unmerge_cells("A1:A1")
    ws.merge_cells(start_row=last + 2, start_column=1, end_row=last + 2, end_column=3)
    ws[f"A{last + 2}"] = "merged footer row"

    # 틀고동 (freeze panes)
    ws.freeze_panes = "B2"

    # 하이퍼링크 (요소 census 항목)
    ws[f"C{last + 3}"] = "문서 링크"
    ws[f"C{last + 3}"].hyperlink = "https://example.invalid/collab-spec"

    # 표 (part census: tables)
    table = Table(displayName="AmountTable", ref=f"A1:C{last}")
    table.tableStyleInfo = TableStyleInfo(
        name="TableStyleMedium2", showRowStripes=True, showColumnStripes=False
    )
    ws.add_table(table)

    # 메모 (threaded 아님 — 기본 comment)
    ws["C2"].comment = Comment("이 셀에 메모가 있습니다", "ada")

    # 차트
    chart = BarChart()
    chart.title = "Amount by Item"
    data = Reference(ws, min_col=2, min_row=1, max_row=last)
    cats = Reference(ws, min_col=1, min_row=2, max_row=last)
    chart.add_data(data, titles_from_data=True)
    chart.set_categories(cats)
    chart.height = 7
    chart.width = 12
    ws.add_chart(chart, "E2")

    # PNG 그림
    png = os.path.join(HERE, "_tmp_pixel.png")
    with open(png, "wb") as fh:
        fh.write(_png(24, 24, (200, 60, 90)))
    img = XLImage(png)
    img.width = 48
    img.height = 48
    ws.add_image(img, "E20")
    # XLImage는 저장 시점에 파일을 읽으므로 여기서 지우면 안 된다.

    # --- 시트 2 ---
    ws2 = wb.create_sheet("Summary")
    ws2["A1"] = "Summary"
    ws2["A1"].font = Font(bold=True, size=14)
    ws2["A2"] = "Total"
    ws2["B2"] = "=SUM(Data!B2:B{0})".format(last)
    ws2["A3"] = "Average"
    ws2["B3"] = "=AVERAGE(Data!B2:B{0})".format(last)
    ws2.freeze_panes = "A2"

    # defined name
    wb.defined_names.add(DefinedName("AmountRange", attr_text=f"Data!$B$2:$B${last}"))

    wb.save(OUT)
    if os.path.exists(png):
        os.remove(png)
    return OUT


if __name__ == "__main__":
    path = build()
    print(f"wrote {path} ({os.path.getsize(path)} bytes)")