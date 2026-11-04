import type { ArtKey } from '../shared/characters';
import { isRankingPeriod, rankingRange, weeksOverlapping } from '../shared/ranking-periods';
import { summarizeRanking, type RankingCursor } from '../shared/ranking-summary';
import type { RankingResponse } from '../shared/types';
import { kstDate } from './rules';

export class RankingError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); }
}
interface ScoreRow { id: string; user_id: string; amount: number; reason: string; reference: string; created_at: string; game_date: string | null }
interface PlayerRow { id: string; username: string; display_name: string; character: ArtKey | null; photo_version: number | null; active: number; role: string }

/** Cursor `createdAt|id`, newest first; both parts come from a previous response. */
function parseCursor(value: string | null): RankingCursor | null {
  if (value === null) return null;
  const match = /^(\d{4}-\d{2}-\d{2}T[\d:.]+Z)\|([A-Za-z0-9_:-]{1,200})$/.exec(value);
  if (!match) throw new RankingError(400, 'INVALID_CURSOR', '기록 페이지를 확인해 주세요.');
  return { createdAt: match[1]!, id: match[2]! };
}

/** Read-only for every signed-in account, including administrators. Two queries:
 * the score rows of every week the period touches (existing `ledger_week_idx`,
 * because each score's `week_start` is the week of its game date) and the roster. */
export async function readRanking(db: D1Database, viewer: { id: string }, period: unknown, before: string | null, now: Date): Promise<RankingResponse> {
  if (!isRankingPeriod(period)) throw new RankingError(400, 'INVALID_PERIOD', '랭킹 기간을 확인해 주세요.');
  const cursor = parseCursor(before);
  const today = kstDate(now);
  const [scores, players] = await Promise.all([
    db.prepare(`SELECT l.id, l.user_id, l.amount, l.reason, l.reference, l.created_at, r.round_date AS game_date
      FROM ledger l LEFT JOIN catchmind_rounds r
        ON r.id = CASE WHEN l.reference LIKE 'catchmind:score:%' THEN substr(l.reference, length('catchmind:score:') + 1) END
      WHERE l.currency = 'score' AND l.week_start IN (SELECT value FROM json_each(?))`)
      .bind(JSON.stringify(weeksOverlapping(rankingRange(period, today)))).all<ScoreRow>(),
    db.prepare(`SELECT u.id, u.username, u.display_name, u.character, u.active, u.role,
        CASE WHEN p.user_id IS NOT NULL THEN u.photo_version ELSE NULL END AS photo_version
      FROM users u LEFT JOIN user_photos p ON p.user_id = u.id ORDER BY u.username`).all<PlayerRow>(),
  ]);
  return summarizeRanking(period, today, viewer.id,
    scores.results.map(row => ({ id: row.id, userId: row.user_id, amount: row.amount, reason: row.reason,
      reference: row.reference, createdAt: row.created_at, catchmindRoundDate: row.game_date })),
    players.results.map(row => ({ id: row.id, username: row.username, displayName: row.display_name, character: row.character,
      photoVersion: row.photo_version, active: row.active === 1, role: row.role })),
    cursor, now.toISOString());
}
