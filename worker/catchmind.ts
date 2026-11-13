import { CATCHMIND_RULES, PLAY_RULES, playClosed, scoreCounts } from '../shared/balance';
import { catchmindKey, catchmindWordProblem, cleanCatchmindWord } from '../shared/catchmind';
import { defaultCharacter, type ArtKey } from '../shared/characters';
import type { CatchmindAction, CatchmindGalleryResponse, CatchmindPlayer, CatchmindPollResponse, CatchmindResponse, CatchmindState, CatchmindSummary } from '../shared/types';
import { hashToken } from './crypto';
import { kstDate, kstTimestamp, weekStart } from './rules';

interface Actor { id: string; role: 'player' | 'admin' }
interface RoundRow {
  id: string; number: number; drawer_id: string; word: string; normalized_word: string;
  status: 'draft' | 'open' | 'ended'; has_image: number; round_date: string | null; published_at: string | null; ended_at: string | null;
  wrong_count: number; winner_id: string | null; end_reason: 'correct' | 'misses' | 'manual' | null;
}
interface TurnRow { drawer_id: string | null; round_id: string | null; version: number }
interface RequestRow { id: string; action: string; payload_hash: string; result_round_id: string }
export class CatchmindError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); }
}
const normalize = catchmindKey;
const nextPlayerSql = (drawer: string) => `COALESCE(
  (SELECT id FROM users WHERE active = 1 AND role = 'player'
    AND username > (SELECT username FROM users WHERE id = ${drawer}) ORDER BY username LIMIT 1),
  (SELECT id FROM users WHERE active = 1 AND role = 'player' ORDER BY username LIMIT 1))`;
function invalidImage(): never { throw new CatchmindError(400, 'INVALID_IMAGE', '정사각형 PNG 또는 WebP 그림을 올려 주세요.'); }

// Reuse the PNG polynomial table across requests; avoid eight bit steps per byte.
const CRC32_TABLE = Uint32Array.from({ length: 256 }, (_, value) => {
  let crc = value;
  for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  return crc >>> 0;
});
function crc32(bytes: Uint8Array, start: number, end: number): number {
  let crc = 0xffffffff;
  for (let index = start; index < end; index++) crc = (crc >>> 8) ^ CRC32_TABLE[(crc ^ bytes[index]!) & 0xff]!;
  return (crc ^ 0xffffffff) >>> 0;
}
function pngDimensions(bytes: Uint8Array): [number, number] {
  if (bytes.length < 45 || [137, 80, 78, 71, 13, 10, 26, 10].some((value, index) => bytes[index] !== value)) return invalidImage();
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 8; let width = 0; let height = 0; let imageData = 0; let ended = false; let palette = false; let color = -1;
  while (offset + 12 <= bytes.length) {
    const length = view.getUint32(offset); const end = offset + 12 + length;
    if (end > bytes.length) return invalidImage();
    const type = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8));
    if (!/^[A-Za-z]{4}$/.test(type) || crc32(bytes, offset + 4, offset + 8 + length) !== view.getUint32(offset + 8 + length)) return invalidImage();
    if (offset === 8 && (type !== 'IHDR' || length !== 13)) return invalidImage();
    if (type === 'IHDR') {
      if (offset !== 8 || length !== 13) return invalidImage();
      width = view.getUint32(offset + 8); height = view.getUint32(offset + 12);
      const depth = bytes[offset + 16]!; color = bytes[offset + 17]!;
      const depths: Record<number, readonly number[]> = { 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] };
      if (!depths[color]?.includes(depth) || bytes[offset + 18] !== 0 || bytes[offset + 19] !== 0 || bytes[offset + 20]! > 1) return invalidImage();
    } else if (type === 'PLTE') {
      if (imageData || length === 0 || length % 3 !== 0 || length > 768) return invalidImage();
      palette = true;
    } else if (type === 'IDAT') imageData += length;
    else if (type === 'IEND') {
      if (length !== 0 || imageData === 0 || end !== bytes.length) return invalidImage();
      ended = true;
    } else if (type[0] === type[0]!.toUpperCase()) return invalidImage();
    offset = end;
  }
  if (!ended || offset !== bytes.length || (color === 3 && !palette) || width > 0x7fffffff || height > 0x7fffffff) return invalidImage();
  return [width, height];
}
function webpDimensions(bytes: Uint8Array): [number, number] {
  const text = (offset: number, length: number) => String.fromCharCode(...bytes.subarray(offset, offset + length));
  if (bytes.length < 26 || text(0, 4) !== 'RIFF' || text(8, 4) !== 'WEBP') return invalidImage();
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(4, true) + 8 !== bytes.length) return invalidImage();
  let offset = 12; let frame: [number, number] | null = null; let extended: [number, number] | null = null;
  const uint24 = (at: number) => bytes[at]! + (bytes[at + 1]! << 8) + (bytes[at + 2]! << 16);
  while (offset + 8 <= bytes.length) {
    const type = text(offset, 4); const size = view.getUint32(offset + 4, true); const start = offset + 8; const end = start + size + (size % 2);
    if (end > bytes.length) return invalidImage();
    if (type === 'VP8X') {
      if (offset !== 12 || extended || size !== 10 || (bytes[start]! & 2)) return invalidImage();
      extended = [1 + uint24(start + 4), 1 + uint24(start + 7)];
    } else if (type === 'VP8 ') {
      if (frame || size < 10 || (bytes[start]! & 1) || text(start + 3, 3) !== '\x9d\x01\x2a') return invalidImage();
      frame = [view.getUint16(start + 6, true) & 0x3fff, view.getUint16(start + 8, true) & 0x3fff];
    } else if (type === 'VP8L') {
      if (frame || size < 5 || bytes[start] !== 0x2f) return invalidImage();
      const bits = view.getUint32(start + 1, true);
      if ((bits >>> 29) !== 0) return invalidImage();
      frame = [1 + (bits & 0x3fff), 1 + ((bits >>> 14) & 0x3fff)];
    } else if (type === 'ANIM' || type === 'ANMF') return invalidImage();
    offset = end;
  }
  if (offset !== bytes.length || !frame || (extended && (extended[0] !== frame[0] || extended[1] !== frame[1]))) return invalidImage();
  return frame;
}
export function validateDrawing(value: unknown): string {
  if (typeof value !== 'string') return invalidImage();
  if (value.length > Math.ceil(CATCHMIND_RULES.maxImageBytes / 3) * 4 + 23) throw new CatchmindError(413, 'IMAGE_TOO_LARGE', '그림 파일이 너무 커요. 크기를 줄여 다시 올려 주세요.');
  const match = /^data:image\/(png|webp);base64,([A-Za-z0-9+/]+={0,2})$/.exec(value);
  if (!match || match[2]!.length % 4 !== 0) return invalidImage();
  let raw: string;
  try { raw = atob(match[2]!); } catch { return invalidImage(); }
  if (raw.length > CATCHMIND_RULES.maxImageBytes) throw new CatchmindError(413, 'IMAGE_TOO_LARGE', '그림 파일이 너무 커요. 크기를 줄여 다시 올려 주세요.');
  if (btoa(raw) !== match[2]) return invalidImage();
  // atob returns one byte per code unit; avoid a callback/iterator for every byte.
  const bytes = new Uint8Array(raw.length);
  for (let index = 0; index < raw.length; index++) bytes[index] = raw.charCodeAt(index);
  const [width, height] = match[1] === 'png' ? pngDimensions(bytes) : webpDimensions(bytes);
  if (!width || width !== height) return invalidImage();
  return value;
}

/** Everyone named by `ids`, in one query however many there are. */
async function players(db: D1Database, ids: Iterable<string | null | undefined>): Promise<Map<string, CatchmindPlayer>> {
  const unique = [...new Set([...ids].filter((id): id is string => Boolean(id)))];
  if (!unique.length) return new Map();
  const { results } = await db.prepare(`SELECT id, username, display_name, character, CASE WHEN EXISTS (SELECT 1 FROM user_photos WHERE user_id = users.id) THEN photo_version ELSE NULL END AS photo_version FROM users WHERE id IN (${unique.map(() => '?').join(',')})`).bind(...unique)
    .all<{ id: string; username: string; display_name: string; character: ArtKey | null; photo_version: number | null }>();
  return new Map(results.map(row => [row.id, { id: row.id, username: row.username, displayName: row.display_name, photoVersion: row.photo_version, character: row.character ?? defaultCharacter(row.username) }]));
}
async function repairTurn(db: D1Database): Promise<void> {
  // Read paths only write for a stopped/missing current drawer. The condition
  // is rechecked in SQL so an older read cannot overwrite a newly started turn.
  await db.prepare(`UPDATE catchmind_turn SET drawer_id = ${nextPlayerSql('COALESCE(catchmind_turn.drawer_id, (SELECT drawer_id FROM catchmind_rounds WHERE id = catchmind_turn.round_id))')},
      version = version + 1
    WHERE id = 1 AND round_id IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM users WHERE id = catchmind_turn.drawer_id AND active = 1 AND role = 'player')
      AND EXISTS (SELECT 1 FROM users WHERE active = 1 AND role = 'player')`).run();
}
async function board(db: D1Database): Promise<{ turn: TurnRow; round: (RoundRow & { drawer_active: number; successor_id: string | null }) | null }> {
  // Polling and mutations need metadata, never the stored base64 image body.
  const row = await db.prepare(`SELECT r.id, r.number, r.drawer_id, r.word, r.normalized_word,
    r.status, r.image IS NOT NULL AS has_image, r.round_date, r.published_at, r.ended_at, r.wrong_count, r.winner_id, r.end_reason,
    t.drawer_id AS next_drawer_id, t.round_id AS current_round_id, t.version,
    EXISTS (SELECT 1 FROM users WHERE id = t.drawer_id AND active = 1 AND role = 'player') AS turn_active,
    EXISTS (SELECT 1 FROM users WHERE id = r.drawer_id AND active = 1 AND role = 'player') AS drawer_active,
    ${nextPlayerSql('r.drawer_id')} AS successor_id
    FROM catchmind_turn t LEFT JOIN catchmind_rounds r ON r.id = t.round_id WHERE t.id = 1`)
    .first<RoundRow & { next_drawer_id: string | null; current_round_id: string | null; version: number; turn_active: number; drawer_active: number; successor_id: string | null }>();
  if (row?.current_round_id && !row.turn_active) {
    await repairTurn(db);
    // If nobody is active, there is no candidate and no write. Do not recurse.
    const repaired = await db.prepare('SELECT drawer_id, round_id, version FROM catchmind_turn WHERE id = 1').first<TurnRow>();
    return { turn: repaired!, round: row.id ? row : null };
  }
  return { turn: { drawer_id: row?.next_drawer_id ?? null, round_id: row?.current_round_id ?? null, version: row?.version ?? 0 }, round: row?.id ? row : null };
}
export async function readCatchmindGallery(db: D1Database, before = Number.MAX_SAFE_INTEGER, limit: number = CATCHMIND_RULES.galleryPageSize): Promise<CatchmindGalleryResponse> {
  // Seek pagination uses (status, number). Never select image or private prompt
  // history: thumbnails and the modal use the existing immutable image route.
  const { results } = await db.prepare(`SELECT id, number, drawer_id, word, winner_id, end_reason, ended_at
    FROM catchmind_rounds WHERE status = 'ended' AND number < ? ORDER BY number DESC LIMIT ?`)
    .bind(before, limit + 1).all<Pick<RoundRow, 'id' | 'number' | 'drawer_id' | 'word' | 'winner_id' | 'end_reason' | 'ended_at'>>();
  const page = results.slice(0, limit);
  const people = await players(db, page.flatMap(row => [row.drawer_id, row.winner_id]));
  return {
    rounds: page.map(row => ({ id: row.id, number: row.number, drawer: people.get(row.drawer_id)!, answer: row.word,
      winner: row.winner_id ? people.get(row.winner_id)! : null, endReason: row.end_reason!, endedAt: row.ended_at!,
      image: `/api/catchmind/rounds/${encodeURIComponent(row.id)}/image` })),
    nextBefore: results.length > limit ? page[page.length - 1]!.number : null,
  };
}
export async function readCatchmindImage(db: D1Database, user: Actor, roundId: string): Promise<Response> {
  const round = await db.prepare('SELECT status, drawer_id, image IS NOT NULL AS has_image FROM catchmind_rounds WHERE id = ?')
    .bind(roundId).first<Pick<RoundRow, 'status' | 'drawer_id' | 'has_image'>>();
  if (!round?.has_image) throw new CatchmindError(404, 'IMAGE_NOT_FOUND', '그림을 찾을 수 없어요.');
  if (round.status === 'draft' && (user.role !== 'player' || round.drawer_id !== user.id)) {
    throw new CatchmindError(403, 'IMAGE_PRIVATE', '아직 공개되지 않은 그림이에요.');
  }
  const row = await db.prepare('SELECT image FROM catchmind_rounds WHERE id = ?').bind(roundId).first<{ image: string | null }>();
  if (!row?.image) throw new CatchmindError(404, 'IMAGE_NOT_FOUND', '그림을 찾을 수 없어요.');
  // Publishing validates and writes the image once; there is no draft-image
  // save endpoint. Retain those exact bytes behind the immutable round URL.
  const match = /^data:image\/(png|webp);base64,([A-Za-z0-9+/]+={0,2})$/.exec(row.image);
  if (!match) throw new Error('Stored catchmind image has an invalid format');
  const bytes = Uint8Array.from(atob(match[2]!), character => character.charCodeAt(0));
  return new Response(bytes, { headers: {
    'Content-Type': `image/${match[1]}`,
    'Content-Length': String(bytes.byteLength),
    'Cache-Control': 'private, max-age=31536000, immutable',
    'Vary': 'Cookie',
    'X-Content-Type-Options': 'nosniff',
  } });
}
/** The winner's guess (the round's end) came before its publication day closed. */
const winnerScored = (round: Pick<RoundRow, 'winner_id' | 'round_date' | 'ended_at'>) =>
  Boolean(round.winner_id && round.round_date && round.ended_at && scoreCounts(round.round_date, Date.parse(round.ended_at)));
export async function readCatchmindSummary(db: D1Database): Promise<CatchmindSummary> {
  const row = await db.prepare(`SELECT r.id, r.status, r.drawer_id, r.wrong_count, r.winner_id, r.word, r.round_date, r.ended_at, t.drawer_id AS next_drawer_id
    FROM catchmind_turn t LEFT JOIN catchmind_rounds r ON r.id = t.round_id WHERE t.id = 1`)
    .first<Pick<RoundRow, 'id' | 'status' | 'drawer_id' | 'wrong_count' | 'winner_id' | 'word' | 'round_date' | 'ended_at'> & { next_drawer_id: string | null }>();
  const people = await players(db, [row?.drawer_id, row?.next_drawer_id, row?.winner_id]);
  const who = (id: string | null | undefined) => (id ? people.get(id) ?? null : null);
  const drawer = who(row?.drawer_id), turn = who(row?.next_drawer_id), winner = who(row?.winner_id);
  return { roundId: row?.id ?? null, status: row?.status ?? 'idle', drawer, turn, wrongCount: row?.wrong_count ?? 0, winner,
    winnerScored: row ? winnerScored(row) : false, answer: row?.status === 'ended' ? row.word : null };
}
async function readState(db: D1Database, user: Actor, now: Date): Promise<{ catchmind: CatchmindState; version: number }> {
  const { turn, round } = await board(db);
  const ids = [...new Set([round?.drawer_id, turn.drawer_id, round?.winner_id, round?.successor_id].filter((id): id is string => Boolean(id)))];
  const profiles = ids.length ? (await db.prepare(`SELECT id, username, display_name, character,
    CASE WHEN EXISTS (SELECT 1 FROM user_photos WHERE user_id = users.id) THEN photo_version ELSE NULL END AS photo_version
    FROM users WHERE id IN (${ids.map(() => '?').join(', ')})`).bind(...ids)
    .all<{ id: string; username: string; display_name: string; character: ArtKey | null; photo_version: number | null }>()).results : [];
  const people = new Map(profiles.map(row => [row.id, { id: row.id, username: row.username, displayName: row.display_name,
    photoVersion: row.photo_version, character: row.character ?? defaultCharacter(row.username) }]));
  const drawer = people.get(round?.drawer_id ?? '') ?? null;
  const next = people.get(turn.drawer_id ?? '') ?? null;
  const winner = people.get(round?.winner_id ?? '') ?? null;
  const skipTime = round?.status === 'ended' && round.ended_at ? Date.parse(round.ended_at) + CATCHMIND_RULES.skipAfterMs : NaN;
  const skipAvailableAt = Number.isFinite(skipTime) ? new Date(skipTime).toISOString() : null;
  const playing = user.role === 'player'; const author = playing && round?.drawer_id === user.id;
  const closed = playClosed(now.getTime());
  const guesses = round ? (await db.prepare(`SELECT g.id, g.answer, g.correct, g.created_at, u.id AS player_id, u.username, u.display_name, u.character, CASE WHEN EXISTS (SELECT 1 FROM user_photos WHERE user_id = u.id) THEN u.photo_version ELSE NULL END AS photo_version
    FROM catchmind_guesses g JOIN users u ON u.id = g.player_id WHERE g.round_id = ? ORDER BY g.sequence`)
    .bind(round.id).all<{ id: string; answer: string; correct: number; created_at: string; player_id: string; username: string; display_name: string; character: ArtKey | null; photo_version: number | null }>()).results : [];
  const letters = round ? Array.from(round.normalized_word) : [];
  return { version: turn.version, catchmind: {
    turn: next,
    nextDrawer: round?.status === 'ended' ? next : people.get(round?.successor_id ?? '') ?? null,
    canSkip: Boolean(playing && next && next.id !== user.id && now.getTime() >= skipTime), skipAvailableAt,
    previousRound: (await readCatchmindGallery(db, round?.number, 1)).rounds[0] ?? null,
    // A draft has no answer until the drawer publishes one (a draft left over
    // from the old prompt flow keeps its prompt, which prefills the drawer's input).
    round: round ? { id: round.id, number: round.number, status: round.status, drawer: drawer!, word: (author || round.status === 'ended') && round.word ? round.word : null,
      image: round.has_image && (round.status !== 'draft' || author) ? `/api/catchmind/rounds/${encodeURIComponent(round.id)}/image` : null,
      wrongCount: round.wrong_count,
      hint: round.wrong_count >= CATCHMIND_RULES.hintAfter ? { firstCharacter: letters[0]!, length: letters.length } : null,
      winner, winnerScored: winnerScored(round), endReason: round.end_reason, publishedAt: round.published_at, endedAt: round.ended_at,
      guesses: guesses.map(guess => ({ id: guess.id, answer: guess.answer, correct: Boolean(guess.correct), createdAt: guess.created_at,
        player: { id: guess.player_id, username: guess.username, displayName: guess.display_name, photoVersion: guess.photo_version, character: guess.character ?? defaultCharacter(guess.username) } })) } : null,
    canClaim: playing && !turn.drawer_id && !round,
    canPublish: Boolean(author && round?.status === 'draft' && !closed), canGuess: Boolean(playing && !author && round?.status === 'open' && !closed),
    canEnd: Boolean(author && round?.status === 'open'),
    canNext: Boolean(playing && turn.drawer_id === user.id && (round?.status === 'ended' || (round?.status === 'draft' && !round.drawer_active))),
  } };
}
async function priorRequest(db: D1Database, user: Actor, requestId: string, action: CatchmindAction, hash: string): Promise<RequestRow | null> {
  const previous = await db.prepare('SELECT id, action, payload_hash, result_round_id FROM catchmind_requests WHERE user_id = ? AND request_id = ?')
    .bind(user.id, requestId).first<RequestRow>();
  if (previous && (previous.action !== action || previous.payload_hash !== hash)) throw new CatchmindError(409, 'REQUEST_CONFLICT', '이미 다른 동작에 사용한 요청 번호예요.');
  return previous;
}
async function mutate(db: D1Database, user: Actor, action: CatchmindAction, input: Record<string, unknown>, now: Date): Promise<void> {
  if (input.expectedUserId !== undefined && input.expectedUserId !== user.id) {
    throw new CatchmindError(409, 'ACCOUNT_CHANGED', '로그인한 계정이 바뀌었어요. 화면을 새로고침해 주세요.');
  }
  if (user.role !== 'player') throw new CatchmindError(403, 'CANNOT_PLAY', '플레이어만 캐치마인드에 참여할 수 있어요.');
  if (typeof input.requestId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(input.requestId)) throw new CatchmindError(400, 'INVALID_REQUEST_ID', '요청 번호를 확인해 주세요.');
  if (action === 'claim' ? input.roundId !== null : typeof input.roundId !== 'string' || !input.roundId || input.roundId.length > 128) {
    throw new CatchmindError(400, 'INVALID_ROUND_ID', '판 번호를 확인해 주세요.');
  }
  if (action === 'skip' && (typeof input.expectedTurnId !== 'string' || !input.expectedTurnId || input.expectedTurnId.length > 128)) {
    throw new CatchmindError(400, 'INVALID_TURN', '넘길 차례를 확인해 주세요.');
  }
  let answer = ''; let image: string | undefined; let word = '';
  if (action === 'guess') {
    if (typeof input.answer !== 'string' || Array.from(input.answer).length > CATCHMIND_RULES.maxAnswerLength || !normalize(input.answer)) {
      throw new CatchmindError(400, 'INVALID_ANSWER', '정답을 짧은 글자로 입력해 주세요.');
    }
    answer = input.answer.trim();
  }
  if (action === 'publish') {
    const problem = typeof input.word === 'string' ? catchmindWordProblem(input.word) : '정답을 적어 주세요.';
    if (problem) throw new CatchmindError(400, 'INVALID_WORD', problem);
    word = cleanCatchmindWord(input.word as string);
    image = validateDrawing(input.image);
  }
  const payload = { roundId: input.roundId, ...(action === 'publish' ? { word } : {}),
    ...(image ? { image } : {}), ...(action === 'guess' ? { answer: normalize(answer) } : {}),
    ...(action === 'skip' ? { expectedTurnId: input.expectedTurnId } : {}) };
  const hash = await hashToken(JSON.stringify(payload));
  if (await priorRequest(db, user, input.requestId, action, hash)) return;
  // Drawing can wait, but publishing and guessing close with every game at 23:50.
  if ((action === 'publish' || action === 'guess') && playClosed(now.getTime())) throw new CatchmindError(409, 'PLAY_CLOSED', PLAY_RULES.closedMessage);
  const { turn, round } = await board(db);
  if (action !== 'claim' && (!round || round.id !== input.roundId)) throw new CatchmindError(409, 'ROUND_CHANGED', '새 판이 시작됐어요. 화면을 새로고침해 주세요.');
  if ((action === 'publish' || action === 'end') && round?.drawer_id !== user.id) throw new CatchmindError(403, 'NOT_DRAWER', '출제자만 할 수 있어요.');
  if (action === 'guess' && round?.drawer_id === user.id) throw new CatchmindError(403, 'DRAWER_CANNOT_GUESS', '출제자는 자기 그림을 맞힐 수 없어요.');
  if (action === 'guess' && round?.status !== 'open') throw new CatchmindError(409, 'ROUND_CHANGED', '맞히기가 끝났거나 아직 그림이 공개되지 않았어요.');
  if (action === 'next' && turn.drawer_id !== user.id) throw new CatchmindError(403, 'NOT_DRAWER', '다음 출제자만 새 판을 시작할 수 있어요.');
  if (action === 'skip' && (round?.status !== 'ended' || !round.ended_at || now.getTime() < Date.parse(round.ended_at) + CATCHMIND_RULES.skipAfterMs)) {
    throw new CatchmindError(409, 'SKIP_NOT_READY', '판이 끝난 뒤 10분이 지나면 차례를 넘길 수 있어요.');
  }
  const attempt = crypto.randomUUID();
  const resultRoundId = action === 'claim' || action === 'next' ? crypto.randomUUID() : round!.id;
  let guard: string; const guardValues: (string | number)[] = [];
  if (action === 'claim') guard = 't.drawer_id IS NULL AND t.round_id IS NULL';
  else {
    guard = 'r.id = ?'; guardValues.push(round!.id);
    if (action === 'next') {
      guard += ` AND t.drawer_id = u.id AND (r.status = 'ended' OR (r.status = 'draft'
        AND NOT EXISTS (SELECT 1 FROM users WHERE id = r.drawer_id AND active = 1 AND role = 'player')))`;
    }
    else if (action === 'skip') {
      guard += " AND r.status = 'ended' AND t.drawer_id = ? AND t.drawer_id != u.id AND unixepoch('now') * 1000 >= ROUND((julianday(r.ended_at) - 2440587.5) * 86400000) + ?";
      guardValues.push(String(input.expectedTurnId), CATCHMIND_RULES.skipAfterMs);
    }
    else if (action === 'publish') {
      const start = kstTimestamp(kstDate(now), '00:00:00');
      guard += " AND r.status = 'draft' AND r.drawer_id = u.id AND unixepoch('now') * 1000 >= ? AND unixepoch('now') * 1000 < ?";
      guardValues.push(start, start + 86_400_000);
    } else if (action === 'guess') guard += " AND r.status = 'open' AND r.drawer_id != u.id";
    else guard += " AND r.status = 'open' AND r.drawer_id = u.id";
  }
  const writes: D1PreparedStatement[] = [db.prepare(`INSERT OR IGNORE INTO catchmind_requests
    (id, user_id, request_id, action, round_id, result_round_id, payload_hash, created_at)
    SELECT ?, u.id, ?, ?, ?, ?, ?, ? FROM users u JOIN catchmind_turn t ON t.id = 1 LEFT JOIN catchmind_rounds r ON r.id = t.round_id
    WHERE u.id = ? AND u.active = 1 AND u.role = 'player' AND ${guard}`)
    .bind(attempt, input.requestId, action, action === 'claim' ? null : round!.id, resultRoundId, hash, now.toISOString(), user.id, ...guardValues)];
  if (action === 'claim' || action === 'next') {
    // The answer is written by the drawer at publish time; a draft has none.
    writes.push(db.prepare(`INSERT INTO catchmind_rounds (id, number, drawer_id, word, normalized_word, word_history, status, created_at)
      SELECT ?, COALESCE((SELECT MAX(number) FROM catchmind_rounds), 0) + 1, user_id, '', '', '[]', 'draft', created_at FROM catchmind_requests WHERE id = ?`)
      .bind(resultRoundId, attempt));
    writes.push(db.prepare(`UPDATE catchmind_turn SET drawer_id = ?, round_id = ? WHERE id = 1 AND EXISTS (SELECT 1 FROM catchmind_requests WHERE id = ?)`)
      .bind(user.id, resultRoundId, attempt));
  } else if (action === 'publish') {
    writes.push(db.prepare(`UPDATE catchmind_rounds SET status = 'open', word = ?, normalized_word = ?, word_history = ?, image = ?, round_date = ?, published_at = ?
      WHERE id = ? AND EXISTS (SELECT 1 FROM catchmind_requests WHERE id = ?)`)
      .bind(word, normalize(word), JSON.stringify([word]), image!, kstDate(now), now.toISOString(), round!.id, attempt));
  } else if (action === 'skip') {
    writes.push(db.prepare(`UPDATE catchmind_turn SET drawer_id = ${nextPlayerSql('catchmind_turn.drawer_id')}
      WHERE id = 1 AND EXISTS (SELECT 1 FROM catchmind_requests WHERE id = ?)`)
      .bind(attempt));
    // Reads the drawer this batch just set, so the new drawer hears about a
    // turn they did not ask for. One row per skip request.
    writes.push(db.prepare(`INSERT OR IGNORE INTO notifications (kind, audience, user_id, actor_id, payload_json, created_at, reference)
      SELECT 'game', 'user', t.drawer_id, t.drawer_id, ?, ?, 'notification:catchmind:turn:' || ?
      FROM catchmind_turn t WHERE t.id = 1 AND t.drawer_id IS NOT NULL
        AND EXISTS (SELECT 1 FROM catchmind_requests WHERE id = ?)`)
      .bind(JSON.stringify({ kind: 'turn', game: 'catchmind' }), now.toISOString(), attempt, attempt));
  } else if (action === 'end') {
    writes.push(db.prepare(`UPDATE catchmind_rounds SET status = 'ended', end_reason = 'manual', ended_at = ?
      WHERE id = ? AND EXISTS (SELECT 1 FROM catchmind_requests WHERE id = ?)`)
      .bind(now.toISOString(), round!.id, attempt));
  } else {
    writes.push(db.prepare(`INSERT INTO catchmind_guesses (id, round_id, player_id, answer, normalized_answer, correct, created_at)
      SELECT q.id, r.id, q.user_id, ?, ?, r.normalized_word = ?, q.created_at
      FROM catchmind_requests q JOIN catchmind_rounds r ON r.id = q.round_id WHERE q.id = ?`)
      .bind(answer, normalize(answer), normalize(answer), attempt));
    writes.push(db.prepare(`UPDATE catchmind_rounds SET
      status = CASE WHEN (SELECT correct FROM catchmind_guesses WHERE id = ?) = 1 OR wrong_count + 1 >= ? THEN 'ended' ELSE 'open' END,
      end_reason = CASE WHEN (SELECT correct FROM catchmind_guesses WHERE id = ?) = 1 THEN 'correct' WHEN wrong_count + 1 >= ? THEN 'misses' ELSE NULL END,
      ended_at = CASE WHEN (SELECT correct FROM catchmind_guesses WHERE id = ?) = 1 OR wrong_count + 1 >= ? THEN ? ELSE NULL END,
      winner_id = CASE WHEN (SELECT correct FROM catchmind_guesses WHERE id = ?) = 1 THEN ? ELSE NULL END,
      wrong_count = wrong_count + CASE WHEN (SELECT correct FROM catchmind_guesses WHERE id = ?) = 1 THEN 0 ELSE 1 END
      WHERE id = ? AND EXISTS (SELECT 1 FROM catchmind_requests WHERE id = ?)`)
      .bind(attempt, CATCHMIND_RULES.endAfter, attempt, CATCHMIND_RULES.endAfter, attempt, CATCHMIND_RULES.endAfter, now.toISOString(), attempt, user.id, attempt, round!.id, attempt));
    // A round published on an earlier day can still be solved, and the winner
    // still takes the gold, but its score only counts before its day closed.
    const counted = scoreCounts(round!.round_date!, now.getTime());
    for (const [currency, amount] of [['gold', CATCHMIND_RULES.gold], ...(counted ? [['score', CATCHMIND_RULES.score]] as const : [])] as const) {
      writes.push(db.prepare(`INSERT OR IGNORE INTO ledger (id, user_id, currency, amount, reason, reference, created_at, week_start)
        SELECT ?, g.player_id, ?, ?, '캐치마인드 정답', ?, g.created_at, ? FROM catchmind_guesses g
        WHERE g.id = ? AND g.correct = 1`)
        .bind(crypto.randomUUID(), currency, amount, `catchmind:${currency}:${round!.id}`, currency === 'score' ? weekStart(new Date(kstTimestamp(round!.round_date!, '00:00:00'))) : null, attempt));
    }
  }
  await db.batch(writes);
  if (!await priorRequest(db, user, input.requestId, action, hash)) {
    const active = await db.prepare("SELECT 1 FROM users WHERE id = ? AND role = 'player' AND active = 1").bind(user.id).first();
    if (!active) throw new CatchmindError(403, 'CANNOT_PLAY', '플레이어만 캐치마인드에 참여할 수 있어요.');
    throw new CatchmindError(409, 'ROUND_CHANGED', '판이나 제시어 상태가 바뀌었어요. 새로고침하고 다시 시도해 주세요.');
  }
}
export function catchmindRoute(db: D1Database, user: Actor, action: string | undefined, method: string, input: Record<string, unknown> | undefined, now: Date): Promise<CatchmindResponse>;
export function catchmindRoute(db: D1Database, user: Actor, action: string | undefined, method: string, input: Record<string, unknown> | undefined, now: Date, since: number | undefined): Promise<CatchmindPollResponse>;
export async function catchmindRoute(db: D1Database, user: Actor, action: string | undefined, method: string, input: Record<string, unknown> | undefined, now: Date, since?: number): Promise<CatchmindPollResponse> {
  if (!action && method === 'GET') {
    if (since !== undefined) {
      // Authentication is the only other D1 query for an unchanged poll. Roster
      // metadata triggers invalidate this token before inactive-turn repair.
      const snapshot = await db.prepare(`SELECT t.version, t.round_id,
          EXISTS (SELECT 1 FROM users WHERE id = t.drawer_id AND active = 1 AND role = 'player') AS turn_active
        FROM catchmind_turn t WHERE t.id = 1`).first<{ version: number; round_id: string | null; turn_active: number }>();
      if (snapshot && snapshot.version === since && (!snapshot.round_id || snapshot.turn_active)) {
        return { unchanged: true, version: snapshot.version, viewerId: user.id, serverTime: now.toISOString() };
      }
    }
    return { ...await readState(db, user, now), viewerId: user.id, serverTime: now.toISOString() };
  }
  const actions: CatchmindAction[] = ['claim', 'publish', 'guess', 'end', 'next', 'skip'];
  if (!actions.includes(action as CatchmindAction)) throw new CatchmindError(404, 'NOT_FOUND', '요청한 캐치마인드 기능이 없어요.');
  if (method !== 'POST') throw new CatchmindError(405, 'METHOD_NOT_ALLOWED', '지원하지 않는 요청이에요.');
  await mutate(db, user, action as CatchmindAction, input!, now);
  return { ...await readState(db, user, now), viewerId: user.id, serverTime: now.toISOString() };
}
