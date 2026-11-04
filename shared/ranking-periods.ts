/** Ranking periods and score attribution shared by the Worker, screens and previews.
 * Every date is a KST calendar date (YYYY-MM-DD). */
export type RankingPeriod = 'day' | 'week' | 'month';
export const RANKING_PERIODS: readonly RankingPeriod[] = ['day', 'week', 'month'];
export const RANKING_RULES = { historyPageSize: 20, clientCacheMs: 30_000 } as const;
export const isRankingPeriod = (value: unknown): value is RankingPeriod =>
  typeof value === 'string' && (RANKING_PERIODS as readonly string[]).includes(value);

export type ScoreGame = 'wake' | 'offwork' | 'luck' | 'catchmind' | 'kuji' | 'claw' | 'other';
export const SCORE_GAME_ORDER: readonly ScoreGame[] = ['wake', 'offwork', 'luck', 'catchmind', 'kuji', 'claw', 'other'];
export const SCORE_GAME_LABELS: Record<ScoreGame, string> = {
  wake: '기상시간 맞히기', offwork: '퇴근시간 맞히기', luck: '행운 점수 맞히기',
  catchmind: '캐치마인드', kuji: '예굼쿠지', claw: '캐릭터 뽑기', other: '기타',
};
/** Short bar labels for the daily per-game chart. */
export const SCORE_GAME_SHORT: Record<ScoreGame, string> = {
  wake: '기상', offwork: '퇴근', luck: '행운', catchmind: '캐치', kuji: '쿠지', claw: '뽑기', other: '기타',
};

/** The game is read from the ledger reference prefix, never from reason text.
 * An unknown prefix keeps its stored reason as the label. */
export function scoreSource(reference: string, reason: string): { game: ScoreGame; label: string } {
  const prediction = /^score:(wake|offwork|luck):/.exec(reference)?.[1] as ScoreGame | undefined;
  if (prediction) return { game: prediction, label: SCORE_GAME_LABELS[prediction] };
  if (reference.startsWith('catchmind:score:')) return { game: 'catchmind', label: SCORE_GAME_LABELS.catchmind };
  if (reference.startsWith('kuji:')) return { game: 'kuji', label: SCORE_GAME_LABELS.kuji };
  if (reference.startsWith('claw:clear:')) return { game: 'claw', label: `${SCORE_GAME_LABELS.claw} · 클리어 보너스` };
  if (reference.startsWith('claw:')) return { game: 'claw', label: SCORE_GAME_LABELS.claw };
  return { game: 'other', label: reason };
}

export function kstDateOf(iso: string): string {
  return new Date(Date.parse(iso) + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
}
export function addDays(date: string, days: number): string {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}
/** Monday of the KST week containing the date. */
export function mondayOf(date: string): string {
  const value = new Date(`${date}T00:00:00Z`);
  return addDays(date, -((value.getUTCDay() + 6) % 7));
}
function lastDayOfMonth(date: string): string {
  const value = new Date(`${date.slice(0, 7)}-01T00:00:00Z`);
  value.setUTCMonth(value.getUTCMonth() + 1, 0);
  return value.toISOString().slice(0, 10);
}

/** Inclusive KST date range of the period that contains `today`. */
export function rankingRange(period: RankingPeriod, today: string): { start: string; end: string } {
  if (period === 'day') return { start: today, end: today };
  if (period === 'week') { const start = mondayOf(today); return { start, end: addDays(start, 6) }; }
  return { start: `${today.slice(0, 7)}-01`, end: lastDayOfMonth(today) };
}
/** Week keys (`ledger.week_start`) that can hold a game date in the range. */
export function weeksOverlapping(range: { start: string; end: string }): string[] {
  const weeks: string[] = [];
  for (let monday = mondayOf(range.start); monday <= range.end; monday = addDays(monday, 7)) weeks.push(monday);
  return weeks;
}
/** The calendar date a score belongs to: a prediction's round date, a Catchmind
 * round's publication date, otherwise the KST date it was earned. Matches the
 * week key every score row is written with. */
export function scoreGameDate(reference: string, createdAt: string, catchmindRoundDate: string | null): string {
  return catchmindRoundDate
    ?? /^score:(?:wake|offwork|luck):(\d{4}-\d{2}-\d{2}):/.exec(reference)?.[1]
    ?? kstDateOf(createdAt);
}
/** 1-based week of the month used by the monthly chart (days 1–7 are week 1). */
export const monthWeek = (date: string) => Math.ceil(Number(date.slice(8, 10)) / 7);
