#!/usr/bin/env python3
"""Prepare 15 claw dolls from a read-only folder of source images.

    python3 scripts/prepare-claw-dolls.py /tmp/claw-dolls-src \
        [--first-number 2] [--output public/claw/dolls] [--preview /tmp/claw-dolls-preview]

Requires Python 3, Pillow with WebP support, and NumPy. Preserve existing
transparency, or remove the edge-connected plain backdrop in the product
photos. Crop to the silhouette and export 320px WebP with lossless alpha.
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


# Checked against the 1200px source photos. These are seeds on the white
# backdrop inside the large key ring and, where visible, its smaller eyelet.
# A clasp behind fabric and the bright reflection in the doctor's mirror stay.
RING_HOLES = {
    "02_간호사_치이카와.jpg": [(597, 180), (598, 368)],
    "03_간호사_하치와레.jpg": [(599, 167), (600, 365)],
    "04_간호사_우사기.jpg": [(597, 172), (600, 368)],
    "05_간호사_치이카와_뒷모습.jpg": [(598, 187)],
    "06_간호사_모몽가.jpg": [(592, 200), (597, 390)],
    "07_간호사_쿠리만쥬.jpg": [(598, 178), (601, 370)],
    "08_간호사_시사.jpg": [(596, 189), (602, 387)],
    "09_간호사_랏코.jpg": [(594, 162), (599, 355)],
    "10_간호사_헌책방.jpg": [(595, 174), (603, 359)],
    "11_간호사_풍뎅이.jpg": [(498, 260)],
    "12_간호사_오데.jpg": [(597, 130), (599, 325)],
    "13_간호사_포셰트_갑옷상.jpg": [(598, 127)],
    "14_간호사_그_녀석.jpg": [(598, 203), (600, 401)],
    "15_의사_우사기.jpg": [(597, 177)],
    "16_의사_랏코.jpg": [(588, 176), (592, 366)],
}


def cutout(image: Image.Image, filename: str) -> Image.Image:
    rgb = np.asarray(image, dtype=np.int16)
    border = np.concatenate((rgb[0], rgb[-1], rgb[:, 0], rgb[:, -1]))
    bg = np.median(border, axis=0)
    if np.percentile(np.abs(border - bg).max(axis=1), 85) > 18:
        raise ValueError("Backdrop along the image border is not uniform")
    # The supplied products have an even white backdrop and no floor shadow.
    # A narrow luminance and chroma tolerance preserves white hats and fur.
    delta = rgb - bg
    passable = (np.abs(delta.mean(axis=2)) < 6) & (np.ptp(delta, axis=2) < 6)
    padded = np.pad(passable, 1, constant_values=True)
    fill = Image.fromarray(padded.astype("uint8")).copy()
    ImageDraw.floodfill(fill, (0, 0), 2)
    for x, y in RING_HOLES.get(unicodedata.normalize("NFC", filename), []):
        if image.size != (1200, 1200) or not passable[y, x]:
            raise ValueError("Key-ring seed does not match the source image")
        ImageDraw.floodfill(fill, (x + 1, y + 1), 2)
    solid = np.asarray(fill)[1:-1, 1:-1] != 2
    # Each photographed doll and its key ring form a single component.
    # Keep the connected foreground nearest its centroid and discard specks.
    ys, xs = np.nonzero(solid)
    if not len(xs):
        raise ValueError("No foreground remained after background removal")
    seed = np.argmin((xs - xs.mean()) ** 2 + (ys - ys.mean()) ** 2)
    body = Image.fromarray(solid.astype("uint8")).copy()
    ImageDraw.floodfill(body, (int(xs[seed]), int(ys[seed])), 2)
    alpha = Image.fromarray((np.asarray(body) == 2).astype("uint8") * 255)
    return clipped_alpha(alpha.filter(ImageFilter.GaussianBlur(.7)))


def prepare_image(image: Image.Image, filename: str) -> Image.Image:
    image = ImageOps.exif_transpose(image).convert("RGBA")
    alpha = clipped_alpha(image.getchannel("A"))
    if alpha.getextrema()[0] == 255:
        alpha = cutout(image.convert("RGB"), filename)
    image.putalpha(alpha)
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
    print("type\tfilename\toriginal_px\toriginal_bytes\twebp_bytes\twebp_px")
    for n, path in zip(DOLL_TYPES, paths):
        try:
            with Image.open(path) as original:
                source_width, source_height = original.size
                image = prepare_image(original, path.name)
            blob = encode(image)
        except (ValueError, OSError) as exc:
            raise ValueError(f"type {n}, {path.name}: {exc}") from exc
        blobs.append(blob)
        original_bytes = path.stat().st_size
        original_total += original_bytes
        print(f"{n}\t{path.name}\t{source_width}x{source_height}\t{original_bytes}\t"
              f"{len(blob)}\t{image.width}x{image.height}")
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
