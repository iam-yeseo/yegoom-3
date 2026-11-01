import { GAME_RULES, PREDICTION_REWARDS, predictionPoints } from "../shared/balance";
import type { GameHistoryRound, GameId, GameResult, GameState, LedgerEntry } from "../shared/types";
import type { ArtKey } from "./components/UI";

// Unimplemented games remain preview-only; prediction rewards use the shared rules.
export const BALANCE = {
  attendanceGold: 100,
  participationGold: PREDICTION_REWARDS.participationGold,
  firstPlaceGold: PREDICTION_REWARDS.firstGold,
  catchmind: { points: 50, hintedPoints: 30, hintAfter: 3, endAfter: 6 },
  claw: { cost: 200, dailyTries: 5, points: 30 },
  kuji: { price: 300, raisedPrice: 400, raiseFrom: 6, boughtToday: 4 },
  lotto: { price: 500, picks: 5, max: 25, drawHour: 17 },
  speetto: { price: 300, prize: 1500 },
};

/** 1-based place by closeness; equal differences share a place. */
export const rankOf = (results: GameResult[], result: GameResult) =>
  results.findIndex((r) => r.difference === result.difference) + 1;
export const KST = "Asia/Seoul";
export function kstParts(date = new Date()) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: KST,
      year: "numeric",
      month: "numeric",
      day: "numeric",
      weekday: "short",
      hour: "numeric",
      minute: "numeric",
      hourCycle: "h23",
    })
      .formatToParts(date)
      .map((part) => [part.type, part.value]),
  );
  const weekday = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].indexOf(
    parts.weekday,
  );
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    /** 0 = Monday … 6 = Sunday */
    weekday,
    hour: Number(parts.hour),
    minute: Number(parts.minute),
  };
}
export const weekdayNames = ["월", "화", "수", "목", "금", "토", "일"];
export function kstDateText(date = new Date()) {
  const t = kstParts(date);
  return `${t.month}월 ${t.day}일 ${weekdayNames[t.weekday]}요일`;
}
/** Weekdays 09:00–18:00 KST. Public holidays are not known yet. */
export function marketOpen(date = new Date()) {
  const t = kstParts(date);
  return t.weekday < 5 && t.hour >= 9 && t.hour < 18;
}

export interface Stock {
  id: string;
  name: string;
  art: ArtKey;
  price: number;
  change: number | null;
  held: number;
  average: number;
}
export const LIMIT = 15;
export const stocks: Stock[] = [
  { id: "upa", name: "우파전자", art: "axolotl", price: 2480, change: 15.0, held: 4, average: 1860 },
  { id: "nyang", name: "냥냥푸드", art: "cat", price: 1120, change: 3.2, held: 0, average: 0 },
  { id: "tokki", name: "토끼항공", art: "bunny", price: 920, change: 6.1, held: 2, average: 860 },
  { id: "manta", name: "만타해운", art: "manta", price: 3050, change: 0.8, held: 0, average: 0 },
  { id: "star", name: "별숭이게임즈", art: "monkey", price: 860, change: -1.4, held: 0, average: 0 },
  { id: "moon", name: "달빛엔터", art: "moon", price: 1780, change: -4.6, held: 1, average: 1900 },
  { id: "bbang", name: "빵빵제과", art: "bread", price: 410, change: -15.0, held: 0, average: 0 },
  { id: "bang", name: "방울바이오", art: "drop", price: 0, change: null, held: 8, average: 200 },
];

/** Sample week used by the logged-out preview. */
export const previewScores: Record<string, number> = {
  siwon: 412,
  yeseo: 340,
  min: 285,
};
export const previewLastWeek = [
  { username: "siwon", score: 512 },
  { username: "yeseo", score: 470 },
  { username: "min", score: 401 },
];
export const previewDaily = [62, 88, 45, 105, 155, 0, 0];
export const previewGold = 12480;

/** The preview plays as yeseo, who sets 행운 점수, so that round is seen as siwon. */
export const previewViewer = (id: GameId) => (id === "luck" ? "siwon" : "yeseo");
/**
 * Prediction rounds shown to the logged-out preview, fixed to the design's
 * frames: 기상시간 and 행운 점수 open (2a, 2b), 퇴근시간 revealed (2c).
 */
export function previewGame(id: GameId): GameState {
  const { title, author: authorUsername, deadline } = GAME_RULES[id];
  const viewer = previewViewer(id);
  const others = ["min", "siwon", "yeseo"].filter((name) => name !== authorUsername);
  const base: GameState = {
    id,
    title,
    authorUsername,
    deadline,
    roundDate: new Date(Date.now() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10),
    phase: "open",
    hint: "비 와도 기분 좋음. 점심이 맛있었다",
    prediction: null,
    answer: null,
    answerEntered: true,
    results: [],
    // Others first and the viewer last, as in the design.
    participants: [...others.filter((n) => n !== viewer), viewer].map((username) => ({
      playerId: username,
      username,
      displayName: username,
      submitted: username !== viewer,
    })),
    canPredict: true,
    canEditAnswer: false,
    canReveal: false,
  };
  if (id !== "offwork") return base;
  return {
    ...base,
    phase: "revealed",
    answer: "18:12:30",
    prediction: "18:12:45",
    canPredict: false,
    results: previewResults(id, "18:12:30", ["18:12:45", "18:13:31"]),
  };
}

function previewResults(id: GameId, answer: string, values: string[]): GameResult[] {
  const players = ["yeseo", "min", "siwon"].filter(name => name !== GAME_RULES[id].author);
  const numeric = (value: string) => id === "luck" ? Number(value) : value.split(":").reduce((total, part) => total * 60 + Number(part), 0);
  const differences = values.map(value => Math.abs(numeric(value) - numeric(answer)));
  const minimum = Math.min(...differences);
  return values.map((value, i) => {
    const firstGold = differences[i] === minimum ? PREDICTION_REWARDS.firstGold : 0;
    return { playerId: players[i], username: players[i], displayName: players[i], value, difference: differences[i],
      score: predictionPoints(id, differences[i]), isFirst: differences[i] === minimum,
      participationGold: PREDICTION_REWARDS.participationGold, firstGold, gold: PREDICTION_REWARDS.participationGold + firstGold };
  }).sort((a, b) => a.difference - b.difference);
}
/** Three published rounds; the skipped day illustrates that unplayed days do not count. */
export function previewHistory(id: GameId): GameHistoryRound[] {
  const answer = id === "luck" ? "70" : id === "wake" ? "08:31:00" : "18:02:30";
  const values = id === "luck" ? ["70", "77"] : id === "wake" ? ["08:31:00", "08:32:01"] : ["18:02:30", "18:03:31"];
  return [1, 2, 4].map((days, i) => ({
    roundDate: new Date(Date.now() + 9 * 60 * 60 * 1000 - days * 86_400_000).toISOString().slice(0, 10),
    answer,
    results: previewResults(id, answer, i === 1 ? [values[0], values[0]] : values),
  }));
}

/** Sample gold and score history for the preview's 내 정보 screen. */
export function previewLedger(): LedgerEntry[] {
  const today = Date.now();
  const yesterday = today - 86_400_000;
  const at = (base: number, time: string) => {
    const t = kstParts(new Date(base));
    const day = `${t.year}-${String(t.month).padStart(2, "0")}-${String(t.day).padStart(2, "0")}`;
    return new Date(`${day}T${time}:00+09:00`).toISOString();
  };
  const rows: [number, string, string, number, "gold" | "score"][] = [
    [today, "17:00", "로또 4등", 1000, "gold"],
    [today, "13:06", "캐릭터 뽑기", -200, "gold"],
    [today, "13:02", "쿠지 4장", -1200, "gold"],
    [today, "11:20", "로또 2장", -1000, "gold"],
    [today, "09:12", "출석", 100, "gold"],
    [yesterday, "17:48", "주식 매도 · 우파전자", 3140, "gold"],
    [yesterday, "08:55", "출석", 100, "gold"],
    [today, "13:10", "캐치마인드 정답", 50, "score"],
    [today, "13:06", "캐릭터 뽑기", 30, "score"],
    [today, "08:47", "기상시간 맞히기", predictionPoints("wake", 0), "score"],
    [today, "08:47", "기상시간 1등", PREDICTION_REWARDS.firstGold, "gold"],
    [today, "08:10", "기상시간 참여", PREDICTION_REWARDS.participationGold, "gold"],
    [yesterday, "18:00", "주식 수익 1위", 40, "score"],
    [yesterday, "18:00", "행운 점수 맞히기", predictionPoints("luck", 1), "score"],
    [yesterday, "08:31", "기상시간 맞히기", predictionPoints("wake", 61), "score"],
  ];
  return rows.map(([base, time, reason, amount, currency], i) => ({
    id: `preview-${i}`,
    currency,
    amount,
    reason,
    createdAt: at(base, time),
  }));
}
