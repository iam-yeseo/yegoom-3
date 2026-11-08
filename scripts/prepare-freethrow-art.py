#!/usr/bin/env python3
"""Optimize the two user-provided free-throw images (docs/asset-provenance.md).

Usage: python3 scripts/prepare-freethrow-art.py <tile image> <ball image>
       [--output public/freethrow]
Writes tile.webp (home tile icon, 210px for a 70px icon at 3x) and ball.webp
(256px canvas sprite) with RGB quality 85 and lossless alpha. Requires Pillow
with WebP support.
"""

import argparse
from pathlib import Path

from PIL import Image

QUALITY = 85
MAX_BYTES = 40_000
TARGETS = {"tile": 210, "ball": 256}


def prepare(sources: dict[str, Path], output: Path) -> None:
    output.mkdir(parents=True, exist_ok=True)
    print("name\toriginal_bytes\twebp_bytes\tdimensions")
    for name, source in sources.items():
        with Image.open(source) as original:
            image = original.convert("RGBA")
        bounds = image.getchannel("A").getbbox()
        if not bounds:
            raise ValueError(f"Image is fully transparent: {source}")
        image = image.crop(bounds)
        # Square canvas: the ball must stay a centred circle when it spins.
        side = max(image.size)
        square = Image.new("RGBA", (side, side), (0, 0, 0, 0))
        square.paste(image, ((side - image.width) // 2, (side - image.height) // 2))
        size = TARGETS[name]
        square = square.resize((size, size), Image.Resampling.LANCZOS)
        destination = output / f"{name}.webp"
        square.save(destination, format="WEBP", quality=QUALITY, alpha_quality=100, lossless=False, method=6, exact=True)
        written = destination.stat().st_size
        if written > MAX_BYTES:
            raise ValueError(f"WebP exceeds {MAX_BYTES} bytes: {destination} ({written})")
        print(f"{name}\t{source.stat().st_size}\t{written}\t{size}x{size}")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("tile", type=Path)
    parser.add_argument("ball", type=Path)
    parser.add_argument("--output", type=Path, default=Path("public/freethrow"))
    args = parser.parse_args()
    prepare({"tile": args.tile, "ball": args.ball}, args.output)


if __name__ == "__main__":
    main()
