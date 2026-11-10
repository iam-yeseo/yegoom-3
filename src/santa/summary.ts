import { SANTA_RULES, santaOpen, santaSlot, santaSlotStart } from "../../shared/balance";
import type { SantaSummary } from "../../shared/types";

/** The home tile before the preview has delivered anything (no engine import). */
export function previewSantaSummary(now = Date.now()): SantaSummary {
  return { open: santaOpen(now), available: santaOpen(now), played: false, completed: false, hits: 0,
    nextSlotAt: santaSlotStart(santaSlot(now) + 1), endsAt: SANTA_RULES.endsAt, serverNow: now, isAdmin: false };
}
/** The tile shows while the event takes runs. */
export const santaTileVisible = (summary: SantaSummary) => summary.open;
/** When the next run opens: "오후 12시" or "자정". */
export const santaOpensAt = (time: number) => (new Date(time + 9 * 3_600_000).getUTCHours() === 12 ? "오후 12시" : "자정");
/** Home tile line. */
export function santaTileText(summary: SantaSummary): string {
  if (summary.isAdmin) return "기록 구경하기";
  if (summary.available) return "지금 출발할 수 있어요";
  const next = summary.nextSlotAt >= summary.endsAt ? "올해 배달 끝" : `다음 배달 ${santaOpensAt(summary.nextSlotAt)}`;
  return summary.completed ? `이번 배달 ${summary.hits}곳 성공 · ${next}` : next;
}
