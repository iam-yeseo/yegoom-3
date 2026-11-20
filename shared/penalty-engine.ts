// Deterministic penalty shoot-out shared by the browser and the Worker. Only
// + - * / and Math.sqrt, so the same kicks give the same result everywhere
// (docs/plan-penalty.md §2).
//
// The goal is seen from behind the ball. Units are metres and seconds: x runs
// along the goal line (0 is the middle), y is height above the grass.

/** A kick is three integers so it can be stored and judged again exactly. */
export interface KickInput {
  /** 0–100: how hard the ball is struck (swipe speed). Harder is faster and higher. */
  power: number;
  /** −100–100: where the swipe pointed. 0 is the middle of the goal. */
  aim: number;
  /** Milliseconds from the whistle to the kick; −1 when the time ran out. */
  t: number;
}
export type KickKind = 'goal' | 'saved' | 'post' | 'wide' | 'over' | 'timeout';
export interface KickResult {
  input: KickInput;
  made: boolean;
  kind: KickKind;
  /** The ball went in off a post or the bar. */
  frame: boolean;
  /** A goal into one of the top corners. */
  corner: boolean;
  /** Where the ball crosses the goal line, and how long it takes to get there. */
  target: { x: number; y: number };
  flight: number;
  /** The keeper when the ball is struck (x, and which way they were stepping),
   * and where the dive ends. */
  keeper: { x: number; moving: number; dive: { x: number; y: number }; reach: number };
}
/** One keeper per kick: how they shuffle along the line before the ball is struck. */
export interface Keeper { amplitude: number; period: number; phase: number; wobble: number; wobblePeriod: number; wobblePhase: number; reach: number }

export const GOAL = {
  halfWidth: 3.66, height: 2.44, ballRadius: 0.11,
  /** Half the thickness of a post or the bar. */
  post: 0.06,
} as const;
export const KICK = {
  /** The whistle to the last moment a kick counts. */
  windowMs: 10_000,
  /** Full aim (±100) sends the ball this far from the middle: beyond the posts. */
  aimReach: 4.6,
  /** Height: nothing under `groundPower` leaves the grass, then `rise` metres a point. */
  groundPower: 8, rise: 0.03,
  /** Flight time from a roller (power 0) to a rocket (power 100). */
  slowest: 0.95, fastest: 0.45,
} as const;
const KEEPER = {
  /** How far a keeper already stepping one way is carried before they can dive. */
  carry: 0.22, maxCarry: 0.45,
  /** Arm span without moving, then metres per second of dive after the reaction time. */
  stand: 1.0, diveSpeed: 5.3, reaction: 0.14,
  /** A ball at bar height is this much harder to reach than one along the grass. */
  heightCost: 0.28,
} as const;

/** A smooth wave of period 1 in [−1, 1] made of two parabolas (no trigonometry). */
function wave(phase: number): number {
  const turn = phase - Math.floor(phase), half = turn < 0.5 ? turn * 2 : turn * 2 - 1;
  const value = 4 * half * (1 - half);
  return turn < 0.5 ? value : -value;
}
/** The wave's slope per unit of phase. */
function waveSlope(phase: number): number {
  const turn = phase - Math.floor(phase), half = turn < 0.5 ? turn * 2 : turn * 2 - 1;
  const slope = 8 * (1 - 2 * half);
  return turn < 0.5 ? slope : -slope;
}
/** The keepers of a set, decided by its seed. An official set uses its slot, so
 * everyone in that slot faces the same five; each one is quicker and wider. */
export function penaltyKeepers(seed: number, count: number): Keeper[] {
  let value = (Math.imul(seed | 0, 2654435761) ^ 0x9e3779b9) >>> 0;
  const random = () => ((value = (Math.imul(value, 1664525) + 1013904223) >>> 0) / 0x100000000);
  return Array.from({ length: count }, (_, index) => {
    const level = count > 1 ? index / (count - 1) : 0;
    const period = 1.7 - 0.6 * level + random() * 0.25;
    return {
      amplitude: 0.7 + 0.4 * level + random() * 0.2,
      period, phase: random(),
      wobble: 0.12 + 0.18 * level, wobblePeriod: period * (0.37 + random() * 0.1), wobblePhase: random(),
      reach: 1 + 0.16 * level,
    };
  });
}
/** Where the keeper stands `ms` after the whistle and how fast they are stepping (m/s). */
export function keeperAt(keeper: Keeper, ms: number): { x: number; v: number } {
  const t = ms / 1000;
  const a = t / keeper.period + keeper.phase, b = t / keeper.wobblePeriod + keeper.wobblePhase;
  return {
    x: keeper.amplitude * ((1 - keeper.wobble) * wave(a) + keeper.wobble * wave(b)),
    v: keeper.amplitude * ((1 - keeper.wobble) * waveSlope(a) / keeper.period + keeper.wobble * waveSlope(b) / keeper.wobblePeriod),
  };
}

export function clampKick(input: KickInput): KickInput {
  const round = (value: number, low: number, high: number) => Math.max(low, Math.min(high, Math.round(Number.isFinite(value) ? value : 0)));
  if (!(input.t >= 0)) return { power: 0, aim: 0, t: -1 };
  return { power: round(input.power, 0, 100), aim: round(input.aim, -100, 100), t: round(input.t, 0, KICK.windowMs) };
}
export function validKick(value: unknown): value is KickInput {
  const input = value && typeof value === 'object' ? value as Record<string, unknown> : null;
  if (!input || !Number.isInteger(input.power) || !Number.isInteger(input.aim) || !Number.isInteger(input.t)) return false;
  const { power, aim, t } = input as unknown as KickInput;
  if (t === -1) return power === 0 && aim === 0;
  return power >= 0 && power <= 100 && aim >= -100 && aim <= 100 && t >= 0 && t <= KICK.windowMs;
}
/** Where a kick crosses the goal line and how long it flies. */
export function kickTarget(input: KickInput): { x: number; y: number; flight: number } {
  return {
    x: KICK.aimReach * input.aim / 100,
    y: GOAL.ballRadius + Math.max(0, input.power - KICK.groundPower) * KICK.rise,
    flight: KICK.slowest - (KICK.slowest - KICK.fastest) * input.power / 100,
  };
}

export function judgeKick(keeper: Keeper, raw: KickInput): KickResult {
  const input = clampKick(raw);
  if (input.t < 0) {
    const stand = keeperAt(keeper, KICK.windowMs);
    return { input, made: false, kind: 'timeout', frame: false, corner: false, target: { x: 0, y: 0 }, flight: 0,
      keeper: { x: stand.x, moving: 0, dive: { x: stand.x, y: 0 }, reach: 0 } };
  }
  const { x, y, flight } = kickTarget(input);
  const stand = keeperAt(keeper, input.t);
  const carry = Math.max(-KEEPER.maxCarry, Math.min(KEEPER.maxCarry, stand.v * KEEPER.carry));
  const from = stand.x + carry;
  const reach = (KEEPER.stand + KEEPER.diveSpeed * Math.max(0, flight - KEEPER.reaction)) * keeper.reach
    * (1 - KEEPER.heightCost * Math.min(1, y / GOAL.height));
  const gap = x - from, away = gap < 0 ? -gap : gap;
  const dive = { x: from + Math.max(-reach, Math.min(reach, gap)), y: Math.min(y, GOAL.height - 0.25) };
  const edge = GOAL.ballRadius + GOAL.post, side = x < 0 ? -x : x;
  // The frame: the inner half of a post or the bar sends the ball in, the outer half out.
  const overBar = y - GOAL.height, pastPost = side - GOAL.halfWidth;
  let kind: KickKind, frame = false;
  if (overBar > edge) kind = 'over';
  else if (pastPost > edge) kind = 'wide';
  else if (overBar > 0 || pastPost > 0) kind = 'post';
  else {
    frame = overBar > -edge || pastPost > -edge;
    kind = away <= reach ? 'saved' : 'goal';
  }
  const made = kind === 'goal';
  return { input, made, kind, frame: made && frame, corner: made && y > 1.6 && side > 2.5, target: { x, y }, flight,
    keeper: { x: stand.x, moving: stand.v, dive, reach } };
}

export interface ShootoutResult { kicks: KickResult[]; goals: number }
export function judgeShootout(seed: number, inputs: readonly KickInput[]): ShootoutResult {
  const keepers = penaltyKeepers(seed, inputs.length);
  const kicks = inputs.map((input, index) => judgeKick(keepers[index]!, input));
  return { kicks, goals: kicks.filter(kick => kick.made).length };
}
