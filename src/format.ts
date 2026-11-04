/** Display formatting only. Date-only and clock-only values already represent KST. */
const kst = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
});

function parts(value: string): Record<string, string> | null {
  const date = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (date) return { year: date[1], month: date[2], day: date[3] };
  const time = /^(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(value);
  if (time) return { hour: time[1], minute: time[2], second: time[3] ?? "00" };
  // A timestamp without an offset must not depend on the device's time zone.
  const iso = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?$/.test(value) ? `${value}+09:00` : value;
  const parsed = new Date(iso);
  return Number.isFinite(parsed.getTime())
    ? Object.fromEntries(kst.formatToParts(parsed).map(part => [part.type, part.value]))
    : null;
}

export function formatDate(value: string): string {
  const p = parts(value);
  return p?.year ? `${p.year}년 ${p.month}월 ${p.day}일` : value;
}
export function formatTime(value: string): string {
  const p = parts(value);
  return p?.hour ? `${p.hour}시 ${p.minute}분` : value;
}
export function formatTimeSeconds(value: string): string {
  const p = parts(value);
  return p?.hour ? `${p.hour}시 ${p.minute}분 ${p.second}초` : value;
}
export function formatDateTime(value: string): string {
  const p = parts(value);
  return p?.year && p.hour ? `${p.year}년 ${p.month}월 ${p.day}일 ${p.hour}시 ${p.minute}분` : value;
}
