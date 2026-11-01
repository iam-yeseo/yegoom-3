import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { hashPassword, hashToken } from '../worker/crypto';
import type { BootstrapResponse, GameResponse, GameId, HistoryResponse, User } from '../shared/types';

const ORIGIN = 'http://localhost';
const PASSWORD = 'test-only-password-42!';
const TODAY = '2026-10-30';
const USERS = ['min', 'siwon', 'yeseo', 'admin'] as const;
type Username = typeof USERS[number];
type Database = Awaited<ReturnType<Miniflare['getD1Database']>>;

// Freeze only the compiled test bundle. Production never accepts a clock header
// or an environment override, and these tests do not depend on the host timezone.
async function workerAt(instant: string, sqlInstant: string = instant): Promise<string> {
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
  return result.outputFiles[0]!.text.replaceAll("unixepoch('now') * 1000", String(Date.parse(sqlInstant)));
}

function runtime(script: string) {
  return new Miniflare({
    modules: true,
    script,
    compatibilityDate: '2026-08-06',
    d1Databases: ['DB'],
  });
}

async function provision(db: Database, migration: string, passwordHash: string) {
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

  async function login(username: Username, instance?: Miniflare) {
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
