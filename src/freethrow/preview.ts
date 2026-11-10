import { FREETHROW_RULES, freeThrowDeadline, freeThrowSlot, freeThrowSlotStart } from "../../shared/balance";
import { simulateShot, validShot } from "../../shared/freethrow-physics";
import type {
  FreeThrowBoardEntry, FreeThrowFinishInput, FreeThrowFinishResponse, FreeThrowSet, FreeThrowSetInput, FreeThrowState, FreeThrowSummary, LedgerEntry,
} from "../../shared/types";
import { ApiFailure } from "../api";

const { shotsPerSet, goalScore, goalGold, engine } = FREETHROW_RULES;
const kstDate = (time: number) => new Date(time + 9 * 3_600_000).toISOString().slice(0, 10);
interface LocalSet { id: string; requestId: string; slot: number; shots: FreeThrowSet["shots"] }

/** Serverless official sets for #/preview, following worker/freethrow.ts. The
 * engine lives for the page session so navigation keeps its sets and rewards. */
export function createFreeThrowPreview(username: string, admin = false) {
  const sets: LocalSet[] = [];
  const ledger: LedgerEntry[] = [];
  let gold = 0, score = 0;
  const completed = (set: LocalSet) => set.shots.length >= shotsPerSet;
  const finished = (set: LocalSet, now: number) => completed(set) || now >= freeThrowDeadline(set.slot);
  const made = (set: LocalSet) => set.shots.filter(shot => shot.made).length;
  function recent(now: number) {
    const slot = freeThrowSlot(now);
    const thisSlot = sets.find(set => set.slot === slot) ?? null;
    return { thisSlot, current: thisSlot ?? sets.find(set => set.slot === slot - 1 && !finished(set, now)) ?? null };
  }
  function summary(now = Date.now()): FreeThrowSummary {
    const set = recent(now).thisSlot;
    return { available: !admin && !set, played: !admin && !!set, completed: !admin && !!set && completed(set), made: set && completed(set) ? made(set) : 0,
      nextSlotAt: freeThrowSlotStart(freeThrowSlot(now) + 1), serverNow: now, isAdmin: admin };
  }
  /** Friends' sample sets earlier today, so the board is never empty. */
  function sample(now: number): FreeThrowBoardEntry[] {
    const slot = freeThrowSlot(now), date = kstDate(now);
    return ([["min", slot - 1, 6], ["siwon", slot - 2, 4], ["min", slot - 3, 3]] as const)
      .filter(([, sampleSlot]) => kstDate(freeThrowSlotStart(sampleSlot)) === date)
      .map(([name, sampleSlot, goals]) => ({ username: name, slot: sampleSlot, slotStart: freeThrowSlotStart(sampleSlot), made: goals, completed: true }));
  }
  function view(set: LocalSet, now: number): FreeThrowSet {
    return { id: set.id, requestId: set.requestId, slot: set.slot, slotStart: freeThrowSlotStart(set.slot), deadline: freeThrowDeadline(set.slot),
      engine, made: made(set), shots: [...set.shots], completed: completed(set), finished: finished(set, now), points: made(set) * goalScore, gold: made(set) * goalGold };
  }
  function state(now = Date.now()): FreeThrowState {
    const slot = freeThrowSlot(now), date = kstDate(now), { current } = recent(now);
    const mine = sets.filter(set => completed(set) && kstDate(freeThrowSlotStart(set.slot)) === date)
      .map(set => ({ username, slot: set.slot, slotStart: freeThrowSlotStart(set.slot), made: made(set), completed: true }));
    return { ...summary(now), date, slot, slotStart: freeThrowSlotStart(slot), current: current ? view(current, now) : null,
      today: [...sample(now), ...mine].sort((a, b) => a.slot - b.slot || a.username.localeCompare(b.username)) };
  }
  return {
    get gold() { return gold; }, get score() { return score; }, get ledger() { return ledger; },
    summary, state,
    async load(): Promise<FreeThrowState> { return state(); },
    async start(input: FreeThrowSetInput): Promise<FreeThrowState> {
      const now = Date.now();
      if (admin) throw new ApiFailure(403, "플레이어만 공식 도전을 할 수 있어요. 연습 모드는 누구나 던질 수 있어요.");
      if (sets.some(set => set.requestId === input.requestId)) return state(now);
      if (recent(now).thisSlot) throw new ApiFailure(409, "이번 시간의 공식 도전은 이미 시작했어요. 다음 세트를 기다려 주세요.");
      sets.push({ id: crypto.randomUUID(), requestId: input.requestId, slot: freeThrowSlot(now), shots: [] });
      return state(now);
    },
    async finish(input: FreeThrowFinishInput): Promise<FreeThrowFinishResponse> {
      const now = Date.now(), set = sets.find(candidate => candidate.id === input.setId);
      if (!set) throw new ApiFailure(404, "이 세트를 찾을 수 없어요.");
      if (completed(set)) {
        if (set.shots.every((shot, i) => shot.power === input.shots[i]?.power && shot.aim === input.shots[i]?.aim)) return { ...state(now), set: view(set, now), replayed: true };
        throw new ApiFailure(409, "이 세트는 이미 다르게 기록됐어요.");
      }
      if (finished(set, now)) throw new ApiFailure(409, "이 세트의 시간이 끝나서 미완료로 기록됐어요.");
      if (input.shots.length !== shotsPerSet || !input.shots.every(shot => validShot(shot))) throw new ApiFailure(400, "세기와 방향이 올바르지 않아요.");
      set.shots = input.shots.map((shot, index) => { const result = simulateShot(shot); return { index, power: shot.power, aim: shot.aim, made: result.made, kind: result.kind }; });
      const goals = made(set);
      if (goals) {
        gold += goals * goalGold; score += goals * goalScore;
        const createdAt = new Date(now).toISOString();
        ledger.unshift({ id: `preview-ft-gold-${set.id}`, currency: "gold", amount: goals * goalGold, reason: "자유투 대결 골", createdAt },
          { id: `preview-ft-score-${set.id}`, currency: "score", amount: goals * goalScore, reason: "자유투 대결 골", createdAt });
      }
      return { ...state(now), set: view(set, now), replayed: false };
    },
  };
}
export type FreeThrowPreview = ReturnType<typeof createFreeThrowPreview>;
const engines = new Map<string, FreeThrowPreview>();
/** One preview engine per preview identity for the page session. */
export function previewEngine(username: string, admin: boolean): FreeThrowPreview {
  const key = `${admin ? "admin" : "player"}:${username}`;
  let engine = engines.get(key);
  if (!engine) { engine = createFreeThrowPreview(username, admin); engines.set(key, engine); }
  return engine;
}
