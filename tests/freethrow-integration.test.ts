import { readFile, readdir } from 'node:fs/promises';
import { Miniflare } from 'miniflare';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { FREETHROW_RULES, freeThrowDeadline, freeThrowSlot, freeThrowSlotStart } from '../shared/balance';
import { simulateShot } from '../shared/freethrow-physics';
import { scoreSource } from '../shared/ranking-periods';
import { FreeThrowError, getFreeThrowState, getFreeThrowSummary, shootFreeThrow, startFreeThrowSet } from '../worker/freethrow';

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
const shoot = (user: string, setId: string, index: number, input: { power: number; aim: number }, now = NOON) =>
  shootFreeThrow(db as unknown as D1Database, player(user), { setId, index, ...input }, now);
// The ledger is append-only, so rows are scoped to the set under test.
const ledger = (setId: string) => db.prepare("SELECT currency, amount, reason, reference, week_start FROM ledger WHERE user_id = 'min' AND substr(reference, 1, ?) = ? ORDER BY reference")
  .bind(`freethrow:goal:${setId}:`.length, `freethrow:goal:${setId}:`).all<{ currency: string; amount: number; reason: string; reference: string; week_start: string | null }>().then(result => result.results);

beforeAll(async () => {
  mf = new Miniflare({ modules: true, script: 'export default { fetch() { return new Response("") } }', compatibilityDate: '2026-08-06', d1Databases: ['DB'] });
  db = await mf.getD1Database('DB');
  await migrate(db);
});
afterAll(async () => { await mf.dispose(); });
beforeEach(async () => {
  for (const table of ['freethrow_shots', 'freethrow_sets']) await db.prepare(`DELETE FROM ${table}`).run();
  await db.prepare('DELETE FROM users').run().catch(() => {});
  for (const [id, role] of [['min', 'player'], ['siwon', 'player'], ['yeseo', 'player'], ['admin', 'admin']] as const) {
    await db.prepare('INSERT OR IGNORE INTO users (id, username, display_name, password_hash, role) VALUES (?, ?, ?, ?, ?)').bind(id, id, id, 'x', role).run();
  }
});

describe('free-throw official sets', () => {
  it('derives availability without writing and keeps admins to practice', async () => {
    expect(await getFreeThrowSummary(db as unknown as D1Database, player('min'), NOON)).toEqual({
      available: true, inProgress: false, made: 0, shots: 0, nextSlotAt: SLOT_END, serverNow: NOON, isAdmin: false });
    expect(await getFreeThrowSummary(db as unknown as D1Database, admin, NOON)).toMatchObject({ available: false, isAdmin: true });
    expect(await db.prepare('SELECT COUNT(*) AS n FROM freethrow_sets').first('n')).toBe(0);
    await rejects(startFreeThrowSet(db as unknown as D1Database, admin, { requestId: rid('admin') }, NOON), 403, 'CANNOT_PLAY');
  });

  it('opens one set per three-hour slot, and a retried start returns the same set', async () => {
    const set = await start();
    expect(set).toMatchObject({ shots: [], made: 0, finished: false, slotStart: freeThrowSlotStart(freeThrowSlot(NOON)), deadline: SLOT_END + FREETHROW_RULES.graceMs, engine: FREETHROW_RULES.engine });
    expect((await start()).id).toBe(set.id);
    await rejects(startFreeThrowSet(db as unknown as D1Database, player('min'), { requestId: rid('again') }, NOON + 60_000), 409, 'SET_USED');
    const summary = await getFreeThrowSummary(db as unknown as D1Database, player('min'), NOON);
    expect(summary).toMatchObject({ available: false, inProgress: true });
    // KST 15:00 opens the next slot.
    expect(await getFreeThrowSummary(db as unknown as D1Database, player('siwon'), SLOT_END)).toMatchObject({ available: true });
    expect(await db.prepare('SELECT date FROM freethrow_sets').first('date')).toBe('2026-11-07');
  });

  it('settles concurrent starts with a single set', async () => {
    const results = await Promise.allSettled(['a', 'b', 'c'].map(label => startFreeThrowSet(db as unknown as D1Database, player('min'), { requestId: rid(label) }, NOON)));
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(await db.prepare('SELECT COUNT(*) AS n FROM freethrow_sets').first('n')).toBe(1);
  });

  it('re-simulates each shot on the server and pays 1 point + 5G per goal once', async () => {
    const set = await start();
    const goal = await shoot('min', set.id, 0, MAKE);
    expect(goal.shot).toEqual({ index: 0, ...MAKE, made: true, kind: simulateShot(MAKE).kind, points: 1, gold: 5 });
    expect(goal.replayed).toBe(false);
    expect(goal.current).toMatchObject({ made: 1, points: 1, gold: 5 });
    expect(await ledger(set.id)).toEqual([
      { currency: 'gold', amount: 5, reason: '자유투 대결 골', reference: `freethrow:goal:${set.id}:0:gold`, week_start: null },
      { currency: 'score', amount: 1, reason: '자유투 대결 골', reference: `freethrow:goal:${set.id}:0:score`, week_start: '2026-11-02' },
    ]);
    expect(scoreSource(`freethrow:goal:${set.id}:0:score`, '')).toEqual({ game: 'freethrow', label: '자유투 대결' });
    const goldBefore = await db.prepare("SELECT gold FROM user_balances WHERE user_id = 'min'").first('gold');
    // A lost response is retried with the same shot: no second simulation or payment.
    const retry = await shoot('min', set.id, 0, MAKE, NOON + 5_000);
    expect(retry.replayed).toBe(true);
    expect(retry.shot.made).toBe(true);
    expect(await ledger(set.id)).toHaveLength(2);
    expect(await db.prepare("SELECT gold FROM user_balances WHERE user_id = 'min'").first('gold')).toBe(goldBefore);
    const miss = await shoot('min', set.id, 1, MISS);
    expect(miss.shot).toMatchObject({ made: false, kind: 'short', points: 0, gold: 0 });
    expect(await ledger(set.id)).toHaveLength(2);
  });

  it('rejects changed retries, skipped balls and other players\' sets', async () => {
    const set = await start();
    await shoot('min', set.id, 0, MAKE);
    await rejects(shoot('min', set.id, 0, { power: 56, aim: 0 }), 409, 'SHOT_CONFLICT');
    await rejects(shoot('min', set.id, 2, MAKE), 409, 'SHOT_ORDER');
    await rejects(shoot('siwon', set.id, 1, MAKE), 404, 'SET_NOT_FOUND');
    await rejects(shootFreeThrow(db as unknown as D1Database, admin, { setId: set.id, index: 1, ...MAKE }, NOON), 403, 'CANNOT_PLAY');
    for (const bad of [{ setId: 'nope', index: 1, ...MAKE }, { setId: set.id, index: 10, ...MAKE }, { setId: set.id, index: 1, power: 101, aim: 0 }, { setId: set.id, index: 1, power: 50, aim: 0.5 }]) {
      await rejects(shootFreeThrow(db as unknown as D1Database, player('min'), bad, NOON), 400, 'INVALID_SHOT');
    }
  });

  it('records simultaneous retries of one ball exactly once', async () => {
    const set = await start();
    const results = await Promise.all([shoot('min', set.id, 0, MAKE), shoot('min', set.id, 0, MAKE), shoot('min', set.id, 0, MAKE)]);
    expect(results.filter(result => !result.replayed).length).toBeLessThanOrEqual(1);
    expect(await db.prepare('SELECT shots, made FROM freethrow_sets').first()).toEqual({ shots: 1, made: 1 });
    expect(await ledger(set.id)).toHaveLength(2);
  });

  it('finishes after ten balls and lists everyone\'s sets on today\'s board', async () => {
    const set = await start();
    let state = null as Awaited<ReturnType<typeof shoot>> | null;
    for (let index = 0; index < FREETHROW_RULES.shotsPerSet; index++) state = await shoot('min', set.id, index, index < 7 ? MAKE : MISS);
    expect(state!.current).toMatchObject({ made: 7, finished: true, points: 7, gold: 35 });
    expect(state!.current!.shots).toHaveLength(10);
    expect(state).toMatchObject({ available: false, inProgress: false, made: 7, shots: 10 });
    await rejects(shoot('min', set.id, 10 - 1, MAKE), 409, 'SHOT_CONFLICT');
    const other = await start('siwon');
    await shoot('siwon', other.id, 0, MAKE);
    const board = await getFreeThrowState(db as unknown as D1Database, admin, NOON);
    expect(board.today).toEqual([
      { username: 'min', slot: set.slot, slotStart: set.slotStart, made: 7, shots: 10, finished: true },
      { username: 'siwon', slot: set.slot, slotStart: set.slotStart, made: 1, shots: 1, finished: false },
    ]);
    expect(board.current).toBeNull();
  });

  it('lets a set started late finish within the grace time, then closes it', async () => {
    const late = SLOT_END - 60_000;
    const set = await start('min', late);
    await shoot('min', set.id, 0, MAKE, late);
    const afterBoundary = SLOT_END + 60_000;
    // The unfinished set still belongs to the player and blocks a new one.
    const summary = await getFreeThrowSummary(db as unknown as D1Database, player('min'), afterBoundary);
    expect(summary).toMatchObject({ available: false, inProgress: true, shots: 1 });
    await rejects(startFreeThrowSet(db as unknown as D1Database, player('min'), { requestId: rid('next') }, afterBoundary), 409, 'SET_IN_PROGRESS');
    expect((await shoot('min', set.id, 1, MAKE, afterBoundary)).current!.made).toBe(2);
    const closed = freeThrowDeadline(set.slot);
    await rejects(shoot('min', set.id, 2, MAKE, closed), 409, 'SET_CLOSED');
    expect(await getFreeThrowSummary(db as unknown as D1Database, player('min'), closed)).toMatchObject({ available: true, inProgress: false });
    const next = await start('min', closed, 'next');
    expect(next.slot).toBe(set.slot + 1);
    const state = await getFreeThrowState(db as unknown as D1Database, player('min'), closed);
    expect(state.today.find(entry => entry.slot === set.slot)).toMatchObject({ made: 2, shots: 2, finished: true });
  });

  it('closes sets recorded with an older engine instead of re-simulating them differently', async () => {
    const set = await start();
    await db.prepare('UPDATE freethrow_sets SET engine = 0 + ? WHERE id = ?').bind(FREETHROW_RULES.engine + 1, set.id).run();
    await rejects(shoot('min', set.id, 0, MAKE), 409, 'ENGINE_CHANGED');
  });
});
