import { FREETHROW_MAX_SHOTS, FREETHROW_RULES, PLAY_RULES, freeThrowDeadline, freeThrowSlot, freeThrowSlotStart, playClosed, scoreCounts } from '../shared/balance';
import { simulateShot, validShot } from '../shared/freethrow-physics';
import type {
  FreeThrowBoardEntry, FreeThrowFinishResponse, FreeThrowSet, FreeThrowShotInput, FreeThrowShotRecord, FreeThrowState, FreeThrowSummary,
} from '../shared/types';
import { kstDate, weekStart } from './rules';

// An official set is thrown on the device for 30 seconds and recorded in one
// request once its last ball lands (docs/plan-freethrow.md §3). Starting uses
// the slot's chance; a set that is never recorded (the player left) ends
// unfinished at its deadline.

interface Actor { id: string; role: 'player' | 'admin' }
interface SetRow {
  id: string; request_id: string; slot: number; engine: number; shots: number; made: number;
  points: number; gold: number; inputs_json: string | null; results_json: string | null; finish_token: string | null; finished_at: string | null;
}
interface BoardRow { username: string; slot: number; made: number }

export class FreeThrowError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); }
}
const requestIdValid = (value: unknown): value is string => typeof value === 'string' && /^[a-zA-Z0-9_-]{16,80}$/.test(value);
const setIdValid = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f-]{36}$/.test(value);
const { durationMs, minGapMs, goalScore, goalGold, engine } = FREETHROW_RULES;
/** A set belongs to the KST day its slot starts on. A set recorded after that
 * day closed (23:50), e.g. the 21시 set's grace past midnight, pays gold but no score. */
const setDay = (slot: number) => kstDate(new Date(freeThrowSlotStart(slot)));
const completedRow = (row: Pick<SetRow, 'finished_at'>) => row.finished_at !== null;
const finishedAt = (row: Pick<SetRow, 'slot' | 'finished_at'>, now: number) => completedRow(row) || now >= freeThrowDeadline(row.slot);
const SET_COLUMNS = 'id, request_id, slot, engine, shots, made, points, gold, inputs_json, results_json, finish_token, finished_at';

/** This slot's set, or the previous slot's while it can still be recorded. */
async function recentSet(db: D1Database, user: Actor, now: number): Promise<{ current: SetRow | null; thisSlot: SetRow | null }> {
  const slot = freeThrowSlot(now);
  const rows = (await db.prepare(`SELECT ${SET_COLUMNS} FROM freethrow_sets WHERE user_id = ? AND slot >= ? ORDER BY slot DESC`)
    .bind(user.id, slot - 1).all<SetRow>()).results;
  const thisSlot = rows.find(row => row.slot === slot) ?? null;
  const previous = rows.find(row => row.slot === slot - 1 && !finishedAt(row, now)) ?? null;
  return { current: thisSlot ?? previous, thisSlot };
}
function summaryOf(user: Actor, sets: { thisSlot: SetRow | null }, now: number): FreeThrowSummary {
  const player = user.role === 'player', set = sets.thisSlot;
  return {
    available: player && !set,
    played: player && !!set, completed: player && !!set && completedRow(set), made: set && completedRow(set) ? set.made : 0,
    nextSlotAt: freeThrowSlotStart(freeThrowSlot(now) + 1), serverNow: now, isAdmin: !player,
  };
}

/** Bootstrap reads one indexed range of this player's rows; nothing is written. */
export async function getFreeThrowSummary(db: D1Database, user: Actor, now = Date.now()): Promise<FreeThrowSummary> {
  return summaryOf(user, user.role === 'player' ? await recentSet(db, user, now) : { thisSlot: null }, now);
}

function setView(row: SetRow, now: number): FreeThrowSet {
  return {
    id: row.id, requestId: row.request_id, slot: row.slot, slotStart: freeThrowSlotStart(row.slot), deadline: freeThrowDeadline(row.slot),
    engine: row.engine, made: row.made, shots: row.results_json ? JSON.parse(row.results_json) as FreeThrowShotRecord[] : [],
    completed: completedRow(row), finished: finishedAt(row, now), points: row.points, gold: row.gold,
  };
}

export async function getFreeThrowState(db: D1Database, user: Actor, now = Date.now()): Promise<FreeThrowState> {
  const slot = freeThrowSlot(now), date = kstDate(new Date(now));
  const [sets, board] = await Promise.all([
    user.role === 'player' ? recentSet(db, user, now) : Promise.resolve({ current: null, thisSlot: null }),
    db.prepare(`SELECT u.username, s.slot, s.made FROM freethrow_sets s JOIN users u ON u.id = s.user_id
      WHERE s.date = ? AND s.finished_at IS NOT NULL AND u.role = 'player' AND u.active = 1 ORDER BY s.slot, u.username`).bind(date).all<BoardRow>(),
  ]);
  const today: FreeThrowBoardEntry[] = board.results.map(row => ({ username: row.username, slot: row.slot, slotStart: freeThrowSlotStart(row.slot), made: row.made, completed: true }));
  return { ...summaryOf(user, sets, now), date, slot, slotStart: freeThrowSlotStart(slot), current: sets.current ? setView(sets.current, now) : null, today };
}

export async function startFreeThrowSet(db: D1Database, user: Actor, input: Record<string, unknown>, now = Date.now()): Promise<FreeThrowState> {
  if (user.role !== 'player') throw new FreeThrowError(403, 'CANNOT_PLAY', '플레이어만 공식 도전을 할 수 있어요. 연습 모드는 누구나 던질 수 있어요.');
  if (!requestIdValid(input.requestId)) throw new FreeThrowError(400, 'INVALID_SET', '요청 번호가 올바르지 않아요.');
  const prior = () => db.prepare('SELECT slot FROM freethrow_sets WHERE user_id = ? AND request_id = ?').bind(user.id, input.requestId).first<{ slot: number }>();
  // A retried start returns the same set; it never opens a second one.
  if (await prior()) return getFreeThrowState(db, user, now);
  if (playClosed(now)) throw new FreeThrowError(409, 'PLAY_CLOSED', PLAY_RULES.closedMessage);
  const slot = freeThrowSlot(now);
  // UNIQUE(user_id, slot) settles concurrent starts.
  await db.prepare(`INSERT OR IGNORE INTO freethrow_sets (id, user_id, request_id, slot, date, engine, created_at)
    SELECT ?, u.id, ?, ?, ?, ?, ? FROM users u WHERE u.id = ? AND u.role = 'player' AND u.active = 1`)
    .bind(crypto.randomUUID(), input.requestId, slot, setDay(slot), engine, new Date(now).toISOString(), user.id).run();
  if (!(await prior())) {
    const active = await db.prepare("SELECT 1 FROM users WHERE id = ? AND role = 'player' AND active = 1").bind(user.id).first();
    if (!active) throw new FreeThrowError(403, 'CANNOT_PLAY', '활성 플레이어만 공식 도전을 할 수 있어요.');
    throw new FreeThrowError(409, 'SET_USED', '이번 시간의 공식 도전은 이미 시작했어요. 다음 세트를 기다려 주세요.');
  }
  return getFreeThrowState(db, user, now);
}

/** The balls of a set in a fixed shape, or why they cannot be one: each ball
 * left the hand inside the 30 seconds, in order, and no faster than a hand can. */
export function cleanShots(value: unknown): FreeThrowShotInput[] | string {
  if (!Array.isArray(value) || value.length > FREETHROW_MAX_SHOTS) return '던진 공의 기록이 올바르지 않아요.';
  let last = -minGapMs;
  const shots: FreeThrowShotInput[] = [];
  for (const shot of value as unknown[]) {
    if (!validShot(shot)) return '세기와 방향이 올바르지 않아요.';
    const t = (shot as { t?: unknown }).t;
    if (!Number.isInteger(t) || (t as number) < 0 || (t as number) > durationMs || (t as number) - last < minGapMs) return '던진 시간이 올바르지 않아요.';
    last = t as number;
    shots.push({ power: shot.power, aim: shot.aim, t: t as number });
  }
  return shots;
}

/** Records a whole set: every ball's power and aim, simulated again here. */
export async function finishFreeThrowSet(db: D1Database, user: Actor, input: Record<string, unknown>, now = Date.now()): Promise<FreeThrowFinishResponse> {
  if (user.role !== 'player') throw new FreeThrowError(403, 'CANNOT_PLAY', '플레이어만 공식 도전을 할 수 있어요.');
  if (!setIdValid(input.setId)) throw new FreeThrowError(400, 'INVALID_SET', '세트 번호가 올바르지 않아요.');
  const shots = cleanShots(input.shots);
  if (typeof shots === 'string') throw new FreeThrowError(400, 'INVALID_SET', shots);
  const setId = input.setId, inputsJson = JSON.stringify(shots);
  const read = () => db.prepare(`SELECT ${SET_COLUMNS} FROM freethrow_sets WHERE id = ? AND user_id = ?`).bind(setId, user.id).first<SetRow>();
  const set = await read();
  if (!set) throw new FreeThrowError(404, 'SET_NOT_FOUND', '이 세트를 찾을 수 없어요. 화면을 새로고침해 주세요.');
  const respond = async (row: SetRow, replayed: boolean): Promise<FreeThrowFinishResponse> => ({ ...await getFreeThrowState(db, user, now), set: setView(row, now), replayed });
  if (completedRow(set)) {
    // A retry of a recorded set (lost response) returns it; a different one is refused.
    if (set.inputs_json === inputsJson) return respond(set, true);
    throw new FreeThrowError(409, 'SET_CONFLICT', '이 세트는 이미 다르게 기록됐어요. 화면을 새로고침해 주세요.');
  }
  if (set.engine !== engine) throw new FreeThrowError(409, 'ENGINE_CHANGED', '게임이 업데이트됐어요. 이 세트는 마감됐어요.');
  const deadline = freeThrowDeadline(set.slot);
  if (now >= deadline) throw new FreeThrowError(409, 'SET_CLOSED', '이 세트의 시간이 끝나서 미완료로 기록됐어요.');
  // One simulation per ball; the browser has already shown the same shots.
  const results: FreeThrowShotRecord[] = shots.map((shot, index) => {
    const result = simulateShot(shot);
    return { index, power: shot.power, aim: shot.aim, made: result.made, kind: result.kind };
  });
  const made = results.filter(result => result.made).length;
  const points = scoreCounts(setDay(set.slot), now) ? made * goalScore : 0, gold = made * goalGold;
  const date = new Date(now), finishedIso = date.toISOString(), token = crypto.randomUUID();
  const writes: D1PreparedStatement[] = [db.prepare(`UPDATE freethrow_sets SET shots = ?, made = ?, points = ?, gold = ?, inputs_json = ?, results_json = ?, finish_token = ?, finished_at = ?
    WHERE id = ? AND user_id = ? AND finished_at IS NULL AND engine = ? AND ? < ?
      AND EXISTS (SELECT 1 FROM users WHERE id = freethrow_sets.user_id AND role = 'player' AND active = 1)`)
    .bind(shots.length, made, points, gold, inputsJson, JSON.stringify(results), token, finishedIso, setId, user.id, engine, now, deadline)];
  // Ledger rows are written only when this request recorded the set.
  for (const [currency, amount] of [['score', points], ['gold', gold]] as const) {
    if (amount) writes.push(db.prepare(`INSERT OR IGNORE INTO ledger (id, user_id, currency, amount, reason, reference, created_at, week_start)
      SELECT ?, s.user_id, ?, ?, '자유투 대결 골', ?, s.finished_at, ? FROM freethrow_sets s WHERE s.id = ? AND s.finish_token = ?`)
      .bind(crypto.randomUUID(), currency, amount, `freethrow:set:${setId}:${currency}`, currency === 'score' ? weekStart(date) : null, setId, token));
  }
  await db.batch(writes);
  const saved = await read();
  if (!saved || !completedRow(saved)) {
    const active = await db.prepare("SELECT 1 FROM users WHERE id = ? AND role = 'player' AND active = 1").bind(user.id).first();
    if (!active) throw new FreeThrowError(403, 'CANNOT_PLAY', '활성 플레이어만 공식 도전을 할 수 있어요.');
    throw new FreeThrowError(409, 'SET_CLOSED', '세트 상태가 바뀌었어요. 화면을 새로고침해 주세요.');
  }
  // A concurrent identical request may have won: then this one is a replay.
  if (saved.inputs_json !== inputsJson) throw new FreeThrowError(409, 'SET_CONFLICT', '이 세트는 이미 다르게 기록됐어요. 화면을 새로고침해 주세요.');
  return respond(saved, saved.finish_token !== token);
}
