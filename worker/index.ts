import type { AttendanceState, BootstrapResponse, GameId, GameState, GameResult, GameHistoryRound, User, LedgerEntry, NicknameTagView } from '../shared/types';
import { ATTENDANCE_RULES, attendanceCycleDay, attendanceReward, attendanceTickets, CATCHMIND_RULES } from '../shared/balance';
import { defaultPredictionRules, predictionPointsForRules } from '../shared/game-settings';
import type { AdminState, PredictionRules } from '../shared/admin';
import { AdminSettingsError, readAdminGames, readAdminChanges, saveGameSettings, readGameRules, rulesForRound, roundSnapshotWrites } from './game-settings';
import { defaultCharacter, isArtKey, type ArtKey } from '../shared/characters';
import { DUMMY_HASH, hashPassword, hashToken, randomToken, verifyPassword } from './crypto';
import { PASSWORD_RULES, validNewPassword } from '../shared/password';
import { GAME_IDS, GAME_RULES, isGameId, kstDate, kstTime, kstTimestamp, TIME_ZONE, validValue, valueDifference, weekStart } from './rules';
import { readKujiSummary, readLottoNotice, settleDueLotto, ShopError, shopRoute } from './shop';
import { RankingError, readRanking } from './ranking';
import { equipTag, tagShopRoute } from './nickname-tags';
import type { NicknameTagGrade } from '../shared/nickname-tags';
import { CatchmindError, catchmindRoute, readCatchmindGallery, readCatchmindImage, readCatchmindSummary, readRemainingWords } from './catchmind';
import { ClawError, getClawState, getClawSummary, purchaseClawCoins, playClaw, readAdminClawConfig, saveAdminClawConfig } from './claw';
import { LaunchGiftError, getLaunchGiftState, claimLaunchGift } from './launch-gift';
import { ProfileError, updateProfile, uploadProfilePhoto, deleteProfilePhoto, readProfilePhoto } from './profile';
import { PhotoError } from './photos';
import { PROFILE_PHOTO, LUCK_PHOTO } from '../shared/profile';
import { LuckPhotoError, uploadLuckPhoto, readLuckPhoto, getLuckPhotoMetadata, luckPhotoUrl } from './luck-photos';
import { readAnnouncements } from './announcements';
import { maintainDatabase } from './maintenance';
import { StockError, addMarketHoliday, advanceStocks, readMarketHolidays, readStockDetail, readStockHome, readStockMarket, readStockNews, removeMarketHoliday, stockCronDue, stockSecret, tradeStock } from './stocks';
import { FEATURES } from '../shared/balance';

export interface Env { DB: D1Database; ASSETS: Fetcher; STOCK_SEED_SECRET?: string }
interface UserRow { id: string; username: string; display_name: string; password_hash: string; role: 'player' | 'admin'; active: number; character: ArtKey | null; photo_version: number | null }
interface RoundRow { answer: string | null; hint: string; reveal_at: number | null; revealed_at: number | null; settings_json: string | null }
interface PredictionRow { player_id: string; username: string; display_name: string; value: string; character: ArtKey | null; photo_version: number | null }
interface ProfileRow { id: string; username: string; display_name: string; role: 'player' | 'admin'; active: number; character: ArtKey | null; photo_version: number | null }
interface BootstrapProfile extends ProfileRow { gold: number; weeklyScore: number; lottoTickets: number; speettoTickets: number; tag_grade: NicknameTagGrade | null; tag_text: string | null }
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
async function body(request: Request, maxBytes = 4096): Promise<Record<string, unknown>> {
  if (!request.headers.get('Content-Type')?.toLowerCase().startsWith('application/json')) throw new HttpError(415, 'INVALID_CONTENT_TYPE', 'JSON 요청만 사용할 수 있어요.');
  if (Number(request.headers.get('Content-Length') || 0) > maxBytes) throw new HttpError(413, 'BODY_TOO_LARGE', '입력 내용이 너무 길어요.');
  const reader = request.body?.getReader();
  if (!reader) throw new HttpError(400, 'INVALID_BODY', '입력 내용을 확인해 주세요.');
  const chunks: Uint8Array[] = [];
  let length = 0;
  while (true) {
    const part = await reader.read();
    if (part.done) break;
    length += part.value.byteLength;
    if (length > maxBytes) { await reader.cancel(); throw new HttpError(413, 'BODY_TOO_LARGE', '입력 내용이 너무 길어요.'); }
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
/** The equipped tag joined on the same row; no extra query. */
const tagOf = (row: { tag_grade: NicknameTagGrade | null; tag_text: string | null } | null | undefined): NicknameTagView | null =>
  row?.tag_grade && row.tag_text ? { grade: row.tag_grade, text: row.tag_text } : null;
const EQUIPPED_TAG_JOIN = 'LEFT JOIN nickname_tags t ON t.user_id = u.id AND t.equipped = 1';
function userView(user: UserRow, balance: { gold: number; weeklyScore: number; photo_version: number | null; tag_grade: NicknameTagGrade | null; tag_text: string | null } | null | undefined): User {
  return { id: user.id, username: user.username, displayName: user.display_name, role: user.role,
    gold: balance?.gold ?? 0, weeklyScore: balance?.weeklyScore ?? 0, character: user.character,
    photoVersion: balance?.photo_version ?? null, tag: tagOf(balance) };
}
async function publicUser(db: D1Database, user: UserRow, now: Date): Promise<User> {
  const balance = await db.prepare(`SELECT COALESCE(b.gold, 0) AS gold,
      COALESCE((SELECT SUM(amount) FROM ledger WHERE currency = 'score' AND week_start = ? AND user_id = u.id), 0) AS weeklyScore,
      CASE WHEN p.user_id IS NOT NULL THEN u.photo_version ELSE NULL END AS photo_version,
      t.grade AS tag_grade, t.text AS tag_text
    FROM users u LEFT JOIN user_balances b ON b.user_id = u.id LEFT JOIN user_photos p ON p.user_id = u.id ${EQUIPPED_TAG_JOIN}
    WHERE u.id = ?`).bind(weekStart(now), user.id).first<Pick<BootstrapProfile, 'gold' | 'weeklyScore' | 'photo_version' | 'tag_grade' | 'tag_text'>>();
  return userView(user, balance);
}
async function consumeLoginLimit(db: D1Database, username: string, ip: string, now: number): Promise<void> {
  const bucketKeys = await Promise.all([hashToken(`user:${username}`), hashToken(`ip:${ip}`)]);
  const results = await db.batch(bucketKeys.map((bucket, index) => db.prepare(`INSERT INTO login_attempts (bucket, attempts, expires_at) VALUES (?, 1, ?)
    ON CONFLICT(bucket) DO UPDATE SET attempts = CASE WHEN expires_at <= ? THEN 1 ELSE attempts + 1 END,
    expires_at = CASE WHEN expires_at <= ? THEN excluded.expires_at ELSE expires_at END
    WHERE expires_at <= ? OR attempts <= ? RETURNING attempts`)
    .bind(bucket, now + 15 * 60_000, now, now, now, index === 0 ? 10 : 30)));
  // Keep the first denied attempt (limit + 1) for diagnostics, then avoid
  // repeated writes while blocked. An empty RETURNING result stays fail-closed.
  const exceeded = results.some((result, index) => !result.results.length
    || Number((result.results[0] as { attempts: number }).attempts) > (index === 0 ? 10 : 30));
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
    // Expired records are swept in the bounded daily maintenance job.
    env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(previousToken ? await hashToken(previousToken) : ''),
    env.DB.prepare('DELETE FROM login_attempts WHERE bucket = ?').bind(await hashToken(`user:${username}`)),
    // Recheck the verified credential snapshot atomically: a password reset, role
    // change or deactivation during the KDF must not mint a fresh session.
    env.DB.prepare(`INSERT INTO sessions (token_hash, user_id, expires_at, created_at)
      SELECT ?, id, ?, ? FROM users WHERE id = ? AND password_hash = ? AND role = ? AND active = 1`)
      .bind(await hashToken(token), now.getTime() + SESSION_AGE_SECONDS * 1000, now.getTime(), user.id, user.password_hash, user.role),
  ]);
  if (sessionWrites[2]!.meta.changes !== 1) throw new HttpError(401, 'INVALID_CREDENTIALS', '아이디와 비밀번호를 확인해 주세요.');
  return json({ user: await publicUser(env.DB, user, now) }, 200, { 'Set-Cookie': cookie(request, token, SESSION_AGE_SECONDS) });
}
async function changePassword(request: Request, env: Env, user: UserRow): Promise<Response> {
  const input = await body(request, PASSWORD_RULES.bodyMaxBytes);
  if (input.expectedUserId !== undefined && input.expectedUserId !== user.id) {
    throw new HttpError(409, 'ACCOUNT_CHANGED', '로그인한 계정이 바뀌었어요. 화면을 새로고침해 주세요.');
  }
  if (typeof input.currentPassword !== 'string' || input.currentPassword.length < 1
    || input.currentPassword.length > PASSWORD_RULES.maxLength
    || new TextEncoder().encode(input.currentPassword).byteLength > PASSWORD_RULES.maxBytes) {
    throw new HttpError(400, 'INVALID_CURRENT_PASSWORD', '현재 비밀번호를 확인해 주세요.');
  }
  if (!validNewPassword(input.newPassword)) {
    throw new HttpError(400, 'INVALID_NEW_PASSWORD', `새 비밀번호는 ${PASSWORD_RULES.minLength}~${PASSWORD_RULES.maxLength}자로 입력해 주세요.`);
  }
  if (input.currentPassword === input.newPassword) {
    throw new HttpError(400, 'PASSWORD_UNCHANGED', '새 비밀번호는 현재 비밀번호와 다르게 입력해 주세요.');
  }
  const bucket = await hashToken(`password:${user.id}`);
  const attemptedAt = Date.now();
  // Reserve a verification slot before the KDF, including concurrent requests.
  // Failed verification retains it; only a committed change clears the bucket.
  const attempts = await env.DB.prepare(`INSERT INTO login_attempts (bucket, attempts, expires_at) VALUES (?, 1, ?)
    ON CONFLICT(bucket) DO UPDATE SET attempts = CASE WHEN expires_at <= ? THEN 1 ELSE attempts + 1 END,
      expires_at = CASE WHEN expires_at <= ? THEN excluded.expires_at ELSE expires_at END
    WHERE expires_at <= ? OR attempts <= ? RETURNING attempts`)
    .bind(bucket, attemptedAt + PASSWORD_RULES.windowMs, attemptedAt, attemptedAt, attemptedAt, PASSWORD_RULES.attempts).first<number>('attempts');
  if (attempts === null || attempts > PASSWORD_RULES.attempts) {
    throw new HttpError(429, 'TOO_MANY_PASSWORD_ATTEMPTS', '비밀번호 확인 시도가 많아요. 15분 뒤 다시 시도해 주세요.');
  }
  if (!await verifyPassword(input.currentPassword, user.password_hash)) {
    // This is a failed confirmation, not an expired login session.
    throw new HttpError(400, 'CURRENT_PASSWORD_INCORRECT', '현재 비밀번호가 맞지 않아요.');
  }
  const passwordHash = await hashPassword(input.newPassword);
  const token = randomToken();
  const [tokenHash, previousTokenHash] = await Promise.all([hashToken(token), hashToken(sessionToken(request)!)]);
  const committedAt = Date.now();
  const writes = await env.DB.batch([
    env.DB.prepare(`UPDATE users SET password_hash = ? WHERE id = ? AND password_hash = ? AND active = 1
      AND EXISTS (SELECT 1 FROM sessions WHERE token_hash = ? AND user_id = users.id AND expires_at > ?) RETURNING id`)
      .bind(passwordHash, user.id, user.password_hash, previousTokenHash, committedAt),
    // users_revoke_sessions runs inside the UPDATE. changes() observes the
    // outer UPDATE, so a losing compare-and-swap cannot create a new session.
    env.DB.prepare(`INSERT INTO sessions (token_hash, user_id, expires_at, created_at)
      SELECT ?, ?, ?, ? WHERE changes() = 1`)
      .bind(tokenHash, user.id, committedAt + SESSION_AGE_SECONDS * 1000, committedAt),
    env.DB.prepare('DELETE FROM login_attempts WHERE bucket = ? AND changes() = 1').bind(bucket),
  ]);
  // D1 meta.changes also includes the trigger's deletes; RETURNING identifies
  // the one user actually updated, independently of their old session count.
  if (writes[0]!.results.length !== 1 || writes[1]!.meta.changes !== 1) {
    throw new HttpError(409, 'PASSWORD_CHANGE_CONFLICT', '계정 상태가 바뀌었어요. 다시 로그인해 주세요.');
  }
  return json({ ok: true }, 200, { 'Set-Cookie': cookie(request, token, SESSION_AGE_SECONDS) });
}

async function roundResults(db: D1Database, id: GameId, date: string, answer: string, rules: PredictionRules): Promise<GameResult[]> {
  const rows = (await db.prepare(`SELECT p.player_id, u.username, u.display_name, p.value, u.character,
    CASE WHEN EXISTS (SELECT 1 FROM user_photos WHERE user_id = u.id) THEN u.photo_version ELSE NULL END AS photo_version
    FROM predictions p JOIN users u ON u.id = p.player_id
    WHERE p.game_id = ? AND p.round_date = ? AND u.role = 'player' AND u.username != ?
    ORDER BY p.updated_at, p.player_id`).bind(id, date, GAME_RULES[id].author).all<PredictionRow>()).results;
  return calculateResults(rows, id, answer, rules);
}
function calculateResults(rows: PredictionRow[], id: GameId, answer: string, rules: PredictionRules): GameResult[] {
  const differences = rows.map(row => valueDifference(id, row.value, answer));
  const closest = Math.min(...differences);
  return rows.map((row, index) => {
    const difference = differences[index]!;
    const isFirst = difference === closest;
    const participationGold = rules.participationGold;
    const firstGold = isFirst ? rules.firstGold : 0;
    return { playerId: row.player_id, username: row.username, displayName: row.display_name, character: row.character ?? defaultCharacter(row.username), photoVersion: row.photo_version,
      value: row.value, difference, score: predictionPointsForRules(rules, difference), isFirst,
      participationGold, firstGold, gold: participationGold + firstGold };
  }).sort((left, right) => left.difference - right.difference);
}

/** Published answers and predictions are immutable. Each round's payouts and
 * completion marker commit together; references also make concurrent calls safe.
 * Scan past rounds too, since the first visit after a reveal may be on a new day. */
async function settlePublishedRounds(db: D1Database, now: Date): Promise<void> {
  const rounds = (await db.prepare(`SELECT r.game_id, r.round_date, r.answer, r.hint, r.reveal_at, r.revealed_at,
      COALESCE(r.settings_json, (SELECT settings_json FROM game_settings
        WHERE game_id = r.game_id AND effective_from <= r.round_date ORDER BY effective_from DESC LIMIT 1),
        CASE r.game_id WHEN 'wake' THEN ? WHEN 'offwork' THEN ? ELSE ? END) AS settings_json
    FROM game_rounds r WHERE r.settled_at IS NULL AND r.answer IS NOT NULL
    AND (r.revealed_at IS NOT NULL OR r.reveal_at <= ?) ORDER BY r.round_date, r.game_id`)
    .bind(...(['wake', 'offwork', 'luck'] as const).map(id => JSON.stringify(defaultPredictionRules(id))), now.getTime()).all<UnsettledRound>()).results;
  if (!rounds.length) return;
  // JSON keys keep the captured round set stable without exceeding D1's bound
  // parameter limit after a long absence. No per-round database calls are needed.
  const predictions = (await db.prepare(`SELECT p.game_id, p.round_date, p.player_id, p.value,
      u.username, u.display_name, u.character, NULL AS photo_version
    FROM predictions p JOIN users u ON u.id = p.player_id
    WHERE (p.game_id, p.round_date) IN (
      SELECT json_extract(value, '$[0]'), json_extract(value, '$[1]') FROM json_each(?)
    ) AND u.role = 'player' ORDER BY p.updated_at, p.player_id`)
    .bind(JSON.stringify(rounds.map(round => [round.game_id, round.round_date])))
    .all<PredictionRow & { game_id: GameId; round_date: string }>()).results;
  const byRound = new Map<string, PredictionRow[]>();
  for (const prediction of predictions) {
    if (prediction.username.toLowerCase() === GAME_RULES[prediction.game_id].author) continue;
    const key = `${prediction.game_id}:${prediction.round_date}`;
    const rows = byRound.get(key) ?? [];
    rows.push(prediction); byRound.set(key, rows);
  }
  const writes: D1PreparedStatement[] = [];
  for (const round of rounds) {
    const rules = JSON.parse(round.settings_json!) as PredictionRules;
    // Settlement needs amounts, not photo metadata; result displays load their
    // current profile metadata independently after payment has committed.
    const results = calculateResults(byRound.get(`${round.game_id}:${round.round_date}`) ?? [], round.game_id, round.answer!, rules);
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
  }
  // One D1 binding call for the whole batch: rewards and completion markers
  // commit together, including rollbacks and concurrent idempotent retries.
  await db.batch(writes);
}

async function readHistory(db: D1Database, user: UserRow, id: GameId, now: Date): Promise<GameHistoryRound[]> {
  const rounds = (await db.prepare(`SELECT round_date, answer, settings_json FROM game_rounds
    WHERE game_id = ? AND round_date < ? AND answer IS NOT NULL
    AND (revealed_at IS NOT NULL OR reveal_at <= ?) ORDER BY round_date DESC LIMIT 3`)
    .bind(id, kstDate(now), now.getTime()).all<{ round_date: string; answer: string; settings_json: string | null }>()).results;
  return Promise.all(rounds.map(async round => {
    const rules = await readGameRules(db, id, round.round_date, round.settings_json);
    return { roundDate: round.round_date, answer: round.answer,
      results: await roundResults(db, id, round.round_date, round.answer, rules),
      photo: id === 'luck' ? await getLuckPhotoMetadata(db, user, round.round_date, true) : null };
  }));
}

/** Current rounds share their roster and predictions. In bootstrap the roster is
 * also the viewer/standings query, so photos and names are not read per game. */
async function readGames(db: D1Database, user: UserRow, ids: readonly GameId[], now: Date,
  sharedProfiles?: Promise<ProfileRow[]>): Promise<GameState[]> {
  const date = kstDate(now);
  const [rounds, predictions, profiles] = await Promise.all([
    db.prepare(`WITH selected(game_id, defaults) AS (VALUES ${ids.map(() => '(?, ?)').join(', ')})
      SELECT s.game_id, r.answer, r.hint, r.reveal_at, r.revealed_at,
        COALESCE(r.settings_json, (SELECT settings_json FROM game_settings
          WHERE game_id = s.game_id AND effective_from <= ? ORDER BY effective_from DESC LIMIT 1), s.defaults) AS settings_json,
        CASE WHEN s.game_id = 'luck' THEN (SELECT version FROM luck_photos WHERE round_date = ?) END AS luck_photo_version
      FROM selected s LEFT JOIN game_rounds r ON r.game_id = s.game_id AND r.round_date = ?`)
      .bind(...ids.flatMap(id => [id, JSON.stringify(defaultPredictionRules(id))]), date, date, date)
      .all<RoundRow & { game_id: GameId; luck_photo_version: number | null }>(),
    db.prepare(`SELECT p.game_id, p.player_id, p.value, u.username, u.display_name, u.role, u.character,
        CASE WHEN photo.user_id IS NOT NULL THEN u.photo_version ELSE NULL END AS photo_version
      FROM predictions p JOIN users u ON u.id = p.player_id LEFT JOIN user_photos photo ON photo.user_id = u.id
      WHERE p.game_id IN (${ids.map(() => '?').join(', ')}) AND p.round_date = ? ORDER BY p.updated_at, p.player_id`)
      .bind(...ids, date).all<PredictionRow & { game_id: GameId; role: 'player' | 'admin' }>(),
    sharedProfiles ?? db.prepare(`SELECT u.id, u.username, u.display_name, u.role, u.active, u.character,
        CASE WHEN p.user_id IS NOT NULL THEN u.photo_version ELSE NULL END AS photo_version
      FROM users u LEFT JOIN user_photos p ON p.user_id = u.id
      WHERE (u.active = 1 AND u.role = 'player') OR u.username IN (${ids.map(() => '?').join(', ')})
      ORDER BY u.username`).bind(...ids.map(id => GAME_RULES[id].author)).all<ProfileRow>().then(result => result.results),
  ]);
  return ids.map(id => {
    const identity = GAME_RULES[id];
    const round = rounds.results.find(row => row.game_id === id)!;
    const rules = JSON.parse(round.settings_json!) as PredictionRules;
    const revealed = round.answer != null && (round.revealed_at != null || (round.reveal_at != null && round.reveal_at <= now.getTime()));
    const closed = !rules.enabled || revealed || now.getTime() >= kstTimestamp(date, rules.deadline);
    const author = user.role === 'player' && user.username === identity.author;
    const gamePredictions = predictions.results.filter(row => row.game_id === id);
    const submitted = new Set(gamePredictions.map(row => row.player_id));
    return {
      participants: profiles.filter(player => player.active === 1 && player.role === 'player' && player.username.toLowerCase() !== identity.author)
        .map(player => ({ playerId: player.id, username: player.username, displayName: player.display_name,
          photoVersion: player.photo_version, submitted: submitted.has(player.id) })),
      id, title: identity.title, authorUsername: identity.author,
      authorDisplayName: profiles.find(player => player.username.toLowerCase() === identity.author)?.display_name ?? identity.author,
      rules, photo: id === 'luck' && (revealed || author) && round.luck_photo_version != null
        ? { url: luckPhotoUrl(date, round.luck_photo_version), version: round.luck_photo_version } : null,
      deadline: rules.deadline, roundDate: date,
      phase: revealed ? 'revealed' : closed ? 'closed' : 'open', hint: round.hint ?? '',
      prediction: gamePredictions.find(row => row.player_id === user.id)?.value ?? null,
      answer: revealed || author ? round.answer ?? null : null,
      answerEntered: round.answer != null,
      results: revealed ? calculateResults(gamePredictions.filter(row => row.role === 'player' && row.username.toLowerCase() !== identity.author), id, round.answer!, rules) : [],
      canPredict: !closed && !author && user.role === 'player',
      canEditAnswer: rules.enabled && author && !revealed,
      canReveal: rules.enabled && id !== 'wake' && author && !revealed && round.answer != null,
    };
  });
}
async function readGame(db: D1Database, user: UserRow, id: GameId, now: Date): Promise<GameState> {
  return (await readGames(db, user, [id], now))[0]!;
}
async function weeklyDailyScores(db: D1Database, userId: string, now: Date): Promise<number[]> {
  const monday = weekStart(now);
  // The profile's recent-entry limit must not truncate this week's chart.
  const rows = (await db.prepare(`SELECT l.amount, l.reference, l.created_at, r.round_date AS game_date FROM ledger l
    LEFT JOIN catchmind_rounds r ON r.id = CASE WHEN l.reference LIKE 'catchmind:score:%' THEN substr(l.reference, length('catchmind:score:') + 1) END
    WHERE l.user_id = ? AND l.currency = 'score' AND l.week_start = ?`)
    .bind(userId, monday).all<{ amount: number; reference: string; created_at: string; game_date: string | null }>()).results;
  const daily = [0, 0, 0, 0, 0, 0, 0];
  for (const row of rows) {
    const roundDate = /^score:(?:wake|offwork|luck):(\d{4}-\d{2}-\d{2}):.+$/.exec(row.reference)?.[1];
    const date = row.game_date ?? roundDate ?? kstDate(new Date(row.created_at));
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
  const awardId = crypto.randomUUID();
  const tickets = attendanceTickets(today);
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
      .bind(awardId, ATTENDANCE_RULES.cycleLength, ATTENDANCE_RULES.cycleGold, ATTENDANCE_RULES.dailyGold,
        `attendance:${today}:${user.id}`, now.toISOString(), user.id, today),
    // Both coupons depend on this attempt's new gold award, not changes() from
    // the preceding coupon. A saved/queued retry cannot backfill or pay twice.
    ...([
      ['lotto_ticket', 'lotto', tickets.lottoTickets],
      ['speetto_ticket', 'speetto', tickets.speettoTickets],
    ] as const).filter(([, , amount]) => amount > 0).map(([item, suffix, amount]) => env.DB.prepare(`
      INSERT OR IGNORE INTO inventory_ledger (id, user_id, item, amount, reason, reference, created_at)
      SELECT ?, user_id, ?, ?, '출석 체크', ?, created_at FROM ledger WHERE id = ?`)
      .bind(crypto.randomUUID(), item, amount, `attendance:${today}:${user.id}:${suffix}`, awardId)),
    env.DB.prepare("SELECT unixepoch('now') * 1000 >= ? AND unixepoch('now') * 1000 < ? AS dayOpen")
      .bind(dayStart, dayEnd),
  ]);
  // A claim queued across midnight must not backfill yesterday after a newer
  // day's streak was computed. Retrying uses the new server day instead.
  if (writes[0]!.meta.changes === 0 && !(writes[writes.length - 1]!.results[0] as { dayOpen: number }).dayOpen) {
    throw new HttpError(409, 'DAY_CHANGED', '새로운 하루가 시작됐어요. 화면을 새로고침하고 출석해 주세요.');
  }
  const attendance = await readAttendance(env.DB, user, now);
  if (!attendance.claimed) throw new HttpError(403, 'CANNOT_ATTEND', '플레이어만 출석할 수 있어요.');
  return json({ attendance, user: await publicUser(env.DB, user, now), awarded: writes[1]!.meta.changes > 0 });
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
  // Keep inactive authors' names available while excluding them from current
  // participants/standings. Historical result participants are read separately.
  const profiles = env.DB.prepare(`SELECT u.id, u.username, u.display_name, u.role, u.active, u.character,
      CASE WHEN p.user_id IS NOT NULL THEN u.photo_version ELSE NULL END AS photo_version,
      COALESCE(b.gold, 0) AS gold, COALESCE(b.lotto_tickets, 0) AS lottoTickets, COALESCE(b.speetto_tickets, 0) AS speettoTickets,
      COALESCE((SELECT SUM(amount) FROM ledger WHERE currency = 'score' AND week_start = ? AND user_id = u.id), 0) AS weeklyScore,
      t.grade AS tag_grade, t.text AS tag_text
    FROM users u LEFT JOIN user_photos p ON p.user_id = u.id LEFT JOIN user_balances b ON b.user_id = u.id ${EQUIPPED_TAG_JOIN}
    WHERE (u.role = 'player' AND u.active = 1) OR u.id = ? OR u.username IN (?, ?, ?) ORDER BY u.username`)
    .bind(weekStart(now), user.id, ...GAME_IDS.map(id => GAME_RULES[id].author)).all<BootstrapProfile>().then(result => result.results);
  const [roster, games, ledger, dailyScores, attendance, kuji, catchmind, claw, launchGift, announcements, lottoNotice, stock] = await Promise.all([
    profiles,
    readGames(env.DB, user, GAME_IDS, now, profiles),
    env.DB.prepare('SELECT id, currency, amount, reason, created_at AS createdAt FROM ledger WHERE user_id = ? ORDER BY created_at DESC LIMIT 50').bind(user.id).all<LedgerEntry>(),
    weeklyDailyScores(env.DB, user.id, now),
    readAttendance(env.DB, user, now),
    readKujiSummary(env.DB),
    readCatchmindSummary(env.DB),
    getClawSummary(env.DB, user, now.getTime()),
    getLaunchGiftState(env.DB, user, now),
    readAnnouncements(env.DB, user.id, now),
    readLottoNotice(env.DB, user.id, now),
    FEATURES.stock ? readStockHome(env.DB, user, now.getTime()) : null,
  ]);
  const viewer = roster.find(player => player.id === user.id);
  const players = roster.filter(player => player.role === 'player' && player.active === 1)
    .sort((left, right) => right.weeklyScore - left.weeklyScore)
    .map(player => ({ id: player.id, username: player.username, displayName: player.display_name,
      character: player.character ?? defaultCharacter(player.username), photoVersion: player.photo_version, weeklyScore: player.weeklyScore, tag: tagOf(player) }));
  return { user: userView(user, viewer), players,
    games, ledger: ledger.results, dailyScores, attendance,
    inventory: { lottoTickets: viewer?.lottoTickets ?? 0, speettoTickets: viewer?.speettoTickets ?? 0 },
    kuji, lottoNotice, catchmind, claw, launchGift, announcements, stock, serverTime: now.toISOString(), timeZone: TIME_ZONE };
}
async function rejectGameWrite(db: D1Database, id: GameId, date: string, code: string, message: string): Promise<never> {
  if (kstDate(new Date()) !== date) throw new HttpError(409, 'ROUND_CHANGED', '새로운 하루가 시작됐어요. 화면을 새로고침해 주세요.');
  if (!(await rulesForRound(db, id, date)).enabled) throw new HttpError(409, 'GAME_OFF', '오늘은 이 게임을 쉬어요.');
  throw new HttpError(409, code, message);
}
async function mutateGame(request: Request, env: Env, user: UserRow, id: GameId, action: string, now: Date): Promise<Response> {
  const input = await body(request);
  now = new Date();
  const date = kstDate(now);
  if (input.roundDate !== date) throw new HttpError(409, 'ROUND_CHANGED', '새로운 하루가 시작됐어요. 화면을 새로고침해 주세요.');
  const identity = GAME_RULES[id];
  const author = user.role === 'player' && user.username === identity.author;
  const rules = await rulesForRound(env.DB, id, date);
  if (!rules.enabled) throw new HttpError(409, 'GAME_OFF', '오늘은 이 게임을 쉬어요.');
  const start = kstTimestamp(date, '00:00:00');
  if (action === 'prediction') {
    if (request.method !== 'PUT') throw new HttpError(405, 'METHOD_NOT_ALLOWED', '지원하지 않는 요청이에요.');
    if (user.role !== 'player' || author) throw new HttpError(403, 'CANNOT_PREDICT', '이 게임의 예측에 참여할 수 없어요.');
    if (!validValue(id, input.value)) throw new HttpError(400, 'INVALID_VALUE', id === 'luck' ? '0부터 100 사이의 정수를 입력해 주세요.' : '시간을 00:00:00부터 23:59:59 사이로 입력해 주세요.');
    if (now.getTime() >= kstTimestamp(date, rules.deadline)) throw new HttpError(409, 'PREDICTION_CLOSED', '오늘의 예측이 마감됐어요.');
    // ADMIN_RULES_WRITE_BOUNDARY: snapshots and their first activity commit together.
    const writes = await env.DB.batch([
      ...roundSnapshotWrites(env.DB, id, date, now, true),
      env.DB.prepare(`INSERT INTO predictions (game_id, round_date, player_id, value, updated_at)
        SELECT ?, ?, ?, ?, ? FROM game_rounds WHERE game_id = ? AND round_date = ?
          AND json_extract(settings_json, '$.enabled') = 1 AND revealed_at IS NULL
          AND (reveal_at IS NULL OR reveal_at > unixepoch('now') * 1000)
          AND unixepoch('now') * 1000 >= ? AND unixepoch('now') * 1000 < ?
          AND unixepoch('now') * 1000 < unixepoch(? || 'T' || json_extract(settings_json, '$.deadline') || '+09:00') * 1000
        ON CONFLICT(game_id, round_date, player_id) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`)
        .bind(id, date, user.id, input.value, now.getTime(), id, date, start, start + 86_400_000, date),
      // Read the amount from that same stored snapshot. Zero rewards create no
      // forbidden zero ledger entry; reference UNIQUE still deduplicates edits.
      env.DB.prepare(`INSERT OR IGNORE INTO ledger (id, user_id, currency, amount, reason, reference, created_at)
        SELECT ?, ?, 'gold', json_extract(settings_json, '$.participationGold'), ?, ?, ?
        FROM game_rounds WHERE game_id = ? AND round_date = ? AND changes() = 1
          AND json_extract(settings_json, '$.participationGold') > 0`)
        .bind(crypto.randomUUID(), user.id, `${identity.title} 참여`, `predict:${id}:${date}:${user.id}`, now.toISOString(), id, date),
    ]);
    if (writes[2]!.meta.changes === 0) await rejectGameWrite(env.DB, id, date, 'PREDICTION_CLOSED', '정답이 공개되었거나 예측이 마감됐어요.');
  } else if (action === 'answer') {
    if (request.method !== 'PUT') throw new HttpError(405, 'METHOD_NOT_ALLOWED', '지원하지 않는 요청이에요.');
    if (!author) throw new HttpError(403, 'NOT_AUTHOR', '출제자만 정답을 입력할 수 있어요.');
    if (id === 'wake') throw new HttpError(400, 'WAKE_ACTION_REQUIRED', '기상했어요 버튼으로 정답을 공개해 주세요.');
    if (!validValue(id, input.value)) throw new HttpError(400, 'INVALID_VALUE', '정답 값을 확인해 주세요.');
    if (input.hint !== undefined && (typeof input.hint !== 'string' || input.hint.length > 200)) throw new HttpError(400, 'INVALID_HINT', '힌트는 200자 이내로 입력해 주세요.');
    if (id === 'luck' && !await env.DB.prepare('SELECT 1 FROM luck_photos WHERE round_date = ?').bind(date).first()) {
      throw new HttpError(400, 'PHOTO_REQUIRED', '증거 사진을 먼저 올려 주세요.');
    }
    // ADMIN_RULES_WRITE_BOUNDARY: answer time and rules are resolved inside SQL.
    const writes = await env.DB.batch([
      ...roundSnapshotWrites(env.DB, id, date, now),
      env.DB.prepare(`UPDATE game_rounds SET answer = ?, hint = ?,
          reveal_at = unixepoch(? || 'T' || CASE WHEN game_id = 'luck' THEN json_extract(settings_json, '$.revealTime') ELSE ? END || '+09:00') * 1000,
          updated_at = ?
        WHERE game_id = ? AND round_date = ? AND json_extract(settings_json, '$.enabled') = 1
          AND (? != 'luck' OR EXISTS (SELECT 1 FROM luck_photos WHERE round_date = ?))
          AND unixepoch('now') * 1000 >= ? AND unixepoch('now') * 1000 < ?
          AND revealed_at IS NULL AND (reveal_at IS NULL OR reveal_at > unixepoch('now') * 1000)`)
        .bind(input.value, id === 'luck' ? (input.hint ?? '') : '', date, input.value, now.getTime(), id, date, id, date, start, start + 86_400_000),
    ]);
    if (writes[2]!.meta.changes === 0) await rejectGameWrite(env.DB, id, date, 'ALREADY_REVEALED', '공개된 정답은 수정할 수 없어요.');
  } else if (action === 'reveal') {
    if (request.method !== 'POST') throw new HttpError(405, 'METHOD_NOT_ALLOWED', '지원하지 않는 요청이에요.');
    if (!author) throw new HttpError(403, 'NOT_AUTHOR', '출제자만 정답을 공개할 수 있어요.');
    if (id === 'wake') throw new HttpError(400, 'WAKE_ACTION_REQUIRED', '기상했어요 버튼으로 정답을 공개해 주세요.');
    // ADMIN_RULES_WRITE_BOUNDARY: reveal cannot create a missing round.
    const writes = await env.DB.batch([
      roundSnapshotWrites(env.DB, id, date, now)[1]!,
      env.DB.prepare(`UPDATE game_rounds SET revealed_at = ?, updated_at = ?
        WHERE game_id = ? AND round_date = ? AND answer IS NOT NULL AND revealed_at IS NULL
          AND json_extract(settings_json, '$.enabled') = 1
          AND (reveal_at IS NULL OR reveal_at > unixepoch('now') * 1000)
          AND unixepoch('now') * 1000 >= ? AND unixepoch('now') * 1000 < ?`)
        .bind(now.getTime(), now.getTime(), id, date, start, start + 86_400_000),
    ]);
    if (writes[1]!.meta.changes === 0) await rejectGameWrite(env.DB, id, date, 'CANNOT_REVEAL', '정답을 먼저 입력하거나 공개 상태를 확인해 주세요.');
  } else if (action === 'wake' && id === 'wake') {
    if (request.method !== 'POST') throw new HttpError(405, 'METHOD_NOT_ALLOWED', '지원하지 않는 요청이에요.');
    if (!author) throw new HttpError(403, 'NOT_AUTHOR', '출제자만 기상 시각을 입력할 수 있어요.');
    // ADMIN_RULES_WRITE_BOUNDARY: the first server time and its rules win together.
    const writes = await env.DB.batch([
      ...roundSnapshotWrites(env.DB, id, date, now),
      env.DB.prepare(`UPDATE game_rounds SET answer = ?, revealed_at = ?, updated_at = ?
        WHERE game_id = ? AND round_date = ? AND answer IS NULL AND revealed_at IS NULL
          AND json_extract(settings_json, '$.enabled') = 1
          AND unixepoch('now') * 1000 >= ? AND unixepoch('now') * 1000 < ?`)
        .bind(kstTime(now), now.getTime(), now.getTime(), id, date, start, start + 86_400_000),
    ]);
    if (!writes[2]!.meta.changes) {
      const answered = await env.DB.prepare('SELECT answer FROM game_rounds WHERE game_id = ? AND round_date = ?').bind(id, date).first<string>('answer');
      if (answered === null) await rejectGameWrite(env.DB, id, date, 'CANNOT_WAKE', '기상 시각을 저장하지 못했어요. 다시 시도해 주세요.');
    }
  } else throw new HttpError(404, 'NOT_FOUND', '요청한 게임 기능이 없어요.');
  const refreshedAt = new Date();
  await settlePublishedRounds(env.DB, refreshedAt);
  return json({ game: await readGame(env.DB, user, id, refreshedAt) });
}
async function adminState(db: D1Database, now: Date): Promise<AdminState> {
  const [games, claw, changes, catchmindWordsRemaining, marketHolidays] = await Promise.all([readAdminGames(db, now), readAdminClawConfig(db), readAdminChanges(db), readRemainingWords(db), readMarketHolidays(db, now.getTime())]);
  return { today: kstDate(now), tomorrow: kstDate(new Date(now.getTime() + 86_400_000)), games, claw, changes, catchmindWordsRemaining, marketHolidays, serverTime: now.toISOString() };
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
  if (url.pathname === '/api/admin' || url.pathname.startsWith('/api/admin/')) {
    if (user.role !== 'admin') throw new HttpError(403, 'ADMIN_ONLY', '운영자만 사용할 수 있어요.');
    if (url.pathname === '/api/admin' && request.method === 'GET') return json(await adminState(env.DB, now));
    const gameSettings = /^\/api\/admin\/games\/([^/]+)$/.exec(url.pathname);
    if (gameSettings && isGameId(gameSettings[1]!)) {
      if (request.method !== 'PUT') throw new HttpError(405, 'METHOD_NOT_ALLOWED', '지원하지 않는 요청이에요.');
      const input = await body(request);
      if (input.expectedUserId !== undefined && input.expectedUserId !== user.id) throw new HttpError(409, 'ACCOUNT_CHANGED', '로그인한 계정이 바뀌었어요. 화면을 새로고침해 주세요.');
      await saveGameSettings(env.DB, user, gameSettings[1], input, new Date());
      return json(await adminState(env.DB, new Date()));
    }
    if (url.pathname === '/api/admin/claw') {
      if (request.method !== 'PUT') throw new HttpError(405, 'METHOD_NOT_ALLOWED', '지원하지 않는 요청이에요.');
      const input = await body(request);
      if (input.expectedUserId !== undefined && input.expectedUserId !== user.id) throw new HttpError(409, 'ACCOUNT_CHANGED', '로그인한 계정이 바뀌었어요. 화면을 새로고침해 주세요.');
      await saveAdminClawConfig(env.DB, user, input, new Date());
      return json(await adminState(env.DB, new Date()));
    }
    const holidayMatch = /^\/api\/admin\/market-holidays(?:\/(\d{4}-\d{2}-\d{2}))?$/.exec(url.pathname);
    if (holidayMatch) {
      if (request.method === 'POST' && !holidayMatch[1]) {
        const input = await body(request);
        if (input.expectedUserId !== undefined && input.expectedUserId !== user.id) throw new HttpError(409, 'ACCOUNT_CHANGED', '로그인한 계정이 바뀌었어요. 화면을 새로고침해 주세요.');
        await addMarketHoliday(env.DB, user, input, Date.now());
      } else if (request.method === 'DELETE' && holidayMatch[1]) await removeMarketHoliday(env.DB, holidayMatch[1], Date.now());
      else throw new HttpError(405, 'METHOD_NOT_ALLOWED', '지원하지 않는 요청이에요.');
      return json(await adminState(env.DB, new Date()));
    }
    throw new HttpError(404, 'NOT_FOUND', '요청한 운영 기능이 없어요.');
  }
  if (url.pathname === '/api/me/password') {
    if (request.method !== 'PUT') throw new HttpError(405, 'METHOD_NOT_ALLOWED', '지원하지 않는 요청이에요.');
    return changePassword(request, env, user);
  }
  if (url.pathname === '/api/auth/me' && request.method === 'GET') return json({ user: await publicUser(env.DB, user, now) });
  if (url.pathname === '/api/bootstrap' && request.method === 'GET') return json(await bootstrap(env, user, now));
  if (url.pathname === '/api/me/profile' || url.pathname === '/api/me/photo') {
    if (request.method !== 'PUT' && !(url.pathname.endsWith('/photo') && request.method === 'DELETE')) {
      throw new HttpError(405, 'METHOD_NOT_ALLOWED', '지원하지 않는 요청이에요.');
    }
    const input = request.method === 'DELETE' && !request.body ? {} : await body(request,
      url.pathname.endsWith('/photo') ? Math.ceil(PROFILE_PHOTO.maxBytes / 3) * 4 + 4096 : 4096);
    // A different tab can replace the session cookie before this tab refreshes.
    if (input.expectedUserId !== undefined && input.expectedUserId !== user.id) throw new HttpError(409, 'ACCOUNT_CHANGED', '로그인한 계정이 바뀌었어요. 화면을 새로고침해 주세요.');
    if (url.pathname.endsWith('/profile')) await updateProfile(env.DB, user, input);
    else if (request.method === 'PUT') await uploadProfilePhoto(env.DB, user, input, new Date());
    else await deleteProfilePhoto(env.DB, user, new Date());
    const current = await env.DB.prepare('SELECT * FROM users WHERE id = ? AND active = 1').bind(user.id).first<UserRow>();
    if (!current) throw new HttpError(401, 'UNAUTHENTICATED', '다시 로그인해 주세요.');
    return json({ user: await publicUser(env.DB, current, new Date()) });
  }
  const profilePhotoMatch = /^\/api\/users\/([^/]+)\/photo$/.exec(url.pathname);
  if (profilePhotoMatch) {
    if (request.method !== 'GET') throw new HttpError(405, 'METHOD_NOT_ALLOWED', '지원하지 않는 요청이에요.');
    return readProfilePhoto(env.DB, user, profilePhotoMatch[1]!, url.searchParams.get('v'));
  }
  if (url.pathname === '/api/games/luck/photo') {
    if (request.method !== 'PUT') throw new HttpError(405, 'METHOD_NOT_ALLOWED', '지원하지 않는 요청이에요.');
    const input = await body(request, Math.ceil(LUCK_PHOTO.maxBytes / 3) * 4 + 4096);
    return json(await uploadLuckPhoto(env.DB, user, input, new Date()));
  }
  const luckPhotoMatch = /^\/api\/games\/luck\/rounds\/([^/]+)\/photo$/.exec(url.pathname);
  if (luckPhotoMatch) {
    if (request.method !== 'GET') throw new HttpError(405, 'METHOD_NOT_ALLOWED', '지원하지 않는 요청이에요.');
    return readLuckPhoto(env.DB, user, luckPhotoMatch[1]!, url.searchParams.get('v'), now);
  }
  if (url.pathname === '/api/events/launch-gift') {
    if (request.method !== 'POST') throw new HttpError(405, 'METHOD_NOT_ALLOWED', '지원하지 않는 요청이에요.');
    if (user.role !== 'player') throw new HttpError(403, 'CANNOT_CLAIM_GIFT', '플레이어만 런칭 선물을 받을 수 있어요.');
    await body(request);
    return json(await claimLaunchGift(env.DB, user, new Date()));
  }
  if (url.pathname === '/api/claw') {
    if (request.method !== 'GET') throw new HttpError(405, 'METHOD_NOT_ALLOWED', '지원하지 않는 요청이에요.');
    return json(await getClawState(env.DB, user, now.getTime()));
  }
  if (url.pathname === '/api/claw/coins' || url.pathname === '/api/claw/play') {
    if (request.method !== 'POST') throw new HttpError(405, 'METHOD_NOT_ALLOWED', '지원하지 않는 요청이에요.');
    if (url.pathname.endsWith('/coins') && user.role !== 'player') throw new HttpError(403, 'CANNOT_PLAY', '플레이어만 코인을 구매할 수 있어요.');
    const input = await body(request);
    return json(await (url.pathname.endsWith('/coins')
      ? purchaseClawCoins(env.DB, user, input, Date.now())
      : playClaw(env.DB, user, input, Date.now())));
  }
  if (url.pathname === '/api/me/attendance') {
    if (request.method === 'GET') return json({ attendance: await readAttendance(env.DB, user, now, url.searchParams.get('month') ?? undefined) });
    if (request.method === 'POST') return claimAttendance(request, env, user, now);
    throw new HttpError(405, 'METHOD_NOT_ALLOWED', '지원하지 않는 요청이에요.');
  }
  if (url.pathname === '/api/me/character') {
    if (request.method === 'PUT') return updateCharacter(request, env, user, now);
    throw new HttpError(405, 'METHOD_NOT_ALLOWED', '지원하지 않는 요청이에요.');
  }
  if (url.pathname === '/api/catchmind/gallery') {
    if (request.method !== 'GET') throw new HttpError(405, 'METHOD_NOT_ALLOWED', '지원하지 않는 요청이에요.');
    const positiveInteger = (value: string | null, fallback: number) => {
      if (value === null) return fallback;
      if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value))) {
        throw new HttpError(400, 'INVALID_PAGE', '갤러리 페이지를 확인해 주세요.');
      }
      return Number(value);
    };
    const before = positiveInteger(url.searchParams.get('before'), Number.MAX_SAFE_INTEGER);
    const limit = positiveInteger(url.searchParams.get('limit'), CATCHMIND_RULES.galleryPageSize);
    if (limit > CATCHMIND_RULES.galleryPageSize) throw new HttpError(400, 'INVALID_PAGE', '한 번에 불러올 그림 수를 확인해 주세요.');
    return json(await readCatchmindGallery(env.DB, before, limit));
  }
  if (url.pathname === '/api/ranking') {
    if (request.method !== 'GET') throw new HttpError(405, 'METHOD_NOT_ALLOWED', '지원하지 않는 요청이에요.');
    return json(await readRanking(env.DB, user, url.searchParams.get('period'), url.searchParams.get('before'), now));
  }
  const catchmindImageMatch = /^\/api\/catchmind\/rounds\/([^/]+)\/image$/.exec(url.pathname);
  if (catchmindImageMatch) {
    if (request.method !== 'GET') throw new HttpError(405, 'METHOD_NOT_ALLOWED', '지원하지 않는 요청이에요.');
    return readCatchmindImage(env.DB, user, catchmindImageMatch[1]!);
  }
  const catchmindMatch = /^\/api\/catchmind(?:\/([^/]+))?$/.exec(url.pathname);
  if (catchmindMatch) {
    if (request.method === 'POST' && user.role !== 'player') throw new HttpError(403, 'CANNOT_PLAY', '플레이어만 캐치마인드에 참여할 수 있어요.');
    const maxBytes = catchmindMatch[1] === 'publish' ? Math.ceil(CATCHMIND_RULES.maxImageBytes / 3) * 4 + 4096 : 4096;
    const input = request.method === 'POST' ? await body(request, maxBytes) : undefined;
    const rawSince = request.method === 'GET' && !catchmindMatch[1] ? url.searchParams.get('since') : null;
    if (rawSince !== null && (!/^\d{1,16}$/.test(rawSince) || !Number.isSafeInteger(Number(rawSince)))) {
      throw new HttpError(400, 'INVALID_VERSION', '판 버전을 확인해 주세요.');
    }
    return json(await catchmindRoute(env.DB, user, catchmindMatch[1], request.method, input, new Date(), rawSince === null ? undefined : Number(rawSince)));
  }
  if (url.pathname === '/api/stock' || url.pathname.startsWith('/api/stock/')) {
    const secret = stockSecret(env.STOCK_SEED_SECRET);
    if (url.pathname === '/api/stock/trade') {
      if (request.method !== 'POST') throw new HttpError(405, 'METHOD_NOT_ALLOWED', '지원하지 않는 요청이에요.');
      return json(await tradeStock(env.DB, secret, user, await body(request), Date.now()));
    }
    if (request.method !== 'GET') throw new HttpError(405, 'METHOD_NOT_ALLOWED', '지원하지 않는 요청이에요.');
    if (url.pathname === '/api/stock') {
      const since = url.searchParams.get('since');
      return json(await readStockMarket(env.DB, secret, user, now.getTime(), since && since.length <= 64 ? since : undefined));
    }
    if (url.pathname === '/api/stock/news') return json(await readStockNews(env.DB, secret, user, url.searchParams.get('before'), now.getTime()));
    const stockMatch = /^\/api\/stock\/([A-Z]{4})$/.exec(url.pathname);
    if (stockMatch) return json(await readStockDetail(env.DB, secret, user, stockMatch[1]!, now.getTime()));
    throw new HttpError(404, 'NOT_FOUND', '요청한 기능을 찾을 수 없어요.');
  }
  if (url.pathname === '/api/shop/tag') {
    const input = request.method === 'POST' ? await body(request) : undefined;
    return json(await tagShopRoute(env.DB, user, request.method, input, new Date()));
  }
  if (url.pathname === '/api/me/nickname-tag') {
    if (request.method !== 'PUT') throw new HttpError(405, 'METHOD_NOT_ALLOWED', '지원하지 않는 요청이에요.');
    return json(await equipTag(env.DB, user, await body(request), new Date()));
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
      ? json({ history: await readHistory(env.DB, user, gameReadMatch[1], now) })
      : json({ game: await readGame(env.DB, user, gameReadMatch[1], now) });
  }
  const gameMatch = /^\/api\/games\/([^/]+)\/([^/]+)$/.exec(url.pathname);
  if (gameMatch && isGameId(gameMatch[1]!)) return mutateGame(request, env, user, gameMatch[1]!, gameMatch[2]!, now);
  throw new HttpError(404, 'NOT_FOUND', '요청한 기능을 찾을 수 없어요.');
}
export default {
  /** One Cron every 10 minutes: daily housekeeping at 00:00 KST, and the stock
   * market's ticks while it is open (reads also catch up if a run is missed). */
  scheduled(event: ScheduledController, env: Env, context: ExecutionContext) {
    const at = new Date(event.scheduledTime);
    if (kstTime(at) < '00:10:00') context.waitUntil(maintainDatabase(env.DB, at));
    if (FEATURES.stock && env.STOCK_SEED_SECRET && stockCronDue(at.getTime())) {
      context.waitUntil(advanceStocks(env.DB, env.STOCK_SEED_SECRET, at.getTime()).then(() => undefined, error => {
        console.error('Stock tick failed', error instanceof Error ? error.name : 'UnknownError');
      }));
    }
  },
  async fetch(request: Request, env: Env): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (path !== '/api' && !path.startsWith('/api/')) return env.ASSETS.fetch(request);
    try { return await api(request, env); }
    catch (error) {
      if (error instanceof HttpError || error instanceof RankingError || error instanceof AdminSettingsError || error instanceof ShopError || error instanceof CatchmindError || error instanceof ClawError || error instanceof LaunchGiftError || error instanceof ProfileError || error instanceof PhotoError || error instanceof LuckPhotoError || error instanceof StockError) return json({ error: { code: error.code, message: error.message } }, error.status, error.status === 429 ? { 'Retry-After': '900' } : undefined);
      console.error('API request failed', error instanceof Error ? error.name : 'UnknownError');
      return json({ error: { code: 'INTERNAL_ERROR', message: '잠시 문제가 생겼어요. 다시 시도해 주세요.' } }, 500);
    }
  },
} satisfies ExportedHandler<Env>;
