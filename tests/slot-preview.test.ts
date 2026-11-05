import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NICKNAME_TAG_RULES, SLOT_RULES } from '../shared/balance';
import { createShopPreview } from '../src/shop-preview';

const at = (clock: string) => vi.setSystemTime(new Date(clock));
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  at('2026-11-04T09:00:00+09:00');
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('offline slot preview', () => {
  it('uses the shared 6/7 jackpot boundary, immediately credits prizes, and replays the same receipt once', () => {
    const preview = createShopPreview(SLOT_RULES.price);
    const random = vi.spyOn(Math, 'random').mockReturnValue(0.06);
    const input = { requestId: 'preview-jackpot' };
    const result = preview.spinSlot(input);
    expect(result.spin).toMatchObject({ reels: ['seven', 'seven', 'seven'], prize: SLOT_RULES.jackpotPrize, cost: SLOT_RULES.price });
    expect(result.gold).toBe(SLOT_RULES.jackpotPrize);
    expect(preview.ledger.map(row => [row.reason, row.amount])).toEqual([['슬롯머신 당첨', 2000], ['슬롯머신', -500]]);
    random.mockReturnValue(0.07);
    expect(preview.spinSlot(input)).toEqual(result);
    expect(preview.ledger).toHaveLength(2);
    const loss = preview.spinSlot({ requestId: 'preview-loss' });
    expect(loss.spin?.prize).toBe(0);
    expect(new Set(loss.spin?.reels).size).toBeGreaterThan(1);
    expect(loss.gold).toBe(SLOT_RULES.jackpotPrize - SLOT_RULES.price);
  });

  it('rejects insufficient gold and malformed request IDs without spending coupons or recording a spin', () => {
    const preview = createShopPreview(SLOT_RULES.price - 1);
    const inventory = preview.read().inventory;
    expect(() => preview.spinSlot({ requestId: 'no-gold' })).toThrow('골드가 부족해요');
    expect(() => preview.spinSlot({ requestId: '' })).toThrow('구매 요청');
    expect(() => preview.spinSlot({ requestId: 'has spaces' })).toThrow('구매 요청');
    expect(preview.read('slot')).toMatchObject({ gold: SLOT_RULES.price - 1, inventory, slot: { recent: [] } });
    expect(preview.ledger).toEqual([]);
  });

  it('does not impose a daily cap and limits history to the latest twenty spins', () => {
    const preview = createShopPreview(SLOT_RULES.price * 25);
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    for (let index = 0; index < 25; index++) {
      at(`2026-11-04T09:00:${String(index).padStart(2, '0')}+09:00`);
      preview.spinSlot({ requestId: `spin-${index}` });
    }
    const result = preview.read('slot');
    expect(SLOT_RULES.dailyLimit).toBeNull();
    expect(result.gold).toBe(0);
    expect(result.slot.recent.map(spin => spin.requestId)).toEqual(Array.from({ length: 20 }, (_, index) => `spin-${24 - index}`));
    expect(preview.ledger).toHaveLength(25);
    // An evicted receipt remains recoverable even after all gold is spent.
    expect(preview.spinSlot({ requestId: 'spin-0' }).spin?.requestId).toBe('spin-0');
    expect(preview.ledger).toHaveLength(25);
  });

  it('uses the inclusive KST seven-day boundary and preserves old receipts outside the visible history', () => {
    at('2026-11-01T23:59:59+09:00');
    const preview = createShopPreview(SLOT_RULES.price * 2);
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    const original = preview.spinSlot({ requestId: 'old-slot' }).spin;
    at('2026-11-07T23:59:59+09:00');
    expect(preview.read('slot').slot.recent).toEqual([original]);
    at('2026-11-08T00:00:00+09:00');
    expect(preview.read('slot').slot.recent).toEqual([]);
    const balance = preview.read().gold;
    expect(preview.spinSlot({ requestId: 'old-slot' })).toMatchObject({ gold: balance, spin: original, slot: { recent: [] } });
    expect(preview.ledger).toHaveLength(1);
    const next = preview.spinSlot({ requestId: 'new-slot' });
    expect(next.spin?.date).toBe('2026-11-08');
    expect(next.slot.recent.map(spin => spin.requestId)).toEqual(['new-slot']);
  });

  it('keeps slot request IDs separate from other shop receipts and returns detached snapshots', () => {
    const preview = createShopPreview(SLOT_RULES.price * 3);
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    preview.buySpeetto({ requestId: 'same-id', payment: 'ticket' });
    const result = preview.spinSlot({ requestId: 'same-id' });
    const original = structuredClone(result.spin);
    result.spin!.reels[0] = 'seven';
    result.slot.recent.length = 0;
    expect(preview.spinSlot({ requestId: 'same-id' }).spin).toEqual(original);
    expect(preview.read('slot').slot.recent).toEqual([original]);
    expect(preview.read().inventory).toEqual({ lottoTickets: 2, speettoTickets: 1, tagTickets: NICKNAME_TAG_RULES.welcomeTickets });
  });
});
