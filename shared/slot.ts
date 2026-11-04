import { SLOT_RULES } from './balance';
import type { SlotSymbol } from './types';

/** One jackpot roll, then bounded symbol selection for a non-winning result. */
export function slotResult(randomInt: (max: number) => number): { reels: SlotSymbol[]; prize: number } {
  if (randomInt(100) < SLOT_RULES.jackpotPercent) {
    return { reels: Array<SlotSymbol>(SLOT_RULES.reels).fill('seven'), prize: SLOT_RULES.jackpotPrize };
  }
  const symbols = SLOT_RULES.symbols;
  const first = randomInt(symbols.length);
  const second = randomInt(symbols.length);
  // Skip the matching symbol on the last reel instead of retrying an RNG loop.
  const last = randomInt(symbols.length - (first === second ? 1 : 0));
  const third = first === second && last >= first ? last + 1 : last;
  return { reels: [symbols[first]!, symbols[second]!, symbols[third]!], prize: 0 };
}
