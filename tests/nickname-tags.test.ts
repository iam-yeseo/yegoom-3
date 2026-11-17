import { describe, expect, it } from 'vitest';
import { TAG_GRADES, TAG_POOLS, TAG_TEXTS, drawNicknameTag, evolutionChance, gradeLabel, nextTagGrade } from '../shared/nickname-tags';
import { TAG_EVOLUTION_RULES, nextPredictionOpenAt, predictionDayOff } from '../shared/balance';

/** A scripted RNG: the first value is the grade roll (0–99), the second picks the phrase. */
const scripted = (...values: number[]) => (max: number) => {
  const value = values.shift();
  if (value === undefined || value < 0 || value >= max) throw new Error(`unexpected roll ${value} for ${max}`);
  return value;
};

describe('nickname tags', () => {
  it('keeps the original odds: S 5 · A 20 · B 30 · C 45', () => {
    expect(TAG_GRADES.map(grade => [grade.grade, grade.chance])).toEqual([['S', 5], ['A', 20], ['B', 30], ['C', 45]]);
    expect(TAG_GRADES.reduce((sum, grade) => sum + grade.chance, 0)).toBe(100);
    const gradeAt = (roll: number) => drawNicknameTag(scripted(roll, 0)).grade;
    expect([0, 4, 5, 24, 25, 54, 55, 99].map(gradeAt)).toEqual(['S', 'S', 'A', 'A', 'B', 'B', 'C', 'C']);
  });
  it('draws S only from S phrases, A from everything but S, B from B and C, C only from C', () => {
    expect(TAG_POOLS.S).toEqual(TAG_TEXTS.S);
    expect(TAG_POOLS.A).toEqual([...TAG_TEXTS.A, ...TAG_TEXTS.B, ...TAG_TEXTS.C]);
    expect(TAG_POOLS.B).toEqual([...TAG_TEXTS.B, ...TAG_TEXTS.C]);
    expect(TAG_POOLS.C).toEqual(TAG_TEXTS.C);
    expect(TAG_POOLS.A.some(text => (TAG_TEXTS.S as readonly string[]).includes(text))).toBe(false);
    // The phrase index is uniform over the chosen pool.
    expect(drawNicknameTag(scripted(10, TAG_POOLS.A.length - 1))).toEqual({ grade: 'A', text: TAG_TEXTS.C.at(-1) });
    expect(drawNicknameTag(scripted(2, 0))).toEqual({ grade: 'S', text: TAG_TEXTS.S[0] });
  });
  it('has no phrase in two grades and no blank phrase', () => {
    const all = [...TAG_TEXTS.S, ...TAG_TEXTS.A, ...TAG_TEXTS.B, ...TAG_TEXTS.C];
    expect(new Set(all).size).toBe(all.length);
    expect(all.every(text => text.trim() === text && text.length > 0)).toBe(true);
  });
  it('labels each grade with its look', () => {
    expect(['S', 'A', 'B', 'C'].map(grade => gradeLabel(grade as 'S'))).toEqual(['S등급 · 홀로그램', 'A등급 · 금빛', 'B등급 · 은빛', 'C등급 · 테두리']);
  });
  it('lands near the stated odds over many unbiased draws', () => {
    const counts = { S: 0, A: 0, B: 0, C: 0 };
    let seed = 7;
    const lcg = (max: number) => { seed = (seed * 1103515245 + 12345) % 2147483648; return Math.floor(seed / 2147483648 * max); };
    for (let index = 0; index < 20000; index++) counts[drawNicknameTag(lcg).grade]++;
    expect(counts.S / 20000).toBeCloseTo(0.05, 1);
    expect(counts.A / 20000).toBeCloseTo(0.20, 1);
    expect(counts.B / 20000).toBeCloseTo(0.30, 1);
    expect(counts.C / 20000).toBeCloseTo(0.45, 1);
  });
  it('evolves C → B → A → S and never past S', () => {
    expect((['C', 'B', 'A', 'S'] as const).map(nextTagGrade)).toEqual(['B', 'A', 'S', null]);
    expect(evolutionChance('S', 'S', TAG_EVOLUTION_RULES)).toBeNull();
  });
  it('uses 30/15/5% by target grade plus 3% per grade step between the two tags (at most 6%)', () => {
    const total = (base: 'A' | 'B' | 'C', material: 'S' | 'A' | 'B' | 'C') => evolutionChance(base, material, TAG_EVOLUTION_RULES)!.total;
    expect([total('C', 'C'), total('B', 'B'), total('A', 'A')]).toEqual([30, 15, 5]);
    expect([total('C', 'B'), total('B', 'C'), total('B', 'A'), total('A', 'B'), total('A', 'S')]).toEqual([33, 18, 18, 8, 8]);
    expect([total('C', 'A'), total('A', 'C'), total('B', 'S')]).toEqual([36, 11, 21]);
    // Three steps apart is capped at the two-step bonus.
    expect(total('C', 'S')).toBe(36);
    expect(TAG_EVOLUTION_RULES).toMatchObject({ dailyFree: 3, price: 100, loseOnFailPercent: 50 });
  });
});

describe('prediction rest days', () => {
  it('rests on Saturday and Sunday (KST dates) only', () => {
    expect(['2026-11-16', '2026-11-17', '2026-11-20', '2026-11-21', '2026-11-22', '2026-11-23'].map(predictionDayOff))
      .toEqual([false, false, false, true, true, false]);
  });
  it('reopens at 00:00 KST on the next Monday', () => {
    const monday = Date.parse('2026-11-23T00:00:00+09:00');
    expect(nextPredictionOpenAt('2026-11-21')).toBe(monday);
    expect(nextPredictionOpenAt('2026-11-22')).toBe(monday);
  });
});
