/** The achievement facts query as it was before the checks were split by
 * activity (worker/achievements.ts at 87bb846), kept verbatim as the oracle
 * for tests: on the same history the scoped checks must unlock exactly what
 * this one statement did. It read every fact, the whole stock history
 * included, on every check. Binds: since, now (ms), since, dates JSON,
 * daily slot spins - 1, since, since, user id. */
import { ACHIEVEMENT_RULES } from '../../shared/achievements';
import { FREETHROW_RULES } from '../../shared/balance';
import { STOCK_RULES } from '../../shared/stocks';

/** Limit prices in SQL, matching isLimitUp/isLimitDown in shared/stock-engine.ts:
 * floor(prev × 1.15) and ceil(prev × 0.85). */
const UP = 1 + STOCK_RULES.dailyLimit, DOWN = 1 - STOCK_RULES.dailyLimit;
const limitUpSql = (prev: string) => `CAST(${prev} * ${UP} AS INTEGER)`;
const limitDownSql = (prev: string) => `(CAST(${prev} * ${DOWN} AS INTEGER) + (${prev} * ${DOWN} > CAST(${prev} * ${DOWN} AS INTEGER)))`;
/** A limit move counts when the player held the stock that day: shares left
 * from earlier days, or a buy on the day itself. Only the player's traded
 * tickers from their first trade on are read (the (ticker, date) key), and the
 * previous close is one key seek. Today's move counts from the live price. */
const heldOnDay = `(EXISTS (SELECT 1 FROM stock_trades t WHERE t.user_id = u.id AND t.ticker = c.ticker AND t.date = c.date AND t.side = 'buy')
      OR (SELECT COALESCE(SUM(CASE t.side WHEN 'buy' THEN t.quantity ELSE -t.quantity END), 0) FROM stock_trades t
        WHERE t.user_id = u.id AND t.ticker = c.ticker AND t.date < c.date) > 0)`;
const prevClose = `(SELECT p.close FROM stock_daily p WHERE p.ticker = c.ticker AND p.date < c.date ORDER BY p.date DESC LIMIT 1)`;
const myCandles = `stock_daily c WHERE c.ticker IN (SELECT ticker FROM stock_trades WHERE user_id = u.id)
        AND c.date >= (SELECT MIN(date) FROM stock_trades WHERE user_id = u.id)`;
export const LEGACY_FACTS_SQL = `SELECT
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
    EXISTS (SELECT 1 FROM nickname_tag_evolutions WHERE user_id = u.id AND success = 1) AS tag_evolve_success,
    EXISTS (SELECT 1 FROM nickname_tag_evolutions WHERE user_id = u.id AND success = 0) AS tag_evolve_fail,
    EXISTS (SELECT 1 FROM nickname_tag_evolutions WHERE user_id = u.id AND success = 0 AND material_lost = 1) AS tag_evolve_lost,
    EXISTS (SELECT 1 FROM nickname_tag_evolutions WHERE user_id = u.id AND success = 1 AND to_grade = 'S') AS tag_evolve_s,
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
    EXISTS (SELECT 1 FROM freethrow_sets WHERE user_id = u.id) AS freethrow_join,
    EXISTS (SELECT 1 FROM freethrow_sets WHERE user_id = u.id AND shots = ${FREETHROW_RULES.shotsPerSet} AND made = 0) AS freethrow_zero,
    (SELECT json_group_array(json_object('d', date, 'm', made)) FROM freethrow_sets
      WHERE user_id = u.id AND date >= ? AND made >= ${ACHIEVEMENT_RULES.freethrow.goals[0]}) AS freethrow,
    EXISTS (SELECT 1 FROM stock_trades WHERE user_id = u.id AND side = 'buy') AS stock_buy,
    EXISTS (SELECT 1 FROM stock_trades WHERE user_id = u.id AND side = 'sell') AS stock_sell,
    EXISTS (SELECT 1 FROM stock_trades WHERE user_id = u.id AND side = 'delist') AS stock_delisted,
    (SELECT MAX(total - cost_basis) FROM stock_trades WHERE user_id = u.id AND side = 'sell') AS stock_best,
    (SELECT MIN(total - cost_basis) FROM stock_trades WHERE user_id = u.id AND side = 'sell') AS stock_worst,
    (CASE WHEN EXISTS (SELECT 1 FROM stock_trades WHERE user_id = u.id) THEN (EXISTS (SELECT 1 FROM ${myCandles} AND c.high >= ${limitUpSql(prevClose)} AND ${heldOnDay})
      OR EXISTS (SELECT 1 FROM stock_holdings h WHERE h.user_id = u.id AND h.quantity > 0 AND EXISTS (SELECT 1 FROM stock_state s
        WHERE s.ticker = h.ticker AND s.status != 'delisted' AND s.day_open IS NOT NULL AND s.day_high >= ${limitUpSql('s.prev_close')}))) ELSE 0 END) AS stock_limit_up,
    (CASE WHEN EXISTS (SELECT 1 FROM stock_trades WHERE user_id = u.id) THEN (EXISTS (SELECT 1 FROM ${myCandles} AND c.low <= ${limitDownSql(prevClose)} AND ${heldOnDay})
      OR EXISTS (SELECT 1 FROM stock_holdings h WHERE h.user_id = u.id AND h.quantity > 0 AND EXISTS (SELECT 1 FROM stock_state s
        WHERE s.ticker = h.ticker AND s.status != 'delisted' AND s.day_open IS NOT NULL AND s.day_low <= ${limitDownSql('s.prev_close')}))) ELSE 0 END) AS stock_limit_down
  FROM users u WHERE u.id = ? AND u.role = 'player' AND u.active = 1`;

