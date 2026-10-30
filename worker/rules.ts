import type { GameId } from '../shared/types';

export const TIME_ZONE = 'Asia/Seoul' as const;
export const GAME_RULES = {
  wake: { title: '기상시간 맞히기', author: 'min', deadline: '10:30' },
  offwork: { title: '퇴근시간 맞히기', author: 'siwon', deadline: '17:00' },
  luck: { title: '행운 점수 맞히기', author: 'yeseo', deadline: '17:00' },
} satisfies Record<GameId, { title: string; author: string; deadline: string }>;
export const GAME_IDS = Object.keys(GAME_RULES) as GameId[];
export function isGameId(value: string): value is GameId { return GAME_IDS.includes(value as GameId); }
export function kstDate(now: Date = new Date()): string {
  return new Date(now.getTime() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
}
export function kstTimestamp(date: string, time: string): number {
  return Date.parse(`${date}T${time}:00+09:00`);
}
export function weekStart(now: Date = new Date()): string {
  const day = new Date(`${kstDate(now)}T00:00:00Z`);
  day.setUTCDate(day.getUTCDate() - ((day.getUTCDay() + 6) % 7));
  return day.toISOString().slice(0, 10);
}
export function validValue(game: GameId, value: unknown): value is string {
  if (typeof value !== 'string') return false;
  if (game === 'luck') return /^(?:0|[1-9][0-9]?|100)$/.test(value);
  return /^(?:[01][0-9]|2[0-3]):[0-5][0-9]$/.test(value);
}
export function valueDifference(game: GameId, left: string, right: string): number {
  const numeric = (value: string) => game === 'luck' ? Number(value) : Number(value.slice(0, 2)) * 60 + Number(value.slice(3));
  return Math.abs(numeric(left) - numeric(right));
}
