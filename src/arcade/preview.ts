import { ARCADE_RULES, arcadeDeadline, arcadeSlot, arcadeSlotStart, type ArcadeGame } from "../../shared/balance";
import { ARCADE_JUDGES, arcadePoints } from "../../shared/arcade-judge";
import type { ArcadeBoardEntry, ArcadeFinishInput, ArcadeFinishResponse, ArcadeSet, ArcadeStartInput, ArcadeState, ArcadeSummary, ArcadeTryRecord, LedgerEntry } from "../../shared/types";
import { ApiFailure } from "../api";

const kstDate = (time: number) => new Date(time + 9 * 3_600_000).toISOString().slice(0, 10);
interface LocalSet { id: string; requestId: string; slot: number; date: string; inputs: string; tries: ArcadeTryRecord[] }

/** Serverless official sets for #/preview, following worker/arcade.ts. The
 * engine lives for the page session so navigation keeps its sets and rewards. */
export function createArcadePreview(game: ArcadeGame, username: string, admin = false) {
  const rules = ARCADE_RULES[game], judge = ARCADE_JUDGES[game];
  const sets: LocalSet[] = [];
  const ledger: LedgerEntry[] = [];
  let gold = 0, score = 0;
  const completed = (set: LocalSet) => set.tries.length >= rules.tries;
  const finished = (set: LocalSet, now: number) => completed(set) || now >= arcadeDeadline(game, set.slot);
  const made = (set: LocalSet) => set.tries.filter(entry => entry.made).length;
  const points = (set: LocalSet) => arcadePoints(set.tries, rules.score);
  function recent(now: number) {
    const slot = arcadeSlot(game, now);
    const thisSlot = sets.find(set => set.slot === slot) ?? null;
    return { thisSlot, current: thisSlot ?? sets.find(set => set.slot === slot - 1 && !finished(set, now)) ?? null };
  }
  function summary(now = Date.now()): ArcadeSummary {
    const set = recent(now).thisSlot;
    return { available: !admin && !set, played: !admin && !!set, completed: !admin && !!set && completed(set), made: set && completed(set) ? made(set) : 0,
      nextSlotAt: arcadeSlotStart(game, arcadeSlot(game, now) + 1), serverNow: now, isAdmin: admin };
  }
  /** Friends' sample sets earlier today, so the board is never empty. */
  function sample(now: number): ArcadeBoardEntry[] {
    const slot = arcadeSlot(game, now), date = kstDate(now);
    // Curling is ranked by points (up to 10 a stone), penalties by goals.
    const worth = game === "curling" ? 6 : rules.score;
    return ([["min", slot - 1, 3], ["siwon", slot - 2, 4], ["min", slot - 3, 2]] as const)
      .filter(([, sampleSlot]) => kstDate(arcadeSlotStart(game, sampleSlot)) === date)
      .map(([name, sampleSlot, count]) => ({ username: name, slot: sampleSlot, slotStart: arcadeSlotStart(game, sampleSlot), made: count, points: count * worth, completed: true }));
  }
  function view(set: LocalSet, now: number): ArcadeSet {
    return { id: set.id, requestId: set.requestId, slot: set.slot, slotStart: arcadeSlotStart(game, set.slot), deadline: arcadeDeadline(game, set.slot),
      engine: rules.engine, made: made(set), tries: [...set.tries], completed: completed(set), finished: finished(set, now), points: points(set), gold: made(set) * rules.gold };
  }
  function state(now = Date.now()): ArcadeState {
    const slot = arcadeSlot(game, now), date = kstDate(now), { current } = recent(now);
    const mine = sets.filter(set => completed(set) && set.date === date)
      .map(set => ({ username, slot: set.slot, slotStart: arcadeSlotStart(game, set.slot), made: made(set), points: points(set), completed: true }));
    return { ...summary(now), game, date, slot, slotStart: arcadeSlotStart(game, slot), current: current ? view(current, now) : null,
      today: [...sample(now), ...mine].sort((a, b) => a.slot - b.slot || a.username.localeCompare(b.username)) };
  }
  return {
    get gold() { return gold; }, get score() { return score; }, get ledger() { return ledger; },
    summary, state,
    async load(): Promise<ArcadeState> { return state(); },
    async start(input: ArcadeStartInput): Promise<ArcadeState> {
      const now = Date.now();
      if (admin) throw new ApiFailure(403, "플레이어만 공식 도전을 할 수 있어요. 연습 모드는 누구나 할 수 있어요.");
      if (sets.some(set => set.requestId === input.requestId)) return state(now);
      if (recent(now).thisSlot) throw new ApiFailure(409, "이번 시간의 공식 도전은 이미 시작했어요. 다음 세트를 기다려 주세요.");
      sets.push({ id: crypto.randomUUID(), requestId: input.requestId, slot: arcadeSlot(game, now), date: kstDate(now), inputs: "", tries: [] });
      return state(now);
    },
    async finish(input: ArcadeFinishInput): Promise<ArcadeFinishResponse> {
      const now = Date.now(), set = sets.find(candidate => candidate.id === input.setId);
      if (!set) throw new ApiFailure(404, "이 세트를 찾을 수 없어요.");
      const inputs = input.inputs.length === rules.tries ? judge.clean(input.inputs) : null;
      if (!inputs) throw new ApiFailure(400, "기록이 올바르지 않아요.");
      if (completed(set)) {
        if (set.inputs === JSON.stringify(inputs)) return { ...state(now), set: view(set, now), replayed: true };
        throw new ApiFailure(409, "이 세트는 이미 다르게 기록됐어요.");
      }
      if (finished(set, now)) throw new ApiFailure(409, "이 세트의 시간이 끝나서 미완료로 기록됐어요.");
      set.inputs = JSON.stringify(inputs); set.tries = judge.judge(set.slot, inputs);
      const count = made(set), earned = points(set);
      if (count) {
        gold += count * rules.gold; score += earned;
        const createdAt = new Date(now).toISOString();
        ledger.unshift({ id: `preview-${game}-gold-${set.id}`, currency: "gold", amount: count * rules.gold, reason: judge.reason, createdAt },
          { id: `preview-${game}-score-${set.id}`, currency: "score", amount: earned, reason: judge.reason, createdAt });
      }
      return { ...state(now), set: view(set, now), replayed: false };
    },
  };
}
export type ArcadePreview = ReturnType<typeof createArcadePreview>;
const engines = new Map<string, ArcadePreview>();
/** One preview engine per game and preview identity for the page session. */
export function previewArcade(game: ArcadeGame, username: string, admin: boolean): ArcadePreview {
  const key = `${game}:${admin ? "admin" : "player"}:${username}`;
  let engine = engines.get(key);
  if (!engine) { engine = createArcadePreview(game, username, admin); engines.set(key, engine); }
  return engine;
}
