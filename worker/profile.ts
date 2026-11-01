import { normalizeNickname, PROFILE_PHOTO } from '../shared/profile';
import type { ProfileMetadata } from '../shared/types';
import { photoResponse, photoVersion, validatePhoto, type PhotoMime, type StoredPhotoData } from './photos';

interface Actor { id: string }
export class ProfileError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); }
}
async function metadata(db: D1Database, userId: string): Promise<ProfileMetadata> {
  const row = await db.prepare(`SELECT display_name AS displayName,
    CASE WHEN EXISTS (SELECT 1 FROM user_photos WHERE user_id = users.id) THEN photo_version ELSE NULL END AS photoVersion
    FROM users WHERE id = ? AND active = 1`).bind(userId).first<ProfileMetadata>();
  if (!row) throw new ProfileError(403, 'PROFILE_UNAVAILABLE', '활성 계정에서만 프로필을 바꿀 수 있어요.');
  return row;
}

export async function updateProfile(db: D1Database, user: Actor, input: Record<string, unknown>): Promise<ProfileMetadata> {
  const nickname = normalizeNickname(input.displayName);
  if ('error' in nickname) throw new ProfileError(400, 'INVALID_NICKNAME', nickname.error);
  const changed = await db.prepare(`UPDATE users SET display_name = ? WHERE id = ? AND active = 1
    AND NOT EXISTS (SELECT 1 FROM users other WHERE other.active = 1 AND other.id != ? AND other.display_name = ? COLLATE NOCASE)`)
    .bind(nickname.value, user.id, user.id, nickname.value).run();
  const current = await metadata(db, user.id);
  if (!changed.meta.changes) throw new ProfileError(409, 'NICKNAME_TAKEN', '이미 사용 중인 닉네임이에요. 다른 이름을 골라 주세요.');
  return current;
}

export async function uploadProfilePhoto(db: D1Database, user: Actor, input: Record<string, unknown>, now = new Date()): Promise<ProfileMetadata> {
  const photo = validatePhoto(input.photo, { maxBytes: PROFILE_PHOTO.maxBytes, maxSide: PROFILE_PHOTO.side, exactSide: PROFILE_PHOTO.side });
  const result = await db.batch([
    db.prepare('UPDATE users SET photo_version = COALESCE(photo_version, 0) + 1 WHERE id = ? AND active = 1').bind(user.id),
    db.prepare(`INSERT INTO user_photos (user_id, mime, data, updated_at)
      SELECT id, ?, ?, ? FROM users WHERE id = ? AND active = 1 AND changes() = 1
      ON CONFLICT(user_id) DO UPDATE SET mime = excluded.mime, data = excluded.data, updated_at = excluded.updated_at`)
      .bind(photo.mime, photo.data.buffer, now.toISOString(), user.id),
  ]);
  if (!result[0]!.meta.changes) throw new ProfileError(403, 'PROFILE_UNAVAILABLE', '활성 계정에서만 사진을 바꿀 수 있어요.');
  return metadata(db, user.id);
}

export async function deleteProfilePhoto(db: D1Database, user: Actor, _now = new Date()): Promise<ProfileMetadata> {
  // Keep advancing the counter after deletion: a later upload must never reuse
  // an immutable URL that a browser may still have in its private cache.
  const result = await db.batch([
    db.prepare('UPDATE users SET photo_version = COALESCE(photo_version, 0) + 1 WHERE id = ? AND active = 1').bind(user.id),
    db.prepare(`DELETE FROM user_photos WHERE user_id = ? AND changes() = 1
      AND EXISTS (SELECT 1 FROM users WHERE id = ? AND active = 1)`).bind(user.id, user.id),
  ]);
  if (!result[0]!.meta.changes) throw new ProfileError(403, 'PROFILE_UNAVAILABLE', '활성 계정에서만 사진을 지울 수 있어요.');
  return metadata(db, user.id);
}

export async function readProfilePhoto(db: D1Database, user: Actor, targetUserId: string, requestedVersion: string | null): Promise<Response> {
  const active = await db.prepare('SELECT 1 FROM users WHERE id = ? AND active = 1').bind(user.id).first();
  if (!active) throw new ProfileError(401, 'UNAUTHENTICATED', '다시 로그인해 주세요.');
  const version = photoVersion(requestedVersion);
  // Read version and bytes together. Replacement between a separate metadata
  // lookup and body lookup must not put new bytes behind an old immutable URL.
  const row = await db.prepare(`SELECT p.mime, p.data FROM user_photos p JOIN users u ON u.id = p.user_id
    WHERE p.user_id = ? AND u.photo_version = ?`).bind(targetUserId, version).first<{ mime: PhotoMime; data: StoredPhotoData }>();
  if (!row) throw new ProfileError(404, 'PHOTO_NOT_FOUND', '프로필 사진을 찾을 수 없어요.');
  return photoResponse(row.data, row.mime);
}
