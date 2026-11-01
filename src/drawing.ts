export const CANVAS_BACKGROUND = "#FFFDF8";
export interface PixelImage { width: number; height: number; data: Uint8ClampedArray }
export type Rgba = readonly [number, number, number, number];

/** Connected scanline fill. The tolerance includes near-color antialiased edge pixels. */
export function floodFill(image: PixelImage, startX: number, startY: number, color: Rgba, tolerance = 32): number {
  const { width, height, data } = image;
  const x = Math.floor(startX), y = Math.floor(startY);
  if (x < 0 || x >= width || y < 0 || y >= height) return 0;
  const start = (y * width + x) * 4;
  const target = Array.from(data.slice(start, start + 4));
  if (color.every((channel, index) => channel === target[index])) return 0;
  const visited = new Uint8Array(width * height);
  const matches = (px: number, py: number) => {
    const pixel = py * width + px, offset = pixel * 4;
    return !visited[pixel] && target.every((channel, index) => Math.abs(data[offset + index] - channel) <= tolerance);
  };
  const stack: [number, number][] = [[x, y]];
  let changed = 0;
  while (stack.length) {
    const [seedX, row] = stack.pop()!;
    if (!matches(seedX, row)) continue;
    let left = seedX;
    while (left > 0 && matches(left - 1, row)) left--;
    let above = false, below = false;
    for (let col = left; col < width && matches(col, row); col++) {
      const pixel = row * width + col, offset = pixel * 4;
      visited[pixel] = 1;
      if (color.some((channel, index) => channel !== data[offset + index])) {
        data.set(color, offset);
        changed++;
      }
      const nextAbove = row > 0 && matches(col, row - 1);
      const nextBelow = row < height - 1 && matches(col, row + 1);
      if (nextAbove && !above) stack.push([col, row - 1]);
      if (nextBelow && !below) stack.push([col, row + 1]);
      above = nextAbove;
      below = nextBelow;
    }
  }
  return changed;
}
