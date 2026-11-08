import { FREETHROW_RULES, freeThrowDeadline, freeThrowSlot, freeThrowSlotStart } from "../../shared/balance";
import { simulateShot, validShot } from "../../shared/freethrow-physics";
import type {
  FreeThrowBoardEntry, FreeThrowSet, FreeThrowSetInput, FreeThrowShotInput, FreeThrowShotResponse, FreeThrowState, FreeThrowSummary, LedgerEntry,
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
  const finished = (set: LocalSet, now: number) => set.shots.length >= shotsPerSet || now >= freeThrowDeadline(set.slot);
  const made = (set: LocalSet) => set.shots.filter(shot => shot.made).length;
  function recent(now: number) {
    const slot = freeThrowSlot(now);
    return { currentSlot: sets.find(set => set.slot === slot) ?? null, open: sets.find(set => set.slot === slot - 1 && !finished(set, now)) ?? null };
  }
  function summary(now = Date.now()): FreeThrowSummary {
    const { currentSlot, open } = recent(now), active = open ?? currentSlot;
    return { available: !admin && !open && !currentSlot, inProgress: !admin && !!active && !finished(active, now),
      made: active ? made(active) : 0, shots: active?.shots.length ?? 0,
      nextSlotAt: freeThrowSlotStart(freeThrowSlot(now) + 1), serverNow: now, isAdmin: admin };
  }
  /** Friends' sample sets earlier today, so the board is never empty. */
  function sample(now: number): FreeThrowBoardEntry[] {
    const slot = freeThrowSlot(now), date = kstDate(now);
    return ([["min", slot - 1, 6], ["siwon", slot - 2, 4], ["min", slot - 3, 3]] as const)
      .filter(([, sampleSlot]) => kstDate(freeThrowSlotStart(sampleSlot)) === date)
      .map(([name, sampleSlot, goals]) => ({ username: name, slot: sampleSlot, slotStart: freeThrowSlotStart(sampleSlot), made: goals, shots: shotsPerSet, finished: true }));
  }
  function state(now = Date.now()): FreeThrowState {
    const slot = freeThrowSlot(now), date = kstDate(now), { currentSlot, open } = recent(now), active = open ?? currentSlot;
    const mine = sets.filter(set => kstDate(freeThrowSlotStart(set.slot)) === date)
      .map(set => ({ username, slot: set.slot, slotStart: freeThrowSlotStart(set.slot), made: made(set), shots: set.shots.length, finished: finished(set, now) }));
    return { ...summary(now), date, slot, slotStart: freeThrowSlotStart(slot),
      current: active ? { id: active.id, requestId: active.requestId, slot: active.slot, slotStart: freeThrowSlotStart(active.slot), deadline: freeThrowDeadline(active.slot),
        engine, made: made(active), shots: [...active.shots], finished: finished(active, now), points: made(active) * goalScore, gold: made(active) * goalGold } : null,
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
      const { currentSlot, open } = recent(now);
      if (open) throw new ApiFailure(409, "지난 세트를 먼저 마쳐 주세요.");
      if (currentSlot) throw new ApiFailure(409, "이번 시간의 공식 도전은 이미 시작했어요. 다음 세트를 기다려 주세요.");
      sets.push({ id: crypto.randomUUID(), requestId: input.requestId, slot: freeThrowSlot(now), shots: [] });
      return state(now);
    },
    async shoot(input: FreeThrowShotInput): Promise<FreeThrowShotResponse> {
      const now = Date.now(), set = sets.find(candidate => candidate.id === input.setId);
      if (!set || !validShot(input)) throw new ApiFailure(400, "슛을 기록하지 못했어요.");
      const old = set.shots[input.index];
      const reply = (shot: FreeThrowSet["shots"][number], replayed: boolean): FreeThrowShotResponse =>
        ({ ...state(now), shot: { ...shot, points: shot.made ? goalScore : 0, gold: shot.made ? goalGold : 0 }, replayed });
      if (old) {
        if (old.power !== input.power || old.aim !== input.aim) throw new ApiFailure(409, "이미 다른 슛으로 기록된 공이에요.");
        return reply(old, true);
      }
      if (finished(set, now)) throw new ApiFailure(409, "이 세트의 시간이 끝났어요. 남은 공은 실패로 기록돼요.");
      if (set.shots.length !== input.index) throw new ApiFailure(409, "슛 순서가 맞지 않아요.");
      const result = simulateShot(input);
      const shot = { index: input.index, power: input.power, aim: input.aim, made: result.made, kind: result.kind };
      set.shots.push(shot);
      if (result.made) {
        gold += goalGold; score += goalScore;
        const createdAt = new Date(now).toISOString();
        ledger.unshift({ id: `preview-ft-gold-${set.id}-${input.index}`, currency: "gold", amount: goalGold, reason: "자유투 대결 골", createdAt },
          { id: `preview-ft-score-${set.id}-${input.index}`, currency: "score", amount: goalScore, reason: "자유투 대결 골", createdAt });
      }
      return reply(shot, false);
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
