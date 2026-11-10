#!/usr/bin/env python3
"""Prepare the Santa gift delivery art (docs/santa-image-prompts.md).

Reads the user's generated PNGs (read only), trims transparent margins,
writes small WebP files to public/santa/ and the measured geometry the canvas
needs (house roof lines, chimney mouth, sleigh drop point) to src/santa/art.ts.

    python3 scripts/prepare-santa-art.py /path/to/santa-images
"""
import json
import sys
from pathlib import Path

import numpy as np
from PIL import Image, ImageOps

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "public" / "santa"
GEOMETRY = ROOT / "src" / "santa" / "art.ts"
ALPHA = 24  # faint generator noise below this is treated as transparent

# Logical (canvas) sizes; files are written at about 2× for sharp phones.
SLEIGH_WIDTH = 180
GIFT_SIZE = 30
HOUSE_HEIGHT = {1: 185, 2: 180, 3: 172, 4: 195}
# The chimney's mouth is 46 logical px wide (engine mouthHalf 23).
CHIMNEY_MOUTH = 46
SKY_HEIGHT = 560
SKY_WIDTH = 360
# The moon sits top right, clear of the sleigh (logical x).
SKY_MOON_X = 292


def load(src: Path, name: str) -> Image.Image:
    return Image.open(src / f"{name}.png").convert("RGBA")


def trim(image: Image.Image) -> Image.Image:
    alpha = np.array(image.getchannel("A"))
    rows = np.where(alpha.max(1) > ALPHA)[0]
    cols = np.where(alpha.max(0) > ALPHA)[0]
    cropped = image.crop((cols.min(), rows.min(), cols.max() + 1, rows.max() + 1))
    # Drop the faint noise so it never shows as a haze around the art.
    data = np.array(cropped)
    data[data[:, :, 3] <= ALPHA] = 0
    return Image.fromarray(data)


def save(image: Image.Image, name: str, size: tuple[int, int], alpha=True) -> None:
    resized = image.resize(size, Image.Resampling.LANCZOS)
    path = OUT / f"{name}.webp"
    if alpha:
        resized.save(path, "WEBP", quality=85, alpha_quality=100, method=6, exact=True)
    else:
        resized.convert("RGB").save(path, "WEBP", quality=82, method=6)
    print(f"{path.relative_to(ROOT)} {size[0]}x{size[1]} {path.stat().st_size} bytes")


def main(src: Path) -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    geometry: dict = {}

    # Sleigh: the drop point is the middle of the sleigh's runners (left part of the picture).
    sleigh = trim(load(src, "santa-sleigh"))
    w, h = sleigh.size
    alpha = np.array(sleigh.getchannel("A")) > 128
    runner_rows = alpha[int(h * 0.88):, : int(w * 0.55)]
    runner_x = float(np.where(runner_rows.any(0))[0].mean())
    scale = SLEIGH_WIDTH / w
    save(sleigh, "sleigh", (SLEIGH_WIDTH * 2, round(h * scale * 2)))
    geometry["sleigh"] = {"width": SLEIGH_WIDTH, "height": round(h * scale, 1), "dropX": round(runner_x * scale, 1)}

    for color in ("red", "green", "blue"):
        gift = trim(load(src, f"gift-{color}"))
        side = max(gift.size)
        square = Image.new("RGBA", (side, side))
        square.paste(gift, ((side - gift.size[0]) // 2, side - gift.size[1]))
        save(square, f"gift-{color}", (GIFT_SIZE * 2, GIFT_SIZE * 2))
    geometry["giftSize"] = GIFT_SIZE

    # Houses: the roof line (first opaque row per column) and where the chimney
    # stands, just right of the highest peak, so it rises from near the ridge.
    houses = []
    for number in (1, 2, 3, 4):
        house = trim(load(src, f"house-{number}"))
        w, h = house.size
        scale = HOUSE_HEIGHT[number] / h
        width = round(w * scale)
        save(house, f"house-{number}", (width * 2, HOUSE_HEIGHT[number] * 2))
        alpha = np.array(house.getchannel("A")) > 128
        step = 2  # logical px between roof samples
        roof = []
        for x in range(0, width + 1, step):
            column = alpha[:, min(w - 1, int(x / scale))]
            rows = np.where(column)[0]
            roof.append(round(float(rows.min()) * scale, 1) if rows.size else float(HOUSE_HEIGHT[number]))
        peak = min(roof)
        # Rightmost column within 3 px of the peak, then down the right slope by 16 px.
        peak_index = max(i for i, y in enumerate(roof) if y <= peak + 3)
        chimney = next(i for i in range(peak_index, len(roof)) if roof[i] >= peak + 16)
        houses.append({"width": width, "height": HOUSE_HEIGHT[number], "chimneyX": chimney * step, "roofStep": step, "roof": roof})
    geometry["houses"] = houses

    # Chimney: scaled so the mouth is CHIMNEY_MOUTH wide; mouthY is the mouth's
    # centre from the top of the picture.
    chimney = trim(load(src, "chimney"))
    w, h = chimney.size
    data = np.array(chimney).astype(int)
    opaque = data[:, :, 3] > 128
    # The hole is the dark opening at the very top; the cap's own shadow sits lower.
    dark = opaque & (data[:, :, :3].sum(2) < 200)
    top = dark[: int(h * 0.085)]
    rows = np.where(top.any(1))[0]
    cols = np.where(top.any(0))[0]
    mouth_width = cols.max() - cols.min() + 1
    mouth_y = (rows.min() + rows.max()) / 2
    body_row = opaque[int(h * 0.6)]
    body = np.where(body_row)[0]
    scale = CHIMNEY_MOUTH / mouth_width
    width = round(w * scale)
    height = round(h * scale)
    save(chimney, "chimney", (width * 2, height * 2))
    geometry["chimney"] = {"width": width, "height": height, "mouthY": round(mouth_y * scale, 1),
                           "mouthX": round((cols.min() + cols.max()) / 2 * scale, 1),
                           "body": round((body.max() - body.min() + 1) * scale, 1), "cap": round(w * scale, 1)}

    # Sky: mirrored so the moon is on the right, then the phone-shaped window
    # with the moon at SKY_MOON_X. The window does not scroll, so no seam shows.
    sky = ImageOps.mirror(Image.open(src / "sky.png").convert("RGB"))
    w, h = sky.size
    # The moon is the widest bright run of columns in the top half (stars are tiny).
    bright = (np.array(sky).astype(int).sum(2)[: h // 2] > 600).sum(0) > 20
    runs, start = [], None
    for x, on in enumerate(list(bright) + [False]):
        if on and start is None:
            start = x
        elif not on and start is not None:
            runs.append((x - start, start, x))
            start = None
    _, run_start, run_end = max(runs)
    moon_x = (run_start + run_end) / 2
    scale = SKY_HEIGHT / h
    window = round(SKY_WIDTH / scale)
    left = max(0, min(w - window, round(moon_x - SKY_MOON_X / scale)))
    save(sky.crop((left, 0, left + window, h)), "sky", (window, h), alpha=False)

    tile = trim(load(src, "tile"))
    side = max(tile.size)
    square = Image.new("RGBA", (side, side))
    square.paste(tile, ((side - tile.size[0]) // 2, (side - tile.size[1]) // 2))
    save(square, "tile", (210, 210))
    for name in ("santa-result", "santa-oops"):
        art = trim(load(src, name))
        side = max(art.size)
        square = Image.new("RGBA", (side, side))
        square.paste(art, ((side - art.size[0]) // 2, (side - art.size[1]) // 2))
        save(square, name.replace("santa-", ""), (240, 240))

    GEOMETRY.write_text(
        "// Generated by scripts/prepare-santa-art.py from the drawn art: logical\n"
        "// (canvas) sizes, house roof lines and the chimney mouth. Do not edit.\n"
        f"export const SANTA_ART = {json.dumps(geometry, separators=(',', ':'))} as const;\n"
    )
    print(f"{GEOMETRY.relative_to(ROOT)} written")


if __name__ == "__main__":
    if len(sys.argv) != 2:
        sys.exit("usage: prepare-santa-art.py /path/to/santa-images")
    main(Path(sys.argv[1]).resolve())
