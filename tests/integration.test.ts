import { readFile, readdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { hashPassword, hashToken } from '../worker/crypto';
import { createBoard, simulateAttempt, type Board } from '../shared/claw-physics';
import { getClawState, getClawSummary, playClaw } from '../worker/claw';
import type { ClawResponse, ClawPlayInput, BootstrapResponse, GameResponse, GameId, HistoryResponse, AttendanceResponse, AttendanceClaimResponse, User, ShopState, KujiResponse, LottoResponse, SpeettoResponse, CatchmindResponse } from '../shared/types';

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

function drawingPng(width = 2, height = 2, decodedBytes?: number): string {
  const chunk = (kind: string, data: Buffer) => {
    const contents = Buffer.concat([Buffer.from(kind), data]);
    let crc = 0xffffffff;
    for (const value of contents) {
      crc ^= value;
      for (let bit = 0; bit < 8; bit++) crc = crc >>> 1 ^ (crc & 1 ? 0xedb88320 : 0);
    }
    const size = Buffer.alloc(4); size.writeUInt32BE(data.length);
    const checksum = Buffer.alloc(4); checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
    return Buffer.concat([size, contents, checksum]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width); header.writeUInt32BE(height, 4);
  header[8] = 8; header[9] = 6; // Eight-bit RGBA, standard compression/filtering.
  const chunks = [Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header),
    chunk('IDAT', deflateSync(Buffer.alloc(height * (width * 4 + 1))))];
  const ending = chunk('IEND', Buffer.alloc(0));
  if (decodedBytes !== undefined) {
    const prefix = Buffer.from('fixture\0');
    const padding = decodedBytes - Buffer.concat(chunks).length - ending.length - 12 - prefix.length;
    if (padding < 0) throw new Error('PNG fixture size is too small');
    chunks.push(chunk('tEXt', Buffer.concat([prefix, Buffer.alloc(padding, 120)])));
  }
  return `data:image/png;base64,${Buffer.concat([...chunks, ending]).toString('base64')}`;
}
const catchmindImagePath = (roundId: string) => `/api/catchmind/rounds/${encodeURIComponent(roundId)}/image`;
const DRAWING_PNG = drawingPng();
const DRAWING_WEBP = 'data:image/webp;base64,UklGRh4AAABXRUJQVlA4TBEAAAAvAUAAAAdQqMKXp/+BiOh/AAA=';
const DRAWING_WEBP_LOSSY = 'data:image/webp;base64,UklGRjoAAABXRUJQVlA4IC4AAADQAQCdASoCAAIAAUAmJaACdLoB+AADsAD+rhf/IL1b5tu3/3ZP9sn+2T/4wAAA';
const NONSQUARE_WEBP = 'data:image/webp;base64,UklGRh4AAABXRUJQVlA4TBEAAAAvAQAAAAdQqMKXp/+BiOh/AAA=';

/** Observe real D1 metadata without adding diagnostic headers to production APIs. */
function measuredClawDatabase(database: Database, now: number) {
  const queries: { sql: string; rowsRead: number; rowsWritten: number }[] = [];
  const originals = new WeakMap<object, { statement: ReturnType<Database['prepare']>; sql: string }>();
  const record = (sql: string, result: { meta: { rows_read?: number; rows_written?: number } }) => {
    expect(result.meta.rows_read).toBeTypeOf('number');
    queries.push({ sql, rowsRead: result.meta.rows_read!, rowsWritten: result.meta.rows_written ?? 0 });
  };
  const wrap = (statement: ReturnType<Database['prepare']>, sql: string): D1PreparedStatement => {
    const wrapped = {
      bind: (...values: unknown[]) => wrap(statement.bind(...values), sql),
      async all() { const result = await statement.all(); record(sql, result); return result; },
      async run() { const result = await statement.run(); record(sql, result); return result; },
      async first(column?: string) {
        // first() discards D1 meta; all() executes the same indexed SQL and exposes it.
        const result = await statement.all<Record<string, unknown>>(); record(sql, result);
        return column ? result.results[0]?.[column] ?? null : result.results[0] ?? null;
      },
    } as unknown as D1PreparedStatement;
    originals.set(wrapped, { statement, sql });
    return wrapped;
  };
  const binding = {
    prepare(sql: string) {
      // Mirror workerAt's isolated SQL clock for direct calls to the same module.
      return wrap(database.prepare(sql.replaceAll("unixepoch('now') * 1000", String(now))), sql);
    },
    async batch(statements: D1PreparedStatement[]) {
      const originalsForBatch = statements.map(statement => originals.get(statement)!);
      const results = await database.batch(originalsForBatch.map(item => item.statement));
      results.forEach((result, index) => record(originalsForBatch[index]!.sql, result));
      return results;
    },
  } as unknown as D1Database;
  return { binding, queries, reset() { queries.length = 0; }, rowsRead() { return queries.reduce((total, query) => total + query.rowsRead, 0); } };
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

  async function getCatchmind(cookie: string, instance?: Miniflare) {
    const response = await request('/api/catchmind', { cookie, instance });
    expect(response.status).toBe(200);
    return response.json() as Promise<CatchmindResponse>;
  }
  async function catchmindAction(action: string, cookie: string, roundId: string | null,
    extra: Record<string, unknown> = {}, instance?: Miniflare) {
    const response = await request(`/api/catchmind/${action}`, { method: 'POST', cookie, instance,
      body: { requestId: crypto.randomUUID(), roundId, ...extra } });
    expect(response.status).toBe(200);
    return response.json() as Promise<CatchmindResponse>;
  }
  async function openCatchmind(cookie: string, instance?: Miniflare) {
    const claimed = await catchmindAction('claim', cookie, null, {}, instance);
    const draft = claimed.catchmind.round!;
    const published = await catchmindAction('publish', cookie, draft.id,
      { wordVersion: draft.wordVersion, image: DRAWING_PNG }, instance);
    return published.catchmind.round!;
  }

  async function getClaw(cookie: string, instance?: Miniflare) {
    const response = await request('/api/claw', { cookie, instance });
    expect(response.status).toBe(200);
    return response.json() as Promise<ClawResponse>;
  }
  async function clawPlay(cookie: string, version: number, extra: Partial<ClawPlayInput> = {}, instance?: Miniflare) {
    const response = await request('/api/claw/play', { method: 'POST', cookie, instance,
      body: { requestId: crypto.randomUUID(), version, x: .05, stop: null, ...extra } });
    expect(response.status).toBe(200);
    return response.json() as Promise<ClawResponse>;
  }
  async function seedClawBoard(database: Database, board: Board, counter = 0) {
    await database.prepare('UPDATE claw_accounts SET board_json = ?, power_counter = ?, next_play_at = 0 WHERE user_id = ?')
      .bind(JSON.stringify(board), counter, 'min').run();
  }

  describe('server claw machine', () => {
    it('creates a private 30-doll machine and keeps bootstrap wallet summaries small and config-free', async () => {
      const { cookie } = await login('min');
      const view = await bootstrap(cookie);
      expect(view.claw).toMatchObject({ coins: 5, freeCoins: 5, purchasedCoins: 0, isAdmin: false });
      expect(view.claw).not.toHaveProperty('board');
      expect(await db.prepare('SELECT board_json FROM claw_accounts WHERE user_id = ?').bind('min').first('board_json')).toBeNull();
      const state = await getClaw(cookie);
      expect(state).toMatchObject({ freeCoins: 5, purchasedCoins: 0, generation: 1, version: 0, nextPlayAt: 0 });
      expect(state.board).toHaveLength(30);
      expect(new Set(state.board.map(doll => doll.id)).size).toBe(30);
      expect(state.board.every(doll => doll.type >= 1 && doll.type <= 11)).toBe(true);
      expect(state.nextGrantAt).toBe(Date.parse(`${TODAY}T03:00:00Z`));
      expect((await getClaw(cookie)).board).toEqual(state.board);
      expect(await db.prepare('SELECT COUNT(*) AS count FROM claw_accounts').first('count')).toBe(1);
      for (const payload of [state, view.claw]) {
        expect(JSON.stringify(payload)).not.toMatch(/payout.?every|weak.?pickup|weak.?carry|power.?counter/i);
      }
    });

    it('replaces free coins at KST 09:00 without carrying missed grants and keeps purchased coins', async () => {
      const persistence = await mkdtemp(join(tmpdir(), 'yegoom-claw-grant-'));
      let instance = runtime(await workerAt('2026-10-29T23:59:59Z'), persistence); // 08:59:59 KST
      try {
        let database = await instance.getD1Database('DB');
        await provision(database, migration, passwordHash);
        let { cookie } = await login('min', instance);
        await getClaw(cookie, instance);
        await database.prepare('UPDATE claw_accounts SET free_coins = 2, purchased_coins = 7 WHERE user_id = ?').bind('min').run();
        expect(await getClaw(cookie, instance)).toMatchObject({ freeCoins: 2, purchasedCoins: 7, nextGrantAt: Date.parse('2026-10-30T00:00:00Z') });
        for (const instant of ['2026-10-30T00:00:00Z', '2026-11-06T00:00:00Z']) {
          await instance.dispose();
          instance = runtime(await workerAt(instant), persistence);
          database = await instance.getD1Database('DB');
          ({ cookie } = await login('min', instance));
          const views = await Promise.all([getClaw(cookie, instance), getClaw(cookie, instance)]);
          expect(views.every(view => view.freeCoins === 5 && view.purchasedCoins === 7 && view.coins === 12)).toBe(true);
          await database.prepare('UPDATE claw_accounts SET free_coins = 1 WHERE user_id = ?').bind('min').run();
          expect((await getClaw(cookie, instance)).freeCoins).toBe(1);
        }
      } finally { await instance.dispose(); await rm(persistence, { recursive: true, force: true }); }
    });

    it('spends free coins first and never reduces purchased coins on a refill', async () => {
      const { cookie } = await login('min');
      let state = await getClaw(cookie);
      await db.prepare('UPDATE claw_accounts SET free_coins = 1, purchased_coins = 2 WHERE user_id = ?').bind('min').run();
      state = await clawPlay(cookie, state.version);
      expect(state).toMatchObject({ freeCoins: 0, purchasedCoins: 2, coins: 2 });
      await db.prepare('UPDATE claw_accounts SET next_play_at = 0 WHERE user_id = ?').bind('min').run();
      state = await clawPlay(cookie, state.version);
      expect(state).toMatchObject({ freeCoins: 0, purchasedCoins: 1, coins: 1 });
      await db.prepare('UPDATE claw_accounts SET last_grant_slot = last_grant_slot - 1 WHERE user_id = ?').bind('min').run();
      expect(await getClaw(cookie)).toMatchObject({ freeCoins: 5, purchasedCoins: 1, coins: 6 });
    });

    it.each([1, 5] as const)('buys %s coins once across repeated and concurrent identical requests', async quantity => {
      const { cookie } = await login('min');
      await fund(1000);
      const body = { requestId: crypto.randomUUID(), quantity };
      const responses = await Promise.all(Array.from({ length: 3 }, () => request('/api/claw/coins', { method: 'POST', cookie, body })));
      expect(responses.every(response => response.status === 200)).toBe(true);
      const views = await Promise.all(responses.map(response => response.json() as Promise<ClawResponse>));
      expect(views.every(view => view.purchasedCoins === quantity)).toBe(true);
      expect(views[0]!.purchase).toEqual({ ...body, cost: quantity * 100 });
      expect((await request('/api/claw/coins', { method: 'POST', cookie, body })).status).toBe(200);
      expect((await getClaw(cookie)).purchasedCoins).toBe(quantity);
      expect((await ledgerRows()).filter(row => row.amount < 0).map(row => row.amount)).toEqual([-quantity * 100]);
      expect(await db.prepare('SELECT COUNT(*) AS count FROM claw_coin_purchases').first('count')).toBe(1);
      expect((await bootstrap(cookie)).user.gold).toBe(1000 - quantity * 100);
    });

    it('rejects invalid quantities, insufficient gold and reused purchase IDs with a different quantity', async () => {
      const { cookie } = await login('min');
      for (const quantity of [0, 2, 4, 6, -1, 1.5, '1', null]) {
        expect((await request('/api/claw/coins', { method: 'POST', cookie, body: { requestId: crypto.randomUUID(), quantity } })).status).toBe(400);
      }
      await fund(99);
      const requestId = crypto.randomUUID();
      expect((await request('/api/claw/coins', { method: 'POST', cookie, body: { requestId, quantity: 1 } })).status).toBe(409);
      expect((await getClaw(cookie)).purchasedCoins).toBe(0);
      expect((await ledgerRows()).filter(row => row.amount < 0)).toEqual([]);
      await fund(1);
      expect((await request('/api/claw/coins', { method: 'POST', cookie, body: { requestId, quantity: 1 } })).status).toBe(200);
      expect((await request('/api/claw/coins', { method: 'POST', cookie, body: { requestId, quantity: 5 } })).status).toBe(409);
      expect((await bootstrap(cookie)).user.gold).toBe(0);
    });

    it('allows only one of two different purchases to spend the last 100G', async () => {
      const { cookie } = await login('min');
      await fund(100);
      const responses = await Promise.all(Array.from({ length: 2 }, () => request('/api/claw/coins', { method: 'POST', cookie,
        body: { requestId: crypto.randomUUID(), quantity: 1 } })));
      expect(responses.map(response => response.status).sort()).toEqual([200, 409]);
      expect((await getClaw(cookie)).purchasedCoins).toBe(1);
      expect((await bootstrap(cookie)).user.gold).toBe(0);
      expect((await ledgerRows()).filter(row => row.amount < 0).map(row => row.amount)).toEqual([-100]);
    });

    it('rolls back a coin receipt and wallet increment when the gold debit fails', async () => {
      const { cookie } = await login('min');
      await fund(100);
      await db.prepare(`CREATE TRIGGER reject_claw_debit BEFORE INSERT ON ledger
        WHEN NEW.amount < 0 BEGIN SELECT RAISE(ABORT, 'test debit failure'); END;`).run();
      const body = { requestId: crypto.randomUUID(), quantity: 1 };
      expect((await request('/api/claw/coins', { method: 'POST', cookie, body })).status).toBe(500);
      expect((await getClaw(cookie)).purchasedCoins).toBe(0);
      expect(await db.prepare('SELECT COUNT(*) AS count FROM claw_coin_purchases').first('count')).toBe(0);
      expect((await bootstrap(cookie)).user.gold).toBe(100);
      await db.prepare('DROP TRIGGER reject_claw_debit').run();
      expect((await request('/api/claw/coins', { method: 'POST', cookie, body })).status).toBe(200);
      expect((await getClaw(cookie)).purchasedCoins).toBe(1);
    });

    it('requires login and lets admins inspect a demo while rejecting purchases and plays', async () => {
      for (const path of ['/api/claw', '/api/claw/coins', '/api/claw/play']) {
        expect((await request(path, path === '/api/claw' ? {} : { method: 'POST', body: {} })).status).toBe(401);
      }
      const { cookie } = await login('admin');
      const demo = await getClaw(cookie);
      expect(demo).toMatchObject({ isAdmin: true, coins: 0, freeCoins: 0, purchasedCoins: 0 });
      expect(demo.board).toHaveLength(30);
      expect((await getClaw(cookie)).board).toEqual(demo.board);
      expect((await request('/api/claw/coins', { method: 'POST', cookie, body: { requestId: crypto.randomUUID(), quantity: 1 } })).status).toBe(403);
      expect((await request('/api/claw/play', { method: 'POST', cookie,
        body: { requestId: crypto.randomUUID(), version: 0, x: .5, stop: null } })).status).toBe(403);
      expect(await db.prepare('SELECT COUNT(*) AS count FROM claw_accounts WHERE user_id = ?').bind('admin').first('count')).toBe(0);
      expect(await ledgerRows()).toEqual([]);
      expect(JSON.stringify(demo)).not.toMatch(/payout.?every|weak.?pickup|weak.?carry|power.?counter/i);
    });

    it('validates request IDs, version, x and stop before spending a coin', async () => {
      const { cookie } = await login('min');
      const state = await getClaw(cookie);
      const valid = { requestId: crypto.randomUUID(), version: state.version, x: .5, stop: null };
      const invalid = [{ x: .049 }, { x: .951 }, { x: '0.5' }, { x: null }, { stop: 47.99 }, { stop: 420.01 },
        { stop: '48' }, { requestId: 'short' }, { requestId: 'a'.repeat(81) }, { requestId: 'bad id with spaces' },
        { version: -1 }, { version: .5 }, { version: Number.MAX_SAFE_INTEGER + 1 }];
      for (const extra of invalid) {
        expect((await request('/api/claw/play', { method: 'POST', cookie, body: { ...valid, ...extra } })).status).toBe(400);
      }
      expect(await getClaw(cookie)).toMatchObject({ freeCoins: 5, version: state.version, board: state.board });
      expect(await db.prepare('SELECT COUNT(*) AS count FROM claw_plays').first('count')).toBe(0);
    });

    it('accepts the original play input boundaries and rounds a manual stop to two decimals', async () => {
      const { cookie } = await login('min');
      let state = await getClaw(cookie);
      for (const [x, stop] of [[.05, 48], [.95, 420], [.5, 48.126]] as const) {
        state = await clawPlay(cookie, state.version, { x, stop });
        expect(state.result).toMatchObject({ x, stop: Number(stop.toFixed(2)) });
        await db.prepare('UPDATE claw_accounts SET next_play_at = 0 WHERE user_id = ?').bind('min').run();
      }
    });

    it('replays simultaneous identical plays from one receipt without another coin or version change', async () => {
      const { cookie } = await login('min');
      const state = await getClaw(cookie);
      const body = { requestId: crypto.randomUUID(), version: state.version, x: .05, stop: null };
      const responses = await Promise.all(Array.from({ length: 3 }, () => request('/api/claw/play', { method: 'POST', cookie, body })));
      expect(responses.map(response => response.status)).toEqual([200, 200, 200]);
      const views = await Promise.all(responses.map(response => response.json() as Promise<ClawResponse>));
      expect(views.every(view => JSON.stringify(view.result) === JSON.stringify(views[0]!.result))).toBe(true);
      const retry = await clawPlay(cookie, state.version, body);
      expect(retry.result).toEqual(views[0]!.result);
      expect(retry).toMatchObject({ freeCoins: 4, version: state.version + 1, replayed: true });
      expect(await db.prepare('SELECT COUNT(*) AS count FROM claw_plays').first('count')).toBe(1);
    });

    it('allows only one of two different plays on the same version', async () => {
      const { cookie } = await login('min');
      const state = await getClaw(cookie);
      const responses = await Promise.all(Array.from({ length: 2 }, () => request('/api/claw/play', { method: 'POST', cookie,
        body: { requestId: crypto.randomUUID(), version: state.version, x: .05, stop: null } })));
      expect(responses.map(response => response.status).sort()).toEqual([200, 409]);
      expect(await getClaw(cookie)).toMatchObject({ freeCoins: 4, version: state.version + 1 });
      expect(await db.prepare('SELECT COUNT(*) AS count FROM claw_plays').first('count')).toBe(1);
    });

    it('rejects a stale version, a cooldown and zero coins without modifying the machine', async () => {
      const { cookie } = await login('min');
      const state = await getClaw(cookie);
      const played = await clawPlay(cookie, state.version);
      for (const version of [state.version, played.version]) {
        expect((await request('/api/claw/play', { method: 'POST', cookie,
          body: { requestId: crypto.randomUUID(), version, x: .05, stop: null } })).status).toBe(409);
      }
      await db.prepare('UPDATE claw_accounts SET next_play_at = 0, free_coins = 0, purchased_coins = 0 WHERE user_id = ?').bind('min').run();
      expect((await request('/api/claw/play', { method: 'POST', cookie,
        body: { requestId: crypto.randomUUID(), version: played.version, x: .05, stop: null } })).status).toBe(409);
      expect(await getClaw(cookie)).toMatchObject({ version: played.version, board: played.board, coins: 0 });
      expect(await db.prepare('SELECT COUNT(*) AS count FROM claw_plays').first('count')).toBe(1);
    });

    it('rejects a play when the SQL write crosses the free-coin slot boundary', async () => {
      const instance = runtime(await workerAt('2026-10-29T23:59:59Z', '2026-10-30T00:00:00Z'));
      try {
        const database = await instance.getD1Database('DB');
        await provision(database, migration, passwordHash);
        const { cookie } = await login('min', instance);
        const state = await getClaw(cookie, instance);
        const response = await request('/api/claw/play', { method: 'POST', cookie, instance,
          body: { requestId: crypto.randomUUID(), version: state.version, x: .05, stop: null } });
        expect(response.status).toBe(409);
        expect(await getClaw(cookie, instance)).toMatchObject({ coins: 5, version: state.version, board: state.board });
        expect(await database.prepare('SELECT COUNT(*) AS count FROM claw_plays').first('count')).toBe(0);
        expect(await ledgerRows(database)).toEqual([]);
      } finally { await instance.dispose(); }
    });

    it('accepts a new play at the exact cooldown boundary and rejects a reused receipt with changed inputs', async () => {
      const { cookie } = await login('min');
      const state = await getClaw(cookie);
      const body = { requestId: crypto.randomUUID(), version: state.version, x: .05, stop: null };
      const first = await clawPlay(cookie, state.version, body);
      expect(first.nextPlayAt).toBe(Date.parse(`${TODAY}T00:00:06Z`));
      for (const extra of [{ x: .06 }, { stop: 48 }, { version: first.version }]) {
        expect((await request('/api/claw/play', { method: 'POST', cookie, body: { ...body, ...extra } })).status).toBe(409);
      }
      await db.prepare('UPDATE claw_accounts SET next_play_at = ? WHERE user_id = ?')
        .bind(Date.parse(`${TODAY}T00:00:00Z`), 'min').run();
      const second = await clawPlay(cookie, first.version);
      expect(second).toMatchObject({ freeCoins: 3, version: first.version + 1 });
      expect(await db.prepare('SELECT COUNT(*) AS count FROM claw_plays').first('count')).toBe(2);
    });

    it('makes exactly the configured coin strong and resets its counter even when it misses', async () => {
      const { cookie } = await login('min');
      let state = await getClaw(cookie);
      await db.prepare('UPDATE claw_config SET payout_every = 3 WHERE id = 1').run();
      for (const [index, strong] of [false, false, true, false].entries()) {
        state = await clawPlay(cookie, state.version);
        expect(state.result).toMatchObject({ caught: false, grip: { strong } });
        if (strong) expect(state.result!.grip).toEqual({ strong: true, pickup: 1, carry: 1 });
        expect(await db.prepare('SELECT power_counter FROM claw_accounts WHERE user_id = ?').bind('min').first('power_counter')).toBe((index + 1) % 3);
        await db.prepare('UPDATE claw_accounts SET next_play_at = 0 WHERE user_id = ?').bind('min').run();
      }
    });

    it.each([{ seed: 1, x: .23, count: 1 }, { seed: 3, x: .71, count: 2 }])('pays $count real simulated prizes once in gold and weekly score', async ({ seed, x, count }) => {
      const { cookie } = await login('min');
      const state = await getClaw(cookie);
      await db.prepare('UPDATE claw_config SET payout_every = 1 WHERE id = 1').run();
      await seedClawBoard(db, createBoard(1, seed));
      const body = { requestId: crypto.randomUUID(), x, stop: null };
      const played = await clawPlay(cookie, state.version, body);
      expect(played.result).toMatchObject({ caught: true, points: count, gold: count * 10, clearBonus: 0, clearGold: 0 });
      expect(played.result!.prizes).toHaveLength(count);
      expect(played.board).toHaveLength(30 - count);
      expect(await db.prepare('SELECT power_counter FROM claw_accounts WHERE user_id = ?').bind('min').first('power_counter')).toBe(0);
      const ledger = await ledgerRows();
      expect(ledger).toHaveLength(2);
      expect(ledger.find(row => row.currency === 'score')).toMatchObject({ amount: count, week_start: '2026-10-26' });
      expect(ledger.find(row => row.currency === 'gold')).toMatchObject({ amount: count * 10 });
      expect(ledger.every(row => row.reference.startsWith(`claw:doll:${played.result!.playId}`))).toBe(true);
      expect((await clawPlay(cookie, state.version, body)).result).toEqual(played.result);
      expect(await ledgerRows()).toEqual(ledger);
      expect((await bootstrap(cookie)).user).toMatchObject({ gold: count * 10, weeklyScore: count });
    });

    it('pays the final doll plus CLEAR once and prepares the next 30-doll generation', async () => {
      const { cookie } = await login('min');
      const state = await getClaw(cookie);
      await db.prepare('UPDATE claw_config SET payout_every = 1 WHERE id = 1').run();
      await seedClawBoard(db, [{ id: '1-1', type: 1, x: .5, y: .8, radius: 32, angle: 0 }]);
      const body = { requestId: crypto.randomUUID(), x: .5, stop: null };
      const played = await clawPlay(cookie, state.version, body);
      expect(played.result).toMatchObject({ caught: true, points: 6, gold: 310, clearBonus: 5, clearGold: 300 });
      expect(played).toMatchObject({ generation: 2, version: state.version + 1, freeCoins: 4 });
      expect(played.board).toHaveLength(30);
      expect(played.board.every(doll => doll.id.startsWith('2-'))).toBe(true);
      const ledger = await ledgerRows();
      expect(ledger.filter(row => row.currency === 'gold').map(row => row.amount).sort((a, b) => a - b)).toEqual([10, 300]);
      expect(ledger.filter(row => row.currency === 'score').map(row => row.amount).sort((a, b) => a - b)).toEqual([1, 5]);
      expect(ledger.filter(row => row.reference.startsWith(`claw:clear:${played.result!.playId}`))).toHaveLength(2);
      expect((await clawPlay(cookie, state.version, body)).result).toEqual(played.result);
      expect(await ledgerRows()).toEqual(ledger);
    });

    it('rolls back the receipt, coin, board and score if a simulated prize gold reward fails', async () => {
      const { cookie } = await login('min');
      const state = await getClaw(cookie);
      await db.prepare('UPDATE claw_config SET payout_every = 1 WHERE id = 1').run();
      const board = createBoard(1, 1);
      await seedClawBoard(db, board);
      await db.prepare(`CREATE TRIGGER reject_claw_reward BEFORE INSERT ON ledger
        WHEN NEW.currency = 'gold' AND NEW.reference LIKE 'claw:doll:%'
        BEGIN SELECT RAISE(ABORT, 'test prize failure'); END;`).run();
      const body = { requestId: crypto.randomUUID(), version: state.version, x: .23, stop: null };
      expect((await request('/api/claw/play', { method: 'POST', cookie, body })).status).toBe(500);
      expect(await getClaw(cookie)).toMatchObject({ freeCoins: 5, version: state.version, board });
      expect(await db.prepare('SELECT COUNT(*) AS count FROM claw_plays').first('count')).toBe(0);
      expect(await ledgerRows()).toEqual([]);
      await db.prepare('DROP TRIGGER reject_claw_reward').run();
      expect((await request('/api/claw/play', { method: 'POST', cookie, body })).status).toBe(200);
      expect((await getClaw(cookie)).freeCoins).toBe(4);
    });

    it.each([{ instant: '2026-11-01T14:59:59Z', week: '2026-10-26' }, { instant: '2026-11-01T15:00:00Z', week: '2026-11-02' }])(
      'uses the KST play week at $instant', async ({ instant, week }) => {
        const instance = runtime(await workerAt(instant));
        try {
          const database = await instance.getD1Database('DB');
          await provision(database, migration, passwordHash);
          const { cookie } = await login('min', instance);
          const state = await getClaw(cookie, instance);
          await database.prepare('UPDATE claw_config SET payout_every = 1 WHERE id = 1').run();
          await seedClawBoard(database, createBoard(1, 1));
          await clawPlay(cookie, state.version, { x: .23 }, instance);
          expect((await ledgerRows(database)).find(row => row.currency === 'score')).toMatchObject({ amount: 1, week_start: week });
        } finally { await instance.dispose(); }
      });

    it.each([0, 1])('uses injected random=%s for the weak grip jitter bounds without exposing configuration', async random => {
      const { cookie } = await login('min');
      const state = await getClaw(cookie);
      const observed = measuredClawDatabase(db, Date.parse(`${TODAY}T00:00:00Z`));
      const played = await playClaw(observed.binding, { id: 'min', role: 'player' },
        { requestId: crypto.randomUUID(), version: state.version, x: .05, stop: null }, Date.parse(`${TODAY}T00:00:00Z`), () => random);
      expect(played.result!.grip).toEqual({ strong: false, pickup: random === 0 ? .405 : .495, carry: random === 0 ? .27 : .33 });
      expect(JSON.stringify(played)).not.toMatch(/payout.?every|weak.?pickup|weak.?carry|power.?counter/i);
    });

    it('resets the counter after a weak-claw prize, independently of the guaranteed strong turn', async () => {
      const { cookie } = await login('min');
      const state = await getClaw(cookie);
      await db.prepare('UPDATE claw_config SET payout_every = 50, weak_pickup = 100, weak_carry = 100 WHERE id = 1').run();
      await seedClawBoard(db, createBoard(1, 1), 4);
      const now = Date.parse(`${TODAY}T00:00:00Z`);
      const observed = measuredClawDatabase(db, now);
      const played = await playClaw(observed.binding, { id: 'min', role: 'player' },
        { requestId: crypto.randomUUID(), version: state.version, x: .23, stop: null }, now, () => .5);
      expect(played.result).toMatchObject({ caught: true, grip: { strong: false, pickup: 1, carry: 1 } });
      expect(await db.prepare('SELECT power_counter FROM claw_accounts WHERE user_id = ?').bind('min').first('power_counter')).toBe(0);
    });

    it('serves machine reads, bootstrap and stored retries without running simulateAttempt again', async () => {
      const persistence = await mkdtemp(join(tmpdir(), 'yegoom-claw-replay-'));
      let instance = runtime(script, persistence);
      try {
        const database = await instance.getD1Database('DB');
        await provision(database, migration, passwordHash);
        const { cookie } = await login('min', instance);
        const state = await getClaw(cookie, instance);
        const body = { requestId: crypto.randomUUID(), version: state.version, x: .05, stop: null };
        const first = await clawPlay(cookie, state.version, body, instance);
        await instance.dispose();
        const signature = /(function simulateAttempt\([\s\S]*?\) \{)/;
        expect(script).toMatch(signature);
        instance = runtime(script.replace(signature, '$1 throw new Error("Unexpected claw simulation on a read or retry");'), persistence);
        expect((await getClaw(cookie, instance)).board).toEqual(first.board);
        expect((await request('/api/bootstrap', { cookie, instance })).status).toBe(200);
        const retried = await clawPlay(cookie, state.version, body, instance);
        expect(retried.result).toEqual(first.result);
        expect(retried).toMatchObject({ replayed: true, freeCoins: 4, version: first.version });
        const persisted = await instance.getD1Database('DB');
        expect(await persisted.prepare('SELECT COUNT(*) AS count FROM claw_plays').first('count')).toBe(1);
      } finally { await instance.dispose(); await rm(persistence, { recursive: true, force: true }); }
    });

    it('keeps machine and bootstrap-summary D1 reads bounded to the requesting account', async () => {
      const { cookie } = await login('min');
      await getClaw(cookie);
      const other = await login('siwon');
      await getClaw(other.cookie);
      await db.prepare('UPDATE claw_accounts SET free_coins = 1, last_grant_slot = last_grant_slot - 1 WHERE user_id = ?').bind('siwon').run();
      const now = Date.parse(`${TODAY}T00:00:00Z`);
      const observed = measuredClawDatabase(db, now);
      const user = { id: 'min', role: 'player' as const };
      await getClawState(observed.binding, user, now);
      const machineRowsRead = observed.rowsRead();
      const machineQueries = [...observed.queries];
      observed.reset();
      await getClawSummary(observed.binding, user, now);
      const summaryRowsRead = observed.rowsRead();
      const summaryQueries = [...observed.queries];
      for (const queries of [machineQueries, summaryQueries]) {
        expect(queries.length).toBeGreaterThan(0);
        expect(queries.every(query => !/SUM\(|claw_plays|claw_coin_purchases|FROM users/i.test(query.sql))).toBe(true);
        expect(queries.every(query => /user_id\s*=\s*\?/i.test(query.sql))).toBe(true);
      }
      expect(await db.prepare('SELECT free_coins FROM claw_accounts WHERE user_id = ?').bind('siwon').first('free_coins')).toBe(1);
      expect(machineRowsRead).toBeLessThanOrEqual(12);
      expect(summaryRowsRead).toBeLessThanOrEqual(12);
      console.log(`Claw D1 meta rows_read: GET machine=${machineRowsRead}, bootstrap claw summary=${summaryRowsRead} (authenticated module calls; existing bootstrap queries excluded)`);
    });

    it('enforces config ranges and nonnegative balances at the database boundary', async () => {
      const { cookie } = await login('min');
      await getClaw(cookie);
      expect(await db.prepare('SELECT payout_every, weak_pickup, weak_carry FROM claw_config WHERE id = 1').first())
        .toEqual({ payout_every: 10, weak_pickup: 45, weak_carry: 30 });
      for (const [column, values] of [['payout_every', [0, 51]], ['weak_pickup', [4, 101]], ['weak_carry', [4, 101]]] as const) {
        for (const value of values) await expect(db.prepare(`UPDATE claw_config SET ${column} = ? WHERE id = 1`).bind(value).run()).rejects.toThrow();
      }
      for (const column of ['free_coins', 'purchased_coins']) {
        await expect(db.prepare(`UPDATE claw_accounts SET ${column} = -1 WHERE user_id = ?`).bind('min').run()).rejects.toThrow();
      }
    });
  });

  describe('server catchmind rounds', () => {
    it('lets only one concurrent claimant take the shared drawing turn', async () => {
      const min = await login('min');
      const siwon = await login('siwon');
      expect((await getCatchmind(min.cookie)).catchmind).toMatchObject({ round: null, turn: null, canClaim: true });
      const responses = await Promise.all([min.cookie, siwon.cookie].map(cookie => request('/api/catchmind/claim', {
        method: 'POST', cookie, body: { requestId: crypto.randomUUID(), roundId: null },
      })));
      expect(responses.map(response => response.status).sort()).toEqual([200, 409]);
      const views = await Promise.all([getCatchmind(min.cookie), getCatchmind(siwon.cookie)]);
      expect(views[0]!.catchmind.round?.id).toBe(views[1]!.catchmind.round?.id);
      expect(views[0]!.catchmind.turn?.id).toBe(views[0]!.catchmind.round?.drawer.id);
      expect(views.every(view => !view.catchmind.canClaim)).toBe(true);
      expect(await ledgerRows()).toEqual([]);
    });

    it('keeps the chosen word private from other players, administrators, and bootstrap summaries', async () => {
      const min = await login('min');
      const other = await login('siwon');
      const admin = await login('admin');
      const requestId = crypto.randomUUID();
      const first = await catchmindAction('claim', min.cookie, null, { requestId, userId: 'siwon', word: 'forged-private-word' });
      const draft = first.catchmind.round!;
      expect(draft.drawer.id).toBe('min');
      expect(draft.word).toBeTruthy();
      expect(draft.word).not.toBe('forged-private-word');
      expect((await catchmindAction('claim', min.cookie, null, { requestId, userId: 'siwon', word: 'forged-private-word' })).catchmind.round?.id).toBe(draft.id);
      for (const phase of ['draft', 'open']) {
        if (phase === 'open') await catchmindAction('publish', min.cookie, draft.id, { wordVersion: draft.wordVersion, image: DRAWING_PNG });
        for (const cookie of [other.cookie, admin.cookie]) {
          const view = await getCatchmind(cookie);
          expect(view.catchmind.round).toMatchObject({ id: draft.id, status: phase, word: null });
          expect(JSON.stringify(view)).not.toContain(draft.word!);
          expect(JSON.stringify((await bootstrap(cookie)).catchmind)).not.toContain(draft.word!);
        }
      }
      expect((await getCatchmind(admin.cookie)).catchmind).toMatchObject({
        canClaim: false, canReroll: false, canPublish: false, canGuess: false, canEnd: false, canNext: false,
      });
    });

    it('allows three distinct rerolls and rejects stale word versions and a fourth reroll', async () => {
      const { cookie } = await login('min');
      let round = (await catchmindAction('claim', cookie, null)).catchmind.round!;
      const words = [round.word];
      for (let index = 1; index <= 3; index++) {
        round = (await catchmindAction('reroll', cookie, round.id, { wordVersion: round.wordVersion })).catchmind.round!;
        expect(round.wordVersion).toBe(index);
        expect(round.rerollsLeft).toBe(3 - index);
        expect(words).not.toContain(round.word);
        words.push(round.word);
      }
      for (const [action, extra] of [
        ['reroll', { wordVersion: round.wordVersion }],
        ['publish', { wordVersion: 0, image: DRAWING_PNG }],
      ] as const) {
        expect((await request(`/api/catchmind/${action}`, { method: 'POST', cookie,
          body: { requestId: crypto.randomUUID(), roundId: round.id, ...extra } })).status).toBe(409);
      }
      expect((await getCatchmind(cookie)).catchmind.round).toMatchObject({ status: 'draft', image: null, wordVersion: 3, rerollsLeft: 0 });
    });

    it('serializes concurrent rerolls of the same word version', async () => {
      const { cookie } = await login('min');
      const round = (await catchmindAction('claim', cookie, null)).catchmind.round!;
      const responses = await Promise.all([1, 2].map(() => request('/api/catchmind/reroll', { method: 'POST', cookie,
        body: { requestId: crypto.randomUUID(), roundId: round.id, wordVersion: round.wordVersion } })));
      expect(responses.map(response => response.status).sort()).toEqual([200, 409]);
      expect((await getCatchmind(cookie)).catchmind.round).toMatchObject({ wordVersion: 1, rerollsLeft: 2 });
    });

    it('allows only the drawer to publish and freezes the published drawing and word', async () => {
      const min = await login('min');
      const siwon = await login('siwon');
      const draft = (await catchmindAction('claim', min.cookie, null)).catchmind.round!;
      const body = { requestId: crypto.randomUUID(), roundId: draft.id, wordVersion: draft.wordVersion, image: DRAWING_PNG };
      expect((await request('/api/catchmind/publish', { method: 'POST', cookie: siwon.cookie, body })).status).toBe(403);
      expect((await request('/api/catchmind/publish', { method: 'POST', cookie: min.cookie, body })).status).toBe(200);
      expect((await request('/api/catchmind/publish', { method: 'POST', cookie: min.cookie, body })).status).toBe(200);
      expect((await request('/api/catchmind/publish', { method: 'POST', cookie: min.cookie,
        body: { ...body, requestId: crypto.randomUUID(), image: drawingPng(3, 3) } })).status).toBe(409);
      expect((await request('/api/catchmind/reroll', { method: 'POST', cookie: min.cookie,
        body: { requestId: crypto.randomUUID(), roundId: draft.id, wordVersion: draft.wordVersion } })).status).toBe(409);
      const view = await getCatchmind(min.cookie);
      expect(view.catchmind.round).toMatchObject({ status: 'open', image: catchmindImagePath(draft.id), word: draft.word, publishedAt: `${TODAY}T00:00:00.000Z` });
      const storedImage = await request(catchmindImagePath(draft.id), { cookie: min.cookie });
      expect(Buffer.from(await storedImage.arrayBuffer())).toEqual(Buffer.from(DRAWING_PNG.split(',')[1]!, 'base64'));
      expect(view.catchmind).toMatchObject({ canPublish: false, canReroll: false, canGuess: false, canEnd: true });
    });

    it('does not consume another wrong attempt when a guess request is retried concurrently', async () => {
      const min = await login('min');
      const siwon = await login('siwon');
      const round = await openCatchmind(min.cookie);
      const body = { requestId: crypto.randomUUID(), roundId: round.id, answer: `오답-${round.word}` };
      const responses = await Promise.all([1, 2].map(() => request('/api/catchmind/guess', { method: 'POST', cookie: siwon.cookie, body })));
      expect(responses.map(response => response.status)).toEqual([200, 200]);
      const state = (await getCatchmind(min.cookie)).catchmind.round!;
      expect(state.wrongCount).toBe(1);
      expect(state.guesses).toHaveLength(1);
      expect(state.guesses[0]).toMatchObject({ answer: body.answer, correct: false, player: { id: 'siwon' } });
      expect((await request('/api/catchmind/guess', { method: 'POST', cookie: siwon.cookie,
        body: { ...body, answer: '다른 오답' } })).status).toBe(409);
      expect((await getCatchmind(min.cookie)).catchmind.round!.wrongCount).toBe(1);
    });

    it('shares all wrong guesses, opens the hint at three, and ends at six while retaining the drawer', async () => {
      const min = await login('min');
      const siwon = await login('siwon');
      const yeseo = await login('yeseo');
      const round = await openCatchmind(min.cookie);
      const normalized = Array.from(round.word!.replace(/\s/g, ''));
      for (let index = 1; index <= 6; index++) {
        const cookie = index % 2 ? siwon.cookie : yeseo.cookie;
        const state = (await catchmindAction('guess', cookie, round.id, { answer: `오답${index}-${round.word}` })).catchmind;
        expect(state.round!.wrongCount).toBe(index);
        expect(state.round!.guesses).toHaveLength(index);
        expect(state.round!.hint).toEqual(index < 3 ? null : { firstCharacter: normalized[0], length: normalized.length });
        expect(state.round!.status).toBe(index < 6 ? 'open' : 'ended');
        if (index === 6) expect(state).toMatchObject({ round: { endReason: 'misses', word: round.word, winner: null }, turn: { id: 'min' } });
      }
      expect(await ledgerRows()).toEqual([]);
      expect((await request('/api/catchmind/next', { method: 'POST', cookie: siwon.cookie,
        body: { requestId: crypto.randomUUID(), roundId: round.id } })).status).toBe(403);
      const next = (await catchmindAction('next', min.cookie, round.id)).catchmind.round!;
      expect(next).toMatchObject({ number: round.number + 1, status: 'draft', drawer: { id: 'min' }, wrongCount: 0 });
      expect(next.id).not.toBe(round.id);
    });

    it('allows only one of two concurrent final wrong guesses to close the round', async () => {
      const min = await login('min');
      const siwon = await login('siwon');
      const yeseo = await login('yeseo');
      const round = await openCatchmind(min.cookie);
      for (let index = 0; index < 5; index++) await catchmindAction('guess', siwon.cookie, round.id, { answer: `오답${index}-${round.word}` });
      const responses = await Promise.all([siwon.cookie, yeseo.cookie].map(cookie => request('/api/catchmind/guess', { method: 'POST', cookie,
        body: { requestId: crypto.randomUUID(), roundId: round.id, answer: `마지막오답-${round.word}` } })));
      expect(responses.map(response => response.status).sort()).toEqual([200, 409]);
      const ended = (await getCatchmind(min.cookie)).catchmind.round!;
      expect(ended).toMatchObject({ status: 'ended', endReason: 'misses', wrongCount: 6 });
      expect(ended.guesses).toHaveLength(6);
      expect(await ledgerRows()).toEqual([]);
    });

    it.each([0, 3])('ignores whitespace in a correct answer and pays 3 points plus 5G after %i wrong guesses', async wrongBefore => {
      const min = await login('min');
      const siwon = await login('siwon');
      const round = await openCatchmind(min.cookie);
      for (let index = 0; index < wrongBefore; index++) await catchmindAction('guess', siwon.cookie, round.id, { answer: `오답${index}-${round.word}` });
      expect((await request('/api/catchmind/guess', { method: 'POST', cookie: min.cookie,
        body: { requestId: crypto.randomUUID(), roundId: round.id, answer: round.word } })).status).toBe(403);
      const answer = ` \t${Array.from(round.word!.replace(/\s/g, '')).join(' \t')}　`;
      const requestId = crypto.randomUUID();
      const solved = await catchmindAction('guess', siwon.cookie, round.id, { requestId, answer });
      expect(solved.catchmind).toMatchObject({ round: { status: 'ended', endReason: 'correct', winner: { id: 'siwon' }, word: round.word }, turn: { id: 'siwon' }, canNext: true });
      expect((await bootstrap(siwon.cookie)).user).toMatchObject({ gold: 5, weeklyScore: 3 });
      expect((await ledgerRows()).map(row => [row.user_id, row.currency, row.amount]).sort()).toEqual([['siwon', 'gold', 5], ['siwon', 'score', 3]]);
      await catchmindAction('guess', siwon.cookie, round.id, { requestId, answer });
      await Promise.all([getCatchmind(siwon.cookie), bootstrap(siwon.cookie), bootstrap(min.cookie)]);
      expect(await ledgerRows()).toHaveLength(2);
      const next = (await catchmindAction('next', siwon.cookie, round.id)).catchmind.round!;
      expect(next.drawer.id).toBe('siwon');
    });

    it('pays only the first concurrent correct guess and transfers the turn to that winner', async () => {
      const min = await login('min');
      const siwon = await login('siwon');
      const yeseo = await login('yeseo');
      const round = await openCatchmind(min.cookie);
      const responses = await Promise.all([siwon.cookie, yeseo.cookie].map(cookie => request('/api/catchmind/guess', { method: 'POST', cookie,
        body: { requestId: crypto.randomUUID(), roundId: round.id, answer: round.word } })));
      expect(responses.map(response => response.status).sort()).toEqual([200, 409]);
      const state = (await getCatchmind(min.cookie)).catchmind;
      expect(state.round!.guesses.filter(guess => guess.correct)).toHaveLength(1);
      expect(state.turn?.id).toBe(state.round!.winner?.id);
      const payouts = await ledgerRows();
      expect(payouts.map(row => [row.currency, row.amount]).sort()).toEqual([['gold', 5], ['score', 3]]);
      expect(new Set(payouts.map(row => row.user_id))).toEqual(new Set([state.round!.winner!.id]));
    });

    it('lets the drawer end a published round without a reward and start only one next round', async () => {
      const min = await login('min');
      const siwon = await login('siwon');
      const round = await openCatchmind(min.cookie);
      expect((await request('/api/catchmind/end', { method: 'POST', cookie: siwon.cookie,
        body: { requestId: crypto.randomUUID(), roundId: round.id } })).status).toBe(403);
      const ended = await catchmindAction('end', min.cookie, round.id);
      expect(ended.catchmind).toMatchObject({ round: { status: 'ended', endReason: 'manual', winner: null }, turn: { id: 'min' }, canNext: true });
      expect(await ledgerRows()).toEqual([]);
      const responses = await Promise.all([1, 2].map(() => request('/api/catchmind/next', { method: 'POST', cookie: min.cookie,
        body: { requestId: crypto.randomUUID(), roundId: round.id } })));
      expect(responses.map(response => response.status).sort()).toEqual([200, 409]);
      const next = (await getCatchmind(min.cookie)).catchmind.round!;
      expect(next).toMatchObject({ number: round.number + 1, status: 'draft', drawer: { id: 'min' } });
    });

    it('rejects stale round mutations after the next drawing turn begins', async () => {
      const min = await login('min');
      const siwon = await login('siwon');
      const previous = await openCatchmind(min.cookie);
      await catchmindAction('end', min.cookie, previous.id);
      const next = (await catchmindAction('next', min.cookie, previous.id)).catchmind.round!;
      for (const [action, cookie, extra] of [
        ['guess', siwon.cookie, { answer: previous.word }],
        ['publish', min.cookie, { wordVersion: next.wordVersion, image: DRAWING_PNG }],
        ['reroll', min.cookie, { wordVersion: next.wordVersion }],
      ] as const) {
        expect((await request(`/api/catchmind/${action}`, { method: 'POST', cookie,
          body: { requestId: crypto.randomUUID(), roundId: previous.id, ...extra } })).status).toBe(409);
      }
      expect((await getCatchmind(min.cookie)).catchmind.round).toMatchObject({ id: next.id, status: 'draft', wordVersion: next.wordVersion, image: null });
      expect(await ledgerRows()).toEqual([]);
    });

    it('rolls back the winning guess, turn, receipt, and score when a payout write fails', async () => {
      const min = await login('min');
      const siwon = await login('siwon');
      const round = await openCatchmind(min.cookie);
      const body = { requestId: crypto.randomUUID(), roundId: round.id, answer: round.word };
      await db.prepare(`CREATE TRIGGER reject_test_reward BEFORE INSERT ON ledger
        WHEN NEW.currency = 'gold' AND NEW.amount = 5
        BEGIN SELECT RAISE(ABORT, 'test reward failure'); END;`).run();
      expect((await request('/api/catchmind/guess', { method: 'POST', cookie: siwon.cookie, body })).status).toBe(500);
      const unchanged = (await getCatchmind(min.cookie)).catchmind;
      expect(unchanged).toMatchObject({ round: { status: 'open', winner: null, wrongCount: 0, guesses: [] }, turn: { id: 'min' } });
      expect(await ledgerRows()).toEqual([]);
      await db.prepare('DROP TRIGGER reject_test_reward').run();
      expect((await request('/api/catchmind/guess', { method: 'POST', cookie: siwon.cookie, body })).status).toBe(200);
      expect((await bootstrap(siwon.cookie)).user).toMatchObject({ gold: 5, weeklyScore: 3 });
    });

    it.each([DRAWING_WEBP, DRAWING_WEBP_LOSSY])('accepts structurally valid square WebP drawings %#', async image => {
      const { cookie } = await login('min');
      const draft = (await catchmindAction('claim', cookie, null)).catchmind.round!;
      const published = await catchmindAction('publish', cookie, draft.id, { wordVersion: draft.wordVersion, image });
      expect(published.catchmind.round).toMatchObject({ status: 'open', image: catchmindImagePath(draft.id) });
    });

    it('rejects malformed, mismatched, and nonsquare PNG or WebP drawings without publishing', async () => {
      const { cookie } = await login('min');
      const draft = (await catchmindAction('claim', cookie, null)).catchmind.round!;
      const bytes = Buffer.from(DRAWING_PNG.split(',')[1]!, 'base64');
      const damagedCrc = Buffer.from(bytes); damagedCrc[29] = damagedCrc[29]! ^ 1;
      for (const image of [null, 12, '', 'https://example.com/image.png', 'data:image/png;base64,%%%bad',
        `data:image/png;base64,${Buffer.from('not a PNG').toString('base64')}`,
        `data:image/png;base64,${bytes.subarray(0, 24).toString('base64')}`,
        `data:image/png;base64,${damagedCrc.toString('base64')}`,
        DRAWING_PNG.replace('image/png', 'image/webp'), DRAWING_WEBP.replace('image/webp', 'image/png'),
        drawingPng(2, 1), NONSQUARE_WEBP, DRAWING_WEBP.slice(0, -8)]) {
        expect((await request('/api/catchmind/publish', { method: 'POST', cookie,
          body: { requestId: crypto.randomUUID(), roundId: draft.id, wordVersion: draft.wordVersion, image } })).status).toBe(400);
      }
      expect((await getCatchmind(cookie)).catchmind.round).toMatchObject({ status: 'draft', image: null, publishedAt: null });
    });

    it('accepts a 300KiB decoded PNG and rejects a valid PNG one byte larger', async () => {
      const { cookie } = await login('min');
      const draft = (await catchmindAction('claim', cookie, null)).catchmind.round!;
      const tooLarge = drawingPng(2, 2, 300 * 1024 + 1);
      expect((await request('/api/catchmind/publish', { method: 'POST', cookie,
        body: { requestId: crypto.randomUUID(), roundId: draft.id, wordVersion: draft.wordVersion, image: tooLarge } })).status).toBe(413);
      expect((await getCatchmind(cookie)).catchmind.round).toMatchObject({ status: 'draft', image: null });
      const image = drawingPng(2, 2, 300 * 1024);
      expect(Buffer.from(image.split(',')[1]!, 'base64')).toHaveLength(300 * 1024);
      const published = await catchmindAction('publish', cookie, draft.id, { wordVersion: draft.wordVersion, image });
      expect(published.catchmind.round).toMatchObject({ status: 'open', image: catchmindImagePath(draft.id) });
    });

    it('keeps a Sunday-published round score in that week when solved after Monday midnight', async () => {
      const persistence = await mkdtemp(join(tmpdir(), 'yegoom-catchmind-week-'));
      let instance = runtime(await workerAt('2026-11-01T14:59:59Z'), persistence);
      try {
        const database = await instance.getD1Database('DB');
        await provision(database, migration, passwordHash);
        const min = await login('min', instance);
        const siwon = await login('siwon', instance);
        const round = await openCatchmind(min.cookie, instance);
        await instance.dispose();
        instance = runtime(await workerAt('2026-11-01T15:00:01Z'), persistence);
        const before = await getCatchmind(siwon.cookie, instance);
        expect(before.catchmind.round).toMatchObject({ id: round.id, status: 'open' });
        await catchmindAction('guess', siwon.cookie, round.id, { answer: round.word }, instance);
        const persisted = await instance.getD1Database('DB');
        expect((await ledgerRows(persisted)).find(row => row.currency === 'score')).toMatchObject({ user_id: 'siwon', amount: 3, week_start: '2026-10-26' });
        const response = await request('/api/bootstrap', { cookie: siwon.cookie, instance });
        expect(response.status).toBe(200);
        const view = await response.json() as BootstrapResponse;
        expect(view.user).toMatchObject({ gold: 5, weeklyScore: 0 });
        expect(view.dailyScores).toEqual([0, 0, 0, 0, 0, 0, 0]);
      } finally { await instance.dispose(); await rm(persistence, { recursive: true, force: true }); }
    });

    it('attributes a delayed catchmind score to the publication day in the weekly chart', async () => {
      const min = await login('min');
      const siwon = await login('siwon');
      const round = await openCatchmind(min.cookie);
      // Represent a published Thursday round still open on Friday morning.
      await db.prepare('UPDATE catchmind_rounds SET round_date = ?, published_at = ? WHERE id = ?')
        .bind('2026-10-29', '2026-10-29T00:00:00.000Z', round.id).run();
      await catchmindAction('guess', siwon.cookie, round.id, { answer: round.word });
      const view = await bootstrap(siwon.cookie);
      expect(view.user.weeklyScore).toBe(3);
      expect(view.dailyScores).toEqual([0, 0, 0, 3, 0, 0, 0]);
      expect(view.ledger.find(row => row.currency === 'score')?.createdAt).toBe(`${TODAY}T00:00:00.000Z`);
    });

    it('does not publish with yesterday game date when the SQL write crosses KST midnight', async () => {
      const instance = runtime(await workerAt('2026-11-01T14:59:59Z', '2026-11-01T15:00:00Z'));
      try {
        const database = await instance.getD1Database('DB');
        await provision(database, migration, passwordHash);
        const { cookie } = await login('min', instance);
        const draft = (await catchmindAction('claim', cookie, null, {}, instance)).catchmind.round!;
        expect((await request('/api/catchmind/publish', { method: 'POST', cookie, instance,
          body: { requestId: crypto.randomUUID(), roundId: draft.id, wordVersion: draft.wordVersion, image: DRAWING_PNG } })).status).toBe(409);
        expect((await getCatchmind(cookie, instance)).catchmind.round).toMatchObject({ status: 'draft', image: null, publishedAt: null });
        expect(await ledgerRows(database)).toEqual([]);
      } finally { await instance.dispose(); }
    });

    it('requires authentication and Origin and forbids administrator game mutations', async () => {
      expect((await request('/api/catchmind')).status).toBe(401);
      const min = await login('min');
      const admin = await login('admin');
      const round = await openCatchmind(min.cookie);
      for (const action of ['claim', 'reroll', 'publish', 'guess', 'end', 'next']) {
        const body = { requestId: crypto.randomUUID(), roundId: action === 'claim' ? null : round.id,
          wordVersion: round.wordVersion, image: DRAWING_PNG, answer: round.word };
        expect((await request(`/api/catchmind/${action}`, { method: 'POST', body })).status).toBe(401);
        expect((await request(`/api/catchmind/${action}`, { method: 'POST', cookie: min.cookie, body, origin: null })).status).toBe(403);
        expect((await request(`/api/catchmind/${action}`, { method: 'POST', cookie: admin.cookie, body })).status).toBe(403);
      }
      expect(await ledgerRows()).toEqual([]);
    });

    it('rejects malformed guesses and request IDs without advancing the wrong counter', async () => {
      const min = await login('min');
      const siwon = await login('siwon');
      const round = await openCatchmind(min.cookie);
      for (const answer of [null, 1, [], {}, '', ' \t\n　', '가'.repeat(81)]) {
        expect((await request('/api/catchmind/guess', { method: 'POST', cookie: siwon.cookie,
          body: { requestId: crypto.randomUUID(), roundId: round.id, answer } })).status).toBe(400);
      }
      for (const requestId of [null, '', 1, 'x'.repeat(129)]) {
        expect((await request('/api/catchmind/guess', { method: 'POST', cookie: siwon.cookie,
          body: { requestId, roundId: round.id, answer: '오답' } })).status).toBe(400);
      }
      expect((await getCatchmind(min.cookie)).catchmind.round).toMatchObject({ status: 'open', wrongCount: 0, guesses: [] });
      expect(await ledgerRows()).toEqual([]);
    });
  });

  describe('catchmind image delivery', () => {
    it.each([
      { image: DRAWING_PNG, mime: 'image/png', format: 'PNG' },
      { image: DRAWING_WEBP, mime: 'image/webp', format: 'lossless WebP' },
      { image: DRAWING_WEBP_LOSSY, mime: 'image/webp', format: 'lossy WebP' },
    ])('serves exact $format bytes with private immutable caching to authenticated viewers', async ({ image, mime }) => {
      const min = await login('min');
      const siwon = await login('siwon');
      const admin = await login('admin');
      const draft = (await catchmindAction('claim', min.cookie, null)).catchmind.round!;
      const published = await catchmindAction('publish', min.cookie, draft.id, { wordVersion: draft.wordVersion, image });
      const path = catchmindImagePath(draft.id);
      expect(published.catchmind.round?.image).toBe(path);
      const expected = Buffer.from(image.split(',')[1]!, 'base64');
      for (const cookie of [min.cookie, siwon.cookie, admin.cookie]) {
        const response = await request(path, { cookie });
        expect(response.status).toBe(200);
        expect(response.headers.get('content-type')).toBe(mime);
        expect(response.headers.get('cache-control')).toBe('private, max-age=31536000, immutable');
        expect(response.headers.get('vary')).toBe('Cookie');
        expect(response.headers.get('x-content-type-options')).toBe('nosniff');
        expect(Buffer.from(await response.arrayBuffer())).toEqual(expected);
      }
    });

    it('returns only a stable image URL from publish, polling, guesses, end, and bootstrap responses', async () => {
      const min = await login('min');
      const siwon = await login('siwon');
      const draft = (await catchmindAction('claim', min.cookie, null)).catchmind.round!;
      const image = drawingPng(2, 2, 300 * 1024);
      const publish = await request('/api/catchmind/publish', { method: 'POST', cookie: min.cookie,
        body: { requestId: crypto.randomUUID(), roundId: draft.id, wordVersion: draft.wordVersion, image } });
      expect(publish.status).toBe(200);
      const responses = [publish];
      for (let index = 0; index < 3; index++) responses.push(await request('/api/catchmind', { cookie: siwon.cookie }));
      responses.push(await request('/api/catchmind/guess', { method: 'POST', cookie: siwon.cookie,
        body: { requestId: crypto.randomUUID(), roundId: draft.id, answer: `오답-${draft.word}` } }));
      responses.push(await request('/api/catchmind/end', { method: 'POST', cookie: min.cookie,
        body: { requestId: crypto.randomUUID(), roundId: draft.id } }));
      for (const response of responses) {
        expect(response.status).toBe(200);
        expect(response.headers.get('cache-control')).toBe('no-store');
        const text = await response.text();
        expect(text.includes('data:image/')).toBe(false);
        expect(text.includes(image.split(',')[1]!)).toBe(false);
        expect(text.length).toBeLessThan(5000);
        expect((JSON.parse(text) as CatchmindResponse).catchmind.round?.image).toBe(catchmindImagePath(draft.id));
      }
      const bootstrapResponse = await request('/api/bootstrap', { cookie: siwon.cookie });
      expect(bootstrapResponse.status).toBe(200);
      const summary = await bootstrapResponse.text();
      expect(summary.includes('data:image/')).toBe(false);
      expect(summary.includes(image.split(',')[1]!)).toBe(false);
      const served = await request(catchmindImagePath(draft.id), { cookie: siwon.cookie });
      expect(served.status).toBe(200);
      expect(Buffer.from(await served.arrayBuffer())).toEqual(Buffer.from(image.split(',')[1]!, 'base64'));
    });

    it('keeps ended round images accessible at their original URL after a different round is published', async () => {
      const min = await login('min');
      const siwon = await login('siwon');
      const first = await openCatchmind(min.cookie);
      const originalPath = first.image!;
      expect(originalPath).toBe(catchmindImagePath(first.id));
      expect((await catchmindAction('end', min.cookie, first.id)).catchmind.round?.image).toBe(originalPath);
      const draft = (await catchmindAction('next', min.cookie, first.id)).catchmind.round!;
      expect(draft.image).toBeNull();
      const second = (await catchmindAction('publish', min.cookie, draft.id,
        { wordVersion: draft.wordVersion, image: DRAWING_WEBP })).catchmind.round!;
      expect(second.image).toBe(catchmindImagePath(second.id));
      expect(second.image).not.toBe(originalPath);
      expect((await getCatchmind(siwon.cookie)).catchmind.round?.image).toBe(second.image);
      const historical = await request(originalPath, { cookie: siwon.cookie });
      expect(historical.status).toBe(200);
      expect(historical.headers.get('content-type')).toBe('image/png');
      expect(Buffer.from(await historical.arrayBuffer())).toEqual(Buffer.from(DRAWING_PNG.split(',')[1]!, 'base64'));
      const current = await request(second.image!, { cookie: siwon.cookie });
      expect(current.status).toBe(200);
      expect(current.headers.get('content-type')).toBe('image/webp');
      expect(Buffer.from(await current.arrayBuffer())).toEqual(Buffer.from(DRAWING_WEBP.split(',')[1]!, 'base64'));
    });

    it('requires a current login and marks missing-image and authentication errors no-store', async () => {
      const min = await login('min');
      const missingPath = catchmindImagePath(crypto.randomUUID());
      const unknown = await request(missingPath, { cookie: min.cookie });
      expect(unknown.status).toBe(404);
      expect(unknown.headers.get('cache-control')).toBe('no-store');
      const draft = (await catchmindAction('claim', min.cookie, null)).catchmind.round!;
      const absent = await request(catchmindImagePath(draft.id), { cookie: min.cookie });
      expect(absent.status).toBe(404);
      expect(absent.headers.get('cache-control')).toBe('no-store');
      await catchmindAction('publish', min.cookie, draft.id, { wordVersion: draft.wordVersion, image: DRAWING_PNG });
      for (const path of [catchmindImagePath(draft.id), missingPath]) {
        const anonymous = await request(path);
        expect(anonymous.status).toBe(401);
        expect(anonymous.headers.get('cache-control')).toBe('no-store');
      }
      expect((await request('/api/auth/logout', { method: 'POST', cookie: min.cookie, body: {} })).status).toBe(200);
      const revoked = await request(catchmindImagePath(draft.id), { cookie: min.cookie });
      expect(revoked.status).toBe(401);
      expect(revoked.headers.get('cache-control')).toBe('no-store');
    });

    it('allows only the drawer to retrieve a stored draft image until publication', async () => {
      const min = await login('min');
      const siwon = await login('siwon');
      const admin = await login('admin');
      const draft = (await catchmindAction('claim', min.cookie, null)).catchmind.round!;
      // Drafts normally have no stored image. Seed one to exercise the route's
      // authorization boundary independently of the current publish flow.
      await db.prepare('UPDATE catchmind_rounds SET image = ? WHERE id = ?').bind(DRAWING_PNG, draft.id).run();
      const path = catchmindImagePath(draft.id);
      expect((await getCatchmind(min.cookie)).catchmind.round?.image).toBe(path);
      const owner = await request(path, { cookie: min.cookie });
      expect(owner.status).toBe(200);
      expect(Buffer.from(await owner.arrayBuffer())).toEqual(Buffer.from(DRAWING_PNG.split(',')[1]!, 'base64'));
      for (const cookie of [siwon.cookie, admin.cookie]) {
        expect((await getCatchmind(cookie)).catchmind.round?.image).toBeNull();
        const forbidden = await request(path, { cookie });
        expect(forbidden.status).toBe(403);
        expect(forbidden.headers.get('cache-control')).toBe('no-store');
      }
      await catchmindAction('publish', min.cookie, draft.id, { wordVersion: draft.wordVersion, image: DRAWING_PNG });
      for (const cookie of [siwon.cookie, admin.cookie]) {
        const publicImage = await request(path, { cookie });
        expect(publicImage.status).toBe(200);
        expect(Buffer.from(await publicImage.arrayBuffer())).toEqual(Buffer.from(DRAWING_PNG.split(',')[1]!, 'base64'));
      }
    });
  });

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


describe('claw simulation CPU budget', () => {
  it('keeps the p99 of 300 random simulations below 40ms', () => {
    // Seeded random coverage is repeatable; generation and fixture creation are
    // outside the timer because only POST play's simulateAttempt is budgeted.
    let seed = 0x6c6177;
    const random = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 0x100000000);
    const cases = Array.from({ length: 300 }, (_, index) => ({
      board: createBoard(index + 1, Math.floor(random() * 0x100000000)),
      input: { x: .05 + random() * .9, stop: index % 3 ? null : 48 + random() * 372,
        pickup: index % 10 ? .405 + random() * .09 : 1, carry: index % 10 ? .27 + random() * .06 : 1 },
    }));
    for (const item of cases.slice(0, 20)) simulateAttempt(item.board, item.input);
    const timings = cases.map(item => {
      const started = performance.now();
      const result = simulateAttempt(item.board, item.input);
      const elapsed = performance.now() - started;
      expect(result.frames).toBeNull();
      return elapsed;
    }).sort((a, b) => a - b);
    const median = (timings[149]! + timings[150]!) / 2;
    const p99 = timings[Math.ceil(timings.length * .99) - 1]!;
    console.log(`Claw simulation CPU (300, Node elapsed time): median=${median.toFixed(3)}ms, p99=${p99.toFixed(3)}ms`);
    expect(p99).toBeLessThanOrEqual(40);
  });
});
