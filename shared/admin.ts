import type { MarketHoliday } from './stock-types';
export interface AdminStockState {
  ai: { enabled: boolean; provider: 'anthropic' | 'openai'; keys: { anthropic: boolean; openai: boolean }; keyConfigured: boolean;
    today: { calls: number; costMicroUsd: number }; month: { calls: number; costMicroUsd: number } };
  news: { id: string; ticker: string | null; kind: string; headline: string; publishAt: string; source: 'ai' | 'template'; hidden: boolean }[];
}
import type { GameId } from './types';

export interface PredictionRules {
  enabled: boolean;
  scoreTable: { maxDifference: number; points: number }[];
  participationGold: number;
  firstGold: number;
  deadline: string;
  revealTime: string | null;
}
export const ADMIN_LIMITS = {
  scoreRows: [1, 10], points: [0, 100], participationGold: [0, 1000], firstGold: [0, 10000],
  payoutEvery: [1, 50], weakPowerPercent: [5, 100],
} as const;
export interface AdminClawConfig { payoutEvery: number; weakPickup: number; weakCarry: number }
export interface AdminGameSettings {
  id: GameId;
  rules: PredictionRules;
  scheduledRules: PredictionRules | null;
  canApplyToday: boolean;
  activityReason: string | null;
}
export interface AdminChange {
  id: string;
  adminId: string;
  adminName: string;
  target: string;
  before: unknown;
  after: unknown;
  effectiveFrom: string;
  createdAt: string;
}
export interface AdminState {
  today: string;
  tomorrow: string;
  games: AdminGameSettings[];
  claw: AdminClawConfig;
  changes: AdminChange[];
  /** Administrator-added market holidays from today on. */
  marketHolidays: MarketHoliday[];
  /** Stock AI switch and spend, and recently published news (never future news). */
  stock: AdminStockState;
  serverTime: string;
}
