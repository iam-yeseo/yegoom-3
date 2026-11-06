import { ACHIEVEMENT_BY_KEY, ACHIEVEMENT_RULES, ACHIEVEMENTS, isAchievementKey, type AchievementClientEvent, type AchievementProgress, type AchievementsResponse } from '../shared/achievements';
import { CATCHMIND_RULES } from '../shared/balance';
import { STOCK_RULES } from '../shared/stocks';
import type { GameId } from '../shared/types';
import { readBalances } from './balances';
import { notify } from './notifications';
import { kstDate, valueDifference, weekStart } from './rules';

export class AchievementError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); }
}
interface Actor { id: string; role: 'player' | 'admin' }
interface Unlock { key: string; periodKey: string }

/** Everything the rules need about one player, read in a single statement.
 * Repeatable facts come back as JSON arrays of the last few days. */
interface Facts {
  nickname: number; photo: number; character: number; notifications: number;
  wake_join: number; offwork_join: number; luck_join: number;
  catchmind_guess: number; catchmind_draw: number; catchmind_misses: number;
  attend_total: number; attend_streak: number | null;
  kuji_first: number; kuji_a: number; kuji_last: number;
  lotto_first: number; lotto_win: number; speetto_win: number; slot_jackpot: number;
  tag_first: number; tag_s: number; tag_equip: number;
  claw_first: number; claw_clear: number; rank_month: number;
  rank_weeks: string; games: string; lotto_zero: string; slots: string; catchmind: string;
  stock_buy: number; stock_sell: number; stock_delisted: number;
  /** Best and worst realized gold on a single sell (null without a sell). */
  stock_best: number | null; stock_worst: number | null;
  stock_limit_up: number; stock_limit_down: number;
}
/** Limit prices in SQL, matching isLimitUp/isLimitDown in shared/stock-engine.ts:
 * floor(prev × 1.15) and ceil(prev × 0.85). */
const UP = 1 + STOCK_RULES.dailyLimit, DOWN = 1 - STOCK_RULES.dailyLimit;
const limitUpSql = (prev: string) => `CAST(${prev} * ${UP} AS INTEGER)`;
const limitDownSql = (prev: string) => `(CAST(${prev} * ${DOWN} AS INTEGER) + (${prev} * ${DOWN} > CAST(${prev} * ${DOWN} AS INTEGER)))`;
/** A limit move counts when the player held the stock that day: shares left
 * from earlier days, or a buy on the day itself. Today's move counts from the
 * live price while they hold it. */
const heldOnDay = `(EXISTS (SELECT 1 FROM stock_trades t WHERE t.user_id = u.id AND t.ticker = c.ticker AND t.date = c.date AND t.side = 'buy')
      OR (SELECT COALESCE(SUM(CASE t.side WHEN 'buy' THEN t.quantity ELSE -t.quantity END), 0) FROM stock_trades t
        WHERE t.user_id = u.id AND t.ticker = c.ticker AND t.date < c.date) > 0)`;
const dailyWithPrev = `(SELECT ticker, date, high, low, LAG(close) OVER (PARTITION BY ticker ORDER BY date) AS prev FROM stock_daily)`;
const FACTS_SQL = `SELECT
    u.display_name != u.username COLLATE NOCASE AS nickname,
    EXISTS (SELECT 1 FROM user_photos WHERE user_id = u.id) AS photo,
    u.character IS NOT NULL AS character,
    u.notifications_seen_at IS NOT NULL AS notifications,
    EXISTS (SELECT 1 FROM predictions WHERE player_id = u.id AND game_id = 'wake') AS wake_join,
    EXISTS (SELECT 1 FROM predictions WHERE player_id = u.id AND game_id = 'offwork') AS offwork_join,
    EXISTS (SELECT 1 FROM predictions WHERE player_id = u.id AND game_id = 'luck') AS luck_join,
    EXISTS (SELECT 1 FROM catchmind_guesses WHERE player_id = u.id) AS catchmind_guess,
    EXISTS (SELECT 1 FROM catchmind_rounds WHERE drawer_id = u.id AND status != 'draft') AS catchmind_draw,
    EXISTS (SELECT 1 FROM catchmind_rounds WHERE drawer_id = u.id AND end_reason = 'misses') AS catchmind_misses,
    (SELECT COUNT(*) FROM attendance WHERE user_id = u.id) AS attend_total,
    (SELECT MAX(streak) FROM attendance WHERE user_id = u.id) AS attend_streak,
    EXISTS (SELECT 1 FROM shop_purchases WHERE user_id = u.id AND kind = 'kuji') AS kuji_first,
    EXISTS (SELECT 1 FROM shop_purchases WHERE user_id = u.id AND kind = 'kuji' AND outcome LIKE '%"grade":"A"%') AS kuji_a,
    EXISTS (SELECT 1 FROM shop_purchases WHERE user_id = u.id AND kind = 'kuji' AND last_one = 1) AS kuji_last,
    EXISTS (SELECT 1 FROM shop_purchases WHERE user_id = u.id AND kind = 'lotto') AS lotto_first,
    EXISTS (SELECT 1 FROM shop_purchases p JOIN lotto_tickets t ON t.id = p.id WHERE p.user_id = u.id AND p.kind = 'lotto' AND t.rank = 1) AS lotto_win,
    EXISTS (SELECT 1 FROM shop_purchases WHERE user_id = u.id AND kind = 'speetto' AND json_extract(outcome, '$.won') = 1) AS speetto_win,
    EXISTS (SELECT 1 FROM slot_spins WHERE user_id = u.id AND prize > 0) AS slot_jackpot,
    EXISTS (SELECT 1 FROM nickname_tags WHERE user_id = u.id) AS tag_first,
    EXISTS (SELECT 1 FROM nickname_tags WHERE user_id = u.id AND grade = 'S') AS tag_s,
    EXISTS (SELECT 1 FROM nickname_tags WHERE user_id = u.id AND equipped = 1) AS tag_equip,
    EXISTS (SELECT 1 FROM claw_plays WHERE user_id = u.id AND caught > 0) AS claw_first,
    EXISTS (SELECT 1 FROM claw_plays WHERE user_id = u.id AND clear_bonus > 0) AS claw_clear,
    EXISTS (SELECT 1 FROM notifications WHERE user_id = u.id AND kind = 'rank'
      AND json_extract(payload_json, '$.period') = 'month' AND json_extract(payload_json, '$.place') <= 3) AS rank_month,
    (SELECT json_group_array(reference) FROM notifications WHERE user_id = u.id AND kind = 'rank'
      AND json_extract(payload_json, '$.period') = 'week' AND json_extract(payload_json, '$.place') = 1) AS rank_weeks,
    (SELECT json_group_array(json_object('g', r.game_id, 'd', r.round_date, 'a', r.answer, 'v', p.value))
      FROM predictions p JOIN game_rounds r ON r.game_id = p.game_id AND r.round_date = p.round_date
      WHERE p.player_id = u.id AND p.round_date >= ? AND r.answer IS NOT NULL
        AND (r.revealed_at IS NOT NULL OR r.reveal_at <= ?)) AS games,
    (SELECT json_group_array(t.draw_date) FROM shop_purchases p JOIN lotto_tickets t ON t.id = p.id
      WHERE p.user_id = u.id AND p.kind = 'lotto' AND p.date >= ? AND t.matches = 0) AS lotto_zero,
    (SELECT json_group_array(d.value) FROM json_each(?) d
      WHERE EXISTS (SELECT 1 FROM slot_spins WHERE user_id = u.id AND date = d.value LIMIT 1 OFFSET ?)) AS slots,
    (SELECT json_group_array(json_object('d', round_date, 'drawer', drawer_id = u.id, 'winner', winner_id = u.id, 'w', wrong_count))
      FROM catchmind_rounds WHERE status = 'ended' AND round_date >= ? AND winner_id IS NOT NULL
        AND (drawer_id = u.id OR winner_id = u.id)) AS catchmind,
    EXISTS (SELECT 1 FROM stock_trades WHERE user_id = u.id AND side = 'buy') AS stock_buy,
    EXISTS (SELECT 1 FROM stock_trades WHERE user_id = u.id AND side = 'sell') AS stock_sell,
    EXISTS (SELECT 1 FROM stock_trades WHERE user_id = u.id AND side = 'delist') AS stock_delisted,
    (SELECT MAX(total - cost_basis) FROM stock_trades WHERE user_id = u.id AND side = 'sell') AS stock_best,
    (SELECT MIN(total - cost_basis) FROM stock_trades WHERE user_id = u.id AND side = 'sell') AS stock_worst,
    (EXISTS (SELECT 1 FROM ${dailyWithPrev} c WHERE c.prev IS NOT NULL AND c.high >= ${limitUpSql('c.prev')} AND ${heldOnDay})
      OR EXISTS (SELECT 1 FROM stock_holdings h JOIN stock_state s ON s.ticker = h.ticker WHERE h.user_id = u.id AND h.quantity > 0
        AND s.status != 'delisted' AND s.day_open IS NOT NULL AND s.day_high >= ${limitUpSql('s.prev_close')})) AS stock_limit_up,
    (EXISTS (SELECT 1 FROM ${dailyWithPrev} c WHERE c.prev IS NOT NULL AND c.low <= ${limitDownSql('c.prev')} AND ${heldOnDay})
      OR EXISTS (SELECT 1 FROM stock_holdings h JOIN stock_state s ON s.ticker = h.ticker WHERE h.user_id = u.id AND h.quantity > 0
        AND s.status != 'delisted' AND s.day_open IS NOT NULL AND s.day_low <= ${limitDownSql('s.prev_close')})) AS stock_limit_down
  FROM users u WHERE u.id = ? AND u.role = 'player' AND u.active = 1`;

/** Which achievements the facts satisfy. Pure, so the rules are unit-testable. */
export function unlockedAchievements(facts: Facts, events: ReadonlySet<string>): Unlock[] {
  const once = (key: string, satisfied: unknown) => satisfied ? [{ key, periodKey: '' }] : [];
  const unlocks: Unlock[] = [
    ...once('welcome', true),
    ...once('nickname', facts.nickname), ...once('photo', facts.photo), ...once('character', facts.character),
    ...once('password', events.has('password')), ...once('notifications', facts.notifications),
    ...once('font_size', events.has('font_size')),
    ...once('wake_join', facts.wake_join), ...once('offwork_join', facts.offwork_join), ...once('luck_join', facts.luck_join),
    ...once('catchmind_guess', facts.catchmind_guess), ...once('catchmind_draw', facts.catchmind_draw), ...once('catchmind_misses', facts.catchmind_misses),
    ...once('attend_first', facts.attend_total >= 1),
    ...once('attend_streak', (facts.attend_streak ?? 0) >= ACHIEVEMENT_RULES.attendance.streak),
    ...once('attend_total', facts.attend_total >= ACHIEVEMENT_RULES.attendance.total),
    ...once('kuji_first', facts.kuji_first), ...once('kuji_a', facts.kuji_a), ...once('kuji_last', facts.kuji_last),
    ...once('lotto_first', facts.lotto_first), ...once('lotto_win', facts.lotto_win), ...once('speetto_win', facts.speetto_win),
    ...once('slot_jackpot', facts.slot_jackpot),
    ...once('tag_first', facts.tag_first), ...once('tag_s', facts.tag_s), ...once('tag_equip', facts.tag_equip),
    ...once('claw_first', facts.claw_first), ...once('claw_clear', facts.claw_clear), ...once('rank_month', facts.rank_month),
    ...once('stock_buy', facts.stock_buy), ...once('stock_sell', facts.stock_sell), ...once('stock_delisted', facts.stock_delisted),
    ...once('stock_limit_up', facts.stock_limit_up), ...once('stock_limit_down', facts.stock_limit_down),
    ...ACHIEVEMENT_RULES.stockTiers.flatMap(tier => [
      ...once(`stock_gain_${tier}`, (facts.stock_best ?? 0) >= tier),
      ...once(`stock_loss_${tier}`, (facts.stock_worst ?? 0) <= -tier),
    ]),
  ];
  for (const reference of JSON.parse(facts.rank_weeks) as string[]) {
    const week = /^notification:rank:week:(\d{4}-\d{2}-\d{2}):/.exec(reference)?.[1];
    if (week) unlocks.push({ key: 'rank_week', periodKey: week });
  }
  for (const round of JSON.parse(facts.games) as { g: GameId; d: string; a: string; v: string }[]) {
    const difference = valueDifference(round.g, round.v, round.a);
    const exact = difference === 0;
    if (round.g === 'wake') {
      if (difference <= ACHIEVEMENT_RULES.wake.near) unlocks.push({ key: 'wake_near', periodKey: round.d });
      if (difference <= ACHIEVEMENT_RULES.wake.close) unlocks.push({ key: 'wake_close', periodKey: round.d });
      if (exact) unlocks.push({ key: 'wake_exact', periodKey: round.d });
    } else if (round.g === 'offwork') {
      if (difference <= ACHIEVEMENT_RULES.offwork.near) unlocks.push({ key: 'offwork_near', periodKey: round.d });
      if (difference <= ACHIEVEMENT_RULES.offwork.close) unlocks.push({ key: 'offwork_close', periodKey: round.d });
      if (exact) unlocks.push({ key: 'offwork_exact', periodKey: round.d });
    } else {
      if (difference <= ACHIEVEMENT_RULES.luck.near) unlocks.push({ key: 'luck_near', periodKey: round.d });
      if (exact) unlocks.push({ key: 'luck_exact', periodKey: round.d });
    }
  }
  for (const date of JSON.parse(facts.lotto_zero) as string[]) unlocks.push({ key: 'lotto_zero', periodKey: date });
  // Only the dates with at least the required number of spins come back.
  for (const date of JSON.parse(facts.slots) as string[]) unlocks.push({ key: 'slot_ten', periodKey: date });
  for (const round of JSON.parse(facts.catchmind) as { d: string | null; drawer: number; winner: number; w: number }[]) {
    if (!round.d) continue;
    if (round.winner && round.w === 0) unlocks.push({ key: 'catchmind_first', periodKey: round.d });
    if (round.winner && round.w === CATCHMIND_RULES.endAfter - 1) unlocks.push({ key: 'catchmind_last', periodKey: round.d });
    if (round.drawer && round.w === 0) unlocks.push({ key: 'catchmind_drawn_first', periodKey: round.d });
  }
  return unlocks;
}

/** Records every achievement the player has earned but not yet been credited
 * with, and notifies them once per row. One read (facts + existing rows) and,
 * only when something is new, one write batch. Safe to run at any time; a
 * retry or a concurrent run inserts nothing twice (both keys are UNIQUE). */
export async function syncAchievements(db: D1Database, userId: string, now: Date, events: Iterable<string> = []): Promise<Unlock[]> {
  const since = kstDate(new Date(now.getTime() - ACHIEVEMENT_RULES.lookbackDays * 86_400_000));
  // The slot check probes each recent date for its tenth spin, so a heavy day
  // costs ten rows rather than every spin of the day.
  const dates = Array.from({ length: ACHIEVEMENT_RULES.lookbackDays + 1 }, (_, back) => kstDate(new Date(now.getTime() - back * 86_400_000)));
  const [facts, existing] = await db.batch<Facts & { key: string; period_key: string }>([
    db.prepare(FACTS_SQL).bind(since, now.getTime(), since, JSON.stringify(dates), ACHIEVEMENT_RULES.slot.dailySpins - 1, since, userId),
    db.prepare('SELECT key, period_key FROM achievements WHERE user_id = ?').bind(userId),
  ]);
  const row = facts!.results[0];
  if (!row) return [];
  const known = new Set(existing!.results.map(item => `${item.key}:${item.period_key}`));
  const fresh = unlockedAchievements(row, new Set(events)).filter(item => !known.has(`${item.key}:${item.periodKey}`));
  if (!fresh.length) return [];
  const createdAt = now.toISOString();
  await db.batch(fresh.flatMap(item => [
    db.prepare('INSERT OR IGNORE INTO achievements (user_id, key, period_key, unlocked_at) VALUES (?, ?, ?, ?)')
      .bind(userId, item.key, item.periodKey, createdAt),
    notify(db, { kind: 'achievement', audience: 'user', userId, actorId: userId,
      payload: { kind: 'achievement', key: item.key, periodKey: item.periodKey },
      reference: `notification:achievement:${userId}:${item.key}:${item.periodKey}`, createdAt }),
  ]));
  return fresh;
}

/** The same sync for several players at once (after a settlement), each
 * independently so one failure cannot hold back the others' unlocks. */
export async function syncAchievementsFor(db: D1Database, userIds: Iterable<string>, now: Date): Promise<void> {
  for (const userId of new Set(userIds)) {
    await syncAchievements(db, userId, now).catch(error => {
      console.error('Achievement sync failed', error instanceof Error ? error.name : 'UnknownError');
    });
  }
}

interface ProgressRow { key: string; period_key: string; unlocked_at: string; claimed_at: string | null }
/** The screen's view: current-period rows plus every unclaimed one, the
 * collected counts, and the wallet so the toolbar can show gold. */
export async function readAchievements(db: D1Database, user: Actor, now: Date): Promise<AchievementsResponse> {
  if (user.role === 'player') await syncAchievements(db, user.id, now);
  const [rows, counts] = await db.batch<ProgressRow & { n: number }>([
    db.prepare(`SELECT key, period_key, unlocked_at, claimed_at FROM achievements
      WHERE user_id = ? AND (claimed_at IS NULL OR period_key IN ('', ?, ?)) ORDER BY unlocked_at`)
      .bind(user.id, kstDate(now), weekStart(now)),
    db.prepare('SELECT key, COUNT(*) AS n FROM achievements WHERE user_id = ? AND claimed_at IS NOT NULL GROUP BY key').bind(user.id),
  ]);
  const progress: AchievementProgress[] = rows!.results.map(row => ({ key: row.key, periodKey: row.period_key, unlockedAt: row.unlocked_at, claimedAt: row.claimed_at }));
  const claimedCounts = Object.fromEntries(counts!.results.map(row => [row.key, row.n]));
  return { progress, claimedCounts, unclaimed: progress.filter(row => row.claimedAt === null).length,
    gold: (await readBalances(db, user.id)).gold, serverTime: now.toISOString() };
}

/** `POST /api/achievements/claim`: marks the row collected and pays its gold in
 * one batch. The ledger reference is UNIQUE, so a retried claim pays once. */
export async function claimAchievement(db: D1Database, user: Actor, input: Record<string, unknown>, now: Date): Promise<AchievementsResponse> {
  if (user.role !== 'player') throw new AchievementError(403, 'CANNOT_CLAIM', '플레이어만 도전과제 보상을 받을 수 있어요.');
  if (!isAchievementKey(input.key) || typeof input.periodKey !== 'string' || input.periodKey.length > 10) {
    throw new AchievementError(400, 'INVALID_ACHIEVEMENT', '받을 도전과제를 확인해 주세요.');
  }
  const definition = ACHIEVEMENT_BY_KEY.get(input.key)!;
  const claimedAt = now.toISOString();
  const writes = await db.batch([
    db.prepare('UPDATE achievements SET claimed_at = ? WHERE user_id = ? AND key = ? AND period_key = ? AND claimed_at IS NULL')
      .bind(claimedAt, user.id, definition.key, input.periodKey),
    db.prepare(`INSERT OR IGNORE INTO ledger (id, user_id, currency, amount, reason, reference, created_at)
      SELECT ?, ?, 'gold', ?, ?, ?, ? WHERE changes() = 1`)
      .bind(crypto.randomUUID(), user.id, definition.reward, `도전과제 · ${definition.title}`,
        `achievement:${definition.key}:${input.periodKey}:${user.id}`, claimedAt),
  ]);
  if (writes[0]!.meta.changes !== 1) {
    const row = await db.prepare('SELECT claimed_at FROM achievements WHERE user_id = ? AND key = ? AND period_key = ?')
      .bind(user.id, definition.key, input.periodKey).first<{ claimed_at: string | null }>();
    if (row) throw new AchievementError(409, 'ALREADY_CLAIMED', '이미 받은 도전과제 보상이에요.');
    throw new AchievementError(409, 'NOT_UNLOCKED', '아직 달성하지 않은 도전과제예요.');
  }
  return readAchievements(db, user, now);
}

/** `POST /api/achievements/events`: a client-side change the Worker cannot see
 * (the font size lives in the browser) is accepted from a short allow-list. */
export async function recordAchievementEvent(db: D1Database, user: Actor, input: Record<string, unknown>, now: Date): Promise<AchievementsResponse> {
  if (user.role !== 'player') throw new AchievementError(403, 'CANNOT_CLAIM', '플레이어만 도전과제에 참여할 수 있어요.');
  if (!(ACHIEVEMENT_RULES.clientEvents as readonly string[]).includes(input.event as string)) {
    throw new AchievementError(400, 'INVALID_EVENT', '기록할 수 없는 도전과제예요.');
  }
  await syncAchievements(db, user.id, now, [input.event as AchievementClientEvent]);
  return readAchievements(db, user, now);
}

export const ACHIEVEMENT_COUNT = ACHIEVEMENTS.length;
