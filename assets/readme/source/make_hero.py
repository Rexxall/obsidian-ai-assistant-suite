"""Render the README hero in light and dark, English and Chinese, from one layout."""
from pathlib import Path
from xml.sax.saxutils import escape

THEMES = {
    "light": dict(bg="#F7F6FB", fg="#1D1B26", muted="#6B6780", line="#E4E1EE",
                  card="#FFFFFF", accent="#7A5AF0", accent_soft="#EEE9FF", on_accent="#FFFFFF",
                  green="#22855A", green_soft="#E5F4EC", amber="#B4631A", amber_soft="#FBEEDF"),
    "dark": dict(bg="#15141B", fg="#EEECF5", muted="#9C98AF", line="#2C2A36",
                 card="#1E1D26", accent="#A48BFF", accent_soft="#2C2643", on_accent="#15141B",
                 green="#5CC892", green_soft="#16301F", amber="#F0A866", amber_soft="#3A2A1A"),
}
SANS = "-apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', 'Hiragino Sans GB', sans-serif"
MONO = "ui-monospace, SFMono-Regular, Menlo, monospace"

TEXT = {
    "en": dict(
        title="AI Assistant Suite",
        desc="Turn a messy note into a tidy one. The AI suggests a title, tags, a folder and cleaner text; you untick what you do not want and apply the rest. A review list for “team sync notes.md” has the title, tags and tidied text ticked, the folder move unticked, and an Apply 3 button.",
        eyebrow="OBSIDIAN PLUGIN · NOTHING CHANGES UNTIL YOU APPLY",
        line1="Messy note in, tidy note out.", line2="You tick what gets written.",
        small="free · your key or a local model · undo any time",
        panel="Review AI suggestions", file="team sync notes.md",
        rows=[("Title", "Team sync: launch moves to the 28th", "New", "on"),
              ("Tags", "#meeting  #launch  #todo", "New 3", "on"),
              ("Text", "Decisions, to-dos, next sync", "Change", "on"),
              ("Move to folder", "→ Meetings", "Move", "off")],
        apply="Apply 3"),
    "zh": dict(
        title="AI Assistant Suite",
        desc="把一篇乱笔记整理整齐。AI 给出标题、标签、文件夹和更清楚的正文，你取消不要的那项，其余一键应用。图中“team sync notes.md”的审核清单里，标题、标签、整理正文已勾选，移动文件夹没勾，按钮是“应用 3 项”。",
        eyebrow="OBSIDIAN 插件 · 不点应用，一个字都不改",
        line1="乱笔记进去，整齐笔记出来。", line2="写进什么，由你勾选。",
        small="免费 · 自己的密钥或本地模型 · 随时撤销",
        panel="审核 AI 建议", file="team sync notes.md",
        rows=[("标题", "团队周会：上线改到 28 号", "新增", "on"),
              ("标签", "#会议  #上线  #待办", "新增 3", "on"),
              ("正文", "决定、待办、下次周会", "修改", "on"),
              ("移动到文件夹", "→ 会议", "移动", "off")],
        apply="应用 3 项"),
}


def chip_width(label):
    return 16 + sum(17 if ord(ch) > 0x2E80 else 9.5 for ch in label)


def render(c, t):
    e = {k: escape(v) if isinstance(v, str) else v for k, v in t.items()}
    out = [f'<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="400" viewBox="0 0 1200 400" role="img" aria-labelledby="t d">',
           f'  <title id="t">{e["title"]}</title>',
           f'  <desc id="d">{e["desc"]}</desc>',
           f'  <rect width="1200" height="400" rx="28" fill="{c["bg"]}"/>',
           f'  <g id="title-block" font-family="{SANS}">',
           f'    <text x="64" y="118" font-family="{MONO}" font-size="16" letter-spacing="2" fill="{c["accent"]}">{e["eyebrow"]}</text>',
           f'    <text x="62" y="194" font-size="58" font-weight="700" letter-spacing="-1.5" fill="{c["fg"]}">{e["title"]}</text>',
           f'    <text x="64" y="250" font-size="29" fill="{c["fg"]}">{e["line1"]}</text>',
           f'    <text x="64" y="290" font-size="29" fill="{c["muted"]}">{e["line2"]}</text>',
           f'    <text x="64" y="346" font-family="{MONO}" font-size="16" fill="{c["muted"]}">{e["small"]}</text>',
           '  </g>',
           f'  <g id="project-proof" font-family="{SANS}">',
           f'    <rect x="700" y="40" width="440" height="320" rx="20" fill="{c["card"]}" stroke="{c["line"]}"/>',
           f'    <text x="724" y="80" font-size="20" font-weight="700" fill="{c["fg"]}">{e["panel"]}</text>',
           f'    <text x="724" y="104" font-size="15" fill="{c["muted"]}">{e["file"]}</text>']
    for i, (label, detail, chip, state) in enumerate(t["rows"]):
        y = 114 + i * 48
        on = state == "on"
        if i:
            out.append(f'    <path d="M724 {y} H1116" stroke="{c["line"]}"/>')
        cy = y + 25
        if on:
            out.append(f'    <circle cx="738" cy="{cy}" r="11" fill="{c["accent"]}"/>')
            out.append(f'    <path d="M733 {cy} l3.5 3.5 l6.5 -7" fill="none" stroke="{c["on_accent"]}" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/>')
        else:
            out.append(f'    <circle cx="738" cy="{cy}" r="10" fill="none" stroke="{c["muted"]}" stroke-width="2"/>')
        tone = c["fg"] if on else c["muted"]
        out.append(f'    <text x="762" y="{cy - 4}" font-size="17" font-weight="600" fill="{tone}">{escape(label)}</text>')
        out.append(f'    <text x="762" y="{cy + 16}" font-size="14" fill="{c["muted"]}">{escape(detail)}</text>')
        w = chip_width(chip)
        fill, ink = ((c["accent_soft"], c["accent"]) if chip.startswith(("New", "新增")) else
                     (c["green_soft"], c["green"]) if on else (c["amber_soft"], c["amber"]))
        if not on:
            fill, ink = c["bg"], c["muted"]
        out.append(f'    <rect x="{1116 - w}" y="{cy - 12}" width="{w}" height="24" rx="12" fill="{fill}"/>')
        out.append(f'    <text x="{1116 - w / 2}" y="{cy + 5}" font-size="14" text-anchor="middle" fill="{ink}">{escape(chip)}</text>')
    bw = chip_width(t["apply"]) + 22
    out.append(f'    <rect x="{1116 - bw}" y="318" width="{bw}" height="30" rx="15" fill="{c["accent"]}"/>')
    out.append(f'    <text x="{1116 - bw / 2}" y="338" font-size="15" font-weight="600" text-anchor="middle" fill="{c["on_accent"]}">{escape(t["apply"])}</text>')
    out += ['  </g>', '</svg>', '']
    return "\n".join(out)


if __name__ == "__main__":
    out = Path(__file__).resolve().parent.parent
    for lang, t in TEXT.items():
        for name, c in THEMES.items():
            stem = f"hero-{name}" if lang == "en" else f"hero-{lang}-{name}"
            (out / f"{stem}.svg").write_text(render(c, t), encoding="utf-8")
            print("wrote", f"{stem}.svg")
