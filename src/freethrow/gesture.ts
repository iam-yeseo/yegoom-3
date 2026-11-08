import type { ShotInput } from "../../shared/freethrow-physics";

/** A pointer sample in stage units: both axes are divided by the stage height,
 * so the same hand movement means the same shot on every screen size. y grows
 * downward like the screen; t is the event time in milliseconds. */
export interface GesturePoint { x: number; y: number; t: number }

export const GESTURE = {
  /** Only the movement just before release decides the shot (the "슉"). */
  windowMs: 110,
  /** The finger must travel this far up from its lowest point... */
  minRise: 0.07,
  /** ...and still be moving up at least this fast when it lets go (heights per second). */
  minSpeed: 0.55,
  /** Upward speed for full power. Power is proportional to speed, so ±10% swipe
   * speed is about ±5 power points around the middle. */
  fullPowerSpeed: 4.4,
  /** Sideways-to-upward ratio for full aim; a straight swipe is 0. */
  fullAimSlope: 0.8,
  /** How far the held ball follows the finger (stage heights). */
  pullDown: 0.15, pullUp: 0.05, pullSide: 0.06,
  /** A still finger for longer than this before letting go counts as stopping. */
  stallMs: 60,
  keepMs: 400,
} as const;

export type GestureOutcome =
  | { shot: ShotInput; speed: number; slope: number }
  | { shot: null; reason: "too-short" | "too-slow" | "downward" };

/** Reads the swipe that ended at the last point. Pulling down first is only a
 * wind-up: the speed comes from the final upward flick. */
export function readGesture(input: readonly GesturePoint[]): GestureOutcome {
  // The release usually repeats the last move's position a few ms later. That
  // is not a stop; only a pause longer than stallMs slows the throw down.
  let end = input.length;
  while (end > 2 && input[end - 1]!.x === input[end - 2]!.x && input[end - 1]!.y === input[end - 2]!.y
    && input[end - 1]!.t - input[end - 2]!.t < GESTURE.stallMs) end--;
  const points = input.slice(0, end);
  const last = points[points.length - 1];
  if (!last || points.length < 2) return { shot: null, reason: "too-short" };
  let lowest = last.y;
  for (const point of points) lowest = Math.max(lowest, point.y);
  if (lowest - last.y < GESTURE.minRise) return { shot: null, reason: "too-short" };
  // The oldest sample inside the window, interpolated to the window edge so
  // sparse pointer events (60 Hz vs 120 Hz screens) give the same speed.
  const edge = last.t - GESTURE.windowMs;
  let start = points[0]!;
  for (let i = points.length - 1; i > 0; i--) {
    const before = points[i - 1]!, after = points[i]!;
    if (before.t <= edge) {
      const span = after.t - before.t;
      const share = span > 0 ? (edge - before.t) / span : 0;
      start = { x: before.x + (after.x - before.x) * share, y: before.y + (after.y - before.y) * share, t: edge };
      break;
    }
    start = before;
  }
  const dt = (last.t - start.t) / 1000;
  if (dt <= 0) return { shot: null, reason: "too-slow" };
  const up = (start.y - last.y) / dt, side = (last.x - start.x) / dt;
  if (up < 0) return { shot: null, reason: "downward" };
  if (up < GESTURE.minSpeed) return { shot: null, reason: "too-slow" };
  const slope = side / up;
  const clamp = (value: number, low: number, high: number) => Math.max(low, Math.min(high, value));
  return {
    shot: { power: Math.round(clamp(up / GESTURE.fullPowerSpeed, 0, 1) * 100), aim: Math.round(clamp(slope / GESTURE.fullAimSlope, -1, 1) * 100) },
    speed: up, slope,
  };
}

/** Where the held ball sits while the finger drags it (stage units from rest). */
export function holdOffset(start: GesturePoint, now: GesturePoint): { x: number; y: number } {
  const clamp = (value: number, low: number, high: number) => Math.max(low, Math.min(high, value));
  return { x: clamp((now.x - start.x) * 0.5, -GESTURE.pullSide, GESTURE.pullSide), y: clamp(now.y - start.y, -GESTURE.pullUp, GESTURE.pullDown) };
}
