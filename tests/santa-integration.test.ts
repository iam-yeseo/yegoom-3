import { readFile, readdir } from 'node:fs/promises';
import { Miniflare } from 'miniflare';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { SANTA_RULES, santaDeadline, santaSlot, santaSlotStart } from '../shared/balance';
import { scoreSource } from '../shared/ranking-periods';
import { idealRelease, santaCourse } from '../shared/santa-engine';
import { SantaError, dropSantaGift, getSantaState, getSantaSummary, startSantaRun } from '../worker/santa';

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
const drop = (user: string, runId: string, index: number, release: number, now = MORNING) =>
  dropSantaGift(d1(), player(user), { runId, index, release }, now);
const hit = (index: number, slot = SLOT) => idealRelease(santaCourse(slot)[index]!);
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
      open: true, available: true, inProgress: false, hits: 0, drops: 0, nextSlotAt: NOON, endsAt: SANTA_RULES.endsAt, serverNow: MORNING, isAdmin: false });
    expect(await getSantaSummary(d1(), admin, MORNING)).toMatchObject({ available: false, isAdmin: true });
    expect(await db.prepare('SELECT COUNT(*) AS n FROM santa_runs').first('n')).toBe(0);
    await rejects(startSantaRun(d1(), admin, { requestId: rid('admin') }, MORNING), 403, 'CANNOT_PLAY');
  });

  it('opens one run per half day, and a retried start returns the same run', async () => {
    const run = await start();
    expect(run).toMatchObject({ drops: [], hits: 0, finished: false, completed: false, slotStart: santaSlotStart(SLOT), deadline: NOON + SANTA_RULES.graceMs, engine: SANTA_RULES.engine });
    expect((await start()).id).toBe(run.id);
    await rejects(startSantaRun(d1(), player('min'), { requestId: rid('again') }, MORNING + 60_000), 409, 'RUN_USED');
    expect(await getSantaSummary(d1(), player('min'), MORNING)).toMatchObject({ available: false, inProgress: true });
    expect(await db.prepare('SELECT date FROM santa_runs').first('date')).toBe('2026-12-01');
  });

  it('pays a point per chimney, the perfect bonus, and 100G for finishing', async () => {
    const run = await start();
    let response;
    for (let index = 0; index < SANTA_RULES.houses; index++) {
      response = await drop('min', run.id, index, hit(index), MORNING + index * 3000);
      expect(response.drop).toMatchObject({ index, hit: true, kind: 'in', points: 1 });
    }
    expect(response!.current).toMatchObject({ hits: 10, completed: true, finished: true, points: 13, gold: 100 });
    expect(response!).toMatchObject({ available: false, inProgress: false, hits: 10, drops: 10 });
    const rows = await ledger(run.id);
    expect(rows.filter(row => row.currency === 'score').reduce((sum, row) => sum + row.amount, 0)).toBe(13);
    expect(rows.filter(row => row.currency === 'gold')).toEqual([
      { currency: 'gold', amount: 100, reason: '산타 선물 배달 완료', reference: `santa:clear:${run.id}:gold`, week_start: null }]);
    expect(rows.find(row => row.reference.startsWith('santa:perfect:'))).toMatchObject({ amount: 3 });
    expect(scoreSource(`santa:hit:${run.id}:0:score`, '산타 선물 배달')).toEqual({ game: 'santa', label: '산타 선물 배달' });
    expect(scoreSource(`santa:perfect:${run.id}:score`, 'x')).toEqual({ game: 'santa', label: '산타 선물 배달 · 10곳 모두 성공' });
    await rejects(drop('min', run.id, 9, hit(9) + 1), 409, 'DROP_CONFLICT');
  });

  it('pays 100G for a finished run even with no hits, and passes count as drops', async () => {
    const run = await start();
    for (let index = 0; index < SANTA_RULES.houses; index++) await drop('min', run.id, index, index % 2 ? -1 : 0);
    const state = await getSantaState(d1(), player('min'), MORNING);
    expect(state.current).toMatchObject({ hits: 0, completed: true, points: 0, gold: 100 });
    expect(state.current!.drops.map(entry => entry.kind)).toEqual(['early', 'pass', 'early', 'pass', 'early', 'pass', 'early', 'pass', 'early', 'pass']);
    const rows = await ledger(run.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ currency: 'gold', amount: 100 });
  });

  it('no perfect bonus for 9 of 10', async () => {
    const run = await start();
    for (let index = 0; index < SANTA_RULES.houses; index++) await drop('min', run.id, index, index === 4 ? -1 : hit(index));
    const state = await getSantaState(d1(), player('min'), MORNING);
    expect(state.current).toMatchObject({ hits: 9, points: 9, gold: 100 });
    expect((await ledger(run.id)).some(row => row.reference.startsWith('santa:perfect:'))).toBe(false);
  });

  it('replays a lost response, refuses out of order or invalid releases', async () => {
    const run = await start();
    const first = await drop('min', run.id, 0, hit(0));
    const again = await drop('min', run.id, 0, hit(0));
    expect(again.replayed).toBe(true);
    expect(again.drop).toEqual(first.drop);
    expect((await ledger(run.id)).length).toBe(1);
    await rejects(drop('min', run.id, 2, hit(2)), 409, 'DROP_ORDER');
    await rejects(drop('min', run.id, 1, COURSE[1]!.approachMs + 1), 400, 'INVALID_DROP');
    await rejects(drop('min', run.id, 1, 3.5), 400, 'INVALID_DROP');
    await rejects(drop('siwon', run.id, 1, hit(1)), 404, 'RUN_NOT_FOUND');
    await rejects(dropSantaGift(d1(), admin, { runId: run.id, index: 1, release: hit(1) }, MORNING), 403, 'CANNOT_PLAY');
  });

  it('lets a late run finish within the grace time, then closes it', async () => {
    const lastMinute = NOON - 60_000;
    const run = await start('min', lastMinute);
    await drop('min', run.id, 0, hit(0), lastMinute);
    // In the 오후 slot the 오전 run is still open, so no new run yet.
    expect(await getSantaSummary(d1(), player('min'), NOON + 1000)).toMatchObject({ available: false, inProgress: true });
    await rejects(startSantaRun(d1(), player('min'), { requestId: rid('noon') }, NOON + 1000), 409, 'RUN_IN_PROGRESS');
    await drop('min', run.id, 1, hit(1), NOON + 1000);
    const deadline = santaDeadline(SLOT);
    await rejects(drop('min', run.id, 2, hit(2), deadline), 409, 'RUN_CLOSED');
    const after = await getSantaState(d1(), player('min'), deadline);
    expect(after.available).toBe(true);
    expect(after.current).toBeNull();
    // The unfinished run never pays the completion gold.
    expect((await ledger(run.id)).filter(row => row.currency === 'gold')).toHaveLength(0);
  });

  it('refuses new runs after Christmas and during the 23:50 close', async () => {
    await rejects(startSantaRun(d1(), player('min'), { requestId: rid('late') }, SANTA_RULES.endsAt), 409, 'EVENT_CLOSED');
    expect(await getSantaSummary(d1(), player('min'), SANTA_RULES.endsAt)).toMatchObject({ open: false, available: false });
    await rejects(startSantaRun(d1(), player('min'), { requestId: rid('closed') }, Date.parse('2026-12-01T23:55:00+09:00')), 409, 'PLAY_CLOSED');
  });

  it('shows everyone\'s runs today on the board', async () => {
    const mine = await start();
    await drop('min', mine.id, 0, hit(0));
    const theirs = await start('siwon');
    await drop('siwon', theirs.id, 0, -1);
    const state = await getSantaState(d1(), admin, MORNING);
    expect(state.today).toEqual([
      { username: 'min', slot: SLOT, slotStart: santaSlotStart(SLOT), hits: 1, drops: 1, finished: false },
      { username: 'siwon', slot: SLOT, slotStart: santaSlotStart(SLOT), hits: 0, drops: 1, finished: false },
    ]);
    expect(state.current).toBeNull();
  });
});
