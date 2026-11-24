import { useRef } from "react";

export interface KeptOffset { stamp: string | undefined; offset: number }

/** Server time minus this device's clock, measured only when a new `serverTime`
 * stamp arrives.
 *
 * A stamp is a moment in the past once the component re-renders on its own
 * (its countdown ticks every second), so it must not be measured again: that
 * would pull the clock back to the stamp each time and freeze the countdown.
 * The app also hands some screens a fresh stamp on every render; a new
 * measurement within a second of the kept one keeps the old offset, so the
 * timers that depend on it are not restarted. */
export function keepServerOffset(kept: KeptOffset | null, serverTime: string | undefined, deviceNow: number): KeptOffset {
  if (kept && kept.stamp === serverTime) return kept;
  const measured = serverTime ? Date.parse(serverTime) - deviceNow : 0;
  const offset = kept && Number.isFinite(measured) && Math.abs(measured - kept.offset) <= 1000 ? kept.offset
    : Number.isFinite(measured) ? measured : 0;
  return { stamp: serverTime, offset };
}

export function useServerOffset(serverTime: string | undefined): number {
  const kept = useRef<KeptOffset | null>(null);
  kept.current = keepServerOffset(kept.current, serverTime, Date.now());
  return kept.current.offset;
}
