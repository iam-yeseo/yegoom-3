import { readFile, readdir } from 'node:fs/promises';
import { Miniflare } from 'miniflare';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { SANTA_RULES, santaDeadline, santaSlot, santaSlotStart } from '../shared/balance';
import { scoreSource } from '../shared/ranking-periods';
import { idealRelease, santaCourse } from '../shared/santa-engine';
import { SantaError, finishSantaRun, getSantaState, getSantaSummary, startSantaRun } from '../worker/santa';

type Database = Awaited<ReturnType<Miniflare['getD1Database']>>;
const player = (id: string) => ({ id, role: 'player' as const });
const admin = { id: 'admin', role: 'admin' as const };
// 2026-12-01 09:30 KST: the 오전 slot.
const MORNING = Date.parse('2026-12-01T09:30:00+09:00');
const SLOT = santaSlot(MORNING);
const NOON = santaSlotStart(SLOT + 1);
const COURSE = santaCourse(SLOT);

let mf: Miniflare; let db: Database;
const d1 = () => db as unknown as D1Database;
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
  expect(error).toBeInstanceOf(SantaError);
  expect(error).toMatchObject({ status, code });
}
const rid = (label: string) => `req-${label}-0123456789abcdef`;
async function start(user = 'min', now = MORNING, label = 'start') {
  const state = await startSantaRun(d1(), player(user), { requestId: rid(`${user}-${label}`) }, now);
  return state.current!;
}
const finish = (user: string, runId: string, releases: number[], now = MORNING) =>
  finishSantaRun(d1(), player(user), { runId, releases }, now);
const hit = (index: number, slot = SLOT) => idealRelease(santaCourse(slot)[index]!);
/** The first `hits` houses get a perfect drop, the rest are passed. */
const plan = (hits: number, slot = SLOT) => Array.from({ length: SANTA_RULES.houses }, (_, i) => (i < hits ? hit(i, slot) : -1));
const ledger = (runId: string) => db.prepare("SELECT currency, amount, reason, reference, week_start FROM ledger WHERE user_id = 'min' AND reference LIKE ? ORDER BY reference")
  .bind(`santa:%${runId}%`).all<{ currency: string; amount: number; reason: string; reference: string; week_start: string | null }>().then(result => result.results);

beforeAll(async () => {
  mf = new Miniflare({ modules: true, script: 'export default { fetch() { return new Response("") } }', compatibilityDate: '2026-08-06', d1Databases: ['DB'] });
  db = await mf.getD1Database('DB');
  await migrate(db);
});
afterAll(async () => { await mf.dispose(); });
beforeEach(async () => {
  for (const table of ['santa_drops', 'santa_runs']) await db.prepare(`DELETE FROM ${table}`).run();
  await db.prepare('DELETE FROM users').run().catch(() => {});
  for (const [id, role] of [['min', 'player'], ['siwon', 'player'], ['admin', 'admin']] as const) {
    await db.prepare('INSERT OR IGNORE INTO users (id, username, display_name, password_hash, role) VALUES (?, ?, ?, ?, ?)').bind(id, id, id, 'x', role).run();
  }
});

describe('santa runs', () => {
  it('derives availability without writing and keeps admins out', async () => {
    expect(await getSantaSummary(d1(), player('min'), MORNING)).toEqual({
      open: true, available: true, played: false, completed: false, hits: 0, nextSlotAt: NOON, endsAt: SANTA_RULES.endsAt, serverNow: MORNING, isAdmin: false });
    expect(await getSantaSummary(d1(), admin, MORNING)).toMatchObject({ available: false, isAdmin: true });
    expect(await db.prepare('SELECT COUNT(*) AS n FROM santa_runs').first('n')).toBe(0);
    await rejects(startSantaRun(d1(), admin, { requestId: rid('admin') }, MORNING), 403, 'CANNOT_PLAY');
  });

  it('opens one run per half day, and a retried start returns the same run', async () => {
    const run = await start();
    expect(run).toMatchObject({ drops: [], hits: 0, completed: false, finished: false, slotStart: santaSlotStart(SLOT), deadline: NOON + SANTA_RULES.graceMs, engine: SANTA_RULES.engine });
    expect((await start()).id).toBe(run.id);
    await rejects(startSantaRun(d1(), player('min'), { requestId: rid('again') }, MORNING + 60_000), 409, 'RUN_USED');
    expect(await getSantaSummary(d1(), player('min'), MORNING)).toMatchObject({ available: false, played: true, completed: false });
    expect(await db.prepare('SELECT date FROM santa_runs').first('date')).toBe('2026-12-01');
  });

  it('records the whole run at once: a point per chimney, the perfect bonus and 100G', async () => {
    const run = await start();
    const done = await finish('min', run.id, plan(10));
    expect(done.replayed).toBe(false);
    expect(done.run).toMatchObject({ hits: 10, completed: true, finished: true, points: 13, gold: 100 });
    expect(done.run.drops.map(entry => entry.kind)).toEqual(Array(10).fill('in'));
    expect(done).toMatchObject({ available: false, played: true, completed: true, hits: 10 });
    expect(await ledger(run.id)).toEqual([
      { currency: 'gold', amount: 100, reason: '산타 선물 배달 완료', reference: `santa:clear:${run.id}:gold`, week_start: null },
      { currency: 'score', amount: 10, reason: '산타 선물 배달', reference: `santa:hits:${run.id}:score`, week_start: '2026-11-30' },
      { currency: 'score', amount: 3, reason: '산타 선물 배달 · 10곳 모두 성공', reference: `santa:perfect:${run.id}:score`, week_start: '2026-11-30' },
    ]);
    expect(scoreSource(`santa:hits:${run.id}:score`, '산타 선물 배달')).toEqual({ game: 'santa', label: '산타 선물 배달' });
    expect(scoreSource(`santa:perfect:${run.id}:score`, 'x')).toEqual({ game: 'santa', label: '산타 선물 배달 · 10곳 모두 성공' });
    // A lost response is retried with the same run: no second payment; a different one is refused.
    expect((await finish('min', run.id, plan(10), MORNING + 5000)).replayed).toBe(true);
    expect(await ledger(run.id)).toHaveLength(3);
    await rejects(finish('min', run.id, plan(9)), 409, 'RUN_CONFLICT');
  });

  it('pays 100G for a finished run even with no hits, and no perfect bonus for 9 of 10', async () => {
    const zero = await start();
    expect((await finish('min', zero.id, Array(10).fill(0))).run).toMatchObject({ hits: 0, completed: true, points: 0, gold: 100 });
    expect(await ledger(zero.id)).toEqual([{ currency: 'gold', amount: 100, reason: '산타 선물 배달 완료', reference: `santa:clear:${zero.id}:gold`, week_start: null }]);
    const nine = await start('min', NOON + 1000, 'nine');
    const done = await finish('min', nine.id, plan(9, SLOT + 1), NOON + 2000);
    expect(done.run).toMatchObject({ hits: 9, points: 9, gold: 100 });
    expect((await ledger(nine.id)).some(row => row.reference.startsWith('santa:perfect:'))).toBe(false);
  });

  it('refuses incomplete or invalid runs and other players\' runs', async () => {
    const run = await start();
    for (const releases of [plan(3).slice(0, 9), [...plan(3), 0], [...plan(3).slice(0, 9), 1.5], [...plan(3).slice(0, 9), santaCourse(SLOT)[9]!.approachMs + 1], [...plan(3).slice(0, 9), -2]]) {
      await rejects(finish('min', run.id, releases), 400, 'INVALID_RUN');
    }
    await rejects(finish('siwon', run.id, plan(3)), 404, 'RUN_NOT_FOUND');
    await rejects(finishSantaRun(d1(), admin, { runId: run.id, releases: plan(3) }, MORNING), 403, 'CANNOT_PLAY');
    expect(await db.prepare('SELECT drops FROM santa_runs').first('drops')).toBe(0);
  });

  it('records simultaneous retries of one run exactly once', async () => {
    const run = await start();
    const results = await Promise.all([finish('min', run.id, plan(4)), finish('min', run.id, plan(4)), finish('min', run.id, plan(4))]);
    expect(results.filter(result => !result.replayed).length).toBeLessThanOrEqual(1);
    expect(await db.prepare('SELECT drops, hits FROM santa_runs').first()).toEqual({ drops: 10, hits: 4 });
    expect(await db.prepare('SELECT COUNT(*) AS n FROM santa_drops').first('n')).toBe(10);
    expect(await ledger(run.id)).toHaveLength(2);
  });

  it('a run left unrecorded ends unfinished; a late start may be recorded within the grace time', async () => {
    const lastMinute = NOON - 60_000;
    const late = await start('min', lastMinute);
    // In the 오후 half day a new run may start while the late one can still be recorded.
    expect(await getSantaSummary(d1(), player('min'), NOON + 1000)).toMatchObject({ available: true, played: false });
    expect((await finish('min', late.id, plan(2), NOON + 30_000)).run).toMatchObject({ id: late.id, hits: 2, completed: true });
    const left = await start('siwon', MORNING);
    await rejects(finish('siwon', left.id, plan(2), santaDeadline(SLOT)), 409, 'RUN_CLOSED');
    // A run from the old one-house-at-a-time records is not completed later.
    await db.prepare('UPDATE santa_runs SET drops = 1 WHERE id = ?').bind(left.id).run();
    await rejects(finish('siwon', left.id, plan(2)), 409, 'RUN_CLOSED');
  });

  it('refuses new runs after Christmas and during the 23:50 close, and scores nothing recorded after it', async () => {
    await rejects(startSantaRun(d1(), player('min'), { requestId: rid('late') }, SANTA_RULES.endsAt), 409, 'EVENT_CLOSED');
    expect(await getSantaSummary(d1(), player('min'), SANTA_RULES.endsAt)).toMatchObject({ open: false, available: false });
    await rejects(startSantaRun(d1(), player('min'), { requestId: rid('closed') }, Date.parse('2026-12-01T23:55:00+09:00')), 409, 'PLAY_CLOSED');
    const evening = Date.parse('2026-12-01T23:49:00+09:00');
    const run = await start('min', evening, 'evening');
    const done = await finish('min', run.id, plan(10, santaSlot(evening)), Date.parse('2026-12-01T23:51:00+09:00'));
    expect(done.run).toMatchObject({ hits: 10, points: 0, gold: 100 });
    expect((await ledger(run.id)).map(row => row.currency)).toEqual(['gold']);
  });

  it('shows only recorded runs on today\'s board', async () => {
    const mine = await start();
    await finish('min', mine.id, plan(6));
    await start('siwon');
    const state = await getSantaState(d1(), admin, MORNING);
    expect(state.today).toEqual([{ username: 'min', slot: SLOT, slotStart: santaSlotStart(SLOT), hits: 6, completed: true }]);
    expect(state.current).toBeNull();
  });
});
