#!/usr/bin/env python3
"""Prepare the nickname tag evolution art (docs/tag-evolution-image-prompts.md).

Reads the user's generated PNGs (read only), clears faint generator noise,
trims transparent margins, centers each picture on a square and writes 360px
WebP files (about 2x the on-screen size) to public/tags/.

    python3 scripts/prepare-tag-evolution-art.py /path/to/images
"""
import sys
from pathlib import Path

import numpy as np
from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "public" / "tags"
ALPHA = 24  # faint generator noise below this is treated as transparent
SIZE = 360
NAMES = ["evolve-working", "evolve-success", "evolve-fail", "evolve-lost"]


def prepare(src: Path, name: str) -> None:
    data = np.array(Image.open(src / f"{name}.png").convert("RGBA"))
    data[data[:, :, 3] <= ALPHA] = 0
    rows = np.where(data[:, :, 3].max(1) > 0)[0]
    cols = np.where(data[:, :, 3].max(0) > 0)[0]
    art = Image.fromarray(data).crop((cols.min(), rows.min(), cols.max() + 1, rows.max() + 1))
    side = max(art.size)
    square = Image.new("RGBA", (side, side), (0, 0, 0, 0))
    square.paste(art, ((side - art.width) // 2, (side - art.height) // 2))
    path = OUT / f"{name}.webp"
    square.resize((SIZE, SIZE), Image.Resampling.LANCZOS).save(path, "WEBP", quality=85, alpha_quality=100, method=6, exact=True)
    print(f"{path.relative_to(ROOT)} {SIZE}x{SIZE} {path.stat().st_size} bytes (source {(src / f'{name}.png').stat().st_size})")


if __name__ == "__main__":
    OUT.mkdir(parents=True, exist_ok=True)
    for name in NAMES:
        prepare(Path(sys.argv[1]), name)
