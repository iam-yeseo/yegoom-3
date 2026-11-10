import { SANTA_RULES, santaDeadline, santaOpen, santaSlot, santaSlotStart } from "../../shared/balance";
import { judgeDrop, santaCourse, validRelease } from "../../shared/santa-engine";
import type {
  LedgerEntry, SantaBoardEntry, SantaDropRecord, SantaFinishInput, SantaFinishResponse, SantaRun, SantaRunInput, SantaState, SantaSummary,
} from "../../shared/types";
import { ApiFailure } from "../api";

const { houses, hitScore, perfectBonus, clearGold, engine } = SANTA_RULES;
const kstDate = (time: number) => new Date(time + 9 * 3_600_000).toISOString().slice(0, 10);
interface LocalRun { id: string; requestId: string; slot: number; drops: SantaDropRecord[] }

/** Serverless runs for #/preview, following worker/santa.ts. The engine lives
 * for the page session so navigation keeps its runs and rewards. */
export function createSantaPreview(username: string, admin = false) {
  const runs: LocalRun[] = [];
  const ledger: LedgerEntry[] = [];
  let gold = 0, score = 0;
  const completed = (run: LocalRun) => run.drops.length >= houses;
  const finished = (run: LocalRun, now: number) => completed(run) || now >= santaDeadline(run.slot);
  const hits = (run: LocalRun) => run.drops.filter(entry => entry.hit).length;
  function recent(now: number) {
    const slot = santaSlot(now);
    const thisSlot = runs.find(run => run.slot === slot) ?? null;
    return { thisSlot, current: thisSlot ?? runs.find(run => run.slot === slot - 1 && !finished(run, now)) ?? null };
  }
  function summary(now = Date.now()): SantaSummary {
    const run = recent(now).thisSlot;
    return { open: santaOpen(now), available: !admin && santaOpen(now) && !run, played: !admin && !!run, completed: !admin && !!run && completed(run),
      hits: run && completed(run) ? hits(run) : 0, nextSlotAt: santaSlotStart(santaSlot(now) + 1), endsAt: SANTA_RULES.endsAt, serverNow: now, isAdmin: admin };
  }
  /** Friends' sample runs earlier today, so the board is never empty. */
  function sample(now: number): SantaBoardEntry[] {
    const slot = santaSlot(now), date = kstDate(now);
    return ([["min", slot - 1, 7], ["siwon", slot - 1, 4], ["min", slot, 9]] as const)
      .filter(([, sampleSlot]) => kstDate(santaSlotStart(sampleSlot)) === date)
      .map(([name, sampleSlot, count]) => ({ username: name, slot: sampleSlot, slotStart: santaSlotStart(sampleSlot), hits: count, completed: true }));
  }
  function view(run: LocalRun, now: number): SantaRun {
    const done = completed(run), count = hits(run);
    return { id: run.id, requestId: run.requestId, slot: run.slot, slotStart: santaSlotStart(run.slot), deadline: santaDeadline(run.slot), engine,
      hits: count, drops: [...run.drops], completed: done, finished: finished(run, now),
      points: count * hitScore + (done && count === houses ? perfectBonus : 0), gold: done ? clearGold : 0 };
  }
  function state(now = Date.now()): SantaState {
    const slot = santaSlot(now), date = kstDate(now), { current } = recent(now);
    const mine = runs.filter(run => completed(run) && kstDate(santaSlotStart(run.slot)) === date)
      .map(run => ({ username, slot: run.slot, slotStart: santaSlotStart(run.slot), hits: hits(run), completed: true }));
    return { ...summary(now), date, slot, slotStart: santaSlotStart(slot), current: current ? view(current, now) : null,
      today: [...sample(now), ...mine].sort((a, b) => a.slot - b.slot || a.username.localeCompare(b.username)) };
  }
  function pay(currency: "gold" | "score", amount: number, reason: string, id: string, createdAt: string) {
    if (currency === "gold") gold += amount; else score += amount;
    ledger.unshift({ id, currency, amount, reason, createdAt });
  }
  return {
    get gold() { return gold; }, get score() { return score; }, get ledger() { return ledger; },
    summary, state,
    async load(): Promise<SantaState> { return state(); },
    async start(input: SantaRunInput): Promise<SantaState> {
      const now = Date.now();
      if (admin) throw new ApiFailure(403, "플레이어만 선물을 배달할 수 있어요.");
      if (runs.some(run => run.requestId === input.requestId)) return state(now);
      if (!santaOpen(now)) throw new ApiFailure(409, "크리스마스 선물 배달은 12월 25일까지였어요.");
      if (recent(now).thisSlot) throw new ApiFailure(409, "이번 배달은 이미 출발했어요. 다음 배달을 기다려 주세요.");
      runs.push({ id: crypto.randomUUID(), requestId: input.requestId, slot: santaSlot(now), drops: [] });
      return state(now);
    },
    async finish(input: SantaFinishInput): Promise<SantaFinishResponse> {
      const now = Date.now(), run = runs.find(candidate => candidate.id === input.runId);
      if (!run) throw new ApiFailure(404, "이 배달을 찾을 수 없어요.");
      if (completed(run)) {
        if (run.drops.every((entry, i) => entry.release === input.releases[i])) return { ...state(now), run: view(run, now), replayed: true };
        throw new ApiFailure(409, "이 배달은 이미 다르게 기록됐어요.");
      }
      if (finished(run, now)) throw new ApiFailure(409, "이 배달의 시간이 끝나서 미완료로 기록됐어요.");
      const course = santaCourse(run.slot, houses);
      if (input.releases.length !== houses || !input.releases.every((release, i) => validRelease(course[i]!, release))) throw new ApiFailure(400, "던진 시각이 올바르지 않아요.");
      run.drops = input.releases.map((release, index) => { const result = judgeDrop(course[index]!, release); return { index, release, hit: result.hit, kind: result.kind }; });
      const createdAt = new Date(now).toISOString(), key = `preview-santa-${run.id}`, count = hits(run);
      if (count) pay("score", count * hitScore, "산타 선물 배달", `${key}-hits`, createdAt);
      if (count === houses) pay("score", perfectBonus, "산타 선물 배달 · 10곳 모두 성공", `${key}-perfect`, createdAt);
      pay("gold", clearGold, "산타 선물 배달 완료", `${key}-clear`, createdAt);
      return { ...state(now), run: view(run, now), replayed: false };
    },
  };
}
export type SantaPreview = ReturnType<typeof createSantaPreview>;
const engines = new Map<string, SantaPreview>();
/** One preview engine per preview identity for the page session. */
export function previewSantaEngine(username: string, admin: boolean): SantaPreview {
  const key = `${admin ? "admin" : "player"}:${username}`;
  let engine = engines.get(key);
  if (!engine) { engine = createSantaPreview(username, admin); engines.set(key, engine); }
  return engine;
}
