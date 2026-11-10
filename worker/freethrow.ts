import { FREETHROW_RULES, PLAY_RULES, freeThrowDeadline, freeThrowSlot, freeThrowSlotStart, playClosed, scoreCounts } from '../shared/balance';
import { simulateShot, validShot } from '../shared/freethrow-physics';
import type {
  FreeThrowBoardEntry, FreeThrowFinishResponse, FreeThrowSet, FreeThrowShotRecord, FreeThrowState, FreeThrowSummary,
} from '../shared/types';
import { kstDate, weekStart } from './rules';

// An official set is thrown on the device and recorded in one request once its
// 10th ball lands (docs/plan-freethrow.md §3). Starting uses the slot's chance;
// a set that is never recorded (the player left) ends unfinished at its deadline.

interface Actor { id: string; role: 'player' | 'admin' }
interface SetRow { id: string; request_id: string; slot: number; engine: number; shots: number; made: number }
interface ShotRow { id: string; shot_index: number; power: number; aim: number; made: number; kind: string; created_at: string }
interface BoardRow { username: string; slot: number; made: number }

export class FreeThrowError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); }
}
const requestIdValid = (value: unknown): value is string => typeof value === 'string' && /^[a-zA-Z0-9_-]{16,80}$/.test(value);
const setIdValid = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f-]{36}$/.test(value);
const { shotsPerSet, goalScore, goalGold, engine } = FREETHROW_RULES;
/** A set belongs to the KST day its slot starts on. A set recorded after that
 * day closed (23:50), e.g. the 21시 set's grace past midnight, pays gold but no score. */
const setDay = (slot: number) => kstDate(new Date(freeThrowSlotStart(slot)));
const goalCounts = (slot: number, at: number) => scoreCounts(setDay(slot), at);
const completedRow = (row: Pick<SetRow, 'shots'>) => row.shots >= shotsPerSet;
const finishedAt = (row: Pick<SetRow, 'slot' | 'shots'>, now: number) => completedRow(row) || now >= freeThrowDeadline(row.slot);
const SET_COLUMNS = 'id, request_id, slot, engine, shots, made';

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

const shotView = (row: ShotRow): FreeThrowShotRecord => ({ index: row.shot_index, power: row.power, aim: row.aim, made: row.made === 1, kind: row.kind });
async function setView(db: D1Database, row: SetRow, now: number): Promise<FreeThrowSet> {
  const rows = (await db.prepare('SELECT id, shot_index, power, aim, made, kind, created_at FROM freethrow_shots WHERE set_id = ? ORDER BY shot_index')
    .bind(row.id).all<ShotRow>()).results;
  const scored = rows.filter(shot => shot.made === 1 && goalCounts(row.slot, Date.parse(shot.created_at))).length;
  return {
    id: row.id, requestId: row.request_id, slot: row.slot, slotStart: freeThrowSlotStart(row.slot), deadline: freeThrowDeadline(row.slot),
    engine: row.engine, made: row.made, shots: rows.map(shotView), completed: completedRow(row), finished: finishedAt(row, now),
    points: scored * goalScore, gold: row.made * goalGold,
  };
}

export async function getFreeThrowState(db: D1Database, user: Actor, now = Date.now()): Promise<FreeThrowState> {
  const slot = freeThrowSlot(now), date = kstDate(new Date(now));
  const [sets, board] = await Promise.all([
    user.role === 'player' ? recentSet(db, user, now) : Promise.resolve({ current: null, thisSlot: null }),
    db.prepare(`SELECT u.username, s.slot, s.made FROM freethrow_sets s JOIN users u ON u.id = s.user_id
      WHERE s.date = ? AND s.shots = ? AND u.role = 'player' AND u.active = 1 ORDER BY s.slot, u.username`).bind(date, shotsPerSet).all<BoardRow>(),
  ]);
  const today: FreeThrowBoardEntry[] = board.results.map(row => ({ username: row.username, slot: row.slot, slotStart: freeThrowSlotStart(row.slot), made: row.made, completed: true }));
  return { ...summaryOf(user, sets, now), date, slot, slotStart: freeThrowSlotStart(slot), current: sets.current ? await setView(db, sets.current, now) : null, today };
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

export function validateFinishInput(value: unknown): string | null {
  const input = value && typeof value === 'object' ? value as Record<string, unknown> : null;
  if (!input || !setIdValid(input.setId)) return '세트 번호가 올바르지 않아요.';
  if (!Array.isArray(input.shots) || input.shots.length !== shotsPerSet) return `${shotsPerSet}구의 기록이 모두 필요해요.`;
  if (!input.shots.every(shot => validShot(shot))) return '세기와 방향이 올바르지 않아요.';
  return null;
}

/** Records a whole set: every ball's power and aim, simulated again here. */
export async function finishFreeThrowSet(db: D1Database, user: Actor, input: Record<string, unknown>, now = Date.now()): Promise<FreeThrowFinishResponse> {
  if (user.role !== 'player') throw new FreeThrowError(403, 'CANNOT_PLAY', '플레이어만 공식 도전을 할 수 있어요.');
  const invalid = validateFinishInput(input);
  if (invalid) throw new FreeThrowError(400, 'INVALID_SET', invalid);
  const setId = input.setId as string, shots = (input.shots as { power: number; aim: number }[]).map(shot => ({ power: shot.power, aim: shot.aim }));
  const set = await db.prepare(`SELECT ${SET_COLUMNS} FROM freethrow_sets WHERE id = ? AND user_id = ?`).bind(setId, user.id).first<SetRow>();
  if (!set) throw new FreeThrowError(404, 'SET_NOT_FOUND', '이 세트를 찾을 수 없어요. 화면을 새로고침해 주세요.');
  const recorded = async () => (await db.prepare('SELECT power, aim FROM freethrow_shots WHERE set_id = ? ORDER BY shot_index').bind(setId).all<{ power: number; aim: number }>()).results;
  const same = (rows: { power: number; aim: number }[]) => rows.length === shotsPerSet && rows.every((row, i) => row.power === shots[i]!.power && row.aim === shots[i]!.aim);
  const respond = async (replayed: boolean): Promise<FreeThrowFinishResponse> => {
    const row = await db.prepare(`SELECT ${SET_COLUMNS} FROM freethrow_sets WHERE id = ?`).bind(setId).first<SetRow>();
    return { ...await getFreeThrowState(db, user, now), set: await setView(db, row!, now), replayed };
  };
  if (completedRow(set)) {
    // A retry of a recorded set (lost response) returns it; a different one is refused.
    if (same(await recorded())) return respond(true);
    throw new FreeThrowError(409, 'SET_CONFLICT', '이 세트는 이미 다르게 기록됐어요. 화면을 새로고침해 주세요.');
  }
  if (set.shots > 0) throw new FreeThrowError(409, 'SET_CLOSED', '이 세트는 미완료로 끝났어요.');
  if (set.engine !== engine) throw new FreeThrowError(409, 'ENGINE_CHANGED', '게임이 업데이트됐어요. 이 세트는 마감됐어요.');
  if (now >= freeThrowDeadline(set.slot)) throw new FreeThrowError(409, 'SET_CLOSED', '이 세트의 시간이 끝나서 미완료로 기록됐어요.');
  // One simulation per ball; the browser has already shown the same shots.
  const results = shots.map(shot => simulateShot(shot));
  const made = results.filter(result => result.made).length;
  const date = new Date(now), createdAt = date.toISOString();
  const ids = results.map(() => crypto.randomUUID());
  const writes: D1PreparedStatement[] = results.map((result, i) =>
    db.prepare(`INSERT OR IGNORE INTO freethrow_shots (id, set_id, shot_index, power, aim, made, kind, created_at)
      SELECT ?, s.id, ?, ?, ?, ?, ?, ? FROM freethrow_sets s JOIN users u ON u.id = s.user_id
      WHERE s.id = ? AND s.user_id = ? AND s.shots = 0 AND s.engine = ? AND u.role = 'player' AND u.active = 1 AND ? < ?`)
      .bind(ids[i], i, shots[i]!.power, shots[i]!.aim, result.made ? 1 : 0, result.kind, createdAt, setId, user.id, engine, now, freeThrowDeadline(set.slot)));
  writes.push(db.prepare(`UPDATE freethrow_sets SET shots = ?, made = ?
    WHERE id = ? AND shots = 0 AND (SELECT COUNT(*) FROM freethrow_shots WHERE set_id = ? AND id IN (${ids.map(() => '?').join(', ')})) = ?`)
    .bind(shotsPerSet, made, setId, setId, ...ids, shotsPerSet));
  if (made) {
    // Ledger rows are written only when this request's shot rows were inserted.
    const witness = ids[shotsPerSet - 1]!;
    for (const [currency, amount] of [...(goalCounts(set.slot, now) ? [['score', made * goalScore]] as const : []), ['gold', made * goalGold]] as const) {
      writes.push(db.prepare(`INSERT OR IGNORE INTO ledger (id, user_id, currency, amount, reason, reference, created_at, week_start)
        SELECT ?, s.user_id, ?, ?, '자유투 대결 골', ?, sh.created_at, ? FROM freethrow_shots sh JOIN freethrow_sets s ON s.id = sh.set_id WHERE sh.id = ?`)
        .bind(crypto.randomUUID(), currency, amount, `freethrow:set:${setId}:${currency}`, currency === 'score' ? weekStart(date) : null, witness));
    }
  }
  await db.batch(writes);
  const saved = await db.prepare(`SELECT ${SET_COLUMNS} FROM freethrow_sets WHERE id = ?`).bind(setId).first<SetRow>();
  if (!saved || !completedRow(saved)) {
    const active = await db.prepare("SELECT 1 FROM users WHERE id = ? AND role = 'player' AND active = 1").bind(user.id).first();
    if (!active) throw new FreeThrowError(403, 'CANNOT_PLAY', '활성 플레이어만 공식 도전을 할 수 있어요.');
    throw new FreeThrowError(409, 'SET_CLOSED', '세트 상태가 바뀌었어요. 화면을 새로고침해 주세요.');
  }
  // A concurrent identical request may have won: then this one is a replay.
  if (!same(await recorded())) throw new FreeThrowError(409, 'SET_CONFLICT', '이 세트는 이미 다르게 기록됐어요. 화면을 새로고침해 주세요.');
  const mine = await db.prepare('SELECT 1 FROM freethrow_shots WHERE id = ?').bind(ids[shotsPerSet - 1]).first();
  return respond(!mine);
}
