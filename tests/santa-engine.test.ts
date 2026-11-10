import { describe, expect, it } from 'vitest';
import { SANTA_RULES, santaDeadline, santaHalf, santaOpen, santaSlot, santaSlotStart } from '../shared/balance';
import { HIT_TOLERANCE, RIM_TOLERANCE, SANTA_WORLD, chimneyX, fallMs, idealRelease, judgeDrop, santaCourse, validRelease } from '../shared/santa-engine';

const at = (kst: string) => Date.parse(`${kst}+09:00`);

describe('santa half-day slots', () => {
  it('splits the KST day at midnight and noon', () => {
    const morning = santaSlot(at('2026-12-01T00:00:00'));
    expect(santaSlot(at('2026-12-01T11:59:59'))).toBe(morning);
    expect(santaSlot(at('2026-12-01T12:00:00'))).toBe(morning + 1);
    expect(santaSlot(at('2026-12-01T23:59:59'))).toBe(morning + 1);
    expect(santaSlot(at('2026-12-02T00:00:00'))).toBe(morning + 2);
    expect(santaSlotStart(morning)).toBe(at('2026-12-01T00:00:00'));
    expect(santaSlotStart(morning + 1)).toBe(at('2026-12-01T12:00:00'));
    expect(santaHalf(morning)).toBe('오전');
    expect(santaHalf(morning + 1)).toBe('오후');
    expect(santaDeadline(morning)).toBe(at('2026-12-01T12:10:00'));
  });

  it('takes new runs until the end of Christmas Day', () => {
    expect(santaOpen(at('2026-11-10T09:00:00'))).toBe(true);
    expect(santaOpen(at('2026-12-25T23:59:59'))).toBe(true);
    expect(santaOpen(at('2026-12-26T00:00:00'))).toBe(false);
    expect(SANTA_RULES.endsAt).toBe(at('2026-12-26T00:00:00'));
  });
});

describe('santa course', () => {
  it('is the same for everyone in a slot and different between slots', () => {
    const slot = santaSlot(at('2026-12-01T09:00:00'));
    expect(santaCourse(slot)).toEqual(santaCourse(slot));
    expect(santaCourse(slot).map(house => house.level)).not.toEqual(santaCourse(slot + 1).map(house => house.level));
  });

  it('uses every height twice, never the same height twice in a row, and speeds up', () => {
    for (let slot = 40_000; slot < 40_200; slot++) {
      const course = santaCourse(slot);
      expect(course).toHaveLength(10);
      const levels = course.map(house => house.level);
      for (let level = 0; level < SANTA_WORLD.tops.length; level++) expect(levels.filter(value => value === level)).toHaveLength(2);
      levels.forEach((level, i) => { if (i) expect(level).not.toBe(levels[i - 1]); });
      course.forEach((house, i) => { if (i) expect(house.speed).toBeGreaterThan(course[i - 1]!.speed); });
    }
    const course = santaCourse(40_000);
    expect(course[9]!.speed / course[0]!.speed).toBeCloseTo(1 + SANTA_WORLD.speedUp, 10);
  });
});

describe('santa drops', () => {
  const course = santaCourse(41_000);

  it('drops the gift in at the ideal release, a different time for every height', () => {
    for (const house of course) expect(judgeDrop(house, idealRelease(house))).toMatchObject({ kind: 'in', hit: true });
    const byLevel = new Map(course.map(house => [house.level, house]));
    const lowest = byLevel.get(0)!, tallest = byLevel.get(4)!;
    // A tall chimney is reached sooner, so its gift goes later (relative to the same chimney position).
    expect(fallMs(tallest)).toBeLessThan(fallMs(lowest));
    // Dropping a low chimney's gift at a tall chimney's lead misses.
    const leadOfTallest = (SANTA_WORLD.startX - SANTA_WORLD.sleighX) / lowest.speed - fallMs(tallest);
    expect(judgeDrop(lowest, Math.round(leadOfTallest)).hit).toBe(false);
  });

  it('explains misses: too early or late, on the rim or clean past', () => {
    const house = course[0]!, ideal = idealRelease(house);
    const ms = (px: number) => Math.ceil(px / house.speed) + 2;
    expect(judgeDrop(house, ideal - ms(HIT_TOLERANCE)).kind).toBe('rim-early');
    expect(judgeDrop(house, ideal + ms(HIT_TOLERANCE)).kind).toBe('rim-late');
    expect(judgeDrop(house, ideal - ms(RIM_TOLERANCE)).kind).toBe('early');
    expect(judgeDrop(house, ideal + ms(RIM_TOLERANCE)).kind).toBe('late');
    expect(judgeDrop(house, -1)).toMatchObject({ kind: 'pass', hit: false });
    // dx is the chimney centre relative to the gift when it reaches the chimney top.
    const early = judgeDrop(house, 0);
    expect(early.dx).toBeCloseTo(chimneyX(house, early.fallMs) - SANTA_WORLD.sleighX, 9);
  });

  it('accepts release times within the approach only', () => {
    const house = course[3]!;
    expect(validRelease(house, -1)).toBe(true);
    expect(validRelease(house, 0)).toBe(true);
    expect(validRelease(house, house.approachMs)).toBe(true);
    expect(validRelease(house, house.approachMs + 1)).toBe(false);
    expect(validRelease(house, -2)).toBe(false);
    expect(validRelease(house, 12.5)).toBe(false);
  });

  it('keeps a hit window of roughly ±60–70 ms', () => {
    for (const house of course) {
      const ideal = idealRelease(house);
      let low = ideal, high = ideal;
      while (judgeDrop(house, low - 1).hit) low--;
      while (judgeDrop(house, high + 1).hit) high++;
      expect((high - low) / 2).toBeGreaterThanOrEqual(58);
      expect((high - low) / 2).toBeLessThanOrEqual(74);
    }
  });

  it('keeps every result for a fixed course (bump SANTA_RULES.engine when this changes)', () => {
    const fingerprint = course.map(house => [house.level, house.approachMs, idealRelease(house), judgeDrop(house, 1300).kind].join(':')).join(' ');
    expect(fingerprint).toMatchInlineSnapshot(`"2:3058:1529:rim-early 0:3008:1410:rim-early 3:2960:1516:rim-early 1:2913:1390:rim-early 0:2867:1319:in 4:2823:1486:rim-early 2:2780:1350:in 4:2739:1431:rim-early 3:2698:1347:in 1:2659:1226:rim-late"`);
  });
});
