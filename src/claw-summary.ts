import { CLAW_RULES } from '../shared/balance';
import type { ClawSummary } from '../shared/types';

/** Home needs the wallet summary, without loading the machine physics. */
export function previewClawSummary(now = Date.now()): ClawSummary {
  return { coins: CLAW_RULES.freeCoins, freeCoins: CLAW_RULES.freeCoins, purchasedCoins: 0,
    nextGrantAt: (Math.floor(now / CLAW_RULES.coinIntervalMs) + 1) * CLAW_RULES.coinIntervalMs,
    serverNow: now, isAdmin: false };
}
