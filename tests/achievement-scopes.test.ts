import { readFile, readdir } from 'node:fs/promises';
import { Miniflare } from 'miniflare';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ACHIEVEMENT_RULES } from '../shared/achievements';
import { ACHIEVEMENT_SCOPES, achievementScopesFor, syncAchievements, syncAchievementsFor, syncMarketAchievements, unlockedAchievements, type AchievementScope, type Facts } from '../worker/achievements';
import { LEGACY_FACTS_SQL } from './fixtures/legacy-achievement-facts';

type Database = Awaited<ReturnType<Miniflare['getD1Database']>>;
const NOW = new Date('2026-11-06T03:00:00Z'); // Friday 12:00 KST
const TODAY = '2026-11-06';
const day = (back: number) => new Date(Date.parse(`${TODAY}T00:00:00Z`) - back * 86_400_000).toISOString().slice(0, 10);

let migration = '';
let worker: Miniflare;
let db: Database;

async function applyMigration(database: Database, sql: string) {
  let statement = '';
  for (const sourceLine of sql.split('\n')) {
    const line = sourceLine.trim();
    if (!line || line.startsWith('--')) continue;
    statement += `${line}\n`;
    const trigger = /^CREATE TRIGGER\b/i.test(statement);
    if (line.endsWith(';') && (!trigger || /\bEND;$/i.test(line))) { await database.prepare(statement).run(); statement = ''; }
  }
}
beforeAll(async () => {
  const files = (await readdir(new URL('../migrations/', import.meta.url))).filter(file => file.endsWith('.sql')).sort();
  migration = (await Promise.all(files.map(file => readFile(new URL(`../migrations/${file}`, import.meta.url), 'utf8')))).join('\n');
});
beforeEach(async () => {
  worker = new Miniflare({ modules: true, script: 'export default { fetch() { return new Response("ok"); } };', compatibilityDate: '2026-08-06', d1Databases: ['DB'] });
  db = await worker.getD1Database('DB');
  await applyMigration(db, migration);
  for (const [id, role] of [['min', 'player'], ['siwon', 'player'], ['yeseo', 'player'], ['admin', 'admin']]) {
    await db.prepare("INSERT INTO users (id, username, display_name, password_hash, role) VALUES (?, ?, ?, 'x', ?)").bind(id, id, id, role).run();
  }
}, 60_000);
afterEach(async () => { await worker.dispose(); });

/** Counts what a function reads from D1: statements, and the rows D1 reports. */
function metered(database: Database) {
  const log: { sql: string; rowsRead: number; rowsWritten: number }[] = [];
  const record = (sql: string, meta: { rows_read?: number; rows_written?: number }) => { log.push({ sql, rowsRead: meta.rows_read ?? 0, rowsWritten: meta.rows_written ?? 0 }); };
  const sources = new WeakMap<object, { statement: D1PreparedStatement; sql: string }>();
  const wrap = (statement: D1PreparedStatement, sql: string): D1PreparedStatement => {
    const wrapped = {
      bind: (...values: unknown[]) => wrap(statement.bind(...values), sql),
      async all() { const result = await statement.all(); record(sql, result.meta); return result; },
      async run() { const result = await statement.run(); record(sql, result.meta); return result; },
      async first(column?: string) {
        const result = await statement.all<Record<string, unknown>>(); record(sql, result.meta);
        return column ? result.results[0]?.[column] ?? null : result.results[0] ?? null;
      },
    } as unknown as D1PreparedStatement;
    sources.set(wrapped, { statement, sql });
    return wrapped;
  };
  const binding = {
    prepare: (sql: string) => wrap(database.prepare(sql) as unknown as D1PreparedStatement, sql),
    async batch(statements: D1PreparedStatement[]) {
      const originals = statements.map(statement => sources.get(statement)!);
      const results = await (database as unknown as D1Database).batch(originals.map(item => item.statement));
      results.forEach((result, index) => record(originals[index]!.sql, result.meta));
      return results;
    },
  } as unknown as D1Database;
  return { binding, log, rowsRead: () => log.reduce((sum, entry) => sum + entry.rowsRead, 0),
    rowsWritten: () => log.reduce((sum, entry) => sum + entry.rowsWritten, 0), reset() { log.length = 0; } };
}
const d1 = () => db as unknown as D1Database;
const run = (sql: string, ...values: unknown[]) => db.prepare(sql).bind(...values).run();
const unlocked = async (userId = 'min') => (await db.prepare('SELECT key, period_key FROM achievements WHERE user_id = ? ORDER BY key, period_key').bind(userId)
  .all<{ key: string; period_key: string }>()).results.map(row => `${row.key}:${row.period_key}`).sort();

/** What the single pre-split statement unlocked, evaluated on the same data. */
async function legacyUnlocks(database: D1Database, userId: string, now = NOW, events: string[] = []) {
  const since = new Date(now.getTime() - ACHIEVEMENT_RULES.lookbackDays * 86_400_000 + 9 * 3_600_000).toISOString().slice(0, 10);
  const dates = Array.from({ length: ACHIEVEMENT_RULES.lookbackDays + 1 }, (_, back) => new Date(now.getTime() - back * 86_400_000 + 9 * 3_600_000).toISOString().slice(0, 10));
  const facts = await database.prepare(LEGACY_FACTS_SQL).bind(since, now.getTime(), since, JSON.stringify(dates), ACHIEVEMENT_RULES.slot.dailySpins - 1, since, since, userId).first<Facts>();
  return [...new Set(unlockedAchievements(facts!, new Set(events)).map(item => `${item.key}:${item.periodKey}`))].sort();
}

/** A player who did a little of everything, late results and market events included. */
async function seedHistory(userId = 'min') {
  const at = (date: string, time = '01:00:00') => `${date}T${time}.000Z`;
  await db.batch([
    db.prepare("UPDATE users SET display_name = '민이', character = 'cat', notifications_seen_at = ? WHERE id = ?").bind(at(day(1)), userId),
    db.prepare("INSERT INTO user_photos (user_id, mime, data, updated_at) VALUES (?, 'image/webp', X'00', ?)").bind(userId, at(day(1))),
    // Predictions: an exact wake two days ago, a near luck yesterday, an unrevealed one today, an old one outside the look-back.
    ...([['wake', day(2), '08:00:00', '08:00:00', 1], ['luck', day(1), '50', '52', 1], ['offwork', TODAY, '18:00:00', '18:00:30', 0], ['offwork', day(9), '18:00:00', '18:00:00', 1]] as const)
      .flatMap(([game, date, answer, value, revealed]) => [
        db.prepare('INSERT INTO game_rounds (game_id, round_date, answer, revealed_at, updated_at) VALUES (?, ?, ?, ?, 0)').bind(game, date, answer, revealed ? Date.parse(at(date)) : null),
        db.prepare('INSERT INTO predictions (game_id, round_date, player_id, value, updated_at) VALUES (?, ?, ?, ?, 0)').bind(game, date, userId, value),
      ]),
    // Attendance: 100 days, with a 30-day streak at the end.
    db.prepare(`INSERT INTO attendance (user_id, date, streak, created_at) SELECT ?, date(?, '-' || value || ' days'), MAX(1, 31 - value), ? FROM json_each(?)`)
      .bind(userId, TODAY, at(TODAY), JSON.stringify(Array.from({ length: 100 }, (_, index) => index))),
    // Shop: a kuji with an A and the last one, a first-prize lotto, a blank lotto yesterday, a winning speetto.
    db.prepare(`INSERT INTO shop_purchases (id, user_id, request_id, kind, request_payload, payment, cost, date, created_at, outcome, last_one) VALUES
      ('k1', ?1, 'k1', 'kuji', '{}', 'gold', 100, ?2, ?3, '{"cells":[{"position":1,"grade":"A"}]}', 1),
      ('l1', ?1, 'l1', 'lotto', '{}', 'gold', 500, ?4, ?3, '{}', 0), ('l2', ?1, 'l2', 'lotto', '{}', 'gold', 500, ?4, ?3, '{}', 0),
      ('s1', ?1, 's1', 'speetto', '{}', 'gold', 300, ?2, ?3, '{"won":true,"prize":1500}', 0)`).bind(userId, day(5), at(day(5)), day(1)),
    db.prepare("INSERT INTO lotto_tickets (id, draw_date, numbers, settled_at, matches, rank, prize) VALUES ('l1', ?, '[]', 'x', 5, 1, 5000), ('l2', ?, '[]', 'x', 0, NULL, 0)").bind(day(1), day(1)),
    // Slot: a jackpot long ago, ten spins today.
    db.prepare(`INSERT INTO slot_spins (id, user_id, request_id, cost, reels, prize, date, created_at) SELECT 'spin' || value, ?, 'spin' || value, 500, '[]', 0, ?, ? FROM json_each('[1,2,3,4,5,6,7,8,9,10]')`).bind(userId, TODAY, at(TODAY)),
    db.prepare("INSERT INTO slot_spins (id, user_id, request_id, cost, reels, prize, date, created_at) VALUES ('jack', ?, 'jack', 500, '[]', 2000, ?, ?)").bind(userId, day(20), at(day(20))),
    // Tags: an S worn now, and evolutions that succeeded, failed and lost the material.
    db.prepare(`INSERT INTO nickname_tags (id, user_id, request_id, grade, text, equipped, date, created_at, payment, discarded) VALUES
      ('t1', ?1, 't1', 'S', '전설적인', 1, ?2, ?3, 'gold', 0), ('t2', ?1, 't2', 'C', '배가 고픈', 0, ?2, ?3, 'gold', 1), ('t3', ?1, 't3', 'B', '배가 고픈', 0, ?2, ?3, 'gold', 0)`).bind(userId, day(3), at(day(3))),
    db.prepare(`INSERT INTO nickname_tag_evolutions (id, user_id, request_id, base_id, material_id, text, from_grade, to_grade, material_grade, chance, success, material_lost, cost, date, created_at) VALUES
      ('e1', ?1, 'e1', 't3', 't2', '배가 고픈', 'C', 'B', 'C', 30, 1, 1, 0, ?2, ?3), ('e2', ?1, 'e2', 't3', 't2', '배가 고픈', 'B', 'A', 'C', 15, 0, 1, 0, ?2, ?3)`).bind(userId, day(3), at(day(3))),
    db.prepare(`INSERT INTO claw_plays (id, user_id, request_id, generation, version, claw_x, stop, caught, score, gold, clear_bonus, result_json, created_at) VALUES
      ('c1', ?, 'c1', 1, 1, 0.5, NULL, 2, 2, 20, 0, '{}', ?)`).bind(userId, at(day(4))),
    // Free throws: a zero set once, a seven-goal set yesterday.
    db.prepare("INSERT INTO freethrow_sets (id, user_id, request_id, slot, date, engine, shots, made, created_at) VALUES ('f1', ?1, 'f1', 1, ?2, 1, 10, 0, ?3), ('f2', ?1, 'f2', 2, ?4, 1, 10, 7, ?5)")
      .bind(userId, day(30), at(day(30)), day(1), at(day(1))),
    // Catchmind: drew a round solved at the first guess two days ago, and one that ended on misses.
    db.prepare(`INSERT INTO catchmind_rounds (id, number, drawer_id, word, normalized_word, word_history, status, round_date, published_at, ended_at, wrong_count, winner_id, end_reason, created_at) VALUES
      ('r1', 1, ?1, '가', '가', '[]', 'ended', ?2, ?3, ?3, 0, 'siwon', 'correct', ?3), ('r2', 2, ?1, '나', '나', '[]', 'ended', ?2, ?3, ?3, 10, NULL, 'misses', ?3),
      ('r3', 3, 'siwon', '다', '다', '[]', 'ended', ?4, ?5, ?5, 9, ?1, 'correct', ?5)`).bind(userId, day(2), at(day(2)), day(1), at(day(1))),
    db.prepare("INSERT INTO catchmind_requests (id, user_id, request_id, action, round_id, result_round_id, payload_hash, created_at) VALUES ('g1', ?, 'g1', 'guess', 'r3', 'r3', 'h', ?)").bind(userId, at(day(1))),
    db.prepare("INSERT INTO catchmind_guesses (id, round_id, player_id, answer, normalized_answer, correct, created_at) VALUES ('g1', 'r3', ?, '다', '다', 1, ?)").bind(userId, at(day(1))),
    // Ranking: first of last week, third of last month.
    db.prepare(`INSERT INTO notifications (kind, audience, user_id, actor_id, payload_json, created_at, reference) VALUES
      ('rank', 'user', ?1, ?1, '{"kind":"rank","period":"week","place":1,"gold":300}', ?2, 'notification:rank:week:2026-10-26:' || ?1),
      ('rank', 'user', ?1, ?1, '{"kind":"rank","period":"month","place":3,"gold":200}', ?2, 'notification:rank:month:2026-10:' || ?1)`).bind(userId, at(day(4))),
  ]);
}
/** Stock history: trades with gains and losses, a delisting, and limit days held and not held. */
async function seedStocks(userId = 'min') {
  const trade = (id: string, ticker: string, side: string, quantity: number, total: number, costBasis: number, date: string) => db.prepare(`INSERT INTO stock_trades
    (id, user_id, request_id, ticker, side, quantity, price, fee, total, cost_basis, date, created_at) VALUES (?, ?, ?, ?, ?, ?, 1, 0, ?, ?, ?, ?)`)
    .bind(`${userId}-${id}`, userId, id, ticker, side, quantity, total, costBasis, date, `${date}T01:00:00.000Z`);
  const candle = (ticker: string, date: string, open: number, high: number, low: number, close: number) =>
    db.prepare('INSERT OR REPLACE INTO stock_daily (ticker, date, open, high, low, close) VALUES (?, ?, ?, ?, ?, ?)').bind(ticker, date, open, high, low, close);
  await db.batch([
    trade('b1', 'MDRG', 'buy', 5, 5000, 5000, day(20)), trade('s1', 'MDRG', 'sell', 2, 4600, 2000, day(18)), // +2,600
    trade('b2', 'DWSC', 'buy', 3, 3900, 3900, day(20)), trade('s2', 'DWSC', 'sell', 3, 2700, 3900, day(17)), // -1,200
    trade('b3', 'RIAN', 'buy', 4, 1600, 1600, day(15)), trade('d3', 'RIAN', 'delist', 4, 0, 1600, day(10)),
    // SOAR: bought on a day it later hit the upper limit; sold out before a later upper-limit day.
    trade('b4', 'SOAR', 'buy', 2, 1500, 1500, day(12)), trade('s4', 'SOAR', 'sell', 2, 1700, 1500, day(11)),
    candle('SOAR', day(13), 750, 760, 740, 750), candle('SOAR', day(12), 760, 862, 760, 862), candle('SOAR', day(8), 862, 1000, 862, 990),
    // MDRG (3 left since day 20): a lower-limit day on day 6. YKHX hit a limit but was never traded.
    candle('MDRG', day(7), 1000, 1010, 990, 1000), candle('MDRG', day(6), 990, 995, 850, 860),
    candle('YKHX', day(7), 1500, 1500, 1500, 1500), candle('YKHX', day(6), 1500, 1725, 1500, 1725),
    db.prepare("INSERT INTO stock_holdings (user_id, ticker, quantity, cost_basis) VALUES (?, 'MDRG', 3, 3000)").bind(userId),
  ]);
}

describe('achievement checks by activity', () => {
  it('unlocks exactly what the single pre-split query unlocked on the same history, in one full check or scope by scope', async () => {
    await seedHistory();
    await seedStocks();
    const legacy = await legacyUnlocks(d1(), 'min', NOW, ['password', 'font_size']);
    // The history really exercises every group, the repeatable ones included.
    for (const key of ['welcome:', 'nickname:', 'photo:', 'character:', 'notifications:', 'password:', 'font_size:', 'wake_join:', `wake_exact:${day(2)}`, `luck_near:${day(1)}`,
      'attend_first:', 'attend_streak:', 'attend_total:', 'kuji_a:', 'kuji_last:', 'lotto_win:', `lotto_zero:${day(1)}`, 'speetto_win:', 'slot_jackpot:', `slot_ten:${TODAY}`,
      'tag_s:', 'tag_equip:', 'tag_evolve_success:', 'tag_evolve_lost:', 'claw_first:', 'freethrow_zero:', `freethrow_5:${day(1)}`, 'catchmind_misses:', `catchmind_drawn_first:${day(2)}`,
      `catchmind_last:${day(1)}`, 'rank_week:2026-10-26', 'rank_month:', 'stock_buy:', 'stock_sell:', 'stock_gain_2000:', 'stock_loss_1000:', 'stock_delisted:', 'stock_limit_up:', 'stock_limit_down:']) {
      expect(legacy, key).toContain(key);
    }
    expect(legacy).not.toContain('stock_gain_5000:');
    expect(legacy).not.toContain(`offwork_exact:${day(9)}`);

    // One full check (the achievements screen).
    const fresh = await syncAchievements(d1(), 'min', NOW, ['password', 'font_size']);
    expect(fresh.map(item => `${item.key}:${item.periodKey}`).sort()).toEqual(legacy);
    expect(await unlocked()).toEqual(legacy);
    const notices = await db.prepare("SELECT COUNT(*) AS n FROM notifications WHERE kind = 'achievement' AND user_id = 'min'").first('n');
    expect(notices).toBe(legacy.length);
    // Checking again, in full or by scope, finds nothing more and writes nothing twice.
    expect(await syncAchievements(d1(), 'min', NOW, ['password', 'font_size'])).toEqual([]);
    for (const scope of ACHIEVEMENT_SCOPES) expect(await syncAchievements(d1(), 'min', NOW, [], [scope]), scope).toEqual([]);
    expect(await db.prepare("SELECT COUNT(*) AS n FROM notifications WHERE kind = 'achievement' AND user_id = 'min'").first('n')).toBe(notices);

    // The same history checked one activity at a time (as the writes arrive) ends in the same place.
    await db.batch([db.prepare('DELETE FROM achievements'), db.prepare('DELETE FROM achievement_scans')]);
    const byScope: string[] = [];
    for (const scope of ACHIEVEMENT_SCOPES) {
      const before = new Set(await unlocked());
      const got = await syncAchievements(d1(), 'min', NOW, scope === 'profile' ? ['password', 'font_size'] : [], [scope]);
      for (const item of got) {
        expect(before.has(`${item.key}:${item.periodKey}`), `${scope} ${item.key}`).toBe(false);
        byScope.push(`${item.key}:${item.periodKey}`);
      }
    }
    expect(byScope.sort()).toEqual(legacy);
    expect(await unlocked()).toEqual(legacy);
  });

  it('reads only the activity it is asked about: no stock table for attendance or profile, and nothing once everything is unlocked', async () => {
    await seedHistory();
    await seedStocks();
    const meter = metered(db);
    const touched = () => meter.log.map(entry => entry.sql).join('\n');
    for (const scope of ['attendance', 'profile', 'tag', 'slot', 'lotto', 'prediction'] as AchievementScope[]) {
      meter.reset();
      await syncAchievements(meter.binding, 'min', NOW, [], [scope]);
      expect(touched(), scope).not.toMatch(/stock_/);
    }
    meter.reset();
    await syncAchievements(meter.binding, 'min', NOW, [], ['attendance']);
    // Everything attendance can give is unlocked: the player and their three rows are read, no fact at all.
    expect(meter.log.map(entry => entry.sql).filter(sql => /FROM users u/.test(sql))).toEqual([]);
    expect(meter.log).toHaveLength(2);
    expect(meter.rowsRead()).toBeLessThanOrEqual(20);
    expect(meter.rowsWritten()).toBe(0);
    // A player with nothing yet: the attendance facts are read, and only those.
    meter.reset();
    await run("INSERT INTO attendance (user_id, date, streak, created_at) VALUES ('siwon', ?, 1, 'x')", TODAY);
    expect((await syncAchievements(meter.binding, 'siwon', NOW, [], ['attendance'])).map(item => item.key).sort()).toEqual(['attend_first', 'welcome']);
    const facts = meter.log.find(entry => /FROM users u/.test(entry.sql))!.sql;
    expect(facts).toMatch(/attend_total/);
    expect(facts).not.toMatch(/stock_|slot_spins|shop_purchases|nickname_tags|predictions/);
    // An administrator or an unknown account is never credited.
    expect(await syncAchievements(d1(), 'admin', NOW)).toEqual([]);
    expect(await syncAchievements(d1(), 'nobody', NOW)).toEqual([]);
    expect(await unlocked('admin')).toEqual([]);
  });

  it('keeps every check independent of the trade history: 0, 1,000 and 10,000 trades cost the same rows', async () => {
    await seedHistory();
    // 60 trading days of candles for every listed stock, no limit day among them.
    const tickers = ['YKHX', 'SIWN', 'MINJ', 'YEDO', 'DWSC', 'MDRG', 'SOAR', 'EEVA', 'RIAN', 'YEGM', 'GEUU', 'PZUV', 'GURO', 'GOOG', 'AMAZ'];
    await run(`INSERT INTO stock_daily (ticker, date, open, high, low, close) SELECT t.value, date(?, '-' || d.value || ' days'), 1000, 1010, 990, 1000 FROM json_each(?) t, json_each(?) d`,
      TODAY, JSON.stringify(tickers), JSON.stringify(Array.from({ length: 60 }, (_, index) => index + 1)));
    /** Adds trades up to `total`: buys and small-gain sells of four stocks, spread over 50 days. */
    let trades = 0;
    const tradeUpTo = async (total: number) => {
      for (; trades < total; trades += 500) {
        await run(`INSERT INTO stock_trades (id, user_id, request_id, ticker, side, quantity, price, fee, total, cost_basis, date, created_at)
          SELECT 'bulk' || value, 'min', 'bulk' || value, CASE value % 4 WHEN 0 THEN 'YKHX' WHEN 1 THEN 'SIWN' WHEN 2 THEN 'MINJ' ELSE 'YEDO' END,
            CASE WHEN value % 8 < 4 THEN 'buy' ELSE 'sell' END, 1, 1000, 10, 1000 + (value % 7) * 10, 1000,
            date(?, '-' || (50 - value % 50) || ' days'), date(?, '-' || (50 - value % 50) || ' days') || 'T01:00:' || printf('%02d', value % 60) || '.' || printf('%03d', value % 1000) || 'Z'
          FROM json_each(?)`, TODAY, TODAY, JSON.stringify(Array.from({ length: Math.min(500, total - trades) }, (_, index) => trades + index)));
      }
    };
    const meter = metered(db);
    const cost = async (label: string, check: () => Promise<unknown>) => { meter.reset(); await check(); return [label, meter.rowsRead()] as const; };
    const measure = async () => {
      // First bring the player up to date; then measure checks that find nothing new.
      await syncAchievements(d1(), 'min', NOW);
      const scoped = (scopes: AchievementScope[]) => () => syncAchievements(meter.binding, 'min', NOW, [], scopes);
      return Object.fromEntries([
        await cost('legacy single query', () => meter.binding.prepare(LEGACY_FACTS_SQL)
          .bind(day(3), NOW.getTime(), day(3), '[]', ACHIEVEMENT_RULES.slot.dailySpins - 1, day(3), day(3), 'min').first()),
        await cost('attendance', scoped(['attendance'])), await cost('profile', scoped(['profile'])), await cost('slot', scoped(['slot'])),
        await cost('stock trade', scoped(['stock-trade', 'stock-market'])), await cost('market', scoped(['stock-market'])),
        await cost('full check', scoped([...ACHIEVEMENT_SCOPES])),
      ]) as Record<string, number>;
    };
    const table: Record<string, Record<string, number>> = {};
    for (const total of [0, 1000, 10_000]) {
      await tradeUpTo(total);
      expect(await db.prepare("SELECT COUNT(*) AS n FROM stock_trades WHERE user_id = 'min'").first('n')).toBe(total);
      table[String(total)] = await measure();
      // The scoped checks and the old query agree on this history too.
      expect(await unlocked()).toEqual(await legacyUnlocks(d1(), 'min'));
    }
    console.info(`Achievement check D1 rows_read by trade count: ${JSON.stringify(table)}`);
    // The old query grew with the trades (about seven scans of them).
    expect(table['10000']!['legacy single query']).toBeGreaterThan(table['1000']!['legacy single query']! * 5);
    expect(table['10000']!['legacy single query']).toBeGreaterThan(50_000);
    // Unrelated activities never see the trades at all.
    for (const scope of ['attendance', 'profile', 'slot']) {
      expect(table['1000']![scope], scope).toBe(table['0']![scope]);
      expect(table['10000']![scope], scope).toBe(table['0']![scope]);
    }
    // The stock checks and the full check (the achievements screen) do not grow from 1,000 to 10,000 trades.
    for (const scope of ['stock trade', 'market', 'full check']) {
      expect(table['10000']![scope], scope).toBeLessThanOrEqual(table['1000']![scope]! + 2);
      expect(table['10000']![scope], scope).toBeLessThan(500);
    }
    expect(table['10000']!['stock trade']).toBeLessThan(200);

    // Their plans: the two ends of the gain index, and the delisting index.
    const plan = async (sql: string) => (await db.prepare(`EXPLAIN QUERY PLAN ${sql}`).bind('min').all<{ detail: string }>()).results.map(row => row.detail).join(' | ');
    expect(await plan("SELECT MAX(total - cost_basis) FROM stock_trades WHERE user_id = ? AND side = 'sell'")).toContain('stock_trades_gain_idx');
    expect(await plan("SELECT MIN(total - cost_basis) FROM stock_trades WHERE user_id = ? AND side = 'sell'")).toContain('stock_trades_gain_idx');
    expect(await plan("SELECT EXISTS (SELECT 1 FROM stock_trades WHERE user_id = ? AND side = 'delist')")).toContain('stock_trades_delist_idx');
  }, 120_000);

  it('credits what the market did while the player was away, once, and never checks a finished day twice', async () => {
    await seedStocks();
    const scan = () => db.prepare("SELECT stock_limit_date FROM achievement_scans WHERE user_id = 'min'").first<string>('stock_limit_date');
    // Nothing the player does: the close-of-day check finds the delisting and both limit days.
    await syncMarketAchievements(d1(), NOW);
    expect(await unlocked()).toEqual(['stock_delisted:', 'stock_limit_down:', 'stock_limit_up:', 'welcome:']);
    expect(await unlocked('siwon')).toEqual([]);
    expect(await scan()).toBe(day(6));
    // Run again (a retried Cron): nothing new, nothing written.
    const meter = metered(db);
    await syncMarketAchievements(meter.binding, NOW);
    expect(meter.rowsWritten()).toBe(0);

    // siwon holds GEUU through an upper-limit day that finished yesterday, and YKHX only after its limit day.
    await db.batch([
      db.prepare("INSERT INTO stock_trades (id, user_id, request_id, ticker, side, quantity, price, fee, total, cost_basis, date, created_at) VALUES ('sg', 'siwon', 'sg', 'GEUU', 'buy', 1, 500, 5, 505, 505, ?, ?), ('sy', 'siwon', 'sy', 'YKHX', 'buy', 1, 1725, 18, 1743, 1743, ?, ?)")
        .bind(day(3), `${day(3)}T01:00:00.000Z`, day(5), `${day(5)}T01:00:00.000Z`),
      db.prepare("INSERT INTO stock_holdings (user_id, ticker, quantity, cost_basis) VALUES ('siwon', 'GEUU', 1, 505), ('siwon', 'YKHX', 1, 1743)"),
      db.prepare("INSERT INTO stock_daily (ticker, date, open, high, low, close) VALUES ('GEUU', ?, 500, 500, 500, 500), ('GEUU', ?, 500, 575, 500, 575)").bind(day(2), day(1)),
    ]);
    await syncMarketAchievements(d1(), NOW);
    // GEUU counts; YKHX's limit day (day 6) was before siwon's first trade of it.
    expect(await unlocked('siwon')).toEqual(['stock_limit_up:', 'welcome:']);
    expect(await db.prepare("SELECT stock_limit_date FROM achievement_scans WHERE user_id = 'siwon'").first('stock_limit_date')).toBe(day(1));
    // min has both limit achievements already: their candles are not read any more, so the watermark rests.
    expect(await scan()).toBe(day(6));
    expect(await unlocked()).toEqual(['stock_delisted:', 'stock_limit_down:', 'stock_limit_up:', 'welcome:']);

    // Today's live move on a stock held now counts at once (no candle yet), and today is never marked as checked.
    await db.batch([
      db.prepare("UPDATE stock_state SET prev_close = 1000, day_open = 990, day_high = 995, day_low = 850, price = 850 WHERE ticker = 'GEUU'"),
    ]);
    await syncAchievements(d1(), 'siwon', NOW, [], ['stock-market']);
    expect(await unlocked('siwon')).toEqual(['stock_limit_down:', 'stock_limit_up:', 'welcome:']);
    expect(await db.prepare("SELECT stock_limit_date FROM achievement_scans WHERE user_id = 'siwon'").first('stock_limit_date')).toBe(day(1));

    // Re-verification: forgetting the watermark only makes the next check read the candles again.
    await db.batch([db.prepare('DELETE FROM achievement_scans'), db.prepare("DELETE FROM achievements WHERE key LIKE 'stock_limit_%'")]);
    await syncMarketAchievements(d1(), NOW);
    expect(await unlocked()).toEqual(['stock_delisted:', 'stock_limit_down:', 'stock_limit_up:', 'welcome:']);
    expect(await unlocked('siwon')).toEqual(['stock_limit_down:', 'stock_limit_up:', 'welcome:']);
  });

  it('survives a failed write, concurrent checks and retries without a missing or a second row', async () => {
    await seedHistory();
    await seedStocks();
    const expected = await legacyUnlocks(d1(), 'min');
    // The write batch fails once: nothing is stored, the watermark included.
    let failures = 1;
    const flaky = new Proxy(d1(), { get(target, key) {
      const value = Reflect.get(target, key);
      if (key === 'batch') return async (statements: D1PreparedStatement[]) => {
        if (statements.length > 3 && failures-- > 0) throw new Error('D1_ERROR: simulated write failure');
        return target.batch(statements);
      };
      return typeof value === 'function' ? value.bind(target) : value;
    } });
    await expect(syncAchievements(flaky, 'min', NOW)).rejects.toThrow('simulated write failure');
    expect(await unlocked()).toEqual([]);
    expect(await db.prepare('SELECT COUNT(*) AS n FROM achievement_scans').first('n')).toBe(0);
    // syncAchievementsFor swallows a player's failure and still serves the others.
    failures = 1;
    await syncAchievementsFor(flaky, ['min', 'siwon'], NOW);
    expect((await unlocked()).length + (await unlocked('siwon')).length).toBeGreaterThan(0);

    // Many checks at once, in full and by scope, then a retry: one row and one notice each.
    await Promise.all([
      ...Array.from({ length: 4 }, () => syncAchievements(d1(), 'min', NOW)),
      ...ACHIEVEMENT_SCOPES.map(scope => syncAchievements(d1(), 'min', NOW, [], [scope])),
    ]);
    await syncAchievements(d1(), 'min', NOW);
    expect(await unlocked()).toEqual(expected);
    const notices = (await db.prepare("SELECT reference, COUNT(*) AS n FROM notifications WHERE kind = 'achievement' AND user_id = 'min' GROUP BY reference").all<{ n: number }>()).results;
    expect(notices).toHaveLength(expected.length);
    expect(notices.every(row => row.n === 1)).toBe(true);
  });

  it('maps each write to its activity and checks an unlisted path in full', () => {
    expect(achievementScopesFor('/api/me/attendance')).toEqual(['attendance']);
    expect(achievementScopesFor('/api/me/profile')).toEqual(['profile']);
    expect(achievementScopesFor('/api/me/password')).toEqual([]);
    expect(achievementScopesFor('/api/shop/slot')).toEqual(['slot']);
    expect(achievementScopesFor('/api/shop/tag')).toEqual(['tag']);
    expect(achievementScopesFor('/api/me/nickname-tag/evolve')).toEqual(['tag']);
    expect(achievementScopesFor('/api/games/wake/prediction')).toEqual(['prediction']);
    expect(achievementScopesFor('/api/catchmind/guess')).toEqual(['catchmind']);
    expect(achievementScopesFor('/api/claw/play')).toEqual(['claw']);
    expect(achievementScopesFor('/api/freethrow/finish')).toEqual(['freethrow']);
    expect(achievementScopesFor('/api/stock/trade')).toEqual(['stock-trade', 'stock-market']);
    expect(achievementScopesFor('/api/santa/finish')).toEqual([]);
    // Only the trade and the unknown path can reach the stock facts.
    for (const path of ['/api/me/attendance', '/api/me/profile', '/api/me/photo', '/api/me/character', '/api/shop/kuji', '/api/shop/lotto', '/api/shop/speetto', '/api/shop/slot',
      '/api/shop/tag', '/api/games/luck/answer', '/api/catchmind/publish', '/api/claw/coins', '/api/freethrow/sets']) {
      expect(achievementScopesFor(path).some(scope => scope.startsWith('stock')), path).toBe(false);
    }
    expect(achievementScopesFor('/api/some/new/endpoint')).toEqual(ACHIEVEMENT_SCOPES);
  });
});
