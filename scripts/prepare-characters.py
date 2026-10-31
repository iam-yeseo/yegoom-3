#!/usr/bin/env python3
"""Slice the final character sheets without changing their production pixels.

Originals: Google Drive, YEGOOM 3/characterImg (user-provided, read-only).
Usage: python3 scripts/prepare-characters.py <characterImg copy> <output folder>
Requires Python 3, Pillow (with WebP support), and numpy. PNG crops preserve all
RGBA channels, including hidden RGB. Only QA images are resized or annotated.
Reproducible bytes require the same Pillow/libwebp versions between runs.
"""

import argparse
import csv
import hashlib
import io
import json
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFont, features


KEYS = ("axolotl", "drop", "cat", "bunny", "bread", "manta", "moon", "monkey")
PLAYBACK_MS = {"idle": 1800, "happy": 1200, "sleepy": 2400, "greet": 900, "jump": 680}
CELL = 512
BASELINE = 470
WEBP_TARGET = 200_000
DARK = "#3A3340"
BACKGROUNDS = ("#FFF9EE", DARK, "#E3F6EE", "#FFE6DF", "#FFF4CC", "#EEE8FC", "#E3F1FC")
# The current eight idle f0 frames have open eyes. A reviewed replacement may
# select its first open-eye frame here; this never alters or repositions pixels.
STILL_FRAMES = {}
# Add observations only after inspecting the contact sheets/GIFs, not by colour
# heuristics (which would confuse intended expressions with design changes).
VISUAL_FLAGS = {}
# Manual edge review passed at 512/96/40px on all seven backgrounds. Tie that
# observation to the exact eight RGBA stills, never to arbitrary future inputs.
REVIEWED_EDGE_PIXELS = "8d278ca921f6fb3d41b8803b9e23dd1ad56bd8e2c552276a6a5c2a1de12ad334"
FIELDS = ("file", "kind", "key", "state", "frame", "body_bbox", "body_long_side",
          "bottom_margin", "center_x", "bytes", "qa", "reasons", "webp_quality",
          "duration_ms")
FONT = ImageFont.load_default(size=15)


def json_value(value):
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


def inspect_frame(frame, state, index):
    alpha = np.asarray(frame)[:, :, 3]
    failures, flags = [], []
    border = np.concatenate((alpha[0], alpha[-1], alpha[1:-1, 0], alpha[1:-1, -1]))
    if np.any(border):
        failures.append(f"f{index}: nontransparent 1px cell border/background")
    y, x = np.where(alpha >= 200)
    if not len(x):
        failures.append(f"f{index}: empty body (alpha >= 200)")
        return {"bbox": None, "long_side": None, "bottom": None, "center": None,
                "failures": failures, "flags": flags}
    # Right/bottom bbox coordinates are exclusive, as in Pillow.crop/getbbox.
    box = [int(x.min()), int(y.min()), int(x.max()) + 1, int(y.max()) + 1]
    bottom = CELL - box[3]
    center = (box[0] + box[2]) / 2
    longest = max(box[2] - box[0], box[3] - box[1])
    if state != "jump" and not 37 <= bottom <= 45:
        flags.append(f"f{index}: bottom margin {bottom}px outside 41 +/- 4")
    if not 246 <= center <= 266:
        flags.append(f"f{index}: center x={center:g} outside 256 +/- 10")
    return {"bbox": box, "long_side": longest, "bottom": bottom, "center": center,
            "failures": failures, "flags": flags}


def load_sheets(source):
    expected = {f"{key}_sprites/{key}_{state}.png" for key in KEYS for state in PLAYBACK_MS}
    actual = {p.relative_to(source).as_posix() for p in source.rglob("*") if p.is_file()}
    if actual != expected:
        raise ValueError(f"Input files differ: missing={sorted(expected - actual)}, extra={sorted(actual - expected)}")
    sheets = {}
    for key in KEYS:
        for state in PLAYBACK_MS:
            path = source / f"{key}_sprites/{key}_{state}.png"
            with Image.open(path) as image:
                if image.size != (1536, 1024):
                    raise ValueError(f"STOP: {path.name} is {image.size}, expected 1536x1024")
                # Format conversion is allowed. Missing transparency will be
                # recorded as a sheet FAIL by its opaque cell borders.
                if image.mode != "RGBA":
                    image = image.convert("RGBA")
                frames = [image.crop(((i % 3) * CELL, (i // 3) * CELL,
                                      (i % 3 + 1) * CELL, (i // 3 + 1) * CELL)) for i in range(6)]
            metrics = [inspect_frame(frame, state, i) for i, frame in enumerate(frames)]
            failures = [reason for metric in metrics for reason in metric["failures"]]
            flags = [reason for metric in metrics for reason in metric["flags"]]
            lengths = [metric["long_side"] for metric in metrics if metric["long_side"]]
            if state in ("idle", "sleepy") and lengths and max(lengths) > min(lengths) * 1.1:
                flags.append(f"body longest side {min(lengths)}-{max(lengths)}px differs by more than 10%")
            flags.extend(VISUAL_FLAGS.get((key, state), ()))
            status = "FAIL" if failures else "FLAG" if flags else "PASS"
            sheets[key, state] = {"frames": frames, "metrics": metrics, "qa": status,
                                  "reasons": failures + flags}
            print(f"{key:8s} {state:6s} {status:4s} {'; '.join(failures + flags) or '-'}")
    failed_idle = [key for key in KEYS if sheets[key, "idle"]["qa"] == "FAIL"]
    if failed_idle:
        raise ValueError(f"STOP: idle FAIL for {', '.join(failed_idle)}; no output generated")
    return sheets


def save_png(image, path):
    path.parent.mkdir(parents=True, exist_ok=True)
    image.save(path, format="PNG", optimize=True)


def on_background(image, size, colour):
    # This helper is used for QA only, never frames, stills, or sprite strips.
    scaled = image if image.size == (size, size) else image.resize((size, size), Image.Resampling.LANCZOS)
    canvas = Image.new("RGBA", (size, size), colour)
    canvas.alpha_composite(scaled)
    return canvas.convert("RGB")


def gif_durations(total):
    # GIF stores centiseconds. Distribute rounding so jump still totals 680ms.
    boundaries = [round(i * total / 60) * 10 for i in range(7)]
    return [boundaries[i + 1] - boundaries[i] for i in range(6)]


def save_preview(frames, path, total):
    previews = [on_background(frame, 256, DARK) for frame in frames]
    palette_source = Image.new("RGB", (256 * 6, 256), DARK)
    for i, frame in enumerate(previews):
        palette_source.paste(frame, (i * 256, 0))
    # One palette for all six frames avoids a different quantizer per frame.
    colours = palette_source.quantize(colors=255, method=Image.Quantize.MEDIANCUT).getpalette()[:765]
    palette = Image.new("P", (1, 1))
    palette.putpalette([58, 51, 64] + colours)
    indexed = [frame.quantize(palette=palette, dither=Image.Dither.NONE) for frame in previews]
    # Pillow's palette lookup may choose a neighbouring colour despite the
    # exact dark colour being present. Keep the requested background exact.
    for frame, quantized in zip(previews, indexed):
        background = np.all(np.asarray(frame) == (58, 51, 64), axis=2)
        quantized.paste(0, mask=Image.fromarray(background.astype(np.uint8) * 255))
    path.parent.mkdir(parents=True, exist_ok=True)
    indexed[0].save(path, format="GIF", save_all=True, append_images=indexed[1:],
                    duration=gif_durations(total), loop=0, disposal=2, optimize=False)


def save_strip(frames, path):
    strip = Image.new("RGBA", (CELL * 6, CELL))
    for i, frame in enumerate(frames):
        strip.paste(frame, (CELL * i, 0))  # No mask: retain all four channels.
    path.parent.mkdir(parents=True, exist_ok=True)
    for quality in (85, 80):
        strip.save(path, format="WEBP", quality=quality, alpha_quality=100,
                   lossless=False, method=6, exact=True)
        if path.stat().st_size <= WEBP_TARGET:
            break
    with Image.open(path) as decoded:
        if not np.array_equal(np.asarray(decoded.convert("RGBA"))[:, :, 3], np.asarray(strip)[:, :, 3]):
            raise ValueError(f"WebP alpha changed: {path.name}")
    if path.stat().st_size > WEBP_TARGET:
        print(f"SIZE FLAG {path.name}: {path.stat().st_size} bytes at quality 80 (resolution retained)")
    return quality


def worst_status(sheets):
    return max((sheet["qa"] for sheet in sheets), key={"PASS": 0, "FLAG": 1, "FAIL": 2}.get)


def contact_sheet(key, sheets):
    row_height = CELL + 34
    canvas = Image.new("RGB", (CELL * 6, row_height * len(PLAYBACK_MS)), DARK)
    draw = ImageDraw.Draw(canvas)
    for row, state in enumerate(PLAYBACK_MS):
        sheet = sheets[key, state]
        for i, (frame, metric) in enumerate(zip(sheet["frames"], sheet["metrics"])):
            x, y = i * CELL, row * row_height + 34
            canvas.paste(on_background(frame, CELL, DARK), (x, y))
            draw.text((x + 8, y - 27), f"{key} {state} f{i} | {sheet['qa']}", font=FONT, fill="white")
            draw.line((x, y + BASELINE, x + CELL - 1, y + BASELINE), fill="#FF70B7", width=1)
            if metric["bbox"]:
                left, top, right, bottom = metric["bbox"]
                draw.rectangle((x + left, y + top, x + right - 1, y + bottom - 1), outline="#75F6B4", width=1)
    return canvas


def edge_sheet(stills):
    # Each background shows the literal 512px crop plus 96px and 40px previews.
    cell_width, cell_height = 640, 560
    canvas = Image.new("RGB", (cell_width * len(BACKGROUNDS), cell_height * len(KEYS)))
    draw = ImageDraw.Draw(canvas)
    for row, key in enumerate(KEYS):
        for col, colour in enumerate(BACKGROUNDS):
            x, y = col * cell_width, row * cell_height
            draw.rectangle((x, y, x + cell_width - 1, y + cell_height - 1), fill=colour)
            ink = "white" if colour == DARK else DARK
            draw.text((x + 8, y + 7), f"{key}  {colour}  512px", font=FONT, fill=ink)
            canvas.paste(on_background(stills[key], 512, colour), (x + 8, y + 32))
            for size, dy in ((96, 32), (40, 184)):
                draw.text((x + 528, y + dy - 20), f"{size}px", font=FONT, fill=ink)
                canvas.paste(on_background(stills[key], size, colour), (x + 528, y + dy))
    return canvas


def edge_review_note(stills):
    digest = hashlib.sha256()
    for key in KEYS:
        digest.update(key.encode("ascii") + b"\0")
        digest.update(stills[key].tobytes())
    if digest.hexdigest() == REVIEWED_EDGE_PIXELS:
        return "Numeric idle-sheet QA; manual edge review PASS for these exact stills at all seven backgrounds and 512/96/40px"
    return "Numeric idle-sheet QA only; changed still pixels need a new manual edge review"


def make_row(path, output, kind, key="", state="", frame="", sheet=None, metric=None, **extra):
    row = dict.fromkeys(FIELDS, "")
    row.update(file=path.relative_to(output).as_posix(), kind=kind, key=key, state=state,
               frame=frame, bytes=path.stat().st_size, **extra)
    if sheet:
        row.update(qa=sheet["qa"], reasons="; ".join(sheet["reasons"]))
        measurements = [metric] if metric else sheet["metrics"]
        for field, source_field in (("body_bbox", "bbox"), ("body_long_side", "long_side"),
                                    ("bottom_margin", "bottom"), ("center_x", "center")):
            values = [item[source_field] for item in measurements]
            row[field] = json_value(values[0] if metric else values)
    return row


def write_manifest(rows, output):
    path = output / "manifest.csv"
    row = dict.fromkeys(FIELDS, "")
    row.update(file="manifest.csv", kind="manifest", bytes=0, qa=worst_status(rows))
    all_rows = rows + [row]
    # Include the manifest itself without an unknown/self-referential byte count.
    for _ in range(10):
        stream = io.StringIO(newline="")
        writer = csv.DictWriter(stream, fieldnames=FIELDS, lineterminator="\n")
        writer.writeheader()
        writer.writerows(all_rows)
        data = stream.getvalue().encode("utf-8")
        if row["bytes"] == len(data):
            path.write_bytes(data)
            return
        row["bytes"] = len(data)
    raise ValueError("Manifest byte count did not converge")


def prepare(source, output):
    source, output = source.resolve(), output.resolve()
    if source == output or source in output.parents or output in source.parents:
        raise ValueError("Input and output directories must be separate; originals are read-only")
    if not features.check("webp"):
        raise ValueError("Pillow must include WebP support")
    sheets = load_sheets(source)  # Validate every sheet before writing output.
    rows, stills = [], {}
    for key in KEYS:
        for state, duration in PLAYBACK_MS.items():
            sheet = sheets[key, state]
            for i, frame in enumerate(sheet["frames"]):
                path = output / f"frames/{key}/{key}_{state}_f{i}.png"
                save_png(frame, path)
                rows.append(make_row(path, output, "frame", key, state, i, sheet, sheet["metrics"][i]))
            path = output / f"sprites/{key}-{state}.webp"
            quality = save_strip(sheet["frames"], path)
            rows.append(make_row(path, output, "sprite", key, state, "0-5", sheet, webp_quality=quality, duration_ms=duration))
            path = output / f"qa/preview/{key}-{state}.gif"
            save_preview(sheet["frames"], path, duration)
            rows.append(make_row(path, output, "preview", key, state, "0-5", sheet, duration_ms=duration))
        idle = sheets[key, "idle"]
        index = STILL_FRAMES.get(key, 0)
        if index not in range(6):
            raise ValueError(f"Invalid still frame for {key}: {index}")
        if index:
            print(f"STILL OVERRIDE {key}: first reviewed open-eye frame f{index}")
        stills[key] = idle["frames"][index]
        path = output / f"stills/{key}.png"
        save_png(stills[key], path)
        rows.append(make_row(path, output, "still", key, "idle", index, idle, idle["metrics"][index]))
        path = output / f"qa/contact-{key}.png"
        save_png(contact_sheet(key, sheets), path)
        related = [sheets[key, state] for state in PLAYBACK_MS]
        rows.append(make_row(path, output, "contact", key, "all", "0-5", qa=worst_status(related),
                             reasons="; ".join(f"{state}: {reason}" for state in PLAYBACK_MS for reason in sheets[key, state]["reasons"])))
    path = output / "qa/edge-check.png"
    save_png(edge_sheet(stills), path)
    rows.append(make_row(path, output, "edge-check", "all", "idle", "0",
                         qa=worst_status(sheets[key, "idle"] for key in KEYS),
                         reasons=edge_review_note(stills)))
    write_manifest(rows, output)
    counts = {kind: sum(row["kind"] == kind for row in rows) for kind in ("frame", "still", "sprite", "preview", "contact", "edge-check")}
    sizes = {kind: sum(row["bytes"] for row in rows if row["kind"] == kind) for kind in ("still", "sprite")}
    idle_bytes = sum(row["bytes"] for row in rows if row["kind"] == "sprite" and row["state"] == "idle")
    print("OUTPUT", json_value(counts), "+ manifest.csv")
    print("BYTES", json_value({**sizes, "character_precache": sizes["still"] + idle_bytes}))
    print("QA", json_value({status: sum(sheet["qa"] == status for sheet in sheets.values()) for status in ("PASS", "FLAG", "FAIL")}))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", type=Path)
    parser.add_argument("output", type=Path)
    args = parser.parse_args()
    try:
        prepare(args.source, args.output)
    except (ValueError, OSError) as error:
        parser.exit(1, f"{error}\n")
