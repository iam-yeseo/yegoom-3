import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CLAW, MACHINE, createBoard, simulateAttempt, type AttemptInput } from '../shared/claw-physics';
// The untouched upstream JavaScript is deliberately the independent oracle.
// @ts-expect-error The original fixture has no TypeScript declarations.
import * as original from './fixtures/gatcha-physics.original.js';

const SOURCE_BLOB = 'b564c2a993f8dff328ff1c6c63810a1993a98a4c';
let seed = 0x434c4157;
const random = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 0x100000000);
const cases = Array.from({ length: 240 }, (_, index) => ({
  index,
  generation: 1 + index % 13,
  seed: Math.floor(random() * 0x100000000),
  position: random(),
  stopFraction: random(),
  pickup: random(),
  carry: random(),
}));

describe('claw physics matches the immutable upstream engine', () => {
  it('keeps the original fixture byte-for-byte at its Git blob SHA', () => {
    const contents = readFileSync(new URL('./fixtures/gatcha-physics.original.js', import.meta.url));
    const hash = createHash('sha1').update(`blob ${contents.length}\0`).update(contents).digest('hex');
    expect(hash).toBe(SOURCE_BLOB);
  });

  it.each(cases)('matches board and every playback frame for case $index (generation $generation, seed $seed)', (sample) => {
    const board = createBoard(sample.generation, sample.seed);
    const oldBoard = original.createBoard(sample.generation, sample.seed);
    expect(JSON.stringify(board)).toBe(JSON.stringify(oldBoard));

    // Exercise walls, exact doll centres, arbitrary positions, automatic descent,
    // early/manual stops, and weak/strong pickup and carry independently.
    const target = board[sample.index % board.length];
    const x = sample.index % 6 === 0 ? MACHINE.clawMin
      : sample.index % 6 === 1 ? MACHINE.clawMax
        : sample.index % 6 === 2 ? target.x
          : MACHINE.clawMin + sample.position * (MACHINE.clawMax - MACHINE.clawMin);
    const input: AttemptInput = {
      x,
      stop: sample.index % 4 === 0 ? CLAW.top
        : sample.index % 4 === 1 ? CLAW.top + sample.stopFraction * (MACHINE.height - CLAW.top) : null,
      pickup: sample.index % 3 === 0 ? 1 : sample.pickup,
      carry: sample.index % 3 === 0 ? 1 : sample.carry,
    };
    const result = simulateAttempt(board, input, { record: true });
    const oldResult = original.simulateAttempt(oldBoard, input, { record: true });
    expect(JSON.stringify(result)).toBe(JSON.stringify(oldResult));
    // Original motor termination and the 360-frame settling cap remain intact.
    // A complete valid play stays within this conservative replay-frame bound.
    expect(result.frames!.length).toBeGreaterThan(0);
    expect(result.frames!.length).toBeLessThanOrEqual(1024);
  });
});
