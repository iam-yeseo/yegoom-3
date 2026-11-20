import { readFile, readdir } from 'node:fs/promises';
import { Miniflare } from 'miniflare';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ARCADE_RULES, arcadeDeadline, arcadeSlot, arcadeSlotStart, freeThrowSlot, freeThrowSlotStart, type ArcadeGame } from '../shared/balance';
import { simulateEnd } from '../shared/curling-physics';
import { judgeShootout, keeperAt, penaltyKeepers, type KickInput } from '../shared/penalty-engine';
import { scoreSource } from '../shared/ranking-periods';
import { ArcadeError, finishArcadeSet, getArcadeState, getArcadeSummaries, startArcadeSet } from '../worker/arcade';

type Database = Awaited<ReturnType<Miniflare['getD1Database']>>;
const player = (id: string) => ({ id, role: 'player' as const });
const admin = { id: 'admin', role: 'admin' as const };
// 2026-11-07 13:30 KST: the curling slot that opened at 13:00, and the penalty slot that opened at 11:00.
const NOW = Date.parse('2026-11-07T04:30:00Z');
const kstHour = (time: number) => new Date(time + 9 * 3_600_000).getUTCHours();

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
  expect(error).toBeInstanceOf(ArcadeError);
  expect(error).toMatchObject({ status, code });
}
const d1 = () => db as unknown as D1Database;
const rid = (label: string) => `req-${label}-0123456789abcdef`;
async function start(game: ArcadeGame, user = 'min', now = NOW, label = 'start') {
  return (await startArcadeSet(d1(), game, player(user), { requestId: rid(`${game}-${user}-${label}`) }, now)).current!;
}
const finish = (game: ArcadeGame, user: string, setId: string, inputs: unknown[], now = NOW) => finishArcadeSet(d1(), game, player(user), { setId, inputs }, now);
/** Five stones that all stay in the house, then variants with some thrown through the back. */
const HOUSE = [{ power: 55, aim: 0 }, { power: 52, aim: -45 }, { power: 52, aim: 45 }, { power: 60, aim: -20 }, { power: 60, aim: 20 }];
const stones = (made: number) => HOUSE.map((stone, i) => (i < made ? stone : { power: 100, aim: 70 * (i % 2 ? 1 : -1) }));
/** Kicks for a slot's keepers: `made` goals away from the keeper, the rest rolled at them. */
function kicks(slot: number, made: number): KickInput[] {
  return penaltyKeepers(slot, 5).map((keeper, i) => {
    if (i >= made) return { power: 12, aim: 0, t: 500 };
    for (let t = 300; t < 6000; t += 20) for (const aim of [-66, 66]) {
      const stand = keeperAt(keeper, t);
      if (Math.sign(stand.x) === -Math.sign(aim) && Math.sign(stand.v) === -Math.sign(aim)) return { power: 74, aim, t };
    }
    throw new Error('No open moment for this keeper');
  });
}
const ledger = (game: ArcadeGame, setId: string) => db.prepare("SELECT currency, amount, reason, reference, week_start FROM ledger WHERE user_id = 'min' AND substr(reference, 1, ?) = ? ORDER BY reference")
  .bind(`${game}:set:${setId}:`.length, `${game}:set:${setId}:`).all<{ currency: string; amount: number; reason: string; reference: string; week_start: string | null }>().then(result => result.results);

beforeAll(async () => {
  mf = new Miniflare({ modules: true, script: 'export default { fetch() { return new Response("") } }', compatibilityDate: '2026-08-06', d1Databases: ['DB'] });
  db = await mf.getD1Database('DB');
  await migrate(db);
});
afterAll(async () => { await mf.dispose(); });
beforeEach(async () => {
  await db.prepare('DELETE FROM arcade_sets').run();
  await db.prepare('DELETE FROM users').run().catch(() => {});
  for (const [id, role] of [['min', 'player'], ['siwon', 'player'], ['yeseo', 'player'], ['admin', 'admin']] as const) {
    await db.prepare('INSERT OR IGNORE INTO users (id, username, display_name, password_hash, role) VALUES (?, ?, ?, ?, ?)').bind(id, id, id, 'x', role).run();
  }
});

describe('the hourly rotation of solo games', () => {
  it('opens the free throw at KST 00·03·…, curling an hour later and penalties an hour after that', () => {
    const day = Date.parse('2026-11-07T00:00:00+09:00');
    const opens = (slotOf: (now: number) => number, startOf: (slot: number) => number) =>
      [...new Set(Array.from({ length: 24 }, (_, hour) => kstHour(startOf(slotOf(day + hour * 3_600_000 + 60_000)))))].sort((a, b) => a - b);
    expect(opens(freeThrowSlot, freeThrowSlotStart)).toEqual([0, 3, 6, 9, 12, 15, 18, 21]);
    expect(opens(now => arcadeSlot('curling', now), slot => arcadeSlotStart('curling', slot))).toEqual([1, 4, 7, 10, 13, 16, 19, 22]);
    expect(opens(now => arcadeSlot('penalty', now), slot => arcadeSlotStart('penalty', slot))).toEqual([2, 5, 8, 11, 14, 17, 20, 23]);
    // A set stays open for its three hours, then ten more minutes to be recorded.
    const slot = arcadeSlot('curling', NOW);
    expect(kstHour(arcadeSlotStart('curling', slot))).toBe(13);
    expect(arcadeDeadline('curling', slot)).toBe(arcadeSlotStart('curling', slot) + 3 * 3_600_000 + ARCADE_RULES.curling.graceMs);
  });
});

describe('curling and penalty official sets', () => {
  it('derives both home tiles from one read without writing, and keeps admins to practice', async () => {
    const summaries = await getArcadeSummaries(d1(), player('min'), NOW);
    expect(summaries.curling).toEqual({ available: true, played: false, completed: false, made: 0, nextSlotAt: arcadeSlotStart('curling', arcadeSlot('curling', NOW) + 1), serverNow: NOW, isAdmin: false });
    expect(summaries.penalty).toMatchObject({ available: true, nextSlotAt: arcadeSlotStart('penalty', arcadeSlot('penalty', NOW) + 1) });
    expect(await getArcadeSummaries(d1(), admin, NOW)).toMatchObject({ curling: { available: false, isAdmin: true }, penalty: { available: false, isAdmin: true } });
    expect(await db.prepare('SELECT COUNT(*) AS n FROM arcade_sets').first('n')).toBe(0);
    await rejects(startArcadeSet(d1(), 'curling', admin, { requestId: rid('admin') }, NOW), 403, 'CANNOT_PLAY');
  });

  it('opens one set per game and slot, and a retried start returns the same set', async () => {
    const set = await start('curling');
    expect(set).toMatchObject({ tries: [], made: 0, completed: false, finished: false, engine: ARCADE_RULES.curling.engine, slotStart: arcadeSlotStart('curling', arcadeSlot('curling', NOW)) });
    expect((await start('curling')).id).toBe(set.id);
    await rejects(startArcadeSet(d1(), 'curling', player('min'), { requestId: rid('again') }, NOW + 60_000), 409, 'SET_USED');
    // The other game has its own chance, and a request number belongs to one game.
    const kick = await start('penalty');
    expect(kick.id).not.toBe(set.id);
    await rejects(startArcadeSet(d1(), 'penalty', player('min'), { requestId: rid('curling-min-start') }, NOW), 409, 'REQUEST_CONFLICT');
    const summaries = await getArcadeSummaries(d1(), player('min'), NOW);
    expect(summaries.curling).toMatchObject({ available: false, played: true, completed: false });
    expect(summaries.penalty).toMatchObject({ available: false, played: true, completed: false });
    expect(await getArcadeSummaries(d1(), player('min'), set.slotStart + 3 * 3_600_000)).toMatchObject({ curling: { available: true } });
  });

  it('settles concurrent starts with a single set', async () => {
    const results = await Promise.allSettled(['a', 'b', 'c'].map(label => startArcadeSet(d1(), 'penalty', player('min'), { requestId: rid(label) }, NOW)));
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(await db.prepare('SELECT COUNT(*) AS n FROM arcade_sets').first('n')).toBe(1);
  });

  it('simulates a curling end again on the server and pays for the stones left in the house, once', async () => {
    const set = await start('curling');
    const inputs = stones(3), expected = simulateEnd(inputs);
    expect(expected.score).toBe(3);
    const done = await finish('curling', 'min', set.id, inputs);
    expect(done.replayed).toBe(false);
    expect(done.set).toMatchObject({ made: 3, completed: true, finished: true, points: 3, gold: 30 });
    expect(done.set.tries).toEqual(expected.throws.map((result, index) => ({ index, made: expected.counted[index], kind: result.kind })));
    expect(done).toMatchObject({ game: 'curling', available: false, played: true, completed: true, made: 3 });
    expect(await ledger('curling', set.id)).toEqual([
      { currency: 'gold', amount: 30, reason: '컬링 하우스 안착', reference: `curling:set:${set.id}:gold`, week_start: null },
      { currency: 'score', amount: 3, reason: '컬링 하우스 안착', reference: `curling:set:${set.id}:score`, week_start: '2026-11-02' },
    ]);
    expect(scoreSource(`curling:set:${set.id}:score`, '')).toEqual({ game: 'curling', label: '컬링' });
    // A lost response is retried with the same end: no second payment. A different end is refused.
    expect((await finish('curling', 'min', set.id, inputs, NOW + 5_000)).replayed).toBe(true);
    expect(await ledger('curling', set.id)).toHaveLength(2);
    await rejects(finish('curling', 'min', set.id, stones(5)), 409, 'SET_CONFLICT');
  });

  it('judges penalty kicks against the keepers of the set\'s slot', async () => {
    const set = await start('penalty');
    const inputs = kicks(set.slot, 4), expected = judgeShootout(set.slot, inputs);
    expect(expected.goals).toBe(4);
    const done = await finish('penalty', 'min', set.id, inputs);
    expect(done.set).toMatchObject({ made: 4, completed: true, points: 4, gold: 40 });
    expect(done.set.tries.map(entry => entry.kind)).toEqual(expected.kicks.map(kick => kick.kind));
    expect((await ledger('penalty', set.id)).map(row => [row.currency, row.amount, row.reason])).toEqual([['gold', 40, '승부차기 골'], ['score', 4, '승부차기 골']]);
    expect(scoreSource(`penalty:set:${set.id}:score`, '')).toEqual({ game: 'penalty', label: '승부차기' });
    // The same kicks against another slot's keepers are a different set: nothing is taken from the client.
    expect(judgeShootout(set.slot + 1, inputs).kicks.map(kick => kick.kind)).not.toEqual(expected.kicks.map(kick => kick.kind));
  });

  it('simulates the sweeping that was recorded with each stone, and refuses sweeping it cannot have happened', async () => {
    const set = await start('curling');
    // Five weak throws stop short of the house; brushed all the way, the first reaches it.
    const weak = Array.from({ length: 5 }, (_, i) => ({ power: 40, aim: [0, -60, 60, -30, 30][i]! }));
    expect(simulateEnd(weak).counted[0]).toBe(false);
    const brushed = simulateEnd([{ ...weak[0]!, sweep: [0, 600] }, ...weak.slice(1)]);
    expect(brushed.counted[0]).toBe(true);
    const inputs = brushed.throws.map(result => result.input);
    await rejects(finish('curling', 'min', set.id, [{ ...weak[0]!, sweep: [30, 10] }, ...weak.slice(1)]), 400, 'INVALID_SET');
    await rejects(finish('curling', 'min', set.id, [{ ...weak[0]!, sweep: [0, 9999] }, ...weak.slice(1)]), 400, 'INVALID_SET');
    const done = await finish('curling', 'min', set.id, inputs);
    expect(done.set.made).toBe(brushed.score);
    expect(done.set.tries[0]).toMatchObject({ made: true, kind: brushed.throws[0]!.kind });
    expect(JSON.parse(await db.prepare('SELECT inputs_json FROM arcade_sets WHERE id = ?').bind(set.id).first('inputs_json') as string)[0].sweep).toEqual(inputs[0]!.sweep);
    // The same throws without the sweeping are a different end.
    await rejects(finish('curling', 'min', set.id, weak), 409, 'SET_CONFLICT');
  });

  it('pays nothing for a set without a score', async () => {
    const set = await start('curling');
    expect((await finish('curling', 'min', set.id, stones(0))).set).toMatchObject({ made: 0, completed: true, points: 0, gold: 0 });
    expect(await ledger('curling', set.id)).toEqual([]);
  });

  it('rejects incomplete sets, bad inputs, the other game\'s inputs and other players\' sets', async () => {
    const set = await start('curling');
    await rejects(finish('curling', 'siwon', set.id, stones(3)), 404, 'SET_NOT_FOUND');
    await rejects(finish('penalty', 'min', set.id, kicks(set.slot, 2)), 404, 'SET_NOT_FOUND');
    await rejects(finishArcadeSet(d1(), 'curling', admin, { setId: set.id, inputs: stones(3) }, NOW), 403, 'CANNOT_PLAY');
    for (const inputs of [stones(3).slice(0, 4), [...stones(3), HOUSE[0]], [...stones(3).slice(0, 4), { power: 101, aim: 0 }], [...stones(3).slice(0, 4), { power: 50, aim: 0.5 }], [...stones(3).slice(0, 4), null]]) {
      await rejects(finish('curling', 'min', set.id, inputs), 400, 'INVALID_SET');
    }
    await rejects(finishArcadeSet(d1(), 'curling', player('min'), { setId: 'nope', inputs: stones(3) }, NOW), 400, 'INVALID_SET');
    const kick = await start('penalty');
    await rejects(finish('penalty', 'min', kick.id, stones(3)), 400, 'INVALID_SET');
    await rejects(finish('penalty', 'min', kick.id, [...kicks(kick.slot, 2).slice(0, 4), { power: 50, aim: 10, t: -1 }]), 400, 'INVALID_SET');
    expect((await db.prepare('SELECT SUM(tries) AS n FROM arcade_sets').first('n'))).toBe(0);
  });

  it('records simultaneous retries of one set exactly once', async () => {
    const set = await start('curling');
    const results = await Promise.all([1, 2, 3].map(() => finish('curling', 'min', set.id, stones(4))));
    expect(results.filter(result => !result.replayed).length).toBeLessThanOrEqual(1);
    expect(await db.prepare('SELECT tries, made FROM arcade_sets').first()).toEqual({ tries: 5, made: 4 });
    expect(await ledger('curling', set.id)).toHaveLength(2);
  });

  it('lists only recorded sets on today\'s board; a set left unrecorded ends unfinished', async () => {
    const set = await start('curling');
    await finish('curling', 'min', set.id, stones(2));
    const left = await start('curling', 'siwon');
    const board = await getArcadeState(d1(), 'curling', admin, NOW);
    expect(board.today).toEqual([{ username: 'min', slot: set.slot, slotStart: set.slotStart, made: 2, completed: true }]);
    expect(board.current).toBeNull();
    expect((await getArcadeState(d1(), 'penalty', admin, NOW)).today).toEqual([]);
    await rejects(finish('curling', 'siwon', left.id, stones(5), arcadeDeadline('curling', left.slot)), 409, 'SET_CLOSED');
  });

  it('records a set started late within the grace time, while the next slot opens on time', async () => {
    const end = arcadeSlotStart('penalty', arcadeSlot('penalty', NOW) + 1);
    const set = await start('penalty', 'min', end - 60_000);
    expect((await getArcadeSummaries(d1(), player('min'), end + 60_000)).penalty).toMatchObject({ available: true, played: false });
    expect((await getArcadeState(d1(), 'penalty', player('min'), end + 60_000)).current).toMatchObject({ id: set.id, completed: false, finished: false });
    expect((await finish('penalty', 'min', set.id, kicks(set.slot, 1), end + 60_000)).set).toMatchObject({ id: set.id, made: 1, completed: true });
    expect((await start('penalty', 'min', end + 60_000, 'next')).id).not.toBe(set.id);
  });

  it('counts a set for the KST day it was started on, even in a slot that began the day before', async () => {
    // Curling's last slot of the day runs 22:00–01:00. Started after midnight it belongs to the new day.
    const afterMidnight = Date.parse('2026-11-08T00:20:00+09:00');
    expect(kstHour(arcadeSlotStart('curling', arcadeSlot('curling', afterMidnight)))).toBe(22);
    const set = await start('curling', 'min', afterMidnight);
    expect(await db.prepare('SELECT date FROM arcade_sets WHERE id = ?').bind(set.id).first('date')).toBe('2026-11-08');
    expect((await finish('curling', 'min', set.id, stones(2), afterMidnight + 120_000)).set).toMatchObject({ points: 2, gold: 20 });
    // Started before the 23:50 close but recorded after it: gold, no score.
    const late = await start('curling', 'siwon', Date.parse('2026-11-07T23:45:00+09:00'));
    const done = await finishArcadeSet(d1(), 'curling', player('siwon'), { setId: late.id, inputs: stones(3) }, Date.parse('2026-11-07T23:55:00+09:00'));
    expect(done.set).toMatchObject({ made: 3, points: 0, gold: 30 });
    // Nothing starts in the last ten minutes of the day.
    await rejects(startArcadeSet(d1(), 'curling', player('yeseo'), { requestId: rid('closed') }, Date.parse('2026-11-07T23:55:00+09:00')), 409, 'PLAY_CLOSED');
  });

  it('closes a set started on an older engine', async () => {
    const set = await start('curling');
    await db.prepare('UPDATE arcade_sets SET engine = engine + 1 WHERE id = ?').bind(set.id).run();
    await rejects(finish('curling', 'min', set.id, stones(3)), 409, 'ENGINE_CHANGED');
  });

  it('stops a player who was deactivated mid-set', async () => {
    const set = await start('curling');
    await db.prepare("UPDATE users SET active = 0 WHERE id = 'min'").run();
    await rejects(finish('curling', 'min', set.id, stones(3)), 403, 'CANNOT_PLAY');
    expect(await ledger('curling', set.id)).toEqual([]);
  });
});
