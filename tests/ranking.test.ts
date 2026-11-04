import { describe, expect, it } from 'vitest';
import { rankSummary, standings, type RankingPlayer } from '../src/ranking';

const player = (username: string, displayName: string, weeklyScore: number): RankingPlayer => ({ username, displayName, weeklyScore });
const me = (score: number) => player('me', '예서', score);
const min = (score: number) => player('min', '민', score);
const siwon = (score: number) => player('siwon', '시원', score);
const fourth = (score: number) => player('fourth', '네번째', score);

describe('competition standings', () => {
  it('sorts once with stable ties and skips occupied ranks without mutating input', () => {
    const original = Object.freeze([
      Object.freeze({ ...fourth(12), extra: 'preserved' }),
      Object.freeze({ ...siwon(20), extra: 'preserved' }),
      Object.freeze({ ...min(20), extra: 'preserved' }),
      Object.freeze({ ...me(12), extra: 'preserved' }),
      Object.freeze({ ...player('fifth', '다섯번째', 1), extra: 'preserved' }),
    ]);
    const table = standings(original);
    expect(table.map(row => [row.username, row.rank])).toEqual([
      ['siwon', 1], ['min', 1], ['fourth', 3], ['me', 3], ['fifth', 5],
    ]);
    expect(table.every(row => row.extra === 'preserved')).toBe(true);
    expect(original.map(row => row.username)).toEqual(['fourth', 'siwon', 'min', 'me', 'fifth']);
    expect(table[0]).not.toBe(original[1]);
    expect('rank' in original[0]).toBe(false);
  });
  it('keeps zero scores tied and handles an empty roster', () => {
    expect(standings([me(0), siwon(0), min(0)]).map(row => row.rank)).toEqual([1, 1, 1]);
    expect(standings([])).toEqual([]);
  });
});

describe('rank summary', () => {
  it.each([
    { scenario: 'sole first with one runner-up', players: [me(20), siwon(8)], line: '2위 시원님과 12점 차', chip: '주간 1위' },
    { scenario: 'sole first with tied runners-up', players: [me(20), siwon(8), min(8)], line: '2위 시원님 외 1명과 12점 차', chip: '주간 1위' },
    { scenario: 'sole first with three tied runners-up', players: [me(20), siwon(8), min(8), fourth(8)], line: '2위 시원님 외 2명과 12점 차', chip: '주간 1위' },
    { scenario: 'only player with a score', players: [me(20)], line: '이번 주 1위', chip: '주간 1위' },
    { scenario: 'two players share first', players: [me(20), siwon(20), min(8)], line: '시원님과 공동 1등', chip: '주간 공동 1위' },
    { scenario: 'three players share first', players: [me(20), siwon(20), min(20)], line: '시원님, 민님과 공동 1등', chip: '주간 공동 1위' },
    { scenario: 'four players share first', players: [me(20), siwon(20), min(20), fourth(20)], line: '시원님 외 2명과 공동 1등', chip: '주간 공동 1위' },
    { scenario: 'everyone has zero', players: [me(0), siwon(0), min(0)], line: '아직 이번 주 점수가 없어요', chip: null },
    { scenario: 'only player has zero', players: [me(0)], line: '아직 이번 주 점수가 없어요', chip: null },
    { scenario: 'sole second', players: [min(20), me(12), siwon(8)], line: '1위 민님까지 8점', chip: '주간 2위' },
    { scenario: 'two players share second', players: [min(20), me(12), siwon(12)], line: '시원님과 공동 2등 · 1위 민님까지 8점', chip: '주간 공동 2위' },
    { scenario: 'three players share second', players: [min(20), me(12), siwon(12), fourth(12)], line: '시원님, 네번째님과 공동 2등 · 1위 민님까지 8점', chip: '주간 공동 2위' },
    { scenario: 'below tied first', players: [min(20), siwon(20), me(12)], line: '1위 민님 외 1명까지 8점', chip: '주간 3위' },
    { scenario: 'shared third below tied first', players: [min(20), fourth(20), me(12), siwon(12)], line: '시원님과 공동 3등 · 1위 민님 외 1명까지 8점', chip: '주간 공동 3위' },
    { scenario: 'zero score trails someone with points', players: [min(8), me(0)], line: '1위 민님까지 8점', chip: '주간 2위' },
  ])('$scenario', ({ players, line, chip }) => {
    expect(rankSummary(standings(players), 'me')).toEqual({ line, chip });
  });
  it('uses current display names and identifies the viewer by login identity', () => {
    const table = standings([player('me', '바뀐예서', 20), player('siwon', '바뀐시원', 20)]);
    expect(rankSummary(table, 'me')).toEqual({ line: '바뀐시원님과 공동 1등', chip: '주간 공동 1위' });
    expect(rankSummary(table, '바뀐예서')).toEqual({ line: '', chip: null });
  });
  it('does not assign a ranking to a missing viewer or an empty roster', () => {
    expect(rankSummary(standings([min(20)]), 'admin')).toEqual({ line: '', chip: null });
    expect(rankSummary([], 'me')).toEqual({ line: '', chip: null });
  });
});
