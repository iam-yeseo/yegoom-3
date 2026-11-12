import { useRef } from "react";

/** Server time minus this device's clock, from a `serverTime` stamp.
 *
 * The app hands screens a fresh stamp on every render. Treated as an effect
 * dependency, that restarted their timers and set state again each time the
 * app re-rendered. The offset only really changes when the device clock does,
 * so the first measurement is kept until a new one disagrees by over a second. */
export function useServerOffset(serverTime: string | undefined): number {
  const kept = useRef<number | null>(null);
  const measured = serverTime ? Date.parse(serverTime) - Date.now() : 0;
  if (kept.current === null || Math.abs(measured - kept.current) > 1000) kept.current = measured;
  return kept.current;
}
