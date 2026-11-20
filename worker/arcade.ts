import { ARCADE_GAMES, ARCADE_RULES, PLAY_RULES, arcadeDeadline, arcadeSlot, arcadeSlotStart, playClosed, scoreCounts, type ArcadeGame } from '../shared/balance';
import { ARCADE_JUDGES, arcadePoints } from '../shared/arcade-judge';
import type { ArcadeBoardEntry, ArcadeFinishResponse, ArcadeSet, ArcadeState, ArcadeSummary, ArcadeTryRecord } from '../shared/types';
import { kstDate, weekStart } from './rules';

// Curling and penalty sets follow the free throw (worker/freethrow.ts): a set
// is played on the device and recorded in one request once its last throw or
// kick is done. Starting uses the slot's chance; a set that is never recorded
// (the player left) ends unfinished at its deadline.

interface Actor { id: string; role: 'player' | 'admin' }
interface SetRow {
  id: string; game: ArcadeGame; request_id: string; slot: number; date: string; engine: number; tries: number; made: number;
  points: number; gold: number; inputs_json: string | null; results_json: string | null; finish_token: string | null;
}
interface BoardRow { username: string; slot: number; made: number; results_json: string | null }
export class ArcadeError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); }
}
const requestIdValid = (value: unknown): value is string => typeof value === 'string' && /^[a-zA-Z0-9_-]{16,80}$/.test(value);
const setIdValid = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f-]{36}$/.test(value);
const completedRow = (row: Pick<SetRow, 'game' | 'tries'>) => row.tries >= ARCADE_RULES[row.game].tries;
const finishedAt = (row: Pick<SetRow, 'game' | 'slot' | 'tries'>, now: number) => completedRow(row) || now >= arcadeDeadline(row.game, row.slot);
const SET_COLUMNS = 'id, game, request_id, slot, date, engine, tries, made, points, gold, inputs_json, results_json, finish_token';

function pick(game: ArcadeGame, rows: SetRow[], now: number): { current: SetRow | null; thisSlot: SetRow | null } {
  const slot = arcadeSlot(game, now);
  const thisSlot = rows.find(row => row.game === game && row.slot === slot) ?? null;
  const previous = rows.find(row => row.game === game && row.slot === slot - 1 && !finishedAt(row, now)) ?? null;
  return { current: thisSlot ?? previous, thisSlot };
}
/** This slot's set, or the previous slot's while it can still be recorded. */
async function recentSet(db: D1Database, game: ArcadeGame, user: Actor, now: number) {
  const rows = (await db.prepare(`SELECT ${SET_COLUMNS} FROM arcade_sets WHERE user_id = ? AND game = ? AND slot >= ? ORDER BY slot DESC`)
    .bind(user.id, game, arcadeSlot(game, now) - 1).all<SetRow>()).results;
  return pick(game, rows, now);
}
function summaryOf(game: ArcadeGame, user: Actor, sets: { thisSlot: SetRow | null }, now: number): ArcadeSummary {
  const player = user.role === 'player', set = sets.thisSlot;
  return {
    available: player && !set,
    played: player && !!set, completed: player && !!set && completedRow(set), made: set && completedRow(set) ? set.made : 0,
    nextSlotAt: arcadeSlotStart(game, arcadeSlot(game, now) + 1), serverNow: now, isAdmin: !player,
  };
}
/** Bootstrap reads one indexed range of this player's rows for every game; nothing is written. */
export async function getArcadeSummaries(db: D1Database, user: Actor, now = Date.now()): Promise<Record<ArcadeGame, ArcadeSummary>> {
  const oldest = Math.min(...ARCADE_GAMES.map(game => arcadeSlot(game, now))) - 1;
  const rows = user.role === 'player'
    ? (await db.prepare(`SELECT ${SET_COLUMNS} FROM arcade_sets WHERE user_id = ? AND slot >= ?`).bind(user.id, oldest).all<SetRow>()).results : [];
  return Object.fromEntries(ARCADE_GAMES.map(game => [game, summaryOf(game, user, pick(game, rows, now), now)])) as Record<ArcadeGame, ArcadeSummary>;
}
function setView(row: SetRow, now: number): ArcadeSet {
  return {
    id: row.id, requestId: row.request_id, slot: row.slot, slotStart: arcadeSlotStart(row.game, row.slot), deadline: arcadeDeadline(row.game, row.slot),
    engine: row.engine, made: row.made, tries: row.results_json ? JSON.parse(row.results_json) as ArcadeTryRecord[] : [],
    completed: completedRow(row), finished: finishedAt(row, now), points: row.points, gold: row.gold,
  };
}
export async function getArcadeState(db: D1Database, game: ArcadeGame, user: Actor, now = Date.now()): Promise<ArcadeState> {
  const slot = arcadeSlot(game, now), date = kstDate(new Date(now));
  const [sets, board] = await Promise.all([
    user.role === 'player' ? recentSet(db, game, user, now) : Promise.resolve({ current: null, thisSlot: null }),
    db.prepare(`SELECT u.username, s.slot, s.made, s.results_json FROM arcade_sets s JOIN users u ON u.id = s.user_id
      WHERE s.game = ? AND s.date = ? AND s.tries > 0 AND u.role = 'player' AND u.active = 1 ORDER BY s.slot, u.username`).bind(game, date).all<BoardRow>(),
  ]);
  const today: ArcadeBoardEntry[] = board.results.map(row => ({ username: row.username, slot: row.slot, slotStart: arcadeSlotStart(game, row.slot), made: row.made,
    points: arcadePoints(row.results_json ? JSON.parse(row.results_json) as ArcadeTryRecord[] : [], ARCADE_RULES[game].score), completed: true }));
  return { ...summaryOf(game, user, sets, now), game, date, slot, slotStart: arcadeSlotStart(game, slot), current: sets.current ? setView(sets.current, now) : null, today };
}

export async function startArcadeSet(db: D1Database, game: ArcadeGame, user: Actor, input: Record<string, unknown>, now = Date.now()): Promise<ArcadeState> {
  if (user.role !== 'player') throw new ArcadeError(403, 'CANNOT_PLAY', '플레이어만 공식 도전을 할 수 있어요. 연습 모드는 누구나 할 수 있어요.');
  if (!requestIdValid(input.requestId)) throw new ArcadeError(400, 'INVALID_SET', '요청 번호가 올바르지 않아요.');
  const prior = () => db.prepare('SELECT game FROM arcade_sets WHERE user_id = ? AND request_id = ?').bind(user.id, input.requestId).first<{ game: string }>();
  // A retried start returns the same set; it never opens a second one.
  const before = await prior();
  if (before) {
    if (before.game !== game) throw new ArcadeError(409, 'REQUEST_CONFLICT', '이미 다른 게임에 사용한 요청 번호예요.');
    return getArcadeState(db, game, user, now);
  }
  if (playClosed(now)) throw new ArcadeError(409, 'PLAY_CLOSED', PLAY_RULES.closedMessage);
  // UNIQUE(user_id, game, slot) settles concurrent starts.
  await db.prepare(`INSERT OR IGNORE INTO arcade_sets (id, user_id, game, request_id, slot, date, engine, created_at)
    SELECT ?, u.id, ?, ?, ?, ?, ?, ? FROM users u WHERE u.id = ? AND u.role = 'player' AND u.active = 1`)
    .bind(crypto.randomUUID(), game, input.requestId, arcadeSlot(game, now), kstDate(new Date(now)), ARCADE_RULES[game].engine, new Date(now).toISOString(), user.id).run();
  if (!(await prior())) {
    const active = await db.prepare("SELECT 1 FROM users WHERE id = ? AND role = 'player' AND active = 1").bind(user.id).first();
    if (!active) throw new ArcadeError(403, 'CANNOT_PLAY', '활성 플레이어만 공식 도전을 할 수 있어요.');
    throw new ArcadeError(409, 'SET_USED', '이번 시간의 공식 도전은 이미 시작했어요. 다음 세트를 기다려 주세요.');
  }
  return getArcadeState(db, game, user, now);
}

/** Records a whole set: every throw or kick, judged again here. */
export async function finishArcadeSet(db: D1Database, game: ArcadeGame, user: Actor, input: Record<string, unknown>, now = Date.now()): Promise<ArcadeFinishResponse> {
  if (user.role !== 'player') throw new ArcadeError(403, 'CANNOT_PLAY', '플레이어만 공식 도전을 할 수 있어요.');
  const rules = ARCADE_RULES[game], definition = ARCADE_JUDGES[game];
  if (!setIdValid(input.setId)) throw new ArcadeError(400, 'INVALID_SET', '세트 번호가 올바르지 않아요.');
  if (!Array.isArray(input.inputs) || input.inputs.length !== rules.tries) throw new ArcadeError(400, 'INVALID_SET', `${rules.tries}번의 기록이 모두 필요해요.`);
  const inputs = definition.clean(input.inputs);
  if (!inputs) throw new ArcadeError(400, 'INVALID_SET', '기록이 올바르지 않아요.');
  const setId = input.setId, inputsJson = JSON.stringify(inputs);
  const read = () => db.prepare(`SELECT ${SET_COLUMNS} FROM arcade_sets WHERE id = ? AND user_id = ? AND game = ?`).bind(setId, user.id, game).first<SetRow>();
  const set = await read();
  if (!set) throw new ArcadeError(404, 'SET_NOT_FOUND', '이 세트를 찾을 수 없어요. 화면을 새로고침해 주세요.');
  const respond = async (row: SetRow, replayed: boolean): Promise<ArcadeFinishResponse> => ({ ...await getArcadeState(db, game, user, now), set: setView(row, now), replayed });
  if (completedRow(set)) {
    // A retry of a recorded set (lost response) returns it; a different one is refused.
    if (set.inputs_json === inputsJson) return respond(set, true);
    throw new ArcadeError(409, 'SET_CONFLICT', '이 세트는 이미 다르게 기록됐어요. 화면을 새로고침해 주세요.');
  }
  if (set.engine !== rules.engine) throw new ArcadeError(409, 'ENGINE_CHANGED', '게임이 업데이트됐어요. 이 세트는 마감됐어요.');
  const deadline = arcadeDeadline(game, set.slot);
  if (now >= deadline) throw new ArcadeError(409, 'SET_CLOSED', '이 세트의 시간이 끝나서 미완료로 기록됐어요.');
  const results = definition.judge(set.slot, inputs);
  const made = results.filter(result => result.made).length;
  // A set belongs to the KST day it was started on; one recorded after that day
  // closed (23:50) pays gold but no score.
  const points = scoreCounts(set.date, now) ? arcadePoints(results, rules.score) : 0, gold = made * rules.gold;
  const date = new Date(now), finishedIso = date.toISOString(), token = crypto.randomUUID();
  const writes: D1PreparedStatement[] = [db.prepare(`UPDATE arcade_sets SET tries = ?, made = ?, points = ?, gold = ?, inputs_json = ?, results_json = ?, finish_token = ?, finished_at = ?
    WHERE id = ? AND user_id = ? AND tries = 0 AND engine = ? AND ? < ?
      AND EXISTS (SELECT 1 FROM users WHERE id = arcade_sets.user_id AND role = 'player' AND active = 1)`)
    .bind(rules.tries, made, points, gold, inputsJson, JSON.stringify(results), token, finishedIso, setId, user.id, rules.engine, now, deadline)];
  // Ledger rows are written only when this request recorded the set.
  for (const [currency, amount] of [['score', points], ['gold', gold]] as const) {
    if (amount) writes.push(db.prepare(`INSERT OR IGNORE INTO ledger (id, user_id, currency, amount, reason, reference, created_at, week_start)
      SELECT ?, s.user_id, ?, ?, ?, ?, s.finished_at, ? FROM arcade_sets s WHERE s.id = ? AND s.finish_token = ?`)
      .bind(crypto.randomUUID(), currency, amount, definition.reason, `${game}:set:${setId}:${currency}`, currency === 'score' ? weekStart(date) : null, setId, token));
  }
  await db.batch(writes);
  const saved = await read();
  if (!saved || !completedRow(saved)) {
    const active = await db.prepare("SELECT 1 FROM users WHERE id = ? AND role = 'player' AND active = 1").bind(user.id).first();
    if (!active) throw new ArcadeError(403, 'CANNOT_PLAY', '활성 플레이어만 공식 도전을 할 수 있어요.');
    throw new ArcadeError(409, 'SET_CLOSED', '세트 상태가 바뀌었어요. 화면을 새로고침해 주세요.');
  }
  // A concurrent identical request may have won: then this one is a replay.
  if (saved.inputs_json !== inputsJson) throw new ArcadeError(409, 'SET_CONFLICT', '이 세트는 이미 다르게 기록됐어요. 화면을 새로고침해 주세요.');
  return respond(saved, saved.finish_token !== token);
}
