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
    // Today's slot 이용권 pays first (2026-11-07 merge): no gold debit.
    expect(result.spin).toMatchObject({ reels: ['seven', 'seven', 'seven'], prize: SLOT_RULES.jackpotPrize, cost: 0, free: true });
    expect(result.gold).toBe(SLOT_RULES.price + SLOT_RULES.jackpotPrize);
    expect(preview.ledger.map(row => [row.reason, row.amount])).toEqual([['슬롯머신 당첨', 2000]]);
    random.mockReturnValue(0.07);
    expect(preview.spinSlot(input)).toEqual(result);
    expect(preview.ledger).toHaveLength(1);
    const loss = preview.spinSlot({ requestId: 'preview-loss' });
    expect(loss.spin?.prize).toBe(0);
    expect(new Set(loss.spin?.reels).size).toBeGreaterThan(1);
    expect(loss.gold).toBe(SLOT_RULES.price + SLOT_RULES.jackpotPrize);
  });

  it('rejects insufficient gold and malformed request IDs without spending coupons or recording a spin', () => {
    const preview = createShopPreview(SLOT_RULES.price - 1);
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    const inventory = preview.read().inventory;
    // Today's three slot 이용권 spin without gold; the fourth needs the price.
    for (let index = 0; index < 3; index++) preview.spinSlot({ requestId: `daily-${index}` });
    expect(() => preview.spinSlot({ requestId: 'no-gold' })).toThrow('이용권과 골드가 부족해요');
    expect(() => preview.spinSlot({ requestId: '' })).toThrow('구매 요청');
    expect(() => preview.spinSlot({ requestId: 'has spaces' })).toThrow('구매 요청');
    expect(preview.read('slot')).toMatchObject({ gold: SLOT_RULES.price - 1, inventory });
    expect(preview.read('slot').slot.recent).toHaveLength(3);
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
    // The first three were today's 이용권, so three spins' worth of gold is left.
    expect(result.gold).toBe(SLOT_RULES.price * 3);
    expect(result.slot.recent.map(spin => spin.requestId)).toEqual(Array.from({ length: 20 }, (_, index) => `spin-${24 - index}`));
    expect(preview.ledger).toHaveLength(22);
    // An evicted receipt remains recoverable even after all gold is spent.
    expect(preview.spinSlot({ requestId: 'spin-0' }).spin?.requestId).toBe('spin-0');
    expect(preview.ledger).toHaveLength(22);
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
    // That day's 이용권 paid for it: no gold row.
    expect(preview.ledger).toHaveLength(0);
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
    // The speetto 이용권 came from today's free ones; owned tickets stay.
    expect(preview.read().inventory).toEqual({ lottoTickets: 2, speettoTickets: 2, tagTickets: NICKNAME_TAG_RULES.welcomeTickets });
  });
});
