import { ANNOUNCEMENT_RULES } from '../shared/balance';
import type { Announcement } from '../shared/types';

/** Insert from the actual payout row, in the same batch as that payout. */
export function announcePrize(db: D1Database, kind: Announcement['kind'], payoutReference: string, rank: number | null): D1PreparedStatement {
  return db.prepare(`INSERT OR IGNORE INTO announcements (kind, user_id, payload_json, created_at, reference)
    SELECT ?, user_id, json_object('rank', ?, 'prize', amount), created_at, ?
    FROM ledger WHERE reference = ? AND currency = 'gold' AND amount > 0`)
    .bind(kind, rank, `announcement:${payoutReference}`, payoutReference);
}

/** Bound the indexed recent window before omitting the viewer, even if they won many prizes. */
export async function readAnnouncements(db: D1Database, userId: string, now: Date): Promise<Announcement[]> {
  const rows = (await db.prepare(`SELECT a.id, a.kind, a.user_id, a.payload_json, a.created_at, u.display_name
    FROM (SELECT id, kind, user_id, payload_json, created_at FROM announcements
      WHERE created_at > ? AND created_at <= ? ORDER BY created_at DESC, id DESC LIMIT ?) a
    JOIN users u ON u.id = a.user_id WHERE a.user_id != ?
    ORDER BY a.created_at DESC, a.id DESC`)
    .bind(new Date(now.getTime() - ANNOUNCEMENT_RULES.recentMs).toISOString(), now.toISOString(), ANNOUNCEMENT_RULES.limit, userId)
    .all<{ id: number; kind: Announcement['kind']; user_id: string; payload_json: string; created_at: string; display_name: string }>()).results;
  return rows.map(row => {
    const payload = JSON.parse(row.payload_json) as { rank: number | null; prize: number };
    return { id: row.id, kind: row.kind, userId: row.user_id, displayName: row.display_name,
      rank: payload.rank, prize: payload.prize, createdAt: row.created_at };
  });
}
