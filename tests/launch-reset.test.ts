import { spawnSync } from 'node:child_process';
import { chmod, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ATTENDANCE_RULES, CLAW_RULES, KUJI_RULES } from '../shared/balance';
import type { AttendanceClaimResponse, BootstrapResponse, ClawResponse, KujiResponse } from '../shared/types';
import { hashToken } from '../worker/crypto';

type Database = Awaited<ReturnType<Miniflare['getD1Database']>>;
const root = fileURLToPath(new URL('..', import.meta.url));
const cleared = ['ledger', 'attendance', 'game_rounds', 'predictions', 'inventory_ledger', 'shop_purchases',
  'kuji_claims', 'kuji_boards', 'lotto_tickets', 'lotto_draws', 'catchmind_guesses', 'catchmind_requests',
  'catchmind_rounds', 'claw_plays', 'claw_coin_purchases', 'claw_accounts', 'login_attempts'];
const preserved = ['users', 'sessions', 'd1_migrations', 'claw_config'];
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
    await db.batch([
      db.prepare("INSERT INTO users (id, username, display_name, password_hash, role, active, character) VALUES ('min', 'min', '민', 'unchanged-player-password', 'player', 1, 'moon'), ('admin', 'admin', '관리자', 'unchanged-admin-password', 'admin', 1, 'cat'), ('inactive', 'inactive', '휴면', 'unchanged-inactive-password', 'player', 0, NULL)"),
      db.prepare('INSERT INTO sessions (token_hash, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)').bind(await hashToken(token), 'min', now + 86400000, now - 86400000),
      db.prepare("INSERT INTO sessions (token_hash, user_id, expires_at, created_at) VALUES ('admin-session', 'admin', ?, ?)").bind(now + 86400000, now - 86400000),
      db.prepare("UPDATE claw_config SET payout_every = 17, weak_pickup = 39, weak_carry = 21, updated_at = '2026-10-31T07:00:00Z'"),
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
    ]);
  });
  afterAll(async () => { await worker?.dispose(); });

  async function contents(tables: string[]) {
    return Object.fromEntries(await Promise.all(tables.map(async table => [table, (await db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()).results])));
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

  it('clears every record, preserves complete account/configuration data and restores the exact immutable triggers', async () => {
    const existingTables = (await db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'").all<{ name: string }>()).results.map(row => row.name).sort();
    expect(existingTables).toEqual([...cleared, ...preserved, 'catchmind_turn'].sort());
    for (const table of [...cleared, ...preserved]) expect(await db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).first('count'), table).toBeGreaterThan(0);
    const before = await contents(preserved);
    const originalTriggers = await triggers();
    const results = await db.batch<Record<string, unknown>>(reset.map(sql => db.prepare(sql)));
    for (const table of cleared) expect(await db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).first('count'), table).toBe(0);
    expect(await contents(preserved)).toEqual(before);
    expect(await triggers()).toEqual(originalTriggers);
    expect((await triggers()).filter(trigger => appendOnly.includes(trigger.name))).toHaveLength(4);
    expect(await db.prepare('SELECT * FROM catchmind_turn').all()).toMatchObject({ results: [{ id: 1, drawer_id: null, round_id: null }] });
    expect(results.flatMap(result => result.results).filter(row => 'cleared_table' in row)).toEqual(cleared.map(cleared_table => ({ cleared_table, remaining: 0 })));

    // The existing session still authenticates; reads create a fresh wallet/first board.
    const bootstrapResponse = await request('/api/bootstrap');
    expect(bootstrapResponse.status).toBe(200);
    const bootstrap = await bootstrapResponse.json() as BootstrapResponse;
    expect(bootstrap.user).toMatchObject({ id: 'min', displayName: '민', character: 'moon', gold: 0, weeklyScore: 0 });
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
    for (const table of ['ledger', 'inventory_ledger']) {
      await expect(db.prepare(`UPDATE ${table} SET amount = amount + 1`).run()).rejects.toThrow('append-only');
      await expect(db.prepare(`DELETE FROM ${table}`).run()).rejects.toThrow('append-only');
    }
    expect(await contents(preserved)).toEqual(before);
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
