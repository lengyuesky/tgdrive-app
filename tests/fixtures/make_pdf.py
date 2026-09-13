"""可选的合成 PDF 再生成工具；正常测试直接使用已生成的 PDF，不依赖 Python。"""
from pathlib import Path
from tempfile import TemporaryDirectory
import sys
from fontTools.ttLib import TTFont
from fpdf import FPDF

font_path = Path(sys.argv[1] if len(sys.argv) > 1 else "/usr/share/fonts/noto-cjk/NotoSansCJK-Regular.ttc")
output = Path(__file__).with_name("chinese.pdf")
with TemporaryDirectory(prefix="tgdrive-pdf-font-") as temporary:
    font = TTFont(font_path, fontNumber=0)
    converted = Path(temporary) / "fixture.otf"
    font.save(converted)
    pdf = FPDF()
    pdf.set_title("中文阅读验收")
    pdf.set_author("tgdrive 合成测试")
    pdf.add_font("fixture", fname=str(converted))
    for page in range(1, 4):
        pdf.add_page()
        pdf.start_section(f"第 {page} 页")
        pdf.set_font("fixture", size=24)
        pdf.multi_cell(0, 14, f"中文阅读验收\n第 {page} 页\n图书与漫画：书签、目录、继续阅读。")
        pdf.set_fill_color(40 + page * 35, 100, 150)
        pdf.rect(20, 100, 160, 70, style="F")
    pdf.output(output)
print(f"已生成合成 PDF：{output}")
