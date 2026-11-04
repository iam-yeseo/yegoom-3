import { describe, expect, it } from 'vitest';
import { SLOT_RULES } from '../shared/balance';
import { slotResult } from '../shared/slot';

describe('slot result generation', () => {
  it.each([0, 6, 7, 99])('uses the exact 7 percent jackpot boundary for roll %i', roll => {
    const calls: number[] = [];
    const result = slotResult(max => { calls.push(max); return max === 100 ? roll : 0; });
    expect(calls[0]).toBe(100);
    expect(result.prize).toBe(roll < 7 ? SLOT_RULES.jackpotPrize : 0);
    if (roll < 7) {
      expect(result.reels).toEqual(['seven', 'seven', 'seven']);
      expect(calls).toEqual([100]);
    } else expect(new Set(result.reels).size).toBeGreaterThan(1);
  });

  it('exhausts all losing symbol choices without a matching triple or unbounded random retries', () => {
    const symbols = SLOT_RULES.symbols;
    const results = new Set<string>();
    let cases = 0;
    for (let first = 0; first < symbols.length; first++) for (let second = 0; second < symbols.length; second++) {
      const finalChoices = symbols.length - (first === second ? 1 : 0);
      for (let last = 0; last < finalChoices; last++) {
        const values = [7, first, second, last];
        const maxima = [100, symbols.length, symbols.length, finalChoices];
        let call = 0;
        const result = slotResult(max => {
          expect(max).toBe(maxima[call]);
          return values[call++]!;
        });
        expect(call).toBe(4);
        expect(result.prize).toBe(0);
        expect(result.reels).toHaveLength(SLOT_RULES.reels);
        expect(result.reels.every(symbol => symbols.includes(symbol))).toBe(true);
        expect(new Set(result.reels).size).toBeGreaterThan(1);
        results.add(result.reels.join(','));
        cases++;
      }
    }
    expect(cases).toBe(7 ** 3 - 7);
    expect(results.size).toBe(cases);
    expect([...results].some(result => result.startsWith('seven,seven,'))).toBe(true);
    expect(SLOT_RULES.dailyLimit).toBeNull();
  });
});
