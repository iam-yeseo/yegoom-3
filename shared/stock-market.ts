import { STOCKS, STOCK_RULES, stockInfo, type Ticker } from './stocks';
import { addTradingDays, isTradingDay, kstDateOf, kstTimestamp, nextDate, tickTimes, tradesOn, TICKS_PER_DAY } from './market-calendar';
import { applyEffect, normalFrom, seededRandom, stepPrice } from './stock-engine';
import { disclosureArticle, newsArticle, type DisclosureKind } from './stock-news-templates';
import { mosquitoArticle, STOCK_GAME_RULES } from './stock-games';

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
/** A 10-minute tick (index 0 = 09:00 open … 54 = 18:00 close), or an event step
 * (index -1) that moves one stock the moment an event is published in market hours. */
export interface MarketTick { at: number; date: string; index: number; ticker?: Ticker }
/** A price event decided elsewhere (game results; rumors in PR 12). Its article,
 * if any, is published when the price moves. */
export interface PendingEvent { id: string; ticker: Ticker; effectBp: number; applyAt: number; kind?: string; headline?: string; body?: string }
export type NewsKind = 'news' | 'disclosure' | 'game' | 'mosquito';
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
/** Ticks plus event steps: an event published while the market is open (on a
 * trading day of its stock) moves that stock at that instant, not at the next tick. */
export function marketSteps(from: number, until: number, holidays: ReadonlyMap<string, string>, events: readonly PendingEvent[],
  limit: number = STOCK_RULES.maxCatchUpTicks): MarketTick[] {
  const ticks = pendingTicks(from, until, holidays, limit);
  const end = ticks.length >= limit ? ticks[ticks.length - 1]!.at : until;
  const steps: MarketTick[] = [];
  for (const event of events) {
    const at = Math.max(event.applyAt, from + 1);
    if (at > end) continue;
    const date = kstDateOf(at);
    if (!isTradingDay(date, holidays) || !tradesOn(event.ticker, date)) continue;
    if (at <= kstTimestamp(date, STOCK_RULES.openTime) || at >= kstTimestamp(date, STOCK_RULES.closeTime)) continue;
    if (ticks.some(tick => tick.at === at) || steps.some(step => step.at === at && step.ticker === event.ticker)) continue;
    steps.push({ at, date, index: -1, ticker: event.ticker });
  }
  return [...ticks, ...steps].sort((a, b) => a.at - b.at || (a.ticker ?? '').localeCompare(b.ticker ?? ''));
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

export interface ScheduledMosquito { id: string; index: number; success: boolean; effectBp: number; variant: number }
/** YEGM's mosquito hunts of a day (0–2), on its trading days only. */
export function scheduledMosquito(seed: string, date: string): ScheduledMosquito[] {
  if (!tradesOn('YEGM', date)) return [];
  const random = seededRandom(`${seed}|mosquito`);
  const { maxPerDay, successRate, effect: [low, high] } = STOCK_GAME_RULES.mosquito;
  const count = Math.floor(random() * (maxPerDay + 1));
  return Array.from({ length: count }, (_, n) => {
    const index = 1 + Math.floor(random() * (TICKS_PER_DAY - 2));
    const success = random() < successRate;
    const size = low + random() * (high - low);
    return { id: `mosquito:${date}:${n}`, index, success, effectBp: Math.round((success ? 1 : -1) * size * 10_000), variant: Math.floor(random() * 1000) };
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
  const mosquitoOf = new Map<string, ScheduledMosquito[]>();
  const eventNews = (event: PendingEvent, at: number) => {
    if (event.headline && event.body) result.news.push({ id: `event:${event.id}`, ticker: event.ticker, kind: event.kind === 'mosquito' ? 'mosquito' : 'game',
      publishAt: at, headline: event.headline, body: event.body, effectBp: event.effectBp });
  };
  for (const tick of ticks) {
    const seed = seedOf(tick.date);
    let todays = newsOf.get(tick.date);
    if (!todays) newsOf.set(tick.date, todays = scheduledNews(seed, tick.date));
    let hunts = mosquitoOf.get(tick.date);
    if (!hunts) mosquitoOf.set(tick.date, hunts = scheduledMosquito(seed, tick.date));
    const closing = tick.index === TICKS_PER_DAY - 1;
    if (tick.index === -1) {
      // Event step: only the event's stock moves, at the publication instant.
      for (const row of rows) row.lastTickAt = tick.at;
      const row = rows.find(item => item.ticker === tick.ticker)!;
      const due = events.filter(event => event.ticker === row.ticker && event.applyAt <= tick.at && !applied.has(event.id));
      for (const event of due) { applied.add(event.id); result.appliedEvents.push({ id: event.id, at: tick.at }); }
      if (row.status === 'delisted' || !due.length) continue;
      row.version += 1;
      row.price = applyEffect(row.price, row.prevClose, due.reduce((sum, event) => sum + event.effectBp, 0) / 10_000);
      row.dayOpen ??= row.price;
      row.dayHigh = Math.max(row.dayHigh ?? row.price, row.price);
      row.dayLow = Math.min(row.dayLow ?? row.price, row.price);
      result.ticks.push({ ticker: row.ticker, at: tick.at, price: row.price });
      for (const event of due) eventNews(event, tick.at);
      continue;
    }
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
      const hunted = row.ticker === 'YEGM' ? hunts.filter(item => item.index === tick.index) : [];
      const effect = (due.reduce((sum, event) => sum + event.effectBp, 0) + scheduled.reduce((sum, item) => sum + item.effectBp, 0)
        + hunted.reduce((sum, item) => sum + item.effectBp, 0)) / 10_000;
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
      for (const item of hunted) {
        result.news.push({ id: item.id, ticker: 'YEGM', kind: 'mosquito', publishAt: tick.at, effectBp: item.effectBp, ...mosquitoArticle(item.success, item.variant) });
      }
      for (const event of due) eventNews(event, tick.at);
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
