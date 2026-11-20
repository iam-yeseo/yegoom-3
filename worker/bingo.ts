import { BINGO_RULES, PLAY_RULES, playClosed, playWindow } from '../shared/balance';
import {
  bingoBoardProblem, bingoLines, bingoTopicProblem, bingoWordsProblem, cleanBingoTopic, cleanBingoWord, firstBingoTurn, nextBingoTurn, settleBingoCall, type BingoSeat,
} from '../shared/bingo';
import { defaultCharacter, type ArtKey } from '../shared/characters';
import type { BingoAction, BingoCall, BingoGameView, BingoPollResponse, BingoResponse, BingoState, BingoStatus, BingoSummary, CatchmindPlayer } from '../shared/types';
import type { BingoWordMaker } from './bingo-ai';
import { weekStart } from './rules';

// Bingo is one shared game at a time (docs/plan-bingo.md). Every change goes
// through bingo_state: a request reads the board, works out the next board in
// memory with shared/bingo.ts, and writes it only if the version it read is
// still the current one. Two requests at once never both apply.

interface Actor { id: string; role: 'player' | 'admin' }
interface StateRow { leader_id: string | null; game_id: string | null; waiting_since: string | null; version: number }
interface GameRow {
  id: string; number: number; leader_id: string; topic: string; lines: number; words_json: string; source: 'ai' | 'manual'; status: BingoStatus;
  turn_id: string | null; turn_started_at: string | null; calls_json: string; created_at: string; started_at: string | null; ended_at: string | null;
}
interface BoardRow { user_id: string; cells_json: string; rank: number | null; points: number }
interface PersonRow { id: string; username: string; display_name: string; character: ArtKey | null; photo_version: number | null; active: number; role: string }
interface Loaded { state: StateRow; game: GameRow | null; boards: BoardRow[]; people: Map<string, PersonRow> }

export class BingoError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); }
}
const GAME_COLUMNS = 'g.id, g.number, g.leader_id, g.topic, g.lines, g.words_json, g.source, g.status, g.turn_id, g.turn_started_at, g.calls_json, g.created_at, g.started_at, g.ended_at';
const requestIdValid = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{16,80}$/.test(value);
const active = (game: GameRow | null): game is GameRow => !!game && (game.status === 'filling' || game.status === 'playing');
const playing = (person: PersonRow | undefined) => !!person && person.active === 1 && person.role === 'player';
const after = (iso: string | null) => (iso ? Date.parse(iso) + BINGO_RULES.skipAfterMs : NaN);
const changed = () => new BingoError(409, 'CHANGED', '그사이에 빙고판이 바뀌었어요. 새로 불러올게요.');

/** The board as stored: the state row, its game, that game's boards, and every
 * active player plus anyone the game names. Three queries. */
async function load(db: D1Database): Promise<Loaded> {
  const row = await db.prepare(`SELECT s.leader_id AS state_leader, s.game_id, s.waiting_since, s.version, ${GAME_COLUMNS}
    FROM bingo_state s LEFT JOIN bingo_games g ON g.id = s.game_id WHERE s.id = 1`).first<StateRow & GameRow & { state_leader: string | null }>();
  if (!row) throw new Error('Missing bingo state');
  const state: StateRow = { leader_id: row.state_leader, game_id: row.game_id, waiting_since: row.waiting_since, version: row.version };
  const game: GameRow | null = row.id ? row : null;
  const [boards, people] = await Promise.all([
    game ? db.prepare('SELECT user_id, cells_json, rank, points FROM bingo_boards WHERE game_id = ?').bind(game.id).all<BoardRow>().then(result => result.results) : [],
    db.prepare(`SELECT id, username, display_name, character, active, role,
      CASE WHEN EXISTS (SELECT 1 FROM user_photos WHERE user_id = users.id) THEN photo_version ELSE NULL END AS photo_version
      FROM users WHERE (role = 'player' AND active = 1) OR id IN (?, ?, ?) OR id IN (SELECT user_id FROM bingo_boards WHERE game_id = ?)`)
      .bind(state.leader_id, game?.leader_id ?? null, game?.turn_id ?? null, game?.id ?? null).all<PersonRow>().then(result => result.results),
  ]);
  return { state, game, boards, people: new Map(people.map(person => [person.id, person])) };
}
const viewOf = (person: PersonRow | undefined): CatchmindPlayer | null => person
  ? { id: person.id, username: person.username, displayName: person.display_name, photoVersion: person.photo_version, character: person.character ?? defaultCharacter(person.username) } : null;
const seatsOf = ({ boards, people }: Loaded): BingoSeat[] => boards.map(board => ({
  userId: board.user_id, username: people.get(board.user_id)?.username ?? board.user_id, cells: JSON.parse(board.cells_json) as string[],
  rank: board.rank, active: playing(people.get(board.user_id)),
}));
const callsOf = (game: GameRow): BingoCall[] => JSON.parse(game.calls_json) as BingoCall[];
/** The player who leads after `leaderId`: the next active one in username order. */
function nextLeader({ people }: Loaded, leaderId: string): string {
  const order = [...people.values()].filter(playing).sort((a, b) => (a.username < b.username ? -1 : 1));
  const name = people.get(leaderId)?.username ?? '';
  return (order.find(person => person.username > name) ?? order[0])?.id ?? leaderId;
}
/** The leader the board is waiting for, or null when anyone may open a game. */
const waitingLeader = (loaded: Loaded): string | null => (loaded.state.leader_id && playing(loaded.people.get(loaded.state.leader_id)) ? loaded.state.leader_id : null);

function stateView(loaded: Loaded, user: Actor, now: number): BingoState {
  const { state, game, boards, people } = loaded;
  const player = user.role === 'player', mine = boards.find(board => board.user_id === user.id);
  const live = active(game), leader = waitingLeader(loaded);
  const called = new Set(game ? callsOf(game).map(call => call.word) : []);
  const over = game?.status === 'ended';
  const view: BingoGameView | null = game ? {
    id: game.id, number: game.number, leader: viewOf(people.get(game.leader_id))!, topic: game.topic, lines: game.lines,
    words: JSON.parse(game.words_json) as string[], source: game.source, status: game.status,
    turn: viewOf(people.get(game.turn_id ?? '')), turnStartedAt: game.turn_started_at, calls: callsOf(game),
    seats: boards.map(board => {
      const cells = JSON.parse(board.cells_json) as string[];
      return { player: viewOf(people.get(board.user_id))!, marked: cells.filter(cell => called.has(cell)).length, lines: bingoLines(cells, called),
        rank: board.rank, points: board.points, cells: over || board.user_id === user.id ? cells : null };
    }).sort((a, b) => (a.rank ?? 99) - (b.rank ?? 99) || (a.player.username < b.player.username ? -1 : 1)),
    createdAt: game.created_at, startedAt: game.started_at, endedAt: game.ended_at,
  } : null;
  const startAt = game?.status === 'filling' ? after(game.created_at) : NaN;
  const skipAt = game?.status === 'playing' ? after(game.turn_started_at) : !live && leader ? after(state.waiting_since) : NaN;
  const iso = (time: number) => (Number.isFinite(time) ? new Date(time).toISOString() : null);
  return {
    game: view, leader: live ? null : viewOf(people.get(leader ?? '')), waitingSince: live ? null : state.waiting_since,
    canCreate: player && !live && (!leader || leader === user.id),
    canFill: player && game?.status === 'filling',
    canStart: player && game?.status === 'filling' && boards.length >= BINGO_RULES.minPlayers && (game.leader_id === user.id || (!!mine && now >= startAt)),
    canCall: player && game?.status === 'playing' && game.turn_id === user.id,
    canSkip: player && now >= skipAt && (game?.status === 'playing' ? !!mine && game.turn_id !== user.id : !live && !!leader && leader !== user.id),
    canCancel: player && game?.status === 'filling' && game.leader_id === user.id,
    startAvailableAt: iso(startAt), skipAvailableAt: iso(skipAt),
  };
}
const respond = (loaded: Loaded, user: Actor, now: Date): BingoResponse => ({
  bingo: stateView(loaded, user, now.getTime()), version: loaded.state.version, viewerId: user.id, serverTime: now.toISOString(), play: playWindow(now.getTime()),
});

/** The home row. One query; nothing is written. */
export async function readBingoSummary(db: D1Database, user: Actor): Promise<BingoSummary> {
  const row = await db.prepare(`SELECT g.status, g.topic, s.leader_id AS next_leader,
      l.username AS leader_username, l.display_name AS leader_name, t.username AS turn_username, t.display_name AS turn_name,
      w.username AS winner_username, w.display_name AS winner_name,
      (SELECT COUNT(*) FROM bingo_boards b WHERE b.game_id = g.id) AS players,
      EXISTS (SELECT 1 FROM bingo_boards b WHERE b.game_id = g.id AND b.user_id = ?) AS joined
    FROM bingo_state s LEFT JOIN bingo_games g ON g.id = s.game_id
      LEFT JOIN users l ON l.id = CASE WHEN g.status IN ('filling', 'playing') THEN g.leader_id ELSE s.leader_id END AND l.active = 1 AND l.role = 'player'
      LEFT JOIN users t ON t.id = g.turn_id AND g.status = 'playing'
      LEFT JOIN users w ON w.id = (SELECT user_id FROM bingo_boards WHERE game_id = g.id AND rank = 1) AND g.status = 'ended'
    WHERE s.id = 1`).bind(user.id).first<{
      status: BingoStatus | null; topic: string | null; leader_username: string | null; leader_name: string | null; turn_username: string | null; turn_name: string | null;
      winner_username: string | null; winner_name: string | null; players: number; joined: number;
    }>();
  const person = (username: string | null | undefined, displayName: string | null | undefined) => (username ? { username, displayName: displayName ?? username } : null);
  return {
    status: !row?.status || row.status === 'cancelled' ? 'idle' : row.status, topic: row?.status && row.status !== 'cancelled' ? row.topic : null,
    leader: person(row?.leader_username, row?.leader_name), turn: person(row?.turn_username, row?.turn_name), winner: person(row?.winner_username, row?.winner_name),
    joined: !!row?.joined, players: row?.players ?? 0,
  };
}

/** Applies `statements` only if the board is still at `version` and the player is
 * still active. `guard` is the SQL every statement must carry in its WHERE. */
async function commit(db: D1Database, user: Actor, version: number, statements: (guard: string, token: string) => D1PreparedStatement[]): Promise<void> {
  const token = crypto.randomUUID();
  await db.batch([
    db.prepare(`UPDATE bingo_state SET version = version + 1, token = ? WHERE id = 1 AND version = ?
      AND EXISTS (SELECT 1 FROM users WHERE id = ? AND role = 'player' AND active = 1)`).bind(token, version, user.id),
    ...statements('EXISTS (SELECT 1 FROM bingo_state WHERE id = 1 AND token = ?)', token),
  ]);
  if (await db.prepare('SELECT token FROM bingo_state WHERE id = 1').first<string>('token') === token) return;
  const still = await db.prepare("SELECT 1 FROM users WHERE id = ? AND role = 'player' AND active = 1").bind(user.id).first();
  if (!still) throw new BingoError(403, 'CANNOT_PLAY', '활성 플레이어만 빙고에 참여할 수 있어요.');
  throw changed();
}
const notify = (db: D1Database, guard: string, token: string, userId: string, game: 'bingo' | 'bingo-lead', reference: string, at: string) =>
  db.prepare(`INSERT OR IGNORE INTO notifications (kind, audience, user_id, actor_id, payload_json, created_at, reference)
    SELECT 'game', 'user', ?, ?, ?, ?, ? WHERE ${guard}`).bind(userId, userId, JSON.stringify({ kind: 'turn', game }), at, reference, token);
/** Opens play: the leader calls first (or whoever follows them, if they have no board). */
function startStatements(db: D1Database, guard: string, token: string, loaded: Loaded, game: GameRow, seats: BingoSeat[], at: string): D1PreparedStatement[] {
  const first = firstBingoTurn(seats, loaded.people.get(game.leader_id)?.username ?? '') ?? seats[0]!;
  return [
    db.prepare(`UPDATE bingo_games SET status = 'playing', turn_id = ?, turn_started_at = ?, started_at = ? WHERE id = ? AND status = 'filling' AND ${guard}`)
      .bind(first.userId, at, at, game.id, token),
    notify(db, guard, token, first.userId, 'bingo', `notification:bingo:turn:${game.id}:0`, at),
  ];
}
/** The game is over (or called off): the lead passes on and the wait for the next game starts. */
const passLead = (db: D1Database, guard: string, token: string, loaded: Loaded, from: string, reference: string, at: string): D1PreparedStatement[] => {
  const next = nextLeader(loaded, from);
  return [
    db.prepare(`UPDATE bingo_state SET leader_id = ?, waiting_since = ? WHERE id = 1 AND ${guard}`).bind(next, at, token),
    notify(db, guard, token, next, 'bingo-lead', reference, at),
  ];
};

async function mutate(db: D1Database, user: Actor, action: BingoAction, input: Record<string, unknown>, now: Date, makeWords: BingoWordMaker): Promise<void> {
  if (user.role !== 'player') throw new BingoError(403, 'CANNOT_PLAY', '플레이어만 빙고에 참여할 수 있어요.');
  const at = now.toISOString(), time = now.getTime();
  const loaded = await load(db);
  const { state } = loaded;
  if (action === 'create') {
    if (!requestIdValid(input.requestId)) throw new BingoError(400, 'INVALID_REQUEST_ID', '요청 번호를 확인해 주세요.');
    // A retried create (lost response) finds the game it already opened.
    if (await db.prepare('SELECT 1 FROM bingo_games WHERE leader_id = ? AND request_id = ?').bind(user.id, input.requestId).first()) return;
    const problem = bingoTopicProblem(input.topic);
    if (problem) throw new BingoError(400, 'INVALID_TOPIC', problem);
    if (!BINGO_RULES.lineChoices.includes(input.lines as never)) throw new BingoError(400, 'INVALID_LINES', '3줄과 5줄 중에서 골라 주세요.');
    if (active(loaded.game)) throw new BingoError(409, 'GAME_ACTIVE', '이미 진행 중인 빙고가 있어요.');
    const leader = waitingLeader(loaded);
    if (leader && leader !== user.id) throw new BingoError(403, 'NOT_LEADER', '이번 판의 리더만 주제를 정할 수 있어요.');
    const topic = cleanBingoTopic(input.topic as string);
    let words: string[], source: 'ai' | 'manual';
    if (input.words !== undefined) {
      const wordsProblem = bingoWordsProblem(input.words);
      if (wordsProblem) throw new BingoError(400, 'INVALID_WORDS', wordsProblem);
      words = (input.words as string[]).map(cleanBingoWord); source = 'manual';
    } else {
      const made = await makeWords(topic);
      if (!made || bingoWordsProblem(made)) throw new BingoError(503, 'AI_UNAVAILABLE', 'AI가 단어를 만들지 못했어요. 단어 30개를 직접 적어서 열 수 있어요.');
      words = made; source = 'ai';
    }
    const id = crypto.randomUUID();
    await commit(db, user, state.version, (guard, token) => [
      db.prepare(`INSERT INTO bingo_games (id, number, leader_id, request_id, topic, lines, words_json, source, status, created_at)
        SELECT ?, COALESCE((SELECT MAX(number) FROM bingo_games), 0) + 1, ?, ?, ?, ?, ?, ?, 'filling', ? WHERE ${guard}`)
        .bind(id, user.id, input.requestId, topic, input.lines, JSON.stringify(words), source, at, token),
      db.prepare(`UPDATE bingo_state SET leader_id = ?, game_id = ?, waiting_since = NULL WHERE id = 1 AND ${guard}`).bind(user.id, id, token),
    ]);
    return;
  }
  if (action === 'skip' && !active(loaded.game)) {
    // Between games: the lead passes on when the leader has kept everyone waiting.
    const leader = waitingLeader(loaded);
    if (!leader || input.expectedTurnId !== leader) throw changed();
    if (leader === user.id) throw new BingoError(403, 'OWN_TURN', '내 차례는 넘길 수 없어요. 주제를 정해 주세요.');
    if (!(time >= after(state.waiting_since))) throw new BingoError(409, 'SKIP_NOT_READY', '10분이 지나면 리더 차례를 넘길 수 있어요.');
    await commit(db, user, state.version, (guard, token) => passLead(db, guard, token, loaded, leader, `notification:bingo:lead:${state.version}`, at));
    return;
  }
  const game = loaded.game;
  if (!active(game) || game.id !== input.gameId) throw changed();
  const seats = seatsOf(loaded), mine = seats.find(seat => seat.userId === user.id);
  if (action === 'board') {
    if (game.status !== 'filling') throw new BingoError(409, 'ALREADY_STARTED', '빙고가 이미 시작돼서 판을 바꿀 수 없어요.');
    const words = JSON.parse(game.words_json) as string[], problem = bingoBoardProblem(input.cells, words);
    if (problem) throw new BingoError(400, 'INVALID_BOARD', problem);
    const cells = input.cells as string[];
    // Once every active player has a board there is nobody left to wait for.
    const seated = [...seats.filter(seat => seat.userId !== user.id), { userId: user.id, username: loaded.people.get(user.id)?.username ?? user.id, cells, rank: null, active: true }];
    const everyone = [...loaded.people.values()].filter(playing).every(person => seated.some(seat => seat.userId === person.id));
    await commit(db, user, state.version, (guard, token) => [
      db.prepare(`INSERT INTO bingo_boards (game_id, user_id, cells_json, submitted_at) SELECT ?, ?, ?, ? WHERE ${guard}
        ON CONFLICT (game_id, user_id) DO UPDATE SET cells_json = excluded.cells_json, submitted_at = excluded.submitted_at`)
        .bind(game.id, user.id, JSON.stringify(cells), at, token),
      ...(everyone && seated.length >= BINGO_RULES.minPlayers ? startStatements(db, guard, token, loaded, game, seated, at) : []),
    ]);
    return;
  }
  if (action === 'cancel') {
    if (game.status !== 'filling' || game.leader_id !== user.id) throw new BingoError(403, 'CANNOT_CANCEL', '판을 채우는 동안에만 리더가 취소할 수 있어요.');
    await commit(db, user, state.version, (guard, token) => [
      db.prepare(`UPDATE bingo_games SET status = 'cancelled', ended_at = ? WHERE id = ? AND ${guard}`).bind(at, game.id, token),
      ...passLead(db, guard, token, loaded, game.leader_id, `notification:bingo:lead:${game.id}`, at),
    ]);
    return;
  }
  if (action === 'start') {
    if (game.status !== 'filling') return;
    if (seats.length < BINGO_RULES.minPlayers) throw new BingoError(409, 'NOT_ENOUGH_PLAYERS', `판을 낸 사람이 ${BINGO_RULES.minPlayers}명은 있어야 시작할 수 있어요.`);
    if (game.leader_id !== user.id && !(mine && time >= after(game.created_at))) throw new BingoError(403, 'CANNOT_START', '리더가 시작하거나, 판을 낸 사람이 10분 뒤에 시작할 수 있어요.');
    await commit(db, user, state.version, (guard, token) => startStatements(db, guard, token, loaded, game, seats, at));
    return;
  }
  if (game.status !== 'playing') throw changed();
  if (!mine) throw new BingoError(403, 'NOT_SEATED', '이번 판에 참여한 사람만 할 수 있어요.');
  const calls = callsOf(game);
  if (action === 'skip') {
    if (input.expectedTurnId !== game.turn_id) throw changed();
    if (game.turn_id === user.id) throw new BingoError(403, 'OWN_TURN', '내 차례는 넘길 수 없어요. 단어를 골라 주세요.');
    if (!(time >= after(game.turn_started_at))) throw new BingoError(409, 'SKIP_NOT_READY', '10분이 지나면 차례를 넘길 수 있어요.');
    const next = nextBingoTurn(seats, loaded.people.get(game.turn_id ?? '')?.username ?? '');
    if (!next) throw changed();
    await commit(db, user, state.version, (guard, token) => [
      db.prepare(`UPDATE bingo_games SET turn_id = ?, turn_started_at = ? WHERE id = ? AND status = 'playing' AND ${guard}`).bind(next.userId, at, game.id, token),
      notify(db, guard, token, next.userId, 'bingo', `notification:bingo:skip:${game.id}:${state.version}`, at),
    ]);
    return;
  }
  // call: the turn player crosses a word off their own board; it comes off every board that has it.
  if (playClosed(time)) throw new BingoError(409, 'PLAY_CLOSED', PLAY_RULES.closedMessage);
  if (game.turn_id !== user.id) throw new BingoError(403, 'NOT_YOUR_TURN', '지금은 내 차례가 아니에요.');
  const word = typeof input.word === 'string' ? input.word : '';
  if (!mine.cells.includes(word)) throw new BingoError(400, 'INVALID_WORD', '내 빙고판에 있는 단어를 골라 주세요.');
  if (calls.some(call => call.word === word)) throw new BingoError(409, 'ALREADY_CALLED', '이미 지워진 단어예요.');
  const next: BingoCall[] = [...calls, { word, by: user.id, at }];
  const settled = settleBingoCall(seats, game.lines, new Set(next.map(call => call.word)), user.id);
  // If nobody else can take a turn (everyone else was deactivated) the caller keeps it.
  const turn = settled.ended ? null : settled.next?.userId ?? user.id;
  await commit(db, user, state.version, (guard, token) => [
    db.prepare(`UPDATE bingo_games SET calls_json = ?, turn_id = ?, turn_started_at = ?, status = ?, ended_at = ? WHERE id = ? AND status = 'playing' AND ${guard}`)
      .bind(JSON.stringify(next), turn, settled.ended ? null : at, settled.ended ? 'ended' : 'playing', settled.ended ? at : null, game.id, token),
    ...settled.ranked.flatMap(place => [
      db.prepare(`UPDATE bingo_boards SET rank = ?, points = ?, ranked_at = ? WHERE game_id = ? AND user_id = ? AND rank IS NULL AND ${guard}`)
        .bind(place.rank, place.points, at, game.id, place.userId, token),
      // A place is paid the moment it is settled, into the week of that moment.
      ...(place.points ? [db.prepare(`INSERT OR IGNORE INTO ledger (id, user_id, currency, amount, reason, reference, created_at, week_start)
        SELECT ?, ?, 'score', ?, ?, ?, ?, ? WHERE ${guard}`)
        .bind(crypto.randomUUID(), place.userId, place.points, `빙고 ${place.rank}등`, `bingo:${game.id}:${place.userId}:score`, at, weekStart(now), token)] : []),
    ]),
    ...(settled.ended ? passLead(db, guard, token, loaded, game.leader_id, `notification:bingo:lead:${game.id}`, at)
      : turn !== user.id ? [notify(db, guard, token, turn!, 'bingo', `notification:bingo:turn:${game.id}:${next.length}`, at)] : []),
  ]);
}

export async function bingoRoute(db: D1Database, user: Actor, action: string | undefined, method: string, input: Record<string, unknown> | undefined, now: Date, makeWords: BingoWordMaker, since?: number): Promise<BingoPollResponse> {
  if (!action && method === 'GET') {
    if (since !== undefined) {
      // An unchanged poll is one small read.
      const version = await db.prepare('SELECT version FROM bingo_state WHERE id = 1').first<number>('version');
      if (version === since) return { unchanged: true, version, viewerId: user.id, serverTime: now.toISOString(), play: playWindow(now.getTime()) };
    }
    return respond(await load(db), user, now);
  }
  const actions: BingoAction[] = ['create', 'board', 'start', 'call', 'skip', 'cancel'];
  if (!actions.includes(action as BingoAction)) throw new BingoError(404, 'NOT_FOUND', '요청한 빙고 기능이 없어요.');
  if (method !== 'POST') throw new BingoError(405, 'METHOD_NOT_ALLOWED', '지원하지 않는 요청이에요.');
  await mutate(db, user, action as BingoAction, input!, now, makeWords);
  return respond(await load(db), user, now);
}
