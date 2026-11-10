import { spawnSync } from 'node:child_process';
import { chmod, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ATTENDANCE_RULES, CLAW_RULES, KUJI_RULES } from '../shared/balance';
import { defaultPredictionRules } from '../shared/game-settings';
import type { AttendanceClaimResponse, BootstrapResponse, ClawResponse, KujiResponse } from '../shared/types';
import { hashToken } from '../worker/crypto';

type Database = Awaited<ReturnType<Miniflare['getD1Database']>>;
const root = fileURLToPath(new URL('..', import.meta.url));
const cleared = ['ledger', 'attendance', 'game_rounds', 'predictions', 'inventory_ledger', 'user_balances', 'shop_purchases',
  'kuji_claims', 'kuji_boards', 'lotto_tickets', 'lotto_draws', 'catchmind_guesses', 'catchmind_requests', 'catchmind_used_words',
  'catchmind_rounds', 'claw_plays', 'claw_coin_purchases', 'claw_accounts', 'login_attempts', 'announcements', 'luck_photos'];
// The launch-era reset does not cover the later slot-machine receipts.
// Post-launch records (slot receipts, nickname tags) are outside the launch-era reset.
const preserved = ['users', 'sessions', 'd1_migrations', 'claw_config', 'user_photos', 'game_settings', 'admin_changes', 'slot_spins', 'nickname_tags',
  // Nickname draw tickets (0018) are granted after launch, so the launch-era reset leaves them alone.
  'tag_ticket_ledger',
  // Ranking payouts (0019) start after launch too; their settlement markers stay.
  'ranking_settlements',
  // The notification centre (0020) and achievements (0021) are newer than the launch-era reset as well.
  'notifications', 'achievements',
  // The stock market (0015) starts after launch; a launch reset never touches it.
  'stock_state', 'stock_ticks', 'stock_daily', 'stock_events', 'stock_news', 'stock_holdings', 'stock_trades', 'market_holidays', 'ai_usage', 'stock_settings',
  // Free-throw official sets (0026) are newer than the launch-era reset.
  'freethrow_sets', 'freethrow_shots',
  // Ranking result snapshots (0027) sit beside their settlement markers.
  'ranking_results',
  // The Christmas gift delivery (0028) is newer than the launch-era reset.
  'santa_runs', 'santa_drops'];
const appendOnly = ['ledger_no_update', 'ledger_no_delete', 'inventory_no_update', 'inventory_no_delete'];
const now = Date.parse('2026-11-02T00:00:00Z');
const token = 'ca'.repeat(32);

// Keep trigger bodies intact, as Wrangler's local --file does before D1 batch().
function statements(sql: string): string[] {
  const result: string[] = [];
  let statement = '';
  for (const source of sql.split('\n')) {
    const line = source.trim();
    if (!line || line.startsWith('--')) continue;
    statement += `${line}\n`;
    if (line.endsWith(';') && (!/^CREATE TRIGGER\b/i.test(statement) || /\bEND;$/i.test(line))) {
      result.push(statement);
      statement = '';
    }
  }
  if (statement.trim()) throw new Error('Incomplete SQL statement');
  return result;
}

describe('launch reset in an isolated local D1', () => {
  let worker: Miniflare;
  let db: Database;
  let script: string;
  let reset: string[];
  let migrations: { name: string; sql: string }[];

  beforeAll(async () => {
    reset = statements(await readFile(new URL('../scripts/launch-reset.sql', import.meta.url), 'utf8'));
    const files = (await readdir(new URL('../migrations/', import.meta.url))).filter(file => file.endsWith('.sql')).sort();
    migrations = await Promise.all(files.map(async name => ({ name, sql: await readFile(new URL(`../migrations/${name}`, import.meta.url), 'utf8') })));
    const result = await build({
      entryPoints: [join(root, 'worker/index.ts')], bundle: true, format: 'esm', platform: 'browser', write: false,
      define: { Date: 'TestDate' },
      banner: { js: `class TestDate extends Date { constructor(...args) { super(...(args.length ? args : [${now}])); } static now() { return ${now}; } }` },
    });
    script = result.outputFiles[0]!.text.replaceAll("unixepoch('now') * 1000", String(now));
  });

  beforeEach(async () => {
    await worker?.dispose();
    worker = new Miniflare({ modules: true, script, compatibilityDate: '2026-08-06', d1Databases: ['DB'] });
    db = await worker.getD1Database('DB');
    for (const migration of migrations) await db.batch(statements(migration.sql).map(sql => db.prepare(sql)));
    await db.prepare('CREATE TABLE d1_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL)').run();
    for (const migration of migrations) await db.prepare('INSERT INTO d1_migrations (name) VALUES (?)').bind(migration.name).run();
    const profileBytes = Array.from(await readFile(new URL('./fixtures/photo-square.webp', import.meta.url)));
    await db.batch([
      db.prepare("INSERT INTO users (id, username, display_name, password_hash, role, active, character) VALUES ('min', 'min', '민', 'unchanged-player-password', 'player', 1, 'moon'), ('admin', 'admin', '관리자', 'unchanged-admin-password', 'admin', 1, 'cat'), ('inactive', 'inactive', '휴면', 'unchanged-inactive-password', 'player', 0, NULL)"),
      db.prepare('INSERT INTO sessions (token_hash, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)').bind(await hashToken(token), 'min', now + 86400000, now - 86400000),
      db.prepare("INSERT INTO sessions (token_hash, user_id, expires_at, created_at) VALUES ('admin-session', 'admin', ?, ?)").bind(now + 86400000, now - 86400000),
      db.prepare("UPDATE claw_config SET payout_every = 17, weak_pickup = 39, weak_carry = 21, updated_at = '2026-10-31T07:00:00Z'"),
      db.prepare("INSERT INTO game_settings (game_id, effective_from, settings_json, created_at, created_by) VALUES ('luck', '2026-11-03', ?, '2026-11-02T00:00:00Z', 'admin')").bind(JSON.stringify({ ...defaultPredictionRules('luck'), participationGold: 125 })),
      db.prepare("INSERT INTO admin_changes (id, admin_id, target, before_json, after_json, effective_from, created_at) VALUES ('retained-change', 'admin', 'game:luck', ?, ?, '2026-11-03', '2026-11-02T00:00:00Z')").bind(JSON.stringify(defaultPredictionRules('luck')), JSON.stringify({ ...defaultPredictionRules('luck'), participationGold: 125 })),
      db.prepare("UPDATE users SET photo_version = 7 WHERE id = 'min'"),
      db.prepare("INSERT INTO user_photos (user_id, mime, data, updated_at) VALUES ('min', 'image/webp', ?, '2026-11-01T00:00:00Z')").bind(profileBytes),
      db.prepare("INSERT INTO luck_photos (round_date, mime, data, version, updated_at) VALUES ('2026-11-01', 'image/webp', ?, 2, '2026-11-01T00:00:00Z')").bind(profileBytes),
      db.prepare("INSERT INTO announcements (kind, user_id, payload_json, created_at, reference) VALUES ('lotto', 'min', '{\"rank\":2,\"prize\":3000}', '2026-11-01T08:00:00Z', 'old-announcement')"),
      db.prepare("INSERT INTO login_attempts (bucket, attempts, expires_at) VALUES ('test:login', 3, ?) ").bind(now),
      db.prepare("INSERT INTO game_rounds (game_id, round_date, answer, hint, updated_at) VALUES ('luck', '2026-11-01', '88', 'fixture', ?) ").bind(now),
      db.prepare("INSERT INTO predictions (game_id, round_date, player_id, value, updated_at) VALUES ('luck', '2026-11-01', 'min', '87', ?)").bind(now),
      db.prepare("INSERT INTO attendance (user_id, date, streak, created_at) VALUES ('min', '2026-11-01', 6, '2026-11-01T00:00:00Z')"),
      db.prepare("INSERT INTO ledger (id, user_id, currency, amount, reason, reference, created_at, week_start) VALUES ('old-gold', 'min', 'gold', 9000, 'fixture', 'fixture:gold', '2026-11-01T00:00:00Z', NULL), ('old-score', 'min', 'score', 10, 'fixture', 'fixture:score', '2026-11-01T00:00:00Z', '2026-10-26')"),
      db.prepare("INSERT INTO inventory_ledger (id, user_id, item, amount, reason, reference, created_at) VALUES ('old-lotto', 'min', 'lotto_ticket', 3, 'fixture', 'fixture:lotto', '2026-11-01T00:00:00Z'), ('old-speetto', 'min', 'speetto_ticket', 2, 'fixture', 'fixture:speetto', '2026-11-01T00:00:00Z')"),
      db.prepare("INSERT INTO shop_purchases (id, user_id, request_id, kind, request_payload, payment, cost, date, created_at, outcome) VALUES ('old-kuji', 'min', 'old-kuji-request', 'kuji', '{}', 'gold', 300, '2026-11-01', '2026-11-01T00:00:00Z', '{}'), ('old-lotto-purchase', 'min', 'old-lotto-request', 'lotto', '{}', 'gold', 500, '2026-11-01', '2026-11-01T00:00:00Z', '{}')"),
      db.prepare("INSERT INTO kuji_boards (id, grades, created_at) VALUES (7, ?, '2026-11-01T00:00:00Z')").bind(JSON.stringify(KUJI_RULES.grades.flatMap(grade => Array(grade.count).fill(grade.grade)))),
      db.prepare("INSERT INTO kuji_claims (board_id, position, purchase_id) VALUES (7, 0, 'old-kuji')"),
      db.prepare("INSERT INTO lotto_draws (date, numbers, created_at) VALUES ('2026-11-01', '[1,2,3,4,5]', '2026-11-01T08:00:00Z')"),
      db.prepare("INSERT INTO lotto_tickets (id, draw_date, numbers) VALUES ('old-lotto-purchase', '2026-11-01', '[1,2,3,4,5]')"),
      db.prepare("INSERT INTO catchmind_rounds (id, number, drawer_id, word, normalized_word, word_history, status, image, round_date, published_at, created_at) VALUES ('old-round', 12, 'min', '사과', '사과', '[\"사과\"]', 'open', 'data:image/png;base64,Zml4dHVyZQ==', '2026-11-01', '2026-11-01T00:00:00Z', '2026-11-01T00:00:00Z')"),
      db.prepare("UPDATE catchmind_turn SET drawer_id = 'min', round_id = 'old-round' WHERE id = 1"),
      db.prepare("INSERT INTO catchmind_requests (id, user_id, request_id, action, round_id, result_round_id, payload_hash, created_at) VALUES ('old-request', 'min', 'old-catchmind-request', 'guess', 'old-round', 'old-round', 'fixture', '2026-11-01T00:00:00Z')"),
      db.prepare("INSERT INTO catchmind_guesses (id, round_id, player_id, answer, normalized_answer, correct, created_at) VALUES ('old-request', 'old-round', 'min', '배', '배', 0, '2026-11-01T00:00:00Z')"),
      db.prepare("INSERT INTO claw_accounts (user_id, free_coins, purchased_coins, last_grant_slot, board_json, generation, version, power_counter) VALUES ('min', 2, 4, 1, '{}', 3, 5, 7)"),
      db.prepare("INSERT INTO claw_plays (id, user_id, request_id, generation, version, claw_x, caught, score, gold, clear_bonus, result_json, created_at) VALUES ('old-play', 'min', 'old-play-request', 3, 5, 0.5, 1, 1, 10, 0, '{}', '2026-11-01T00:00:00Z')"),
      db.prepare("INSERT INTO claw_coin_purchases (id, user_id, request_id, quantity, cost, created_at) VALUES ('old-coins', 'min', 'old-coins-request', 5, 500, '2026-11-01T00:00:00Z')"),
      db.prepare("INSERT INTO slot_spins (id, user_id, request_id, cost, reels, prize, date, created_at) VALUES ('retained-slot', 'min', 'retained-slot-request', 500, '[\"banana\",\"apple\",\"seven\"]', 0, '2026-11-01', '2026-11-01T00:00:00Z')"),
      db.prepare("INSERT INTO nickname_tags (id, user_id, request_id, grade, text, equipped, date, created_at) VALUES ('retained-tag', 'min', 'retained-tag-request', 'A', '반짝이는', 1, '2026-11-01', '2026-11-01T00:00:00Z')"),
      db.prepare("INSERT INTO tag_ticket_ledger (id, user_id, amount, reason, reference, created_at) VALUES ('retained-tag-ticket', 'min', 5, '별명 뽑기권 지급', 'tag:grant:welcome:min', '2026-11-01T00:00:00Z')"),
      db.prepare("INSERT INTO ranking_settlements (period, key, settled_at) VALUES ('week', '2026-10-26', '2026-11-02T00:01:00Z')"),
      db.prepare("INSERT INTO ranking_results (period, key, user_id, place, score, gold, players) VALUES ('week', '2026-10-26', 'min', 1, 10, 300, 3)"),
      db.prepare(`INSERT INTO notifications (kind, audience, user_id, actor_id, payload_json, created_at, reference)
        VALUES ('speetto', 'all', NULL, 'min', '{"kind":"speetto","prize":1500}', '2026-11-01T00:00:00Z', 'retained-notification')`),
      db.prepare("INSERT INTO achievements (user_id, key, period_key, unlocked_at, claimed_at) VALUES ('min', 'welcome', '', '2026-11-01T00:00:00Z', '2026-11-01T00:00:00Z')"),
      db.prepare("INSERT INTO stock_ticks (ticker, at, price) VALUES ('YEGM', 1, 500)"),
      db.prepare("INSERT INTO stock_daily (ticker, date, open, high, low, close) VALUES ('YEGM', '2026-11-05', 500, 510, 490, 505)"),
      db.prepare("INSERT INTO stock_events (id, ticker, kind, effect_bp, apply_at, created_at) VALUES ('retained-event', 'MINJ', 'game', 400, 1, 'x')"),
      db.prepare("INSERT INTO stock_news (id, ticker, kind, publish_at, headline, body, created_at) VALUES ('retained-news', 'YEGM', 'news', 1, '제목', '본문', 'x')"),
      db.prepare("INSERT INTO stock_holdings (user_id, ticker, quantity, cost_basis) VALUES ('min', 'YEGM', 1, 505)"),
      db.prepare("INSERT INTO stock_trades (id, user_id, request_id, ticker, side, quantity, price, fee, total, date, created_at) VALUES ('retained-trade', 'min', 'retained-trade', 'YEGM', 'buy', 1, 500, 5, 505, '2026-11-05', 'x')"),
      db.prepare("INSERT INTO market_holidays (date, reason, created_by, created_at) VALUES ('2026-12-03', '선거', 'admin', 'x')"),
      db.prepare("INSERT INTO ai_usage (date, calls, cost_micro_usd) VALUES ('2026-11-05', 1, 1000)"),
      db.prepare("INSERT INTO freethrow_sets (id, user_id, request_id, slot, date, engine, shots, made, created_at) VALUES ('00000000-0000-4000-8000-000000000001', 'min', 'retained-freethrow-request', 164703, '2026-11-07', 1, 1, 0, '2026-11-07T03:00:00Z')"),
      db.prepare("INSERT INTO freethrow_shots (id, set_id, shot_index, power, aim, made, kind, created_at) VALUES ('retained-shot', '00000000-0000-4000-8000-000000000001', 0, 10, 0, 0, 'short', '2026-11-07T03:00:01Z')"),
      db.prepare("INSERT INTO santa_runs (id, user_id, request_id, slot, date, engine, drops, hits, created_at) VALUES ('00000000-0000-4000-8000-000000000002', 'min', 'retained-santa-request', 41231, '2026-11-10', 1, 1, 0, '2026-11-10T03:00:00Z')"),
      db.prepare("INSERT INTO santa_drops (id, run_id, house_index, release_ms, hit, kind, created_at) VALUES ('retained-drop', '00000000-0000-4000-8000-000000000002', 0, -1, 0, 'pass', '2026-11-10T03:00:01Z')"),
    ]);
  });
  afterAll(async () => { await worker?.dispose(); });

  async function contents(tables: string[]) {
    return Object.fromEntries(await Promise.all(tables.map(async table => [table, (await db.prepare(`SELECT * FROM ${table} ORDER BY 1, 2`).all()).results])));
  }
  async function triggers() {
    return (await db.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'trigger' ORDER BY name").all<{ name: string; sql: string }>()).results;
  }
  async function request(path: string, method = 'GET') {
    return worker.dispatchFetch(`http://localhost${path}`, { method,
      headers: { cookie: `yegoom_session=${token}`, ...(method === 'GET' ? {} : { origin: 'http://localhost', 'content-type': 'application/json' }) },
      ...(method === 'GET' ? {} : { body: '{}' }),
    });
  }

  it('clears launch-era game records, preserves accounts/configuration and later slot receipts, and restores the exact immutable triggers', async () => {
    const existingTables = (await db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'").all<{ name: string }>()).results.map(row => row.name).sort();
    expect(existingTables).toEqual([...cleared, ...preserved, 'catchmind_turn'].sort());
    for (const table of [...cleared, ...preserved]) expect(await db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).first('count'), table).toBeGreaterThan(0);
    const before = await contents(preserved);
    const originalTriggers = await triggers();
    const results = await db.batch<Record<string, unknown>>(reset.map(sql => db.prepare(sql)));
    for (const table of cleared) expect(await db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).first('count'), table).toBe(0);
    expect(await contents(preserved)).toEqual(before);
    expect(await db.prepare("SELECT id, request_id, cost, reels, prize FROM slot_spins WHERE id = 'retained-slot'").first())
      .toEqual({ id: 'retained-slot', request_id: 'retained-slot-request', cost: 500, reels: '["banana","apple","seven"]', prize: 0 });
    expect(await triggers()).toEqual(originalTriggers);
    expect((await triggers()).filter(trigger => appendOnly.includes(trigger.name))).toHaveLength(4);
    expect(await db.prepare('SELECT * FROM catchmind_turn').all()).toMatchObject({ results: [{ id: 1, drawer_id: null, round_id: null }] });
    expect(results.flatMap(result => result.results).filter(row => 'cleared_table' in row)
      .sort((a, b) => String(a.cleared_table).localeCompare(String(b.cleared_table))))
      .toEqual([...cleared].sort().map(cleared_table => ({ cleared_table, remaining: 0 })));

    // The existing session still authenticates; reads create a fresh wallet/first board.
    const bootstrapResponse = await request('/api/bootstrap');
    expect(bootstrapResponse.status).toBe(200);
    const bootstrap = await bootstrapResponse.json() as BootstrapResponse;
    expect(bootstrap.user).toMatchObject({ id: 'min', displayName: '민', photoVersion: 7, character: 'moon', gold: 0, weeklyScore: 0 });
    // The reset predates the notification centre, so the seeded notice survives.
    // It is a day old, so it counts as unread without riding along for the toast.
    expect(bootstrap.notifications.unread).toBe(1);
    expect(bootstrap.notifications.recent).toEqual([]);
    expect(await db.prepare("SELECT actor_id FROM notifications WHERE reference = 'retained-notification'").first('actor_id')).toBe('min');
    const retainedPhoto = await request('/api/users/min/photo?v=7');
    expect(retainedPhoto.status).toBe(200);
    expect(Buffer.from(await retainedPhoto.arrayBuffer())).toEqual(await readFile(new URL('./fixtures/photo-square.webp', import.meta.url)));
    expect(bootstrap.attendance).toMatchObject({ claimed: false, streak: 1, cycleDay: 1 });
    expect(bootstrap.claw).toMatchObject({ freeCoins: CLAW_RULES.freeCoins, purchasedCoins: 0 });
    const kujiResponse = await request('/api/shop/kuji');
    expect(kujiResponse.status).toBe(200);
    const { kuji } = await kujiResponse.json() as KujiResponse;
    expect(kuji).toMatchObject({ boardId: 1, remaining: KUJI_RULES.size, purchasedToday: 0 });
    expect(kuji.cells.every(cell => cell.grade === null && cell.buyerId === null)).toBe(true);
    const clawResponse = await request('/api/claw');
    expect(clawResponse.status).toBe(200);
    expect(await clawResponse.json() as ClawResponse).toMatchObject({ freeCoins: CLAW_RULES.freeCoins, purchasedCoins: 0, generation: 1, version: 0 });
    const attendanceResponse = await request('/api/me/attendance', 'POST');
    expect(attendanceResponse.status).toBe(200);
    expect(await attendanceResponse.json() as AttendanceClaimResponse).toMatchObject({ awarded: true, attendance: { claimed: true, streak: 1, cycleDay: 1 }, user: { gold: ATTENDANCE_RULES.dailyGold } });
    await db.prepare("INSERT INTO inventory_ledger (id, user_id, item, amount, reason, reference, created_at) VALUES ('new-ticket', 'min', 'lotto_ticket', 1, 'test', 'after-reset:ticket', '2026-11-02T00:00:00Z')").run();
    expect(await db.prepare("SELECT gold, lotto_tickets, speetto_tickets FROM user_balances WHERE user_id = 'min'").first())
      .toEqual({ gold: ATTENDANCE_RULES.dailyGold, lotto_tickets: 1, speetto_tickets: 0 });
    for (const table of ['ledger', 'inventory_ledger']) {
      await expect(db.prepare(`UPDATE ${table} SET amount = amount + 1`).run()).rejects.toThrow('append-only');
      await expect(db.prepare(`DELETE FROM ${table}`).run()).rejects.toThrow('append-only');
    }
    // The claim above also completed 첫 출석, which adds an achievement row and
    // its notice; every other preserved table is exactly as it was.
    const stable = preserved.filter(table => table !== 'achievements' && table !== 'notifications');
    expect(await contents(stable)).toEqual(Object.fromEntries(stable.map(table => [table, before[table]])));
    expect(await db.prepare("SELECT claimed_at FROM achievements WHERE user_id = 'min' AND key = 'attend_first'").first('claimed_at')).toBeNull();
  });

  it('rolls back deletions and dropped triggers together if the D1 batch fails partway', async () => {
    const allTables = [...cleared, ...preserved, 'catchmind_turn'];
    const before = await contents(allTables);
    const originalTriggers = await triggers();
    const failing = [...reset];
    failing.splice(failing.findIndex(sql => /^CREATE TRIGGER/.test(sql)), 0, "INSERT INTO users (id) VALUES ('invalid-incomplete-user');");
    await expect(db.batch(failing.map(sql => db.prepare(sql)))).rejects.toThrow('NOT NULL constraint failed');
    expect(await contents(allTables)).toEqual(before);
    expect(await triggers()).toEqual(originalTriggers);
    await expect(db.prepare('DELETE FROM ledger').run()).rejects.toThrow('append-only');
    await expect(db.prepare('DELETE FROM inventory_ledger').run()).rejects.toThrow('append-only');
  });
});

describe('launch reset operator confirmation', () => {
  it('runs no command for anything except exact RESET, then executes the file and read-only checks', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'yegoom-reset-cli-'));
    const log = join(directory, 'invocations.jsonl');
    const mock = join(directory, 'npx');
    try {
      // A local fake npx captures arguments. This test never runs Wrangler or a remote command.
      await writeFile(mock, `#!${process.execPath}\nrequire('node:fs').appendFileSync(process.env.RESET_TEST_LOG, JSON.stringify(process.argv.slice(2)) + '\\n');\n`);
      await chmod(mock, 0o700);
      const env = { ...process.env, PATH: `${directory}:${process.env.PATH}`, RESET_TEST_LOG: log };
      for (const input of ['', '\n', 'reset\n', ' RESET\n', 'RESET \n', 'yes\n', 'RESETplease\n']) {
        const result = spawnSync(process.execPath, ['scripts/launch-reset.mjs'], { cwd: root, input, env, encoding: 'utf8' });
        expect(result.status, input).toBe(1);
        expect(result.stdout).toContain('yegoom-db의 기록을 모두 지웁니다. 계속하려면 RESET 입력');
        expect(result.stdout).toContain('DB 명령을 실행하지 않았습니다.');
        await expect(readFile(log, 'utf8')).rejects.toThrow();
      }
      const confirmed = spawnSync(process.execPath, ['scripts/launch-reset.mjs'], { cwd: root, input: 'RESET\n', env, encoding: 'utf8' });
      expect(confirmed.status, confirmed.stderr).toBe(0);
      const calls = (await readFile(log, 'utf8')).trim().split('\n').map(line => JSON.parse(line) as string[]);
      expect(calls).toHaveLength(3);
      expect(calls[1]).toEqual(['wrangler', 'd1', 'execute', 'yegoom-db', '--remote', '--file', 'scripts/launch-reset.sql']);
      for (const call of [calls[0]!, calls[2]!]) {
        expect(call.slice(0, 6)).toEqual(['wrangler', 'd1', 'execute', 'yegoom-db', '--remote', '--command']);
        expect(statements(call[6]!)).toSatisfy((queries: string[]) => queries.every(sql => /^SELECT\b/.test(sql)));
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

describe('launch profile additive migration', () => {
  let instance: Miniflare;
  let database: Database;
  let oldMigrations: string[];
  let launchMigration: string[];
  beforeAll(async () => {
    const names = (await readdir(new URL('../migrations/', import.meta.url))).filter(name => name.endsWith('.sql')).sort();
    oldMigrations = await Promise.all(names.filter(name => name < '0007').map(name => readFile(new URL(`../migrations/${name}`, import.meta.url), 'utf8')));
    launchMigration = statements(await readFile(new URL('../migrations/0007_launch_profiles.sql', import.meta.url), 'utf8'));
  });
  beforeEach(async () => {
    await instance?.dispose();
    instance = new Miniflare({ modules: true, script: 'export default { fetch() { return new Response("schema test"); } };', compatibilityDate: '2026-08-06', d1Databases: ['DB'] });
    database = await instance.getD1Database('DB');
    for (const sql of oldMigrations) await database.batch(statements(sql).map(statement => database.prepare(statement)));
    await database.prepare(`INSERT INTO users (id, username, display_name, password_hash, role)
      VALUES ('first', 'first', 'Name', 'unchanged-password', 'player'), ('second', 'second', 'Other', 'other-password', 'player')`).run();
    await database.prepare(`INSERT INTO sessions (token_hash, user_id, expires_at, created_at)
      VALUES ('preserved-session', 'first', ?, ?)`).bind(now + 86400000, now).run();
  });
  afterAll(async () => { await instance?.dispose(); });

  it('refuses existing active nickname duplicates before adding any columns or tables', async () => {
    await database.prepare("UPDATE users SET display_name = 'name' WHERE id = 'second'").run();
    const before = (await database.prepare('SELECT * FROM users ORDER BY id').all()).results;
    await expect(database.batch(launchMigration.map(sql => database.prepare(sql)))).rejects.toThrow('UNIQUE');
    expect((await database.prepare('PRAGMA table_info(users)').all<{ name: string }>()).results.some(column => column.name === 'photo_version')).toBe(false);
    expect(await database.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name IN ('user_photos', 'announcements', 'luck_photos', 'users_active_display_name_idx')").first('n')).toBe(0);
    expect((await database.prepare('SELECT * FROM users ORDER BY id').all()).results).toEqual(before);
  });

  it('preserves existing account/session values and the old SQL write contract when applied before deployment', async () => {
    const before = (await database.prepare('SELECT id, username, display_name, password_hash, role, active, character FROM users ORDER BY id').all()).results;
    await database.batch(launchMigration.map(sql => database.prepare(sql)));
    expect((await database.prepare('SELECT id, username, display_name, password_hash, role, active, character FROM users ORDER BY id').all()).results).toEqual(before);
    expect((await database.prepare('SELECT photo_version FROM users').all<{ photo_version: number | null }>()).results.every(row => row.photo_version === null)).toBe(true);
    expect(await database.prepare('SELECT COUNT(*) AS n FROM sessions').first('n')).toBe(1);
    // These are the pre-launch column lists; additive columns need no old-app writes.
    await database.prepare("INSERT INTO attendance (user_id, date, streak, created_at) VALUES ('first', '2026-11-02', 1, '2026-11-02T00:00:00Z')").run();
    await database.prepare("INSERT INTO ledger (id, user_id, currency, amount, reason, reference, created_at) VALUES ('compat-gold', 'first', 'gold', 100, 'compatibility', 'compat:attendance', '2026-11-02T00:00:00Z')").run();
    await database.prepare("INSERT INTO users (id, username, display_name, password_hash, role) VALUES ('new', 'new', 'New', 'old-column-list', 'player')").run();
    expect(await database.prepare("SELECT SUM(amount) AS gold FROM ledger WHERE user_id = 'first'").first('gold')).toBe(100);
    await expect(database.prepare('DELETE FROM ledger').run()).rejects.toThrow('append-only');
    for (const table of ['user_photos', 'announcements', 'luck_photos']) expect(await database.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first('n')).toBe(0);
  });
});
