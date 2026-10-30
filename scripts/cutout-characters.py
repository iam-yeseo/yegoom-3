"""Cut the cream background out of the character art.

The original art (1254px RGB on a cream background) is in the Claude Design
export, project/assets/. Usage:

    python3 scripts/cutout-characters.py SRC.png public/characters/NAME.png [TOL GRAD FLOOR CLOSE]

public/characters was made with the defaults, except drop.png, which needs a
stricter edge (GRAD 0.7) so its cream swirl is kept:

    python3 scripts/cutout-characters.py assets/drop.png public/characters/drop.png 26 0.7

Background pixels are found by flood-filling from the border through pixels
close to the border colour, stopped by the soft outline of the character. A
second pass continues into the floor shadow in the bottom band, which keeps a
little alpha as a warm shadow. Specks are closed, islands not connected to the
character are dropped, and the edge is feathered.
"""
import sys
import numpy as np
from PIL import Image, ImageFilter

SIZE = 640
TOL = float(sys.argv[3]) if len(sys.argv) > 3 else 26.0
GRAD = float(sys.argv[4]) if len(sys.argv) > 4 else 1.5
CLOSE = int(sys.argv[6]) if len(sys.argv) > 6 else 3
FLOOR = float(sys.argv[5]) if len(sys.argv) > 5 else 0.8


def dilate(m):
    out = m.copy()
    out[1:] |= m[:-1]
    out[:-1] |= m[1:]
    out[:, 1:] |= m[:, :-1]
    out[:, :-1] |= m[:, 1:]
    return out


def flood(seed, passable):
    region = seed & passable
    while True:
        grown = dilate(region) & passable
        if grown.sum() == region.sum():
            return region
        region = grown


def cutout(src, dst):
    im = Image.open(src).convert("RGB").resize((SIZE, SIZE), Image.LANCZOS)
    a = np.asarray(im).astype(np.float32)
    border = np.concatenate([a[0], a[-1], a[:, 0], a[:, -1]])
    bg = np.median(border, 0)
    dist = np.sqrt(((a - bg) ** 2).sum(-1))
    # Chroma difference catches pale characters whose brightness is close to
    # the background but whose hue is not (e.g. the cream cat).
    chroma = a - a.mean(-1, keepdims=True)
    bg_chroma = bg - bg.mean()
    cdist = np.sqrt(((chroma - bg_chroma) ** 2).sum(-1))
    lum = a.mean(-1)
    darker = np.clip(bg.mean() - lum, 0, None)
    # Shadows are darker but keep the background's hue.
    # Edge barrier: the fill may not cross the soft outline of a character,
    # which keeps pale bodies (the cream cat) from leaking into the fill.
    soft = np.asarray(im.convert("L").filter(ImageFilter.GaussianBlur(1.2))).astype(np.float32)
    gy, gx = np.gradient(soft)
    grad = np.hypot(gx, gy)
    passable = (grad < GRAD) & (cdist < 9) & (dist < TOL)
    region = np.zeros_like(passable)
    region[[0, -1]] = True
    region[:, [0, -1]] = True
    region = flood(region, passable)
    # Second pass: the floor shadow is darker and warmer than the backdrop but
    # very smooth, so let the fill continue into it from the lower half only.
    shade = (grad < GRAD * 0.7) & (cdist < 26) & (darker < 80)
    shade[: int(SIZE * FLOOR)] = False
    region = flood(region, region | shade)
    # Close small specks of film grain that the strict edge barrier left out.
    for _ in range(CLOSE):
        region = dilate(region)
    for _ in range(CLOSE):
        region = ~dilate(~region)
    # Keep only the opaque area connected to the character in the middle.
    seed = np.zeros_like(region)
    seed[SIZE // 2, SIZE // 2] = True
    body = flood(seed, ~region)
    assert body.sum() > SIZE * SIZE * 0.1, "centre is not on the character"
    region = ~body
    shadow = np.clip(darker / 60.0, 0, 1) * 0.6
    shadow[shadow < 0.08] = 0
    alpha = np.where(region, shadow, 1.0)
    alpha_img = Image.fromarray((alpha * 255).astype(np.uint8)).filter(ImageFilter.GaussianBlur(0.8))
    alpha = np.asarray(alpha_img).astype(np.float32) / 255
    rgb = np.where(region[..., None], np.array([150, 120, 95], np.float32), a)
    out = np.dstack([rgb, alpha * 255]).clip(0, 255).astype(np.uint8)
    Image.fromarray(out, "RGBA").save(dst, optimize=True)


if __name__ == "__main__":
    cutout(sys.argv[1], sys.argv[2])
