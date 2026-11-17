import { describe, expect, it } from 'vitest';
import { createRequestGate } from '../src/shop-requests';

type Kind = 'shop' | 'tag' | 'lotto';
/** The provider's wiring in miniature: answers arrive when the test releases
 * them, in whatever order it chooses, and only a current answer is applied. */
function harness() {
  const loading: boolean[] = [];
  const gate = createRequestGate<Kind>(value => { loading.push(value); });
  const applied: string[] = [];
  const pendingReads: { kind: Kind; answer: (value: string) => void; fail: () => void }[] = [];
  const read = (kind: Kind) => {
    const ticket = gate.beginRead(kind);
    if (!ticket) return;
    const settle = (value: string | null) => {
      if (value !== null && ticket.current()) applied.push(value);
      ticket.end();
    };
    pendingReads.push({ kind, answer: value => settle(value), fail: () => settle(null) });
  };
  /** Starts a write; the returned function delivers its answer (or failure). */
  const write = (covered: Kind[] = ['shop', 'tag']) => {
    const ticket = gate.beginWrite();
    return (value: string | null) => {
      if (value !== null) applied.push(value);
      const owed = ticket.end(kind => value !== null && covered.includes(kind));
      if (owed) read(owed.kind);
    };
  };
  return { gate, loading, applied, pendingReads, read, write, isLoading: () => loading[loading.length - 1] ?? false };
}

describe('shop request gate', () => {
  it('releases loading when a tag change overtakes a slow read, whichever answer comes first', () => {
    for (const writeFirst of [true, false]) {
      const shop = harness();
      shop.read('tag'); // the slow re-read of a cached inventory
      expect(shop.isLoading()).toBe(true);
      const finishWrite = shop.write(); // wear, discard or evolve
      expect(shop.isLoading()).toBe(true);
      if (writeFirst) {
        finishWrite('worn');
        // Every request that still counts has ended: the draw button is usable again.
        expect(shop.isLoading()).toBe(false);
        shop.pendingReads[0]!.answer('before the change');
      } else {
        shop.pendingReads[0]!.answer('before the change');
        // The write is still running: not released early.
        expect(shop.isLoading()).toBe(true);
        finishWrite('worn');
      }
      expect(shop.isLoading(), String(writeFirst)).toBe(false);
      // The stale read never replaced the write's state, and was not asked again:
      // the write's answer already carried the tags.
      expect(shop.applied, String(writeFirst)).toEqual(['worn']);
      expect(shop.pendingReads, String(writeFirst)).toHaveLength(1);
    }
  });

  it('runs the overtaken read again after a failed change, and stays loading until it ends', () => {
    for (const writeFirst of [true, false]) {
      const shop = harness();
      shop.read('tag');
      const finishWrite = shop.write();
      if (!writeFirst) shop.pendingReads[0]!.answer('stale');
      finishWrite(null); // the change failed: nothing fresh arrived with it
      expect(shop.isLoading()).toBe(true);
      expect(shop.pendingReads.map(entry => entry.kind)).toEqual(['tag', 'tag']);
      if (writeFirst) shop.pendingReads[0]!.answer('stale');
      expect(shop.isLoading()).toBe(true);
      shop.pendingReads[1]!.answer('fresh');
      expect(shop.isLoading()).toBe(false);
      expect(shop.applied).toEqual(['fresh']);
    }
  });

  it('owes a read asked for during a write, and a read of another kind the write did not carry', () => {
    const shop = harness();
    const finishWrite = shop.write(['shop', 'tag']);
    shop.read('lotto'); // deferred: nothing is sent while the write runs
    expect(shop.pendingReads).toHaveLength(0);
    finishWrite('worn');
    expect(shop.isLoading()).toBe(true);
    expect(shop.pendingReads.map(entry => entry.kind)).toEqual(['lotto']);
    shop.pendingReads[0]!.fail();
    expect(shop.isLoading()).toBe(false);
    expect(shop.applied).toEqual(['worn']);
  });

  it('lets the newest read own loading, ignores older answers, and reports a write in flight', () => {
    const shop = harness();
    shop.read('shop');
    shop.read('tag');
    shop.pendingReads[1]!.answer('newer');
    expect(shop.isLoading()).toBe(false);
    shop.pendingReads[0]!.answer('older');
    expect(shop.applied).toEqual(['newer']);
    expect(shop.isLoading()).toBe(false);

    expect(shop.gate.writing()).toBe(false);
    const finishWrite = shop.write();
    expect(shop.gate.writing()).toBe(true);
    finishWrite('done');
    expect(shop.gate.writing()).toBe(false);

    // A local replacement of the state drops the read in flight without owing it.
    shop.read('shop');
    shop.gate.supersedeRead();
    expect(shop.isLoading()).toBe(false);
    shop.pendingReads[2]!.answer('dropped');
    expect(shop.applied).toEqual(['newer', 'done']);
    expect(shop.isLoading()).toBe(false);
  });
});
