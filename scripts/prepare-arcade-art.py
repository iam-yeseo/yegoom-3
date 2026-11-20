#!/usr/bin/env python3
"""Optimize the user-provided curling, penalty and bingo images (docs/asset-provenance.md).

Usage: python3 scripts/prepare-arcade-art.py <folder with the original PNGs>
Reads curling-tile, penalty-tile, bingo-tile, curling-stone, penalty-ball,
keeper-ready and keeper-dive (.png) and writes WebP files (RGB quality 85,
lossless alpha) under public/curling, public/penalty and public/bingo. Faint
specks (alpha 24 or less) are cleared and the transparent margin is cropped.
It also writes src/penalty/art.ts with the keeper pictures' proportions.
Requires Pillow with WebP support.
"""

import argparse
from pathlib import Path

from PIL import Image

QUALITY = 85
SPECK_ALPHA = 24
# name -> (output path, how it is fitted, target size in pixels)
#   square: centred on a transparent square of that side (icons, round sprites)
#   height / width: scaled so that side has that length, the other follows
TARGETS = {
    "curling-tile": ("public/curling/tile.webp", "square", 210),
    "penalty-tile": ("public/penalty/tile.webp", "square", 210),
    "bingo-tile": ("public/bingo/tile.webp", "square", 210),
    "curling-stone": ("public/curling/stone.webp", "square", 96),
    "penalty-ball": ("public/penalty/ball.webp", "square", 128),
    "keeper-ready": ("public/penalty/keeper-ready.webp", "height", 256),
    "keeper-dive": ("public/penalty/keeper-dive.webp", "width", 320),
}


def trimmed(source: Path) -> Image.Image:
    with Image.open(source) as original:
        image = original.convert("RGBA")
    alpha = image.getchannel("A").point(lambda value: 0 if value <= SPECK_ALPHA else value)
    image.putalpha(alpha)
    bounds = alpha.getbbox()
    if not bounds:
        raise ValueError(f"Image is fully transparent: {source}")
    return image.crop(bounds)


def prepare(folder: Path, root: Path) -> None:
    sizes: dict[str, tuple[int, int]] = {}
    print("name\toriginal_bytes\twebp_bytes\tdimensions")
    for name, (output, fit, size) in TARGETS.items():
        source = folder / f"{name}.png"
        image = trimmed(source)
        if fit == "square":
            side = max(image.size)
            square = Image.new("RGBA", (side, side), (0, 0, 0, 0))
            square.paste(image, ((side - image.width) // 2, (side - image.height) // 2))
            image = square.resize((size, size), Image.Resampling.LANCZOS)
        elif fit == "height":
            image = image.resize((round(image.width * size / image.height), size), Image.Resampling.LANCZOS)
        else:
            image = image.resize((size, round(image.height * size / image.width)), Image.Resampling.LANCZOS)
        destination = root / output
        destination.parent.mkdir(parents=True, exist_ok=True)
        image.save(destination, format="WEBP", quality=QUALITY, alpha_quality=100, lossless=False, method=6, exact=True)
        sizes[name] = image.size
        print(f"{name}\t{source.stat().st_size}\t{destination.stat().st_size}\t{image.width}x{image.height}")
    ready, dive = sizes["keeper-ready"], sizes["keeper-dive"]
    (root / "src/penalty/art.ts").write_text(
        "// Written by scripts/prepare-arcade-art.py from the keeper pictures. Do not edit by hand.\n"
        "/** Width divided by height of each keeper picture once its margin is cropped. */\n"
        f"export const KEEPER_ART = {{ ready: {ready[0] / ready[1]:.4f}, dive: {dive[0] / dive[1]:.4f} }} as const;\n",
        encoding="utf-8",
    )


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("folder", type=Path)
    parser.add_argument("--root", type=Path, default=Path("."))
    args = parser.parse_args()
    prepare(args.folder, args.root)


if __name__ == "__main__":
    main()
