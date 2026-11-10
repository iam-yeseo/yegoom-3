import { SANTA_RULES, santaDeadline, santaOpen, santaSlot, santaSlotStart } from "../../shared/balance";
import { judgeDrop, santaCourse, validRelease } from "../../shared/santa-engine";
import type {
  LedgerEntry, SantaBoardEntry, SantaDropInput, SantaDropRecord, SantaDropResponse, SantaRun, SantaRunInput, SantaState, SantaSummary,
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
  const finished = (run: LocalRun, now: number) => run.drops.length >= houses || now >= santaDeadline(run.slot);
  const hits = (run: LocalRun) => run.drops.filter(entry => entry.hit).length;
  function recent(now: number) {
    const slot = santaSlot(now);
    return { currentSlot: runs.find(run => run.slot === slot) ?? null, open: runs.find(run => run.slot === slot - 1 && !finished(run, now)) ?? null };
  }
  function summary(now = Date.now()): SantaSummary {
    const { currentSlot, open } = recent(now), active = open ?? currentSlot;
    return { open: santaOpen(now), available: !admin && santaOpen(now) && !open && !currentSlot, inProgress: !admin && !!active && !finished(active, now),
      hits: active ? hits(active) : 0, drops: active?.drops.length ?? 0,
      nextSlotAt: santaSlotStart(santaSlot(now) + 1), endsAt: SANTA_RULES.endsAt, serverNow: now, isAdmin: admin };
  }
  /** Friends' sample runs earlier today, so the board is never empty. */
  function sample(now: number): SantaBoardEntry[] {
    const slot = santaSlot(now), date = kstDate(now);
    return ([["min", slot - 1, 7], ["siwon", slot - 1, 4], ["min", slot, 9]] as const)
      .filter(([, sampleSlot]) => kstDate(santaSlotStart(sampleSlot)) === date)
      .map(([name, sampleSlot, count]) => ({ username: name, slot: sampleSlot, slotStart: santaSlotStart(sampleSlot), hits: count, drops: houses, finished: true }));
  }
  function view(run: LocalRun, now: number): SantaRun {
    const completed = run.drops.length >= houses, count = hits(run);
    return { id: run.id, requestId: run.requestId, slot: run.slot, slotStart: santaSlotStart(run.slot), deadline: santaDeadline(run.slot), engine,
      hits: count, drops: [...run.drops], completed, finished: finished(run, now),
      points: count * hitScore + (completed && count === houses ? perfectBonus : 0), gold: completed ? clearGold : 0 };
  }
  function state(now = Date.now()): SantaState {
    const slot = santaSlot(now), date = kstDate(now), { currentSlot, open } = recent(now), active = open ?? currentSlot;
    const mine = runs.filter(run => kstDate(santaSlotStart(run.slot)) === date)
      .map(run => ({ username, slot: run.slot, slotStart: santaSlotStart(run.slot), hits: hits(run), drops: run.drops.length, finished: finished(run, now) }));
    return { ...summary(now), date, slot, slotStart: santaSlotStart(slot), current: active ? view(active, now) : null,
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
      const { currentSlot, open } = recent(now);
      if (open) throw new ApiFailure(409, "지난 배달을 먼저 마쳐 주세요.");
      if (currentSlot) throw new ApiFailure(409, "이번 배달은 이미 출발했어요. 다음 배달을 기다려 주세요.");
      runs.push({ id: crypto.randomUUID(), requestId: input.requestId, slot: santaSlot(now), drops: [] });
      return state(now);
    },
    async drop(input: SantaDropInput): Promise<SantaDropResponse> {
      const now = Date.now(), run = runs.find(candidate => candidate.id === input.runId);
      if (!run) throw new ApiFailure(404, "이 배달을 찾을 수 없어요.");
      const old = run.drops[input.index];
      const reply = (entry: SantaDropRecord, replayed: boolean): SantaDropResponse =>
        ({ ...state(now), drop: { ...entry, points: entry.hit ? hitScore : 0 }, replayed });
      if (old) {
        if (old.release !== input.release) throw new ApiFailure(409, "이 집은 이미 다르게 기록됐어요.");
        return reply(old, true);
      }
      if (finished(run, now)) throw new ApiFailure(409, "이 배달의 시간이 끝났어요. 남은 집은 미배달로 기록돼요.");
      if (run.drops.length !== input.index) throw new ApiFailure(409, "배달 순서가 맞지 않아요.");
      const house = santaCourse(run.slot, houses)[input.index]!;
      if (!validRelease(house, input.release)) throw new ApiFailure(400, "던진 시각이 올바르지 않아요.");
      const result = judgeDrop(house, input.release);
      const entry = { index: input.index, release: input.release, hit: result.hit, kind: result.kind };
      run.drops.push(entry);
      const createdAt = new Date(now).toISOString(), key = `preview-santa-${run.id}`;
      if (entry.hit) pay("score", hitScore, "산타 선물 배달", `${key}-${input.index}`, createdAt);
      if (run.drops.length === houses) {
        if (hits(run) === houses) pay("score", perfectBonus, "산타 선물 배달 · 10곳 모두 성공", `${key}-perfect`, createdAt);
        pay("gold", clearGold, "산타 선물 배달 완료", `${key}-clear`, createdAt);
      }
      return reply(entry, false);
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
