// Deterministic free-throw physics shared by the browser and (from step 2) the
// Worker. Like shared/claw-physics.ts it uses only + - * / and Math.sqrt with a
// fixed time step, so the same input always produces the same shot everywhere.
//
// World units are metres and seconds. x points right, y up, z from the shooter
// toward the hoop. Sizes follow a regulation court: 4.19 m from the release
// point to the rim centre (the free-throw line), rim at 3.05 m.

/** A shot is two integers so it can be stored and re-simulated exactly. */
export interface ShotInput {
  /** 0–100: how hard the ball is thrown (swipe speed). */
  power: number;
  /** −100–100: left/right tilt of the swipe. 0 is straight at the rim. */
  aim: number;
}
export type ShotKind = 'swish' | 'bank' | 'rim-in' | 'rim-out' | 'board-out' | 'short' | 'long' | 'left' | 'right';
export type ShotEventType = 'rim' | 'board' | 'net' | 'floor';
export interface ShotEvent { t: number; type: ShotEventType }
export interface ShotFrame { x: number; y: number; z: number }
export interface ShotResult {
  input: ShotInput;
  made: boolean;
  kind: ShotKind;
  rimHits: number;
  boardHits: number;
  /** Ball centre every FRAME_DT seconds, starting at release. */
  frames: ShotFrame[];
  events: ShotEvent[];
  /** Seconds from release until the ball went through (made shots). */
  madeAt: number | null;
  /** Where the ball passed rim height on the way down, relative to the rim centre. */
  miss: { dx: number; dz: number } | null;
  /** Which part of the rim the ball touched first: front means short, back means long. */
  firstRim: RimSide | null;
  /** What the ball hit first. A shot off the glass first was long, whatever the rim did next. */
  firstContact: 'rim' | 'board' | null;
}
export type RimSide = 'front' | 'back' | 'left' | 'right';

export const COURT = {
  gravity: 9.81,
  ballRadius: 0.12,
  release: { x: 0, y: 2.05, z: 0 },
  rim: { x: 0, y: 3.05, z: 4.19, radius: 0.2286, tube: 0.01 },
  /** Front face of the backboard; the rim hangs 0.15 m in front of it. */
  board: { z: 4.57, halfWidth: 0.915, bottom: 2.9, top: 3.97 },
  /** The net hangs this far below the rim and narrows to this share of its radius. */
  net: { depth: 0.42, bottomScale: 0.62 },
} as const;
/** Launch elevation is fixed (≈52°); stored as cos/sin so no trigonometry runs here. */
const LAUNCH_COS = 0.615661475;
const LAUNCH_SIN = 0.788010754;
/** Swipe power 0–100 maps linearly onto this release speed range (m/s). */
export const SPEED = { min: 6.4, max: 8.0 } as const;
/** Full aim (±100) tilts the throw sideways by this ratio (≈ ±6°). */
export const AIM_RATIO = 0.105;
const STEP = 1 / 240;
const STEPS_PER_FRAME = 4;
export const FRAME_DT = STEP * STEPS_PER_FRAME;
/** Hard cap on simulated time (also bounds Worker CPU). */
const MAX_STEPS = 240 * 5;
/** Simulation keeps running this long after the outcome is known, for the animation. */
const TAIL_STEPS = 240 * 1.1;
const RIM_RESTITUTION = 0.42;
const RIM_FRICTION = 0.8;
const BOARD_RESTITUTION = 0.85;
/** The glass keeps most sideways speed but soaks up the fall, so hard shots bounce long. */
const BOARD_SIDE_FRICTION = 0.9;
const BOARD_FALL_FRICTION = 0.45;
const FLOOR_RESTITUTION = 0.62;

export function clampShot(input: ShotInput): ShotInput {
  const round = (value: number, low: number, high: number) => Math.max(low, Math.min(high, Math.round(Number.isFinite(value) ? value : 0)));
  return { power: round(input.power, 0, 100), aim: round(input.aim, -100, 100) };
}
export function validShot(value: unknown): value is ShotInput {
  const input = value && typeof value === 'object' ? value as Record<string, unknown> : null;
  return !!input && Number.isInteger(input.power) && Number.isInteger(input.aim)
    && (input.power as number) >= 0 && (input.power as number) <= 100
    && (input.aim as number) >= -100 && (input.aim as number) <= 100;
}

export function launchVelocity(input: ShotInput): ShotFrame {
  const speed = SPEED.min + (SPEED.max - SPEED.min) * input.power / 100;
  const side = AIM_RATIO * input.aim / 100;
  const flat = speed * LAUNCH_COS;
  const norm = Math.sqrt(1 + side * side);
  return { x: flat * side / norm, y: speed * LAUNCH_SIN, z: flat / norm };
}

export function simulateShot(raw: ShotInput): ShotResult {
  const input = clampShot(raw);
  const { ballRadius: r, gravity: g, rim, board, net } = COURT;
  const p: ShotFrame = { ...COURT.release };
  const v = launchVelocity(input);
  const frames: ShotFrame[] = [{ x: p.x, y: p.y, z: p.z }];
  const events: ShotEvent[] = [];
  let rimHits = 0, boardHits = 0, touchingRim = false, touchingBoard = false;
  let boardX = 0, firstRim: RimSide | null = null, firstContact: 'rim' | 'board' | null = null;
  let made = false, madeAt: number | null = null, miss: { dx: number; dz: number } | null = null;
  let decidedAt = -1, peaked = false, inNet = false;
  for (let step = 1; step <= MAX_STEPS; step++) {
    const t = step * STEP;
    const before = p.y;
    v.y -= g * STEP;
    p.x += v.x * STEP; p.y += v.y * STEP; p.z += v.z * STEP;
    if (v.y < 0) peaked = true;

    // Rim: a thin torus. The closest point on its centre circle pushes the ball out.
    const rx = p.x - rim.x, rz = p.z - rim.z;
    const flat = Math.sqrt(rx * rx + rz * rz);
    const ux = flat > 1e-9 ? rx / flat : 1, uz = flat > 1e-9 ? rz / flat : 0;
    const nx = p.x - (rim.x + ux * rim.radius), ny = p.y - rim.y, nz = p.z - (rim.z + uz * rim.radius);
    const gap = Math.sqrt(nx * nx + ny * ny + nz * nz);
    const reach = r + rim.tube;
    if (gap < reach && gap > 1e-9) {
      const ox = nx / gap, oy = ny / gap, oz = nz / gap;
      const push = reach - gap;
      p.x += ox * push; p.y += oy * push; p.z += oz * push;
      const into = v.x * ox + v.y * oy + v.z * oz;
      if (into < 0) {
        const tx = v.x - into * ox, ty = v.y - into * oy, tz = v.z - into * oz;
        const bounce = -into * RIM_RESTITUTION;
        v.x = tx * RIM_FRICTION + ox * bounce; v.y = ty * RIM_FRICTION + oy * bounce; v.z = tz * RIM_FRICTION + oz * bounce;
      }
      if (!touchingRim) {
        rimHits++; events.push({ t, type: 'rim' }); firstContact ??= 'rim';
        if (!firstRim) firstRim = uz < -0.6 ? 'front' : uz > 0.6 ? 'back' : ux < 0 ? 'left' : 'right';
      }
      touchingRim = true;
    } else touchingRim = false;

    // Backboard: the front face only. A ball wide of the board flies past it.
    if (p.z + r > board.z && p.z < board.z && p.x > -board.halfWidth - r * 0.5 && p.x < board.halfWidth + r * 0.5
      && p.y > board.bottom - r * 0.5 && p.y < board.top + r * 0.5) {
      p.z = board.z - r;
      if (v.z > 0) {
        v.z = -v.z * BOARD_RESTITUTION; v.x *= BOARD_SIDE_FRICTION; v.y *= BOARD_FALL_FRICTION;
        if (!touchingBoard) {
          boardHits++; events.push({ t, type: 'board' });
          if (!firstContact) { firstContact = 'board'; boardX = p.x - rim.x; }
        }
      }
      touchingBoard = true;
    } else touchingBoard = false;

    // Through the hoop: the centre crosses rim height downward inside the ring.
    if (!made && decidedAt < 0 && before >= rim.y && p.y < rim.y) {
      const dx = p.x - rim.x, dz = p.z - rim.z;
      if (dx * dx + dz * dz < rim.radius * rim.radius) {
        made = true; madeAt = t; decidedAt = step; inNet = true;
        events.push({ t, type: 'net' });
      } else if (!miss && peaked) miss = { dx, dz };
    }
    // The net slows the ball and pulls it toward the centre while it falls through.
    if (inNet) {
      if (p.y > rim.y - net.depth) {
        v.x *= 0.9; v.z *= 0.9; v.y *= 0.985;
        p.x += (rim.x - p.x) * 0.06; p.z += (rim.z - p.z) * 0.06;
      } else inNet = false;
    }

    // Floor: a miss is final once the ball lands; keep bouncing for the animation.
    if (p.y < r) {
      p.y = r;
      if (v.y < 0) {
        if (v.y < -1) events.push({ t, type: 'floor' });
        v.y = -v.y * FLOOR_RESTITUTION; v.x *= 0.8; v.z *= 0.8;
      }
      if (decidedAt < 0) decidedAt = step;
    }
    if (step % STEPS_PER_FRAME === 0) frames.push({ x: p.x, y: p.y, z: p.z });
    if (decidedAt >= 0 && step - decidedAt >= TAIL_STEPS) break;
  }
  return { input, made, kind: classify(made, firstContact, boardX, miss), rimHits, boardHits, frames, events, madeAt, miss, firstRim, firstContact };
}

function classify(made: boolean, first: 'rim' | 'board' | null, boardX: number, miss: { dx: number; dz: number } | null): ShotKind {
  if (made) return first === 'board' ? 'bank' : first === 'rim' ? 'rim-in' : 'swish';
  // Glass wide of the rim means the direction was off, not the power.
  if (first === 'board') return boardX < -COURT.rim.radius ? 'left' : boardX > COURT.rim.radius ? 'right' : 'board-out';
  if (first === 'rim') return 'rim-out';
  if (!miss) return 'short';
  const side = Math.abs(miss.dx), depth = Math.abs(miss.dz);
  if (side > depth) return miss.dx < 0 ? 'left' : 'right';
  return miss.dz < 0 ? 'short' : 'long';
}
