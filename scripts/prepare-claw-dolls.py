#!/usr/bin/env python3
"""Optimize the 11 user-provided claw dolls without changing their numbering.

Usage: python3 scripts/prepare-claw-dolls.py <yegoom/public/assets copy>
       [--output public/claw/dolls]
Requires Python 3 and Pillow with WebP support. Read the original PNGs only;
write 320px-long-side WebP images with RGB quality 85 and lossless alpha.
Reproducible bytes require the same Pillow/libwebp versions between runs.
"""

import argparse
from pathlib import Path

from PIL import Image, features


LONG_SIDE = 320
QUALITY = 85
MAX_BYTES = 40_000
DOLL_TYPES = range(1, 12)


def prepare(source: Path, output: Path) -> None:
    originals = [source / f"gatcha-{number}.png" for number in DOLL_TYPES]
    missing = [str(path) for path in originals if not path.is_file()]
    if missing:
        raise ValueError(f"Missing original PNGs: {', '.join(missing)}")
    output.mkdir(parents=True, exist_ok=True)
    original_total = optimized_total = 0
    print(f"Pillow {Image.__version__}; libwebp {features.version('webp')}")
    print("type\toriginal_bytes\twebp_bytes\tdimensions\talpha")
    for number, path in zip(DOLL_TYPES, originals):
        with Image.open(path) as original:
            image = original.convert("RGBA")
            width, height = image.size
            size = (max(1, round(width * LONG_SIDE / max(width, height))),
                    max(1, round(height * LONG_SIDE / max(width, height))))
            image = image.resize(size, Image.Resampling.LANCZOS)
        alpha = image.getchannel("A")
        if alpha.getextrema() != (0, 255):
            raise ValueError(f"Expected transparent and opaque pixels: {path.name}")
        destination = output / f"doll-{number}.webp"
        image.save(destination, format="WEBP", quality=QUALITY, alpha_quality=100,
                   lossless=False, method=6, exact=True)
        with Image.open(destination) as decoded:
            if decoded.size != size or decoded.convert("RGBA").getchannel("A").tobytes() != alpha.tobytes():
                raise ValueError(f"Dimensions or alpha changed: {destination}")
        original_bytes, optimized_bytes = path.stat().st_size, destination.stat().st_size
        if optimized_bytes > MAX_BYTES:
            raise ValueError(f"WebP exceeds {MAX_BYTES} bytes: {destination} ({optimized_bytes})")
        original_total += original_bytes
        optimized_total += optimized_bytes
        print(f"{number}\t{original_bytes}\t{optimized_bytes}\t{size[0]}x{size[1]}\tlossless")
    print(f"total\t{original_total}\t{optimized_total}")
    print(f"reduction\t{100 * (1 - optimized_total / original_total):.2f}%")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", type=Path, help="Read-only copy of yegoom/public/assets")
    parser.add_argument("--output", type=Path, default=Path(__file__).resolve().parents[1] / "public/claw/dolls")
    args = parser.parse_args()
    prepare(args.source, args.output)


if __name__ == "__main__":
    main()
