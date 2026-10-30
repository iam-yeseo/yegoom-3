import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { hashPassword, hashToken } from '../worker/crypto';
import type { BootstrapResponse, GameResponse, User } from '../shared/types';

const ORIGIN = 'http://localhost';
const PASSWORD = 'test-only-password-42!';
const TODAY = '2026-10-30';
const USERS = ['min', 'siwon', 'yeseo', 'admin'] as const;
type Username = typeof USERS[number];
type Database = Awaited<ReturnType<Miniflare['getD1Database']>>;

// Freeze only the compiled test bundle. Production never accepts a clock header
// or an environment override, and these tests do not depend on the host timezone.
async function workerAt(instant: string): Promise<string> {
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
  return result.outputFiles[0]!.text.replaceAll("unixepoch('now') * 1000", String(timestamp));
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
      readFile(new URL('../migrations/0001_initial.sql', import.meta.url), 'utf8'),
      hashPassword(PASSWORD),
    ]);
    worker = runtime(await workerAt(`${TODAY}T00:00:00Z`)); // 09:00 KST
    db = await worker.getD1Database('DB');
    await provision(db, migration, passwordHash);
  });

  beforeEach(async () => {
    await db.batch([
      db.prepare('DELETE FROM predictions'),
      db.prepare('DELETE FROM game_rounds'),
      db.prepare('DELETE FROM sessions'),
      db.prepare('DELETE FROM login_attempts'),
      db.prepare('UPDATE users SET active = 1'),
    ]);
  });

  afterAll(async () => { await worker?.dispose(); });

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
    // Unconfirmed reward rules must not create an arbitrary payout.
    expect(await db.prepare('SELECT COUNT(*) AS count FROM ledger').first('count')).toBe(0);
  });

  it('rejects invalid game values without persisting them', async () => {
    const min = await login('min');
    const yeseo = await login('yeseo');
    for (const value of ['-1', '101', '01', '12.5', 55, null]) {
      expect((await request('/api/games/luck/prediction', { method: 'PUT', cookie: min.cookie, body: { value } })).status).toBe(400);
      expect((await request('/api/games/luck/answer', { method: 'PUT', cookie: yeseo.cookie, body: { value } })).status).toBe(400);
    }
    for (const value of ['24:00', '9:00', '12:60', '12:00:00', "'; DROP TABLE users; --"]) {
      expect((await request('/api/games/offwork/prediction', { method: 'PUT', cookie: min.cookie, body: { value } })).status).toBe(400);
    }
    expect(await db.prepare('SELECT COUNT(*) AS count FROM predictions').first('count')).toBe(0);
    expect(await db.prepare('SELECT COUNT(*) AS count FROM users').first('count')).toBe(4);
  });

  it('automatically reveals the off-work answer at its recorded time and closes predictions', async () => {
    const min = await login('min');
    const siwon = await login('siwon');
    expect((await request('/api/games/offwork/prediction', {
      method: 'PUT', cookie: min.cookie, body: { value: '09:05' },
    })).status).toBe(200);
    expect((await request('/api/games/offwork/answer', {
      method: 'PUT', cookie: siwon.cookie, body: { value: '09:00' },
    })).status).toBe(200);
    const revealed = (await bootstrap(min.cookie)).games.find(game => game.id === 'offwork')!;
    expect(revealed.phase).toBe('revealed');
    expect(revealed.answer).toBe('09:00');
    expect(revealed.results[0]?.difference).toBe(5);
    expect((await request('/api/games/offwork/prediction', {
      method: 'PUT', cookie: min.cookie, body: { value: '09:00' },
    })).status).toBe(409);
    expect((await request('/api/games/offwork/answer', {
      method: 'PUT', cookie: siwon.cookie, body: { value: '10:00' },
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

  it('rejects predictions at the exact 17:00 KST deadline', async () => {
    const atDeadline = runtime(await workerAt(`${TODAY}T08:00:00Z`));
    try {
      const deadlineDb = await atDeadline.getD1Database('DB');
      await provision(deadlineDb, migration, passwordHash);
      const { cookie } = await login('min', atDeadline);
      for (const [game, value] of [['offwork', '18:30'], ['luck', '50']]) {
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
