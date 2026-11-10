import { readFile, readdir } from 'node:fs/promises';
import { Miniflare } from 'miniflare';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { FREETHROW_RULES, freeThrowDeadline, freeThrowSlot, freeThrowSlotStart } from '../shared/balance';
import { simulateShot } from '../shared/freethrow-physics';
import { scoreSource } from '../shared/ranking-periods';
import { syncAchievements } from '../worker/achievements';
import { FreeThrowError, finishFreeThrowSet, getFreeThrowState, getFreeThrowSummary, startFreeThrowSet } from '../worker/freethrow';

type Database = Awaited<ReturnType<Miniflare['getD1Database']>>;
const MAKE = { power: 55, aim: 0 } as const;
const MISS = { power: 10, aim: 0 } as const;
const player = (id: string) => ({ id, role: 'player' as const });
const admin = { id: 'admin', role: 'admin' as const };
// 2026-11-07 12:30 KST: the 12:00–15:00 KST slot.
const NOON = Date.parse('2026-11-07T03:30:00Z');
const SLOT_END = freeThrowSlotStart(freeThrowSlot(NOON) + 1);

let mf: Miniflare; let db: Database;
async function migrate(database: Database) {
  for (const name of (await readdir(new URL('../migrations/', import.meta.url))).filter(file => file.endsWith('.sql')).sort()) {
    let statement = '';
    for (const sourceLine of (await readFile(new URL(`../migrations/${name}`, import.meta.url), 'utf8')).split('\n')) {
      const line = sourceLine.trim();
      if (!line || line.startsWith('--')) continue;
      statement += `${line}\n`;
      const trigger = /^CREATE TRIGGER\b/i.test(statement);
      if (line.endsWith(';') && (!trigger || /\bEND;$/i.test(line))) { await database.prepare(statement).run(); statement = ''; }
    }
  }
}
async function rejects(promise: Promise<unknown>, status: number, code: string) {
  const error = await promise.then(() => null, (failure: unknown) => failure);
  expect(error).toBeInstanceOf(FreeThrowError);
  expect(error).toMatchObject({ status, code });
}
const rid = (label: string) => `req-${label}-0123456789abcdef`;
async function start(user = 'min', now = NOON, label = 'start') {
  const state = await startFreeThrowSet(db as unknown as D1Database, player(user), { requestId: rid(`${user}-${label}`) }, now);
  return state.current!;
}
type Shot = { power: number; aim: number };
/** A set of ten: the first `made` balls go in, the rest fall short. */
const balls = (made: number): Shot[] => Array.from({ length: FREETHROW_RULES.shotsPerSet }, (_, i) => (i < made ? MAKE : MISS));
const finish = (user: string, setId: string, shots: Shot[], now = NOON) =>
  finishFreeThrowSet(db as unknown as D1Database, player(user), { setId, shots }, now);
// The ledger is append-only, so rows are scoped to the set under test.
const ledger = (setId: string) => db.prepare("SELECT currency, amount, reason, reference, week_start FROM ledger WHERE user_id = 'min' AND substr(reference, 1, ?) = ? ORDER BY reference")
  .bind(`freethrow:set:${setId}:`.length, `freethrow:set:${setId}:`).all<{ currency: string; amount: number; reason: string; reference: string; week_start: string | null }>().then(result => result.results);

beforeAll(async () => {
  mf = new Miniflare({ modules: true, script: 'export default { fetch() { return new Response("") } }', compatibilityDate: '2026-08-06', d1Databases: ['DB'] });
  db = await mf.getD1Database('DB');
  await migrate(db);
});
afterAll(async () => { await mf.dispose(); });
beforeEach(async () => {
  for (const table of ['freethrow_shots', 'freethrow_sets', 'achievements']) await db.prepare(`DELETE FROM ${table}`).run();
  await db.prepare('DELETE FROM users').run().catch(() => {});
  for (const [id, role] of [['min', 'player'], ['siwon', 'player'], ['yeseo', 'player'], ['admin', 'admin']] as const) {
    await db.prepare('INSERT OR IGNORE INTO users (id, username, display_name, password_hash, role) VALUES (?, ?, ?, ?, ?)').bind(id, id, id, 'x', role).run();
  }
});

describe('free-throw official sets', () => {
  it('derives availability without writing and keeps admins to practice', async () => {
    expect(await getFreeThrowSummary(db as unknown as D1Database, player('min'), NOON)).toEqual({
      available: true, played: false, completed: false, made: 0, nextSlotAt: SLOT_END, serverNow: NOON, isAdmin: false });
    expect(await getFreeThrowSummary(db as unknown as D1Database, admin, NOON)).toMatchObject({ available: false, isAdmin: true });
    expect(await db.prepare('SELECT COUNT(*) AS n FROM freethrow_sets').first('n')).toBe(0);
    await rejects(startFreeThrowSet(db as unknown as D1Database, admin, { requestId: rid('admin') }, NOON), 403, 'CANNOT_PLAY');
  });

  it('opens one set per three-hour slot, and a retried start returns the same set', async () => {
    const set = await start();
    expect(set).toMatchObject({ shots: [], made: 0, completed: false, finished: false, slotStart: freeThrowSlotStart(freeThrowSlot(NOON)), deadline: SLOT_END + FREETHROW_RULES.graceMs, engine: FREETHROW_RULES.engine });
    expect((await start()).id).toBe(set.id);
    await rejects(startFreeThrowSet(db as unknown as D1Database, player('min'), { requestId: rid('again') }, NOON + 60_000), 409, 'SET_USED');
    const summary = await getFreeThrowSummary(db as unknown as D1Database, player('min'), NOON);
    expect(summary).toMatchObject({ available: false, played: true, completed: false });
    // KST 15:00 opens the next slot.
    expect(await getFreeThrowSummary(db as unknown as D1Database, player('siwon'), SLOT_END)).toMatchObject({ available: true });
    expect(await db.prepare('SELECT date FROM freethrow_sets').first('date')).toBe('2026-11-07');
  });

  it('settles concurrent starts with a single set', async () => {
    const results = await Promise.allSettled(['a', 'b', 'c'].map(label => startFreeThrowSet(db as unknown as D1Database, player('min'), { requestId: rid(label) }, NOON)));
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(await db.prepare('SELECT COUNT(*) AS n FROM freethrow_sets').first('n')).toBe(1);
  });

  it('re-simulates the whole set on the server and pays 1 point + 5G per goal once', async () => {
    const set = await start();
    const shots = balls(7);
    const done = await finish('min', set.id, shots);
    expect(done.replayed).toBe(false);
    expect(done.current).toMatchObject({ made: 7, completed: true, finished: true, points: 7, gold: 35 });
    expect(done.current!.shots).toEqual(shots.map((shot, index) => ({ index, ...shot, made: index < 7, kind: simulateShot(shot).kind })));
    expect(done).toMatchObject({ available: false, played: true, completed: true, made: 7 });
    expect(await ledger(set.id)).toEqual([
      { currency: 'gold', amount: 35, reason: '자유투 대결 골', reference: `freethrow:set:${set.id}:gold`, week_start: null },
      { currency: 'score', amount: 7, reason: '자유투 대결 골', reference: `freethrow:set:${set.id}:score`, week_start: '2026-11-02' },
    ]);
    expect(scoreSource(`freethrow:set:${set.id}:score`, '')).toEqual({ game: 'freethrow', label: '자유투 대결' });
    const goldBefore = await db.prepare("SELECT gold FROM user_balances WHERE user_id = 'min'").first('gold');
    // A lost response is retried with the same set: no second simulation or payment.
    const retry = await finish('min', set.id, shots, NOON + 5_000);
    expect(retry.replayed).toBe(true);
    expect(await ledger(set.id)).toHaveLength(2);
    expect(await db.prepare("SELECT gold FROM user_balances WHERE user_id = 'min'").first('gold')).toBe(goldBefore);
    await rejects(finish('min', set.id, balls(8)), 409, 'SET_CONFLICT');
  });

  it('pays nothing for a set without a goal', async () => {
    const set = await start();
    expect((await finish('min', set.id, balls(0))).current).toMatchObject({ made: 0, completed: true, points: 0, gold: 0 });
    expect(await ledger(set.id)).toEqual([]);
  });

  it('rejects incomplete sets, bad shots and other players\' sets', async () => {
    const set = await start();
    await rejects(finish('siwon', set.id, balls(3)), 404, 'SET_NOT_FOUND');
    await rejects(finishFreeThrowSet(db as unknown as D1Database, admin, { setId: set.id, shots: balls(3) }, NOON), 403, 'CANNOT_PLAY');
    for (const shots of [balls(3).slice(0, 9), [...balls(3), MAKE], [...balls(3).slice(0, 9), { power: 101, aim: 0 }], [...balls(3).slice(0, 9), { power: 50, aim: 0.5 }]]) {
      await rejects(finish('min', set.id, shots), 400, 'INVALID_SET');
    }
    await rejects(finishFreeThrowSet(db as unknown as D1Database, player('min'), { setId: 'nope', shots: balls(3) }, NOON), 400, 'INVALID_SET');
    expect(await db.prepare('SELECT shots FROM freethrow_sets').first('shots')).toBe(0);
  });

  it('records simultaneous retries of one set exactly once', async () => {
    const set = await start();
    const results = await Promise.all([finish('min', set.id, balls(4)), finish('min', set.id, balls(4)), finish('min', set.id, balls(4))]);
    expect(results.filter(result => !result.replayed).length).toBeLessThanOrEqual(1);
    expect(await db.prepare('SELECT shots, made FROM freethrow_sets').first()).toEqual({ shots: 10, made: 4 });
    expect(await db.prepare('SELECT COUNT(*) AS n FROM freethrow_shots').first('n')).toBe(10);
    expect(await ledger(set.id)).toHaveLength(2);
  });

  it('lists only recorded sets on today\'s board; a set left unrecorded ends unfinished', async () => {
    const set = await start();
    await finish('min', set.id, balls(7));
    const left = await start('siwon');
    const board = await getFreeThrowState(db as unknown as D1Database, admin, NOON);
    expect(board.today).toEqual([{ username: 'min', slot: set.slot, slotStart: set.slotStart, made: 7, completed: true }]);
    expect(board.current).toBeNull();
    // The player who left still used the slot; the set closes at its deadline.
    expect(await getFreeThrowSummary(db as unknown as D1Database, player('siwon'), NOON)).toMatchObject({ available: false, played: true, completed: false, made: 0 });
    const closed = freeThrowDeadline(left.slot);
    await rejects(finish('siwon', left.id, balls(9), closed), 409, 'SET_CLOSED');
    // A set from the old one-ball-at-a-time records is not completed later.
    await db.prepare('UPDATE freethrow_sets SET shots = 3 WHERE id = ?').bind(left.id).run();
    await rejects(finish('siwon', left.id, balls(9)), 409, 'SET_CLOSED');
  });

  it('records a set started late within the grace time, and the next slot opens on time', async () => {
    const late = SLOT_END - 60_000;
    const set = await start('min', late);
    const afterBoundary = SLOT_END + 60_000;
    expect(await getFreeThrowSummary(db as unknown as D1Database, player('min'), afterBoundary)).toMatchObject({ available: true, played: false });
    const state = await getFreeThrowState(db as unknown as D1Database, player('min'), afterBoundary);
    expect(state.current).toMatchObject({ id: set.id, completed: false, finished: false });
    expect((await finish('min', set.id, balls(2), afterBoundary)).set).toMatchObject({ id: set.id, made: 2, completed: true });
    const next = await start('min', afterBoundary, 'next');
    expect(next.slot).toBe(set.slot + 1);
  });

  it('closes sets recorded with an older engine instead of re-simulating them differently', async () => {
    const set = await start();
    await db.prepare('UPDATE freethrow_sets SET engine = 0 + ? WHERE id = ?').bind(FREETHROW_RULES.engine + 1, set.id).run();
    await rejects(finish('min', set.id, balls(3)), 409, 'ENGINE_CHANGED');
  });

  it('earns the sheet\'s free-throw achievements from official sets only', async () => {
    const keys = async (now = NOON) => (await syncAchievements(db as unknown as D1Database, 'min', new Date(now)))
      .filter(item => item.key.startsWith('freethrow')).map(item => `${item.key}:${item.periodKey}`).sort();
    expect(await keys()).toEqual([]);
    const set = await start();
    expect(await keys()).toEqual(['freethrow_join:']);
    await finish('min', set.id, balls(5));
    expect(await keys()).toEqual(['freethrow_3:2026-11-07', 'freethrow_5:2026-11-07']);
    // A second qualifying set the same day earns nothing new (one per day).
    const later = SLOT_END + FREETHROW_RULES.graceMs;
    const next = await start('min', later, 'later');
    await finish('min', next.id, balls(6), later);
    expect(await keys(later)).toEqual([]);
    // Ten goals in one set, and a full set without a goal.
    const ten = await start('min', later + FREETHROW_RULES.setIntervalMs, 'ten');
    await finish('min', ten.id, balls(10), later + FREETHROW_RULES.setIntervalMs);
    expect(await keys(later + FREETHROW_RULES.setIntervalMs)).toEqual(['freethrow_10:2026-11-07']);
    const zero = await start('min', later + 2 * FREETHROW_RULES.setIntervalMs, 'zero');
    expect(await keys(later + 2 * FREETHROW_RULES.setIntervalMs)).toEqual([]);
    await finish('min', zero.id, balls(0), later + 2 * FREETHROW_RULES.setIntervalMs);
    expect(await keys(later + 2 * FREETHROW_RULES.setIntervalMs)).toEqual(['freethrow_zero:']);
  });
});

describe('23:50 daily close', () => {
  // The 21시 slot of Sunday 2026-11-08 KST, whose grace runs past midnight.
  const at = (kst: string) => Date.parse(`${kst}+09:00`);
  it('refuses a new official set from 23:50 to midnight', async () => {
    await rejects(start('min', at('2026-11-08T23:50:00'), 'closed'), 409, 'PLAY_CLOSED');
    await rejects(start('min', at('2026-11-08T23:59:59'), 'closed-2'), 409, 'PLAY_CLOSED');
  });
  it('pays gold but no score for a set recorded after the day closed, including the grace past midnight', async () => {
    const before = await start('min', at('2026-11-08T23:40:00'), 'before');
    expect((await finish('min', before.id, balls(3), at('2026-11-08T23:45:00'))).current).toMatchObject({ made: 3, points: 3, gold: 15 });
    await db.prepare('DELETE FROM freethrow_shots').run();
    await db.prepare('DELETE FROM freethrow_sets').run();
    const late = await start('min', at('2026-11-08T23:40:00'), 'late');
    expect((await finish('min', late.id, balls(3), at('2026-11-09T00:05:00'))).set).toMatchObject({ made: 3, points: 0, gold: 15 });
    expect((await ledger(late.id)).map(row => row.currency)).toEqual(['gold']);
  });
});
