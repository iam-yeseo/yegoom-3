// Deterministic curling shared by the browser and the Worker. Like
// shared/freethrow-physics.ts it uses only + - * / and Math.sqrt with a fixed
// time step, so the same five throws always give the same end everywhere.
//
// The sheet is seen from above. Units are metres and seconds: x points right,
// y runs from the release point toward the house. The sheet is shortened to
// fit one portrait screen (docs/plan-curling.md §2).

/** A throw is two integers so it can be stored and simulated again exactly. */
export interface StoneInput {
  /** 0–100: how hard the stone is pushed (swipe speed). */
  power: number;
  /** −100–100: the direction chosen before the push. 0 is straight up the sheet. */
  aim: number;
  /** Sweeping, as frame ranges [from, to, from, to, …] counted from the release
   * (FRAME_DT each): while a range is on, the ice in front of the thrown stone
   * is brushed and it slows down less. Absent when nothing was swept. */
  sweep?: number[];
}
export type StoneKind = 'button' | 'house' | 'guard' | 'wide' | 'short' | 'long' | 'out';
export interface StonePosition { id: number; x: number; y: number }
export interface SheetFrame { stones: StonePosition[] }
export interface SheetEvent { t: number; type: 'hit' | 'out' }
export interface ThrowResult {
  input: StoneInput;
  /** Where the thrown stone ended: in the house, in play outside it, or removed. */
  kind: StoneKind;
  /** The thrown stone touched another stone. */
  hits: number;
  /** Stones that were in the house before this throw and are not after it. */
  knocked: number;
  /** Stones on the sheet every FRAME_DT seconds, starting at release. */
  frames: SheetFrame[];
  events: SheetEvent[];
  /** Stones left in play once everything has stopped. */
  after: StonePosition[];
}

export const SHEET = {
  halfWidth: 2.3,
  stoneRadius: 0.2,
  /** A thrown stone must fully cross this line to stay in play. */
  hog: 2.6,
  /** Centre of the house. */
  tee: 5.6,
  houseRadius: 1.1,
  buttonRadius: 0.3,
  /** Drawing only: the rings inside the house. */
  rings: [1.1, 0.72, 0.3],
} as const;
/** A stone completely past this line is out of play. */
export const BACK_LINE = SHEET.tee + SHEET.houseRadius;
/** Ice friction as a constant deceleration (m/s²). */
const FRICTION = 0.9;
/** Swipe power maps linearly onto how far a free stone slides: `teePower`
 * stops on the tee and each point is `perPower` metres. Linear in distance
 * (not in speed) so a slightly fast hand is slightly long, not far too long. */
export const SLIDE = { teePower: 55, perPower: 0.12, min: 0.4 } as const;
/** Full aim (±100) tilts the throw sideways by this ratio (≈ ±17°). */
export const AIM_RATIO = 0.3;
/** Brushing the ice takes this share off the thrown stone's friction. Swept
 * from release to rest, a draw to the tee carries about a metre further. */
export const SWEEP = { ease: 0.16, maxRanges: 24 } as const;
const RESTITUTION = 0.9;
const STEP = 1 / 240;
const STEPS_PER_FRAME = 4;
export const FRAME_DT = STEP * STEPS_PER_FRAME;
/** Hard cap on simulated time (also bounds Worker CPU). */
const MAX_STEPS = 240 * 10;
export const MAX_FRAMES = MAX_STEPS / STEPS_PER_FRAME;

/** Sweep ranges are whole frames in order, never touching or overlapping, and few enough to store. */
export function validSweep(value: unknown): value is number[] {
  if (!Array.isArray(value) || value.length % 2 !== 0 || value.length > SWEEP.maxRanges * 2) return false;
  let last = -1;
  for (const frame of value as unknown[]) {
    if (!Number.isInteger(frame) || (frame as number) <= last || (frame as number) > MAX_FRAMES) return false;
    last = frame as number;
  }
  return true;
}
export function clampStone(input: StoneInput): StoneInput {
  const round = (value: number, low: number, high: number) => Math.max(low, Math.min(high, Math.round(Number.isFinite(value) ? value : 0)));
  const sweep = input.sweep?.length && validSweep(input.sweep) ? { sweep: [...input.sweep] } : {};
  return { power: round(input.power, 0, 100), aim: round(input.aim, -100, 100), ...sweep };
}
export function validStone(value: unknown): value is StoneInput {
  const input = value && typeof value === 'object' ? value as Record<string, unknown> : null;
  return !!input && Number.isInteger(input.power) && Number.isInteger(input.aim)
    && (input.power as number) >= 0 && (input.power as number) <= 100
    && (input.aim as number) >= -100 && (input.aim as number) <= 100
    && (input.sweep === undefined || validSweep(input.sweep));
}
/** How far a stone thrown this hard slides when nothing is in its way. */
export const slideDistance = (power: number): number => Math.max(SLIDE.min, SHEET.tee + (power - SLIDE.teePower) * SLIDE.perPower);
/** Unit direction of a throw. */
export function aimDirection(aim: number): { x: number; y: number } {
  const side = AIM_RATIO * aim / 100, norm = Math.sqrt(1 + side * side);
  return { x: side / norm, y: 1 / norm };
}
/** Any part of the stone touches the house. */
export const inHouse = (stone: { x: number; y: number }): boolean => {
  const dx = stone.x, dy = stone.y - SHEET.tee, reach = SHEET.houseRadius + SHEET.stoneRadius;
  return dx * dx + dy * dy <= reach * reach;
};
/** What a stone is worth by where it lies when the end is over, from the centre
 * outwards: inside a circle (the stone's centre is in it), then only touching
 * it (걸침). `reach` is the farthest the stone's centre may be from the tee. */
export const CURLING_ZONES = [
  { points: 10, label: '빨간 원 안', reach: SHEET.rings[2] },
  { points: 8, label: '빨간 원에 걸침', reach: SHEET.rings[2] + SHEET.stoneRadius },
  { points: 6, label: '흰 원 안', reach: SHEET.rings[1] },
  { points: 4, label: '흰 원에 걸침', reach: SHEET.rings[1] + SHEET.stoneRadius },
  { points: 2, label: '파란 원 안', reach: SHEET.rings[0] },
  { points: 1, label: '파란 원에 걸침', reach: SHEET.rings[0] + SHEET.stoneRadius },
] as const;
/** Points for a stone lying here: 10 in the middle down to 1 on the edge of the house, 0 outside it. */
export function stonePoints(stone: { x: number; y: number }): number {
  const dx = stone.x, dy = stone.y - SHEET.tee, gap2 = dx * dx + dy * dy;
  for (const zone of CURLING_ZONES) if (gap2 <= zone.reach * zone.reach) return zone.points;
  return 0;
}
/** The points of every stone on a sheet. */
export const sheetPoints = (sheet: readonly { x: number; y: number }[]): number => sheet.reduce((sum, stone) => sum + stonePoints(stone), 0);
/** In front of the house rather than beside it. */
const inLane = (stone: { x: number }): boolean => (stone.x < 0 ? -stone.x : stone.x) <= SHEET.houseRadius + SHEET.stoneRadius;
const onButton = (stone: { x: number; y: number }): boolean => {
  const dx = stone.x, dy = stone.y - SHEET.tee;
  return dx * dx + dy * dy <= SHEET.buttonRadius * SHEET.buttonRadius;
};

interface Body { id: number; x: number; y: number; vx: number; vy: number; alive: boolean; gone: 'side' | 'back' | null }

/** A throw being played out frame by frame, so the sweeping can be decided as it goes. */
export interface ThrowRun {
  /** Everything has stopped (or the time cap was reached). */
  readonly done: boolean;
  /** Frames advanced so far. */
  readonly frame: number;
  /** Stones in play right now. */
  stones(): StonePosition[];
  /** The thrown stone, while it is still sliding in play. */
  sliding(): StonePosition | null;
  /** Moves everything on by one frame, brushing the ice or not; returns what happened in it. */
  advance(sweeping: boolean): SheetEvent[];
  /** The outcome, once done. Its input carries the sweeping exactly as it was applied. */
  result(): ThrowResult;
}
/** Starts a throw onto a sheet that already holds `before`. The new stone gets `id`. */
export function startThrow(before: readonly StonePosition[], raw: StoneInput, id: number): ThrowRun {
  const input = clampStone(raw);
  const r = SHEET.stoneRadius, direction = aimDirection(input.aim);
  const speed = Math.sqrt(2 * FRICTION * slideDistance(input.power));
  const bodies: Body[] = [
    ...before.map(stone => ({ id: stone.id, x: stone.x, y: stone.y, vx: 0, vy: 0, alive: true, gone: null })),
    { id, x: 0, y: 0, vx: direction.x * speed, vy: direction.y * speed, alive: true, gone: null },
  ];
  const thrown = bodies[bodies.length - 1]!;
  const houseBefore = before.filter(inHouse).map(stone => stone.id);
  const snapshot = (): SheetFrame => ({ stones: bodies.filter(body => body.alive).map(body => ({ id: body.id, x: body.x, y: body.y })) });
  const frames: SheetFrame[] = [snapshot()];
  const events: SheetEvent[] = [];
  const touching = new Set<string>();
  const swept: number[] = [];
  let hits = 0, step = 0, frame = 0, done = false, outcome: ThrowResult | null = null;
  function advance(sweeping: boolean): SheetEvent[] {
    if (done) return [];
    const from = events.length;
    // Brushing only helps the stone that was thrown, while it is still moving, and only as often as can be stored.
    const brushed = sweeping && thrown.alive && (thrown.vx !== 0 || thrown.vy !== 0)
      && (swept.length % 2 === 1 || swept.length < SWEEP.maxRanges * 2);
    if (brushed !== (swept.length % 2 === 1)) swept.push(frame);
    do {
      step++;
      let moving = false;
      for (const body of bodies) {
        if (!body.alive) continue;
        const fast = Math.sqrt(body.vx * body.vx + body.vy * body.vy);
        if (fast <= 0) continue;
        const drop = (brushed && body === thrown ? FRICTION * (1 - SWEEP.ease) : FRICTION) * STEP;
        if (fast <= drop) { body.vx = 0; body.vy = 0; continue; }
        const keep = (fast - drop) / fast;
        body.vx *= keep; body.vy *= keep;
        body.x += body.vx * STEP; body.y += body.vy * STEP;
        moving = true;
      }
      // Equal stones: they trade the part of their speed that points at each other.
      for (let i = 0; i < bodies.length; i++) {
        const a = bodies[i]!;
        if (!a.alive) continue;
        for (let j = i + 1; j < bodies.length; j++) {
          const b = bodies[j]!;
          if (!b.alive) continue;
          const dx = b.x - a.x, dy = b.y - a.y, gap2 = dx * dx + dy * dy, key = `${a.id}:${b.id}`;
          if (gap2 >= 4 * r * r) { touching.delete(key); continue; }
          const gap = Math.sqrt(gap2);
          if (gap < 1e-9) continue;
          const nx = dx / gap, ny = dy / gap, overlap = (2 * r - gap) / 2;
          a.x -= nx * overlap; a.y -= ny * overlap; b.x += nx * overlap; b.y += ny * overlap;
          const closing = (a.vx - b.vx) * nx + (a.vy - b.vy) * ny;
          if (closing > 0) {
            const push = (1 + RESTITUTION) / 2 * closing;
            a.vx -= nx * push; a.vy -= ny * push; b.vx += nx * push; b.vy += ny * push;
            if (!touching.has(key)) {
              touching.add(key);
              events.push({ t: step * STEP, type: 'hit' });
              if (a === thrown || b === thrown) hits++;
            }
          }
        }
      }
      for (const body of bodies) {
        if (!body.alive) continue;
        const side = body.x > SHEET.halfWidth - r || body.x < r - SHEET.halfWidth;
        if (side || body.y > BACK_LINE + r || body.y < -1) {
          body.alive = false; body.gone = side ? 'side' : 'back';
          events.push({ t: step * STEP, type: 'out' });
        }
      }
      if (step % STEPS_PER_FRAME === 0) frames.push(snapshot());
      if (!moving || step >= MAX_STEPS) done = true;
    } while (!done && step % STEPS_PER_FRAME !== 0);
    frame++;
    if (done && swept.length % 2 === 1) swept.push(frame);
    return events.slice(from);
  }
  function result(): ThrowResult {
    if (outcome) return outcome;
    if (!done) throw new Error('The throw is still sliding');
    // The thrown stone has to clear the hog line; one that does not is taken off.
    let short = false;
    if (thrown.alive && thrown.y < SHEET.hog + r) { thrown.alive = false; short = true; frames.push(snapshot()); }
    const after = bodies.filter(body => body.alive).map(body => ({ id: body.id, x: body.x, y: body.y }));
    const kind: StoneKind = short ? 'short'
      : !thrown.alive ? (thrown.gone === 'side' ? 'out' : 'long')
        : onButton(thrown) ? 'button' : inHouse(thrown) ? 'house' : inLane(thrown) && thrown.y < SHEET.tee ? 'guard' : 'wide';
    const knocked = houseBefore.filter(stone => !after.some(left => left.id === stone && inHouse(left))).length;
    const played: StoneInput = { power: input.power, aim: input.aim, ...(swept.length ? { sweep: [...swept] } : {}) };
    return outcome = { input: played, kind, hits, knocked, frames, events, after };
  }
  return {
    get done() { return done; }, get frame() { return frame; },
    stones: () => snapshot().stones,
    sliding: () => (thrown.alive && (thrown.vx !== 0 || thrown.vy !== 0) ? { id: thrown.id, x: thrown.x, y: thrown.y } : null),
    advance, result,
  };
}
/** Whether a frame lies in one of the input's sweep ranges. */
function sweptAt(sweep: readonly number[] | undefined, frame: number): boolean {
  if (!sweep) return false;
  for (let i = 0; i + 1 < sweep.length; i += 2) if (frame >= sweep[i]! && frame < sweep[i + 1]!) return true;
  return false;
}
/** One whole throw onto a sheet that already holds `before`, swept as its input says. */
export function simulateThrow(before: readonly StonePosition[], raw: StoneInput, id: number): ThrowResult {
  const run = startThrow(before, raw, id), sweep = clampStone(raw).sweep;
  while (!run.done) run.advance(sweptAt(sweep, run.frame));
  return run.result();
}

export interface EndResult {
  throws: ThrowResult[];
  /** For each thrown stone, whether it lies in the house when the end is over. */
  counted: boolean[];
  /** For each thrown stone, what it is worth where it lies when the end is over. */
  points: number[];
  /** Stones in the house. */
  score: number;
  /** The end's points. */
  total: number;
}
/** A whole end: every stone thrown in order onto the stones left before it. */
export function simulateEnd(inputs: readonly StoneInput[]): EndResult {
  const throws: ThrowResult[] = [];
  let sheet: StonePosition[] = [];
  inputs.forEach((input, id) => { const result = simulateThrow(sheet, input, id); throws.push(result); sheet = result.after; });
  const points = inputs.map((_, id) => { const stone = sheet.find(left => left.id === id); return stone ? stonePoints(stone) : 0; });
  const counted = points.map(value => value > 0);
  return { throws, counted, points, score: counted.filter(Boolean).length, total: points.reduce((sum, value) => sum + value, 0) };
}
