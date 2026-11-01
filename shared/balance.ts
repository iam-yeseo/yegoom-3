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
