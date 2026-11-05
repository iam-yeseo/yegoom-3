import { STOCK_RULES, isTicker, stockInfo, type Ticker } from '../shared/stocks';
import { isTradingDay, isWeekend, kstDateOf, kstTimestamp, marketStatus, tradesOn } from '../shared/market-calendar';
import { advanceMarket, advanceStart, latestTickAt, marketSteps, marketVersion, nextTickAt, type PendingEvent, type StockRow, type StockStatus } from '../shared/stock-market';
import { GAME_STOCK, STOCK_GAME_RULES, gameArticle, gameEffectBp, gameForTicker, isAuthorOf, usualTime } from '../shared/stock-games';
import { GAME_RULES } from '../shared/balance';
import type { GameId } from '../shared/types';
import { readGameRules } from './game-settings';
import { AI_RULES } from '../shared/balance';
import { writeCloseNews, writeMorningNews, type AiWriters } from './stock-ai';
import type { Candle, MarketClock, MarketHoliday, StockDetailView, StockHomeSummary, StockMarketView, StockNewsItem, StockNewsKind, StockNewsPage, StockQuote, StockTradeResponse, StockTradeView, StockUnchanged } from '../shared/stock-types';

export interface StockUser { id: string; role: 'player' | 'admin'; username: string }
export class StockError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); }
}

interface StateRow {
  ticker: Ticker; price: number; prev_close: number; day_open: number | null; day_high: number | null; day_low: number | null;
  status: StockStatus; warning_since: string | null; delisted_on: string | null; relist_on: string | null;
  last_tick_at: number; version: number;
}
interface HoldingRow { ticker: Ticker; quantity: number; cost_basis: number }
interface NewsRow { id: string; ticker: Ticker | null; kind: StockNewsKind; headline: string; body: string; publish_at: number; effect_bp: number | null; source: 'ai' | 'template' }
interface TradeRow { id: string; request_id: string; ticker: Ticker; side: 'buy' | 'sell' | 'delist'; quantity: number; price: number; fee: number; total: number; cost_basis: number; created_at: string }

const fromState = (row: StateRow): StockRow => ({
  ticker: row.ticker, price: row.price, prevClose: row.prev_close, dayOpen: row.day_open, dayHigh: row.day_high, dayLow: row.day_low,
  status: row.status, warningSince: row.warning_since, delistedOn: row.delisted_on, relistOn: row.relist_on,
  lastTickAt: row.last_tick_at, version: row.version,
});
const newsView = (row: NewsRow): StockNewsItem => ({
  id: row.id, ticker: row.ticker, kind: row.kind, headline: row.headline, body: row.body,
  publishAt: new Date(row.publish_at).toISOString(), effectBp: row.effect_bp, source: row.source,
});
const tradeView = (row: TradeRow): StockTradeView => ({
  id: row.id, requestId: row.request_id, ticker: row.ticker, side: row.side, quantity: row.quantity, price: row.price,
  fee: row.fee, total: row.total, costBasis: row.cost_basis, createdAt: row.created_at,
});

/** The secret day seed: HMAC-SHA256(STOCK_SEED_SECRET, "stock|date"). Neither the
 * code nor the database is enough to predict a future price. */
export async function daySeeds(secret: string, dates: readonly string[]): Promise<Map<string, string>> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const seeds = await Promise.all(dates.map(async date => {
    const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`stock|${date}`)));
    return [date, Array.from(mac, byte => byte.toString(16).padStart(2, '0')).join('')] as const;
  }));
  return new Map(seeds);
}
export function stockSecret(secret: string | undefined): string {
  if (!secret || secret.length < 16) throw new StockError(503, 'STOCK_UNAVAILABLE', '주식 시장을 준비하고 있어요. 잠시 뒤 다시 와 주세요.');
  return secret;
}

export async function readHolidays(db: D1Database, from: string): Promise<Map<string, string>> {
  const rows = await db.prepare('SELECT date, reason FROM market_holidays WHERE date >= ? ORDER BY date').bind(from).all<MarketHoliday>();
  return new Map(rows.results.map(row => [row.date, row.reason]));
}

interface Market { rows: StockRow[]; holidays: Map<string, string> }
interface EventRow { id: string; ticker: Ticker; kind: string; effectBp: number; applyAt: number; context_json: string }
interface PublishedRound { game_id: GameId; round_date: string; answer: string; published_at: number }
const eventOf = (row: EventRow): PendingEvent => {
  const context = JSON.parse(row.context_json || '{}') as { headline?: string; body?: string };
  return { id: row.id, ticker: row.ticker, kind: row.kind, effectBp: row.effectBp, applyAt: row.applyAt, headline: context.headline, body: context.body };
};
/** Turn newly published game results into price events (§7). The event time is
 * the publication time: during market hours the stock moves at that instant,
 * otherwise at the next open. Runs on any stock read, the Cron and right after
 * a game write, so a failed run is simply retried. */
async function createGameEvents(db: D1Database, rounds: readonly PublishedRound[], now: number): Promise<void> {
  const inserts: D1PreparedStatement[] = [];
  for (const round of rounds) {
    const author = GAME_RULES[round.game_id].author;
    const [history, person] = await db.batch([
      db.prepare(`SELECT answer FROM game_rounds WHERE game_id = ? AND round_date < ? AND answer IS NOT NULL
        AND (revealed_at IS NOT NULL OR reveal_at <= ?) ORDER BY round_date DESC LIMIT ?`)
        .bind(round.game_id, round.round_date, now, STOCK_GAME_RULES.baselineRounds),
      db.prepare('SELECT display_name FROM users WHERE username = ? COLLATE NOCASE').bind(author),
    ]);
    const usual = round.game_id === 'luck' ? null : usualTime((history!.results as { answer: string }[]).map(row => row.answer), round.game_id);
    const effectBp = gameEffectBp(round.game_id, round.answer, usual ?? undefined);
    const name = (person!.results[0] as { display_name: string } | undefined)?.display_name ?? author;
    const article = gameArticle(round.game_id, round.answer, name, usual, effectBp);
    inserts.push(db.prepare(`INSERT OR IGNORE INTO stock_events (id, ticker, kind, effect_bp, apply_at, context_json, created_at)
      VALUES (?, ?, 'game', ?, ?, ?, ?)`).bind(`game:${round.game_id}:${round.round_date}`, GAME_STOCK[round.game_id], effectBp, round.published_at,
      JSON.stringify({ game: round.game_id, date: round.round_date, answer: round.answer, usual, ...article }), new Date(now).toISOString()));
  }
  await db.batch(inserts);
}
/** Bring prices up to `now`: replays every missing tick (at most 60 per call) in
 * one batch. Every dependent write is guarded by this run's writer token, so a
 * concurrent run that lost the race changes nothing. */
export async function advanceStocks(db: D1Database, secret: string, now: number): Promise<Market> {
  const holidayFrom = kstDateOf(now - 40 * 86_400_000);
  const pendingEvents = db.prepare(`SELECT id, ticker, kind, effect_bp AS effectBp, apply_at AS applyAt, context_json FROM stock_events
    WHERE applied_at IS NULL AND apply_at <= ? ORDER BY apply_at, id`).bind(now);
  const [stateResult, holidayResult, roundResult, eventResult] = await db.batch([
    db.prepare('SELECT * FROM stock_state ORDER BY rowid'),
    db.prepare('SELECT date, reason FROM market_holidays WHERE date >= ? ORDER BY date').bind(holidayFrom),
    // Published game results that have no stock event yet (idempotent by id).
    db.prepare(`SELECT r.game_id, r.round_date, r.answer, COALESCE(r.revealed_at, r.reveal_at) AS published_at FROM game_rounds r
      WHERE r.answer IS NOT NULL AND (r.revealed_at IS NOT NULL OR r.reveal_at <= ?) AND r.round_date >= ?
        AND NOT EXISTS (SELECT 1 FROM stock_events e WHERE e.id = 'game:' || r.game_id || ':' || r.round_date)`)
      .bind(now, kstDateOf(now - STOCK_GAME_RULES.lookbackDays * 86_400_000)),
    pendingEvents,
  ]);
  const rows = (stateResult!.results as StateRow[]).map(fromState);
  const holidays = new Map((holidayResult!.results as MarketHoliday[]).map(row => [row.date, row.reason]));
  if (!rows.length) throw new StockError(503, 'STOCK_UNAVAILABLE', '주식 시장을 준비하고 있어요. 잠시 뒤 다시 와 주세요.');
  let eventRows = eventResult!.results as EventRow[];
  if (roundResult!.results.length) {
    await createGameEvents(db, roundResult!.results as PublishedRound[], now);
    eventRows = (await pendingEvents.all<EventRow>()).results;
  }
  const events = eventRows.map(eventOf);
  const lastTickAt = Math.min(...rows.map(row => row.lastTickAt));
  const ticks = marketSteps(advanceStart(lastTickAt, now), now, holidays, events);
  if (!ticks.length) return { rows, holidays };
  const seeds = await daySeeds(secret, [...new Set(ticks.map(tick => tick.date))]);
  const result = advanceMarket(rows, ticks, date => seeds.get(date)!, events, holidays);
  const token = crypto.randomUUID();
  const createdAt = new Date(now).toISOString();
  const won = 'EXISTS (SELECT 1 FROM stock_state WHERE writer = ?)';
  const field = (name: string) => `json_extract(value, '$.${name}')`;
  const statements = [
    db.prepare(`UPDATE stock_state SET price = j.price, prev_close = j.prevClose, day_open = j.dayOpen, day_high = j.dayHigh,
        day_low = j.dayLow, status = j.status, warning_since = j.warningSince, delisted_on = j.delistedOn, relist_on = j.relistOn,
        last_tick_at = j.lastTickAt, version = j.version, writer = ?
      FROM (SELECT ${['ticker', 'price', 'prevClose', 'dayOpen', 'dayHigh', 'dayLow', 'status', 'warningSince', 'delistedOn', 'relistOn', 'lastTickAt', 'version', 'previousVersion', 'previousTickAt']
        .map(name => `${field(name)} AS ${name}`).join(', ')} FROM json_each(?)) AS j
      WHERE stock_state.ticker = j.ticker AND stock_state.version = j.previousVersion AND stock_state.last_tick_at = j.previousTickAt`)
      .bind(token, JSON.stringify(result.rows.map((row, index) => ({ ...row, previousVersion: rows[index]!.version, previousTickAt: rows[index]!.lastTickAt })))),
    db.prepare(`INSERT OR IGNORE INTO stock_ticks (ticker, at, price)
      SELECT ${field('ticker')}, ${field('at')}, ${field('price')} FROM json_each(?) WHERE ${won}`)
      .bind(JSON.stringify(result.ticks), token),
  ];
  if (result.daily.length) statements.push(db.prepare(`INSERT OR REPLACE INTO stock_daily (ticker, date, open, high, low, close)
    SELECT ${['ticker', 'date', 'open', 'high', 'low', 'close'].map(field).join(', ')} FROM json_each(?) WHERE ${won}`)
    .bind(JSON.stringify(result.daily), token));
  if (result.news.length) statements.push(db.prepare(`INSERT OR IGNORE INTO stock_news (id, event_id, ticker, kind, publish_at, headline, body, effect_bp, source, created_at)
    SELECT ${field('id')}, CASE WHEN ${field('id')} LIKE 'event:%' THEN substr(${field('id')}, 7) END,
      ${['ticker', 'kind', 'publishAt', 'headline', 'body', 'effectBp'].map(field).join(', ')}, 'template', ? FROM json_each(?) WHERE ${won}`)
    .bind(createdAt, JSON.stringify(result.news), token));
  if (result.appliedEvents.length) statements.push(db.prepare(`UPDATE stock_events SET applied_at = j.at
    FROM (SELECT ${field('id')} AS id, ${field('at')} AS at FROM json_each(?)) AS j
    WHERE stock_events.id = j.id AND stock_events.applied_at IS NULL AND ${won}`)
    .bind(JSON.stringify(result.appliedEvents), token));
  if (result.delisted.length) {
    // Holders lose the shares; a 'delist' trade row keeps it in their history. No gold moves.
    const delisted = JSON.stringify(result.delisted);
    statements.push(
      db.prepare(`INSERT OR IGNORE INTO stock_trades (id, user_id, request_id, ticker, side, quantity, price, fee, total, cost_basis, date, created_at)
        SELECT lower(hex(randomblob(16))), h.user_id, 'delist:' || h.ticker || ':' || ${field('date')}, h.ticker, 'delist', h.quantity,
          s.price, 0, 0, h.cost_basis, ${field('date')}, ?
        FROM json_each(?) JOIN stock_holdings h ON h.ticker = ${field('ticker')} AND h.quantity > 0
        JOIN stock_state s ON s.ticker = h.ticker
        WHERE ${won}`).bind(createdAt, delisted, token),
      db.prepare(`UPDATE stock_holdings SET quantity = 0, cost_basis = 0
        WHERE quantity > 0 AND ticker IN (SELECT ${field('ticker')} FROM json_each(?)) AND ${won}`).bind(delisted, token),
    );
  }
  const writes = await db.batch(statements);
  if (writes[0]!.meta.changes === rows.length) return { rows: result.rows, holidays };
  // Another run advanced first; its result is identical for the same ticks.
  const current = await db.prepare('SELECT * FROM stock_state ORDER BY rowid').all<StateRow>();
  return { rows: current.results.map(fromState), holidays };
}

export const AUTHOR_LOCK_MESSAGE = '오늘은 출제자라서 거래할 수 없어요 · 결과 반영 후 거래 가능';
/** §7-3: a game's author cannot trade its stock from 00:00 of a game day until
 * that day's result has moved the price (often the next trading day's open). */
async function authorLocked(db: D1Database, user: StockUser, ticker: Ticker, now: number): Promise<boolean> {
  const game = gameForTicker(ticker);
  if (!game || user.role !== 'player' || !isAuthorOf(user.username, game)) return false;
  const today = kstDateOf(now);
  const row = (await db.prepare(`SELECT
      EXISTS (SELECT 1 FROM stock_events WHERE ticker = ? AND kind = 'game' AND applied_at IS NULL) AS pending,
      EXISTS (SELECT 1 FROM stock_events WHERE id = ? AND applied_at IS NOT NULL) AS applied,
      (SELECT settings_json FROM game_rounds WHERE game_id = ? AND round_date = ?) AS snapshot`)
    .bind(ticker, `game:${game}:${today}`, game, today).first<{ pending: number; applied: number; snapshot: string | null }>())!;
  if (row.pending) return true;
  if (row.applied) return false;
  return (await readGameRules(db, game, today, row.snapshot)).enabled;
}

function clock(now: number, holidays: ReadonlyMap<string, string>): MarketClock {
  const status = marketStatus(now, holidays);
  const next = nextTickAt(now, holidays);
  return { open: status.open, date: status.date, holiday: status.holiday, opensAt: new Date(status.opensAt).toISOString(),
    closesAt: new Date(status.closesAt).toISOString(), nextTickAt: next === null ? null : new Date(next).toISOString() };
}
function quote(row: StockRow, date: string, holding?: HoldingRow): StockQuote {
  return { ticker: row.ticker, price: row.price, prevClose: row.prevClose, dayOpen: row.dayOpen, dayHigh: row.dayHigh, dayLow: row.dayLow,
    status: row.status, halted: !tradesOn(row.ticker, date), warningSince: row.warningSince, delistedOn: row.delistedOn,
    relistOn: row.relistOn, version: row.version, held: holding?.quantity ?? 0, costBasis: holding?.cost_basis ?? 0 };
}
const VISIBLE_NEWS = 'publish_at <= ? AND hidden = 0 AND (audience_user_id IS NULL OR audience_user_id = ?)';

export async function readStockMarket(db: D1Database, secret: string, user: StockUser, now: number, since?: string): Promise<StockMarketView | StockUnchanged> {
  const { rows, holidays } = await advanceStocks(db, secret, now);
  const version = marketVersion(rows);
  const market = clock(now, holidays);
  const serverTime = new Date(now).toISOString();
  if (since === version) return { unchanged: true, version, market, serverTime };
  const [holdings, news, gold, closingRows] = await db.batch([
    db.prepare('SELECT ticker, quantity, cost_basis FROM stock_holdings WHERE user_id = ?').bind(user.id),
    db.prepare(`SELECT id, ticker, kind, headline, body, publish_at, effect_bp, source FROM stock_news WHERE ${VISIBLE_NEWS}
      AND kind NOT IN ('close', 'comment', 'weekly') ORDER BY publish_at DESC, id DESC LIMIT 5`).bind(now, user.id),
    db.prepare('SELECT gold FROM user_balances WHERE user_id = ?').bind(user.id),
    // The latest closing articles (one publish time); empty work while the market is open.
    db.prepare(`SELECT id, ticker, kind, headline, body, publish_at, effect_bp, source FROM stock_news WHERE ${VISIBLE_NEWS}
      AND kind IN ('close', 'comment', 'weekly') AND ? = 0 ORDER BY publish_at DESC LIMIT 3`).bind(now, user.id, market.open ? 1 : 0),
  ]);
  const held = new Map((holdings!.results as HoldingRow[]).map(row => [row.ticker, row]));
  const closingNews = (closingRows!.results as NewsRow[]).filter((row, _, all) => row.publish_at === all[0]!.publish_at).map(newsView);
  const closing = market.open ? null : { summary: closingNews.find(item => item.kind === 'close') ?? null,
    comment: closingNews.find(item => item.kind === 'comment') ?? null, weekly: closingNews.find(item => item.kind === 'weekly') ?? null };
  return { market, version, stocks: rows.map(row => quote(row, market.date, held.get(row.ticker))), news: (news!.results as NewsRow[]).map(newsView), closing,
    gold: (gold!.results[0] as { gold: number } | undefined)?.gold ?? 0, canTrade: user.role === 'player', serverTime };
}

export async function readStockDetail(db: D1Database, secret: string, user: StockUser, ticker: string, now: number): Promise<StockDetailView> {
  if (!isTicker(ticker)) throw new StockError(404, 'UNKNOWN_STOCK', '없는 종목이에요.');
  const { rows, holidays } = await advanceStocks(db, secret, now);
  const row = rows.find(item => item.ticker === ticker)!;
  const [ticks, daily, news, trades, holding, gold] = await db.batch([
    // The latest trading day of this stock: a day spans 09:00–18:00.
    db.prepare(`SELECT at, price FROM stock_ticks WHERE ticker = ?
      AND at >= (SELECT MAX(at) FROM stock_ticks WHERE ticker = ? AND at <= ?) - 9 * 3600000 AND at <= ? ORDER BY at`).bind(ticker, ticker, now, now),
    db.prepare('SELECT date, open, high, low, close FROM stock_daily WHERE ticker = ? ORDER BY date DESC LIMIT 22').bind(ticker),
    db.prepare(`SELECT id, ticker, kind, headline, body, publish_at, effect_bp, source FROM stock_news
      WHERE ticker = ? AND ${VISIBLE_NEWS} ORDER BY publish_at DESC, id DESC LIMIT 10`).bind(ticker, now, user.id),
    db.prepare('SELECT * FROM stock_trades WHERE user_id = ? AND ticker = ? ORDER BY created_at DESC, id DESC LIMIT 10').bind(user.id, ticker),
    db.prepare('SELECT ticker, quantity, cost_basis FROM stock_holdings WHERE user_id = ? AND ticker = ?').bind(user.id, ticker),
    db.prepare('SELECT gold FROM user_balances WHERE user_id = ?').bind(user.id),
  ]);
  const market = clock(now, holidays);
  return {
    market, version: marketVersion(rows), stock: quote(row, market.date, holding!.results[0] as HoldingRow | undefined),
    ticks: ticks!.results as { at: number; price: number }[], daily: (daily!.results as Candle[]).reverse(),
    news: (news!.results as NewsRow[]).map(newsView), trades: (trades!.results as TradeRow[]).map(tradeView),
    gold: (gold!.results[0] as { gold: number } | undefined)?.gold ?? 0, canTrade: user.role === 'player',
    tradeBlock: await authorLocked(db, user, ticker, now) ? AUTHOR_LOCK_MESSAGE : null,
    serverTime: new Date(now).toISOString(),
  };
}

/** News newest first; `before` is the previous page's cursor (`publishAt|id`). */
export async function readStockNews(db: D1Database, secret: string, user: StockUser, before: string | null, now: number): Promise<StockNewsPage> {
  await advanceStocks(db, secret, now);
  const cursor = before === null ? null : /^(\d{1,16})\|([\w:.-]{1,128})$/.exec(before);
  if (before !== null && !cursor) throw new StockError(400, 'INVALID_CURSOR', '뉴스 위치를 확인해 주세요.');
  const limit = 30;
  const rows = await db.prepare(`SELECT id, ticker, kind, headline, body, publish_at, effect_bp, source FROM stock_news
    WHERE ${VISIBLE_NEWS} AND (? IS NULL OR publish_at < ? OR (publish_at = ? AND id < ?))
    ORDER BY publish_at DESC, id DESC LIMIT ?`)
    .bind(now, user.id, cursor ? 1 : null, cursor ? Number(cursor[1]) : 0, cursor ? Number(cursor[1]) : 0, cursor?.[2] ?? '', limit + 1).all<NewsRow>();
  const page = rows.results.slice(0, limit);
  const last = page[page.length - 1];
  return { news: page.map(newsView), nextBefore: rows.results.length > limit && last ? `${last.publish_at}|${last.id}` : null, serverTime: new Date(now).toISOString() };
}

function tradeInput(input: Record<string, unknown>) {
  const { requestId, ticker, side, quantity, expectedVersion } = input;
  if (typeof requestId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(requestId)) throw new StockError(400, 'INVALID_REQUEST_ID', '주문 번호를 확인해 주세요.');
  if (!isTicker(ticker)) throw new StockError(400, 'UNKNOWN_STOCK', '없는 종목이에요.');
  if (side !== 'buy' && side !== 'sell') throw new StockError(400, 'INVALID_SIDE', '사기 또는 팔기를 골라 주세요.');
  if (!Number.isInteger(quantity) || (quantity as number) < 1 || (quantity as number) > STOCK_RULES.maxOrder) {
    throw new StockError(400, 'INVALID_QUANTITY', `한 번에 1주부터 ${STOCK_RULES.maxOrder}주까지 거래할 수 있어요.`);
  }
  if (!Number.isSafeInteger(expectedVersion) || (expectedVersion as number) < 0) throw new StockError(400, 'INVALID_VERSION', '가격 정보를 새로 불러와 주세요.');
  return { requestId, ticker, side, quantity: quantity as number, expectedVersion: expectedVersion as number };
}

async function tradeResponse(db: D1Database, user: StockUser, trade: TradeRow, row: StockRow, date: string, replayed: boolean): Promise<StockTradeResponse> {
  const [holding, gold] = await db.batch([
    db.prepare('SELECT ticker, quantity, cost_basis FROM stock_holdings WHERE user_id = ? AND ticker = ?').bind(user.id, trade.ticker),
    db.prepare('SELECT gold FROM user_balances WHERE user_id = ?').bind(user.id),
  ]);
  return { trade: tradeView(trade), stock: quote(row, date, holding!.results[0] as HoldingRow | undefined),
    gold: (gold!.results[0] as { gold: number } | undefined)?.gold ?? 0, replayed };
}

/** Buy or sell at the current server price. Balance, holding, market hours, stock
 * status and price version are checked inside the same conditional batch that
 * writes the trade, the ledger and the holding. A repeated requestId replays. */
export async function tradeStock(db: D1Database, secret: string, user: StockUser, input: Record<string, unknown>, now: number): Promise<StockTradeResponse> {
  if (user.role !== 'player') throw new StockError(403, 'CANNOT_TRADE', '플레이어만 주식을 거래할 수 있어요.');
  const order = tradeInput(input);
  const previous = await db.prepare('SELECT * FROM stock_trades WHERE user_id = ? AND request_id = ?').bind(user.id, order.requestId).first<TradeRow>();
  const { rows, holidays } = await advanceStocks(db, secret, now);
  const date = kstDateOf(now);
  const row = rows.find(item => item.ticker === order.ticker)!;
  if (previous) {
    if (previous.ticker !== order.ticker || previous.side !== order.side || previous.quantity !== order.quantity) {
      throw new StockError(409, 'REQUEST_CONFLICT', '이미 다른 주문에 사용한 주문 번호예요.');
    }
    return tradeResponse(db, user, previous, row, date, true);
  }
  const status = marketStatus(now, holidays);
  if (!status.open) throw new StockError(409, 'MARKET_CLOSED', status.holiday ? `오늘은 ${status.holiday} 휴장이에요.` : '지금은 장이 닫혀 있어요.');
  if (!tradesOn(order.ticker, date)) throw new StockError(409, 'TRADING_HALTED', '겨울 근무 중이라 오늘은 거래할 수 없어요.');
  if (row.status === 'delisted') throw new StockError(409, 'DELISTED', '상장폐지된 종목은 거래할 수 없어요.');
  if (await authorLocked(db, user, order.ticker, now)) throw new StockError(409, 'AUTHOR_LOCKED', AUTHOR_LOCK_MESSAGE);
  if (row.version !== order.expectedVersion) {
    throw new StockError(409, 'PRICE_CHANGED', `가격이 ${row.price.toLocaleString('ko-KR')}G로 바뀌었어요. 확인하고 다시 주문해 주세요.`);
  }
  const tick = latestTickAt(now, holidays)!;
  const windowEnd = Math.min(tick + STOCK_RULES.tickMinutes * 60_000, status.closesAt);
  const id = crypto.randomUUID();
  const createdAt = new Date(now).toISOString();
  const name = stockInfo(order.ticker)!.name;
  const buy = order.side === 'buy';
  const q = order.quantity;
  // SQL fragments with their parameters, so the price is read inside the write.
  // D1 binds JavaScript numbers as REAL, so every bound count is cast to keep
  // the integer division (fee rounding, proportional cost basis) exact.
  const amount = { sql: 's.price * CAST(? AS INTEGER)', args: [q] };
  const fee = { sql: `MAX(1, (${amount.sql} + 99) / 100)`, args: [q] };
  const cost = { sql: `${amount.sql} + ${fee.sql}`, args: [q, q] };
  const total = buy ? cost : { sql: `MAX(0, ${amount.sql} - ${fee.sql})`, args: [q, q] };
  const basis = buy ? cost : { sql: 'h.cost_basis * CAST(? AS INTEGER) / h.quantity', args: [q] };
  const allowed = buy
    ? { sql: `COALESCE(b.gold, 0) >= ${cost.sql} AND COALESCE(h.quantity, 0) + CAST(? AS INTEGER) <= ?`, args: [q, q, q, STOCK_RULES.maxHolding] }
    : { sql: 'COALESCE(h.quantity, 0) >= ?', args: [q] };
  const writes = await db.batch([
    db.prepare(`INSERT OR IGNORE INTO stock_trades (id, user_id, request_id, ticker, side, quantity, price, fee, total, cost_basis, date, created_at)
      SELECT ?, u.id, ?, s.ticker, ?, CAST(? AS INTEGER), s.price, ${fee.sql}, ${total.sql}, ${basis.sql}, ?, ?
      FROM stock_state s JOIN users u ON u.id = ? AND u.role = 'player' AND u.active = 1
      LEFT JOIN user_balances b ON b.user_id = u.id
      LEFT JOIN stock_holdings h ON h.user_id = u.id AND h.ticker = s.ticker
      WHERE s.ticker = ? AND s.version = ? AND s.status != 'delisted' AND s.last_tick_at >= ?
        AND unixepoch('now') * 1000 >= ? AND unixepoch('now') * 1000 < ? AND ${allowed.sql}`)
      .bind(id, order.requestId, order.side, q, ...fee.args, ...total.args, ...basis.args, date, createdAt,
        user.id, order.ticker, order.expectedVersion, tick, tick, windowEnd, ...allowed.args),
    db.prepare(`INSERT OR IGNORE INTO ledger (id, user_id, currency, amount, reason, reference, created_at)
      SELECT ?, user_id, 'gold', ${buy ? '-total' : 'total'}, ?, 'stock:' || side || ':' || user_id || ':' || request_id, created_at
      FROM stock_trades WHERE id = ? AND total > 0`)
      .bind(crypto.randomUUID(), `주식 ${buy ? '매수' : '매도'} · ${name} ${order.quantity}주`, id),
    buy
      ? db.prepare(`INSERT INTO stock_holdings (user_id, ticker, quantity, cost_basis)
          SELECT user_id, ticker, quantity, cost_basis FROM stock_trades WHERE id = ?
          ON CONFLICT (user_id, ticker) DO UPDATE SET quantity = quantity + excluded.quantity, cost_basis = cost_basis + excluded.cost_basis`).bind(id)
      : db.prepare(`UPDATE stock_holdings SET quantity = stock_holdings.quantity - t.quantity, cost_basis = stock_holdings.cost_basis - t.cost_basis
          FROM (SELECT user_id, ticker, quantity, cost_basis FROM stock_trades WHERE id = ?) AS t
          WHERE stock_holdings.user_id = t.user_id AND stock_holdings.ticker = t.ticker`).bind(id),
  ]);
  if (writes[0]!.meta.changes === 1 && (q >= AI_RULES.whaleShares || row.price * q >= AI_RULES.whaleGold)) {
    // Anonymous whale news (no price effect), once an hour per person and stock.
    await db.prepare(`INSERT OR IGNORE INTO stock_news (id, ticker, kind, publish_at, headline, body, source, created_at)
      SELECT ?, ?, 'whale', ?, ?, ?, 'template', ? WHERE NOT EXISTS (
        SELECT 1 FROM stock_trades t WHERE t.user_id = ? AND t.ticker = ? AND t.id != ? AND t.side IN ('buy', 'sell')
          AND t.created_at >= ? AND (t.quantity >= ? OR t.price * t.quantity >= ?))`)
      .bind(`whale:${id}`, order.ticker, now, `익명의 큰손, ${name} ${q.toLocaleString('ko-KR')}주 ${buy ? '매수' : '매도'}`,
        `한 번에 ${(row.price * q).toLocaleString('ko-KR')}G어치가 ${buy ? '사들여졌다' : '팔려 나갔다'}. 누구인지는 아무도 모른다.`, createdAt,
        user.id, order.ticker, id, new Date(now - 3_600_000).toISOString(), AI_RULES.whaleShares, AI_RULES.whaleGold).run();
  }
  if (writes[0]!.meta.changes === 1) {
    const trade = (await db.prepare('SELECT * FROM stock_trades WHERE id = ?').bind(id).first<TradeRow>())!;
    return tradeResponse(db, user, trade, row, date, false);
  }
  return rejectTrade(db, user, order, row);
}

async function rejectTrade(db: D1Database, user: StockUser, order: ReturnType<typeof tradeInput>, row: StockRow): Promise<never> {
  const [replay, state, holding, gold] = await db.batch([
    db.prepare('SELECT * FROM stock_trades WHERE user_id = ? AND request_id = ?').bind(user.id, order.requestId),
    db.prepare('SELECT * FROM stock_state WHERE ticker = ?').bind(order.ticker),
    db.prepare('SELECT ticker, quantity, cost_basis FROM stock_holdings WHERE user_id = ? AND ticker = ?').bind(user.id, order.ticker),
    db.prepare('SELECT gold FROM user_balances WHERE user_id = ?').bind(user.id),
  ]);
  if (replay!.results.length) throw new StockError(409, 'REQUEST_IN_PROGRESS', '같은 주문을 처리하고 있어요. 잠시 뒤 다시 확인해 주세요.');
  const current = state!.results[0] as StateRow | undefined;
  if (!current || current.version !== order.expectedVersion || current.price !== row.price) {
    throw new StockError(409, 'PRICE_CHANGED', '가격이 바뀌었어요. 확인하고 다시 주문해 주세요.');
  }
  const held = (holding!.results[0] as HoldingRow | undefined)?.quantity ?? 0;
  if (order.side === 'sell') throw new StockError(409, 'NOT_ENOUGH_SHARES', `보유한 주식이 ${held}주예요.`);
  if (held + order.quantity > STOCK_RULES.maxHolding) throw new StockError(409, 'HOLDING_LIMIT', `한 종목은 ${STOCK_RULES.maxHolding}주까지 가질 수 있어요. 지금 ${held}주 보유 중이에요.`);
  const balance = (gold!.results[0] as { gold: number } | undefined)?.gold ?? 0;
  const amount = current.price * order.quantity;
  if (balance < amount + Math.max(1, Math.ceil(amount * STOCK_RULES.fee))) throw new StockError(409, 'NOT_ENOUGH_GOLD', '골드가 부족해요.');
  throw new StockError(409, 'MARKET_CHANGED', '장 상태가 바뀌었어요. 새로고침하고 다시 시도해 주세요.');
}

/** Home tile: no advance, just the stored prices (at most one tick behind). */
export async function readStockHome(db: D1Database, user: StockUser, now: number): Promise<StockHomeSummary> {
  const date = kstDateOf(now);
  // One statement: the aggregate always returns a row, with today's holiday reason.
  const sums = (await db.prepare(`SELECT COALESCE(SUM(CASE WHEN s.status != 'delisted' THEN h.quantity * s.price ELSE 0 END), 0) AS value,
      COALESCE(SUM(h.cost_basis), 0) AS cost, (SELECT reason FROM market_holidays WHERE date = ?) AS holiday
    FROM stock_holdings h JOIN stock_state s ON s.ticker = h.ticker WHERE h.user_id = ? AND h.quantity > 0`)
    .bind(date, user.id).first<{ value: number; cost: number; holiday: string | null }>())!;
  const status = marketStatus(now, new Map(sums.holiday ? [[date, sums.holiday]] : []));
  return { open: status.open, holiday: status.holiday, value: sums.value, cost: sums.cost };
}

// Administrator market holidays. Today can be added or removed only before the open.
export async function readMarketHolidays(db: D1Database, now: number): Promise<MarketHoliday[]> {
  return [...(await readHolidays(db, kstDateOf(now))).entries()].map(([date, reason]) => ({ date, reason }));
}
function editableDate(date: unknown, now: number): string {
  if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(`${date}T00:00:00Z`))) {
    throw new StockError(400, 'INVALID_DATE', '날짜를 확인해 주세요.');
  }
  const today = kstDateOf(now);
  if (date < today || (date === today && now >= kstTimestamp(today, STOCK_RULES.openTime))) {
    throw new StockError(409, 'MARKET_ALREADY_OPENED', '이미 장이 열린 날은 바꿀 수 없어요.');
  }
  if (date > kstDateOf(now + 366 * 86_400_000)) throw new StockError(400, 'INVALID_DATE', '1년 안의 날짜만 정할 수 있어요.');
  return date;
}
export async function addMarketHoliday(db: D1Database, user: StockUser, input: Record<string, unknown>, now: number): Promise<void> {
  const date = editableDate(input.date, now);
  const reason = typeof input.reason === 'string' ? input.reason.trim() : '';
  if (!reason || reason.length > 20) throw new StockError(400, 'INVALID_REASON', '휴장 이유를 20자 이내로 적어 주세요.');
  if (isWeekend(date)) throw new StockError(409, 'ALREADY_CLOSED', '주말은 원래 휴장이에요.');
  if (!isTradingDay(date)) throw new StockError(409, 'ALREADY_CLOSED', '이미 공휴일로 쉬는 날이에요.');
  // The SQL clock re-checks that the day's market has not opened yet.
  const result = await db.prepare(`INSERT OR IGNORE INTO market_holidays (date, reason, created_by, created_at)
    SELECT ?, ?, ?, ? WHERE unixepoch('now') * 1000 < ?`)
    .bind(date, reason, user.id, new Date(now).toISOString(), kstTimestamp(date, STOCK_RULES.openTime)).run();
  if (!result.meta.changes) throw new StockError(409, 'HOLIDAY_EXISTS', '이미 휴장일이거나 장이 열린 날이에요.');
}
export async function removeMarketHoliday(db: D1Database, date: string, now: number): Promise<void> {
  editableDate(date, now);
  const result = await db.prepare("DELETE FROM market_holidays WHERE date = ? AND unixepoch('now') * 1000 < ?")
    .bind(date, kstTimestamp(date, STOCK_RULES.openTime)).run();
  if (!result.meta.changes) throw new StockError(404, 'HOLIDAY_NOT_FOUND', '지울 수 있는 휴장일이 없어요.');
}

/** Cron: weekdays from the open through the close tick only. */
export function stockCronDue(now: number): boolean {
  const date = kstDateOf(now);
  const step = STOCK_RULES.tickMinutes * 60_000;
  // 08:50 writes the morning AI news; 09:00–18:00 are the ticks (18:00 also the close news).
  return !isWeekend(date) && now >= kstTimestamp(date, STOCK_RULES.openTime) - step && now < kstTimestamp(date, STOCK_RULES.closeTime) + step;
}

/** The 10-minute Cron: ticks, then the AI news batches at 08:50 and 18:00. */
export async function runStockCron(db: D1Database, secret: string, writers: AiWriters, now: number): Promise<void> {
  const { rows, holidays } = await advanceStocks(db, secret, now);
  const date = kstDateOf(now);
  if (!isTradingDay(date, holidays)) return;
  const time = new Date(now + 9 * 3_600_000).toISOString().slice(11, 16);
  if (time === '08:50') await writeMorningNews(db, writers, (await daySeeds(secret, [date])).get(date)!, date, rows, now);
  if (time === '18:00') await writeCloseNews(db, writers, date, rows, now);
}

// Administrator: published news only (never future), hide/show, and the AI switch.
export interface AdminStockNews { id: string; ticker: Ticker | null; kind: string; headline: string; publishAt: string; source: 'ai' | 'template'; hidden: boolean }
export async function readAdminStockNews(db: D1Database, now: number): Promise<AdminStockNews[]> {
  const rows = await db.prepare(`SELECT id, ticker, kind, headline, publish_at, source, hidden FROM stock_news
    WHERE publish_at <= ? AND audience_user_id IS NULL ORDER BY publish_at DESC, id DESC LIMIT 20`).bind(now)
    .all<{ id: string; ticker: Ticker | null; kind: string; headline: string; publish_at: number; source: 'ai' | 'template'; hidden: number }>();
  return rows.results.map(row => ({ id: row.id, ticker: row.ticker, kind: row.kind, headline: row.headline,
    publishAt: new Date(row.publish_at).toISOString(), source: row.source, hidden: row.hidden === 1 }));
}
export async function setStockNewsHidden(db: D1Database, id: string, hidden: boolean, now: number): Promise<void> {
  const result = await db.prepare('UPDATE stock_news SET hidden = ? WHERE id = ? AND publish_at <= ? AND audience_user_id IS NULL')
    .bind(hidden ? 1 : 0, id, now).run();
  if (!result.meta.changes) throw new StockError(404, 'NEWS_NOT_FOUND', '공개된 뉴스만 숨길 수 있어요.');
}
