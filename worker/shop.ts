import { KUJI_RULES, LOTTO_RULES, SPEETTO_RULES, kujiCost, lottoPrize, lottoRank } from '../shared/balance';
import type { Inventory, KujiGrade, KujiPurchase, KujiResponse, KujiState, LottoResponse, LottoTicket, ShopKind, ShopPayment, ShopState, SpeettoResponse, SpeettoSymbol, SpeettoTicket } from '../shared/types';
import { kstDate, kstTimestamp, weekStart } from './rules';

export interface ShopUser { id: string; role: 'player' | 'admin' }
export class ShopError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); }
}
interface PurchaseRow {
  id: string; user_id: string; request_id: string; kind: ShopKind; request_payload: string;
  payment: ShopPayment; cost: number; date: string; created_at: string; outcome: string; last_one: number;
}
interface BoardRow { id: number; grades: string }
interface LottoRow extends PurchaseRow {
  draw_date: string; numbers: string; winning_numbers: string | null; matches: number | null; rank: number | null; prize: number | null;
}

/** Unbiased crypto randomness. Tests replace this function only in their bundle. */
export function randomInt(max: number): number {
  const limit = Math.floor(0x1_0000_0000 / max) * max;
  const bytes = new Uint32Array(1);
  do { crypto.getRandomValues(bytes); } while (bytes[0]! >= limit);
  return bytes[0]! % max;
}
function shuffled<T>(values: readonly T[]): T[] {
  const result = [...values];
  for (let index = result.length - 1; index > 0; index--) {
    const other = randomInt(index + 1);
    [result[index], result[other]] = [result[other]!, result[index]!];
  }
  return result;
}
function requestId(input: Record<string, unknown>): string {
  if (typeof input.requestId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(input.requestId)) {
    throw new ShopError(400, 'INVALID_REQUEST_ID', '구매 요청 번호를 확인해 주세요.');
  }
  return input.requestId;
}
function payment(input: Record<string, unknown>): ShopPayment {
  if (input.payment !== 'gold' && input.payment !== 'ticket') throw new ShopError(400, 'INVALID_PAYMENT', '골드 또는 이용권을 선택해 주세요.');
  return input.payment;
}
function dayWindow(now: Date): { date: string; start: number; end: number } {
  const date = kstDate(now);
  const start = kstTimestamp(date, '00:00:00');
  return { date, start, end: start + 86_400_000 };
}
function targetDrawDate(now: Date): string {
  const today = kstDate(now);
  return now.getTime() < kstTimestamp(today, LOTTO_RULES.drawTime) ? today : kstDate(new Date(now.getTime() + 86_400_000));
}
async function previousPurchase(db: D1Database, user: ShopUser, id: string, kind: ShopKind, payload: string): Promise<PurchaseRow | null> {
  const row = await db.prepare('SELECT * FROM shop_purchases WHERE user_id = ? AND request_id = ?').bind(user.id, id).first<PurchaseRow>();
  if (row && (row.kind !== kind || row.request_payload !== payload)) throw new ShopError(409, 'REQUEST_CONFLICT', '이미 다른 구매에 사용한 요청 번호예요.');
  return row;
}
async function rejectedPurchase(db: D1Database, user: ShopUser, start: number, end: number): Promise<never> {
  const active = await db.prepare("SELECT 1 FROM users WHERE id = ? AND role = 'player' AND active = 1").bind(user.id).first();
  if (!active) throw new ShopError(403, 'CANNOT_PURCHASE', '플레이어만 구매할 수 있어요.');
  const clock = await db.prepare("SELECT unixepoch('now') * 1000 AS now").first<{ now: number }>();
  if (!clock || clock.now < start || clock.now >= end) throw new ShopError(409, 'PURCHASE_TIME_CHANGED', '구매 날짜나 추첨 회차가 바뀌었어요. 새로고침하고 다시 시도해 주세요.');
  throw new ShopError(409, 'PURCHASE_REJECTED', '잔액과 이용권, 남은 쿠지를 확인하고 다시 시도해 주세요.');
}

export async function readInventory(db: D1Database, userId: string): Promise<Inventory> {
  const rows = (await db.prepare('SELECT item, SUM(amount) AS quantity FROM inventory_ledger WHERE user_id = ? GROUP BY item')
    .bind(userId).all<{ item: string; quantity: number }>()).results;
  return { lottoTickets: rows.find(row => row.item === 'lotto_ticket')?.quantity ?? 0,
    speettoTickets: rows.find(row => row.item === 'speetto_ticket')?.quantity ?? 0 };
}
export async function readShopState(db: D1Database, user: ShopUser, now: Date): Promise<ShopState> {
  const [gold, inventory] = await Promise.all([
    db.prepare("SELECT COALESCE(SUM(amount), 0) AS gold FROM ledger WHERE user_id = ? AND currency = 'gold'").bind(user.id).first<number>('gold'),
    readInventory(db, user.id),
  ]);
  return { gold: gold ?? 0, inventory, canPurchase: user.role === 'player', serverTime: now.toISOString() };
}

function chargeStatements(db: D1Database, attempt: string, kind: ShopKind): D1PreparedStatement[] {
  const reason = kind === 'kuji' ? '예굼쿠지 구매' : kind === 'lotto' ? '데일리 로또 구매' : '스피또 구매';
  const statements = [db.prepare(`INSERT OR IGNORE INTO ledger (id, user_id, currency, amount, reason, reference, created_at)
    SELECT ?, user_id, 'gold', -cost, ?, 'buy:' || kind || ':' || user_id || ':' || request_id, created_at
    FROM shop_purchases WHERE id = ? AND payment = 'gold' AND cost > 0`).bind(crypto.randomUUID(), reason, attempt)];
  if (kind !== 'kuji') statements.push(db.prepare(`INSERT OR IGNORE INTO inventory_ledger (id, user_id, item, amount, reason, reference, created_at)
    SELECT ?, user_id, ?, -1, ?, 'use:' || kind || ':' || user_id || ':' || request_id, created_at
    FROM shop_purchases WHERE id = ? AND payment = 'ticket'`).bind(crypto.randomUUID(), `${kind}_ticket`, reason, attempt));
  return statements;
}
function grantGold(db: D1Database, attempt: string, amount: number, reason: string, reference: string): D1PreparedStatement {
  return db.prepare(`INSERT OR IGNORE INTO ledger (id, user_id, currency, amount, reason, reference, created_at)
    SELECT ?, user_id, 'gold', ?, ?, ?, created_at FROM shop_purchases WHERE id = ?`)
    .bind(crypto.randomUUID(), amount, reason, reference, attempt);
}

async function ensureBoard(db: D1Database, now: Date): Promise<BoardRow> {
  const current = await db.prepare('SELECT id, grades FROM kuji_boards ORDER BY id DESC LIMIT 1').first<BoardRow>();
  if (current) {
    const sold = await db.prepare('SELECT COUNT(*) AS count FROM kuji_claims WHERE board_id = ?').bind(current.id).first<number>('count');
    if ((sold ?? 0) < KUJI_RULES.size) return current;
  }
  const grades = shuffled(KUJI_RULES.grades.flatMap(tier => Array<KujiGrade>(tier.count).fill(tier.grade)));
  await db.prepare(`INSERT OR IGNORE INTO kuji_boards (id, grades, created_at)
    SELECT COALESCE(MAX(id), 0) + 1, ?, ? FROM kuji_boards
    HAVING COUNT(*) = 0 OR (SELECT COUNT(*) FROM kuji_claims WHERE board_id = (SELECT MAX(id) FROM kuji_boards)) >= ?`)
    .bind(JSON.stringify(grades), now.toISOString(), KUJI_RULES.size).run();
  return (await db.prepare('SELECT id, grades FROM kuji_boards ORDER BY id DESC LIMIT 1').first<BoardRow>())!;
}
async function readKuji(db: D1Database, user: ShopUser, now: Date, board?: BoardRow): Promise<KujiState> {
  board ??= await ensureBoard(db, now);
  const grades = JSON.parse(board.grades) as KujiGrade[];
  const [claims, purchasedToday] = await Promise.all([
    db.prepare('SELECT c.position, p.user_id FROM kuji_claims c JOIN shop_purchases p ON p.id = c.purchase_id WHERE c.board_id = ?')
      .bind(board.id).all<{ position: number; user_id: string }>(),
    db.prepare('SELECT COUNT(*) AS count FROM kuji_claims c JOIN shop_purchases p ON p.id = c.purchase_id WHERE p.user_id = ? AND p.date = ?')
      .bind(user.id, kstDate(now)).first<number>('count'),
  ]);
  const remainingByGrade = Object.fromEntries(KUJI_RULES.grades.map(tier => [tier.grade, tier.count])) as Record<KujiGrade, number>;
  const claimed = new Map(claims.results.map(claim => [claim.position, claim.user_id]));
  for (const claim of claims.results) remainingByGrade[grades[claim.position]!]--;
  return { boardId: board.id, remaining: KUJI_RULES.size - claims.results.length, remainingByGrade,
    purchasedToday: purchasedToday ?? 0, nextPrice: kujiCost(purchasedToday ?? 0, 1),
    cells: grades.map((grade, position) => ({ position, grade: claimed.has(position) ? grade : null, buyerId: claimed.get(position) ?? null })) };
}
function kujiReceipt(row: PurchaseRow): KujiPurchase {
  const outcome = JSON.parse(row.outcome) as Omit<KujiPurchase, 'requestId' | 'cost' | 'lastOne'>;
  return { ...outcome, requestId: row.request_id, cost: row.cost, lastOne: Boolean(row.last_one),
    reward: { ...outcome.reward, gold: outcome.reward.gold + (row.last_one ? KUJI_RULES.lastOneGold : 0) } };
}
async function buyKuji(db: D1Database, user: ShopUser, input: Record<string, unknown>, now: Date): Promise<PurchaseRow> {
  const id = requestId(input);
  if (!Number.isSafeInteger(input.boardId) || Number(input.boardId) < 1 || !Array.isArray(input.positions) || input.positions.length < 1 || input.positions.length > KUJI_RULES.size
    || input.positions.some(position => !Number.isInteger(position) || position < 0 || position >= KUJI_RULES.size)
    || new Set(input.positions).size !== input.positions.length) throw new ShopError(400, 'INVALID_KUJI_SELECTION', '구매할 쿠지를 다시 골라 주세요.');
  const positions = [...input.positions as number[]].sort((left, right) => left - right);
  const payload = JSON.stringify({ boardId: input.boardId, positions });
  const previous = await previousPurchase(db, user, id, 'kuji', payload);
  if (previous) return previous;
  const board = await ensureBoard(db, now);
  if (board.id !== input.boardId) throw new ShopError(409, 'BOARD_CHANGED', '새 쿠지판이 열렸어요. 다시 골라 주세요.');
  const grades = JSON.parse(board.grades) as KujiGrade[];
  const cells = positions.map(position => ({ position, grade: grades[position]! }));
  const reward = { gold: 0, score: 0, lottoTickets: 0, speettoTickets: 0 };
  for (const cell of cells) {
    const tier = KUJI_RULES.grades.find(value => value.grade === cell.grade)!;
    reward.gold += tier.gold; reward.score += tier.score; reward.lottoTickets += tier.lottoTickets; reward.speettoTickets += tier.speettoTickets;
  }
  const attempt = crypto.randomUUID();
  const window = dayWindow(now);
  const writes = [db.prepare(`WITH bought AS (
      SELECT COUNT(*) AS count FROM kuji_claims c JOIN shop_purchases p ON p.id = c.purchase_id WHERE p.user_id = ? AND p.date = ?
    ), priced AS (SELECT ? * ? - MIN(?, MAX(0, ? - count)) * ? AS cost FROM bought)
    INSERT OR IGNORE INTO shop_purchases (id, user_id, request_id, kind, request_payload, payment, cost, date, created_at, outcome, last_one)
    SELECT ?, u.id, ?, 'kuji', ?, 'gold', priced.cost, ?, ?, ?,
      (SELECT COUNT(*) FROM kuji_claims WHERE board_id = ?) + ? = ?
    FROM users u, priced WHERE u.id = ? AND u.role = 'player' AND u.active = 1
      AND unixepoch('now') * 1000 >= ? AND unixepoch('now') * 1000 < ?
      AND COALESCE((SELECT SUM(amount) FROM ledger WHERE user_id = u.id AND currency = 'gold'), 0) >= priced.cost
      AND NOT EXISTS (SELECT 1 FROM kuji_claims WHERE board_id = ? AND position IN (SELECT value FROM json_each(?)))`)
    .bind(user.id, window.date, positions.length, KUJI_RULES.higherPrice, positions.length, KUJI_RULES.basePriceCount, KUJI_RULES.higherPrice - KUJI_RULES.basePrice,
      attempt, id, payload, window.date, now.toISOString(), JSON.stringify({ boardId: board.id, cells, reward }), board.id, positions.length, KUJI_RULES.size,
      user.id, window.start, window.end, board.id, JSON.stringify(positions)),
    ...chargeStatements(db, attempt, 'kuji'),
    db.prepare(`INSERT INTO kuji_claims (board_id, position, purchase_id)
      SELECT ?, value, p.id FROM shop_purchases p, json_each(?) WHERE p.id = ?`).bind(board.id, JSON.stringify(positions), attempt),
  ];
  if (reward.gold) writes.push(grantGold(db, attempt, reward.gold, '예굼쿠지 등급 보상', `kuji:gold:${attempt}`));
  if (reward.score) writes.push(db.prepare(`INSERT OR IGNORE INTO ledger (id, user_id, currency, amount, reason, reference, created_at, week_start)
    SELECT ?, user_id, 'score', ?, '예굼쿠지 등급 보상', ?, created_at, ? FROM shop_purchases WHERE id = ?`)
    .bind(crypto.randomUUID(), reward.score, `kuji:score:${attempt}`, weekStart(now), attempt));
  for (const [item, amount] of [['lotto_ticket', reward.lottoTickets], ['speetto_ticket', reward.speettoTickets]] as const) {
    if (amount) writes.push(db.prepare(`INSERT OR IGNORE INTO inventory_ledger (id, user_id, item, amount, reason, reference, created_at)
      SELECT ?, user_id, ?, ?, '예굼쿠지 등급 보상', ?, created_at FROM shop_purchases WHERE id = ?`)
      .bind(crypto.randomUUID(), item, amount, `kuji:${item}:${attempt}`, attempt));
  }
  writes.push(db.prepare(`INSERT OR IGNORE INTO ledger (id, user_id, currency, amount, reason, reference, created_at)
    SELECT ?, user_id, 'gold', ?, '예굼쿠지 라스트원', ?, created_at FROM shop_purchases WHERE id = ? AND last_one = 1`)
    .bind(crypto.randomUUID(), KUJI_RULES.lastOneGold, `kuji:last:${board.id}`, attempt));
  await db.batch(writes);
  return await previousPurchase(db, user, id, 'kuji', payload) ?? await rejectedPurchase(db, user, window.start, window.end);
}

export async function settleDueLotto(db: D1Database, now: Date): Promise<void> {
  const today = kstDate(now);
  const overdue = (await db.prepare('SELECT DISTINCT draw_date FROM lotto_tickets WHERE settled_at IS NULL AND draw_date <= ?')
    .bind(today).all<{ draw_date: string }>()).results;
  const dates = new Set(overdue.map(row => row.draw_date));
  if (now.getTime() >= kstTimestamp(today, LOTTO_RULES.drawTime)) dates.add(today);
  for (const date of [...dates].sort()) {
    const drawAt = kstTimestamp(date, LOTTO_RULES.drawTime);
    if (drawAt > now.getTime()) continue;
    const existing = await db.prepare('SELECT numbers FROM lotto_draws WHERE date = ?').bind(date).first<{ numbers: string }>();
    if (!existing) {
      const numbers = shuffled(Array.from({ length: LOTTO_RULES.maxNumber }, (_, index) => index + 1)).slice(0, LOTTO_RULES.pickCount).sort((left, right) => left - right);
      await db.prepare(`INSERT OR IGNORE INTO lotto_draws (date, numbers, created_at)
        SELECT ?, ?, ? WHERE unixepoch('now') * 1000 >= ?`).bind(date, JSON.stringify(numbers), now.toISOString(), drawAt).run();
    }
    const draw = await db.prepare('SELECT numbers FROM lotto_draws WHERE date = ?').bind(date).first<{ numbers: string }>();
    if (!draw) continue;
    const winning = JSON.parse(draw.numbers) as number[];
    const tickets = (await db.prepare(`SELECT t.id, t.numbers, p.user_id FROM lotto_tickets t JOIN shop_purchases p ON p.id = t.id
      WHERE t.draw_date = ? AND t.settled_at IS NULL`).bind(date).all<{ id: string; numbers: string; user_id: string }>()).results;
    for (const ticket of tickets) {
      const matches = (JSON.parse(ticket.numbers) as number[]).filter(number => winning.includes(number)).length;
      const prize = lottoPrize(matches);
      const writes: D1PreparedStatement[] = [];
      if (prize) writes.push(db.prepare(`INSERT OR IGNORE INTO ledger (id, user_id, currency, amount, reason, reference, created_at)
        VALUES (?, ?, 'gold', ?, ?, ?, ?)`)
        .bind(crypto.randomUUID(), ticket.user_id, prize, `데일리 로또 ${lottoRank(matches)}등`, `lotto:prize:${ticket.id}`, now.toISOString()));
      writes.push(db.prepare('UPDATE lotto_tickets SET matches = ?, rank = ?, prize = ?, settled_at = ? WHERE id = ? AND settled_at IS NULL')
        .bind(matches, lottoRank(matches), prize, now.toISOString(), ticket.id));
      await db.batch(writes);
    }
  }
}

function simplePurchaseStatement(db: D1Database, user: ShopUser, id: string, kind: 'lotto' | 'speetto', payload: string, method: ShopPayment,
  price: number, outcome: string, attempt: string, now: Date, start: number, end: number): D1PreparedStatement {
  return db.prepare(`INSERT OR IGNORE INTO shop_purchases (id, user_id, request_id, kind, request_payload, payment, cost, date, created_at, outcome)
    SELECT ?, u.id, ?, ?, ?, ?, ?, ?, ?, ? FROM users u
    WHERE u.id = ? AND u.role = 'player' AND u.active = 1
      AND unixepoch('now') * 1000 >= ? AND unixepoch('now') * 1000 < ?
      AND ((? = 'gold' AND COALESCE((SELECT SUM(amount) FROM ledger WHERE user_id = u.id AND currency = 'gold'), 0) >= ?)
        OR (? = 'ticket' AND COALESCE((SELECT SUM(amount) FROM inventory_ledger WHERE user_id = u.id AND item = ?), 0) >= 1))`)
    .bind(attempt, id, kind, payload, method, method === 'gold' ? price : 0, kstDate(now), now.toISOString(), outcome,
      user.id, start, end, method, price, method, `${kind}_ticket`);
}
async function buyLotto(db: D1Database, user: ShopUser, input: Record<string, unknown>, now: Date): Promise<PurchaseRow> {
  const id = requestId(input); const method = payment(input);
  if (!Array.isArray(input.numbers) || input.numbers.length !== LOTTO_RULES.pickCount
    || input.numbers.some(value => !Number.isInteger(value) || value < 1 || value > LOTTO_RULES.maxNumber)
    || new Set(input.numbers).size !== LOTTO_RULES.pickCount) throw new ShopError(400, 'INVALID_LOTTO_NUMBERS', '서로 다른 로또 번호를 골라 주세요.');
  const numbers = [...input.numbers as number[]].sort((left, right) => left - right);
  const payload = JSON.stringify({ numbers, payment: method });
  const previous = await previousPurchase(db, user, id, 'lotto', payload);
  if (previous) return previous;
  const drawDate = targetDrawDate(now); const drawAt = kstTimestamp(drawDate, LOTTO_RULES.drawTime);
  const window = dayWindow(now); const start = Math.max(window.start, drawAt - 86_400_000); const end = Math.min(window.end, drawAt);
  const attempt = crypto.randomUUID();
  await db.batch([
    simplePurchaseStatement(db, user, id, 'lotto', payload, method, LOTTO_RULES.price, JSON.stringify({ drawDate, numbers }), attempt, now, start, end),
    ...chargeStatements(db, attempt, 'lotto'),
    db.prepare(`INSERT INTO lotto_tickets (id, draw_date, numbers) SELECT id, ?, ? FROM shop_purchases WHERE id = ?`)
      .bind(drawDate, JSON.stringify(numbers), attempt),
  ]);
  return await previousPurchase(db, user, id, 'lotto', payload) ?? await rejectedPurchase(db, user, start, end);
}
function lottoTicket(row: LottoRow): LottoTicket {
  return { id: row.id, requestId: row.request_id, drawDate: row.draw_date, numbers: JSON.parse(row.numbers) as number[], payment: row.payment, cost: row.cost,
    winningNumbers: row.winning_numbers == null ? null : JSON.parse(row.winning_numbers) as number[], matches: row.matches, rank: row.rank, prize: row.prize };
}
async function readLottoTickets(db: D1Database, userId: string, now: Date): Promise<LottoTicket[]> {
  const rows = (await db.prepare(`SELECT p.*, t.draw_date, t.numbers, t.matches, t.rank, t.prize, d.numbers AS winning_numbers
    FROM lotto_tickets t JOIN shop_purchases p ON p.id = t.id LEFT JOIN lotto_draws d ON d.date = t.draw_date
    WHERE p.user_id = ? ORDER BY p.created_at DESC, p.id`).bind(userId).all<LottoRow>()).results;
  return rows.map(row => lottoTicket(kstTimestamp(row.draw_date, LOTTO_RULES.drawTime) <= now.getTime() ? row : { ...row, winning_numbers: null, matches: null, rank: null, prize: null }));
}

function speettoTicket(row: PurchaseRow): SpeettoTicket {
  const result = JSON.parse(row.outcome) as { cells: SpeettoSymbol[]; won: boolean; prize: number };
  return { ...result, id: row.id, requestId: row.request_id, payment: row.payment, cost: row.cost, createdAt: row.created_at };
}
async function buySpeetto(db: D1Database, user: ShopUser, input: Record<string, unknown>, now: Date): Promise<PurchaseRow> {
  const id = requestId(input); const method = payment(input); const payload = JSON.stringify({ payment: method });
  const previous = await previousPurchase(db, user, id, 'speetto', payload);
  if (previous) return previous;
  const won = randomInt(100) < SPEETTO_RULES.winPercent;
  const characters = SPEETTO_RULES.characters;
  const first = randomInt(characters.length);
  const cells: SpeettoSymbol[] = won ? Array<SpeettoSymbol>(3).fill(characters[first]!)
    : [characters[first]!, characters[randomInt(characters.length)]!, characters[randomInt(characters.length)]!];
  if (!won && cells.every(cell => cell === cells[0])) cells[2] = characters[(first + 1 + randomInt(characters.length - 1)) % characters.length]!;
  const prize = won ? SPEETTO_RULES.prize : 0;
  const attempt = crypto.randomUUID(); const window = dayWindow(now);
  const writes = [simplePurchaseStatement(db, user, id, 'speetto', payload, method, SPEETTO_RULES.price, JSON.stringify({ cells, won, prize }), attempt, now, window.start, window.end),
    ...chargeStatements(db, attempt, 'speetto')];
  if (prize) writes.push(grantGold(db, attempt, prize, '스피또 당첨', `speetto:prize:${attempt}`));
  await db.batch(writes);
  return await previousPurchase(db, user, id, 'speetto', payload) ?? await rejectedPurchase(db, user, window.start, window.end);
}

export async function shopRoute(db: D1Database, user: ShopUser, path: string, method: string, input: Record<string, unknown> | undefined, now: Date): Promise<ShopState | KujiResponse | LottoResponse | SpeettoResponse> {
  if (method !== 'GET' && method !== 'POST') throw new ShopError(405, 'METHOD_NOT_ALLOWED', '지원하지 않는 요청이에요.');
  if (method === 'POST' && user.role !== 'player') throw new ShopError(403, 'CANNOT_PURCHASE', '플레이어만 구매할 수 있어요.');
  await settleDueLotto(db, now);
  if (path === '/api/shop' && method === 'GET') return readShopState(db, user, now);
  if (path === '/api/shop/kuji') {
    const purchase = method === 'POST' ? await buyKuji(db, user, input!, now) : undefined;
    const receipt = purchase && kujiReceipt(purchase);
    const board = receipt ? await db.prepare('SELECT id, grades FROM kuji_boards WHERE id = ?').bind(receipt.boardId).first<BoardRow>() : undefined;
    return { ...await readShopState(db, user, now), kuji: await readKuji(db, user, now, board ?? undefined), ...(receipt ? { purchase: receipt } : {}) };
  }
  if (path === '/api/shop/lotto') {
    const purchase = method === 'POST' ? await buyLotto(db, user, input!, now) : undefined;
    const tickets = await readLottoTickets(db, user.id, now);
    const today = kstDate(now);
    const draw = now.getTime() >= kstTimestamp(today, LOTTO_RULES.drawTime)
      ? await db.prepare('SELECT numbers FROM lotto_draws WHERE date = ?').bind(today).first<{ numbers: string }>() : null;
    return { ...await readShopState(db, user, now), lotto: { targetDrawDate: targetDrawDate(now), todayDraw: { date: today, numbers: draw ? JSON.parse(draw.numbers) as number[] : null }, tickets },
      ...(purchase ? { purchase: tickets.find(ticket => ticket.id === purchase.id)! } : {}) };
  }
  if (path === '/api/shop/speetto') {
    const purchase = method === 'POST' ? await buySpeetto(db, user, input!, now) : undefined;
    const rows = (await db.prepare("SELECT * FROM shop_purchases WHERE user_id = ? AND kind = 'speetto' ORDER BY created_at DESC, id")
      .bind(user.id).all<PurchaseRow>()).results;
    return { ...await readShopState(db, user, now), speetto: { tickets: rows.map(speettoTicket) }, ...(purchase ? { purchase: speettoTicket(purchase) } : {}) };
  }
  throw new ShopError(404, 'NOT_FOUND', '요청한 상점 기능이 없어요.');
}
