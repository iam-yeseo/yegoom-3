import { defaultCharacter, type ArtKey } from './characters';
import {
  RANKING_RULES, SCORE_GAME_ORDER, SCORE_GAME_SHORT, addDays, monthWeek, rankingRange,
  scoreGameDate, scoreSource, type RankingPeriod, type ScoreGame,
} from './ranking-periods';
import type { RankingBucket, RankingHistoryEntry, RankingResponse, RankingStanding } from './types';

export interface RankingScoreRow { id: string; userId: string; amount: number; reason: string; reference: string; createdAt: string; catchmindRoundDate: string | null }
export interface RankingPlayerRow { id: string; username: string; displayName: string; character: ArtKey | null; photoVersion: number | null; active: boolean; role: string }
export interface RankingCursor { createdAt: string; id: string }

const WEEKDAYS = ['월', '화', '수', '목', '금', '토', '일'];
const newerFirst = (left: RankingCursor, right: RankingCursor) =>
  right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id);

/** Pure aggregation shared by the Worker and the serverless preview. `rows` may
 * contain scores outside the period (whole weeks are read); they are filtered by
 * the date each score belongs to. */
export function summarizeRanking(period: RankingPeriod, today: string, viewerId: string, rows: RankingScoreRow[],
  players: RankingPlayerRow[], cursor: RankingCursor | null, serverTime: string): RankingResponse {
  const range = rankingRange(period, today);
  const inRange = rows
    .map(row => ({ ...row, gameDate: scoreGameDate(row.reference, row.createdAt, row.catchmindRoundDate) }))
    .filter(row => row.gameDate >= range.start && row.gameDate <= range.end);

  const totals = new Map<string, number>();
  for (const row of inRange) totals.set(row.userId, (totals.get(row.userId) ?? 0) + row.amount);
  const standings: RankingStanding[] = players
    .filter(player => player.active && player.role === 'player')
    .map(player => ({ userId: player.id, username: player.username, displayName: player.displayName,
      photoVersion: player.photoVersion, character: player.character ?? defaultCharacter(player.username), score: totals.get(player.id) ?? 0 }))
    .sort((left, right) => right.score - left.score || left.username.localeCompare(right.username));

  const mine = inRange.filter(row => row.userId === viewerId);
  const sum = (list: typeof mine) => list.reduce((total, row) => total + row.amount, 0);
  let buckets: RankingBucket[];
  if (period === 'week') {
    buckets = WEEKDAYS.map((label, index) => {
      const date = addDays(range.start, index);
      return { key: date, label, current: date === today, future: date > today, score: sum(mine.filter(row => row.gameDate === date)) };
    });
  } else if (period === 'month') {
    buckets = Array.from({ length: monthWeek(range.end) }, (_, index) => ({
      key: String(index + 1), label: `${index + 1}주차`, current: monthWeek(today) === index + 1, future: index + 1 > monthWeek(today),
      score: sum(mine.filter(row => monthWeek(row.gameDate) === index + 1)),
    }));
  } else {
    const byGame = new Map<ScoreGame, number>();
    for (const row of mine) {
      const { game } = scoreSource(row.reference, row.reason);
      byGame.set(game, (byGame.get(game) ?? 0) + row.amount);
    }
    buckets = SCORE_GAME_ORDER.filter(game => byGame.has(game))
      .map(game => ({ key: game, label: SCORE_GAME_SHORT[game], current: false, future: false, score: byGame.get(game)! }));
  }

  const people = new Map(players.map(player => [player.id, player]));
  const ordered: RankingHistoryEntry[] = inRange
    .map(row => ({ id: row.id, userId: row.userId, username: people.get(row.userId)?.username ?? '', displayName: people.get(row.userId)?.displayName ?? '',
      ...scoreSource(row.reference, row.reason), amount: row.amount, createdAt: row.createdAt, gameDate: row.gameDate }))
    .sort(newerFirst);
  // The first entry ordered strictly after the cursor (i.e. older than it).
  const start = cursor ? ordered.findIndex(entry => newerFirst(cursor, entry) < 0) : 0;
  const page = start < 0 ? [] : ordered.slice(start, start + RANKING_RULES.historyPageSize);
  const last = page[page.length - 1];
  const hasMore = start >= 0 && start + RANKING_RULES.historyPageSize < ordered.length;
  return { period, range, standings, buckets, history: page,
    nextBefore: hasMore && last ? `${last.createdAt}|${last.id}` : null, serverTime };
}
