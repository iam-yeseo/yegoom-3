import { describe, expect, it } from "vitest";
import { SCRATCH_RADIUS, scratchBitmapSize, scratchMark, scratchedRatio } from "../src/scratch";

function halfCleared(ratio: number) {
  const width = 100 * ratio, height = 60 * ratio;
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = width / 2; x < width; x++) data[(y * width + x) * 4 + 3] = 255;
  return { width, height, data };
}

describe("scratch display and coverage coordinates", () => {
  it("keeps one CSS brush circle at DPR1, DPR2 and a later stretched display", () => {
    for (const [displayWidth, displayHeight, width, height] of [[300, 150, 300, 150], [300, 150, 600, 300], [500, 150, 600, 300]]) {
      const mark = scratchMark(90, 60, displayWidth, displayHeight, width, height);
      expect(mark.x / width * displayWidth).toBeCloseTo(90);
      expect(mark.y / height * displayHeight).toBeCloseTo(60);
      expect(mark.radiusX / width * displayWidth).toBeCloseTo(SCRATCH_RADIUS);
      expect(mark.radiusY / height * displayHeight).toBeCloseTo(SCRATCH_RADIUS);
    }
  });
  it("caps high-density bitmaps at twice the actual display size", () => {
    expect(scratchBitmapSize(343, 150, 1)).toEqual({ width: 343, height: 150 });
    expect(scratchBitmapSize(343, 150, 3)).toEqual({ width: 686, height: 300 });
    expect(scratchBitmapSize(319.5, 150, 1.5)).toEqual({ width: 479, height: 225 });
    expect(scratchBitmapSize(343, 150, .75)).toEqual({ width: 257, height: 113 });
  });
  it("measures the same erased region at each device scale", () => {
    expect(scratchedRatio(halfCleared(1), 100, 60)).toBe(.5);
    expect(scratchedRatio(halfCleared(2), 100, 60)).toBe(.5);
    expect(scratchedRatio(halfCleared(3), 100, 60)).toBe(.5);
  });
  it("keeps coverage meaningful when an in-progress bitmap scales after resize", () => {
    const image = halfCleared(2);
    expect(scratchedRatio(image, 100, 60)).toBe(.5);
    expect(scratchedRatio(image, 200, 60)).toBe(.5);
  });
  it("uses the original transparency threshold without NaN for an empty display", () => {
    const image = { width: 20, height: 10, data: new Uint8ClampedArray(20 * 10 * 4).fill(255) };
    image.data[(4 * image.width + 4) * 4 + 3] = 39;
    image.data[(4 * image.width + 14) * 4 + 3] = 40;
    expect(scratchedRatio(image, 20, 10)).toBe(.5);
    expect(scratchedRatio(image, 0, 0)).toBe(0);
  });
});
