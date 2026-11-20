import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { BACK_LINE, CURLING_ZONES, MAX_FRAMES, SHEET, SWEEP, inHouse, sheetPoints, stonePoints, simulateEnd, simulateThrow, slideDistance, startThrow, validStone, validSweep } from '../shared/curling-physics';

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

  it('carries a swept stone further: about a metre at draw weight, and nothing for a stone that has stopped', () => {
    const plain = simulateThrow([], { power: 45, aim: 0 }, 0);
    const swept = simulateThrow([], { power: 45, aim: 0, sweep: [0, MAX_FRAMES] }, 0);
    const gain = swept.after[0]!.y - plain.after[0]!.y;
    expect(gain).toBeGreaterThan(0.6); expect(gain).toBeLessThan(1.1);
    // A weak throw that would have been a guard is brought into the house.
    expect(simulateThrow([], { power: 40, aim: 0 }, 0).kind).toBe('guard');
    expect(simulateThrow([], { power: 40, aim: 0, sweep: [0, MAX_FRAMES] }, 0).kind).toBe('house');
    // Brushing for part of the slide helps less, and sooner helps more than later.
    const early = simulateThrow([], { power: 45, aim: 0, sweep: [0, 60] }, 0).after[0]!.y, late = simulateThrow([], { power: 45, aim: 0, sweep: [120, 180] }, 0).after[0]!.y;
    expect(early).toBeGreaterThan(late); expect(late).toBeGreaterThan(plain.after[0]!.y); expect(early).toBeLessThan(swept.after[0]!.y);
    // It never makes a stone shorter, and brushing after everything has stopped changes nothing.
    expect(simulateThrow([], { power: 45, aim: 0, sweep: [500, 560] }, 0).after).toEqual(plain.after);
    // The stored input keeps only the frames that were really brushed.
    expect(swept.input.sweep![0]).toBe(0);
    expect(swept.input.sweep![1]).toBeGreaterThanOrEqual(swept.frames.length - 1);
    expect(swept.input.sweep![1]).toBeLessThanOrEqual(swept.frames.length);
    expect(simulateThrow([], { power: 45, aim: 0, sweep: [500, 560] }, 0).input.sweep).toBeUndefined();
    expect(SWEEP.ease).toBeGreaterThan(0);
  });

  it('gives the same throw whether it is played frame by frame or simulated from its stored sweeping', () => {
    const guard = simulateThrow([], { power: 38, aim: 0 }, 0);
    const run = startThrow(guard.after, { power: 50, aim: 8 }, 1);
    // Brush in bursts, as a finger would.
    while (!run.done) run.advance(run.frame % 50 < 20 && run.frame > 10);
    const live = run.result();
    expect(live.input.sweep!.length).toBeGreaterThan(2);
    expect(validStone(live.input)).toBe(true);
    const again = simulateThrow(guard.after, live.input, 1);
    expect(JSON.stringify(again)).toBe(JSON.stringify(live));
    // Only the thrown stone is helped: a struck stone slides on ordinary ice.
    const hit = simulateThrow(guard.after, { power: 55, aim: 0 }, 1), hitSwept = simulateThrow(guard.after, { power: 55, aim: 0, sweep: [200, MAX_FRAMES] }, 1);
    expect(hit.hits).toBe(1);
    expect(hitSwept.after.find(stone => stone.id === 0)!.y).toBeCloseTo(hit.after.find(stone => stone.id === 0)!.y, 1);
    // No more ranges are taken than can be stored.
    const busy = startThrow([], { power: 100, aim: 0 }, 0);
    while (!busy.done) busy.advance(busy.frame % 2 === 0);
    expect(busy.result().input.sweep!.length).toBeLessThanOrEqual(SWEEP.maxRanges * 2);
    expect(validSweep(busy.result().input.sweep)).toBe(true);
  });

  it('accepts sweeping only as ordered whole-frame ranges', () => {
    expect(validSweep([])).toBe(true);
    expect(validSweep([0, 10, 12, 40])).toBe(true);
    for (const bad of [[5], [10, 10], [10, 5], [0, 10, 10, 20], [0, 10, 5, 20], [-1, 4], [0, 1.5], [0, MAX_FRAMES + 1], Array.from({ length: SWEEP.maxRanges * 2 + 2 }, (_, i) => i * 2), '0,10', null]) expect(validSweep(bad), JSON.stringify(bad)).toBe(false);
    expect(validStone({ power: 50, aim: 0, sweep: [0, 10] })).toBe(true);
    expect(validStone({ power: 50, aim: 0, sweep: [10, 0] })).toBe(false);
  });

  it('accepts only whole numbers in range', () => {
    expect(validStone({ power: 0, aim: -100 })).toBe(true);
    expect(validStone({ power: 100, aim: 100 })).toBe(true);
    for (const bad of [{ power: 101, aim: 0 }, { power: -1, aim: 0 }, { power: 50, aim: 101 }, { power: 50.5, aim: 0 }, { power: '50', aim: 0 }, { power: 50 }, null, 7]) expect(validStone(bad)).toBe(false);
  });

  it('scores a stone by how close to the centre it lies: 10, 8, 6, 4, 2, 1, then nothing', () => {
    const [red, white, blue] = [SHEET.rings[2], SHEET.rings[1], SHEET.rings[0]], r = SHEET.stoneRadius;
    const at = (gap: number) => stonePoints({ x: 0, y: SHEET.tee + gap });
    // Inside a circle means the stone's centre is in it; touching means only its edge reaches it.
    expect([0, red, red + 0.01, red + r, red + r + 0.01, white, white + 0.01, white + r, white + r + 0.01, blue, blue + 0.01, blue + r - 0.001, blue + r + 0.01].map(at))
      .toEqual([10, 10, 8, 8, 6, 6, 4, 4, 2, 2, 1, 1, 0]);
    // The same in every direction, and never more for being farther out.
    expect(stonePoints({ x: red + 0.01, y: SHEET.tee })).toBe(8);
    expect(stonePoints({ x: -0.5, y: SHEET.tee - 0.5 })).toBe(at(Math.sqrt(0.5)));
    for (let gap = 0, last = 10; gap < 2; gap += 0.01) { const now = at(gap); expect(now).toBeLessThanOrEqual(last); last = now; }
    expect(CURLING_ZONES.map(zone => zone.points)).toEqual([10, 8, 6, 4, 2, 1]);
    // A stone is in the house exactly when it scores.
    for (let gap = 0; gap < 2; gap += 0.013) expect(at(gap) > 0).toBe(inHouse({ x: 0, y: SHEET.tee + gap }));
  });

  it('adds up an end from where each stone lies when the last one has stopped', () => {
    const end = simulateEnd([{ power: 55, aim: 0 }, { power: 100, aim: 70 }, { power: 52, aim: -45 }, { power: 40, aim: 0 }, { power: 100, aim: -70 }]);
    expect(end.points[0]).toBe(10);
    expect(end.points[1]).toBe(0);
    expect(end.counted).toEqual(end.points.map(value => value > 0));
    expect(end.total).toBe(end.points.reduce((sum, value) => sum + value, 0));
    expect(end.total).toBe(sheetPoints(end.throws[end.throws.length - 1]!.after));
    // A stone knocked out of the middle afterwards is scored where it ends up, not where it first stopped.
    const bumped = simulateEnd([{ power: 55, aim: 0 }, { power: 75, aim: 0 }]);
    expect(stonePoints(bumped.throws[0]!.after[0]!)).toBe(10);
    expect(bumped.points[0]).toBeLessThan(10);
  });

  it('stays cheap enough for a Worker request', () => {
    const started = performance.now();
    for (let i = 0; i < 50; i++) simulateEnd([{ power: 55, aim: 0 }, { power: 70, aim: 0 }, { power: 60, aim: 5 }, { power: 80, aim: -3 }, { power: 58, aim: 2 }]);
    expect((performance.now() - started) / 50).toBeLessThan(10);
  });
});
