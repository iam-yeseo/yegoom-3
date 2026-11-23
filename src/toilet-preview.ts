import { TOILET_RULES, playWindow } from "../shared/balance";
import { burstChance, bursts, nextToiletOpen, nextToiletTurn, toiletOrder, toiletResults, toiletSlots, toiletWindow } from "../shared/toilet";
import type { CatchmindPlayer, LedgerEntry, ToiletAction, ToiletPollResponse, ToiletPush, ToiletPushInput, ToiletResponse, ToiletRoundView, ToiletSummary } from "../shared/types";
import { ApiFailure } from "./api";

/** How long a preview friend takes over their turn, and how long a burst round stays before the next opens. */
const BOT_MS = 1600, NEXT_MS = 9000;
interface Round {
  id: string; number: number; order: string[]; slots: number; pushes: ToiletPush[]; seat: number; turnStartedAt: number;
  status: "waiting" | "playing" | "burst"; loserId: string | null; results: { userId: string; points: number }[]; startedAt: number; endedAt: number | null;
}

/** A serverless toilet for #/preview: the viewer plus two friends who push a
 * moment after their turn comes. The rules are the Worker's (shared/toilet.ts);
 * a new round opens a few seconds after each burst so the preview never stalls. */
export function createToiletPreview(viewer: CatchmindPlayer, admin = false) {
  const friends: CatchmindPlayer[] = (["min", "siwon"] as const).filter(name => name !== viewer.username)
    .map(username => ({ id: username, username, displayName: username, photoVersion: null, character: username === "min" ? "axolotl" : "cat" }));
  const people = new Map<string, CatchmindPlayer>([...(admin ? [] : [viewer]), ...friends].map(person => [person.id, person]));
  const ledger: LedgerEntry[] = [];
  let round: Round, previous: Round | null = null, version = 1, score = 0, opened = 0;
  function open(now: number) {
    const order = toiletOrder([...people.values()], opened);
    opened++;
    round = { id: `preview-${opened}`, number: opened, order, slots: toiletSlots(order.length), pushes: [], seat: 0, turnStartedAt: now, status: "waiting", loserId: null, results: [], startedAt: now, endedAt: null };
    version++;
  }
  open(Date.now());
  function push(by: string, at: number, random = Math.random()) {
    const turnId = round.order[round.seat]!;
    const burst = bursts(random, round.slots, round.pushes.length);
    round.pushes.push({ for: turnId, by, at: new Date(at).toISOString() });
    if (burst) {
      round.status = "burst"; round.loserId = turnId; round.endedAt = at; round.results = toiletResults(round.order, turnId, () => true);
      const mine = round.results.find(entry => entry.userId === viewer.id);
      if (mine) {
        score += mine.points;
        ledger.unshift({ id: `preview-toilet-${round.id}`, currency: "score", amount: mine.points, reason: `변기 폭파 · ${mine.points < 0 ? "펑!" : "생존"}`, createdAt: new Date(at).toISOString() });
      }
    } else {
      round.status = "playing"; round.seat = nextToiletTurn(round.order, round.seat, () => true); round.turnStartedAt = at;
    }
    version++;
  }
  /** Friends push once their moment has come; a burst round makes way for the next. */
  function advance(now: number) {
    for (let guard = 0; guard < 40; guard++) {
      const live = round.status !== "burst", turnId = round.order[round.seat];
      if (live && turnId !== viewer.id && now - round.turnStartedAt >= BOT_MS) push(turnId!, round.turnStartedAt + BOT_MS);
      else if (!live && round.endedAt !== null && now - round.endedAt >= NEXT_MS) { previous = round; open(round.endedAt + NEXT_MS); }
      else break;
    }
  }
  const label = () => toiletWindow(Date.now())?.label ?? "오후";
  function view(entry: Round): ToiletRoundView {
    const live = entry.status !== "burst", person = (id: string | null) => (id ? people.get(id) ?? null : null);
    return {
      id: entry.id, date: new Date(entry.startedAt + 9 * 3_600_000).toISOString().slice(0, 10), half: label() === "오전" ? "am" : "pm", label: label(),
      startsAt: new Date(entry.startedAt).toISOString(), endsAt: new Date(toiletWindow(Date.now())?.endsAt ?? nextToiletOpen(Date.now())).toISOString(),
      order: entry.order.map(id => people.get(id)!), slots: entry.slots, pushes: [...entry.pushes], status: entry.status,
      turn: live ? person(entry.order[entry.seat]!) : null, turnStartedAt: live ? new Date(entry.turnStartedAt).toISOString() : null,
      chance: live ? burstChance(entry.slots, entry.pushes.length) : 0, loser: person(entry.loserId),
      results: entry.results.map(result => ({ player: people.get(result.userId)!, points: result.points })),
      endedAt: entry.endedAt === null ? null : new Date(entry.endedAt).toISOString(),
    };
  }
  function respond(now: number): ToiletResponse {
    const turnId = round.status !== "burst" ? round.order[round.seat] : null;
    const skipAt = round.turnStartedAt + TOILET_RULES.skipAfterMs;
    return {
      stamp: String(version), viewerId: viewer.id, serverTime: new Date(now).toISOString(), play: playWindow(now),
      toilet: {
        current: view(round), previous: previous ? view(previous) : null,
        canPush: !admin && turnId === viewer.id, canSkip: !admin && !!turnId && turnId !== viewer.id && now >= skipAt,
        skipAvailableAt: turnId ? new Date(skipAt).toISOString() : null, nextOpensAt: new Date(nextToiletOpen(now)).toISOString(),
      },
    };
  }
  function summary(): ToiletSummary {
    const short = (id: string | null | undefined) => { const person = id ? people.get(id) : null; return person ? { username: person.username, displayName: person.displayName } : null; };
    return {
      half: label() === "오전" ? "am" : "pm", label: label(), status: round.status, turn: short(round.status !== "burst" ? round.order[round.seat] : null), loser: short(round.loserId),
      points: round.results.find(entry => entry.userId === viewer.id)?.points ?? 0, pushes: round.pushes.length, slots: round.slots,
    };
  }
  return {
    get score() { return score; }, get ledger() { return ledger; }, summary,
    read(since?: string): ToiletPollResponse {
      const now = Date.now(); advance(now);
      return since === String(version) ? { unchanged: true, stamp: since, viewerId: viewer.id, serverTime: new Date(now).toISOString(), play: playWindow(now) } : respond(now);
    },
    async mutate(action: ToiletAction, input: ToiletPushInput): Promise<ToiletResponse> {
      const now = Date.now(); advance(now);
      if (admin) throw new ApiFailure(403, "플레이어만 변기 폭파에 참여할 수 있어요.");
      if (input.roundId !== round.id || input.pushes !== round.pushes.length || round.status === "burst") throw new ApiFailure(409, "그사이에 변기 상황이 바뀌었어요. 새로 불러올게요.");
      const turnId = round.order[round.seat]!;
      if (action === "push" && turnId !== viewer.id) throw new ApiFailure(403, "지금은 내 차례가 아니에요.");
      if (action === "skip" && (turnId === viewer.id || now < round.turnStartedAt + TOILET_RULES.skipAfterMs)) throw new ApiFailure(409, "10분이 지나면 대신 누를 수 있어요.");
      push(viewer.id, now);
      return respond(now);
    },
  };
}
export type ToiletPreview = ReturnType<typeof createToiletPreview>;
const engines = new Map<string, ToiletPreview>();
/** One preview toilet per preview identity for the page session. */
export function previewToilet(viewer: CatchmindPlayer, admin: boolean): ToiletPreview {
  const key = `${admin ? "admin" : "player"}:${viewer.username}`;
  let engine = engines.get(key);
  if (!engine) { engine = createToiletPreview(viewer, admin); engines.set(key, engine); }
  return engine;
}
/** The home row before the preview has been opened. */
export const previewToiletSummary = (): ToiletSummary => ({ half: "pm", label: "오후", status: "waiting", turn: null, loser: null, points: 0, pushes: 0, slots: 3 * TOILET_RULES.slotsPerPlayer });
