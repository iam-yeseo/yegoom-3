/** Daily housekeeping only: accounting and public game history are never deleted. */
import { NOTIFICATION_RULES } from '../shared/notifications';
import { STOCK_RULES } from '../shared/stocks';

export const MAINTENANCE_RULES = { requestRetentionDays: 30, deleteLimit: 500, stockTickDeleteLimit: 2000 } as const;

export async function maintainDatabase(db: D1Database, now: Date): Promise<void> {
  const cutoff = new Date(now.getTime() - MAINTENANCE_RULES.requestRetentionDays * 86_400_000).toISOString();
  await db.batch([
    db.prepare(`DELETE FROM sessions WHERE token_hash IN (
      SELECT token_hash FROM sessions WHERE expires_at <= ? ORDER BY expires_at LIMIT ?
    )`).bind(now.getTime(), MAINTENANCE_RULES.deleteLimit),
    db.prepare(`DELETE FROM login_attempts WHERE bucket IN (
      SELECT bucket FROM login_attempts WHERE expires_at <= ? ORDER BY expires_at LIMIT ?
    )`).bind(now.getTime(), MAINTENANCE_RULES.deleteLimit),
    // Guesses reference their request IDs, so keep those receipts permanently.
    // Current/draft/open rounds also retain replay protection even after 30 days.
    db.prepare(`DELETE FROM catchmind_requests WHERE id IN (
      SELECT q.id FROM catchmind_requests q
      WHERE q.action != 'guess' AND q.created_at < ?
        AND NOT EXISTS (SELECT 1 FROM catchmind_guesses g WHERE g.id = q.id)
        AND EXISTS (SELECT 1 FROM catchmind_rounds r WHERE r.id = q.result_round_id AND r.status = 'ended')
        AND q.result_round_id IS NOT (SELECT round_id FROM catchmind_turn WHERE id = 1)
      ORDER BY q.created_at LIMIT ?
    )`).bind(cutoff, MAINTENANCE_RULES.deleteLimit),
    // Notifications are a view of things the ledger and game history already
    // keep, so dropping the old ones loses no record.
    db.prepare(`DELETE FROM notifications WHERE id IN (
      SELECT id FROM notifications WHERE created_at < ? ORDER BY created_at LIMIT ?
    )`).bind(new Date(now.getTime() - NOTIFICATION_RULES.retentionDays * 86_400_000).toISOString(), MAINTENANCE_RULES.deleteLimit),
    // 10-minute prices are kept 30 days; daily candles stay in stock_daily.
    db.prepare(`DELETE FROM stock_ticks WHERE (ticker, at) IN (
      SELECT ticker, at FROM stock_ticks WHERE at < ? LIMIT ?
    )`).bind(now.getTime() - STOCK_RULES.tickRetentionDays * 86_400_000, MAINTENANCE_RULES.stockTickDeleteLimit),
  ]);
}
