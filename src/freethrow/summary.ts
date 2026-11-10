import { freeThrowSlot, freeThrowSlotStart } from "../../shared/balance";
import type { FreeThrowSummary } from "../../shared/types";

/** The home tile before the preview has thrown anything (no physics import). */
export function previewFreeThrowSummary(now = Date.now()): FreeThrowSummary {
  return { available: true, played: false, completed: false, made: 0, nextSlotAt: freeThrowSlotStart(freeThrowSlot(now) + 1), serverNow: now, isAdmin: false };
}
