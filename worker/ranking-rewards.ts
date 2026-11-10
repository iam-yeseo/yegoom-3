import { addDays, mondayOf, rankingRange, scoreGameDate, weeksOverlapping } from '../shared/ranking-periods';
import { RANKING_REWARDS, RANKING_SETTLEMENT_CATCHUP, rankScores, rankingReward, type RankResult, type RankResultKey, type RewardPeriod } from '../shared/ranking-rewards';
import { notify } from './notifications';
import { syncAchievementsFor } from './achievements';
import { kstDate } from './rules';

interface ScoreRow { user_id: string; amount: number; reference: string; created_at: string; game_date: string | null }
interface PlayerRow { id: string; username: string }
interface DuePeriod { period: RewardPeriod; key: string; start: string; end: string }

const monthKey = (date: string) => date.slice(0, 7);
const previousMonth = (key: string, back: number) => {
  const value = new Date(`${key}-01T00:00:00Z`);
  value.setUTCMonth(value.getUTCMonth() - back);
  return value.toISOString().slice(0, 7);
};
const range = (period: RewardPeriod, key: string) =>
  rankingRange(period, period === 'week' ? key : `${key}-01`);

/** Every finished period that could still be owed a payout, newest first. The
 * catch-up window bounds a late run, and `from` keeps the job from paying the
 * weeks and months that were played before rewards existed. */
export function duePeriods(today: string): DuePeriod[] {
  const due: DuePeriod[] = [];
  for (let back = 1; back <= RANKING_SETTLEMENT_CATCHUP.week; back++) {
    const key = addDays(mondayOf(today), -7 * back);
    if (key >= RANKING_REWARDS.week.from) due.push({ period: 'week', key, ...range('week', key) });
  }
  for (let back = 1; back <= RANKING_SETTLEMENT_CATCHUP.month; back++) {
    const key = previousMonth(monthKey(today), back);
    if (key >= RANKING_REWARDS.month.from) due.push({ period: 'month', key, ...range('month', key) });
  }
  return due;
}

/** A batch that lost the race for the settlement row: its plain INSERT hit the
 * (period, key) primary key, so D1 rolled the whole batch back. */
const lostSettlementRace = (error: unknown) =>
  error instanceof Error && /UNIQUE constraint failed: ranking_settlements\.period, ranking_settlements\.key/.test(error.message);

/** Pay every finished period that has no settlement row yet. Two reads and one
 * batch per settlement; a run with nothing owed costs a single indexed read.
 * The batch claims the settlement row first with a plain INSERT, so exactly one
 * run's snapshot is ever paid: a concurrent run that read different scores
 * fails on the primary key and its whole batch rolls back. */
export async function settleDueRankingRewards(db: D1Database, now: Date): Promise<void> {
  const due = duePeriods(kstDate(now));
  if (!due.length) return;
  // Week keys are dates and month keys are months, so one key list is unambiguous.
  const settled = new Set((await db.prepare(
    'SELECT period, key FROM ranking_settlements WHERE key IN (SELECT value FROM json_each(?))')
    .bind(JSON.stringify(due.map(period => period.key)))
    .all<{ period: string; key: string }>()).results.map(row => `${row.period}:${row.key}`));
  const pending = due.filter(period => !settled.has(`${period.period}:${period.key}`));
  if (!pending.length) return;

  const weeks = [...new Set(pending.flatMap(period => weeksOverlapping(period)))];
  const [scores, players] = await Promise.all([
    db.prepare(`SELECT l.user_id, l.amount, l.reference, l.created_at, r.round_date AS game_date
      FROM ledger l LEFT JOIN catchmind_rounds r
        ON r.id = CASE WHEN l.reference LIKE 'catchmind:score:%' THEN substr(l.reference, length('catchmind:score:') + 1) END
      WHERE l.currency = 'score' AND l.week_start IN (SELECT value FROM json_each(?))`)
      .bind(JSON.stringify(weeks)).all<ScoreRow>(),
    db.prepare("SELECT id, username FROM users WHERE role = 'player' AND active = 1 ORDER BY username").all<PlayerRow>(),
  ]);
  const dated = scores.results.map(row => ({ ...row, gameDate: scoreGameDate(row.reference, row.created_at, row.game_date) }));
  const createdAt = now.toISOString();

  for (const period of pending) {
    const totals = new Map(players.results.map(player => [player.id, 0]));
    for (const row of dated) {
      if (row.gameDate < period.start || row.gameDate > period.end) continue;
      const total = totals.get(row.user_id);
      if (total !== undefined) totals.set(row.user_id, total + row.amount);
    }
    // Same order as the ranking screen: score first, then login name.
    const ordered = players.results
      .map(player => ({ userId: player.id, username: player.username, score: totals.get(player.id) ?? 0 }))
      .sort((left, right) => right.score - left.score || left.username.localeCompare(right.username));
    const ranked = rankScores(ordered)
      .map(entry => ({ ...entry, gold: rankingReward(period.period, entry.rank, entry.score) }));
    const payouts = ranked.filter(entry => entry.gold > 0);
    try {
      await db.batch([
        // First statement on purpose: the whole period commits under one claim.
        db.prepare('INSERT INTO ranking_settlements (period, key, settled_at) VALUES (?, ?, ?)')
          .bind(period.period, period.key, createdAt),
        // Every ranked player's snapshot, paid or not, for the result dialog.
        ...ranked.map(entry => db.prepare(`INSERT INTO ranking_results (period, key, user_id, place, score, gold, players)
          VALUES (?, ?, ?, ?, ?, ?, ?)`).bind(period.period, period.key, entry.userId, entry.rank, entry.score, entry.gold, ranked.length)),
        ...payouts.flatMap(entry => {
          const reference = `rank:${period.period}:${period.key}:${entry.userId}`;
          return [
            db.prepare(`INSERT OR IGNORE INTO ledger (id, user_id, currency, amount, reason, reference, created_at)
              VALUES (?, ?, 'gold', ?, ?, ?, ?)`)
              .bind(crypto.randomUUID(), entry.userId, entry.gold, RANKING_REWARDS[period.period].reason, reference, createdAt),
            // Only this player sees it, and only once: the reference is UNIQUE.
            notify(db, { kind: 'rank', audience: 'user', userId: entry.userId, actorId: entry.userId,
              payload: { kind: 'rank', period: period.period, place: entry.rank, gold: entry.gold },
              reference: `notification:${reference}`, createdAt }),
          ];
        }),
      ]);
    } catch (error) {
      // Another run already paid this period from its own snapshot. Anything
      // else is a real failure: nothing committed, and the next run retries.
      if (lostSettlementRace(error)) continue;
      throw error;
    }
    // A first place or a podium finish is also an achievement.
    await syncAchievementsFor(db, payouts.map(entry => entry.userId), now);
  }
}

interface ResultRow { period: RewardPeriod; key: string; place: number; score: number; gold: number; players: number }

/** The newest finished week and month: the periods a result dialog may still
 * announce. Older unseen results are history the ranking screen already shows. */
function latestPeriods(today: string): { week: string; month: string } {
  return { week: addDays(mondayOf(today), -7), month: previousMonth(monthKey(today), 1) };
}

/** This player's unseen results for the newest finished week and month, from
 * one partial-index probe (at most two rows). */
export async function readRankResults(db: D1Database, user: { id: string; role: string }, now: Date): Promise<RankResult[]> {
  if (user.role !== 'player') return [];
  const latest = latestPeriods(kstDate(now));
  const rows = (await db.prepare(`SELECT period, key, place, score, gold, players FROM ranking_results
    WHERE user_id = ? AND seen_at IS NULL AND ((period = 'week' AND key = ?) OR (period = 'month' AND key = ?))
    ORDER BY period DESC`).bind(user.id, latest.week, latest.month).all<ResultRow>()).results;
  return rows.map(row => ({ ...row, ...range(row.period, row.key) }));
}

export class RankResultError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); }
}
/** Closing the dialog marks the shown results as seen, on every device. */
export async function markRankResultsSeen(db: D1Database, user: { id: string; role: string }, input: unknown, now: Date): Promise<{ results: RankResult[] }> {
  const list = input && typeof input === 'object' ? (input as { results?: unknown }).results : undefined;
  const valid = Array.isArray(list) && list.length >= 1 && list.length <= 2 && list.every(item => item && typeof item === 'object'
    && ((item as RankResultKey).period === 'week' || (item as RankResultKey).period === 'month')
    && typeof (item as RankResultKey).key === 'string' && (item as RankResultKey).key.length <= 10);
  if (!valid) throw new RankResultError(400, 'INVALID_RESULTS', '확인할 랭킹 결과를 다시 불러와 주세요.');
  await db.batch((list as RankResultKey[]).map(item => db.prepare(`UPDATE ranking_results SET seen_at = ?
    WHERE user_id = ? AND period = ? AND key = ? AND seen_at IS NULL`).bind(now.toISOString(), user.id, item.period, item.key)));
  return { results: await readRankResults(db, user, now) };
}
