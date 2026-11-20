import { BACK_LINE, SHEET, aimDirection, type StonePosition } from "../../shared/curling-physics";

/** Logical canvas size; the buffer is scaled by devicePixelRatio (max 2). */
export const STAGE = { width: 360, height: 560 } as const;
/** The sheet is drawn from straight above: pixels per metre and where the release point sits. */
export const SCALE = 64;
export const RELEASE = { x: STAGE.width / 2, y: 492 };
export const STONE_RADIUS = SHEET.stoneRadius * SCALE;
export const toScreen = (x: number, y: number) => ({ x: RELEASE.x + x * SCALE, y: RELEASE.y - y * SCALE });

export interface Scene {
  /** Stones lying or sliding on the sheet. */
  stones: StonePosition[];
  /** The stone waiting at the release point (null while one is sliding or the end is over). */
  ready: { id: number; offset: number; held: boolean } | null;
  aim: number;
  /** The newest stone, ringed so it is easy to follow. */
  latest: number | null;
  /** The ice is being brushed: where the broom is (logical pixels) and a clock for its wiggle. */
  sweep: { at: { x: number; y: number } | null; phase: number } | null;
}
export const STONE_SRC = "/curling/stone.webp";
const COLORS = { ice: "#eaf6fb", edge: "#cfe6f0", line: "#b9d3df", hog: "#f47c66", blue: "#8cc4ea", white: "#ffffff", red: "#f69a88", text: "#8aa5b3" };

export class CurlingRenderer {
  private ctx: CanvasRenderingContext2D;
  private backdrop: HTMLCanvasElement | null = null;
  private ratio = 1;
  private sprite: HTMLImageElement | null = null;
  /** onReady repaints once the stone picture has loaded; until then (or if it
   * fails) the stone is drawn with gradients. */
  constructor(private canvas: HTMLCanvasElement, onReady?: () => void) {
    const ctx = canvas.getContext("2d", { alpha: false });
    if (!ctx) throw new Error("이 브라우저에서는 시트를 그릴 수 없어요.");
    this.ctx = ctx;
    if (typeof Image !== "undefined") {
      const sprite = new Image();
      sprite.decoding = "async";
      sprite.onload = () => { this.sprite = sprite; onReady?.(); };
      sprite.src = STONE_SRC;
    }
  }
  /** Matches the buffer to the displayed size; returns true when it changed. */
  resize(): boolean {
    const rect = this.canvas.getBoundingClientRect();
    const ratio = Math.min(2, window.devicePixelRatio || 1) * (rect.width ? rect.width / STAGE.width : 1);
    const width = Math.round(STAGE.width * ratio), height = Math.round(STAGE.height * ratio);
    if (width === this.canvas.width && height === this.canvas.height) { if (this.ratio !== ratio) { this.ratio = ratio; this.backdrop = null; } return false; }
    this.canvas.width = width; this.canvas.height = height; this.ratio = ratio; this.backdrop = null;
    return true;
  }
  draw(scene: Scene) {
    const { ctx } = this;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    if (!this.backdrop) this.backdrop = this.paintBackdrop();
    ctx.drawImage(this.backdrop, 0, 0);
    ctx.setTransform(this.ratio, 0, 0, this.ratio, 0, 0);
    if (scene.ready) this.aimLine(scene.aim);
    for (const stone of scene.stones) { const at = toScreen(stone.x, stone.y); this.stone(at.x, at.y, stone.id === scene.latest, false); }
    if (scene.ready) this.stone(RELEASE.x, RELEASE.y + scene.ready.offset, true, scene.ready.held);
    if (scene.sweep?.at) this.broom(scene.sweep.at.x, scene.sweep.at.y, scene.sweep.phase);
  }
  /** A little broom scrubbing side to side, with the polished streaks it leaves. */
  private broom(x: number, y: number, phase: number) {
    const { ctx } = this, swing = Math.sin(phase / 38) * 9;
    ctx.save();
    ctx.lineCap = "round";
    ctx.strokeStyle = "rgba(255, 255, 255, 0.95)"; ctx.lineWidth = 3;
    for (const [dx, dy, length] of [[-14, 10, 16], [2, 16, 20], [14, 9, 14]] as const) {
      ctx.beginPath(); ctx.moveTo(x + dx - length / 2 - swing * 0.4, y + dy); ctx.lineTo(x + dx + length / 2 - swing * 0.4, y + dy); ctx.stroke();
    }
    ctx.translate(x + swing, y);
    ctx.strokeStyle = "#8d6e4f"; ctx.lineWidth = 4;
    ctx.beginPath(); ctx.moveTo(0, -2); ctx.lineTo(10, -30); ctx.stroke();
    ctx.fillStyle = "#f47c66"; ctx.beginPath(); ctx.roundRect(-15, -5, 30, 10, 5); ctx.fill();
    ctx.fillStyle = "#ffd866"; ctx.beginPath(); ctx.roundRect(-15, 3, 30, 4, 2); ctx.fill();
    ctx.restore();
  }
  /** The ice, the house and the lines never change: they are painted once. */
  private paintBackdrop(): HTMLCanvasElement {
    const layer = document.createElement("canvas");
    layer.width = this.canvas.width; layer.height = this.canvas.height;
    const ctx = layer.getContext("2d")!;
    ctx.setTransform(this.ratio, 0, 0, this.ratio, 0, 0);
    const left = RELEASE.x - SHEET.halfWidth * SCALE, right = RELEASE.x + SHEET.halfWidth * SCALE;
    ctx.fillStyle = COLORS.edge; ctx.fillRect(0, 0, STAGE.width, STAGE.height);
    ctx.fillStyle = COLORS.ice; ctx.fillRect(left, 0, right - left, STAGE.height);
    // Pebbled ice: faint speckles so a sliding stone reads as moving.
    let seed = 7;
    const random = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 0x100000000);
    ctx.fillStyle = "rgba(255, 255, 255, 0.75)";
    for (let i = 0; i < 260; i++) { ctx.beginPath(); ctx.arc(left + random() * (right - left), random() * STAGE.height, 0.6 + random() * 1.2, 0, Math.PI * 2); ctx.fill(); }
    const tee = toScreen(0, SHEET.tee);
    SHEET.rings.forEach((radius, i) => {
      ctx.beginPath(); ctx.arc(tee.x, tee.y, radius * SCALE, 0, Math.PI * 2);
      ctx.fillStyle = [COLORS.blue, COLORS.white, COLORS.red][i]!; ctx.fill();
    });
    ctx.beginPath(); ctx.arc(tee.x, tee.y, SHEET.buttonRadius * SCALE * 0.45, 0, Math.PI * 2); ctx.fillStyle = COLORS.white; ctx.fill();
    ctx.strokeStyle = COLORS.line; ctx.lineWidth = 1.5;
    const line = (y: number) => { const at = toScreen(0, y); ctx.beginPath(); ctx.moveTo(left, at.y); ctx.lineTo(right, at.y); ctx.stroke(); };
    line(SHEET.tee); line(BACK_LINE);
    ctx.beginPath(); ctx.moveTo(RELEASE.x, 0); ctx.lineTo(RELEASE.x, RELEASE.y - STONE_RADIUS - 6); ctx.stroke();
    ctx.strokeStyle = COLORS.hog; ctx.lineWidth = 4; line(SHEET.hog);
    ctx.fillStyle = COLORS.text; ctx.font = "700 10px system-ui, sans-serif"; ctx.textAlign = "left";
    ctx.fillText("호그 라인", left + 6, toScreen(0, SHEET.hog).y - 7);
    ctx.strokeStyle = "#a9c6d4"; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(left, 0); ctx.lineTo(left, STAGE.height); ctx.moveTo(right, 0); ctx.lineTo(right, STAGE.height); ctx.stroke();
    return layer;
  }
  /** Only the direction is shown, as far as the hog line: where the stone stops is the player's to judge. */
  private aimLine(aim: number) {
    const { ctx } = this, direction = aimDirection(aim), length = (SHEET.hog - 0.2) / direction.y;
    const end = toScreen(direction.x * length, direction.y * length);
    ctx.save();
    ctx.strokeStyle = "rgba(58, 51, 64, 0.45)"; ctx.lineWidth = 2.5; ctx.setLineDash([7, 7]); ctx.lineCap = "round";
    ctx.beginPath(); ctx.moveTo(RELEASE.x, RELEASE.y - STONE_RADIUS - 4); ctx.lineTo(end.x, end.y); ctx.stroke();
    ctx.setLineDash([]);
    // Arrowhead along the direction.
    const ux = direction.x, uy = -direction.y, size = 8;
    ctx.fillStyle = "rgba(58, 51, 64, 0.55)";
    ctx.beginPath();
    ctx.moveTo(end.x + ux * size, end.y + uy * size);
    ctx.lineTo(end.x - uy * size * 0.6, end.y + ux * size * 0.6);
    ctx.lineTo(end.x + uy * size * 0.6, end.y - ux * size * 0.6);
    ctx.closePath(); ctx.fill();
    ctx.restore();
  }
  private stone(x: number, y: number, latest: boolean, held: boolean) {
    const { ctx } = this, r = STONE_RADIUS;
    ctx.fillStyle = "rgba(58, 51, 64, 0.16)";
    ctx.beginPath(); ctx.ellipse(x + 1.5, y + 3, r, r * 0.92, 0, 0, Math.PI * 2); ctx.fill();
    if (latest) { ctx.beginPath(); ctx.arc(x, y, r + 3, 0, Math.PI * 2); ctx.fillStyle = held ? "rgba(255, 216, 102, 0.95)" : "rgba(255, 216, 102, 0.7)"; ctx.fill(); }
    // The picture is a stone seen from straight above, its handle pointing up the sheet.
    if (this.sprite) { ctx.drawImage(this.sprite, x - r, y - r, r * 2, r * 2); return; }
    const body = ctx.createRadialGradient(x - r * 0.3, y - r * 0.35, r * 0.1, x, y, r);
    body.addColorStop(0, "#f4f2f6"); body.addColorStop(1, "#b5afbd");
    ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fillStyle = body; ctx.fill();
    ctx.lineWidth = 1.5; ctx.strokeStyle = "#8d8696"; ctx.stroke();
    ctx.beginPath(); ctx.arc(x, y, r * 0.62, 0, Math.PI * 2); ctx.fillStyle = "#f47c66"; ctx.fill();
    // The handle.
    ctx.strokeStyle = "#c95d49"; ctx.lineWidth = 3.2; ctx.lineCap = "round";
    ctx.beginPath(); ctx.moveTo(x, y + r * 0.34); ctx.lineTo(x, y - r * 0.34); ctx.stroke();
  }
}
