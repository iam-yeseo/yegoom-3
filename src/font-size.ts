/** 내 정보 › 글자 크기. A per-device preference: only text sizes change (see vite.config.ts). */
export type FontSize = "small" | "normal" | "large";
export const FONT_SIZES: readonly { value: FontSize; label: string; scale: number }[] = [
  { value: "small", label: "작게", scale: 0.86 },
  { value: "normal", label: "보통", scale: 0.93 },
  { value: "large", label: "크게", scale: 1 },
];
/** The original design size. */
export const DEFAULT_FONT_SIZE: FontSize = "large";
const KEY = "yegoom3:font-size";

export function readFontSize(): FontSize {
  try {
    const value = localStorage.getItem(KEY);
    return FONT_SIZES.some(option => option.value === value) ? value as FontSize : DEFAULT_FONT_SIZE;
  } catch { return DEFAULT_FONT_SIZE; }
}
export function applyFontSize(size: FontSize) {
  const scale = FONT_SIZES.find(option => option.value === size)?.scale ?? 1;
  document.documentElement.style.setProperty("--font-scale", String(scale));
  document.documentElement.dataset.fontSize = size;
}
export function saveFontSize(size: FontSize) {
  applyFontSize(size);
  try { localStorage.setItem(KEY, size); } catch { /* Applies for this visit even without storage. */ }
}
