import { describe, expect, it } from 'vitest';
import { GESTURE, holdOffset, readGesture, type GesturePoint } from '../src/freethrow/gesture';

/** A pull-down wind-up followed by an upward flick at `speed` stage heights per
 * second, sampled every `interval` ms, leaning `slope` sideways per unit up. */
function swipe({ speed, slope = 0, interval = 16, pull = 0.12, flickMs = 160, release = 4 }: { speed: number; slope?: number; interval?: number; pull?: number; flickMs?: number; release?: number | null }) {
  const points: GesturePoint[] = [];
  let t = 1000;
  for (let i = 0; i <= 6; i++) points.push({ x: 0.5, y: 0.7 + (pull * i) / 6, t: (t += interval) });
  const base = points[points.length - 1]!;
  const start = base.t;
  for (let elapsed = interval; elapsed <= flickMs; elapsed += interval) {
    const rise = (speed * elapsed) / 1000;
    points.push({ x: base.x + slope * rise, y: base.y - rise, t: start + elapsed });
  }
  if (release !== null) { const last = points[points.length - 1]!; points.push({ ...last, t: last.t + release }); }
  return points;
}

describe('free-throw gesture', () => {
  it('turns flick speed into proportional power', () => {
    const power = (speed: number) => readGesture(swipe({ speed })).shot?.power;
    expect(power(2.2)).toBe(50);
    expect(power(4.4)).toBe(100);
    expect(power(1.1)).toBe(25);
    expect(power(9)).toBe(100);
  });

  it('ignores the pull-down: only the final upward motion counts', () => {
    const shallow = readGesture(swipe({ speed: 2.5, pull: 0.03 })).shot;
    const deep = readGesture(swipe({ speed: 2.5, pull: 0.2 })).shot;
    expect(shallow).toEqual(deep);
  });

  it('gives the same shot on 60 Hz and 120 Hz screens', () => {
    const slow = readGesture(swipe({ speed: 2.6, slope: 0.1, interval: 16.7 })).shot!;
    const fast = readGesture(swipe({ speed: 2.6, slope: 0.1, interval: 8.3 })).shot!;
    expect(Math.abs(slow.power - fast.power)).toBeLessThanOrEqual(1);
    expect(Math.abs(slow.aim - fast.aim)).toBeLessThanOrEqual(1);
  });

  it('does not treat the release event repeating the last position as a stop', () => {
    const withRelease = readGesture(swipe({ speed: 2.4, release: 6 })).shot;
    const without = readGesture(swipe({ speed: 2.4, release: null })).shot;
    expect(withRelease).toEqual(without);
  });

  it('softens a flick that stopped before letting go', () => {
    const paused = readGesture(swipe({ speed: 2.4, release: GESTURE.windowMs + 40 }));
    expect(paused.shot).toBeNull();
    if (!paused.shot) expect(paused.reason).toBe('too-slow');
  });

  it('leans the aim with the swipe and clamps it', () => {
    expect(readGesture(swipe({ speed: 2.4, slope: 0 })).shot!.aim).toBe(0);
    expect(readGesture(swipe({ speed: 2.4, slope: 0.2 })).shot!.aim).toBe(25);
    expect(readGesture(swipe({ speed: 2.4, slope: -0.2 })).shot!.aim).toBe(-25);
    expect(readGesture(swipe({ speed: 2.4, slope: 3 })).shot!.aim).toBe(100);
  });

  it('puts the ball back for taps, short nudges and downward releases', () => {
    expect(readGesture([{ x: 0.5, y: 0.7, t: 0 }])).toEqual({ shot: null, reason: 'too-short' });
    expect(readGesture(swipe({ speed: 2.4, flickMs: 16 })).shot).toBeNull();
    const down: GesturePoint[] = [{ x: 0.5, y: 0.8, t: 0 }, { x: 0.5, y: 0.6, t: 200 }, { x: 0.5, y: 0.66, t: 300 }];
    expect(readGesture(down)).toEqual({ shot: null, reason: 'downward' });
  });

  it('keeps the held ball within reach of the finger', () => {
    const start = { x: 0.5, y: 0.7, t: 0 };
    const held = holdOffset(start, { x: 0.6, y: 0.8, t: 1 });
    expect(held.x).toBeCloseTo(0.05, 9); expect(held.y).toBeCloseTo(0.1, 9);
    expect(holdOffset(start, { x: 1.5, y: 2, t: 1 })).toEqual({ x: GESTURE.pullSide, y: GESTURE.pullDown });
    expect(holdOffset(start, { x: -1, y: -1, t: 1 })).toEqual({ x: -GESTURE.pullSide, y: -GESTURE.pullUp });
  });
});
