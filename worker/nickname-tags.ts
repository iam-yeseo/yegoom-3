import { DAILY_FREE, NICKNAME_TAG_RULES, TAG_EVOLUTION_RULES } from '../shared/balance';
import { drawNicknameTag, evolutionChance, isTagGrade, nextTagGrade } from '../shared/nickname-tags';
import type { NicknameTag, NicknameTagState, TagEvolution, TagResponse } from '../shared/types';
import { readBalances } from './balances';
import { dayWindow, randomInt, readShopState, requestId, ShopError, type ShopUser } from './shop';

interface TagRow { id: string; user_id: string; request_id: string; grade: string; text: string; equipped: number; date: string; created_at: string; payment: string; discarded?: number }

function tagView(row: TagRow): NicknameTag {
  if (!isTagGrade(row.grade)) throw new Error('Stored nickname tag has an invalid grade');
  return { id: row.id, grade: row.grade, text: row.text, equipped: row.equipped === 1,
    createdAt: row.created_at, payment: row.payment === 'ticket' ? 'ticket' : row.payment === 'free' ? 'free' : 'gold' };
}
const GRADE_ORDER = `CASE grade WHEN 'S' THEN 0 WHEN 'A' THEN 1 WHEN 'B' THEN 2 ELSE 3 END`;

/** My collection: equipped first, then S→C, newest first; plus today's draw
 * and evolution counts. One batch of three statements.
 * The list asks only for tags still owned (the owned-tags index of migration
 * 0033), so tags thrown away or spent on evolutions over the months cost
 * nothing. Today's draws are counted apart, by date, over every tag drawn
 * today: a tag drawn and then discarded or used as material still counts
 * toward the daily limit, exactly as before. */
export async function readTagState(db: D1Database, user: ShopUser, now: Date): Promise<NicknameTagState> {
  const today = dayWindow(now).date;
  const [list, draws, evolves] = await db.batch<TagRow & { n: number }>([
    db.prepare(`SELECT * FROM nickname_tags WHERE user_id = ? AND discarded = 0
      ORDER BY equipped DESC, ${GRADE_ORDER}, created_at DESC, id`).bind(user.id),
    db.prepare('SELECT COUNT(*) AS n FROM nickname_tags WHERE user_id = ? AND date = ?').bind(user.id, today),
    db.prepare('SELECT COUNT(*) AS n FROM nickname_tag_evolutions WHERE user_id = ? AND date = ?').bind(user.id, today),
  ]);
  const tags = list!.results.map(tagView);
  return { tags, equipped: tags.find(tag => tag.equipped) ?? null,
    drawsToday: draws!.results[0]?.n ?? 0,
    dailyLimit: NICKNAME_TAG_RULES.dailyLimit, price: NICKNAME_TAG_RULES.price,
    evolvesToday: evolves!.results[0]?.n ?? 0 };
}
async function tagResponse(db: D1Database, user: ShopUser, now: Date, draw?: NicknameTag, evolution?: TagEvolution): Promise<TagResponse> {
  const [shop, tags] = await Promise.all([readShopState(db, user, now), readTagState(db, user, now)]);
  return { ...shop, tags, ...(draw ? { draw } : {}), ...(evolution ? { evolution } : {}) };
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
  if (input.free !== undefined && typeof input.free !== 'boolean') throw new ShopError(400, 'INVALID_PAYMENT', '무료 이용 여부를 확인해 주세요.');
  // Today's free draws, then owned draw tickets, then gold: one 뽑기권 count.
  // `free: true` from a client before the merge still means "only a free draw".
  const free = input.free === true;
  const previous = await previousDraw(db, user.id, id);
  if (previous) return previous;
  const tag = drawNicknameTag(randomInt);
  const attempt = crypto.randomUUID();
  const window = dayWindow(now);
  const tickets = 'COALESCE((SELECT tag_tickets FROM user_balances WHERE user_id = u.id), 0)';
  const freeLeft = `(SELECT COUNT(*) FROM nickname_tags WHERE user_id = u.id AND date = '${window.date}' AND payment = 'free') < ${DAILY_FREE.tag}`;
  const paid = `(${tickets} >= 1 OR COALESCE((SELECT gold FROM user_balances WHERE user_id = u.id), 0) >= ?)`;
  await db.batch([
    db.prepare(`INSERT OR IGNORE INTO nickname_tags (id, user_id, request_id, grade, text, equipped, date, created_at, payment)
      SELECT ?, u.id, ?, ?, ?, 0, ?, ?, ${free ? `'free'` : `CASE WHEN ${freeLeft} THEN 'free' WHEN ${tickets} >= 1 THEN 'ticket' ELSE 'gold' END`} FROM users u
      WHERE u.id = ? AND u.role = 'player' AND u.active = 1
        AND unixepoch('now') * 1000 >= ? AND unixepoch('now') * 1000 < ?
        AND ${free ? `(${freeLeft} OR ? IS NULL)` : `(${freeLeft} OR ${paid})`}
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
  if (free) throw new ShopError(409, 'NO_FREE_LEFT', '오늘 뽑기권을 모두 썼어요.');
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
    const owned = await db.prepare('SELECT 1 FROM nickname_tags WHERE id = ? AND user_id = ? AND discarded = 0').bind(tagId, user.id).first();
    if (!owned) throw new ShopError(404, 'TAG_NOT_FOUND', '내가 모은 별명 태그가 아니에요.');
  }
  // Take off first, then wear, in one transaction: the partial unique index
  // allows at most one equipped tag even when two requests race.
  await db.batch([
    db.prepare('UPDATE nickname_tags SET equipped = 0 WHERE user_id = ? AND equipped = 1 AND id IS NOT ?').bind(user.id, tagId),
    ...(tagId === null ? [] : [db.prepare('UPDATE nickname_tags SET equipped = 1 WHERE id = ? AND user_id = ? AND discarded = 0').bind(tagId, user.id)]),
  ]);
  return tagResponse(db, user, now);
}

/** POST /api/me/nickname-tag/discard { tagId }: throw away a tag I am not
 * wearing (typically one I just drew), so it never shows in my collection.
 * Discarding again is harmless. */
export async function discardTag(db: D1Database, user: ShopUser, input: Record<string, unknown>, now: Date): Promise<TagResponse> {
  if (user.role !== 'player') throw new ShopError(403, 'CANNOT_EQUIP', '플레이어만 별명 태그를 버릴 수 있어요.');
  const tagId = input.tagId;
  if (typeof tagId !== 'string' || !tagId || tagId.length > 128) throw new ShopError(400, 'INVALID_TAG', '버릴 별명 태그를 골라 주세요.');
  const row = await db.prepare('SELECT equipped FROM nickname_tags WHERE id = ? AND user_id = ?').bind(tagId, user.id).first<{ equipped: number }>();
  if (!row) throw new ShopError(404, 'TAG_NOT_FOUND', '내가 모은 별명 태그가 아니에요.');
  if (row.equipped) throw new ShopError(409, 'TAG_EQUIPPED', '달고 있는 별명 태그는 먼저 떼고 버려 주세요.');
  await db.prepare('UPDATE nickname_tags SET discarded = 1 WHERE id = ? AND user_id = ? AND equipped = 0').bind(tagId, user.id).run();
  return tagResponse(db, user, now);
}

interface EvolutionRow {
  id: string; request_id: string; base_id: string; material_id: string; text: string; from_grade: string; to_grade: string;
  material_grade: string; chance: number; success: number; material_lost: number; cost: number;
}
async function previousEvolution(db: D1Database, userId: string, id: string): Promise<EvolutionRow | null> {
  return db.prepare('SELECT * FROM nickname_tag_evolutions WHERE user_id = ? AND request_id = ?').bind(userId, id).first<EvolutionRow>();
}

/** POST /api/me/nickname-tag/evolve { requestId, tagId, materialId }.
 * Two of my tags with the same phrase: `tagId` tries to rise one grade and
 * `materialId` is what it costs. The roll is made here from the grades just
 * read; the single conditional insert then checks, inside the batch, that both
 * tags are still mine, unspent and of those grades, and decides free or paid
 * from today's attempts and the cached balance. The debit, the new grade and
 * the spent material follow only that row, so a retry (same request id) or a
 * concurrent attempt can neither charge nor consume twice. */
export async function evolveTag(db: D1Database, user: ShopUser, input: Record<string, unknown>, now: Date): Promise<TagResponse> {
  if (user.role !== 'player') throw new ShopError(403, 'CANNOT_EVOLVE', '플레이어만 별명 태그를 진화시킬 수 있어요.');
  const id = requestId(input);
  const { tagId, materialId } = input;
  if (typeof tagId !== 'string' || !tagId || tagId.length > 128 || typeof materialId !== 'string' || !materialId || materialId.length > 128 || tagId === materialId) {
    throw new ShopError(400, 'INVALID_TAG', '진화할 별명 태그와 재료 태그를 골라 주세요.');
  }
  const respond = async (row: EvolutionRow) => {
    const tag = await db.prepare('SELECT * FROM nickname_tags WHERE id = ? AND user_id = ?').bind(row.base_id, user.id).first<TagRow>();
    if (!tag || !isTagGrade(row.from_grade) || !isTagGrade(row.to_grade) || !isTagGrade(row.material_grade)) throw new Error('Stored evolution is invalid');
    return tagResponse(db, user, now, undefined, { requestId: row.request_id, tag: tagView(tag), text: row.text, fromGrade: row.from_grade, toGrade: row.to_grade,
      materialGrade: row.material_grade, chance: row.chance, success: row.success === 1, materialLost: row.material_lost === 1, cost: row.cost });
  };
  const previous = await previousEvolution(db, user.id, id);
  if (previous) return respond(previous);
  const pair = (await db.prepare('SELECT * FROM nickname_tags WHERE user_id = ? AND id IN (?, ?) AND discarded = 0').bind(user.id, tagId, materialId).all<TagRow>()).results;
  const base = pair.find(row => row.id === tagId), material = pair.find(row => row.id === materialId);
  if (!base || !material) throw new ShopError(404, 'TAG_NOT_FOUND', '내가 모은 별명 태그가 아니에요.');
  if (!isTagGrade(base.grade) || !isTagGrade(material.grade)) throw new Error('Stored nickname tag has an invalid grade');
  if (base.text !== material.text) throw new ShopError(409, 'TAG_MISMATCH', '같은 별명끼리만 진화할 수 있어요.');
  if (material.equipped) throw new ShopError(409, 'TAG_EQUIPPED', '달고 있는 별명 태그는 재료로 쓸 수 없어요. 먼저 떼어 주세요.');
  const target = nextTagGrade(base.grade);
  const chance = evolutionChance(base.grade, material.grade, TAG_EVOLUTION_RULES);
  if (!target || !chance) throw new ShopError(409, 'TAG_MAX_GRADE', 'S등급 별명 태그는 더 진화하지 않아요.');
  const success = randomInt(100) < chance.total;
  const materialLost = success || randomInt(100) < TAG_EVOLUTION_RULES.loseOnFailPercent;
  const attempt = crypto.randomUUID();
  const window = dayWindow(now);
  const freeLeft = `(SELECT COUNT(*) FROM nickname_tag_evolutions WHERE user_id = u.id AND date = '${window.date}') < ${TAG_EVOLUTION_RULES.dailyFree}`;
  await db.batch([
    db.prepare(`INSERT OR IGNORE INTO nickname_tag_evolutions
        (id, user_id, request_id, base_id, material_id, text, from_grade, to_grade, material_grade, chance, success, material_lost, cost, date, created_at)
      SELECT ?, u.id, ?, b.id, m.id, b.text, b.grade, ?, m.grade, ?, ?, ?, CASE WHEN ${freeLeft} THEN 0 ELSE ? END, ?, ?
      FROM users u
        JOIN nickname_tags b ON b.id = ? AND b.user_id = u.id AND b.discarded = 0 AND b.grade = ?
        JOIN nickname_tags m ON m.id = ? AND m.user_id = u.id AND m.discarded = 0 AND m.equipped = 0 AND m.grade = ? AND m.text = b.text AND m.id != b.id
      WHERE u.id = ? AND u.role = 'player' AND u.active = 1
        AND unixepoch('now') * 1000 >= ? AND unixepoch('now') * 1000 < ?
        AND (${freeLeft} OR COALESCE((SELECT gold FROM user_balances WHERE user_id = u.id), 0) >= ?)`)
      .bind(attempt, id, target, chance.total, Number(success), Number(materialLost), TAG_EVOLUTION_RULES.price, window.date, now.toISOString(),
        base.id, base.grade, material.id, material.grade, user.id, window.start, window.end, TAG_EVOLUTION_RULES.price),
    db.prepare(`INSERT INTO ledger (id, user_id, currency, amount, reason, reference, created_at)
      SELECT ?, user_id, 'gold', -cost, '별명 태그 진화', 'tag:evolve:' || user_id || ':' || request_id, created_at
      FROM nickname_tag_evolutions WHERE id = ? AND cost > 0`).bind(crypto.randomUUID(), attempt),
    db.prepare(`UPDATE nickname_tags SET grade = ? WHERE id = (SELECT base_id FROM nickname_tag_evolutions WHERE id = ? AND success = 1)`).bind(target, attempt),
    db.prepare(`UPDATE nickname_tags SET discarded = 1 WHERE id = (SELECT material_id FROM nickname_tag_evolutions WHERE id = ? AND material_lost = 1)`).bind(attempt),
  ]);
  const receipt = await previousEvolution(db, user.id, id);
  if (receipt) return respond(receipt);
  const active = await db.prepare("SELECT 1 FROM users WHERE id = ? AND role = 'player' AND active = 1").bind(user.id).first();
  if (!active) throw new ShopError(403, 'CANNOT_EVOLVE', '플레이어만 별명 태그를 진화시킬 수 있어요.');
  const [today, balances] = await Promise.all([
    db.prepare('SELECT COUNT(*) AS n FROM nickname_tag_evolutions WHERE user_id = ? AND date = ?').bind(user.id, window.date).first<{ n: number }>(),
    readBalances(db, user.id),
  ]);
  if ((today?.n ?? 0) >= TAG_EVOLUTION_RULES.dailyFree && balances.gold < TAG_EVOLUTION_RULES.price) throw new ShopError(409, 'INSUFFICIENT_GOLD', '골드가 부족해요');
  // The tags changed under us (another device) or the day turned: nothing was spent.
  throw new ShopError(409, 'EVOLVE_REJECTED', '별명 태그가 바뀌었어요. 인벤토리를 새로 불러온 뒤 다시 시도해 주세요.');
}
