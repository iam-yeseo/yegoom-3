import type { Board, SimulationFrame } from "../../shared/claw-physics";
import type { ClawResult } from "../../shared/types";

export interface ReplayJob { id: number; board: Board; result: ClawResult; finalBoard: Board }
export type ReplayReply = { id: number; frames: SimulationFrame[] } | { id: number; error: string };

/** Warm on machine entry, before the server result is needed. No server calls,
 * account data persistence or physics decisions happen in this worker. */
export function createReplayBuilder() {
  let worker: Worker | null = null;
  let failure: Error | null = null;
  let disposed = false;
  let sequence = 0;
  const pending = new Map<number, { resolve: (frames: SimulationFrame[]) => void; reject: (error: Error) => void }>();
  function fail(error: Error) {
    failure = error;
    worker?.terminate(); worker = null;
    for (const job of pending.values()) job.reject(error);
    pending.clear();
  }
  function warm() {
    if (worker || failure || disposed) return;
    try {
      worker = new Worker(new URL("./replay-worker.ts", import.meta.url), { type: "module" });
      worker.onmessage = (event: MessageEvent<ReplayReply>) => {
        const reply = event.data, job = pending.get(reply.id);
        if (!job) return;
        pending.delete(reply.id);
        if ("error" in reply) job.reject(new Error(reply.error));
        else if (Array.isArray(reply.frames)) job.resolve(reply.frames);
        else job.reject(new Error("뽑기 재생을 확인하지 못했어요."));
      };
      worker.onerror = event => {
        event.preventDefault();
        fail(new Error("뽑기 재생을 준비하지 못했어요."));
      };
      worker.onmessageerror = () => fail(new Error("뽑기 재생을 읽지 못했어요."));
    } catch {
      fail(new Error("이 브라우저에서는 뽑기 재생을 준비하지 못했어요."));
    }
  }
  function build(board: Board, result: ClawResult, finalBoard: Board): Promise<SimulationFrame[]> {
    if (disposed) return Promise.reject(new Error("뽑기 재생이 종료됐어요."));
    warm();
    if (!worker || failure) return Promise.reject(failure ?? new Error("뽑기 재생을 준비하지 못했어요."));
    const id = ++sequence;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      try { worker!.postMessage({ id, board, result, finalBoard } satisfies ReplayJob); }
      catch { pending.delete(id); reject(new Error("뽑기 재생을 보내지 못했어요.")); }
    });
  }
  return {
    warm, build,
    destroy() { disposed = true; fail(new Error("뽑기 재생이 종료됐어요.")); },
  };
}
