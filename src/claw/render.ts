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
export function createRenderer(canvas: HTMLCanvasElement) {
  const context = canvas.getContext("2d");
  if (!context) throw new Error("그림을 표시할 수 없어요. 브라우저를 다시 열어 주세요.");
  const ctx: CanvasRenderingContext2D = context;
  const { width: W, height: H } = MACHINE;
  const sprites = [null, ...Array.from({ length: DOLL_TYPES }, (_, i) => {
    const image = new Image(); image.src = dollSrc(i + 1); return image;
  })];
function roundRect(x: number, y: number, w: number, h: number, r: number, fill?: string, stroke?: string, line = 2) {
  ctx.beginPath(); ctx.roundRect(x, y, w, h, r);
  if (fill) { ctx.fillStyle = fill; ctx.fill(); }
  if (stroke) { ctx.strokeStyle = stroke; ctx.lineWidth = line; ctx.stroke(); }
}

function drawDoll(d: Doll) {
  const r = d.radius ?? MACHINE.radius;
  ctx.save(); ctx.translate(d.x, d.y); ctx.rotate(d.angle ?? 0);
  const sprite = sprites[d.type];
  if (sprite?.complete && sprite.naturalWidth) {
    const ratio = sprite.naturalWidth / sprite.naturalHeight;
    const size = r * 2.3;
    const dw = ratio >= 1 ? size : size * ratio;
    const dh = ratio >= 1 ? size / ratio : size;
    ctx.shadowColor = 'rgba(58,51,64,.16)'; ctx.shadowBlur = 5; ctx.shadowOffsetY = 4;
    ctx.drawImage(sprite, -dw / 2, -dh / 2, dw, dh);
  } else {
    ctx.font = `${r * 1.65}px system-ui`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText('🧸', 0, 0);
  }
  ctx.restore();
}

function draw(time: number, scene: RenderScene) {
  const { view, claw, mode, board, prizeFlashUntil } = scene;
  const quiet = reduced();
  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = '#E3F1FC'; ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = '#D8CCF7'; ctx.fillRect(0, H - 28, W, 28);
  ctx.strokeStyle = '#3A3340'; ctx.lineWidth = 3;
  ctx.beginPath(); ctx.moveTo(0, H - 28); ctx.lineTo(W, H - 28); ctx.stroke();
  ctx.fillStyle = 'rgba(255,255,255,.11)';
  for (const [x, y, size] of [[80, 130, 5], [470, 85, 6], [420, 210, 4], [205, 100, 3]]) {
    ctx.beginPath(); ctx.arc(x, y, size, 0, Math.PI * 2); ctx.fill();
  }
  // Prizes fall into the recessed chute and disappear behind its front panel.
  for (const doll of view.chute) drawDoll(doll);
  const flash = !quiet && time < prizeFlashUntil && Math.floor(time / 120) % 2 === 0;
  roundRect(9, H - 100, 104, 92, 10, flash ? '#FFD866' : '#7C7383', '#3A3340', 4);
  roundRect(18, H - 91, 86, 35, 7, '#3A3340');
  ctx.fillStyle = flash ? '#3A3340' : '#FFF9EE'; ctx.font = '800 13px TmoneyRoundWind, sans-serif'; ctx.textAlign = 'center';
  ctx.fillText('PRIZE OUT', 61, H - 26);
  ctx.fillStyle = '#F47C66'; ctx.beginPath(); ctx.moveTo(53, H - 49); ctx.lineTo(69, H - 49); ctx.lineTo(61, H - 39); ctx.closePath(); ctx.fill();
  roundRect(114, H - MACHINE.dividerHeight, 9, MACHINE.dividerHeight, 3, '#8FD9C0', '#3A3340', 2);
  ctx.fillStyle = '#B9A3F0'; ctx.beginPath(); ctx.ellipse(358, H - 7, 217, 8, 0, 0, Math.PI * 2); ctx.fill();
  for (const doll of [...view.dolls].sort((a, b) => a.y - b.y)) drawDoll(doll);

  // Where the claw would land: a soft spot of light, the way a cabinet lamp casts it.
  if (mode === 'ready' && board) {
    const { bottom } = planDescent(board!, claw.x);
    ctx.fillStyle = 'rgba(255,249,238,.45)';
    ctx.beginPath(); ctx.ellipse(claw.x * W, bottom + CLAW.body + 4, 18, 5, 0, 0, Math.PI * 2); ctx.fill();
  }

  // Overhead track and the travelling carriage.
  roundRect(14, 4, W - 28, 14, 4, '#C9DDF0', '#3A3340', 3);
  ctx.strokeStyle = '#FFF9EE'; ctx.lineWidth = 3; ctx.beginPath(); ctx.moveTo(20, 8); ctx.lineTo(W - 20, 8); ctx.stroke();
  const cx = claw.x * W, cy = claw.y;
  roundRect(cx - 22, 0, 44, 24, 5, '#FFF9EE', '#3A3340', 3);
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
  roundRect(cx - 25, cy, 50, 29, 7, '#FFF9EE', '#3A3340', 4);
  ctx.fillStyle = mode === 'ready' || mode === 'descending' ? (!quiet && Math.floor(time / 300) % 2 ? '#FFD866' : '#F47C66') : '#FFD866';
  ctx.beginPath(); ctx.arc(cx - 12, cy + 12, 4, 0, Math.PI * 2); ctx.fill();
  ctx.restore();
}

  function resize() {
    const bounds = canvas.getBoundingClientRect();
    const ratio = Math.min(window.devicePixelRatio || 1, 3);
    const width = Math.max(1, Math.round(bounds.width * ratio));
    const height = Math.max(1, Math.round(bounds.height * ratio));
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width; canvas.height = height;
    }
    ctx.setTransform(width / W, 0, 0, height / H, 0, 0);
  }
  resize();
  const observer = new ResizeObserver(resize);
  observer.observe(canvas);
  window.addEventListener("resize", resize);
  return { draw, resize, destroy() { observer.disconnect(); window.removeEventListener("resize", resize); } };
}
