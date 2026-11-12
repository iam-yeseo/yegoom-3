import { COURT, type ShotFrame } from "../../shared/freethrow-physics";

/** Logical canvas size; the buffer is scaled by devicePixelRatio (max 2). */
export const STAGE = { width: 360, height: 560 } as const;
const CAMERA = { z: -3, y: 2.5, focal: 1100, horizon: 258 };
/** Drawing-only tilt so the rim reads as seen slightly from above. */
const RIM_TILT = 0.3;
const CX = STAGE.width / 2;
const FLOOR_FAR = 340;

export interface ScreenPoint { x: number; y: number; scale: number }
export function project(x: number, y: number, z: number): ScreenPoint {
  const depth = z - CAMERA.z;
  const lift = RIM_TILT * Math.max(-0.7, Math.min(0.7, z - COURT.rim.z));
  const scale = CAMERA.focal / depth;
  return { x: CX + x * scale, y: CAMERA.horizon - (y + lift - CAMERA.y) * scale, scale };
}
/** The court floor is stylised: it fills the lower stage so the ball's shadow
 * always shows how far and how wide the ball has travelled. */
function floorY(z: number) {
  const share = Math.max(0, Math.min(1.15, z / COURT.rim.z));
  return STAGE.height - 24 + (FLOOR_FAR - (STAGE.height - 24)) * Math.sqrt(share);
}
export const REST = project(COURT.release.x, COURT.release.y, COURT.release.z);
export const BALL_REST_RADIUS = COURT.ballRadius * REST.scale;

export interface Scene {
  ball: ShotFrame;
  /** Offset in logical pixels while the ball is held or just released. */
  offset: { x: number; y: number };
  spin: number;
  alpha: number;
  /** 0–1 rim wobble and seconds since the net caught a made shot. */
  rimShake: number;
  netAge: number | null;
}
export const BALL_SRC = "/freethrow/ball.webp";
export const restScene = (): Scene => ({ ball: { ...COURT.release }, offset: { x: 0, y: 0 }, spin: 0, alpha: 1, rimShake: 0, netAge: null });

const ring = (y: number, radius: number, count: number, shiftX = 0, shiftZ = 0) =>
  Array.from({ length: count }, (_, i) => {
    const angle = (i / count) * Math.PI * 2;
    return project(COURT.rim.x + shiftX + Math.cos(angle) * radius, y, COURT.rim.z + shiftZ + Math.sin(angle) * radius);
  });

// The rim and a resting net never change: their screen points are worked out once.
const NET_STRANDS = 12, RIM_STEPS = 20;
/** The far half of the rim spans angles 0–π (positive z), the near half π–2π. */
const rimHalf = (from: number) => Array.from({ length: RIM_STEPS + 1 }, (_, i) => {
  const angle = from + (i / RIM_STEPS) * Math.PI;
  return project(COURT.rim.x + Math.cos(angle) * COURT.rim.radius, COURT.rim.y, COURT.rim.z + Math.sin(angle) * COURT.rim.radius);
});
const RIM_BACK = rimHalf(0), RIM_FRONT = rimHalf(Math.PI);
const NET_TOP = ring(COURT.rim.y, COURT.rim.radius, NET_STRANDS);
const NET_MID = ring(COURT.rim.y - COURT.net.depth * 0.55, COURT.rim.radius * 0.8, NET_STRANDS);
const NET_BOTTOM = ring(COURT.rim.y - COURT.net.depth, COURT.rim.radius * COURT.net.bottomScale, NET_STRANDS);

export class FreeThrowRenderer {
  private ctx: CanvasRenderingContext2D;
  private backdrop: HTMLCanvasElement | null = null;
  private ratio = 1;
  private sprite: HTMLImageElement | null = null;
  /** The ball picture resampled once to the size it has in the hand; in the
   * air it only gets smaller, so each frame scales a small copy, not the original. */
  private ballCopy: HTMLCanvasElement | null = null;
  /** onReady repaints once the ball sprite has loaded; until then (or if it
   * fails) the ball is drawn with gradients and seam lines. */
  constructor(private canvas: HTMLCanvasElement, onReady?: () => void) {
    const ctx = canvas.getContext("2d", { alpha: false });
    if (!ctx) throw new Error("이 브라우저에서는 코트를 그릴 수 없어요.");
    this.ctx = ctx;
    if (typeof Image !== "undefined") {
      const sprite = new Image();
      sprite.decoding = "async";
      sprite.onload = () => { this.sprite = sprite; onReady?.(); };
      sprite.src = BALL_SRC;
    }
  }
  /** Matches the buffer to the displayed size; returns true when it changed. */
  resize(): boolean {
    const rect = this.canvas.getBoundingClientRect();
    const ratio = Math.min(2, window.devicePixelRatio || 1) * (rect.width ? rect.width / STAGE.width : 1);
    const width = Math.round(STAGE.width * ratio), height = Math.round(STAGE.height * ratio);
    // Another renderer (a remounted screen) may already have sized this canvas: the scale still has to match it.
    if (width === this.canvas.width && height === this.canvas.height) { if (this.ratio !== ratio) { this.ratio = ratio; this.backdrop = null; this.ballCopy = null; } return false; }
    this.canvas.width = width; this.canvas.height = height; this.ratio = ratio; this.backdrop = null; this.ballCopy = null;
    return true;
  }
  draw(scene: Scene) {
    const { ctx } = this;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    if (!this.backdrop) this.backdrop = this.paintBackdrop();
    ctx.drawImage(this.backdrop, 0, 0);
    ctx.setTransform(this.ratio, 0, 0, this.ratio, 0, 0);
    const { ball } = scene, rim = COURT.rim;
    const flat = Math.hypot(ball.x - rim.x, ball.z - rim.z);
    const zone = ball.z > COURT.board.z ? "behind-board"
      : flat < rim.radius ? "inside"
        : ball.z > rim.z ? "behind-rim" : "front";
    this.shadow(scene);
    if (zone === "behind-board") this.ball(scene);
    this.board();
    if (zone === "behind-rim") this.ball(scene);
    const shake = scene.rimShake * Math.sin(performance.now() / 22) * 1.6;
    this.rim(true, shake);
    if (zone === "inside") this.ball(scene);
    this.net(scene.netAge, shake);
    this.rim(false, shake);
    if (zone === "front") this.ball(scene);
  }

  private paintBackdrop(): HTMLCanvasElement {
    const layer = document.createElement("canvas");
    layer.width = this.canvas.width; layer.height = this.canvas.height;
    const ctx = layer.getContext("2d")!;
    ctx.scale(this.ratio, this.ratio);
    const { width: W, height: H } = STAGE;
    const wall = ctx.createLinearGradient(0, 0, 0, FLOOR_FAR);
    wall.addColorStop(0, "#eee8fc"); wall.addColorStop(1, "#fff4e8");
    ctx.fillStyle = wall; ctx.fillRect(0, 0, W, FLOOR_FAR);
    // A soft spotlight behind the hoop.
    const glow = ctx.createRadialGradient(CX, 120, 10, CX, 120, 220);
    glow.addColorStop(0, "rgba(255,255,255,.75)"); glow.addColorStop(1, "rgba(255,255,255,0)");
    ctx.fillStyle = glow; ctx.fillRect(0, 0, W, FLOOR_FAR);
    const floor = ctx.createLinearGradient(0, FLOOR_FAR, 0, H);
    floor.addColorStop(0, "#f2d3ae"); floor.addColorStop(1, "#f7e2c6");
    ctx.fillStyle = floor; ctx.fillRect(0, FLOOR_FAR, W, H - FLOOR_FAR);
    ctx.strokeStyle = "rgba(186,128,78,.14)"; ctx.lineWidth = 1;
    for (let i = 1; i < 12; i++) {
      const y = FLOOR_FAR + (H - FLOOR_FAR) * (i / 12) ** 1.6;
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke();
    }
    ctx.strokeStyle = "#fff9ee"; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(0, FLOOR_FAR); ctx.lineTo(W, FLOOR_FAR); ctx.stroke();
    // The key (painted lane) and the free-throw circle.
    ctx.fillStyle = "rgba(244,124,102,.2)";
    ctx.beginPath(); ctx.moveTo(CX - 74, FLOOR_FAR + 4); ctx.lineTo(CX + 74, FLOOR_FAR + 4); ctx.lineTo(CX + 150, H - 46); ctx.lineTo(CX - 150, H - 46); ctx.closePath(); ctx.fill();
    ctx.strokeStyle = "rgba(255,249,238,.95)"; ctx.lineWidth = 2.5; ctx.stroke();
    ctx.beginPath(); ctx.ellipse(CX, H - 46, 150, 34, 0, 0, Math.PI, false); ctx.stroke();
    ctx.setLineDash([7, 7]);
    ctx.beginPath(); ctx.ellipse(CX, H - 46, 150, 22, 0, Math.PI, Math.PI * 2, false); ctx.stroke();
    ctx.setLineDash([]);
    return layer;
  }
  private board() {
    const { ctx } = this, b = COURT.board;
    const tl = project(-b.halfWidth, b.top, b.z), br = project(b.halfWidth, b.bottom, b.z);
    ctx.fillStyle = "#c9c0c8";
    ctx.fillRect(CX - 7, 0, 14, tl.y + 4);
    ctx.fillStyle = "rgba(255,255,255,.9)"; ctx.strokeStyle = "#3a3340"; ctx.lineWidth = 3;
    ctx.beginPath(); ctx.roundRect(tl.x, tl.y, br.x - tl.x, br.y - tl.y, 8); ctx.fill(); ctx.stroke();
    const st = project(-0.295, 3.5, b.z), sb = project(0.295, 3.08, b.z);
    ctx.strokeStyle = "#f47c66"; ctx.lineWidth = 3;
    ctx.strokeRect(st.x, st.y, sb.x - st.x, sb.y - st.y);
    // Bracket from the board to the back of the rim.
    const rimBack = project(0, COURT.rim.y, COURT.rim.z + COURT.rim.radius), plate = project(0, COURT.rim.y - 0.02, b.z);
    ctx.fillStyle = "#7c7383";
    ctx.fillRect(rimBack.x - 6, rimBack.y - 2, 12, Math.max(4, plate.y - rimBack.y + 4));
  }
  private rim(back: boolean, shake: number) {
    const { ctx } = this, points = back ? RIM_BACK : RIM_FRONT;
    ctx.strokeStyle = back ? "#d9604c" : "#f47c66"; ctx.lineWidth = back ? 3.4 : 4.2; ctx.lineCap = "round";
    ctx.beginPath();
    ctx.moveTo(points[0]!.x, points[0]!.y + shake);
    for (let i = 1; i < points.length; i++) ctx.lineTo(points[i]!.x, points[i]!.y + shake);
    ctx.stroke();
  }
  private net(age: number | null, shake: number) {
    const { ctx } = this, { rim, net } = COURT, count = NET_STRANDS;
    // A made shot stretches the net down and lets it swing back; otherwise it hangs still.
    const moving = age !== null && age <= 1.2;
    const swing = moving ? Math.exp(-age * 4) * Math.sin(age * 18) : 0;
    const stretch = moving ? Math.exp(-age * 5) * 0.12 : 0;
    const top = NET_TOP;
    const mid = moving ? ring(rim.y - net.depth * 0.55 - stretch * 0.6, rim.radius * 0.8, count, swing * 0.03) : NET_MID;
    const bottom = moving ? ring(rim.y - net.depth - stretch, rim.radius * net.bottomScale, count, swing * 0.06) : NET_BOTTOM;
    ctx.strokeStyle = "rgba(58,51,64,.38)"; ctx.lineWidth = 1.2; ctx.lineCap = "round";
    ctx.beginPath();
    for (let i = 0; i < count; i++) {
      const next = (i + 1) % count;
      ctx.moveTo(top[i]!.x, top[i]!.y + shake); ctx.lineTo(mid[next]!.x, mid[next]!.y); ctx.lineTo(bottom[i]!.x, bottom[i]!.y);
      ctx.moveTo(top[next]!.x, top[next]!.y + shake); ctx.lineTo(mid[i]!.x, mid[i]!.y); ctx.lineTo(bottom[next]!.x, bottom[next]!.y);
    }
    ctx.stroke();
  }
  private ballPoint(scene: Scene) {
    const p = project(scene.ball.x, scene.ball.y, scene.ball.z);
    return { x: p.x + scene.offset.x, y: p.y + scene.offset.y, r: COURT.ballRadius * p.scale };
  }
  private shadow(scene: Scene) {
    const { ctx } = this, { ball } = scene;
    const p = project(ball.x, 0, Math.max(0, ball.z));
    const height = Math.max(0, ball.y - COURT.ballRadius);
    const r = COURT.ballRadius * p.scale * (1.15 - Math.min(0.5, height / 8));
    ctx.fillStyle = `rgba(120,80,50,${(0.24 * (1 - Math.min(0.75, height / 4)) * scene.alpha).toFixed(3)})`;
    ctx.beginPath(); ctx.ellipse(p.x + scene.offset.x * 0.4, floorY(ball.z), r, r * 0.32, 0, 0, Math.PI * 2); ctx.fill();
  }
  private ball(scene: Scene) {
    const { ctx } = this, { x, y, r } = this.ballPoint(scene);
    ctx.save();
    ctx.globalAlpha = scene.alpha;
    if (this.sprite) {
      if (!this.ballCopy) {
        const size = Math.max(1, Math.ceil(BALL_REST_RADIUS * 2 * this.ratio));
        const copy = document.createElement("canvas");
        copy.width = copy.height = size;
        const layer = copy.getContext("2d")!;
        layer.imageSmoothingQuality = "high";
        layer.drawImage(this.sprite, 0, 0, size, size);
        this.ballCopy = copy;
      }
      ctx.translate(x, y); ctx.rotate(scene.spin);
      ctx.drawImage(this.ballCopy, -r, -r, r * 2, r * 2);
      ctx.restore();
      return;
    }
    const shade = ctx.createRadialGradient(x - r * 0.35, y - r * 0.4, r * 0.1, x, y, r);
    shade.addColorStop(0, "#ffb27a"); shade.addColorStop(0.65, "#f3843f"); shade.addColorStop(1, "#d9662c");
    ctx.fillStyle = shade;
    ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
    ctx.clip();
    ctx.translate(x, y); ctx.rotate(scene.spin);
    ctx.strokeStyle = "rgba(58,51,64,.62)"; ctx.lineWidth = Math.max(1, r * 0.075);
    ctx.beginPath(); ctx.moveTo(-r, 0); ctx.lineTo(r, 0); ctx.moveTo(0, -r); ctx.lineTo(0, r); ctx.stroke();
    ctx.beginPath(); ctx.ellipse(-r * 0.95, 0, r * 0.55, r * 1.05, 0, -Math.PI / 2, Math.PI / 2); ctx.stroke();
    ctx.beginPath(); ctx.ellipse(r * 0.95, 0, r * 0.55, r * 1.05, 0, Math.PI / 2, Math.PI * 1.5); ctx.stroke();
    ctx.restore();
  }
}
