import { STOCK_RULES, stockInfo, tradeFee, type Ticker } from "../shared/stocks";
import { kstDateOf, kstTimestamp, marketStatus, tradesOn } from "../shared/market-calendar";
import { advanceMarket, initialRows, marketVersion, nextTickAt, pendingTicks, type DailyRecord, type NewsRecord, type StockRow, type TickRecord } from "../shared/stock-market";
import type { MarketClock, StockDetailView, StockMarketView, StockNewsItem, StockNewsPage, StockQuote, StockTradeInput, StockTradeResponse, StockTradeView, StockUnchanged } from "../shared/stock-types";
import { ApiFailure } from "./api";

/** What the stock screens need, served by the Worker or by the preview below. */
export interface StockClient {
  market(since?: string): Promise<StockMarketView | StockUnchanged>;
  detail(ticker: string): Promise<StockDetailView>;
  news(before?: string): Promise<StockNewsPage>;
  trade(input: StockTradeInput): Promise<StockTradeResponse>;
}

/** The serverless preview: the same engine with public sample seeds (never the
 * server's), starting a month ago at the listing prices. Nothing is stored. */
interface PreviewMarket {
  rows: StockRow[]; ticks: TickRecord[]; daily: DailyRecord[]; news: NewsRecord[];
  holdings: Map<Ticker, { quantity: number; costBasis: number }>; trades: StockTradeView[];
}
let preview: PreviewMarket | null = null;
const seedOf = (date: string) => `preview|${date}`;
const none = new Map<string, string>();

function advance(now: number): PreviewMarket {
  if (!preview) {
    const start = kstTimestamp(kstDateOf(now - 35 * 86_400_000), "18:00");
    preview = { rows: initialRows(start), ticks: [], daily: [], news: [],
      holdings: new Map([["YEGM", { quantity: 20, costBasis: 10_100 }], ["YEDO", { quantity: 3, costBasis: 3_030 }]]), trades: [] };
  }
  const from = Math.min(...preview.rows.map(row => row.lastTickAt));
  const ticks = pendingTicks(from, now, none, 5_000);
  if (ticks.length) {
    const result = advanceMarket(preview.rows, ticks, seedOf, [], none);
    preview.rows = result.rows;
    const cutoff = now - STOCK_RULES.tickRetentionDays * 86_400_000;
    preview.ticks = [...preview.ticks, ...result.ticks].filter(tick => tick.at >= cutoff);
    preview.daily.push(...result.daily);
    preview.news.push(...result.news);
    for (const { ticker } of result.delisted) {
      const held = preview.holdings.get(ticker);
      if (held?.quantity) {
        const row = preview.rows.find(item => item.ticker === ticker)!;
        preview.trades.unshift({ id: crypto.randomUUID(), requestId: `delist:${ticker}`, ticker, side: "delist", quantity: held.quantity,
          price: row.price, fee: 0, total: 0, costBasis: held.costBasis, createdAt: new Date(now).toISOString() });
        preview.holdings.set(ticker, { quantity: 0, costBasis: 0 });
      }
    }
  }
  return preview;
}
function clock(now: number): MarketClock {
  const status = marketStatus(now);
  const next = nextTickAt(now, none);
  return { open: status.open, date: status.date, holiday: status.holiday, opensAt: new Date(status.opensAt).toISOString(),
    closesAt: new Date(status.closesAt).toISOString(), nextTickAt: next === null ? null : new Date(next).toISOString() };
}
function quote(market: PreviewMarket, row: StockRow, date: string): StockQuote {
  const held = market.holdings.get(row.ticker);
  return { ticker: row.ticker, price: row.price, prevClose: row.prevClose, dayOpen: row.dayOpen, dayHigh: row.dayHigh, dayLow: row.dayLow,
    status: row.status, halted: !tradesOn(row.ticker, date), warningSince: row.warningSince, delistedOn: row.delistedOn,
    relistOn: row.relistOn, version: row.version, held: held?.quantity ?? 0, costBasis: held?.costBasis ?? 0 };
}
const newsItem = (record: NewsRecord): StockNewsItem => ({ id: record.id, ticker: record.ticker, kind: record.kind, headline: record.headline,
  body: record.body, publishAt: new Date(record.publishAt).toISOString(), effectBp: record.effectBp, source: "template" });
const newestNews = (market: PreviewMarket) => [...market.news].reverse();

export function createPreviewStockClient(wallet: { gold(): number; canTrade(): boolean; spend(amount: number, reason: string): void }): StockClient {
  return {
    async market(since) {
      const now = Date.now();
      const market = advance(now);
      const version = marketVersion(market.rows);
      const status = clock(now);
      if (since === version) return { unchanged: true, version, market: status, serverTime: new Date(now).toISOString() };
      return { market: status, version, stocks: market.rows.map(row => quote(market, row, status.date)), news: newestNews(market).slice(0, 5).map(newsItem),
        gold: wallet.gold(), canTrade: wallet.canTrade(), serverTime: new Date(now).toISOString() };
    },
    async detail(ticker) {
      const now = Date.now();
      const market = advance(now);
      const row = market.rows.find(item => item.ticker === ticker);
      if (!row) throw new ApiFailure(404, "없는 종목이에요.", "UNKNOWN_STOCK");
      const own = market.ticks.filter(tick => tick.ticker === ticker);
      const last = own[own.length - 1]?.at ?? 0;
      const status = clock(now);
      return { market: status, version: marketVersion(market.rows), stock: quote(market, row, status.date),
        ticks: own.filter(tick => tick.at >= last - 9 * 3_600_000).map(({ at, price }) => ({ at, price })),
        daily: market.daily.filter(candle => candle.ticker === ticker).slice(-22).map(({ date, open, high, low, close }) => ({ date, open, high, low, close })),
        news: newestNews(market).filter(item => item.ticker === ticker).slice(0, 10).map(newsItem),
        trades: market.trades.filter(trade => trade.ticker === ticker).slice(0, 10),
        gold: wallet.gold(), canTrade: wallet.canTrade(), tradeBlock: null, serverTime: new Date(now).toISOString() };
    },
    async news(before) {
      const now = Date.now();
      const all = newestNews(advance(now));
      const start = before ? all.findIndex(item => `${item.publishAt}|${item.id}` === before) + 1 : 0;
      const page = all.slice(start, start + 30);
      const last = page[page.length - 1];
      return { news: page.map(newsItem), nextBefore: start + 30 < all.length && last ? `${last.publishAt}|${last.id}` : null, serverTime: new Date(now).toISOString() };
    },
    async trade(input) {
      const now = Date.now();
      const market = advance(now);
      const previous = market.trades.find(trade => trade.requestId === input.requestId);
      const row = market.rows.find(item => item.ticker === input.ticker)!;
      const date = kstDateOf(now);
      if (previous) return { trade: previous, stock: quote(market, row, date), gold: wallet.gold(), replayed: true };
      if (!wallet.canTrade()) throw new ApiFailure(403, "플레이어만 주식을 거래할 수 있어요.", "CANNOT_TRADE");
      const status = marketStatus(now);
      if (!status.open) throw new ApiFailure(409, "지금은 장이 닫혀 있어요.", "MARKET_CLOSED");
      if (!tradesOn(input.ticker, date)) throw new ApiFailure(409, "겨울 근무 중이라 오늘은 거래할 수 없어요.", "TRADING_HALTED");
      if (row.status === "delisted") throw new ApiFailure(409, "상장폐지된 종목은 거래할 수 없어요.", "DELISTED");
      if (row.version !== input.expectedVersion) throw new ApiFailure(409, `가격이 ${row.price.toLocaleString("ko-KR")}G로 바뀌었어요. 확인하고 다시 주문해 주세요.`, "PRICE_CHANGED");
      const held = market.holdings.get(input.ticker) ?? { quantity: 0, costBasis: 0 };
      const amount = row.price * input.quantity;
      const fee = tradeFee(amount);
      const name = stockInfo(input.ticker)!.name;
      let trade: StockTradeView;
      if (input.side === "buy") {
        if (held.quantity + input.quantity > STOCK_RULES.maxHolding) throw new ApiFailure(409, `한 종목은 ${STOCK_RULES.maxHolding}주까지 가질 수 있어요. 지금 ${held.quantity}주 보유 중이에요.`, "HOLDING_LIMIT");
        if (wallet.gold() < amount + fee) throw new ApiFailure(409, "골드가 부족해요.", "NOT_ENOUGH_GOLD");
        trade = { id: crypto.randomUUID(), requestId: input.requestId, ticker: input.ticker, side: "buy", quantity: input.quantity, price: row.price,
          fee, total: amount + fee, costBasis: amount + fee, createdAt: new Date(now).toISOString() };
        market.holdings.set(input.ticker, { quantity: held.quantity + input.quantity, costBasis: held.costBasis + trade.total });
        wallet.spend(trade.total, `주식 매수 · ${name} ${input.quantity}주`);
      } else {
        if (held.quantity < input.quantity) throw new ApiFailure(409, `보유한 주식이 ${held.quantity}주예요.`, "NOT_ENOUGH_SHARES");
        const basis = Math.floor(held.costBasis * input.quantity / held.quantity);
        trade = { id: crypto.randomUUID(), requestId: input.requestId, ticker: input.ticker, side: "sell", quantity: input.quantity, price: row.price,
          fee, total: Math.max(0, amount - fee), costBasis: basis, createdAt: new Date(now).toISOString() };
        market.holdings.set(input.ticker, { quantity: held.quantity - input.quantity, costBasis: held.costBasis - basis });
        if (trade.total) wallet.spend(-trade.total, `주식 매도 · ${name} ${input.quantity}주`);
      }
      market.trades.unshift(trade);
      return { trade, stock: quote(market, row, date), gold: wallet.gold(), replayed: false };
    },
  };
}
/** Home tile in the preview: the same simulated holdings. */
export function previewStockHome(now = Date.now()) {
  const market = advance(now);
  let value = 0, cost = 0;
  for (const row of market.rows) {
    const held = market.holdings.get(row.ticker);
    if (!held?.quantity) continue;
    if (row.status !== "delisted") value += held.quantity * row.price;
    cost += held.costBasis;
  }
  const status = marketStatus(now);
  return { open: status.open, holiday: status.holiday, value, cost };
}
/** For tests: start the preview market over. */
export function resetPreviewStock() { preview = null; }
