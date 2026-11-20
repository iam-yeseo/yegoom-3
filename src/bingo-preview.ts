import { BINGO_RULES, playWindow } from "../shared/balance";
import { bingoBoardProblem, bingoLines, bingoTopicProblem, bingoWordsProblem, cleanBingoTopic, cleanBingoWord, firstBingoTurn, nextBingoTurn, settleBingoCall, type BingoSeat } from "../shared/bingo";
import type { BingoAction, BingoCall, BingoInput, BingoPollResponse, BingoResponse, BingoStatus, BingoSummary, CatchmindPlayer, LedgerEntry } from "../shared/types";
import { ApiFailure } from "./api";

/** The pool the preview "AI" answers with, whatever the topic. */
const SAMPLE_WORDS = ["떡볶이", "순대", "튀김", "김밥", "라면", "쫄면", "어묵", "만두", "핫도그", "토스트", "주먹밥", "돈가스", "우동", "잔치국수", "비빔밥",
  "오므라이스", "제육덮밥", "김치찌개", "된장찌개", "떡꼬치", "닭강정", "컵밥", "계란말이", "군만두", "냉면", "칼국수", "수제비", "볶음밥", "카레", "식혜"];
const BOT_TOPICS = ["분식집 메뉴", "편의점 간식", "학교 앞 맛집"];
/** How long a preview friend takes over a turn or over opening a game. */
const BOT_MS = 1400;
interface Game { id: string; number: number; leaderId: string; topic: string; lines: number; words: string[]; source: "ai" | "manual"; status: BingoStatus;
  turnId: string | null; turnStartedAt: number | null; calls: BingoCall[]; createdAt: number; startedAt: number | null; endedAt: number | null;
  boards: Map<string, { cells: string[]; rank: number | null; points: number }> }

/** A serverless bingo table for #/preview: the viewer plus two friends who fill
 * their boards at once and call a word a moment after their turn starts. The
 * rules are the Worker's (shared/bingo.ts). */
export function createBingoPreview(viewer: CatchmindPlayer, admin = false) {
  const friends: CatchmindPlayer[] = (["min", "siwon"] as const).filter(name => name !== viewer.username)
    .map(username => ({ id: username, username, displayName: username, photoVersion: null, character: username === "min" ? "axolotl" : "cat" }));
  const people = new Map<string, CatchmindPlayer>([viewer, ...friends].map(person => [person.id, person]));
  const order = [...people.values()].sort((a, b) => (a.username < b.username ? -1 : 1));
  const ledger: LedgerEntry[] = [];
  let game: Game | null = null, leaderId: string | null = null, waitingSince: number | null = null, version = 1, score = 0, opened = 0;
  let seed = 20261120;
  const random = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 0x100000000);
  const shuffled = <T,>(list: readonly T[]) => { const copy = [...list]; for (let i = copy.length - 1; i > 0; i--) { const j = Math.floor(random() * (i + 1)); [copy[i], copy[j]] = [copy[j]!, copy[i]!]; } return copy; };
  const live = () => !!game && (game.status === "filling" || game.status === "playing");
  const seats = (): BingoSeat[] => (game ? [...game.boards].map(([userId, board]) => ({ userId, username: people.get(userId)!.username, cells: board.cells, rank: board.rank, active: true })) : []);
  const nextLeader = (from: string) => { const index = order.findIndex(person => person.id === from); return order[(index + 1) % order.length]!.id; };
  function open(leader: string, topic: string, lines: number, words: string[], source: "ai" | "manual", now: number) {
    game = { id: crypto.randomUUID(), number: ++opened, leaderId: leader, topic, lines, words, source, status: "filling", turnId: null, turnStartedAt: null,
      calls: [], createdAt: now, startedAt: null, endedAt: null, boards: new Map() };
    leaderId = leader; waitingSince = null;
    for (const friend of friends) game.boards.set(friend.id, { cells: shuffled(words).slice(0, 25), rank: null, points: 0 });
    version++;
  }
  function start(now: number) {
    if (!game) return;
    const first = firstBingoTurn(seats(), people.get(game.leaderId)!.username) ?? seats()[0]!;
    game.status = "playing"; game.turnId = first.userId; game.turnStartedAt = now; game.startedAt = now; version++;
  }
  function call(userId: string, word: string, now: number) {
    if (!game) return;
    game.calls.push({ word, by: userId, at: new Date(now).toISOString() });
    const settled = settleBingoCall(seats(), game.lines, new Set(game.calls.map(entry => entry.word)), userId);
    for (const place of settled.ranked) {
      const board = game.boards.get(place.userId)!;
      board.rank = place.rank; board.points = place.points;
      if (place.userId === viewer.id && place.points) {
        score += place.points;
        ledger.unshift({ id: `preview-bingo-${game.id}`, currency: "score", amount: place.points, reason: `빙고 ${place.rank}등`, createdAt: new Date(now).toISOString() });
      }
    }
    if (settled.ended) { game.status = "ended"; game.turnId = null; game.turnStartedAt = null; game.endedAt = now; leaderId = nextLeader(game.leaderId); waitingSince = now; }
    else { game.turnId = settled.next?.userId ?? userId; game.turnStartedAt = now; }
    version++;
  }
  /** Friends act on their own once their moment has come. */
  function advance(now: number) {
    for (let guard = 0; guard < 60; guard++) {
      if (game?.status === "playing" && game.turnId && game.turnId !== viewer.id && now - (game.turnStartedAt ?? now) >= BOT_MS) {
        const called = new Set(game.calls.map(entry => entry.word));
        const open = game.boards.get(game.turnId)!.cells.filter(cell => !called.has(cell));
        call(game.turnId, open[Math.floor(random() * open.length)]!, (game.turnStartedAt ?? now) + BOT_MS);
      } else if (!live() && leaderId && leaderId !== viewer.id && waitingSince !== null && now - waitingSince >= BOT_MS * 2) {
        open(leaderId, BOT_TOPICS[opened % BOT_TOPICS.length]!, opened % 2 ? 5 : 3, SAMPLE_WORDS, "ai", waitingSince + BOT_MS * 2);
      } else break;
    }
  }
  function summary(): BingoSummary {
    const name = (id: string | null | undefined) => { const person = id ? people.get(id) : null; return person ? { username: person.username, displayName: person.displayName } : null; };
    const winner = game?.status === "ended" ? [...game.boards].find(([, board]) => board.rank === 1)?.[0] : null;
    return { status: !game || game.status === "cancelled" ? "idle" : game.status, topic: game && game.status !== "cancelled" ? game.topic : null,
      leader: name(live() ? game!.leaderId : leaderId), turn: name(game?.status === "playing" ? game.turnId : null), winner: name(winner),
      joined: !!game?.boards.has(viewer.id), players: game?.boards.size ?? 0 };
  }
  function respond(now: number): BingoResponse {
    const called = new Set(game ? game.calls.map(entry => entry.word) : []), mine = game?.boards.get(viewer.id);
    const iso = (time: number | null | undefined) => (typeof time === "number" ? new Date(time).toISOString() : null);
    const startAt = game?.status === "filling" ? game.createdAt + BINGO_RULES.skipAfterMs : null;
    const skipAt = game?.status === "playing" ? (game.turnStartedAt ?? now) + BINGO_RULES.skipAfterMs : !live() && leaderId && waitingSince !== null ? waitingSince + BINGO_RULES.skipAfterMs : null;
    return {
      version, viewerId: viewer.id, serverTime: new Date(now).toISOString(), play: playWindow(now),
      bingo: {
        game: game ? {
          id: game.id, number: game.number, leader: people.get(game.leaderId)!, topic: game.topic, lines: game.lines, words: game.words, source: game.source, status: game.status,
          turn: game.turnId ? people.get(game.turnId)! : null, turnStartedAt: iso(game.turnStartedAt), calls: [...game.calls],
          seats: [...game.boards].map(([userId, board]) => ({ player: people.get(userId)!, marked: board.cells.filter(cell => called.has(cell)).length, lines: bingoLines(board.cells, called),
            rank: board.rank, points: board.points, cells: game!.status === "ended" || userId === viewer.id ? board.cells : null }))
            .sort((a, b) => (a.rank ?? 99) - (b.rank ?? 99) || (a.player.username < b.player.username ? -1 : 1)),
          createdAt: iso(game.createdAt)!, startedAt: iso(game.startedAt), endedAt: iso(game.endedAt),
        } : null,
        leader: live() || !leaderId ? null : people.get(leaderId)!, waitingSince: live() ? null : iso(waitingSince),
        canCreate: !admin && !live() && (!leaderId || leaderId === viewer.id), canFill: !admin && game?.status === "filling",
        canStart: !admin && game?.status === "filling" && game.boards.size >= BINGO_RULES.minPlayers && (game.leaderId === viewer.id || (!!mine && now >= (startAt ?? Infinity))),
        canCall: !admin && game?.status === "playing" && game.turnId === viewer.id,
        canSkip: !admin && skipAt !== null && now >= skipAt && (game?.status === "playing" ? !!mine && game.turnId !== viewer.id : !live() && leaderId !== viewer.id),
        canCancel: !admin && game?.status === "filling" && game.leaderId === viewer.id,
        startAvailableAt: iso(startAt), skipAvailableAt: iso(skipAt),
      },
    };
  }
  return {
    get score() { return score; }, get ledger() { return ledger; }, summary,
    read(since?: number): BingoPollResponse {
      const now = Date.now(); advance(now);
      return since === version ? { unchanged: true, version, viewerId: viewer.id, serverTime: new Date(now).toISOString(), play: playWindow(now) } : respond(now);
    },
    async mutate(action: BingoAction, raw: BingoInput): Promise<BingoResponse> {
      const now = Date.now(), input = raw as unknown as Record<string, unknown>;
      advance(now);
      if (admin) throw new ApiFailure(403, "플레이어만 빙고에 참여할 수 있어요.");
      if (action === "create") {
        const problem = bingoTopicProblem(input.topic) ?? (input.words === undefined ? null : bingoWordsProblem(input.words));
        if (problem) throw new ApiFailure(400, problem);
        if (live() || (leaderId && leaderId !== viewer.id)) throw new ApiFailure(409, "이미 진행 중인 빙고가 있어요.");
        open(viewer.id, cleanBingoTopic(input.topic as string), input.lines === 5 ? 5 : 3, input.words ? (input.words as string[]).map(cleanBingoWord) : SAMPLE_WORDS, input.words ? "manual" : "ai", now);
        return respond(now);
      }
      if (action === "skip" && !live()) {
        if (!leaderId || leaderId === viewer.id || waitingSince === null || now < waitingSince + BINGO_RULES.skipAfterMs) throw new ApiFailure(409, "10분이 지나면 리더 차례를 넘길 수 있어요.");
        leaderId = nextLeader(leaderId); waitingSince = now; version++;
        return respond(now);
      }
      if (!game || !live() || game.id !== input.gameId) throw new ApiFailure(409, "그사이에 빙고판이 바뀌었어요. 새로 불러올게요.");
      if (action === "board") {
        const problem = game.status !== "filling" ? "빙고가 이미 시작돼서 판을 바꿀 수 없어요." : bingoBoardProblem(input.cells, game.words);
        if (problem) throw new ApiFailure(400, problem);
        game.boards.set(viewer.id, { cells: input.cells as string[], rank: null, points: 0 }); version++;
        start(now);
      } else if (action === "cancel") {
        if (game.status !== "filling" || game.leaderId !== viewer.id) throw new ApiFailure(403, "판을 채우는 동안에만 리더가 취소할 수 있어요.");
        game.status = "cancelled"; game.endedAt = now; leaderId = nextLeader(game.leaderId); waitingSince = now; version++;
      } else if (action === "start") {
        if (game.status === "filling") start(now);
      } else if (action === "skip") {
        if (game.status !== "playing" || game.turnId === viewer.id || now < (game.turnStartedAt ?? now) + BINGO_RULES.skipAfterMs) throw new ApiFailure(409, "10분이 지나면 차례를 넘길 수 있어요.");
        const next = nextBingoTurn(seats(), people.get(game.turnId ?? "")?.username ?? "");
        if (next) { game.turnId = next.userId; game.turnStartedAt = now; version++; }
      } else {
        const mine = game.boards.get(viewer.id), word = String(input.word ?? "");
        if (game.status !== "playing" || game.turnId !== viewer.id) throw new ApiFailure(403, "지금은 내 차례가 아니에요.");
        if (!mine?.cells.includes(word) || game.calls.some(entry => entry.word === word)) throw new ApiFailure(400, "내 빙고판에 남아 있는 단어를 골라 주세요.");
        call(viewer.id, word, now);
      }
      return respond(now);
    },
  };
}
export type BingoPreview = ReturnType<typeof createBingoPreview>;
const engines = new Map<string, BingoPreview>();
/** One preview table per preview identity for the page session. */
export function previewBingo(viewer: CatchmindPlayer, admin: boolean): BingoPreview {
  const key = `${admin ? "admin" : "player"}:${viewer.username}`;
  let engine = engines.get(key);
  if (!engine) { engine = createBingoPreview(viewer, admin); engines.set(key, engine); }
  return engine;
}
/** The home row before the preview has opened anything. */
export const previewBingoSummary = (): BingoSummary => ({ status: "idle", topic: null, leader: null, turn: null, winner: null, joined: false, players: 0 });
