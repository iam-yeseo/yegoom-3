import { PLAY_RULES, TOILET_RULES, playWindow } from '../shared/balance';
import { defaultCharacter, type ArtKey } from '../shared/characters';
import {
  burstChance, bursts, nextToiletOpen, nextToiletTurn, previousToiletWindow, toiletOrder, toiletResults, toiletSlots, toiletTurn, toiletWindow, type ToiletWindow,
} from '../shared/toilet';
import type { CatchmindPlayer, ToiletAction, ToiletPollResponse, ToiletPush, ToiletResponse, ToiletRoundView, ToiletState, ToiletSummary } from '../shared/types';
import { weekStart } from './rules';

// 변기 폭파 (docs/plan-toilet.md). A round has no row until its first push;
// before that its order comes from the active players and the round number.
// Each push writes only if the push count it read is still the stored one, so
// two pushes at once never both apply, and the chance is rolled here, never on
// the device.

interface Actor { id: string; role: 'player' | 'admin' }
interface RoundRow {
  id: string; round_date: string; half: 'am' | 'pm'; order_json: string; slots: number; pushes_json: string; push_count: number;
  turn: number | null; turn_started_at: string | null; status: 'playing' | 'burst'; loser_id: string | null; results_json: string | null; created_at: string; ended_at: string | null;
}
interface PersonRow { id: string; username: string; display_name: string; character: ArtKey | null; photo_version: number | null; active: number; role: string }
interface Loaded { current: ToiletWindow | null; previous: ToiletWindow; rows: Map<string, RoundRow>; people: Map<string, PersonRow> }

export class ToiletError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); }
}
const changed = () => new ToiletError(409, 'CHANGED', '그사이에 변기 상황이 바뀌었어요. 새로 불러올게요.');
const playing = (person: PersonRow | undefined) => !!person && person.active === 1 && person.role === 'player';
const iso = (time: number) => new Date(time).toISOString();
const ROUND_COLUMNS = 'id, round_date, half, order_json, slots, pushes_json, push_count, turn, turn_started_at, status, loser_id, results_json, created_at, ended_at';
const PEOPLE = `SELECT id, username, display_name, character, active, role,
  CASE WHEN EXISTS (SELECT 1 FROM user_photos WHERE user_id = users.id) THEN photo_version ELSE NULL END AS photo_version FROM users`;

/** This round and the one before it, every active player, and anyone either round names. Two queries. */
async function load(db: D1Database, now: number): Promise<Loaded> {
  const current = toiletWindow(now), previous = previousToiletWindow(now);
  const rounds = await db.prepare(`SELECT ${ROUND_COLUMNS} FROM toilet_rounds WHERE id IN (?, ?)`).bind(current?.id ?? previous.id, previous.id).all<RoundRow>();
  const named = rounds.results.flatMap(row => JSON.parse(row.order_json) as string[]);
  const people = await db.prepare(`${PEOPLE} WHERE (role = 'player' AND active = 1) OR id IN (SELECT value FROM json_each(?))`).bind(JSON.stringify(named)).all<PersonRow>();
  return { current, previous, rows: new Map(rounds.results.map(row => [row.id, row])), people: new Map(people.results.map(person => [person.id, person])) };
}
const viewOf = (person: PersonRow | undefined): CatchmindPlayer | null => person
  ? { id: person.id, username: person.username, displayName: person.display_name, photoVersion: person.photo_version, character: person.character ?? defaultCharacter(person.username) } : null;

/** A round as the rules see it, stored or not. */
interface Round {
  window: ToiletWindow; row: RoundRow | null; order: string[]; slots: number; pushes: ToiletPush[];
  live: boolean; seat: number; turnStartedAt: string | null;
}
function roundOf(loaded: Loaded, window: ToiletWindow, now: number): Round | null {
  const row = loaded.rows.get(window.id) ?? null;
  const active = (id: string) => playing(loaded.people.get(id));
  const order = row ? JSON.parse(row.order_json) as string[]
    : toiletOrder([...loaded.people.values()].filter(playing), window.index);
  if (!row && order.length < TOILET_RULES.minPlayers) return null;
  const live = (row?.status ?? 'playing') === 'playing' && now < window.endsAt;
  const seat = live ? toiletTurn(order, row?.turn ?? 0, active) : -1;
  return {
    window, row, order, slots: row?.slots ?? toiletSlots(order.length), pushes: row ? JSON.parse(row.pushes_json) as ToiletPush[] : [],
    live: live && seat >= 0, seat, turnStartedAt: live ? row?.turn_started_at ?? iso(window.startsAt) : null,
  };
}
function roundView(loaded: Loaded, round: Round): ToiletRoundView {
  const { window, row } = round;
  const person = (id: string | null | undefined) => viewOf(loaded.people.get(id ?? ''));
  const results = row?.results_json ? JSON.parse(row.results_json) as { userId: string; points: number }[] : [];
  return {
    id: window.id, date: window.date, half: window.half, label: window.label, startsAt: iso(window.startsAt), endsAt: iso(window.endsAt),
    order: round.order.flatMap(id => person(id) ?? []), slots: round.slots, pushes: round.pushes,
    status: row?.status === 'burst' ? 'burst' : !round.live ? 'void' : row ? 'playing' : 'waiting',
    turn: round.live ? person(round.order[round.seat]) : null, turnStartedAt: round.turnStartedAt,
    chance: round.live ? burstChance(round.slots, round.pushes.length) : 0,
    loser: person(row?.loser_id), results: results.flatMap(entry => { const player = person(entry.userId); return player ? [{ player, points: entry.points }] : []; }),
    endedAt: row?.ended_at ?? (round.live ? null : iso(window.endsAt)),
  };
}
function stateView(loaded: Loaded, user: Actor, now: number): ToiletState {
  const current = loaded.current ? roundOf(loaded, loaded.current, now) : null;
  const before = roundOf(loaded, loaded.previous, now);
  const turnId = current?.live ? current.order[current.seat] : null;
  const seated = !!current && user.role === 'player' && current.order.includes(user.id);
  const skipAt = current?.live && current.turnStartedAt ? Date.parse(current.turnStartedAt) + TOILET_RULES.skipAfterMs : NaN;
  return {
    current: current ? roundView(loaded, current) : null,
    // A round before this one is shown only when someone played it.
    previous: before?.row ? roundView(loaded, before) : null,
    canPush: seated && turnId === user.id,
    canSkip: seated && !!turnId && turnId !== user.id && now >= skipAt,
    skipAvailableAt: Number.isFinite(skipAt) ? iso(skipAt) : null,
    nextOpensAt: iso(nextToiletOpen(now)),
  };
}
/** What a poll compares: the round open now and its push count. */
const stampOf = (loaded: Loaded) => { const row = loaded.current ? loaded.rows.get(loaded.current.id) : undefined; return `${loaded.current?.id ?? 'closed'}:${row?.push_count ?? 0}:${row?.status ?? 'none'}`; };
const respond = (loaded: Loaded, user: Actor, now: Date): ToiletResponse => ({
  toilet: stateView(loaded, user, now.getTime()), stamp: stampOf(loaded), viewerId: user.id, serverTime: now.toISOString(), play: playWindow(now.getTime()),
});

/** The home row. One statement: this round's row (if anyone pushed yet) with
 * every active player and anyone it names; nothing is written. */
export async function readToiletSummary(db: D1Database, user: Actor, now: Date): Promise<ToiletSummary> {
  const time = now.getTime(), window = toiletWindow(time);
  if (!window) return { half: null, label: null, status: 'closed', turn: null, loser: null, points: 0, pushes: 0, slots: 0 };
  const found = await db.prepare(`SELECT ${ROUND_COLUMNS.split(', ').map(column => `r.${column}`).join(', ')},
      (SELECT json_group_array(json_object('id', u.id, 'username', u.username, 'display_name', u.display_name, 'active', u.active, 'role', u.role))
        FROM users u WHERE (u.role = 'player' AND u.active = 1) OR u.id IN (SELECT value FROM json_each(COALESCE(r.order_json, '[]')))) AS people_json
    FROM (SELECT 1) LEFT JOIN toilet_rounds r ON r.id = ?`).bind(window.id).first<RoundRow & { people_json: string }>();
  const row = found?.id ? found : null;
  const people = JSON.parse(found?.people_json ?? '[]') as PersonRow[];
  const loaded: Loaded = { current: window, previous: previousToiletWindow(time), rows: new Map(row ? [[row.id, row]] : []), people: new Map(people.map(person => [person.id, person])) };
  const round = roundOf(loaded, window, time);
  const short = (id: string | null | undefined) => { const person = loaded.people.get(id ?? ''); return person ? { username: person.username, displayName: person.display_name } : null; };
  if (!round) return { half: window.half, label: window.label, status: 'void', turn: null, loser: null, points: 0, pushes: 0, slots: 0 };
  const results = row?.results_json ? JSON.parse(row.results_json) as { userId: string; points: number }[] : [];
  return {
    half: window.half, label: window.label, status: row?.status === 'burst' ? 'burst' : !round.live ? 'void' : row ? 'playing' : 'waiting',
    turn: round.live ? short(round.order[round.seat]) : null, loser: short(row?.loser_id),
    points: results.find(entry => entry.userId === user.id)?.points ?? 0, pushes: round.pushes.length, slots: round.slots,
  };
}

const randomUnit = () => crypto.getRandomValues(new Uint32Array(1))[0]! / 2 ** 32;

async function push(db: D1Database, user: Actor, action: ToiletAction, input: Record<string, unknown>, now: Date, random: () => number): Promise<void> {
  if (user.role !== 'player') throw new ToiletError(403, 'CANNOT_PLAY', '플레이어만 변기 폭파에 참여할 수 있어요.');
  const time = now.getTime(), at = now.toISOString();
  const window = toiletWindow(time);
  if (!window) throw new ToiletError(409, 'PLAY_CLOSED', PLAY_RULES.closedMessage);
  if (input.roundId !== window.id || typeof input.pushes !== 'number') throw changed();
  const loaded = await load(db, time);
  const round = roundOf(loaded, window, time);
  if (!round) throw new ToiletError(409, 'NOT_ENOUGH_PLAYERS', `플레이어가 ${TOILET_RULES.minPlayers}명은 있어야 열려요.`);
  if (round.row?.status === 'burst') throw new ToiletError(409, 'BURST', '이번 판 변기는 이미 터졌어요. 다음 판을 기다려 주세요.');
  if (!round.order.includes(user.id)) throw new ToiletError(403, 'NOT_SEATED', '이번 판이 시작된 뒤에 들어와서 다음 판부터 참여할 수 있어요.');
  if (input.pushes !== round.pushes.length || !round.live) throw changed();
  const turnId = round.order[round.seat]!;
  if (action === 'push' && turnId !== user.id) throw new ToiletError(403, 'NOT_YOUR_TURN', '지금은 내 차례가 아니에요.');
  if (action === 'skip') {
    if (turnId === user.id) throw new ToiletError(403, 'OWN_TURN', '내 차례예요. 직접 눌러 주세요.');
    if (!(time >= Date.parse(round.turnStartedAt!) + TOILET_RULES.skipAfterMs)) throw new ToiletError(409, 'SKIP_NOT_READY', '10분이 지나면 대신 누를 수 있어요.');
  }
  const active = (id: string) => playing(loaded.people.get(id));
  const burst = bursts(random(), round.slots, round.pushes.length);
  const pushes: ToiletPush[] = [...round.pushes, { for: turnId, by: user.id, at }];
  const nextSeat = burst ? null : nextToiletTurn(round.order, round.seat, active);
  const results = burst ? toiletResults(round.order, turnId, active) : null;
  const token = crypto.randomUUID();
  const values = [JSON.stringify(pushes), pushes.length, nextSeat, burst ? null : at, burst ? 'burst' : 'playing', burst ? turnId : null, results ? JSON.stringify(results) : null, token, burst ? at : null];
  const pusherActive = "EXISTS (SELECT 1 FROM users WHERE id = ? AND role = 'player' AND active = 1)";
  const guard = 'EXISTS (SELECT 1 FROM toilet_rounds WHERE id = ? AND token = ?)';
  const write = round.row
    ? db.prepare(`UPDATE toilet_rounds SET pushes_json = ?, push_count = ?, turn = ?, turn_started_at = ?, status = ?, loser_id = ?, results_json = ?, token = ?, ended_at = ?
        WHERE id = ? AND push_count = ? AND status = 'playing' AND ${pusherActive}`).bind(...values, window.id, round.pushes.length, user.id)
    : db.prepare(`INSERT INTO toilet_rounds (pushes_json, push_count, turn, turn_started_at, status, loser_id, results_json, token, ended_at, id, round_date, half, order_json, slots, created_at)
        SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE ${pusherActive} ON CONFLICT (id) DO NOTHING`)
      .bind(...values, window.id, window.date, window.half, JSON.stringify(round.order), round.slots, at, user.id);
  const notify = (userId: string, actorId: string, payload: object, reference: string) =>
    db.prepare(`INSERT OR IGNORE INTO notifications (kind, audience, user_id, actor_id, payload_json, created_at, reference)
      SELECT 'game', 'user', ?, ?, ?, ?, ? WHERE ${guard}`).bind(userId, actorId, JSON.stringify(payload), at, reference, window.id, token);
  const nextId = nextSeat === null ? null : round.order[nextSeat]!;
  await db.batch([
    write,
    ...(results ?? []).flatMap(entry => [
      db.prepare(`INSERT OR IGNORE INTO ledger (id, user_id, currency, amount, reason, reference, created_at, week_start)
        SELECT ?, ?, 'score', ?, ?, ?, ?, ? WHERE ${guard}`)
        .bind(crypto.randomUUID(), entry.userId, entry.points, entry.points < 0 ? `변기 폭파 ${window.label} · 펑!` : `변기 폭파 ${window.label} · 생존`,
          `toilet:${window.id}:${entry.userId}:score`, at, weekStart(now), window.id, token),
      notify(entry.userId, turnId, { kind: 'toilet', half: window.half, points: entry.points }, `notification:toilet:${window.id}:${entry.userId}`),
    ]),
    ...(nextId && nextId !== user.id ? [notify(nextId, nextId, { kind: 'turn', game: 'toilet' }, `notification:toilet:turn:${window.id}:${pushes.length}`)] : []),
  ]);
  if (await db.prepare('SELECT token FROM toilet_rounds WHERE id = ?').bind(window.id).first<string>('token') === token) return;
  if (!await db.prepare("SELECT 1 FROM users WHERE id = ? AND role = 'player' AND active = 1").bind(user.id).first()) throw new ToiletError(403, 'CANNOT_PLAY', '활성 플레이어만 변기 폭파에 참여할 수 있어요.');
  throw changed();
}

export async function toiletRoute(db: D1Database, user: Actor, action: string | undefined, method: string, input: Record<string, unknown> | undefined, now: Date,
  since?: string, random: () => number = randomUnit): Promise<ToiletPollResponse> {
  if (!action && method === 'GET') {
    const window = toiletWindow(now.getTime());
    if (since !== undefined && window) {
      // An unchanged poll is one small read.
      const row = await db.prepare('SELECT push_count, status FROM toilet_rounds WHERE id = ?').bind(window.id).first<{ push_count: number; status: string }>();
      const stamp = `${window.id}:${row?.push_count ?? 0}:${row?.status ?? 'none'}`;
      if (stamp === since) return { unchanged: true, stamp, viewerId: user.id, serverTime: now.toISOString(), play: playWindow(now.getTime()) };
    }
    return respond(await load(db, now.getTime()), user, now);
  }
  if (action !== 'push' && action !== 'skip') throw new ToiletError(404, 'NOT_FOUND', '요청한 변기 폭파 기능이 없어요.');
  if (method !== 'POST') throw new ToiletError(405, 'METHOD_NOT_ALLOWED', '지원하지 않는 요청이에요.');
  await push(db, user, action, input ?? {}, now, random);
  return respond(await load(db, now.getTime()), user, now);
}
