import { GAME_RULES } from '../shared/balance';
import { LUCK_PHOTO } from '../shared/profile';
import type { LuckPhotoResponse, PhotoMetadata } from '../shared/types';
import { photoResponse, photoVersion, validatePhoto, type PhotoMime } from './photos';
import { kstDate, kstTimestamp } from './rules';

interface Actor { id: string; username: string; role: 'player' | 'admin' }
interface PhotoRow { mime: PhotoMime; data: ArrayBuffer | Uint8Array | number[]; version: number }
export class LuckPhotoError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); }
}
const isAuthor = (user: Actor) => user.role === 'player' && user.username === GAME_RULES.luck.author;
const validDate = (value: unknown): value is string => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
  && Number.isFinite(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
export const luckPhotoUrl = (date: string, version: number) => `/api/games/luck/rounds/${date}/photo?v=${version}`;

/** Polling and history responses contain only the immutable image address. */
export async function getLuckPhotoMetadata(db: D1Database, user: Actor, date: string, revealed: boolean): Promise<PhotoMetadata | null> {
  if (!isAuthor(user) && !revealed) return null;
  const row = await db.prepare('SELECT version FROM luck_photos WHERE round_date = ?').bind(date).first<{ version: number }>();
  return row ? { url: luckPhotoUrl(date, row.version), version: row.version } : null;
}

export async function uploadLuckPhoto(db: D1Database, user: Actor, input: Record<string, unknown>, now = new Date()): Promise<LuckPhotoResponse> {
  if (!isAuthor(user)) throw new LuckPhotoError(403, 'NOT_AUTHOR', '출제자만 증거 사진을 올릴 수 있어요.');
  if (!validDate(input.roundDate)) throw new LuckPhotoError(400, 'INVALID_DATE', '사진을 올릴 날짜를 확인해 주세요.');
  if (input.roundDate !== kstDate(now)) throw new LuckPhotoError(409, 'STALE_ROUND', '오늘의 행운 점수 화면에서 다시 올려 주세요.');
  const image = validatePhoto(input.image, LUCK_PHOTO);
  const start = kstTimestamp(input.roundDate, '00:00:00');
  // The publication and date checks belong to the same write as the replacement.
  // In particular, an automatic reveal cannot race a pre-checked photo upload.
  const row = await db.prepare(`INSERT INTO luck_photos (round_date, mime, data, version, updated_at)
    SELECT ?, ?, ?, 1, ? FROM users u
    WHERE u.id = ? AND u.username = ? AND u.role = 'player' AND u.active = 1
      AND unixepoch('now') * 1000 >= ? AND unixepoch('now') * 1000 < ?
      AND NOT EXISTS (SELECT 1 FROM game_rounds r WHERE r.game_id = 'luck' AND r.round_date = ?
        AND (r.revealed_at IS NOT NULL OR (r.answer IS NOT NULL AND r.reveal_at IS NOT NULL AND r.reveal_at <= unixepoch('now') * 1000)))
    ON CONFLICT(round_date) DO UPDATE SET mime = excluded.mime, data = excluded.data,
      version = luck_photos.version + 1, updated_at = excluded.updated_at
    RETURNING version`)
    .bind(input.roundDate, image.mime, image.data, now.toISOString(), user.id, GAME_RULES.luck.author,
      start, start + 86_400_000, input.roundDate).first<{ version: number }>();
  if (!row) {
    const active = await db.prepare("SELECT 1 FROM users WHERE id = ? AND username = ? AND role = 'player' AND active = 1")
      .bind(user.id, GAME_RULES.luck.author).first();
    if (!active) throw new LuckPhotoError(403, 'NOT_AUTHOR', '활성 출제자만 증거 사진을 올릴 수 있어요.');
    throw new LuckPhotoError(409, 'PHOTO_LOCKED', '날짜가 바뀌었거나 정답이 공개되어 사진을 바꿀 수 없어요.');
  }
  return { photo: { url: luckPhotoUrl(input.roundDate, row.version), version: row.version }, serverTime: now.toISOString() };
}

/** Caller authenticates before invoking this function, even for cached image URLs. */
export async function readLuckPhoto(db: D1Database, user: Actor, date: string, version: unknown, _now = new Date()): Promise<Response> {
  if (!validDate(date)) throw new LuckPhotoError(404, 'PHOTO_NOT_FOUND', '증거 사진을 찾을 수 없어요.');
  const number = photoVersion(typeof version === 'string' ? version : typeof version === 'number' ? String(version) : null);
  // Check the access condition using metadata first; denied requests never load the BLOB.
  const access = await db.prepare(`SELECT p.version,
      r.revealed_at IS NOT NULL OR (r.answer IS NOT NULL AND r.reveal_at IS NOT NULL AND r.reveal_at <= unixepoch('now') * 1000) AS revealed
    FROM luck_photos p LEFT JOIN game_rounds r ON r.game_id = 'luck' AND r.round_date = p.round_date
    WHERE p.round_date = ?`).bind(date).first<{ version: number; revealed: number | null }>();
  if (!access || access.version !== number) throw new LuckPhotoError(404, 'PHOTO_NOT_FOUND', '증거 사진을 찾을 수 없어요.');
  if (!isAuthor(user) && !access.revealed) throw new LuckPhotoError(403, 'PHOTO_HIDDEN', '정답이 공개된 뒤 증거 사진을 볼 수 있어요.');
  const row = await db.prepare('SELECT mime, data, version FROM luck_photos WHERE round_date = ? AND version = ?')
    .bind(date, number).first<PhotoRow>();
  if (!row) throw new LuckPhotoError(404, 'PHOTO_NOT_FOUND', '사진이 바뀌었어요. 화면을 새로고침해 주세요.');
  const bytes = row.data instanceof ArrayBuffer ? row.data : Uint8Array.from(row.data).buffer;
  return photoResponse(bytes, row.mime);
}
