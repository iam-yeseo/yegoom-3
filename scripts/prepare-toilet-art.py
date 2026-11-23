#!/usr/bin/env python3
"""Optimize the user-provided 변기 폭파 images (docs/asset-provenance.md).

Usage: python3 scripts/prepare-toilet-art.py <folder with the original PNGs>
Reads the seven pictures named as in docs/toilet-image-prompts.md and writes
WebP files (RGB quality 85, lossless alpha) under public/toilet. Faint specks
(alpha 24 or less) are cleared.

The calm, nervous and burst toilets are swapped in place on the game screen,
so they are not trimmed one by one: each is scaled so its blue seat ring has
the same width, then cut around the same anchor (the ring's centre, the base's
bottom edge) into frames STAGE_WIDTH wide. The calm and nervous frames are
square; the burst frame is taller, with the toilet at its bottom. Shown at the
same width, the three toilets line up.
Requires Pillow with WebP support.
"""

import argparse
from pathlib import Path

from PIL import Image

QUALITY = 85
SPECK_ALPHA = 24
# Source pixels across a stage frame, around the ring's centre, and the
# transparent margin kept under the base.
FRAME = 1040
FOOT = 6
STAGE_WIDTH = 360
# name -> (output path, target square side, margin) for the pictures that are
# trimmed and centred. The home row shows its icon at 64px in a 54px box, so the
# tall tile keeps a margin around it or its top and bottom are cut off.
SQUARES = {
    "toilet-tile": ("public/toilet/tile.webp", 210, 0.18),
    "poop": ("public/toilet/poop.webp", 160, 0),
    "toilet-result-safe": ("public/toilet/result-safe.webp", 240, 0),
    "toilet-result-lose": ("public/toilet/result-lose.webp", 240, 0),
}
STAGES = {"toilet-calm": "public/toilet/calm.webp", "toilet-nervous": "public/toilet/nervous.webp", "toilet-boom": "public/toilet/boom.webp"}


def load(source: Path) -> Image.Image:
    with Image.open(source) as original:
        image = original.convert("RGBA")
    image.putalpha(image.getchannel("A").point(lambda value: 0 if value <= SPECK_ALPHA else value))
    return image


def save(image: Image.Image, destination: Path) -> None:
    destination.parent.mkdir(parents=True, exist_ok=True)
    image.save(destination, format="WEBP", quality=QUALITY, alpha_quality=100, lossless=False, method=6, exact=True)


def anchor(image: Image.Image) -> tuple[float, float, int]:
    """The seat ring's widest row (centre x, width) and the base's bottom edge.
    The ring is the widest run of solid blue in the lower 45% of the picture
    (above that the burst picture has its blue water fountain);
    the base is the lowest solid row."""
    pixels, width, height = image.load(), image.width, image.height
    best = (0, 0, 0)
    for y in range(int(height * 0.55), height):
        xs = [x for x in range(width) if pixels[x, y][3] > 200 and pixels[x, y][2] > pixels[x, y][0] + 60]
        if xs and xs[-1] - xs[0] > best[0]:
            best = (xs[-1] - xs[0], xs[0], xs[-1])
    solid = image.getchannel("A").point(lambda value: 255 if value > 128 else 0).getbbox()
    if not best[0] or not solid:
        raise ValueError("No seat ring found")
    return (best[1] + best[2]) / 2, best[0], solid[3]


def prepare(folder: Path, root: Path) -> None:
    print("name\toriginal_bytes\twebp_bytes\tdimensions")
    for name, (output, side, margin) in SQUARES.items():
        source = folder / f"{name}.png"
        image = load(source)
        image = image.crop(image.getchannel("A").getbbox())
        square = Image.new("RGBA", (round(max(image.size) * (1 + margin)),) * 2, (0, 0, 0, 0))
        square.paste(image, ((square.width - image.width) // 2, (square.height - image.height) // 2))
        image = square.resize((side, side), Image.Resampling.LANCZOS)
        save(image, root / output)
        print(f"{name}\t{source.stat().st_size}\t{(root / output).stat().st_size}\t{image.width}x{image.height}")
    calm = load(folder / "toilet-calm.png")
    _, ring, _ = anchor(calm)
    for name, output in STAGES.items():
        source = folder / f"{name}.png"
        image = load(source)
        _, width, _ = anchor(image)
        scale = ring / width
        image = image.resize((round(image.width * scale), round(image.height * scale)), Image.Resampling.LANCZOS)
        centre, _, bottom = anchor(image)
        top = image.getchannel("A").getbbox()[1]
        height = FRAME if name != "toilet-boom" else bottom + FOOT - top
        left, low = round(centre - FRAME / 2), bottom + FOOT
        frame = image.crop((left, low - height, left + FRAME, low))
        frame = frame.resize((STAGE_WIDTH, round(height * STAGE_WIDTH / FRAME)), Image.Resampling.LANCZOS)
        save(frame, root / output)
        print(f"{name}\t{source.stat().st_size}\t{(root / output).stat().st_size}\t{frame.width}x{frame.height}\tscale {scale:.3f}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("folder", type=Path)
    arguments = parser.parse_args()
    prepare(arguments.folder, Path(__file__).resolve().parent.parent)
