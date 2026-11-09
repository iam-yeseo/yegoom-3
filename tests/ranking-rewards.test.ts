import { describe, expect, it } from 'vitest';
import { RANKING_REWARDS, rankScores, rankingReward } from '../shared/ranking-rewards';
import { playClosed, scoreCounts } from '../shared/balance';
import { defaultPredictionRules, validatePredictionRules } from '../shared/game-settings';
import { duePeriods } from '../worker/ranking-rewards';

describe('ranking reward amounts', () => {
  it('pays the period score times the rank multiplier', () => {
    expect(rankingReward('week', 1, 100)).toBe(500);
    expect(rankingReward('week', 2, 100)).toBe(400);
    expect(rankingReward('week', 3, 100)).toBe(300);
    expect(rankingReward('month', 1, 1000)).toBe(2000);
    expect(rankingReward('month', 3, 1000)).toBe(1000);
  });
  it('rounds a half multiplier and never pays below the rank floor', () => {
    // 301 × 1.5 = 451.5, above the 400G floor, so the rounding is what shows.
    expect(rankingReward('month', 2, 301)).toBe(452);
    expect(rankingReward('week', 1, 0)).toBe(RANKING_REWARDS.week.minimums[0]);
    expect(rankingReward('week', 3, 10)).toBe(RANKING_REWARDS.week.minimums[2]);
    expect(rankingReward('month', 1, 100)).toBe(RANKING_REWARDS.month.minimums[0]);
  });
  it('pays nothing for a rank the table does not cover yet', () => {
    expect(rankingReward('week', 4, 1000)).toBe(0);
    expect(rankingReward('month', 9, 1000)).toBe(0);
  });
  it('shares a rank for equal scores and skips the places they take', () => {
    expect(rankScores([{ userId: 'a', score: 80 }, { userId: 'b', score: 80 }, { userId: 'c', score: 10 }])
      .map(entry => entry.rank)).toEqual([1, 1, 3]);
    expect(rankScores([{ userId: 'a', score: 0 }, { userId: 'b', score: 0 }, { userId: 'c', score: 0 }])
      .map(entry => entry.rank)).toEqual([1, 1, 1]);
    // Joint firsts both take the first multiplier; the next player takes third.
    expect(rankScores([{ userId: 'a', score: 80 }, { userId: 'b', score: 80 }, { userId: 'c', score: 10 }])
      .map(entry => rankingReward('week', entry.rank, entry.score))).toEqual([400, 400, 100]);
  });
});

describe('periods owed a settlement', () => {
  it('lists finished weeks and months, newest first, within the catch-up window', () => {
    // A Monday: the week that ended last night is the one before this Monday.
    const due = duePeriods('2026-12-07');
    expect(due.filter(period => period.period === 'week').map(period => period.key))
      .toEqual(['2026-11-30', '2026-11-23', '2026-11-16', '2026-11-09', '2026-11-02']);
    expect(due.find(period => period.key === '2026-11-30')).toMatchObject({ start: '2026-11-30', end: '2026-12-06' });
    expect(due.filter(period => period.period === 'month').map(period => period.key)).toEqual(['2026-11']);
    expect(due.find(period => period.key === '2026-11')).toMatchObject({ start: '2026-11-01', end: '2026-11-30' });
  });
  it('never reaches back before rewards started', () => {
    expect(duePeriods('2026-11-02')).toEqual([]);
    expect(duePeriods('2026-11-09').map(period => period.key)).toEqual(['2026-11-02']);
    expect(duePeriods('2026-12-01').filter(period => period.period === 'month').map(period => period.key)).toEqual(['2026-11']);
  });
  it('keeps the current period out of the list', () => {
    const due = duePeriods('2026-11-11');
    expect(due.map(period => period.key)).not.toContain('2026-11-09');
    expect(due.map(period => period.key)).not.toContain('2026-11');
  });
});

describe('the 23:50 daily close', () => {
  const at = (kst: string) => Date.parse(`${kst}+09:00`);
  it('closes play from 23:50 to midnight KST', () => {
    expect(playClosed(at('2026-11-08T23:49:59'))).toBe(false);
    expect(playClosed(at('2026-11-08T23:50:00'))).toBe(true);
    expect(playClosed(at('2026-11-08T23:59:59'))).toBe(true);
    expect(playClosed(at('2026-11-09T00:00:00'))).toBe(false);
  });
  it('counts a score only if it was earned before its game day closed', () => {
    expect(scoreCounts('2026-11-08', at('2026-11-08T23:49:59'))).toBe(true);
    expect(scoreCounts('2026-11-08', at('2026-11-08T23:50:00'))).toBe(false);
    // A round from Sunday solved on Monday morning belongs to Sunday: no score.
    expect(scoreCounts('2026-11-08', at('2026-11-09T09:00:00'))).toBe(false);
  });
});

describe('prediction deadlines', () => {
  it('cannot be set past the 23:50 close', () => {
    const base = defaultPredictionRules('offwork');
    expect(validatePredictionRules('offwork', { ...base, deadline: '23:50:00' })).toHaveProperty('rules');
    expect(validatePredictionRules('offwork', { ...base, deadline: '23:50:01' })).toEqual({ error: '예측 마감은 게임이 닫히는 밤 11시 50분 이전이어야 해요.' });
  });
});
