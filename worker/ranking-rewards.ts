import { addDays, mondayOf, rankingRange, scoreGameDate, weeksOverlapping } from '../shared/ranking-periods';
import { RANKING_REWARDS, RANKING_SETTLEMENT_CATCHUP, rankScores, rankingReward, type RewardPeriod } from '../shared/ranking-rewards';
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

/** Pay every finished period that has no settlement row yet. Two reads and one
 * batch per settlement; a day with nothing owed costs a single indexed read.
 * `INSERT OR IGNORE` on both the payout reference and the settlement row makes
 * a retry, a concurrent Cron and a replayed catch-up all harmless. */
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
    const payouts = rankScores(ordered)
      .map(entry => ({ ...entry, gold: rankingReward(period.period, entry.rank, entry.score) }))
      .filter(entry => entry.gold > 0);
    await db.batch([
      ...payouts.map(entry => db.prepare(`INSERT OR IGNORE INTO ledger (id, user_id, currency, amount, reason, reference, created_at)
        VALUES (?, ?, 'gold', ?, ?, ?, ?)`)
        .bind(crypto.randomUUID(), entry.userId, entry.gold, RANKING_REWARDS[period.period].reason,
          `rank:${period.period}:${period.key}:${entry.userId}`, createdAt)),
      db.prepare('INSERT OR IGNORE INTO ranking_settlements (period, key, settled_at) VALUES (?, ?, ?)')
        .bind(period.period, period.key, createdAt),
    ]);
  }
}
