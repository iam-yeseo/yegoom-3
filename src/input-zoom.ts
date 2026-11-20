/** iOS Safari zooms the whole page in when a focused field's text is smaller
 * than 16px, and leaves it zoomed afterwards. Most fields here are smaller than
 * that (and the 글자 크기 setting scales them down further), so on iOS the
 * viewport is told not to zoom by itself. Pinching still zooms: iOS ignores
 * this limit for the user's own gesture. Other browsers do not zoom on focus,
 * and there the limit would take pinch-zoom away, so they are left alone. */
export function isIos(navigator: { userAgent: string; platform?: string; maxTouchPoints?: number }): boolean {
  // An iPad asking for the desktop site calls itself a Mac, but a Mac has no touch screen.
  return /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && (navigator.maxTouchPoints ?? 0) > 1);
}
/** The viewport content with automatic zoom switched off (idempotent). */
export function withoutFocusZoom(content: string): string {
  const parts = content.split(",").map(part => part.trim()).filter(part => part && !/^maximum-scale\s*=/.test(part));
  return [...parts, "maximum-scale=1"].join(", ");
}
export function preventFocusZoom() {
  if (!isIos(navigator)) return;
  const viewport = document.querySelector<HTMLMetaElement>('meta[name="viewport"]');
  if (viewport) viewport.content = withoutFocusZoom(viewport.content);
}
