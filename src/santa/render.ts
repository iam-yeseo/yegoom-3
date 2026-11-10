import { SANTA_STAGE, SANTA_WORLD, type SantaHouse } from "../../shared/santa-engine";
import { SANTA_ART } from "./art";

// Draws the delivery with the user's art (public/santa/*.webp, see
// scripts/prepare-santa-art.py). Sizes and the house roof lines come from the
// measured geometry in ./art.ts, so the chimney rises from just right of each
// roof's ridge and a missed gift lands on the roof it actually hit. Until an
// image has loaded (or if it fails) a simple shape stands in for it.

export const STAGE = SANTA_STAGE;
const W = STAGE.width, H = STAGE.height, GROUND = SANTA_WORLD.ground;
/** Houses sit a little into the snow. */
const HOUSE_BOTTOM = GROUND + 8;
const { chimney: CHIMNEY, sleigh: SLEIGH, giftSize: GIFT_SIZE } = SANTA_ART;
const GIFT_NAMES = ["red", "green", "blue"] as const;
const GIFT_COLORS = ["#ef6b5b", "#5cc2a0", "#7fb4ec"] as const;
export const SANTA_IMAGES = ["sky", "sleigh", "chimney", "house-1", "house-2", "house-3", "house-4", ...GIFT_NAMES.map(name => `gift-${name}`)]
  .map(name => `/santa/${name}.webp`);

/** How far each level's chimney mouth rises above the roof under it. A taller
 * chimney top mostly stands on a bigger house, so the chimney itself grows a little. */
export const LEVEL_RISE = [34, 42, 50, 58, 66] as const;
/** Where a house is drawn when its chimney's centre is at screen x. The chimney
 * stands in the middle of every house; the house is sized so the roof there
 * sits LEVEL_RISE below the chimney mouth. */
export function housePlacement(house: Pick<SantaHouse, "style" | "level" | "top">, chimney: number) {
  const art = SANTA_ART.houses[house.style % SANTA_ART.houses.length]!;
  const under = art.roof[Math.round(art.chimneyX / art.roofStep)]! / art.height;
  const height = (HOUSE_BOTTOM - house.top - (LEVEL_RISE[house.level] ?? LEVEL_RISE[0])) / (1 - under), scale = height / art.height;
  const left = chimney - art.chimneyX * scale, top = HOUSE_BOTTOM - height;
  const index = (x: number) => Math.round((x - left) / (art.roofStep * scale));
  /** Roof top (snow surface) y at screen x, or null beside the house. */
  const roofAt = (x: number) => { const i = index(x); return i < 0 || i >= art.roof.length ? null : top + art.roof[i]! * scale; };
  /** The roof line carried on past the eaves (for the chimney's foot). */
  const roofLine = (x: number) => top + art.roof[Math.max(0, Math.min(art.roof.length - 1, index(x)))]! * scale;
  return { art, scale, left, top, width: art.width * scale, height, right: left + art.width * scale, roofAt, roofLine };
}
/** Roof (or ground) y at screen x, for a gift landing near a house. */
export function surfaceAt(house: Pick<SantaHouse, "style" | "level" | "top">, chimney: number, x: number) {
  return Math.min(GROUND, housePlacement(house, chimney).roofAt(x) ?? GROUND);
}

export interface GiftSprite { x: number; y: number; angle: number; color: number; alpha: number;
  /** Clip the gift below this y (it is going down the chimney). */
  clipBelow: number | null }
export interface SantaScene {
  /** Total distance the world has scrolled (px), for parallax and the ground. */
  distance: number;
  /** ms clock for snow, twinkle and the sleigh bob. */
  time: number;
  /** The house on screen and its chimney x. */
  house: { house: SantaHouse; x: number } | null;
  /** The previous house while it leaves the screen. */
  leaving: { house: SantaHouse; x: number } | null;
  gifts: GiftSprite[];
  /** The gift under the sleigh, ready to drop on this house. */
  ready: number | null;
  /** 0–1 glow around the chimney (by house index) that just got a gift. */
  glow: { index: number; amount: number } | null;
  calm: boolean;
}

export const emptyScene = (): SantaScene => ({ distance: 0, time: 0, house: null, leaving: null, gifts: [], ready: null, glow: null, calm: false });

const seeded = (n: number) => { const x = Math.sin(n * 127.1 + 311.7) * 43758.5453; return x - Math.floor(x); };
const STARS = Array.from({ length: 22 }, (_, i) => ({ x: seeded(i) * W, y: seeded(i + 99) * 260, r: 0.7 + seeded(i + 7) * 1.1, phase: seeded(i + 3) * 6.28 }));
const FLAKES = Array.from({ length: 42 }, (_, i) => ({ x: seeded(i + 500) * W, y: seeded(i + 900) * H, r: 1 + seeded(i + 40) * 2.2, speed: 0.018 + seeded(i + 70) * 0.03, sway: seeded(i + 11) * 6.28 }));

export class SantaRenderer {
  private ctx: CanvasRenderingContext2D;
  private ratio = 1;
  private images = new Map<string, HTMLImageElement>();
  /** onReady repaints whenever another picture has loaded. */
  constructor(private canvas: HTMLCanvasElement, onReady?: () => void) {
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("이 브라우저에서는 하늘을 그릴 수 없어요.");
    this.ctx = ctx;
    if (typeof Image === "undefined") return;
    for (const src of SANTA_IMAGES) {
      const image = new Image();
      image.decoding = "async";
      image.onload = () => { this.images.set(src, image); onReady?.(); };
      image.src = src;
    }
  }
  private image(name: string) { return this.images.get(`/santa/${name}.webp`) ?? null; }
  /** Matches the buffer to the displayed size × DPR (max 2). Returns whether it changed. */
  resize(): boolean {
    const rect = this.canvas.getBoundingClientRect();
    const ratio = Math.min(2, Math.max(1, window.devicePixelRatio || 1));
    const width = Math.round((rect.width || W) * ratio), height = Math.round((rect.height || H) * ratio);
    if (this.canvas.width === width && this.canvas.height === height) return false;
    this.canvas.width = width; this.canvas.height = height; this.ratio = width / W;
    return true;
  }
  draw(scene: SantaScene) {
    const ctx = this.ctx;
    ctx.setTransform(this.ratio, 0, 0, this.ratio, 0, 0);
    ctx.imageSmoothingQuality = "high";
    this.drawSky(scene);
    this.drawHills(scene.distance * 0.18, 446, "#7a69a8", 30, 0.011);
    this.drawFarHouses(scene.distance * 0.34);
    this.drawHills(scene.distance * 0.42, 478, "#9584bf", 20, 0.017);
    for (const entry of [scene.leaving, scene.house]) if (entry) this.drawHouse(entry.house, entry.x, scene.glow);
    this.drawGround(scene.distance);
    for (const gift of scene.gifts) this.drawGift(gift);
    this.drawSleigh(scene);
    this.drawSnow(scene);
  }

  private drawSky(scene: SantaScene) {
    const ctx = this.ctx, sky = this.image("sky");
    if (sky) ctx.drawImage(sky, 0, 0, W, H);
    else {
      const gradient = ctx.createLinearGradient(0, 0, 0, H);
      gradient.addColorStop(0, "#1c2150"); gradient.addColorStop(0.55, "#3c3772"); gradient.addColorStop(1, "#8a78b4");
      ctx.fillStyle = gradient; ctx.fillRect(0, 0, W, H);
    }
    if (scene.calm) return;
    for (const star of STARS) {
      ctx.fillStyle = `rgba(255, 250, 230, ${0.25 + 0.6 * Math.max(0, Math.sin(scene.time / 700 + star.phase))})`;
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
      const w = 24 + seeded(n + 5) * 14, h = 16 + seeded(n + 9) * 10, base = 462 + seeded(n + 2) * 8;
      ctx.fillStyle = "#6a5a97";
      ctx.fillRect(x, base - h, w, h);
      ctx.beginPath(); ctx.moveTo(x - 3, base - h); ctx.lineTo(x + w / 2, base - h - 12); ctx.lineTo(x + w + 3, base - h); ctx.fill();
      ctx.fillStyle = "rgba(255, 220, 130, 0.85)";
      ctx.fillRect(x + w * 0.25, base - h * 0.62, 4, 4);
      if (seeded(n + 13) > 0.4) ctx.fillRect(x + w * 0.62, base - h * 0.62, 4, 4);
    }
  }
  private drawGround(distance: number) {
    const ctx = this.ctx;
    ctx.fillStyle = "#fbf7ff";
    ctx.beginPath(); ctx.moveTo(0, H);
    for (let x = 0; x <= W; x += 6) ctx.lineTo(x, GROUND - 3 * Math.sin((x + distance) * 0.035));
    ctx.lineTo(W, H); ctx.closePath(); ctx.fill();
    ctx.fillStyle = "#e6def3";
    const spacing = 46, offset = distance % spacing;
    for (let x = -offset; x < W + spacing; x += spacing) { ctx.beginPath(); ctx.ellipse(x, GROUND + 16, 12, 3, 0, 0, Math.PI * 2); ctx.fill(); }
  }
  private drawHouse(house: SantaHouse, chimney: number, glow: SantaScene["glow"]) {
    const ctx = this.ctx, place = housePlacement(house, chimney);
    if (place.right < -CHIMNEY.cap || place.left > W + CHIMNEY.cap) return;
    const image = this.image(`house-${(house.style % SANTA_ART.houses.length) + 1}`);
    if (image) ctx.drawImage(image, place.left, place.top, place.width, place.height);
    else {
      ctx.fillStyle = "#fff3e0";
      ctx.beginPath(); ctx.moveTo(place.left, HOUSE_BOTTOM);
      for (let x = place.left; x <= place.right; x += 4) ctx.lineTo(x, place.roofAt(x) ?? HOUSE_BOTTOM);
      ctx.lineTo(place.right, HOUSE_BOTTOM); ctx.closePath(); ctx.fill();
    }
    const amount = glow && glow.index === house.index ? glow.amount : 0;
    if (amount > 0) {
      const light = ctx.createRadialGradient(chimney, house.top, 4, chimney, house.top, 80);
      light.addColorStop(0, `rgba(255, 228, 140, ${0.8 * amount})`); light.addColorStop(1, "rgba(255, 228, 140, 0)");
      ctx.fillStyle = light; ctx.fillRect(chimney - 80, house.top - 80, 160, 160);
    }
    // The chimney stands on the roof in front of it: its foot is cut along the
    // roof's snow line, so it rises out of the snow on the ridge.
    const from = chimney - CHIMNEY.cap / 2 - 2, to = chimney + CHIMNEY.cap / 2 + 2;
    ctx.save();
    ctx.beginPath(); ctx.moveTo(from, 0); ctx.lineTo(to, 0);
    for (let x = to; x >= from; x -= 2) ctx.lineTo(x, place.roofLine(x) + 4);
    ctx.closePath(); ctx.clip();
    const chimneyImage = this.image("chimney");
    if (chimneyImage) ctx.drawImage(chimneyImage, chimney - CHIMNEY.mouthX, house.top - CHIMNEY.mouthY, CHIMNEY.width, CHIMNEY.height);
    else {
      ctx.fillStyle = "#e0604f"; ctx.fillRect(chimney - CHIMNEY.body / 2, house.top, CHIMNEY.body, GROUND - house.top);
      ctx.fillStyle = "#f07a66"; ctx.fillRect(chimney - CHIMNEY.cap / 2, house.top - 10, CHIMNEY.cap, 22);
      ctx.fillStyle = "#3a2430"; ctx.beginPath(); ctx.ellipse(chimney, house.top, SANTA_WORLD.mouthHalf, 5, 0, 0, Math.PI * 2); ctx.fill();
    }
    ctx.restore();
  }
  private drawGift(gift: GiftSprite) {
    const ctx = this.ctx, image = this.image(`gift-${GIFT_NAMES[gift.color % GIFT_NAMES.length]}`);
    ctx.save();
    ctx.globalAlpha = gift.alpha;
    if (gift.clipBelow !== null) { ctx.beginPath(); ctx.rect(0, 0, W, gift.clipBelow); ctx.clip(); }
    ctx.translate(gift.x, gift.y); ctx.rotate(gift.angle);
    // The picture's box fills the engine's gift; the bow sits above it.
    if (image) ctx.drawImage(image, -GIFT_SIZE / 2, SANTA_WORLD.giftHalf - GIFT_SIZE, GIFT_SIZE, GIFT_SIZE);
    else {
      const size = SANTA_WORLD.giftHalf * 2;
      ctx.fillStyle = GIFT_COLORS[gift.color % GIFT_COLORS.length]!; ctx.fillRect(-size / 2, -size / 2, size, size);
      ctx.fillStyle = "#fff1d6"; ctx.fillRect(-2.5, -size / 2, 5, size); ctx.fillRect(-size / 2, -2.5, size, 5);
    }
    ctx.restore();
  }
  private drawSleigh(scene: SantaScene) {
    const ctx = this.ctx, bob = scene.calm ? 0 : Math.sin(scene.time / 260) * 3;
    const left = SANTA_WORLD.sleighX - SLEIGH.dropX;
    const bottom = SANTA_WORLD.releaseY - SANTA_WORLD.giftHalf - 1;
    const image = this.image("sleigh");
    ctx.save();
    // A gentle tilt with the bob, as if riding the wind.
    ctx.translate(SANTA_WORLD.sleighX, bottom + bob);
    if (!scene.calm) ctx.rotate(Math.sin(scene.time / 520) * 0.025);
    if (image) ctx.drawImage(image, -SLEIGH.dropX, -SLEIGH.height, SLEIGH.width, SLEIGH.height);
    else {
      ctx.fillStyle = "#e8524a"; ctx.fillRect(left - SANTA_WORLD.sleighX, -40, 90, 34);
      ctx.fillStyle = "#a9714f"; ctx.fillRect(left - SANTA_WORLD.sleighX + 120, -50, 50, 26);
    }
    ctx.restore();
    if (scene.ready !== null) this.drawGift({ x: SANTA_WORLD.sleighX, y: SANTA_WORLD.releaseY + bob, angle: 0, color: scene.ready, alpha: 1, clipBelow: null });
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
