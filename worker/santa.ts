import { PLAY_RULES, SANTA_RULES, playClosed, santaDeadline, santaOpen, santaSlot, santaSlotStart, scoreCounts } from '../shared/balance';
import { judgeDrop, santaCourse, validRelease } from '../shared/santa-engine';
import type { SantaBoardEntry, SantaDropRecord, SantaDropResponse, SantaRun, SantaState, SantaSummary } from '../shared/types';
import { kstDate, weekStart } from './rules';

interface Actor { id: string; role: 'player' | 'admin' }
interface RunRow { id: string; request_id: string; slot: number; engine: number; drops: number; hits: number }
interface DropRow { id: string; house_index: number; release_ms: number; hit: number; kind: string; created_at: string }
interface BoardRow { username: string; slot: number; hits: number; drops: number }

export class SantaError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); }
}
const requestIdValid = (value: unknown): value is string => typeof value === 'string' && /^[a-zA-Z0-9_-]{16,80}$/.test(value);
const runIdValid = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f-]{36}$/.test(value);
const { houses, hitScore, perfectBonus, clearGold, engine } = SANTA_RULES;
const CLOSED_MESSAGE = '크리스마스 선물 배달은 12월 25일까지였어요. 산타는 내년에 다시 출발해요!';
/** A run belongs to the KST day its half day starts on. Hits after that day
 * closed (23:50), including the 오후 run's grace past midnight, score nothing. */
const runDay = (slot: number) => kstDate(new Date(santaSlotStart(slot)));
const hitCounts = (slot: number, at: number) => scoreCounts(runDay(slot), at);
const finishedAt = (row: Pick<RunRow, 'slot' | 'drops'>, now: number) => row.drops >= houses || now >= santaDeadline(row.slot);

/** The player's two most recent slots: the current one and, while its grace
 * time lasts, an unfinished run from the previous slot. */
async function recentRuns(db: D1Database, user: Actor, now: number): Promise<{ open: RunRow | null; currentSlot: RunRow | null }> {
  const slot = santaSlot(now);
  const rows = (await db.prepare('SELECT id, request_id, slot, engine, drops, hits FROM santa_runs WHERE user_id = ? AND slot >= ? ORDER BY slot DESC')
    .bind(user.id, slot - 1).all<RunRow>()).results;
  const currentSlot = rows.find(row => row.slot === slot) ?? null;
  const previous = rows.find(row => row.slot === slot - 1 && !finishedAt(row, now)) ?? null;
  return { open: previous, currentSlot };
}
function summaryOf(user: Actor, runs: { open: RunRow | null; currentSlot: RunRow | null }, now: number): SantaSummary {
  const active = runs.open ?? runs.currentSlot;
  const player = user.role === 'player';
  return {
    open: santaOpen(now),
    available: player && santaOpen(now) && !runs.open && !runs.currentSlot,
    inProgress: player && !!active && !finishedAt(active, now),
    hits: active?.hits ?? 0, drops: active?.drops ?? 0,
    nextSlotAt: santaSlotStart(santaSlot(now) + 1), endsAt: SANTA_RULES.endsAt, serverNow: now, isAdmin: !player,
  };
}

/** Bootstrap reads one indexed range of this player's rows; nothing is written. */
export async function getSantaSummary(db: D1Database, user: Actor, now = Date.now()): Promise<SantaSummary> {
  const playing = user.role === 'player' && now < santaDeadline(santaSlot(SANTA_RULES.endsAt - 1));
  return summaryOf(user, playing ? await recentRuns(db, user, now) : { open: null, currentSlot: null }, now);
}

const dropView = (row: DropRow): SantaDropRecord => ({ index: row.house_index, release: row.release_ms, hit: row.hit === 1, kind: row.kind });
async function runView(db: D1Database, row: RunRow, now: number): Promise<SantaRun> {
  const rows = (await db.prepare('SELECT id, house_index, release_ms, hit, kind, created_at FROM santa_drops WHERE run_id = ? ORDER BY house_index')
    .bind(row.id).all<DropRow>()).results;
  const scored = rows.filter(drop => drop.hit === 1 && hitCounts(row.slot, Date.parse(drop.created_at))).length;
  const completed = row.drops >= houses;
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
    user.role === 'player' ? recentRuns(db, user, now) : Promise.resolve({ open: null, currentSlot: null }),
    db.prepare(`SELECT u.username, r.slot, r.hits, r.drops FROM santa_runs r JOIN users u ON u.id = r.user_id
      WHERE r.date = ? AND u.role = 'player' AND u.active = 1 ORDER BY r.slot, u.username`).bind(date).all<BoardRow>(),
  ]);
  const active = runs.open ?? runs.currentSlot;
  const today: SantaBoardEntry[] = board.results.map(row => ({ username: row.username, slot: row.slot, slotStart: santaSlotStart(row.slot),
    hits: row.hits, drops: row.drops, finished: finishedAt(row, now) }));
  return { ...summaryOf(user, runs, now), date, slot, slotStart: santaSlotStart(slot), current: active ? await runView(db, active, now) : null, today };
}

export async function startSantaRun(db: D1Database, user: Actor, input: Record<string, unknown>, now = Date.now()): Promise<SantaState> {
  if (user.role !== 'player') throw new SantaError(403, 'CANNOT_PLAY', '플레이어만 선물을 배달할 수 있어요.');
  if (!requestIdValid(input.requestId)) throw new SantaError(400, 'INVALID_RUN', '요청 번호가 올바르지 않아요.');
  const prior = () => db.prepare('SELECT slot FROM santa_runs WHERE user_id = ? AND request_id = ?').bind(user.id, input.requestId).first<{ slot: number }>();
  // A retried start returns the same run; it never opens a second one.
  if (await prior()) return getSantaState(db, user, now);
  if (!santaOpen(now)) throw new SantaError(409, 'EVENT_CLOSED', CLOSED_MESSAGE);
  if (playClosed(now)) throw new SantaError(409, 'PLAY_CLOSED', PLAY_RULES.closedMessage);
  const runs = await recentRuns(db, user, now);
  if (runs.open) throw new SantaError(409, 'RUN_IN_PROGRESS', '지난 배달을 먼저 마쳐 주세요.');
  if (runs.currentSlot) throw new SantaError(409, 'RUN_USED', '이번 배달은 이미 출발했어요. 다음 배달을 기다려 주세요.');
  const slot = santaSlot(now);
  const previousOpen = now < santaDeadline(slot - 1) ? 1 : 0;
  // UNIQUE(user_id, slot) settles concurrent starts. A previous run still in
  // its grace time blocks a new one inside the same statement.
  await db.prepare(`INSERT OR IGNORE INTO santa_runs (id, user_id, request_id, slot, date, engine, created_at)
    SELECT ?, u.id, ?, ?, ?, ?, ? FROM users u WHERE u.id = ? AND u.role = 'player' AND u.active = 1
      AND NOT (? = 1 AND EXISTS (SELECT 1 FROM santa_runs p WHERE p.user_id = u.id AND p.slot = ? AND p.drops < ?))`)
    .bind(crypto.randomUUID(), input.requestId, slot, runDay(slot), engine, new Date(now).toISOString(),
      user.id, previousOpen, slot - 1, houses).run();
  if (!(await prior())) {
    const active = await db.prepare("SELECT 1 FROM users WHERE id = ? AND role = 'player' AND active = 1").bind(user.id).first();
    if (!active) throw new SantaError(403, 'CANNOT_PLAY', '활성 플레이어만 선물을 배달할 수 있어요.');
    throw new SantaError(409, 'RUN_USED', '이번 배달은 이미 출발했어요. 다음 배달을 기다려 주세요.');
  }
  return getSantaState(db, user, now);
}

export function validateDropInput(value: unknown): string | null {
  const input = value && typeof value === 'object' ? value as Record<string, unknown> : null;
  if (!input || !runIdValid(input.runId)) return '배달 번호가 올바르지 않아요.';
  if (!Number.isInteger(input.index) || (input.index as number) < 0 || (input.index as number) >= houses) return '몇 번째 집인지 확인해 주세요.';
  if (!Number.isInteger(input.release) || (input.release as number) < -1) return '던진 시각이 올바르지 않아요.';
  return null;
}

export async function dropSantaGift(db: D1Database, user: Actor, input: Record<string, unknown>, now = Date.now()): Promise<SantaDropResponse> {
  if (user.role !== 'player') throw new SantaError(403, 'CANNOT_PLAY', '플레이어만 선물을 배달할 수 있어요.');
  const invalid = validateDropInput(input);
  if (invalid) throw new SantaError(400, 'INVALID_DROP', invalid);
  const runId = input.runId as string, index = input.index as number, release = input.release as number;
  const run = await db.prepare('SELECT id, request_id, slot, engine, drops, hits FROM santa_runs WHERE id = ? AND user_id = ?').bind(runId, user.id).first<RunRow>();
  if (!run) throw new SantaError(404, 'RUN_NOT_FOUND', '이 배달을 찾을 수 없어요. 화면을 새로고침해 주세요.');
  const recorded = () => db.prepare('SELECT id, house_index, release_ms, hit, kind, created_at FROM santa_drops WHERE run_id = ? AND house_index = ?').bind(runId, index).first<DropRow>();
  const respond = async (row: DropRow, replayed: boolean): Promise<SantaDropResponse> => {
    if (row.release_ms !== release) throw new SantaError(409, 'DROP_CONFLICT', '이 집은 이미 다르게 기록됐어요. 화면을 새로고침해 주세요.');
    const drop = dropView(row);
    return { ...await getSantaState(db, user, now), drop: { ...drop, points: drop.hit && hitCounts(run.slot, Date.parse(row.created_at)) ? hitScore : 0 }, replayed };
  };
  const old = await recorded();
  // A retry of a recorded drop (lost response) returns it without judging again.
  if (old) return respond(old, true);
  if (run.engine !== engine) throw new SantaError(409, 'ENGINE_CHANGED', '게임이 업데이트됐어요. 이 배달은 마감됐어요.');
  if (now >= santaDeadline(run.slot)) throw new SantaError(409, 'RUN_CLOSED', '이 배달의 시간이 끝났어요. 남은 집은 미배달로 기록돼요.');
  if (run.drops !== index) throw new SantaError(409, 'DROP_ORDER', '배달 순서가 맞지 않아요. 화면을 새로고침해 주세요.');
  const house = santaCourse(run.slot, houses)[index]!;
  if (!validRelease(house, release)) throw new SantaError(400, 'INVALID_DROP', '던진 시각이 올바르지 않아요.');
  // Exactly one judgement per new drop; the browser has already shown the same result.
  const result = judgeDrop(house, release);
  const id = crypto.randomUUID(), date = new Date(now), createdAt = date.toISOString(), hit = result.hit ? 1 : 0;
  const counts = hitCounts(run.slot, now);
  const writes: D1PreparedStatement[] = [
    db.prepare(`INSERT OR IGNORE INTO santa_drops (id, run_id, house_index, release_ms, hit, kind, created_at)
      SELECT ?, r.id, ?, ?, ?, ?, ? FROM santa_runs r JOIN users u ON u.id = r.user_id
      WHERE r.id = ? AND r.user_id = ? AND r.drops = ? AND r.engine = ? AND u.role = 'player' AND u.active = 1 AND ? < ?`)
      .bind(id, index, release, hit, result.kind, createdAt, runId, user.id, index, engine, now, santaDeadline(run.slot)),
    db.prepare(`UPDATE santa_runs SET drops = drops + 1, hits = hits + ?
      WHERE id = ? AND drops = ? AND EXISTS (SELECT 1 FROM santa_drops WHERE id = ?)`).bind(hit, runId, index, id),
  ];
  // Ledger rows are written only when this request's drop row was inserted.
  const ledger = (currency: 'score' | 'gold', amount: number, reason: string, reference: string) =>
    db.prepare(`INSERT OR IGNORE INTO ledger (id, user_id, currency, amount, reason, reference, created_at, week_start)
      SELECT ?, r.user_id, ?, ?, ?, ?, d.created_at, ? FROM santa_drops d JOIN santa_runs r ON r.id = d.run_id WHERE d.id = ?`)
      .bind(crypto.randomUUID(), currency, amount, reason, reference, currency === 'score' ? weekStart(date) : null, id);
  if (hit && counts) writes.push(ledger('score', hitScore, '산타 선물 배달', `santa:hit:${runId}:${index}:score`));
  if (index === houses - 1) {
    if (hit && run.hits + 1 === houses && counts) writes.push(ledger('score', perfectBonus, '산타 선물 배달 · 10곳 모두 성공', `santa:perfect:${runId}:score`));
    writes.push(ledger('gold', clearGold, '산타 선물 배달 완료', `santa:clear:${runId}:gold`));
  }
  await db.batch(writes);
  const saved = await recorded();
  if (!saved) {
    const active = await db.prepare("SELECT 1 FROM users WHERE id = ? AND role = 'player' AND active = 1").bind(user.id).first();
    if (!active) throw new SantaError(403, 'CANNOT_PLAY', '활성 플레이어만 선물을 배달할 수 있어요.');
    throw new SantaError(409, 'DROP_ORDER', '배달 상태가 바뀌었어요. 화면을 새로고침해 주세요.');
  }
  return respond(saved, saved.id !== id);
}
