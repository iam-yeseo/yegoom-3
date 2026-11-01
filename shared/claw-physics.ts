// Type-only port of iam-yeseo/yegoom@5a8017247c365b7233f4dfb2209a6bf27a30c678.
// The original runtime operations and their ordering are preserved verbatim.
export interface Doll {
  id: string;
  type: number;
  x: number;
  y: number;
  radius: number;
  angle: number;
  vx?: number;
  vy?: number;
}
export type Board = Doll[];
export interface ClawPosition { x: number; velocity: number }
export interface AttemptInput { x: number; stop?: number | null; pickup?: number; carry?: number }
export type SimulationPhase = 'descend' | 'close' | 'lift' | 'carry' | 'release' | 'settle';
interface Rest { x: number; y: number; angle: number }
interface Body extends Doll {
  vx: number;
  vy: number;
  sleep: boolean;
  still: number;
  rest: Rest | null;
  px?: number;
  py?: number;
  pa?: number;
  captured?: boolean;
}
interface Pusher { x: number; y: number; radius: number; vx: number; vy: number }
export interface HeldDoll extends Doll { relX: number; relY: number; settle: number; bump: number }
export interface ReleasedDoll { phase: SimulationPhase; x: number; y: number }
export interface SimulationFrame {
  phase: SimulationPhase;
  cx: number;
  cy: number;
  closed: number;
  swing: number;
  held: HeldDoll | null;
  dolls: Doll[];
  chute: Doll[];
}
export interface AttemptResult {
  target: Doll | null;
  bottom: number;
  quality: number;
  prizes: Doll[];
  released: ReleasedDoll | null;
  reason: 'caught' | 'miss' | 'lift-drop' | 'travel-drop';
  board: Board;
  frames: SimulationFrame[] | null;
}

// A small deterministic circle-body engine shared by the Worker and canvas renderer.
// Positions use the machine's normalized 600 × 420 playfield; velocities use px/s.
//
// The Worker decides every play by running simulateAttempt() and the browser replays
// the very same frames, so what the player sees is the result. To keep both sides
// bit-for-bit identical the simulation only uses + - * / and Math.sqrt, which every
// JavaScript engine rounds exactly (Math.hypot, sin and cos may differ by engine).
export const DOLL_COUNT = 30;
export const DOLL_TYPES = 11;
export const MACHINE = Object.freeze({ width: 600, height: 420, radius: 32, leftWall: 120, dividerHeight: 260, floor: 420, clawMin: .05, clawMax: .95, home: .1 });
// Claw geometry (px below the carriage) and motor speeds (px/s, px/s²).
export const CLAW = Object.freeze({ top: 48, hold: 63, tip: 80, body: 29, prong: 30, descend: 260, lift: 240, travel: 288, accel: 900 });
// Relative weight of each sprite type (1..11). Heavier dolls slip out of a weak claw sooner.
export const DOLL_WEIGHT = Object.freeze([1, 1, .9, 1.15, .85, 1.05, .95, 1.2, .8, 1.1, .9, 1]);
// New machines get slightly different sizes per type, so the pile packs unevenly like plush toys.
export const DOLL_RADIUS = Object.freeze([32, 32, 30, 34, 29, 33, 31, 35, 28, 33, 30, 32]);
const MAX_RADIUS = 36;
export const FPS = 60;
const DT = 1 / FPS, GRAVITY = 1500;
// The chute divider is a post with a rounded top; anything that rolls over it is a prize.
const DIVIDER_X = 117, DIVIDER_TOP = MACHINE.height - MACHINE.dividerHeight, CORNER = 4;
const clamp = (n: number, min: number, max: number) => Math.max(min, Math.min(max, n));
const byId = (a: Pick<Doll, 'id'>, b: Pick<Doll, 'id'>) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0;

export function moveClaw(claw: ClawPosition, direction: number, dt: number) {
  const step = clamp(dt, 0, 1 / 30);
  let velocity = claw.velocity + (direction * .48 - claw.velocity) * (1 - Math.exp(-step * (direction ? 9 : 7)));
  if (!direction && Math.abs(velocity) < .001) velocity = 0;
  const x = clamp(claw.x + velocity * step, MACHINE.clawMin, MACHINE.clawMax);
  if (x === MACHINE.clawMin || x === MACHINE.clawMax) velocity = 0;
  return { x, velocity };
}

// Bodies carry a little transient state while simulating; boards never store it.
// A body that has barely moved for a while falls asleep: it stops integrating and acts
// as a fixed obstacle until something hits it hard. That stands in for static friction,
// so a pile of uneven plush stays put instead of slowly creeping sideways.
const SLEEP_FRAMES = 20, SLEEP_DISTANCE = 1.5, WAKE_SPEED = 40;
const toBodies = (board: Board, asleep = false): Body[] => board.map(d => ({ ...d, x: d.x * MACHINE.width, y: d.y * MACHINE.height,
  vx: d.vx ?? 0, vy: d.vy ?? 0, angle: d.angle ?? 0, sleep: asleep, still: 0, rest: null }));
const round = (n: number) => Number(n.toFixed(6));
const dollOf = ({ vx, vy, sleep, still, rest, px, py, pa, captured, ...d }: Body) => d;
const toBoard = (bodies: Body[]) => bodies.map(b => { const d = dollOf(b); return { ...d, x: round(d.x / MACHINE.width), y: round(d.y / MACHINE.height), angle: round(d.angle) }; });

function wake(d: Body) {
  d.sleep = false; d.still = 0; d.rest = null;
}

function bound(d: Body, chute: boolean) {
  const { width, leftWall, floor } = MACHINE, r = d.radius;
  if (d.x > width - r) { d.x = width - r; d.vx = -Math.abs(d.vx) * .12; }
  if (d.y > floor - r) { d.y = floor - r; d.vy = -Math.abs(d.vy) * .08; d.vx *= .82; }
  if (!chute || d.y >= DIVIDER_TOP) {
    // Below the divider top the toy bay ends at the divider; past it is the chute.
    if (chute && d.x < DIVIDER_X) { d.captured = true; return; }
    if (d.x < leftWall + r) { d.x = leftWall + r; d.vx = Math.abs(d.vx) * .12; }
    return;
  }
  if (d.x < r) { d.x = r; d.vx = Math.abs(d.vx) * .12; }
  const dx = d.x - DIVIDER_X, dy = d.y - DIVIDER_TOP, min = r + CORNER, dist2 = dx * dx + dy * dy;
  if (dist2 >= min * min) return;
  const dist = Math.sqrt(dist2) || .0001, nx = dist2 ? dx / dist : 1, ny = dist2 ? dy / dist : 0;
  d.x += nx * (min - dist); d.y += ny * (min - dist);
  const closing = d.vx * nx + d.vy * ny;
  if (closing < 0) { d.vx -= 1.1 * closing * nx; d.vy -= 1.1 * closing * ny; }
}

function collide(a: Body, b: Body) {
  if (a.sleep && b.sleep) return;
  let dx = b.x - a.x, dy = b.y - a.y;
  const sum = a.radius + b.radius;
  // Cheap rejection first: most pairs are far apart, so skip the square root.
  if (dx * dx + dy * dy >= sum * sum) return;
  let distance = Math.sqrt(dx * dx + dy * dy);
  if (distance < .0001) { dx = .001; dy = -.001; distance = Math.sqrt(dx * dx + dy * dy); }
  const nx = dx / distance, ny = dy / distance, penetration = sum - distance;
  let closing = (b.vx - a.vx) * nx + (b.vy - a.vy) * ny;
  // A gentle touch leaves a sleeping doll where it is; a real knock wakes it up.
  if ((a.sleep || b.sleep) && (-closing > WAKE_SPEED || penetration > 2)) wake(a.sleep ? a : b);
  if (a.sleep || b.sleep) {
    const moving = a.sleep ? b : a, sign = a.sleep ? 1 : -1;
    moving.x += sign * nx * penetration; moving.y += sign * ny * penetration;
    const into = sign * (moving.vx * nx + moving.vy * ny);
    if (into < 0) { moving.vx -= sign * into * nx; moving.vy -= sign * into * ny; }
    moving.vx *= .96;
    return;
  }
  a.x -= nx * penetration / 2; a.y -= ny * penetration / 2;
  b.x += nx * penetration / 2; b.y += ny * penetration / 2;
  if (closing < 0) {
    const impulse = -.55 * closing;
    a.vx -= impulse * nx; a.vy -= impulse * ny;
    b.vx += impulse * nx; b.vy += impulse * ny;
  }
  a.vx *= .96; b.vx *= .96;
}

// A doll held by the claw moves with the claw and shoves loose dolls aside.
function shove(d: Body, pusher: Pusher) {
  const dx = d.x - pusher.x, dy = d.y - pusher.y, sum = d.radius + pusher.radius;
  if (dx * dx + dy * dy >= sum * sum) return 0;
  wake(d);
  const distance = Math.sqrt(dx * dx + dy * dy) || .0001, nx = dx / distance, ny = dy / distance, penetration = sum - distance;
  d.x += nx * penetration; d.y += ny * penetration;
  const closing = (d.vx - pusher.vx) * nx + (d.vy - pusher.vy) * ny;
  if (closing < 0) { d.vx -= 1.2 * closing * nx; d.vy -= 1.2 * closing * ny; }
  return penetration;
}

// Advances bodies in place by one step and returns those that fell into the chute.
// Position correction plus collision impulses keeps a pile stable without tunneling.
function stepBodies(bodies: Body[], step: number, { chute = false, pusher = null }: { chute?: boolean; pusher?: Pusher | null } = {}) {
  for (const d of bodies) {
    if (d.sleep) continue;
    d.px = d.x; d.py = d.y; d.pa = d.angle;
    d.vy += GRAVITY * step;
    d.x += d.vx * step; d.y += d.vy * step;
    d.vx *= .985; d.vy *= .995;
    // Dolls roll a little as they slide, but never end up upside down.
    d.angle = clamp(d.angle + d.vx * step / d.radius * .35, -.6, .6);
  }
  // Sweep pairs in x order so the scan stops at the first body out of reach.
  // Insertion sort is cheap here because the order barely changes between frames.
  const order = bodies.slice();
  for (let i = 1; i < order.length; i++) {
    const d = order[i];
    let j = i - 1;
    while (j >= 0 && (order[j].x > d.x || order[j].x === d.x && byId(order[j], d) > 0)) { order[j + 1] = order[j]; j--; }
    order[j + 1] = d;
  }
  let pushed = 0, captured = false;
  for (let pass = 0; pass < 6; pass++) {
    for (const d of order) if (!d.sleep && !d.captured) { bound(d, chute); captured ||= !!d.captured; }
    for (let i = 0; i < order.length; i++) {
      const a = order[i];
      if (a.captured) continue;
      for (let j = i + 1; j < order.length; j++) {
        const b = order[j];
        if (b.x - a.x >= a.radius + MAX_RADIUS + 4) break;
        if (!b.captured) collide(a, b);
      }
    }
    if (pusher) for (const d of order) if (!d.captured) pushed += shove(d, pusher);
  }
  // Collisions in the last pass may nudge a doll into a wall; walls always win.
  for (const d of order) if (!d.sleep && !d.captured) { bound(d, chute); captured ||= !!d.captured; }
  // A body that stays within a hair of one spot for long enough goes back to that spot
  // and sleeps, so re-settling a resting pile reproduces it exactly.
  for (const d of bodies) {
    if (d.sleep || d.captured || d.px === undefined) continue;
    d.rest ??= { x: d.px, y: d.py!, angle: d.pa! };
    if (Math.abs(d.x - d.rest.x) > SLEEP_DISTANCE || Math.abs(d.y - d.rest.y) > SLEEP_DISTANCE) { d.still = 0; d.rest = { x: d.x, y: d.y, angle: d.angle }; continue; }
    if (++d.still >= SLEEP_FRAMES) Object.assign(d, d.rest, { vx: 0, vy: 0, sleep: true, rest: null });
  }
  if (!captured) return { captured: [], pushed };
  const fallen = bodies.filter(d => d.captured);
  for (let i = bodies.length - 1; i >= 0; i--) if (bodies[i].captured) bodies.splice(i, 1);
  return { captured: fallen, pushed };
}

export function stepBoard(board: Board, { dt = 1 / 60 } = {}) {
  const { width, height, leftWall, floor } = MACHINE;
  const bodies = toBodies(board);
  stepBodies(bodies, clamp(dt, 0, 1 / 30));
  return bodies.map(b => { const d = dollOf(b); return { ...d, vx: b.vx, vy: b.vy, x: clamp(d.x, leftWall + d.radius, width - d.radius) / width,
    y: Math.min(d.y, floor - d.radius) / height }; });
}

const asleep = (bodies: Body[]) => bodies.every(d => d.sleep);

// The pile normally comes to rest within ~40 frames. Stop once every body sleeps
// so the Worker does not burn CPU simulating a motionless pile.
export function settleBoard(board: Board, frames = 360) {
  const bodies = toBodies(board);
  for (let frame = 0; frame < frames && !asleep(bodies); frame++) stepBodies(bodies, DT);
  return toBoard(bodies);
}

export function createBoard(generation = 1, seed = generation) {
  // A stored seed makes layouts reproducible; the server supplies a fresh random
  // seed for each machine. Rows are staggered and jittered so the pile looks tossed in.
  let value = seed >>> 0;
  const random = () => ((value = (Math.imul(value, 1664525) + 1013904223) >>> 0) / 0x100000000);
  const initial = Array.from({ length: DOLL_COUNT }, (_, i) => {
    const row = Math.floor(i / 7), type = Math.floor(random() * DOLL_TYPES) + 1;
    return { id: `${generation}-${i + 1}`, type,
      x: (164 + i % 7 * 64 + row % 2 * 30 + random() * 16 - 8) / MACHINE.width,
      y: (350 - row * 70) / MACHINE.height,
      radius: DOLL_RADIUS[type], angle: (random() * 34 - 17) * Math.PI / 180 };
  });
  return settleBoard(initial);
}

// The first circle touched by the descending claw occludes all dolls below it.
export function selectTarget(board: Board, x: number) {
  return board.map(d => {
    const dx = Math.abs(d.x - x) * MACHINE.width;
    return { d, hitY: dx <= d.radius ? d.y * MACHINE.height - Math.sqrt(d.radius * d.radius - dx * dx) : Infinity };
  }).filter(h => Number.isFinite(h.hitY)).sort((a, b) => a.hitY - b.hitY || byId(a.d, b.d))[0]?.d ?? null;
}

export function canGrip(doll: Doll | null, x: number) {
  return !!doll && Math.abs(doll.x - x) * MACHINE.width <= doll.radius * .76;
}

// Where the claw stops on its own: its body rests on the doll under the rope, unless
// a prong lands on a neighbour (or the divider) first. Prongs slide around the target.
export function planDescent(board: Board, x: number) {
  const px = x * MACHINE.width, target = selectTarget(board, x);
  let bottom = MACHINE.floor - 4 - CLAW.tip;
  if (target) {
    const dx = (target.x - x) * MACHINE.width;
    bottom = Math.min(bottom, target.y * MACHINE.height - Math.sqrt(target.radius * target.radius - dx * dx) - CLAW.body);
  }
  for (const side of [-1, 1]) {
    const prong = px + side * CLAW.prong;
    if (prong > DIVIDER_X - 6 && prong < MACHINE.leftWall) bottom = Math.min(bottom, DIVIDER_TOP - CLAW.tip + 8);
    for (const d of board) {
      if (d === target) continue;
      const dx = Math.abs(d.x * MACHINE.width - prong);
      if (dx < d.radius) bottom = Math.min(bottom, d.y * MACHINE.height - Math.sqrt(d.radius * d.radius - dx * dx) - CLAW.tip + 8);
    }
  }
  return { target, bottom: Math.max(CLAW.top, bottom) };
}

// How well the closed prongs cradle a doll: centred and below its middle is best.
export function gripQuality(doll: Doll | null, x: number, bottom: number) {
  if (!doll) return 0;
  const offset = Math.abs(doll.x - x) * MACHINE.width / doll.radius;
  const depth = clamp((bottom + CLAW.tip - doll.y * MACHINE.height + 26) / 40, 0, 1);
  if (offset > .76 || depth <= 0) return 0;
  const centred = offset / .76;
  return (1 - .75 * centred * centred) * (.3 + .7 * depth);
}

// One axis of a carriage move with a trapezoid speed profile; returns the new state.
function drive(position: number, velocity: number, goal: number, max: number) {
  const remaining = goal - position, direction = remaining < 0 ? -1 : 1, distance = remaining * direction;
  let speed = velocity * direction;
  if (distance < .01) return { position: goal, velocity: 0, accel: -velocity / DT, done: true };
  speed = speed * speed / (2 * CLAW.accel) >= distance ? Math.max(0, speed - CLAW.accel * DT) : Math.min(max, speed + CLAW.accel * DT);
  let next = position + direction * speed * DT;
  if ((goal - next) * direction <= 0 || speed === 0) { next = goal; speed = 0; }
  return { position: next, velocity: direction * speed, accel: (direction * speed - velocity) / DT, done: next === goal };
}

/**
 * Plays one coin: descend at x (or until `stop`), close, lift, carry to the chute and open.
 * `pickup` and `carry` are the claw's holding power (0~1) before and after it reaches the top.
 * Returns the outcome, the board after everything settles, and optionally every frame.
 */
export function simulateAttempt(board: Board, { x, stop = null, pickup = 1, carry = 1 }: AttemptInput, { record = false } = {}): AttemptResult {
  const { width, height } = MACHINE;
  const plan = planDescent(board, x);
  const bottom = stop == null ? plan.bottom : clamp(stop, CLAW.top, plan.bottom);
  // A stored board is a resting pile, so every doll starts asleep until the claw disturbs it.
  const bodies = toBodies(board, true), frames: SimulationFrame[] | null = record ? [] : null, chute: (Doll & { vx: number; vy: number })[] = [], prizes: string[] = [];
  const claw: Record<'x' | 'y' | 'vx' | 'vy' | 'ax' | 'ay' | 'closed' | 'swing' | 'swingV', number> = { x: x * width, y: CLAW.top, vx: 0, vy: 0, ax: 0, ay: 0, closed: 0, swing: 0, swingV: 0 };
  let phase: SimulationPhase = 'descend', held: HeldDoll | null = null, quality = 0, power = pickup, slip = 0, buried = 0, released: ReleasedDoll | null = null, stepping = false;

  // The canvas rotates the claw clockwise by `swing`, which carries its tip to the left.
  const heldPosition = () => ({ x: claw.x + held!.relX - claw.swing * CLAW.hold, y: claw.y + held!.relY + slip * 12 });
  const snapshot = () => frames && frames.push({ phase, cx: claw.x, cy: claw.y, closed: claw.closed, swing: claw.swing,
    held: held && { ...held, ...heldPosition(), angle: held.angle + (held.relX < 0 ? -1 : 1) * slip * .5 },
    dolls: bodies.map(d => ({ id: d.id, type: d.type, x: d.x, y: d.y, angle: d.angle, radius: d.radius })),
    chute: chute.map(d => ({ id: d.id, type: d.type, x: d.x, y: d.y, angle: d.angle, radius: d.radius })) });

  function release() {
    const at = heldPosition(), { relX, relY, settle, bump, ...doll } = held!;
    bodies.push({ ...doll, ...at, vx: claw.vx - claw.swingV * CLAW.hold, vy: claw.vy, sleep: false, still: 0, rest: null });
    released ??= { phase, x: round(at.x / width), y: round(at.y / height) };
    held = null; slip = 0;
  }

  function tick() {
    // Pendulum: the hanging claw lags behind carriage acceleration and settles back.
    claw.swingV += (-35 * claw.swing - 5 * claw.swingV + claw.ax / 120) * DT;
    claw.swing = clamp(claw.swing + claw.swingV * DT, -.22, .22);
    if (held) {
      if (held.settle > 0) { held.relX *= .9; held.relY += (CLAW.hold - held.relY) * .2; held.settle--; }
      const load = (Math.abs(claw.ay) + Math.abs(claw.ax)) / GRAVITY * .4 + Math.abs(claw.swingV) * .12;
      const need = (DOLL_WEIGHT[held.type] ?? 1) * (1 + load + held.bump) + (bottom - claw.y < 40 ? buried : 0);
      const hold = 2.5 * power * quality;
      slip = need > hold ? slip + (need - hold) * 5 * DT : Math.max(0, slip - .6 * DT);
      held.bump = 0;
      if (slip >= 1) release();
    }
    if (stepping) {
      const pusher = held && { ...heldPosition(), radius: held.radius, vx: claw.vx - claw.swingV * CLAW.hold, vy: claw.vy };
      const { captured, pushed } = stepBodies(bodies, DT, { chute: true, pusher });
      if (held) held.bump = pushed / held.radius * .5;
      for (const d of captured) { prizes.push(d.id); chute.push({ ...dollOf(d), vx: d.vx, vy: d.vy }); }
      for (let i = chute.length - 1; i >= 0; i--) {
        const d = chute[i];
        d.vy += GRAVITY * DT; d.y += d.vy * DT; d.vx *= .9;
        d.x = clamp(d.x + d.vx * DT, d.radius, DIVIDER_X - CORNER - d.radius);
        if (d.y > height - 40) chute.splice(i, 1);
      }
    }
    snapshot();
  }

  snapshot();
  while (claw.y < bottom) { claw.y = Math.min(bottom, claw.y + CLAW.descend * DT); snapshot(); }

  phase = 'close';
  for (let frame = 1; frame <= 15; frame++) {
    claw.closed = frame / 15;
    if (frame === 8) {
      const target = plan.target && bodies.find(d => d.id === plan.target.id);
      quality = gripQuality(plan.target, x, bottom);
      stepping = true;
      if (quality > 0) {
        bodies.splice(bodies.indexOf(target!), 1);
        held = { ...dollOf(target!), relX: target!.x - claw.x, relY: target!.y - claw.y, settle: 12, bump: 0 };
        // Whatever rested on or beside the target may now be unsupported; the rest of
        // the pile stays asleep exactly where it was.
        for (const d of bodies) {
          const dx = d.x - target!.x, dy = d.y - target!.y, near = target!.radius + d.radius + MAX_RADIUS;
          if (dx * dx + dy * dy < near * near) wake(d);
        }
        // Dolls resting on the target's shoulders make the first pull heavier.
        for (const d of bodies) {
          const dx = d.x - target!.x, dy = d.y - target!.y, sum = d.radius + target!.radius + 2;
          if (dy < -8 && dx * dx + dy * dy < sum * sum) buried += .35 * (DOLL_WEIGHT[d.type] ?? 1);
        }
      } else {
        // The closing prongs drag a doll under them toward the middle instead.
        const reach = CLAW.prong + MACHINE.radius, tip = bottom + CLAW.tip + 4;
        const victim = bodies.filter(d => Math.abs(d.x - claw.x) < reach && d.y - d.radius < tip)
          .sort((a, b) => Math.abs(a.x - claw.x) - Math.abs(b.x - claw.x) || a.y - b.y || byId(a, b))[0];
        if (victim && Math.abs(victim.x - claw.x) > 4) {
          wake(victim);
          victim.vx += (victim.x > claw.x ? -1 : 1) * 110; victim.vy -= 60;
        }
      }
    }
    tick();
  }

  phase = 'lift';
  for (;;) {
    const state = drive(claw.y, claw.vy, CLAW.top, CLAW.lift);
    claw.y = state.position; claw.vy = state.velocity; claw.ay = state.accel;
    tick();
    if (state.done) break;
  }
  claw.vy = 0; claw.ay = 0;

  // Reaching the top, a weak claw drops to its carry power — the classic "툭".
  phase = 'carry'; power = carry;
  for (let frame = 0; frame < 12; frame++) tick();
  const homeX = MACHINE.home * width;
  for (;;) {
    const state = drive(claw.x, claw.vx, homeX, CLAW.travel);
    claw.x = state.position; claw.vx = state.velocity; claw.ax = state.accel;
    tick();
    if (state.done) break;
  }
  claw.vx = 0; claw.ax = 0;

  phase = 'release';
  for (let frame = 1; frame <= 10; frame++) {
    claw.closed = 1 - frame / 10;
    if (frame === 3 && held) release();
    tick();
  }

  // Let everything come to rest, including anything still rolling toward the chute.
  phase = 'settle';
  for (let frame = 0; frame < 360 && (!asleep(bodies) || chute.length); frame++) tick();

  const original = new Map(board.map(d => [d.id, d]));
  const won = prizes.map(id => { const { vx, vy, ...d } = original.get(id)!; return d; });
  const reason = won.length ? 'caught' : !quality ? 'miss' : (released as ReleasedDoll | null)?.phase === 'lift' || (released as ReleasedDoll | null)?.phase === 'close' ? 'lift-drop' : 'travel-drop';
  return { target: plan.target, bottom, quality, prizes: won, released,
    reason, board: toBoard(bodies), frames };
}
