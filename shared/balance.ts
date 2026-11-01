import type { GameId } from './types';

/** The published prediction rules, shared by settlement, help, and previews. */
export const GAME_RULES = {
  wake: { title: '기상시간 맞히기', author: 'min', deadline: '10:30:00' },
  offwork: { title: '퇴근시간 맞히기', author: 'siwon', deadline: '17:00:00' },
  luck: { title: '행운 점수 맞히기', author: 'yeseo', deadline: '17:00:00', revealTime: '18:00:00' },
} as const satisfies Record<GameId, { title: string; author: string; deadline: string; revealTime?: string }>;

export const PREDICTION_REWARDS = { participationGold: 100, firstGold: 100 } as const;
export const ATTENDANCE_RULES = { cycleLength: 7, dailyGold: 100, cycleGold: 500 } as const;
export function attendanceCycleDay(streak: number): number {
  return ((streak - 1) % ATTENDANCE_RULES.cycleLength) + 1;
}
export function attendanceReward(streak: number): number {
  return streak % ATTENDANCE_RULES.cycleLength === 0 ? ATTENDANCE_RULES.cycleGold : ATTENDANCE_RULES.dailyGold;
}
export const CATCHMIND_RULES = {
  rerolls: 3, hintAfter: 3, endAfter: 6, score: 3, gold: 5,
  pollIntervalMs: 5000, maxImageBytes: 300 * 1024, maxAnswerLength: 80,
} as const;
/** Public claw economy only; grip settings and counters stay in the server DB. */
export const CLAW_RULES = {
  coinIntervalMs: 3 * 60 * 60 * 1000, freeCoins: 5,
  coinPrice: 100, purchaseQuantities: [1, 5],
  dollScore: 1, dollGold: 10, clearScore: 5, clearGold: 300,
  playDurationMs: 6000, controlDurationMs: 10000, engine: 2,
} as const;
/** Shop prices, odds and rewards are shared by the Worker and every screen. */
export const KUJI_RULES = {
  size: 100, basePrice: 300, higherPrice: 400, basePriceCount: 5, lastOneGold: 1000,
  grades: [
    { grade: 'A', count: 1, score: 10, gold: 100, lottoTickets: 0, speettoTickets: 0 },
    { grade: 'B', count: 2, score: 5, gold: 50, lottoTickets: 0, speettoTickets: 0 },
    { grade: 'C', count: 3, score: 3, gold: 30, lottoTickets: 0, speettoTickets: 0 },
    { grade: 'D', count: 6, score: 1, gold: 10, lottoTickets: 0, speettoTickets: 0 },
    { grade: 'E', count: 10, score: 0, gold: 0, lottoTickets: 3, speettoTickets: 0 },
    { grade: 'F', count: 15, score: 0, gold: 0, lottoTickets: 1, speettoTickets: 0 },
    { grade: 'G', count: 25, score: 0, gold: 0, lottoTickets: 0, speettoTickets: 3 },
    { grade: 'H', count: 38, score: 0, gold: 0, lottoTickets: 0, speettoTickets: 1 },
  ],
} as const;
export const LOTTO_RULES = {
  price: 500, maxNumber: 25, pickCount: 5, drawTime: '17:00:00',
  prizes: { 5: 5000, 4: 3000, 3: 1000, 2: 500 },
} as const;
export const SPEETTO_RULES = {
  price: 300, winPercent: 10, prize: 1500,
  characters: ['axolotl', 'drop', 'cat', 'bunny', 'bread', 'manta', 'moon', 'monkey'],
} as const;
export function kujiCost(purchasedToday: number, quantity: number): number {
  const baseCount = Math.min(quantity, Math.max(0, KUJI_RULES.basePriceCount - purchasedToday));
  return baseCount * KUJI_RULES.basePrice + (quantity - baseCount) * KUJI_RULES.higherPrice;
}
export function lottoPrize(matches: number): number {
  return LOTTO_RULES.prizes[matches as keyof typeof LOTTO_RULES.prizes] ?? 0;
}
export function lottoRank(matches: number): number | null {
  return lottoPrize(matches) ? LOTTO_RULES.pickCount - matches + 1 : null;
}
export const SCORE_TABLES = {
  wake: [
    { maxDifference: 0, points: 30 }, { maxDifference: 60, points: 25 },
    { maxDifference: 180, points: 20 }, { maxDifference: 600, points: 15 },
    { maxDifference: 1800, points: 10 }, { maxDifference: 3600, points: 5 },
    { maxDifference: 7200, points: 3 },
  ],
  offwork: [
    { maxDifference: 0, points: 30 }, { maxDifference: 15, points: 25 },
    { maxDifference: 30, points: 20 }, { maxDifference: 60, points: 15 },
    { maxDifference: 180, points: 10 }, { maxDifference: 300, points: 5 },
    { maxDifference: 600, points: 1 },
  ],
  luck: [
    { maxDifference: 0, points: 30 }, { maxDifference: 1, points: 25 },
    { maxDifference: 2, points: 20 }, { maxDifference: 3, points: 15 },
    { maxDifference: 4, points: 10 }, { maxDifference: 5, points: 5 },
    { maxDifference: 10, points: 3 }, { maxDifference: 15, points: 1 },
  ],
} as const satisfies Record<GameId, readonly { maxDifference: number; points: number }[]>;

export function predictionPoints(game: GameId, difference: number): number {
  return SCORE_TABLES[game].find(tier => difference <= tier.maxDifference)?.points ?? 0;
}
