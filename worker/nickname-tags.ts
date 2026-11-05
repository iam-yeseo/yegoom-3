import { NICKNAME_TAG_RULES } from '../shared/balance';
import { drawNicknameTag, isTagGrade } from '../shared/nickname-tags';
import type { NicknameTag, NicknameTagState, TagResponse } from '../shared/types';
import { readBalances } from './balances';
import { dayWindow, randomInt, readShopState, requestId, ShopError, type ShopUser } from './shop';

interface TagRow { id: string; user_id: string; request_id: string; grade: string; text: string; equipped: number; date: string; created_at: string; payment: string }

function tagView(row: TagRow): NicknameTag {
  if (!isTagGrade(row.grade)) throw new Error('Stored nickname tag has an invalid grade');
  return { id: row.id, grade: row.grade, text: row.text, equipped: row.equipped === 1,
    createdAt: row.created_at, payment: row.payment === 'ticket' ? 'ticket' : 'gold' };
}
const GRADE_ORDER = `CASE grade WHEN 'S' THEN 0 WHEN 'A' THEN 1 WHEN 'B' THEN 2 ELSE 3 END`;

/** My collection: equipped first, then S→C, newest first; plus today's draw count. One query. */
export async function readTagState(db: D1Database, user: ShopUser, now: Date): Promise<NicknameTagState> {
  const today = dayWindow(now).date;
  const rows = (await db.prepare(`SELECT * FROM nickname_tags WHERE user_id = ?
    ORDER BY equipped DESC, ${GRADE_ORDER}, created_at DESC, id`).bind(user.id).all<TagRow>()).results;
  const tags = rows.map(tagView);
  return { tags, equipped: tags.find(tag => tag.equipped) ?? null,
    drawsToday: rows.filter(row => row.date === today).length,
    dailyLimit: NICKNAME_TAG_RULES.dailyLimit, price: NICKNAME_TAG_RULES.price };
}
async function tagResponse(db: D1Database, user: ShopUser, now: Date, draw?: NicknameTag): Promise<TagResponse> {
  const [shop, tags] = await Promise.all([readShopState(db, user, now), readTagState(db, user, now)]);
  return { ...shop, tags, ...(draw ? { draw } : {}) };
}
async function previousDraw(db: D1Database, userId: string, id: string): Promise<TagRow | null> {
  return db.prepare('SELECT * FROM nickname_tags WHERE user_id = ? AND request_id = ?').bind(userId, id).first<TagRow>();
}

/** Buying draws one tag at once. The grade and phrase are decided here; the
 * balance, the daily limit, the debit and the new tag commit in one batch, and a
 * repeated request id returns the tag it first drew without charging again.
 * A draw ticket pays before gold. The same conditional write picks the payment
 * from the cached balance and stores it, so a concurrent draw cannot overdraw
 * either side and no extra read is needed to decide. */
async function drawTag(db: D1Database, user: ShopUser, input: Record<string, unknown>, now: Date): Promise<TagRow> {
  const id = requestId(input);
  const previous = await previousDraw(db, user.id, id);
  if (previous) return previous;
  const tag = drawNicknameTag(randomInt);
  const attempt = crypto.randomUUID();
  const window = dayWindow(now);
  const tickets = 'COALESCE((SELECT tag_tickets FROM user_balances WHERE user_id = u.id), 0)';
  await db.batch([
    db.prepare(`INSERT OR IGNORE INTO nickname_tags (id, user_id, request_id, grade, text, equipped, date, created_at, payment)
      SELECT ?, u.id, ?, ?, ?, 0, ?, ?, CASE WHEN ${tickets} >= 1 THEN 'ticket' ELSE 'gold' END FROM users u
      WHERE u.id = ? AND u.role = 'player' AND u.active = 1
        AND unixepoch('now') * 1000 >= ? AND unixepoch('now') * 1000 < ?
        AND (${tickets} >= 1 OR COALESCE((SELECT gold FROM user_balances WHERE user_id = u.id), 0) >= ?)
        AND (SELECT COUNT(*) FROM nickname_tags WHERE user_id = u.id AND date = ?) < ?`)
      .bind(attempt, id, tag.grade, tag.text, window.date, now.toISOString(),
        user.id, window.start, window.end, NICKNAME_TAG_RULES.price,
        window.date, NICKNAME_TAG_RULES.dailyLimit),
    // Only this attempt's row can pay; a duplicate or rejected request has none.
    db.prepare(`INSERT INTO ledger (id, user_id, currency, amount, reason, reference, created_at)
      SELECT ?, user_id, 'gold', ?, '별명 태그 뽑기', 'tag:buy:' || user_id || ':' || request_id, created_at
      FROM nickname_tags WHERE id = ? AND payment = 'gold'`).bind(crypto.randomUUID(), -NICKNAME_TAG_RULES.price, attempt),
    db.prepare(`INSERT INTO tag_ticket_ledger (id, user_id, amount, reason, reference, created_at)
      SELECT ?, user_id, -1, '별명 뽑기권 사용', 'tag:use:' || user_id || ':' || request_id, created_at
      FROM nickname_tags WHERE id = ? AND payment = 'ticket'`).bind(crypto.randomUUID(), attempt),
  ]);
  const receipt = await previousDraw(db, user.id, id);
  if (receipt) return receipt;
  const active = await db.prepare("SELECT 1 FROM users WHERE id = ? AND role = 'player' AND active = 1").bind(user.id).first();
  if (!active) throw new ShopError(403, 'CANNOT_PURCHASE', '플레이어만 별명 태그를 뽑을 수 있어요.');
  const clock = await db.prepare("SELECT unixepoch('now') * 1000 AS now").first<{ now: number }>();
  if (!clock || clock.now < window.start || clock.now >= window.end) {
    throw new ShopError(409, 'PURCHASE_TIME_CHANGED', '구매 날짜가 바뀌었어요. 새로고침하고 다시 시도해 주세요.');
  }
  const today = await db.prepare('SELECT COUNT(*) AS n FROM nickname_tags WHERE user_id = ? AND date = ?').bind(user.id, window.date).first<{ n: number }>();
  if ((today?.n ?? 0) >= NICKNAME_TAG_RULES.dailyLimit) {
    throw new ShopError(409, 'DAILY_LIMIT', `별명 태그는 하루 ${NICKNAME_TAG_RULES.dailyLimit}번까지 뽑을 수 있어요.`);
  }
  const balances = await readBalances(db, user.id);
  // Only a draw with neither a ticket nor the price in gold is out of funds; any
  // other rejection raced another write and is worth retrying with the same id.
  if (balances.inventory.tagTickets > 0 || balances.gold >= NICKNAME_TAG_RULES.price) {
    throw new ShopError(409, 'PURCHASE_REJECTED', '뽑기권과 골드를 다시 확인하고 같은 버튼으로 시도해 주세요.');
  }
  throw new ShopError(409, 'INSUFFICIENT_GOLD', '골드가 부족해요');
}

/** GET /api/shop/tag and POST /api/shop/tag { requestId }. */
export async function tagShopRoute(db: D1Database, user: ShopUser, method: string, input: Record<string, unknown> | undefined, now: Date): Promise<TagResponse> {
  if (method === 'GET') return tagResponse(db, user, now);
  if (method !== 'POST') throw new ShopError(405, 'METHOD_NOT_ALLOWED', '지원하지 않는 요청이에요.');
  if (user.role !== 'player') throw new ShopError(403, 'CANNOT_PURCHASE', '플레이어만 별명 태그를 뽑을 수 있어요.');
  const row = await drawTag(db, user, input!, now);
  return tagResponse(db, user, now, tagView(row));
}

/** PUT /api/me/nickname-tag { tagId }: wear one of my tags, or take it off with null. */
export async function equipTag(db: D1Database, user: ShopUser, input: Record<string, unknown>, now: Date): Promise<TagResponse> {
  if (user.role !== 'player') throw new ShopError(403, 'CANNOT_EQUIP', '플레이어만 별명 태그를 달 수 있어요.');
  const tagId = input.tagId;
  if (tagId !== null && (typeof tagId !== 'string' || !tagId || tagId.length > 128)) {
    throw new ShopError(400, 'INVALID_TAG', '달 별명 태그를 골라 주세요.');
  }
  if (tagId !== null) {
    const owned = await db.prepare('SELECT 1 FROM nickname_tags WHERE id = ? AND user_id = ?').bind(tagId, user.id).first();
    if (!owned) throw new ShopError(404, 'TAG_NOT_FOUND', '내가 모은 별명 태그가 아니에요.');
  }
  // Take off first, then wear, in one transaction: the partial unique index
  // allows at most one equipped tag even when two requests race.
  await db.batch([
    db.prepare('UPDATE nickname_tags SET equipped = 0 WHERE user_id = ? AND equipped = 1 AND id IS NOT ?').bind(user.id, tagId),
    ...(tagId === null ? [] : [db.prepare('UPDATE nickname_tags SET equipped = 1 WHERE id = ? AND user_id = ?').bind(tagId, user.id)]),
  ]);
  return tagResponse(db, user, now);
}
