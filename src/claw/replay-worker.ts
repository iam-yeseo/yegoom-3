import type { ReplayJob, ReplayReply } from "./replay";
import { framesAfterDescent, simulateReplay } from "./replay-simulation";

const scope = self as unknown as {
  onmessage: ((event: MessageEvent<ReplayJob>) => void) | null;
  postMessage: (reply: ReplayReply) => void;
};
scope.onmessage = event => {
  const { id, board, result, finalBoard } = event.data;
  try { scope.postMessage({ id, frames: framesAfterDescent(simulateReplay(board, result, finalBoard)) }); }
  catch (error) { scope.postMessage({ id, error: error instanceof Error ? error.message : "뽑기 재생을 확인하지 못했어요." }); }
};
