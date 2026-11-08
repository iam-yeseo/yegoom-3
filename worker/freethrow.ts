import { FREETHROW_RULES, freeThrowDeadline, freeThrowSlot, freeThrowSlotStart } from '../shared/balance';
import { simulateShot, validShot } from '../shared/freethrow-physics';
import type {
  FreeThrowBoardEntry, FreeThrowSet, FreeThrowShotRecord, FreeThrowShotResponse, FreeThrowState, FreeThrowSummary,
} from '../shared/types';
import { kstDate, weekStart } from './rules';

interface Actor { id: string; role: 'player' | 'admin' }
interface SetRow { id: string; request_id: string; slot: number; engine: number; shots: number; made: number }
interface ShotRow { id: string; shot_index: number; power: number; aim: number; made: number; kind: string }
interface BoardRow { username: string; slot: number; made: number; shots: number }

export class FreeThrowError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); }
}
const requestIdValid = (value: unknown): value is string => typeof value === 'string' && /^[a-zA-Z0-9_-]{16,80}$/.test(value);
const setIdValid = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f-]{36}$/.test(value);
const { shotsPerSet, goalScore, goalGold, engine } = FREETHROW_RULES;
const finishedAt = (row: Pick<SetRow, 'slot' | 'shots'>, now: number) => row.shots >= shotsPerSet || now >= freeThrowDeadline(row.slot);

/** The player's two most recent slots: the current one and, while its grace
 * time lasts, an unfinished set from the previous slot. */
async function recentSets(db: D1Database, user: Actor, now: number): Promise<{ open: SetRow | null; currentSlot: SetRow | null }> {
  const slot = freeThrowSlot(now);
  const rows = (await db.prepare('SELECT id, request_id, slot, engine, shots, made FROM freethrow_sets WHERE user_id = ? AND slot >= ? ORDER BY slot DESC')
    .bind(user.id, slot - 1).all<SetRow>()).results;
  const currentSlot = rows.find(row => row.slot === slot) ?? null;
  const previous = rows.find(row => row.slot === slot - 1 && !finishedAt(row, now)) ?? null;
  return { open: previous, currentSlot };
}
function summaryOf(user: Actor, sets: { open: SetRow | null; currentSlot: SetRow | null }, now: number): FreeThrowSummary {
  const active = sets.open ?? sets.currentSlot;
  const player = user.role === 'player';
  return {
    available: player && !sets.open && !sets.currentSlot,
    inProgress: player && !!active && !finishedAt(active, now),
    made: active?.made ?? 0, shots: active?.shots ?? 0,
    nextSlotAt: freeThrowSlotStart(freeThrowSlot(now) + 1), serverNow: now, isAdmin: !player,
  };
}

/** Bootstrap reads one indexed range of this player's rows; nothing is written. */
export async function getFreeThrowSummary(db: D1Database, user: Actor, now = Date.now()): Promise<FreeThrowSummary> {
  return summaryOf(user, user.role === 'player' ? await recentSets(db, user, now) : { open: null, currentSlot: null }, now);
}

async function setView(db: D1Database, row: SetRow, now: number): Promise<FreeThrowSet> {
  const shots = (await db.prepare('SELECT id, shot_index, power, aim, made, kind FROM freethrow_shots WHERE set_id = ? ORDER BY shot_index')
    .bind(row.id).all<ShotRow>()).results.map(shotView);
  return {
    id: row.id, requestId: row.request_id, slot: row.slot, slotStart: freeThrowSlotStart(row.slot), deadline: freeThrowDeadline(row.slot),
    engine: row.engine, made: row.made, shots, finished: finishedAt(row, now), points: row.made * goalScore, gold: row.made * goalGold,
  };
}
const shotView = (row: ShotRow): FreeThrowShotRecord => ({ index: row.shot_index, power: row.power, aim: row.aim, made: row.made === 1, kind: row.kind });

export async function getFreeThrowState(db: D1Database, user: Actor, now = Date.now()): Promise<FreeThrowState> {
  const slot = freeThrowSlot(now), date = kstDate(new Date(now));
  const [sets, board] = await Promise.all([
    user.role === 'player' ? recentSets(db, user, now) : Promise.resolve({ open: null, currentSlot: null }),
    db.prepare(`SELECT u.username, s.slot, s.made, s.shots FROM freethrow_sets s JOIN users u ON u.id = s.user_id
      WHERE s.date = ? AND u.role = 'player' AND u.active = 1 ORDER BY s.slot, u.username`).bind(date).all<BoardRow>(),
  ]);
  const active = sets.open ?? sets.currentSlot;
  const today: FreeThrowBoardEntry[] = board.results.map(row => ({ username: row.username, slot: row.slot, slotStart: freeThrowSlotStart(row.slot),
    made: row.made, shots: row.shots, finished: finishedAt(row, now) }));
  return { ...summaryOf(user, sets, now), date, slot, slotStart: freeThrowSlotStart(slot), current: active ? await setView(db, active, now) : null, today };
}

export async function startFreeThrowSet(db: D1Database, user: Actor, input: Record<string, unknown>, now = Date.now()): Promise<FreeThrowState> {
  if (user.role !== 'player') throw new FreeThrowError(403, 'CANNOT_PLAY', '플레이어만 공식 도전을 할 수 있어요. 연습 모드는 누구나 던질 수 있어요.');
  if (!requestIdValid(input.requestId)) throw new FreeThrowError(400, 'INVALID_SET', '요청 번호가 올바르지 않아요.');
  const prior = () => db.prepare('SELECT slot FROM freethrow_sets WHERE user_id = ? AND request_id = ?').bind(user.id, input.requestId).first<{ slot: number }>();
  // A retried start returns the same set; it never opens a second one.
  if (await prior()) return getFreeThrowState(db, user, now);
  const sets = await recentSets(db, user, now);
  if (sets.open) throw new FreeThrowError(409, 'SET_IN_PROGRESS', '지난 세트를 먼저 마쳐 주세요.');
  if (sets.currentSlot) throw new FreeThrowError(409, 'SET_USED', '이번 시간의 공식 도전은 이미 시작했어요. 다음 세트를 기다려 주세요.');
  const slot = freeThrowSlot(now);
  const previousOpen = now < freeThrowDeadline(slot - 1) ? 1 : 0;
  // UNIQUE(user_id, slot) settles concurrent starts. A previous set still in
  // its grace time blocks a new one inside the same statement.
  await db.prepare(`INSERT OR IGNORE INTO freethrow_sets (id, user_id, request_id, slot, date, engine, created_at)
    SELECT ?, u.id, ?, ?, ?, ?, ? FROM users u WHERE u.id = ? AND u.role = 'player' AND u.active = 1
      AND NOT (? = 1 AND EXISTS (SELECT 1 FROM freethrow_sets p WHERE p.user_id = u.id AND p.slot = ? AND p.shots < ?))`)
    .bind(crypto.randomUUID(), input.requestId, slot, kstDate(new Date(freeThrowSlotStart(slot))), engine, new Date(now).toISOString(),
      user.id, previousOpen, slot - 1, shotsPerSet).run();
  if (!(await prior())) {
    const active = await db.prepare("SELECT 1 FROM users WHERE id = ? AND role = 'player' AND active = 1").bind(user.id).first();
    if (!active) throw new FreeThrowError(403, 'CANNOT_PLAY', '활성 플레이어만 공식 도전을 할 수 있어요.');
    throw new FreeThrowError(409, 'SET_USED', '이번 시간의 공식 도전은 이미 시작했어요. 다음 세트를 기다려 주세요.');
  }
  return getFreeThrowState(db, user, now);
}

export function validateShotInput(value: unknown): string | null {
  const input = value && typeof value === 'object' ? value as Record<string, unknown> : null;
  if (!input || !setIdValid(input.setId)) return '세트 번호가 올바르지 않아요.';
  if (!Number.isInteger(input.index) || (input.index as number) < 0 || (input.index as number) >= shotsPerSet) return '몇 번째 공인지 확인해 주세요.';
  if (!validShot(input)) return '세기와 방향이 올바르지 않아요.';
  return null;
}

export async function shootFreeThrow(db: D1Database, user: Actor, input: Record<string, unknown>, now = Date.now()): Promise<FreeThrowShotResponse> {
  if (user.role !== 'player') throw new FreeThrowError(403, 'CANNOT_PLAY', '플레이어만 공식 도전을 할 수 있어요.');
  const invalid = validateShotInput(input);
  if (invalid) throw new FreeThrowError(400, 'INVALID_SHOT', invalid);
  const setId = input.setId as string, index = input.index as number, power = input.power as number, aim = input.aim as number;
  const set = await db.prepare('SELECT id, request_id, slot, engine, shots, made FROM freethrow_sets WHERE id = ? AND user_id = ?').bind(setId, user.id).first<SetRow>();
  if (!set) throw new FreeThrowError(404, 'SET_NOT_FOUND', '이 세트를 찾을 수 없어요. 화면을 새로고침해 주세요.');
  const recorded = () => db.prepare('SELECT id, shot_index, power, aim, made, kind FROM freethrow_shots WHERE set_id = ? AND shot_index = ?').bind(setId, index).first<ShotRow>();
  const respond = async (row: ShotRow, replayed: boolean): Promise<FreeThrowShotResponse> => {
    if (row.power !== power || row.aim !== aim) throw new FreeThrowError(409, 'SHOT_CONFLICT', '이미 다른 슛으로 기록된 공이에요. 화면을 새로고침해 주세요.');
    const shot = shotView(row);
    return { ...await getFreeThrowState(db, user, now), shot: { ...shot, points: shot.made ? goalScore : 0, gold: shot.made ? goalGold : 0 }, replayed };
  };
  const old = await recorded();
  // A retry of a recorded shot (lost response) returns it without simulating again.
  if (old) return respond(old, true);
  if (set.engine !== engine) throw new FreeThrowError(409, 'ENGINE_CHANGED', '게임이 업데이트됐어요. 이 세트는 마감됐어요.');
  if (now >= freeThrowDeadline(set.slot)) throw new FreeThrowError(409, 'SET_CLOSED', '이 세트의 시간이 끝났어요. 남은 공은 실패로 기록돼요.');
  if (set.shots !== index) throw new FreeThrowError(409, 'SHOT_ORDER', '슛 순서가 맞지 않아요. 화면을 새로고침해 주세요.');
  // Exactly one simulation per new shot; the browser has already shown the same result.
  const result = simulateShot({ power, aim });
  const id = crypto.randomUUID(), date = new Date(now), createdAt = date.toISOString(), made = result.made ? 1 : 0;
  const writes: D1PreparedStatement[] = [
    db.prepare(`INSERT OR IGNORE INTO freethrow_shots (id, set_id, shot_index, power, aim, made, kind, created_at)
      SELECT ?, s.id, ?, ?, ?, ?, ?, ? FROM freethrow_sets s JOIN users u ON u.id = s.user_id
      WHERE s.id = ? AND s.user_id = ? AND s.shots = ? AND s.engine = ? AND u.role = 'player' AND u.active = 1 AND ? < ?`)
      .bind(id, index, power, aim, made, result.kind, createdAt, setId, user.id, index, engine, now, freeThrowDeadline(set.slot)),
    db.prepare(`UPDATE freethrow_sets SET shots = shots + 1, made = made + ?
      WHERE id = ? AND shots = ? AND EXISTS (SELECT 1 FROM freethrow_shots WHERE id = ?)`).bind(made, setId, index, id),
  ];
  if (made) {
    for (const [currency, amount] of [['score', goalScore], ['gold', goalGold]] as const) {
      writes.push(db.prepare(`INSERT OR IGNORE INTO ledger (id, user_id, currency, amount, reason, reference, created_at, week_start)
        SELECT ?, s.user_id, ?, ?, '자유투 대결 골', ?, sh.created_at, ? FROM freethrow_shots sh JOIN freethrow_sets s ON s.id = sh.set_id WHERE sh.id = ?`)
        .bind(crypto.randomUUID(), currency, amount, `freethrow:goal:${setId}:${index}:${currency}`, currency === 'score' ? weekStart(date) : null, id));
    }
  }
  await db.batch(writes);
  const saved = await recorded();
  if (!saved) {
    const active = await db.prepare("SELECT 1 FROM users WHERE id = ? AND role = 'player' AND active = 1").bind(user.id).first();
    if (!active) throw new FreeThrowError(403, 'CANNOT_PLAY', '활성 플레이어만 공식 도전을 할 수 있어요.');
    throw new FreeThrowError(409, 'SHOT_ORDER', '세트 상태가 바뀌었어요. 화면을 새로고침해 주세요.');
  }
  return respond(saved, saved.id !== id);
}
