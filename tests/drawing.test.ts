import { describe, expect, it } from "vitest";
import { floodFill, type PixelImage, type Rgba } from "../src/drawing";

function pixels(rows: number[][]): PixelImage {
  return { width: rows[0].length, height: rows.length, data: new Uint8ClampedArray(rows.flatMap(row => row.flatMap(value => [value, value, value, 255]))) };
}
const pixel = (image: PixelImage, x: number, y: number) => Array.from(image.data.slice((y * image.width + x) * 4, (y * image.width + x) * 4 + 4));
const coral: Rgba = [255, 142, 122, 255];

describe("connected scanline fill", () => {
  it("fills only the tapped region, preserving the outline and disconnected equal colors", () => {
    const image = pixels([
      [255, 0, 0, 0, 0, 0, 255],
      [255, 0, 255, 255, 255, 0, 255],
      [255, 0, 255, 255, 255, 0, 255],
      [255, 0, 0, 0, 0, 0, 255],
    ]);
    expect(floodFill(image, 3, 2, coral)).toBe(6);
    expect(pixel(image, 2, 1)).toEqual(coral);
    expect(pixel(image, 4, 2)).toEqual(coral);
    expect(pixel(image, 0, 2)).toEqual([255, 255, 255, 255]);
    expect(pixel(image, 1, 2)).toEqual([0, 0, 0, 255]);
  });

  it("includes antialiased near-color edges within tolerance without crossing dark boundaries", () => {
    const image = pixels([[0, 230, 255, 224, 200, 0, 255]]);
    expect(floodFill(image, 2, 0, coral)).toBe(3);
    expect(pixel(image, 1, 0)).toEqual(coral);
    expect(pixel(image, 3, 0)).toEqual(coral);
    expect(pixel(image, 4, 0)).toEqual([200, 200, 200, 255]);
    expect(pixel(image, 6, 0)).toEqual([255, 255, 255, 255]);
  });

  it("follows a connected region around obstacles and branches on adjacent scanlines", () => {
    const image = pixels([[255, 255, 255, 255, 255], [255, 0, 255, 0, 255], [255, 255, 255, 255, 255]]);
    expect(floodFill(image, 0, 0, coral)).toBe(13);
    expect(pixel(image, 1, 1)).toEqual([0, 0, 0, 255]);
    expect(pixel(image, 4, 2)).toEqual(coral);
  });

  it("terminates when the replacement remains inside the source tolerance", () => {
    const image = pixels(Array.from({ length: 128 }, () => Array(128).fill(255)));
    expect(floodFill(image, 64, 64, [250, 250, 250, 255])).toBe(128 * 128);
    expect(floodFill(image, 64, 64, [250, 250, 250, 255])).toBe(0);
  });

  it("checks alpha, writes the requested opaque color, and ignores out-of-bounds taps", () => {
    const image = pixels([[255, 255]]);
    image.data[7] = 0;
    expect(floodFill(image, -1, 0, coral)).toBe(0);
    expect(floodFill(image, 2, 0, coral)).toBe(0);
    expect(floodFill(image, 0, 0, coral)).toBe(1);
    expect(pixel(image, 0, 0)).toEqual(coral);
    expect(pixel(image, 1, 0)).toEqual([255, 255, 255, 0]);
  });
});
