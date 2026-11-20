import { arcadeSlot, arcadeSlotStart, type ArcadeGame } from "../../shared/balance";
import type { ArcadeSummary } from "../../shared/types";

/** The home tile before the preview has played anything (no engine import). */
export function previewArcadeSummary(game: ArcadeGame, now = Date.now()): ArcadeSummary {
  return { available: true, played: false, completed: false, made: 0, nextSlotAt: arcadeSlotStart(game, arcadeSlot(game, now) + 1), serverNow: now, isAdmin: false };
}
/** KST clock hour of an epoch time, e.g. "15시". */
export const kstHour = (time: number) => `${String(new Date(time + 9 * 3_600_000).getUTCHours()).padStart(2, "0")}시`;
/** Home tile line: whether a set can be played now, else when the next opens. */
export function arcadeTileText(summary: ArcadeSummary, unit: string): string {
  if (summary.isAdmin) return "연습 모드";
  if (summary.available) return "이번 세트 도전 가능";
  const next = `다음 세트 ${kstHour(summary.nextSlotAt)}`;
  return summary.completed ? `이번 세트 ${summary.made}${unit} · ${next}` : next;
}
