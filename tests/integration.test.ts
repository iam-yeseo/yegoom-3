import { readFileSync, writeFileSync } from 'node:fs';
import { readFile, readdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { hashPassword, hashToken, verifyPassword } from '../worker/crypto';
import { PASSWORD_RULES } from '../shared/password';
import { CATCHMIND_RULES, SLOT_RULES, SPEETTO_RULES } from '../shared/balance';
import { CATCHMIND_WORDS } from '../shared/catchmind-words';
import { catchmindRoute } from '../worker/catchmind';
import type { AdminState, PredictionRules } from '../shared/admin';
import { defaultPredictionRules } from '../shared/game-settings';
import { createBoard, simulateAttempt, type Board } from '../shared/claw-physics';
import { getClawState, getClawSummary, playClaw } from '../worker/claw';
import { getLaunchGiftState, claimLaunchGift } from '../worker/launch-gift';
import { readNotificationSummary } from '../worker/notifications';
import { isToastWorthy } from '../shared/notifications';
import { readEffectiveRules } from '../worker/game-settings';
import { readKujiSummary } from '../worker/shop';
import { maintainDatabase } from '../worker/maintenance';
import { settleDueRankingRewards } from '../worker/ranking-rewards';
import { mondayOf } from '../shared/ranking-periods';
import { rankSummary, standings } from '../src/ranking';
import type { CatchmindGalleryResponse, NotificationsResponse, RankingResponse, SlotResponse, TagResponse } from '../shared/types';
import { TAG_TEXTS } from '../shared/nickname-tags';
import type { LuckPhotoResponse, LaunchGiftResponse, ClawResponse, ClawPlayInput, BootstrapResponse, GameResponse, GameId, HistoryResponse, AttendanceResponse, AttendanceClaimResponse, User, ShopState, KujiResponse, LottoResponse, SpeettoResponse, CatchmindResponse } from '../shared/types';

// Tiny, real encoded fixtures: solid coral images generated with Pillow, quality 80.
const photoFixture = (name: string, mime = 'image/webp') => `data:${mime};base64,${readFileSync(new URL(`./fixtures/${name}`, import.meta.url)).toString('base64')}`;
const PROFILE_WEBP = photoFixture('photo-square.webp');
const PROFILE_JPEG = photoFixture('photo-square.jpg', 'image/jpeg');
const LUCK_PHOTO = photoFixture('photo-wide.webp');
const NONSQUARE_PHOTO = photoFixture('photo-nonsquare.webp');
const TOO_WIDE_PHOTO = photoFixture('photo-too-wide.webp');
function paddedJpeg(bytes: number): string {
  const original = Buffer.from(PROFILE_JPEG.split(',')[1]!, 'base64');
  const chunks: Buffer[] = [original.subarray(0, 2)];
  let remaining = bytes - original.length;
  if (remaining < 4) throw new Error('JPEG padding must fit a comment segment');
  while (remaining > 0) {
    let size = Math.min(65537, remaining);
    if (remaining - size > 0 && remaining - size < 4) size -= 4;
    const chunk = Buffer.alloc(size); chunk[0] = 0xff; chunk[1] = 0xfe; chunk.writeUInt16BE(size - 2, 2);
    chunks.push(chunk); remaining -= size;
  }
  chunks.push(original.subarray(2));
  return `data:image/jpeg;base64,${Buffer.concat(chunks).toString('base64')}`;
}
const profilePhotoPath = (id: string, version: number) => `/api/users/${id}/photo?v=${version}`;
const luckPhotoPath = (date: string, version: number) => `/api/games/luck/rounds/${date}/photo?v=${version}`;

/** Home tiles added after the recorded budgets: stock PR 12 reads one statement
 * (holdings value and today's market holiday; 12 rows), the free-throw tile
 * reads one indexed range of the player's last two slots (at most 2 rows), and
 * the merged 이용권 counts read today's free uses (four partial-index probes; the
 * allowance covers a player who used all twelve).
 * The ranking result dialog reads the player's unseen results of the newest
 * finished week and month (one partial-index probe, at most 2 rows). */
const STOCK_HOME = { prepares: 1 + 1 + 1 + 1, queries: 1 + 1 + 1 + 1, bindingCalls: 1 + 1 + 1 + 1, rowsRead: 12 + 2 + 12 + 2, rowsWritten: 0 } as const;
const stockAllowance = (route: string, field: keyof typeof STOCK_HOME) => route.includes('bootstrap') ? STOCK_HOME[field] : 0;
/** Every successful player write is followed by the achievement check: one
 * batch that reads the facts and the known rows, and, only when something new
 * was earned, one batch of two statements per unlock (the row and its notice).
 * A first write in a fresh fixture earns up to three at once. */
const ACHIEVEMENT_SYNC = { prepares: 2 + 2 * 3, queries: 2 + 2 * 3, bindingCalls: 2, rowsRead: 60, rowsWritten: 8 * 3 + 1 } as const;
/** bootstrap also carries up to five of my own fresh achievement notices for the toast. */
const achievementAllowance = (route: string, field: keyof typeof ACHIEVEMENT_SYNC) =>
  /^POST\b/.test(route) ? ACHIEVEMENT_SYNC[field] : route.includes('bootstrap') && field === 'rowsRead' ? 5 : 0;
const ORIGIN = 'http://localhost';
const PASSWORD = 'test-only-password-42!';
const TODAY = '2026-10-30';
const USERS = ['min', 'siwon', 'yeseo', 'admin'] as const;
type Username = typeof USERS[number];
type Database = Awaited<ReturnType<Miniflare['getD1Database']>>;

// Freeze only the compiled test bundle. Production never accepts a clock header
// or an environment override, and these tests do not depend on the host timezone.
async function workerAt(instant: string, sqlInstant: string = instant, speettoRoll?: number, options: { noDailyFree?: boolean } = {}): Promise<string> {
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
  if (options.noDailyFree) {
    // Gold and owned-ticket economy tests predate the daily 이용권 (which are
    // spent first since the 2026-11-07 merge). Their test artifact gives none.
    const daily = /var DAILY_FREE = \{ lotto: 3, speetto: 3, slot: 3, tag: 3 \};/;
    if (!daily.test(artifact)) throw new Error('Compiled DAILY_FREE constant was not found');
    artifact = artifact.replace(daily, 'var DAILY_FREE = { lotto: 0, speetto: 0, slot: 0, tag: 0 };');
  }
  return artifact;
}

/** Test-bundle-only instrumentation includes authentication in real HTTP request totals. */
function workerWithD1Metrics(script: string): string {
  const exported = /export\s*\{\s*(\w+)\s+as\s+default\s*\};?\s*$/;
  const match = script.match(exported);
  if (!match) throw new Error('Compiled worker default export was not found');
  return `${script.replace(exported, '')}
export default {
  async fetch(request, env, context) {
    let prepares = 0; let queries = 0; let bindingCalls = 0; let rowsRead = 0; let rowsWritten = 0;
    const originals = new WeakMap();
    const record = result => { queries++; rowsRead += result.meta.rows_read; rowsWritten += result.meta.rows_written; return result; };
    const wrap = statement => {
      const wrapped = {
        bind: (...values) => wrap(statement.bind(...values)),
        all: async () => { bindingCalls++; return record(await statement.all()); },
        run: async () => { bindingCalls++; return record(await statement.run()); },
        first: async column => {
          bindingCalls++;
          const result = record(await statement.all());
          return column ? result.results[0]?.[column] ?? null : result.results[0] ?? null;
        }
      };
      originals.set(wrapped, statement);
      return wrapped;
    };
    const DB = {
      prepare: sql => { prepares++; return wrap(env.DB.prepare(sql)); },
      batch: async statements => {
        bindingCalls++;
        const results = await env.DB.batch(statements.map(statement => originals.get(statement)));
        return results.map(record);
      }
    };
    const response = await ${match[1]}.fetch(request, { ...env, DB }, context);
    const headers = new Headers(response.headers);
    headers.set('X-Test-D1-Binding-Calls', String(bindingCalls));
    headers.set('X-Test-D1-Prepares', String(prepares));
    headers.set('X-Test-D1-Queries', String(queries));
    headers.set('X-Test-D1-Rows-Read', String(rowsRead));
    headers.set('X-Test-D1-Rows-Written', String(rowsWritten));
    return new Response(response.body, { status: response.status, headers });
  }
};`;
}

/** Count actual KDF calls in the isolated test artifact; no production diagnostics. */
function workerWithPasswordMetrics(script: string): string {
  const signature = /async function hashPassword\([^\n]+\) \{/;
  const exported = /export\s*\{\s*(\w+)\s+as\s+default\s*\};?\s*$/;
  const match = script.match(exported);
  if (!match || !signature.test(script)) throw new Error('Password instrumentation target was not found');
  return `let testKdfCalls = 0;\n${script.replace(signature, value => `${value} testKdfCalls++;`).replace(exported, '')}
    export default { async fetch(request, env, context) {
      testKdfCalls = 0;
      const response = await ${match[1]}.fetch(request, env, context);
      const headers = new Headers(response.headers);
      headers.set('X-Test-Kdf-Calls', String(testKdfCalls));
      return new Response(response.body, { status: response.status, headers });
    } };`;
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

/** The current Worker needs the full schema. Tests that start from an older
 * schema apply their migration under test first, then the later ones. */
async function applyMigrationsAfter(db: Database, file: string) {
  const later = (await readdir(new URL('../migrations/', import.meta.url))).filter(name => name.endsWith('.sql') && name > file).sort();
  for (const name of later) await applyMigration(db, await readFile(new URL(`../migrations/${name}`, import.meta.url), 'utf8'));
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
function measuredDatabase(database: Database, now: number) {
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
  let noFreeScript: string;

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
    [script, noFreeScript] = await Promise.all([
      workerAt(`${TODAY}T00:00:00Z`), // 09:00 KST
      workerAt(`${TODAY}T00:00:00Z`, undefined, undefined, { noDailyFree: true }),
    ]);
  });
  /** Gold and owned-ticket mechanics, without today's free 이용권 spent first. */
  async function withoutDailyFree() {
    await worker?.dispose();
    worker = runtime(noFreeScript);
    db = await worker.getD1Database('DB');
    await provision(db, migration, passwordHash);
  }

  beforeEach(async () => {
    // Use a fresh database; production ledger triggers forbid clearing payout history.
    await worker?.dispose();
    worker = runtime(script);
    db = await worker.getD1Database('DB');
    await provision(db, migration, passwordHash);
  });

  afterAll(async () => { await worker?.dispose(); });

  async function expectBalanced(database: Database = db) {
    const mismatches = (await database.prepare(`SELECT u.id FROM users u
      LEFT JOIN user_balances b ON b.user_id = u.id
      LEFT JOIN (SELECT user_id, SUM(amount) gold FROM ledger WHERE currency = 'gold' GROUP BY user_id) g ON g.user_id = u.id
      LEFT JOIN (SELECT user_id, SUM(CASE WHEN item = 'lotto_ticket' THEN amount ELSE 0 END) lotto,
        SUM(CASE WHEN item = 'speetto_ticket' THEN amount ELSE 0 END) speetto FROM inventory_ledger GROUP BY user_id) i ON i.user_id = u.id
      WHERE COALESCE(b.gold, 0) != COALESCE(g.gold, 0)
        OR COALESCE(b.lotto_tickets, 0) != COALESCE(i.lotto, 0)
        OR COALESCE(b.speetto_tickets, 0) != COALESCE(i.speetto, 0)`).all()).results;
    expect(mismatches, 'cached balances must equal both append-only ledgers').toEqual([]);
  }
  // Also covers every existing primary-database payout, concurrent debit,
  // idempotent retry and forced rollback test, rather than only synthetic writes.
  afterEach(async () => { if (db) await expectBalanced(); });

  describe('derived ledger balances', () => {
    it('backfills existing gold and both ticket balances without including scores', async () => {
      const instance = runtime(script);
      try {
        const database = await instance.getD1Database('DB');
        const oldMigration = (await Promise.all((await readdir(new URL('../migrations/', import.meta.url)))
          .filter(name => name.endsWith('.sql') && name < '0010').sort()
          .map(name => readFile(new URL(`../migrations/${name}`, import.meta.url), 'utf8')))).join('\n');
        await provision(database, oldMigration, passwordHash);
        await fund(900, 'min', database); await fund(-200, 'min', database); await fund(40, 'siwon', database);
        await grantTicket('lotto_ticket', 4, database); await grantTicket('lotto_ticket', -1, database);
        await grantTicket('speetto_ticket', 2, database);
        await database.prepare(`INSERT INTO ledger (id, user_id, currency, amount, reason, reference, created_at, week_start)
          VALUES ('score-only', 'yeseo', 'score', 99, 'fixture', 'score-only', ?, '2026-10-26')`).bind(`${TODAY}T00:00:00.000Z`).run();
        await applyMigration(database, await readFile(new URL('../migrations/0010_balances.sql', import.meta.url), 'utf8'));
        expect((await database.prepare('SELECT * FROM user_balances ORDER BY user_id').all()).results).toEqual([
          { user_id: 'admin', gold: 0, lotto_tickets: 0, speetto_tickets: 0 },
          { user_id: 'min', gold: 700, lotto_tickets: 3, speetto_tickets: 2 },
          { user_id: 'siwon', gold: 40, lotto_tickets: 0, speetto_tickets: 0 },
          { user_id: 'yeseo', gold: 0, lotto_tickets: 0, speetto_tickets: 0 },
        ]);
        await expectBalanced(database);
        await fund(25, 'min', database); await grantTicket('lotto_ticket', -1, database);
        await expectBalanced(database);
      } finally { await instance.dispose(); }
    });

    it('ignores duplicate references and rolls cache changes back with a failed batch', async () => {
      const { cookie } = await login('min');
      expect((await request('/api/shop', { cookie })).status).toBe(200);
      expect(await db.prepare('SELECT COUNT(*) AS n FROM user_balances').first('n')).toBe(0);
      await fund(700); await grantTicket('lotto_ticket', 3); await grantTicket('speetto_ticket', 2);
      await db.prepare(`INSERT OR IGNORE INTO ledger (id, user_id, currency, amount, reason, reference, created_at)
        SELECT 'duplicate-gold', user_id, currency, amount, reason, reference, created_at FROM ledger LIMIT 1`).run();
      await db.prepare(`INSERT OR IGNORE INTO inventory_ledger (id, user_id, item, amount, reason, reference, created_at)
        SELECT 'duplicate-ticket', user_id, item, amount, reason, reference, created_at FROM inventory_ledger LIMIT 1`).run();
      expect(await db.prepare("SELECT gold, lotto_tickets, speetto_tickets FROM user_balances WHERE user_id = 'min'").first())
        .toEqual({ gold: 700, lotto_tickets: 3, speetto_tickets: 2 });
      await db.prepare(`CREATE TRIGGER reject_balance_batch BEFORE INSERT ON inventory_ledger
        WHEN NEW.reference = 'fail-balance' BEGIN SELECT RAISE(ABORT, 'test balance rollback'); END`).run();
      await expect(db.batch([
        db.prepare(`INSERT INTO ledger (id, user_id, currency, amount, reason, reference, created_at)
          VALUES ('rollback-gold', 'min', 'gold', -500, 'fixture', 'rollback-gold', ?)` ).bind(`${TODAY}T00:00:00.000Z`),
        db.prepare(`INSERT INTO inventory_ledger (id, user_id, item, amount, reason, reference, created_at)
          VALUES ('rollback-ticket', 'min', 'lotto_ticket', -1, 'fixture', 'fail-balance', ?)` ).bind(`${TODAY}T00:00:00.000Z`),
      ])).rejects.toThrow('test balance rollback');
      expect(await db.prepare("SELECT gold, lotto_tickets, speetto_tickets FROM user_balances WHERE user_id = 'min'").first())
        .toEqual({ gold: 700, lotto_tickets: 3, speetto_tickets: 2 });
      expect(await db.prepare("SELECT COUNT(*) AS n FROM ledger WHERE id = 'rollback-gold'").first('n')).toBe(0);
      await expectBalanced();
    });

    it('derives fresh and pending claw grants without writing during bootstrap summaries', async () => {
      const now = Date.parse(`${TODAY}T00:00:00Z`); const observed = measuredDatabase(db, now);
      const user = { id: 'min', role: 'player' as const };
      expect(await getClawSummary(observed.binding, user, now)).toMatchObject({ freeCoins: 5, purchasedCoins: 0 });
      expect(observed.queries.every(query => query.rowsWritten === 0)).toBe(true);
      expect(await db.prepare('SELECT COUNT(*) AS n FROM claw_accounts').first('n')).toBe(0);
      const { cookie } = await login('min'); await getClaw(cookie);
      await db.prepare("UPDATE claw_accounts SET free_coins = 1, purchased_coins = 3, last_grant_slot = last_grant_slot - 1 WHERE user_id = 'min'").run();
      observed.reset();
      expect(await getClawSummary(observed.binding, user, now)).toMatchObject({ freeCoins: 5, purchasedCoins: 3, coins: 8 });
      expect(observed.queries.every(query => query.rowsWritten === 0)).toBe(true);
      expect(await db.prepare("SELECT free_coins FROM claw_accounts WHERE user_id = 'min'").first('free_coins')).toBe(1);
      expect(await getClaw(cookie)).toMatchObject({ freeCoins: 5, purchasedCoins: 3, coins: 8 });
      expect(await db.prepare("SELECT free_coins FROM claw_accounts WHERE user_id = 'min'").first('free_coins')).toBe(5);
      await db.prepare("UPDATE claw_accounts SET free_coins = 1, last_grant_slot = last_grant_slot + 1 WHERE user_id = 'min'").run();
      observed.reset();
      expect(await getClawSummary(observed.binding, user, now)).toMatchObject({ freeCoins: 1, purchasedCoins: 3, coins: 4 });
      expect(observed.queries.every(query => query.rowsWritten === 0)).toBe(true);
    });
  });

  describe('bounded daily maintenance', () => {
    it('caps expired deletions and preserves current receipts, guesses and all ledgers', async () => {
      const now = new Date(`${TODAY}T00:00:00Z`); const expired = now.getTime() - 1;
      const cutoff = new Date(now.getTime() - 30 * 86400000).toISOString();
      const old = new Date(Date.parse(cutoff) - 1).toISOString();
      await fund(900); await grantTicket('lotto_ticket', 2);
      for (const table of ['sessions', 'login_attempts']) {
        const columns = table === 'sessions' ? 'token_hash, user_id, expires_at, created_at' : 'bucket, expires_at';
        const values = table === 'sessions' ? "'expired-' || x, 'min', ?, 0" : "'expired-' || x, ?";
        await db.prepare(`WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<502)
          INSERT INTO ${table} (${columns}) SELECT ${values} FROM n`).bind(expired).run();
      }
      await db.prepare("INSERT INTO sessions VALUES ('live', 'min', ?, 0)").bind(now.getTime() + 1).run();
      await db.prepare("INSERT INTO login_attempts VALUES ('live', 1, ?)").bind(now.getTime() + 1).run();
      for (const [index, status] of ['ended', 'draft', 'open', 'ended'].entries()) {
        await db.prepare(`INSERT INTO catchmind_rounds (id, number, drawer_id, word, normalized_word, word_history, status, created_at)
          VALUES (?, ?, 'min', '사과', '사과', '["사과"]', ?, ?)` ).bind(`retention-${index}`, index + 1, status, old).run();
      }
      await db.prepare("UPDATE catchmind_turn SET drawer_id = 'min', round_id = 'retention-3' WHERE id = 1").run();
      await db.prepare(`WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<502)
        INSERT INTO catchmind_requests (id, user_id, request_id, action, round_id, result_round_id, payload_hash, created_at)
        SELECT 'expired-' || x, 'min', 'expired-' || x, 'publish', 'retention-0', 'retention-0', 'fixture', ? FROM n`).bind(old).run();
      for (const [id, round, action, date] of [
        ['guess', 'retention-0', 'guess', old], ['draft', 'retention-1', 'reroll', old],
        ['open', 'retention-2', 'publish', old], ['current', 'retention-3', 'end', old],
        ['boundary', 'retention-0', 'publish', cutoff], ['recent', 'retention-0', 'end', now.toISOString()],
      ]) {
        await db.prepare(`INSERT INTO catchmind_requests (id, user_id, request_id, action, round_id, result_round_id, payload_hash, created_at)
          VALUES (?, 'min', ?, ?, ?, ?, 'fixture', ?)` ).bind(id, id, action, round, round, date).run();
      }
      await db.prepare(`INSERT INTO catchmind_guesses (id, round_id, player_id, answer, normalized_answer, correct, created_at)
        VALUES ('guess', 'retention-0', 'siwon', '사과', '사과', 1, ?)` ).bind(old).run();
      // Notifications past the retention window go; the recent one stays.
      for (const [id, when] of [['old-notice', old], ['recent-notice', now.toISOString()]]) {
        await db.prepare(`INSERT INTO notifications (kind, audience, user_id, actor_id, payload_json, created_at, reference)
          VALUES ('speetto', 'all', NULL, 'siwon', '{"kind":"speetto","prize":1500}', ?, ?)`).bind(when, id).run();
      }
      await maintainDatabase(db as unknown as D1Database, now);
      for (const table of ['sessions', 'login_attempts']) expect(await db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first('n')).toBe(3);
      expect(await db.prepare('SELECT COUNT(*) AS n FROM catchmind_requests').first('n')).toBe(8);
      await maintainDatabase(db as unknown as D1Database, now);
      for (const table of ['sessions', 'login_attempts']) expect(await db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first('n')).toBe(1);
      expect((await db.prepare('SELECT id FROM catchmind_requests ORDER BY id').all()).results.map(row => row.id))
        .toEqual(['boundary', 'current', 'draft', 'guess', 'open', 'recent']);
      expect(await db.prepare('SELECT COUNT(*) AS n FROM catchmind_guesses').first('n')).toBe(1);
      expect(await db.prepare('SELECT COUNT(*) AS n FROM catchmind_rounds').first('n')).toBe(4);
      expect(await db.prepare('SELECT COUNT(*) AS n FROM ledger').first('n')).toBe(1);
      expect(await db.prepare('SELECT COUNT(*) AS n FROM inventory_ledger').first('n')).toBe(1);
      expect((await db.prepare('SELECT reference FROM notifications').all()).results.map(row => row.reference)).toEqual(['recent-notice']);
      const observed = measuredDatabase(db, now.getTime());
      await maintainDatabase(observed.binding, now);
      expect(observed.queries).toHaveLength(6);
      expect(observed.queries.every(query => query.rowsWritten === 0)).toBe(true);
    });
  });

  describe('free-plan request budgets', () => {
    it('uses current-week bootstrap scores for shared home ranks without extra queries or writes', async () => {
      const instance = runtime(workerWithD1Metrics(script));
      try {
        const database = await instance.getD1Database('DB'); await provision(database, migration, passwordHash);
        await database.prepare(`INSERT INTO users (id, username, display_name, password_hash, role)
          VALUES ('fourth', 'fourth', '넷째', ?, 'player')`).bind(passwordHash).run();
        for (const [id, name] of [['min', '민'], ['siwon', '시원'], ['yeseo', '예서']]) {
          await database.prepare('UPDATE users SET display_name = ? WHERE id = ?').bind(name, id).run();
        }
        const { cookie } = await login('yeseo', instance);
        let baselineQueries = 0;
        const snapshot = async () => {
          const response = await request('/api/bootstrap', { cookie, instance }); expect(response.status).toBe(200);
          const queries = Number(response.headers.get('X-Test-D1-Queries'));
          baselineQueries ||= queries;
          expect(queries).toBe(baselineQueries);
          expect(Number(response.headers.get('X-Test-D1-Rows-Written'))).toBe(0);
          return response.json() as Promise<BootstrapResponse>;
        };
        const empty = await snapshot();
        expect(empty.players).toHaveLength(4);
        expect(rankSummary(standings(empty.players), 'yeseo'))
          .toEqual({ line: '아직 이번 주 점수가 없어요', chip: null });
        const score = async (userId: string, amount: number, reference: string, week = '2026-10-26') => {
          await database.prepare(`INSERT INTO ledger (id, user_id, currency, amount, reason, reference, created_at, week_start)
            VALUES (?, ?, 'score', ?, 'home rank fixture', ?, ?, ?)`)
            .bind(reference, userId, amount, reference, `${TODAY}T00:00:00.000Z`, week).run();
        };
        // Different award counts can still produce a tie. Prior weeks, admins
        // and later inactive players must not become current ranking leaders.
        await score('min', 60, 'home:min:a'); await score('min', 40, 'home:min:b');
        await score('siwon', 100, 'home:siwon'); await score('yeseo', 80, 'home:yeseo');
        await score('fourth', 80, 'home:fourth'); await score('admin', 1000, 'home:admin');
        await score('min', 999, 'home:old-week', '2026-10-19');
        const lowerTie = await snapshot();
        const lowerTable = standings(lowerTie.players);
        expect(lowerTable.map(player => [player.username, player.weeklyScore, player.rank]))
          .toEqual([['min', 100, 1], ['siwon', 100, 1], ['fourth', 80, 3], ['yeseo', 80, 3]]);
        expect(lowerTie.user.weeklyScore).toBe(80);
        expect(lowerTie.user.gold).toBe(0);
        expect(rankSummary(lowerTable, 'yeseo'))
          .toEqual({ line: '넷째님과 공동 3등 · 1위 민님 외 1명까지 20점', chip: '주간 공동 3위' });
        await score('yeseo', 20, 'home:yeseo:catchup'); await score('fourth', 20, 'home:fourth:catchup');
        const fourWay = await snapshot();
        expect(rankSummary(standings(fourWay.players), 'yeseo'))
          .toEqual({ line: '넷째님 외 2명과 공동 1등', chip: '주간 공동 1위' });
        await database.prepare("UPDATE users SET active = 0 WHERE id = 'min'").run();
        const inactiveExcluded = await snapshot();
        expect(inactiveExcluded.players.map(player => player.username)).toEqual(['fourth', 'siwon', 'yeseo']);
        expect(rankSummary(standings(inactiveExcluded.players), 'yeseo'))
          .toEqual({ line: '넷째님, 시원님과 공동 1등', chip: '주간 공동 1위' });
        expect(inactiveExcluded.players.every(player => !player.displayName.endsWith('님'))).toBe(true);
        await expectBalanced(database);
      } finally { await instance.dispose(); }
    });

    it('settles a thirty-day backlog within the D1 binding-call budget and retries without writes', async () => {
      const instance = runtime(workerWithD1Metrics(script));
      try {
        const database = await instance.getD1Database('DB'); await provision(database, migration, passwordHash);
        for (let day = 1; day <= 30; day++) {
          const date = `2026-09-${String(day).padStart(2, '0')}`;
          await seedRound({ game: 'wake', date, answer: '08:00:00', revealedAt: Date.parse(`${date}T00:00:00Z`),
            predictions: [['siwon', '08:00:00']], database });
        }
        const { cookie } = await login('siwon', instance);
        const first = await request('/api/bootstrap', { cookie, instance }); expect(first.status).toBe(200);
        expect(Number(first.headers.get('X-Test-D1-Binding-Calls'))).toBeLessThanOrEqual(50);
        expect(Number(first.headers.get('X-Test-D1-Queries'))).toBeGreaterThan(50);
        console.log(`Thirty-round settlement: ${first.headers.get('X-Test-D1-Binding-Calls')} D1 binding calls, ${first.headers.get('X-Test-D1-Queries')} statements, ${first.headers.get('X-Test-D1-Rows-Read')} rows_read, ${first.headers.get('X-Test-D1-Rows-Written')} rows_written (authentication included)`);
        const view = await first.json() as BootstrapResponse;
        const rules = defaultPredictionRules('wake');
        expect(view.user.gold).toBe(30 * rules.firstGold);
        expect(await database.prepare('SELECT COUNT(*) AS n FROM game_rounds WHERE settled_at IS NOT NULL').first('n')).toBe(30);
        expect(await database.prepare("SELECT COUNT(*) AS n FROM ledger WHERE currency = 'gold'").first('n')).toBe(30);
        expect(await database.prepare("SELECT COUNT(*) AS n FROM ledger WHERE currency = 'score'").first('n')).toBe(30);
        expect(await database.prepare("SELECT SUM(amount) AS n FROM ledger WHERE currency = 'score'").first('n')).toBe(30 * rules.scoreTable[0]!.points);
        await expectBalanced(database);
        const retry = await request('/api/bootstrap', { cookie, instance }); expect(retry.status).toBe(200);
        expect(Number(retry.headers.get('X-Test-D1-Queries'))).toBeLessThanOrEqual(30);
        expect(Number(retry.headers.get('X-Test-D1-Rows-Written'))).toBe(0);
        expect((await retry.json() as BootstrapResponse).user.gold).toBe(view.user.gold);
      } finally { await instance.dispose(); }
    });

    it('keeps capped login and password attempt buckets read-only until their windows expire', async () => {
      const instance = runtime(workerWithD1Metrics(script));
      try {
        const database = await instance.getD1Database('DB'); await provision(database, migration, passwordHash);
        const { cookie } = await login('min', instance);
        const now = Date.parse(`${TODAY}T00:00:00Z`);
        const ipBucket = await database.prepare('SELECT bucket FROM login_attempts').first<string>('bucket');
        expect(ipBucket).toBeTruthy(); // Miniflare supplies the connecting IP.
        const buckets = [await hashToken('user:min'), ipBucket!, await hashToken('password:min')];
        for (const [index, bucket] of buckets.entries()) await database.prepare(`INSERT INTO login_attempts (bucket, attempts, expires_at)
          VALUES (?, ?, ?) ON CONFLICT(bucket) DO UPDATE SET attempts = excluded.attempts, expires_at = excluded.expires_at`)
          .bind(bucket, index === 1 ? 31 : 11, now + 900000).run();
        for (let attempt = 0; attempt < 2; attempt++) {
          for (const [path, body, method] of [
            ['/api/auth/login', { username: 'min', password: PASSWORD }, 'POST'],
            ['/api/me/password', { currentPassword: PASSWORD, newPassword: 'next-valid-password-42!' }, 'PUT'],
          ] as const) {
            const response = await request(path, { method, body, cookie, instance }); expect(response.status).toBe(429);
            expect(Number(response.headers.get('X-Test-D1-Rows-Written')), path).toBe(0);
          }
        }
        expect((await database.prepare('SELECT attempts FROM login_attempts ORDER BY attempts').all()).results.map(row => row.attempts)).toEqual([11, 11, 31]);
        await database.prepare('UPDATE login_attempts SET expires_at = ?').bind(now).run();
        const reset = await request('/api/auth/login', { method: 'POST', body: { username: 'min', password: 'wrong-password' }, instance });
        expect(reset.status).toBe(401);
        for (const bucket of buckets.slice(0, 2)) expect(await database.prepare('SELECT attempts FROM login_attempts WHERE bucket = ?').bind(bucket).first('attempts')).toBe(1);
        const passwordReset = await request('/api/me/password', { method: 'PUT', cookie, instance,
          body: { currentPassword: 'wrong-password', newPassword: 'next-valid-password-42!' } });
        expect(passwordReset.status).toBe(400);
        expect(await database.prepare('SELECT attempts FROM login_attempts WHERE bucket = ?').bind(buckets[2]).first('attempts')).toBe(1);
      } finally { await instance.dispose(); }
    });

    it('returns matching batched and individual game views across privacy, profiles and inactive predictors', async () => {
      const min = await login('min'); const siwon = await login('siwon'); const yeseo = await login('yeseo');
      await uploadProfile(siwon.cookie);
      await seedRound({ game: 'wake', answer: '08:00:00', predictions: [['siwon', '08:01:00'], ['yeseo', '07:59:00']] });
      await seedRound({ game: 'offwork', answer: '18:05:00', predictions: [['min', '18:00:00']] });
      await seedRound({ game: 'luck', answer: '50', revealedAt: Date.parse(`${TODAY}T00:00:00Z`), predictions: [['min', '50'], ['siwon', '55']] });
      const frozenRules = { ...defaultPredictionRules('luck'), firstGold: 29 };
      await db.prepare("UPDATE game_rounds SET settings_json = ? WHERE game_id = 'luck'").bind(JSON.stringify(frozenRules)).run();
      await db.prepare("UPDATE users SET active = 0, display_name = '쉬는시원' WHERE id = 'siwon'").run();
      for (const viewer of [min, yeseo]) {
        const snapshot = await bootstrap(viewer.cookie);
        for (const game of snapshot.games) {
          const individual = await request(`/api/games/${game.id}`, { cookie: viewer.cookie }); expect(individual.status).toBe(200);
          expect((await individual.json() as GameResponse).game).toEqual(game);
        }
        expect(snapshot.players.some(player => player.id === 'siwon')).toBe(false);
        expect(snapshot.games.find(game => game.id === 'offwork')!.authorDisplayName).toBe('쉬는시원');
        expect(snapshot.games.find(game => game.id === 'luck')!.results.find(result => result.playerId === 'siwon'))
          .toMatchObject({ displayName: '쉬는시원', photoVersion: 1, value: '55' });
        expect(snapshot.games.find(game => game.id === 'luck')!.rules.firstGold).toBe(29);
      }
      expect((await bootstrap(min.cookie)).games.find(game => game.id === 'wake')!.answer).toBe('08:00:00');
      expect((await bootstrap(yeseo.cookie)).games.find(game => game.id === 'wake')!.answer).toBeNull();
    });


    it('bounds authenticated polling queries and rows as historical ledgers grow', async () => {
      const measurements: { clockKst: string; historicalRowsPerLedger: number; route: string; prepares: number; queries: number; bindingCalls: number; rowsRead: number; rowsWritten: number }[] = [];
      const previous = JSON.parse(readFileSync(new URL('../docs/free-plan-measurements.json', import.meta.url), 'utf8')) as { after: typeof measurements };
      for (const clockKst of ['09:00', '18:00']) for (const historicalRows of [100, 10_000]) {
        const measuredScript = clockKst === '09:00' ? script : await workerAt(`${TODAY}T09:00:00Z`);
        const instance = runtime(workerWithD1Metrics(measuredScript));
        try {
          const database = await instance.getD1Database('DB'); await provision(database, migration, passwordHash);
          // A completed daily draw isolates the 18:00 no-due settlement path.
          if (clockKst === '18:00') await database.prepare("INSERT INTO lotto_draws (date, numbers, created_at) VALUES (?, '[1,2,3,4,5]', ?)")
            .bind(TODAY, `${TODAY}T08:00:00.000Z`).run();
          // Three active players, one administrator, three current rounds, six
          // predictions and 45 current-week scores. Older data grows independently.
          await database.prepare(`WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM n WHERE x < ?)
            INSERT INTO ledger (id, user_id, currency, amount, reason, reference, created_at)
            SELECT 'history-gold-' || x, CASE x % 3 WHEN 0 THEN 'min' WHEN 1 THEN 'siwon' ELSE 'yeseo' END,
              'gold', 1, 'budget fixture', 'history-gold-' || x, '2026-01-01T00:00:00.000Z' FROM n`).bind(historicalRows).run();
          await database.prepare(`WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM n WHERE x < ?)
            INSERT INTO inventory_ledger (id, user_id, item, amount, reason, reference, created_at)
            SELECT 'history-ticket-' || x, CASE x % 3 WHEN 0 THEN 'min' WHEN 1 THEN 'siwon' ELSE 'yeseo' END,
              CASE x % 2 WHEN 0 THEN 'lotto_ticket' ELSE 'speetto_ticket' END, 1, 'budget fixture',
              'history-ticket-' || x, '2026-01-01T00:00:00.000Z' FROM n`).bind(historicalRows).run();
          await database.prepare(`WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM n WHERE x < 45)
            INSERT INTO ledger (id, user_id, currency, amount, reason, reference, created_at, week_start)
            SELECT 'current-score-' || x, CASE x % 3 WHEN 0 THEN 'min' WHEN 1 THEN 'siwon' ELSE 'yeseo' END,
              'score', 10, 'budget fixture', 'current-score-' || x, '2026-10-29T00:00:00.000Z', '2026-10-26' FROM n`).run();
          for (const game of ['wake', 'offwork', 'luck'] as const) {
            await database.prepare('INSERT INTO game_rounds (game_id, round_date, updated_at) VALUES (?, ?, ?)')
              .bind(game, TODAY, Date.parse(`${TODAY}T00:00:00Z`)).run();
            for (const player of ['min', 'siwon', 'yeseo'].filter(value => value !== ({ wake: 'min', offwork: 'siwon', luck: 'yeseo' })[game])) {
              await database.prepare('INSERT INTO predictions (game_id, round_date, player_id, value, updated_at) VALUES (?, ?, ?, ?, ?)')
                .bind(game, TODAY, player, game === 'luck' ? '50' : '09:00', Date.parse(`${TODAY}T00:00:00Z`)).run();
            }
          }
          const { cookie } = await login('min', instance);
          const measure = async (route: string, path: string, maxQueries: number, maxRows: number) => {
            const response = await request(path, { cookie, instance });
            expect(response.status).toBe(200);
            const metrics = {
              clockKst, historicalRowsPerLedger: historicalRows, route,
              prepares: Number(response.headers.get('X-Test-D1-Prepares')),
              queries: Number(response.headers.get('X-Test-D1-Queries')),
              bindingCalls: Number(response.headers.get('X-Test-D1-Binding-Calls')),
              rowsRead: Number(response.headers.get('X-Test-D1-Rows-Read')),
              rowsWritten: Number(response.headers.get('X-Test-D1-Rows-Written')),
            };
            measurements.push(metrics);
            expect(metrics.prepares).toBe(metrics.queries);
            expect(metrics.queries, route).toBeLessThanOrEqual(maxQueries);
            expect(metrics.rowsRead, route).toBeLessThanOrEqual(maxRows);
            expect(metrics.rowsWritten, route).toBe(0);
            if (route.startsWith('bootstrap')) {
              const prior = previous.after.find(row => row.clockKst === clockKst && row.historicalRowsPerLedger === historicalRows && row.route === route)!;
              expect(prior, `PR 2 baseline for ${route}`).toBeDefined();
              // PR 6 adds exactly one aggregate notice read after the draw.
              // This fixture has no lottery purchases, so the empty aggregate
              // must leave billed rows unchanged and add no writes.
              const noticeAllowance = clockKst === '18:00' ? 1 : 0;
              expect(metrics.prepares, route).toBeLessThanOrEqual(prior.prepares + noticeAllowance + stockAllowance(route, 'prepares'));
              expect(metrics.bindingCalls, route).toBeLessThanOrEqual(prior.bindingCalls + noticeAllowance + stockAllowance(route, 'bindingCalls'));
              expect(metrics.queries, route).toBeLessThanOrEqual(prior.queries + noticeAllowance + stockAllowance(route, 'queries'));
              expect(metrics.rowsRead, route).toBeLessThanOrEqual(prior.rowsRead + stockAllowance(route, 'rowsRead'));
            }
            await response.arrayBuffer();
          };
          // Ranking currently consumes bootstrap; PR 8 will add its own API.
          await measure('bootstrap (home/ranking, idle catchmind)', '/api/bootstrap', 30, 200);
          await measure('bootstrap (home/ranking, idle repeated)', '/api/bootstrap', 30, 200);
          await measure('shop', '/api/shop', 3, 10);
          await measure('catchmind (idle)', '/api/catchmind', 3, 10);
          await database.prepare(`INSERT INTO catchmind_rounds
            (id, number, drawer_id, word, normalized_word, word_history, status, image, round_date, published_at, created_at)
            VALUES ('budget-open', 1, 'siwon', '사과', '사과', '["사과"]', 'open', ?, ?, ?, ?)`)
            .bind(DRAWING_PNG, TODAY, `${TODAY}T00:00:00.000Z`, `${TODAY}T00:00:00.000Z`).run();
          await database.prepare("UPDATE catchmind_turn SET drawer_id = 'siwon', round_id = 'budget-open' WHERE id = 1").run();
          await measure('catchmind (open, no new guesses)', '/api/catchmind', 6, 15);
          await measure('bootstrap (home/ranking, open catchmind)', '/api/bootstrap', 30, 200);
        } finally { await instance.dispose(); }
      }
      // An opt-in artifact captures only deterministic fixture counts, never data
      // from a remote database. The same fixture also runs against the base commit.
      if (process.env.FREE_PLAN_MEASUREMENTS) writeFileSync(process.env.FREE_PLAN_MEASUREMENTS, `${JSON.stringify(measurements, null, 2)}\n`);
      for (const small of measurements.filter(row => row.historicalRowsPerLedger === 100)) {
        const large = measurements.find(row => row.historicalRowsPerLedger === 10_000 && row.route === small.route && row.clockKst === small.clockKst)!;
        expect(large.queries).toBe(small.queries);
        expect(large.rowsRead).toBeLessThanOrEqual(small.rowsRead + 10);
      }
    });
  });

  describe('catchmind request costs', () => {
    it('records authenticated read and mutation costs across a complete drawing round', async () => {
      const instance = runtime(workerWithD1Metrics(script));
      const measurements: { label: string; prepares: number; queries: number; bindingCalls: number; rowsRead: number; rowsWritten: number }[] = [];
      try {
        const database = await instance.getD1Database('DB'); await provision(database, migration, passwordHash);
        const actors = Object.fromEntries(await Promise.all(['min', 'siwon', 'yeseo'].map(async username => [username, (await login(username, instance)).cookie])));
        const measure = async (label: string, path: string, cookie: string, body?: unknown) => {
          const response = await request(path, { cookie, instance, ...(body ? { method: 'POST', body } : {}) });
          expect(response.status, label).toBe(200);
          measurements.push({ label,
            prepares: Number(response.headers.get('X-Test-D1-Prepares')),
            queries: Number(response.headers.get('X-Test-D1-Queries')),
            bindingCalls: Number(response.headers.get('X-Test-D1-Binding-Calls')),
            rowsRead: Number(response.headers.get('X-Test-D1-Rows-Read')),
            rowsWritten: Number(response.headers.get('X-Test-D1-Rows-Written')) });
          return response.json() as Promise<CatchmindResponse>;
        };
        await measure('bootstrap idle', '/api/bootstrap', actors.min!);
        await measure('GET idle', '/api/catchmind', actors.siwon!);
        let state = await measure('POST claim', '/api/catchmind/claim', actors.min!, { requestId: 'budget-claim', roundId: null });
        await measure('GET draft peer', '/api/catchmind', actors.siwon!);
        state = await measure('POST reroll', '/api/catchmind/reroll', actors.min!, { requestId: 'budget-reroll', roundId: state.catchmind.round!.id, wordVersion: state.catchmind.round!.wordVersion });
        state = await measure('POST publish', '/api/catchmind/publish', actors.min!, { requestId: 'budget-publish', roundId: state.catchmind.round!.id, wordVersion: state.catchmind.round!.wordVersion, image: DRAWING_PNG });
        state = await measure('GET open peer', '/api/catchmind', actors.siwon!);
        const version = (state as CatchmindResponse & { version?: number }).version ?? 0;
        const unchanged = await measure('GET unchanged open peer', `/api/catchmind?since=${version}`, actors.siwon!);
        if ('unchanged' in unchanged) {
          const cost = measurements.at(-1)!;
          expect(cost.queries).toBeLessThanOrEqual(2); expect(cost.rowsWritten).toBe(0);
        }
        await measure('bootstrap open', '/api/bootstrap', actors.min!);
        const wrong = { requestId: 'budget-guess', roundId: state.catchmind.round!.id, answer: '분명한 오답' };
        await measure('POST wrong guess', '/api/catchmind/guess', actors.siwon!, wrong);
        await measure('POST saved guess retry', '/api/catchmind/guess', actors.siwon!, wrong);
        state = await measure('POST manual end', '/api/catchmind/end', actors.min!, { requestId: 'budget-end', roundId: state.catchmind.round!.id });
        await measure('GET ended peer', '/api/catchmind', actors.yeseo!);
        state = await measure('POST next', '/api/catchmind/next', actors[state.catchmind.turn!.username]!, { requestId: 'budget-next', roundId: state.catchmind.round!.id });
        await measure('GET next draft peer', '/api/catchmind', actors.yeseo!);
        await expectBalanced(database);
      } finally { await instance.dispose(); }
      if (process.env.FREE_PLAN_CATCHMIND_MEASUREMENTS) writeFileSync(process.env.FREE_PLAN_CATCHMIND_MEASUREMENTS, `${JSON.stringify(measurements, null, 2)}\n`);
      console.log(`Catchmind authenticated request metrics: ${JSON.stringify(measurements)}`);
    }, 30000);
  });


  describe('lotto cutoff, home notice and recent shop histories', () => {
    it('returns a user-scoped notice only for today after 17:30 and clears it on the next day', async () => {
      const persistence = await mkdtemp(join(tmpdir(), 'yegoom-lotto-notice-'));
      let instance = runtime(await workerAt(`${TODAY}T08:29:59Z`), persistence);
      try {
        let database = await instance.getD1Database('DB');
        await provision(database, migration, passwordHash);
        await fund(1500, 'min', database);
        const { cookie } = await login('min', instance);
        const view = async (viewer = cookie) => {
          const response = await request('/api/bootstrap', { cookie: viewer, instance });
          expect(response.status).toBe(200);
          return response.json() as Promise<BootstrapResponse>;
        };
        expect((await view()).lottoNotice).toBeNull();
        for (const numbers of [[1, 2, 3, 4, 5], [6, 7, 8, 9, 10]]) {
          const response = await request('/api/shop/lotto', { method: 'POST', cookie, instance,
            body: { requestId: crypto.randomUUID(), numbers, payment: 'gold' } });
          expect(response.status).toBe(200);
          expect((await response.json() as LottoResponse).purchase).toMatchObject({ drawDate: TODAY, purchaseDate: TODAY, createdAt: `${TODAY}T08:29:59.000Z` });
        }
        expect((await view()).lottoNotice).toBeNull();
        await instance.dispose();
        instance = runtime(await workerAt(`${TODAY}T08:30:00Z`), persistence);
        database = await instance.getD1Database('DB');
        await database.prepare("INSERT INTO lotto_draws (date, numbers, created_at) VALUES (?, '[1,2,3,4,5]', ?)")
          .bind(TODAY, `${TODAY}T08:30:00.000Z`).run();
        const finished = await view();
        expect(finished.lottoNotice).toEqual({ drawDate: TODAY, tickets: 2, winners: 1, prize: 5000 });
        expect(finished.user.gold).toBe(5500);
        const peer = await login('siwon', instance);
        expect((await view(peer.cookie)).lottoNotice).toBeNull();
        await instance.dispose();
        instance = runtime(await workerAt('2026-10-31T09:00:00Z'), persistence);
        const tomorrow = await view();
        expect(tomorrow.lottoNotice).toBeNull();
        expect(tomorrow.user.gold).toBe(5500);
        await expectBalanced(await instance.getD1Database('DB'));
      } finally { await instance.dispose(); await rm(persistence, { recursive: true, force: true }); }
    });

    it('does not include a next-day ticket in the current draw notice', async () => {
      const instance = runtime(await workerAt(`${TODAY}T08:30:00Z`));
      try {
        const database = await instance.getD1Database('DB'); await provision(database, migration, passwordHash);
        await fund(500, 'min', database);
        const { cookie } = await login('min', instance);
        const response = await request('/api/shop/lotto', { method: 'POST', cookie, instance,
          body: { requestId: crypto.randomUUID(), numbers: [1, 2, 3, 4, 5], payment: 'gold' } });
        expect(response.status).toBe(200);
        expect((await response.json() as LottoResponse).purchase).toMatchObject({ purchaseDate: TODAY, drawDate: '2026-10-31' });
        const snapshot = await request('/api/bootstrap', { cookie, instance });
        expect(snapshot.status).toBe(200);
        expect((await snapshot.json() as BootstrapResponse).lottoNotice).toBeNull();
        await expectBalanced(database);
      } finally { await instance.dispose(); }
    });

    it('keeps an explicit old purchase retry idempotent without restoring that ticket to recent histories', async () => {
      const persistence = await mkdtemp(join(tmpdir(), 'yegoom-old-shop-receipt-'));
      const oldInstant = '2026-10-20T00:00:00Z';
      let instance = runtime(await workerAt(oldInstant, oldInstant, 99), persistence);
      try {
        let database = await instance.getD1Database('DB'); await provision(database, migration, passwordHash);
        await fund(800, 'min', database);
        let { cookie } = await login('min', instance);
        const inputs = {
          lotto: { requestId: crypto.randomUUID(), payment: 'gold', numbers: [1, 2, 3, 4, 5] },
          speetto: { requestId: crypto.randomUUID(), payment: 'gold' },
        };
        const originalIds: string[] = [];
        for (const kind of ['lotto', 'speetto'] as const) {
          const bought = await request(`/api/shop/${kind}`, { method: 'POST', cookie, instance, body: inputs[kind] });
          expect(bought.status).toBe(200);
          originalIds.push((await bought.json() as LottoResponse | SpeettoResponse).purchase!.id);
        }
        await instance.dispose();
        instance = runtime(await workerAt(`${TODAY}T00:00:00Z`), persistence);
        database = await instance.getD1Database('DB');
        // A ten-day-old session has expired; the same account reauthenticates.
        cookie = (await login('min', instance)).cookie;
        await database.prepare("INSERT INTO lotto_draws (date, numbers, created_at) VALUES ('2026-10-20', '[6,7,8,9,10]', '2026-10-20T08:30:00.000Z')").run();
        for (const kind of ['lotto', 'speetto'] as const) {
          const current = await request(`/api/shop/${kind}`, { cookie, instance }); expect(current.status).toBe(200);
          const body = await current.json() as LottoResponse & SpeettoResponse;
          expect(body[kind].tickets).toEqual([]);
        }
        const before = await ledgerRows(database);
        for (const [index, kind] of (['lotto', 'speetto'] as const).entries()) {
          const responses = await Promise.all([1, 2].map(() => request(`/api/shop/${kind}`, { method: 'POST', cookie, instance, body: inputs[kind] })));
          expect(responses.map(response => response.status)).toEqual([200, 200]);
          for (const response of responses) {
            const body = await response.json() as LottoResponse & SpeettoResponse;
            expect(body.purchase).toMatchObject({ id: originalIds[index], requestId: inputs[kind].requestId, purchaseDate: '2026-10-20', createdAt: '2026-10-20T00:00:00.000Z' });
            expect(body[kind].tickets).toEqual([]);
          }
        }
        expect(await ledgerRows(database)).toEqual(before);
        expect(await database.prepare('SELECT COUNT(*) AS count FROM shop_purchases').first('count')).toBe(2);
        await expectBalanced(database);
      } finally { await instance.dispose(); await rm(persistence, { recursive: true, force: true }); }
    });

    it('limits both histories by KST purchase date while still settling an older unpaid lotto ticket once', async () => {
      const instance = runtime(await workerAt(`${TODAY}T09:00:00Z`));
      try {
        const database = await instance.getD1Database('DB'); await provision(database, migration, passwordHash);
        const { cookie } = await login('min', instance);
        for (const [id, date] of [['old-unpaid', '2026-10-01'], ['expired', '2026-10-23'], ['last-visible', '2026-10-24'], ['today', TODAY]]) {
          const createdAt = date === '2026-10-24' ? '2026-10-23T15:00:00.000Z' : `${date}T00:00:00.000Z`;
          for (const kind of ['lotto', 'speetto'] as const) {
            const outcome = kind === 'lotto' ? { drawDate: date, numbers: [1, 2, 3, 4, 5] }
              : { cells: ['cat', 'bunny', 'bread'], won: false, prize: 0 };
            await database.prepare(`INSERT INTO shop_purchases
              (id, user_id, request_id, kind, request_payload, payment, cost, date, created_at, outcome)
              VALUES (?, 'min', ?, ?, '{}', 'ticket', 0, ?, ?, ?)`)
              .bind(`${kind}:${id}`, `${kind}:${id}`, kind, date, createdAt, JSON.stringify(outcome)).run();
            if (kind === 'lotto') {
              await database.prepare(`INSERT INTO lotto_tickets (id, draw_date, numbers, settled_at, matches, rank, prize)
                VALUES (?, ?, '[1,2,3,4,5]', ?, ?, NULL, ?)`)
                .bind(`${kind}:${id}`, date, id === 'old-unpaid' ? null : createdAt, id === 'old-unpaid' ? null : 0, id === 'old-unpaid' ? null : 0).run();
              await database.prepare("INSERT OR IGNORE INTO lotto_draws (date, numbers, created_at) VALUES (?, '[1,2,3,4,5]', ?)").bind(date, createdAt).run();
            }
          }
        }
        const lottery = await request('/api/shop/lotto', { cookie, instance }); expect(lottery.status).toBe(200);
        const lotto = await lottery.json() as LottoResponse;
        expect(lotto.lotto.tickets.map(ticket => ticket.id)).toEqual(['lotto:today', 'lotto:last-visible']);
        expect(lotto.lotto.tickets[1]).toMatchObject({ purchaseDate: '2026-10-24', createdAt: '2026-10-23T15:00:00.000Z' });
        expect(lotto.gold).toBe(5000);
        const scratch = await request('/api/shop/speetto', { cookie, instance }); expect(scratch.status).toBe(200);
        const speetto = await scratch.json() as SpeettoResponse;
        expect(speetto.speetto.tickets.map(ticket => ticket.id)).toEqual(['speetto:today', 'speetto:last-visible']);
        expect(speetto.speetto.tickets[1]).toMatchObject({ purchaseDate: '2026-10-24', createdAt: '2026-10-23T15:00:00.000Z' });
        expect(await database.prepare("SELECT prize, rank, settled_at FROM lotto_tickets WHERE id = 'lotto:old-unpaid'").first())
          .toMatchObject({ prize: 5000, rank: 1, settled_at: `${TODAY}T09:00:00.000Z` });
        await Promise.all(['/api/bootstrap', '/api/shop/lotto', '/api/shop/speetto'].map(path => request(path, { cookie, instance })));
        expect((await ledgerRows(database)).filter(row => row.reference === 'lotto:prize:lotto:old-unpaid')).toHaveLength(1);
        await expectBalanced(database);
      } finally { await instance.dispose(); }
    });
  });

  describe('shop recent history request budgets', () => {
    it('records authenticated recent lottery and scratch histories before and after large past histories', async () => {
      const baseline = process.env.FREE_PLAN_SHOP_BASELINE === '1';
      const measurements: { clockKst: string; historicalTicketsPerKind: number; route: string; prepares: number; queries: number; bindingCalls: number; rowsRead: number; rowsWritten: number; returnedTickets: number | null }[] = [];
      for (const clockKst of ['09:00', '18:00']) for (const historicalTickets of [0, 5000]) {
        const instant = `${TODAY}T${clockKst === '09:00' ? '00' : '09'}:00:00Z`;
        const instance = runtime(workerWithD1Metrics(await workerAt(instant)));
        try {
          const database = await instance.getD1Database('DB'); await provision(database, migration, passwordHash);
          // Settled fixtures isolate list/notice reads from payout creation. Each
          // kind has three recent purchases and independently growing old rows.
          for (const date of ['2026-01-01', '2026-10-24', '2026-10-29', TODAY]) {
            await database.prepare("INSERT INTO lotto_draws (date, numbers, created_at) VALUES (?, '[1,2,3,4,5]', ?)").bind(date, `${date}T09:00:00.000Z`).run();
          }
          if (historicalTickets) {
            for (const kind of ['lotto', 'speetto'] as const) {
              await database.prepare(`WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM n WHERE x < ?)
                INSERT INTO shop_purchases (id, user_id, request_id, kind, request_payload, payment, cost, date, created_at, outcome)
                SELECT ? || x, 'min', ? || x, ?, '{}', 'ticket', 0, '2026-01-01', '2026-01-01T00:00:00.000Z', ? FROM n`)
                .bind(historicalTickets, `${kind}:history:`, `${kind}:history:`, kind,
                  JSON.stringify(kind === 'lotto' ? { drawDate: '2026-01-01', numbers: [6, 7, 8, 9, 10] } : { cells: ['cat', 'bunny', 'bread'], won: false, prize: 0 })).run();
            }
            await database.prepare(`WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM n WHERE x < ?)
              INSERT INTO lotto_tickets (id, draw_date, numbers, settled_at, matches, rank, prize)
              SELECT 'lotto:history:' || x, '2026-01-01', '[6,7,8,9,10]', '2026-01-01T09:00:00.000Z', 0, NULL, 0 FROM n`).bind(historicalTickets).run();
          }
          for (const date of ['2026-10-24', '2026-10-29', TODAY]) for (const kind of ['lotto', 'speetto'] as const) {
            const id = `${kind}:recent:${date}`;
            await database.prepare(`INSERT INTO shop_purchases (id, user_id, request_id, kind, request_payload, payment, cost, date, created_at, outcome)
              VALUES (?, 'min', ?, ?, '{}', 'ticket', 0, ?, ?, ?)`)
              .bind(id, id, kind, date, `${date}T00:00:00.000Z`, JSON.stringify(kind === 'lotto' ? { drawDate: date, numbers: [6, 7, 8, 9, 10] } : { cells: ['cat', 'bunny', 'bread'], won: false, prize: 0 })).run();
            if (kind === 'lotto') await database.prepare(`INSERT INTO lotto_tickets (id, draw_date, numbers, settled_at, matches, rank, prize)
              VALUES (?, ?, '[6,7,8,9,10]', ?, 0, NULL, 0)`).bind(id, date, `${date}T09:00:00.000Z`).run();
          }
          const { cookie } = await login('min', instance);
          for (const route of ['bootstrap', 'lotto', 'speetto']) {
            const path = route === 'bootstrap' ? '/api/bootstrap' : `/api/shop/${route}`;
            const response = await request(path, { cookie, instance }); expect(response.status).toBe(200);
            const body = await response.json() as BootstrapResponse & LottoResponse & SpeettoResponse;
            const tickets = route === 'bootstrap' ? null : route === 'lotto' ? body.lotto.tickets : body.speetto.tickets;
            const row = { clockKst, historicalTicketsPerKind: historicalTickets, route,
              prepares: Number(response.headers.get('X-Test-D1-Prepares')), queries: Number(response.headers.get('X-Test-D1-Queries')),
              bindingCalls: Number(response.headers.get('X-Test-D1-Binding-Calls')), rowsRead: Number(response.headers.get('X-Test-D1-Rows-Read')),
              rowsWritten: Number(response.headers.get('X-Test-D1-Rows-Written')), returnedTickets: tickets?.length ?? null };
            measurements.push(row);
            expect(row.bindingCalls).toBeLessThanOrEqual(50); expect(row.rowsWritten).toBe(0);
            if (tickets) {
              expect(tickets).toHaveLength(baseline ? historicalTickets + 3 : 3);
              if (!baseline) expect(tickets.map(ticket => ticket.purchaseDate)).toEqual([TODAY, '2026-10-29', '2026-10-24']);
            }
            if (!baseline && route === 'bootstrap') {
              expect(body.lottoNotice).toEqual(clockKst === '09:00' ? null : { drawDate: TODAY, tickets: 1, winners: 0, prize: 0 });
            }
          }
          await expectBalanced(database);
        } finally { await instance.dispose(); }
      }
      if (process.env.FREE_PLAN_SHOP_MEASUREMENTS) {
        writeFileSync(process.env.FREE_PLAN_SHOP_MEASUREMENTS, `${JSON.stringify(measurements, null, 2)}\n`);
      } else {
        const prior = JSON.parse(readFileSync(new URL('../docs/free-plan-pr6-measurements.json', import.meta.url), 'utf8')) as { after: typeof measurements };
        expect(measurements.map(row => [row.clockKst, row.historicalTicketsPerKind, row.route])).toEqual(prior.after.map(row => [row.clockKst, row.historicalTicketsPerKind, row.route]));
        for (const row of measurements) {
          const limit = prior.after.find(candidate => candidate.clockKst === row.clockKst && candidate.historicalTicketsPerKind === row.historicalTicketsPerKind && candidate.route === row.route)!;
          for (const field of ['prepares', 'queries', 'bindingCalls', 'rowsRead', 'rowsWritten'] as const) expect(row[field], `${row.clockKst} ${row.route}: ${field}`).toBeLessThanOrEqual(limit[field] + stockAllowance(row.route, field));
        }
      }
      if (!baseline) for (const row of measurements.filter(value => value.historicalTicketsPerKind === 5000)) {
        const empty = measurements.find(value => value.clockKst === row.clockKst && value.route === row.route && value.historicalTicketsPerKind === 0)!;
        expect(row.queries).toBe(empty.queries);
        expect(row.rowsRead, `${row.clockKst} ${row.route}: old histories must not increase reads`).toBeLessThanOrEqual(empty.rowsRead + 2);
      }
      console.log(`Recent shop authenticated request metrics: ${JSON.stringify(measurements)}`);
    }, 30000);
  });

  describe('claw authenticated request budgets', () => {
    it('keeps authenticated machine reads, play receipts and bootstrap within the PR 4 main costs', async () => {
      const instance = runtime(workerWithD1Metrics(script));
      const measurements: { label: string; prepares: number; queries: number; bindingCalls: number; rowsRead: number; rowsWritten: number }[] = [];
      try {
        const database = await instance.getD1Database('DB'); await provision(database, migration, passwordHash);
        const { cookie } = await login('min', instance);
        const measure = async <T,>(label: string, path: string, body?: unknown): Promise<T> => {
          const response = await request(path, { cookie, instance, ...(body ? { method: 'POST', body } : {}) });
          expect(response.status, label).toBe(200);
          measurements.push({ label,
            prepares: Number(response.headers.get('X-Test-D1-Prepares')),
            queries: Number(response.headers.get('X-Test-D1-Queries')),
            bindingCalls: Number(response.headers.get('X-Test-D1-Binding-Calls')),
            rowsRead: Number(response.headers.get('X-Test-D1-Rows-Read')),
            rowsWritten: Number(response.headers.get('X-Test-D1-Rows-Written')) });
          return response.json() as Promise<T>;
        };
        const before = await measure<BootstrapResponse>('bootstrap before machine', '/api/bootstrap');
        expect(before.claw.coins).toBe(5);
        const fresh = await measure<ClawResponse>('GET initial machine', '/api/claw');
        const existing = await measure<ClawResponse>('GET existing machine', '/api/claw');
        expect(existing.board).toEqual(fresh.board);
        await measure<BootstrapResponse>('bootstrap existing machine', '/api/bootstrap');

        // A known pile and guaranteed strong grip exercise the reward writes,
        // independent of crypto random seeds or weak-grip jitter. No rule changes.
        const board = createBoard(1, 1);
        await seedClawBoard(database, board);
        await database.prepare('UPDATE claw_config SET payout_every = 1 WHERE id = 1').run();
        const input = { requestId: 'budget-claw-play', version: fresh.version, x: .23, stop: null };
        const played = await measure<ClawResponse>('POST rewarded play', '/api/claw/play', input);
        const expected = simulateAttempt(board, { x: input.x, stop: input.stop, pickup: 1, carry: 1 });
        expect(expected.prizes.length).toBeGreaterThan(0);
        expect(expected.board.length).toBeGreaterThan(0); // Not the separate clear-bonus path.
        expect(played.board).toEqual(expected.board);
        expect(played.result).toMatchObject({ reason: expected.reason, prizes: expected.prizes,
          grip: { pickup: 1, carry: 1, strong: true }, points: expected.prizes.length, gold: expected.prizes.length * 10 });
        expect(played).toMatchObject({ freeCoins: 4, version: fresh.version + 1, replayed: false });
        const retry = await measure<ClawResponse>('POST saved play retry', '/api/claw/play', input);
        expect(retry).toMatchObject({ board: played.board, result: played.result, freeCoins: 4, version: played.version, replayed: true });
        expect((await measure<ClawResponse>('GET after play', '/api/claw')).board).toEqual(played.board);
        const after = await measure<BootstrapResponse>('bootstrap after play', '/api/bootstrap');
        expect(after.user.gold).toBe(before.user.gold + played.result!.gold);
        expect(after.user.weeklyScore).toBe(before.user.weeklyScore + played.result!.points);
        expect(await database.prepare('SELECT COUNT(*) AS count FROM claw_plays').first('count')).toBe(1);
        await expectBalanced(database);
      } finally { await instance.dispose(); }
      for (const row of measurements) {
        expect(row.bindingCalls, row.label).toBeLessThanOrEqual(50);
        if (row.label !== 'GET initial machine' && row.label !== 'POST rewarded play') expect(row.rowsWritten, row.label).toBe(0);
      }
      if (process.env.FREE_PLAN_CLAW_MEASUREMENTS) {
        writeFileSync(process.env.FREE_PLAN_CLAW_MEASUREMENTS, `${JSON.stringify(measurements, null, 2)}\n`);
      } else {
        const previous = JSON.parse(readFileSync(new URL('../docs/free-plan-pr5-measurements.json', import.meta.url), 'utf8')) as { before: typeof measurements };
        expect(measurements.map(row => row.label)).toEqual(previous.before.map(row => row.label));
        for (const row of measurements) {
          const prior = previous.before.find(candidate => candidate.label === row.label)!;
          for (const field of ['prepares', 'queries', 'bindingCalls', 'rowsRead', 'rowsWritten'] as const) {
            expect(row[field], `${row.label}: ${field}`).toBeLessThanOrEqual(prior[field] + stockAllowance(row.label, field) + achievementAllowance(row.label, field));
          }
        }
      }
      console.log(`Claw authenticated request metrics: ${JSON.stringify(measurements)}`);
    }, 30000);
  });

  describe('ranking reward settlement', () => {
    const KST = '+09:00';
    async function giveScore(userId: string, amount: number, date: string) {
      await db.prepare(`INSERT INTO ledger (id, user_id, currency, amount, reason, reference, created_at, week_start)
        VALUES (?, ?, 'score', ?, '기상시간 맞히기', ?, ?, ?)`)
        .bind(`score-${userId}-${date}-${amount}`, userId, amount, `score:wake:${date}:${userId}`,
          `${date}T01:00:00.000Z`, mondayOf(date)).run();
    }
    const payouts = async (prefix: string) => (await db.prepare(
      `SELECT user_id, amount, reason FROM ledger WHERE reference LIKE ? ORDER BY user_id`)
      .bind(`${prefix}%`).all<{ user_id: string; amount: number; reason: string }>()).results;
    const settled = async () => (await db.prepare('SELECT period, key FROM ranking_settlements ORDER BY period, key')
      .all<{ period: string; key: string }>()).results;

    it('pays the finished week by score and rank, keeps the floor and only pays once', async () => {
      await giveScore('min', 100, '2026-11-03');
      await giveScore('siwon', 80, '2026-11-05');
      // The week after this one must not leak into the payout.
      await giveScore('siwon', 500, '2026-11-10');
      await settleDueRankingRewards(db, new Date(`2026-11-09T00:01:00${KST}`));
      expect(await payouts('rank:week:2026-11-02:')).toEqual([
        { user_id: 'min', amount: 500, reason: '주간 랭킹 보상' },      // 1위 100 × 5
        { user_id: 'siwon', amount: 320, reason: '주간 랭킹 보상' },    // 2위 80 × 4
        { user_id: 'yeseo', amount: 100, reason: '주간 랭킹 보상' },    // 3위 0 → 최소 보장
      ]);
      expect(await settled()).toEqual([{ period: 'week', key: '2026-11-02' }]);
      // Weeks played before rewards existed are never paid.
      expect(await payouts('rank:week:2026-10-26:')).toEqual([]);
      await settleDueRankingRewards(db, new Date(`2026-11-09T00:11:00${KST}`));
      await settleDueRankingRewards(db, new Date(`2026-11-10T00:01:00${KST}`));
      expect(await payouts('rank:week:2026-11-02:')).toHaveLength(3);
      expect(await settled()).toEqual([{ period: 'week', key: '2026-11-02' }]);
    });

    it('gives joint first place both top multipliers and moves the next player to third', async () => {
      await giveScore('min', 60, '2026-11-03');
      await giveScore('siwon', 60, '2026-11-04');
      await giveScore('yeseo', 10, '2026-11-05');
      await settleDueRankingRewards(db, new Date(`2026-11-09T00:01:00${KST}`));
      expect(await payouts('rank:week:2026-11-02:')).toEqual([
        { user_id: 'min', amount: 300, reason: '주간 랭킹 보상' },      // 공동 1위 60 × 5
        { user_id: 'siwon', amount: 300, reason: '주간 랭킹 보상' },    // 공동 1위 60 × 5
        { user_id: 'yeseo', amount: 100, reason: '주간 랭킹 보상' },    // 3위 10 × 3 → 최소 보장
      ]);
    });

    it('settles the month on the first, counting every week of that month, and catches up missed weeks', async () => {
      await giveScore('min', 100, '2026-11-03');
      await giveScore('min', 300, '2026-11-24');
      await giveScore('siwon', 200, '2026-11-17');
      await settleDueRankingRewards(db, new Date(`2026-12-01T00:05:00${KST}`));
      expect(await payouts('rank:month:2026-11:')).toEqual([
        { user_id: 'min', amount: 800, reason: '월간 랭킹 보상' },      // 1위 400 × 2
        { user_id: 'siwon', amount: 400, reason: '월간 랭킹 보상' },    // 2위 200 × 1.5 = 300 → 최소 보장
        { user_id: 'yeseo', amount: 200, reason: '월간 랭킹 보상' },    // 3위 0 → 최소 보장
      ]);
      // The same run catches up every finished week of that month, including the
      // quiet ones, where everyone ties on zero and takes the first-place floor.
      expect((await settled()).map(row => `${row.period}:${row.key}`))
        .toEqual(['month:2026-11', 'week:2026-11-02', 'week:2026-11-09', 'week:2026-11-16', 'week:2026-11-23']);
      expect(await payouts('rank:week:2026-11-09:')).toEqual([
        { user_id: 'min', amount: 300, reason: '주간 랭킹 보상' },
        { user_id: 'siwon', amount: 300, reason: '주간 랭킹 보상' },
        { user_id: 'yeseo', amount: 300, reason: '주간 랭킹 보상' },
      ]);
      expect(await payouts('rank:week:2026-11-16:')).toEqual([
        { user_id: 'min', amount: 200, reason: '주간 랭킹 보상' },      // 0점 공동 2위 최소 보장
        { user_id: 'siwon', amount: 1000, reason: '주간 랭킹 보상' },   // 1위 200 × 5
        { user_id: 'yeseo', amount: 200, reason: '주간 랭킹 보상' },    // 공동 2위라 3위 자리는 비어요
      ]);
    });

    it('leaves administrators and suspended accounts out of the payout', async () => {
      await db.prepare("UPDATE users SET active = 0 WHERE username = 'yeseo'").run();
      await giveScore('min', 100, '2026-11-03');
      await settleDueRankingRewards(db, new Date(`2026-11-09T00:01:00${KST}`));
      expect(await payouts('rank:week:2026-11-02:')).toEqual([
        { user_id: 'min', amount: 500, reason: '주간 랭킹 보상' },      // 1위 100 × 5
        { user_id: 'siwon', amount: 200, reason: '주간 랭킹 보상' },    // 2위 0 → 최소 보장
      ]);
    });

    it('pays exactly one snapshot when two runs read different scores', async () => {
      await db.prepare("INSERT INTO users (id, username, display_name, password_hash, role) VALUES ('jun', 'jun', 'jun', 'x', 'player')").run();
      await giveScore('min', 100, '2026-11-03');
      await giveScore('siwon', 80, '2026-11-04');
      await giveScore('yeseo', 50, '2026-11-05');
      // The first run reads its scores, then stalls right before its batch.
      let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
      let reached!: () => void; const atBatch = new Promise<void>(resolve => { reached = resolve; });
      const stalled = new Proxy(db, { get(target, key) {
        if (key === 'batch') return async (statements: D1PreparedStatement[]) => { reached(); await gate; return target.batch(statements); };
        const value = Reflect.get(target, key);
        return typeof value === 'function' ? value.bind(target) : value;
      } }) as unknown as D1Database;
      const first = settleDueRankingRewards(stalled, new Date(`2026-11-09T00:00:00${KST}`));
      await atBatch;
      // A last-week score lands in between, so the second run sees another podium.
      await giveScore('jun', 60, '2026-11-08');
      await settleDueRankingRewards(db, new Date(`2026-11-09T00:00:00${KST}`));
      release();
      await first; // Lost the claim: rolled back and skipped, not an error.
      expect(await payouts('rank:week:2026-11-02:')).toEqual([
        { user_id: 'jun', amount: 180, reason: '주간 랭킹 보상' },      // 3위 60 × 3
        { user_id: 'min', amount: 500, reason: '주간 랭킹 보상' },
        { user_id: 'siwon', amount: 320, reason: '주간 랭킹 보상' },
      ]);
      expect((await db.prepare("SELECT COUNT(*) AS count FROM notifications WHERE reference LIKE 'notification:rank:%'")
        .first<{ count: number }>())!.count).toBe(3);
      await expectBalanced();
    });

    it('rolls back a failed payout batch completely and pays on the next run', async () => {
      await giveScore('min', 100, '2026-11-03');
      await db.prepare(`CREATE TRIGGER test_fail_rank BEFORE INSERT ON notifications WHEN NEW.user_id = 'yeseo'
        BEGIN SELECT RAISE(ABORT, 'test failure'); END`).run();
      await expect(settleDueRankingRewards(db, new Date(`2026-11-09T00:00:00${KST}`))).rejects.toThrow('test failure');
      expect(await payouts('rank:')).toEqual([]);
      expect(await settled()).toEqual([]);
      expect((await db.prepare("SELECT COUNT(*) AS count FROM notifications").first<{ count: number }>())!.count).toBe(0);
      await expectBalanced();
      await db.prepare('DROP TRIGGER test_fail_rank').run();
      await settleDueRankingRewards(db, new Date(`2026-11-09T00:10:00${KST}`));
      expect(await payouts('rank:week:2026-11-02:')).toHaveLength(3);
      expect(await settled()).toEqual([{ period: 'week', key: '2026-11-02' }]);
    });

    it('lets the Cron post a late Sunday answer before paying, and retries after midnight', async () => {
      // Revealed at 23:45 on the last day, before it closed; nobody opens the app afterwards.
      await seedRound({ game: 'offwork', date: '2026-11-08', answer: '18:00:00',
        revealAt: Date.parse(`2026-11-08T23:45:00${KST}`), predictions: [['yeseo', '18:00:00']] });
      await giveScore('min', 3, '2026-11-03');
      const cron = await worker.getWorker();
      // The first run of the day fails (simulated), so nothing is paid yet.
      await db.prepare(`CREATE TRIGGER test_fail_rank BEFORE INSERT ON ranking_settlements
        BEGIN SELECT RAISE(ABORT, 'test failure'); END`).run();
      await cron.scheduled({ scheduledTime: new Date(`2026-11-09T00:00:00${KST}`), cron: '*/10 * * * *' }).catch(() => undefined);
      expect(await payouts('rank:')).toEqual([]);
      await db.prepare('DROP TRIGGER test_fail_rank').run();
      // 00:20 is outside the old 00:00–00:10 window; the payout still happens.
      await cron.scheduled({ scheduledTime: new Date(`2026-11-09T00:20:00${KST}`), cron: '*/10 * * * *' });
      expect((await db.prepare("SELECT amount FROM ledger WHERE reference = 'score:offwork:2026-11-08:yeseo'")
        .first<{ amount: number }>())?.amount).toBeGreaterThan(3);
      const paid = await payouts('rank:week:2026-11-02:');
      expect(paid.find(row => row.user_id === 'yeseo')?.amount).toBeGreaterThan(paid.find(row => row.user_id === 'min')!.amount);
      expect(await settled()).toEqual([{ period: 'week', key: '2026-11-02' }]);
    });

    it('stores every player\'s place and shows it once in the result dialog', async () => {
      const instance = runtime(await workerAt('2026-11-09T01:00:00Z')); // Monday 10:00 KST
      try {
        const database = await instance.getD1Database('DB');
        await provision(database, migration, passwordHash);
        await database.prepare("INSERT INTO users (id, username, display_name, password_hash, role) VALUES ('jun', 'jun', 'jun', ?, 'player')").bind(passwordHash).run();
        for (const [user, amount] of [['min', 100], ['siwon', 80], ['yeseo', 50], ['jun', 10]] as const) {
          await database.prepare(`INSERT INTO ledger (id, user_id, currency, amount, reason, reference, created_at, week_start)
            VALUES (?, ?, 'score', ?, 'fixture', ?, '2026-11-04T01:00:00.000Z', '2026-11-02')`).bind(`s-${user}`, user, amount, `score:wake:2026-11-04:${user}`).run();
        }
        await settleDueRankingRewards(database as unknown as D1Database, new Date(`2026-11-09T00:00:00${KST}`));
        expect((await database.prepare('SELECT user_id, place, score, gold, players, seen_at FROM ranking_results ORDER BY place').all()).results).toEqual([
          { user_id: 'min', place: 1, score: 100, gold: 500, players: 4, seen_at: null },
          { user_id: 'siwon', place: 2, score: 80, gold: 320, players: 4, seen_at: null },
          { user_id: 'yeseo', place: 3, score: 50, gold: 150, players: 4, seen_at: null },
          { user_id: 'jun', place: 4, score: 10, gold: 0, players: 4, seen_at: null },
        ]);
        const results = async (cookie: string) => {
          const response = await request('/api/bootstrap', { cookie, instance });
          expect(response.status).toBe(200);
          return (await response.json() as BootstrapResponse).rankResults;
        };
        const min = (await login('min', instance)).cookie;
        const shown = await results(min);
        expect(shown).toEqual([{ period: 'week', key: '2026-11-02', start: '2026-11-02', end: '2026-11-08', place: 1, score: 100, gold: 500, players: 4 }]);
        // A player outside the podium still hears their place.
        expect(await results((await login('jun', instance)).cookie)).toMatchObject([{ place: 4, gold: 0 }]);
        const seen = await request('/api/ranking/results/seen', { method: 'POST', cookie: min, instance, body: { results: shown } });
        expect(seen.status).toBe(200);
        expect(await results(min)).toEqual([]);
        expect((await request('/api/ranking/results/seen', { method: 'POST', cookie: min, instance, body: { results: [] } })).status).toBe(400);
        // Admins are never ranked and get no dialog.
        expect(await results((await login('admin', instance)).cookie)).toEqual([]);
      } finally { await instance.dispose(); }
    });
  });

  describe('23:50 daily close', () => {
    it('refuses game play from 23:50 to midnight but keeps non-game actions', async () => {
      const instance = runtime(await workerAt(`${TODAY}T14:55:00Z`)); // 23:55 KST
      try {
        const database = await instance.getD1Database('DB');
        await provision(database, migration, passwordHash);
        await fund(5000, 'min', database);
        const { cookie } = await login('min', instance);
        const closed = async (path: string, body: unknown) => {
          const response = await request(path, { method: 'POST', cookie, instance, body });
          expect(response.status, path).toBe(409);
          expect((await response.json() as { error: { code: string } }).error.code, path).toBe('PLAY_CLOSED');
        };
        await closed('/api/shop/lotto', { requestId: crypto.randomUUID(), numbers: [1, 2, 3, 4, 5], payment: 'gold' });
        await closed('/api/shop/kuji', { requestId: crypto.randomUUID(), count: 1 });
        await closed('/api/claw/play', { requestId: crypto.randomUUID(), version: (await getClaw(cookie, instance)).version, x: .05, stop: null });
        await closed('/api/freethrow/sets', { requestId: 'req-closed-0123456789abcdef' });
        // Drawing may start; only publishing and guessing are closed.
        const claimed = await catchmindAction('claim', cookie, null, {}, instance);
        expect(claimed.catchmind.canPublish).toBe(false);
        await closed('/api/catchmind/publish', { requestId: crypto.randomUUID(), roundId: claimed.catchmind.round!.id,
          wordVersion: claimed.catchmind.round!.wordVersion, image: DRAWING_PNG });
      } finally { await instance.dispose(); }
    });

    it('scores a Catchmind round solved on its own day', async () => {
      const { cookie: drawer } = await login('siwon');
      const { cookie: guesser } = await login('min');
      const round = await openCatchmind(drawer);
      const solved = await catchmindAction('guess', guesser, round.id, { answer: round.word });
      expect(solved.catchmind.round).toMatchObject({ status: 'ended', winnerScored: true });
      expect((await db.prepare("SELECT currency FROM ledger WHERE reference LIKE 'catchmind:%' ORDER BY currency").all()).results)
        .toEqual([{ currency: 'gold' }, { currency: 'score' }]);
    });

    it('shows a prediction revealed after 23:50 but adds no score', async () => {
      const instance = runtime(await workerAt('2026-10-30T15:30:00Z')); // 2026-10-31 00:30 KST
      try {
        const database = await instance.getD1Database('DB');
        await provision(database, migration, passwordHash);
        // Left work at 23:55: the answer goes public after the day closed.
        await seedRound({ game: 'offwork', date: TODAY, answer: '23:55:00', revealAt: Date.parse(`${TODAY}T23:55:00+09:00`),
          predictions: [['min', '23:55:00'], ['yeseo', '18:00:00']], database });
        await seedRound({ game: 'luck', date: TODAY, answer: '50', revealedAt: Date.parse(`${TODAY}T23:40:00+09:00`),
          predictions: [['min', '50']], database });
        const { cookie } = await login('min', instance);
        const response = await request('/api/games/offwork/history', { cookie, instance });
        expect(response.status).toBe(200);
        const history = (await response.json() as { history: { roundDate: string; results: { username: string; score: number; isFirst: boolean }[] }[] }).history;
        expect(history.find(round => round.roundDate === TODAY)!.results.find(row => row.username === 'min')).toMatchObject({ score: 0, isFirst: true });
        const rows = (await database.prepare("SELECT reference FROM ledger WHERE reference LIKE 'score:%' OR reference LIKE 'first:%' ORDER BY reference").all<{ reference: string }>()).results.map(row => row.reference);
        // The 23:40 luck answer still counts; the 23:55 offwork answer pays only the first-place gold.
        expect(rows).toEqual([`first:luck:${TODAY}:min`, `first:offwork:${TODAY}:min`, `score:luck:${TODAY}:min`]);
      } finally { await instance.dispose(); }
    });
  });

  describe('nickname tags', () => {
    async function giveGold(database: Database, userId: string, amount: number) {
      await database.prepare(`INSERT INTO ledger (id, user_id, currency, amount, reason, reference, created_at)
        VALUES (?, ?, 'gold', ?, 'tag fixture gold', ?, ?)`).bind(`gold-${userId}-${amount}`, userId, amount, `fixture:tag-gold:${userId}:${amount}`, `${TODAY}T00:00:00.000Z`).run();
    }
    const draw = (cookie: string, requestId: string, instance?: Miniflare, free?: boolean) =>
      request('/api/shop/tag', { method: 'POST', body: { requestId, ...(free ? { free } : {}) }, cookie, instance });
    const equip = (cookie: string, tagId: string | null) => request('/api/me/nickname-tag', { method: 'PUT', body: { tagId }, cookie });

    it('draws a tag for 300 gold, replays the same request and caps five draws a day', async () => {
      await withoutDailyFree();
      await giveGold(db, 'yeseo', 2000);
      const { cookie } = await login('yeseo');
      const first = await draw(cookie, 'tag-1');
      expect(first.status).toBe(200);
      const body = await first.json() as TagResponse;
      expect(body.gold).toBe(1700);
      expect(body.draw).toMatchObject({ equipped: false });
      expect(['S', 'A', 'B', 'C']).toContain(body.draw!.grade);
      expect(body.tags).toMatchObject({ drawsToday: 1, dailyLimit: 5, price: 300, equipped: null });
      const replay = await (await draw(cookie, 'tag-1')).json() as TagResponse;
      expect(replay.draw).toEqual(body.draw);
      expect(replay.gold).toBe(1700);
      for (const id of ['tag-2', 'tag-3', 'tag-4', 'tag-5']) expect((await draw(cookie, id)).status).toBe(200);
      const sixth = await draw(cookie, 'tag-6');
      expect(sixth.status).toBe(409);
      expect((await sixth.json() as { error: { code: string } }).error.code).toBe('DAILY_LIMIT');
      const debits = await db.prepare("SELECT COUNT(*) AS n, SUM(amount) AS total FROM ledger WHERE user_id = 'yeseo' AND reason = '별명 태그 뽑기'").first<{ n: number; total: number }>();
      expect(debits).toEqual({ n: 5, total: -1500 });
      const state = await (await request('/api/shop/tag', { cookie })).json() as TagResponse;
      expect(state.tags.tags).toHaveLength(5);
      expect(state.tags.drawsToday).toBe(5);
    });
    it('gives three free uses a day of each item without charging, then refuses a fourth free use', async () => {
      const { cookie } = await login('min');
      const shop = async () => (await (await request('/api/shop', { cookie })).json() as ShopState);
      expect((await shop()).free).toEqual({ lotto: 3, speetto: 3, slot: 3, tag: 3 });
      for (let index = 0; index < 3; index++) {
        const lotto = await request('/api/shop/lotto', { method: 'POST', cookie, body: { requestId: `free-lotto-${index}`, numbers: [1, 2, 3, 4, 5 + index], payment: 'free' } });
        expect(lotto.status).toBe(200);
        expect((await lotto.json() as LottoResponse).purchase).toMatchObject({ payment: 'free', cost: 0 });
        expect((await request('/api/shop/speetto', { method: 'POST', cookie, body: { requestId: `free-speetto-${index}`, payment: 'free' } })).status).toBe(200);
        const slot = await request('/api/shop/slot', { method: 'POST', cookie, body: { requestId: `free-slot-${index}`, free: true } });
        expect(slot.status).toBe(200);
        expect((await slot.json() as SlotResponse).spin).toMatchObject({ cost: 0, free: true });
        const tag = await draw(cookie, `free-tag-${index}`, undefined, true);
        expect(tag.status).toBe(200);
        expect((await tag.json() as TagResponse).draw).toMatchObject({ payment: 'free' });
      }
      expect((await shop()).free).toEqual({ lotto: 0, speetto: 0, slot: 0, tag: 0 });
      const refused = await Promise.all([
        request('/api/shop/lotto', { method: 'POST', cookie, body: { requestId: 'free-lotto-x', numbers: [9, 10, 11, 12, 13], payment: 'free' } }),
        request('/api/shop/speetto', { method: 'POST', cookie, body: { requestId: 'free-speetto-x', payment: 'free' } }),
        request('/api/shop/slot', { method: 'POST', cookie, body: { requestId: 'free-slot-x', free: true } }),
        draw(cookie, 'free-tag-x', undefined, true),
      ]);
      expect(refused.map(response => response.status)).toEqual([409, 409, 409, 409]);
      // Free uses never touch gold or tickets (speetto prizes are the only gold).
      expect(await db.prepare("SELECT COUNT(*) AS n FROM ledger WHERE user_id = 'min' AND amount < 0").first('n')).toBe(0);
      expect(await db.prepare("SELECT COUNT(*) AS n FROM inventory_ledger WHERE user_id = 'min' AND amount < 0").first('n')).toBe(0);
      expect(await db.prepare("SELECT COUNT(*) AS n FROM tag_ticket_ledger WHERE user_id = 'min' AND amount < 0").first('n')).toBe(0);
    });
    it('merges today\'s free uses into 이용권: spent first by itself, then owned tickets, then gold', async () => {
      const { cookie } = await login('min');
      await fund(5000, 'min');
      await grantTicket('lotto_ticket', 1);
      await grantTicket('speetto_ticket', 1);
      await db.prepare(`INSERT INTO tag_ticket_ledger (id, user_id, amount, reason, reference, created_at)
        VALUES ('grant-min', 'min', 1, '별명 뽑기권 지급', 'tag:grant:test:min', ?)`).bind(`${TODAY}T00:00:00.000Z`).run();
      expect((await bootstrap(cookie)).dailyFree).toEqual({ lotto: 3, speetto: 3, slot: 3, tag: 3 });
      const lotto = (index: number) => request('/api/shop/lotto', { method: 'POST', cookie, body: { requestId: `merged-lotto-${index}`, numbers: [1, 2, 3, 4, 10 + index], payment: 'ticket' } });
      const speetto = (index: number) => request('/api/shop/speetto', { method: 'POST', cookie, body: { requestId: `merged-speetto-${index}`, payment: 'ticket' } });
      const payments: string[] = [];
      for (let index = 0; index < 4; index++) {
        const bought = await lotto(index); expect(bought.status).toBe(200);
        payments.push((await bought.json() as LottoResponse).purchase!.payment);
        expect((await speetto(index)).status).toBe(200);
      }
      // Three of today's, then the owned ticket; no more 이용권 after that.
      expect(payments).toEqual(['free', 'free', 'free', 'ticket']);
      expect((await lotto(4)).status).toBe(409);
      expect((await speetto(4)).status).toBe(409);
      const state = await bootstrap(cookie);
      expect(state.inventory).toMatchObject({ lottoTickets: 0, speettoTickets: 0 });
      expect(state.dailyFree).toMatchObject({ lotto: 0, speetto: 0 });
      // Slot and tag draws pick on their own: today's first, then (tag) a ticket, then gold.
      const spins: number[] = [];
      for (let index = 0; index < 4; index++) {
        const spun = await request('/api/shop/slot', { method: 'POST', cookie, body: { requestId: `merged-slot-${index}` } });
        expect(spun.status).toBe(200);
        spins.push((await spun.json() as SlotResponse).spin!.cost);
      }
      expect(spins).toEqual([0, 0, 0, 500]);
      const draws: string[] = [];
      for (let index = 0; index < 5; index++) {
        const drawn = await draw(cookie, `merged-tag-${index}`);
        expect(drawn.status).toBe(200);
        draws.push((await drawn.json() as TagResponse).draw!.payment);
      }
      expect(draws).toEqual(['free', 'free', 'free', 'ticket', 'gold']);
      expect((await bootstrap(cookie)).dailyFree).toEqual({ lotto: 0, speetto: 0, slot: 0, tag: 0 });
      // Gold spent only on the fourth spin and the fifth draw.
      const debits = await db.prepare("SELECT SUM(amount) AS total FROM ledger WHERE user_id = 'min' AND amount < 0").first<{ total: number }>();
      expect(debits!.total).toBe(-500 - 300);
    });
    it('throws away a drawn tag: it leaves the collection but still counts toward the day', async () => {
      await giveGold(db, 'yeseo', 1000);
      const { cookie } = await login('yeseo');
      const kept = (await (await draw(cookie, 'keep-1')).json() as TagResponse).draw!;
      const drawn = (await (await draw(cookie, 'toss-1')).json() as TagResponse).draw!;
      const discard = (tagId: string) => request('/api/me/nickname-tag/discard', { method: 'POST', body: { tagId }, cookie });
      const after = await discard(drawn.id);
      expect(after.status).toBe(200);
      const state = (await after.json() as TagResponse).tags;
      expect(state.tags.map(tag => tag.id)).toEqual([kept.id]);
      expect(state.drawsToday).toBe(2);
      expect((await equip(cookie, drawn.id)).status).toBe(404);
      expect((await equip(cookie, kept.id)).status).toBe(200);
      expect((await discard(kept.id)).status).toBe(409);
      expect((await discard('someone-else')).status).toBe(404);
    });
    it('grants five draw tickets to the players that existed when the migration ran', async () => {
      const instance = runtime(script);
      try {
        const database = await instance.getD1Database('DB');
        const oldMigration = (await Promise.all((await readdir(new URL('../migrations/', import.meta.url)))
          .filter(name => name.endsWith('.sql') && name < '0018_tag_tickets.sql').sort()
          .map(name => readFile(new URL(`../migrations/${name}`, import.meta.url), 'utf8')))).join('\n');
        await provision(database, oldMigration, passwordHash);
        await database.prepare("UPDATE users SET active = 0 WHERE username = 'yeseo'").run();
        const file = await readFile(new URL('../migrations/0018_tag_tickets.sql', import.meta.url), 'utf8');
        await applyMigration(database, file);
        const granted = async () => (await database.prepare(`SELECT u.username, COALESCE(b.tag_tickets, 0) AS tickets
          FROM users u LEFT JOIN user_balances b ON b.user_id = u.id ORDER BY u.username`).all<{ username: string; tickets: number }>()).results;
        // Administrators and suspended accounts are left out; the rest get five.
        expect(await granted()).toEqual([
          { username: 'admin', tickets: 0 }, { username: 'min', tickets: 5 },
          { username: 'siwon', tickets: 5 }, { username: 'yeseo', tickets: 0 },
        ]);
        // The fixed reference keeps a re-run from granting the same tickets twice.
        await applyMigration(database, file.slice(file.indexOf('INSERT OR IGNORE INTO tag_ticket_ledger')));
        expect(await granted()).toEqual([
          { username: 'admin', tickets: 0 }, { username: 'min', tickets: 5 },
          { username: 'siwon', tickets: 5 }, { username: 'yeseo', tickets: 0 },
        ]);
        expect(await database.prepare("SELECT COUNT(*) AS n FROM tag_ticket_ledger").first<number>('n')).toBe(2);
      } finally { await instance.dispose(); }
    });
    it('spends a draw ticket before gold and charges gold once the tickets run out', async () => {
      await withoutDailyFree();
      await giveGold(db, 'yeseo', 1000);
      await db.prepare(`INSERT INTO tag_ticket_ledger (id, user_id, amount, reason, reference, created_at)
        VALUES ('grant-yeseo', 'yeseo', 2, '별명 뽑기권 지급', 'tag:grant:test:yeseo', ?)`).bind(`${TODAY}T00:00:00.000Z`).run();
      const { cookie } = await login('yeseo');
      const first = await (await draw(cookie, 'ticket-1')).json() as TagResponse;
      expect(first.draw!.payment).toBe('ticket');
      expect(first.gold).toBe(1000);
      expect(first.inventory.tagTickets).toBe(1);
      // A replayed request returns the first draw without spending a second ticket.
      expect((await (await draw(cookie, 'ticket-1')).json() as TagResponse).inventory.tagTickets).toBe(1);
      expect((await (await draw(cookie, 'ticket-2')).json() as TagResponse).inventory.tagTickets).toBe(0);
      const third = await (await draw(cookie, 'ticket-3')).json() as TagResponse;
      expect(third.draw!.payment).toBe('gold');
      expect(third.gold).toBe(700);
      expect(third.inventory.tagTickets).toBe(0);
      expect(await db.prepare("SELECT SUM(amount) AS total FROM tag_ticket_ledger WHERE user_id = 'yeseo'").first<number>('total')).toBe(0);
      expect(await db.prepare("SELECT tag_tickets AS n FROM user_balances WHERE user_id = 'yeseo'").first<number>('n')).toBe(0);
      expect(await db.prepare("SELECT COUNT(*) AS n FROM ledger WHERE user_id = 'yeseo' AND reason = '별명 태그 뽑기'").first<number>('n')).toBe(1);
    });
    it('refuses without enough gold and for administrators, without charging', async () => {
      await withoutDailyFree();
      await giveGold(db, 'min', 299);
      const { cookie } = await login('min');
      const poor = await draw(cookie, 'poor-1');
      expect(poor.status).toBe(409);
      expect((await poor.json() as { error: { code: string; message: string } }).error).toMatchObject({ code: 'INSUFFICIENT_GOLD', message: '골드가 부족해요' });
      expect(await db.prepare("SELECT COUNT(*) AS n FROM nickname_tags WHERE user_id = 'min'").first<number>('n')).toBe(0);
      const admin = await login('admin');
      expect((await draw(admin.cookie, 'admin-1')).status).toBe(403);
      expect((await equip(admin.cookie, null)).status).toBe(403);
      expect((await draw(cookie, 'bad id!')).status).toBe(400);
    });
    it('charges once when the same request races, and a forced S grade draws an S phrase', async () => {
      const instance = runtime(await workerAt(`${TODAY}T00:00:00Z`, `${TODAY}T00:00:00Z`, 2, { noDailyFree: true })); // grade roll 2 → S
      try {
        const database = await instance.getD1Database('DB'); await provision(database, migration, passwordHash);
        await giveGold(database, 'siwon', 1000);
        const { cookie } = await login('siwon', instance);
        const results = await Promise.all([draw(cookie, 'race', instance), draw(cookie, 'race', instance), draw(cookie, 'race', instance)]);
        expect(results.map(result => result.status)).toEqual([200, 200, 200]);
        const bodies = await Promise.all(results.map(result => result.json() as Promise<TagResponse>));
        expect(new Set(bodies.map(body => body.draw!.id)).size).toBe(1);
        expect(bodies[0]!.draw!.grade).toBe('S');
        expect((TAG_TEXTS.S as readonly string[]).includes(bodies[0]!.draw!.text)).toBe(true);
        expect(await database.prepare("SELECT SUM(amount) AS total FROM ledger WHERE user_id = 'siwon' AND reason = '별명 태그 뽑기'").first<number>('total')).toBe(-300);
        await expectBalanced(database);
      } finally { await instance.dispose(); }
    });
    it('wears one tag at a time, shows it in bootstrap for everyone and can take it off', async () => {
      await giveGold(db, 'yeseo', 1000);
      const { cookie } = await login('yeseo');
      const a = (await (await draw(cookie, 'wear-a')).json() as TagResponse).draw!;
      const b = (await (await draw(cookie, 'wear-b')).json() as TagResponse).draw!;
      const worn = await (await equip(cookie, a.id)).json() as TagResponse;
      expect(worn.tags.equipped).toMatchObject({ id: a.id, equipped: true });
      expect(worn.tags.tags[0]!.id).toBe(a.id);
      const switched = await (await equip(cookie, b.id)).json() as TagResponse;
      expect(switched.tags.tags.filter(tag => tag.equipped).map(tag => tag.id)).toEqual([b.id]);
      expect(await db.prepare("SELECT COUNT(*) AS n FROM nickname_tags WHERE user_id = 'yeseo' AND equipped = 1").first<number>('n')).toBe(1);
      const mine = await bootstrap(cookie);
      expect(mine.user.tag).toEqual({ grade: b.grade, text: b.text });
      const other = await login('min');
      const theirs = await bootstrap(other.cookie);
      expect(theirs.players.find(player => player.username === 'yeseo')!.tag).toEqual({ grade: b.grade, text: b.text });
      expect(theirs.players.find(player => player.username === 'min')!.tag).toBeNull();
      // Someone else's tag cannot be worn.
      expect((await equip(other.cookie, b.id)).status).toBe(404);
      expect((await equip(cookie, 42 as unknown as string)).status).toBe(400);
      const off = await (await equip(cookie, null)).json() as TagResponse;
      expect(off.tags.equipped).toBeNull();
      expect((await bootstrap(cookie)).user.tag).toBeNull();
      expect((await request('/api/me/nickname-tag', { method: 'POST', body: { tagId: null }, cookie })).status).toBe(405);
    });
  });

  describe('ranking periods API', () => {
    // TODAY is Friday 2026-10-30 (KST): week 10-26..11-01, month October.
    async function score(database: Database, id: string, userId: string, amount: number, reference: string, createdAt: string, week: string) {
      await database.prepare(`INSERT INTO ledger (id, user_id, currency, amount, reason, reference, created_at, week_start)
        VALUES (?, ?, 'score', ?, 'ranking fixture', ?, ?, ?)`).bind(id, userId, amount, reference, createdAt, week).run();
    }
    async function seed(database: Database) {
      await database.prepare(`INSERT INTO catchmind_rounds (id, number, drawer_id, word, normalized_word, word_history, status, round_date, created_at)
        VALUES ('cm-old', 1, 'min', '사과', '사과', '["사과"]', 'ended', '2026-10-28', '2026-10-28T03:00:00.000Z')`).run();
      // A luck round from yesterday settled this morning still belongs to yesterday.
      await score(database, 'r-luck', 'min', 20, 'score:luck:2026-10-29:min', `${TODAY}T00:10:00.000Z`, '2026-10-26');
      await score(database, 'r-wake', 'yeseo', 25, `score:wake:${TODAY}:yeseo`, `${TODAY}T01:31:00.000Z`, '2026-10-26');
      await score(database, 'r-claw', 'yeseo', 5, 'claw:clear:p1:score', `${TODAY}T02:00:00.000Z`, '2026-10-26');
      // Guessed today, published on Wednesday: counts for Wednesday.
      await score(database, 'r-cm', 'siwon', 3, 'catchmind:score:cm-old', `${TODAY}T03:00:00.000Z`, '2026-10-26');
      await score(database, 'r-kuji', 'siwon', 10, 'kuji:score:k1', '2026-10-20T05:00:00.000Z', '2026-10-19');
      // Read with the week of 09-28 (it overlaps October) but dated September 30.
      await score(database, 'r-sept', 'min', 50, 'score:wake:2026-09-30:min', '2026-09-30T02:00:00.000Z', '2026-09-28');
    }
    it('ranks day, week and month by game date with zero scores, buckets and names', async () => {
      await seed(db);
      await db.prepare(`INSERT INTO users (id, username, display_name, password_hash, role, active) VALUES ('gone', 'gone', '떠난 사람', ?, 'player', 0)`).bind(passwordHash).run();
      await score(db, 'r-gone', 'gone', 7, 'claw:doll:p2:score', `${TODAY}T04:00:00.000Z`, '2026-10-26');
      const { cookie } = await login('yeseo');
      const read = async (period: string) => {
        const response = await request(`/api/ranking?period=${period}`, { cookie });
        expect(response.status).toBe(200);
        expect(response.headers.get('cache-control')).toBe('no-store');
        return response.json() as Promise<RankingResponse>;
      };
      const day = await read('day');
      expect(day.range).toEqual({ start: TODAY, end: TODAY });
      expect(day.standings.map(entry => [entry.username, entry.score])).toEqual([['yeseo', 30], ['min', 0], ['siwon', 0]]);
      expect(day.buckets.map(bucket => [bucket.key, bucket.score])).toEqual([['wake', 25], ['claw', 5]]);
      expect(day.history.map(entry => [entry.username, entry.label, entry.amount])).toEqual([
        ['gone', '캐릭터 뽑기', 7], ['yeseo', '캐릭터 뽑기 · 클리어 보너스', 5], ['yeseo', '기상시간 맞히기', 25]]);
      const week = await read('week');
      expect(week.range).toEqual({ start: '2026-10-26', end: '2026-11-01' });
      expect(week.standings.map(entry => [entry.username, entry.score])).toEqual([['yeseo', 30], ['min', 20], ['siwon', 3]]);
      expect(week.buckets.map(bucket => bucket.score)).toEqual([0, 0, 0, 0, 30, 0, 0]);
      expect(week.buckets[4]).toMatchObject({ current: true, future: false });
      expect(week.history.find(entry => entry.id === 'r-cm')).toMatchObject({ game: 'catchmind', gameDate: '2026-10-28' });
      expect(week.history.find(entry => entry.id === 'r-luck')).toMatchObject({ gameDate: '2026-10-29' });
      const month = await read('month');
      expect(month.range).toEqual({ start: '2026-10-01', end: '2026-10-31' });
      expect(month.standings.map(entry => [entry.username, entry.score])).toEqual([['yeseo', 30], ['min', 20], ['siwon', 13]]);
      expect(month.buckets.map(bucket => bucket.label)).toEqual(['1주차', '2주차', '3주차', '4주차', '5주차']);
      expect(month.history.some(entry => entry.id === 'r-sept')).toBe(false);
    });
    it('pages history, validates input and lets administrators read', async () => {
      for (let index = 0; index < 25; index++) {
        await score(db, `p-${String(index).padStart(2, '0')}`, 'min', 1, `claw:doll:page${index}:score`, `${TODAY}T0${index % 3}:00:00.000Z`, '2026-10-26');
      }
      const { cookie } = await login('min');
      const first = await (await request('/api/ranking?period=day', { cookie })).json() as RankingResponse;
      expect(first.history).toHaveLength(20);
      expect(first.nextBefore).toMatch(/^2026-10-30T0\d:00:00\.000Z\|p-\d{2}$/);
      const second = await (await request(`/api/ranking?period=day&before=${encodeURIComponent(first.nextBefore!)}`, { cookie })).json() as RankingResponse;
      expect(second.history).toHaveLength(5);
      expect(second.nextBefore).toBeNull();
      expect(new Set([...first.history, ...second.history].map(entry => entry.id)).size).toBe(25);
      expect((await request('/api/ranking?period=year', { cookie })).status).toBe(400);
      expect((await request('/api/ranking', { cookie })).status).toBe(400);
      expect((await request('/api/ranking?period=day&before=bad', { cookie })).status).toBe(400);
      expect((await request('/api/ranking?period=day', { cookie, method: 'POST', body: {} })).status).toBe(405);
      expect((await request('/api/ranking?period=day')).status).toBe(401);
      const admin = await login('admin');
      const adminView = await request('/api/ranking?period=week', { cookie: admin.cookie });
      expect(adminView.status).toBe(200);
      const adminBody = await adminView.json() as RankingResponse;
      expect(adminBody.standings.map(entry => entry.username)).toEqual(['min', 'siwon', 'yeseo']);
      expect(adminBody.buckets.every(bucket => bucket.score === 0)).toBe(true);
    });
    it('reads a period with two queries after authentication and writes nothing', async () => {
      const instance = runtime(workerWithD1Metrics(script));
      try {
        const database = await instance.getD1Database('DB'); await provision(database, migration, passwordHash);
        await seed(database);
        const { cookie } = await login('yeseo', instance);
        for (const period of ['day', 'week', 'month']) {
          const response = await request(`/api/ranking?period=${period}`, { cookie, instance });
          expect(response.status).toBe(200);
          expect(Number(response.headers.get('X-Test-D1-Queries'))).toBe(3); // session + scores + roster
          expect(Number(response.headers.get('X-Test-D1-Rows-Written'))).toBe(0);
        }
      } finally { await instance.dispose(); }
    });
  });

  describe('self-service password changes', () => {
    const nextPassword = 'new-test-password-2026!';
    const bucketFor = (userId = 'min') => hashToken(`password:${userId}`);
    const change = (cookie: string, newPassword: unknown = nextPassword, currentPassword: unknown = PASSWORD, instance?: Miniflare) =>
      request('/api/me/password', { method: 'PUT', cookie, body: { currentPassword, newPassword }, instance });
    const signIn = (password: string, username = 'min', instance?: Miniflare) =>
      request('/api/auth/login', { method: 'POST', body: { username, password }, instance });

    it('records a wrong current password without logging out or disclosing either password', async () => {
      const { cookie } = await login('min');
      const wrong = 'incorrect-password-2026';
      const response = await change(cookie, nextPassword, wrong);
      expect(response.status).toBe(400);
      const body = await response.text();
      expect(body).toContain('CURRENT_PASSWORD_INCORRECT');
      for (const secret of [wrong, nextPassword, passwordHash]) expect(body).not.toContain(secret);
      expect(await db.prepare('SELECT attempts FROM login_attempts WHERE bucket = ?').bind(await bucketFor()).first('attempts')).toBe(1);
      expect((await request('/api/auth/me', { cookie })).status).toBe(200);
      expect(response.headers.get('set-cookie')).toBeNull();
    });

    it('blocks the eleventh attempt for 15 minutes without extending the window or locking another user', async () => {
      const { cookie } = await login('min');
      for (let i = 0; i < PASSWORD_RULES.attempts; i++) expect((await change(cookie, nextPassword, 'incorrect-password')).status).toBe(400);
      const blocked = await change(cookie);
      expect(blocked.status).toBe(429);
      expect(blocked.headers.get('retry-after')).toBe('900');
      const bucket = await bucketFor();
      const expiry = Date.parse(`${TODAY}T00:00:00Z`) + PASSWORD_RULES.windowMs;
      expect(await db.prepare('SELECT attempts, expires_at FROM login_attempts WHERE bucket = ?').bind(bucket).first()).toEqual({ attempts: 11, expires_at: expiry });
      expect((await change((await login('siwon')).cookie)).status).toBe(200);
      // The exact expiry boundary permits a fresh window; one ms before does not.
      await db.prepare('UPDATE login_attempts SET expires_at = ? WHERE bucket = ?').bind(expiry - PASSWORD_RULES.windowMs + 1, bucket).run();
      expect((await change(cookie)).status).toBe(429);
      await db.prepare('UPDATE login_attempts SET expires_at = ? WHERE bucket = ?').bind(expiry - PASSWORD_RULES.windowMs, bucket).run();
      expect((await change(cookie)).status).toBe(200);
      expect(await db.prepare('SELECT attempts FROM login_attempts WHERE bucket = ?').bind(bucket).first()).toBeNull();
    });

    it.each(['', 'a'.repeat(11), 'a'.repeat(129), null, 42])('rejects invalid new password case %# without changing sessions', async newPassword => {
      const { cookie } = await login('min');
      expect((await change(cookie, newPassword)).status).toBe(400);
      expect((await request('/api/auth/me', { cookie })).status).toBe(200);
      expect(await db.prepare('SELECT attempts FROM login_attempts WHERE bucket = ?').bind(await bucketFor()).first()).toBeNull();
    });

    it.each(['a'.repeat(12), '한'.repeat(128), '  exact-password  '])('accepts password length boundaries and preserves whitespace case %#', async newPassword => {
      const { cookie } = await login('min');
      expect((await change(cookie, newPassword)).status).toBe(200);
      expect((await signIn(newPassword)).status).toBe(200);
    });

    it('rejects unchanged passwords and oversized bodies before consuming a verification slot', async () => {
      const { cookie } = await login('min');
      const unchanged = await change(cookie, PASSWORD);
      expect(unchanged.status).toBe(400);
      expect((await unchanged.json() as { error: { code: string } }).error.code).toBe('PASSWORD_UNCHANGED');
      expect((await change(cookie, nextPassword, 'x'.repeat(129))).status).toBe(400);
      expect((await request('/api/me/password', { method: 'PUT', cookie,
        body: { currentPassword: PASSWORD, newPassword: nextPassword, padding: '한'.repeat(PASSWORD_RULES.bodyMaxBytes) } })).status).toBe(413);
      expect(await db.prepare('SELECT attempts FROM login_attempts WHERE bucket = ?').bind(await bucketFor()).first()).toBeNull();
    });

    it.each(['min', 'admin'] as const)('rotates only %s sessions atomically and permits only the new password afterward', async username => {
      const first = await login(username);
      const other = await login(username);
      const peer = await login('siwon');
      expect((await change(first.cookie, nextPassword, 'incorrect-password')).status).toBe(400);
      const response = await change(first.cookie);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ ok: true });
      const setCookie = response.headers.get('set-cookie')!;
      expect(setCookie).toContain('HttpOnly');
      expect(setCookie).toContain('SameSite=Strict');
      expect(setCookie).toContain('Max-Age=604800');
      const current = setCookie.split(';')[0]!;
      expect(current).not.toBe(first.cookie);
      for (const cookie of [first.cookie, other.cookie]) expect((await request('/api/auth/me', { cookie })).status).toBe(401);
      for (const cookie of [current, peer.cookie]) expect((await request('/api/auth/me', { cookie })).status).toBe(200);
      expect(await db.prepare('SELECT COUNT(*) AS count FROM sessions WHERE user_id = ?').bind(username).first('count')).toBe(1);
      expect(await db.prepare('SELECT attempts FROM login_attempts WHERE bucket = ?').bind(await bucketFor(username)).first()).toBeNull();
      expect((await signIn(nextPassword, username)).status).toBe(200);
      expect((await signIn(PASSWORD, username)).status).toBe(401);
    });

    it('allows only one change from two verified copies of the same credential snapshot', async () => {
      const marker = 'const passwordHash = await hashPassword(input.newPassword);';
      expect(script).toContain(marker);
      const instance = runtime(`let passwordWaiters = [];\n${script.replace(marker, `${marker}
        await new Promise(resolve => { passwordWaiters.push(resolve); if (passwordWaiters.length === 2) passwordWaiters.splice(0).forEach(done => done()); });`)}`);
      try {
        const database = await instance.getD1Database('DB');
        await provision(database, migration, passwordHash);
        const { cookie } = await login('min', instance);
        const passwords = [nextPassword, 'other-test-password-2026!'];
        const results = await Promise.all(passwords.map(value => change(cookie, value, PASSWORD, instance)));
        expect(results.map(result => result.status).sort()).toEqual([200, 409]);
        const winner = results.findIndex(result => result.status === 200);
        expect(results[1 - winner]!.headers.get('set-cookie')).toBeNull();
        const current = results[winner]!.headers.get('set-cookie')!.split(';')[0]!;
        expect((await request('/api/auth/me', { cookie: current, instance })).status).toBe(200);
        expect((await request('/api/auth/me', { cookie, instance })).status).toBe(401);
        expect(await database.prepare('SELECT COUNT(*) AS count FROM sessions').first('count')).toBe(1);
        const stored = await database.prepare('SELECT password_hash FROM users WHERE id = ?').bind('min').first<string>('password_hash');
        expect(await verifyPassword(passwords[winner]!, stored!)).toBe(true);
        expect(await verifyPassword(passwords[1 - winner]!, stored!)).toBe(false);
      } finally { await instance.dispose(); }
    });

    it('rejects inactive users, missing Origin, and a changed account', async () => {
      const { cookie } = await login('min');
      expect((await request('/api/me/password', { method: 'PUT', cookie, origin: null,
        body: { currentPassword: PASSWORD, newPassword: nextPassword } })).status).toBe(403);
      expect((await request('/api/me/password', { method: 'PUT', cookie,
        body: { currentPassword: PASSWORD, newPassword: nextPassword, expectedUserId: 'siwon' } })).status).toBe(409);
      await db.prepare("UPDATE users SET active = 0 WHERE id = 'min'").run();
      expect((await change(cookie)).status).toBe(401);
      expect(await db.prepare("SELECT password_hash FROM users WHERE id = 'min'").first('password_hash')).toBe(passwordHash);
      expect(await db.prepare('SELECT attempts FROM login_attempts WHERE bucket = ?').bind(await bucketFor()).first()).toBeNull();
    });

    it.each(['deactivate', 'logout'] as const)('rejects a %s during hashing instead of minting a session', async action => {
      const marker = 'const passwordHash = await hashPassword(input.newPassword);';
      expect(script).toContain(marker);
      const sql = action === 'deactivate' ? "UPDATE users SET active = 0 WHERE id = 'min'" : "DELETE FROM sessions WHERE user_id = 'min'";
      const instance = runtime(script.replace(marker, `${marker}\n await env.DB.prepare(${JSON.stringify(sql)}).run();`));
      try {
        const database = await instance.getD1Database('DB');
        await provision(database, migration, passwordHash);
        const { cookie } = await login('min', instance);
        const response = await change(cookie, nextPassword, PASSWORD, instance);
        expect(response.status).toBe(409);
        expect(response.headers.get('set-cookie')).toBeNull();
        expect(await database.prepare("SELECT password_hash FROM users WHERE id = 'min'").first('password_hash')).toBe(passwordHash);
        expect(await database.prepare('SELECT COUNT(*) AS count FROM sessions').first('count')).toBe(0);
      } finally { await instance.dispose(); }
    });

    it('rolls back the hash and session revocation if inserting the replacement session fails', async () => {
      const first = await login('min');
      const other = await login('min');
      await db.prepare("CREATE TRIGGER fail_password_session BEFORE INSERT ON sessions BEGIN SELECT RAISE(ABORT, 'test session insert'); END").run();
      const response = await change(first.cookie);
      expect(response.status).toBe(500);
      expect(response.headers.get('set-cookie')).toBeNull();
      expect(await db.prepare("SELECT password_hash FROM users WHERE id = 'min'").first('password_hash')).toBe(passwordHash);
      for (const cookie of [first.cookie, other.cookie]) expect((await request('/api/auth/me', { cookie })).status).toBe(200);
      expect(await db.prepare('SELECT attempts FROM login_attempts WHERE bucket = ?').bind(await bucketFor()).first('attempts')).toBe(1);
    });

    it('runs exactly one verify plus one new hash, and no KDF for blocked or invalid requests', async () => {
      const instance = runtime(workerWithPasswordMetrics(script));
      try {
        const database = await instance.getD1Database('DB');
        await provision(database, migration, passwordHash);
        const signedIn = await signIn(PASSWORD, 'min', instance);
        expect(signedIn.headers.get('x-test-kdf-calls')).toBe('1');
        const cookie = signedIn.headers.get('set-cookie')!.split(';')[0]!;
        for (const newPassword of ['short', PASSWORD]) {
          const response = await change(cookie, newPassword, PASSWORD, instance);
          expect(response.status).toBe(400);
          expect(response.headers.get('x-test-kdf-calls')).toBe('0');
        }
        const wrong = await change(cookie, nextPassword, 'incorrect-password', instance);
        expect(wrong.headers.get('x-test-kdf-calls')).toBe('1');
        const bucket = await bucketFor();
        await database.prepare('UPDATE login_attempts SET attempts = 10 WHERE bucket = ?').bind(bucket).run();
        const blocked = await change(cookie, nextPassword, PASSWORD, instance);
        expect(blocked.status).toBe(429);
        expect(blocked.headers.get('x-test-kdf-calls')).toBe('0');
        await database.prepare('UPDATE login_attempts SET expires_at = 0 WHERE bucket = ?').bind(bucket).run();
        const changed = await change(cookie, nextPassword, PASSWORD, instance);
        expect(changed.status).toBe(200);
        expect(changed.headers.get('x-test-kdf-calls')).toBe('2');
        console.log('Password KDF calls (real Worker artifact): login=1, wrong current=1, change=2 (verify 1 + generate 1), blocked/invalid=0');
      } finally { await instance.dispose(); }
    });
  });

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
  async function seedClawBoard(database: Database, board: Board, counter = 0, userId = 'min') {
    await database.prepare('UPDATE claw_accounts SET board_json = ?, power_counter = ?, next_play_at = 0 WHERE user_id = ?')
      .bind(JSON.stringify(board), counter, userId).run();
  }

  async function uploadLuck(cookie: string, image = LUCK_PHOTO, instance?: Miniflare, roundDate = TODAY) {
    const response = await request('/api/games/luck/photo', { method: 'PUT', cookie, instance, body: { roundDate, image } });
    expect(response.status).toBe(200);
    return response.json() as Promise<LuckPhotoResponse>;
  }
  async function uploadProfile(cookie: string, photo = PROFILE_WEBP, instance?: Miniflare) {
    const response = await request('/api/me/photo', { method: 'PUT', cookie, instance, body: { photo } });
    expect(response.status).toBe(200);
    return (await response.json() as { user: User }).user;
  }

  describe('launch profile and photo APIs', () => {
    it('rejects stale profile and photo edits after another tab switches the authenticated account', async () => {
      const min = await login('min');
      const siwon = await login('siwon');
      await uploadProfile(min.cookie, PROFILE_JPEG);
      await uploadProfile(siwon.cookie, PROFILE_WEBP);
      const snapshot = async () => ({
        users: (await db.prepare("SELECT id, display_name, photo_version FROM users WHERE id IN ('min', 'siwon') ORDER BY id").all()).results,
        photos: (await db.prepare("SELECT user_id, mime, data, updated_at FROM user_photos WHERE user_id IN ('min', 'siwon') ORDER BY user_id").all()).results,
      });
      const before = await snapshot();
      const operations = [
        { path: '/api/me/profile', method: 'PUT', body: { displayName: '이전계정이름' } },
        { path: '/api/me/photo', method: 'PUT', body: { photo: PROFILE_JPEG } },
        { path: '/api/me/photo', method: 'DELETE', body: {} },
      ];
      for (const operation of operations) {
        const response = await request(operation.path, { method: operation.method, cookie: siwon.cookie,
          body: { ...operation.body, expectedUserId: 'min' } });
        expect(response.status).toBe(409);
        expect(await response.json()).toMatchObject({ error: { code: 'ACCOUNT_CHANGED' } });
        expect(await snapshot()).toEqual(before);
      }
      // The same routes remain usable when the screen and session agree.
      for (const operation of operations) {
        const response = await request(operation.path, { method: operation.method, cookie: siwon.cookie,
          body: { ...operation.body, expectedUserId: 'siwon' } });
        expect(response.status).toBe(200);
      }
      const after = await snapshot();
      expect(after.users.filter(row => row.id === 'min')).toEqual(before.users.filter(row => row.id === 'min'));
      expect(after.photos.filter(row => row.user_id === 'min')).toEqual(before.photos.filter(row => row.user_id === 'min'));
      expect((await bootstrap(siwon.cookie)).user).toMatchObject({ displayName: '이전계정이름', photoVersion: null });
    });


    it('normalizes NFC and surrounding spaces, counts Hangul graphemes, and leaves the login ID intact', async () => {
      const { cookie } = await login('min');
      const response = await request('/api/me/profile', { method: 'PUT', cookie, body: { displayName: `  ${'가'.repeat(10).normalize('NFD')}  ` } });
      expect(response.status).toBe(200);
      expect((await response.json() as { user: User }).user).toMatchObject({ username: 'min', displayName: '가'.repeat(10) });
      expect((await login('min')).user.displayName).toBe('가'.repeat(10));
      expect((await bootstrap(cookie)).players.find(player => player.id === 'min')?.displayName).toBe('가'.repeat(10));
      for (const displayName of ['', '  ', 'a'.repeat(11), '가'.repeat(11), '한 글', 'hello!', 'é', '中文', '👨‍👩‍👧‍👦', { toString: 'bad' }]) {
        expect((await request('/api/me/profile', { method: 'PUT', cookie, body: { displayName } })).status).toBe(400);
      }
      expect((await bootstrap(cookie)).user.displayName).toBe('가'.repeat(10));
      expect((await request('/api/me/profile', { method: 'PUT', cookie, body: { displayName: '새이름Ab12' } })).status).toBe(200);
    });

    it('enforces case-insensitive uniqueness across concurrent active users', async () => {
      const min = await login('min');
      const siwon = await login('siwon');
      const responses = await Promise.all([
        request('/api/me/profile', { method: 'PUT', cookie: min.cookie, body: { displayName: 'Together' } }),
        request('/api/me/profile', { method: 'PUT', cookie: siwon.cookie, body: { displayName: 'together' } }),
      ]);
      expect(responses.map(response => response.status).sort()).toEqual([200, 409]);
      expect(await db.prepare("SELECT COUNT(*) AS n FROM users WHERE display_name = 'Together' COLLATE NOCASE AND active = 1").first('n')).toBe(1);
    });

    it('allows inactive-name reuse but prevents reactivating a conflicting account', async () => {
      const { cookie } = await login('min');
      await db.prepare("UPDATE users SET active = 0, display_name = 'Reusable' WHERE id = 'siwon'").run();
      expect((await request('/api/me/profile', { method: 'PUT', cookie, body: { displayName: 'reusable' } })).status).toBe(200);
      await expect(db.prepare("UPDATE users SET active = 1 WHERE id = 'siwon'").run()).rejects.toThrow('UNIQUE');
      expect(await db.prepare("SELECT active FROM users WHERE id = 'siwon'").first('active')).toBe(0);
    });

    it.each([PROFILE_WEBP, PROFILE_JPEG])('serves a real 512px profile photo to another logged-in user with immutable private caching %#', async photo => {
      const min = await login('min');
      const siwon = await login('siwon');
      const user = await uploadProfile(min.cookie, photo);
      expect(user.photoVersion).toBe(1);
      const path = profilePhotoPath('min', user.photoVersion!);
      expect((await request(path)).status).toBe(401);
      const response = await request(path, { cookie: siwon.cookie });
      expect(response.status).toBe(200);
      expect(response.headers.get('cache-control')).toBe('private, max-age=31536000, immutable');
      expect(response.headers.get('vary')).toContain('Cookie');
      expect(response.headers.get('content-type')).toBe(photo.startsWith('data:image/webp') ? 'image/webp' : 'image/jpeg');
      expect(Buffer.from(await response.arrayBuffer())).toEqual(Buffer.from(photo.split(',')[1]!, 'base64'));
      const view = await bootstrap(siwon.cookie);
      expect(view.players.find(player => player.id === 'min')?.photoVersion).toBe(1);
      expect(JSON.stringify(view)).not.toContain(photo.split(',')[1]);
      expect(JSON.stringify(view)).not.toContain('data:image/');
    });

    it('rejects malformed, unsupported, non-512 and nonsquare profile images without changing version', async () => {
      const { cookie } = await login('min');
      const invalid = [null, '', 'https://example.test/p.jpg', 'data:image/jpeg;base64,@@@', DRAWING_PNG,
        DRAWING_WEBP, NONSQUARE_PHOTO, LUCK_PHOTO, PROFILE_WEBP.replace('image/webp', 'image/jpeg'),
        PROFILE_JPEG.slice(0, -8), PROFILE_WEBP.slice(0, -8), 'data:image/jpeg;base64,' + Buffer.from('not a jpeg').toString('base64')];
      for (const photo of invalid) {
        expect((await request('/api/me/photo', { method: 'PUT', cookie, body: { photo } })).status).toBe(400);
      }
      expect(await db.prepare('SELECT COUNT(*) AS n FROM user_photos').first('n')).toBe(0);
      expect((await bootstrap(cookie)).user.photoVersion).toBeNull();
    });

    it('accepts exactly 260KiB of valid JPEG bytes and rejects one extra byte', async () => {
      const { cookie } = await login('min');
      expect((await uploadProfile(cookie, paddedJpeg(260 * 1024))).photoVersion).toBe(1);
      const rejected = await request('/api/me/photo', { method: 'PUT', cookie, body: { photo: paddedJpeg(260 * 1024 + 1) } });
      expect(rejected.status).toBe(413);
      expect((await bootstrap(cookie)).user.photoVersion).toBe(1);
    });

    it('increments versions across replacements, deletion and reupload without reusing an old URL', async () => {
      const { cookie } = await login('min');
      expect((await uploadProfile(cookie)).photoVersion).toBe(1);
      expect((await uploadProfile(cookie, PROFILE_JPEG)).photoVersion).toBe(2);
      expect((await request(profilePhotoPath('min', 1), { cookie })).status).toBe(404);
      const deleted = await request('/api/me/photo', { method: 'DELETE', cookie, body: {} });
      expect(deleted.status).toBe(200);
      expect((await deleted.json() as { user: User }).user.photoVersion).toBeNull();
      expect((await request(profilePhotoPath('min', 2), { cookie })).status).toBe(404);
      expect((await bootstrap(cookie)).players.find(player => player.id === 'min')?.photoVersion).toBeNull();
      expect((await uploadProfile(cookie)).photoVersion).toBe(4);
      expect((await request(profilePhotoPath('min', 3), { cookie })).status).toBe(404);
    });

    it('rolls back photo-version counters with failed image writes or deletion', async () => {
      const { cookie } = await login('min');
      await db.prepare(`CREATE TRIGGER reject_profile_upload BEFORE INSERT ON user_photos
        BEGIN SELECT RAISE(ABORT, 'test photo write failure'); END;`).run();
      expect((await request('/api/me/photo', { method: 'PUT', cookie, body: { photo: PROFILE_WEBP } })).status).toBe(500);
      expect(await db.prepare("SELECT photo_version FROM users WHERE id = 'min'").first('photo_version')).toBeNull();
      expect(await db.prepare('SELECT COUNT(*) AS n FROM user_photos').first('n')).toBe(0);
      await db.prepare('DROP TRIGGER reject_profile_upload').run();
      expect((await uploadProfile(cookie)).photoVersion).toBe(1);
      await db.prepare(`CREATE TRIGGER reject_profile_delete BEFORE DELETE ON user_photos
        BEGIN SELECT RAISE(ABORT, 'test photo delete failure'); END;`).run();
      expect((await request('/api/me/photo', { method: 'DELETE', cookie, body: {} })).status).toBe(500);
      expect((await bootstrap(cookie)).user.photoVersion).toBe(1);
      expect((await request(profilePhotoPath('min', 1), { cookie })).status).toBe(200);
      await db.prepare('DROP TRIGGER reject_profile_delete').run();
      expect((await request('/api/me/photo', { method: 'DELETE', cookie, body: {} })).status).toBe(200);
    });

    it('rejects missing and invalid image versions and protects profile mutations with authentication', async () => {
      for (const path of ['/api/me/profile', '/api/me/photo']) {
        expect((await request(path, { method: 'PUT', body: {} })).status).toBe(401);
      }
      const { cookie } = await login('admin');
      expect((await request('/api/me/profile', { method: 'PUT', cookie, body: { displayName: '관리자2' } })).status).toBe(200);
      await uploadProfile(cookie);
      for (const suffix of ['', '?v=0', '?v=-1', '?v=1.5', '?v=nope']) {
        expect((await request(`/api/users/admin/photo${suffix}`, { cookie })).status).toBe(400);
      }
      expect((await request('/api/users/missing/photo?v=1', { cookie })).status).toBe(404);
      expect((await request('/api/me/photo', { method: 'PUT', cookie, origin: 'https://evil.test', body: { photo: PROFILE_WEBP } })).status).toBe(403);
    });

    it('updates nickname and photo metadata in results, participants and catchmind without leaking photo bytes', async () => {
      const min = await login('min'); const yeseo = await login('yeseo');
      expect((await request('/api/me/profile', { method: 'PUT', cookie: min.cookie, body: { displayName: '민새이름' } })).status).toBe(200);
      await uploadProfile(min.cookie);
      await seedRound({ game: 'luck', answer: '50', revealedAt: Date.parse(`${TODAY}T00:00:00Z`), predictions: [['min', '50']] });
      const view = await bootstrap(yeseo.cookie);
      const game = view.games.find(game => game.id === 'luck')!;
      expect(game.results[0]).toMatchObject({ displayName: '민새이름', photoVersion: 1 });
      expect(game.participants.find(player => player.playerId === 'min')).toMatchObject({ displayName: '민새이름', photoVersion: 1 });
      const round = await openCatchmind(min.cookie);
      expect(round.drawer).toMatchObject({ displayName: '민새이름', photoVersion: 1 });
      expect(JSON.stringify(await getCatchmind(yeseo.cookie))).not.toContain(PROFILE_WEBP.split(',')[1]);
    });
  });

  describe('luck evidence photos', () => {
    it('requires a photo before saving an answer and permits JPEG/WebP rectangular evidence', async () => {
      const { cookie } = await login('yeseo');
      expect((await request('/api/games/luck/answer', { method: 'PUT', cookie, body: { value: '77', hint: '오늘' } })).status).toBe(400);
      expect(await db.prepare("SELECT answer FROM game_rounds WHERE game_id = 'luck' AND round_date = ?").bind(TODAY).first('answer')).toBeNull();
      const uploaded = await uploadLuck(cookie);
      expect(uploaded.photo).toEqual({ url: luckPhotoPath(TODAY, 1), version: 1 });
      expect((await request('/api/games/luck/answer', { method: 'PUT', cookie, body: { value: '77', hint: '오늘' } })).status).toBe(200);
      expect((await uploadLuck(cookie, PROFILE_JPEG)).photo.version).toBe(2);
    });

    it('hides evidence before reveal, publishes it afterward and includes only URLs in polling responses', async () => {
      const yeseo = await login('yeseo'); const min = await login('min'); const admin = await login('admin');
      const uploaded = await uploadLuck(yeseo.cookie);
      const path = uploaded.photo.url;
      expect((await request(path)).status).toBe(401);
      for (const cookie of [min.cookie, admin.cookie]) expect((await request(path, { cookie })).status).toBe(403);
      expect((await request(path, { cookie: yeseo.cookie })).status).toBe(200);
      expect((await bootstrap(min.cookie)).games.find(game => game.id === 'luck')?.photo).toBeNull();
      expect((await bootstrap(yeseo.cookie)).games.find(game => game.id === 'luck')?.photo).toEqual(uploaded.photo);
      expect((await request('/api/games/luck/answer', { method: 'PUT', cookie: yeseo.cookie, body: { value: '77' } })).status).toBe(200);
      expect((await request('/api/games/luck/reveal', { method: 'POST', cookie: yeseo.cookie, body: {} })).status).toBe(200);
      const image = await request(path, { cookie: min.cookie });
      expect(image.status).toBe(200);
      expect(image.headers.get('cache-control')).toBe('private, max-age=31536000, immutable');
      expect(image.headers.get('vary')).toContain('Cookie');
      expect(Buffer.from(await image.arrayBuffer())).toEqual(Buffer.from(LUCK_PHOTO.split(',')[1]!, 'base64'));
      const view = await bootstrap(min.cookie);
      expect(view.games.find(game => game.id === 'luck')?.photo).toEqual(uploaded.photo);
      expect(JSON.stringify(view)).not.toContain('data:image/');
      expect(JSON.stringify(view)).not.toContain(LUCK_PHOTO.split(',')[1]);
      expect((await request('/api/games/luck/photo', { method: 'PUT', cookie: yeseo.cookie, body: { image: PROFILE_WEBP } })).status).toBe(409);
    });

    it('allows only today\'s author to replace a hidden photo and invalidates old version addresses', async () => {
      const yeseo = await login('yeseo'); const min = await login('min'); const admin = await login('admin');
      for (const cookie of [min.cookie, admin.cookie]) {
        expect((await request('/api/games/luck/photo', { method: 'PUT', cookie, body: { image: LUCK_PHOTO } })).status).toBe(403);
      }
      expect((await request('/api/games/luck/photo', { method: 'PUT', cookie: yeseo.cookie,
        body: { roundDate: '2026-10-29', image: LUCK_PHOTO } })).status).toBe(409);
      await uploadLuck(yeseo.cookie);
      expect((await uploadLuck(yeseo.cookie, PROFILE_WEBP)).photo.version).toBe(2);
      expect((await request(luckPhotoPath(TODAY, 1), { cookie: yeseo.cookie })).status).toBe(404);
      expect((await request(luckPhotoPath(TODAY, 2), { cookie: yeseo.cookie })).status).toBe(200);
      for (const suffix of ['', '?v=0', '?v=-1', '?v=1.5']) {
        expect((await request(`/api/games/luck/rounds/${TODAY}/photo${suffix}`, { cookie: yeseo.cookie })).status).toBe(400);
      }
    });

    it('accepts 440KiB evidence and rejects malformed, oversized and wider-than-1280 inputs', async () => {
      const { cookie } = await login('yeseo');
      expect((await uploadLuck(cookie, paddedJpeg(440 * 1024))).photo.version).toBe(1);
      expect((await request('/api/games/luck/photo', { method: 'PUT', cookie, body: { image: paddedJpeg(440 * 1024 + 1) } })).status).toBe(413);
      for (const image of [DRAWING_PNG, TOO_WIDE_PHOTO, 'not a photo', PROFILE_WEBP.slice(0, -8)]) {
        expect((await request('/api/games/luck/photo', { method: 'PUT', cookie, body: { image } })).status).toBe(400);
      }
      expect(await db.prepare('SELECT version FROM luck_photos WHERE round_date = ?').bind(TODAY).first('version')).toBe(1);
    });

    it('uses automatic reveal time for image permissions, keeps evidence out of history and deletes it after the day', async () => {
      const { cookie } = await login('min');
      await seedRound({ game: 'luck', date: '2026-10-29', answer: '50', revealAt: Date.parse('2026-10-29T09:00:00Z') });
      await db.prepare('INSERT INTO luck_photos (round_date, mime, data, version, updated_at) VALUES (?, ?, ?, 3, ?)')
        .bind('2026-10-29', 'image/webp', Array.from(Buffer.from(LUCK_PHOTO.split(',')[1]!, 'base64')), '2026-10-29T00:00:00Z').run();
      await db.prepare('INSERT INTO luck_photos (round_date, mime, data, version, updated_at) VALUES (?, ?, ?, 1, ?)')
        .bind(TODAY, 'image/webp', Array.from(Buffer.from(LUCK_PHOTO.split(',')[1]!, 'base64')), `${TODAY}T00:00:00Z`).run();
      const response = await request(luckPhotoPath('2026-10-29', 3), { cookie });
      expect(response.status).toBe(200);
      const history = await request('/api/games/luck/history', { cookie });
      const round = (await history.json() as HistoryResponse).history[0]!;
      expect(round).toMatchObject({ roundDate: '2026-10-29', answer: '50' });
      expect('photo' in round).toBe(false);
      // The nightly job keeps only today's evidence; the answer and results stay.
      await maintainDatabase(db as unknown as D1Database, new Date(`${TODAY}T00:00:00Z`));
      expect((await db.prepare('SELECT round_date FROM luck_photos').all()).results.map(row => row.round_date)).toEqual([TODAY]);
      expect((await request(luckPhotoPath('2026-10-29', 3), { cookie })).status).toBe(404);
      expect((await (await request('/api/games/luck/history', { cookie })).json() as HistoryResponse).history[0]).toMatchObject({ roundDate: '2026-10-29', answer: '50' });
    });

    it('rejects a photo replacement when the SQL write crosses KST midnight', async () => {
      const instance = runtime(await workerAt('2026-10-30T14:59:59Z', '2026-10-30T15:00:00Z'));
      try {
        const database = await instance.getD1Database('DB'); await provision(database, migration, passwordHash);
        const { cookie } = await login('yeseo', instance);
        expect((await request('/api/games/luck/photo', { method: 'PUT', cookie, instance, body: { image: LUCK_PHOTO } })).status).toBe(409);
        expect(await database.prepare('SELECT COUNT(*) AS n FROM luck_photos').first('n')).toBe(0);
      } finally { await instance.dispose(); }
    });
  });

  describe('notifications', () => {
    // Prize notices only: a player's own achievement notices (first purchase,
    // first win…) ride along in the same table and are covered separately.
    const notificationRows = async (database: Database = db) => (await database.prepare(
      "SELECT kind, audience, user_id, actor_id, payload_json, reference FROM notifications WHERE kind != 'achievement' ORDER BY id")
      .all<{ kind: string; audience: string; user_id: string | null; actor_id: string | null; payload_json: string; reference: string }>()).results;
    const addNotice = (id: string, actor: string, when: number) =>
      db.prepare(`INSERT INTO notifications (kind, audience, user_id, actor_id, payload_json, created_at, reference)
        VALUES ('speetto', 'all', NULL, ?, '{"kind":"speetto","prize":1500}', ?, ?)`)
        .bind(actor, new Date(when).toISOString(), id).run();

    it.each([0, 99])('stores a winning speetto roll %i atomically once across retries', async roll => {
      const instant = `${TODAY}T00:00:00Z`;
      const instance = runtime(await workerAt(instant, instant, roll, { noDailyFree: true }));
      try {
        const database = await instance.getD1Database('DB'); await provision(database, migration, passwordHash);
        await fund(1000, 'min', database);
        const min = await login('min', instance); const siwon = await login('siwon', instance);
        const body = { requestId: crypto.randomUUID(), payment: 'gold' };
        const responses = await Promise.all(Array.from({ length: 3 }, () => request('/api/shop/speetto', { method: 'POST', cookie: min.cookie, instance, body })));
        expect(responses.every(response => response.status === 200)).toBe(true);
        const purchase = (await responses[0]!.json() as SpeettoResponse).purchase!;
        const rows = await notificationRows(database);
        expect(rows).toHaveLength(roll === 0 ? 1 : 0);
        if (roll === 0) {
          expect(rows[0]).toMatchObject({ kind: 'speetto', audience: 'all', user_id: null, actor_id: 'min',
            reference: `notification:speetto:prize:${purchase.id}` });
          expect(JSON.parse(rows[0]!.payload_json)).toEqual({ kind: 'speetto', prize: 1500 });
          const peer = await request('/api/bootstrap', { cookie: siwon.cookie, instance });
          const seen = (await peer.json() as BootstrapResponse).notifications;
          expect(seen.unread).toBe(1);
          expect(seen.recent[0]).toMatchObject({ actorId: 'min', unread: true, payload: { kind: 'speetto', prize: 1500 } });
        }
        // bootstrap only carries what the toast may show, so my own win is not
        // in it; the centre below still lists it.
        const own = (await (await request('/api/bootstrap', { cookie: min.cookie, instance })).json() as BootstrapResponse).notifications;
        expect(own.recent.filter(notice => notice.payload.kind !== 'achievement')).toEqual([]);
        const centre = await (await request('/api/notifications', { cookie: min.cookie, instance })).json() as NotificationsResponse;
        expect(centre.notifications.filter(notice => notice.payload.kind !== 'achievement')).toHaveLength(roll === 0 ? 1 : 0);
      } finally { await instance.dispose(); }
    });

    it('rolls back a speetto debit, win and receipt when its notification cannot be inserted', async () => {
      const instant = `${TODAY}T00:00:00Z`;
      const instance = runtime(await workerAt(instant, instant, 0));
      try {
        const database = await instance.getD1Database('DB'); await provision(database, migration, passwordHash);
        await fund(1000, 'min', database);
        const { cookie } = await login('min', instance);
        await database.prepare(`CREATE TRIGGER reject_win_notice BEFORE INSERT ON notifications
          BEGIN SELECT RAISE(ABORT, 'test notification failure'); END;`).run();
        const body = { requestId: crypto.randomUUID(), payment: 'gold' };
        expect((await request('/api/shop/speetto', { method: 'POST', cookie, instance, body })).status).toBe(500);
        expect(await database.prepare('SELECT COUNT(*) AS n FROM shop_purchases').first('n')).toBe(0);
        expect(await database.prepare('SELECT COUNT(*) AS n FROM notifications WHERE kind != \'achievement\'').first('n')).toBe(0);
        expect((await ledgerRows(database)).map(row => row.amount)).toEqual([1000]);
        await database.prepare('DROP TRIGGER reject_win_notice').run();
        expect((await request('/api/shop/speetto', { method: 'POST', cookie, instance, body })).status).toBe(200);
        expect(await database.prepare('SELECT COUNT(*) AS n FROM notifications WHERE kind != \'achievement\'').first('n')).toBe(1);
      } finally { await instance.dispose(); }
    });

    it('notifies only daily lotto ranks one through three and deduplicates concurrent settlement', async () => {
      const min = await login('min'); const siwon = await login('siwon');
      await fund(3000);
      const picks = [[1,2,3,4,5], [1,2,3,4,6], [1,2,3,6,7], [1,2,6,7,8], [1,6,7,8,9], [6,7,8,9,10]];
      for (const numbers of picks) {
        expect((await request('/api/shop/lotto', { method: 'POST', cookie: min.cookie,
          body: { requestId: crypto.randomUUID(), numbers, payment: 'gold' } })).status).toBe(200);
      }
      await db.prepare("UPDATE lotto_tickets SET draw_date = '2026-10-29'").run();
      await db.prepare("INSERT INTO lotto_draws (date, numbers, created_at) VALUES ('2026-10-29', '[1,2,3,4,5]', '2026-10-29T08:00:00Z')").run();
      const views = await Promise.all([bootstrap(siwon.cookie), bootstrap(min.cookie), bootstrap(siwon.cookie)]);
      const rows = await notificationRows();
      expect(rows).toHaveLength(3);
      expect(rows.map(row => JSON.parse(row.payload_json).rank).sort()).toEqual([1,2,3]);
      expect(rows.map(row => JSON.parse(row.payload_json).prize).sort((a, b) => a - b)).toEqual([1000,3000,5000]);
      expect(rows.every(row => row.kind === 'lotto' && row.reference.startsWith('notification:lotto:prize:'))).toBe(true);
      expect(views[0]!.notifications.recent).toHaveLength(3);
      expect(views[0]!.notifications.unread).toBe(3);
      const payouts = (await ledgerRows()).filter(row => row.reference.startsWith('lotto:prize:'));
      expect(payouts.map(row => row.amount).sort((a, b) => a - b)).toEqual([500,1000,3000,5000]);
      await bootstrap(siwon.cookie);
      expect(await db.prepare('SELECT COUNT(*) AS n FROM notifications WHERE kind != \'achievement\'').first('n')).toBe(3);
    });

    it('rolls back lotto settlement and payout if its notification fails', async () => {
      const { cookie } = await login('min'); await fund(500);
      const bought = await request('/api/shop/lotto', { method: 'POST', cookie,
        body: { requestId: crypto.randomUUID(), numbers: [1,2,3,4,5], payment: 'gold' } });
      expect(bought.status).toBe(200);
      await db.prepare("UPDATE lotto_tickets SET draw_date = '2026-10-29'").run();
      await db.prepare("INSERT INTO lotto_draws (date, numbers, created_at) VALUES ('2026-10-29', '[1,2,3,4,5]', '2026-10-29T08:00:00Z')").run();
      await db.prepare(`CREATE TRIGGER reject_lotto_notice BEFORE INSERT ON notifications
        BEGIN SELECT RAISE(ABORT, 'test lotto notice failure'); END;`).run();
      expect((await request('/api/bootstrap', { cookie })).status).toBe(500);
      expect(await db.prepare('SELECT settled_at FROM lotto_tickets').first('settled_at')).toBeNull();
      expect((await ledgerRows()).filter(row => row.reference.startsWith('lotto:prize:'))).toEqual([]);
      expect(await db.prepare('SELECT COUNT(*) AS n FROM notifications WHERE kind != \'achievement\'').first('n')).toBe(0);
      await db.prepare('DROP TRIGGER reject_lotto_notice').run();
      expect((await bootstrap(cookie)).user.gold).toBe(5000);
      expect(await db.prepare('SELECT COUNT(*) AS n FROM notifications WHERE kind != \'achievement\'').first('n')).toBe(1);
    });

    it('counts unread against the watermark and clears it when the centre is opened', async () => {
      const min = await login('min');
      const now = Date.parse(`${TODAY}T00:00:00Z`);
      for (let index = 1; index <= 7; index++) await addNotice(`notice-${index}`, 'siwon', now - index * 1000);
      const before = (await bootstrap(min.cookie)).notifications;
      expect(before.unread).toBe(7);
      // Only the newest five ride along in bootstrap; the centre pages the rest.
      expect(before.recent).toHaveLength(5);
      expect(before.recent.every(notice => notice.unread)).toBe(true);
      const opened = await (await request('/api/notifications', { cookie: min.cookie })).json() as NotificationsResponse;
      expect(opened.notifications).toHaveLength(7);
      expect(opened.notifications.every(notice => notice.unread)).toBe(true);
      expect(opened.unread).toBe(0);
      expect((await bootstrap(min.cookie)).notifications.unread).toBe(0);
      // A notice stamped after the visit counts again; the frozen clock keeps it
      // out of the toast list, which only carries what has already happened.
      await addNotice('notice-after', 'siwon', now + 1000);
      const after = (await bootstrap(min.cookie)).notifications;
      expect(after.unread).toBe(1);
      expect(after.recent.every(notice => Date.parse(notice.createdAt) <= now)).toBe(true);
      expect((await (await request('/api/notifications', { cookie: min.cookie })).json() as NotificationsResponse)
        .notifications[0]).toMatchObject({ unread: true });
    });

    it('pages the centre oldest-ward and keeps personal notices to their owner', async () => {
      const min = await login('min'); const siwon = await login('siwon');
      const now = Date.parse(`${TODAY}T00:00:00Z`);
      for (let index = 1; index <= 22; index++) await addNotice(`page-${index}`, 'siwon', now - index * 1000);
      await db.prepare(`INSERT INTO notifications (kind, audience, user_id, actor_id, payload_json, created_at, reference)
        VALUES ('rank', 'user', 'min', 'min', '{"kind":"rank","period":"week","place":1,"gold":500}', ?, 'mine-only')`)
        .bind(new Date(now).toISOString()).run();
      const first = await (await request('/api/notifications', { cookie: min.cookie })).json() as NotificationsResponse;
      expect(first.notifications).toHaveLength(20);
      expect(first.notifications[0]!.payload.kind).toBe('rank');
      expect(first.nextBefore).not.toBeNull();
      const next = await (await request(`/api/notifications?before=${encodeURIComponent(first.nextBefore!)}`, { cookie: min.cookie })).json() as NotificationsResponse;
      expect(next.notifications).toHaveLength(3);
      expect(next.nextBefore).toBeNull();
      // siwon never sees a notice addressed to min.
      const theirs = await (await request('/api/notifications', { cookie: siwon.cookie })).json() as NotificationsResponse;
      expect(theirs.notifications.some(notice => notice.payload.kind === 'rank')).toBe(false);
      expect(theirs.notifications).toHaveLength(20);
    });

    it('sends an administrator notice to every player and refuses an empty or oversized title', async () => {
      const admin = await login('admin'); const min = await login('min');
      expect((await request('/api/admin/notifications', { method: 'POST', cookie: admin.cookie, body: { title: '  ' } })).status).toBe(400);
      expect((await request('/api/admin/notifications', { method: 'POST', cookie: admin.cookie, body: { title: 'ㄱ'.repeat(41) } })).status).toBe(400);
      expect((await request('/api/admin/notifications', { method: 'POST', cookie: min.cookie, body: { title: '안녕' } })).status).toBe(403);
      const sent = await request('/api/admin/notifications', { method: 'POST', cookie: admin.cookie,
        body: { title: '토요일은 쉬어요', body: '일요일에 다시 열려요.' } });
      expect(sent.status).toBe(200);
      const rows = await notificationRows();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ kind: 'admin', audience: 'all', user_id: null, actor_id: null });
      expect(JSON.parse(rows[0]!.payload_json)).toEqual({ kind: 'admin', title: '토요일은 쉬어요', body: '일요일에 다시 열려요.' });
      const mine = (await bootstrap(min.cookie)).notifications;
      expect(mine.unread).toBe(1);
      expect(mine.recent[0]!.payload).toMatchObject({ kind: 'admin', title: '토요일은 쉬어요' });
    });

    it('reads a bounded indexed window regardless of how much history exists', async () => {
      const now = new Date(`${TODAY}T00:00:00Z`);
      await db.batch(Array.from({ length: 5 }, (_, index) => db.prepare(`INSERT INTO notifications
        (kind, audience, user_id, actor_id, payload_json, created_at, reference)
        VALUES ('speetto', 'all', NULL, 'siwon', '{"kind":"speetto","prize":1500}', ?, ?)`)
        .bind(new Date(now.getTime() - index * 1000).toISOString(), `recent-fixture:${index}`)));
      const observed = measuredDatabase(db, now.getTime());
      expect((await readNotificationSummary(observed.binding, 'min', now)).recent).toHaveLength(5);
      const before = observed.rowsRead(); observed.reset();
      await db.batch(Array.from({ length: 200 }, (_, index) => db.prepare(`INSERT INTO notifications
        (kind, audience, user_id, actor_id, payload_json, created_at, reference)
        VALUES ('speetto', 'all', NULL, 'siwon', '{"kind":"speetto","prize":1500}', ?, ?)`)
        .bind(new Date(now.getTime() - 600000 - index * 1000).toISOString(), `old-fixture:${index}`)));
      const summary = await readNotificationSummary(observed.binding, 'min', now);
      expect(summary.recent).toHaveLength(5);
      expect(summary.unread).toBe(99);
      expect(observed.rowsRead()).toBeLessThanOrEqual(before + 100);
      console.log(`Notification summary D1 rows_read: ${before} for five notices, ${observed.rowsRead()} with 205 and the unread count capped at 99`);
    });
  });

  it('measures complete authenticated profile and luck photo API reads without production instrumentation', async () => {
    const instance = runtime(workerWithD1Metrics(script));
    try {
      const database = await instance.getD1Database('DB'); await provision(database, migration, passwordHash);
      const min = await login('min', instance); const yeseo = await login('yeseo', instance);
      const measurements: Record<string, number> = {};
      const measured = async (name: string, path: string, options: { method?: string; cookie: string; body?: unknown }) => {
        const response = await request(path, { ...options, instance });
        expect(response.status).toBe(200);
        const value = response.headers.get('X-Test-D1-Rows-Read'); expect(value).not.toBeNull();
        measurements[name] = Number(value); expect(measurements[name]).toBeGreaterThan(0);
        return response;
      };
      await measured('PUT profile', '/api/me/profile', { method: 'PUT', cookie: min.cookie, body: { displayName: '측정이름' } });
      const uploaded = await measured('PUT profile photo', '/api/me/photo', { method: 'PUT', cookie: min.cookie, body: { photo: PROFILE_WEBP } });
      const user = (await uploaded.json() as { user: User }).user;
      await measured('GET profile photo', profilePhotoPath('min', user.photoVersion!), { cookie: yeseo.cookie });
      await measured('DELETE profile photo', '/api/me/photo', { method: 'DELETE', cookie: min.cookie, body: {} });
      const luck = await measured('PUT luck photo', '/api/games/luck/photo', { method: 'PUT', cookie: yeseo.cookie, body: { roundDate: TODAY, image: LUCK_PHOTO } });
      const photo = (await luck.json() as LuckPhotoResponse).photo;
      await measured('GET luck photo author', photo.url, { cookie: yeseo.cookie });
      console.log(`Launch B full authenticated API D1 rows_read (empty history): ${JSON.stringify(measurements)}`);
    } finally { await instance.dispose(); }
  });

  describe('achievements', () => {
    type Achievements = import('../shared/achievements').AchievementsResponse;
    const achievements = async (cookie: string, instance?: Miniflare) => {
      const response = await request('/api/achievements', { cookie, instance }); expect(response.status).toBe(200);
      return response.json() as Promise<Achievements>;
    };
    const status = (view: Achievements, key: string, periodKey = '') => {
      const row = view.progress.find(item => item.key === key && item.periodKey === periodKey);
      return row ? row.claimedAt ? 'claimed' : 'unlocked' : 'locked';
    };

    it('unlocks on the first read and after writes, notifies the player once, and pays each claim exactly once', async () => {
      const instant = `${TODAY}T00:00:00Z`;
      const instance = runtime(await workerAt(instant, instant, 0));
      try {
        const database = await instance.getD1Database('DB'); await provision(database, migration, passwordHash);
        await fund(1000, 'min', database);
        const min = await login('min', instance); const admin = await login('admin', instance);
        const first = await achievements(min.cookie, instance);
        expect(status(first, 'welcome')).toBe('unlocked');
        expect(status(first, 'speetto_win')).toBe('locked');
        expect(first.unclaimed).toBe(1); expect(first.gold).toBe(1000);
        // Reading again changes nothing and notifies nothing twice.
        expect((await achievements(min.cookie, instance)).unclaimed).toBe(1);
        const notices = async () => (await database.prepare("SELECT reference, user_id, actor_id FROM notifications WHERE kind = 'achievement' ORDER BY id")
          .all<{ reference: string; user_id: string; actor_id: string }>()).results;
        expect(await notices()).toEqual([{ reference: 'notification:achievement:min:welcome:', user_id: 'min', actor_id: 'min' }]);
        // A winning scratch ticket (roll 0) completes 손톱이 일했다 after the write.
        const bought = await request('/api/shop/speetto', { method: 'POST', cookie: min.cookie, instance, body: { requestId: crypto.randomUUID(), payment: 'gold' } });
        expect(bought.status).toBe(200);
        const afterWin = await achievements(min.cookie, instance);
        expect(status(afterWin, 'speetto_win')).toBe('unlocked');
        expect(afterWin.unclaimed).toBe(2);
        expect((await notices()).map(row => row.reference)).toEqual(['notification:achievement:min:welcome:', 'notification:achievement:min:speetto_win:']);
        // My own achievement rides in bootstrap for the toast; a peer never sees it.
        const own = await (await request('/api/bootstrap', { cookie: min.cookie, instance })).json() as BootstrapResponse;
        expect(own.notifications.recent.filter(notice => notice.payload.kind === 'achievement')).toHaveLength(2);
        expect(own.notifications.recent.every(notice => notice.payload.kind !== 'achievement' || isToastWorthy(notice, 'min', Date.parse(instant)))).toBe(true);
        const siwon = await login('siwon', instance);
        const peer = await (await request('/api/bootstrap', { cookie: siwon.cookie, instance })).json() as BootstrapResponse;
        expect(peer.notifications.recent.filter(notice => notice.payload.kind === 'achievement')).toHaveLength(0);
        // Claiming pays once, even for three concurrent requests.
        const claims = await Promise.all(Array.from({ length: 3 }, () => request('/api/achievements/claim', { method: 'POST', cookie: min.cookie, instance, body: { key: 'welcome', periodKey: '' } })));
        expect(claims.map(response => response.status).sort()).toEqual([200, 409, 409]);
        const paid = await claims.find(response => response.status === 200)!.json() as Achievements;
        expect(status(paid, 'welcome')).toBe('claimed');
        expect(paid.gold).toBe(1000 - SPEETTO_RULES.price + SPEETTO_RULES.prize + 50);
        expect((await ledgerRows(database)).filter(row => row.reference.startsWith('achievement:'))).toEqual([{ user_id: 'min', currency: 'gold', amount: 50, reference: 'achievement:welcome::min', week_start: null }]);
        expect((await (await request('/api/achievements/claim', { method: 'POST', cookie: min.cookie, instance, body: { key: 'welcome', periodKey: '' } })).json() as { error: { code: string } }).error.code).toBe('ALREADY_CLAIMED');
        expect((await (await request('/api/achievements/claim', { method: 'POST', cookie: min.cookie, instance, body: { key: 'claw_clear', periodKey: '' } })).json() as { error: { code: string } }).error.code).toBe('NOT_UNLOCKED');
        expect((await request('/api/achievements/claim', { method: 'POST', cookie: min.cookie, instance, body: { key: 'nope', periodKey: '' } })).status).toBe(400);
        // 모두 받기 sends one list: rows collected elsewhere or still locked are skipped, the rest are paid once.
        const list = { claims: [{ key: 'welcome', periodKey: '' }, { key: 'speetto_win', periodKey: '' }, { key: 'claw_clear', periodKey: '' }] };
        const many = await request('/api/achievements/claim', { method: 'POST', cookie: min.cookie, instance, body: list });
        expect(many.status).toBe(200);
        const all = await many.json() as Achievements;
        expect(status(all, 'speetto_win')).toBe('claimed');
        expect(all.unclaimed).toBe(0);
        const rewards = (await ledgerRows(database)).filter(row => row.reference.startsWith('achievement:'));
        expect(rewards.map(row => row.reference).sort()).toEqual(['achievement:speetto_win::min', 'achievement:welcome::min']);
        expect(all.gold).toBe(paid.gold + rewards.find(row => row.reference === 'achievement:speetto_win::min')!.amount);
        const again = await request('/api/achievements/claim', { method: 'POST', cookie: min.cookie, instance, body: list });
        expect(again.status).toBe(409);
        expect((await again.json() as { error: { code: string } }).error.code).toBe('ALREADY_CLAIMED');
        for (const claims of [[], [{ key: 'welcome', periodKey: '' }, { key: 'welcome', periodKey: '' }], [{ key: 'welcome', periodKey: '' }, { key: 'nope', periodKey: '' }], [null]]) {
          expect((await request('/api/achievements/claim', { method: 'POST', cookie: min.cookie, instance, body: { claims } })).status).toBe(400);
        }
        // Administrators have no achievements and cannot claim any.
        expect((await achievements(admin.cookie, instance)).progress).toEqual([]);
        expect((await request('/api/achievements/claim', { method: 'POST', cookie: admin.cookie, instance, body: { key: 'welcome', periodKey: '' } })).status).toBe(403);
        await expectBalanced(database);
      } finally { await instance.dispose(); }
    });

    it('keys daily achievements by the round date, weekly ones by the settled week, and counts collections', async () => {
      const { cookie } = await login('min');
      // An exact wake guess satisfies all three tiers for that date; a two-minute
      // miss on another day satisfies the two wider ones only.
      await seedRound({ game: 'wake', date: '2026-10-29', answer: '08:00:00', revealedAt: Date.parse('2026-10-29T00:00:00Z'), predictions: [['min', '08:00:00']] });
      await seedRound({ game: 'wake', date: '2026-10-28', answer: '08:00:00', revealedAt: Date.parse('2026-10-28T00:00:00Z'), predictions: [['min', '08:02:00']] });
      await seedRound({ game: 'luck', date: '2026-10-29', answer: '50', revealedAt: Date.parse('2026-10-29T00:00:00Z'), predictions: [['min', '53']] });
      await db.prepare(`INSERT INTO notifications (kind, audience, user_id, actor_id, payload_json, created_at, reference)
        VALUES ('rank', 'user', 'min', 'min', '{"kind":"rank","period":"week","place":1,"gold":500}', ?, 'notification:rank:week:2026-10-19:min')`)
        .bind(`${TODAY}T00:00:00.000Z`).run();
      await bootstrap(cookie); // settles both rounds and runs the check for each predictor
      const view = await achievements(cookie);
      expect(status(view, 'wake_exact', '2026-10-29')).toBe('unlocked');
      expect(status(view, 'wake_close', '2026-10-29')).toBe('unlocked');
      expect(status(view, 'wake_near', '2026-10-28')).toBe('unlocked');
      expect(status(view, 'wake_close', '2026-10-28')).toBe('unlocked');
      expect(status(view, 'wake_exact', '2026-10-28')).toBe('locked');
      expect(status(view, 'luck_near', '2026-10-29')).toBe('unlocked');
      expect(status(view, 'luck_exact', '2026-10-29')).toBe('locked');
      expect(status(view, 'wake_join')).toBe('unlocked');
      expect(status(view, 'rank_week', '2026-10-19')).toBe('unlocked');
      expect(status(view, 'rank_month')).toBe('locked');
      const claimed = await (await request('/api/achievements/claim', { method: 'POST', cookie, body: { key: 'wake_near', periodKey: '2026-10-28' } })).json() as Achievements;
      expect(claimed.claimedCounts.wake_near).toBe(1);
      // A collected row from another day leaves the current list; unclaimed ones stay.
      expect(claimed.progress.some(row => row.key === 'wake_near' && row.periodKey === '2026-10-28')).toBe(false);
      expect(status(claimed, 'wake_close', '2026-10-28')).toBe('unlocked');
      expect((await ledgerRows()).find(row => row.reference === 'achievement:wake_near:2026-10-28:min')).toMatchObject({ amount: 100 });
    });

    it('accepts the allow-listed client event, counts opening the centre, attendance and a kuji A prize', async () => {
      const min = await login('min'); const siwon = await login('siwon');
      await fund(2000);
      expect((await request('/api/achievements/events', { method: 'POST', cookie: min.cookie, body: { event: 'password' } })).status).toBe(400);
      const fontSize = await (await request('/api/achievements/events', { method: 'POST', cookie: min.cookie, body: { event: 'font_size' } })).json() as Achievements;
      expect(status(fontSize, 'font_size')).toBe('unlocked');
      expect(status(fontSize, 'notifications')).toBe('locked');
      await request('/api/notifications', { cookie: min.cookie });
      expect(status(await achievements(min.cookie), 'notifications')).toBe('unlocked');
      expect((await request('/api/me/attendance', { method: 'POST', cookie: min.cookie, body: {} })).status).toBe(200);
      expect(status(await achievements(min.cookie), 'attend_first')).toBe('unlocked');
      // A board whose first cell is the A prize.
      const grades = ['A', 'B', 'B', 'C', 'C', 'C', ...Array(6).fill('D'), ...Array(10).fill('E'), ...Array(15).fill('F'), ...Array(25).fill('G'), ...Array(38).fill('H')];
      await db.prepare('INSERT INTO kuji_boards (id, grades, created_at) VALUES (1, ?, ?)').bind(JSON.stringify(grades), `${TODAY}T00:00:00.000Z`).run();
      const bought = await request('/api/shop/kuji', { method: 'POST', cookie: min.cookie, body: { requestId: crypto.randomUUID(), boardId: 1, positions: [0, 1] } });
      expect(bought.status).toBe(200);
      const board = (await bought.json() as KujiResponse).kuji;
      expect(board.recent).toHaveLength(1);
      expect(board.recent[0]).toMatchObject({ userId: 'min', lastOne: false, cells: [{ position: 0, grade: 'A' }, { position: 1, grade: 'B' }] });
      const afterKuji = await achievements(min.cookie);
      expect(status(afterKuji, 'kuji_first')).toBe('unlocked');
      expect(status(afterKuji, 'kuji_a')).toBe('unlocked');
      expect(status(afterKuji, 'kuji_last')).toBe('locked');
      // A round siwon drew that min guessed first try: both sides get theirs.
      await db.prepare(`INSERT INTO catchmind_rounds (id, number, drawer_id, word, normalized_word, word_history, status, round_date, published_at, ended_at, wrong_count, winner_id, end_reason, created_at)
        VALUES ('ach-round', 1, 'siwon', '사과', '사과', '["사과"]', 'ended', ?, ?, ?, 0, 'min', 'correct', ?)`)
        .bind(TODAY, `${TODAY}T00:00:00.000Z`, `${TODAY}T00:00:00.000Z`, `${TODAY}T00:00:00.000Z`).run();
      expect(status(await achievements(min.cookie), 'catchmind_first', TODAY)).toBe('unlocked');
      const drawer = await achievements(siwon.cookie);
      expect(status(drawer, 'catchmind_drawn_first', TODAY)).toBe('unlocked');
      expect(status(drawer, 'catchmind_draw')).toBe('unlocked');
      expect(status(drawer, 'catchmind_first', TODAY)).toBe('locked');
    });
  });

  describe('launch gift event', () => {
    const launchInstant = '2026-11-02T00:00:00Z'; // 09:00 KST on launch day.
    let launchScript: string;
    let launchNoFreeScript: string;
    beforeAll(async () => {
      [launchScript, launchNoFreeScript] = await Promise.all([workerAt(launchInstant), workerAt(launchInstant, undefined, undefined, { noDailyFree: true })]);
    });
    beforeEach(async () => {
      await worker.dispose();
      worker = runtime(launchScript);
      db = await worker.getD1Database('DB');
      await provision(db, migration, passwordHash);
    });
    async function attend(cookie: string, instance?: Miniflare) {
      const response = await request('/api/me/attendance', { method: 'POST', cookie, body: {}, instance });
      expect(response.status).toBe(200);
      expect((await response.json() as AttendanceClaimResponse).attendance.claimed).toBe(true);
    }
    async function claim(cookie: string, instance?: Miniflare) {
      const response = await request('/api/events/launch-gift', { method: 'POST', cookie, body: {}, instance });
      expect(response.status).toBe(200);
      return response.json() as Promise<LaunchGiftResponse>;
    }
    async function giftRows(database: Database = db) {
      return (await database.prepare(`SELECT user_id, item, amount, reference FROM inventory_ledger
        WHERE reference LIKE 'event:launch:%' ORDER BY reference`).all<{
          user_id: string; item: string; amount: number; reference: string;
        }>()).results;
    }

    it.each([
      { instant: '2026-11-01T14:59:59Z', date: '2026-11-01' },
      { instant: '2026-11-02T15:00:00Z', date: '2026-11-03' },
    ])('rejects the gift on KST $date even with attendance and a forged client date', async ({ instant }) => {
      const instance = runtime(await workerAt(instant));
      try {
        const database = await instance.getD1Database('DB');
        await provision(database, migration, passwordHash);
        const { cookie } = await login('min', instance);
        await seedAttendance('2026-11-02', 1, 'min', database);
        const response = await request('/api/events/launch-gift', { method: 'POST', cookie, instance,
          body: { date: '2026-11-02', serverTime: launchInstant, lottoTickets: 999, speettoTickets: 999 } });
        expect(response.status).toBe(409);
        expect(await giftRows(database)).toEqual([]);
        const view = await request('/api/bootstrap', { cookie, instance });
        expect((await view.json() as BootstrapResponse).launchGift).toEqual({ available: false, claimed: false });
      } finally { await instance.dispose(); }
    });

    it('requires attendance on launch day rather than an earlier attendance or client claim', async () => {
      const { cookie } = await login('min');
      await seedAttendance('2026-11-01', 1);
      expect((await bootstrap(cookie)).launchGift).toEqual({ available: false, claimed: false });
      expect((await request('/api/events/launch-gift', { method: 'POST', cookie,
        body: { attendance: true, date: '2026-11-02' } })).status).toBe(409);
      expect(await giftRows()).toEqual([]);
      await attend(cookie);
      expect((await bootstrap(cookie)).launchGift).toEqual({ available: true, claimed: false });
      // Merely revisiting bootstrap does not claim or lose the available gift.
      expect((await bootstrap(cookie)).launchGift).toEqual({ available: true, claimed: false });
      expect(await giftRows()).toEqual([]);
    });

    it('grants exactly five of each ticket after attendance and reflects them in bootstrap and shop', async () => {
      const { cookie } = await login('min');
      await attend(cookie);
      const result = await claim(cookie);
      expect(result).toMatchObject({ awarded: true, launchGift: { available: false, claimed: true },
        inventory: { lottoTickets: 5, speettoTickets: 5 }, serverTime: new Date(launchInstant).toISOString() });
      expect(await giftRows()).toEqual([
        { user_id: 'min', item: 'lotto_ticket', amount: 5, reference: 'event:launch:2026-11-02:min:lotto' },
        { user_id: 'min', item: 'speetto_ticket', amount: 5, reference: 'event:launch:2026-11-02:min:speetto' },
      ]);
      const view = await bootstrap(cookie);
      expect(view).toMatchObject({ launchGift: { available: false, claimed: true },
        inventory: { lottoTickets: 5, speettoTickets: 5 }, user: { gold: 100, weeklyScore: 0 } });
      const shopResponse = await request('/api/shop', { cookie });
      expect((await shopResponse.json() as ShopState).inventory).toEqual({ lottoTickets: 5, speettoTickets: 5, tagTickets: 0 });
      expect((await ledgerRows()).map(row => row.reference)).toEqual(['attendance:2026-11-02:min']);
    });

    it('grants once across simultaneous sessions and repeated requests', async () => {
      const first = await login('min');
      const second = await login('min');
      await attend(first.cookie);
      const results = await Promise.all([first.cookie, second.cookie, first.cookie, second.cookie].map(cookie => claim(cookie)));
      expect(results.filter(result => result.awarded)).toHaveLength(1);
      expect(results.every(result => result.launchGift.claimed && !result.launchGift.available)).toBe(true);
      expect(results.every(result => result.inventory.lottoTickets === 5 && result.inventory.speettoTickets === 5)).toBe(true);
      const repeated = await claim(first.cookie);
      expect(repeated).toMatchObject({ awarded: false, inventory: { lottoTickets: 5, speettoTickets: 5 } });
      expect(await giftRows()).toHaveLength(2);
    });

    it('keeps claim history after a ticket is spent instead of replenishing the gift', async () => {
      // Spend the gifted ticket itself, not one of today's free 이용권.
      await worker.dispose(); worker = runtime(launchNoFreeScript); db = await worker.getD1Database('DB'); await provision(db, migration, passwordHash);
      const { cookie } = await login('min');
      await attend(cookie);
      await claim(cookie);
      const purchase = await request('/api/shop/lotto', { method: 'POST', cookie,
        body: { requestId: crypto.randomUUID(), numbers: [1, 2, 3, 4, 5], payment: 'ticket' } });
      expect(purchase.status).toBe(200);
      expect((await bootstrap(cookie)).launchGift).toEqual({ available: false, claimed: true });
      expect(await claim(cookie)).toMatchObject({ awarded: false, inventory: { lottoTickets: 4, speettoTickets: 5 } });
      expect(await giftRows()).toHaveLength(2);
    });

    it('allows each active player to claim their own gift and ignores a forged recipient', async () => {
      const min = await login('min');
      const siwon = await login('siwon');
      await attend(min.cookie);
      await attend(siwon.cookie);
      const first = await request('/api/events/launch-gift', { method: 'POST', cookie: min.cookie,
        body: { userId: 'siwon', lottoTickets: 999, speettoTickets: 999 } });
      expect(first.status).toBe(200);
      expect((await giftRows()).map(row => row.user_id)).toEqual(['min', 'min']);
      expect((await bootstrap(siwon.cookie)).launchGift).toEqual({ available: true, claimed: false });
      await claim(siwon.cookie);
      expect(await giftRows()).toHaveLength(4);
      expect((await bootstrap(min.cookie)).inventory).toEqual({ lottoTickets: 5, speettoTickets: 5, tagTickets: 0 });
      expect((await bootstrap(siwon.cookie)).inventory).toEqual({ lottoTickets: 5, speettoTickets: 5, tagTickets: 0 });
    });

    it('requires login and rejects an admin even with a seeded attendance record', async () => {
      expect((await request('/api/events/launch-gift', { method: 'POST', body: {} })).status).toBe(401);
      const { cookie } = await login('admin');
      await seedAttendance('2026-11-02', 1, 'admin');
      expect((await bootstrap(cookie)).launchGift).toEqual({ available: false, claimed: false });
      expect((await request('/api/events/launch-gift', { method: 'POST', cookie, body: {} })).status).toBe(403);
      expect(await giftRows()).toEqual([]);
    });

    it('does not grant to a deactivated player or trust a stale authenticated actor', async () => {
      const { cookie } = await login('min');
      await attend(cookie);
      await db.prepare('UPDATE users SET active = 0 WHERE id = ?').bind('min').run();
      expect((await request('/api/events/launch-gift', { method: 'POST', cookie, body: {} })).status).toBe(401);
      const observed = measuredDatabase(db, Date.parse(launchInstant));
      const actor = { id: 'min', role: 'player' as const };
      expect(await getLaunchGiftState(observed.binding, actor, new Date(launchInstant))).toEqual({ available: false, claimed: false });
      await expect(claimLaunchGift(observed.binding, actor, new Date(launchInstant))).rejects.toMatchObject({ status: 403 });
      expect(await giftRows()).toEqual([]);
    });

    it('rolls back both ticket rows when the speetto grant fails and permits a clean retry', async () => {
      const { cookie } = await login('min');
      await attend(cookie);
      await db.prepare(`CREATE TRIGGER reject_launch_speetto BEFORE INSERT ON inventory_ledger
        WHEN NEW.reference = 'event:launch:2026-11-02:min:speetto'
        BEGIN SELECT RAISE(ABORT, 'test launch second ticket failure'); END;`).run();
      expect((await request('/api/events/launch-gift', { method: 'POST', cookie, body: {} })).status).toBe(500);
      expect(await giftRows()).toEqual([]);
      expect((await bootstrap(cookie)).launchGift).toEqual({ available: true, claimed: false });
      await db.prepare('DROP TRIGGER reject_launch_speetto').run();
      expect(await claim(cookie)).toMatchObject({ awarded: true, inventory: { lottoTickets: 5, speettoTickets: 5 } });
      expect(await giftRows()).toHaveLength(2);
    });

    it('rejects a grant if the D1 write crosses into November 3 even though JavaScript began on launch day', async () => {
      const instance = runtime(await workerAt('2026-11-02T14:59:59Z', '2026-11-02T15:00:00Z'));
      try {
        const database = await instance.getD1Database('DB');
        await provision(database, migration, passwordHash);
        const { cookie } = await login('min', instance);
        await seedAttendance('2026-11-02', 1, 'min', database);
        expect((await request('/api/events/launch-gift', { method: 'POST', cookie, body: {}, instance })).status).toBe(409);
        expect(await giftRows(database)).toEqual([]);
      } finally { await instance.dispose(); }
    });

    it('accepts the exact KST launch midnight and retains claimed state after the event closes', async () => {
      const instant = '2026-11-01T15:00:00Z';
      const instance = runtime(await workerAt(instant));
      try {
        const database = await instance.getD1Database('DB');
        await provision(database, migration, passwordHash);
        const { cookie } = await login('min', instance);
        await attend(cookie, instance);
        expect(await claim(cookie, instance)).toMatchObject({ awarded: true, launchGift: { available: false, claimed: true } });
        const after = new Date('2026-11-02T15:00:00Z');
        const observed = measuredDatabase(database, after.getTime());
        const actor = { id: 'min', role: 'player' as const };
        expect(await getLaunchGiftState(observed.binding, actor, after)).toEqual({ available: false, claimed: true });
        await expect(claimLaunchGift(observed.binding, actor, after)).rejects.toMatchObject({ status: 409 });
        expect(await giftRows(database)).toHaveLength(2);
      } finally { await instance.dispose(); }
    });

    it('measures the whole authenticated gift API request including session lookup', async () => {
      const instance = runtime(workerWithD1Metrics(launchScript));
      try {
        const database = await instance.getD1Database('DB');
        await provision(database, migration, passwordHash);
        const { cookie } = await login('min', instance);
        await attend(cookie, instance);
        const totals: number[] = [];
        for (const awarded of [true, false]) {
          const response = await request('/api/events/launch-gift', { method: 'POST', cookie, body: {}, instance });
          expect(response.status).toBe(200);
          expect(await response.json()).toMatchObject({ awarded, inventory: { lottoTickets: 5, speettoTickets: 5 } });
          const header = response.headers.get('X-Test-D1-Rows-Read');
          expect(header).not.toBeNull();
          const rowsRead = Number(header);
          expect(rowsRead).toBeGreaterThan(10); // Business-only measurement is 10; this includes auth.
          expect(rowsRead).toBeLessThanOrEqual(30);
          totals.push(rowsRead);
        }
        console.log(`Launch gift full authenticated POST D1 rows_read: initial claim=${totals[0]}, saved retry=${totals[1]} (empty prior inventory, test-bundle-only instrumentation)`);
      } finally { await instance.dispose(); }
    });

    it('reports actual D1 rows_read for the gift summary, initial claim and saved retry', async () => {
      const { cookie } = await login('min');
      await attend(cookie);
      const observed = measuredDatabase(db, Date.parse(launchInstant));
      const actor = { id: 'min', role: 'player' as const };
      const now = new Date(launchInstant);
      expect(await getLaunchGiftState(observed.binding, actor, now)).toEqual({ available: true, claimed: false });
      const summaryRowsRead = observed.rowsRead();
      observed.reset();
      expect((await claimLaunchGift(observed.binding, actor, now)).awarded).toBe(true);
      const claimRowsRead = observed.rowsRead();
      // D1 rows_written includes index writes; inspect business rows separately.
      expect(await giftRows()).toHaveLength(2);
      observed.reset();
      expect(await getLaunchGiftState(observed.binding, actor, now)).toEqual({ available: false, claimed: true });
      const claimedSummaryRowsRead = observed.rowsRead();
      observed.reset();
      expect((await claimLaunchGift(observed.binding, actor, now)).awarded).toBe(false);
      const retryRowsRead = observed.rowsRead();
      expect(observed.queries.reduce((total, query) => total + query.rowsWritten, 0)).toBe(0);
      expect(summaryRowsRead).toBeLessThanOrEqual(12);
      expect(claimedSummaryRowsRead).toBeLessThanOrEqual(12);
      expect(claimRowsRead).toBeLessThanOrEqual(40);
      expect(retryRowsRead).toBeLessThanOrEqual(30);
      console.log(`Launch gift D1 meta rows_read: bootstrap gift summary unclaimed/claimed=${summaryRowsRead}/${claimedSummaryRowsRead}, POST initial claim=${claimRowsRead}, POST saved retry=${retryRowsRead} (authenticated module calls, empty prior inventory; auth and unrelated bootstrap queries excluded)`);
    });
  });

  describe('admin console prediction settings', () => {
    const tomorrow = '2026-10-31';
    const customRules = (game: GameId, overrides: Partial<PredictionRules> = {}): PredictionRules => ({
      ...defaultPredictionRules(game), ...overrides,
    });
    async function readAdmin(cookie: string, instance?: Miniflare): Promise<AdminState> {
      const response = await request('/api/admin', { cookie, instance });
      expect(response.status).toBe(200);
      return response.json() as Promise<AdminState>;
    }
    const save = (cookie: string, game: GameId, rules: unknown, effectiveFrom: unknown = TODAY, instance?: Miniflare) =>
      request(`/api/admin/games/${game}`, { method: 'PUT', cookie, instance, body: { rules, effectiveFrom } });
    const readGame = async (cookie: string, game: GameId, instance?: Miniflare) => {
      const response = await request(`/api/games/${game}`, { cookie, instance });
      expect(response.status).toBe(200);
      return (await response.json() as GameResponse).game;
    };

    it('requires an active administrator for every settings endpoint and leaves no rejected audit', async () => {
      const { cookie } = await login('min');
      for (const [path, method, body] of [
        ['/api/admin', 'GET', undefined],
        ['/api/admin/games/wake', 'PUT', { rules: customRules('wake'), effectiveFrom: tomorrow }],
        ['/api/admin/claw', 'PUT', { payoutEvery: 10, weakPickup: .45, weakCarry: .3 }],
      ] as const) {
        expect((await request(path, { method, body })).status).toBe(401);
        const forbidden = await request(path, { method, body, cookie });
        expect(forbidden.status).toBe(403);
        expect(await forbidden.json()).toMatchObject({ error: { code: 'ADMIN_ONLY' } });
      }
      const admin = await login('admin');
      await db.prepare("UPDATE users SET active = 0 WHERE id = 'admin'").run();
      expect((await request('/api/admin', { cookie: admin.cookie })).status).toBe(401);
      expect(await db.prepare('SELECT COUNT(*) AS n FROM admin_changes').first('n')).toBe(0);
      expect(await db.prepare('SELECT COUNT(*) AS n FROM game_settings').first('n')).toBe(0);
    });

    it('returns shared defaults and schedules omitted effectiveFrom for tomorrow without changing today', async () => {
      const admin = await login('admin'); const min = await login('min');
      const before = await readAdmin(admin.cookie);
      expect(before).toMatchObject({ today: TODAY, tomorrow, changes: [] });
      expect(before.games.map(game => game.id).sort()).toEqual(['luck', 'offwork', 'wake']);
      expect(before.games.every(game => game.canApplyToday && game.scheduledRules === null)).toBe(true);
      expect(before.games.find(game => game.id === 'wake')?.rules).toMatchObject({
        enabled: true, deadline: '10:30:00', participationGold: 100, firstGold: 100,
      });
      const updated = customRules('offwork', { participationGold: 321, firstGold: 654, deadline: '16:45:30' });
      const saved = await request('/api/admin/games/offwork', { method: 'PUT', cookie: admin.cookie, body: { rules: updated } });
      expect(saved.status).toBe(200);
      const view = await saved.json() as AdminState;
      expect(view.games.find(game => game.id === 'offwork')).toMatchObject({ rules: before.games.find(game => game.id === 'offwork')!.rules, scheduledRules: updated });
      expect((await readGame(min.cookie, 'offwork')).rules.participationGold).toBe(100);
      const row = await db.prepare('SELECT effective_from, settings_json FROM game_settings WHERE game_id = ?').bind('offwork').first<{ effective_from: string; settings_json: string }>();
      expect(row?.effective_from).toBe(tomorrow);
      expect(JSON.parse(row!.settings_json)).toEqual(updated);
      const audit = await db.prepare('SELECT admin_id, before_json, after_json, effective_from FROM admin_changes').first<{ admin_id: string; before_json: string; after_json: string; effective_from: string }>();
      expect(audit).toMatchObject({ admin_id: 'admin', effective_from: tomorrow });
      expect(JSON.parse(audit!.before_json)).toEqual(customRules('offwork'));
      expect(JSON.parse(audit!.after_json)).toEqual(updated);
    });

    it('activates scheduled rules at KST midnight and keeps the prior day unchanged', async () => {
      const persistence = await mkdtemp(join(tmpdir(), 'yegoom-admin-midnight-'));
      let instance = runtime(await workerAt('2026-10-30T14:59:59Z'), persistence);
      try {
        const database = await instance.getD1Database('DB'); await provision(database, migration, passwordHash);
        const admin = await login('admin', instance); const min = await login('min', instance);
        const updated = customRules('wake', { enabled: false, participationGold: 333 });
        expect((await save(admin.cookie, 'wake', updated, tomorrow, instance)).status).toBe(200);
        expect((await readGame(min.cookie, 'wake', instance)).rules.enabled).toBe(true);
        await instance.dispose();
        instance = runtime(await workerAt('2026-10-30T15:00:00Z'), persistence);
        const after = await readGame(min.cookie, 'wake', instance);
        expect(after.roundDate).toBe(tomorrow); expect(after.rules).toEqual(updated);
        expect((await readAdmin(admin.cookie, instance)).today).toBe(tomorrow);
        const persisted = await instance.getD1Database('DB');
        expect(await persisted.prepare('SELECT COUNT(*) AS n FROM game_rounds').first('n')).toBe(0);
      } finally { await instance.dispose(); await rm(persistence, { recursive: true, force: true }); }
    });

    it('applies today when an existing round is empty and replaces only its unused snapshot', async () => {
      const admin = await login('admin'); const min = await login('min');
      await seedRound({ game: 'offwork' });
      await db.prepare('UPDATE game_rounds SET settings_json = ? WHERE game_id = ? AND round_date = ?')
        .bind(JSON.stringify(customRules('offwork')), 'offwork', TODAY).run();
      const updated = customRules('offwork', { participationGold: 70, firstGold: 80, deadline: '16:00:00' });
      expect((await readAdmin(admin.cookie)).games.find(game => game.id === 'offwork')?.canApplyToday).toBe(true);
      expect((await save(admin.cookie, 'offwork', updated)).status).toBe(200);
      expect((await readGame(min.cookie, 'offwork')).rules).toEqual(updated);
      expect(JSON.parse((await db.prepare('SELECT settings_json FROM game_rounds WHERE game_id = ? AND round_date = ?').bind('offwork', TODAY).first<string>('settings_json'))!)).toEqual(updated);
      const predicted = await request('/api/games/offwork/prediction', { method: 'PUT', cookie: min.cookie, body: { value: '18:00:00' } });
      expect(predicted.status).toBe(200);
      expect((await ledgerRows()).map(row => [row.currency, row.amount])).toEqual([['gold', 70]]);
    });

    it.each(['prediction', 'answer'] as const)('rejects today after a %s and keeps the next-day choice available', async activity => {
      const admin = await login('admin'); const min = await login('min'); const siwon = await login('siwon');
      expect((await request(`/api/games/offwork/${activity}`, { method: 'PUT', cookie: activity === 'prediction' ? min.cookie : siwon.cookie, body: { value: '18:01:00' } })).status).toBe(200);
      const before = await readAdmin(admin.cookie);
      const state = before.games.find(game => game.id === 'offwork')!;
      expect(state.canApplyToday).toBe(false); expect(state.activityReason).toBeTruthy();
      const updated = customRules('offwork', { enabled: false });
      const response = await save(admin.cookie, 'offwork', updated);
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({ error: { code: 'TODAY_HAS_ACTIVITY' } });
      expect(await db.prepare('SELECT COUNT(*) AS n FROM admin_changes').first('n')).toBe(0);
      expect((await save(admin.cookie, 'offwork', updated, tomorrow)).status).toBe(200);
      expect((await readGame(min.cookie, 'offwork')).rules.enabled).toBe(true);
    });

    it('serializes a today-OFF save racing the first prediction so exactly one operation wins', async () => {
      const admin = await login('admin'); const min = await login('min');
      const [setting, prediction] = await Promise.all([
        save(admin.cookie, 'offwork', customRules('offwork', { enabled: false })),
        request('/api/games/offwork/prediction', { method: 'PUT', cookie: min.cookie, body: { value: '18:01:00' } }),
      ]);
      expect([setting.status, prediction.status].sort()).toEqual([200, 409]);
      const count = await db.prepare("SELECT COUNT(*) AS n FROM predictions WHERE game_id = 'offwork'").first('n');
      if (setting.status === 200) {
        expect(count).toBe(0); expect(await ledgerRows()).toEqual([]);
        expect(await db.prepare("SELECT COUNT(*) AS n FROM game_rounds WHERE game_id = 'offwork'").first('n')).toBe(0);
      } else {
        expect(count).toBe(1);
        expect((await ledgerRows()).map(row => row.amount)).toEqual([100]);
        expect(await db.prepare('SELECT COUNT(*) AS n FROM game_settings').first('n')).toBe(0);
      }
    });

    it('settles yesterday only from its stored rules even if the underlying settings row later changes', async () => {
      const persistence = await mkdtemp(join(tmpdir(), 'yegoom-admin-snapshot-'));
      let instance = runtime(script, persistence);
      try {
        const database = await instance.getD1Database('DB'); await provision(database, migration, passwordHash);
        const admin = await login('admin', instance); const min = await login('min', instance); const siwon = await login('siwon', instance);
        const original = customRules('offwork', { participationGold: 70, firstGold: 80, scoreTable: [{ maxDifference: 30, points: 42 }] });
        expect((await save(admin.cookie, 'offwork', original, TODAY, instance)).status).toBe(200);
        expect((await request('/api/games/offwork/prediction', { method: 'PUT', cookie: min.cookie, instance, body: { value: '18:00:15' } })).status).toBe(200);
        expect((await request('/api/games/offwork/answer', { method: 'PUT', cookie: siwon.cookie, instance, body: { value: '18:00:00' } })).status).toBe(200);
        const snapshot = await database.prepare("SELECT settings_json FROM game_rounds WHERE game_id = 'offwork' AND round_date = ?").bind(TODAY).first<string>('settings_json');
        expect(JSON.parse(snapshot!)).toEqual(original);
        const replacement = customRules('offwork', { participationGold: 1, firstGold: 2, scoreTable: [{ maxDifference: 30, points: 3 }] });
        expect((await save(admin.cookie, 'offwork', replacement, tomorrow, instance)).status).toBe(200);
        // Deliberately make the lookup row disagree: settlement must use the round,
        // even if a maintenance correction ever changes historical configuration.
        await database.prepare('UPDATE game_settings SET settings_json = ? WHERE game_id = ? AND effective_from = ?')
          .bind(JSON.stringify(replacement), 'offwork', TODAY).run();
        await instance.dispose(); instance = runtime(await workerAt('2026-10-31T00:00:00Z'), persistence);
        const response = await request('/api/bootstrap', { cookie: min.cookie, instance });
        expect(response.status).toBe(200);
        const view = await response.json() as BootstrapResponse;
        expect(view.user).toMatchObject({ gold: 150, weeklyScore: 42 });
        expect(view.games.find(game => game.id === 'offwork')!.rules).toEqual(replacement);
        const history = await request('/api/games/offwork/history', { cookie: min.cookie, instance });
        const past = (await history.json() as HistoryResponse).history[0]!;
        expect(past.roundDate).toBe(TODAY);
        expect(past.results[0]).toMatchObject({ score: 42, participationGold: 70, firstGold: 80, gold: 150 });
        const persisted = await instance.getD1Database('DB'); const paid = await ledgerRows(persisted);
        await request('/api/bootstrap', { cookie: min.cookie, instance });
        expect(await ledgerRows(persisted)).toEqual(paid);
      } finally { await instance.dispose(); await rm(persistence, { recursive: true, force: true }); }
    });

    it('keeps legacy rounds without snapshots on their historical default rules', async () => {
      const admin = await login('admin'); const min = await login('min');
      await seedRound({ game: 'offwork', date: '2026-10-29', answer: '18:00:00', revealedAt: Date.parse('2026-10-29T09:00:00Z'), predictions: [['min', '18:00:15']] });
      expect((await save(admin.cookie, 'offwork', customRules('offwork', { firstGold: 777, scoreTable: [{ maxDifference: 99, points: 99 }] }))).status).toBe(200);
      const view = await bootstrap(min.cookie);
      expect(view.user).toMatchObject({ gold: 100, weeklyScore: 25 });
      const history = await request('/api/games/offwork/history', { cookie: min.cookie });
      expect((await history.json() as HistoryResponse).history[0]!.results[0]).toMatchObject({ score: 25, firstGold: 100, participationGold: 100 });
    });

    it('accepts zero rewards and score without inserting forbidden zero-value ledger entries', async () => {
      const admin = await login('admin'); const min = await login('min'); const siwon = await login('siwon');
      expect((await save(admin.cookie, 'offwork', customRules('offwork', { participationGold: 0, firstGold: 0, scoreTable: [{ maxDifference: 0, points: 0 }] }))).status).toBe(200);
      expect((await request('/api/games/offwork/prediction', { method: 'PUT', cookie: min.cookie, body: { value: '18:00:00' } })).status).toBe(200);
      expect((await request('/api/games/offwork/answer', { method: 'PUT', cookie: siwon.cookie, body: { value: '18:00:00' } })).status).toBe(200);
      const reveal = await request('/api/games/offwork/reveal', { method: 'POST', cookie: siwon.cookie, body: {} });
      expect(reveal.status).toBe(200);
      expect((await reveal.json() as GameResponse).game.results[0]).toMatchObject({ score: 0, participationGold: 0, firstGold: 0, gold: 0, isFirst: true });
      expect(await ledgerRows()).toEqual([]);
      expect(await db.prepare("SELECT settled_at FROM game_rounds WHERE game_id = 'offwork' AND round_date = ?").bind(TODAY).first('settled_at')).not.toBeNull();
    });

    it.each([{ deadline: '09:00:00', status: 409 }, { deadline: '09:00:01', status: 200 }])('uses the configured cutoff $deadline for reads and writes at exactly 09:00:00', async ({ deadline, status }) => {
      const admin = await login('admin'); const min = await login('min');
      expect((await save(admin.cookie, 'offwork', customRules('offwork', { deadline }))).status).toBe(200);
      const game = await readGame(min.cookie, 'offwork');
      expect(game.deadline).toBe(deadline); expect(game.canPredict).toBe(status === 200);
      expect((await request('/api/games/offwork/prediction', { method: 'PUT', cookie: min.cookie, body: { value: '18:00:00' } })).status).toBe(status);
    });

    it('rejects a prediction when the SQL write crosses the configured cutoff', async () => {
      const instance = runtime(await workerAt(`${TODAY}T00:00:00Z`, `${TODAY}T00:00:01Z`));
      try {
        const database = await instance.getD1Database('DB'); await provision(database, migration, passwordHash);
        const admin = await login('admin', instance); const min = await login('min', instance);
        expect((await save(admin.cookie, 'offwork', customRules('offwork', { deadline: '09:00:01' }), TODAY, instance)).status).toBe(200);
        const response = await request('/api/games/offwork/prediction', { method: 'PUT', cookie: min.cookie, instance, body: { value: '18:00:00' } });
        expect(response.status).toBe(409);
        expect(await database.prepare('SELECT COUNT(*) AS n FROM predictions').first('n')).toBe(0);
        expect(await ledgerRows(database)).toEqual([]);
      } finally { await instance.dispose(); }
    });

    it.each(['wake', 'offwork', 'luck'] as const)('rejects every OFF-day action without creating a %s round', async game => {
      const admin = await login('admin'); const author = await login(game === 'wake' ? 'min' : game === 'offwork' ? 'siwon' : 'yeseo');
      const predictor = await login(game === 'wake' ? 'siwon' : 'min');
      expect((await save(admin.cookie, game, customRules(game, { enabled: false }))).status).toBe(200);
      expect((await readGame(predictor.cookie, game)).rules.enabled).toBe(false);
      const actions = [
        { action: 'prediction', method: 'PUT', cookie: predictor.cookie, body: { value: game === 'luck' ? '77' : '18:00:00' } },
        { action: 'answer', method: 'PUT', cookie: author.cookie, body: { value: game === 'luck' ? '77' : '18:00:00' } },
        { action: game === 'wake' ? 'wake' : 'reveal', method: 'POST', cookie: author.cookie, body: {} },
      ];
      if (game === 'luck') actions.push({ action: 'photo', method: 'PUT', cookie: author.cookie, body: { image: LUCK_PHOTO } } as typeof actions[number]);
      for (const action of actions) {
        const response = await request(`/api/games/${game}/${action.action}`, action);
        expect(response.status).toBe(409);
        expect(await response.json()).toMatchObject({ error: { code: 'GAME_OFF' } });
      }
      expect(await db.prepare('SELECT COUNT(*) AS n FROM game_rounds').first('n')).toBe(0);
      expect(await db.prepare('SELECT COUNT(*) AS n FROM predictions').first('n')).toBe(0);
      expect(await db.prepare('SELECT COUNT(*) AS n FROM luck_photos').first('n')).toBe(0);
      expect(await ledgerRows()).toEqual([]);
    });

    it('rejects invalid tables, gold, fixed times and malformed rules without an audit or settings row', async () => {
      const { cookie } = await login('admin');
      const invalid: [GameId, unknown][] = [
        ['offwork', null], ['offwork', {}], ['offwork', { ...customRules('offwork'), enabled: 'true' }],
        ['offwork', customRules('offwork', { scoreTable: [] })],
        ['offwork', customRules('offwork', { scoreTable: Array.from({ length: 11 }, (_, index) => ({ maxDifference: index, points: 1 })) })],
        ['offwork', customRules('offwork', { scoreTable: [{ maxDifference: 10, points: 10 }, { maxDifference: 10, points: 5 }] })],
        ['offwork', customRules('offwork', { scoreTable: [{ maxDifference: 10, points: 10 }, { maxDifference: 9, points: 5 }] })],
        ['offwork', customRules('offwork', { scoreTable: [{ maxDifference: 0, points: 5 }, { maxDifference: 1, points: 6 }] })],
        ...[-1, .5, 101].map(points => ['offwork', customRules('offwork', { scoreTable: [{ maxDifference: 0, points }] })] as [GameId, unknown]),
        ...[-1, .5, Number.MAX_SAFE_INTEGER + 1].map(maxDifference => ['luck', customRules('luck', { scoreTable: [{ maxDifference, points: 1 }] })] as [GameId, unknown]),
        ...[-1, .5, 1001].map(participationGold => ['offwork', customRules('offwork', { participationGold })] as [GameId, unknown]),
        ...[-1, .5, 10001].map(firstGold => ['offwork', customRules('offwork', { firstGold })] as [GameId, unknown]),
        ...['9:00:00', '24:00:00', '12:60:00', '12:00:60', '12:00'].map(deadline => ['offwork', customRules('offwork', { deadline })] as [GameId, unknown]),
        ['wake', customRules('wake', { deadline: '10:29:59' })],
        ['luck', customRules('luck', { deadline: '18:00:00' })], ['luck', customRules('luck', { deadline: '18:00:01' })],
        ['luck', customRules('luck', { revealTime: '19:00:00' })], ['wake', customRules('wake', { revealTime: '18:00:00' })],
      ];
      for (const [game, rules] of invalid) {
        const response = await save(cookie, game, rules, tomorrow);
        expect(response.status, JSON.stringify(rules)).toBe(400);
      }
      expect(await db.prepare('SELECT COUNT(*) AS n FROM game_settings').first('n')).toBe(0);
      expect(await db.prepare('SELECT COUNT(*) AS n FROM admin_changes').first('n')).toBe(0);
    });

    it('accepts one and ten ordered rows, equal descending points and gold endpoints', async () => {
      const { cookie } = await login('admin');
      for (const rules of [
        customRules('luck', { scoreTable: [{ maxDifference: 0, points: 100 }], participationGold: 1000, firstGold: 10000, deadline: '17:59:59' }),
        customRules('luck', { scoreTable: Array.from({ length: 10 }, (_, index) => ({ maxDifference: index, points: 0 })), participationGold: 0, firstGold: 0, deadline: '00:00:00' }),
      ]) expect((await save(cookie, 'luck', rules, tomorrow)).status).toBe(200);
      const row = await db.prepare("SELECT settings_json FROM game_settings WHERE game_id = 'luck'").first<string>('settings_json');
      expect(JSON.parse(row!).scoreTable).toHaveLength(10);
      expect(await db.prepare('SELECT COUNT(*) AS n FROM admin_changes').first('n')).toBe(2);
    });

    it('rejects dates other than today and tomorrow and rolls back settings when audit insertion fails', async () => {
      const { cookie } = await login('admin'); const rules = customRules('offwork');
      for (const date of ['2026-10-29', '2026-11-01', '2026-02-30', 'tomorrow', '', null, 20261031]) {
        const response = await save(cookie, 'offwork', rules, date);
        expect(response.status).toBe(400);
        expect(await response.json()).toMatchObject({ error: { code: 'INVALID_EFFECTIVE_DATE' } });
      }
      await seedRound({ game: 'offwork' });
      await db.prepare('UPDATE game_rounds SET settings_json = ?').bind(JSON.stringify(rules)).run();
      await db.prepare("CREATE TRIGGER reject_admin_audit BEFORE INSERT ON admin_changes BEGIN SELECT RAISE(ABORT, 'test audit failure'); END;").run();
      expect((await save(cookie, 'offwork', customRules('offwork', { participationGold: 88 }))).status).toBe(500);
      expect(await db.prepare('SELECT COUNT(*) AS n FROM game_settings').first('n')).toBe(0);
      expect(await db.prepare('SELECT COUNT(*) AS n FROM admin_changes').first('n')).toBe(0);
      expect(JSON.parse((await db.prepare('SELECT settings_json FROM game_rounds').first<string>('settings_json'))!)).toEqual(rules);
    });

    it('rejects today when the SQL clock crosses KST midnight after the request begins', async () => {
      const instance = runtime(await workerAt('2026-10-30T14:59:59Z', '2026-10-30T15:00:00Z'));
      try {
        const database = await instance.getD1Database('DB'); await provision(database, migration, passwordHash);
        const { cookie } = await login('admin', instance);
        expect((await save(cookie, 'offwork', customRules('offwork'), TODAY, instance)).status).toBe(409);
        expect(await database.prepare('SELECT COUNT(*) AS n FROM game_settings').first('n')).toBe(0);
        expect(await database.prepare('SELECT COUNT(*) AS n FROM admin_changes').first('n')).toBe(0);
      } finally { await instance.dispose(); }
    });

    it.each([false, true])('returns the newest twenty audits in append order with identical timestamps=%s', async sameTime => {
      const { cookie } = await login('admin');
      await db.prepare("UPDATE users SET display_name = '운영민' WHERE id = 'admin'").run();
      await db.batch(Array.from({ length: 25 }, (_, index) => db.prepare(`INSERT INTO admin_changes
        (id, admin_id, target, before_json, after_json, effective_from, created_at) VALUES (?, 'admin', 'claw', '{}', '{}', ?, ?)`)
        .bind(`audit-${(24 - index).toString().padStart(2, '0')}`, TODAY, new Date(Date.parse(`${TODAY}T00:00:00Z`) - (sameTime ? 0 : (25 - index) * 1000)).toISOString())));
      const changes = (await readAdmin(cookie)).changes;
      expect(changes).toHaveLength(20);
      expect(changes.map(change => change.id)).toEqual(Array.from({ length: 20 }, (_, index) => `audit-${index.toString().padStart(2, '0')}`));
      expect(changes.every(change => change.adminName === '운영민')).toBe(true);
    });

    it('measures authenticated admin API reads and bounds configuration lookup despite old history', async () => {
      const instance = runtime(workerWithD1Metrics(script));
      try {
        const database = await instance.getD1Database('DB'); await provision(database, migration, passwordHash);
        const { cookie } = await login('admin', instance);
        const measurements: Record<string, number> = {};
        const measured = async (name: string, path: string, method = 'GET', body?: unknown) => {
          const response = await request(path, { method, body, cookie, instance });
          expect(response.status).toBe(200);
          const count = response.headers.get('X-Test-D1-Rows-Read'); expect(count).not.toBeNull();
          measurements[name] = Number(count); return response;
        };
        await measured('GET admin empty', '/api/admin');
        await measured('PUT game today', '/api/admin/games/offwork', 'PUT', { rules: customRules('offwork', { participationGold: 200 }), effectiveFrom: TODAY });
        await measured('PUT claw', '/api/admin/claw', 'PUT', { payoutEvery: 12, weakPickup: .5, weakCarry: .25 });
        await measured('GET admin current', '/api/admin');
        await database.batch(Array.from({ length: 200 }, (_, index) => {
          const date = new Date(Date.UTC(2020, 0, index + 1)).toISOString().slice(0, 10);
          return database.prepare(`INSERT INTO game_settings (game_id, effective_from, settings_json, created_at, created_by)
            VALUES ('offwork', ?, ?, ?, 'admin')`).bind(date, JSON.stringify(customRules('offwork')), `${date}T00:00:00.000Z`);
        }));
        await measured('GET admin after 200 old settings', '/api/admin');
        expect(measurements['GET admin after 200 old settings']).toBe(measurements['GET admin current']);
        const observed = measuredDatabase(database, Date.parse(`${TODAY}T00:00:00Z`));
        expect((await readEffectiveRules(observed.binding, 'offwork', TODAY)).participationGold).toBe(200);
        expect(observed.rowsRead()).toBe(1);
        for (const [count, prefix, date] of [[18, 'recent', '2026-10-29'], [200, 'old', '2020-01-01']] as const) {
          await database.batch(Array.from({ length: count }, (_, index) => database.prepare(`INSERT INTO admin_changes
            (id, admin_id, target, before_json, after_json, effective_from, created_at)
            VALUES (?, 'admin', 'claw', '{}', '{}', ?, ?)`)
            .bind(`metrics-${prefix}-${index}`, date, `${date}T00:00:00.000Z`)));
          await measured(prefix === 'recent' ? 'GET admin with 20 audits' : 'GET admin after 200 old audits', '/api/admin');
        }
        expect(measurements['GET admin after 200 old audits']).toBe(measurements['GET admin with 20 audits']);
        console.log(`Admin effective rules indexed lookup D1 rows_read: ${observed.rowsRead()} with 200 historical settings`);
        console.log(`Admin full authenticated API D1 rows_read: ${JSON.stringify(measurements)} (empty game/ledger history, audit count noted by operation)`);
      } finally { await instance.dispose(); }
    });
  });

  describe('admin console claw operations', () => {
    const clawConfig = { payoutEvery: 10, weakPickup: .45, weakCarry: .3 };
    const configure = (cookie: string, config: unknown = clawConfig) => request('/api/admin/claw', { method: 'PUT', cookie, body: config });

    it('plays more than a player wallet for free while preserving cooldown and leaving no rewards or notices', async () => {
      const { cookie } = await login('admin');
      let state = await getClaw(cookie);
      const beforeBoard = state.board;
      expect((await getClaw(cookie)).board).toEqual(beforeBoard);
      for (let index = 0; index < 7; index++) {
        const previous = state;
        state = await clawPlay(cookie, state.version);
        expect(state).toMatchObject({ isAdmin: true, coins: 0, freeCoins: 0, purchasedCoins: 0, version: previous.version + 1 });
        expect(state.result).toMatchObject({ points: 0, gold: 0, clearBonus: 0, clearGold: 0 });
        expect((await request('/api/claw/play', { method: 'POST', cookie, body: { requestId: crypto.randomUUID(), version: state.version, x: .05 } })).status).toBe(409);
        await db.prepare("UPDATE claw_accounts SET next_play_at = 0 WHERE user_id = 'admin'").run();
      }
      expect(await db.prepare("SELECT COUNT(*) AS n FROM claw_plays WHERE user_id = 'admin'").first('n')).toBe(7);
      expect(await db.prepare("SELECT SUM(score + gold + clear_bonus) AS n FROM claw_plays WHERE user_id = 'admin'").first('n')).toBe(0);
      expect(await ledgerRows()).toEqual([]);
      expect(await db.prepare('SELECT COUNT(*) AS n FROM announcements').first('n')).toBe(0);
      const view = await bootstrap(cookie);
      expect(view.user).toMatchObject({ gold: 0, weeklyScore: 0 });
      expect(view.players.some(player => player.id === 'admin')).toBe(false);
      expect(view.ledger).toEqual([]);
      expect(await db.prepare("SELECT COUNT(*) AS n FROM claw_coin_purchases WHERE user_id = 'admin'").first('n')).toBe(0);
    });

    it('clears the admin machine and generates a new board with zero stored or displayed rewards', async () => {
      const { cookie } = await login('admin'); const state = await getClaw(cookie);
      await seedClawBoard(db, [{ id: '1-1', type: 1, x: .5, y: .8, radius: 32, angle: 0 }], 0, 'admin');
      const played = await clawPlay(cookie, state.version, { x: .5, forceStrong: true });
      expect(played.result).toMatchObject({ caught: true, points: 0, gold: 0, clearBonus: 0, clearGold: 0, grip: { strong: true, pickup: 1, carry: 1 } });
      expect(played.result!.prizes).toHaveLength(1);
      expect(played.generation).toBe(2); expect(played.board).toHaveLength(30);
      expect(played.board.every(doll => doll.id.startsWith('2-'))).toBe(true);
      expect(await db.prepare("SELECT score, gold, clear_bonus FROM claw_plays WHERE user_id = 'admin'").first()).toEqual({ score: 0, gold: 0, clear_bonus: 0 });
      expect(await ledgerRows()).toEqual([]);
      expect(await db.prepare('SELECT COUNT(*) AS n FROM announcements').first('n')).toBe(0);
    });

    it('rejects forceStrong from players, validates admin booleans and binds it to the saved receipt', async () => {
      const min = await login('min'); const admin = await login('admin');
      const player = await getClaw(min.cookie); const state = await getClaw(admin.cookie);
      for (const forceStrong of [true, false]) expect((await request('/api/claw/play', { method: 'POST', cookie: min.cookie,
        body: { requestId: crypto.randomUUID(), version: player.version, x: .05, forceStrong } })).status).toBe(403);
      expect((await getClaw(min.cookie)).freeCoins).toBe(5);
      for (const forceStrong of ['true', 1, null]) expect((await request('/api/claw/play', { method: 'POST', cookie: admin.cookie,
        body: { requestId: crypto.randomUUID(), version: state.version, x: .05, forceStrong } })).status).toBe(400);
      const input = { requestId: crypto.randomUUID(), version: state.version, x: .05, forceStrong: true };
      const responses = await Promise.all([request('/api/claw/play', { method: 'POST', cookie: admin.cookie, body: input }), request('/api/claw/play', { method: 'POST', cookie: admin.cookie, body: input })]);
      expect(responses.map(response => response.status)).toEqual([200, 200]);
      const results = await Promise.all(responses.map(response => response.json() as Promise<ClawResponse>));
      expect(results[0]!.result).toEqual(results[1]!.result);
      expect((await request('/api/claw/play', { method: 'POST', cookie: admin.cookie, body: { ...input, forceStrong: false } })).status).toBe(409);
      expect(await db.prepare('SELECT COUNT(*) AS n FROM claw_plays').first('n')).toBe(1);
      expect(await ledgerRows()).toEqual([]);
    });

    it('validates claw setting boundaries and audits each accepted configuration', async () => {
      const { cookie } = await login('admin');
      for (const invalid of [null, {}, ...[0, 51, 1.5, '10'].map(payoutEvery => ({ ...clawConfig, payoutEvery })),
        ...[.049, 1.01, '0.5', null].map(weakPickup => ({ ...clawConfig, weakPickup })),
        ...[.049, 1.01, '0.5', null].map(weakCarry => ({ ...clawConfig, weakCarry }))]) {
        expect((await configure(cookie, invalid)).status).toBe(400);
      }
      expect(await db.prepare('SELECT COUNT(*) AS n FROM admin_changes').first('n')).toBe(0);
      for (const config of [{ payoutEvery: 1, weakPickup: .05, weakCarry: 1 }, { payoutEvery: 50, weakPickup: 1, weakCarry: .05 }]) {
        const response = await configure(cookie, config); expect(response.status).toBe(200);
        expect((await response.json() as AdminState).claw).toEqual(config);
      }
      const audits = (await db.prepare("SELECT before_json, after_json FROM admin_changes WHERE target = 'claw' ORDER BY created_at, id").all<{ before_json: string; after_json: string }>()).results;
      expect(audits).toHaveLength(2);
      expect(audits.some(audit => JSON.parse(audit.before_json).payoutEvery === 10)).toBe(true);
      expect(audits.some(audit => JSON.parse(audit.after_json).payoutEvery === 50)).toBe(true);
    });

    it('rolls back a claw config update if its audit write fails', async () => {
      const { cookie } = await login('admin');
      const before = await db.prepare('SELECT * FROM claw_config').first();
      await db.prepare("CREATE TRIGGER reject_claw_config_audit BEFORE INSERT ON admin_changes BEGIN SELECT RAISE(ABORT, 'test claw audit failure'); END;").run();
      expect((await configure(cookie, { payoutEvery: 1, weakPickup: .9, weakCarry: .8 })).status).toBe(500);
      expect(await db.prepare('SELECT * FROM claw_config').first()).toEqual(before);
      expect(await db.prepare('SELECT COUNT(*) AS n FROM admin_changes').first('n')).toBe(0);
    });

    it('uses config changes for the next play, preserves a saved result and never exposes private config to players', async () => {
      const admin = await login('admin'); const min = await login('min');
      const state = await getClaw(min.cookie);
      const input = { requestId: crypto.randomUUID(), version: state.version, x: .05, stop: null };
      const first = await clawPlay(min.cookie, state.version, input);
      expect(first.result!.grip.strong).toBe(false);
      expect((await configure(admin.cookie, { payoutEvery: 1, weakPickup: .05, weakCarry: .05 })).status).toBe(200);
      expect((await clawPlay(min.cookie, state.version, input)).result).toEqual(first.result);
      await db.prepare("UPDATE claw_accounts SET next_play_at = 0 WHERE user_id = 'min'").run();
      const next = await clawPlay(min.cookie, first.version);
      expect(next.result!.grip).toEqual({ strong: true, pickup: 1, carry: 1 });
      const summary = (await bootstrap(min.cookie)).claw;
      for (const payload of [next, await getClaw(min.cookie), summary]) expect(JSON.stringify(payload)).not.toMatch(/payout.?every|weak.?pickup|weak.?carry|power.?counter|forceStrong/i);
    });
  });

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

    it('requires login and lets admins keep a private machine while rejecting coin purchases', async () => {
      for (const path of ['/api/claw', '/api/claw/coins', '/api/claw/play']) {
        expect((await request(path, path === '/api/claw' ? {} : { method: 'POST', body: {} })).status).toBe(401);
      }
      const { cookie } = await login('admin');
      const demo = await getClaw(cookie);
      expect(demo).toMatchObject({ isAdmin: true, coins: 0, freeCoins: 0, purchasedCoins: 0 });
      expect(demo.board).toHaveLength(30);
      expect((await getClaw(cookie)).board).toEqual(demo.board);
      expect((await request('/api/claw/coins', { method: 'POST', cookie, body: { requestId: crypto.randomUUID(), quantity: 1 } })).status).toBe(403);
      expect(await db.prepare('SELECT COUNT(*) AS count FROM claw_accounts WHERE user_id = ?').bind('admin').first('count')).toBe(1);
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

    // 23:49:59 KST is the last playable second of Sunday (games close at 23:50).
    it.each([{ instant: '2026-11-01T14:49:59Z', week: '2026-10-26' }, { instant: '2026-11-01T15:00:00Z', week: '2026-11-02' }])(
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
      const observed = measuredDatabase(db, Date.parse(`${TODAY}T00:00:00Z`));
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
      const observed = measuredDatabase(db, now);
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
      const observed = measuredDatabase(db, now);
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

  describe('catchmind rotation, consumed words and version protocol', () => {
    it.each(['correct', 'misses', 'manual'] as const)('cycles min, siwon, yeseo and wraps after a %s ending', async ending => {
      const cookies = Object.fromEntries(await Promise.all(['min', 'siwon', 'yeseo'].map(async username => [username, (await login(username)).cookie])));
      const order = ['min', 'siwon', 'yeseo'];
      let round = (await catchmindAction('claim', cookies.min!, null)).catchmind.round!;
      for (let index = 0; index < order.length; index++) {
        const drawer = order[index]!; const next = order[(index + 1) % order.length]!;
        const other = order[(index + 2) % order.length]!;
        expect(round.drawer.username).toBe(drawer);
        await catchmindAction('publish', cookies[drawer]!, round.id, { wordVersion: round.wordVersion, image: DRAWING_PNG });
        let ended: CatchmindResponse;
        if (ending === 'correct') ended = await catchmindAction('guess', cookies[other]!, round.id, { answer: round.word });
        else if (ending === 'manual') ended = await catchmindAction('end', cookies[drawer]!, round.id);
        else {
          for (let wrong = 1; wrong <= CATCHMIND_RULES.endAfter; wrong++) {
            ended = await catchmindAction('guess', cookies[other]!, round.id, { answer: `오답 ${wrong}` });
          }
        }
        expect(ended!.catchmind).toMatchObject({ round: { status: 'ended', endReason: ending }, turn: { username: next } });
        if (ending === 'correct') expect(ended!.catchmind.round!.winner!.username).toBe(other);
        round = (await catchmindAction('next', cookies[next]!, round.id)).catchmind.round!;
      }
      expect(round).toMatchObject({ number: 4, drawer: { username: 'min' }, status: 'draft' });
      if (ending !== 'correct') expect(await ledgerRows()).toEqual([]);
    });

    it('skips only after ten minutes and serializes concurrent stale turn skips and retries', async () => {
      const min = await login('min'); const siwon = await login('siwon'); const yeseo = await login('yeseo');
      const round = await openCatchmind(min.cookie);
      const ended = await catchmindAction('end', min.cookie, round.id);
      expect(ended.catchmind).toMatchObject({ turn: { id: 'siwon' }, canSkip: false });
      const body = { requestId: 'skip-saved', roundId: round.id, expectedTurnId: 'siwon' };
      const before = new Date(Date.parse(`${TODAY}T00:00:00Z`) - CATCHMIND_RULES.skipAfterMs + 1).toISOString();
      await db.prepare('UPDATE catchmind_rounds SET ended_at = ? WHERE id = ?').bind(before, round.id).run();
      expect((await request('/api/catchmind/skip', { method: 'POST', cookie: min.cookie, body })).status).toBe(409);
      const boundary = new Date(Date.parse(`${TODAY}T00:00:00Z`) - CATCHMIND_RULES.skipAfterMs).toISOString();
      await db.prepare('UPDATE catchmind_rounds SET ended_at = ? WHERE id = ?').bind(boundary, round.id).run();
      expect((await getCatchmind(min.cookie)).catchmind.canSkip).toBe(true);
      expect((await getCatchmind(siwon.cookie)).catchmind.canSkip).toBe(false);
      const responses = await Promise.all([
        request('/api/catchmind/skip', { method: 'POST', cookie: min.cookie, body }),
        request('/api/catchmind/skip', { method: 'POST', cookie: yeseo.cookie, body: { ...body, requestId: 'skip-racer' } }),
      ]);
      expect(responses.map(response => response.status).sort()).toEqual([200, 409]);
      const winner = responses[0]!.status === 200 ? min : yeseo;
      const winningBody = responses[0]!.status === 200 ? body : { ...body, requestId: 'skip-racer' };
      const state = await getCatchmind(min.cookie);
      expect(state.catchmind.turn?.id).toBe('yeseo');
      const version = state.version;
      expect((await request('/api/catchmind/skip', { method: 'POST', cookie: winner.cookie, body: winningBody })).status).toBe(200);
      expect((await getCatchmind(min.cookie)).version).toBe(version);
      expect((await getCatchmind(min.cookie)).catchmind.turn?.id).toBe('yeseo');
      expect(await ledgerRows()).toEqual([]);
    });

    it('repairs inactive ended turns and lets the successor replace an abandoned private draft', async () => {
      const min = await login('min'); const yeseo = await login('yeseo');
      const round = await openCatchmind(min.cookie);
      const ended = await catchmindAction('end', min.cookie, round.id);
      await db.prepare("UPDATE users SET active = 0 WHERE id = 'siwon'").run();
      const response = await request(`/api/catchmind?since=${ended.version}`, { cookie: min.cookie });
      expect(response.status).toBe(200);
      const repaired = await response.json() as CatchmindResponse;
      expect('unchanged' in repaired).toBe(false);
      expect(repaired.catchmind.turn?.id).toBe('yeseo');
      expect(repaired.version).toBeGreaterThan(ended.version);
      const draft = (await catchmindAction('next', yeseo.cookie, round.id)).catchmind.round!;
      await db.prepare("UPDATE users SET active = 0 WHERE id = 'yeseo'").run();
      const abandoned = await getCatchmind(min.cookie);
      expect(abandoned.catchmind).toMatchObject({ turn: { id: 'min' }, round: { id: draft.id, status: 'draft', word: null }, canNext: true });
      const replacement = (await catchmindAction('next', min.cookie, draft.id)).catchmind.round!;
      expect(replacement).toMatchObject({ status: 'draft', drawer: { id: 'min' }, number: draft.number + 1 });
      expect(await db.prepare('SELECT status FROM catchmind_rounds WHERE id = ?').bind(draft.id).first('status')).toBe('draft');
      expect(await db.prepare('SELECT COUNT(*) AS n FROM catchmind_guesses').first('n')).toBe(0);
    });

    it('returns unchanged with two authenticated queries and invalidates it for profile and game changes', async () => {
      const instance = runtime(workerWithD1Metrics(script));
      try {
        const database = await instance.getD1Database('DB'); await provision(database, migration, passwordHash);
        const min = await login('min', instance); const siwon = await login('siwon', instance);
        const draft = await catchmindAction('claim', min.cookie, null, {}, instance);
        const fullResponse = await request('/api/catchmind', { cookie: siwon.cookie, instance });
        const full = await fullResponse.json() as CatchmindResponse;
        expect(Number.isSafeInteger(full.version)).toBe(true);
        const poll = await request(`/api/catchmind?since=${full.version}`, { cookie: siwon.cookie, instance });
        expect(await poll.json()).toEqual({ unchanged: true, version: full.version, viewerId: 'siwon', serverTime: `${TODAY}T00:00:00.000Z` });
        expect(Number(poll.headers.get('X-Test-D1-Queries'))).toBeLessThanOrEqual(2);
        expect(Number(poll.headers.get('X-Test-D1-Rows-Read'))).toBeLessThanOrEqual(5);
        expect(Number(poll.headers.get('X-Test-D1-Rows-Written'))).toBe(0);
        const otherViewer = await request(`/api/catchmind?since=${full.version}`, { cookie: min.cookie, instance });
        expect(await otherViewer.json()).toMatchObject({ unchanged: true, version: full.version, viewerId: 'min' });
        await database.prepare("UPDATE users SET display_name = '새로운민' WHERE id = 'min'").run();
        const renamed = await request(`/api/catchmind?since=${full.version}`, { cookie: siwon.cookie, instance });
        const renamedState = await renamed.json() as CatchmindResponse;
        expect(renamedState.version).toBeGreaterThan(full.version);
        expect(renamedState.catchmind.round!.drawer.displayName).toBe('새로운민');
        const body = { requestId: 'version-reroll', roundId: draft.catchmind.round!.id, wordVersion: draft.catchmind.round!.wordVersion };
        const mutation = await catchmindAction('reroll', min.cookie, body.roundId, body, instance);
        expect(mutation.version).toBeGreaterThan(renamedState.version);
        const retry = await catchmindAction('reroll', min.cookie, body.roundId, body, instance);
        expect(retry.version).toBe(mutation.version);
        const wrongAccount = await request('/api/catchmind/reroll', { method: 'POST', cookie: siwon.cookie, instance,
          body: { requestId: 'wrong-account', expectedUserId: 'min', roundId: mutation.catchmind.round!.id, wordVersion: mutation.catchmind.round!.wordVersion } });
        expect(wrongAccount.status).toBe(409);
        expect(Number(wrongAccount.headers.get('X-Test-D1-Rows-Written'))).toBe(0);
        expect((await getCatchmind(min.cookie, instance)).version).toBe(mutation.version);
        for (const value of ['-1', 'bad', '1.2', '9007199254740992']) {
          expect((await request(`/api/catchmind?since=${value}`, { cookie: min.cookie, instance })).status).toBe(400);
        }
        expect((await request(`/api/catchmind?since=${mutation.version}`, { instance })).status).toBe(401);
      } finally { await instance.dispose(); }
    });

    it('draws four hundred different round words and restarts the exhausted pool', async () => {
      await db.prepare("UPDATE users SET active = 0 WHERE id IN ('siwon', 'yeseo')").run();
      const now = new Date(`${TODAY}T00:00:00Z`);
      const binding = measuredDatabase(db, now.getTime()).binding;
      const actor = { id: 'min', role: 'player' as const };
      const action = (name: string, roundId: string | null, extra: Record<string, unknown> = {}) =>
        catchmindRoute(binding, actor, name, 'POST', { requestId: crypto.randomUUID(), roundId, ...extra }, now);
      const seen = new Set<string>();
      let state = await action('claim', null);
      for (let index = 0; index < CATCHMIND_WORDS.length; index++) {
        const round = state.catchmind.round!;
        expect(seen.has(round.word!), `round ${index + 1}`).toBe(false);
        seen.add(round.word!);
        expect(CATCHMIND_WORDS).toContain(round.word);
        // Ending rules are exercised above. Advance this fixture directly so
        // the stress test isolates 400 real, atomic prompt allocations rather
        // than repeating 800 unrelated full publish/end response reads.
        await db.prepare(`UPDATE catchmind_rounds SET status = 'ended', end_reason = 'manual', ended_at = ? WHERE id = ?`)
          .bind(now.toISOString(), round.id).run();
        if (index < CATCHMIND_WORDS.length - 1) state = await action('next', round.id);
      }
      expect(seen.size).toBe(400);
      expect(await db.prepare('SELECT COUNT(*) AS n FROM catchmind_used_words').first('n')).toBe(400);
      const reset = await action('next', state.catchmind.round!.id);
      expect(CATCHMIND_WORDS).toContain(reset.catchmind.round!.word);
      expect(await db.prepare('SELECT COUNT(*) AS n FROM catchmind_used_words').first('n')).toBe(1);
      expect(await db.prepare('SELECT COUNT(*) AS n FROM catchmind_rounds').first('n')).toBe(401);
      expect(await ledgerRows()).toEqual([]);
    }, 120000);

    it('resets an exhausted pool atomically when two next-round requests race', async () => {
      const min = await login('min'); const siwon = await login('siwon');
      const round = await openCatchmind(min.cookie);
      await db.batch(CATCHMIND_WORDS.map(word => db.prepare('INSERT OR IGNORE INTO catchmind_used_words (word, round_id, used_at) VALUES (?, ?, ?)')
        .bind(word, round.id, `${TODAY}T00:00:00.000Z`)));
      await catchmindAction('end', min.cookie, round.id);
      const responses = await Promise.all([1, 2].map(index => request('/api/catchmind/next', { method: 'POST', cookie: siwon.cookie,
        body: { requestId: `exhausted-race-${index}`, roundId: round.id } })));
      expect(responses.map(response => response.status).sort()).toEqual([200, 409]);
      const next = await getCatchmind(siwon.cookie);
      expect(next.catchmind.round).toMatchObject({ number: 2, status: 'draft', drawer: { id: 'siwon' } });
      expect((await db.prepare('SELECT word, round_id FROM catchmind_used_words').all()).results)
        .toEqual([{ word: next.catchmind.round!.word, round_id: next.catchmind.round!.id }]);
      expect(await db.prepare('SELECT COUNT(*) AS n FROM catchmind_rounds').first('n')).toBe(2);
    });

    it('consumes every rerolled prompt and rolls word and version changes back when a later write fails', async () => {
      const min = await login('min');
      let state = await catchmindAction('claim', min.cookie, null);
      const shown = new Set([state.catchmind.round!.word!]);
      for (let index = 0; index < CATCHMIND_RULES.rerolls; index++) {
        state = await catchmindAction('reroll', min.cookie, state.catchmind.round!.id, { wordVersion: state.catchmind.round!.wordVersion });
        expect(shown.has(state.catchmind.round!.word!)).toBe(false); shown.add(state.catchmind.round!.word!);
      }
      const used = (await db.prepare('SELECT word FROM catchmind_used_words').all<{ word: string }>()).results.map(row => row.word);
      expect(new Set(used)).toEqual(shown);
      await catchmindAction('publish', min.cookie, state.catchmind.round!.id, { wordVersion: state.catchmind.round!.wordVersion, image: DRAWING_PNG });
      await catchmindAction('end', min.cookie, state.catchmind.round!.id);
      const siwon = await login('siwon');
      const draft = await catchmindAction('next', siwon.cookie, state.catchmind.round!.id);
      expect(shown.has(draft.catchmind.round!.word!)).toBe(false);
      const wordsBefore = (await db.prepare('SELECT * FROM catchmind_used_words ORDER BY word').all()).results;
      await db.prepare(`CREATE TRIGGER fail_word_change BEFORE UPDATE OF word ON catchmind_rounds
        BEGIN SELECT RAISE(ABORT, 'test word rollback'); END;`).run();
      expect((await request('/api/catchmind/reroll', { method: 'POST', cookie: siwon.cookie,
        body: { requestId: 'failed-reroll', roundId: draft.catchmind.round!.id, wordVersion: draft.catchmind.round!.wordVersion } })).status).toBe(500);
      expect((await db.prepare('SELECT * FROM catchmind_used_words ORDER BY word').all()).results).toEqual(wordsBefore);
      const after = await getCatchmind(siwon.cookie);
      expect(after.version).toBe(draft.version);
      expect(after.catchmind.round!.word).toBe(draft.catchmind.round!.word);
      expect(await db.prepare("SELECT COUNT(*) AS n FROM catchmind_requests WHERE request_id = 'failed-reroll'").first('n')).toBe(0);
    });

    it('backfills all previously shown prompts, repairs legacy winner turns and preserves running rounds during migration', async () => {
      const instance = runtime(script);
      try {
        const database = await instance.getD1Database('DB');
        const oldMigration = (await Promise.all((await readdir(new URL('../migrations/', import.meta.url)))
          .filter(name => name.endsWith('.sql') && name < '0012').sort()
          .map(name => readFile(new URL(`../migrations/${name}`, import.meta.url), 'utf8')))).join('\n');
        await provision(database, oldMigration, passwordHash);
        const oldWord = CATCHMIND_WORDS[0]!, rerolledWord = CATCHMIND_WORDS[1]!;
        await database.prepare(`INSERT INTO catchmind_rounds
          (id, number, drawer_id, word, normalized_word, word_history, status, wrong_count, winner_id, end_reason, ended_at, created_at)
          VALUES ('legacy-ended', 1, 'min', ?, ?, ?, 'ended', 2, 'yeseo', 'correct', ?, ?)`)
          .bind(rerolledWord, rerolledWord, JSON.stringify([oldWord, rerolledWord]), `${TODAY}T00:00:00.000Z`, `${TODAY}T00:00:00.000Z`).run();
        await database.prepare("UPDATE catchmind_turn SET round_id = 'legacy-ended', drawer_id = 'yeseo' WHERE id = 1").run();
        const migrationSql = await readFile(new URL('../migrations/0012_catchmind_used_words.sql', import.meta.url), 'utf8');
        await applyMigration(database, migrationSql);
        expect((await database.prepare('SELECT word FROM catchmind_used_words ORDER BY word').all()).results.map(row => row.word))
          .toEqual([oldWord, rerolledWord].sort());
        expect(await database.prepare('SELECT drawer_id FROM catchmind_turn WHERE id = 1').first('drawer_id')).toBe('siwon');
        expect(await database.prepare('SELECT winner_id FROM catchmind_rounds WHERE id = ?').bind('legacy-ended').first('winner_id')).toBe('yeseo');
        const versionBefore = await database.prepare('SELECT version FROM catchmind_turn WHERE id = 1').first<number>('version');
        // The deployed old Worker inserts the receipt before a final guess,
        // then overwrites the next turn with its winner after ending the round.
        await database.batch([
          database.prepare(`INSERT INTO catchmind_requests
            (id, user_id, request_id, action, round_id, result_round_id, payload_hash, created_at)
            VALUES ('legacy-receipt', 'yeseo', 'legacy-receipt', 'guess', 'legacy-ended', 'legacy-ended', 'old-worker', ?)`)
            .bind(`${TODAY}T00:00:00.000Z`),
          database.prepare("UPDATE catchmind_turn SET drawer_id = 'yeseo' WHERE id = 1"),
        ]);
        expect(await database.prepare('SELECT drawer_id FROM catchmind_turn WHERE id = 1').first('drawer_id')).toBe('siwon');
        expect(await database.prepare('SELECT version FROM catchmind_turn WHERE id = 1').first<number>('version')).toBeGreaterThan(versionBefore!);
        const introduced = CATCHMIND_WORDS[2]!, changed = CATCHMIND_WORDS[3]!;
        await database.prepare(`INSERT INTO catchmind_rounds
          (id, number, drawer_id, word, normalized_word, word_history, status, created_at)
          VALUES ('legacy-post-migration', 2, 'siwon', ?, ?, ?, 'draft', ?)`)
          .bind(introduced, introduced, JSON.stringify([introduced]), `${TODAY}T00:00:00.000Z`).run();
        await database.prepare('UPDATE catchmind_rounds SET word = ?, normalized_word = ?, word_history = ? WHERE id = ?')
          .bind(changed, changed, JSON.stringify([introduced, changed]), 'legacy-post-migration').run();
        expect((await database.prepare('SELECT word FROM catchmind_used_words ORDER BY word').all()).results.map(row => row.word))
          .toEqual([oldWord, rerolledWord, introduced, changed].sort());
      } finally { await instance.dispose(); }
      for (const [status, wrongCount] of [['draft', 0], ['open', 3], ['open', 4], ['open', 5]] as const) {
        const isolated = runtime(script);
        try {
          const database = await isolated.getD1Database('DB');
          const oldMigration = (await Promise.all((await readdir(new URL('../migrations/', import.meta.url)))
            .filter(name => name.endsWith('.sql') && name < '0012').sort()
            .map(name => readFile(new URL(`../migrations/${name}`, import.meta.url), 'utf8')))).join('\n');
          await provision(database, oldMigration, passwordHash);
          const word = CATCHMIND_WORDS[3]!;
          await database.prepare(`INSERT INTO catchmind_rounds
            (id, number, drawer_id, word, normalized_word, word_history, status, wrong_count, image, created_at)
            VALUES ('legacy-running', 1, 'min', ?, ?, ?, ?, ?, ?, ?)`)
            .bind(word, word, JSON.stringify([word]), status, wrongCount, status === 'open' ? DRAWING_PNG : null, `${TODAY}T00:00:00.000Z`).run();
          await database.prepare("UPDATE catchmind_turn SET round_id = 'legacy-running', drawer_id = 'min' WHERE id = 1").run();
          await applyMigration(database, await readFile(new URL('../migrations/0012_catchmind_used_words.sql', import.meta.url), 'utf8'));
          expect(await database.prepare('SELECT status, wrong_count, image, drawer_id FROM catchmind_rounds WHERE id = ?').bind('legacy-running').first())
            .toEqual({ status, wrong_count: wrongCount, image: status === 'open' ? DRAWING_PNG : null, drawer_id: 'min' });
          await applyMigrationsAfter(database, '0012_catchmind_used_words.sql');
          const { cookie } = await login('siwon', isolated);
          const view = await getCatchmind(cookie, isolated);
          expect(view.catchmind.round!.hint !== null).toBe(wrongCount >= CATCHMIND_RULES.hintAfter);
          expect(view.catchmind.round!.word).toBeNull();
        } finally { await isolated.dispose(); }
      }
    }, 30000);

    it('exposes remaining-word counts only in the administrator state including the low-pool threshold', async () => {
      const admin = await login('admin'); const min = await login('min');
      const entries = CATCHMIND_WORDS.slice(0, CATCHMIND_WORDS.length - 30);
      await db.batch(entries.map((word, index) => db.prepare('INSERT INTO catchmind_used_words (word, round_id, used_at) VALUES (?, ?, ?)')
        .bind(word, `old-${index}`, `${TODAY}T00:00:00.000Z`)));
      const response = await request('/api/admin', { cookie: admin.cookie }); expect(response.status).toBe(200);
      expect((await response.json() as AdminState).catchmindWordsRemaining).toBe(30);
      expect((await request('/api/admin', { cookie: min.cookie })).status).toBe(403);
      expect(JSON.stringify(await getCatchmind(min.cookie))).not.toContain('catchmindWordsRemaining');
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
      expect(await db.prepare('SELECT COUNT(*) AS n FROM catchmind_used_words').first('n')).toBe(1);
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
      expect(await db.prepare('SELECT COUNT(*) AS n FROM catchmind_used_words').first('n')).toBe(2);
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

    it('shares all wrong guesses, opens the hint at five, and ends at ten without paying while advancing the turn', async () => {
      const min = await login('min');
      const siwon = await login('siwon');
      const yeseo = await login('yeseo');
      const round = await openCatchmind(min.cookie);
      const normalized = Array.from(round.word!.replace(/\s/g, ''));
      for (let index = 1; index <= CATCHMIND_RULES.endAfter; index++) {
        const cookie = index % 2 ? siwon.cookie : yeseo.cookie;
        const state = (await catchmindAction('guess', cookie, round.id, { answer: `오답${index}-${round.word}` })).catchmind;
        expect(state.round!.wrongCount).toBe(index);
        expect(state.round!.guesses).toHaveLength(index);
        expect(state.round!.hint).toEqual(index < CATCHMIND_RULES.hintAfter ? null : { firstCharacter: normalized[0], length: normalized.length });
        expect(state.round!.status).toBe(index < CATCHMIND_RULES.endAfter ? 'open' : 'ended');
        if (index === CATCHMIND_RULES.endAfter) expect(state).toMatchObject({ round: { endReason: 'misses', word: round.word, winner: null }, turn: { id: 'siwon' } });
      }
      expect(await ledgerRows()).toEqual([]);
      expect((await request('/api/catchmind/next', { method: 'POST', cookie: min.cookie,
        body: { requestId: crypto.randomUUID(), roundId: round.id } })).status).toBe(403);
      const next = (await catchmindAction('next', siwon.cookie, round.id)).catchmind.round!;
      expect(next).toMatchObject({ number: round.number + 1, status: 'draft', drawer: { id: 'siwon' }, wrongCount: 0 });
      expect(next.id).not.toBe(round.id);
    });

    it('allows only one of two concurrent final wrong guesses to close the round', async () => {
      const min = await login('min');
      const siwon = await login('siwon');
      const yeseo = await login('yeseo');
      const round = await openCatchmind(min.cookie);
      for (let index = 0; index < CATCHMIND_RULES.endAfter - 1; index++) await catchmindAction('guess', siwon.cookie, round.id, { answer: `오답${index}-${round.word}` });
      const responses = await Promise.all([siwon.cookie, yeseo.cookie].map(cookie => request('/api/catchmind/guess', { method: 'POST', cookie,
        body: { requestId: crypto.randomUUID(), roundId: round.id, answer: `마지막오답-${round.word}` } })));
      expect(responses.map(response => response.status).sort()).toEqual([200, 409]);
      const ended = (await getCatchmind(min.cookie)).catchmind.round!;
      expect(ended).toMatchObject({ status: 'ended', endReason: 'misses', wrongCount: CATCHMIND_RULES.endAfter });
      expect(ended.guesses).toHaveLength(CATCHMIND_RULES.endAfter);
      expect(await ledgerRows()).toEqual([]);
    });

    it.each([0, CATCHMIND_RULES.hintAfter])('ignores whitespace in a correct answer and pays 3 points plus 5G after %i wrong guesses', async wrongBefore => {
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

    it('pays only the first concurrent correct guess and advances from the drawer', async () => {
      const min = await login('min');
      const siwon = await login('siwon');
      const yeseo = await login('yeseo');
      const round = await openCatchmind(min.cookie);
      const responses = await Promise.all([siwon.cookie, yeseo.cookie].map(cookie => request('/api/catchmind/guess', { method: 'POST', cookie,
        body: { requestId: crypto.randomUUID(), roundId: round.id, answer: round.word } })));
      expect(responses.map(response => response.status).sort()).toEqual([200, 409]);
      const state = (await getCatchmind(min.cookie)).catchmind;
      expect(state.round!.guesses.filter(guess => guess.correct)).toHaveLength(1);
      expect(state.turn?.id).toBe('siwon');
      const payouts = await ledgerRows();
      expect(payouts.map(row => [row.currency, row.amount]).sort()).toEqual([['gold', 5], ['score', 3]]);
      expect(new Set(payouts.map(row => row.user_id))).toEqual(new Set([state.round!.winner!.id]));
    });

    it('lets the drawer end without a reward and the next player start only one new round', async () => {
      const min = await login('min');
      const siwon = await login('siwon');
      const round = await openCatchmind(min.cookie);
      expect((await request('/api/catchmind/end', { method: 'POST', cookie: siwon.cookie,
        body: { requestId: crypto.randomUUID(), roundId: round.id } })).status).toBe(403);
      const ended = await catchmindAction('end', min.cookie, round.id);
      expect(ended.catchmind).toMatchObject({ round: { status: 'ended', endReason: 'manual', winner: null }, turn: { id: 'siwon' }, canNext: false });
      expect(await ledgerRows()).toEqual([]);
      const responses = await Promise.all([1, 2].map(() => request('/api/catchmind/next', { method: 'POST', cookie: siwon.cookie,
        body: { requestId: crypto.randomUUID(), roundId: round.id } })));
      expect(responses.map(response => response.status).sort()).toEqual([200, 409]);
      const next = (await getCatchmind(min.cookie)).catchmind.round!;
      expect(next).toMatchObject({ number: round.number + 1, status: 'draft', drawer: { id: 'siwon' } });
    });

    it('rejects stale round mutations after the next drawing turn begins', async () => {
      const min = await login('min');
      const siwon = await login('siwon');
      const previous = await openCatchmind(min.cookie);
      await catchmindAction('end', min.cookie, previous.id);
      const next = (await catchmindAction('next', siwon.cookie, previous.id)).catchmind.round!;
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

    it('pays a Sunday-published round solved after Monday midnight gold only, never score', async () => {
      const persistence = await mkdtemp(join(tmpdir(), 'yegoom-catchmind-week-'));
      // Published at 23:49:59 KST Sunday, the last second before the daily close.
      let instance = runtime(await workerAt('2026-11-01T14:49:59Z'), persistence);
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
        const solved = await catchmindAction('guess', siwon.cookie, round.id, { answer: round.word }, instance);
        expect(solved.catchmind.round).toMatchObject({ status: 'ended', winnerScored: false });
        const persisted = await instance.getD1Database('DB');
        expect((await ledgerRows(persisted)).filter(row => row.reference.startsWith('catchmind:'))).toMatchObject([{ user_id: 'siwon', currency: 'gold', amount: 5 }]);
        const response = await request('/api/bootstrap', { cookie: siwon.cookie, instance });
        expect(response.status).toBe(200);
        const view = await response.json() as BootstrapResponse;
        expect(view.user).toMatchObject({ gold: 5, weeklyScore: 0 });
        expect(view.dailyScores).toEqual([0, 0, 0, 0, 0, 0, 0]);
      } finally { await instance.dispose(); await rm(persistence, { recursive: true, force: true }); }
    });

    it('gives a round solved on a later day gold but no score in the weekly chart', async () => {
      const min = await login('min');
      const siwon = await login('siwon');
      const round = await openCatchmind(min.cookie);
      // Represent a published Thursday round still open on Friday morning.
      await db.prepare('UPDATE catchmind_rounds SET round_date = ?, published_at = ? WHERE id = ?')
        .bind('2026-10-29', '2026-10-29T00:00:00.000Z', round.id).run();
      const solved = await catchmindAction('guess', siwon.cookie, round.id, { answer: round.word });
      expect(solved.catchmind.round).toMatchObject({ status: 'ended', winnerScored: false });
      const view = await bootstrap(siwon.cookie);
      expect(view.user).toMatchObject({ gold: 5, weeklyScore: 0 });
      expect(view.dailyScores).toEqual([0, 0, 0, 0, 0, 0, 0]);
      expect(view.ledger.filter(row => row.reason === '캐치마인드 정답').map(row => row.currency)).toEqual(['gold']);
      expect(view.catchmind.winnerScored).toBe(false);
    });

    it('does not publish with yesterday game date when the SQL write crosses KST midnight', async () => {
      const instance = runtime(await workerAt('2026-11-01T14:49:59Z', '2026-11-01T15:00:00Z'));
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
      for (const action of ['claim', 'reroll', 'publish', 'guess', 'end', 'next', 'skip']) {
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

  async function seedGallery(database: Database, count: number, start = 1) {
    await database.prepare(`WITH RECURSIVE numbers(n) AS (VALUES(CAST(? AS INTEGER)) UNION ALL SELECT n + 1 FROM numbers WHERE n < ?)
      INSERT INTO catchmind_rounds (id, number, drawer_id, word, normalized_word, word_history, status, image, winner_id, end_reason, ended_at, created_at)
      SELECT 'gallery-' || n, n, 'min', '그림 ' || n, '그림' || n, '[]', 'ended', ?,
        CASE WHEN n % 3 = 0 THEN 'siwon' ELSE NULL END,
        CASE WHEN n % 3 = 0 THEN 'correct' WHEN n % 3 = 1 THEN 'misses' ELSE 'manual' END, ?, ? FROM numbers`)
      .bind(start, start + count - 1, DRAWING_PNG, `${TODAY}T00:00:00Z`, `${TODAY}T00:00:00Z`).run();
  }

  describe('catchmind finished-round gallery', () => {
    it('requires login, rejects invalid pages and returns an empty gallery without creating a round', async () => {
      expect((await request('/api/catchmind/gallery')).status).toBe(401);
      const { cookie } = await login('min');
      expect(await (await request('/api/catchmind/gallery', { cookie })).json()).toEqual({ rounds: [], nextBefore: null });
      for (const query of ['before=0', 'before=-1', 'before=1.5', 'before=9007199254740992', 'before=no', 'before=', 'limit=0', 'limit=10', 'limit=-1', 'limit=1.5']) {
        expect((await request(`/api/catchmind/gallery?${query}`, { cookie })).status, query).toBe(400);
      }
      expect((await request('/api/catchmind/gallery', { method: 'POST', cookie, body: {} })).status).toBe(405);
      expect(await db.prepare('SELECT COUNT(*) AS count FROM catchmind_rounds').first('count')).toBe(0);
    });

    it('returns only ended metadata in descending pages of nine, with stable cursors and current profiles', async () => {
      const { cookie } = await login('min');
      await seedGallery(db, 21);
      await db.prepare("UPDATE users SET display_name = '그리는 민', character = 'moon' WHERE id = 'min'").run();
      await db.prepare("UPDATE users SET display_name = '맞힌 시원' WHERE id = 'siwon'").run();
      expect((await request('/api/me/photo', { method: 'PUT', cookie, body: { photo: PROFILE_WEBP, expectedUserId: 'min' } })).status).toBe(200);
      for (const [number, status] of [[22, 'draft'], [23, 'open']] as const) {
        await db.prepare(`INSERT INTO catchmind_rounds (id, number, drawer_id, word, normalized_word, word_history, status, created_at)
          VALUES (?, ?, 'min', '비공개제시어', '비공개제시어', '["숨긴이력"]', ?, ?)`)
          .bind(`hidden-${status}`, number, status, `${TODAY}T00:00:00Z`).run();
      }
      const first = await request('/api/catchmind/gallery?limit=9', { cookie });
      const text = await first.text();
      expect(text).not.toContain('data:image'); expect(text).not.toContain('base64');
      expect(text).not.toContain('비공개제시어'); expect(text).not.toContain('숨긴이력');
      const page1 = JSON.parse(text) as CatchmindGalleryResponse;
      expect(page1.rounds.map(round => round.number)).toEqual([21, 20, 19, 18, 17, 16, 15, 14, 13]);
      expect(page1.nextBefore).toBe(13);
      expect(page1.rounds[0]).toEqual({ id: 'gallery-21', number: 21, answer: '그림 21', image: catchmindImagePath('gallery-21'), endReason: 'correct', endedAt: `${TODAY}T00:00:00Z`,
        drawer: { id: 'min', username: 'min', displayName: '그리는 민', photoVersion: 1, character: 'moon' },
        winner: { id: 'siwon', username: 'siwon', displayName: '맞힌 시원', photoVersion: null, character: 'cat' } });
      expect(page1.rounds[1]).toMatchObject({ winner: null, endReason: 'manual' });
      expect(page1.rounds[2]).toMatchObject({ winner: null, endReason: 'misses' });
      await seedGallery(db, 1, 24); // A new finish cannot shift an existing cursor.
      const page2 = await (await request('/api/catchmind/gallery?before=13&limit=9', { cookie })).json() as CatchmindGalleryResponse;
      expect(page2.rounds.map(round => round.number)).toEqual([12, 11, 10, 9, 8, 7, 6, 5, 4]);
      expect(page2.nextBefore).toBe(4);
      const page3 = await (await request('/api/catchmind/gallery?before=4', { cookie })).json() as CatchmindGalleryResponse;
      expect(page3.rounds.map(round => round.number)).toEqual([3, 2, 1]); expect(page3.nextBefore).toBeNull();
      const image = await request(page1.rounds[0]!.image, { cookie });
      expect(image.headers.get('Cache-Control')).toContain('immutable');
      expect(Buffer.from(await image.arrayBuffer())).toEqual(Buffer.from(DRAWING_PNG.split(',')[1]!, 'base64'));
    });

    it('retains the previous result across new drafts and excludes the current ended round', async () => {
      const cookies = Object.fromEntries(await Promise.all(['min', 'siwon', 'yeseo'].map(async username => [username, (await login(username)).cookie])));
      let cookie = cookies.min!;
      let round = (await catchmindAction('claim', cookie, null)).catchmind.round!;
      expect((await getCatchmind(cookie)).catchmind.previousRound).toBeNull();
      await catchmindAction('publish', cookie, round.id, { wordVersion: round.wordVersion, image: DRAWING_PNG });
      const first = await catchmindAction('end', cookie, round.id);
      expect(first.catchmind.previousRound).toBeNull();
      const firstId = round.id;
      cookie = cookies.siwon!;
      round = (await catchmindAction('next', cookie, round.id)).catchmind.round!;
      expect((await getCatchmind(cookie)).catchmind.previousRound).toMatchObject({ id: firstId, number: 1, answer: first.catchmind.round!.word });
      await catchmindAction('publish', cookie, round.id, { wordVersion: round.wordVersion, image: DRAWING_WEBP });
      expect((await getCatchmind(cookie)).catchmind.previousRound?.id).toBe(firstId);
      expect((await catchmindAction('end', cookie, round.id)).catchmind.previousRound?.id).toBe(firstId);
      expect((await catchmindAction('next', cookies.yeseo!, round.id)).catchmind.previousRound?.id).toBe(round.id);
    });

    it('reports full authenticated gallery rows_read without growth from 5000 older rounds', async () => {
      const instance = runtime(workerWithD1Metrics(script));
      try {
        const database = await instance.getD1Database('DB');
        await provision(database, migration, passwordHash);
        const { cookie } = await login('min', instance);
        const measurements: Record<string, number> = {};
        const measure = async (label: string, query = '') => {
          const response = await request(`/api/catchmind/gallery${query}`, { cookie, instance });
          expect(response.status).toBe(200);
          const header = response.headers.get('X-Test-D1-Rows-Read'); expect(header).not.toBeNull();
          measurements[label] = Number(header);
          expect(measurements[label]).toBeLessThanOrEqual(40);
          return response.json() as Promise<CatchmindGalleryResponse>;
        };
        await measure('empty');
        await seedGallery(database, 20, 6001);
        expect((await measure('firstPage')).rounds).toHaveLength(9);
        await measure('secondPage', '?before=6012&limit=9');
        await seedGallery(database, 5000);
        await measure('firstPageWith5000OlderRounds');
        await measure('secondPageWith5000OlderRounds', '?before=6012&limit=9');
        expect(measurements.firstPageWith5000OlderRounds).toBe(measurements.firstPage);
        expect(measurements.secondPageWith5000OlderRounds).toBe(measurements.secondPage);
        console.log(`Catchmind gallery full authenticated GET D1 rows_read: ${JSON.stringify(measurements)} (local D1, session lookup included)`);
      } finally { await instance.dispose(); }
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
      const draft = (await catchmindAction('next', siwon.cookie, first.id)).catchmind.round!;
      expect(draft.image).toBeNull();
      const second = (await catchmindAction('publish', siwon.cookie, draft.id,
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

  describe('attendance coupons from November 3 KST', () => {
    it.each([
      { instant: '2026-11-02T14:59:59Z', day: '2026-11-02', prior: 0, gold: 100, coupons: 0 },
      { instant: '2026-11-02T15:00:00Z', day: '2026-11-03', prior: 0, gold: 100, coupons: 1 },
      { instant: '2026-11-02T15:00:00Z', day: '2026-11-03', prior: 6, gold: 500, coupons: 1 },
      { instant: '2026-11-02T15:00:00Z', day: '2026-11-03', prior: 13, gold: 500, coupons: 1 },
      { instant: '2026-11-03T15:00:00Z', day: '2026-11-04', prior: 0, gold: 100, coupons: 1 },
    ])('awards $gold G and $coupons of each coupon once on $day after streak $prior', async ({ instant, day, prior, gold, coupons }) => {
      const instance = runtime(await workerAt(instant));
      try {
        const database = await instance.getD1Database('DB');
        await provision(database, migration, passwordHash);
        const previousDay = new Date(Date.parse(`${day}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
        if (prior) await seedAttendance(previousDay, prior, 'min', database);
        const historical = (await database.prepare('SELECT * FROM attendance').all()).results;
        const sessions = await Promise.all([login('min', instance), login('min', instance)]);
        const claim = (cookie: string) => request('/api/me/attendance', { method: 'POST', cookie, instance,
          body: { date: '2026-11-09', lottoTickets: 999, speettoTickets: 999 } });
        const responses = await Promise.all(sessions.map(session => claim(session.cookie)));
        expect(responses.map(response => response.status)).toEqual([200, 200]);
        const receipts = await Promise.all(responses.map(response => response.json() as Promise<AttendanceClaimResponse>));
        expect(receipts.map(receipt => receipt.awarded).sort()).toEqual([false, true]);
        expect(receipts[0]!.attendance).toMatchObject({ today: day, streak: prior + 1, reward: gold });
        expect(await (await claim(sessions[0]!.cookie)).json()).toMatchObject({ awarded: false });
        expect(await ledgerRows(database)).toEqual([{ user_id: 'min', currency: 'gold', amount: gold, reference: `attendance:${day}:min`, week_start: null }]);
        expect((await database.prepare('SELECT item, amount, reference FROM inventory_ledger ORDER BY item').all()).results).toEqual(coupons ? [
          { item: 'lotto_ticket', amount: 1, reference: `attendance:${day}:min:lotto` },
          { item: 'speetto_ticket', amount: 1, reference: `attendance:${day}:min:speetto` },
        ] : []);
        expect((await database.prepare('SELECT * FROM attendance WHERE date < ?').bind(day).all()).results).toEqual(historical);
        const view = await (await request('/api/bootstrap', { cookie: sessions[0]!.cookie, instance })).json() as BootstrapResponse;
        expect(view.inventory).toEqual({ lottoTickets: coupons, speettoTickets: coupons, tagTickets: 0 });
        expect(await (await request('/api/shop', { cookie: sessions[0]!.cookie, instance })).json()).toMatchObject({ inventory: view.inventory });
      } finally { await instance.dispose(); }
    });

    it('rejects admins and rolls all rewards back if either coupon cannot be written', async () => {
      const instance = runtime(await workerAt('2026-11-03T00:00:00Z'));
      try {
        const database = await instance.getD1Database('DB');
        await provision(database, migration, passwordHash);
        const admin = await login('admin', instance);
        expect((await request('/api/me/attendance', { method: 'POST', cookie: admin.cookie, instance, body: {} })).status).toBe(403);
        const { cookie } = await login('min', instance);
        await database.prepare(`CREATE TRIGGER fail_attendance_coupon BEFORE INSERT ON inventory_ledger
          WHEN NEW.item = 'speetto_ticket' BEGIN SELECT RAISE(ABORT, 'test coupon failure'); END;`).run();
        expect((await request('/api/me/attendance', { method: 'POST', cookie, instance, body: {} })).status).toBe(500);
        for (const table of ['attendance', 'ledger', 'inventory_ledger']) {
          expect(await database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).first('count')).toBe(0);
        }
        await database.prepare('DROP TRIGGER fail_attendance_coupon').run();
        expect((await request('/api/me/attendance', { method: 'POST', cookie, instance, body: {} })).status).toBe(200);
        expect(await database.prepare('SELECT COUNT(*) AS count FROM inventory_ledger').first('count')).toBe(2);
      } finally { await instance.dispose(); }
    });

    it.each(['2026-11-02T14:59:59Z', '2026-11-03T14:59:59Z'])('never backfills a claim queued across midnight from %s', async instant => {
      const instance = runtime(await workerAt(instant, new Date(Date.parse(instant) + 1000).toISOString()));
      try {
        const database = await instance.getD1Database('DB');
        await provision(database, migration, passwordHash);
        const { cookie } = await login('min', instance);
        expect((await request('/api/me/attendance', { method: 'POST', cookie, instance, body: {} })).status).toBe(409);
        for (const table of ['attendance', 'ledger', 'inventory_ledger']) {
          expect(await database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).first('count')).toBe(0);
        }
      } finally { await instance.dispose(); }
    });
  });

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

  describe('bootstrap kuji summary', () => {
    it('returns 100 remaining without creating a board, including concurrent first reads', async () => {
      const min = await login('min');
      const admin = await login('admin');
      const views = await Promise.all([bootstrap(min.cookie), bootstrap(admin.cookie), bootstrap(min.cookie)]);
      for (const view of views) expect(view.kuji).toEqual({ boardId: null, remaining: 100 });
      expect(await db.prepare('SELECT COUNT(*) AS count FROM kuji_boards').first('count')).toBe(0);
      expect(await db.prepare('SELECT COUNT(*) AS count FROM kuji_claims').first('count')).toBe(0);
    });

    it('reports the shared current board after purchases by different players without exposing cells', async () => {
      const min = await login('min');
      const siwon = await login('siwon');
      await fund(5000);
      await fund(5000, 'siwon');
      const { kuji } = await getKuji(min.cookie);
      expect((await bootstrap(min.cookie)).kuji).toEqual({ boardId: kuji.boardId, remaining: 100 });
      await buyKuji(min.cookie, kuji.boardId, [0, 1]);
      await buyKuji(siwon.cookie, kuji.boardId, [2]);
      for (const cookie of [min.cookie, siwon.cookie]) {
        expect((await bootstrap(cookie)).kuji).toEqual({ boardId: kuji.boardId, remaining: 97 });
      }
      expect(await db.prepare('SELECT COUNT(*) AS count FROM kuji_boards').first('count')).toBe(1);
    });

    it('keeps a sold-out board at zero until a kuji visit creates the next board', async () => {
      const { cookie } = await login('min');
      await fund(50000);
      const { kuji } = await getKuji(cookie);
      await buyKuji(cookie, kuji.boardId, Array.from({ length: 99 }, (_, index) => index));
      expect((await bootstrap(cookie)).kuji).toEqual({ boardId: kuji.boardId, remaining: 1 });
      const last = await buyKuji(cookie, kuji.boardId, [99]);
      expect(last.kuji.remaining).toBe(0);
      for (const view of await Promise.all([bootstrap(cookie), bootstrap(cookie)])) {
        expect(view.kuji).toEqual({ boardId: kuji.boardId, remaining: 0 });
      }
      expect(await db.prepare('SELECT COUNT(*) AS count FROM kuji_boards').first('count')).toBe(1);
      const next = await getKuji(cookie);
      expect(next.kuji.boardId).toBe(kuji.boardId + 1);
      expect((await bootstrap(cookie)).kuji).toEqual({ boardId: next.kuji.boardId, remaining: 100 });
      await buyKuji(cookie, next.kuji.boardId, [0]);
      expect((await bootstrap(cookie)).kuji).toEqual({ boardId: next.kuji.boardId, remaining: 99 });
    });

    it('reports D1 rows_read and reads only current claims even with 5000 historical claims', async () => {
      const { cookie } = await login('min');
      await fund(50000);
      const observed = measuredDatabase(db, Date.parse(`${TODAY}T00:00:00Z`));
      const measurements: Record<string, number> = {};
      const measure = async (label: string, boardId: number | null, remaining: number) => {
        observed.reset();
        expect(await readKujiSummary(observed.binding)).toEqual({ boardId, remaining });
        expect(observed.queries).toHaveLength(1);
        expect(observed.queries[0]!.rowsWritten).toBe(0);
        expect(observed.rowsRead()).toBeLessThanOrEqual(102);
        measurements[label] = observed.rowsRead();
      };
      await measure('noBoard', null, 100);
      await getKuji(cookie);
      // Leave positive IDs available for historical fixtures below the current board.
      await db.prepare('UPDATE kuji_boards SET id = 1000 WHERE id = 1').run();
      await measure('emptyBoard', 1000, 100);
      await buyKuji(cookie, 1000, Array.from({ length: 37 }, (_, index) => index));
      await measure('sold37', 1000, 63);
      await db.prepare(`WITH RECURSIVE ids(id) AS (VALUES(1) UNION ALL SELECT id + 1 FROM ids WHERE id < 50)
        INSERT INTO kuji_boards (id, grades, created_at)
        SELECT ids.id, b.grades, b.created_at FROM ids CROSS JOIN kuji_boards b WHERE b.id = 1000`).run();
      await db.prepare(`WITH RECURSIVE positions(position) AS (VALUES(0) UNION ALL SELECT position + 1 FROM positions WHERE position < 99)
        INSERT INTO kuji_claims (board_id, position, purchase_id)
        SELECT b.id, positions.position, c.purchase_id FROM kuji_boards b CROSS JOIN positions
        JOIN kuji_claims c ON c.board_id = 1000 AND c.position = 0 WHERE b.id < 1000`).run();
      expect(await db.prepare('SELECT COUNT(*) AS count FROM kuji_claims WHERE board_id < 1000').first('count')).toBe(5000);
      await measure('sold37With5000HistoricalClaims', 1000, 63);
      expect(measurements.sold37With5000HistoricalClaims).toBe(measurements.sold37);
      await buyKuji(cookie, 1000, Array.from({ length: 63 }, (_, index) => index + 37));
      await measure('soldOut', 1000, 0);
      console.log(`Kuji bootstrap summary D1 meta rows_read: ${JSON.stringify(measurements)}; one read-only statement, auth and unrelated bootstrap queries excluded`);
    });
  });

  describe('slot machine economy', () => {
    const instant = `${TODAY}T00:00:00Z`;
    // Gold mechanics: these instances have no daily free spins (spent first otherwise).
    async function slotInstance(roll: number, gold = 500) {
      const instance = runtime(await workerAt(instant, instant, roll, { noDailyFree: true }));
      const database = await instance.getD1Database('DB');
      await provision(database, migration, passwordHash);
      if (gold) await fund(gold, 'min', database);
      const { cookie } = await login('min', instance);
      return { instance, database, cookie };
    }
    async function spin(cookie: string, instance: Miniflare, requestId = crypto.randomUUID()) {
      const response = await request('/api/shop/slot', { method: 'POST', cookie, instance, body: { requestId } });
      expect(response.status).toBe(200);
      return response.json() as Promise<SlotResponse>;
    }
    async function recent(cookie: string, instance: Miniflare) {
      const response = await request('/api/shop/slot', { cookie, instance });
      expect(response.status).toBe(200);
      return response.json() as Promise<SlotResponse>;
    }

    it.each([6, 7])('persists the roll %i slot outcome and credits the exact prize immediately once', async roll => {
      const { instance, database, cookie } = await slotInstance(roll);
      try {
        const requestId = crypto.randomUUID();
        const result = await spin(cookie, instance, requestId);
        expect(result.spin).toMatchObject({ requestId, cost: SLOT_RULES.price, prize: roll === 6 ? 2000 : 0,
          date: TODAY, createdAt: instant.replace('Z', '.000Z') });
        expect(result.spin!.reels).toHaveLength(3);
        if (roll === 6) expect(result.spin!.reels).toEqual(['seven', 'seven', 'seven']);
        else expect(new Set(result.spin!.reels).size).toBeGreaterThan(1);
        expect(result.gold).toBe(roll === 6 ? SLOT_RULES.jackpotPrize : 0);
        expect(result.inventory).toEqual({ lottoTickets: 0, speettoTickets: 0, tagTickets: 0 });
        expect((await recent(cookie, instance)).slot.recent).toEqual([result.spin]);
        const before = await ledgerRows(database);
        expect((await spin(cookie, instance, requestId)).spin).toEqual(result.spin);
        expect(await ledgerRows(database)).toEqual(before);
        const ledger = (await database.prepare("SELECT amount, reason, reference FROM ledger WHERE reason LIKE '슬롯머신%' ORDER BY amount").all()).results;
        expect(ledger).toEqual([
          { amount: -500, reason: '슬롯머신', reference: `slot:buy:min:${requestId}` },
          ...(roll === 6 ? [{ amount: 2000, reason: '슬롯머신 당첨', reference: `slot:prize:${result.spin!.id}` }] : []),
        ]);
        expect(await database.prepare('SELECT COUNT(*) AS n FROM slot_spins').first('n')).toBe(1);
        expect(await database.prepare('SELECT COUNT(*) AS n FROM shop_purchases').first('n')).toBe(0);
        expect(await database.prepare('SELECT COUNT(*) AS n FROM announcements').first('n')).toBe(0);
        await expectBalanced(database);
      } finally { await instance.dispose(); }
    });

    it('replays concurrent identical slot requests with one debit even after the wallet reaches zero', async () => {
      const { instance, database, cookie } = await slotInstance(7);
      try {
        const requestId = crypto.randomUUID();
        const results = await Promise.all(Array.from({ length: 6 }, () => spin(cookie, instance, requestId)));
        for (const result of results) expect(result.spin).toEqual(results[0]!.spin);
        expect((await recent(cookie, instance)).gold).toBe(0);
        expect(await database.prepare('SELECT COUNT(*) AS n FROM slot_spins').first('n')).toBe(1);
        expect((await ledgerRows(database)).filter(row => row.amount < 0).map(row => row.amount)).toEqual([-500]);
        await expectBalanced(database);
      } finally { await instance.dispose(); }
    });

    it('allows only affordable concurrent distinct slot requests without a negative cached wallet', async () => {
      const { instance, database, cookie } = await slotInstance(7, 1000);
      try {
        const responses = await Promise.all(Array.from({ length: 5 }, () => request('/api/shop/slot', {
          method: 'POST', cookie, instance, body: { requestId: crypto.randomUUID() },
        })));
        expect(responses.map(response => response.status).sort()).toEqual([200, 200, 409, 409, 409]);
        for (const response of responses.filter(value => value.status === 409)) {
          expect(await response.json()).toMatchObject({ error: { message: '이용권과 골드가 부족해요' } });
        }
        expect((await recent(cookie, instance)).gold).toBe(0);
        expect(await database.prepare('SELECT COUNT(*) AS n FROM slot_spins').first('n')).toBe(2);
        expect((await ledgerRows(database)).filter(row => row.amount < 0).map(row => row.amount)).toEqual([-500, -500]);
        await expectBalanced(database);
      } finally { await instance.dispose(); }
    });

    it('cannot pay for a winning slot with its prize or inventory coupons when gold is insufficient', async () => {
      const { instance, database, cookie } = await slotInstance(6, 499);
      try {
        await grantTicket('lotto_ticket', 2, database);
        await grantTicket('speetto_ticket', 3, database);
        const response = await request('/api/shop/slot', { method: 'POST', cookie, instance,
          body: { requestId: crypto.randomUUID(), payment: 'ticket' } });
        expect(response.status).toBe(409);
        expect(await response.json()).toMatchObject({ error: { code: 'INSUFFICIENT_GOLD', message: '이용권과 골드가 부족해요' } });
        expect(await database.prepare('SELECT COUNT(*) AS n FROM slot_spins').first('n')).toBe(0);
        expect((await ledgerRows(database)).map(row => row.amount)).toEqual([499]);
        expect(await recent(cookie, instance)).toMatchObject({ gold: 499, inventory: { lottoTickets: 2, speettoTickets: 3 } });
        await expectBalanced(database);
      } finally { await instance.dispose(); }
    });

    it('rolls back the slot receipt, debit and cached wallet if the prize write fails', async () => {
      const { instance, database, cookie } = await slotInstance(6);
      try {
        await database.prepare(`CREATE TRIGGER fail_slot_prize BEFORE INSERT ON ledger
          WHEN NEW.reason = '슬롯머신 당첨' BEGIN SELECT RAISE(FAIL, 'simulated slot prize failure'); END;`).run();
        const requestId = crypto.randomUUID();
        const response = await request('/api/shop/slot', { method: 'POST', cookie, instance, body: { requestId } });
        expect(response.status).toBe(500);
        expect(await database.prepare('SELECT COUNT(*) AS n FROM slot_spins').first('n')).toBe(0);
        expect((await ledgerRows(database)).map(row => row.amount)).toEqual([500]);
        expect((await recent(cookie, instance)).gold).toBe(500);
        await expectBalanced(database);
        await database.prepare('DROP TRIGGER fail_slot_prize').run();
        expect((await spin(cookie, instance, requestId)).gold).toBe(2000);
        expect(await database.prepare('SELECT COUNT(*) AS n FROM slot_spins').first('n')).toBe(1);
        await expectBalanced(database);
      } finally { await instance.dispose(); }
    });

    it('keeps slot history user-scoped, inclusive at seven days, newest first and capped at twenty', async () => {
      const { instance, database, cookie } = await slotInstance(7, 0);
      try {
        for (const [id, date, user] of [
          ['excluded-old', '2026-10-23', 'min'], ['inclusive-six-days', '2026-10-24', 'min'],
          ['today', TODAY, 'min'], ['other-player', TODAY, 'siwon'],
        ]) await database.prepare(`INSERT INTO slot_spins (id, user_id, request_id, cost, reels, prize, date, created_at)
          VALUES (?, ?, ?, 500, '["seven","seven","apple"]', 0, ?, ?)`)
          .bind(id, user, id, date, `${date}T00:00:00.000Z`).run();
        expect((await recent(cookie, instance)).slot.recent.map(value => value.id)).toEqual(['today', 'inclusive-six-days']);
        await database.prepare(`WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM n WHERE x < 24)
          INSERT INTO slot_spins (id, user_id, request_id, cost, reels, prize, date, created_at)
          SELECT 'recent-' || x, 'min', 'recent-' || x, 500, '["apple","seven","grape"]', 0, ?,
            ? || printf('%02d', x) || ':00.000Z' FROM n`).bind(TODAY, `${TODAY}T00:`).run();
        const history = (await recent(cookie, instance)).slot.recent;
        expect(history).toHaveLength(SLOT_RULES.historyLimit);
        expect(history.map(value => value.id)).toEqual(Array.from({ length: 20 }, (_, index) => `recent-${24 - index}`));
        expect(await database.prepare('SELECT COUNT(*) AS n FROM slot_spins').first('n')).toBe(28);
        await expectBalanced(database);
      } finally { await instance.dispose(); }
    });

    it('restores an explicit old slot receipt without another debit or reinserting it in recent history', async () => {
      const persistence = await mkdtemp(join(tmpdir(), 'yegoom-old-slot-receipt-'));
      const old = '2026-10-20T00:00:00Z';
      let instance = runtime(await workerAt(old, old, 6, { noDailyFree: true }), persistence);
      try {
        let database = await instance.getD1Database('DB'); await provision(database, migration, passwordHash);
        await fund(500, 'min', database);
        let { cookie } = await login('min', instance);
        const requestId = crypto.randomUUID();
        const original = (await spin(cookie, instance, requestId)).spin;
        await instance.dispose();
        instance = runtime(await workerAt(instant, instant, 7), persistence);
        database = await instance.getD1Database('DB');
        cookie = (await login('min', instance)).cookie;
        expect((await recent(cookie, instance)).slot.recent).toEqual([]);
        const before = await ledgerRows(database);
        const replay = await spin(cookie, instance, requestId);
        expect(replay.spin).toEqual(original);
        expect(replay.slot.recent).toEqual([]);
        expect(replay.gold).toBe(2000);
        expect(await ledgerRows(database)).toEqual(before);
        await expectBalanced(database);
      } finally { await instance.dispose(); await rm(persistence, { recursive: true, force: true }); }
    });

    it('rejects slot auth, Origin, invalid IDs and administrator writes before recording a spin', async () => {
      const player = await login('min'); const admin = await login('admin');
      const input = { requestId: crypto.randomUUID() };
      expect((await request('/api/shop/slot')).status).toBe(401);
      expect((await request('/api/shop/slot', { method: 'POST', body: input })).status).toBe(401);
      expect((await request('/api/shop/slot', { method: 'POST', cookie: player.cookie, origin: 'https://other.invalid', body: input })).status).toBe(403);
      expect((await request('/api/shop/slot', { method: 'POST', cookie: admin.cookie, body: input })).status).toBe(403);
      const adminRead = await request('/api/shop/slot', { cookie: admin.cookie });
      expect(adminRead.status).toBe(200);
      expect(await adminRead.json()).toMatchObject({ canPurchase: false, slot: { recent: [] } });
      for (const requestId of ['', 'invalid id', 'a'.repeat(129), 42, undefined]) {
        expect((await request('/api/shop/slot', { method: 'POST', cookie: player.cookie, body: { requestId } })).status).toBe(400);
      }
      expect((await request('/api/shop/slot', { method: 'PUT', cookie: player.cookie, body: input })).status).toBe(405);
      expect(await db.prepare('SELECT COUNT(*) AS n FROM slot_spins').first('n')).toBe(0);
      expect(await ledgerRows()).toEqual([]);
    });

    it('scopes slot request IDs to each player', async () => {
      const { instance, database, cookie } = await slotInstance(7);
      try {
        await fund(500, 'siwon', database);
        const other = await login('siwon', instance);
        const requestId = crypto.randomUUID();
        const [first, second] = await Promise.all([spin(cookie, instance, requestId), spin(other.cookie, instance, requestId)]);
        expect(first.spin!.id).not.toBe(second.spin!.id);
        expect(first.spin!.requestId).toBe(second.spin!.requestId);
        expect(first.gold).toBe(0); expect(second.gold).toBe(0);
        expect(await database.prepare('SELECT COUNT(*) AS n FROM slot_spins').first('n')).toBe(2);
        await expectBalanced(database);
      } finally { await instance.dispose(); }
    });

    it('adds only the slot table and indexes while preserving old shop and announcement CHECK contracts', async () => {
      const instance = runtime(script);
      try {
        const database = await instance.getD1Database('DB');
        const oldMigration = (await Promise.all((await readdir(new URL('../migrations/', import.meta.url)))
          .filter(name => name.endsWith('.sql') && name < '0013_slot_machine.sql').sort()
          .map(name => readFile(new URL(`../migrations/${name}`, import.meta.url), 'utf8')))).join('\n');
        await provision(database, oldMigration, passwordHash);
        const schema = async () => (await database.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY name").all<{ name: string; sql: string }>()).results;
        const before = await schema();
        await applyMigration(database, await readFile(new URL('../migrations/0013_slot_machine.sql', import.meta.url), 'utf8'));
        const after = await schema();
        expect(after.filter(table => table.name !== 'slot_spins')).toEqual(before);
        expect(after.filter(table => !before.some(prior => prior.name === table.name)).map(table => table.name)).toEqual(['slot_spins']);
        expect(await database.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'index' AND name = 'slot_spins_user_date_idx'").first('n')).toBe(1);
        await applyMigrationsAfter(database, '0013_slot_machine.sql');
        // These existing requests exercise the unchanged old paths after only the additive migration.
        const { cookie } = await login('min', instance);
        expect((await request('/api/bootstrap', { cookie, instance })).status).toBe(200);
        await grantTicket('speetto_ticket', 1, database);
        expect((await request('/api/shop/speetto', { method: 'POST', cookie, instance,
          body: { requestId: crypto.randomUUID(), payment: 'ticket' } })).status).toBe(200);
        expect(await database.prepare('SELECT COUNT(*) AS n FROM slot_spins').first('n')).toBe(0);
        await expectBalanced(database);
      } finally { await instance.dispose(); }
    });
  });

  describe('slot machine request budgets', () => {
    it('records authenticated slot read, spin, retry and bootstrap costs with bounded histories and cached wallets', async () => {
      type Measurement = {
        historicalSpins: number; recentSpins: number; historicalGoldLedgerRows: number; outcome: 'win' | 'loss'; route: string;
        prepares: number; queries: number; bindingCalls: number; rowsRead: number; rowsWritten: number; returnedSpins: number | null;
      };
      const measurements: Measurement[] = [];
      const instant = `${TODAY}T00:00:00Z`;
      const fixtures = [
        { historicalSpins: 0, recentSpins: 3, historicalGoldLedgerRows: 0 },
        { historicalSpins: 5000, recentSpins: 3, historicalGoldLedgerRows: 0 },
        { historicalSpins: 0, recentSpins: 3, historicalGoldLedgerRows: 10000 },
        { historicalSpins: 5000, recentSpins: 3, historicalGoldLedgerRows: 10000 },
        { historicalSpins: 5000, recentSpins: 5000, historicalGoldLedgerRows: 10000 },
      ];
      for (const fixture of fixtures) for (const outcome of ['loss', 'win'] as const) {
        const instance = runtime(workerWithD1Metrics(await workerAt(instant, instant, outcome === "win" ? 6 : 7, { noDailyFree: true })));
        try {
          const database = await instance.getD1Database('DB'); await provision(database, migration, passwordHash);
          await fund(10000, 'min', database);
          if (fixture.historicalGoldLedgerRows) await database.prepare(`WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM n WHERE x < ?)
            INSERT INTO ledger (id, user_id, currency, amount, reason, reference, created_at)
            SELECT 'slot-budget-gold-' || x, 'min', 'gold', 1, 'old fixture funding', 'slot-budget-gold:' || x,
              '2026-01-01T00:00:00.000Z' FROM n`).bind(fixture.historicalGoldLedgerRows).run();
          if (fixture.historicalSpins) await database.prepare(`WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM n WHERE x < ?)
            INSERT INTO slot_spins (id, user_id, request_id, cost, reels, prize, date, created_at)
            SELECT 'old-slot-' || x, 'min', 'old-slot-' || x, 500, '["apple","seven","grape"]', 0,
              '2026-01-01', '2026-01-01T00:00:00.000Z' FROM n`).bind(fixture.historicalSpins).run();
          for (const date of fixture.recentSpins > 3 ? [TODAY] : ['2026-10-24', '2026-10-29', TODAY]) await database.prepare(`INSERT INTO slot_spins
            (id, user_id, request_id, cost, reels, prize, date, created_at)
            VALUES (?, 'min', ?, 500, '["apple","seven","grape"]', 0, ?, ?)`)
            .bind(`slot-budget-${date}`, `slot-budget-${date}`, date, `${date}T00:00:00.000Z`).run();
          if (fixture.recentSpins > 3) await database.prepare(`WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM n WHERE x < ?)
            INSERT INTO slot_spins (id, user_id, request_id, cost, reels, prize, date, created_at)
            SELECT 'dense-slot-' || printf('%05d', x), 'min', 'dense-slot-' || x, 500, '["apple","seven","grape"]', 0,
              ?, ? FROM n`).bind(fixture.recentSpins - 1, TODAY, `${TODAY}T00:00:00.000Z`).run();
          const plan = (await database.prepare(`EXPLAIN QUERY PLAN SELECT * FROM slot_spins
            WHERE user_id = ? AND date >= ? ORDER BY date DESC, created_at DESC, id DESC LIMIT ?`)
            .bind('min', '2026-10-24', SLOT_RULES.historyLimit).all<{ detail: string }>()).results.map(row => row.detail).join('; ');
          expect(plan).toContain('slot_spins_user_date_idx');
          expect(plan).not.toMatch(/TEMP B-TREE/i);
          const { cookie } = await login('min', instance);
          const requestId = crypto.randomUUID();
          let original: SlotResponse['spin'];
          for (const route of ['bootstrap before', 'GET slot before', 'POST slot new', 'POST slot retry', 'GET slot after', 'bootstrap after']) {
            const isBootstrap = route.startsWith('bootstrap');
            const isPost = route.startsWith('POST');
            const response = await request(isBootstrap ? '/api/bootstrap' : '/api/shop/slot', {
              cookie, instance, ...(isPost ? { method: 'POST', body: { requestId } } : {}),
            });
            expect(response.status, route).toBe(200);
            const body = await response.json() as SlotResponse & BootstrapResponse;
            const row: Measurement = { ...fixture, outcome, route,
              prepares: Number(response.headers.get('X-Test-D1-Prepares')),
              queries: Number(response.headers.get('X-Test-D1-Queries')),
              bindingCalls: Number(response.headers.get('X-Test-D1-Binding-Calls')),
              rowsRead: Number(response.headers.get('X-Test-D1-Rows-Read')),
              rowsWritten: Number(response.headers.get('X-Test-D1-Rows-Written')),
              returnedSpins: isBootstrap ? null : body.slot.recent.length,
            };
            measurements.push(row);
            expect(row.bindingCalls).toBeLessThanOrEqual(50);
            if (route !== 'POST slot new') expect(row.rowsWritten, route).toBe(0);
            else {
              expect(row.rowsWritten).toBeGreaterThan(0);
              original = body.spin;
              expect(body.gold).toBe(10000 + fixture.historicalGoldLedgerRows - SLOT_RULES.price + (outcome === 'win' ? SLOT_RULES.jackpotPrize : 0));
            }
            if (route === 'POST slot retry') expect(body.spin).toEqual(original);
            if (!isBootstrap) {
              const added = route === 'GET slot before' ? 0 : 1;
              expect(row.returnedSpins).toBe(Math.min(SLOT_RULES.historyLimit, fixture.recentSpins + added));
              // Both the server list limit and cached balance must bound work;
              // the achievement check after a spin probes indexes only.
              expect(row.rowsRead).toBeLessThan(100 + achievementAllowance(route, 'rowsRead'));
            }
          }
          await expectBalanced(database);
        } finally { await instance.dispose(); }
      }
      for (const row of measurements.filter(value => value.historicalSpins === 5000 && value.recentSpins === 3)) {
        const empty = measurements.find(value => value.historicalSpins === 0 && value.recentSpins === 3
          && value.historicalGoldLedgerRows === row.historicalGoldLedgerRows && value.outcome === row.outcome && value.route === row.route)!;
        for (const field of ['prepares', 'queries', 'bindingCalls', 'rowsWritten'] as const) expect(row[field], `${row.route}: ${field}`).toBe(empty[field]);
        expect(row.rowsRead, `${row.route}: old spins must not grow reads`).toBeLessThanOrEqual(empty.rowsRead + 2);
      }
      for (const row of measurements.filter(value => value.historicalGoldLedgerRows === 10000 && value.recentSpins === 3 && !value.route.startsWith('bootstrap'))) {
        const empty = measurements.find(value => value.historicalGoldLedgerRows === 0 && value.historicalSpins === row.historicalSpins
          && value.recentSpins === 3 && value.outcome === row.outcome && value.route === row.route)!;
        expect(row.queries).toBe(empty.queries);
        expect(row.rowsRead, `${row.route}: cached wallet must avoid ledger scans`).toBeLessThanOrEqual(empty.rowsRead + 2);
      }
      if (process.env.FREE_PLAN_SLOT_MEASUREMENTS) {
        writeFileSync(process.env.FREE_PLAN_SLOT_MEASUREMENTS, `${JSON.stringify({
          measuredOn: '2026-11-04', baseMain: '9fc547c',
          source: 'tests/integration.test.ts: slot machine request budgets',
          command: 'FREE_PLAN_SLOT_MEASUREMENTS=docs/free-plan-pr7-measurements.json XDG_CONFIG_HOME=/tmp/yegoom-config npm test -- tests/integration.test.ts -t "records authenticated slot read"',
          environment: { node: process.version, database: 'isolated local D1/workerd, no remote access' },
          counting: {
            prepares: 'DB.prepare calls', queries: 'Executed SQL statements; each DB.batch statement counts separately',
            bindingCalls: 'all/first/run or one DB.batch call', rowsRead: 'Sum of actual D1 meta.rows_read, including authentication',
            rowsWritten: 'Sum of actual D1 meta.rows_written, including balance-cache triggers and index maintenance',
          },
          fixture: {
            clockKst: '09:00', currentDate: TODAY, recentBoundaryDate: '2026-10-24',
            initialGold: '10000G funding plus 0/10000 historical one-gold ledger entries; cache kept by real triggers',
            histories: '3 recent plus 0/5000 older spins, then 5000 recent spins at one timestamp to exercise bounded indexed sorting',
            receiptFixtures: 'Historical/list-only spins are directly seeded; actual new/retry requests use real conditional batch debit and prize paths',
            outcomes: 'Compiled-test-only randomInt(100)=7 loss / 6 jackpot; no production randomness controls',
            bootstrap: 'No slot aggregate added; before/after includes the unchanged PR2 bootstrap paths, with actual spin ledger rows visible afterward',
          }, measurements,
        }, null, 2)}\n`);
      } else {
        const prior = JSON.parse(readFileSync(new URL('../docs/free-plan-pr7-measurements.json', import.meta.url), 'utf8')) as { measurements: Measurement[] };
        expect(measurements.map(({ historicalSpins, recentSpins, historicalGoldLedgerRows, outcome, route }) =>
          [historicalSpins, recentSpins, historicalGoldLedgerRows, outcome, route])).toEqual(prior.measurements.map(row =>
          [row.historicalSpins, row.recentSpins, row.historicalGoldLedgerRows, row.outcome, row.route]));
        for (const [index, row] of measurements.entries()) for (const field of ['prepares', 'queries', 'bindingCalls', 'rowsRead', 'rowsWritten'] as const) {
          expect(row[field], `${row.route}: ${field}`).toBeLessThanOrEqual(prior.measurements[index]![field] + stockAllowance(row.route, field) + achievementAllowance(row.route, field));
        }
      }
      console.log(`Slot authenticated request metrics: ${JSON.stringify(measurements)}`);
    }, 90000);
  });

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
      let instance = runtime(await workerAt('2026-11-01T14:49:59Z'), persistence); // 23:49:59 KST, before the close
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
      { kind: 'lotto', before: '2026-10-30T08:29:59Z', after: '2026-10-30T08:30:00Z' },
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
      let instance = runtime(await workerAt(`${TODAY}T08:29:59Z`), persistence);
      try {
        const database = await instance.getD1Database('DB');
        await provision(database, migration, passwordHash);
        await fund(1000, 'min', database);
        const { cookie } = await login('min', instance);
        const body = { requestId: crypto.randomUUID(), numbers: [1, 2, 3, 4, 5], payment: 'gold' };
        const first = await request('/api/shop/lotto', { method: 'POST', cookie, instance, body });
        expect(first.status).toBe(200);
        const original = (await first.json() as LottoResponse).purchase!;
        for (const instant of [`${TODAY}T08:30:00Z`, `${TODAY}T15:00:00Z`]) {
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
      ['2026-10-30T08:00:00Z', '2026-10-30'],
      ['2026-10-30T08:29:59Z', '2026-10-30'],
      ['2026-10-30T08:30:00Z', '2026-10-31'],
      ['2026-10-30T14:49:59Z', '2026-10-31'], // 23:49:59 KST, the last purchase before the close
      ['2026-10-30T15:00:00Z', '2026-10-31'],
      ['2026-10-31T08:30:00Z', '2026-11-01'],
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

    it('creates the 17:30 lotto draw once across concurrent reads', async () => {
      const instance = runtime(await workerAt(`${TODAY}T08:30:00Z`));
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
        expect(view.inventory).toEqual({ lottoTickets: 0, speettoTickets: 0, tagTickets: 0 });
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
      await withoutDailyFree();
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
      const instance = runtime(await workerAt(instant, instant, roll, { noDailyFree: true }));
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
          body: { requestId: crypto.randomUUID(), numbers: [1, 2, 3, 4, 5], payment: 'coupon' } })).status).toBe(400);
      }
      expect(await ledgerRows()).toEqual([]);
      expect(await db.prepare('SELECT COUNT(*) AS count FROM shop_purchases').first('count')).toBe(0);
    });
  });

  const scoringCases: { game: GameId; player: Username; thresholds: [number, number][] }[] = [
    { game: 'wake', player: 'siwon', thresholds: [[0, 30], [60, 25], [180, 20], [600, 15], [1800, 10], [3600, 5], [7200, 3]] },
    { game: 'offwork', player: 'min', thresholds: [[0, 30], [15, 25], [30, 20], [60, 15], [180, 10], [300, 5], [600, 1]] },
    { game: 'luck', player: 'min', thresholds: [[0, 15], [1, 12], [2, 10], [3, 8], [4, 6], [5, 4], [10, 2], [15, 1]] },
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
    await uploadLuck(yeseo.cookie);
    expect((await request('/api/games/luck/answer', { method: 'PUT', cookie: yeseo.cookie, body: { value: '50' } })).status).toBe(200);
    expect((await request('/api/games/luck/reveal', { method: 'POST', cookie: yeseo.cookie, body: {} })).status).toBe(200);
    const result = (await bootstrap(min.cookie)).games.find(game => game.id === 'luck')!;
    expect(result.results).toHaveLength(2);
    for (const row of result.results) expect(row).toMatchObject({ difference: 7, score: 2, isFirst: true, participationGold: 100, firstGold: 100, gold: 200 });
    expect((await ledgerRows()).filter(row => row.reference.startsWith('first:')).map(row => [row.user_id, row.amount])).toEqual([['min', 100], ['siwon', 100]]);
    expect((await bootstrap(min.cookie)).user).toMatchObject({ gold: 200, weeklyScore: 2 });
    expect((await bootstrap(siwon.cookie)).user).toMatchObject({ gold: 200, weeklyScore: 2 });
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
      expect(round.results).toMatchObject([{ playerId: 'min', value: '49', difference: 1, score: 12, isFirst: true }]);
    }
    expect(JSON.stringify(history)).not.toContain('88');
    expect((await request('/api/games/luck/history')).status).toBe(401);
  });

  it('assigns delayed Sunday-night scores to the game week when first read on Monday', async () => {
    const monday = runtime(await workerAt('2026-11-01T15:00:01Z'));
    try {
      const mondayDb = await monday.getD1Database('DB');
      await provision(mondayDb, migration, passwordHash);
      // Revealed at 23:45 KST, before the daily close, but settled only by Monday's first read.
      await seedRound({ game: 'offwork', date: '2026-11-01', answer: '23:45:00', revealAt: Date.parse('2026-11-01T14:45:00Z'),
        predictions: [['min', '23:45:00']], database: mondayDb });
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
    expect(view.user.weeklyScore).toBe(42);
    expect(view.dailyScores).toEqual([0, 30, 0, 12, 0, 0, 0]);
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
    await uploadLuck(yeseo.cookie);
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
      { reference: `score:luck:${TODAY}:min`, amount: 8 },
      { reference: `score:luck:${TODAY}:siwon`, amount: 2 },
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
    const marker = 'const previousToken = sessionToken(request);';
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
      expect(view.user.weeklyScore).toBe(phase === 'revealed' ? 15 : 0);
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
    await uploadLuck(cookie);
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
