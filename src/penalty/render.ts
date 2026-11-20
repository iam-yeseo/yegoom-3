import { GOAL } from "../../shared/penalty-engine";
import { KEEPER_ART } from "./art";

/** Logical canvas size; the buffer is scaled by devicePixelRatio (max 2). */
export const STAGE = { width: 360, height: 560 } as const;
/** The goal is drawn flat, seen from behind the ball: pixels per metre on the goal line. */
export const SCALE = 38;
export const GROUND = 250;
const CX = STAGE.width / 2;
export const toScreen = (x: number, y: number) => ({ x: CX + x * SCALE, y: GROUND - y * SCALE });
/** The ball on its spot, and how big it looks there and on the goal line. */
export const REST = { x: CX, y: 462 };
export const BALL_REST_RADIUS = 16;
export const BALL_GOAL_RADIUS = 6.5;

export interface KeeperPose {
  /** Feet position along the line (m) and how far the body has left the ground (m). */
  x: number; lift: number;
  /** Lean in radians: positive tips toward +x (a dive to the right). */
  lean: number;
  /** 0 arms low and ready, 1 stretched out. */
  stretch: number;
}
export interface Scene {
  keeper: KeeperPose;
  /** Ball centre in logical pixels, its radius and spin. */
  ball: { x: number; y: number; radius: number; spin: number; alpha: number };
  /** The ball is behind the keeper and the net (it went in). */
  ballBehind: boolean;
  /** 0–1 of the kick clock left; null hides the bar. */
  clock: number | null;
  /** Seconds since the net was hit by a goal. */
  netAge: number | null;
  netAt: { x: number; y: number } | null;
}
const POST = 5;
export const ART = { ball: "/penalty/ball.webp", ready: "/penalty/keeper-ready.webp", dive: "/penalty/keeper-dive.webp", jump: "/penalty/keeper-jump.webp", stand: "/penalty/stand.webp" } as const;
/** How tall the standing keeper picture is, and how long the diving one, in metres.
 * Standing, the open arms span about the reach the engine gives a keeper who does not move. */
const KEEPER_HEIGHT = 1.95, DIVE_LENGTH = 2.3, JUMP_HEIGHT = 2.3;
/** Off the ground by more than this (metres) without diving, the keeper is drawn jumping. */
const JUMP_LIFT = 0.1;
/** The stand picture covers the stage down to the foot of the advertising board. */
const STAND_HEIGHT = 166, BOARD_TOP = 146;
/** Past this lean the diving picture replaces the standing one. */
const DIVE_LEAN = 0.75;

export class PenaltyRenderer {
  private ctx: CanvasRenderingContext2D;
  private backdrop: HTMLCanvasElement | null = null;
  private ratio = 1;
  /** Pictures as they finish loading; anything missing is drawn with shapes instead. */
  private art: Partial<Record<keyof typeof ART, HTMLImageElement>> = {};
  constructor(private canvas: HTMLCanvasElement) {
    const ctx = canvas.getContext("2d", { alpha: false });
    if (!ctx) throw new Error("이 브라우저에서는 경기장을 그릴 수 없어요.");
    this.ctx = ctx;
    if (typeof Image !== "undefined") for (const key of Object.keys(ART) as (keyof typeof ART)[]) {
      const image = new Image();
      image.decoding = "async";
      // The stand is part of the painted backdrop: paint that again once it is here.
      image.onload = () => { this.art[key] = image; if (key === "stand") this.backdrop = null; };
      image.src = ART[key];
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
    if (scene.ballBehind) this.ball(scene);
    this.net(scene);
    this.frame();
    this.keeper(scene.keeper);
    if (!scene.ballBehind) this.ball(scene);
    if (scene.clock !== null) this.clock(scene.clock);
  }
  private paintBackdrop(): HTMLCanvasElement {
    const layer = document.createElement("canvas");
    layer.width = this.canvas.width; layer.height = this.canvas.height;
    const ctx = layer.getContext("2d")!;
    ctx.setTransform(this.ratio, 0, 0, this.ratio, 0, 0);
    if (this.art.stand) ctx.drawImage(this.art.stand, 0, 0, STAGE.width, STAND_HEIGHT);
    else {
      const sky = ctx.createLinearGradient(0, 0, 0, 150);
      sky.addColorStop(0, "#bfe3f5"); sky.addColorStop(1, "#e6f5fb");
      ctx.fillStyle = sky; ctx.fillRect(0, 0, STAGE.width, 150);
      // The stand: rows of dots for the crowd, then an advertising board.
      ctx.fillStyle = "#cdbfe6"; ctx.fillRect(0, 52, STAGE.width, 100);
      let seed = 11;
      const random = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 0x100000000);
      const crowd = ["#f47c66", "#ffd866", "#ffffff", "#7fd1b4", "#8cc4ea", "#f6a7c1"];
      for (let row = 0; row < 7; row++) for (let x = 6 + (row % 2) * 6; x < STAGE.width; x += 12) {
        ctx.fillStyle = crowd[Math.floor(random() * crowd.length)]!;
        ctx.beginPath(); ctx.arc(x + random() * 3, 62 + row * 12 + random() * 2, 4, 0, Math.PI * 2); ctx.fill();
      }
    }
    ctx.fillStyle = "#3a3340"; ctx.fillRect(0, BOARD_TOP, STAGE.width, STAND_HEIGHT - BOARD_TOP);
    ctx.fillStyle = "#ffd866"; ctx.font = "800 11px system-ui, sans-serif"; ctx.textAlign = "center";
    ctx.fillText("YEGOOM ARCADE  ·  예굼방 승부차기  ·  YEGOOM ARCADE", CX, 160);
    const grass = ctx.createLinearGradient(0, 166, 0, STAGE.height);
    grass.addColorStop(0, "#7ccf8a"); grass.addColorStop(1, "#58b86f");
    ctx.fillStyle = grass; ctx.fillRect(0, 166, STAGE.width, STAGE.height - 166);
    // Mown stripes fanning toward the viewer.
    ctx.fillStyle = "rgba(255, 255, 255, 0.07)";
    for (let i = -6; i < 6; i += 2) {
      ctx.beginPath();
      ctx.moveTo(CX + i * 34, GROUND); ctx.lineTo(CX + (i + 1) * 34, GROUND);
      ctx.lineTo(CX + (i + 1) * 110, STAGE.height); ctx.lineTo(CX + i * 110, STAGE.height);
      ctx.closePath(); ctx.fill();
    }
    ctx.strokeStyle = "rgba(255, 255, 255, 0.9)"; ctx.lineWidth = 3;
    ctx.beginPath(); ctx.moveTo(0, GROUND); ctx.lineTo(STAGE.width, GROUND); ctx.stroke();
    // The six-yard box, drawn as a widening shape.
    ctx.lineWidth = 2.5;
    ctx.beginPath(); ctx.moveTo(CX - 92, GROUND); ctx.lineTo(CX - 150, 344); ctx.lineTo(CX + 150, 344); ctx.lineTo(CX + 92, GROUND); ctx.stroke();
    ctx.fillStyle = "rgba(255, 255, 255, 0.9)";
    ctx.beginPath(); ctx.ellipse(REST.x, REST.y + BALL_REST_RADIUS - 2, 9, 4, 0, 0, Math.PI * 2); ctx.fill();
    return layer;
  }
  private goalBox() {
    const left = toScreen(-GOAL.halfWidth, 0).x, right = toScreen(GOAL.halfWidth, 0).x, top = toScreen(0, GOAL.height).y;
    return { left, right, top };
  }
  private net(scene: Scene) {
    const { ctx } = this, { left, right, top } = this.goalBox();
    ctx.save();
    ctx.fillStyle = "rgba(255, 255, 255, 0.18)"; ctx.fillRect(left, top, right - left, GROUND - top);
    ctx.strokeStyle = "rgba(255, 255, 255, 0.55)"; ctx.lineWidth = 1;
    const bulge = scene.netAge !== null && scene.netAt ? Math.max(0, 1 - scene.netAge / 0.9) * Math.cos(scene.netAge * 14) : 0;
    const push = (x: number, y: number) => {
      if (!bulge || !scene.netAt) return { x, y };
      const dx = x - scene.netAt.x, dy = y - scene.netAt.y, near = Math.max(0, 1 - Math.hypot(dx, dy) / 70);
      return { x: x + dx * 0.12 * near * bulge, y: y - 7 * near * bulge };
    };
    ctx.beginPath();
    for (let x = left + 10; x < right; x += 10) for (let y = top; y < GROUND; y += 10) {
      const a = push(x, y), b = push(x, Math.min(GROUND, y + 10));
      ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y);
    }
    for (let y = top + 10; y < GROUND; y += 10) for (let x = left; x < right; x += 10) {
      const a = push(x, y), b = push(Math.min(right, x + 10), y);
      ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y);
    }
    ctx.stroke();
    ctx.restore();
  }
  private frame() {
    const { ctx } = this, { left, right, top } = this.goalBox();
    ctx.save();
    ctx.lineWidth = POST; ctx.lineJoin = "round"; ctx.lineCap = "round";
    ctx.strokeStyle = "rgba(58, 51, 64, 0.18)";
    ctx.beginPath(); ctx.moveTo(left + 1.5, GROUND); ctx.lineTo(left + 1.5, top + 1.5); ctx.lineTo(right + 1.5, top + 1.5); ctx.lineTo(right + 1.5, GROUND); ctx.stroke();
    ctx.strokeStyle = "#ffffff";
    ctx.beginPath(); ctx.moveTo(left, GROUND); ctx.lineTo(left, top); ctx.lineTo(right, top); ctx.lineTo(right, GROUND); ctx.stroke();
    ctx.restore();
  }
  private keeper(pose: KeeperPose) {
    const { ctx } = this, unit = SCALE;
    const feet = toScreen(pose.x, pose.lift);
    ctx.save();
    // Shadow stays on the grass under the keeper.
    ctx.fillStyle = "rgba(58, 51, 64, 0.18)";
    ctx.beginPath(); ctx.ellipse(feet.x, GROUND + 3, 20 - Math.min(8, pose.lift * 8), 5, 0, 0, Math.PI * 2); ctx.fill();
    const lean = Math.abs(pose.lean), { ready, dive, jump } = this.art;
    if (dive && lean > DIVE_LEAN) {
      // Flying sideways: the picture dives to the right and is mirrored for the left.
      // Early in the dive it is still tipped up; at full stretch it lies level.
      const width = DIVE_LENGTH * unit, height = width / KEEPER_ART.dive;
      const centre = toScreen(pose.x, Math.max(height / unit / 2 - 0.05, 0.3 + pose.lift));
      ctx.translate(centre.x, centre.y);
      if (pose.lean < 0) ctx.scale(-1, 1);
      ctx.rotate((lean - 1.3) * 0.5);
      ctx.drawImage(dive, -width / 2, -height / 2, width, height);
      ctx.restore();
      return;
    }
    if (jump && pose.lift > JUMP_LIFT) {
      // Up for a high ball close by: arms straight above the head.
      const height = JUMP_HEIGHT * unit, width = height * KEEPER_ART.jump;
      ctx.translate(feet.x, feet.y);
      ctx.rotate(pose.lean * 0.6);
      ctx.drawImage(jump, -width / 2, -height, width, height);
      ctx.restore();
      return;
    }
    if (ready) {
      // Standing or stepping: the picture turns a little about its feet.
      const height = KEEPER_HEIGHT * unit, width = height * KEEPER_ART.ready;
      ctx.translate(feet.x, feet.y);
      ctx.rotate(pose.lean * 0.6);
      ctx.drawImage(ready, -width / 2, -height, width, height);
      ctx.restore();
      return;
    }
    // The body turns about its hips.
    // A keeper lying sideways has their hips near the grass, not at standing height.
    const hip = { x: feet.x, y: feet.y - (0.25 + 0.6 * Math.cos(pose.lean)) * unit };
    ctx.translate(hip.x, hip.y); ctx.rotate(pose.lean);
    ctx.lineCap = "round";
    ctx.strokeStyle = "#3a3340"; ctx.lineWidth = 9;
    ctx.beginPath(); ctx.moveTo(-6, 0); ctx.lineTo(-9, 0.82 * unit); ctx.moveTo(6, 0); ctx.lineTo(9, 0.82 * unit); ctx.stroke();
    ctx.fillStyle = "#ffd866";
    ctx.beginPath(); ctx.roundRect(-13, -0.72 * unit, 26, 0.76 * unit, 9); ctx.fill();
    ctx.fillStyle = "#f2b93b"; ctx.fillRect(-13, -0.36 * unit, 26, 5);
    // Arms: low and wide when ready, straight up along the body when stretched.
    const shoulder = -0.62 * unit, spread = 20 - pose.stretch * 12, reach = shoulder + 10 - pose.stretch * (0.62 * unit + 6);
    ctx.strokeStyle = "#ffd866"; ctx.lineWidth = 8;
    ctx.beginPath(); ctx.moveTo(-11, shoulder); ctx.lineTo(-spread, reach); ctx.moveTo(11, shoulder); ctx.lineTo(spread, reach); ctx.stroke();
    ctx.fillStyle = "#ffffff"; ctx.strokeStyle = "#d9d3df"; ctx.lineWidth = 1.5;
    for (const side of [-1, 1]) { ctx.beginPath(); ctx.arc(side * spread, reach - 3, 6.5, 0, Math.PI * 2); ctx.fill(); ctx.stroke(); }
    ctx.fillStyle = "#ffdcc4"; ctx.beginPath(); ctx.arc(0, -0.92 * unit, 10, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = "#6b4a3a"; ctx.beginPath(); ctx.arc(0, -0.97 * unit, 10, Math.PI, Math.PI * 2); ctx.fill();
    ctx.restore();
  }
  private ball(scene: Scene) {
    const { ctx } = this, { x, y, radius, spin, alpha } = scene.ball;
    if (alpha <= 0) return;
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.translate(x, y);
    if (this.art.ball) {
      ctx.rotate(spin);
      ctx.drawImage(this.art.ball, -radius, -radius, radius * 2, radius * 2);
      ctx.restore();
      return;
    }
    const shade = ctx.createRadialGradient(-radius * 0.3, -radius * 0.35, radius * 0.1, 0, 0, radius);
    shade.addColorStop(0, "#ffffff"); shade.addColorStop(1, "#d8d3de");
    ctx.beginPath(); ctx.arc(0, 0, radius, 0, Math.PI * 2); ctx.fillStyle = shade; ctx.fill();
    ctx.lineWidth = Math.max(1, radius * 0.09); ctx.strokeStyle = "#3a3340"; ctx.stroke();
    ctx.rotate(spin);
    ctx.fillStyle = "#3a3340";
    const patch = (cx: number, cy: number, size: number) => {
      ctx.beginPath();
      for (let i = 0; i < 5; i++) { const angle = -Math.PI / 2 + i * Math.PI * 2 / 5; const px = cx + Math.cos(angle) * size, py = cy + Math.sin(angle) * size; if (i) ctx.lineTo(px, py); else ctx.moveTo(px, py); }
      ctx.closePath(); ctx.fill();
    };
    ctx.save(); ctx.beginPath(); ctx.arc(0, 0, radius - 0.5, 0, Math.PI * 2); ctx.clip();
    patch(0, 0, radius * 0.36);
    for (let i = 0; i < 5; i++) { const angle = -Math.PI / 2 + i * Math.PI * 2 / 5; patch(Math.cos(angle) * radius * 0.92, Math.sin(angle) * radius * 0.92, radius * 0.3); }
    ctx.restore();
    ctx.restore();
  }
  private clock(left: number) {
    const { ctx } = this, width = STAGE.width - 48;
    ctx.fillStyle = "rgba(58, 51, 64, 0.35)"; ctx.beginPath(); ctx.roundRect(24, 14, width, 8, 4); ctx.fill();
    ctx.fillStyle = left < 0.3 ? "#f47c66" : "#ffd866"; ctx.beginPath(); ctx.roundRect(24, 14, Math.max(8, width * left), 8, 4); ctx.fill();
  }
}
