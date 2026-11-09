import { useEffect, useState } from "react";
import { PLAY_RULES, playClosed } from "../shared/balance";
import { kstDateOf } from "../shared/ranking-periods";

/** Milliseconds until the next 23:50 or 00:00 KST boundary. */
function untilNextBoundary(now: number): number {
  const today = kstDateOf(new Date(now).toISOString());
  const close = Date.parse(`${today}T${PLAY_RULES.closeTime}+09:00`);
  const midnight = Date.parse(`${today}T00:00:00+09:00`) + 86_400_000;
  return (now < close ? close : midnight) - now;
}

/** True from 23:50 to midnight KST on this device's clock; the Worker enforces
 * the same window, so this only explains why play buttons are off. */
export function usePlayClosed(): boolean {
  const [closed, setClosed] = useState(() => playClosed(Date.now()));
  useEffect(() => {
    let timer: number | undefined;
    const update = () => {
      setClosed(playClosed(Date.now()));
      window.clearTimeout(timer);
      timer = window.setTimeout(update, untilNextBoundary(Date.now()) + 500);
    };
    update();
    document.addEventListener("visibilitychange", update);
    return () => { window.clearTimeout(timer); document.removeEventListener("visibilitychange", update); };
  }, []);
  return closed;
}

/** Today's KST date on this device's clock. */
export const todayKst = () => kstDateOf(new Date().toISOString());
