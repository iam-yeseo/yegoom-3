import { describe, expect, it } from 'vitest';
import { keepServerOffset } from '../src/clock';

const at = (iso: string) => Date.parse(iso);

describe('server clock offset', () => {
  it('keeps counting after the stamp it was measured from grows old', () => {
    // The server says 09:00:00 while the device reads 08:59:58: offset +2s.
    const stamp = '2026-11-24T00:00:00.000Z';
    let kept = keepServerOffset(null, stamp, at('2026-11-23T23:59:58.000Z'));
    expect(kept.offset).toBe(2000);
    // The same stamp re-renders 5 and 90 seconds later (a ticking countdown).
    for (const device of ['2026-11-23T23:59:59.000Z', '2026-11-24T00:00:03.000Z', '2026-11-24T00:01:28.000Z']) {
      kept = keepServerOffset(kept, stamp, at(device));
      expect(kept.offset).toBe(2000);
      expect(at(device) + kept.offset).toBe(at(device) + 2000);
    }
  });

  it('ignores sub-second jitter from fresh stamps but follows a real clock change', () => {
    let kept = keepServerOffset(null, '2026-11-24T00:00:00.000Z', at('2026-11-24T00:00:00.000Z'));
    kept = keepServerOffset(kept, '2026-11-24T00:00:10.400Z', at('2026-11-24T00:00:10.000Z'));
    expect(kept.offset).toBe(0);
    kept = keepServerOffset(kept, '2026-11-24T00:00:20.000Z', at('2026-11-24T00:00:15.000Z'));
    expect(kept.offset).toBe(5000);
  });

  it('uses the device clock without a stamp or with an unreadable one', () => {
    expect(keepServerOffset(null, undefined, 1234).offset).toBe(0);
    expect(keepServerOffset(null, 'not a date', 1234).offset).toBe(0);
  });
});
