/** A notice belongs to one account and one KST draw, never to a browser-wide day. */
export const lottoSeenKey = (userId: string, drawDate: string) => `yegoom3:lotto-seen:${userId}:${drawDate}`;

export function hasSeenLotto(userId: string, drawDate: string): boolean {
  try { return localStorage.getItem(lottoSeenKey(userId, drawDate)) === "1"; }
  catch { return false; }
}

export function markLottoSeen(userId: string, drawDate: string): void {
  try { localStorage.setItem(lottoSeenKey(userId, drawDate), "1"); }
  catch { /* The current card can close; a later visit may show it again. */ }
}

/** A result can reach the lotto screen before the next bootstrap notice does. */
export function markViewedLottoDraw(userId: string, path: string, draw: LottoState["todayDraw"] | null, serverTime: string): void {
  if (path !== "/shop/lotto" || !draw?.numbers?.length || !(Date.parse(serverTime) >= Date.parse(`${draw.date}T${LOTTO_RULES.drawTime}+09:00`))) return;
  markLottoSeen(userId, draw.date);
}

export const noticeDate = (time: number) => new Date(time + 9 * 3_600_000).toISOString().slice(0, 10);

/** Once a draw day has ended locally, a delayed snapshot must not revive it. */
export function advanceNoticeOffset(previous: number | null, serverTime: string, localNow: number): number {
  const incoming = Date.parse(serverTime) - localNow;
  return previous === null ? incoming : Math.max(previous, incoming);
}

export function nextKstMidnight(time: number): number {
  return Date.parse(`${noticeDate(time)}T00:00:00+09:00`) + 86_400_000;
}
import { LOTTO_RULES } from "../shared/balance";
import type { LottoState } from "../shared/types";
