import { STOCK_RULES, type Ticker } from './stocks';

/** Statutory fixed-date public holidays (MM-DD). */
const FIXED: Record<string, string> = {
  '01-01': '신정', '03-01': '삼일절', '05-05': '어린이날', '06-06': '현충일',
  '08-15': '광복절', '10-03': '개천절', '10-09': '한글날', '12-25': '성탄절',
};
/** Lunar-calendar and substitute holidays by year. 2027 dates are the 설날·추석 and
 * substitute holidays that several published 2027 calendars agree on (web search,
 * 2026-11-05; the official KASI page was unreachable from the build environment).
 * Anything missing here (e.g. 부처님오신날 2027, 임시공휴일, 선거일) is added by an
 * administrator as a temporary market holiday in the 운영 tab. */
const BY_DATE: Record<string, string> = {
  '2027-02-08': '설날 연휴', '2027-02-09': '설날 대체공휴일',
  '2027-08-16': '광복절 대체공휴일',
  '2027-09-14': '추석 연휴', '2027-09-15': '추석', '2027-09-16': '추석 연휴',
  '2027-10-04': '개천절 대체공휴일', '2027-10-11': '한글날 대체공휴일', '2027-12-27': '성탄절 대체공휴일',
};

const weekdayOf = (date: string) => new Date(`${date}T00:00:00Z`).getUTCDay(); // 0 = Sunday
export const isWeekend = (date: string) => { const day = weekdayOf(date); return day === 0 || day === 6; };
/** Holiday name for a KST date, or null. `extra` are administrator-added market holidays. */
export function holidayName(date: string, extra: ReadonlyMap<string, string> = new Map()): string | null {
  return extra.get(date) ?? BY_DATE[date] ?? FIXED[date.slice(5)] ?? null;
}
export function isTradingDay(date: string, extra: ReadonlyMap<string, string> = new Map()): boolean {
  return !isWeekend(date) && holidayName(date, extra) === null;
}
/** YEGM's winter schedule: in December–February it trades only on Wednesdays. */
export function tradesOn(ticker: Ticker, date: string): boolean {
  if (ticker !== 'YEGM') return true;
  const month = Number(date.slice(5, 7));
  return !(month === 12 || month <= 2) || weekdayOf(date) === STOCK_RULES.yegmWinterWeekday;
}

const minutes = (time: string) => Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5));
/** Tick times of a trading day: 09:00 (the open, overnight events only) then every 10 minutes to 18:00 (the close). */
export function tickTimes(): string[] {
  const out: string[] = [];
  for (let at = minutes(STOCK_RULES.openTime); at <= minutes(STOCK_RULES.closeTime); at += STOCK_RULES.tickMinutes) {
    out.push(`${String(Math.floor(at / 60)).padStart(2, '0')}:${String(at % 60).padStart(2, '0')}`);
  }
  return out;
}
export const TICKS_PER_DAY = tickTimes().length; // 55: open + 54 moves
export const kstTimestamp = (date: string, time: string) => Date.parse(`${date}T${time}:00+09:00`);
export const kstDateOf = (ms: number) => new Date(ms + 9 * 3_600_000).toISOString().slice(0, 10);
export const kstTimeOf = (ms: number) => new Date(ms + 9 * 3_600_000).toISOString().slice(11, 16);
export function nextDate(date: string, days = 1): string {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}
/** The n-th trading day after `date` (n ≥ 1). */
export function addTradingDays(date: string, n: number, extra: ReadonlyMap<string, string> = new Map()): string {
  let current = date;
  for (let count = 0; count < n;) { current = nextDate(current); if (isTradingDay(current, extra)) count++; }
  return current;
}
/** Market status at a moment: open between the first and last tick of a trading day. */
export function marketStatus(now: number, extra: ReadonlyMap<string, string> = new Map()):
  { open: boolean; date: string; holiday: string | null; opensAt: number; closesAt: number } {
  const date = kstDateOf(now);
  const opensAt = kstTimestamp(date, STOCK_RULES.openTime), closesAt = kstTimestamp(date, STOCK_RULES.closeTime);
  const holiday = isWeekend(date) ? null : holidayName(date, extra);
  return { open: isTradingDay(date, extra) && now >= opensAt && now < closesAt, date, holiday, opensAt, closesAt };
}
