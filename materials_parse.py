"""
@local/research-core/materials_parse.py — 本地材料解析助手（03 阶段）

只做"把文件变成带位置的文本块/表格"这一件事，不联网、不写文件、不执行材料内容。
由 materials.mjs 通过宿主本机 Python 调用；缺库或加密/损坏时返回 ok:false + reason，
让调用方把它标成"未覆盖"，而不是悄悄当成空文件。

用法：
  python materials_parse.py --file <path> --json
输出（stdout 最后一段 JSON）：
  {"ok":true,"kind":"docx","blocks":[...],"tables":[...]}
  {"ok":false,"reason":"encrypted|corrupt|unsupported|needs_ocr|too_large","error":"..."}
"""

import json
import os
import sys

MAX_BLOCKS = 20000
MAX_CELL = 4000


def emit(payload):
    sys.stdout.write('===JSON===' + json.dumps(payload, ensure_ascii=False))
    sys.stdout.flush()


def block(text, **ref):
    text = (text or "").strip()
    if not text:
        return None
    if len(text) > MAX_CELL:
        text = text[:MAX_CELL] + "…"
    row = {"kind": "paragraph", "text": text}
    row.update({key: value for key, value in ref.items() if value is not None})
    return row


def parse_docx(path):
    try:
        import docx
    except Exception as error:  # noqa: BLE001
        return {"ok": False, "reason": "parser_unavailable", "error": "python-docx: %s" % error}
    try:
        document = docx.Document(path)
    except Exception as error:  # noqa: BLE001
        message = str(error)
        reason = "encrypted" if "encrypt" in message.lower() else "corrupt"
        return {"ok": False, "reason": reason, "error": message}
    blocks = []
    tables = []
    for index, paragraph in enumerate(document.paragraphs):
        entry = block(paragraph.text, paragraph=index, style=(paragraph.style.name if paragraph.style is not None else None))
        if entry:
            blocks.append(entry)
        if len(blocks) >= MAX_BLOCKS:
            break
    for table_index, table in enumerate(document.tables):
        rows = []
        for row in table.rows:
            cells = [(cell.text or "").strip() for cell in row.cells]
            if any(cells):
                rows.append(cells)
        if rows:
            tables.append({"ref": {"table": table_index}, "rows": rows[:1000]})
    if not blocks and not tables:
        return {"ok": False, "reason": "corrupt", "error": "文档没有可读段落或表格"}
    return {"ok": True, "kind": "docx", "blocks": blocks, "tables": tables}


def parse_xlsx(path):
    try:
        import openpyxl
    except Exception as error:  # noqa: BLE001
        return {"ok": False, "reason": "parser_unavailable", "error": "openpyxl: %s" % error}
    try:
        workbook = openpyxl.load_workbook(path, read_only=True, data_only=True)
    except Exception as error:  # noqa: BLE001
        message = str(error)
        reason = "encrypted" if "encrypt" in message.lower() else "corrupt"
        return {"ok": False, "reason": reason, "error": message}
    tables = []
    blocks = []
    try:
        for sheet in workbook.worksheets:
            rows = []
            for row_index, row in enumerate(sheet.iter_rows(values_only=True)):
                cells = ["" if value is None else str(value) for value in row]
                if any(cell.strip() for cell in cells):
                    rows.append(cells)
                if len(rows) >= 5000:
                    break
            if rows:
                tables.append({"ref": {"sheet": sheet.title}, "rows": rows})
                blocks.append(block("%s：%d 行" % (sheet.title, len(rows)), sheet=sheet.title))
    finally:
        try:
            workbook.close()
        except Exception:  # noqa: BLE001
            pass
    if not tables:
        return {"ok": False, "reason": "corrupt", "error": "工作簿没有可读单元格"}
    return {"ok": True, "kind": "xlsx", "blocks": blocks, "tables": tables}


def parse_pdf(path):
    try:
        import fitz  # pymupdf
    except Exception as error:  # noqa: BLE001
        return {"ok": False, "reason": "parser_unavailable", "error": "pymupdf: %s" % error}
    try:
        document = fitz.open(path)
    except Exception as error:  # noqa: BLE001
        message = str(error)
        reason = "encrypted" if "encrypt" in message.lower() or "password" in message.lower() else "corrupt"
        return {"ok": False, "reason": reason, "error": message}
    blocks = []
    pages_with_text = 0
    try:
        if document.needs_pass:
            return {"ok": False, "reason": "encrypted", "error": "PDF 需要密码"}
        for page_index in range(document.page_count):
            page = document.load_page(page_index)
            text = page.get_text("text") or ""
            if text.strip():
                pages_with_text += 1
            for line_index, line in enumerate(text.splitlines()):
                entry = block(line, page=page_index + 1, line=line_index + 1)
                if entry:
                    blocks.append(entry)
                if len(blocks) >= MAX_BLOCKS:
                    break
            if len(blocks) >= MAX_BLOCKS:
                break
    finally:
        try:
            document.close()
        except Exception:  # noqa: BLE001
            pass
    if pages_with_text == 0 or not blocks:
        return {"ok": False, "reason": "needs_ocr", "error": "PDF 没有可提取文字（可能是扫描件）"}
    return {"ok": True, "kind": "pdf", "blocks": blocks, "tables": [], "pages": pages_with_text}


def main():
    if "--file" not in sys.argv:
        emit({"ok": False, "reason": "unsupported", "error": "缺少 --file"})
        return
    path = sys.argv[sys.argv.index("--file") + 1]
    extension = os.path.splitext(path)[1].lower()
    if not os.path.isfile(path):
        emit({"ok": False, "reason": "missing", "error": "文件不存在"})
        return
    if extension == ".docx":
        emit(parse_docx(path))
    elif extension == ".xlsx":
        emit(parse_xlsx(path))
    elif extension == ".pdf":
        emit(parse_pdf(path))
    elif extension in (".doc", ".xls", ".ppt"):
        emit({"ok": False, "reason": "legacy", "error": "旧版 Office 二进制格式未支持，请另存为 docx/xlsx"})
    else:
        emit({"ok": False, "reason": "unsupported", "error": "不支持的扩展名：%s" % extension})


if __name__ == "__main__":
    main()
