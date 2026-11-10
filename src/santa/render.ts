import { SANTA_STAGE, SANTA_WORLD, type SantaHouse } from "../../shared/santa-engine";

// Placeholder shapes until the drawn art arrives (docs/santa-image-prompts.md).
// Every shape sits where its image will go: the sleigh around the release point,
// a house whose roof the chimney rises out of, gifts the engine's size.

export const STAGE = SANTA_STAGE;
const W = STAGE.width, H = STAGE.height, GROUND = SANTA_WORLD.ground;
/** The roof surface right at the chimney, for every house style. */
const ROOF_AT_CHIMNEY = 420;
const CHIMNEY_HALF = SANTA_WORLD.mouthHalf + SANTA_WORLD.wall;
const HOUSE_STYLES = [
  { width: 140, body: 78, wall: "#fff3e0", roof: "#e86f5c", door: "#a8705a" },
  { width: 160, body: 84, wall: "#dff3ea", roof: "#8a5a44", door: "#6e8f5a" },
  { width: 124, body: 72, wall: "#ffe3ea", roof: "#4f8a68", door: "#c1666b" },
  { width: 150, body: 80, wall: "#ece4fb", roof: "#3f4f86", door: "#8c6bb1" },
] as const;
export const GIFT_COLORS = [
  { box: "#ef6b5b", ribbon: "#fff1d6" },
  { box: "#5cc2a0", ribbon: "#ef6b5b" },
  { box: "#7fb4ec", ribbon: "#f6c64f" },
] as const;

/** House geometry around its chimney: the chimney stands on the right slope. */
export function houseShape(style: number, chimney: number) {
  const s = HOUSE_STYLES[style % HOUSE_STYLES.length]!;
  const half = s.width / 2 + 10, share = 0.45;
  const center = chimney - half * share;
  const bodyTop = GROUND - s.body;
  const roofHeight = (bodyTop - ROOF_AT_CHIMNEY) / (1 - share);
  return { ...s, center, half, bodyTop, peak: bodyTop - roofHeight, left: center - half, right: center + half };
}
/** Roof (or ground) surface y at screen x, for a gift landing near a house. */
export function surfaceAt(style: number, chimney: number, x: number) {
  const house = houseShape(style, chimney);
  if (x < house.left || x > house.right) return GROUND;
  return house.peak + (house.bodyTop - house.peak) * (Math.abs(x - house.center) / house.half);
}

export interface GiftSprite { x: number; y: number; angle: number; color: number; alpha: number;
  /** Clip the gift below this y (it is going down the chimney). */
  clipBelow: number | null }
export interface SantaScene {
  /** Total distance the world has scrolled (px), for parallax and the ground. */
  distance: number;
  /** ms clock for snow, twinkle and the sleigh bob. */
  time: number;
  /** The house on screen and its chimney x (null before the first house). */
  house: { house: SantaHouse; x: number } | null;
  /** The previous house while it leaves the screen. */
  leaving: { house: SantaHouse; x: number } | null;
  gifts: GiftSprite[];
  /** A gift waiting in Santa's hands (not yet thrown on this house). */
  ready: number | null;
  /** 0–1 glow around the chimney (by house index) that just got a gift. */
  glow: { index: number; amount: number } | null;
  calm: boolean;
}

export const emptyScene = (): SantaScene => ({ distance: 0, time: 0, house: null, leaving: null, gifts: [], ready: null, glow: null, calm: false });

const seeded = (n: number) => { const x = Math.sin(n * 127.1 + 311.7) * 43758.5453; return x - Math.floor(x); };
const STARS = Array.from({ length: 46 }, (_, i) => ({ x: seeded(i) * W, y: seeded(i + 99) * 300, r: 0.6 + seeded(i + 7) * 1.2, phase: seeded(i + 3) * 6.28 }));
const FLAKES = Array.from({ length: 42 }, (_, i) => ({ x: seeded(i + 500) * W, y: seeded(i + 900) * H, r: 1 + seeded(i + 40) * 2.2, speed: 0.018 + seeded(i + 70) * 0.03, sway: seeded(i + 11) * 6.28 }));

export class SantaRenderer {
  private ctx: CanvasRenderingContext2D;
  private ratio = 1;
  private sky: HTMLCanvasElement | null = null;
  constructor(private canvas: HTMLCanvasElement) {
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("이 브라우저에서는 하늘을 그릴 수 없어요.");
    this.ctx = ctx;
  }
  /** Matches the buffer to the displayed size × DPR (max 2). Returns whether it changed. */
  resize(): boolean {
    const rect = this.canvas.getBoundingClientRect();
    const ratio = Math.min(2, Math.max(1, window.devicePixelRatio || 1));
    const width = Math.round((rect.width || W) * ratio), height = Math.round((rect.height || H) * ratio);
    if (this.canvas.width === width && this.canvas.height === height) return false;
    this.canvas.width = width; this.canvas.height = height; this.ratio = width / W; this.sky = null;
    return true;
  }
  draw(scene: SantaScene) {
    const ctx = this.ctx;
    ctx.setTransform(this.ratio, 0, 0, this.ratio, 0, 0);
    this.drawSky(scene);
    this.drawHills(scene.distance * 0.18, 438, "#4a4479", 34, 0.011);
    this.drawFarHouses(scene.distance * 0.34);
    this.drawHills(scene.distance * 0.42, 470, "#5d5490", 22, 0.017);
    for (const entry of [scene.leaving, scene.house]) if (entry) this.drawHouse(entry.house, entry.x, scene.glow);
    this.drawGround(scene.distance);
    for (const gift of scene.gifts) this.drawGift(gift);
    this.drawSleigh(scene);
    this.drawSnow(scene);
  }

  private drawSky(scene: SantaScene) {
    const ctx = this.ctx;
    if (!this.sky) {
      const sky = document.createElement("canvas");
      sky.width = this.canvas.width; sky.height = this.canvas.height;
      const c = sky.getContext("2d")!;
      c.setTransform(this.ratio, 0, 0, this.ratio, 0, 0);
      const gradient = c.createLinearGradient(0, 0, 0, H);
      gradient.addColorStop(0, "#1c2150"); gradient.addColorStop(0.55, "#3c3772"); gradient.addColorStop(1, "#6b5c9a");
      c.fillStyle = gradient; c.fillRect(0, 0, W, H);
      const glow = c.createRadialGradient(286, 74, 10, 286, 74, 90);
      glow.addColorStop(0, "rgba(255, 244, 214, 0.35)"); glow.addColorStop(1, "rgba(255, 244, 214, 0)");
      c.fillStyle = glow; c.fillRect(180, 0, 180, 180);
      c.fillStyle = "#fff4d6"; c.beginPath(); c.arc(286, 74, 30, 0, Math.PI * 2); c.fill();
      c.fillStyle = "rgba(230, 214, 180, 0.6)";
      for (const [x, y, r] of [[276, 66, 6], [296, 86, 4], [292, 62, 3]] as const) { c.beginPath(); c.arc(x, y, r, 0, Math.PI * 2); c.fill(); }
      this.sky = sky;
    }
    ctx.drawImage(this.sky, 0, 0, W, H);
    for (const star of STARS) {
      const twinkle = scene.calm ? 0.8 : 0.55 + 0.45 * Math.sin(scene.time / 600 + star.phase);
      ctx.fillStyle = `rgba(255, 250, 230, ${twinkle})`;
      ctx.beginPath(); ctx.arc(star.x, star.y, star.r, 0, Math.PI * 2); ctx.fill();
    }
  }
  private drawHills(shift: number, base: number, color: string, height: number, frequency: number) {
    const ctx = this.ctx;
    ctx.fillStyle = color;
    ctx.beginPath(); ctx.moveTo(0, H);
    for (let x = 0; x <= W; x += 8) {
      const u = x + shift;
      ctx.lineTo(x, base - height * (0.5 + 0.3 * Math.sin(u * frequency) + 0.2 * Math.sin(u * frequency * 2.3 + 1)));
    }
    ctx.lineTo(W, H); ctx.closePath(); ctx.fill();
  }
  private drawFarHouses(shift: number) {
    const ctx = this.ctx, spacing = 110, offset = ((shift % spacing) + spacing) % spacing;
    for (let i = -1; i <= Math.ceil(W / spacing) + 1; i++) {
      const n = Math.floor(shift / spacing) + i, x = i * spacing - offset + seeded(n) * 40;
      const w = 24 + seeded(n + 5) * 14, h = 16 + seeded(n + 9) * 10, base = 452 + seeded(n + 2) * 8;
      ctx.fillStyle = "#3e3868";
      ctx.fillRect(x, base - h, w, h);
      ctx.beginPath(); ctx.moveTo(x - 3, base - h); ctx.lineTo(x + w / 2, base - h - 12); ctx.lineTo(x + w + 3, base - h); ctx.fill();
      ctx.fillStyle = "rgba(255, 214, 120, 0.75)";
      ctx.fillRect(x + w * 0.25, base - h * 0.62, 4, 4);
      if (seeded(n + 13) > 0.4) ctx.fillRect(x + w * 0.62, base - h * 0.62, 4, 4);
    }
  }
  private drawGround(distance: number) {
    const ctx = this.ctx;
    ctx.fillStyle = "#f4f1fb";
    ctx.beginPath(); ctx.moveTo(0, H);
    for (let x = 0; x <= W; x += 6) ctx.lineTo(x, GROUND - 3 * Math.sin((x + distance) * 0.035));
    ctx.lineTo(W, H); ctx.closePath(); ctx.fill();
    ctx.fillStyle = "#ded8ef";
    const spacing = 46, offset = distance % spacing;
    for (let x = -offset; x < W + spacing; x += spacing) { ctx.beginPath(); ctx.ellipse(x, GROUND + 14, 12, 3, 0, 0, Math.PI * 2); ctx.fill(); }
  }
  private drawHouse(house: SantaHouse, chimney: number, glow: SantaScene["glow"]) {
    const ctx = this.ctx, shape = houseShape(house.style, chimney);
    if (shape.right < -20 || shape.left > W + 20) return;
    const bodyLeft = shape.center - shape.width / 2;
    // Body, windows, door.
    ctx.fillStyle = shape.wall;
    roundRect(ctx, bodyLeft, shape.bodyTop, shape.width, GROUND - shape.bodyTop + 4, 6); ctx.fill();
    ctx.fillStyle = "#ffd36e";
    for (const at of [0.2, 0.62]) { roundRect(ctx, bodyLeft + shape.width * at, shape.bodyTop + 18, 22, 20, 5); ctx.fill(); }
    ctx.fillStyle = "rgba(255, 196, 80, 0.25)";
    for (const at of [0.2, 0.62]) { ctx.beginPath(); ctx.arc(bodyLeft + shape.width * at + 11, shape.bodyTop + 28, 20, 0, Math.PI * 2); ctx.fill(); }
    ctx.fillStyle = shape.door;
    roundRect(ctx, shape.center - 11, GROUND - 36, 22, 38, 8); ctx.fill();
    ctx.strokeStyle = "#4fae7c"; ctx.lineWidth = 3;
    ctx.beginPath(); ctx.arc(shape.center, GROUND - 26, 6, 0, Math.PI * 2); ctx.stroke();
    // Chimney, then the roof in front of its foot.
    this.drawChimney(chimney, house.top, glow && glow.index === house.index ? glow.amount : 0);
    ctx.fillStyle = shape.roof;
    ctx.beginPath(); ctx.moveTo(shape.left, shape.bodyTop + 2); ctx.lineTo(shape.center, shape.peak); ctx.lineTo(shape.right, shape.bodyTop + 2); ctx.closePath(); ctx.fill();
    // Snow on the roof.
    ctx.fillStyle = "#ffffff";
    ctx.beginPath();
    ctx.moveTo(shape.left - 2, shape.bodyTop + 2);
    ctx.lineTo(shape.center, shape.peak - 6);
    ctx.lineTo(shape.right + 2, shape.bodyTop + 2);
    ctx.lineTo(shape.right - 6, shape.bodyTop + 6);
    for (let i = 1; i <= 6; i++) { const share = 1 - i / 7; ctx.lineTo(shape.center + (shape.right - 6 - shape.center) * share, shape.peak + 4 + (shape.bodyTop + 6 - shape.peak - 4) * share + (i % 2 ? 4 : 0)); }
    ctx.lineTo(shape.center, shape.peak + 4);
    for (let i = 1; i <= 6; i++) { const share = i / 7; ctx.lineTo(shape.center + (shape.left + 6 - shape.center) * share, shape.peak + 4 + (shape.bodyTop + 6 - shape.peak - 4) * share + (i % 2 ? 4 : 0)); }
    ctx.lineTo(shape.left + 6, shape.bodyTop + 6);
    ctx.closePath(); ctx.fill();
  }
  private drawChimney(x: number, top: number, glow: number) {
    const ctx = this.ctx, half = CHIMNEY_HALF, bottom = ROOF_AT_CHIMNEY + 30;
    if (glow > 0) {
      const light = ctx.createRadialGradient(x, top, 4, x, top, 70);
      light.addColorStop(0, `rgba(255, 228, 140, ${0.75 * glow})`); light.addColorStop(1, "rgba(255, 228, 140, 0)");
      ctx.fillStyle = light; ctx.fillRect(x - 70, top - 70, 140, 140);
    }
    ctx.fillStyle = "#c95c4c";
    ctx.fillRect(x - half, top, half * 2, bottom - top);
    // Brick rows.
    ctx.strokeStyle = "rgba(255, 228, 210, 0.55)"; ctx.lineWidth = 1.5;
    for (let y = top + 18, row = 0; y < bottom; y += 13, row++) {
      ctx.beginPath(); ctx.moveTo(x - half, y); ctx.lineTo(x + half, y); ctx.stroke();
      for (let bx = x - half + (row % 2 ? 10 : 21); bx < x + half; bx += 22) { ctx.beginPath(); ctx.moveTo(bx, y); ctx.lineTo(bx, y + 13); ctx.stroke(); }
    }
    // Cap with the dark mouth and a little snow.
    ctx.fillStyle = "#b14d40";
    roundRect(ctx, x - half - 4, top - 2, half * 2 + 8, 14, 4); ctx.fill();
    ctx.fillStyle = "#2a1f2e";
    ctx.beginPath(); ctx.ellipse(x, top + 2, SANTA_WORLD.mouthHalf, 5, 0, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = "#ffffff";
    ctx.beginPath(); ctx.ellipse(x - half + 2, top - 2, 9, 4, 0, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.ellipse(x + half - 3, top - 1, 7, 3.5, 0, 0, Math.PI * 2); ctx.fill();
  }
  private drawGift(gift: GiftSprite) {
    const ctx = this.ctx, size = SANTA_WORLD.giftHalf * 2, colors = GIFT_COLORS[gift.color % GIFT_COLORS.length]!;
    ctx.save();
    ctx.globalAlpha = gift.alpha;
    if (gift.clipBelow !== null) { ctx.beginPath(); ctx.rect(0, 0, W, gift.clipBelow); ctx.clip(); }
    ctx.translate(gift.x, gift.y); ctx.rotate(gift.angle);
    ctx.fillStyle = colors.box;
    roundRect(ctx, -size / 2, -size / 2, size, size, 5); ctx.fill();
    ctx.fillStyle = colors.ribbon;
    ctx.fillRect(-3, -size / 2, 6, size); ctx.fillRect(-size / 2, -3, size, 6);
    ctx.beginPath(); ctx.ellipse(-6, -size / 2 - 3, 6, 4, -0.5, 0, Math.PI * 2); ctx.ellipse(6, -size / 2 - 3, 6, 4, 0.5, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
  }
  private drawSleigh(scene: SantaScene) {
    const ctx = this.ctx, bob = scene.calm ? 0 : Math.sin(scene.time / 260) * 3;
    const x = SANTA_WORLD.sleighX, y = SANTA_WORLD.releaseY - 14 + bob;
    ctx.save();
    // Reins.
    ctx.strokeStyle = "#e8b64c"; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(x + 22, y - 18); ctx.quadraticCurveTo(x + 70, y - 10, x + 104, y - 24); ctx.stroke();
    // Rudolph.
    const rx = x + 112, ry = y - 22 + (scene.calm ? 0 : Math.sin(scene.time / 180) * 2);
    ctx.fillStyle = "#a9714f";
    ctx.beginPath(); ctx.ellipse(rx, ry, 22, 12, 0, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = "#8a5a3c"; ctx.lineWidth = 4; ctx.lineCap = "round";
    const kick = scene.calm ? 0 : Math.sin(scene.time / 140) * 5;
    for (const [lx, sway] of [[-12, kick], [-4, -kick], [8, kick], [16, -kick]] as const) { ctx.beginPath(); ctx.moveTo(rx + lx, ry + 8); ctx.lineTo(rx + lx + sway, ry + 22); ctx.stroke(); }
    ctx.fillStyle = "#a9714f";
    ctx.beginPath(); ctx.ellipse(rx + 24, ry - 14, 11, 10, 0.2, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = "#7a4c30"; ctx.lineWidth = 2.5;
    ctx.beginPath(); ctx.moveTo(rx + 20, ry - 22); ctx.lineTo(rx + 14, ry - 36); ctx.moveTo(rx + 16, ry - 30); ctx.lineTo(rx + 8, ry - 33); ctx.moveTo(rx + 27, ry - 23); ctx.lineTo(rx + 30, ry - 37); ctx.stroke();
    ctx.fillStyle = "#3a2a2a"; ctx.beginPath(); ctx.arc(rx + 26, ry - 16, 1.8, 0, Math.PI * 2); ctx.fill();
    const nose = ctx.createRadialGradient(rx + 35, ry - 11, 1, rx + 35, ry - 11, 12);
    nose.addColorStop(0, "rgba(255, 90, 80, 0.9)"); nose.addColorStop(1, "rgba(255, 90, 80, 0)");
    ctx.fillStyle = nose; ctx.beginPath(); ctx.arc(rx + 35, ry - 11, 12, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = "#ff4d4d"; ctx.beginPath(); ctx.arc(rx + 35, ry - 11, 4.5, 0, Math.PI * 2); ctx.fill();
    // Santa.
    ctx.fillStyle = "#e8524a"; ctx.beginPath(); ctx.ellipse(x - 2, y - 26, 17, 18, 0, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = "#ffe0c8"; ctx.beginPath(); ctx.arc(x + 2, y - 48, 11, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = "#ffffff"; ctx.beginPath(); ctx.ellipse(x + 3, y - 38, 11, 9, 0, 0, Math.PI); ctx.fill();
    ctx.fillStyle = "#e8524a"; ctx.beginPath(); ctx.moveTo(x - 10, y - 54); ctx.quadraticCurveTo(x + 2, y - 74, x + 16, y - 58); ctx.lineTo(x + 12, y - 52); ctx.closePath(); ctx.fill();
    ctx.fillStyle = "#ffffff"; ctx.fillRect(x - 11, y - 56, 24, 5);
    ctx.beginPath(); ctx.arc(x + 17, y - 59, 4, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = "#3a2a2a"; ctx.beginPath(); ctx.arc(x + 6, y - 49, 1.6, 0, Math.PI * 2); ctx.fill();
    // Sack behind Santa.
    ctx.fillStyle = "#b9874f"; ctx.beginPath(); ctx.ellipse(x - 26, y - 24, 14, 16, -0.3, 0, Math.PI * 2); ctx.fill();
    // Sleigh body and runner.
    ctx.fillStyle = "#d9443d";
    ctx.beginPath(); ctx.moveTo(x - 44, y - 22); ctx.lineTo(x + 30, y - 18); ctx.quadraticCurveTo(x + 36, y + 4, x + 18, y + 6); ctx.lineTo(x - 36, y + 6); ctx.quadraticCurveTo(x - 50, y - 6, x - 44, y - 22); ctx.fill();
    ctx.fillStyle = "#f2c14e"; ctx.fillRect(x - 40, y - 8, 66, 4);
    ctx.strokeStyle = "#f2c14e"; ctx.lineWidth = 3;
    ctx.beginPath(); ctx.moveTo(x - 40, y + 12); ctx.lineTo(x + 30, y + 12); ctx.quadraticCurveTo(x + 44, y + 12, x + 42, y); ctx.stroke();
    // The gift in Santa's hand, ready to drop.
    ctx.restore();
    if (scene.ready !== null) this.drawGift({ x, y: SANTA_WORLD.releaseY + bob * 0.3, angle: 0, color: scene.ready, alpha: 1, clipBelow: null });
  }
  private drawSnow(scene: SantaScene) {
    if (scene.calm) return;
    const ctx = this.ctx;
    ctx.fillStyle = "rgba(255, 255, 255, 0.85)";
    for (const flake of FLAKES) {
      const y = (flake.y + scene.time * flake.speed) % (H + 10) - 5;
      const x = ((flake.x - scene.distance * 0.6 + Math.sin(scene.time / 900 + flake.sway) * 8) % (W + 10) + W + 10) % (W + 10) - 5;
      ctx.beginPath(); ctx.arc(x, y, flake.r, 0, Math.PI * 2); ctx.fill();
    }
  }
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
}
