export const CANVAS_BACKGROUND = "#FFFDF8";
export interface PixelImage { width: number; height: number; data: Uint8ClampedArray }
export type Rgba = readonly [number, number, number, number];

/** Connected scanline fill. The tolerance includes near-color antialiased edge pixels. */
export function floodFill(image: PixelImage, startX: number, startY: number, color: Rgba, tolerance = 32): number {
  const { width, height, data } = image;
  const x = Math.floor(startX), y = Math.floor(startY);
  if (x < 0 || x >= width || y < 0 || y >= height) return 0;
  const start = (y * width + x) * 4;
  const red = data[start], green = data[start + 1], blue = data[start + 2], alpha = data[start + 3];
  const [r, g, b, a] = color;
  if (r === red && g === green && b === blue && a === alpha) return 0;
  const redLow = red - tolerance, redHigh = red + tolerance;
  const greenLow = green - tolerance, greenHigh = green + tolerance;
  const blueLow = blue - tolerance, blueHigh = blue + tolerance;
  const alphaLow = alpha - tolerance, alphaHigh = alpha + tolerance;
  const visited = new Uint8Array(width * height);
  const matches = (pixel: number) => {
    const offset = pixel * 4;
    return !visited[pixel]
      && data[offset] >= redLow && data[offset] <= redHigh
      && data[offset + 1] >= greenLow && data[offset + 1] <= greenHigh
      && data[offset + 2] >= blueLow && data[offset + 2] <= blueHigh
      && data[offset + 3] >= alphaLow && data[offset + 3] <= alphaHigh;
  };
  // Flat pixel indices avoid allocating coordinate/channel arrays in the loop.
  const stack: number[] = [y * width + x];
  let changed = 0;
  while (stack.length) {
    const seed = stack.pop()!;
    if (!matches(seed)) continue;
    const row = Math.floor(seed / width), rowStart = row * width, rowEnd = rowStart + width;
    let left = seed;
    while (left > rowStart && matches(left - 1)) left--;
    let above = false, below = false;
    for (let current = left; current < rowEnd && matches(current); current++) {
      const offset = current * 4;
      visited[current] = 1;
      if (data[offset] !== r || data[offset + 1] !== g || data[offset + 2] !== b || data[offset + 3] !== a) {
        data[offset] = r; data[offset + 1] = g; data[offset + 2] = b; data[offset + 3] = a;
        changed++;
      }
      const nextAbove = row > 0 && matches(current - width);
      const nextBelow = row + 1 < height && matches(current + width);
      if (nextAbove && !above) stack.push(current - width);
      if (nextBelow && !below) stack.push(current + width);
      above = nextAbove;
      below = nextBelow;
    }
  }
  return changed;
}
