import { createContext, useCallback, useContext, useEffect, useState, useSyncExternalStore } from "react";
import { attendanceCycleDay, attendanceReward } from "../shared/balance";
import type { AttendanceState } from "../shared/types";
import { kstParts } from "./sample";

export interface AttendanceContextValue {
  attendance: AttendanceState;
  claim: () => Promise<{ attendance: AttendanceState; awarded: boolean }>;
  loadMonth: (month: string) => Promise<AttendanceState>;
  preview: boolean;
}
const AttendanceContext = createContext<AttendanceContextValue | null>(null);
export const AttendanceProvider = AttendanceContext.Provider;

/** Signed-in attendance always comes from the current server session. */
export function useAttendance(_legacyKey?: string) {
  const context = useContext(AttendanceContext);
  if (!context) throw new Error("AttendanceProvider is required");
  return { ...context.attendance, days: new Set(context.attendance.days), claim: context.claim, loadMonth: context.loadMonth, preview: context.preview };
}

const previewKey = "yegoom3:attendance:preview";
const listeners = new Set<() => void>();
let previewCache: string | null = null;
export const dayKey = (date = new Date()) => {
  const t = kstParts(date);
  return `${t.year}-${String(t.month).padStart(2, "0")}-${String(t.day).padStart(2, "0")}`;
};

/** Old device records are untrusted and are deliberately never uploaded. */
export function clearLegacyAttendance(username: string) {
  if (username === "preview") return;
  try { localStorage.removeItem(`yegoom3:attendance:${username}`); }
  catch { /* Storage may be disabled. Server attendance still works. */ }
}
function previewDays(): string {
  const t = kstParts();
  const missed = [6, 14, 15, 25];
  return Array.from({ length: t.day - 1 }, (_, i) => i + 1)
    .filter(day => !missed.includes(day))
    .map(day => `${t.year}-${String(t.month).padStart(2, "0")}-${String(day).padStart(2, "0")}`)
    .join(",");
}
function readPreview(): string {
  if (previewCache !== null) return previewCache;
  try {
    const stored = localStorage.getItem(previewKey);
    if (stored !== null) return stored;
  } catch { /* Keep the offline preview usable without storage. */ }
  return previewDays();
}
function subscribe(listener: () => void) {
  listeners.add(listener);
  const storage = (event: StorageEvent) => {
    if (event.key === previewKey || event.key === null) { previewCache = null; listener(); }
  };
  window.addEventListener("storage", storage);
  return () => { listeners.delete(listener); window.removeEventListener("storage", storage); };
}
function previewState(raw: string, today: string, month = today.slice(0, 7)): AttendanceState {
  const days = new Set(raw.split(",").filter(date => /^\d{4}-\d{2}-\d{2}$/.test(date)));
  const claimed = days.has(today);
  let previous = 0;
  let cursor = Date.parse(`${today}T00:00:00Z`) - (claimed ? 0 : 86_400_000);
  while (days.has(new Date(cursor).toISOString().slice(0, 10))) { previous += 1; cursor -= 86_400_000; }
  const streak = previous + (claimed ? 0 : 1);
  const monthlyDays = [...days].filter(date => date.startsWith(`${month}-`)).sort();
  return { today, claimed, streak, cycleDay: attendanceCycleDay(streak), reward: attendanceReward(streak), canClaim: !claimed, month, monthCount: monthlyDays.length, days: monthlyDays };
}

/** Only the logged-out preview persists attendance on this device. */
export function usePreviewAttendance(enabled = true): AttendanceContextValue & { goldBonus: number } {
  const raw = useSyncExternalStore(subscribe, readPreview);
  const [today, setToday] = useState(dayKey);
  useEffect(() => {
    if (!enabled) return;
    setToday(dayKey());
    const timer = window.setInterval(() => setToday(dayKey()), 30_000);
    return () => window.clearInterval(timer);
  }, [enabled]);
  const attendance = previewState(raw, today);
  const claim = useCallback(async () => {
    const currentDate = dayKey();
    const before = previewState(readPreview(), currentDate);
    if (before.claimed) return { attendance: before, awarded: false };
    const days = new Set(readPreview().split(",").filter(Boolean));
    days.add(currentDate);
    previewCache = [...days].sort().join(",");
    try { localStorage.setItem(previewKey, previewCache); }
    catch { /* In-memory preview is enough when storage is blocked. */ }
    listeners.forEach(listener => listener());
    setToday(currentDate);
    return { attendance: previewState(previewCache, currentDate), awarded: true };
  }, []);
  const loadMonth = useCallback(async (month: string) => previewState(readPreview(), dayKey(), month), []);
  return { attendance, claim, loadMonth, preview: true, goldBonus: attendance.claimed ? attendance.reward : 0 };
}
