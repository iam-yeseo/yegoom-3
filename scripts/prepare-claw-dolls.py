#!/usr/bin/env python3
"""Prepare 15 claw dolls from a read-only folder of source images.

    python3 scripts/prepare-claw-dolls.py /tmp/claw-dolls-src \
        [--first-number 2] [--output public/claw/dolls] [--preview /tmp/claw-dolls-preview]

Requires Python 3, Pillow with WebP support, and NumPy. Preserve existing
transparency, or remove the edge-connected plain backdrop in the product
photos, remove the key rings, then crop the bodies and export 320px WebP
with lossless alpha.
"""
import argparse
from io import BytesIO
from pathlib import Path
import re
from tempfile import TemporaryDirectory
import unicodedata

import numpy as np
from PIL import Image, ImageDraw, ImageFilter, ImageOps, features


DOLL_TYPES = range(1, 16)
LONG_SIDE = 320
MAX_BYTES = 40_000
EXTENSIONS = {".png", ".jpg", ".jpeg", ".webp"}


def source_files(source: Path, first_number: int) -> list[Path]:
    paths = sorted((p for p in source.iterdir()
                    if p.is_file() and not p.name.startswith(".") and p.suffix.lower() in EXTENSIONS),
                   key=lambda p: unicodedata.normalize("NFC", p.name))
    if len(paths) != len(DOLL_TYPES):
        raise ValueError(f"Expected 15 source images, found {len(paths)} in {source}")
    labels = [re.findall(r"\d+", p.stem) for p in paths]
    if not any(labels):
        if first_number != 1:
            raise ValueError("--first-number requires numbered source files")
        return paths
    if any(len(groups) != 1 for groups in labels):
        raise ValueError("Expected exactly one number in each numbered source filename")
    numbered = {int(groups[0]): p for groups, p in zip(labels, paths)}
    expected = range(first_number, first_number + len(DOLL_TYPES))
    if set(numbered) != set(expected):
        raise ValueError(f"Expected unique source numbers {expected.start} to {expected.stop - 1}")
    return [numbered[n] for n in expected]


def clipped_alpha(image: Image.Image) -> Image.Image:
    return image.point(lambda a: a if a > 24 else 0)


# Photo-specific limits in the original 1200px JPEGs. For the nurses the y
# limit encloses the pink clasp but excludes the similar-colored hat badges,
# hearts and hair. Pixels are removed only when connected to the top hardware.
# Type 4 is the one rear-facing cap; type 14 uses color alone between its ears.
CLIP_LIMITS = {
    "02_간호사_치이카와.jpg": 390, "03_간호사_하치와레.jpg": 389,
    "04_간호사_우사기.jpg": 390,
    "06_간호사_모몽가.jpg": 416, "07_간호사_쿠리만쥬.jpg": 389,
    "08_간호사_시사.jpg": 429, "09_간호사_랏코.jpg": 376,
    "10_간호사_헌책방.jpg": 378, "11_간호사_풍뎅이.jpg": 452,
    "12_간호사_오데.jpg": 347, "13_간호사_포셰트_갑옷상.jpg": 302,
    "14_간호사_그_녀석.jpg": 435, "15_의사_우사기.jpg": None,
    "16_의사_랏코.jpg": 440,
}
BACK_HAT = "05_간호사_치이카와_뒷모습.jpg"
BLUE_RINGS = {"15_의사_우사기.jpg", "16_의사_랏코.jpg"}
# The pale cord protrudes above these caps. Bound the removal by the intact
# adjacent fabric. The cord on type 15 narrows just above the furry forehead.
CORD_SPANS = {
    "08_간호사_시사.jpg": [(400, 418, 593, 612)],
    "14_간호사_그_녀석.jpg": [(410, 420, 592, 610)],
    "16_의사_랏코.jpg": [(372, 412, 582, 602), (412, 424, 585, 599)],
}


def connected(mask: np.ndarray, seed: tuple[int, int]) -> np.ndarray:
    layer = Image.fromarray(mask.astype(np.uint8)).copy()
    ImageDraw.floodfill(layer, seed, 2)
    return np.asarray(layer) == 2


def foreground(passable: np.ndarray) -> np.ndarray:
    # Padding connects all four image edges into one exterior flood.
    return ~connected(np.pad(passable, 1, constant_values=True), (0, 0))[1:-1, 1:-1]


def keep_body(solid: np.ndarray) -> np.ndarray:
    ys, xs = np.nonzero(solid)
    if not len(xs):
        raise ValueError("No foreground remained after background removal")
    seed = np.argmin((xs - xs.mean()) ** 2 + (ys - ys.mean()) ** 2)
    return connected(solid, (int(xs[seed]), int(ys[seed])))


def grow(mask: np.ndarray, radius: int) -> np.ndarray:
    pixels = Image.fromarray(mask.astype(np.uint8))
    return np.asarray(pixels.filter(ImageFilter.MaxFilter(2 * radius + 1))).astype(bool)


def remove_clip(rgb: np.ndarray, solid: np.ndarray, plain: np.ndarray, name: str) -> np.ndarray:
    red, green, blue = rgb.transpose(2, 0, 1)
    if name in BLUE_RINGS:
        color = (blue - red >= 3) & (green > red)
        weak = blue > red
    else:
        # On type 12 the stem sits flush with a slightly pink-tinted white
        # cap. Its stronger plastic chroma separates the two at the seam.
        threshold = 28 if name == "13_간호사_포셰트_갑옷상.jpg" else 18
        color = (red - green >= threshold) & (red - blue >= 6)
        weak = red - green > threshold - 6
    candidates = color & solid
    limit = CLIP_LIMITS[name]
    if limit is not None:
        candidates[limit:] = False
    crown_rows = np.flatnonzero(candidates.any(axis=1))
    if not len(crown_rows):
        raise ValueError("No colored clip found at the top of the doll")
    y = int(crown_rows[0])
    xs = np.flatnonzero(candidates[y])
    seed = (int(xs[len(xs) // 2]), y)
    ring = connected(candidates, seed)
    removed = ring | (grow(ring, 1) & (weak | plain))
    for top, bottom, left, right in CORD_SPANS.get(name, []):
        removed[top:bottom, left:right] = True
    # The former clasp holes are now open to the edge, so their original white
    # backdrop disappears with it without punching holes in white fabric.
    body = foreground(plain | removed)
    if name not in BLUE_RINGS:
        # A one-pixel JPEG highlight can cling to the hat after the plastic is
        # gone. Remove thin upright slivers only along the warm-colored rim.
        fringe = (red - green >= 3) & (blue - green >= -7)
        fringe[limit:] = False
        rim = grow(connected(ring | fringe, seed), 2)
        padded = np.pad(body, ((0, 0), (2, 2)))
        spans = np.lib.stride_tricks.sliding_window_view(padded, 5, axis=1).all(axis=-1)
        spans = np.pad(spans, ((0, 0), (2, 2)))
        supported = np.lib.stride_tricks.sliding_window_view(spans, 5, axis=1).any(axis=-1)
        body[rim & ~supported] = False
    return body


def restore_back_hat(image: Image.Image, solid: np.ndarray):
    """Recover only the fabric hidden by the clasp and its white braid in photo 05."""
    rgb = np.array(image.convert("RGB"))
    body = solid.copy()
    # Outside this patch the hardware is strictly above the first visible cap
    # fibers at y=346. Between the two visible fabric edges, the top drops 1px.
    body[:346] = False
    rows, cols = slice(343, 476), slice(556, 646)
    patch = rgb[rows, cols]
    cap = body[rows, cols]
    y, x = np.ogrid[rows, cols]
    top = np.interp(x, [577, 623], [347, 348])
    interrupted_edge = (x >= 577) & (x <= 623) & (y <= 349)
    cap[interrupted_edge] = np.broadcast_to(y >= top - 0.5, cap.shape)[interrupted_edge]

    red, green, blue = patch.astype(np.int16).transpose(2, 0, 1)
    pink = (red - green >= 14) & (blue - green >= -2) & (y <= 416)
    seed = (600 - cols.start, 347 - rows.start)
    if not pink[seed[1], seed[0]]:
        raise ValueError("Back-cap clasp seed does not match the source")
    ring = grow(connected(pink, seed), 2)
    # The colorless braided cord tapers to a few fibers below the cap seam.
    half_width = np.interp(y, [391, 400, 457, 466, 472], [2, 7, 7, 6, 3])
    cord = (y >= 391) & (y <= 472) & (np.abs(x - 598.5) <= half_width)
    missing = cap & (ring | cord)
    if not missing.any():
        raise ValueError("Expected the clasp to overlap the back of the cap")

    # Start from neighboring original fabric; unfilled/transparent samples
    # have zero weight. Keep original texels fixed during each relaxation.
    # Horizontal fibers at the crown and hem give those neighbors more weight.
    fabric = patch.astype(np.float64)
    known = cap & ~missing
    horizontal = np.where((y < 363) | (y >= 435), 9.0, 2.0)
    for _ in range(1000):
        padded = np.pad(fabric * known[:, :, None], ((1, 1), (1, 1), (0, 0)))
        valid = np.pad(known.astype(np.float64), 1)
        sides = padded[1:-1, :-2] + padded[1:-1, 2:]
        vertical = padded[:-2, 1:-1] + padded[2:, 1:-1]
        weights = (horizontal * (valid[1:-1, :-2] + valid[1:-1, 2:])
                   + valid[:-2, 1:-1] + valid[2:, 1:-1])
        active = missing & (weights > 0)
        if not active.any():
            raise ValueError("No neighboring original cloth available to repair the cap")
        revised = (horizontal[:, :, None] * sides + vertical)[active] / weights[active, None]
        delta = np.max(np.abs(revised - fabric[active]))
        fabric[active] = revised
        known[active] = True
        if np.array_equal(active, missing) and delta < 0.01:
            break
    if not np.all(known[missing]):
        raise ValueError("Fabric repair did not reach every occluded pixel")
    patch[missing] = np.rint(fabric[missing]).astype(np.uint8)
    # Feathering the new silhouette also gives its exterior edge partial
    # coverage. Extend the recovered fabric color under that narrow fringe
    # so the removed pink plastic cannot reappear during resampling.
    for column in range(577 - cols.start, 624 - cols.start):
        first = np.flatnonzero(cap[:, column])[0]
        patch[max(0, first - 2):first, column] = patch[first, column]
    filled = np.zeros_like(body)
    filled[rows, cols] = missing
    return Image.fromarray(rgb), body, filled


def isolate(image: Image.Image, filename: str) -> tuple[Image.Image, np.ndarray | None, int]:
    image = ImageOps.exif_transpose(image).convert("RGBA")
    alpha = clipped_alpha(image.getchannel("A"))
    if alpha.getextrema()[0] != 255:
        image.putalpha(alpha)
        return image, None, int(np.count_nonzero(alpha))
    image = image.convert("RGB")
    rgb = np.asarray(image, dtype=np.int16)
    border = np.concatenate((rgb[0], rgb[-1], rgb[:, 0], rgb[:, -1]))
    bg = np.median(border, axis=0)
    if np.percentile(np.abs(border - bg).max(axis=1), 85) > 18:
        raise ValueError("Backdrop along the image border is not uniform")
    delta = rgb - bg
    plain = (np.abs(delta.mean(axis=2)) < 6) & (np.ptp(delta, axis=2) < 6)
    solid = foreground(plain)
    name = unicodedata.normalize("NFC", filename)
    filled = None
    hardware = None
    if name == BACK_HAT or name in CLIP_LIMITS:
        if image.size != (1200, 1200):
            raise ValueError("Clip settings require the original 1200px photo")
        if name == BACK_HAT:
            image, solid, filled = restore_back_hat(image, solid)
        else:
            remaining = remove_clip(rgb, solid, plain, name)
            hardware = solid & ~remaining
            solid = remaining
    body = keep_body(solid)
    count = int(np.count_nonzero(body))
    if filled is not None and np.count_nonzero(filled) > 0.015 * count:
        raise ValueError("Cap repair exceeds 1.5% of the final doll silhouette")
    alpha = Image.fromarray(body.astype(np.uint8) * 255).filter(ImageFilter.GaussianBlur(.7))
    if hardware is not None:
        # The feather may extend into old plastic at the newly exposed seam.
        # Leave those pixels transparent so resizing cannot reintroduce its dye.
        alpha.paste(0, mask=Image.fromarray(hardware))
    image.putalpha(clipped_alpha(alpha))
    return image, filled, count


def resize_doll(image: Image.Image) -> Image.Image:
    alpha = image.getchannel("A")
    bbox = alpha.getbbox()
    if bbox is None:
        raise ValueError("Empty silhouette")
    image = image.crop(bbox)
    if max(image.size) < LONG_SIDE:
        raise ValueError(f"Silhouette is smaller than {LONG_SIDE}px: {image.size}")
    size = tuple(max(1, round(s * LONG_SIDE / max(image.size))) for s in image.size)
    image = image.resize(size, Image.Resampling.LANCZOS)
    image.putalpha(clipped_alpha(image.getchannel("A")))
    bbox = image.getchannel("A").getbbox()
    if bbox is None:
        raise ValueError("Empty silhouette after resize")
    image = image.crop(bbox)
    if max(image.size) != LONG_SIDE or image.getchannel("A").getextrema() != (0, 255):
        raise ValueError(f"Expected transparency and a {LONG_SIDE}px silhouette, got {image.size}")
    return image


def encode(image: Image.Image) -> bytes:
    stream = BytesIO()
    image.save(stream, format="WEBP", quality=85, alpha_quality=100, method=6, exact=True)
    if stream.tell() > MAX_BYTES:
        raise ValueError(f"WebP exceeds {MAX_BYTES} bytes: {stream.tell()}")
    stream.seek(0)
    with Image.open(stream) as decoded:
        if (decoded.size != image.size or
                decoded.convert("RGBA").getchannel("A").tobytes() != image.getchannel("A").tobytes()):
            raise ValueError("Dimensions or alpha changed during encoding")
    return stream.getvalue()


def contact_sheets(blobs: list[bytes], preview: Path) -> None:
    preview.mkdir(parents=True, exist_ok=True)
    cell, label = 224, 24
    for theme, bg in [("machine", "#E3F1FC"), ("dark", "#3A3340"), ("checker", "#EEEEEE")]:
        sheet = Image.new("RGB", (5 * cell, 3 * (cell + label)), bg)
        draw = ImageDraw.Draw(sheet)
        if theme == "checker":
            step = 12
            for y in range(0, sheet.height, step):
                for x in range(step * (y // step % 2), sheet.width, 2 * step):
                    draw.rectangle((x, y, x + step - 1, y + step - 1), fill="#BDBDBD")
        for i, blob in enumerate(blobs):
            with Image.open(BytesIO(blob)) as original:
                doll = original.convert("RGBA")
            doll.thumbnail((cell - 12, cell - 12), Image.Resampling.LANCZOS)
            x, y = i % 5 * cell, i // 5 * (cell + label)
            sheet.paste(doll, (x + (cell - doll.width) // 2, y + (cell - doll.height) // 2), doll)
            draw.text((x + cell // 2, y + cell), str(i + 1), anchor="mt",
                      fill="white" if theme == "dark" else "#222222")
        sheet.save(preview / f"{theme}.png")


def prepare(source: Path, output: Path, preview: Path | None, first_number: int) -> None:
    paths = source_files(source, first_number)
    names = [f"doll-{n}.webp" for n in DOLL_TYPES]
    folders = [source.resolve(), output.resolve()]
    if preview:
        folders.append(preview.resolve())
    if len(folders) != len(set(folders)):
        raise ValueError("Source, output and preview folders must differ")
    if output.exists():
        unexpected = {p.name for p in output.iterdir()} - set(names)
        if unexpected:
            raise ValueError(f"Unexpected output files: {sorted(unexpected)}")
    blobs = []
    original_total = 0
    print(f"Pillow {Image.__version__}; libwebp {features.version('webp')}")
    print("type\tfilename\toriginal_px\toriginal_bytes\twebp_bytes\twebp_px\tfilled_px\tbody_px")
    for n, path in zip(DOLL_TYPES, paths):
        try:
            with Image.open(path) as original:
                source_width, source_height = original.size
                image, filled, body_pixels = isolate(original, path.name)
                image = resize_doll(image)
            blob = encode(image)
        except (ValueError, OSError) as exc:
            raise ValueError(f"type {n}, {path.name}: {exc}") from exc
        blobs.append(blob)
        original_bytes = path.stat().st_size
        original_total += original_bytes
        print(f"{n}\t{path.name}\t{source_width}x{source_height}\t{original_bytes}\t"
              f"{len(blob)}\t{image.width}x{image.height}\t"
              f"{np.count_nonzero(filled) if filled is not None else 0}\t{body_pixels}")
    if preview:
        contact_sheets(blobs, preview)
    output.mkdir(parents=True, exist_ok=True)
    # Validate the whole batch before replacing any previously published sprites.
    with TemporaryDirectory(dir=output) as temp:
        staging = Path(temp)
        for name, blob in zip(names, blobs):
            (staging / name).write_bytes(blob)
        for name in names:
            (staging / name).replace(output / name)
    print(f"total\t{original_total}\t{sum(map(len, blobs))}")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", type=Path)
    parser.add_argument("--output", type=Path, default=Path(__file__).resolve().parents[1] / "public/claw/dolls")
    parser.add_argument("--preview", type=Path)
    parser.add_argument("--first-number", type=int, default=1,
                        help="First source number to assign to type 1 (default: 1)")
    args = parser.parse_args()
    prepare(args.source, args.output, args.preview, args.first_number)


if __name__ == "__main__":
    main()
