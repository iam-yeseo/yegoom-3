import { readFile, readdir } from 'node:fs/promises';
import { Miniflare } from 'miniflare';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { TOILET_RULES } from '../shared/balance';
import { scoreSource } from '../shared/ranking-periods';
import type { ToiletResponse } from '../shared/types';
import { ToiletError, readToiletSummary, toiletRoute } from '../worker/toilet';

type Database = Awaited<ReturnType<Miniflare['getD1Database']>>;
const player = (id: string) => ({ id, role: 'player' as const });
const admin = { id: 'admin', role: 'admin' as const };
// 2026-11-23 13:30 KST: the 오후 round.
const NOW = Date.parse('2026-11-23T04:30:00Z');
const MIN = 60_000;
const SAFE = () => 0.999, BOOM = () => 0;

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
const d1 = () => db as unknown as D1Database;
async function rejects(promise: Promise<unknown>, status: number, code: string) {
  const error = await promise.then(() => null, (failure: unknown) => failure);
  expect(error).toBeInstanceOf(ToiletError);
  expect(error).toMatchObject({ status, code });
}
const read = (user = 'min', now = NOW) => toiletRoute(d1(), user === 'admin' ? admin : player(user), undefined, 'GET', undefined, new Date(now)) as Promise<ToiletResponse>;
const act = (user: string, action: string, input: Record<string, unknown>, now = NOW, random = SAFE) =>
  toiletRoute(d1(), user === 'admin' ? admin : player(user), action, 'POST', input, new Date(now), undefined, random) as Promise<ToiletResponse>;
/** Whoever's turn it is pushes. */
async function pushTurn(now = NOW, random = SAFE) {
  const state = await read('admin', now), round = state.toilet.current!;
  return act(round.turn!.id, 'push', { roundId: round.id, pushes: round.pushes.length }, now, random);
}
const scores = (roundId: string) => db.prepare('SELECT user_id, amount, reason, reference FROM ledger WHERE reference LIKE ? ORDER BY user_id').bind(`toilet:${roundId}:%`)
  .all<{ user_id: string; amount: number; reason: string; reference: string }>().then(result => result.results);

beforeAll(async () => {
  mf = new Miniflare({ modules: true, script: 'export default { fetch() { return new Response("") } }', compatibilityDate: '2026-08-06', d1Databases: ['DB'] });
  db = await mf.getD1Database('DB');
  await migrate(db);
});
afterAll(async () => { await mf.dispose(); });
beforeEach(async () => {
  await db.prepare('DELETE FROM toilet_rounds').run();
  await db.prepare('DELETE FROM notifications').run();
  for (const [id, role] of [['min', 'player'], ['siwon', 'player'], ['yeseo', 'player'], ['admin', 'admin']] as const) {
    await db.prepare('INSERT OR IGNORE INTO users (id, username, display_name, password_hash, role, active) VALUES (?, ?, ?, ?, ?, 1)').bind(id, id, id, 'x', role).run();
    await db.prepare('UPDATE users SET active = 1 WHERE id = ?').bind(id).run();
  }
});

describe('변기 폭파 server', () => {
  it('opens a waiting round for every active player in rotated order', async () => {
    const state = await read();
    const round = state.toilet.current!;
    expect(round).toMatchObject({ id: '2026-11-23:pm', status: 'waiting', slots: 3 * TOILET_RULES.slotsPerPlayer, pushes: [] });
    expect(round.order.map(person => person.id).sort()).toEqual(['min', 'siwon', 'yeseo']);
    expect(round.turn!.id).toBe(round.order[0]!.id);
    expect(round.chance).toBeCloseTo(1 / round.slots);
    expect(state.toilet.canPush).toBe(round.turn!.id === 'min');
    // The 오전 round started one seat earlier.
    const morning = await read('min', Date.parse('2026-11-23T01:00:00Z'));
    expect(morning.toilet.current!.order.map(person => person.id)).toEqual([round.order[2]!.id, round.order[0]!.id, round.order[1]!.id]);
  });

  it('takes turns, raises the chance, and never lets the wrong player or a stale screen push', async () => {
    const first = (await read()).toilet.current!;
    const [a, b] = first.order.map(person => person.id);
    await rejects(act(b!, 'push', { roundId: first.id, pushes: 0 }), 403, 'NOT_YOUR_TURN');
    await rejects(act('admin', 'push', { roundId: first.id, pushes: 0 }), 403, 'CANNOT_PLAY');
    const after = await act(a!, 'push', { roundId: first.id, pushes: 0 });
    expect(after.toilet.current).toMatchObject({ status: 'playing', turn: { id: b } });
    expect(after.toilet.current!.chance).toBeCloseTo(1 / (first.slots - 1));
    // The same tap again (the screen still thinks no one pushed) is refused.
    await rejects(act(a!, 'push', { roundId: first.id, pushes: 0 }), 409, 'CHANGED');
    await rejects(act(b!, 'push', { roundId: first.id, pushes: 0 }), 409, 'CHANGED');
    const notes = await db.prepare("SELECT user_id FROM notifications WHERE reference LIKE 'notification:toilet:turn:%'").all<{ user_id: string }>();
    expect(notes.results.map(row => row.user_id)).toEqual([b]);
  });

  it('bursts on someone: they lose 10, everyone else gains 5, and the round is over', async () => {
    await pushTurn();
    const before = (await read()).toilet.current!;
    const loser = before.turn!.id;
    const burst = await act(loser, 'push', { roundId: before.id, pushes: 1 }, NOW, BOOM);
    expect(burst.toilet.current).toMatchObject({ status: 'burst', loser: { id: loser }, turn: null, chance: 0 });
    expect(burst.toilet.canPush).toBe(false);
    const paid = await scores(before.id);
    expect(paid.map(row => [row.user_id, row.amount])).toEqual(
      ['min', 'siwon', 'yeseo'].map(id => [id, id === loser ? TOILET_RULES.loseScore : TOILET_RULES.winScore]));
    expect(scoreSource(paid[0]!.reference, paid[0]!.reason).game).toBe('toilet');
    await rejects(act(loser === 'min' ? 'siwon' : 'min', 'skip', { roundId: before.id, pushes: 2 }, NOW + 20 * MIN), 409, 'BURST');
    const summary = await readToiletSummary(d1(), player(loser), new Date(NOW));
    expect(summary).toMatchObject({ status: 'burst', points: TOILET_RULES.loseScore, loser: { username: loser } });
    const told = await db.prepare("SELECT COUNT(*) AS count FROM notifications WHERE reference LIKE 'notification:toilet:2026-11-23:pm:%'").first<number>('count');
    expect(told).toBe(3);
  });

  it('always bursts by the last slot', async () => {
    const slots = (await read()).toilet.current!.slots;
    let state: ToiletResponse | null = null;
    for (let push = 0; push < slots; push++) state = await pushTurn();
    expect(state!.toilet.current!.status).toBe('burst');
    expect(state!.toilet.current!.pushes).toHaveLength(slots);
  });

  it('lets another player push for a turn that has waited 10 minutes', async () => {
    const round = (await read()).toilet.current!;
    const [a, b] = round.order.map(person => person.id);
    // The first turn has waited since noon, so it can be pushed for already.
    const early = Date.parse('2026-11-23T12:05:00+09:00');
    await rejects(act(b!, 'skip', { roundId: round.id, pushes: 0 }, early), 409, 'SKIP_NOT_READY');
    await rejects(act(a!, 'skip', { roundId: round.id, pushes: 0 }), 403, 'OWN_TURN');
    const skipped = await act(b!, 'skip', { roundId: round.id, pushes: 0 });
    expect(skipped.toilet.current!.pushes).toEqual([{ for: a, by: b, at: new Date(NOW).toISOString() }]);
    expect(skipped.toilet.current!.turn!.id).toBe(b);
    // The skipped player carries the burst if it happens on their push.
    const next = skipped.toilet.current!;
    await act(b!, 'push', { roundId: next.id, pushes: 1 }, NOW + MIN);
    const c = round.order[2]!.id;
    const waited = await act(a!, 'skip', { roundId: next.id, pushes: 2 }, NOW + 11 * MIN, BOOM);
    expect(waited.toilet.current!.loser!.id).toBe(c);
  });

  it('counts a round that never burst for nothing, and shows it as the round before', async () => {
    // Another day, so earlier tests' payouts (the ledger is append-only) stay out of it.
    const day = Date.parse('2026-11-25T15:00:00+09:00');
    await pushTurn(day);
    const evening = Date.parse('2026-11-25T23:55:00+09:00');
    const closed = await read('min', evening);
    expect(closed.toilet.current).toBeNull();
    expect(closed.toilet.previous).toMatchObject({ id: '2026-11-25:pm', status: 'void', loser: null });
    await rejects(act('min', 'push', { roundId: '2026-11-25:pm', pushes: 1 }, evening), 409, 'PLAY_CLOSED');
    expect(await scores('2026-11-25:pm')).toEqual([]);
    const morning = await read('min', Date.parse('2026-11-26T08:00:00+09:00'));
    expect(morning.toilet.current!.status).toBe('waiting');
    expect(morning.toilet.previous).toMatchObject({ id: '2026-11-25:pm', status: 'void' });
  });

  it('keeps a player who arrives mid-round out until the next one, and skips one who left', async () => {
    const round = (await read()).toilet.current!;
    await pushTurn();
    await db.prepare("INSERT OR IGNORE INTO users (id, username, display_name, password_hash, role, active) VALUES ('newbie', 'newbie', 'newbie', 'x', 'player', 1)").run();
    await rejects(act('newbie', 'skip', { roundId: round.id, pushes: 1 }, NOW + 20 * MIN), 403, 'NOT_SEATED');
    const turn = (await read()).toilet.current!.turn!.id;
    await db.prepare('UPDATE users SET active = 0 WHERE id = ?').bind(turn).run();
    const now = (await read()).toilet.current!;
    expect(now.turn!.id).not.toBe(turn);
    await db.prepare("DELETE FROM users WHERE id = 'newbie'").run();
  });

  it('answers an unchanged poll with one small read', async () => {
    const first = await read();
    const again = await toiletRoute(d1(), player('min'), undefined, 'GET', undefined, new Date(NOW), first.stamp);
    expect(again).toMatchObject({ unchanged: true, stamp: first.stamp });
    await pushTurn();
    const moved = await toiletRoute(d1(), player('min'), undefined, 'GET', undefined, new Date(NOW), first.stamp);
    expect('unchanged' in moved).toBe(false);
  });
});
