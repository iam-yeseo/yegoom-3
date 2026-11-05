import { NOTIFICATION_RULES, type AppNotification, type NotificationKind, type NotificationPayload, type NotificationSummary, type NotificationsResponse } from '../shared/notifications';

export class NotificationError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); }
}
interface Row { id: number; actor_id: string | null; payload_json: string; created_at: string }

/** Rows this reader may see: everyone's news plus the ones addressed to them. */
const VISIBLE = "(n.audience = 'all' OR n.user_id = ?)";
const WATERMARK = "COALESCE((SELECT notifications_seen_at FROM users WHERE id = ?), '')";

type ListRow = Row & { unread: number; seen_at: string };
/** The centre, the badge and the toast share one shape: a page of visible rows,
 * the capped unread count and the reader's watermark. */
const listQuery = (extra: string) => `SELECT n.id, n.actor_id, n.payload_json, n.created_at,
    (SELECT COUNT(*) FROM (SELECT 1 FROM notifications n WHERE ${VISIBLE} AND n.created_at > ${WATERMARK} LIMIT ?)) AS unread,
    ${WATERMARK} AS seen_at
  FROM notifications n WHERE ${VISIBLE} ${extra} ORDER BY n.created_at DESC, n.id DESC LIMIT ?`;
const listBindings = (userId: string) => [userId, userId, NOTIFICATION_RULES.unreadCap, userId, userId] as const;

function view(row: Row, seenAt: string): AppNotification {
  return { id: row.id, actorId: row.actor_id, payload: JSON.parse(row.payload_json) as NotificationPayload,
    createdAt: row.created_at, unread: row.created_at > seenAt };
}

/** One notification, stored by the write that causes it. The reference is
 * UNIQUE, so a retried payout or a replayed Cron never notifies twice. */
export function notify(db: D1Database, notification: {
  kind: NotificationKind; audience: 'all' | 'user'; userId?: string | null; actorId?: string | null;
  payload: NotificationPayload; reference: string; createdAt: string;
}): D1PreparedStatement {
  return db.prepare(`INSERT OR IGNORE INTO notifications (kind, audience, user_id, actor_id, payload_json, created_at, reference)
    VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .bind(notification.kind, notification.audience, notification.userId ?? null, notification.actorId ?? null,
      JSON.stringify(notification.payload), notification.createdAt, notification.reference);
}

/** A prize notification that exists only if its payout row does, inserted in
 * the same batch as the payout and carrying the amount that was actually paid. */
export function notifyPrize(db: D1Database, kind: 'lotto' | 'speetto', payoutReference: string, rank: number | null): D1PreparedStatement {
  return db.prepare(`INSERT OR IGNORE INTO notifications (kind, audience, user_id, actor_id, payload_json, created_at, reference)
    SELECT ?, 'all', NULL, user_id, json_patch(?, json_object('prize', amount)), created_at, ?
    FROM ledger WHERE reference = ? AND currency = 'gold' AND amount > 0`)
    .bind(kind, JSON.stringify(kind === 'lotto' ? { kind, rank, prize: 0 } : { kind, prize: 0 }),
      `notification:${payoutReference}`, payoutReference);
}

/** Bell badge and toast queue in one indexed read. The count stops at the cap so
 * a long absence costs the same as a short one. */
export async function readNotificationSummary(db: D1Database, userId: string): Promise<NotificationSummary> {
  const rows = (await db.prepare(listQuery('')).bind(...listBindings(userId), NOTIFICATION_RULES.recentLimit)
    .all<ListRow>()).results;
  return { unread: rows[0]?.unread ?? 0, recent: rows.map(row => view(row, row.seen_at)) };
}

/** Cursor `createdAt|id`, newest first, from a previous page. */
function parseCursor(value: string | null): { createdAt: string; id: number } | null {
  if (value === null) return null;
  const match = /^(\d{4}-\d{2}-\d{2}T[\d:.]+Z)\|(\d{1,12})$/.exec(value);
  if (!match) throw new NotificationError(400, 'INVALID_CURSOR', '알림 페이지를 확인해 주세요.');
  return { createdAt: match[1]!, id: Number(match[2]) };
}

/** The notification centre. Opening it (the first page) also marks everything
 * read, in the same batch, while the rows keep the flags the reader just saw. */
export async function readNotifications(db: D1Database, userId: string, before: string | null, now: Date): Promise<NotificationsResponse> {
  const cursor = parseCursor(before);
  const page = NOTIFICATION_RULES.pageSize;
  const statement = db.prepare(listQuery(cursor ? 'AND (n.created_at, n.id) < (?, ?)' : ''))
    .bind(...listBindings(userId), ...(cursor ? [cursor.createdAt, cursor.id] : []), page + 1);
  // The first page is the moment the centre was opened, so it clears the badge.
  const results = cursor ? [await statement.all<ListRow>()] : await db.batch<ListRow>([statement,
    db.prepare('UPDATE users SET notifications_seen_at = ? WHERE id = ?').bind(now.toISOString(), userId)]);
  const rows = results[0]!.results;
  const seenAt = rows[0]?.seen_at ?? '';
  const hasMore = rows.length > page;
  const items = rows.slice(0, page).map(row => view(row, seenAt));
  const last = items[items.length - 1];
  return { notifications: items, unread: cursor ? rows[0]?.unread ?? 0 : 0,
    nextBefore: hasMore && last ? `${last.createdAt}|${last.id}` : null, serverTime: now.toISOString() };
}

/** `GET /api/notifications[?before=…]` for every signed-in account. */
export async function notificationsRoute(db: D1Database, user: { id: string }, method: string, before: string | null, now: Date): Promise<NotificationsResponse> {
  if (method !== 'GET') throw new NotificationError(405, 'METHOD_NOT_ALLOWED', '지원하지 않는 요청이에요.');
  return readNotifications(db, user.id, before, now);
}

/** `POST /api/admin/notifications` — one notice to every player. */
export async function sendAdminNotification(db: D1Database, input: Record<string, unknown>, now: Date): Promise<NotificationSummary> {
  const title = typeof input.title === 'string' ? input.title.trim() : '';
  const body = typeof input.body === 'string' ? input.body.trim() : '';
  if (!title || title.length > NOTIFICATION_RULES.titleMax) {
    throw new NotificationError(400, 'INVALID_TITLE', `제목은 1~${NOTIFICATION_RULES.titleMax}자로 써 주세요.`);
  }
  if (body.length > NOTIFICATION_RULES.bodyMax) {
    throw new NotificationError(400, 'INVALID_BODY', `내용은 ${NOTIFICATION_RULES.bodyMax}자까지 쓸 수 있어요.`);
  }
  const createdAt = now.toISOString();
  await notify(db, { kind: 'admin', audience: 'all', payload: { kind: 'admin', title, body },
    reference: `admin:${createdAt}`, createdAt }).run();
  return { unread: 0, recent: [] };
}
