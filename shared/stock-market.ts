import { STOCKS, STOCK_RULES, stockInfo, type Ticker } from './stocks';
import { addTradingDays, isTradingDay, kstDateOf, kstTimestamp, nextDate, tickTimes, tradesOn, TICKS_PER_DAY } from './market-calendar';
import { applyEffect, normalFrom, seededRandom, stepPrice } from './stock-engine';
import { disclosureArticle, newsArticle, rumorArticle, type DisclosureKind } from './stock-news-templates';
import { mosquitoArticle, STOCK_GAME_RULES } from './stock-games';
import { companyPhase, featureArticle, PHASES, type Phase } from './stock-lifecycle';

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
export type NewsKind = 'news' | 'feature' | 'disclosure' | 'game' | 'mosquito' | 'rumor' | 'confirm' | 'denied';
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
/** One article every 30 minutes, 09:00–17:30: tick indexes 0, 3, …, 51 (18 slots). */
export const NEWS_SLOTS = Array.from({ length: STOCK_RULES.newsSlots }, (_, n) => n * STOCK_RULES.newsSlotTicks);
export type DayItemKind = 'news' | 'feature' | 'mosquito' | 'rumor' | 'confirm' | 'denied';
/** Every article scheduled for a day, with its template text. The AI morning batch
 * rewrites these before they are published. `phase` is internal (never shown). */
export interface DayItem { id: string; ticker: Ticker; index: number; effectBp: number; kind: DayItemKind; headline: string; body: string; relatedId?: string; phase: Phase }

/** A day's 18 articles. Price-moving items keep their usual number (rumors and
 * their outcome, YEGM mosquito hunts, 4–7 news); every other slot is a mood
 * piece with no price effect. Hidden company phases decide who makes the news
 * and whether moving news is good or bad. */
export function dayItems(seed: string, date: string, phaseSeed = 'phase'): DayItem[] {
  const random = seededRandom(`${seed}|slots`);
  const trading = STOCKS.filter(stock => tradesOn(stock.ticker, date));
  const phaseOf = new Map(trading.map(stock => [stock.ticker, companyPhase(phaseSeed, stock.ticker, date)]));
  const pick = () => {
    const total = trading.reduce((sum, stock) => sum + PHASES[phaseOf.get(stock.ticker)!].weight, 0);
    let roll = random() * total;
    for (const stock of trading) if ((roll -= PHASES[phaseOf.get(stock.ticker)!].weight) < 0) return stock;
    return trading[trading.length - 1]!;
  };
  const free = new Set(NEWS_SLOTS.map((_, slot) => slot));
  const freeSlot = (from = 0, to = NEWS_SLOTS.length - 1) => {
    const options = [...free].filter(slot => slot >= from && slot <= to);
    return options.length ? options[Math.floor(random() * options.length)]! : null;
  };
  const items: DayItem[] = [];
  const add = (slot: number, item: Omit<DayItem, 'index' | 'phase'>) => {
    free.delete(slot);
    items.push({ ...item, index: NEWS_SLOTS[slot]!, phase: phaseOf.get(item.ticker)! });
  };
  if (!trading.length) return [];
  // 찌라시 and its confirmation/denial 2–4 hours (4–8 slots) later.
  const { perDay: [rumorMin, rumorMax], truthRate, spread, confirm, deny, delaySlots: [early, late] } = STOCK_RULES.rumor;
  const rumors = rumorMin + Math.floor(random() * (rumorMax - rumorMin + 1));
  for (let n = 0; n < rumors; n++) {
    const stock = pick();
    const phase = PHASES[phaseOf.get(stock.ticker)!];
    const sign = random() < phase.upRate ? 1 : -1;
    const truth = random() < truthRate;
    const delay = early + Math.floor(random() * (late - early + 1));
    const effectBp = Math.round(sign * (spread[0] + random() * (spread[1] - spread[0])) * 10_000);
    const outcomeBp = truth ? Math.round(sign * (confirm[0] + random() * (confirm[1] - confirm[0])) * 10_000)
      : -effectBp - Math.round(sign * (deny[0] + random() * (deny[1] - deny[0])) * 10_000);
    const variant = Math.floor(random() * 1000);
    const slot = freeSlot(1, NEWS_SLOTS.length - 1 - delay);
    if (slot === null || !free.has(slot + delay)) continue;
    const id = `rumor:${date}:s${slot}`;
    add(slot, { id, ticker: stock.ticker, effectBp, kind: 'rumor', ...rumorArticle(stock.ticker, 'rumor', sign > 0, variant) });
    add(slot + delay, { id: `${truth ? 'confirm' : 'denied'}:${date}:s${slot + delay}`, ticker: stock.ticker, effectBp: outcomeBp, kind: truth ? 'confirm' : 'denied',
      relatedId: id, ...rumorArticle(stock.ticker, truth ? 'confirm' : 'denied', sign > 0, variant) });
  }
  // YEGM mosquito hunts (0–2) on its trading days.
  if (phaseOf.has('YEGM')) {
    const { maxPerDay, successRate, effect: [low, high] } = STOCK_GAME_RULES.mosquito;
    const hunts = Math.floor(random() * (maxPerDay + 1));
    for (let n = 0; n < hunts; n++) {
      const success = random() < successRate;
      const effectBp = Math.round((success ? 1 : -1) * (low + random() * (high - low)) * 10_000);
      const variant = Math.floor(random() * 1000);
      const slot = freeSlot();
      if (slot !== null) add(slot, { id: `mosquito:${date}:s${slot}`, ticker: 'YEGM', effectBp, kind: 'mosquito', ...mosquitoArticle(success, variant) });
    }
  }
  // Price-moving news (4–7), direction and size shaped by the hidden phase.
  const [min, max] = STOCK_RULES.newsPerDay;
  const moving = min + Math.floor(random() * (max - min + 1));
  for (let n = 0; n < moving; n++) {
    const stock = pick();
    const phase = PHASES[phaseOf.get(stock.ticker)!];
    const [low, high] = STOCK_RULES.newsEffect[stock.volatility];
    const sign = random() < phase.upRate ? 1 : -1;
    const effectBp = Math.round(sign * (low + random() * (high - low)) * phase.size * 10_000);
    const variant = Math.floor(random() * 1000);
    const slot = freeSlot();
    if (slot !== null) add(slot, { id: `news:${date}:s${slot}`, ticker: stock.ticker, effectBp, kind: 'news', ...newsArticle(stock.ticker, effectBp > 0, variant) });
  }
  // Every remaining slot: a mood piece (no price effect).
  for (const slot of [...free].sort((a, b) => a - b)) {
    const stock = pick();
    const variant = Math.floor(random() * 1000);
    add(slot, { id: `feature:${date}:s${slot}`, ticker: stock.ticker, effectBp: 0, kind: 'feature', ...featureArticle(stock.ticker, phaseOf.get(stock.ticker)!, variant) });
  }
  return items.sort((a, b) => a.index - b.index);
}

function disclosure(ticker: Ticker, kind: DisclosureKind, date: string, at: number): NewsRecord {
  return { id: `disclosure:${kind}:${ticker}:${date}`, ticker, kind: 'disclosure', publishAt: at, effectBp: null, ...disclosureArticle(ticker, kind) };
}

/** Replay `ticks` in order. `seedOf(date)` must return that date's secret seed. */
export function advanceMarket(input: readonly StockRow[], ticks: readonly MarketTick[], seedOf: (date: string) => string,
  events: readonly PendingEvent[], holidays: ReadonlyMap<string, string>, phaseSeed = 'phase'): AdvanceResult {
  const rows = input.map(row => ({ ...row }));
  const result: AdvanceResult = { rows, ticks: [], daily: [], news: [], appliedEvents: [], delisted: [] };
  const applied = new Set<string>();
  const itemsOf = new Map<string, DayItem[]>();
  const eventNews = (event: PendingEvent, at: number) => {
    if (event.headline && event.body) result.news.push({ id: `event:${event.id}`, ticker: event.ticker, kind: event.kind === 'mosquito' ? 'mosquito' : 'game',
      publishAt: at, headline: event.headline, body: event.body, effectBp: event.effectBp });
  };
  for (const tick of ticks) {
    const seed = seedOf(tick.date);
    let todays = itemsOf.get(tick.date);
    if (!todays) itemsOf.set(tick.date, todays = dayItems(seed, tick.date, phaseSeed));
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
        result.news.push({ id: item.id, ticker: item.ticker, kind: item.kind, publishAt: tick.at, effectBp: item.effectBp, headline: item.headline, body: item.body });
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
