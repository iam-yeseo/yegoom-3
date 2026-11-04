import { MACHINE, CLAW, DOLL_TYPES, planDescent, type Board, type Doll, type SimulationFrame } from "../../shared/claw-physics";
import { reduced } from "../motion";

export interface ClawArm { x: number; y: number; closed: number; velocity: number; swing: number; swingVelocity: number }
export interface RenderScene {
  mode: string;
  claw: ClawArm;
  view: Pick<SimulationFrame, "dolls" | "held" | "chute">;
  board: Board | null;
  prizeFlashUntil: number;
}
export const dollSrc = (type: number) => `/claw/dolls/doll-${type}.webp`;

/** Original cabinet geometry and doll layering, drawn with the app palette. */
export function createRenderer(canvas: HTMLCanvasElement, onInvalidate: () => void = () => {}) {
  // Every frame fully covers this canvas with the opaque cabinet background.
  // Avoid an unnecessary alpha surface and compositor synchronization; the
  // transparent offscreen layers below still use their normal alpha contexts.
  const context = canvas.getContext("2d", { alpha: false, desynchronized: true });
  if (!context) throw new Error("그림을 표시할 수 없어요. 브라우저를 다시 열어 주세요.");
  const ctx: CanvasRenderingContext2D = context;
  const { width: W, height: H } = MACHINE;
  let alive = true;
  let resolution = 1;
  const spriteCache = new Map<string, { surface: HTMLCanvasElement; width: number; height: number }>();
  const layers: HTMLCanvasElement[] = [];
  let staticLayers: { background: HTMLCanvasElement; panel: HTMLCanvasElement; flashingPanel: HTMLCanvasElement; track: HTMLCanvasElement } | null = null;
  let previousDolls: Doll[] | null = null;
  let inputIds: string[] = [];
  let sortedIndices: number[] = [];
  const sortedDolls: Doll[] = [];
  let plannedBoard: Board | null = null;
  let plannedX = NaN, plannedBottom = 0;
  const sprites = [null, ...Array.from({ length: DOLL_TYPES }, (_, i) => {
    const image = new Image();
    image.decoding = "async";
    image.onload = () => {
      if (!alive) return;
      for (const [key, cached] of spriteCache) if (key.startsWith(`${i + 1}:`)) {
        cached.surface.width = cached.surface.height = 0;
        spriteCache.delete(key);
      }
      onInvalidate();
    };
    image.onerror = () => { if (alive) onInvalidate(); };
    image.src = dollSrc(i + 1);
    return image;
  })];
  function disposeLayers() {
    for (const layer of layers) layer.width = layer.height = 0;
    layers.length = 0;
    staticLayers = null;
  }
  function layer(paint: (target: CanvasRenderingContext2D) => void) {
    const surface = document.createElement("canvas");
    surface.width = canvas.width; surface.height = canvas.height;
    const target = surface.getContext("2d")!;
    target.setTransform(surface.width / W, 0, 0, surface.height / H, 0, 0);
    paint(target);
    layers.push(surface);
    return surface;
  }
  function background(target: CanvasRenderingContext2D) {
    target.fillStyle = '#E3F1FC'; target.fillRect(0, 0, W, H);
    target.fillStyle = '#D8CCF7'; target.fillRect(0, H - 28, W, 28);
    target.strokeStyle = '#3A3340'; target.lineWidth = 3;
    target.beginPath(); target.moveTo(0, H - 28); target.lineTo(W, H - 28); target.stroke();
    target.fillStyle = 'rgba(255,255,255,.11)';
    for (const [x, y, size] of [[80, 130, 5], [470, 85, 6], [420, 210, 4], [205, 100, 3]]) {
      target.beginPath(); target.arc(x, y, size, 0, Math.PI * 2); target.fill();
    }
  }
  function panel(target: CanvasRenderingContext2D, flash: boolean) {
    roundRect(target, 9, H - 100, 104, 92, 10, flash ? '#FFD866' : '#7C7383', '#3A3340', 4);
    roundRect(target, 18, H - 91, 86, 35, 7, '#3A3340');
    target.fillStyle = flash ? '#3A3340' : '#FFF9EE'; target.font = '800 13px TmoneyRoundWind, sans-serif'; target.textAlign = 'center';
    target.fillText('PRIZE OUT', 61, H - 26);
    target.fillStyle = '#F47C66'; target.beginPath(); target.moveTo(53, H - 49); target.lineTo(69, H - 49); target.lineTo(61, H - 39); target.closePath(); target.fill();
    roundRect(target, 114, H - MACHINE.dividerHeight, 9, MACHINE.dividerHeight, 3, '#8FD9C0', '#3A3340', 2);
    target.fillStyle = '#B9A3F0'; target.beginPath(); target.ellipse(358, H - 7, 217, 8, 0, 0, Math.PI * 2); target.fill();
  }
  function track(target: CanvasRenderingContext2D) {
    roundRect(target, 14, 4, W - 28, 14, 4, '#C9DDF0', '#3A3340', 3);
    target.strokeStyle = '#FFF9EE'; target.lineWidth = 3; target.beginPath(); target.moveTo(20, 8); target.lineTo(W - 20, 8); target.stroke();
  }
  function cabinet() {
    return staticLayers ??= {
      background: layer(background), panel: layer(target => panel(target, false)),
      flashingPanel: layer(target => panel(target, true)), track: layer(track),
    };
  }
  function drawLayer(surface: HTMLCanvasElement, top: number, bottom: number) {
    // Copy only the strip containing artwork. Integer backing-pixel boundaries
    // and matching destinations preserve the original 1:1 sample alignment.
    const scale = surface.height / H;
    const first = Math.max(0, Math.floor(top * scale));
    const last = Math.min(surface.height, Math.ceil(bottom * scale));
    ctx.drawImage(surface, 0, first, surface.width, last - first, 0, first / scale, W, (last - first) / scale);
  }
  function orderedDolls(dolls: Doll[]) {
    if (dolls === previousDolls) return sortedDolls;
    const sameIds = dolls.length === inputIds.length && dolls.every((doll, index) => doll.id === inputIds[index]);
    if (!sameIds) {
      inputIds = dolls.map(doll => doll.id);
      sortedIndices = dolls.map((_, index) => index);
    }
    // Frames often contain new objects whose relative height order did not
    // change. Keep their indices and update references without sorting again.
    let ordered = sameIds;
    for (let i = 1; ordered && i < sortedIndices.length; i++) {
      const before = sortedIndices[i - 1], after = sortedIndices[i];
      ordered = dolls[before].y < dolls[after].y || dolls[before].y === dolls[after].y && before < after;
    }
    if (!ordered) sortedIndices.sort((a, b) => dolls[a].y - dolls[b].y || a - b);
    sortedDolls.length = dolls.length;
    for (let i = 0; i < sortedIndices.length; i++) sortedDolls[i] = dolls[sortedIndices[i]];
    previousDolls = dolls;
    return sortedDolls;
  }
  function descentBottom(board: Board, x: number) {
    if (board !== plannedBoard || x !== plannedX) {
      plannedBottom = planDescent(board, x).bottom;
      plannedBoard = board; plannedX = x;
    }
    return plannedBottom;
  }
  function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number, fill?: string, stroke?: string, line = 2) {
    ctx.beginPath(); ctx.roundRect(x, y, w, h, r);
    if (fill) { ctx.fillStyle = fill; ctx.fill(); }
    if (stroke) { ctx.strokeStyle = stroke; ctx.lineWidth = line; ctx.stroke(); }
  }

  function drawDoll(d: Doll) {
    const radius = d.radius ?? MACHINE.radius;
    const key = `${d.type}:${radius}`;
    let cached = spriteCache.get(key);
    if (!cached) {
      const surface = document.createElement("canvas");
      const sprite = sprites[d.type];
      const ratio = sprite?.naturalWidth && sprite.naturalHeight ? sprite.naturalWidth / sprite.naturalHeight : 1;
      const size = radius * 2.3;
      const dw = ratio >= 1 ? size : size * ratio;
      const dh = ratio >= 1 ? size / ratio : size;
      // The old five-pixel shadow is baked once at the current display scale.
      // Padding keeps its blur from clipping at every sprite's rectangle edge.
      const padding = 14 / resolution;
      const width = dw + padding * 2, height = dh + padding * 2;
      surface.width = Math.max(1, Math.ceil(width * resolution));
      surface.height = Math.max(1, Math.ceil(height * resolution));
      const target = surface.getContext("2d")!;
      target.setTransform(resolution, 0, 0, resolution, surface.width / 2, surface.height / 2);
      if (sprite?.complete && sprite.naturalWidth) {
        target.shadowColor = 'rgba(58,51,64,.16)'; target.shadowBlur = 5; target.shadowOffsetY = 4;
        target.drawImage(sprite, -dw / 2, -dh / 2, dw, dh);
      } else {
        target.font = `${radius * 1.65}px system-ui`; target.textAlign = 'center'; target.textBaseline = 'middle'; target.fillText('🧸', 0, 0);
      }
      cached = { surface, width: surface.width / resolution, height: surface.height / resolution };
      spriteCache.set(key, cached);
    }
    ctx.save(); ctx.translate(d.x, d.y); ctx.rotate(d.angle ?? 0);
    ctx.drawImage(cached.surface, -cached.width / 2, -cached.height / 2, cached.width, cached.height);
    ctx.restore();
  }

  function draw(time: number, scene: RenderScene) {
    if (!alive) return;
    const { view, claw, mode, board, prizeFlashUntil } = scene;
    const quiet = reduced();
    const cached = cabinet();
    ctx.drawImage(cached.background, 0, 0, W, H);
    // Preserve the original occlusion: chute prizes sit behind the front panel.
    for (const doll of view.chute) drawDoll(doll);
    const flash = !quiet && time < prizeFlashUntil && Math.floor(time / 120) % 2 === 0;
    // The divider begins at y160; two pixels leave room for its stroke.
    drawLayer(flash ? cached.flashingPanel : cached.panel, H - MACHINE.dividerHeight - 2, H);
    for (const doll of orderedDolls(view.dolls)) drawDoll(doll);

    // Where the claw would land: a soft spot of light, the way a cabinet lamp casts it.
    if (mode === 'ready' && board) {
      const bottom = descentBottom(board, claw.x);
      ctx.fillStyle = 'rgba(255,249,238,.45)';
      ctx.beginPath(); ctx.ellipse(claw.x * W, bottom + CLAW.body + 4, 18, 5, 0, 0, Math.PI * 2); ctx.fill();
    }

    // Static track stays above the dolls; the carriage and cable move below it.
    // The top rail's outer stroke ends at y19.5, below this conservative edge.
    drawLayer(cached.track, 0, 22);
    const cx = claw.x * W, cy = claw.y;
    roundRect(ctx, cx - 22, 0, 44, 24, 5, '#FFF9EE', '#3A3340', 3);
    ctx.strokeStyle = '#3A3340'; ctx.lineWidth = 6; ctx.beginPath(); ctx.moveTo(cx, 22); ctx.lineTo(cx, cy); ctx.stroke();
    ctx.strokeStyle = '#FFF9EE'; ctx.lineWidth = 3; ctx.beginPath(); ctx.moveTo(cx - 1, 22); ctx.lineTo(cx - 1, cy); ctx.stroke();

    if (view.held) drawDoll(view.held);
    // The hook rocks around its suspension while the carriage accelerates/coasts.
    ctx.save(); ctx.translate(cx, cy); ctx.rotate(quiet ? 0 : claw.swing); ctx.translate(-cx, -cy);
    const spread = 38 - 17 * claw.closed;
    for (const side of [-1, 1]) {
      ctx.beginPath(); ctx.moveTo(cx + side * 14, cy + 21);
      ctx.quadraticCurveTo(cx + side * (spread + 16), cy + 44, cx + side * spread, cy + 65);
      ctx.quadraticCurveTo(cx + side * (spread - 5), cy + 76, cx + side * (spread - 14), cy + 80 - claw.closed * 7);
      ctx.strokeStyle = '#3A3340'; ctx.lineWidth = 8; ctx.lineCap = 'round'; ctx.stroke();
      ctx.strokeStyle = '#FFF9EE'; ctx.lineWidth = 4; ctx.stroke();
    }
    ctx.beginPath(); ctx.moveTo(cx, cy + 24); ctx.lineTo(cx + 6, cy + 60); ctx.lineTo(cx + 2, cy + 69);
    ctx.strokeStyle = '#7C7383'; ctx.lineWidth = 5; ctx.stroke();
    roundRect(ctx, cx - 25, cy, 50, 29, 7, '#FFF9EE', '#3A3340', 4);
    ctx.fillStyle = mode === 'ready' || mode === 'descending' ? (!quiet && Math.floor(time / 300) % 2 ? '#FFD866' : '#F47C66') : '#FFD866';
    ctx.beginPath(); ctx.arc(cx - 12, cy + 12, 4, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
  }

  function resize() {
    if (!alive) return;
    const bounds = canvas.getBoundingClientRect();
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    const width = Math.max(1, Math.round(bounds.width * ratio));
    const height = Math.max(1, Math.round(bounds.height * ratio));
    resolution = Math.max(width / W, height / H);
    const changed = canvas.width !== width || canvas.height !== height;
    if (changed) {
      canvas.width = width; canvas.height = height;
      for (const cached of spriteCache.values()) cached.surface.width = cached.surface.height = 0;
      spriteCache.clear();
      disposeLayers();
    }
    ctx.setTransform(width / W, 0, 0, height / H, 0, 0);
    if (changed) {
      // An opaque backing store starts black after resize. Paint the cabinet's
      // base before the next animation frame so it cannot flash through.
      ctx.fillStyle = '#E3F1FC'; ctx.fillRect(0, 0, W, H);
      onInvalidate();
    }
  }
  resize();
  const observer = new ResizeObserver(resize);
  observer.observe(canvas);
  window.addEventListener("resize", resize);
  // Text in the cached chute panel must use the loaded app font, even if the
  // controller has already stopped its idle animation loop.
  void document.fonts?.ready.then(() => {
    if (!alive) return;
    disposeLayers();
    for (const cached of spriteCache.values()) cached.surface.width = cached.surface.height = 0;
    spriteCache.clear();
    onInvalidate();
  });
  return { draw, resize, destroy() {
    alive = false;
    observer.disconnect(); window.removeEventListener("resize", resize);
    for (const image of sprites) if (image) { image.onload = null; image.onerror = null; }
    for (const cached of spriteCache.values()) cached.surface.width = cached.surface.height = 0;
    spriteCache.clear(); disposeLayers();
  } };
}
