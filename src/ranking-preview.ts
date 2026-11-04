import { previewScores } from "./sample";
import { addDays, kstDateOf, mondayOf, rankingRange, type RankingPeriod } from "../shared/ranking-periods";
import { summarizeRanking, type RankingCursor, type RankingPlayerRow, type RankingScoreRow } from "../shared/ranking-summary";
import type { RankingResponse } from "../shared/types";

/** Small deterministic generator so every preview visit shows the same history. */
function seeded(text: string) {
  let state = 2166136261;
  for (const character of text) state = Math.imul(state ^ character.charCodeAt(0), 16777619) >>> 0;
  return (max: number) => { state = Math.imul(state ^ (state >>> 15), 2246822519) >>> 0; return state % max; };
}
/** Never show a preview score earned later than the current moment. */
const at = (date: string, time: string, now: Date) =>
  new Date(Math.min(Date.parse(`${date}T${time}+09:00`), now.getTime() - 60_000)).toISOString();

/** One player's points for one day split across the games played that day. */
function dayRows(username: string, userId: string, date: string, total: number, random: (max: number) => number, now: Date): RankingScoreRow[] {
  const rows: RankingScoreRow[] = [];
  let left = total;
  const add = (amount: number, reference: string, reason: string, time: string) => {
    if (amount <= 0) return;
    rows.push({ id: `preview-${reference}`, userId, amount, reason, reference, createdAt: at(date, time, now), catchmindRoundDate: null });
    left -= amount;
  };
  if (username !== "min") add(Math.min(left, 5 + random(26)), `score:wake:${date}:${userId}`, "기상시간 맞히기 예측 점수", "10:31:00");
  if (username !== "siwon") add(Math.min(left, 3 + random(26)), `score:offwork:${date}:${userId}`, "퇴근시간 맞히기 예측 점수", "18:21:00");
  if (username !== "yeseo") add(Math.min(left, 3 + random(26)), `score:luck:${date}:${userId}`, "행운 점수 맞히기 예측 점수", "18:00:30");
  if (left >= 3 && random(2)) add(3, `catchmind:score:preview-${date}-${userId}`, "캐치마인드 정답", "14:12:00");
  if (left > 0) add(left, `claw:doll:preview-${date}-${userId}:score`, "캐릭터 뽑기", "21:04:00");
  return rows;
}

/** Serverless preview data for each period. This week's totals equal the home
 * preview's `previewScores`, so both screens agree. */
export function previewRanking(period: RankingPeriod, viewerId: string, displayNameOf: (username: string) => string,
  cursor: RankingCursor | null = null, now = new Date()): RankingResponse {
  const today = kstDateOf(now.toISOString());
  const monday = mondayOf(today);
  const monthStart = rankingRange("month", today).start;
  const players: RankingPlayerRow[] = Object.keys(previewScores).map(username => ({
    id: username === "yeseo" ? viewerId : username, username, displayName: displayNameOf(username),
    character: null, photoVersion: null, active: true, role: "player",
  }));
  const rows: RankingScoreRow[] = [];
  for (const player of players) {
    const random = seeded(`${player.username}:${monthStart}`);
    // Earlier days of the month (and of a week that began last month) get random play.
    for (let date = monthStart < monday ? monthStart : monday; date < monday; date = addDays(date, 1)) {
      rows.push(...dayRows(player.username, player.id, date, 20 + random(60), random, now));
    }
    // This week: split the fixed weekly total evenly over Monday..today.
    const days: string[] = [];
    for (let date = monday; date <= today; date = addDays(date, 1)) days.push(date);
    const total = previewScores[player.username] ?? 0;
    days.forEach((date, index) => {
      const share = Math.floor(total / days.length) + (index === days.length - 1 ? total % days.length : 0);
      rows.push(...dayRows(player.username, player.id, date, share, random, now));
    });
  }
  return summarizeRanking(period, today, viewerId, rows, players, cursor, now.toISOString());
}
