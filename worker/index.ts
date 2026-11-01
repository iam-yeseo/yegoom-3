import type { AttendanceState, BootstrapResponse, GameId, GameState, GameResult, GameHistoryRound, User, Player, LedgerEntry } from '../shared/types';
import { ATTENDANCE_RULES, attendanceCycleDay, attendanceReward, PREDICTION_REWARDS, predictionPoints } from '../shared/balance';
import { defaultCharacter, isArtKey, type ArtKey } from '../shared/characters';
import { DUMMY_HASH, hashToken, randomToken, verifyPassword } from './crypto';
import { GAME_IDS, GAME_RULES, isGameId, kstDate, kstTime, kstTimestamp, TIME_ZONE, validValue, valueDifference, weekStart } from './rules';
import { readInventory, settleDueLotto, ShopError, shopRoute } from './shop';

export interface Env { DB: D1Database; ASSETS: Fetcher }
interface UserRow { id: string; username: string; display_name: string; password_hash: string; role: 'player' | 'admin'; active: number; character: ArtKey | null }
interface RoundRow { answer: string | null; hint: string; reveal_at: number | null; revealed_at: number | null }
interface PredictionRow { player_id: string; username: string; display_name: string; value: string; character: ArtKey | null }
interface UnsettledRound extends RoundRow { game_id: GameId; round_date: string }
class HttpError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); }
}
const SESSION_AGE_SECONDS = 7 * 24 * 60 * 60;
const COOKIE_NAME = 'yegoom_session';
const json = (data: unknown, status = 200, headers?: HeadersInit) => {
  const responseHeaders = new Headers(headers);
  responseHeaders.set('Content-Type', 'application/json; charset=utf-8');
  responseHeaders.set('Cache-Control', 'no-store');
  responseHeaders.set('X-Content-Type-Options', 'nosniff');
  return new Response(JSON.stringify(data), { status, headers: responseHeaders });
};
function cookie(request: Request, token: string, maxAge: number): string {
  const host = new URL(request.url).hostname;
  const secure = host !== 'localhost' && host !== '127.0.0.1' && host !== '[::1]';
  return `${COOKIE_NAME}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure ? '; Secure' : ''}`;
}
function sessionToken(request: Request): string | null {
  const match = request.headers.get('Cookie')?.split(';').map(value => value.trim()).find(value => value.startsWith(`${COOKIE_NAME}=`));
  const token = match?.slice(COOKIE_NAME.length + 1);
  return token && /^[a-f0-9]{64}$/.test(token) ? token : null;
}
function requireSameOrigin(request: Request): void {
  const origin = request.headers.get('Origin');
  if (origin !== new URL(request.url).origin || request.headers.get('Sec-Fetch-Site') === 'cross-site') {
    throw new HttpError(403, 'ORIGIN_REJECTED', '이 페이지에서 다시 시도해 주세요.');
  }
}
async function body(request: Request): Promise<Record<string, unknown>> {
  if (!request.headers.get('Content-Type')?.toLowerCase().startsWith('application/json')) throw new HttpError(415, 'INVALID_CONTENT_TYPE', 'JSON 요청만 사용할 수 있어요.');
  if (Number(request.headers.get('Content-Length') || 0) > 4096) throw new HttpError(413, 'BODY_TOO_LARGE', '입력 내용이 너무 길어요.');
  const reader = request.body?.getReader();
  if (!reader) throw new HttpError(400, 'INVALID_BODY', '입력 내용을 확인해 주세요.');
  const chunks: Uint8Array[] = [];
  let length = 0;
  while (true) {
    const part = await reader.read();
    if (part.done) break;
    length += part.value.byteLength;
    if (length > 4096) { await reader.cancel(); throw new HttpError(413, 'BODY_TOO_LARGE', '입력 내용이 너무 길어요.'); }
    chunks.push(part.value);
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  try {
    const value: unknown = JSON.parse(new TextDecoder().decode(bytes));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    return value as Record<string, unknown>;
  } catch { throw new HttpError(400, 'INVALID_BODY', '입력 내용을 확인해 주세요.'); }
}
async function requireUser(request: Request, env: Env, now: number): Promise<UserRow> {
  const token = sessionToken(request);
  if (!token) throw new HttpError(401, 'UNAUTHENTICATED', '로그인이 필요해요.');
  const user = await env.DB.prepare('SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ? AND s.expires_at > ? AND u.active = 1').bind(await hashToken(token), now).first<UserRow>();
  if (!user) throw new HttpError(401, 'UNAUTHENTICATED', '다시 로그인해 주세요.');
  return user;
}
async function publicUser(db: D1Database, user: UserRow, now: Date): Promise<User> {
  const balances = await db.prepare("SELECT COALESCE(SUM(CASE WHEN currency = 'gold' THEN amount ELSE 0 END), 0) AS gold, COALESCE(SUM(CASE WHEN currency = 'score' AND week_start = ? THEN amount ELSE 0 END), 0) AS score FROM ledger WHERE user_id = ?").bind(weekStart(now), user.id).first<{ gold: number; score: number }>();
  return { id: user.id, username: user.username, displayName: user.display_name, role: user.role, gold: balances?.gold ?? 0, weeklyScore: balances?.score ?? 0, character: user.character };
}
async function consumeLoginLimit(db: D1Database, username: string, ip: string, now: number): Promise<void> {
  const bucketKeys = await Promise.all([hashToken(`user:${username}`), hashToken(`ip:${ip}`)]);
  const results = await db.batch(bucketKeys.map(bucket => db.prepare(`INSERT INTO login_attempts (bucket, attempts, expires_at) VALUES (?, 1, ?)
    ON CONFLICT(bucket) DO UPDATE SET attempts = CASE WHEN expires_at <= ? THEN 1 ELSE attempts + 1 END,
    expires_at = CASE WHEN expires_at <= ? THEN excluded.expires_at ELSE expires_at END RETURNING attempts`).bind(bucket, now + 15 * 60_000, now, now)));
  const exceeded = results.some((result, index) => Number((result.results[0] as { attempts?: number } | undefined)?.attempts ?? 0) > (index === 0 ? 10 : 30));
  if (exceeded) throw new HttpError(429, 'TOO_MANY_ATTEMPTS', '로그인 시도가 많아요. 15분 뒤 다시 시도해 주세요.');
}
async function login(request: Request, env: Env, now: Date): Promise<Response> {
  const input = await body(request);
  const username = typeof input.username === 'string' ? input.username.trim().toLowerCase() : '';
  if (!/^[a-z0-9_-]{2,32}$/.test(username) || typeof input.password !== 'string' || input.password.length < 1 || input.password.length > 128) throw new HttpError(400, 'INVALID_CREDENTIALS', '아이디와 비밀번호를 확인해 주세요.');
  await consumeLoginLimit(env.DB, username, request.headers.get('CF-Connecting-IP') ?? 'local', now.getTime());
  const user = await env.DB.prepare('SELECT * FROM users WHERE username = ? COLLATE NOCASE AND active = 1').bind(username).first<UserRow>();
  const passwordValid = await verifyPassword(input.password, user?.password_hash ?? DUMMY_HASH);
  if (!user || !passwordValid) throw new HttpError(401, 'INVALID_CREDENTIALS', '아이디와 비밀번호를 확인해 주세요.');
  const token = randomToken();
  const previousToken = sessionToken(request);
  const sessionWrites = await env.DB.batch([
    env.DB.prepare('DELETE FROM sessions WHERE expires_at <= ? OR token_hash = ?').bind(now.getTime(), previousToken ? await hashToken(previousToken) : ''),
    env.DB.prepare('DELETE FROM login_attempts WHERE expires_at <= ? OR bucket = ?').bind(now.getTime(), await hashToken(`user:${username}`)),
    // Recheck the verified credential snapshot atomically: a password reset, role
    // change or deactivation during the KDF must not mint a fresh session.
    env.DB.prepare(`INSERT INTO sessions (token_hash, user_id, expires_at, created_at)
      SELECT ?, id, ?, ? FROM users WHERE id = ? AND password_hash = ? AND role = ? AND active = 1`)
      .bind(await hashToken(token), now.getTime() + SESSION_AGE_SECONDS * 1000, now.getTime(), user.id, user.password_hash, user.role),
  ]);
  if (sessionWrites[2]!.meta.changes !== 1) throw new HttpError(401, 'INVALID_CREDENTIALS', '아이디와 비밀번호를 확인해 주세요.');
  return json({ user: await publicUser(env.DB, user, now) }, 200, { 'Set-Cookie': cookie(request, token, SESSION_AGE_SECONDS) });
}
async function roundResults(db: D1Database, id: GameId, date: string, answer: string): Promise<GameResult[]> {
  const rows = (await db.prepare(`SELECT p.player_id, u.username, u.display_name, p.value, u.character
    FROM predictions p JOIN users u ON u.id = p.player_id
    WHERE p.game_id = ? AND p.round_date = ? AND u.role = 'player' AND u.username != ?
    ORDER BY p.updated_at, p.player_id`).bind(id, date, GAME_RULES[id].author).all<PredictionRow>()).results;
  const differences = rows.map(row => valueDifference(id, row.value, answer));
  const closest = Math.min(...differences);
  return rows.map((row, index) => {
    const difference = differences[index]!;
    const isFirst = difference === closest;
    const participationGold = PREDICTION_REWARDS.participationGold;
    const firstGold = isFirst ? PREDICTION_REWARDS.firstGold : 0;
    return { playerId: row.player_id, username: row.username, displayName: row.display_name, character: row.character ?? defaultCharacter(row.username),
      value: row.value, difference, score: predictionPoints(id, difference), isFirst,
      participationGold, firstGold, gold: participationGold + firstGold };
  }).sort((left, right) => left.difference - right.difference);
}

/** Published answers and predictions are immutable. Each round's payouts and
 * completion marker commit together; references also make concurrent calls safe.
 * Scan past rounds too, since the first visit after a reveal may be on a new day. */
async function settlePublishedRounds(db: D1Database, now: Date): Promise<void> {
  const rounds = (await db.prepare(`SELECT game_id, round_date, answer, hint, reveal_at, revealed_at
    FROM game_rounds WHERE settled_at IS NULL AND answer IS NOT NULL
    AND (revealed_at IS NOT NULL OR reveal_at <= ?) ORDER BY round_date, game_id`)
    .bind(now.getTime()).all<UnsettledRound>()).results;
  for (const round of rounds) {
    const results = await roundResults(db, round.game_id, round.round_date, round.answer!);
    const writes: D1PreparedStatement[] = [];
    const gameWeek = weekStart(new Date(kstTimestamp(round.round_date, '00:00:00')));
    for (const result of results) {
      for (const [kind, currency, amount, reason] of [
        ['score', 'score', result.score, `${GAME_RULES[round.game_id].title} 예측 점수`],
        ['first', 'gold', result.firstGold, `${GAME_RULES[round.game_id].title} 1등`],
      ] as const) {
        if (amount === 0) continue;
        writes.push(db.prepare(`INSERT OR IGNORE INTO ledger
          (id, user_id, currency, amount, reason, reference, created_at, week_start)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
          .bind(crypto.randomUUID(), result.playerId, currency, amount, reason,
            `${kind}:${round.game_id}:${round.round_date}:${result.playerId}`, now.toISOString(), currency === 'score' ? gameWeek : null));
      }
    }
    writes.push(db.prepare('UPDATE game_rounds SET settled_at = ? WHERE game_id = ? AND round_date = ? AND settled_at IS NULL')
      .bind(now.getTime(), round.game_id, round.round_date));
    await db.batch(writes);
  }
}

async function readHistory(db: D1Database, id: GameId, now: Date): Promise<GameHistoryRound[]> {
  const rounds = (await db.prepare(`SELECT round_date, answer FROM game_rounds
    WHERE game_id = ? AND round_date < ? AND answer IS NOT NULL
    AND (revealed_at IS NOT NULL OR reveal_at <= ?) ORDER BY round_date DESC LIMIT 3`)
    .bind(id, kstDate(now), now.getTime()).all<{ round_date: string; answer: string }>()).results;
  return Promise.all(rounds.map(async round => ({ roundDate: round.round_date, answer: round.answer,
    results: await roundResults(db, id, round.round_date, round.answer) })));
}

async function readGame(db: D1Database, user: UserRow, id: GameId, now: Date): Promise<GameState> {
  const date = kstDate(now);
  const rules = GAME_RULES[id];
  const round = await db.prepare('SELECT answer, hint, reveal_at, revealed_at FROM game_rounds WHERE game_id = ? AND round_date = ?').bind(id, date).first<RoundRow>();
  const revealed = round?.answer != null && (round.revealed_at != null || (round.reveal_at != null && round.reveal_at <= now.getTime()));
  const closed = revealed || now.getTime() >= kstTimestamp(date, rules.deadline);
  const author = user.role === 'player' && user.username === rules.author;
  const prediction = await db.prepare('SELECT value FROM predictions WHERE game_id = ? AND round_date = ? AND player_id = ?').bind(id, date, user.id).first<{ value: string }>();
  const results = revealed ? await roundResults(db, id, date, round!.answer!) : [];
  const participants = (await db.prepare(`SELECT u.id AS playerId, u.username, u.display_name AS displayName, p.player_id IS NOT NULL AS submitted
    FROM users u LEFT JOIN predictions p ON p.player_id = u.id AND p.game_id = ? AND p.round_date = ?
    WHERE u.active = 1 AND u.role = 'player' AND u.username != ? ORDER BY u.username`).bind(id, date, rules.author).all<{ playerId: string; username: string; displayName: string; submitted: number }>()).results;
  return {
    participants: participants.map(player => ({ ...player, submitted: Boolean(player.submitted) })),
    id, title: rules.title, authorUsername: rules.author, deadline: rules.deadline, roundDate: date,
    phase: revealed ? 'revealed' : closed ? 'closed' : 'open', hint: round?.hint ?? '',
    prediction: prediction?.value ?? null, answer: revealed || author ? round?.answer ?? null : null,
    answerEntered: round?.answer != null,
    results,
    canPredict: !closed && !author && user.role === 'player', canEditAnswer: author && !revealed, canReveal: id !== 'wake' && author && !revealed && round?.answer != null,
  };
}
async function weeklyDailyScores(db: D1Database, userId: string, now: Date): Promise<number[]> {
  const monday = weekStart(now);
  // The profile's recent-entry limit must not truncate this week's chart.
  const rows = (await db.prepare(`SELECT amount, reference, created_at FROM ledger
    WHERE user_id = ? AND currency = 'score' AND week_start = ?`)
    .bind(userId, monday).all<{ amount: number; reference: string; created_at: string }>()).results;
  const daily = [0, 0, 0, 0, 0, 0, 0];
  for (const row of rows) {
    const roundDate = /^score:(?:wake|offwork|luck):(\d{4}-\d{2}-\d{2}):.+$/.exec(row.reference)?.[1];
    const date = roundDate ?? kstDate(new Date(row.created_at));
    const day = (Date.parse(`${date}T00:00:00Z`) - Date.parse(`${monday}T00:00:00Z`)) / 86_400_000;
    if (Number.isInteger(day) && day >= 0 && day < daily.length) daily[day]! += row.amount;
  }
  return daily;
}
async function readAttendance(db: D1Database, user: UserRow, now: Date, selectedMonth?: string): Promise<AttendanceState> {
  const today = kstDate(now);
  const yesterday = kstDate(new Date(now.getTime() - 86_400_000));
  const month = selectedMonth ?? today.slice(0, 7);
  if (!/^\d{4}-(?:0[1-9]|1[0-2])$/.test(month)) throw new HttpError(400, 'INVALID_MONTH', '조회할 달을 YYYY-MM 형식으로 입력해 주세요.');
  const [recent, history] = await Promise.all([
    db.prepare('SELECT date, streak FROM attendance WHERE user_id = ? AND date IN (?, ?)')
      .bind(user.id, today, yesterday).all<{ date: string; streak: number }>(),
    db.prepare('SELECT date FROM attendance WHERE user_id = ? AND date >= ? AND date <= ? ORDER BY date')
      .bind(user.id, `${month}-01`, `${month}-31`).all<{ date: string }>(),
  ]);
  const claimed = recent.results.find(row => row.date === today);
  const previous = recent.results.find(row => row.date === yesterday);
  const streak = claimed?.streak ?? (previous?.streak ?? 0) + 1;
  const days = history.results.map(row => row.date);
  return { today, claimed: Boolean(claimed), streak, cycleDay: attendanceCycleDay(streak), reward: attendanceReward(streak),
    canClaim: user.role === 'player' && !claimed, month, monthCount: days.length, days };
}

async function claimAttendance(request: Request, env: Env, user: UserRow, now: Date): Promise<Response> {
  if (user.role !== 'player') throw new HttpError(403, 'CANNOT_ATTEND', '플레이어만 출석할 수 있어요.');
  await body(request); // The authenticated user and server KST day are authoritative.
  now = new Date();
  const today = kstDate(now);
  const yesterday = kstDate(new Date(now.getTime() - 86_400_000));
  const dayStart = kstTimestamp(today, '00:00:00');
  const dayEnd = dayStart + 86_400_000;
  const writes = await env.DB.batch([
    // Read yesterday's streak inside the write, so concurrent claims cannot
    // overwrite a stored streak or create a second attendance for this day.
    env.DB.prepare(`INSERT OR IGNORE INTO attendance (user_id, date, streak, created_at)
      SELECT u.id, ?, COALESCE((SELECT streak + 1 FROM attendance WHERE user_id = u.id AND date = ?), 1), ?
      FROM users u WHERE u.id = ? AND u.role = 'player' AND u.active = 1
      AND unixepoch('now') * 1000 >= ? AND unixepoch('now') * 1000 < ?`)
      .bind(today, yesterday, now.toISOString(), user.id, dayStart, dayEnd),
    env.DB.prepare(`INSERT OR IGNORE INTO ledger
      (id, user_id, currency, amount, reason, reference, created_at)
      SELECT ?, user_id, 'gold', CASE WHEN streak % ? = 0 THEN ? ELSE ? END, '출석 체크', ?, ?
      FROM attendance WHERE user_id = ? AND date = ? AND changes() = 1`)
      .bind(crypto.randomUUID(), ATTENDANCE_RULES.cycleLength, ATTENDANCE_RULES.cycleGold, ATTENDANCE_RULES.dailyGold,
        `attendance:${today}:${user.id}`, now.toISOString(), user.id, today),
    env.DB.prepare("SELECT unixepoch('now') * 1000 >= ? AND unixepoch('now') * 1000 < ? AS dayOpen")
      .bind(dayStart, dayEnd),
  ]);
  // A claim queued across midnight must not backfill yesterday after a newer
  // day's streak was computed. Retrying uses the new server day instead.
  if (writes[0]!.meta.changes === 0 && !(writes[2]!.results[0] as { dayOpen: number }).dayOpen) {
    throw new HttpError(409, 'DAY_CHANGED', '새로운 하루가 시작됐어요. 화면을 새로고침하고 출석해 주세요.');
  }
  const attendance = await readAttendance(env.DB, user, now);
  if (!attendance.claimed) throw new HttpError(403, 'CANNOT_ATTEND', '플레이어만 출석할 수 있어요.');
  return json({ attendance, user: await publicUser(env.DB, user, now), awarded: writes[1]!.meta.changes === 1 });
}

async function updateCharacter(request: Request, env: Env, user: UserRow, now: Date): Promise<Response> {
  const input = await body(request);
  if (!isArtKey(input.character) || (input.migrate !== undefined && typeof input.migrate !== 'boolean')) {
    throw new HttpError(400, 'INVALID_CHARACTER', '사용할 캐릭터를 확인해 주세요.');
  }
  if (input.migrate === true && input.expectedUserId !== user.id) {
    throw new HttpError(409, 'ACCOUNT_CHANGED', '로그인한 계정이 바뀌었어요. 화면을 새로고침해 주세요.');
  }
  // A stale device's one-time import may only fill an unset choice. Explicit
  // selections may replace it, and multiple players may choose the same art.
  const updated = await env.DB.prepare(`UPDATE users SET character = ?
    WHERE id = ? AND active = 1 AND (? = 0 OR character IS NULL) RETURNING *`)
    .bind(input.character, user.id, input.migrate === true ? 1 : 0).first<UserRow>();
  const current = updated ?? await env.DB.prepare('SELECT * FROM users WHERE id = ? AND active = 1').bind(user.id).first<UserRow>();
  if (!current) throw new HttpError(401, 'UNAUTHENTICATED', '다시 로그인해 주세요.');
  return json({ user: await publicUser(env.DB, current, now) });
}

async function bootstrap(env: Env, user: UserRow, now: Date): Promise<BootstrapResponse> {
  // Complete payments before reading balances and weekly rankings in parallel.
  await settlePublishedRounds(env.DB, now);
  await settleDueLotto(env.DB, now);
  const [viewer, players, games, ledger, dailyScores, attendance, inventory] = await Promise.all([
    publicUser(env.DB, user, now),
    env.DB.prepare("SELECT u.id, u.username, u.display_name AS displayName, u.character, COALESCE(SUM(l.amount), 0) AS weeklyScore FROM users u LEFT JOIN ledger l ON l.user_id = u.id AND l.currency = 'score' AND l.week_start = ? WHERE u.role = 'player' AND u.active = 1 GROUP BY u.id ORDER BY weeklyScore DESC, u.username").bind(weekStart(now)).all<Omit<Player, 'character'> & { character: ArtKey | null }>(),
    Promise.all(GAME_IDS.map(id => readGame(env.DB, user, id, now))),
    env.DB.prepare('SELECT id, currency, amount, reason, created_at AS createdAt FROM ledger WHERE user_id = ? ORDER BY created_at DESC LIMIT 50').bind(user.id).all<LedgerEntry>(),
    weeklyDailyScores(env.DB, user.id, now),
    readAttendance(env.DB, user, now),
    readInventory(env.DB, user.id),
  ]);
  return { user: viewer, players: players.results.map(player => ({ ...player, character: player.character ?? defaultCharacter(player.username) })),
    games, ledger: ledger.results, dailyScores, attendance, inventory, serverTime: now.toISOString(), timeZone: TIME_ZONE };
}
async function mutateGame(request: Request, env: Env, user: UserRow, id: GameId, action: string, now: Date): Promise<Response> {
  const input = await body(request);
  const date = kstDate(now);
  // Reject stale browser tabs explicitly instead of silently carrying yesterday's input into today.
  if (input.roundDate !== date) throw new HttpError(409, 'ROUND_CHANGED', '새로운 하루가 시작됐어요. 화면을 새로고침해 주세요.');
  const rules = GAME_RULES[id];
  const author = user.role === 'player' && user.username === rules.author;
  if (action === 'prediction') {
    if (request.method !== 'PUT') throw new HttpError(405, 'METHOD_NOT_ALLOWED', '지원하지 않는 요청이에요.');
    if (user.role !== 'player' || author) throw new HttpError(403, 'CANNOT_PREDICT', '이 게임의 예측에 참여할 수 없어요.');
    if (!validValue(id, input.value)) throw new HttpError(400, 'INVALID_VALUE', id === 'luck' ? '0부터 100 사이의 정수를 입력해 주세요.' : '시간을 00:00:00부터 23:59:59 사이로 입력해 주세요.');
    if (now.getTime() >= kstTimestamp(date, rules.deadline)) throw new HttpError(409, 'PREDICTION_CLOSED', '오늘의 예측이 마감됐어요.');
    const writes = await env.DB.batch([
      env.DB.prepare('INSERT OR IGNORE INTO game_rounds (game_id, round_date, updated_at) VALUES (?, ?, ?)').bind(id, date, now.getTime()),
      env.DB.prepare(`INSERT INTO predictions (game_id, round_date, player_id, value, updated_at)
        SELECT ?, ?, ?, ?, ? FROM game_rounds WHERE game_id = ? AND round_date = ? AND revealed_at IS NULL AND (reveal_at IS NULL OR reveal_at > unixepoch('now') * 1000) AND unixepoch('now') * 1000 < ?
        ON CONFLICT(game_id, round_date, player_id) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`).bind(id, date, user.id, input.value, now.getTime(), id, date, kstTimestamp(date, rules.deadline)),
      // changes() belongs to the preceding conditional prediction write in this
      // transaction. A rejected write cannot pay; edits share the same reference.
      env.DB.prepare(`INSERT OR IGNORE INTO ledger
        (id, user_id, currency, amount, reason, reference, created_at)
        SELECT ?, ?, 'gold', ?, ?, ?, ? WHERE changes() = 1`)
        .bind(crypto.randomUUID(), user.id, PREDICTION_REWARDS.participationGold,
          `${rules.title} 참여`, `predict:${id}:${date}:${user.id}`, now.toISOString()),
    ]);
    if (writes[1]!.meta.changes === 0) throw new HttpError(409, 'PREDICTION_CLOSED', '정답이 공개되어 예측이 마감됐어요.');
  } else if (action === 'answer') {
    if (request.method !== 'PUT') throw new HttpError(405, 'METHOD_NOT_ALLOWED', '지원하지 않는 요청이에요.');
    if (!author) throw new HttpError(403, 'NOT_AUTHOR', '출제자만 정답을 입력할 수 있어요.');
    if (id === 'wake') throw new HttpError(400, 'WAKE_ACTION_REQUIRED', '기상했어요 버튼으로 정답을 공개해 주세요.');
    if (!validValue(id, input.value)) throw new HttpError(400, 'INVALID_VALUE', '정답 값을 확인해 주세요.');
    if (input.hint !== undefined && (typeof input.hint !== 'string' || input.hint.length > 200)) throw new HttpError(400, 'INVALID_HINT', '힌트는 200자 이내로 입력해 주세요.');
    const revealAt = kstTimestamp(date, id === 'luck' ? GAME_RULES.luck.revealTime : input.value);
    const result = await env.DB.prepare(`INSERT INTO game_rounds (game_id, round_date, answer, hint, reveal_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(game_id, round_date) DO UPDATE SET answer = excluded.answer, hint = excluded.hint, reveal_at = excluded.reveal_at, updated_at = excluded.updated_at
      WHERE game_rounds.revealed_at IS NULL AND (game_rounds.reveal_at IS NULL OR game_rounds.reveal_at > unixepoch('now') * 1000)`)
      .bind(id, date, input.value, id === 'luck' ? (input.hint ?? '') : '', revealAt, now.getTime()).run();
    if (result.meta.changes === 0) throw new HttpError(409, 'ALREADY_REVEALED', '공개된 정답은 수정할 수 없어요.');
  } else if (action === 'reveal') {
    if (request.method !== 'POST') throw new HttpError(405, 'METHOD_NOT_ALLOWED', '지원하지 않는 요청이에요.');
    if (!author) throw new HttpError(403, 'NOT_AUTHOR', '출제자만 정답을 공개할 수 있어요.');
    if (id === 'wake') throw new HttpError(400, 'WAKE_ACTION_REQUIRED', '기상했어요 버튼으로 정답을 공개해 주세요.');
    const result = await env.DB.prepare(`UPDATE game_rounds SET revealed_at = ?, updated_at = ? WHERE game_id = ? AND round_date = ? AND answer IS NOT NULL AND revealed_at IS NULL AND (reveal_at IS NULL OR reveal_at > unixepoch('now') * 1000)`)
      .bind(now.getTime(), now.getTime(), id, date).run();
    if (result.meta.changes === 0) throw new HttpError(409, 'CANNOT_REVEAL', '정답을 먼저 입력하거나 공개 상태를 확인해 주세요.');
  } else if (action === 'wake' && id === 'wake') {
    if (request.method !== 'POST') throw new HttpError(405, 'METHOD_NOT_ALLOWED', '지원하지 않는 요청이에요.');
    if (!author) throw new HttpError(403, 'NOT_AUTHOR', '출제자만 기상 시각을 공개할 수 있어요.');
    await env.DB.batch([
      env.DB.prepare('INSERT OR IGNORE INTO game_rounds (game_id, round_date, updated_at) VALUES (?, ?, ?)').bind(id, date, now.getTime()),
      // The first server timestamp wins, including concurrent presses/retries.
      env.DB.prepare(`UPDATE game_rounds SET answer = ?, revealed_at = ?, updated_at = ?
        WHERE game_id = ? AND round_date = ? AND answer IS NULL AND revealed_at IS NULL`)
        .bind(kstTime(now), now.getTime(), now.getTime(), id, date),
    ]);
  } else throw new HttpError(404, 'NOT_FOUND', '요청한 게임 기능이 없어요.');
  const refreshedAt = new Date();
  await settlePublishedRounds(env.DB, refreshedAt);
  return json({ game: await readGame(env.DB, user, id, refreshedAt) });
}
async function api(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const now = new Date();
  if (!['GET', 'HEAD'].includes(request.method)) requireSameOrigin(request);
  if (url.pathname === '/api/health' && request.method === 'GET') return json({ ok: true });
  if (url.pathname === '/api/auth/login' && request.method === 'POST') return login(request, env, now);
  if (url.pathname === '/api/auth/logout' && request.method === 'POST') {
    const token = sessionToken(request);
    if (token) await env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(await hashToken(token)).run();
    return json({ ok: true }, 200, { 'Set-Cookie': cookie(request, '', 0) });
  }
  const user = await requireUser(request, env, now.getTime());
  if (url.pathname === '/api/auth/me' && request.method === 'GET') return json({ user: await publicUser(env.DB, user, now) });
  if (url.pathname === '/api/bootstrap' && request.method === 'GET') return json(await bootstrap(env, user, now));
  if (url.pathname === '/api/me/attendance') {
    if (request.method === 'GET') return json({ attendance: await readAttendance(env.DB, user, now, url.searchParams.get('month') ?? undefined) });
    if (request.method === 'POST') return claimAttendance(request, env, user, now);
    throw new HttpError(405, 'METHOD_NOT_ALLOWED', '지원하지 않는 요청이에요.');
  }
  if (url.pathname === '/api/me/character') {
    if (request.method === 'PUT') return updateCharacter(request, env, user, now);
    throw new HttpError(405, 'METHOD_NOT_ALLOWED', '지원하지 않는 요청이에요.');
  }
  if (url.pathname === '/api/shop' || url.pathname.startsWith('/api/shop/')) {
    if (request.method === 'POST' && user.role !== 'player') throw new HttpError(403, 'CANNOT_PURCHASE', '플레이어만 구매할 수 있어요.');
    const input = request.method === 'POST' ? await body(request) : undefined;
    return json(await shopRoute(env.DB, user, url.pathname, request.method, input, new Date()));
  }
  const gameReadMatch = /^\/api\/games\/([^/]+)(?:\/(history))?$/.exec(url.pathname);
  if (gameReadMatch && isGameId(gameReadMatch[1]!) && request.method === 'GET') {
    await settlePublishedRounds(env.DB, now);
    return gameReadMatch[2] === 'history'
      ? json({ history: await readHistory(env.DB, gameReadMatch[1], now) })
      : json({ game: await readGame(env.DB, user, gameReadMatch[1], now) });
  }
  const gameMatch = /^\/api\/games\/([^/]+)\/([^/]+)$/.exec(url.pathname);
  if (gameMatch && isGameId(gameMatch[1]!)) return mutateGame(request, env, user, gameMatch[1]!, gameMatch[2]!, now);
  throw new HttpError(404, 'NOT_FOUND', '요청한 기능을 찾을 수 없어요.');
}
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (path !== '/api' && !path.startsWith('/api/')) return env.ASSETS.fetch(request);
    try { return await api(request, env); }
    catch (error) {
      if (error instanceof HttpError || error instanceof ShopError) return json({ error: { code: error.code, message: error.message } }, error.status, error.status === 429 ? { 'Retry-After': '900' } : undefined);
      console.error('API request failed', error instanceof Error ? error.name : 'UnknownError');
      return json({ error: { code: 'INTERNAL_ERROR', message: '잠시 문제가 생겼어요. 다시 시도해 주세요.' } }, 500);
    }
  },
} satisfies ExportedHandler<Env>;
