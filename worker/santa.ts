import { PLAY_RULES, SANTA_RULES, playClosed, santaDeadline, santaOpen, santaSlot, santaSlotStart, scoreCounts } from '../shared/balance';
import { judgeDrop, santaCourse, validRelease } from '../shared/santa-engine';
import type { SantaBoardEntry, SantaDropRecord, SantaFinishResponse, SantaRun, SantaState, SantaSummary } from '../shared/types';
import { kstDate, weekStart } from './rules';

// A run is played on the device and recorded in one request once its last
// house is done (docs/plan-santa.md §3). Starting uses the half day's chance;
// a run that is never recorded (the player left) ends unfinished at its deadline.

interface Actor { id: string; role: 'player' | 'admin' }
interface RunRow { id: string; request_id: string; slot: number; engine: number; drops: number; hits: number }
interface DropRow { id: string; house_index: number; release_ms: number; hit: number; kind: string; created_at: string }
interface BoardRow { username: string; slot: number; hits: number }

export class SantaError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); }
}
const requestIdValid = (value: unknown): value is string => typeof value === 'string' && /^[a-zA-Z0-9_-]{16,80}$/.test(value);
const runIdValid = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f-]{36}$/.test(value);
const { houses, hitScore, perfectBonus, clearGold, engine } = SANTA_RULES;
const CLOSED_MESSAGE = '크리스마스 선물 배달은 12월 25일까지였어요. 산타는 내년에 다시 출발해요!';
/** A run belongs to the KST day its half day starts on. A run recorded after
 * that day closed (23:50), e.g. the 오후 run's grace past midnight, scores nothing. */
const runDay = (slot: number) => kstDate(new Date(santaSlotStart(slot)));
const hitCounts = (slot: number, at: number) => scoreCounts(runDay(slot), at);
const completedRow = (row: Pick<RunRow, 'drops'>) => row.drops >= houses;
const finishedAt = (row: Pick<RunRow, 'slot' | 'drops'>, now: number) => completedRow(row) || now >= santaDeadline(row.slot);
const RUN_COLUMNS = 'id, request_id, slot, engine, drops, hits';

/** This half day's run, or the previous half day's while it can still be recorded. */
async function recentRun(db: D1Database, user: Actor, now: number): Promise<{ current: RunRow | null; thisSlot: RunRow | null }> {
  const slot = santaSlot(now);
  const rows = (await db.prepare(`SELECT ${RUN_COLUMNS} FROM santa_runs WHERE user_id = ? AND slot >= ? ORDER BY slot DESC`)
    .bind(user.id, slot - 1).all<RunRow>()).results;
  const thisSlot = rows.find(row => row.slot === slot) ?? null;
  const previous = rows.find(row => row.slot === slot - 1 && !finishedAt(row, now)) ?? null;
  return { current: thisSlot ?? previous, thisSlot };
}
function summaryOf(user: Actor, runs: { thisSlot: RunRow | null }, now: number): SantaSummary {
  const player = user.role === 'player', run = runs.thisSlot;
  return {
    open: santaOpen(now),
    available: player && santaOpen(now) && !run,
    played: player && !!run, completed: player && !!run && completedRow(run), hits: run && completedRow(run) ? run.hits : 0,
    nextSlotAt: santaSlotStart(santaSlot(now) + 1), endsAt: SANTA_RULES.endsAt, serverNow: now, isAdmin: !player,
  };
}

/** Bootstrap reads one indexed range of this player's rows; nothing is written. */
export async function getSantaSummary(db: D1Database, user: Actor, now = Date.now()): Promise<SantaSummary> {
  const playing = user.role === 'player' && now < santaDeadline(santaSlot(SANTA_RULES.endsAt - 1));
  return summaryOf(user, playing ? await recentRun(db, user, now) : { thisSlot: null }, now);
}

const dropView = (row: DropRow): SantaDropRecord => ({ index: row.house_index, release: row.release_ms, hit: row.hit === 1, kind: row.kind });
async function runView(db: D1Database, row: RunRow, now: number): Promise<SantaRun> {
  const rows = (await db.prepare('SELECT id, house_index, release_ms, hit, kind, created_at FROM santa_drops WHERE run_id = ? ORDER BY house_index')
    .bind(row.id).all<DropRow>()).results;
  const scored = rows.filter(drop => drop.hit === 1 && hitCounts(row.slot, Date.parse(drop.created_at))).length;
  const completed = completedRow(row);
  const last = rows[houses - 1];
  const bonus = completed && row.hits === houses && last && hitCounts(row.slot, Date.parse(last.created_at)) ? perfectBonus : 0;
  return {
    id: row.id, requestId: row.request_id, slot: row.slot, slotStart: santaSlotStart(row.slot), deadline: santaDeadline(row.slot),
    engine: row.engine, hits: row.hits, drops: rows.map(dropView), completed, finished: finishedAt(row, now),
    points: scored * hitScore + bonus, gold: completed ? clearGold : 0,
  };
}

export async function getSantaState(db: D1Database, user: Actor, now = Date.now()): Promise<SantaState> {
  const slot = santaSlot(now), date = kstDate(new Date(now));
  const [runs, board] = await Promise.all([
    user.role === 'player' ? recentRun(db, user, now) : Promise.resolve({ current: null, thisSlot: null }),
    db.prepare(`SELECT u.username, r.slot, r.hits FROM santa_runs r JOIN users u ON u.id = r.user_id
      WHERE r.date = ? AND r.drops = ? AND u.role = 'player' AND u.active = 1 ORDER BY r.slot, u.username`).bind(date, houses).all<BoardRow>(),
  ]);
  const today: SantaBoardEntry[] = board.results.map(row => ({ username: row.username, slot: row.slot, slotStart: santaSlotStart(row.slot), hits: row.hits, completed: true }));
  return { ...summaryOf(user, runs, now), date, slot, slotStart: santaSlotStart(slot), current: runs.current ? await runView(db, runs.current, now) : null, today };
}

export async function startSantaRun(db: D1Database, user: Actor, input: Record<string, unknown>, now = Date.now()): Promise<SantaState> {
  if (user.role !== 'player') throw new SantaError(403, 'CANNOT_PLAY', '플레이어만 선물을 배달할 수 있어요.');
  if (!requestIdValid(input.requestId)) throw new SantaError(400, 'INVALID_RUN', '요청 번호가 올바르지 않아요.');
  const prior = () => db.prepare('SELECT slot FROM santa_runs WHERE user_id = ? AND request_id = ?').bind(user.id, input.requestId).first<{ slot: number }>();
  // A retried start returns the same run; it never opens a second one.
  if (await prior()) return getSantaState(db, user, now);
  if (!santaOpen(now)) throw new SantaError(409, 'EVENT_CLOSED', CLOSED_MESSAGE);
  if (playClosed(now)) throw new SantaError(409, 'PLAY_CLOSED', PLAY_RULES.closedMessage);
  const slot = santaSlot(now);
  // UNIQUE(user_id, slot) settles concurrent starts.
  await db.prepare(`INSERT OR IGNORE INTO santa_runs (id, user_id, request_id, slot, date, engine, created_at)
    SELECT ?, u.id, ?, ?, ?, ?, ? FROM users u WHERE u.id = ? AND u.role = 'player' AND u.active = 1`)
    .bind(crypto.randomUUID(), input.requestId, slot, runDay(slot), engine, new Date(now).toISOString(), user.id).run();
  if (!(await prior())) {
    const active = await db.prepare("SELECT 1 FROM users WHERE id = ? AND role = 'player' AND active = 1").bind(user.id).first();
    if (!active) throw new SantaError(403, 'CANNOT_PLAY', '활성 플레이어만 선물을 배달할 수 있어요.');
    throw new SantaError(409, 'RUN_USED', '이번 배달은 이미 출발했어요. 다음 배달을 기다려 주세요.');
  }
  return getSantaState(db, user, now);
}

export function validateFinishInput(value: unknown): string | null {
  const input = value && typeof value === 'object' ? value as Record<string, unknown> : null;
  if (!input || !runIdValid(input.runId)) return '배달 번호가 올바르지 않아요.';
  if (!Array.isArray(input.releases) || input.releases.length !== houses || !input.releases.every(value => Number.isInteger(value)))
    return `집 ${houses}곳의 기록이 모두 필요해요.`;
  return null;
}

/** Records a whole run: every house's release time (-1 when passed), judged again here. */
export async function finishSantaRun(db: D1Database, user: Actor, input: Record<string, unknown>, now = Date.now()): Promise<SantaFinishResponse> {
  if (user.role !== 'player') throw new SantaError(403, 'CANNOT_PLAY', '플레이어만 선물을 배달할 수 있어요.');
  const invalid = validateFinishInput(input);
  if (invalid) throw new SantaError(400, 'INVALID_RUN', invalid);
  const runId = input.runId as string, releases = input.releases as number[];
  const run = await db.prepare(`SELECT ${RUN_COLUMNS} FROM santa_runs WHERE id = ? AND user_id = ?`).bind(runId, user.id).first<RunRow>();
  if (!run) throw new SantaError(404, 'RUN_NOT_FOUND', '이 배달을 찾을 수 없어요. 화면을 새로고침해 주세요.');
  const recorded = async () => (await db.prepare('SELECT release_ms FROM santa_drops WHERE run_id = ? ORDER BY house_index').bind(runId).all<{ release_ms: number }>()).results;
  const respond = async (replayed: boolean): Promise<SantaFinishResponse> => {
    const row = await db.prepare(`SELECT ${RUN_COLUMNS} FROM santa_runs WHERE id = ?`).bind(runId).first<RunRow>();
    return { ...await getSantaState(db, user, now), run: await runView(db, row!, now), replayed };
  };
  if (completedRow(run)) {
    // A retry of a recorded run (lost response) returns it; a different one is refused.
    const saved = await recorded();
    if (saved.length === houses && saved.every((row, i) => row.release_ms === releases[i])) return respond(true);
    throw new SantaError(409, 'RUN_CONFLICT', '이 배달은 이미 다르게 기록됐어요. 화면을 새로고침해 주세요.');
  }
  if (run.drops > 0) throw new SantaError(409, 'RUN_CLOSED', '이 배달은 미완료로 끝났어요.');
  if (run.engine !== engine) throw new SantaError(409, 'ENGINE_CHANGED', '게임이 업데이트됐어요. 이 배달은 마감됐어요.');
  if (now >= santaDeadline(run.slot)) throw new SantaError(409, 'RUN_CLOSED', '이 배달의 시간이 끝나서 미완료로 기록됐어요.');
  const course = santaCourse(run.slot, houses);
  if (!releases.every((release, i) => validRelease(course[i]!, release))) throw new SantaError(400, 'INVALID_RUN', '던진 시각이 올바르지 않아요.');
  // One judgement per house; the browser has already shown the same results.
  const results = releases.map((release, i) => judgeDrop(course[i]!, release));
  const hits = results.filter(result => result.hit).length;
  const date = new Date(now), createdAt = date.toISOString(), counts = hitCounts(run.slot, now);
  const ids = results.map(() => crypto.randomUUID());
  const writes: D1PreparedStatement[] = results.map((result, i) =>
    db.prepare(`INSERT OR IGNORE INTO santa_drops (id, run_id, house_index, release_ms, hit, kind, created_at)
      SELECT ?, r.id, ?, ?, ?, ?, ? FROM santa_runs r JOIN users u ON u.id = r.user_id
      WHERE r.id = ? AND r.user_id = ? AND r.drops = 0 AND r.engine = ? AND u.role = 'player' AND u.active = 1 AND ? < ?`)
      .bind(ids[i], i, result.release, result.hit ? 1 : 0, result.kind, createdAt, runId, user.id, engine, now, santaDeadline(run.slot)));
  writes.push(db.prepare(`UPDATE santa_runs SET drops = ?, hits = ?
    WHERE id = ? AND drops = 0 AND (SELECT COUNT(*) FROM santa_drops WHERE run_id = ? AND id IN (${ids.map(() => '?').join(', ')})) = ?`)
    .bind(houses, hits, runId, runId, ...ids, houses));
  // Ledger rows are written only when this request's drop rows were inserted.
  const witness = ids[houses - 1]!;
  const ledger = (currency: 'score' | 'gold', amount: number, reason: string, reference: string) =>
    db.prepare(`INSERT OR IGNORE INTO ledger (id, user_id, currency, amount, reason, reference, created_at, week_start)
      SELECT ?, r.user_id, ?, ?, ?, ?, d.created_at, ? FROM santa_drops d JOIN santa_runs r ON r.id = d.run_id WHERE d.id = ?`)
      .bind(crypto.randomUUID(), currency, amount, reason, reference, currency === 'score' ? weekStart(date) : null, witness);
  if (hits && counts) writes.push(ledger('score', hits * hitScore, '산타 선물 배달', `santa:hits:${runId}:score`));
  if (hits === houses && counts) writes.push(ledger('score', perfectBonus, '산타 선물 배달 · 10곳 모두 성공', `santa:perfect:${runId}:score`));
  writes.push(ledger('gold', clearGold, '산타 선물 배달 완료', `santa:clear:${runId}:gold`));
  await db.batch(writes);
  const saved = await db.prepare(`SELECT ${RUN_COLUMNS} FROM santa_runs WHERE id = ?`).bind(runId).first<RunRow>();
  if (!saved || !completedRow(saved)) {
    const active = await db.prepare("SELECT 1 FROM users WHERE id = ? AND role = 'player' AND active = 1").bind(user.id).first();
    if (!active) throw new SantaError(403, 'CANNOT_PLAY', '활성 플레이어만 선물을 배달할 수 있어요.');
    throw new SantaError(409, 'RUN_CLOSED', '배달 상태가 바뀌었어요. 화면을 새로고침해 주세요.');
  }
  // A concurrent identical request may have won: then this one is a replay.
  const rows = await recorded();
  if (!rows.every((row, i) => row.release_ms === releases[i])) throw new SantaError(409, 'RUN_CONFLICT', '이 배달은 이미 다르게 기록됐어요. 화면을 새로고침해 주세요.');
  const mine = await db.prepare('SELECT 1 FROM santa_drops WHERE id = ?').bind(witness).first();
  return respond(!mine);
}
