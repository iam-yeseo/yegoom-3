import { readFile, readdir, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { hashPassword } from '../worker/crypto';
import { kstTimestamp } from '../shared/market-calendar';
import { readStockMarket } from '../worker/stocks';
import type { AdminState } from '../shared/admin';
import type { AchievementsResponse } from '../shared/achievements';
import type { StockDetailView, StockMarketView, StockNewsPage, StockTradeResponse, StockUnchanged } from '../shared/stock-types';

const ORIGIN = 'http://localhost';
const PASSWORD = 'test-only-password-42!';
const SECRET = 'test-only-stock-seed-secret-2026';
const USERS = ['min', 'siwon', 'yeseo', 'admin'] as const;
type Database = Awaited<ReturnType<Miniflare['getD1Database']>>;
const kst = (date: string, time: string) => kstTimestamp(date, time);

let migration = '';
let passwordHash = '';
const scripts = new Map<number, string>();
const instances: Miniflare[] = [];
const persisted: string[] = [];

/** Freeze JavaScript and the SQL clock in the compiled test bundle only. */
async function workerAt(timestamp: number): Promise<string> {
  const cached = scripts.get(timestamp);
  if (cached) return cached;
  const result = await build({
    entryPoints: [fileURLToPath(new URL('../worker/index.ts', import.meta.url))], bundle: true, format: 'esm', platform: 'browser', write: false,
    define: { Date: 'TestDate' },
    banner: { js: `class TestDate extends Date { constructor(...args) { super(...(args.length ? args : [${timestamp}])); } static now() { return ${timestamp}; } }` },
  });
  const script = result.outputFiles[0]!.text.replaceAll("unixepoch('now') * 1000", String(timestamp));
  scripts.set(timestamp, script);
  return script;
}
async function applyMigration(db: Database, sql: string) {
  let statement = '';
  for (const sourceLine of sql.split('\n')) {
    const line = sourceLine.trim();
    if (!line || line.startsWith('--')) continue;
    statement += `${line}\n`;
    const trigger = /^CREATE TRIGGER\b/i.test(statement);
    if (line.endsWith(';') && (!trigger || /\bEND;$/i.test(line))) { await db.prepare(statement).run(); statement = ''; }
  }
}

/** One shared D1 database, served by Workers frozen at different instants. */
class Market {
  constructor(readonly persist: string) {}
  db!: Database;
  cookies = new Map<string, string>();
  workers = new Map<number, Miniflare>();
  static async create(lastTickAt: number) {
    const market = new Market(`.test-build/stock-${crypto.randomUUID()}`);
    persisted.push(market.persist);
    const first = await market.at(lastTickAt);
    market.db = await first.getD1Database('DB');
    await applyMigration(market.db, migration);
    for (const username of USERS) {
      await market.db.prepare('INSERT INTO users (id, username, display_name, password_hash, role) VALUES (?, ?, ?, ?, ?)')
        .bind(username, username, username, passwordHash, username === 'admin' ? 'admin' : 'player').run();
    }
    await market.db.prepare("INSERT INTO ledger (id, user_id, currency, amount, reason, reference, created_at) VALUES ('fixture-min', 'min', 'gold', 100000, '테스트 골드', 'fixture:min', '2026-11-01T00:00:00.000Z')").run();
    await market.db.prepare('UPDATE stock_state SET last_tick_at = ?').bind(lastTickAt).run();
    return market;
  }
  async at(timestamp: number) {
    const cached = this.workers.get(timestamp);
    if (cached) return cached;
    const instance = new Miniflare({ modules: true, script: await workerAt(timestamp), compatibilityDate: '2026-08-06',
      d1Databases: ['DB'], d1Persist: this.persist, bindings: { STOCK_SEED_SECRET: SECRET } });
    instances.push(instance);
    this.workers.set(timestamp, instance);
    return instance;
  }
  async request<T>(timestamp: number, username: string, path: string, method = 'GET', body?: unknown): Promise<{ status: number; data: T }> {
    const worker = await this.at(timestamp);
    let cookie = this.cookies.get(username);
    if (!cookie) {
      const login = await worker.dispatchFetch(`${ORIGIN}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json', origin: ORIGIN },
        body: JSON.stringify({ username, password: PASSWORD }) });
      expect(login.status).toBe(200);
      cookie = login.headers.get('set-cookie')!.split(';')[0]!;
      this.cookies.set(username, cookie);
    }
    const headers: Record<string, string> = { cookie };
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (method !== 'GET') headers.origin = ORIGIN;
    const response = await worker.dispatchFetch(`${ORIGIN}${path}`, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, data: await response.json() as T };
  }
  async gold(user: string) {
    return Number(await this.db.prepare('SELECT gold FROM user_balances WHERE user_id = ?').bind(user).first('gold') ?? 0);
  }
  async expectBalanced() {
    const mismatches = await this.db.prepare(`SELECT u.id FROM users u LEFT JOIN user_balances b ON b.user_id = u.id
      LEFT JOIN (SELECT user_id, SUM(amount) gold FROM ledger WHERE currency = 'gold' GROUP BY user_id) g ON g.user_id = u.id
      WHERE COALESCE(b.gold, 0) != COALESCE(g.gold, 0)`).all();
    expect(mismatches.results).toEqual([]);
  }
}

beforeAll(async () => {
  const files = (await readdir(new URL('../migrations/', import.meta.url))).filter(file => file.endsWith('.sql')).sort();
  migration = (await Promise.all(files.map(file => readFile(new URL(`../migrations/${file}`, import.meta.url), 'utf8')))).join('\n');
  passwordHash = await hashPassword(PASSWORD);
}, 60_000);
afterEach(async () => {
  await Promise.all(instances.splice(0).map(instance => instance.dispose()));
  await Promise.all(persisted.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

const thursdayOpen = kst('2026-11-05', '09:00');
const yesterdayClose = kst('2026-11-04', '18:00');

describe('stock market API', () => {
  it('catches up missed ticks on read, answers "unchanged" by version, and never shows future or hidden news', async () => {
    const market = await Market.create(yesterdayClose);
    const now = kst('2026-11-05', '10:03');
    const first = await market.request<StockMarketView>(now, 'min', '/api/stock');
    expect(first.status).toBe(200);
    expect(first.data.market).toMatchObject({ open: true, date: '2026-11-05', holiday: null, nextTickAt: new Date(kst('2026-11-05', '10:10')).toISOString() });
    expect(first.data.stocks).toHaveLength(15);
    expect(first.data.stocks.every(stock => stock.status === 'listed' && stock.version === 7)).toBe(true);
    expect(await market.db.prepare('SELECT COUNT(*) AS n FROM stock_ticks').first('n')).toBe(105);
    const again = await market.request<StockUnchanged>(now, 'min', `/api/stock?since=${first.data.version}`);
    expect(again.data).toMatchObject({ unchanged: true, version: first.data.version });
    // Same instant, another reader: no further writes.
    await market.request(now, 'siwon', '/api/stock');
    expect(await market.db.prepare('SELECT COUNT(*) AS n FROM stock_ticks').first('n')).toBe(105);

    await market.db.prepare(`INSERT INTO stock_news (id, ticker, kind, publish_at, headline, body, source, created_at) VALUES
      ('future', 'YEGM', 'news', ?, '미래 기사', '아직 공개되지 않음', 'template', 'x'),
      ('hidden', 'YEGM', 'news', ?, '숨긴 기사', '운영자가 숨김', 'template', 'x')`).bind(now + 60_000, now - 60_000).run();
    await market.db.prepare("UPDATE stock_news SET hidden = 1 WHERE id = 'hidden'").run();
    for (const user of ['min', 'admin']) {
      const list = await market.request<StockMarketView>(now, user, '/api/stock');
      const page = await market.request<StockNewsPage>(now, user, '/api/stock/news');
      const detail = await market.request<StockDetailView>(now, user, '/api/stock/YEGM');
      for (const news of [list.data.news, page.data.news, detail.data.news]) {
        expect(news.map(item => item.id)).not.toContain('future');
        expect(news.map(item => item.id)).not.toContain('hidden');
        expect(news.every(item => Date.parse(item.publishAt) <= now)).toBe(true);
      }
    }
    const detail = await market.request<StockDetailView>(now, 'min', '/api/stock/YKHX');
    expect(detail.data.ticks).toHaveLength(7);
    expect(detail.data.ticks[0]!.at).toBe(thursdayOpen);
    expect(detail.data.stock).toMatchObject({ ticker: 'YKHX', held: 0, halted: false });
    expect((await market.request(now, 'min', '/api/stock/NOPE')).status).toBe(404);
  });

  it('buys and sells at the server price with a 1% fee, replays a request once, and keeps the ledger balanced', async () => {
    const market = await Market.create(yesterdayClose);
    const now = kst('2026-11-05', '10:03');
    const view = (await market.request<StockMarketView>(now, 'min', '/api/stock')).data;
    const ykhx = view.stocks.find(stock => stock.ticker === 'YKHX')!;
    const order = { requestId: 'buy-1', ticker: 'YKHX', side: 'buy', quantity: 10, expectedVersion: ykhx.version };
    const results = await Promise.all([1, 2, 3].map(() => market.request<StockTradeResponse>(now, 'min', '/api/stock/trade', 'POST', order)));
    expect(results.every(result => result.status === 200 || result.status === 409)).toBe(true);
    const fee = Math.max(1, Math.ceil(ykhx.price * 10 / 100));
    expect(await market.gold('min')).toBe(100000 - ykhx.price * 10 - fee);
    const replay = await market.request<StockTradeResponse>(now, 'min', '/api/stock/trade', 'POST', order);
    expect(replay.data).toMatchObject({ replayed: true, trade: { quantity: 10, price: ykhx.price, fee, total: ykhx.price * 10 + fee }, stock: { held: 10, costBasis: ykhx.price * 10 + fee } });
    expect((await market.request(now, 'min', '/api/stock/trade', 'POST', { ...order, quantity: 11 })).status).toBe(409);
    const ledger = await market.db.prepare("SELECT amount, reason, reference FROM ledger WHERE reference LIKE 'stock:%'").all();
    expect(ledger.results).toEqual([{ amount: -(ykhx.price * 10 + fee), reason: '주식 매수 · YK하이커스 10주', reference: 'stock:buy:min:buy-1' }]);

    const sell = await market.request<StockTradeResponse>(now, 'min', '/api/stock/trade', 'POST', { requestId: 'sell-1', ticker: 'YKHX', side: 'sell', quantity: 4, expectedVersion: ykhx.version });
    const sellFee = Math.max(1, Math.ceil(ykhx.price * 4 / 100));
    expect(sell.data).toMatchObject({ replayed: false, trade: { side: 'sell', total: ykhx.price * 4 - sellFee, costBasis: Math.floor((ykhx.price * 10 + fee) * 4 / 10) }, stock: { held: 6 } });
    expect(sell.data.stock.costBasis).toBe(ykhx.price * 10 + fee - Math.floor((ykhx.price * 10 + fee) * 4 / 10));

    const reject = async (body: Record<string, unknown>, user = 'min') => (await market.request<{ error: { code: string } }>(now, user, '/api/stock/trade', 'POST',
      { requestId: crypto.randomUUID(), ticker: 'YKHX', side: 'buy', quantity: 1, expectedVersion: ykhx.version, ...body })).data.error?.code;
    expect(await reject({ side: 'sell', quantity: 7 })).toBe('NOT_ENOUGH_SHARES');
    expect(await reject({ quantity: 495 })).toBe('HOLDING_LIMIT');
    expect(await reject({ quantity: 80 }, 'siwon')).toBe('NOT_ENOUGH_GOLD');
    expect(await reject({ expectedVersion: ykhx.version - 1 })).toBe('PRICE_CHANGED');
    expect(await reject({ quantity: 501 })).toBe('INVALID_QUANTITY');
    expect(await reject({}, 'admin')).toBe('CANNOT_TRADE');
    expect(await market.db.prepare('SELECT COUNT(*) AS n FROM stock_trades').first('n')).toBe(2);
    await market.expectBalanced();

    // After the next tick the old version is stale.
    const later = kst('2026-11-05', '10:11');
    expect((await market.request<{ error: { code: string } }>(later, 'min', '/api/stock/trade', 'POST',
      { requestId: 'late', ticker: 'YKHX', side: 'buy', quantity: 1, expectedVersion: ykhx.version })).data.error.code).toBe('PRICE_CHANGED');
  });

  it('rejects trades outside market hours, on weekends and on administrator holidays', async () => {
    const market = await Market.create(yesterdayClose);
    const trade = async (timestamp: number) => {
      const view = (await market.request<StockMarketView>(timestamp, 'min', '/api/stock')).data;
      const version = view.stocks.find(stock => stock.ticker === 'MDRG')!.version;
      return (await market.request<{ error: { code: string; message: string } }>(timestamp, 'min', '/api/stock/trade', 'POST',
        { requestId: crypto.randomUUID(), ticker: 'MDRG', side: 'buy', quantity: 1, expectedVersion: version })).data.error;
    };
    expect((await trade(kst('2026-11-05', '08:30'))).code).toBe('MARKET_CLOSED');
    expect((await trade(kst('2026-11-05', '18:00'))).code).toBe('MARKET_CLOSED');
    const added = await market.request<AdminState>(kst('2026-11-05', '19:00'), 'admin', '/api/admin/market-holidays', 'POST', { date: '2026-11-06', reason: '임시 휴장' });
    expect(added.data.marketHolidays).toEqual([{ date: '2026-11-06', reason: '임시 휴장' }]);
    expect((await trade(kst('2026-11-07', '12:00'))).code).toBe('MARKET_CLOSED');
    const closed = await trade(kst('2026-11-06', '11:00'));
    expect(closed).toMatchObject({ code: 'MARKET_CLOSED', message: '오늘은 임시 휴장 휴장이에요.' });
    // No ticks on the holiday.
    expect(await market.db.prepare('SELECT COUNT(*) AS n FROM stock_ticks WHERE at >= ?').bind(kst('2026-11-06', '00:00')).first('n')).toBe(0);
    // Today after the open cannot change; players cannot use the admin API.
    expect((await market.request<{ error: { code: string } }>(kst('2026-11-09', '09:30'), 'admin', '/api/admin/market-holidays', 'POST', { date: '2026-11-09', reason: '늦음' })).data.error.code).toBe('MARKET_ALREADY_OPENED');
    expect((await market.request(kst('2026-11-05', '19:00'), 'min', '/api/admin/market-holidays', 'POST', { date: '2026-11-10', reason: '선거' })).status).toBe(403);
    await market.request(kst('2026-11-05', '19:00'), 'admin', '/api/admin/market-holidays', 'POST', { date: '2026-11-10', reason: '선거' });
    const removed = await market.request<AdminState>(kst('2026-11-05', '19:00'), 'admin', '/api/admin/market-holidays/2026-11-10', 'DELETE');
    expect(removed.data.marketHolidays.map(item => item.date)).toEqual(['2026-11-06']);
  });

  it('delists after a warned close, zeroes holdings with a history row and no gold, then relists', async () => {
    const market = await Market.create(kst('2026-11-05', '17:50'));
    await market.db.prepare(`UPDATE stock_state SET price = 300, prev_close = 300, day_open = 300, day_high = 300, day_low = 300,
      status = 'warning', warning_since = '2026-11-04' WHERE ticker = 'EEVA'`).run();
    await market.db.prepare("INSERT INTO stock_holdings (user_id, ticker, quantity, cost_basis) VALUES ('min', 'EEVA', 12, 6000)").run();
    const goldBefore = await market.gold('min');
    const view = await market.request<StockMarketView>(kst('2026-11-05', '18:00') + 30_000, 'min', '/api/stock');
    expect(view.data.stocks.find(stock => stock.ticker === 'EEVA')).toMatchObject({ status: 'delisted', delistedOn: '2026-11-05', relistOn: '2026-11-19', held: 0 });
    expect(view.data.news[0]).toMatchObject({ headline: '[공시] 에바참치, 상장폐지', kind: 'disclosure' });
    const trades = await market.db.prepare("SELECT user_id, side, quantity, total, cost_basis, request_id FROM stock_trades WHERE ticker = 'EEVA'").all();
    expect(trades.results).toEqual([{ user_id: 'min', side: 'delist', quantity: 12, total: 0, cost_basis: 6000, request_id: 'delist:EEVA:2026-11-05' }]);
    expect(await market.gold('min')).toBe(goldBefore);
    expect(await market.db.prepare('SELECT close FROM stock_daily WHERE ticker = ? AND date = ?').bind('EEVA', '2026-11-05').first('close')).toBeLessThan(400);
    // The relisting day's open: back at the listing price (sessions last a week).
    market.cookies.clear();
    await market.db.prepare("UPDATE stock_state SET last_tick_at = ?").bind(kst('2026-11-18', '18:00')).run();
    const relisted = await market.request<StockMarketView>(kst('2026-11-19', '09:00') + 5_000, 'min', '/api/stock');
    expect(relisted.status, JSON.stringify(relisted.data)).toBe(200);
    expect(relisted.data.stocks.find(stock => stock.ticker === 'EEVA')).toMatchObject({ status: 'listed', price: 500, prevClose: 500 });
    await market.expectBalanced();
  });

  it('bounds the market read: a few queries, and only reads once the tick is written', async () => {
    const market = await Market.create(yesterdayClose);
    const now = kst('2026-11-05', '09:00') + 1000;
    let statements = 0;
    const counted = new Proxy(market.db, { get(target, key) {
      const value = Reflect.get(target, key);
      if (key === 'prepare') return (sql: string) => { statements++; return target.prepare(sql.replaceAll("unixepoch('now') * 1000", String(now))); };
      return typeof value === 'function' ? value.bind(target) : value;
    } }) as unknown as D1Database;
    await readStockMarket(counted, SECRET, { id: 'min', role: 'player', username: 'min' }, now);
    expect(statements).toBeLessThanOrEqual(12);
    statements = 0;
    const view = await readStockMarket(counted, SECRET, { id: 'min', role: 'player', username: 'min' }, now) as StockMarketView;
    expect(statements).toBe(8); // state + holidays + new game results + pending events, then holdings + news + gold + closing
    statements = 0;
    expect(await readStockMarket(counted, SECRET, { id: 'min', role: 'player', username: 'min' }, now, view.version)).toMatchObject({ unchanged: true });
    expect(statements).toBe(4);
  });

  it('turns a result published in market hours into an immediate move with a news item, once', async () => {
    const market = await Market.create(yesterdayClose);
    for (const [date, answer] of [['2026-11-02', '08:00:00'], ['2026-11-03', '08:10:00'], ['2026-11-04', '07:50:00']]) {
      await market.db.prepare('INSERT INTO game_rounds (game_id, round_date, answer, revealed_at, updated_at) VALUES (?, ?, ?, ?, ?)')
        .bind('wake', date, answer, kst(date, '08:00'), kst(date, '08:00')).run();
    }
    const tenAm = await market.request<StockMarketView>(kst('2026-11-05', '10:00') + 1000, 'siwon', '/api/stock');
    const before = tenAm.data.stocks.find(stock => stock.ticker === 'MINJ')!;
    const revealed = kst('2026-11-05', '10:04') + 30_000;
    await market.db.prepare('INSERT INTO game_rounds (game_id, round_date, answer, revealed_at, updated_at) VALUES (?, ?, ?, ?, ?)')
      .bind('wake', '2026-11-05', '07:30:00', revealed, revealed).run();
    const now = kst('2026-11-05', '10:05');
    const view = await market.request<StockMarketView>(now, 'siwon', '/api/stock');
    const after = view.data.stocks.find(stock => stock.ticker === 'MINJ')!;
    expect(after.price).toBe(Math.max(Math.ceil(before.prevClose * 0.85), Math.min(Math.floor(before.prevClose * 1.15), Math.round(before.price * 1.04))));
    expect(after.version).toBe(before.version + 1);
    expect(view.data.news[0]).toMatchObject({ kind: 'game', ticker: 'MINJ', effectBp: 400, publishAt: new Date(revealed).toISOString(),
      headline: '[속보] min님 07시 30분 기상, MJ일렉트로닉스 들썩' });
    expect(await market.db.prepare("SELECT applied_at FROM stock_events WHERE id = 'game:wake:2026-11-05'").first('applied_at')).toBe(revealed);
    // The three history rounds (within the 4-day lookback) were applied at the 10:00 read.
    expect(await market.db.prepare('SELECT COUNT(*) AS n FROM stock_events WHERE applied_at IS NOT NULL').first('n')).toBe(4);
    await market.request(now + 1000, 'siwon', '/api/stock');
    expect(await market.db.prepare('SELECT COUNT(*) AS n FROM stock_events').first('n')).toBe(4);
    expect(await market.db.prepare("SELECT COUNT(*) AS n FROM stock_news WHERE kind = 'game'").first('n')).toBe(4);
  });

  it('applies results published after the close at the next open, and locks the author until then', async () => {
    const market = await Market.create(kst('2026-11-05', '17:50'));
    const published = kst('2026-11-05', '18:40');
    await market.db.prepare("INSERT INTO game_rounds (game_id, round_date, answer, revealed_at, updated_at) VALUES ('offwork', '2026-11-05', '17:00:00', ?, ?)")
      .bind(published, published).run();
    await market.request(kst('2026-11-05', '19:00'), 'siwon', '/api/stock');
    expect(await market.db.prepare("SELECT apply_at, applied_at, effect_bp FROM stock_events WHERE id = 'game:offwork:2026-11-05'").first())
      .toEqual({ apply_at: published, applied_at: null, effect_bp: 800 });
    const blocked = await market.request<StockDetailView>(kst('2026-11-06', '08:59'), 'siwon', '/api/stock/SIWN');
    expect(blocked.data.tradeBlock).toBe('오늘은 출제자라서 거래할 수 없어요 · 결과 반영 후 거래 가능');
    expect((await market.request<StockDetailView>(kst('2026-11-06', '08:59'), 'min', '/api/stock/SIWN')).data.tradeBlock).toBeNull();
    const open = await market.request<StockDetailView>(kst('2026-11-06', '09:00') + 1000, 'siwon', '/api/stock/SIWN');
    expect(open.data.news[0]).toMatchObject({ kind: 'game', publishAt: new Date(kst('2026-11-06', '09:00')).toISOString() });
    expect(open.data.stock.dayOpen).toBe(Math.min(Math.floor(open.data.stock.prevClose * 1.15), Math.round(open.data.stock.prevClose * 1.08)));
    // Friday's own round is not answered yet: siwon stays locked; the game OFF unlocks.
    expect(open.data.tradeBlock).not.toBeNull();
    const trade = await market.request<{ error: { code: string } }>(kst('2026-11-06', '09:00') + 1000, 'siwon', '/api/stock/trade', 'POST',
      { requestId: 'author', ticker: 'SIWN', side: 'buy', quantity: 1, expectedVersion: open.data.stock.version });
    expect(trade.data.error.code).toBe('AUTHOR_LOCKED');
    await market.db.prepare("INSERT INTO game_settings (game_id, effective_from, settings_json, created_at, created_by) VALUES ('offwork', '2026-11-06', ?, 'x', 'admin')")
      .bind(JSON.stringify({ enabled: false, scoreTable: [{ maxDifference: 0, points: 1 }], participationGold: 0, firstGold: 0, deadline: '17:00:00', revealTime: null })).run();
    const off = await market.request<StockDetailView>(kst('2026-11-06', '09:00') + 1000, 'siwon', '/api/stock/SIWN');
    expect(off.data.tradeBlock).toBeNull();
    await market.expectBalanced();
  });

  it('reports whale trades anonymously, at most once an hour per person and stock, with no price effect', async () => {
    const market = await Market.create(yesterdayClose);
    const now = kst('2026-11-05', '10:03');
    const view = (await market.request<StockMarketView>(now, 'min', '/api/stock')).data;
    const yegm = view.stocks.find(stock => stock.ticker === 'YEGM')!;
    const buy = (requestId: string, quantity: number) => market.request<StockTradeResponse>(now, 'min', '/api/stock/trade', 'POST',
      { requestId, ticker: 'YEGM', side: 'buy', quantity, expectedVersion: yegm.version });
    expect((await buy('small', 10)).status).toBe(200);
    expect((await buy('whale-1', 100)).status).toBe(200);
    expect((await buy('whale-2', 60)).status).toBe(200);
    const whales = (await market.db.prepare("SELECT headline, body, ticker, effect_bp FROM stock_news WHERE kind = 'whale'").all<{ headline: string; body: string; ticker: string; effect_bp: number | null }>()).results;
    expect(whales).toHaveLength(1);
    expect(whales[0]).toMatchObject({ headline: '익명의 큰손, 예굼 100주 매수', ticker: 'YEGM', effect_bp: null });
    expect(`${whales[0]!.headline}${whales[0]!.body}`).not.toMatch(/min|민/);
    const after = (await market.request<StockMarketView>(now, 'siwon', '/api/stock')).data;
    expect(after.stocks.find(stock => stock.ticker === 'YEGM')!.price).toBe(yegm.price);
    expect(after.news[0]).toMatchObject({ kind: 'whale' });
  });

  it('lets the administrator hide published news and switch AI news, never touching future news', async () => {
    const market = await Market.create(yesterdayClose);
    const now = kst('2026-11-05', '10:03');
    await market.request(now, 'min', '/api/stock');
    await market.db.prepare(`INSERT INTO stock_news (id, ticker, kind, publish_at, headline, body, source, created_at)
      VALUES ('future-ai', 'YEGM', 'news', ?, '미래', '아직', 'ai', 'x'), ('news:2026-11-05:9', 'YEGM', 'news', ?, '공개됨', '본문', 'template', 'x')`).bind(now + 3_600_000, now - 60_000).run();
    const admin = await market.request<AdminState>(now, 'admin', '/api/admin');
    expect(admin.status, JSON.stringify(admin.data)).toBe(200);
    expect(admin.data.stock.ai).toMatchObject({ enabled: true, provider: 'openai', keys: { anthropic: false, openai: false }, keyConfigured: false, today: { calls: 0, costMicroUsd: 0 } });
    expect(admin.data.stock.news.map(item => item.id)).not.toContain('future-ai');
    const target = admin.data.stock.news[0]!;
    const hidden = await market.request<AdminState>(now, 'admin', `/api/admin/stock/news/${encodeURIComponent(target.id)}`, 'PUT', { hidden: true });
    expect(hidden.data.stock.news.find(item => item.id === target.id)!.hidden).toBe(true);
    const page = await market.request<StockNewsPage>(now, 'min', '/api/stock/news');
    expect(page.data.news.map(item => item.id)).not.toContain(target.id);
    expect((await market.request(now, 'admin', '/api/admin/stock/news/future-ai', 'PUT', { hidden: true })).status).toBe(404);
    expect((await market.request(now, 'min', `/api/admin/stock/news/${encodeURIComponent(target.id)}`, 'PUT', { hidden: false })).status).toBe(403);
    const off = await market.request<AdminState>(now, 'admin', '/api/admin/stock/ai', 'PUT', { enabled: false });
    expect(off.data.stock.ai.enabled).toBe(false);
    const claude = await market.request<AdminState>(now, 'admin', '/api/admin/stock/ai', 'PUT', { provider: 'anthropic' });
    expect(claude.data.stock.ai).toMatchObject({ enabled: false, provider: 'anthropic' });
    expect((await market.request(now, 'admin', '/api/admin/stock/ai', 'PUT', { provider: 'gemini' })).status).toBe(400);
  });

  it('unlocks the stock achievements: first buy and sell, realized gain and loss tiers, a delisting and limit moves while holding', async () => {
    const market = await Market.create(yesterdayClose);
    const now = kst('2026-11-05', '10:03');
    const unlocked = async () => (await market.request<AchievementsResponse>(now, 'min', '/api/achievements')).data.progress.map(row => row.key).filter(key => key.startsWith('stock_')).sort();
    expect(await unlocked()).toEqual([]);
    const view = (await market.request<StockMarketView>(now, 'min', '/api/stock')).data;
    const ykhx = view.stocks.find(stock => stock.ticker === 'YKHX')!;
    expect((await market.request(now, 'min', '/api/stock/trade', 'POST', { requestId: 'a-buy', ticker: 'YKHX', side: 'buy', quantity: 2, expectedVersion: ykhx.version })).status).toBe(200);
    expect(await unlocked()).toEqual(['stock_buy']);
    expect((await market.request(now, 'min', '/api/stock/trade', 'POST', { requestId: 'a-sell', ticker: 'YKHX', side: 'sell', quantity: 1, expectedVersion: ykhx.version })).status).toBe(200);
    // Selling one of two at the same price loses only the fees: no loss tier yet.
    expect(await unlocked()).toEqual(['stock_buy', 'stock_sell']);

    const trade = (id: string, ticker: string, side: string, total: number, costBasis: number, date: string) => market.db.prepare(`INSERT INTO stock_trades
      (id, user_id, request_id, ticker, side, quantity, price, fee, total, cost_basis, date, created_at) VALUES (?, 'min', ?, ?, ?, 1, 1, 0, ?, ?, ?, ?)`)
      .bind(id, id, ticker, side, total, costBasis, date, `${date}T01:00:00.000Z`);
    await market.db.batch([
      trade('gain', 'MDRG', 'sell', 3600, 1000, '2026-11-03'), // +2,600G
      trade('loss', 'DWSC', 'sell', 100, 1300, '2026-11-03'), // -1,200G
      trade('gone', 'RIAN', 'delist', 0, 400, '2026-11-03'),
      // Bought SOAR on 11/4, the day it closed at the +15% limit over 11/3.
      trade('soar', 'SOAR', 'buy', 750, 750, '2026-11-04'),
      market.db.prepare("INSERT INTO stock_daily (ticker, date, open, high, low, close) VALUES ('SOAR', '2026-11-03', 750, 760, 740, 750), ('SOAR', '2026-11-04', 760, 862, 760, 862)"),
      // Holding GEUU now while it trades at today's -15% limit.
      market.db.prepare("INSERT INTO stock_holdings (user_id, ticker, quantity, cost_basis) VALUES ('min', 'GEUU', 1, 500)"),
      market.db.prepare("UPDATE stock_state SET prev_close = 500, day_open = 480, day_high = 480, day_low = 425, price = 425 WHERE ticker = 'GEUU'"),
    ]);
    expect(await unlocked()).toEqual(['stock_buy', 'stock_delisted', 'stock_gain_100', 'stock_gain_1000', 'stock_gain_2000', 'stock_gain_500',
      'stock_limit_down', 'stock_limit_up', 'stock_loss_100', 'stock_loss_1000', 'stock_loss_500', 'stock_sell']);
  });

  it('returns 503 until the seed secret is configured', async () => {
    const market = await Market.create(yesterdayClose);
    const worker = new Miniflare({ modules: true, script: await workerAt(thursdayOpen), compatibilityDate: '2026-08-06', d1Databases: ['DB'], d1Persist: market.persist });
    instances.push(worker);
    const login = await worker.dispatchFetch(`${ORIGIN}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json', origin: ORIGIN }, body: JSON.stringify({ username: 'min', password: PASSWORD }) });
    const response = await worker.dispatchFetch(`${ORIGIN}/api/stock`, { headers: { cookie: login.headers.get('set-cookie')!.split(';')[0]! } });
    expect(response.status).toBe(503);
  });
});
