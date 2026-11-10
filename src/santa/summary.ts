import { SANTA_RULES, santaOpen, santaSlot, santaSlotStart } from "../../shared/balance";
import type { SantaSummary } from "../../shared/types";

/** The home tile before the preview has delivered anything (no engine import). */
export function previewSantaSummary(now = Date.now()): SantaSummary {
  return { open: santaOpen(now), available: santaOpen(now), inProgress: false, hits: 0, drops: 0,
    nextSlotAt: santaSlotStart(santaSlot(now) + 1), endsAt: SANTA_RULES.endsAt, serverNow: now, isAdmin: false };
}
/** The tile shows from release until the last run's grace time ends. */
export const santaTileVisible = (summary: SantaSummary) => summary.open || summary.inProgress;
/** Home tile line. */
export function santaTileText(summary: SantaSummary): string {
  if (summary.isAdmin) return "기록 구경하기";
  if (summary.inProgress) return `배달 중 · ${summary.drops}/${SANTA_RULES.houses}집`;
  if (summary.available) return "지금 출발할 수 있어요";
  if (summary.nextSlotAt >= summary.endsAt) return "올해 배달은 모두 끝났어요";
  return `다음 배달 ${new Date(summary.nextSlotAt + 9 * 3_600_000).getUTCHours() === 12 ? "오후 12시" : "자정"}`;
}
