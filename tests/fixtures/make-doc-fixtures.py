"""
生成 03 验收用的合成材料（不是真实研究材料）。
由 tests/materials.test.mjs 调用：python make-doc-fixtures.py <输出目录>
"""
import os
import sys

out = sys.argv[1]
os.makedirs(out, exist_ok=True)


def p(name):
    return os.path.join(out, name)


import docx

document = docx.Document()
document.add_heading("合成实验流程（虚构）", 0)
document.add_paragraph("访视：基线")
document.add_paragraph("访视：一周随访")
document.add_paragraph("任务：体验问卷")
document.add_paragraph("量表：花园量表 10 题")
table = document.add_table(rows=2, cols=2)
table.cell(0, 0).text = "编号"
table.cell(0, 1).text = "性别"
table.cell(1, 0).text = "P-001"
table.cell(1, 1).text = "女"
document.save(p("flow.docx"))

import openpyxl

workbook = openpyxl.Workbook()
sheet = workbook.active
sheet.title = "人口学"
sheet.append(["编号", "性别", "年龄"])
sheet.append(["P-001", "女", 20])
sheet.append(["P-002", "男", 22])
workbook.save(p("demographics.xlsx"))

import fitz

text_pdf = fitz.open()
page = text_pdf.new_page()
# 用 ASCII：内置字体不含中文字形，中文会被提取成占位符（这是测试夹具的问题，不是解析器的问题）。
page.insert_text((72, 72), "Primary outcome: state anxiety score")
page.insert_text((72, 96), "Analysis plan: paired comparison T0 vs T2")
text_pdf.save(p("plan.pdf"))
text_pdf.close()

scanned = fitz.open()
scanned.new_page()
scanned.save(p("scanned.pdf"))
scanned.close()

encrypted = fitz.open()
encrypted.new_page().insert_text((72, 72), "加密材料")
encrypted.save(p("encrypted.pdf"), encryption=fitz.PDF_ENCRYPT_AES_256, owner_pw="owner", user_pw="user")
encrypted.close()

with open(p("broken.docx"), "wb") as handle:
    handle.write(b"this is not a zip archive")

with open(p("legacy.doc"), "wb") as handle:
    handle.write(b"\xd0\xcf\x11\xe0legacy")

print("===JSON===" + '{"ok":true}')
