#!/usr/bin/env python3
"""Generate the 妙境法軒 favicon, PWA icons and social share card.

Run from the repository root:

    python3 scripts/make-icons.py

Regenerates everything under public/ plus src/app/favicon.ico. The artwork is
drawn programmatically rather than stored as binary so the palette stays in one
reviewable place and the assets can be rebuilt at any resolution.

The mark is a five-petal blossom: a small golden centre with petals radiating
symmetrically around it. Petals grow *outward from a ring* around the centre;
drawing them upward from a centre at their base produces a lotus that sits low
in the frame and reads as a lopsided fan at small sizes.

Requires Pillow.
"""
from __future__ import annotations

import math
import pathlib

from PIL import Image, ImageDraw, ImageFont

# Palette from src/app/globals.css (light theme) plus petal tints.
CREAM = (247, 242, 232)
CREAM_RIM = (238, 229, 212)
GOLD = (198, 124, 19)
GOLD_SOFT = (208, 156, 80)
PETAL_EDGE = (235, 154, 176)
PETAL_FILL = (249, 193, 208)
PETAL_INNER = (252, 222, 231)
CENTER = (247, 205, 106)
CENTER_EDGE = (226, 168, 48)

SS = 4  # supersampling factor, downsampled with LANCZOS for smooth curves

ROOT = pathlib.Path(__file__).resolve().parent.parent
PUBLIC = ROOT / "public"
APP = ROOT / "src" / "app"

# CJK fonts, in preference order, for the share card wordmark.
FONT_CANDIDATES = [
    "/System/Library/Fonts/STHeiti Medium.ttc",
    "/System/Library/Fonts/STHeiti Light.ttc",
    "/System/Library/Fonts/Hiragino Sans GB.ttc",
]


def _font(size: int) -> ImageFont.FreeTypeFont:
    for path in FONT_CANDIDATES:
        if pathlib.Path(path).exists():
            return ImageFont.truetype(path, size, index=0)
    raise SystemExit("No CJK font found; install one or adjust FONT_CANDIDATES.")


def _petal_layer(s, angle_deg, length, halfwidth, offset, fill, outline, lw):
    """One teardrop petal radiating from `offset` px above centre, then rotated."""
    layer = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    cx = cy = s / 2
    base_y = cy - offset

    right, left = [], []
    steps = 60
    for i in range(steps + 1):
        t = i / steps
        x = halfwidth * math.sin(math.pi * t) * (1 - 0.25 * t)
        y = base_y - length * t
        right.append((cx + x, y))
        left.append((cx - x, y))
    d.polygon(right + left[::-1], fill=fill, outline=outline, width=lw)
    return layer.rotate(-angle_deg, resample=Image.BICUBIC, center=(cx, cy))


def blossom(size: int, rounded: bool = True, bg: bool = True) -> Image.Image:
    """Render the mark at `size` px as RGBA."""
    s = size * SS
    img = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    if bg:
        d.rounded_rectangle(
            [0, 0, s - 1, s - 1],
            radius=int(s * 0.22) if rounded else 0,
            fill=CREAM,
            outline=CREAM_RIM,
            width=max(1, int(s * 0.005)),
        )

    lw = max(1, int(s * 0.008))
    offset = s * 0.085  # petals start on a ring so the centre sits inside them
    length = s * 0.235
    halfw = s * 0.115

    for ang, fill in [
        (-144, PETAL_EDGE),
        (-72, PETAL_EDGE),
        (0, PETAL_FILL),
        (72, PETAL_FILL),
        (144, PETAL_FILL),
    ]:
        img.alpha_composite(
            _petal_layer(s, ang, length, halfw, offset, fill, GOLD_SOFT, lw)
        )
    for i in range(5):
        img.alpha_composite(
            _petal_layer(
                s,
                i * 72 + 36,
                length * 0.62,
                halfw * 0.60,
                offset * 0.75,
                PETAL_INNER,
                PETAL_EDGE,
                lw,
            )
        )

    cx = cy = s / 2
    cr = s * 0.085
    d.ellipse(
        [cx - cr, cy - cr, cx + cr, cy + cr],
        fill=CENTER,
        outline=CENTER_EDGE,
        width=lw,
    )
    return img.resize((size, size), Image.LANCZOS)


def social_card() -> Image.Image:
    """1200x630 share card: blossom on the left, wordmark on the right."""
    w, h = 1200, 630
    img = Image.new("RGB", (w, h), CREAM)
    d = ImageDraw.Draw(img)
    d.rectangle([0, h - 16, w, h], fill=GOLD)

    mark = blossom(300)
    img.paste(mark, (70, (h - 300) // 2 - 10), mark)

    x = 430
    d.text((x, 196), "妙境法軒", font=_font(128), fill=(30, 36, 43))
    d.text((x + 4, 350), "玅境長老經典講記講述", font=_font(46), fill=(96, 88, 78))
    d.rectangle([x + 6, 424, x + 120, 430], fill=GOLD)
    d.text((x + 4, 452), "fayun.org 典藏課程平台", font=_font(38), fill=(140, 128, 112))
    return img


def main() -> None:
    PUBLIC.mkdir(exist_ok=True)
    written = []

    def save(name: str, image: Image.Image) -> None:
        image.save(PUBLIC / name)
        written.append(f"public/{name} ({image.width}x{image.height})")

    # The rounded frame provides the padding that lets a maskable crop survive.
    save("icon-192.png", blossom(192))
    save("icon-512.png", blossom(512))
    save("apple-touch-icon.png", blossom(180))
    save("icon-32.png", blossom(32, rounded=False))
    save("favicon-48.png", blossom(48, rounded=False))
    save("og-image.png", social_card())

    # The framework's stock favicon.ico ships a Vercel triangle; leaving it would
    # put that mark in every browser tab. The largest size must be the base
    # image for Pillow to embed the full set.
    ico = APP / "favicon.ico"
    if ico.parent.exists():
        ico_sizes = [(16, 16), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)]
        blossom(256).convert("RGBA").save(ico, format="ICO", sizes=ico_sizes)
        written.append(f"src/app/favicon.ico ({len(ico_sizes)} sizes)")

    print("Generated:")
    for line in written:
        print(f"  {line}")


if __name__ == "__main__":
    main()
