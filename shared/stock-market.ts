import { STOCKS, STOCK_RULES, stockInfo, type Ticker } from './stocks';
import { addTradingDays, isTradingDay, kstDateOf, kstTimestamp, nextDate, tickTimes, tradesOn, TICKS_PER_DAY } from './market-calendar';
import { applyEffect, normalFrom, seededRandom, stepPrice } from './stock-engine';
import { disclosureArticle, newsArticle, type DisclosureKind } from './stock-news-templates';

/** The market simulation shared by the Worker (HMAC day seeds, D1 state) and the
 * serverless preview (fixed seeds, memory). Given the same rows, ticks, seeds and
 * events it always produces the same result, so a repeated or concurrent run is
 * harmless and a missed Cron run is caught up by replaying the missing ticks. */
export type StockStatus = 'listed' | 'warning' | 'delisted';
export interface StockRow {
  ticker: Ticker; price: number; prevClose: number;
  dayOpen: number | null; dayHigh: number | null; dayLow: number | null;
  status: StockStatus; warningSince: string | null; delistedOn: string | null; relistOn: string | null;
  lastTickAt: number; version: number;
}
export interface MarketTick { at: number; date: string; index: number }
/** A price event decided elsewhere (game results, PR 11; rumors, PR 12). */
export interface PendingEvent { id: string; ticker: Ticker; effectBp: number; applyAt: number }
export type NewsKind = 'news' | 'disclosure';
export interface NewsRecord {
  id: string; ticker: Ticker; kind: NewsKind; publishAt: number;
  headline: string; body: string; effectBp: number | null;
}
export interface TickRecord { ticker: Ticker; at: number; price: number }
export interface DailyRecord { ticker: Ticker; date: string; open: number; high: number; low: number; close: number }
export interface AdvanceResult {
  rows: StockRow[]; ticks: TickRecord[]; daily: DailyRecord[]; news: NewsRecord[];
  appliedEvents: { id: string; at: number }[]; delisted: { ticker: Ticker; date: string }[];
}
export interface ScheduledNews { id: string; ticker: Ticker; index: number; effectBp: number; variant: number }

const TIMES = tickTimes();
export const initialRows = (lastTickAt: number): StockRow[] => STOCKS.map(stock => ({
  ticker: stock.ticker, price: stock.listingPrice, prevClose: stock.listingPrice, dayOpen: null, dayHigh: null, dayLow: null,
  status: 'listed', warningSince: null, delistedOn: null, relistOn: null, lastTickAt, version: 0,
}));

/** Where an advance starts. After a long gap (the market was switched off, or
 * nobody and no Cron ran for days) it restarts at today's midnight instead of
 * replaying days nobody saw. */
export function advanceStart(lastTickAt: number, now: number): number {
  return now - lastTickAt > STOCK_RULES.staleGapDays * 86_400_000
    ? Math.max(lastTickAt, kstTimestamp(kstDateOf(now), '00:00')) : lastTickAt;
}
/** Tick instants in (from, until], oldest first, at most `limit`. */
export function pendingTicks(from: number, until: number, holidays: ReadonlyMap<string, string>, limit: number = STOCK_RULES.maxCatchUpTicks): MarketTick[] {
  const out: MarketTick[] = [];
  for (let date = kstDateOf(from), last = kstDateOf(until); date <= last && out.length < limit; date = nextDate(date)) {
    if (!isTradingDay(date, holidays)) continue;
    for (let index = 0; index < TIMES.length && out.length < limit; index++) {
      const at = kstTimestamp(date, TIMES[index]!);
      if (at > from && at <= until) out.push({ at, date, index });
    }
  }
  return out;
}
/** The latest tick instant at or before `now` on a trading day, or null. */
export function latestTickAt(now: number, holidays: ReadonlyMap<string, string>): number | null {
  const date = kstDateOf(now);
  if (!isTradingDay(date, holidays)) return null;
  let latest: number | null = null;
  for (const time of TIMES) { const at = kstTimestamp(date, time); if (at <= now) latest = at; }
  return latest;
}
/** The next tick instant after `now` (looks ahead up to three weeks). */
export function nextTickAt(now: number, holidays: ReadonlyMap<string, string>): number | null {
  for (let date = kstDateOf(now), days = 0; days < 21; date = nextDate(date), days++) {
    if (!isTradingDay(date, holidays)) continue;
    for (const time of TIMES) { const at = kstTimestamp(date, time); if (at > now) return at; }
  }
  return null;
}

/** Standard normal move of one stock at one tick of a day. */
export function tickNormal(seed: string, ticker: Ticker, index: number): number {
  const random = seededRandom(`${seed}|${ticker}|${index}`);
  return normalFrom(random(), random());
}
/** The day's template news (4–7 items between 09:10 and 17:50). */
export function scheduledNews(seed: string, date: string): ScheduledNews[] {
  const random = seededRandom(`${seed}|news`);
  const [min, max] = STOCK_RULES.newsPerDay;
  const count = min + Math.floor(random() * (max - min + 1));
  return Array.from({ length: count }, (_, n) => {
    const stock = STOCKS[Math.floor(random() * STOCKS.length)]!;
    const index = 1 + Math.floor(random() * (TICKS_PER_DAY - 2));
    const [low, high] = STOCK_RULES.newsEffect[stock.volatility];
    const sign = random() < 0.5 ? -1 : 1;
    const size = low + random() * (high - low);
    return { id: `news:${date}:${n}`, ticker: stock.ticker, index, effectBp: Math.round(sign * size * 10_000), variant: Math.floor(random() * 1000) };
  });
}

function disclosure(ticker: Ticker, kind: DisclosureKind, date: string, at: number): NewsRecord {
  return { id: `disclosure:${kind}:${ticker}:${date}`, ticker, kind: 'disclosure', publishAt: at, effectBp: null, ...disclosureArticle(ticker, kind) };
}

/** Replay `ticks` in order. `seedOf(date)` must return that date's secret seed. */
export function advanceMarket(input: readonly StockRow[], ticks: readonly MarketTick[], seedOf: (date: string) => string,
  events: readonly PendingEvent[], holidays: ReadonlyMap<string, string>): AdvanceResult {
  const rows = input.map(row => ({ ...row }));
  const result: AdvanceResult = { rows, ticks: [], daily: [], news: [], appliedEvents: [], delisted: [] };
  const applied = new Set<string>();
  const newsOf = new Map<string, ScheduledNews[]>();
  for (const tick of ticks) {
    const seed = seedOf(tick.date);
    let todays = newsOf.get(tick.date);
    if (!todays) newsOf.set(tick.date, todays = scheduledNews(seed, tick.date));
    const closing = tick.index === TICKS_PER_DAY - 1;
    for (const row of rows) {
      const info = stockInfo(row.ticker)!;
      row.lastTickAt = tick.at;
      row.version += 1;
      if (!tradesOn(row.ticker, tick.date)) continue; // halted: events wait for its next trading day
      const due = events.filter(event => event.ticker === row.ticker && event.applyAt <= tick.at && !applied.has(event.id));
      for (const event of due) { applied.add(event.id); result.appliedEvents.push({ id: event.id, at: tick.at }); }
      if (row.status === 'delisted') {
        if (tick.index !== 0 || !row.relistOn || row.relistOn > tick.date) continue; // events for a delisted stock lapse
        Object.assign(row, { status: 'listed', price: info.listingPrice, prevClose: info.listingPrice, delistedOn: null, relistOn: null, warningSince: null });
        result.news.push(disclosure(row.ticker, 'relist', tick.date, tick.at));
      }
      const scheduled = todays.filter(item => item.ticker === row.ticker && item.index === tick.index);
      const effect = (due.reduce((sum, event) => sum + event.effectBp, 0) + scheduled.reduce((sum, item) => sum + item.effectBp, 0)) / 10_000;
      if (tick.index === 0) {
        row.prevClose = row.price;
        row.price = applyEffect(row.price, row.prevClose, effect);
        row.dayOpen = row.dayHigh = row.dayLow = row.price;
      } else {
        row.price = stepPrice(row.price, info.listingPrice, row.prevClose, info.volatility, tickNormal(seed, row.ticker, tick.index), effect);
        row.dayOpen ??= row.price;
        row.dayHigh = Math.max(row.dayHigh ?? row.price, row.price);
        row.dayLow = Math.min(row.dayLow ?? row.price, row.price);
      }
      result.ticks.push({ ticker: row.ticker, at: tick.at, price: row.price });
      for (const item of scheduled) {
        result.news.push({ id: item.id, ticker: item.ticker, kind: 'news', publishAt: tick.at, effectBp: item.effectBp, ...newsArticle(item.ticker, item.effectBp > 0, item.variant) });
      }
      if (!closing) continue;
      result.daily.push({ ticker: row.ticker, date: tick.date, open: row.dayOpen!, high: row.dayHigh!, low: row.dayLow!, close: row.price });
      if (row.price < info.listingPrice * STOCK_RULES.delistRatio) {
        if (row.status === 'warning') {
          Object.assign(row, { status: 'delisted', delistedOn: tick.date, warningSince: null,
            relistOn: addTradingDays(tick.date, STOCK_RULES.relistAfterTradingDays, holidays) });
          result.delisted.push({ ticker: row.ticker, date: tick.date });
          result.news.push(disclosure(row.ticker, 'delist', tick.date, tick.at));
        } else {
          Object.assign(row, { status: 'warning', warningSince: tick.date });
          result.news.push(disclosure(row.ticker, 'warning', tick.date, tick.at));
        }
      } else if (row.status === 'warning') {
        Object.assign(row, { status: 'listed', warningSince: null });
        result.news.push(disclosure(row.ticker, 'release', tick.date, tick.at));
      }
    }
  }
  return result;
}

/** One string that changes whenever any price or status changes. */
export const marketVersion = (rows: readonly StockRow[]) =>
  `${Math.max(0, ...rows.map(row => row.lastTickAt))}.${rows.reduce((sum, row) => sum + row.version, 0)}`;
