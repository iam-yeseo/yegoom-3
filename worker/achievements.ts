import { ACHIEVEMENT_BY_KEY, ACHIEVEMENT_RULES, ACHIEVEMENTS, isAchievementKey, type AchievementClientEvent, type AchievementProgress, type AchievementsResponse } from '../shared/achievements';
import { CATCHMIND_RULES } from '../shared/balance';
import { STOCK_RULES, STOCKS } from '../shared/stocks';
import type { GameId } from '../shared/types';
import { readBalances } from './balances';
import { notify } from './notifications';
import { kstDate, valueDifference, weekStart } from './rules';

export class AchievementError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); }
}
interface Actor { id: string; role: 'player' | 'admin' }
interface Unlock { key: string; periodKey: string }

/** What a player did that may have earned something. Each caller names the
 * activity it just saw, and only the facts of that activity are read: an
 * attendance check never touches stock history, and a trade never re-reads
 * the lotto. `ACHIEVEMENT_SCOPES` (everything) is the achievements screen's
 * full re-check and the default. */
export type AchievementScope = 'profile' | 'prediction' | 'catchmind' | 'attendance' | 'kuji' | 'lotto' | 'speetto' | 'slot' | 'tag'
  | 'claw' | 'freethrow' | 'ranking' | 'stock-trade' | 'stock-market';
export const ACHIEVEMENT_SCOPES: readonly AchievementScope[] = ['profile', 'prediction', 'catchmind', 'attendance', 'kuji', 'lotto', 'speetto',
  'slot', 'tag', 'claw', 'freethrow', 'ranking', 'stock-trade', 'stock-market'];

/** Everything the rules can ask about one player. A sync reads only the facts
 * its scopes need, so every field may be missing; a missing fact unlocks
 * nothing. Repeatable facts come back as JSON arrays of the last few days. */
export interface Facts {
  nickname: number; photo: number; character: number; notifications: number;
  wake_join: number; offwork_join: number; luck_join: number;
  catchmind_guess: number; catchmind_draw: number; catchmind_misses: number;
  attend_total: number; attend_streak: number | null;
  kuji_first: number; kuji_a: number; kuji_last: number;
  lotto_first: number; lotto_win: number; speetto_win: number; slot_jackpot: number;
  tag_first: number; tag_s: number; tag_equip: number;
  tag_evolve_success: number; tag_evolve_fail: number; tag_evolve_lost: number; tag_evolve_s: number;
  claw_first: number; claw_clear: number; rank_month: number;
  rank_weeks: string; games: string; lotto_zero: string; slots: string; catchmind: string;
  freethrow_join: number; freethrow_zero: number; freethrow: string;
  stock_buy: number; stock_sell: number; stock_delisted: number;
  /** Best and worst realized gold on a single sell (null without a sell). */
  stock_best: number | null; stock_worst: number | null;
  stock_limit_up: number; stock_limit_down: number;
}
/** What a fact's SQL may bind, in the order its `?` appear. */
interface FactContext { since: string; nowMs: number; dates: string; watermark: string; tickers: string }
interface FactDefinition {
  name: keyof Facts; scope: AchievementScope; sql: string;
  binds?: (context: FactContext) => unknown[];
  /** The one-time achievements this fact alone decides. Once the player has
   * all of them the fact is not read again; a repeatable fact has none. */
  once?: readonly string[];
  /** The repeatable achievements (one row per day or week) this fact earns. */
  periodic?: readonly string[];
}

/** Limit prices in SQL, matching isLimitUp/isLimitDown in shared/stock-engine.ts:
 * floor(prev × 1.15) and ceil(prev × 0.85). */
const UP = 1 + STOCK_RULES.dailyLimit, DOWN = 1 - STOCK_RULES.dailyLimit;
const limitUpSql = (prev: string) => `CAST(${prev} * ${UP} AS INTEGER)`;
const limitDownSql = (prev: string) => `(CAST(${prev} * ${DOWN} AS INTEGER) + (${prev} * ${DOWN} > CAST(${prev} * ${DOWN} AS INTEGER)))`;
/** A limit move counts when the player held the stock that day: shares left
 * from earlier days, or a buy on the day itself. */
const heldOnDay = `(EXISTS (SELECT 1 FROM stock_trades t WHERE t.user_id = u.id AND t.ticker = c.ticker AND t.date = c.date AND t.side = 'buy')
      OR (SELECT COALESCE(SUM(CASE t.side WHEN 'buy' THEN t.quantity ELSE -t.quantity END), 0) FROM stock_trades t
        WHERE t.user_id = u.id AND t.ticker = c.ticker AND t.date < c.date) > 0)`;
const prevClose = `(SELECT p.close FROM stock_daily p WHERE p.ticker = c.ticker AND p.date < c.date ORDER BY p.date DESC LIMIT 1)`;
/** The candles still to check for one player: only of stocks they traded
 * (one index probe per listed ticker, however many trades there are), from
 * that stock's first trade on, and only days after their watermark (the last
 * finished day already checked, kept in achievement_scans). Trades and candles
 * are never back-dated, so a checked day cannot start to qualify later. */
const candlesToCheck = `json_each(?) k JOIN stock_daily c ON c.ticker = k.value AND c.date > ?
        AND c.date >= (SELECT t.date FROM stock_trades t WHERE t.user_id = u.id AND t.ticker = k.value ORDER BY t.created_at LIMIT 1)`;
/** A past limit day (CASE keeps the holding check to the rare days that hit
 * the limit), or today's live move on a stock held right now. */
const limitMoveSql = (candle: string, live: string) => `(CASE WHEN EXISTS (SELECT 1 FROM stock_trades WHERE user_id = u.id) THEN (
      EXISTS (SELECT 1 FROM ${candlesToCheck} WHERE CASE WHEN ${candle} THEN ${heldOnDay} ELSE 0 END)
      OR EXISTS (SELECT 1 FROM stock_holdings h WHERE h.user_id = u.id AND h.quantity > 0 AND EXISTS (SELECT 1 FROM stock_state s
        WHERE s.ticker = h.ticker AND s.status != 'delisted' AND s.day_open IS NOT NULL AND ${live}))) ELSE 0 END)`;
const candleBinds = (context: FactContext) => [context.tickers, context.watermark];

const exists = (name: keyof Facts, scope: AchievementScope, from: string, once: readonly string[] = [name]): FactDefinition =>
  ({ name, scope, sql: `EXISTS (SELECT 1 FROM ${from})`, once });
const FACTS: readonly FactDefinition[] = [
  { name: 'nickname', scope: 'profile', sql: 'u.display_name != u.username COLLATE NOCASE', once: ['nickname'] },
  exists('photo', 'profile', 'user_photos WHERE user_id = u.id'),
  { name: 'character', scope: 'profile', sql: 'u.character IS NOT NULL', once: ['character'] },
  { name: 'notifications', scope: 'profile', sql: 'u.notifications_seen_at IS NOT NULL', once: ['notifications'] },
  exists('wake_join', 'prediction', "predictions WHERE player_id = u.id AND game_id = 'wake'"),
  exists('offwork_join', 'prediction', "predictions WHERE player_id = u.id AND game_id = 'offwork'"),
  exists('luck_join', 'prediction', "predictions WHERE player_id = u.id AND game_id = 'luck'"),
  { name: 'games', scope: 'prediction', binds: context => [context.since, context.nowMs],
    periodic: ['wake_near', 'wake_close', 'wake_exact', 'offwork_near', 'offwork_close', 'offwork_exact', 'luck_near', 'luck_exact'],
    sql: `(SELECT json_group_array(json_object('g', r.game_id, 'd', r.round_date, 'a', r.answer, 'v', p.value))
      FROM predictions p JOIN game_rounds r ON r.game_id = p.game_id AND r.round_date = p.round_date
      WHERE p.player_id = u.id AND p.round_date >= ? AND r.answer IS NOT NULL
        AND (r.revealed_at IS NOT NULL OR r.reveal_at <= ?))` },
  exists('catchmind_guess', 'catchmind', 'catchmind_guesses WHERE player_id = u.id'),
  exists('catchmind_draw', 'catchmind', "catchmind_rounds WHERE drawer_id = u.id AND status != 'draft'"),
  exists('catchmind_misses', 'catchmind', "catchmind_rounds WHERE drawer_id = u.id AND end_reason = 'misses'"),
  { name: 'catchmind', scope: 'catchmind', binds: context => [context.since], periodic: ['catchmind_first', 'catchmind_last', 'catchmind_drawn_first'],
    sql: `(SELECT json_group_array(json_object('d', round_date, 'drawer', drawer_id = u.id, 'winner', winner_id = u.id, 'w', wrong_count))
      FROM catchmind_rounds WHERE status = 'ended' AND round_date >= ? AND winner_id IS NOT NULL
        AND (drawer_id = u.id OR winner_id = u.id))` },
  { name: 'attend_total', scope: 'attendance', sql: '(SELECT COUNT(*) FROM attendance WHERE user_id = u.id)', once: ['attend_first', 'attend_total'] },
  { name: 'attend_streak', scope: 'attendance', sql: '(SELECT MAX(streak) FROM attendance WHERE user_id = u.id)', once: ['attend_streak'] },
  exists('kuji_first', 'kuji', "shop_purchases WHERE user_id = u.id AND kind = 'kuji'"),
  exists('kuji_a', 'kuji', `shop_purchases WHERE user_id = u.id AND kind = 'kuji' AND outcome LIKE '%"grade":"A"%'`),
  exists('kuji_last', 'kuji', "shop_purchases WHERE user_id = u.id AND kind = 'kuji' AND last_one = 1"),
  exists('lotto_first', 'lotto', "shop_purchases WHERE user_id = u.id AND kind = 'lotto'"),
  exists('lotto_win', 'lotto', "shop_purchases p JOIN lotto_tickets t ON t.id = p.id WHERE p.user_id = u.id AND p.kind = 'lotto' AND t.rank = 1"),
  { name: 'lotto_zero', scope: 'lotto', binds: context => [context.since], periodic: ['lotto_zero'],
    sql: `(SELECT json_group_array(t.draw_date) FROM shop_purchases p JOIN lotto_tickets t ON t.id = p.id
      WHERE p.user_id = u.id AND p.kind = 'lotto' AND p.date >= ? AND t.matches = 0)` },
  exists('speetto_win', 'speetto', "shop_purchases WHERE user_id = u.id AND kind = 'speetto' AND json_extract(outcome, '$.won') = 1"),
  exists('slot_jackpot', 'slot', 'slot_spins WHERE user_id = u.id AND prize > 0'),
  // The slot check probes each recent date for its tenth spin, so a heavy day
  // costs ten rows rather than every spin of the day.
  { name: 'slots', scope: 'slot', binds: context => [context.dates, ACHIEVEMENT_RULES.slot.dailySpins - 1], periodic: ['slot_ten'],
    sql: `(SELECT json_group_array(d.value) FROM json_each(?) d
      WHERE EXISTS (SELECT 1 FROM slot_spins WHERE user_id = u.id AND date = d.value LIMIT 1 OFFSET ?))` },
  exists('tag_first', 'tag', 'nickname_tags WHERE user_id = u.id'),
  exists('tag_s', 'tag', "nickname_tags WHERE user_id = u.id AND grade = 'S'"),
  exists('tag_equip', 'tag', 'nickname_tags WHERE user_id = u.id AND equipped = 1'),
  exists('tag_evolve_success', 'tag', 'nickname_tag_evolutions WHERE user_id = u.id AND success = 1'),
  exists('tag_evolve_fail', 'tag', 'nickname_tag_evolutions WHERE user_id = u.id AND success = 0'),
  exists('tag_evolve_lost', 'tag', 'nickname_tag_evolutions WHERE user_id = u.id AND success = 0 AND material_lost = 1'),
  exists('tag_evolve_s', 'tag', "nickname_tag_evolutions WHERE user_id = u.id AND success = 1 AND to_grade = 'S'"),
  exists('claw_first', 'claw', 'claw_plays WHERE user_id = u.id AND caught > 0'),
  exists('claw_clear', 'claw', 'claw_plays WHERE user_id = u.id AND clear_bonus > 0'),
  exists('rank_month', 'ranking', `notifications WHERE user_id = u.id AND kind = 'rank'
      AND json_extract(payload_json, '$.period') = 'month' AND json_extract(payload_json, '$.place') <= 3`),
  { name: 'rank_weeks', scope: 'ranking', periodic: ['rank_week'],
    sql: `(SELECT json_group_array(reference) FROM notifications WHERE user_id = u.id AND kind = 'rank'
      AND json_extract(payload_json, '$.period') = 'week' AND json_extract(payload_json, '$.place') = 1)` },
  exists('freethrow_join', 'freethrow', 'freethrow_sets WHERE user_id = u.id'),
  exists('freethrow_zero', 'freethrow', `freethrow_sets WHERE user_id = u.id AND finished_at IS NOT NULL AND shots >= ${ACHIEVEMENT_RULES.freethrow.zeroMinShots} AND made = 0`),
  { name: 'freethrow', scope: 'freethrow', binds: context => [context.since], periodic: ACHIEVEMENT_RULES.freethrow.goals.map(goals => `freethrow_${goals}`),
    sql: `(SELECT json_group_array(json_object('d', date, 'm', made)) FROM freethrow_sets
      WHERE user_id = u.id AND date >= ? AND made >= ${ACHIEVEMENT_RULES.freethrow.goals[0]})` },
  // Trades. None of these walks the player's trade history: the first buy is
  // their first index entry, and sells and delistings have their own partial
  // indexes (migration 0031), which also give the best and worst sell at once.
  exists('stock_buy', 'stock-trade', "stock_trades WHERE user_id = u.id AND side = 'buy'"),
  exists('stock_sell', 'stock-trade', "stock_trades WHERE user_id = u.id AND side = 'sell'"),
  { name: 'stock_best', scope: 'stock-trade', sql: "(SELECT MAX(total - cost_basis) FROM stock_trades WHERE user_id = u.id AND side = 'sell')",
    once: ACHIEVEMENT_RULES.stockTiers.map(tier => `stock_gain_${tier}`) },
  { name: 'stock_worst', scope: 'stock-trade', sql: "(SELECT MIN(total - cost_basis) FROM stock_trades WHERE user_id = u.id AND side = 'sell')",
    once: ACHIEVEMENT_RULES.stockTiers.map(tier => `stock_loss_${tier}`) },
  // The market: what happened to stocks the player holds, whoever was looking.
  exists('stock_delisted', 'stock-market', "stock_trades WHERE user_id = u.id AND side = 'delist'"),
  { name: 'stock_limit_up', scope: 'stock-market', binds: candleBinds, once: ['stock_limit_up'],
    sql: limitMoveSql(`c.high >= ${limitUpSql(prevClose)}`, `s.day_high >= ${limitUpSql('s.prev_close')}`) },
  { name: 'stock_limit_down', scope: 'stock-market', binds: candleBinds, once: ['stock_limit_down'],
    sql: limitMoveSql(`c.low <= ${limitDownSql(prevClose)}`, `s.day_low <= ${limitDownSql('s.prev_close')}`) },
];
const LIMIT_FACTS: readonly (keyof Facts)[] = ['stock_limit_up', 'stock_limit_down'];
/** The newest finished day that has candles (trading days are shared by the
 * listed stocks; one index probe per ticker). Binds: tickers, today. */
const SCANNED_THROUGH_SQL = `(SELECT MAX((SELECT MAX(c.date) FROM stock_daily c WHERE c.ticker = k.value AND c.date < ?)) FROM json_each(?) k)`;

/** Which achievements the facts satisfy. Pure, so the rules are unit-testable. */
export function unlockedAchievements(facts: Partial<Facts>, events: ReadonlySet<string>): Unlock[] {
  const once = (key: string, satisfied: unknown) => satisfied ? [{ key, periodKey: '' }] : [];
  const list = <T>(json: string | undefined) => JSON.parse(json ?? '[]') as T[];
  const unlocks: Unlock[] = [
    ...once('welcome', true),
    ...once('nickname', facts.nickname), ...once('photo', facts.photo), ...once('character', facts.character),
    ...once('password', events.has('password')), ...once('notifications', facts.notifications),
    ...once('font_size', events.has('font_size')),
    ...once('wake_join', facts.wake_join), ...once('offwork_join', facts.offwork_join), ...once('luck_join', facts.luck_join),
    ...once('catchmind_guess', facts.catchmind_guess), ...once('catchmind_draw', facts.catchmind_draw), ...once('catchmind_misses', facts.catchmind_misses),
    ...once('attend_first', (facts.attend_total ?? 0) >= 1),
    ...once('attend_streak', (facts.attend_streak ?? 0) >= ACHIEVEMENT_RULES.attendance.streak),
    ...once('attend_total', (facts.attend_total ?? 0) >= ACHIEVEMENT_RULES.attendance.total),
    ...once('kuji_first', facts.kuji_first), ...once('kuji_a', facts.kuji_a), ...once('kuji_last', facts.kuji_last),
    ...once('lotto_first', facts.lotto_first), ...once('lotto_win', facts.lotto_win), ...once('speetto_win', facts.speetto_win),
    ...once('slot_jackpot', facts.slot_jackpot),
    ...once('tag_first', facts.tag_first), ...once('tag_s', facts.tag_s), ...once('tag_equip', facts.tag_equip),
    ...once('tag_evolve_success', facts.tag_evolve_success), ...once('tag_evolve_fail', facts.tag_evolve_fail),
    ...once('tag_evolve_lost', facts.tag_evolve_lost), ...once('tag_evolve_s', facts.tag_evolve_s),
    ...once('freethrow_join', facts.freethrow_join), ...once('freethrow_zero', facts.freethrow_zero),
    ...once('claw_first', facts.claw_first), ...once('claw_clear', facts.claw_clear), ...once('rank_month', facts.rank_month),
    ...once('stock_buy', facts.stock_buy), ...once('stock_sell', facts.stock_sell), ...once('stock_delisted', facts.stock_delisted),
    ...once('stock_limit_up', facts.stock_limit_up), ...once('stock_limit_down', facts.stock_limit_down),
    ...ACHIEVEMENT_RULES.stockTiers.flatMap(tier => [
      ...once(`stock_gain_${tier}`, (facts.stock_best ?? 0) >= tier),
      ...once(`stock_loss_${tier}`, (facts.stock_worst ?? 0) <= -tier),
    ]),
  ];
  for (const reference of list<string>(facts.rank_weeks)) {
    const week = /^notification:rank:week:(\d{4}-\d{2}-\d{2}):/.exec(reference)?.[1];
    if (week) unlocks.push({ key: 'rank_week', periodKey: week });
  }
  for (const round of list<{ g: GameId; d: string; a: string; v: string }>(facts.games)) {
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
  for (const date of list<string>(facts.lotto_zero)) unlocks.push({ key: 'lotto_zero', periodKey: date });
  // "N골 성공" means N or more goals in one official set, once per KST day of the set.
  for (const set of list<{ d: string; m: number }>(facts.freethrow)) {
    for (const goals of ACHIEVEMENT_RULES.freethrow.goals) if (set.m >= goals) unlocks.push({ key: `freethrow_${goals}`, periodKey: set.d });
  }
  // Only the dates with at least the required number of spins come back.
  for (const date of list<string>(facts.slots)) unlocks.push({ key: 'slot_ten', periodKey: date });
  for (const round of list<{ d: string | null; drawer: number; winner: number; w: number }>(facts.catchmind)) {
    if (!round.d) continue;
    if (round.winner && round.w === 0) unlocks.push({ key: 'catchmind_first', periodKey: round.d });
    if (round.winner && round.w === CATCHMIND_RULES.endAfter - 1) unlocks.push({ key: 'catchmind_last', periodKey: round.d });
    if (round.drawer && round.w === 0) unlocks.push({ key: 'catchmind_drawn_first', periodKey: round.d });
  }
  return unlocks;
}

/** Records every achievement the player has earned in `scopes` but not yet
 * been credited with, and notifies them once per row.
 *
 * It first reads the player and the rows they already hold (the one-time ones
 * and the recent periods), then only the facts still undecided: a one-time
 * achievement already held is never judged again. When something is new, one
 * batch writes the rows, their notices and the limit-move watermark together.
 * Safe to run at any time, in any scope and concurrently: both keys are UNIQUE,
 * so a retry or a twin inserts nothing twice, and a failed write leaves the
 * watermark where it was, so the next run judges the same days again. */
export async function syncAchievements(db: D1Database, userId: string, now: Date, events: Iterable<string> = [],
  scopes: readonly AchievementScope[] = ACHIEVEMENT_SCOPES): Promise<Unlock[]> {
  const since = kstDate(new Date(now.getTime() - ACHIEVEMENT_RULES.lookbackDays * 86_400_000));
  const candidates = FACTS.filter(fact => scopes.includes(fact.scope));
  const market = candidates.some(fact => LIMIT_FACTS.includes(fact.name));
  const reported = new Set(events);
  // Only the rows this sync could add are looked up (primary-key probes):
  // the one-time rows of its facts, and its repeatable rows of recent periods.
  // Weekly ranks are told by notices kept for 30 days; every other period is within the look-back.
  const periodsFrom = scopes.includes('ranking') ? kstDate(new Date(now.getTime() - 45 * 86_400_000)) : since;
  const keys = ['welcome', ...reported, ...candidates.flatMap(fact => [...fact.once ?? [], ...fact.periodic ?? []])];
  const [player, existing, scan] = await db.batch<{ key: string; period_key: string; stock_limit_date: string }>([
    db.prepare("SELECT 1 FROM users WHERE id = ? AND role = 'player' AND active = 1").bind(userId),
    db.prepare(`SELECT key, period_key FROM achievements WHERE user_id = ? AND key IN (SELECT value FROM json_each(?))
      AND (period_key = '' OR period_key >= ?)`).bind(userId, JSON.stringify(keys), periodsFrom),
    ...(market ? [db.prepare('SELECT stock_limit_date FROM achievement_scans WHERE user_id = ?').bind(userId)] : []),
  ]);
  if (!player!.results.length) return [];
  const known = new Set(existing!.results.map(item => `${item.key}:${item.period_key}`));
  const needed = candidates.filter(fact => !fact.once || fact.once.some(key => !known.has(`${key}:`)));
  const today = kstDate(now);
  const watermark = scan?.results[0]?.stock_limit_date ?? '';
  const context: FactContext = { since, nowMs: now.getTime(), watermark, tickers: JSON.stringify(STOCKS.map(stock => stock.ticker)),
    // The slot check looks at each recent date.
    dates: JSON.stringify(Array.from({ length: ACHIEVEMENT_RULES.lookbackDays + 1 }, (_, back) => kstDate(new Date(now.getTime() - back * 86_400_000)))) };
  const scanning = needed.some(fact => LIMIT_FACTS.includes(fact.name));
  let facts: Partial<Facts> & { scanned_through?: string | null } = {};
  if (needed.length) {
    const columns = needed.map(fact => `${fact.sql} AS ${fact.name}`);
    const binds = needed.flatMap(fact => fact.binds?.(context) ?? []);
    if (scanning) { columns.push(`${SCANNED_THROUGH_SQL} AS scanned_through`); binds.push(today, context.tickers); }
    facts = await db.prepare(`SELECT ${columns.join(',\n    ')}\n  FROM users u WHERE u.id = ?`).bind(...binds, userId).first<typeof facts>() ?? {};
  }
  // Several sources can earn the same row (two qualifying free-throw sets in a day): keep one.
  const fresh = unlockedAchievements(facts, reported).filter(item => {
    const id = `${item.key}:${item.periodKey}`;
    if (known.has(id)) return false;
    known.add(id);
    return true;
  });
  const scannedThrough = scanning && facts.scanned_through && facts.scanned_through > watermark ? facts.scanned_through : null;
  if (!fresh.length && !scannedThrough) return [];
  const createdAt = now.toISOString();
  await db.batch([
    ...fresh.flatMap(item => [
      db.prepare('INSERT OR IGNORE INTO achievements (user_id, key, period_key, unlocked_at) VALUES (?, ?, ?, ?)')
        .bind(userId, item.key, item.periodKey, createdAt),
      notify(db, { kind: 'achievement', audience: 'user', userId, actorId: userId,
        payload: { kind: 'achievement', key: item.key, periodKey: item.periodKey },
        reference: `notification:achievement:${userId}:${item.key}:${item.periodKey}`, createdAt }),
    ]),
    // In the same batch as the rows those days earned: the watermark never
    // passes a day whose unlock was not stored.
    ...(scannedThrough ? [db.prepare(`INSERT INTO achievement_scans (user_id, stock_limit_date) VALUES (?, ?)
      ON CONFLICT (user_id) DO UPDATE SET stock_limit_date = MAX(stock_limit_date, excluded.stock_limit_date)`).bind(userId, scannedThrough)] : []),
  ]);
  return fresh;
}

/** The same sync for several players at once (after a settlement), each
 * independently so one failure cannot hold back the others' unlocks. */
export async function syncAchievementsFor(db: D1Database, userIds: Iterable<string>, now: Date, scopes: readonly AchievementScope[] = ACHIEVEMENT_SCOPES): Promise<void> {
  await Promise.all([...new Set(userIds)].map(userId => syncAchievements(db, userId, now, [], scopes).catch(error => {
    console.error('Achievement sync failed', error instanceof Error ? error.name : 'UnknownError');
  })));
}

/** Which activities a successful player write may have completed, by its path.
 * An empty list still credits the sign-up achievement; a path that is not
 * listed here is checked in full, so a new endpoint is never silently skipped. */
export function achievementScopesFor(pathname: string): readonly AchievementScope[] {
  const exact: Record<string, readonly AchievementScope[]> = {
    '/api/me/password': [], '/api/me/profile': ['profile'], '/api/me/photo': ['profile'], '/api/me/character': ['profile'],
    '/api/me/attendance': ['attendance'],
    '/api/me/nickname-tag': ['tag'], '/api/me/nickname-tag/discard': ['tag'], '/api/me/nickname-tag/evolve': ['tag'], '/api/shop/tag': ['tag'],
    '/api/shop/kuji': ['kuji'], '/api/shop/lotto': ['lotto'], '/api/shop/speetto': ['speetto'], '/api/shop/speetto/reveal': [], '/api/shop/slot': ['slot'],
    // A buy can also be the first holding of a stock already at today's limit.
    '/api/stock/trade': ['stock-trade', 'stock-market'],
    '/api/events/launch-gift': [], '/api/ranking/results/seen': [], '/api/games/luck/photo': [], '/api/notices/read': [],
  };
  if (exact[pathname]) return exact[pathname];
  const prefixes: [string, readonly AchievementScope[]][] = [
    ['/api/games/', ['prediction']], ['/api/catchmind/', ['catchmind']], ['/api/claw/', ['claw']],
    ['/api/freethrow/', ['freethrow']], ['/api/santa/', []], ['/api/arcade/', []], ['/api/bingo', []], ['/api/toilet', []],
  ];
  return prefixes.find(([prefix]) => pathname.startsWith(prefix))?.[1] ?? ACHIEVEMENT_SCOPES;
}

/** After the close of a trading day: every player who has ever held a stock
 * is checked for what the market did to it (a limit day, a delisting), so
 * these arrive even for a player who is away. One small read per holder. */
export async function syncMarketAchievements(db: D1Database, now: Date): Promise<void> {
  const holders = (await db.prepare('SELECT DISTINCT user_id FROM stock_holdings').all<{ user_id: string }>()).results;
  await syncAchievementsFor(db, holders.map(holder => holder.user_id), now, ['stock-market']);
}

interface ProgressRow { key: string; period_key: string; unlocked_at: string; claimed_at: string | null }
/** The screen's view: current-period rows plus every unclaimed one, the
 * collected counts, and the wallet so the toolbar can show gold. */
export async function readAchievements(db: D1Database, user: Actor, now: Date, sync = true): Promise<AchievementsResponse> {
  if (sync && user.role === 'player') await syncAchievements(db, user.id, now);
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

/** Most rows one request may collect (every achievement, with room for older periods). */
const CLAIM_LIMIT = 80;
/** `POST /api/achievements/claim`: marks rows collected and pays their gold in
 * one batch. It takes one `{ key, periodKey }` or `{ claims: [...] }` for
 * 모두 받기. The ledger reference is UNIQUE, so a retried claim pays once. In a
 * list, rows already collected elsewhere are skipped; only when nothing at
 * all could be collected is it an error. */
export async function claimAchievement(db: D1Database, user: Actor, input: Record<string, unknown>, now: Date): Promise<AchievementsResponse> {
  if (user.role !== 'player') throw new AchievementError(403, 'CANNOT_CLAIM', '플레이어만 도전과제 보상을 받을 수 있어요.');
  const list: unknown[] = Array.isArray(input.claims) ? input.claims : [input];
  const seen = new Set<string>();
  const claims = list.map(item => {
    const claim = item as { key?: unknown; periodKey?: unknown } | null;
    if (!claim || !isAchievementKey(claim.key) || typeof claim.periodKey !== 'string' || claim.periodKey.length > 10) return null;
    const id = `${claim.key}:${claim.periodKey}`;
    if (seen.has(id)) return null;
    seen.add(id);
    return { definition: ACHIEVEMENT_BY_KEY.get(claim.key)!, periodKey: claim.periodKey };
  });
  if (!claims.length || claims.length > CLAIM_LIMIT || claims.includes(null)) {
    throw new AchievementError(400, 'INVALID_ACHIEVEMENT', '받을 도전과제를 확인해 주세요.');
  }
  const claimedAt = now.toISOString();
  // changes() is read by the statement right after its UPDATE, so pairs can share one batch.
  const writes = await db.batch(claims.flatMap(claim => [
    db.prepare('UPDATE achievements SET claimed_at = ? WHERE user_id = ? AND key = ? AND period_key = ? AND claimed_at IS NULL')
      .bind(claimedAt, user.id, claim!.definition.key, claim!.periodKey),
    db.prepare(`INSERT OR IGNORE INTO ledger (id, user_id, currency, amount, reason, reference, created_at)
      SELECT ?, ?, 'gold', ?, ?, ?, ? WHERE changes() = 1`)
      .bind(crypto.randomUUID(), user.id, claim!.definition.reward, `도전과제 · ${claim!.definition.title}`,
        `achievement:${claim!.definition.key}:${claim!.periodKey}:${user.id}`, claimedAt),
  ]));
  if (!claims.some((_, i) => writes[i * 2]!.meta.changes === 1)) {
    const { definition, periodKey } = claims[0]!;
    const row = await db.prepare('SELECT claimed_at FROM achievements WHERE user_id = ? AND key = ? AND period_key = ?')
      .bind(user.id, definition.key, periodKey).first<{ claimed_at: string | null }>();
    if (row) throw new AchievementError(409, 'ALREADY_CLAIMED', '이미 받은 도전과제 보상이에요.');
    throw new AchievementError(409, 'NOT_UNLOCKED', '아직 달성하지 않은 도전과제예요.');
  }
  return readAchievements(db, user, now, false);
}

/** `POST /api/achievements/events`: a client-side change the Worker cannot see
 * (the font size lives in the browser) is accepted from a short allow-list. */
export async function recordAchievementEvent(db: D1Database, user: Actor, input: Record<string, unknown>, now: Date): Promise<AchievementsResponse> {
  if (user.role !== 'player') throw new AchievementError(403, 'CANNOT_CLAIM', '플레이어만 도전과제에 참여할 수 있어요.');
  if (!(ACHIEVEMENT_RULES.clientEvents as readonly string[]).includes(input.event as string)) {
    throw new AchievementError(400, 'INVALID_EVENT', '기록할 수 없는 도전과제예요.');
  }
  // The event is the whole news here; the screen's own read re-checks the rest.
  await syncAchievements(db, user.id, now, [input.event as AchievementClientEvent], []);
  return readAchievements(db, user, now, false);
}

