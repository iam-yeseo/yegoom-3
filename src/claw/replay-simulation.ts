import { simulateAttempt, type Board, type SimulationFrame } from "../../shared/claw-physics";
import { CLAW_RULES } from "../../shared/balance";
import type { ClawResult } from "../../shared/types";

/** Keep the original deterministic engine and its server-result check together.
 * This module runs in the replay worker, without changing any physics values. */
export function simulateReplay(board: Board, result: ClawResult, finalBoard: Board): SimulationFrame[] {
  const sim = simulateAttempt(board, { x: result.x, stop: result.stop, pickup: result.grip.pickup, carry: result.grip.carry }, { record: true });
  const sameIds = sim.prizes.map(doll => doll.id).join() === result.prizes.map(doll => doll.id).join();
  const consistent = result.engine === CLAW_RULES.engine && sim.reason === result.reason && sameIds
    && ((result.cleared ?? Boolean(result.clearBonus)) || JSON.stringify(sim.board) === JSON.stringify(finalBoard));
  if (!consistent || !sim.frames) throw new Error("뽑기 재생이 서버 결과와 달라 결과만 보여 줘요.");
  return sim.frames;
}

/** Descent has already played before the server receipt arrives. Keep the
 * remaining original frames verbatim and avoid cloning that discarded prefix
 * back to the main thread. The physics simulation itself still records all of
 * its frames for the server-result check and independent engine oracle. */
export function framesAfterDescent(frames: SimulationFrame[]): SimulationFrame[] {
  return frames.slice(Math.max(0, frames.findIndex(frame => frame.phase !== "descend")));
}
