export interface HsvColor { h: number; s: number; v: number }
export interface RgbColor { r: number; g: number; b: number }
export interface PaintColor { hex: string; alpha: number }

export const INK_PALETTE = [
  ["#5E6A8A", "먹색"], ["#FF8E7A", "코랄"], ["#8FD9C0", "민트"],
  ["#8CC8F2", "하늘색"], ["#B9A3F0", "보라색"], ["#FFD866", "노란색"],
] as const;

export const clamp = (value: number, min = 0, max = 1) => Math.max(min, Math.min(max, value));

export function normalizeHex(value: string): string | null {
  const hex = value.trim().replace(/^#/, "");
  if (/^[\da-f]{3}$/i.test(hex)) return `#${[...hex].map(char => char + char).join("").toUpperCase()}`;
  return /^[\da-f]{6}$/i.test(hex) ? `#${hex.toUpperCase()}` : null;
}

export function hexToRgb(value: string): RgbColor {
  const hex = normalizeHex(value);
  if (!hex) throw new Error("올바른 HEX 색상이 아니에요.");
  return { r: parseInt(hex.slice(1, 3), 16), g: parseInt(hex.slice(3, 5), 16), b: parseInt(hex.slice(5, 7), 16) };
}

export function rgbToHsv({ r, g, b }: RgbColor): HsvColor {
  const red = clamp(r / 255), green = clamp(g / 255), blue = clamp(b / 255);
  const max = Math.max(red, green, blue), min = Math.min(red, green, blue), delta = max - min;
  let h = 0;
  if (delta) {
    if (max === red) h = ((green - blue) / delta) % 6;
    else if (max === green) h = (blue - red) / delta + 2;
    else h = (red - green) / delta + 4;
    h = (h * 60 + 360) % 360;
  }
  return { h, s: max ? delta / max : 0, v: max };
}

export const hexToHsv = (value: string) => rgbToHsv(hexToRgb(value));

export function hsvToHex({ h, s, v }: HsvColor): string {
  const hue = ((h % 360) + 360) % 360 / 60;
  const chroma = clamp(v) * clamp(s), x = chroma * (1 - Math.abs(hue % 2 - 1));
  const offset = clamp(v) - chroma;
  const channels = hue < 1 ? [chroma, x, 0] : hue < 2 ? [x, chroma, 0] : hue < 3 ? [0, chroma, x]
    : hue < 4 ? [0, x, chroma] : hue < 5 ? [x, 0, chroma] : [chroma, 0, x];
  return `#${channels.map(channel => Math.round((channel + offset) * 255).toString(16).padStart(2, "0")).join("").toUpperCase()}`;
}

/** Coordinates are viewport coordinates, so scrolling and CSS canvas scaling are harmless. */
export function saturationValueAt(
  clientX: number, clientY: number,
  rect: { left: number; top: number; width: number; height: number },
): Pick<HsvColor, "s" | "v"> {
  return { s: clamp((clientX - rect.left) / Math.max(1, rect.width)), v: 1 - clamp((clientY - rect.top) / Math.max(1, rect.height)) };
}

export function rememberColor(recent: string[], hex: string): string[] {
  const normalized = normalizeHex(hex);
  return normalized ? [normalized, ...recent.filter(color => color !== normalized)].slice(0, 5) : recent;
}
