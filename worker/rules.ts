import type { GameId } from '../shared/types';
import { GAME_RULES } from '../shared/balance';
export { GAME_RULES } from '../shared/balance';

export const TIME_ZONE = 'Asia/Seoul' as const;
export const GAME_IDS = Object.keys(GAME_RULES) as GameId[];
export function isGameId(value: string): value is GameId { return GAME_IDS.includes(value as GameId); }
export function kstDate(now: Date = new Date()): string {
  return new Date(now.getTime() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
}
export function kstTimestamp(date: string, time: string): number {
  return Date.parse(`${date}T${time}+09:00`);
}
export function kstTime(now: Date = new Date()): string {
  return new Date(now.getTime() + 9 * 60 * 60 * 1000).toISOString().slice(11, 19);
}
export function weekStart(now: Date = new Date()): string {
  const day = new Date(`${kstDate(now)}T00:00:00Z`);
  day.setUTCDate(day.getUTCDate() - ((day.getUTCDay() + 6) % 7));
  return day.toISOString().slice(0, 10);
}
export function validValue(game: GameId, value: unknown): value is string {
  if (typeof value !== 'string') return false;
  if (game === 'luck') return /^(?:0|[1-9][0-9]?|100)$/.test(value);
  return /^(?:[01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9]$/.test(value);
}
export function valueDifference(game: GameId, left: string, right: string): number {
  const numeric = (value: string) => game === 'luck' ? Number(value) : Number(value.slice(0, 2)) * 3600 + Number(value.slice(3, 5)) * 60 + Number(value.slice(6, 8));
  return Math.abs(numeric(left) - numeric(right));
}
