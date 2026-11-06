"""Turn recorded keyframes into the README demo: a cursor, click feedback and a camera that follows the action.

    python3 make_demo.py <frames dir> <light|dark> <out.gif>

The frames dir holds start / wait / review / untick / done screenshots (2x) and boxes.json (CSS px).
The suggestions in them come from a real model call.
"""
import json
import sys
from pathlib import Path
from PIL import Image, ImageDraw, ImageFilter

BG = {"light": (247, 246, 251), "dark": (21, 20, 27)}
PAGE = {"light": (255, 255, 255), "dark": (13, 17, 23)}  # GitHub page outside the rounded card
LINE = {"light": (228, 225, 238), "dark": (44, 42, 54)}
ACCENT = {"light": (122, 90, 240), "dark": (164, 139, 255)}
RED = {"light": (201, 58, 64), "dark": (240, 124, 128)}
W, PAD, RADIUS, CROP_LEFT, SCALE = 1200, 40, 22, 88, 2


def smooth(t):
    return t * t * (3 - 2 * t)


class Film:
    def __init__(self, mode, size):
        self.mode, self.frames, self.durations = mode, [], []
        sw, sh = size
        self.full = (CROP_LEFT, 0, sw, sh)
        self.aspect = (sw - CROP_LEFT) / sh
        self.inner = W - 2 * PAD
        self.height = round(self.inner / self.aspect)

    def cam(self, x, y, w):
        return (x, y, x + w, y + w / self.aspect)

    def around(self, box, w):
        """Camera of width w centred on a screenshot-px box, kept inside the window."""
        cx, cy = (box[0] + box[2]) / 2, (box[1] + box[3]) / 2
        h = w / self.aspect
        x = min(max(cx - w / 2, self.full[0]), self.full[2] - w)
        y = min(max(cy - h / 2, 0), self.full[3] - h)
        return self.cam(x, y, w)

    @staticmethod
    def mix(a, b, t):
        return tuple(p + (q - p) * t for p, q in zip(a, b))

    def to_out(self, cam, x, y):
        s = self.inner / (cam[2] - cam[0])
        return PAD + (x - cam[0]) * s, PAD + (y - cam[1]) * s

    def add(self, shot, cam, ms, cursor=None, ripple=None, ring=None, ring_color=None):
        crop = shot.crop(tuple(round(v) for v in cam)).resize((self.inner, self.height), Image.LANCZOS)
        layer = Image.new("RGBA", crop.size, (0, 0, 0, 0))
        d = ImageDraw.Draw(layer)
        if ring:
            (x0, y0), (x1, y1) = self.to_out(cam, ring[0] - 8, ring[1] - 8), self.to_out(cam, ring[2] + 8, ring[3] + 8)
            d.rounded_rectangle((x0 - PAD, y0 - PAD, x1 - PAD, y1 - PAD), 12, outline=(*ring_color, 230), width=4)
        if ripple:
            (x, y), p = self.to_out(cam, *ripple[:2]), ripple[2]
            r = 10 + 26 * p
            d.ellipse((x - PAD - r, y - PAD - r, x - PAD + r, y - PAD + r), fill=(*ACCENT[self.mode], round(110 * (1 - p))))
        if cursor:
            x, y = self.to_out(cam, *cursor)
            x, y = x - PAD, y - PAD
            pts = [(0, 0), (0, 26), (6.5, 20), (11, 30), (15.5, 28), (11, 18.5), (19, 18.5)]
            d.polygon([(x + a * 1.35, y + b * 1.35) for a, b in pts], fill=(20, 20, 24, 255), outline=(255, 255, 255, 255), width=2)
        crop = Image.alpha_composite(crop.convert("RGBA"), layer).convert("RGB")
        self.frames.append(self.frame(crop))
        self.durations.append(ms)

    def frame(self, shot):
        H = shot.height + 2 * PAD
        canvas = Image.new("RGB", (W, H), BG[self.mode])
        shadow = Image.new("L", (W, H), 0)
        ImageDraw.Draw(shadow).rounded_rectangle((PAD, PAD + 8, PAD + self.inner, PAD + shot.height + 8), RADIUS, fill=70 if self.mode == "light" else 140)
        canvas.paste((0, 0, 0) if self.mode == "dark" else (60, 50, 110), (0, 0), shadow.filter(ImageFilter.GaussianBlur(18)))
        mask = Image.new("L", shot.size, 0)
        ImageDraw.Draw(mask).rounded_rectangle((0, 0, shot.width - 1, shot.height - 1), RADIUS, fill=255)
        canvas.paste(shot, (PAD, PAD), mask)
        ImageDraw.Draw(canvas).rounded_rectangle((PAD, PAD, PAD + self.inner - 1, PAD + shot.height - 1), RADIUS, outline=LINE[self.mode], width=2)
        card = Image.new("L", (W, H), 0)
        ImageDraw.Draw(card).rounded_rectangle((0, 0, W - 1, H - 1), 28, fill=255)
        page = Image.new("RGB", (W, H), PAGE[self.mode])
        page.paste(canvas, (0, 0), card)
        return page

    def save(self, out):
        pal = [f.quantize(colors=128, method=Image.Quantize.MEDIANCUT, dither=Image.Dither.NONE) for f in self.frames]
        pal[0].save(out, save_all=True, append_images=pal[1:], duration=self.durations, loop=0, optimize=True, disposal=1)
        print(out, Path(out).stat().st_size // 1024, "KB", len(self.frames), "frames", sum(self.durations) / 1000, "s")


def main(frames_dir, mode, out):
    d = Path(frames_dir)
    boxes = {k: [v * SCALE for v in b] for k, b in json.loads((d / "boxes.json").read_text()).items()}
    shots = {}
    for f in sorted(d.glob("*.png")):
        shots.setdefault(f.stem.split("-", 1)[1], []).append(Image.open(f).convert("RGB"))
    start, waits, review, untick, done = shots["start"][0], shots["wait"], shots["review"][0], shots["untick"][0], shots["done"][0]
    film = Film(mode, start.size)
    centre = lambda b: ((b[0] + b[2]) / 2, (b[1] + b[3]) / 2)
    gen, check, apply = centre(boxes["generate"]), centre(boxes["check"]), centre(boxes["apply"])
    g = boxes["generate"]  # frame the assistant panel from its action chips down to the button
    side = film.around((g[0], g[1] - 420, g[2], g[3]), 1000)
    sheet = film.around(boxes["sheet"], 1500)
    enter = (gen[0] - 520, gen[1] + 360)

    film.add(start, film.full, 1100)  # the messy note
    for k in range(1, 9):  # camera moves in on the assistant
        film.add(start, film.mix(film.full, side, smooth(k / 8)), 55)
    for k in range(1, 11):
        film.add(start, side, 35, cursor=film.mix(enter, gen, smooth(k / 10)))
    for k in range(4):
        film.add(start, side, 45, cursor=gen, ripple=(*gen, k / 3))
    for img in waits:  # the real model is working
        film.add(img, side, 650, cursor=gen)
    for k in range(1, 9):  # the review list opens
        film.add(review, film.mix(side, sheet, smooth(k / 8)), 55)
    film.add(review, sheet, 1300)
    for k in range(1, 11):
        film.add(review, sheet, 35, cursor=film.mix(gen, check, smooth(k / 10)))
    for k in range(4):
        film.add(review, sheet, 45, cursor=check, ripple=(*check, k / 3))
    film.add(untick, sheet, 1100, cursor=check, ring=boxes["move"], ring_color=ACCENT[mode])
    for k in range(1, 11):
        film.add(untick, sheet, 35, cursor=film.mix(check, apply, smooth(k / 10)))
    for k in range(4):
        film.add(untick, sheet, 45, cursor=apply, ripple=(*apply, k / 3))
    for k in range(1, 9):  # pull back to the tidy note
        film.add(done, film.mix(sheet, film.full, smooth(k / 8)), 55)
    film.add(done, film.full, 3200)
    film.save(out)


if __name__ == "__main__":
    main(*sys.argv[1:4])
