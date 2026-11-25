import { readFile, readdir } from 'node:fs/promises';
import { Miniflare } from 'miniflare';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { BINGO_RULES } from '../shared/balance';
import { scoreSource } from '../shared/ranking-periods';
import type { BingoResponse } from '../shared/types';
import { BingoError, bingoRoute, readBingoSummary } from '../worker/bingo';
import type { BingoWordMaker } from '../worker/bingo-ai';

type Database = Awaited<ReturnType<Miniflare['getD1Database']>>;
const player = (id: string) => ({ id, role: 'player' as const });
const admin = { id: 'admin', role: 'admin' as const };
// 2026-11-07 13:30 KST.
const NOW = Date.parse('2026-11-07T04:30:00Z');
const MIN = 60_000;
const WORDS = Array.from({ length: BINGO_RULES.words }, (_, i) => `단어${i + 1}`);
const made: string[] = [];
const maker: BingoWordMaker = async topic => { made.push(topic); return WORDS; };
const noAi: BingoWordMaker = async () => null;
/** A board whose top three rows are the first fifteen words; the rest starts `shift` words further on. */
const board = (shift = 0) => [...WORDS.slice(0, 15), ...Array.from({ length: 10 }, (_, i) => WORDS[15 + (i + shift) % 15]!)];

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
  expect(error).toBeInstanceOf(BingoError);
  expect(error).toMatchObject({ status, code });
}
const read = (user = 'min', now = NOW) => bingoRoute(d1(), user === 'admin' ? admin : player(user), undefined, 'GET', undefined, new Date(now), maker) as Promise<BingoResponse>;
const act = (user: string, action: string, input: Record<string, unknown>, now = NOW, words: BingoWordMaker = maker) =>
  bingoRoute(d1(), user === 'admin' ? admin : player(user), action, 'POST', input, new Date(now), words) as Promise<BingoResponse>;
const rid = (label: string) => `req-${label}-0123456789abcdef`;
const create = (user = 'min', lines = 3, now = NOW, label = 'create') => act(user, 'create', { requestId: rid(`${user}-${label}`), topic: '분식집 메뉴', lines }, now);
/** Opens a three-line game led by min and seats the named players; play starts when all three are in. */
async function seated(users: string[], now = NOW) {
  const opened = await act('min', 'create', { requestId: rid(`seat-${now}`), topic: '분식집 메뉴', lines: 3 }, now);
  const gameId = opened.bingo.game!.id;
  for (const [i, user] of users.entries()) await act(user, 'board', { gameId, cells: board(i * 3) }, now);
  return gameId;
}
/** Whoever's turn it is calls the given words in order. */
async function callAll(gameId: string, words: string[], now = NOW) {
  let state = await read('admin', now);
  for (const word of words) state = await act(state.bingo.game!.turn!.id, 'call', { gameId, word }, now);
  return state;
}
// The ledger is append-only, so rows are scoped to the game under test.
const scores = (gameId: string) => db.prepare("SELECT user_id, amount, reason, week_start FROM ledger WHERE reference LIKE ? ORDER BY amount DESC").bind(`bingo:${gameId}:%`).all<{ user_id: string; amount: number; reason: string; week_start: string }>().then(result => result.results);

beforeAll(async () => {
  mf = new Miniflare({ modules: true, script: 'export default { fetch() { return new Response("") } }', compatibilityDate: '2026-08-06', d1Databases: ['DB'] });
  db = await mf.getD1Database('DB');
  await migrate(db);
});
afterAll(async () => { await mf.dispose(); });
beforeEach(async () => {
  made.length = 0;
  await db.prepare('UPDATE bingo_state SET leader_id = NULL, game_id = NULL, waiting_since = NULL, token = NULL WHERE id = 1').run();
  for (const table of ['bingo_boards', 'bingo_games']) await db.prepare(`DELETE FROM ${table}`).run();
  await db.prepare("DELETE FROM notifications").run().catch(() => {});
  await db.prepare('DELETE FROM users').run().catch(() => {});
  for (const [id, role] of [['min', 'player'], ['siwon', 'player'], ['yeseo', 'player'], ['admin', 'admin']] as const) {
    await db.prepare('INSERT OR IGNORE INTO users (id, username, display_name, password_hash, role, active) VALUES (?, ?, ?, ?, ?, 1)').bind(id, id, id, 'x', role).run();
    await db.prepare('UPDATE users SET active = 1 WHERE id = ?').bind(id).run();
  }
});

describe('bingo: opening a game', () => {
  it('starts with nobody leading: any player may open the first game, an admin only watches', async () => {
    const start = await read();
    expect(start.bingo).toMatchObject({ game: null, leader: null, canCreate: true, canFill: false, canCall: false });
    expect((await read('admin')).bingo.canCreate).toBe(false);
    await rejects(create('admin'), 403, 'CANNOT_PLAY');
    expect(await readBingoSummary(d1(), player('min'))).toMatchObject({ status: 'idle', topic: null, joined: false });
  });

  it('makes the 50 words from the leader\'s topic and lets the leader choose 3 or 5 lines', async () => {
    const opened = await create('siwon', 5);
    expect(made).toEqual(['분식집 메뉴']);
    expect(opened.bingo.game).toMatchObject({ number: 1, topic: '분식집 메뉴', lines: 5, words: WORDS, source: 'ai', status: 'filling', seats: [], calls: [], leader: { id: 'siwon' } });
    expect(opened.bingo).toMatchObject({ canCreate: false, canFill: true, canStart: false, canCancel: true });
    expect((await read('min')).bingo).toMatchObject({ canFill: true, canCancel: false, canCreate: false });
    // A retried create finds the game it opened; it does not call the AI or open another.
    const again = await create('siwon', 5);
    expect(again.bingo.game!.id).toBe(opened.bingo.game!.id);
    expect(made).toHaveLength(1);
    await rejects(create('min'), 409, 'GAME_ACTIVE');
    expect(await readBingoSummary(d1(), player('min'))).toMatchObject({ status: 'filling', topic: '분식집 메뉴', leader: { username: 'siwon' }, joined: false, players: 0 });
  });

  it('checks the topic and the line count, and falls back to the leader\'s own words when the AI cannot answer', async () => {
    await rejects(act('min', 'create', { requestId: rid('a'), topic: '  ', lines: 3 }), 400, 'INVALID_TOPIC');
    await rejects(act('min', 'create', { requestId: rid('b'), topic: '과일', lines: 4 }), 400, 'INVALID_LINES');
    await rejects(act('min', 'create', { requestId: 'short', topic: '과일', lines: 3 }), 400, 'INVALID_REQUEST_ID');
    await rejects(act('min', 'create', { requestId: rid('c'), topic: '과일', lines: 3 }, NOW, noAi), 503, 'AI_UNAVAILABLE');
    await rejects(act('min', 'create', { requestId: rid('d'), topic: '과일', lines: 3, words: WORDS.slice(0, 49) }, NOW, noAi), 400, 'INVALID_WORDS');
    const manual = await act('min', 'create', { requestId: rid('e'), topic: '과일', lines: 3, words: WORDS.map(word => ` ${word} `) }, NOW, noAi);
    expect(manual.bingo.game).toMatchObject({ source: 'manual', words: WORDS, lines: 3 });
  });

  it('lets the leader call the game off while boards are being filled, passing the lead on', async () => {
    const opened = await create('min');
    const gameId = opened.bingo.game!.id;
    await rejects(act('siwon', 'cancel', { gameId }), 403, 'CANNOT_CANCEL');
    const cancelled = await act('min', 'cancel', { gameId });
    expect(cancelled.bingo.game!.status).toBe('cancelled');
    expect(cancelled.bingo).toMatchObject({ leader: { id: 'siwon' }, canCreate: false });
    expect((await read('siwon')).bingo.canCreate).toBe(true);
    await rejects(create('min', 3, NOW, 'again'), 403, 'NOT_LEADER');
    expect(await readBingoSummary(d1(), player('min'))).toMatchObject({ status: 'idle', leader: { username: 'siwon' } });
  });
});

describe('bingo: filling boards', () => {
  it('takes 25 different words of the pool, keeps boards private, and lets a player change theirs until play starts', async () => {
    const gameId = (await create('min')).bingo.game!.id;
    await rejects(act('siwon', 'board', { gameId, cells: board().slice(0, 24) }), 400, 'INVALID_BOARD');
    await rejects(act('siwon', 'board', { gameId, cells: [...board().slice(0, 24), '없는 단어'] }), 400, 'INVALID_BOARD');
    await rejects(act('siwon', 'board', { gameId: 'other', cells: board() }), 409, 'CHANGED');
    await act('siwon', 'board', { gameId, cells: board() });
    const changed = await act('siwon', 'board', { gameId, cells: board(4) });
    expect(changed.bingo.game!.seats).toHaveLength(1);
    expect(changed.bingo.game!.seats[0]).toMatchObject({ player: { id: 'siwon' }, cells: board(4), marked: 0, lines: 0, rank: null });
    // Other players see that siwon is in, not what siwon wrote.
    expect((await read('min')).bingo.game!.seats[0]).toMatchObject({ player: { id: 'siwon' }, cells: null });
    expect(await readBingoSummary(d1(), player('siwon'))).toMatchObject({ joined: true, players: 1 });
    expect(await readBingoSummary(d1(), player('min'))).toMatchObject({ joined: false, players: 1 });
  });

  it('starts by itself when every active player has a board; the leader calls first', async () => {
    const gameId = (await create('siwon')).bingo.game!.id;
    await act('min', 'board', { gameId, cells: board() });
    expect((await act('yeseo', 'board', { gameId, cells: board(3) })).bingo.game!.status).toBe('filling');
    const started = await act('siwon', 'board', { gameId, cells: board(6) });
    expect(started.bingo.game).toMatchObject({ status: 'playing', turn: { id: 'siwon' } });
    expect(started.bingo).toMatchObject({ canCall: true, canFill: false, canCancel: false });
    await rejects(act('min', 'board', { gameId, cells: board(9) }), 409, 'ALREADY_STARTED');
    const turn = await db.prepare("SELECT user_id, payload_json FROM notifications WHERE reference LIKE 'notification:bingo:turn:%'").first<{ user_id: string; payload_json: string }>();
    expect(turn).toEqual({ user_id: 'siwon', payload_json: JSON.stringify({ kind: 'turn', game: 'bingo' }) });
  });

  it('lets the leader start with two boards at once, and another seated player after ten minutes', async () => {
    const gameId = (await create('min')).bingo.game!.id;
    await act('siwon', 'board', { gameId, cells: board() });
    await rejects(act('min', 'start', { gameId }), 409, 'NOT_ENOUGH_PLAYERS');
    await act('yeseo', 'board', { gameId, cells: board(3) });
    expect((await read('siwon')).bingo).toMatchObject({ canStart: false });
    await rejects(act('siwon', 'start', { gameId }), 403, 'CANNOT_START');
    const later = NOW + BINGO_RULES.skipAfterMs;
    expect((await read('siwon', later)).bingo.canStart).toBe(true);
    const started = await act('siwon', 'start', { gameId }, later);
    // The leader has no board: the first seated player after them calls first.
    expect(started.bingo.game).toMatchObject({ status: 'playing', turn: { id: 'siwon' } });
    expect(started.bingo.game!.seats.map(seat => seat.player.id).sort()).toEqual(['siwon', 'yeseo']);
    // The leader did not join, so they only watch.
    await rejects(act('min', 'call', { gameId, word: WORDS[0] }, later), 403, 'NOT_SEATED');
  });
});

describe('bingo: calling words', () => {
  it('crosses the confirmed word off every board that has it and passes the turn on', async () => {
    const gameId = await seated(['min', 'siwon', 'yeseo']);
    await rejects(act('siwon', 'call', { gameId, word: WORDS[0] }), 403, 'NOT_YOUR_TURN');
    await rejects(act('min', 'call', { gameId, word: '없는 단어' }), 400, 'INVALID_WORD');
    const called = await act('min', 'call', { gameId, word: WORDS[0] });
    expect(called.bingo.game!.calls).toMatchObject([{ word: WORDS[0], by: 'min' }]);
    expect(called.bingo.game!.seats.map(seat => [seat.player.id, seat.marked])).toEqual([['min', 1], ['siwon', 1], ['yeseo', 1]]);
    expect(called.bingo.game!.turn!.id).toBe('siwon');
    expect(called.bingo).toMatchObject({ canCall: false });
    await rejects(act('siwon', 'call', { gameId, word: WORDS[0] }), 409, 'ALREADY_CALLED');
    // A word only some boards hold comes off only those.
    const lone = board(3).find(word => !board(0).includes(word))!;
    expect(lone).toBeTruthy();
    const next = await act('siwon', 'call', { gameId, word: lone });
    expect(Object.fromEntries(next.bingo.game!.seats.map(seat => [seat.player.id, seat.marked]))).toMatchObject({ min: 1, siwon: 2 });
    expect(await db.prepare("SELECT COUNT(*) AS n FROM notifications WHERE reference LIKE 'notification:bingo:turn:%'").first('n')).toBe(3);
  });

  it('pays 5, 3 and 1 points as each place is settled, to the players who took part', async () => {
    // Everyone shares the top three rows, so their fifteenth word finishes all three at once.
    // The turns go min, siwon, yeseo: yeseo makes that call and is placed first, then the turn order.
    const gameId = await seated(['min', 'siwon', 'yeseo']);
    const before = await callAll(gameId, WORDS.slice(0, 14));
    expect(before.bingo.game).toMatchObject({ status: 'playing', turn: { id: 'yeseo' } });
    expect(before.bingo.game!.seats.every(seat => seat.lines === 2 && seat.rank === null)).toBe(true);
    expect(await scores(gameId)).toEqual([]);
    const done = await act('yeseo', 'call', { gameId, word: WORDS[14] });
    expect(done.bingo.game).toMatchObject({ status: 'ended', turn: null });
    expect(done.bingo.game!.seats.map(seat => [seat.player.id, seat.rank, seat.points])).toEqual([['yeseo', 1, 5], ['min', 2, 3], ['siwon', 3, 1]]);
    // Once it is over every board is shown.
    expect((await read('admin')).bingo.game!.seats.every(seat => seat.cells?.length === 25)).toBe(true);
    expect(await scores(gameId)).toEqual([
      { user_id: 'yeseo', amount: 5, reason: '빙고 1등', week_start: '2026-11-02' },
      { user_id: 'min', amount: 3, reason: '빙고 2등', week_start: '2026-11-02' },
      { user_id: 'siwon', amount: 1, reason: '빙고 3등', week_start: '2026-11-02' },
    ]);
    expect(scoreSource(`bingo:${gameId}:siwon:score`, '')).toEqual({ game: 'bingo', label: '빙고' });
    // The lead passes to the player after this game's leader, and they are told.
    expect(done.bingo).toMatchObject({ leader: { id: 'siwon' }, canCreate: false });
    expect((await read('siwon')).bingo.canCreate).toBe(true);
    expect(await db.prepare("SELECT user_id FROM notifications WHERE reference = ?").bind(`notification:bingo:lead:${gameId}`).first('user_id')).toBe('siwon');
    await rejects(act('min', 'call', { gameId, word: WORDS[15] }), 409, 'CHANGED');
    expect(await readBingoSummary(d1(), player('min'))).toMatchObject({ status: 'ended', winner: { username: 'yeseo' }, leader: { username: 'siwon' } });
  });

  it('keeps playing for second place, then gives the last player the next place', async () => {
    // Only min's board has the first fifteen words as three rows; on the others they make two lines.
    const gameId = (await create('min')).bingo.game!.id;
    const others = WORDS.slice(5, 30);
    await act('siwon', 'board', { gameId, cells: others });
    await act('yeseo', 'board', { gameId, cells: [...others].reverse() });
    await act('min', 'board', { gameId, cells: board() });
    // min calls the five words only they hold; the others call the ten they share.
    const mine = WORDS.slice(0, 5), shared = WORDS.slice(5, 15);
    const order = Array.from({ length: 15 }, (_, i) => (i % 3 === 0 ? mine[i / 3]! : shared[i - Math.floor(i / 3) - 1]!));
    const first = await callAll(gameId, order);
    expect(first.bingo.game!.status).toBe('playing');
    expect(first.bingo.game!.seats[0]).toMatchObject({ player: { id: 'min' }, rank: 1, points: 5, lines: 3 });
    expect(await scores(gameId)).toHaveLength(1);
    // The winner is out of the rotation; the other two keep going.
    expect(first.bingo.game!.turn!.id).toBe('siwon');
    let state = first;
    for (let guard = 0; guard < 40 && state.bingo.game!.status === 'playing'; guard++) {
      const turn = state.bingo.game!.turn!.id, called = new Set(state.bingo.game!.calls.map(call => call.word));
      expect(turn).not.toBe('min');
      const cells = (await read(turn)).bingo.game!.seats.find(seat => seat.player.id === turn)!.cells!;
      state = await act(turn, 'call', { gameId, word: cells.find(cell => !called.has(cell))! });
    }
    expect(state.bingo.game!.status).toBe('ended');
    expect(state.bingo.game!.seats.map(seat => seat.rank)).toEqual([1, 2, 3]);
    expect((await scores(gameId)).map(row => row.amount)).toEqual([5, 3, 1]);
  });

  it('closes calling from 23:50 to midnight and scores a place in the week it was settled', async () => {
    const sunday = Date.parse('2026-11-08T23:40:00+09:00');
    const gameId = await seated(['min', 'siwon', 'yeseo'], sunday);
    await callAll(gameId, WORDS.slice(0, 14), sunday);
    await rejects(act('yeseo', 'call', { gameId, word: WORDS[14] }, Date.parse('2026-11-08T23:55:00+09:00')), 409, 'PLAY_CLOSED');
    // The game ran past midnight: the points belong to the moment the places were settled.
    await act('yeseo', 'call', { gameId, word: WORDS[14] }, Date.parse('2026-11-09T00:05:00+09:00'));
    expect((await scores(gameId)).map(row => row.week_start)).toEqual(['2026-11-09', '2026-11-09', '2026-11-09']);
  });

  it('lets another seated player pass a turn that has waited ten minutes', async () => {
    const gameId = await seated(['min', 'siwon', 'yeseo']);
    expect((await read('siwon')).bingo).toMatchObject({ canSkip: false, skipAvailableAt: new Date(NOW + BINGO_RULES.skipAfterMs).toISOString() });
    await rejects(act('siwon', 'skip', { gameId, expectedTurnId: 'min' }, NOW + 9 * MIN), 409, 'SKIP_NOT_READY');
    const late = NOW + BINGO_RULES.skipAfterMs;
    await rejects(act('min', 'skip', { gameId, expectedTurnId: 'min' }, late), 403, 'OWN_TURN');
    const skipped = await act('yeseo', 'skip', { gameId, expectedTurnId: 'min' }, late);
    expect(skipped.bingo.game!.turn!.id).toBe('siwon');
    expect(skipped.bingo.game!.calls).toEqual([]);
    // Two taps on the same waiting turn pass one turn, not two.
    await rejects(act('siwon', 'skip', { gameId, expectedTurnId: 'min' }, late + MIN), 409, 'CHANGED');
  });

  it('applies only one of two changes made from the same board', async () => {
    const gameId = await seated(['min', 'siwon', 'yeseo']);
    const results = await Promise.allSettled([act('min', 'call', { gameId, word: WORDS[0] }), act('min', 'call', { gameId, word: WORDS[1] })]);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect((await read()).bingo.game!.calls).toHaveLength(1);
  });

  it('skips a deactivated player\'s turn and still lets the game finish', async () => {
    const gameId = await seated(['min', 'siwon', 'yeseo']);
    await db.prepare("UPDATE users SET active = 0 WHERE id = 'siwon'").run();
    const called = await act('min', 'call', { gameId, word: WORDS[0] });
    expect(called.bingo.game!.turn!.id).toBe('yeseo');
    // A player deactivated on their own turn cannot call; the others pass it after ten minutes.
    await db.prepare("UPDATE users SET active = 0 WHERE id = 'yeseo'").run();
    await rejects(act('yeseo', 'call', { gameId, word: WORDS[1] }), 403, 'CANNOT_PLAY');
    expect((await act('min', 'skip', { gameId, expectedTurnId: 'yeseo' }, NOW + BINGO_RULES.skipAfterMs)).bingo.game!.turn!.id).toBe('min');
  });
});

describe('bingo: between games', () => {
  it('passes the lead after ten minutes of waiting, and answers an unchanged poll with one small read', async () => {
    const gameId = (await create('min')).bingo.game!.id;
    await act('min', 'cancel', { gameId });
    const waiting = await read('yeseo');
    expect(waiting.bingo).toMatchObject({ leader: { id: 'siwon' }, canCreate: false, canSkip: false });
    await rejects(act('yeseo', 'skip', { gameId: null, expectedTurnId: 'siwon' }), 409, 'SKIP_NOT_READY');
    await rejects(act('siwon', 'skip', { gameId: null, expectedTurnId: 'siwon' }, NOW + BINGO_RULES.skipAfterMs), 403, 'OWN_TURN');
    const passed = await act('min', 'skip', { gameId: null, expectedTurnId: 'siwon' }, NOW + BINGO_RULES.skipAfterMs);
    expect(passed.bingo).toMatchObject({ leader: { id: 'yeseo' } });
    const poll = await bingoRoute(d1(), player('min'), undefined, 'GET', undefined, new Date(NOW), maker, passed.version);
    expect(poll).toMatchObject({ unchanged: true, version: passed.version });
    expect('bingo' in await bingoRoute(d1(), player('min'), undefined, 'GET', undefined, new Date(NOW), maker, passed.version - 1)).toBe(true);
  });

  it('lets anyone open a game when the waiting leader has been deactivated', async () => {
    const gameId = (await create('min')).bingo.game!.id;
    await act('min', 'cancel', { gameId });
    await db.prepare("UPDATE users SET active = 0 WHERE id = 'siwon'").run();
    expect((await read('yeseo')).bingo).toMatchObject({ leader: null, canCreate: true });
    expect((await create('yeseo', 5, NOW, 'open')).bingo.game).toMatchObject({ number: 2, leader: { id: 'yeseo' }, lines: 5 });
  });
});
