// Deterministic gift delivery shared by the browser and the Worker
// (docs/plan-santa.md). Like the free-throw engine it uses only + - * /,
// Math.sqrt and 32-bit integer math, so the same input always gives the same
// result everywhere.
//
// Units are logical stage pixels (360 × 560, y grows downward) and
// milliseconds. The sleigh stays at a fixed screen position and the world
// scrolls left under it. A dropped gift keeps the sleigh's forward speed, so on
// screen it falls straight down while the chimney slides toward it: the player
// has to drop it early by the distance the chimney travels during the fall.
// Higher chimneys mean shorter falls, so every house needs a different lead.

/** Logical canvas size; the buffer is scaled by devicePixelRatio (max 2). */
export const SANTA_STAGE = { width: 360, height: 560 } as const;
export const SANTA_WORLD = {
  /** Gift release point (under the sleigh's runners). */
  sleighX: 104, releaseY: 112,
  gravity: 1500 / 1_000_000, // px/ms²
  /** Chimney centre at the start and end of each house's approach. */
  startX: 440, endX: -80,
  /** First house speed (px/ms); the last one is speedUp faster. */
  baseSpeed: 170 / 1000, speedUp: 0.15,
  /** Gift half width, chimney mouth half width (inside), rim width; they match the drawn art. */
  giftHalf: 11, mouthHalf: 23, wall: 25,
  /** Chimney mouth y for each height level, lowest chimney first. */
  tops: [326, 294, 262, 230, 198],
  ground: 528,
} as const;
export type DropKind = 'in' | 'rim-early' | 'rim-late' | 'early' | 'late' | 'pass';
export interface SantaHouse {
  index: number;
  /** 0 (barely above the roof) … 4 (tallest). */
  level: number;
  /** Chimney top y. */
  top: number;
  /** Scroll speed in px/ms. */
  speed: number;
  /** Throws are accepted from 0 to approachMs after the approach starts. */
  approachMs: number;
  /** Drawing only. */
  style: number; gift: number;
}
export interface DropResult {
  kind: DropKind;
  hit: boolean;
  /** Release time in ms after the approach started; -1 when the house was passed. */
  release: number;
  /** ms from release until the gift reaches the chimney's top. */
  fallMs: number;
  /** Chimney centre minus gift centre when the gift reaches the chimney top (+ = chimney still ahead, the drop was early). */
  dx: number;
}

const LEVELS = SANTA_WORLD.tops.length;
export const HOUSE_STYLES = 4;
export const GIFT_STYLES = 3;
/** Chimney centre minus gift centre within this distance → the gift drops in. */
export const HIT_TOLERANCE = SANTA_WORLD.mouthHalf - SANTA_WORLD.giftHalf;
/** Beyond the mouth but within this distance the gift catches the chimney's rim. */
export const RIM_TOLERANCE = SANTA_WORLD.mouthHalf + SANTA_WORLD.wall + SANTA_WORLD.giftHalf;

/** mulberry32 on 32-bit integers: identical in every JavaScript engine. */
function random(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const pick = (next: () => number, count: number) => Math.min(count - 1, Math.floor(next() * count));

/** Speed of the house at `index` (px/ms): the sleigh gets a little faster each house. */
export const houseSpeed = (index: number, houses: number) =>
  SANTA_WORLD.baseSpeed * (1 + SANTA_WORLD.speedUp * (houses > 1 ? index / (houses - 1) : 0));

/** The course for a half-day slot: the same for every player in that slot.
 * Each height level appears equally often and never twice in a row. */
export function santaCourse(slot: number, houses = 10): SantaHouse[] {
  const next = random(Math.imul(slot + 1, 0x9e3779b1) ^ 0x5a17a);
  const base = Array.from({ length: houses }, (_, i) => i % LEVELS);
  let levels = base;
  for (let attempt = 0; attempt < 64; attempt++) {
    const order = [...base];
    for (let i = order.length - 1; i > 0; i--) {
      const j = pick(next, i + 1);
      [order[i], order[j]] = [order[j]!, order[i]!];
    }
    if (order.every((level, i) => i === 0 || level !== order[i - 1])) { levels = order; break; }
    // Fallback (practically never): the unshuffled 0,1,2,3,4,0,… never repeats.
  }
  return levels.map((level, index) => {
    const speed = houseSpeed(index, houses);
    return { index, level, top: SANTA_WORLD.tops[level]!, speed,
      approachMs: Math.floor((SANTA_WORLD.startX - SANTA_WORLD.endX) / speed),
      style: pick(next, HOUSE_STYLES), gift: pick(next, GIFT_STYLES) };
  });
}

/** Chimney centre x at `ms` after the approach started. */
export const chimneyX = (house: SantaHouse, ms: number) => SANTA_WORLD.startX - house.speed * ms;
/** ms the gift needs to fall from the sleigh to the chimney top. */
export const fallMs = (house: SantaHouse) => Math.sqrt((2 * (house.top - SANTA_WORLD.releaseY)) / SANTA_WORLD.gravity);
/** Gift y at `ms` after release. */
export const giftY = (ms: number) => SANTA_WORLD.releaseY + 0.5 * SANTA_WORLD.gravity * ms * ms;

export function validRelease(house: SantaHouse, value: unknown): value is number {
  return Number.isInteger(value) && (value === -1 || ((value as number) >= 0 && (value as number) <= house.approachMs));
}

/** Decides one house. `release` is ms after the approach started, or -1 (passed). */
export function judgeDrop(house: SantaHouse, release: number): DropResult {
  const fall = fallMs(house);
  if (release < 0) return { kind: 'pass', hit: false, release: -1, fallMs: fall, dx: 0 };
  const dx = chimneyX(house, release + fall) - SANTA_WORLD.sleighX;
  const off = Math.abs(dx);
  const kind: DropKind = off <= HIT_TOLERANCE ? 'in'
    : off <= RIM_TOLERANCE ? (dx > 0 ? 'rim-early' : 'rim-late')
      : dx > 0 ? 'early' : 'late';
  return { kind, hit: kind === 'in', release, fallMs: fall, dx };
}

/** The release that lands dead centre (tests and tuning). */
export const idealRelease = (house: SantaHouse) => Math.round((SANTA_WORLD.startX - SANTA_WORLD.sleighX) / house.speed - fallMs(house));
