import { readFile, readdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { hashPassword, hashToken } from '../worker/crypto';
import type { BootstrapResponse, GameResponse, GameId, HistoryResponse, AttendanceResponse, AttendanceClaimResponse, User, ShopState, KujiResponse, LottoResponse, SpeettoResponse } from '../shared/types';

const ORIGIN = 'http://localhost';
const PASSWORD = 'test-only-password-42!';
const TODAY = '2026-10-30';
const USERS = ['min', 'siwon', 'yeseo', 'admin'] as const;
type Username = typeof USERS[number];
type Database = Awaited<ReturnType<Miniflare['getD1Database']>>;

// Freeze only the compiled test bundle. Production never accepts a clock header
// or an environment override, and these tests do not depend on the host timezone.
async function workerAt(instant: string, sqlInstant: string = instant, speettoRoll?: number): Promise<string> {
  const timestamp = Date.parse(instant);
  const result = await build({
    entryPoints: [fileURLToPath(new URL('../worker/index.ts', import.meta.url))],
    bundle: true,
    format: 'esm',
    platform: 'browser',
    write: false,
    define: { Date: 'TestDate' },
    banner: { js: `class TestDate extends Date { constructor(...args) { super(...(args.length ? args : [${timestamp}])); } static now() { return ${timestamp}; } }` },
  });
  // D1 also checks its own clock inside conditional writes, so freeze that SQL
  // expression in the test artifact along with JavaScript. No app source changes.
  let artifact = result.outputFiles[0]!.text.replaceAll("unixepoch('now') * 1000", String(Date.parse(sqlInstant)));
  if (speettoRoll !== undefined) {
    // Inject only the compiled test artifact's probability roll. Production has
    // no random override; shuffles and authentication still use real crypto.
    const signature = /function randomInt\((\w+)\) \{/;
    if (!signature.test(artifact)) throw new Error('Compiled shop randomInt function was not found');
    artifact = artifact.replace(signature, (match, maximum: string) => `${match} if (${maximum} === 100) return ${speettoRoll};`);
  }
  return artifact;
}

function runtime(script: string, persistence?: string) {
  return new Miniflare({
    modules: true,
    script,
    compatibilityDate: '2026-08-06',
    d1Databases: ['DB'],
    ...(persistence ? { d1Persist: persistence } : {}),
  });
}

async function applyMigration(db: Database, migration: string) {
  // D1 exec() splits on newlines, including newlines inside CREATE TABLE.
  // Preserve full statements and trigger bodies while applying the real file.
  let statement = '';
  for (const sourceLine of migration.split('\n')) {
    const line = sourceLine.trim();
    if (!line || line.startsWith('--')) continue;
    statement += `${line}\n`;
    const trigger = /^CREATE TRIGGER\b/i.test(statement);
    if (line.endsWith(';') && (!trigger || /\bEND;$/i.test(line))) {
      await db.prepare(statement).run();
      statement = '';
    }
  }
  if (statement.trim()) throw new Error('Migration contains an incomplete SQL statement');
}

async function provision(db: Database, migration: string, passwordHash: string) {
  await applyMigration(db, migration);
  for (const username of USERS) {
    await db.prepare('INSERT INTO users (id, username, display_name, password_hash, role) VALUES (?, ?, ?, ?, ?)')
      .bind(username, username, username, passwordHash, username === 'admin' ? 'admin' : 'player').run();
  }
}

describe('Worker and D1 integration', () => {
  let worker: Miniflare;
  let db: Database;
  let migration: string;
  let passwordHash: string;
  let script: string;

  async function request(path: string, options: {
    method?: string;
    body?: unknown;
    cookie?: string;
    origin?: string | null;
    instance?: Miniflare;
  } = {}) {
    const method = options.method ?? 'GET';
    const headers: Record<string, string> = {};
    if (options.cookie) headers.cookie = options.cookie;
    if (options.body !== undefined) headers['content-type'] = 'application/json';
    if (method !== 'GET' && options.origin !== null) headers.origin = options.origin ?? ORIGIN;
    const payload = path.startsWith('/api/games/') && options.body && typeof options.body === 'object'
      ? { roundDate: TODAY, ...options.body }
      : options.body;
    return (options.instance ?? worker).dispatchFetch(`${ORIGIN}${path}`, {
      method,
      headers,
      ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
    });
  }

  async function login(username: string, instance?: Miniflare) {
    const response = await request('/api/auth/login', {
      method: 'POST', body: { username, password: PASSWORD }, instance,
    });
    expect(response.status).toBe(200);
    const setCookie = response.headers.get('set-cookie');
    expect(setCookie).toBeTruthy();
    const cookie = setCookie!.split(';')[0]!;
    const { user } = await response.json() as { user: User };
    return { cookie, setCookie: setCookie!, user };
  }

  async function bootstrap(cookie: string) {
    const response = await request('/api/bootstrap', { cookie });
    expect(response.status).toBe(200);
    return response.json() as Promise<BootstrapResponse>;
  }

  beforeAll(async () => {
    [migration, passwordHash] = await Promise.all([
      readdir(new URL('../migrations/', import.meta.url)).then(async files =>
        (await Promise.all(files.filter(file => file.endsWith('.sql')).sort().map(file =>
          readFile(new URL(`../migrations/${file}`, import.meta.url), 'utf8')))).join('\n')),
      hashPassword(PASSWORD),
    ]);
    script = await workerAt(`${TODAY}T00:00:00Z`); // 09:00 KST
  });

  beforeEach(async () => {
    // Use a fresh database; production ledger triggers forbid clearing payout history.
    await worker?.dispose();
    worker = runtime(script);
    db = await worker.getD1Database('DB');
    await provision(db, migration, passwordHash);
  });

  afterAll(async () => { await worker?.dispose(); });

  async function seedRound(options: {
    game: GameId;
    date?: string;
    answer?: string | null;
    predictions?: [Username, string][];
    revealAt?: number | null;
    revealedAt?: number | null;
    database?: Database;
  }) {
    const database = options.database ?? db;
    const date = options.date ?? TODAY;
    const timestamp = Date.parse(`${date}T00:00:00Z`);
    await database.prepare(`INSERT INTO game_rounds
      (game_id, round_date, answer, reveal_at, revealed_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`)
      .bind(options.game, date, options.answer ?? null, options.revealAt ?? null, options.revealedAt ?? null, timestamp).run();
    for (const [username, value] of options.predictions ?? []) {
      await database.prepare('INSERT INTO predictions (game_id, round_date, player_id, value, updated_at) VALUES (?, ?, ?, ?, ?)')
        .bind(options.game, date, username, value, timestamp).run();
    }
  }

  async function ledgerRows(database: Database = db) {
    return (await database.prepare('SELECT user_id, currency, amount, reference, week_start FROM ledger ORDER BY reference')
      .all<{ user_id: string; currency: string; amount: number; reference: string; week_start: string | null }>()).results;
  }

  async function seedAttendance(date: string, streak: number, username: Username = 'min', database: Database = db) {
    await database.prepare('INSERT INTO attendance (user_id, date, streak, created_at) VALUES (?, ?, ?, ?)')
      .bind(username, date, streak, `${date}T00:00:00.000Z`).run();
  }

  describe('server attendance and saved characters', () => {
    it('claims the first daily 100G once and returns the persisted state on retries', async () => {
      const { cookie } = await login('min');
      expect((await bootstrap(cookie)).attendance).toMatchObject({
        today: TODAY, claimed: false, streak: 1, cycleDay: 1, reward: 100, canClaim: true,
        month: '2026-10', monthCount: 0, days: [],
      });
      for (const awarded of [true, false, false]) {
        const response = await request('/api/me/attendance', { method: 'POST', cookie, body: {} });
        expect(response.status).toBe(200);
        const result = await response.json() as AttendanceClaimResponse;
        expect(result.awarded).toBe(awarded);
        expect(result.user.gold).toBe(100);
        expect(result.attendance).toMatchObject({ today: TODAY, claimed: true, streak: 1,
          cycleDay: 1, reward: 100, canClaim: false, monthCount: 1, days: [TODAY] });
      }
      expect(await ledgerRows()).toEqual([{ user_id: 'min', currency: 'gold', amount: 100,
        reference: `attendance:${TODAY}:min`, week_start: null }]);
      expect(await db.prepare('SELECT user_id, date, streak FROM attendance').all()).toMatchObject({
        results: [{ user_id: 'min', date: TODAY, streak: 1 }],
      });
      const view = await bootstrap(cookie);
      expect(view.user).toMatchObject({ gold: 100, weeklyScore: 0 });
      expect(view.ledger).toHaveLength(1);
      expect(view.ledger[0]).toMatchObject({ currency: 'gold', amount: 100, createdAt: `${TODAY}T00:00:00.000Z` });
    });

    it('serializes simultaneous attendance claims from two sessions into one payout', async () => {
      const first = await login('min');
      const second = await login('min');
      const responses = await Promise.all([first.cookie, second.cookie].map(cookie =>
        request('/api/me/attendance', { method: 'POST', cookie, body: {} })));
      expect(responses.map(response => response.status)).toEqual([200, 200]);
      const claims = await Promise.all(responses.map(response => response.json() as Promise<AttendanceClaimResponse>));
      expect(claims.map(claim => claim.awarded).sort()).toEqual([false, true]);
      expect(claims.map(claim => claim.user.gold)).toEqual([100, 100]);
      expect(await db.prepare('SELECT COUNT(*) AS count FROM attendance').first('count')).toBe(1);
      expect((await ledgerRows()).map(row => [row.reference, row.amount])).toEqual([[`attendance:${TODAY}:min`, 100]]);
    });

    it.each([
      { yesterday: 6, streak: 7, cycleDay: 7, reward: 500 },
      { yesterday: 13, streak: 14, cycleDay: 7, reward: 500 },
      { yesterday: 7, streak: 8, cycleDay: 1, reward: 100 },
      { yesterday: 14, streak: 15, cycleDay: 1, reward: 100 },
    ])('pays the attendance cycle reward for streak $streak', async ({ yesterday, streak, cycleDay, reward }) => {
      await seedAttendance('2026-10-29', yesterday);
      const { cookie } = await login('min');
      expect((await bootstrap(cookie)).attendance).toMatchObject({ claimed: false, streak, cycleDay, reward, monthCount: 1 });
      const responses = await Promise.all([1, 2].map(() => request('/api/me/attendance', { method: 'POST', cookie, body: {} })));
      expect(responses.map(response => response.status)).toEqual([200, 200]);
      const claims = await Promise.all(responses.map(response => response.json() as Promise<AttendanceClaimResponse>));
      expect(claims.map(claim => claim.awarded).sort()).toEqual([false, true]);
      for (const claim of claims) {
        expect(claim.user.gold).toBe(reward);
        expect(claim.attendance).toMatchObject({ claimed: true, streak, cycleDay, reward, monthCount: 2 });
      }
      expect((await ledgerRows()).map(row => row.amount)).toEqual([reward]);
      expect(await db.prepare('SELECT streak FROM attendance WHERE date = ?').bind(TODAY).first('streak')).toBe(streak);
    });

    it('resets the attendance streak after a missed day without using another player history', async () => {
      await seedAttendance('2026-10-28', 13);
      await seedAttendance('2026-10-29', 6, 'siwon');
      const { cookie } = await login('min');
      expect((await bootstrap(cookie)).attendance).toMatchObject({ claimed: false, streak: 1, cycleDay: 1, reward: 100 });
      const response = await request('/api/me/attendance', { method: 'POST', cookie, body: {} });
      expect(response.status).toBe(200);
      expect((await response.json() as AttendanceClaimResponse).attendance).toMatchObject({ streak: 1, cycleDay: 1, reward: 100 });
      expect((await ledgerRows()).map(row => row.amount)).toEqual([100]);
    });

    it.each([
      { instant: '2026-10-31T14:59:59Z', today: '2026-10-31', yesterday: '2026-10-30', previousStreak: 6, streak: 7, reward: 500, month: '2026-10', count: 2 },
      { instant: '2026-10-31T15:00:00Z', today: '2026-11-01', yesterday: '2026-10-31', previousStreak: 7, streak: 8, reward: 100, month: '2026-11', count: 1 },
    ])('uses the server KST date across midnight and month changes at $instant', async ({ instant, today, yesterday, previousStreak, streak, reward, month, count }) => {
      const instance = runtime(await workerAt(instant));
      try {
        const database = await instance.getD1Database('DB');
        await provision(database, migration, passwordHash);
        await seedAttendance(yesterday, previousStreak, 'min', database);
        const { cookie } = await login('min', instance);
        const response = await request('/api/me/attendance', { method: 'POST', cookie, instance,
          body: { date: '1999-01-01', today: '2099-01-01', streak: 700, amount: 999999, reward: 999999, userId: 'siwon' } });
        expect(response.status).toBe(200);
        const claim = await response.json() as AttendanceClaimResponse;
        expect(claim.attendance).toMatchObject({ today, claimed: true, streak, reward, month, monthCount: count });
        expect(claim.user).toMatchObject({ id: 'min', gold: reward });
        expect((await ledgerRows(database)).map(row => [row.reference, row.amount])).toEqual([[`attendance:${today}:min`, reward]]);
        expect(await database.prepare('SELECT user_id, date, streak FROM attendance WHERE date = ?').bind(today).all()).toMatchObject({
          results: [{ user_id: 'min', date: today, streak }],
        });
      } finally { await instance.dispose(); }
    });

    it.each([false, true])('rejects an attendance write crossing KST midnight (next day already claimed: %s)', async (nextDayClaimed) => {
      const instance = runtime(await workerAt('2026-10-31T14:59:59Z', '2026-10-31T15:00:00Z'));
      try {
        const database = await instance.getD1Database('DB');
        await provision(database, migration, passwordHash);
        if (nextDayClaimed) {
          // A new-day request has already committed while yesterday's request
          // was still in flight. The late request must not backfill yesterday.
          await seedAttendance('2026-11-01', 1, 'min', database);
          await database.prepare(`INSERT INTO ledger (id, user_id, currency, amount, reason, reference, created_at)
            VALUES ('next-day-attendance', 'min', 'gold', 100, '출석 체크', 'attendance:2026-11-01:min', '2026-10-31T15:00:00Z')`).run();
        }
        const { cookie } = await login('min', instance);
        const response = await request('/api/me/attendance', { method: 'POST', cookie, body: {}, instance });
        expect(response.status).toBe(409);
        expect((await database.prepare('SELECT date, streak FROM attendance ORDER BY date').all()).results)
          .toEqual(nextDayClaimed ? [{ date: '2026-11-01', streak: 1 }] : []);
        expect((await ledgerRows(database)).map(row => [row.reference, row.amount]))
          .toEqual(nextDayClaimed ? [['attendance:2026-11-01:min', 100]] : []);
      } finally { await instance.dispose(); }
    });

    it('requires authentication and matching Origin and forbids administrator attendance', async () => {
      expect((await request('/api/me/attendance')).status).toBe(401);
      expect((await request('/api/me/attendance', { method: 'POST', body: {} })).status).toBe(401);
      const min = await login('min');
      for (const origin of [null, 'https://elsewhere.example']) {
        expect((await request('/api/me/attendance', { method: 'POST', cookie: min.cookie, body: {}, origin })).status).toBe(403);
      }
      const admin = await login('admin');
      expect((await bootstrap(admin.cookie)).attendance.canClaim).toBe(false);
      expect((await request('/api/me/attendance', { method: 'POST', cookie: admin.cookie, body: {} })).status).toBe(403);
      expect(await db.prepare('SELECT COUNT(*) AS count FROM attendance').first('count')).toBe(0);
      expect(await ledgerRows()).toEqual([]);
    });

    it('returns only the authenticated player attendance for the requested calendar month', async () => {
      for (const [date, streak] of [['2026-09-30', 1], ['2026-10-01', 2], ['2026-10-29', 1]] as const) await seedAttendance(date, streak);
      await seedAttendance('2026-10-15', 7, 'siwon');
      const { cookie } = await login('min');
      const view = await bootstrap(cookie);
      expect(view.attendance).toMatchObject({ month: '2026-10', monthCount: 2, days: ['2026-10-01', '2026-10-29'], streak: 2 });
      const previous = await request('/api/me/attendance?month=2026-09&userId=siwon', { cookie });
      expect(previous.status).toBe(200);
      expect((await previous.json() as AttendanceResponse).attendance).toMatchObject({ month: '2026-09', monthCount: 1, days: ['2026-09-30'] });
      const empty = await request('/api/me/attendance?month=2026-08', { cookie });
      expect(empty.status).toBe(200);
      expect((await empty.json() as AttendanceResponse).attendance).toMatchObject({ month: '2026-08', monthCount: 0, days: [] });
      const current = await request('/api/me/attendance', { cookie });
      expect((await current.json() as AttendanceResponse).attendance).toEqual(view.attendance);
    });

    it('rejects malformed attendance month parameters', async () => {
      const { cookie } = await login('min');
      for (const month of ['', '2026-00', '2026-13', '2026-1', '26-10', '2026-10-01', '2026-10T00:00:00Z', "' OR 1=1 --"]) {
        expect((await request(`/api/me/attendance?month=${encodeURIComponent(month)}`, { cookie })).status, month).toBe(400);
      }
      expect(await ledgerRows()).toEqual([]);
    });

    it('adds nullable characters without changing existing accounts or ledger rows', async () => {
      const instance = runtime(script);
      try {
        const database = await instance.getD1Database('DB');
        const oldMigration = (await Promise.all(['0001_initial.sql', '0002_prediction_settlement.sql'].map(file =>
          readFile(new URL(`../migrations/${file}`, import.meta.url), 'utf8')))).join('\n');
        await provision(database, oldMigration, passwordHash);
        await database.prepare(`INSERT INTO ledger (id, user_id, currency, amount, reason, reference, created_at)
          VALUES ('existing-gold', 'min', 'gold', 123, 'existing balance', 'existing:gold:min', '2026-10-29T00:00:00Z')`).run();
        const additions = (await readdir(new URL('../migrations/', import.meta.url))).filter(file => file.endsWith('.sql') && file > '0002_prediction_settlement.sql').sort();
        for (const file of additions) await applyMigration(database, await readFile(new URL(`../migrations/${file}`, import.meta.url), 'utf8'));
        expect(await database.prepare('SELECT username, character FROM users ORDER BY username').all()).toMatchObject({ results: [
          { username: 'admin', character: null }, { username: 'min', character: null },
          { username: 'siwon', character: null }, { username: 'yeseo', character: null },
        ] });
        const { cookie, user } = await login('min', instance);
        expect(user).toMatchObject({ gold: 123, character: null });
        const response = await request('/api/bootstrap', { cookie, instance });
        expect(response.status).toBe(200);
        const view = await response.json() as BootstrapResponse;
        expect(view.players.map(player => [player.username, player.character]).sort()).toEqual([
          ['min', 'axolotl'], ['siwon', 'cat'], ['yeseo', 'bunny'],
        ]);
        expect(view.attendance).toMatchObject({ claimed: false, monthCount: 0, days: [] });
        expect((await ledgerRows(database)).map(row => row.amount)).toEqual([123]);
        await expect(database.prepare('DELETE FROM ledger').run()).rejects.toThrow('append-only');
        // Old provisioning INSERTs remain valid after the additive migration.
        await database.prepare('INSERT INTO users (id, username, display_name, password_hash, role) VALUES (?, ?, ?, ?, ?)')
          .bind('guest', 'guest', 'guest', passwordHash, 'player').run();
        const guest = await login('guest', instance);
        const guestView = await request('/api/bootstrap', { cookie: guest.cookie, instance });
        expect((await guestView.json() as BootstrapResponse).players.find(player => player.username === 'guest')?.character).toBe('monkey');
      } finally { await instance.dispose(); }
    });

    it('persists every permitted character and allows players to share the same character', async () => {
      const min = await login('min');
      const siwon = await login('siwon');
      for (const character of ['axolotl', 'drop', 'cat', 'bunny', 'bread', 'manta', 'moon', 'monkey']) {
        const response = await request('/api/me/character', { method: 'PUT', cookie: min.cookie, body: { character } });
        expect(response.status, character).toBe(200);
        expect((await response.json() as { user: User }).user.character).toBe(character);
        expect(await db.prepare('SELECT character FROM users WHERE id = ?').bind('min').first('character')).toBe(character);
      }
      expect((await request('/api/me/character', { method: 'PUT', cookie: siwon.cookie, body: { character: 'monkey' } })).status).toBe(200);
      const view = await bootstrap(min.cookie);
      expect(view.players.filter(player => ['min', 'siwon'].includes(player.username)).map(player => player.character)).toEqual(['monkey', 'monkey']);
      expect(await ledgerRows()).toEqual([]);
    });

    it('rejects unsupported character values and unauthenticated or cross-origin changes', async () => {
      const { cookie } = await login('min');
      for (const character of [null, '', 'dog', 'CAT', ' cat ', '__proto__', 'constructor', 1, {}, ['cat']]) {
        expect((await request('/api/me/character', { method: 'PUT', cookie, body: { character } })).status).toBe(400);
      }
      expect((await request('/api/me/character', { method: 'PUT', cookie, body: {} })).status).toBe(400);
      expect((await request('/api/me/character', { method: 'PUT', body: { character: 'cat' } })).status).toBe(401);
      expect((await request('/api/me/character', { method: 'PUT', cookie, origin: null, body: { character: 'cat' } })).status).toBe(403);
      expect(await db.prepare('SELECT character FROM users WHERE id = ?').bind('min').first('character')).toBeNull();
    });

    it('keeps character changes scoped to the viewer and shares them across sessions and results', async () => {
      const first = await login('min');
      const second = await login('min');
      const other = await login('siwon');
      const response = await request('/api/me/character', { method: 'PUT', cookie: first.cookie,
        body: { character: 'moon', userId: 'siwon', username: 'siwon' } });
      expect(response.status).toBe(200);
      const resumed = await request('/api/auth/me', { cookie: second.cookie });
      expect(resumed.status).toBe(200);
      expect((await resumed.json() as { user: User }).user.character).toBe('moon');
      expect(await db.prepare('SELECT character FROM users WHERE id = ?').bind('siwon').first('character')).toBeNull();
      await seedRound({ game: 'luck', answer: '50', revealedAt: Date.parse(`${TODAY}T00:00:00Z`), predictions: [['min', '50']] });
      await seedRound({ game: 'luck', date: '2026-10-29', answer: '50', revealedAt: Date.parse('2026-10-29T09:00:00Z'), predictions: [['min', '50']] });
      const view = await bootstrap(other.cookie);
      expect(view.players.find(player => player.username === 'min')?.character).toBe('moon');
      expect(view.games.find(game => game.id === 'luck')?.results[0]?.character).toBe('moon');
      const history = await request('/api/games/luck/history', { cookie: other.cookie });
      expect((await history.json() as HistoryResponse).history[0]?.results[0]?.character).toBe('moon');
    });

    it('migrates a legacy character only while the server field is null', async () => {
      const { cookie } = await login('min');
      for (const [body, expected] of [
        [{ character: 'bread', migrate: true, expectedUserId: 'min' }, 'bread'],
        [{ character: 'cat', migrate: true, expectedUserId: 'min' }, 'bread'],
        [{ character: 'moon' }, 'moon'],
        [{ character: 'manta', migrate: true, expectedUserId: 'min' }, 'moon'],
      ] as const) {
        const response = await request('/api/me/character', { method: 'PUT', cookie, body });
        expect(response.status).toBe(200);
        expect((await response.json() as { user: User }).user.character).toBe(expected);
      }
    });

    it('rejects legacy character migration when its expected account is missing or differs from the session', async () => {
      const min = await login('min');
      const siwon = await login('siwon');
      for (const [cookie, expected] of [
        [min.cookie, {}],
        [min.cookie, { expectedUserId: 'siwon' }],
        // Another browser tab switched the shared cookie after min's local
        // choice was read; it must never become siwon's saved character.
        [siwon.cookie, { expectedUserId: 'min' }],
      ] as const) {
        const response = await request('/api/me/character', { method: 'PUT', cookie,
          body: { character: 'bread', migrate: true, ...expected } });
        expect(response.status).toBe(409);
      }
      expect((await db.prepare('SELECT character FROM users WHERE id IN (?, ?)').bind('min', 'siwon').all()).results)
        .toEqual([{ character: null }, { character: null }]);
    });

    it('lets only one concurrent legacy character migration replace a null value', async () => {
      const first = await login('min');
      const second = await login('min');
      const responses = await Promise.all([
        request('/api/me/character', { method: 'PUT', cookie: first.cookie, body: { character: 'manta', migrate: true, expectedUserId: 'min' } }),
        request('/api/me/character', { method: 'PUT', cookie: second.cookie, body: { character: 'bread', migrate: true, expectedUserId: 'min' } }),
      ]);
      expect(responses.map(response => response.status)).toEqual([200, 200]);
      const results = await Promise.all(responses.map(response => response.json() as Promise<{ user: User }>));
      const saved = await db.prepare('SELECT character FROM users WHERE id = ?').bind('min').first('character');
      expect(['manta', 'bread']).toContain(saved);
      expect(results.map(result => result.user.character)).toEqual([saved, saved]);
    });

    it('never lets a concurrent legacy migration overwrite an explicit character choice', async () => {
      const first = await login('min');
      const second = await login('min');
      const responses = await Promise.all([
        request('/api/me/character', { method: 'PUT', cookie: first.cookie, body: { character: 'bread', migrate: true, expectedUserId: 'min' } }),
        request('/api/me/character', { method: 'PUT', cookie: second.cookie, body: { character: 'moon' } }),
      ]);
      expect(responses.map(response => response.status)).toEqual([200, 200]);
      expect(await db.prepare('SELECT character FROM users WHERE id = ?').bind('min').first('character')).toBe('moon');
      expect((await bootstrap(first.cookie)).user.character).toBe('moon');
    });
  });

  async function fund(amount: number, username: Username = 'min', database: Database = db) {
    const id = crypto.randomUUID();
    await database.prepare(`INSERT INTO ledger (id, user_id, currency, amount, reason, reference, created_at)
      VALUES (?, ?, 'gold', ?, 'test funding', ?, ?)`)
      .bind(id, username, amount, `fixture:${id}`, `${TODAY}T00:00:00.000Z`).run();
  }
  async function grantTicket(item: 'lotto_ticket' | 'speetto_ticket', amount: number, database: Database = db) {
    const id = crypto.randomUUID();
    await database.prepare(`INSERT INTO inventory_ledger (id, user_id, item, amount, reason, reference, created_at)
      VALUES (?, 'min', ?, ?, 'test funding', ?, ?)`)
      .bind(id, item, amount, `fixture:${id}`, `${TODAY}T00:00:00.000Z`).run();
  }
  async function getKuji(cookie: string, instance?: Miniflare) {
    const response = await request('/api/shop/kuji', { cookie, instance });
    expect(response.status).toBe(200);
    return response.json() as Promise<KujiResponse>;
  }
  async function positionsFor(boardId: number, grade: string, database: Database = db) {
    const raw = await database.prepare('SELECT grades FROM kuji_boards WHERE id = ?').bind(boardId).first<string>('grades');
    return (JSON.parse(raw!) as string[]).flatMap((value, position) => value === grade ? [position] : []);
  }
  async function buyKuji(cookie: string, boardId: number, positions: number[], requestId = crypto.randomUUID(), instance?: Miniflare) {
    const response = await request('/api/shop/kuji', { method: 'POST', cookie, instance, body: { requestId, boardId, positions } });
    expect(response.status).toBe(200);
    return response.json() as Promise<KujiResponse>;
  }
  async function shop(cookie: string, instance?: Miniflare) {
    const response = await request('/api/shop', { cookie, instance });
    expect(response.status).toBe(200);
    return response.json() as Promise<ShopState>;
  }

  describe('server shop economy', () => {
    it('creates one shared 100-ticket kuji board and reveals only sold grades', async () => {
      const min = await login('min');
      const siwon = await login('siwon');
      const [first, second] = await Promise.all([getKuji(min.cookie), getKuji(siwon.cookie)]);
      expect(first.kuji.boardId).toBe(second.kuji.boardId);
      expect(await db.prepare('SELECT COUNT(*) AS count FROM kuji_boards').first('count')).toBe(1);
      expect(first.kuji.cells).toHaveLength(100);
      expect(first.kuji.cells.every(cell => cell.grade === null && cell.buyerId === null)).toBe(true);
      expect(first.kuji.remaining).toBe(100);
      expect(first.kuji.remainingByGrade).toEqual({ A: 1, B: 2, C: 3, D: 6, E: 10, F: 15, G: 25, H: 38 });
      const grades = JSON.parse((await db.prepare('SELECT grades FROM kuji_boards').first<string>('grades'))!) as string[];
      expect(Object.fromEntries('ABCDEFGH'.split('').map(grade => [grade, grades.filter(item => item === grade).length])))
        .toEqual({ A: 1, B: 2, C: 3, D: 6, E: 10, F: 15, G: 25, H: 38 });
      await fund(1000);
      await buyKuji(min.cookie, first.kuji.boardId, [7]);
      const visible = await getKuji(siwon.cookie);
      expect(visible.kuji.cells[7]).toMatchObject({ position: 7, grade: grades[7], buyerId: 'min' });
      expect(visible.kuji.cells.filter(cell => cell.grade !== null)).toHaveLength(1);
      expect(visible.kuji.remaining).toBe(99);
    });

    it('charges 300G through the fifth ticket and 400G from the sixth in a multi-buy', async () => {
      const { cookie } = await login('min');
      await fund(4000);
      const { kuji } = await getKuji(cookie);
      const positions = await positionsFor(kuji.boardId, 'H');
      expect((await buyKuji(cookie, kuji.boardId, positions.slice(0, 4))).purchase?.cost).toBe(1200);
      const crossed = await buyKuji(cookie, kuji.boardId, positions.slice(4, 7));
      expect(crossed.purchase?.cost).toBe(1100);
      expect(crossed.gold).toBe(1700);
      expect(crossed.kuji).toMatchObject({ purchasedToday: 7, nextPrice: 400 });
      expect(crossed.inventory.speettoTickets).toBe(7);
    });

    it('computes concurrent fifth and sixth kuji prices from committed daily purchases', async () => {
      const { cookie } = await login('min');
      await fund(3000);
      const { kuji } = await getKuji(cookie);
      const positions = await positionsFor(kuji.boardId, 'H');
      await buyKuji(cookie, kuji.boardId, positions.slice(0, 4));
      const purchases = await Promise.all(positions.slice(4, 6).map(position => buyKuji(cookie, kuji.boardId, [position])));
      expect(purchases.map(result => result.purchase?.cost).sort()).toEqual([300, 400]);
      expect((await shop(cookie)).gold).toBe(1100);
      expect((await getKuji(cookie)).kuji.purchasedToday).toBe(6);
    });

    it('rejects an unaffordable kuji multi-buy without claiming or paying any selected cell', async () => {
      const { cookie } = await login('min');
      await fund(599);
      const { kuji } = await getKuji(cookie);
      const positions = await positionsFor(kuji.boardId, 'H');
      const response = await request('/api/shop/kuji', { method: 'POST', cookie,
        body: { requestId: crypto.randomUUID(), boardId: kuji.boardId, positions: positions.slice(0, 2) } });
      expect(response.status).toBe(409);
      expect(await db.prepare('SELECT COUNT(*) AS count FROM kuji_claims').first('count')).toBe(0);
      expect(await db.prepare('SELECT COUNT(*) AS count FROM shop_purchases').first('count')).toBe(0);
      expect((await shop(cookie))).toMatchObject({ gold: 599, inventory: { lottoTickets: 0, speettoTickets: 0 } });
      expect(await ledgerRows()).toHaveLength(1);
    });

    it('fails the whole kuji selection if one cell was sold', async () => {
      const { cookie } = await login('min');
      await fund(2000);
      const { kuji } = await getKuji(cookie);
      const [first, second] = await positionsFor(kuji.boardId, 'H');
      await buyKuji(cookie, kuji.boardId, [first!]);
      const response = await request('/api/shop/kuji', { method: 'POST', cookie,
        body: { requestId: crypto.randomUUID(), boardId: kuji.boardId, positions: [first, second] } });
      expect(response.status).toBe(409);
      expect(await db.prepare('SELECT COUNT(*) AS count FROM kuji_claims').first('count')).toBe(1);
      expect((await shop(cookie))).toMatchObject({ gold: 1700, inventory: { speettoTickets: 1 } });
    });

    it('serializes overlapping kuji multi-buys with one complete winner', async () => {
      const min = await login('min');
      const siwon = await login('siwon');
      await fund(600);
      await fund(600, 'siwon');
      const { kuji } = await getKuji(min.cookie);
      const positions = await positionsFor(kuji.boardId, 'H');
      const responses = await Promise.all([min.cookie, siwon.cookie].map((cookie, index) => request('/api/shop/kuji', {
        method: 'POST', cookie, body: { requestId: crypto.randomUUID(), boardId: kuji.boardId, positions: positions.slice(index, index + 2) },
      })));
      expect(responses.map(response => response.status).sort()).toEqual([200, 409]);
      expect(await db.prepare('SELECT COUNT(*) AS count FROM kuji_claims').first('count')).toBe(2);
      expect(await db.prepare('SELECT COUNT(*) AS count FROM shop_purchases').first('count')).toBe(1);
      expect((await Promise.all([shop(min.cookie), shop(siwon.cookie)])).map(state => state.gold).sort()).toEqual([0, 600]);
    });

    it('prevents concurrent different-cell purchases from overspending the same gold', async () => {
      const { cookie } = await login('min');
      await fund(300);
      const { kuji } = await getKuji(cookie);
      const positions = await positionsFor(kuji.boardId, 'H');
      const responses = await Promise.all(positions.slice(0, 2).map(position => request('/api/shop/kuji', {
        method: 'POST', cookie, body: { requestId: crypto.randomUUID(), boardId: kuji.boardId, positions: [position] },
      })));
      expect(responses.map(response => response.status).sort()).toEqual([200, 409]);
      expect((await shop(cookie)).gold).toBe(0);
      expect(await db.prepare('SELECT COUNT(*) AS count FROM kuji_claims').first('count')).toBe(1);
    });

    it('pays every kuji grade reward and inventory exactly once', async () => {
      const { cookie } = await login('min');
      await fund(10000);
      const { kuji } = await getKuji(cookie);
      const expected = [
        ['A', 100, 10, 0, 0], ['B', 50, 5, 0, 0], ['C', 30, 3, 0, 0], ['D', 10, 1, 0, 0],
        ['E', 0, 0, 3, 0], ['F', 0, 0, 1, 0], ['G', 0, 0, 0, 3], ['H', 0, 0, 0, 1],
      ] as const;
      for (const [grade, gold, score, lottoTickets, speettoTickets] of expected) {
        const [position] = await positionsFor(kuji.boardId, grade);
        const result = await buyKuji(cookie, kuji.boardId, [position!]);
        expect(result.purchase?.reward, grade).toEqual({ gold, score, lottoTickets, speettoTickets });
      }
      expect((await shop(cookie))).toMatchObject({ gold: 7490, inventory: { lottoTickets: 4, speettoTickets: 4 } });
      const view = await bootstrap(cookie);
      expect(view.user.weeklyScore).toBe(19);
      const scores = (await ledgerRows()).filter(row => row.currency === 'score');
      expect(scores.map(row => row.amount).sort((a, b) => a - b)).toEqual([1, 3, 5, 10]);
      expect(scores.every(row => row.week_start === '2026-10-26')).toBe(true);
    });

    it('pays last-one once, starts the next shared board, and retains daily pricing across boards', async () => {
      const { cookie } = await login('min');
      await fund(50000);
      const { kuji } = await getKuji(cookie);
      const requestId = crypto.randomUUID();
      await buyKuji(cookie, kuji.boardId, Array.from({ length: 99 }, (_, index) => index));
      const last = await buyKuji(cookie, kuji.boardId, [99], requestId);
      expect(last.purchase?.lastOne).toBe(true);
      expect(last.purchase!.reward.gold).toBeGreaterThanOrEqual(1000);
      const after = await getKuji(cookie);
      expect(after.kuji.boardId).toBeGreaterThan(kuji.boardId);
      expect(after.kuji).toMatchObject({ remaining: 100, purchasedToday: 100, nextPrice: 400 });
      const beforeReplay = await ledgerRows();
      const replay = await buyKuji(cookie, kuji.boardId, [99], requestId);
      expect(replay.purchase).toEqual(last.purchase);
      expect(await ledgerRows()).toEqual(beforeReplay);
      expect(await db.prepare('SELECT COUNT(*) AS count FROM kuji_claims WHERE board_id = ?').bind(after.kuji.boardId).first('count')).toBe(0);
      const [position] = await positionsFor(after.kuji.boardId, 'H');
      expect((await buyKuji(cookie, after.kuji.boardId, [position!])).purchase?.cost).toBe(400);
    });

    it('awards last-one once when the final two kuji cells sell concurrently', async () => {
      const { cookie } = await login('min');
      await fund(50000);
      const { kuji } = await getKuji(cookie);
      const finalPositions = (await positionsFor(kuji.boardId, 'H')).slice(0, 2);
      await buyKuji(cookie, kuji.boardId, Array.from({ length: 100 }, (_, index) => index).filter(position => !finalPositions.includes(position)));
      const results = await Promise.all(finalPositions.map(position => buyKuji(cookie, kuji.boardId, [position])));
      expect(results.map(result => result.purchase?.lastOne).sort()).toEqual([false, true]);
      expect(results.map(result => result.purchase?.reward.gold).sort((a, b) => Number(a) - Number(b))).toEqual([0, 1000]);
      expect((await ledgerRows()).filter(row => row.amount === 1000)).toHaveLength(1);
      const [first, second] = await Promise.all([getKuji(cookie), getKuji(cookie)]);
      expect(first.kuji.boardId).toBe(second.kuji.boardId);
      expect(first.kuji.remaining).toBe(100);
      expect(await db.prepare('SELECT COUNT(*) AS count FROM kuji_boards').first('count')).toBe(2);
    });

    it('replays concurrent identical kuji requests once and rejects a reused ID with another payload', async () => {
      const { cookie } = await login('min');
      await fund(1000);
      const { kuji } = await getKuji(cookie);
      const [first, second] = await positionsFor(kuji.boardId, 'H');
      const requestId = crypto.randomUUID();
      const results = await Promise.all([1, 2].map(() => buyKuji(cookie, kuji.boardId, [first!], requestId)));
      expect(results[0]!.purchase).toEqual(results[1]!.purchase);
      expect((await shop(cookie))).toMatchObject({ gold: 700, inventory: { speettoTickets: 1 } });
      expect((await request('/api/shop/kuji', { method: 'POST', cookie,
        body: { requestId, boardId: kuji.boardId, positions: [second] } })).status).toBe(409);
      expect(await db.prepare('SELECT COUNT(*) AS count FROM kuji_claims').first('count')).toBe(1);
    });

    it('keeps Sunday kuji scores in their game week and resets personal prices on Monday', async () => {
      const persistence = await mkdtemp(join(tmpdir(), 'yegoom-shop-week-'));
      let instance = runtime(await workerAt('2026-11-01T14:59:59Z'), persistence);
      try {
        const database = await instance.getD1Database('DB');
        await provision(database, migration, passwordHash);
        await fund(3000, 'min', database);
        const { cookie } = await login('min', instance);
        const { kuji } = await getKuji(cookie, instance);
        const [position] = await positionsFor(kuji.boardId, 'A', database);
        const result = await buyKuji(cookie, kuji.boardId, [position!], crypto.randomUUID(), instance);
        expect(result.purchase?.reward.score).toBe(10);
        expect((await ledgerRows(database)).find(row => row.currency === 'score')).toMatchObject({ amount: 10, week_start: '2026-10-26' });
        await instance.dispose();
        instance = runtime(await workerAt('2026-11-01T15:00:00Z'), persistence);
        const monday = await getKuji(cookie, instance);
        expect(monday.kuji).toMatchObject({ purchasedToday: 0, nextPrice: 300 });
        const response = await request('/api/bootstrap', { cookie, instance });
        expect(response.status).toBe(200);
        const view = await response.json() as BootstrapResponse;
        expect(view.user.weeklyScore).toBe(0);
        expect(view.dailyScores).toEqual([0, 0, 0, 0, 0, 0, 0]);
      } finally { await instance.dispose(); await rm(persistence, { recursive: true, force: true }); }
    });

    it.each([
      { kind: 'kuji', before: '2026-11-01T14:59:59Z', after: '2026-11-01T15:00:00Z' },
      { kind: 'lotto', before: '2026-10-30T07:59:59Z', after: '2026-10-30T08:00:00Z' },
    ])('rejects a $kind purchase crossing its SQL time boundary without partial writes', async ({ kind, before, after }) => {
      const instance = runtime(await workerAt(before, after));
      try {
        const database = await instance.getD1Database('DB');
        await provision(database, migration, passwordHash);
        await fund(1000, 'min', database);
        const { cookie } = await login('min', instance);
        const input = kind === 'kuji'
          ? { boardId: (await getKuji(cookie, instance)).kuji.boardId, positions: [0] }
          : { numbers: [1, 2, 3, 4, 5], payment: 'gold' };
        const response = await request(`/api/shop/${kind}`, { method: 'POST', cookie, instance, body: { requestId: crypto.randomUUID(), ...input } });
        expect(response.status).toBe(409);
        expect(await database.prepare('SELECT COUNT(*) AS count FROM shop_purchases').first('count')).toBe(0);
        expect(await database.prepare('SELECT COUNT(*) AS count FROM kuji_claims').first('count')).toBe(0);
        expect(await database.prepare('SELECT COUNT(*) AS count FROM lotto_tickets').first('count')).toBe(0);
        expect(await database.prepare('SELECT COUNT(*) AS count FROM inventory_ledger').first('count')).toBe(0);
        expect((await ledgerRows(database)).map(row => row.amount)).toEqual([1000]);
      } finally { await instance.dispose(); }
    });

    it('replays an original lotto purchase after the draw cutoff and KST midnight', async () => {
      const persistence = await mkdtemp(join(tmpdir(), 'yegoom-shop-replay-'));
      let instance = runtime(await workerAt(`${TODAY}T07:59:59Z`), persistence);
      try {
        const database = await instance.getD1Database('DB');
        await provision(database, migration, passwordHash);
        await fund(1000, 'min', database);
        const { cookie } = await login('min', instance);
        const body = { requestId: crypto.randomUUID(), numbers: [1, 2, 3, 4, 5], payment: 'gold' };
        const first = await request('/api/shop/lotto', { method: 'POST', cookie, instance, body });
        expect(first.status).toBe(200);
        const original = (await first.json() as LottoResponse).purchase!;
        for (const instant of [`${TODAY}T08:00:00Z`, `${TODAY}T15:00:00Z`]) {
          await instance.dispose();
          instance = runtime(await workerAt(instant), persistence);
          const replay = await request('/api/shop/lotto', { method: 'POST', cookie, instance, body });
          expect(replay.status).toBe(200);
          expect((await replay.json() as LottoResponse).purchase).toMatchObject({
            id: original.id, requestId: original.requestId, drawDate: TODAY, numbers: original.numbers, payment: 'gold', cost: 500,
          });
        }
        const persisted = await instance.getD1Database('DB');
        expect(await persisted.prepare('SELECT COUNT(*) AS count FROM lotto_tickets').first('count')).toBe(1);
        expect((await ledgerRows(persisted)).filter(row => row.amount < 0).map(row => row.amount)).toEqual([-500]);
      } finally { await instance.dispose(); await rm(persistence, { recursive: true, force: true }); }
    });

    it.each([
      ['2026-10-30T07:59:59Z', '2026-10-30'],
      ['2026-10-30T08:00:00Z', '2026-10-31'],
      ['2026-10-30T14:59:59Z', '2026-10-31'],
      ['2026-10-30T15:00:00Z', '2026-10-31'],
      ['2026-10-31T08:00:00Z', '2026-11-01'],
    ])('assigns the lotto target using server KST at %s', async (instant, drawDate) => {
      const instance = runtime(await workerAt(instant));
      try {
        const database = await instance.getD1Database('DB');
        await provision(database, migration, passwordHash);
        await fund(500, 'min', database);
        const { cookie } = await login('min', instance);
        const response = await request('/api/shop/lotto', { method: 'POST', cookie, instance,
          body: { requestId: crypto.randomUUID(), numbers: [1, 2, 3, 4, 5], payment: 'gold', drawDate: '2099-01-01' } });
        expect(response.status).toBe(200);
        const result = await response.json() as LottoResponse;
        expect(result.purchase).toMatchObject({ drawDate, cost: 500, payment: 'gold' });
        expect(result.gold).toBe(0);
      } finally { await instance.dispose(); }
    });

    it('creates the 17:00 lotto draw once across concurrent reads', async () => {
      const instance = runtime(await workerAt(`${TODAY}T08:00:00Z`));
      try {
        const database = await instance.getD1Database('DB');
        await provision(database, migration, passwordHash);
        const { cookie } = await login('min', instance);
        const responses = await Promise.all(['/api/shop/lotto', '/api/shop/lotto', '/api/bootstrap'].map(path => request(path, { cookie, instance })));
        expect(responses.map(response => response.status)).toEqual([200, 200, 200]);
        const views = await Promise.all(responses.slice(0, 2).map(response => response.json() as Promise<LottoResponse>));
        expect(views[0]!.lotto.todayDraw).toEqual(views[1]!.lotto.todayDraw);
        const numbers = views[0]!.lotto.todayDraw.numbers!;
        expect(new Set(numbers).size).toBe(5);
        expect(numbers.every(value => Number.isInteger(value) && value >= 1 && value <= 25)).toBe(true);
        expect(await database.prepare('SELECT COUNT(*) AS count FROM lotto_draws WHERE date = ?').bind(TODAY).first('count')).toBe(1);
      } finally { await instance.dispose(); }
    });

    it.each([1, 4])('settles due lotto before bootstrap reads gold with %i initial readers and never pays twice', async readers => {
      const { cookie } = await login('min');
      await fund(500);
      const purchaseResponse = await request('/api/shop/lotto', { method: 'POST', cookie,
        body: { requestId: crypto.randomUUID(), numbers: [1, 2, 3, 4, 5], payment: 'gold' } });
      expect(purchaseResponse.status).toBe(200);
      const purchase = (await purchaseResponse.json() as LottoResponse).purchase!;
      expect((await ledgerRows()).reduce((sum, row) => sum + row.amount, 0)).toBe(0);
      await db.prepare('UPDATE lotto_tickets SET draw_date = ? WHERE id = ?').bind('2026-10-29', purchase.id).run();
      await db.prepare('INSERT INTO lotto_draws (date, numbers, created_at) VALUES (?, ?, ?)')
        .bind('2026-10-29', JSON.stringify([1, 2, 3, 4, 5]), '2026-10-29T08:00:00.000Z').run();

      // Bootstrap is the first endpoint to encounter the due winning ticket.
      // Each response must include the payout in both the balance and ledger.
      const views = await Promise.all(Array.from({ length: readers }, () => bootstrap(cookie)));
      for (const view of views) {
        expect(view.user.gold).toBe(5000);
        expect(view.ledger.filter(row => row.currency === 'gold' && row.amount === 5000)).toHaveLength(1);
        expect(view.attendance).toMatchObject({ today: TODAY, claimed: false, canClaim: true });
        expect(view.inventory).toEqual({ lottoTickets: 0, speettoTickets: 0 });
      }
      const settled = await db.prepare('SELECT matches, rank, prize, settled_at FROM lotto_tickets WHERE id = ?')
        .bind(purchase.id).first<{ matches: number; rank: number; prize: number; settled_at: string | null }>();
      expect(settled).toMatchObject({ matches: 5, rank: 1, prize: 5000 });
      expect(settled?.settled_at).not.toBeNull();
      const afterFirstRead = await ledgerRows();
      expect(afterFirstRead.filter(row => row.reference === `lotto:prize:${purchase.id}`)).toHaveLength(1);
      for (let index = 0; index < 3; index++) expect((await bootstrap(cookie)).user.gold).toBe(5000);
      expect(await ledgerRows()).toEqual(afterFirstRead);
    });

    it('settles all lotto match counts and ranks exactly once from a historical draw', async () => {
      const { cookie } = await login('min');
      await fund(3000);
      const picks = [[1, 2, 3, 4, 5], [1, 2, 3, 4, 6], [1, 2, 3, 6, 7], [1, 2, 6, 7, 8], [1, 6, 7, 8, 9], [6, 7, 8, 9, 10]];
      for (const numbers of picks) {
        expect((await request('/api/shop/lotto', { method: 'POST', cookie,
          body: { requestId: crypto.randomUUID(), numbers, payment: 'gold' } })).status).toBe(200);
      }
      await db.prepare("UPDATE lotto_tickets SET draw_date = '2026-10-29'").run();
      await db.prepare('INSERT INTO lotto_draws (date, numbers, created_at) VALUES (?, ?, ?)')
        .bind('2026-10-29', JSON.stringify([1, 2, 3, 4, 5]), '2026-10-29T08:00:00.000Z').run();
      await bootstrap(cookie);
      const response = await request('/api/shop/lotto', { cookie });
      expect(response.status).toBe(200);
      const result = await response.json() as LottoResponse;
      expect(result.gold).toBe(9500);
      expect(result.lotto.tickets.map(ticket => [ticket.matches, ticket.rank, ticket.prize]).sort((a, b) => Number(b[0]) - Number(a[0])))
        .toEqual([[5, 1, 5000], [4, 2, 3000], [3, 3, 1000], [2, 4, 500], [1, null, 0], [0, null, 0]]);
      const ledger = await ledgerRows();
      await Promise.all([bootstrap(cookie), request('/api/shop/lotto', { cookie }), bootstrap(cookie)]);
      expect(await ledgerRows()).toEqual(ledger);
      expect(await db.prepare('SELECT COUNT(*) AS count FROM lotto_tickets WHERE settled_at IS NOT NULL').first('count')).toBe(6);
    });

    it('draws and settles missed past lotto dates on the first later request', async () => {
      const { cookie } = await login('min');
      await fund(1500);
      for (const date of ['2026-10-25', '2026-10-27', '2026-10-29']) {
        const response = await request('/api/shop/lotto', { method: 'POST', cookie,
          body: { requestId: crypto.randomUUID(), numbers: [1, 2, 3, 4, 5], payment: 'gold' } });
        expect(response.status).toBe(200);
        const { purchase } = await response.json() as LottoResponse;
        await db.prepare('UPDATE lotto_tickets SET draw_date = ? WHERE id = ?').bind(date, purchase!.id).run();
      }
      await bootstrap(cookie);
      const draws = await db.prepare('SELECT date FROM lotto_draws ORDER BY date').all<{ date: string }>();
      expect(draws.results.map(draw => draw.date)).toEqual(['2026-10-25', '2026-10-27', '2026-10-29']);
      expect(await db.prepare('SELECT COUNT(*) AS count FROM lotto_tickets WHERE settled_at IS NOT NULL').first('count')).toBe(3);
      const before = await ledgerRows();
      await bootstrap(cookie);
      expect(await ledgerRows()).toEqual(before);
    });

    it('allows more than five daily lotto purchases and deduplicates retried requests', async () => {
      const { cookie } = await login('min');
      await fund(6000);
      for (let index = 0; index < 11; index++) {
        expect((await request('/api/shop/lotto', { method: 'POST', cookie,
          body: { requestId: crypto.randomUUID(), numbers: [1, 2, 3, 4, 5], payment: 'gold' } })).status).toBe(200);
      }
      const body = { requestId: crypto.randomUUID(), numbers: [6, 7, 8, 9, 10], payment: 'gold' };
      const responses = await Promise.all([1, 2].map(() => request('/api/shop/lotto', { method: 'POST', cookie, body })));
      expect(responses.map(response => response.status)).toEqual([200, 200]);
      const results = await Promise.all(responses.map(response => response.json() as Promise<LottoResponse>));
      expect(results[0]!.purchase).toEqual(results[1]!.purchase);
      expect(await db.prepare('SELECT COUNT(*) AS count FROM lotto_tickets').first('count')).toBe(12);
      expect((await shop(cookie)).gold).toBe(0);
    });

    it.each(['lotto', 'speetto'] as const)('requires sufficient %s gold or tickets and consumes one ticket atomically', async kind => {
      const { cookie } = await login('min');
      const input = kind === 'lotto' ? { numbers: [1, 2, 3, 4, 5] } : {};
      for (const payment of ['gold', 'ticket']) {
        expect((await request(`/api/shop/${kind}`, { method: 'POST', cookie,
          body: { requestId: crypto.randomUUID(), payment, ...input } })).status).toBe(409);
      }
      await grantTicket(kind === 'lotto' ? 'lotto_ticket' : 'speetto_ticket', 1);
      const responses = await Promise.all([1, 2].map(() => request(`/api/shop/${kind}`, { method: 'POST', cookie,
        body: { requestId: crypto.randomUUID(), payment: 'ticket', ...input } })));
      expect(responses.map(response => response.status).sort()).toEqual([200, 409]);
      const result = await responses.find(response => response.status === 200)!.json() as LottoResponse | SpeettoResponse;
      expect(result.purchase).toMatchObject({ payment: 'ticket', cost: 0 });
      expect(result.inventory[kind === 'lotto' ? 'lottoTickets' : 'speettoTickets']).toBe(0);
      expect(await db.prepare('SELECT SUM(amount) AS total FROM inventory_ledger').first('total')).toBe(0);
      expect(await db.prepare('SELECT COUNT(*) AS count FROM shop_purchases').first('count')).toBe(1);
      await expect(db.prepare('UPDATE inventory_ledger SET amount = 999').run()).rejects.toThrow('append-only');
      await expect(db.prepare('DELETE FROM inventory_ledger').run()).rejects.toThrow('append-only');
    });

    it.each([0, 9, 10, 99])('uses the 10 percent speetto boundary for roll %s and persists prepaid outcomes', async roll => {
      const instant = `${TODAY}T00:00:00Z`;
      const instance = runtime(await workerAt(instant, instant, roll));
      try {
        const database = await instance.getD1Database('DB');
        await provision(database, migration, passwordHash);
        const payment = roll === 9 ? 'ticket' : 'gold';
        if (payment === 'ticket') await grantTicket('speetto_ticket', 1, database);
        else await fund(300, 'min', database);
        const { cookie } = await login('min', instance);
        const body = { requestId: crypto.randomUUID(), payment };
        const response = await request('/api/shop/speetto', { method: 'POST', cookie, instance, body });
        expect(response.status).toBe(200);
        const result = await response.json() as SpeettoResponse;
        expect(result.purchase).toMatchObject({ won: roll < 10, prize: roll < 10 ? 1500 : 0, payment, cost: payment === 'ticket' ? 0 : 300 });
        expect(result.inventory.speettoTickets).toBe(0);
        expect(result.gold).toBe(roll < 10 ? 1500 : 0);
        const cells = result.purchase!.cells;
        expect(cells).toHaveLength(3);
        const counts = [...new Set(cells)].map(value => cells.filter(cell => cell === value).length);
        expect(Math.max(...counts) >= 3).toBe(roll < 10);
        const replay = await request('/api/shop/speetto', { method: 'POST', cookie, instance, body });
        expect(replay.status).toBe(200);
        expect((await replay.json() as SpeettoResponse).purchase).toEqual(result.purchase);
        const saved = await request('/api/shop/speetto', { cookie, instance });
        expect((await saved.json() as SpeettoResponse).speetto.tickets[0]).toEqual(result.purchase);
        expect(await database.prepare('SELECT COUNT(*) AS count FROM shop_purchases').first('count')).toBe(1);
        expect((await ledgerRows(database)).filter(row => row.amount === 1500)).toHaveLength(roll < 10 ? 1 : 0);
      } finally { await instance.dispose(); }
    });

    it('deduplicates concurrent speetto requests into one debit and one persistent outcome', async () => {
      const { cookie } = await login('min');
      await fund(300);
      const body = { requestId: crypto.randomUUID(), payment: 'gold' };
      const responses = await Promise.all([1, 2].map(() => request('/api/shop/speetto', { method: 'POST', cookie, body })));
      expect(responses.map(response => response.status)).toEqual([200, 200]);
      const results = await Promise.all(responses.map(response => response.json() as Promise<SpeettoResponse>));
      expect(results[0]!.purchase).toEqual(results[1]!.purchase);
      expect((await shop(cookie)).gold).toBe(results[0]!.purchase!.prize);
      expect((await ledgerRows()).filter(row => row.amount < 0).map(row => row.amount)).toEqual([-300]);
      expect(await db.prepare('SELECT COUNT(*) AS count FROM shop_purchases').first('count')).toBe(1);
    });

    it('does not let a winning speetto prize fund its own purchase', async () => {
      const instant = `${TODAY}T00:00:00Z`;
      const instance = runtime(await workerAt(instant, instant, 0));
      try {
        const database = await instance.getD1Database('DB');
        await provision(database, migration, passwordHash);
        const { cookie } = await login('min', instance);
        const response = await request('/api/shop/speetto', { method: 'POST', cookie, instance,
          body: { requestId: crypto.randomUUID(), payment: 'gold' } });
        expect(response.status).toBe(409);
        expect(await ledgerRows(database)).toEqual([]);
        expect(await database.prepare('SELECT COUNT(*) AS count FROM shop_purchases').first('count')).toBe(0);
      } finally { await instance.dispose(); }
    });

    it('rejects reuse of a successful request ID for another shop product', async () => {
      const { cookie } = await login('min');
      await fund(1000);
      const requestId = crypto.randomUUID();
      expect((await request('/api/shop/lotto', { method: 'POST', cookie,
        body: { requestId, numbers: [1, 2, 3, 4, 5], payment: 'gold' } })).status).toBe(200);
      expect((await request('/api/shop/speetto', { method: 'POST', cookie, body: { requestId, payment: 'gold' } })).status).toBe(409);
      expect((await shop(cookie)).gold).toBe(500);
      expect(await db.prepare('SELECT COUNT(*) AS count FROM shop_purchases').first('count')).toBe(1);
    });

    it('enforces shop authentication, Origin, administrator and input validation boundaries', async () => {
      const min = await login('min');
      const admin = await login('admin');
      const { kuji } = await getKuji(min.cookie);
      const inputs = {
        kuji: { boardId: kuji.boardId, positions: [0] },
        lotto: { numbers: [1, 2, 3, 4, 5], payment: 'gold' },
        speetto: { payment: 'gold' },
      };
      for (const kind of ['kuji', 'lotto', 'speetto'] as const) {
        const body = { requestId: crypto.randomUUID(), ...inputs[kind] };
        expect((await request(`/api/shop/${kind}`)).status).toBe(401);
        expect((await request(`/api/shop/${kind}`, { method: 'POST', body })).status).toBe(401);
        expect((await request(`/api/shop/${kind}`, { method: 'POST', body, cookie: admin.cookie })).status).toBe(403);
        expect((await request(`/api/shop/${kind}`, { method: 'POST', body, cookie: min.cookie, origin: null })).status).toBe(403);
        for (const requestId of [null, '', 1, 'x'.repeat(129)]) {
          expect((await request(`/api/shop/${kind}`, { method: 'POST', cookie: min.cookie, body: { ...body, requestId } })).status).toBe(400);
        }
      }
      for (const numbers of [[], [1, 2, 3, 4], [1, 1, 2, 3, 4], [0, 1, 2, 3, 4], [1, 2, 3, 4, 26], [1, 2, 3, 4, 5.5], ['1', 2, 3, 4, 5]]) {
        expect((await request('/api/shop/lotto', { method: 'POST', cookie: min.cookie,
          body: { requestId: crypto.randomUUID(), numbers, payment: 'gold' } })).status).toBe(400);
      }
      for (const positions of [[], [0, 0], [-1], [100], [0.5], ['0']]) {
        expect((await request('/api/shop/kuji', { method: 'POST', cookie: min.cookie,
          body: { requestId: crypto.randomUUID(), boardId: kuji.boardId, positions } })).status).toBe(400);
      }
      for (const kind of ['lotto', 'speetto']) {
        expect((await request(`/api/shop/${kind}`, { method: 'POST', cookie: min.cookie,
          body: { requestId: crypto.randomUUID(), numbers: [1, 2, 3, 4, 5], payment: 'free' } })).status).toBe(400);
      }
      expect(await ledgerRows()).toEqual([]);
      expect(await db.prepare('SELECT COUNT(*) AS count FROM shop_purchases').first('count')).toBe(0);
    });
  });

  const scoringCases: { game: GameId; player: Username; thresholds: [number, number][] }[] = [
    { game: 'wake', player: 'siwon', thresholds: [[0, 30], [60, 25], [180, 20], [600, 15], [1800, 10], [3600, 5], [7200, 3]] },
    { game: 'offwork', player: 'min', thresholds: [[0, 30], [15, 25], [30, 20], [60, 15], [180, 10], [300, 5], [600, 1]] },
    { game: 'luck', player: 'min', thresholds: [[0, 30], [1, 25], [2, 20], [3, 15], [4, 10], [5, 5], [10, 3], [15, 1]] },
  ];
  it.each(scoringCases)('settles every $game score threshold and threshold + 1 through D1', async ({ game, player, thresholds }) => {
    const { cookie } = await login(player);
    const cases = thresholds.flatMap(([difference, points], index) => [
      { difference, points },
      { difference: difference + 1, points: thresholds[index + 1]?.[1] ?? 0 },
    ]);
    for (const [index, item] of cases.entries()) {
      const date = `2026-09-${String(index + 1).padStart(2, '0')}`;
      const time = new Date(Date.UTC(2026, 0, 1, 0, 0, item.difference)).toISOString().slice(11, 19);
      await seedRound({ game, date, answer: game === 'luck' ? '0' : '00:00:00',
        predictions: [[player, game === 'luck' ? String(item.difference) : time]], revealedAt: Date.parse(`${date}T01:00:00Z`) });
    }
    await bootstrap(cookie);
    const rows = await ledgerRows();
    for (const [index, item] of cases.entries()) {
      const date = `2026-09-${String(index + 1).padStart(2, '0')}`;
      const scoreRows = rows.filter(row => row.reference === `score:${game}:${date}:${player}`);
      expect(scoreRows.map(row => row.amount), `${game}: difference ${item.difference}`).toEqual(item.points ? [item.points] : []);
      // Closest still wins when every prediction scores zero.
      expect(rows.filter(row => row.reference === `first:${game}:${date}:${player}`).map(row => row.amount)).toEqual([100]);
    }
    expect(rows.some(row => row.amount === 0)).toBe(false);
    expect(await db.prepare('SELECT COUNT(*) AS count FROM game_rounds WHERE settled_at IS NOT NULL').first('count')).toBe(cases.length);
  });

  it('pays participation immediately once and never repeats it on edits', async () => {
    const { cookie } = await login('min');
    for (const value of ['41', '42', '43']) {
      expect((await request('/api/games/luck/prediction', { method: 'PUT', cookie, body: { value } })).status).toBe(200);
      expect((await bootstrap(cookie)).user.gold).toBe(100);
    }
    expect(await ledgerRows()).toEqual([{ user_id: 'min', currency: 'gold', amount: 100,
      reference: `predict:luck:${TODAY}:min`, week_start: null }]);
    expect(await db.prepare('SELECT value FROM predictions').first('value')).toBe('43');
  });

  it('pays participation once for two concurrent first saves', async () => {
    const { cookie } = await login('min');
    const responses = await Promise.all(['41', '42'].map(value => request('/api/games/luck/prediction', {
      method: 'PUT', cookie, body: { value },
    })));
    expect(responses.map(response => response.status)).toEqual([200, 200]);
    expect(await db.prepare('SELECT COUNT(*) AS count FROM predictions').first('count')).toBe(1);
    expect((await ledgerRows()).map(row => [row.reference, row.amount])).toEqual([[`predict:luck:${TODAY}:min`, 100]]);
    expect((await bootstrap(cookie)).user.gold).toBe(100);
  });

  it('pays all tied closest players and exposes actual score and gold results', async () => {
    const min = await login('min');
    const siwon = await login('siwon');
    const yeseo = await login('yeseo');
    for (const [cookie, value] of [[min.cookie, '43'], [siwon.cookie, '57']]) {
      expect((await request('/api/games/luck/prediction', { method: 'PUT', cookie, body: { value } })).status).toBe(200);
    }
    expect((await request('/api/games/luck/answer', { method: 'PUT', cookie: yeseo.cookie, body: { value: '50' } })).status).toBe(200);
    expect((await request('/api/games/luck/reveal', { method: 'POST', cookie: yeseo.cookie, body: {} })).status).toBe(200);
    const result = (await bootstrap(min.cookie)).games.find(game => game.id === 'luck')!;
    expect(result.results).toHaveLength(2);
    for (const row of result.results) expect(row).toMatchObject({ difference: 7, score: 3, isFirst: true, participationGold: 100, firstGold: 100, gold: 200 });
    expect((await ledgerRows()).filter(row => row.reference.startsWith('first:')).map(row => [row.user_id, row.amount])).toEqual([['min', 100], ['siwon', 100]]);
    expect((await bootstrap(min.cookie)).user).toMatchObject({ gold: 200, weeklyScore: 3 });
    expect((await bootstrap(siwon.cookie)).user).toMatchObject({ gold: 200, weeklyScore: 3 });
  });

  it('marks an empty revealed round settled without creating payouts', async () => {
    const { cookie } = await login('min');
    await seedRound({ game: 'luck', answer: '50', revealedAt: Date.parse(`${TODAY}T00:00:00Z`) });
    expect((await bootstrap(cookie)).games.find(game => game.id === 'luck')!.results).toEqual([]);
    expect(await ledgerRows()).toEqual([]);
    expect(await db.prepare('SELECT settled_at FROM game_rounds').first('settled_at')).not.toBeNull();
  });

  it('keeps a round without an answer pending and preserves its participation reward', async () => {
    const { cookie } = await login('min');
    expect((await request('/api/games/luck/prediction', { method: 'PUT', cookie, body: { value: '50' } })).status).toBe(200);
    await seedRound({ game: 'luck', date: '2026-10-29', predictions: [['min', '50']] });
    await bootstrap(cookie);
    expect((await ledgerRows()).map(row => row.reference)).toEqual([`predict:luck:${TODAY}:min`]);
    expect(await db.prepare('SELECT COUNT(*) AS count FROM game_rounds WHERE settled_at IS NOT NULL').first('count')).toBe(0);
    const history = await request('/api/games/luck/history', { cookie });
    expect((await history.json() as HistoryResponse).history).toEqual([]);
  });

  it('settles an automatically revealed round on its first read, even across concurrent endpoints', async () => {
    const { cookie } = await login('min');
    await seedRound({ game: 'offwork', answer: '09:00:00', revealAt: Date.parse(`${TODAY}T00:00:00Z`), predictions: [['min', '09:00:15']] });
    expect(await ledgerRows()).toEqual([]);
    const responses = await Promise.all(['/api/bootstrap', '/api/games/offwork', '/api/games/offwork/history', '/api/bootstrap']
      .map(path => request(path, { cookie })));
    expect(responses.map(response => response.status)).toEqual([200, 200, 200, 200]);
    const view = await responses[0]!.json() as BootstrapResponse;
    expect(view.user).toMatchObject({ gold: 100, weeklyScore: 25 });
    expect(view.ledger.map(row => row.amount).sort((a, b) => a - b)).toEqual([25, 100]);
    expect(view.games.find(game => game.id === 'offwork')).toMatchObject({ phase: 'revealed', answer: '09:00:00' });
    for (let index = 0; index < 3; index++) await bootstrap(cookie);
    expect((await ledgerRows()).map(row => [row.reference, row.amount])).toEqual([
      [`first:offwork:${TODAY}:min`, 100], [`score:offwork:${TODAY}:min`, 25],
    ]);
  });

  it('recovers settlement with an existing payout reference without double payment', async () => {
    const { cookie } = await login('min');
    await seedRound({ game: 'luck', answer: '50', revealedAt: Date.parse(`${TODAY}T00:00:00Z`), predictions: [['min', '50']] });
    await db.prepare(`INSERT INTO ledger (id, user_id, currency, amount, reason, reference, created_at, week_start)
      VALUES ('existing-score', 'min', 'score', 30, 'existing settlement', ?, ?, '2026-10-26')`)
      .bind(`score:luck:${TODAY}:min`, `${TODAY}T00:00:00.000Z`).run();
    await bootstrap(cookie);
    expect((await ledgerRows()).map(row => [row.reference, row.amount])).toEqual([
      [`first:luck:${TODAY}:min`, 100], [`score:luck:${TODAY}:min`, 30],
    ]);
    expect(await db.prepare('SELECT settled_at FROM game_rounds').first('settled_at')).not.toBeNull();
  });

  it('records wake from the server clock, ignores client time, and rejects later predictions', async () => {
    const min = await login('min');
    const siwon = await login('siwon');
    expect((await request('/api/games/wake/prediction', { method: 'PUT', cookie: siwon.cookie, body: { value: '08:59:59' } })).status).toBe(200);
    const response = await request('/api/games/wake/wake', { method: 'POST', cookie: min.cookie, body: { value: '23:59:59', time: '00:00:01', timestamp: 0 } });
    expect(response.status).toBe(200);
    expect((await response.json() as GameResponse).game).toMatchObject({ answer: '09:00:00', phase: 'revealed', canEditAnswer: false, canReveal: false });
    expect(await db.prepare('SELECT revealed_at FROM game_rounds').first('revealed_at')).toBe(Date.parse(`${TODAY}T00:00:00Z`));
    expect((await request('/api/games/wake/prediction', { method: 'PUT', cookie: siwon.cookie, body: { value: '09:00:00' } })).status).toBe(409);
    expect((await bootstrap(siwon.cookie)).user).toMatchObject({ gold: 200, weeklyScore: 25 });
  });

  it('serializes a prediction racing wake without paying a rejected submission', async () => {
    const min = await login('min');
    const siwon = await login('siwon');
    const [prediction, wake] = await Promise.all([
      request('/api/games/wake/prediction', { method: 'PUT', cookie: siwon.cookie, body: { value: '09:00:00' } }),
      request('/api/games/wake/wake', { method: 'POST', cookie: min.cookie, body: {} }),
    ]);
    expect(wake.status).toBe(200);
    expect([200, 409]).toContain(prediction.status);
    const accepted = prediction.status === 200;
    const view = await bootstrap(siwon.cookie);
    expect(view.games.find(game => game.id === 'wake')!.results).toHaveLength(accepted ? 1 : 0);
    expect(view.user).toMatchObject({ gold: accepted ? 200 : 0, weeklyScore: accepted ? 30 : 0 });
    const rows = await ledgerRows();
    expect(rows).toHaveLength(accepted ? 3 : 0);
    expect(rows.filter(row => row.reference === `predict:wake:${TODAY}:siwon`)).toHaveLength(accepted ? 1 : 0);
  });

  it('preserves the first wake time on repeated and concurrent wake calls', async () => {
    const { cookie } = await login('min');
    const firstTimestamp = Date.parse(`${TODAY}T00:00:00Z`) - 73_000;
    await seedRound({ game: 'wake', answer: '08:58:47', revealedAt: firstTimestamp });
    const responses = await Promise.all([1, 2].map(() => request('/api/games/wake/wake', {
      method: 'POST', cookie, body: { value: '12:00:00' },
    })));
    for (const response of responses) {
      expect(response.status).toBe(200);
      expect((await response.json() as GameResponse).game.answer).toBe('08:58:47');
    }
    expect(await db.prepare('SELECT revealed_at FROM game_rounds').first('revealed_at')).toBe(firstTimestamp);
  });

  it('allows only the wake author to wake and forbids manual wake answer editing', async () => {
    for (const username of ['siwon', 'yeseo', 'admin'] as const) {
      const { cookie } = await login(username);
      expect((await request('/api/games/wake/wake', { method: 'POST', cookie, body: {} })).status).toBe(403);
    }
    const { cookie } = await login('min');
    expect((await request('/api/games/wake/answer', { method: 'PUT', cookie, body: { value: '10:00:00' } })).status).toBe(400);
    expect((await request('/api/games/wake/reveal', { method: 'POST', cookie, body: {} })).status).toBe(400);
    expect(await db.prepare('SELECT COUNT(*) AS count FROM game_rounds').first('count')).toBe(0);
  });

  it('returns the latest three published past rounds, skipping gaps and hiding unpublished answers', async () => {
    const { cookie } = await login('min');
    for (const date of ['2026-10-20', '2026-10-22', '2026-10-25', '2026-10-27', TODAY]) {
      await seedRound({ game: 'luck', date, answer: '50', revealedAt: Date.parse(`${date}T09:00:00Z`), predictions: [['min', '49']] });
    }
    await seedRound({ game: 'luck', date: '2026-10-28' });
    await seedRound({ game: 'luck', date: '2026-10-29', answer: '88' });
    const response = await request('/api/games/luck/history', { cookie });
    expect(response.status).toBe(200);
    const { history } = await response.json() as HistoryResponse;
    expect(history.map(round => round.roundDate)).toEqual(['2026-10-27', '2026-10-25', '2026-10-22']);
    for (const round of history) {
      expect(round.answer).toBe('50');
      expect(round.results).toMatchObject([{ playerId: 'min', value: '49', difference: 1, score: 25, isFirst: true }]);
    }
    expect(JSON.stringify(history)).not.toContain('88');
    expect((await request('/api/games/luck/history')).status).toBe(401);
  });

  it('assigns delayed Sunday-night scores to the game week when first read on Monday', async () => {
    const monday = runtime(await workerAt('2026-11-01T15:00:01Z'));
    try {
      const mondayDb = await monday.getD1Database('DB');
      await provision(mondayDb, migration, passwordHash);
      await seedRound({ game: 'offwork', date: '2026-11-01', answer: '23:59:59', revealAt: Date.parse('2026-11-01T14:59:59Z'),
        predictions: [['min', '23:59:59']], database: mondayDb });
      const { cookie } = await login('min', monday);
      const response = await request('/api/bootstrap', { cookie, instance: monday });
      expect(response.status).toBe(200);
      const view = await response.json() as BootstrapResponse;
      expect(view.user).toMatchObject({ gold: 100, weeklyScore: 0 });
      expect(view.dailyScores).toEqual([0, 0, 0, 0, 0, 0, 0]);
      expect(view.players.find(player => player.username === 'min')?.weeklyScore).toBe(0);
      expect((await ledgerRows(mondayDb)).find(row => row.currency === 'score')).toMatchObject({
        amount: 30, reference: 'score:offwork:2026-11-01:min', week_start: '2026-10-26',
      });
    } finally { await monday.dispose(); }
  });

  it('builds daily scores by game date from all weekly ledger entries beyond the recent 50', async () => {
    const { cookie } = await login('min');
    await db.prepare(`INSERT INTO ledger (id, user_id, currency, amount, reason, reference, created_at, week_start)
      VALUES ('older-score', 'min', 'score', 30, 'earlier game', 'score:luck:2026-10-27:min', '2026-10-28T00:00:00Z', '2026-10-26')`).run();
    await db.batch(Array.from({ length: 51 }, (_, index) => db.prepare(`INSERT INTO ledger
      (id, user_id, currency, amount, reason, reference, created_at)
      VALUES (?, 'min', 'gold', 1, 'test fixture', ?, '2026-10-29T00:00:00Z')`).bind(`recent-${index}`, `fixture:${index}`)));
    await seedRound({ game: 'luck', date: '2026-10-29', answer: '50',
      revealAt: Date.parse('2026-10-29T09:00:00Z'), predictions: [['min', '51']] });
    const view = await bootstrap(cookie);
    expect(view.user.weeklyScore).toBe(55);
    expect(view.dailyScores).toEqual([0, 30, 0, 25, 0, 0, 0]);
    expect(view.ledger).toHaveLength(50);
    expect(view.ledger.some(entry => entry.id === 'older-score')).toBe(false);
    expect(view.ledger.find(entry => entry.currency === 'score')?.createdAt).toBe(`${TODAY}T00:00:00.000Z`);
  });

  it('accepts all valid second endpoints for predictions and off-work answers', async () => {
    const min = await login('min');
    const siwon = await login('siwon');
    for (const value of ['00:00:00', '12:34:56', '23:59:59']) {
      expect((await request('/api/games/offwork/prediction', { method: 'PUT', cookie: min.cookie, body: { value } })).status).toBe(200);
      expect((await request('/api/games/wake/prediction', { method: 'PUT', cookie: siwon.cookie, body: { value } })).status).toBe(200);
    }
    expect((await request('/api/games/offwork/answer', { method: 'PUT', cookie: siwon.cookie, body: { value: '23:59:59' } })).status).toBe(200);
    expect((await request('/api/games/offwork/answer', { method: 'PUT', cookie: siwon.cookie, body: { value: '00:00:00' } })).status).toBe(200);
  });

  it('requires authentication and resumes a session using only its cookie', async () => {
    expect((await request('/api/bootstrap')).status).toBe(401);
    const { cookie, setCookie, user } = await login('min');
    expect(setCookie).toMatch(/HttpOnly/i);
    expect(setCookie).toMatch(/SameSite=Strict/i);
    expect(setCookie).toMatch(/Max-Age=604800/i);
    expect(user.username).toBe('min');
    expect(user).not.toHaveProperty('password_hash');
    const resumed = await request('/api/auth/me', { cookie });
    expect(resumed.status).toBe(200);
    expect((await resumed.json() as { user: User }).user.id).toBe(user.id);
    expect(resumed.headers.get('cache-control')).toContain('no-store');
    const stored = await db.prepare('SELECT token_hash FROM sessions WHERE user_id = ?').bind(user.id).first<{ token_hash: string }>();
    const token = cookie.slice(cookie.indexOf('=') + 1);
    expect(stored?.token_hash).toBe(await hashToken(token));
    expect(stored?.token_hash).not.toBe(token);
  });

  it('rejects invalid credentials uniformly and throttles repeated attempts', async () => {
    const bad = await request('/api/auth/login', { method: 'POST', body: { username: 'min', password: 'wrong' } });
    const unknown = await request('/api/auth/login', { method: 'POST', body: { username: 'unknown', password: 'wrong' } });
    expect(bad.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(await bad.json()).toEqual(await unknown.json());
    for (let attempt = 1; attempt < 10; attempt++) {
      await request('/api/auth/login', { method: 'POST', body: { username: 'min', password: 'wrong' } });
    }
    const blocked = await request('/api/auth/login', { method: 'POST', body: { username: 'min', password: PASSWORD } });
    expect(blocked.status).toBe(429);
    expect(Number(blocked.headers.get('retry-after'))).toBeGreaterThan(0);
    expect(await db.prepare('SELECT COUNT(*) AS count FROM sessions').first('count')).toBe(0);
  });

  it('requires a matching Origin on login and authenticated mutations', async () => {
    for (const origin of [null, 'https://elsewhere.example']) {
      const response = await request('/api/auth/login', {
        method: 'POST', body: { username: 'min', password: PASSWORD }, origin,
      });
      expect(response.status).toBe(403);
    }
    const { cookie } = await login('min');
    expect((await request('/api/auth/logout', { method: 'POST', body: {}, cookie, origin: 'https://elsewhere.example' })).status).toBe(403);
    expect((await request('/api/games/luck/prediction', { method: 'PUT', body: { value: '44' }, cookie, origin: null })).status).toBe(403);
    expect((await request('/api/auth/me', { cookie })).status).toBe(200);
    expect(await db.prepare('SELECT COUNT(*) AS count FROM predictions').first('count')).toBe(0);
  });

  it('isolates player predictions and ignores a forged player identity', async () => {
    const min = await login('min');
    const siwon = await login('siwon');
    const first = await request('/api/games/luck/prediction', {
      method: 'PUT', cookie: min.cookie, body: { value: '41', playerId: 'siwon', userId: 'siwon' },
    });
    expect(first.status).toBe(200);
    expect((await first.json() as GameResponse).game.prediction).toBe('41');
    expect((await request('/api/games/luck/prediction', { method: 'PUT', cookie: siwon.cookie, body: { value: '63' } })).status).toBe(200);
    const minView = await bootstrap(min.cookie);
    const siwonView = await bootstrap(siwon.cookie);
    expect(minView.games.find(game => game.id === 'luck')?.prediction).toBe('41');
    expect(siwonView.games.find(game => game.id === 'luck')?.prediction).toBe('63');
    expect(minView.games.find(game => game.id === 'luck')?.results).toEqual([]);
    const rows = await db.prepare('SELECT player_id, value FROM predictions ORDER BY player_id').all();
    expect(rows.results).toEqual([{ player_id: 'min', value: '41' }, { player_id: 'siwon', value: '63' }]);
  });

  it('enforces author and administrator boundaries on the server', async () => {
    const yeseo = await login('yeseo');
    const admin = await login('admin');
    const min = await login('min');
    for (const cookie of [yeseo.cookie, admin.cookie]) {
      expect((await request('/api/games/luck/prediction', { method: 'PUT', cookie, body: { value: '55' } })).status).toBe(403);
    }
    for (const cookie of [min.cookie, admin.cookie]) {
      expect((await request('/api/games/luck/answer', { method: 'PUT', cookie, body: { value: '55', hint: '오늘의 힌트' } })).status).toBe(403);
      expect((await request('/api/games/luck/reveal', { method: 'POST', cookie, body: {} })).status).toBe(403);
    }
    expect(await db.prepare('SELECT COUNT(*) AS count FROM predictions').first('count')).toBe(0);
  });

  it('keeps answers private until early reveal and then closes all edits', async () => {
    const yeseo = await login('yeseo');
    const min = await login('min');
    const siwon = await login('siwon');
    const admin = await login('admin');
    expect((await request('/api/games/luck/answer', { method: 'PUT', cookie: yeseo.cookie, body: { value: '77', hint: '행운이 가득해요' } })).status).toBe(200);
    for (const cookie of [min.cookie, siwon.cookie, admin.cookie]) {
      const state = (await bootstrap(cookie)).games.find(game => game.id === 'luck')!;
      expect(state.answer).toBeNull();
      expect(state.hint).toBe('행운이 가득해요');
      expect(state.results).toEqual([]);
    }
    expect((await bootstrap(yeseo.cookie)).games.find(game => game.id === 'luck')?.answer).toBe('77');
    expect((await request('/api/games/luck/prediction', { method: 'PUT', cookie: min.cookie, body: { value: '80' } })).status).toBe(200);
    expect((await request('/api/games/luck/prediction', { method: 'PUT', cookie: siwon.cookie, body: { value: '70' } })).status).toBe(200);
    const reveal = await request('/api/games/luck/reveal', { method: 'POST', cookie: yeseo.cookie, body: {} });
    expect(reveal.status).toBe(200);
    const revealed = (await bootstrap(min.cookie)).games.find(game => game.id === 'luck')!;
    expect(revealed.phase).toBe('revealed');
    expect(revealed.answer).toBe('77');
    expect(revealed.canPredict).toBe(false);
    expect(revealed.results.map(result => [result.username, result.difference]).sort()).toEqual([['min', 3], ['siwon', 7]]);
    expect((await request('/api/games/luck/prediction', { method: 'PUT', cookie: min.cookie, body: { value: '77' } })).status).toBe(409);
    expect((await request('/api/games/luck/answer', { method: 'PUT', cookie: yeseo.cookie, body: { value: '80' } })).status).toBe(409);
    expect(await db.prepare('SELECT reference, amount FROM ledger ORDER BY reference').all()).toMatchObject({ results: [
      { reference: `first:luck:${TODAY}:min`, amount: 100 },
      { reference: `predict:luck:${TODAY}:min`, amount: 100 },
      { reference: `predict:luck:${TODAY}:siwon`, amount: 100 },
      { reference: `score:luck:${TODAY}:min`, amount: 15 },
      { reference: `score:luck:${TODAY}:siwon`, amount: 3 },
    ] });
  });

  it('rejects invalid game values without persisting them', async () => {
    const min = await login('min');
    const yeseo = await login('yeseo');
    const siwon = await login('siwon');
    for (const value of ['-1', '101', '01', '12.5', 55, null]) {
      expect((await request('/api/games/luck/prediction', { method: 'PUT', cookie: min.cookie, body: { value } })).status).toBe(400);
      expect((await request('/api/games/luck/answer', { method: 'PUT', cookie: yeseo.cookie, body: { value } })).status).toBe(400);
    }
    for (const value of ['24:00:00', '9:00:00', '12:60:00', '12:00:60', '12:00', '00:00', '23:59', '12:00:00.1', '12:00:00Z', "'; DROP TABLE users; --"]) {
      expect((await request('/api/games/offwork/prediction', { method: 'PUT', cookie: min.cookie, body: { value } })).status).toBe(400);
      expect((await request('/api/games/wake/prediction', { method: 'PUT', cookie: yeseo.cookie, body: { value } })).status).toBe(400);
      expect((await request('/api/games/offwork/answer', { method: 'PUT', cookie: siwon.cookie, body: { value } })).status).toBe(400);
    }
    expect(await db.prepare('SELECT COUNT(*) AS count FROM predictions').first('count')).toBe(0);
    expect(await db.prepare('SELECT COUNT(*) AS count FROM users').first('count')).toBe(4);
  });

  it('automatically reveals the off-work answer at its recorded time and closes predictions', async () => {
    const min = await login('min');
    const siwon = await login('siwon');
    expect((await request('/api/games/offwork/prediction', {
      method: 'PUT', cookie: min.cookie, body: { value: '09:05:00' },
    })).status).toBe(200);
    expect((await request('/api/games/offwork/answer', {
      method: 'PUT', cookie: siwon.cookie, body: { value: '09:00:00' },
    })).status).toBe(200);
    const revealed = (await bootstrap(min.cookie)).games.find(game => game.id === 'offwork')!;
    expect(revealed.phase).toBe('revealed');
    expect(revealed.answer).toBe('09:00:00');
    expect(revealed.results[0]?.difference).toBe(300);
    expect((await request('/api/games/offwork/prediction', {
      method: 'PUT', cookie: min.cookie, body: { value: '09:00:00' },
    })).status).toBe(409);
    expect((await request('/api/games/offwork/answer', {
      method: 'PUT', cookie: siwon.cookie, body: { value: '10:00:00' },
    })).status).toBe(409);
  });

  it('revokes the server session on logout', async () => {
    const { cookie } = await login('min');
    const response = await request('/api/auth/logout', { method: 'POST', body: {}, cookie });
    expect(response.status).toBe(200);
    expect(response.headers.get('set-cookie')).toMatch(/Max-Age=0/i);
    expect((await request('/api/auth/me', { cookie })).status).toBe(401);
    expect((await request('/api/bootstrap', { cookie })).status).toBe(401);
    expect(await db.prepare('SELECT COUNT(*) AS count FROM sessions').first('count')).toBe(0);
  });

  it('rejects a stale browser tab instead of saving its prediction into a new day', async () => {
    const { cookie } = await login('min');
    const stale = await request('/api/games/luck/prediction', {
      method: 'PUT', cookie, body: { value: '42', roundDate: '2026-10-29' },
    });
    expect(stale.status).toBe(409);
    const missingDate = await worker.dispatchFetch(`${ORIGIN}/api/games/luck/prediction`, {
      method: 'PUT', headers: { origin: ORIGIN, cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ value: '42' }),
    });
    expect(missingDate.status).toBe(409);
    expect(await db.prepare('SELECT COUNT(*) AS count FROM predictions').first('count')).toBe(0);
  });

  it('rejects a deactivated account even when its existing cookie is valid', async () => {
    const { cookie } = await login('min');
    await db.prepare('UPDATE users SET active = 0 WHERE username = ?').bind('min').run();
    expect((await request('/api/auth/me', { cookie })).status).toBe(401);
    expect((await request('/api/auth/login', { method: 'POST', body: { username: 'min', password: PASSWORD } })).status).toBe(401);
  });

  it('does not mint a session when the password is reset during an in-flight login', async () => {
    const script = await workerAt(`${TODAY}T00:00:00Z`);
    const marker = 'const token = randomToken();';
    expect(script.split(marker)).toHaveLength(2);
    const replacementHash = await hashPassword('a-new-password-after-reset');
    // Reproduce a second administrator connection resetting credentials exactly
    // after verification. This scheduling hook exists only in the test bundle.
    const raced = runtime(script.replace(marker,
      `await env.DB.prepare("UPDATE users SET password_hash = ? WHERE id = ?").bind(${JSON.stringify(replacementHash)}, user.id).run();\n${marker}`));
    try {
      const raceDb = await raced.getD1Database('DB');
      await provision(raceDb, migration, passwordHash);
      const response = await request('/api/auth/login', {
        method: 'POST', body: { username: 'min', password: PASSWORD }, instance: raced,
      });
      expect(response.status).toBe(401);
      expect(response.headers.get('set-cookie')).toBeNull();
      expect(await raceDb.prepare('SELECT COUNT(*) AS count FROM sessions').first('count')).toBe(0);
    } finally {
      await raced.dispose();
    }
  });

  it.each([
    { instant: '2026-10-30T01:29:59Z', status: 200 },
    { instant: '2026-10-30T01:30:00Z', status: 409 },
  ])('enforces the wake cutoff at $instant', async ({ instant, status }) => {
    const instance = runtime(await workerAt(instant));
    try {
      const database = await instance.getD1Database('DB');
      await provision(database, migration, passwordHash);
      const { cookie } = await login('siwon', instance);
      const response = await request('/api/games/wake/prediction', {
        method: 'PUT', cookie, body: { value: '10:15:30' }, instance,
      });
      expect(response.status).toBe(status);
      expect((await ledgerRows(database)).length).toBe(status === 200 ? 1 : 0);
    } finally { await instance.dispose(); }
  });

  it('does not pay if the prediction crosses the deadline before the conditional SQL write', async () => {
    const instance = runtime(await workerAt('2026-10-30T07:59:59Z', '2026-10-30T08:00:00Z'));
    try {
      const database = await instance.getD1Database('DB');
      await provision(database, migration, passwordHash);
      const { cookie } = await login('min', instance);
      const response = await request('/api/games/luck/prediction', {
        method: 'PUT', cookie, body: { value: '50' }, instance,
      });
      expect(response.status).toBe(409);
      expect(await database.prepare('SELECT COUNT(*) AS count FROM predictions').first('count')).toBe(0);
      expect(await ledgerRows(database)).toEqual([]);
    } finally { await instance.dispose(); }
  });

  it('does not pay a new participant after an early reveal', async () => {
    const { cookie } = await login('min');
    await seedRound({ game: 'luck', answer: '50', revealedAt: Date.parse(`${TODAY}T00:00:00Z`) });
    expect((await request('/api/games/luck/prediction', { method: 'PUT', cookie, body: { value: '50' } })).status).toBe(409);
    expect(await ledgerRows()).toEqual([]);
    expect(await db.prepare('SELECT COUNT(*) AS count FROM predictions').first('count')).toBe(0);
  });

  it.each([
    { instant: '2026-10-30T08:59:59Z', phase: 'closed', gold: 0 },
    { instant: '2026-10-30T09:00:00Z', phase: 'revealed', gold: 100 },
  ])('automatically reveals and settles luck at the 18:00 boundary: $instant', async ({ instant, phase, gold }) => {
    const instance = runtime(await workerAt(instant));
    try {
      const database = await instance.getD1Database('DB');
      await provision(database, migration, passwordHash);
      await seedRound({ game: 'luck', answer: '50', revealAt: Date.parse(`${TODAY}T09:00:00Z`), predictions: [['min', '50']], database });
      const { cookie } = await login('min', instance);
      const response = await request('/api/bootstrap', { cookie, instance });
      expect(response.status).toBe(200);
      const view = await response.json() as BootstrapResponse;
      expect(view.games.find(game => game.id === 'luck')).toMatchObject({ phase, answer: phase === 'revealed' ? '50' : null });
      expect(view.user.gold).toBe(gold);
      expect(view.user.weeklyScore).toBe(phase === 'revealed' ? 30 : 0);
    } finally { await instance.dispose(); }
  });

  it('lets the off-work author revise a hidden second-precision answer before revealing it', async () => {
    const siwon = await login('siwon');
    const min = await login('min');
    for (const value of ['17:45:10', '18:01:59']) {
      const response = await request('/api/games/offwork/answer', { method: 'PUT', cookie: siwon.cookie, body: { value } });
      expect(response.status).toBe(200);
      expect((await response.json() as GameResponse).game.answer).toBe(value);
      expect((await bootstrap(min.cookie)).games.find(game => game.id === 'offwork')?.answer).toBeNull();
    }
    expect(await db.prepare('SELECT reveal_at FROM game_rounds').first('reveal_at')).toBe(Date.parse(`${TODAY}T18:01:59+09:00`));
    expect((await request('/api/games/offwork/reveal', { method: 'POST', cookie: siwon.cookie, body: {} })).status).toBe(200);
    expect((await bootstrap(min.cookie)).games.find(game => game.id === 'offwork')?.answer).toBe('18:01:59');
  });

  it('limits luck hints to 200 characters and schedules the saved answer for 18:00', async () => {
    const { cookie } = await login('yeseo');
    expect((await request('/api/games/luck/answer', { method: 'PUT', cookie, body: { value: '50', hint: '가'.repeat(200) } })).status).toBe(200);
    expect(await db.prepare('SELECT reveal_at FROM game_rounds').first('reveal_at')).toBe(Date.parse(`${TODAY}T09:00:00Z`));
    expect((await request('/api/games/luck/answer', { method: 'PUT', cookie, body: { value: '51', hint: '가'.repeat(201) } })).status).toBe(400);
    expect(await db.prepare('SELECT answer FROM game_rounds').first('answer')).toBe('50');
  });

  it('keeps payouts append-only after the additive migration', async () => {
    const { cookie } = await login('min');
    expect((await request('/api/games/luck/prediction', { method: 'PUT', cookie, body: { value: '50' } })).status).toBe(200);
    await expect(db.prepare('UPDATE ledger SET amount = 999').run()).rejects.toThrow('append-only');
    await expect(db.prepare('DELETE FROM ledger').run()).rejects.toThrow('append-only');
    expect((await ledgerRows()).map(row => row.amount)).toEqual([100]);
  });

  it('rejects predictions at the exact 17:00 KST deadline', async () => {
    const atDeadline = runtime(await workerAt(`${TODAY}T08:00:00Z`));
    try {
      const deadlineDb = await atDeadline.getD1Database('DB');
      await provision(deadlineDb, migration, passwordHash);
      const { cookie } = await login('min', atDeadline);
      for (const [game, value] of [['offwork', '18:30:00'], ['luck', '50']]) {
        const response = await request(`/api/games/${game}/prediction`, {
          method: 'PUT', cookie, body: { value }, instance: atDeadline,
        });
        expect(response.status).toBe(409);
      }
      expect(await deadlineDb.prepare('SELECT COUNT(*) AS count FROM predictions').first('count')).toBe(0);
    } finally {
      await atDeadline.dispose();
    }
  });
});
