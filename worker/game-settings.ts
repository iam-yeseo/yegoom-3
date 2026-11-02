import { defaultPredictionRules, validatePredictionRules } from '../shared/game-settings';
import type { AdminChange, AdminGameSettings, PredictionRules } from '../shared/admin';
import type { GameId } from '../shared/types';
import { GAME_IDS, kstDate, kstTimestamp } from './rules';

interface AdminActor { id: string; role: 'player' | 'admin' }
export class AdminSettingsError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); }
}
export const effectiveRulesSql = `COALESCE((SELECT settings_json FROM game_settings
  WHERE game_id = ? AND effective_from <= ? ORDER BY effective_from DESC LIMIT 1), ?)`;
export const rulesBindings = (id: GameId, date: string) => [id, date, JSON.stringify(defaultPredictionRules(id))] as const;

/** The (game_id,effective_from) PK seeks directly to at most one applicable row. */
export async function readEffectiveRules(db: D1Database, id: GameId, date: string): Promise<PredictionRules> {
  const row = await db.prepare(`SELECT settings_json FROM game_settings
    WHERE game_id = ? AND effective_from <= ? ORDER BY effective_from DESC LIMIT 1`)
    .bind(id, date).first<{ settings_json: string }>();
  return row ? JSON.parse(row.settings_json) as PredictionRules : defaultPredictionRules(id);
}
export async function readGameRules(db: D1Database, id: GameId, date: string, snapshot?: string | null): Promise<PredictionRules> {
  return snapshot ? JSON.parse(snapshot) as PredictionRules : readEffectiveRules(db, id, date);
}
export async function rulesForRound(db: D1Database, id: GameId, date: string): Promise<PredictionRules> {
  const row = await db.prepare('SELECT settings_json FROM game_rounds WHERE game_id = ? AND round_date = ?').bind(id, date).first<{ settings_json: string | null }>();
  return readGameRules(db, id, date, row?.settings_json);
}

/** These statements execute in the SAME batch as the first prediction/answer.
 * SQL reads current settings, so a concurrent today change cannot use stale JS
 * rules or leave an OFF round behind. Existing legacy rounds gain a snapshot. */
export function roundSnapshotWrites(db: D1Database, id: GameId, date: string, now: Date, prediction = false): D1PreparedStatement[] {
  const start = kstTimestamp(date, '00:00:00');
  const deadline = prediction ? `AND unixepoch('now') * 1000 < unixepoch(? || 'T' || json_extract(settings, '$.deadline') || '+09:00') * 1000` : '';
  return [
    db.prepare(`INSERT OR IGNORE INTO game_rounds (game_id, round_date, updated_at, settings_json)
      SELECT ?, ?, ?, settings FROM (SELECT ${effectiveRulesSql} AS settings)
      WHERE json_extract(settings, '$.enabled') = 1
        AND unixepoch('now') * 1000 >= ? AND unixepoch('now') * 1000 < ? ${deadline}`)
      .bind(id, date, now.getTime(), ...rulesBindings(id, date), start, start + 86_400_000, ...(prediction ? [date] : [])),
    db.prepare(`UPDATE game_rounds SET settings_json = ${effectiveRulesSql}
      WHERE game_id = ? AND round_date = ? AND settings_json IS NULL
        AND unixepoch('now') * 1000 >= ? AND unixepoch('now') * 1000 < ?`)
      .bind(...rulesBindings(id, date), id, date, start, start + 86_400_000),
  ];
}
export async function readAdminGames(db: D1Database, now: Date): Promise<AdminGameSettings[]> {
  const today = kstDate(now); const tomorrow = kstDate(new Date(now.getTime() + 86_400_000));
  return Promise.all(GAME_IDS.map(async id => {
    const [round, scheduled, predicted] = await Promise.all([
      db.prepare('SELECT answer, settings_json FROM game_rounds WHERE game_id = ? AND round_date = ?').bind(id, today).first<{ answer: string | null; settings_json: string | null }>(),
      db.prepare('SELECT settings_json FROM game_settings WHERE game_id = ? AND effective_from = ?').bind(id, tomorrow).first<{ settings_json: string }>(),
      db.prepare('SELECT 1 FROM predictions WHERE game_id = ? AND round_date = ? LIMIT 1').bind(id, today).first(),
    ]);
    const canApplyToday = !predicted && round?.answer == null;
    return { id, rules: await readGameRules(db, id, today, round?.settings_json),
      scheduledRules: scheduled ? JSON.parse(scheduled.settings_json) as PredictionRules : null,
      canApplyToday, activityReason: canApplyToday ? null : '오늘 예측이나 정답이 있어 내일부터 적용할 수 있어요.' };
  }));
}
export async function readAdminChanges(db: D1Database): Promise<AdminChange[]> {
  const rows = (await db.prepare(`SELECT c.id, c.admin_id AS adminId, u.display_name AS adminName,
      c.target, c.before_json, c.after_json, c.effective_from AS effectiveFrom, c.created_at AS createdAt
    FROM (SELECT *, rowid AS change_order FROM admin_changes ORDER BY created_at DESC, rowid DESC LIMIT 20) c
    JOIN users u ON u.id = c.admin_id ORDER BY c.created_at DESC, c.change_order DESC`)
    .all<Omit<AdminChange, 'before' | 'after'> & { before_json: string; after_json: string }>()).results;
  return rows.map(({ before_json, after_json, ...row }) => ({ ...row, before: JSON.parse(before_json), after: JSON.parse(after_json) }));
}
export async function saveGameSettings(db: D1Database, admin: AdminActor, id: GameId, input: Record<string, unknown>, now: Date): Promise<void> {
  if (admin.role !== 'admin') throw new AdminSettingsError(403, 'ADMIN_ONLY', '운영자만 설정을 바꿀 수 있어요.');
  const validation = validatePredictionRules(id, input.rules);
  if ('error' in validation) throw new AdminSettingsError(400, 'INVALID_GAME_SETTINGS', validation.error);
  const today = kstDate(now); const tomorrow = kstDate(new Date(now.getTime() + 86_400_000));
  const effectiveFrom = input.effectiveFrom === undefined ? tomorrow : input.effectiveFrom;
  if (effectiveFrom !== today && effectiveFrom !== tomorrow) throw new AdminSettingsError(400, 'INVALID_EFFECTIVE_DATE', '오늘 또는 내일부터 적용할 수 있어요.');
  const start = kstTimestamp(today, '00:00:00'); const changeId = crypto.randomUUID();
  const after = JSON.stringify(validation.rules);
  // The audit insert owns the conditional write. Settings and any empty current
  // round snapshot follow only its new ID; a concurrent first play wins OR this
  // batch wins, never both with different rules.
  const result = await db.batch([
    db.prepare(`INSERT INTO admin_changes (id, admin_id, target, before_json, after_json, effective_from, created_at)
      SELECT ?, ?, ?, ${effectiveRulesSql}, ?, ?, ?
      WHERE EXISTS (SELECT 1 FROM users WHERE id = ? AND role = 'admin' AND active = 1)
        AND unixepoch('now') * 1000 >= ? AND unixepoch('now') * 1000 < ?
        AND (? != ? OR (NOT EXISTS (SELECT 1 FROM predictions WHERE game_id = ? AND round_date = ?)
          AND NOT EXISTS (SELECT 1 FROM game_rounds WHERE game_id = ? AND round_date = ? AND answer IS NOT NULL)))`)
      .bind(changeId, admin.id, `game:${id}`, ...rulesBindings(id, effectiveFrom), after, effectiveFrom, now.toISOString(),
        admin.id, start, start + 86_400_000, effectiveFrom, today, id, today, id, today),
    db.prepare(`INSERT INTO game_settings (game_id, effective_from, settings_json, created_at, created_by)
      SELECT ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM admin_changes WHERE id = ?)
      ON CONFLICT(game_id, effective_from) DO UPDATE SET settings_json = excluded.settings_json,
        created_at = excluded.created_at, created_by = excluded.created_by`)
      .bind(id, effectiveFrom, after, now.toISOString(), admin.id, changeId),
    db.prepare(`UPDATE game_rounds SET settings_json = ? WHERE game_id = ? AND round_date = ?
      AND answer IS NULL AND NOT EXISTS (SELECT 1 FROM predictions WHERE game_id = ? AND round_date = ?)
      AND EXISTS (SELECT 1 FROM admin_changes WHERE id = ?) AND ? = ?`)
      .bind(after, id, effectiveFrom, id, effectiveFrom, changeId, effectiveFrom, today),
  ]);
  if (!result[0]!.meta.changes) {
    const active = await db.prepare("SELECT 1 FROM users WHERE id = ? AND role = 'admin' AND active = 1").bind(admin.id).first();
    if (!active) throw new AdminSettingsError(403, 'ADMIN_ONLY', '활성 운영자만 설정을 바꿀 수 있어요.');
    if (kstDate(new Date()) !== today) throw new AdminSettingsError(409, 'ROUND_CHANGED', '날짜가 바뀌었어요. 설정을 다시 확인해 주세요.');
    throw new AdminSettingsError(409, 'TODAY_HAS_ACTIVITY', '오늘 예측이나 정답이 있어 내일부터 적용할 수 있어요.');
  }
}
