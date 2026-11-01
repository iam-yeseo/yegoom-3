import { afterEach, describe, expect, it, vi } from 'vitest';
import { ATTENDANCE_RULES, LOTTO_RULES } from '../shared/balance';
import { createShopPreview } from '../src/shop-preview';

afterEach(() => vi.useRealTimers());

describe('combined attendance and shop preview cash', () => {
  it('keeps earlier spending and makes a new attendance award spendable exactly once', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-01T00:00:00Z'));
    const engine = createShopPreview(LOTTO_RULES.price * 2 - ATTENDANCE_RULES.dailyGold);
    const first = { requestId: 'before-attendance', numbers: [1, 2, 3, 4, 5], payment: 'gold' as const };
    const second = { requestId: 'after-attendance', numbers: [6, 7, 8, 9, 10], payment: 'gold' as const };

    engine.buyLotto(first);
    expect(() => engine.buyLotto(second)).toThrow('골드가 부족해요.');
    engine.setAttendanceBonus(ATTENDANCE_RULES.dailyGold, '2026-11-01');
    engine.setAttendanceBonus(ATTENDANCE_RULES.dailyGold, '2026-11-01');
    expect(engine.read().gold).toBe(LOTTO_RULES.price);
    const purchased = engine.buyLotto(second);
    expect(purchased.gold).toBe(0);
    expect(engine.buyLotto(second).purchase).toEqual(purchased.purchase);
    engine.setAttendanceBonus(ATTENDANCE_RULES.dailyGold, '2026-11-01');
    expect(engine.read().gold).toBe(0);
    expect(engine.read('lotto').lotto.tickets.filter(ticket => ticket.requestId === first.requestId || ticket.requestId === second.requestId)).toHaveLength(2);
    // Attendance owns its own preview history; the engine records shop debits only.
    expect(engine.ledger.map(row => row.amount)).toEqual([-LOTTO_RULES.price, -LOTTO_RULES.price]);
  });

  it('does not revoke a spent attendance award at KST midnight and credits the next day once', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-01T14:59:59Z'));
    const engine = createShopPreview(0, ATTENDANCE_RULES.cycleGold);
    const input = { requestId: 'before-midnight', numbers: [1, 2, 3, 4, 5], payment: 'gold' as const };
    const purchased = engine.buyLotto(input).purchase;
    expect(engine.read().gold).toBe(ATTENDANCE_RULES.cycleGold - LOTTO_RULES.price);

    vi.setSystemTime(new Date('2026-11-01T15:00:00Z'));
    engine.setAttendanceBonus(0, '2026-11-02');
    engine.setAttendanceBonus(0, '2026-11-02');
    expect(engine.read().gold).toBe(0);
    expect(engine.read('lotto').lotto.tickets.find(ticket => ticket.requestId === input.requestId)).toEqual(purchased);
    engine.setAttendanceBonus(ATTENDANCE_RULES.dailyGold, '2026-11-02');
    engine.setAttendanceBonus(ATTENDANCE_RULES.dailyGold, '2026-11-02');
    expect(engine.read().gold).toBe(ATTENDANCE_RULES.dailyGold);
    expect(engine.buyLotto(input).purchase).toEqual(purchased);
    expect(engine.read().gold).toBe(ATTENDANCE_RULES.dailyGold);
    expect(engine.ledger.map(row => row.amount)).toEqual([-LOTTO_RULES.price]);
  });
});
