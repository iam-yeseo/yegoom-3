import { useEffect, useState } from "react";
import { PLAY_RULES, playClosed } from "../shared/balance";
import { kstDateOf } from "../shared/ranking-periods";

/** The server's clock as last read (bootstrap's serverTime). The Worker decides
 * the 23:50 window on its own clock, so a phone whose clock is a few minutes
 * off must not open or close play buttons at a different moment. */
let serverOffset = 0;
const clockListeners = new Set<() => void>();
export function syncServerClock(serverTime: string) {
  const parsed = Date.parse(serverTime);
  if (!Number.isFinite(parsed)) return;
  serverOffset = parsed - Date.now();
  clockListeners.forEach(listener => listener());
}
/** Now on the server's clock (this device's clock until a server time is read). */
export const serverNow = () => Date.now() + serverOffset;

/** Milliseconds until the next 23:50 or 00:00 KST boundary. */
function untilNextBoundary(now: number): number {
  const today = kstDateOf(new Date(now).toISOString());
  const close = Date.parse(`${today}T${PLAY_RULES.closeTime}+09:00`);
  const midnight = Date.parse(`${today}T00:00:00+09:00`) + 86_400_000;
  return (now < close ? close : midnight) - now;
}

/** True from 23:50 to midnight KST on the server's clock; the Worker enforces
 * the same window, so this only explains why play buttons are off. */
export function usePlayClosed(): boolean {
  const [closed, setClosed] = useState(() => playClosed(serverNow()));
  useEffect(() => {
    let timer: number | undefined;
    const update = () => {
      const now = serverNow();
      setClosed(playClosed(now));
      window.clearTimeout(timer);
      timer = window.setTimeout(update, untilNextBoundary(now) + 500);
    };
    update();
    clockListeners.add(update);
    document.addEventListener("visibilitychange", update);
    return () => { window.clearTimeout(timer); clockListeners.delete(update); document.removeEventListener("visibilitychange", update); };
  }, []);
  return closed;
}

/** Today's KST date on the server's clock. */
export const todayKst = () => kstDateOf(new Date(serverNow()).toISOString());
