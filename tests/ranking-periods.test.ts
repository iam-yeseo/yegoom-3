import { describe, expect, it } from 'vitest';
import { addDays, mondayOf, monthWeek, rankingRange, scoreGameDate, scoreSource, weeksOverlapping } from '../shared/ranking-periods';
import { summarizeRanking, type RankingPlayerRow, type RankingScoreRow } from '../shared/ranking-summary';

const players: RankingPlayerRow[] = [
  { id: 'u-min', username: 'min', displayName: '민', character: null, photoVersion: null, active: true, role: 'player' },
  { id: 'u-siwon', username: 'siwon', displayName: '시원', character: 'cat', photoVersion: 3, active: true, role: 'player' },
  { id: 'u-yeseo', username: 'yeseo', displayName: '예서', character: null, photoVersion: null, active: true, role: 'player' },
  { id: 'u-gone', username: 'gone', displayName: '떠난 사람', character: null, photoVersion: null, active: false, role: 'player' },
  { id: 'u-admin', username: 'admin', displayName: '운영자', character: null, photoVersion: null, active: true, role: 'admin' },
];
let sequence = 0;
const row = (userId: string, amount: number, reference: string, createdAt: string, catchmindRoundDate: string | null = null): RankingScoreRow =>
  ({ id: `row-${String(++sequence).padStart(3, '0')}`, userId, amount, reason: '사유 원문', reference, createdAt, catchmindRoundDate });

describe('ranking periods', () => {
  it('builds inclusive KST ranges for day, week and month', () => {
    expect(rankingRange('day', '2026-11-04')).toEqual({ start: '2026-11-04', end: '2026-11-04' });
    expect(rankingRange('week', '2026-11-04')).toEqual({ start: '2026-11-02', end: '2026-11-08' });
    expect(rankingRange('week', '2026-11-01')).toEqual({ start: '2026-10-26', end: '2026-11-01' });
    expect(rankingRange('month', '2026-11-04')).toEqual({ start: '2026-11-01', end: '2026-11-30' });
    expect(rankingRange('month', '2028-02-10')).toEqual({ start: '2028-02-01', end: '2028-02-29' });
    expect(rankingRange('month', '2026-12-31')).toEqual({ start: '2026-12-01', end: '2026-12-31' });
  });
  it('lists every week key a range can be stored under', () => {
    expect(mondayOf('2026-11-08')).toBe('2026-11-02');
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(weeksOverlapping({ start: '2026-11-01', end: '2026-11-30' })).toEqual(['2026-10-26', '2026-11-02', '2026-11-09', '2026-11-16', '2026-11-23', '2026-11-30']);
    expect(weeksOverlapping({ start: '2026-11-04', end: '2026-11-04' })).toEqual(['2026-11-02']);
  });
  it('names the game from the reference prefix, not from the reason text', () => {
    expect(scoreSource('score:wake:2026-11-04:u1', '아무 글')).toEqual({ game: 'wake', label: '기상시간 맞히기' });
    expect(scoreSource('score:offwork:2026-11-04:u1', '')).toMatchObject({ game: 'offwork' });
    expect(scoreSource('score:luck:2026-11-04:u1', '')).toMatchObject({ game: 'luck' });
    expect(scoreSource('catchmind:score:round-1', '기상')).toEqual({ game: 'catchmind', label: '캐치마인드' });
    expect(scoreSource('kuji:score:abc', '')).toEqual({ game: 'kuji', label: '예굼쿠지' });
    expect(scoreSource('claw:doll:play:score', '')).toEqual({ game: 'claw', label: '캐릭터 뽑기' });
    expect(scoreSource('claw:clear:play:score', '')).toEqual({ game: 'claw', label: '캐릭터 뽑기 · 클리어 보너스' });
    expect(scoreSource('event:bonus:1', '특별 보너스')).toEqual({ game: 'other', label: '특별 보너스' });
  });
  it('dates a score by its game, matching the stored week key', () => {
    // Settled the next morning, but belongs to the round date.
    expect(scoreGameDate('score:luck:2026-11-03:u1', '2026-11-04T00:30:00.000Z', null)).toBe('2026-11-03');
    expect(scoreGameDate('catchmind:score:r', '2026-11-05T01:00:00.000Z', '2026-11-03')).toBe('2026-11-03');
    // 23:30 UTC is the next KST day.
    expect(scoreGameDate('claw:doll:x:score', '2026-11-03T23:30:00.000Z', null)).toBe('2026-11-04');
    expect([monthWeek('2026-11-01'), monthWeek('2026-11-07'), monthWeek('2026-11-08'), monthWeek('2026-11-30')]).toEqual([1, 1, 2, 5]);
  });
});

describe('ranking summary', () => {
  const today = '2026-11-04';
  const rows = [
    row('u-siwon', 25, 'score:wake:2026-11-04:u-siwon', '2026-11-04T01:31:00.000Z'),
    row('u-yeseo', 25, 'score:offwork:2026-11-04:u-yeseo', '2026-11-04T09:21:00.000Z'),
    row('u-yeseo', 3, 'catchmind:score:r1', '2026-11-04T05:00:00.000Z', '2026-11-04'),
    // Belongs to Monday although it was earned on Wednesday.
    row('u-min', 10, 'catchmind:score:r0', '2026-11-04T02:00:00.000Z', '2026-11-02'),
    row('u-min', 7, 'score:luck:2026-11-01:u-min', '2026-11-01T09:00:00.000Z'),
    row('u-gone', 30, 'claw:doll:p:score', '2026-11-04T03:00:00.000Z'),
    row('u-siwon', 99, 'score:wake:2026-10-31:u-siwon', '2026-10-31T01:00:00.000Z'),
  ];
  it('ranks active players only, includes zero scores and breaks ties by username', () => {
    const day = summarizeRanking('day', today, 'u-yeseo', rows, players, null, 'now');
    expect(day.standings.map(entry => [entry.username, entry.score])).toEqual([['yeseo', 28], ['siwon', 25], ['min', 0]]);
    const week = summarizeRanking('week', today, 'u-yeseo', rows, players, null, 'now');
    expect(week.standings.map(entry => [entry.username, entry.score])).toEqual([['yeseo', 28], ['siwon', 25], ['min', 10]]);
    const month = summarizeRanking('month', today, 'u-min', rows, players, null, 'now');
    expect(month.standings.map(entry => [entry.username, entry.score])).toEqual([['yeseo', 28], ['siwon', 25], ['min', 17]]);
    expect(month.standings.find(entry => entry.username === 'siwon')).toMatchObject({ character: 'cat', photoVersion: 3 });
  });
  it('groups the viewer’s points by game, weekday and week of month', () => {
    expect(summarizeRanking('day', today, 'u-yeseo', rows, players, null, 'now').buckets)
      .toEqual([{ key: 'offwork', label: '퇴근', score: 25, current: false, future: false }, { key: 'catchmind', label: '캐치', score: 3, current: false, future: false }]);
    const week = summarizeRanking('week', today, 'u-min', rows, players, null, 'now').buckets;
    expect(week.map(bucket => bucket.score)).toEqual([10, 0, 0, 0, 0, 0, 0]);
    expect(week.map(bucket => [bucket.current, bucket.future])).toEqual([[false, false], [false, false], [true, false], [false, true], [false, true], [false, true], [false, true]]);
    const month = summarizeRanking('month', today, 'u-min', rows, players, null, 'now').buckets;
    expect(month.map(bucket => [bucket.label, bucket.score, bucket.current, bucket.future])).toEqual([
      ['1주차', 17, true, false], ['2주차', 0, false, true], ['3주차', 0, false, true], ['4주차', 0, false, true], ['5주차', 0, false, true]]);
  });
  it('lists every player’s history newest first with names, including inactive players', () => {
    const day = summarizeRanking('day', today, 'u-yeseo', rows, players, null, 'now');
    expect(day.history.map(entry => [entry.username, entry.label, entry.amount])).toEqual([
      ['yeseo', '퇴근시간 맞히기', 25], ['yeseo', '캐치마인드', 3], ['gone', '캐릭터 뽑기', 30], ['siwon', '기상시간 맞히기', 25]]);
    expect(day.nextBefore).toBeNull();
  });
  it('pages the history with a stable created-at and id cursor', () => {
    const many = Array.from({ length: 45 }, (_, index) =>
      row('u-min', 1, `claw:doll:p${index}:score`, `2026-11-04T0${index % 2}:00:00.000Z`));
    const first = summarizeRanking('day', today, 'u-min', many, players, null, 'now');
    expect(first.history).toHaveLength(20);
    const [createdAt, id] = first.nextBefore!.split('|');
    const second = summarizeRanking('day', today, 'u-min', many, players, { createdAt: createdAt!, id: id! }, 'now');
    const [createdAt2, id2] = second.nextBefore!.split('|');
    const third = summarizeRanking('day', today, 'u-min', many, players, { createdAt: createdAt2!, id: id2! }, 'now');
    expect(third.history).toHaveLength(5);
    expect(third.nextBefore).toBeNull();
    const ids = [...first.history, ...second.history, ...third.history].map(entry => entry.id);
    expect(new Set(ids).size).toBe(45);
  });
});
