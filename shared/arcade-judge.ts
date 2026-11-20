import type { ArcadeGame } from './balance';
import { simulateEnd, validStone, type StoneInput } from './curling-physics';
import { judgeShootout, validKick, type KickInput } from './penalty-engine';
import type { ArcadeTryRecord } from './types';

/** What each game adds to the shared set rules (worker/arcade.ts and the
 * preview): the shape of its inputs and how a recorded set is judged again. */
export interface ArcadeJudge {
  /** Ledger reason for the set's score and gold. */
  reason: string;
  /** The inputs in a fixed shape, or null when they are not valid. */
  clean(inputs: unknown[]): unknown[] | null;
  judge(slot: number, inputs: unknown[]): ArcadeTryRecord[];
}
export const ARCADE_JUDGES: Record<ArcadeGame, ArcadeJudge> = {
  curling: {
    reason: '컬링 하우스 안착',
    clean: inputs => inputs.every(validStone) ? (inputs as StoneInput[]).map(({ power, aim }) => ({ power, aim })) : null,
    // A stone counts when it lies in the house once the last stone has stopped.
    judge: (_slot, inputs) => {
      const end = simulateEnd(inputs as StoneInput[]);
      return end.throws.map((result, index) => ({ index, made: end.counted[index]!, kind: result.kind }));
    },
  },
  penalty: {
    reason: '승부차기 골',
    clean: inputs => inputs.every(validKick) ? (inputs as KickInput[]).map(({ power, aim, t }) => ({ power, aim, t })) : null,
    // Everyone in a slot faces the same five keepers.
    judge: (slot, inputs) => judgeShootout(slot, inputs as KickInput[]).kicks.map((kick, index) => ({ index, made: kick.made, kind: kick.kind })),
  },
};
