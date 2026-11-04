/** Display geometry stays in CSS pixels even when the backing bitmap is frozen
 * after scratching starts and a later viewport resize scales that bitmap. */
export const SCRATCH_RADIUS = 17;
export const SCRATCH_LABEL = "여기를 긁어보세요";
export const SCRATCH_FONT = "800 20px TmoneyRoundWind";

export function scratchBitmapSize(width: number, height: number, deviceRatio: number) {
  const ratio = Number.isFinite(deviceRatio) && deviceRatio > 0 ? Math.min(deviceRatio, 2) : 1;
  return { width: Math.max(1, Math.round(width * ratio)), height: Math.max(1, Math.round(height * ratio)) };
}

export function scratchMark(x: number, y: number, displayWidth: number, displayHeight: number, width: number, height: number) {
  return { x: x * width / displayWidth, y: y * height / displayHeight,
    radiusX: SCRATCH_RADIUS * width / displayWidth, radiusY: SCRATCH_RADIUS * height / displayHeight };
}

interface ScratchPixels { width: number; height: number; data: Uint8ClampedArray }
/** Sample a fixed CSS-pixel grid, not a different density for each DPR. */
export function scratchedRatio(image: ScratchPixels, displayWidth: number, displayHeight: number): number {
  if (!(displayWidth > 0 && displayHeight > 0 && image.width > 0 && image.height > 0)) return 0;
  let clear = 0, total = 0;
  for (let y = 4; y < displayHeight; y += 10) for (let x = 4; x < displayWidth; x += 10) {
    const pixelX = Math.min(image.width - 1, Math.floor(x * image.width / displayWidth));
    const pixelY = Math.min(image.height - 1, Math.floor(y * image.height / displayHeight));
    total++;
    if (image.data[(pixelY * image.width + pixelX) * 4 + 3] < 40) clear++;
  }
  return total ? clear / total : 0;
}
