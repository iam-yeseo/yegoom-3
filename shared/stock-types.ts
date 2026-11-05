import type { StockStatus } from './stock-market';
import type { Ticker } from './stocks';

export interface StockQuote {
  ticker: Ticker; price: number; prevClose: number;
  dayOpen: number | null; dayHigh: number | null; dayLow: number | null;
  status: StockStatus;
  /** YEGM's winter schedule: no trading and no moves today. */
  halted: boolean;
  warningSince: string | null; delistedOn: string | null; relistOn: string | null;
  version: number;
  /** The viewer's holding. */
  held: number; costBasis: number;
}
export interface MarketClock {
  open: boolean; date: string; holiday: string | null;
  opensAt: string; closesAt: string;
  /** When prices next move (the next 10-minute tick), for polling. */
  nextTickAt: string | null;
}
export type StockNewsKind = 'news' | 'feature' | 'disclosure' | 'rumor' | 'confirm' | 'denied' | 'game' | 'mosquito' | 'whale' | 'close' | 'comment' | 'weekly';
export interface StockNewsItem {
  id: string; ticker: Ticker | null; kind: StockNewsKind;
  headline: string; body: string; publishAt: string;
  /** The event's intended move in basis points (null for disclosures and notices). */
  effectBp: number | null;
  source: 'ai' | 'template';
}
export interface StockTradeView {
  id: string; requestId: string; ticker: Ticker; side: 'buy' | 'sell' | 'delist';
  quantity: number; price: number; fee: number; total: number; costBasis: number; createdAt: string;
}
export interface Candle { date: string; open: number; high: number; low: number; close: number }
export interface StockMarketView {
  market: MarketClock; version: string; stocks: StockQuote[]; news: StockNewsItem[];
  /** While the market is closed: the latest close summary, the viewer's own comment and (Fridays) the weekly report. */
  closing: { summary: StockNewsItem | null; comment: StockNewsItem | null; weekly: StockNewsItem | null } | null;
  gold: number; canTrade: boolean; serverTime: string;
}
export interface StockUnchanged { unchanged: true; version: string; market: MarketClock; serverTime: string }
export interface StockDetailView {
  market: MarketClock; version: string; stock: StockQuote;
  /** The latest trading day's 10-minute prices for this stock. */
  ticks: { at: number; price: number }[];
  /** Up to 22 most recent daily candles, oldest first. */
  daily: Candle[];
  news: StockNewsItem[]; trades: StockTradeView[];
  gold: number; canTrade: boolean;
  /** Why this viewer cannot trade this stock right now (e.g. game author), or null. */
  tradeBlock: string | null;
  serverTime: string;
}
export interface StockTradeInput { requestId: string; ticker: Ticker; side: 'buy' | 'sell'; quantity: number; expectedVersion: number }
export interface StockTradeResponse { trade: StockTradeView; stock: StockQuote; gold: number; replayed: boolean }
export interface StockNewsPage { news: StockNewsItem[]; nextBefore: string | null; serverTime: string }
export interface StockHomeSummary { open: boolean; holiday: string | null; value: number; cost: number }
export interface MarketHoliday { date: string; reason: string }
