import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { BACK_LINE, SHEET, inHouse, simulateEnd, simulateThrow, slideDistance, validStone } from '../shared/curling-physics';

const FINGERPRINT = '2f0ced8c41ca1432a25c49320e7d441054c3d6a36d732941ae4e00e0a6468a12';
const fingerprint = () => {
  const hash = createHash('sha256');
  for (let power = 0; power <= 100; power += 4) for (let aim = -100; aim <= 100; aim += 10) {
    const end = simulateEnd([{ power: 55, aim: 0 }, { power: 40, aim: 12 }, { power, aim }]);
    hash.update(`${power},${aim}:${end.throws.map(result => `${result.kind}${result.hits}${result.frames.length}`).join('|')}:${JSON.stringify(end.throws[2]!.after)};`);
  }
  return hash.digest('hex');
};

describe('curling physics', () => {
  it('gives the same end for the same throws', () => {
    const inputs = [{ power: 55, aim: 0 }, { power: 70, aim: 0 }, { power: 48, aim: -20 }, { power: 62, aim: 15 }, { power: 100, aim: 100 }];
    expect(JSON.stringify(simulateEnd(inputs))).toBe(JSON.stringify(simulateEnd(inputs.map(input => ({ ...input })))));
  });

  it('keeps every outcome stable (update this hash only when the sheet is retuned on purpose)', () => {
    // The Worker simulates recorded ends again; a silent change here would make
    // the browser and the Worker disagree. Bump ARCADE_RULES.curling.engine with it.
    expect(fingerprint()).toBe(FINGERPRINT);
  });

  it('reads like a draw at aim 0: short of the hog line, a guard, the house, then through the back', () => {
    const at = (power: number) => simulateThrow([], { power, aim: 0 }, 0);
    for (let power = 0; power <= 31; power++) expect(at(power).kind, `power ${power}`).toBe('short');
    for (let power = 34; power <= 44; power++) expect(at(power).kind, `power ${power}`).toBe('guard');
    for (let power = 45; power <= 65; power++) expect(['house', 'button'], `power ${power}`).toContain(at(power).kind);
    expect(at(55).kind).toBe('button');
    for (let power = 67; power <= 100; power++) expect(at(power).kind, `power ${power}`).toBe('long');
    // A free stone stops where the power says: the tee at 55, each point 12 cm.
    expect(at(55).after[0]!.y).toBeCloseTo(SHEET.tee, 1);
    expect(at(60).after[0]!.y).toBeCloseTo(slideDistance(60), 1);
    expect(at(60).after[0]!.y - at(50).after[0]!.y).toBeCloseTo(1.2, 1);
    expect(at(100).after).toEqual([]);
  });

  it('follows the chosen direction and mirrors left and right exactly', () => {
    const left = simulateThrow([], { power: 55, aim: -40 }, 0), right = simulateThrow([], { power: 55, aim: 40 }, 0);
    expect(left.after[0]!.x).toBeLessThan(0);
    expect(right.after[0]!.x).toBeCloseTo(-left.after[0]!.x, 9);
    expect(right.after[0]!.y).toBeCloseTo(left.after[0]!.y, 9);
    // Full aim at draw weight ends beside the house, not in it.
    expect(simulateThrow([], { power: 55, aim: 100 }, 0).kind).toBe('wide');
    // Even at full aim a free stone passes the back line before it reaches a wall.
    expect(simulateThrow([], { power: 100, aim: 100 }, 0).kind).toBe('long');
  });

  it('leaves stones on the sheet: a guard blocks, and a hit moves both stones', () => {
    const guard = simulateThrow([], { power: 38, aim: 0 }, 0);
    expect(guard.kind).toBe('guard');
    const blocked = simulateThrow(guard.after, { power: 55, aim: 0 }, 1);
    expect(blocked.hits).toBe(1);
    expect(blocked.events.some(event => event.type === 'hit')).toBe(true);
    // The moving stone gives most of its speed away: the guard is driven on, the shooter stays short.
    const first = blocked.after.find(stone => stone.id === 0)!, second = blocked.after.find(stone => stone.id === 1)!;
    expect(first.y).toBeGreaterThan(guard.after[0]!.y + 0.5);
    expect(second.y).toBeLessThan(first.y);
    // Around the guard the way is open.
    expect(simulateThrow(guard.after, { power: 55, aim: 60 }, 1).hits).toBe(0);
  });

  it('counts the stones lying in the house when the end is over, not when they were thrown', () => {
    // A stone on the button, then a heavy one straight at it: the first is driven out the back.
    const end = simulateEnd([{ power: 55, aim: 0 }, { power: 90, aim: 0 }]);
    expect(end.throws[0]!.kind).toBe('button');
    expect(end.throws[1]!.knocked).toBe(1);
    expect(end.counted[0]).toBe(false);
    expect(end.score).toBe(end.counted.filter(Boolean).length);
    const spread = simulateEnd([{ power: 55, aim: 0 }, { power: 52, aim: -45 }, { power: 52, aim: 45 }, { power: 60, aim: -20 }, { power: 60, aim: 20 }]);
    expect(spread.score).toBe(5);
    expect(spread.throws.at(-1)!.after.every(inHouse)).toBe(true);
  });

  it('takes stones off at the back line and the side walls, and keeps every stone inside the sheet', () => {
    for (const input of [{ power: 100, aim: 0 }, { power: 80, aim: 60 }, { power: 66, aim: -100 }, { power: 47, aim: 100 }]) {
      for (const stone of simulateThrow([], input, 0).after) {
        expect(Math.abs(stone.x)).toBeLessThanOrEqual(SHEET.halfWidth - SHEET.stoneRadius + 1e-9);
        expect(stone.y).toBeLessThanOrEqual(BACK_LINE + SHEET.stoneRadius + 1e-9);
        expect(stone.y).toBeGreaterThanOrEqual(SHEET.hog + SHEET.stoneRadius - 1e-9);
      }
    }
  });

  it('accepts only whole numbers in range', () => {
    expect(validStone({ power: 0, aim: -100 })).toBe(true);
    expect(validStone({ power: 100, aim: 100 })).toBe(true);
    for (const bad of [{ power: 101, aim: 0 }, { power: -1, aim: 0 }, { power: 50, aim: 101 }, { power: 50.5, aim: 0 }, { power: '50', aim: 0 }, { power: 50 }, null, 7]) expect(validStone(bad)).toBe(false);
  });

  it('stays cheap enough for a Worker request', () => {
    const started = performance.now();
    for (let i = 0; i < 50; i++) simulateEnd([{ power: 55, aim: 0 }, { power: 70, aim: 0 }, { power: 60, aim: 5 }, { power: 80, aim: -3 }, { power: 58, aim: 2 }]);
    expect((performance.now() - started) / 50).toBeLessThan(10);
  });
});
