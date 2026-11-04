import { describe, expect, it } from 'vitest';
import { TAG_GRADES, TAG_POOLS, TAG_TEXTS, drawNicknameTag, gradeLabel } from '../shared/nickname-tags';

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
});
