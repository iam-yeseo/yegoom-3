import { useSyncExternalStore } from "react";
import { kstParts } from "./sample";

// Attendance has no server endpoint yet, so claims are remembered per user on
// this device. The preview account starts from a sample month.
const key = (username: string) => `yegoom3:attendance:${username}`;
const listeners = new Set<() => void>();
const cache = new Map<string, string>();

export const dayKey = (date = new Date()) => {
  const t = kstParts(date);
  return `${t.year}-${String(t.month).padStart(2, "0")}-${String(t.day).padStart(2, "0")}`;
};
function previewDays(): string[] {
  const t = kstParts();
  const missed = [6, 14, 15, 25];
  return Array.from({ length: t.day - 1 }, (_, i) => i + 1)
    .filter((day) => !missed.includes(day))
    .map(
      (day) =>
        `${t.year}-${String(t.month).padStart(2, "0")}-${String(day).padStart(2, "0")}`,
    );
}
function read(username: string): string {
  try {
    const stored = localStorage.getItem(key(username));
    if (stored !== null) return stored;
  } catch {
    // Storage blocked: fall through to the in-memory copy.
  }
  return cache.get(username) ?? (username === "preview" ? previewDays().join(",") : "");
}
export function claimToday(username: string) {
  const days = new Set(read(username).split(",").filter(Boolean));
  days.add(dayKey());
  const value = [...days].sort().join(",");
  cache.set(username, value);
  try {
    localStorage.setItem(key(username), value);
  } catch {
    // Remembered for this page only.
  }
  listeners.forEach((listener) => listener());
}
function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
export function useAttendance(username: string) {
  const raw = useSyncExternalStore(subscribe, () => read(username));
  const days = new Set(raw.split(",").filter(Boolean));
  const today = dayKey();
  const claimed = days.has(today);
  let streak = 0;
  const cursor = new Date();
  if (!claimed) cursor.setTime(cursor.getTime() - 86_400_000);
  while (days.has(dayKey(cursor))) {
    streak += 1;
    cursor.setTime(cursor.getTime() - 86_400_000);
  }
  const t = kstParts();
  const monthPrefix = `${t.year}-${String(t.month).padStart(2, "0")}-`;
  const monthCount = [...days].filter((day) => day.startsWith(monthPrefix)).length;
  return { days, claimed, streak, monthCount };
}
