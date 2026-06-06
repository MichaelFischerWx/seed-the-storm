#!/usr/bin/env python3
"""Generate brand assets for Seed the Storm: a social-preview (OG) image and
app icons. Output -> assets/. Run once (re-run to regenerate)."""
import math, os
from PIL import Image, ImageDraw, ImageFont, ImageFilter

ASSETS = os.path.join(os.path.dirname(__file__), '..', 'assets')
os.makedirs(ASSETS, exist_ok=True)
ARIAL = '/System/Library/Fonts/Supplemental/Arial.ttf'
ARIALB = '/System/Library/Fonts/Supplemental/Arial Bold.ttf'
CYAN = (60, 232, 250)
INK = (235, 242, 251)
DIM = (160, 180, 210)
FAINT = (104, 124, 159)


def cyclone(draw, cx, cy, R, color, width):
    """A two-armed logarithmic swirl + eye — a hurricane glyph."""
    for arm in (0.0, math.pi):
        pts = []
        for i in range(121):
            t = i / 120.0
            th = t * 2.5 * math.pi + arm
            r = R * (1 - 0.80 * t)
            pts.append((cx + r * math.cos(th), cy + r * math.sin(th)))
        draw.line(pts, fill=color + (255,) if len(color) == 3 else color, width=width, joint='curve')
    d = width * 0.9
    draw.ellipse([cx - d, cy - d, cx + d, cy + d], fill=color + (255,) if len(color) == 3 else color)


def vgrad(w, h, top, bot):
    im = Image.new('RGB', (w, h)); dr = ImageDraw.Draw(im)
    for y in range(h):
        t = y / (h - 1)
        dr.line([(0, y), (w, y)], fill=tuple(int(top[i] + (bot[i] - top[i]) * t) for i in range(3)))
    return im


def streaks(w, h):
    import random
    random.seed(7)
    layer = Image.new('RGBA', (w, h), (0, 0, 0, 0)); dr = ImageDraw.Draw(layer)
    for _ in range(80):
        x0 = random.uniform(-60, w); y0 = random.uniform(0, h)
        amp = random.uniform(5, 26); ph = random.uniform(0, 6.28); ln = random.uniform(120, 460)
        pts = [(x, y0 + amp * math.sin(x * 0.011 + ph)) for x in range(int(x0), int(x0 + ln), 6)]
        if len(pts) > 1:
            dr.line(pts, fill=(150, 210, 240, random.randint(8, 24)), width=1)
    return layer.filter(ImageFilter.GaussianBlur(0.4))


def og():
    W, H = 1200, 630
    img = vgrad(W, H, (11, 19, 34), (8, 14, 26)).convert('RGBA')
    glow = Image.new('RGBA', (W, H), (0, 0, 0, 0))
    ImageDraw.Draw(glow).ellipse([330, -120, 870, 520], fill=(30, 200, 225, 46))
    img = Image.alpha_composite(img, glow.filter(ImageFilter.GaussianBlur(130)))
    img = Image.alpha_composite(img, streaks(W, H))
    # cyclone glyph + glow
    gl = Image.new('RGBA', (W, H), (0, 0, 0, 0))
    cyclone(ImageDraw.Draw(gl), 600, 188, 74, CYAN, 12)
    img = Image.alpha_composite(img, gl.filter(ImageFilter.GaussianBlur(11)))
    cyclone(ImageDraw.Draw(img), 600, 188, 74, CYAN, 11)
    d = ImageDraw.Draw(img)
    tb = ImageFont.truetype(ARIALB, 92); sb = ImageFont.truetype(ARIAL, 38); fb = ImageFont.truetype(ARIAL, 26)
    d.text((600, 330), "Seed the Storm", font=tb, fill=INK + (255,), anchor='mm')
    d.rounded_rectangle([520, 384, 680, 391], radius=4, fill=CYAN + (255,))
    d.text((600, 432), "Pick the seed that spins up the most ACE", font=sb, fill=DIM + (255,), anchor='mm')
    d.text((600, 520), "An educational tropical-cyclone game  ·  ERA5 + LGEM physics", font=fb, fill=FAINT + (255,), anchor='mm')
    img.convert('RGB').save(os.path.join(ASSETS, 'og-image.png'), 'PNG')


def app_icon(size):
    im = Image.new('RGBA', (size, size), (0, 0, 0, 0)); d = ImageDraw.Draw(im)
    d.rounded_rectangle([0, 0, size - 1, size - 1], radius=int(size * 0.22), fill=(11, 19, 34, 255))
    cyclone(d, size / 2.0, size / 2.0, size * 0.31, CYAN, max(3, int(size * 0.065)))
    im.save(os.path.join(ASSETS, 'icon-%d.png' % size), 'PNG')


og()
app_icon(180)
app_icon(64)
print('wrote assets/og-image.png, icon-180.png, icon-64.png')
