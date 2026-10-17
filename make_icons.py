from PIL import Image, ImageDraw, ImageFont
import os

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "icons")
os.makedirs(OUT, exist_ok=True)


def icon(size, maskable=False):
    im = Image.new("RGBA", (size, size), (79, 109, 245, 255))
    d = ImageDraw.Draw(im)
    pad = int(size * 0.24) if maskable else int(size * 0.16)
    w = size - 2 * pad
    h = int(w * 0.68)
    x0, y0 = pad, (size - h) // 2
    r = int(size * 0.06)
    # shadow card behind
    d.rounded_rectangle([x0 + int(w * 0.10), y0 - int(h * 0.12), x0 + w + int(w * 0.10), y0 + h - int(h * 0.12)], r, fill=(255, 255, 255, 120))
    # front card
    d.rounded_rectangle([x0, y0, x0 + w, y0 + h], r, fill=(255, 255, 255, 255))
    try:
        f = ImageFont.truetype("arialbd.ttf", int(h * 0.62))
    except Exception:
        f = ImageFont.load_default()
    t = "A"
    bb = d.textbbox((0, 0), t, font=f)
    tw, th = bb[2] - bb[0], bb[3] - bb[1]
    d.text((x0 + (w - tw) / 2 - bb[0], y0 + (h - th) / 2 - bb[1]), t, font=f, fill=(79, 109, 245, 255))
    return im


icon(192).save(os.path.join(OUT, "icon-192.png"))
icon(512).save(os.path.join(OUT, "icon-512.png"))
icon(512, True).save(os.path.join(OUT, "icon-maskable-512.png"))
print(sorted(os.listdir(OUT)))
