"""Render the three-card summary in light and dark, English and Chinese."""
from pathlib import Path
from xml.sax.saxutils import escape
from make_hero import THEMES, SANS

CARDS = {
    "en": dict(title="What AI Assistant Suite does",
               desc="Suggest: title, summary, tags, a folder and tidier text. Review: untick anything; only ticked rows are written. Your model: DeepSeek, Qwen, Gemini, any OpenAI-compatible service, or a local model.",
               cards=[("Suggest", "Title, tags, folder, tidier text.", "spark"),
                      ("Review", "Only ticked rows are written.", "check"),
                      ("Your model", "Cloud key or local. Undo any time.", "plug")]),
    "zh": dict(title="AI Assistant Suite 能做什么",
               desc="一键建议：标题、摘要、标签、文件夹、整理正文。逐项审核：取消不要的，只写入勾选的。用你的模型：DeepSeek、通义千问、Gemini、任何 OpenAI 兼容服务，或本地模型。",
               cards=[("一键建议", "标题、标签、文件夹、整理正文。", "spark"),
                      ("逐项审核", "只写入你勾选的那几项。", "check"),
                      ("用你的模型", "云端密钥或本地模型，随时撤销。", "plug")]),
}


def glyph(kind, x, y, c):
    a = c["accent"]
    if kind == "spark":
        return (f'<path d="M{x+24} {y+11} L{x+27} {y+21} L{x+37} {y+24} L{x+27} {y+27} L{x+24} {y+37} L{x+21} {y+27} L{x+11} {y+24} L{x+21} {y+21} Z" fill="{a}"/>'
                f'<circle cx="{x+36}" cy="{y+13}" r="2.5" fill="{a}"/>')
    if kind == "check":
        rows = []
        for j, on in enumerate((True, True, False)):
            cy = y + 14 + j * 10
            rows.append(f'<circle cx="{x+15}" cy="{cy}" r="3.5" fill="{a if on else "none"}" stroke="{a if on else c["muted"]}" stroke-width="1.6"/>')
            rows.append(f'<rect x="{x+22}" y="{cy-2}" width="{16 if on else 12}" height="4" rx="2" fill="{c["fg"] if on else c["muted"]}" opacity="{0.75 if on else 0.6}"/>')
        return "".join(rows)
    return (f'<rect x="{x+13}" y="{y+16}" width="22" height="14" rx="5" fill="none" stroke="{a}" stroke-width="2.6"/>'
            f'<path d="M{x+19} {y+16} V{y+10} M{x+29} {y+16} V{y+10} M{x+24} {y+30} V{y+38}" stroke="{a}" stroke-width="2.6" stroke-linecap="round"/>')


def render(c, t):
    parts = ['<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="190" viewBox="0 0 1200 190" role="img" aria-labelledby="t d">',
             f'<title id="t">{escape(t["title"])}</title>',
             f'<desc id="d">{escape(t["desc"])}</desc>',
             f'<g font-family="{SANS}">']
    for i, (title, body, kind) in enumerate(t["cards"]):
        x = 24 + i * 392
        parts.append(f'<rect x="{x}" y="16" width="368" height="158" rx="22" fill="{c["bg"]}" stroke="{c["line"]}"/>')
        parts.append(f'<rect x="{x+28}" y="44" width="48" height="48" rx="14" fill="{c["accent_soft"]}"/>')
        parts.append(glyph(kind, x + 28, 44, c))
        parts.append(f'<text x="{x+96}" y="78" font-size="27" font-weight="700" fill="{c["fg"]}">{escape(title)}</text>')
        parts.append(f'<text x="{x+28}" y="138" font-size="20" fill="{c["muted"]}">{escape(body)}</text>')
    parts.append('</g></svg>\n')
    return "\n".join(parts)


out = Path(__file__).resolve().parent.parent
for lang, t in CARDS.items():
    for name, c in THEMES.items():
        stem = f"cards-{name}" if lang == "en" else f"cards-{lang}-{name}"
        (out / f"{stem}.svg").write_text(render(c, t), encoding="utf-8")
        print("wrote", f"{stem}.svg")
