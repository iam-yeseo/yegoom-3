/** Weekly and monthly ranking payouts, shared by the settlement job, the ranking
 * screen and the preview. A payout is the period's own score times the rank's
 * multiplier, never below that rank's floor, so a quiet week still pays
 * something. Ranks are competition ranks (1·1·3): joint firsts both take the
 * first multiplier and the next player takes third. Ranks past the table are
 * not paid, because four or more players has not been decided yet. */
export type RewardPeriod = 'week' | 'month';

export const RANKING_REWARDS = {
  week: {
    label: '주간 랭킹 보상', reason: '주간 랭킹 보상',
    multipliers: [5, 4, 3], minimums: [300, 200, 100],
    /** The first period paid: weeks whose Monday is on or after this date. */
    from: '2026-11-02',
  },
  month: {
    label: '월간 랭킹 보상', reason: '월간 랭킹 보상',
    multipliers: [2, 1.5, 1], minimums: [600, 400, 200],
    /** The first month paid (`YYYY-MM`), settled on the first of the next month. */
    from: '2026-11',
  },
} as const satisfies Record<RewardPeriod, {
  label: string; reason: string;
  multipliers: readonly number[]; minimums: readonly number[]; from: string;
}>;

/** How many finished periods a late settlement may still pay. */
export const RANKING_SETTLEMENT_CATCHUP = { week: 8, month: 3 } as const;

export function rankingReward(period: RewardPeriod, rank: number, score: number): number {
  const rules = RANKING_REWARDS[period];
  const multiplier = rules.multipliers[rank - 1];
  const minimum = rules.minimums[rank - 1];
  if (multiplier === undefined || minimum === undefined) return 0;
  return Math.max(Math.round(score * multiplier), minimum);
}

/** `×5`, `×1.5` — the multiplier as the screens print it. */
export function multiplierLabel(period: RewardPeriod, rank: number): string {
  return `×${RANKING_REWARDS[period].multipliers[rank - 1] ?? 0}`;
}

export interface RankedScore { userId: string; score: number; rank: number }

/** Competition ranks over totals sorted highest first; equal totals share a
 * rank and skip the places they occupy. The caller decides the tie order. */
export function rankScores(totals: readonly { userId: string; score: number }[]): RankedScore[] {
  let rank = 0;
  let previous: number | undefined;
  return totals.map((entry, index) => {
    if (index === 0 || entry.score !== previous) rank = index + 1;
    previous = entry.score;
    return { ...entry, rank };
  });
}
