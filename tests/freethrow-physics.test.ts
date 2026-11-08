import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { clampShot, simulateShot, validShot, type ShotResult } from '../shared/freethrow-physics';

const fingerprint = () => {
  const hash = createHash('sha256');
  for (let power = 0; power <= 100; power += 3) for (let aim = -100; aim <= 100; aim += 9) {
    const shot = simulateShot({ power, aim });
    hash.update(`${power},${aim}:${shot.kind}:${shot.rimHits}:${shot.boardHits}:${shot.frames.length}:${JSON.stringify(shot.frames[shot.frames.length - 1])};`);
  }
  return hash.digest('hex');
};

describe('free-throw physics', () => {
  it('gives the same shot for the same input', () => {
    for (const input of [{ power: 0, aim: 0 }, { power: 54, aim: 7 }, { power: 77, aim: -20 }, { power: 100, aim: 100 }]) {
      expect(JSON.stringify(simulateShot(input))).toBe(JSON.stringify(simulateShot({ ...input })));
    }
  });

  it('keeps every outcome stable (update this hash only when the court is retuned on purpose)', () => {
    // Step 2 re-simulates official shots on the server; a silent change here
    // would make the browser and the Worker disagree about recorded sets.
    expect(fingerprint()).toBe(FINGERPRINT);
  });

  it('reads like a real free throw at aim 0: short, then a scoring band, then long', () => {
    const at = (power: number) => simulateShot({ power, aim: 0 });
    for (let power = 0; power <= 33; power++) expect(at(power).kind).toBe('short');
    for (let power = 52; power <= 60; power++) expect(at(power).made, `power ${power}`).toBe(true);
    expect(at(53).kind).toBe('swish');
    for (let power = 85; power <= 100; power++) expect(at(power).kind).toBe('board-out');
    // Below the band the ball meets the front of the rim; above it, the back or the glass.
    for (let power = 34; power <= 45; power++) expect(at(power).firstRim).toBe('front');
    for (let power = 61; power <= 70; power++) expect(at(power).made || at(power).firstRim === 'back' || at(power).firstContact === 'board').toBe(true);
  });

  it('misses to the side the swipe leaned', () => {
    for (const power of [45, 55, 65]) {
      const left = simulateShot({ power, aim: -100 }), right = simulateShot({ power, aim: 100 });
      expect(left.made).toBe(false); expect(right.made).toBe(false);
      expect(left.frames.at(-1)!.x).toBeLessThan(0); expect(right.frames.at(-1)!.x).toBeGreaterThan(0);
    }
    expect(simulateShot({ power: 55, aim: -100 }).kind).toBe('left');
    expect(simulateShot({ power: 55, aim: 100 }).kind).toBe('right');
  });

  it('mirrors left and right exactly', () => {
    for (const [power, aim] of [[50, 12], [57, 30], [72, 8], [40, 60]] as const) {
      const a = simulateShot({ power, aim }), b = simulateShot({ power, aim: -aim });
      expect(a.made).toBe(b.made);
      expect(a.frames.length).toBe(b.frames.length);
      a.frames.forEach((frame, i) => { expect(frame.x).toBeCloseTo(-b.frames[i]!.x, 9); expect(frame.y).toBeCloseTo(b.frames[i]!.y, 9); });
    }
  });

  it('records the moment and order of contacts', () => {
    const made: ShotResult = simulateShot({ power: 57, aim: 0 });
    expect(made.madeAt).toBeGreaterThan(0.6);
    expect(made.events.map(event => event.type)).toContain('net');
    expect(made.events.every((event, i, all) => i === 0 || all[i - 1]!.t <= event.t)).toBe(true);
    const bank = simulateShot({ power: 75, aim: 0 });
    expect(bank.kind).toBe('bank');
    expect(bank.events[0]!.type).toBe('board');
  });

  it('accepts only whole numbers in range and clamps loose input', () => {
    expect(validShot({ power: 50, aim: -3 })).toBe(true);
    for (const bad of [null, {}, { power: 50.5, aim: 0 }, { power: 101, aim: 0 }, { power: 0, aim: -101 }, { power: '50', aim: 0 }]) expect(validShot(bad)).toBe(false);
    expect(clampShot({ power: 120.4, aim: -300 })).toEqual({ power: 100, aim: -100 });
    expect(clampShot({ power: Number.NaN, aim: 4.6 })).toEqual({ power: 0, aim: 5 });
  });

  it('stays cheap enough to re-run on the Worker', () => {
    let longest = 0;
    const started = performance.now();
    for (let i = 0; i < 1000; i++) {
      const before = performance.now();
      simulateShot({ power: (i * 37) % 101, aim: ((i * 53) % 201) - 100 });
      longest = Math.max(longest, performance.now() - before);
    }
    expect((performance.now() - started) / 1000).toBeLessThan(1);
    expect(longest).toBeLessThan(20);
  });
});
const FINGERPRINT = '52a5b593b09275213f04764e010ff7f4e13dc86c913ddf3c1e0b65a054a0f19e';
