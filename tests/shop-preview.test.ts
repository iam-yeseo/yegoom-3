import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ATTENDANCE_RULES, CATCHMIND_RULES, LOTTO_RULES, NICKNAME_TAG_RULES, SPEETTO_RULES } from '../shared/balance';
import { createShopPreview } from '../src/shop-preview';
import { advanceNoticeOffset, hasSeenLotto, lottoSeenKey, markLottoSeen, markViewedLottoDraw, nextKstMidnight, noticeDate } from '../src/lotto-notice';

const numbers = [2, 3, 4, 5, 6];
const at = (clock: string) => vi.setSystemTime(new Date(clock));
const setupClock = () => { vi.useFakeTimers(); at('2026-11-04T09:00:00+09:00'); };
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('shop preview draw and recent purchase rules', () => {
  beforeEach(setupClock);
  it('keeps 17:00–17:29:59 purchases in today and moves 17:30:00 purchases to tomorrow', () => {
    const preview = createShopPreview(10000);
    at('2026-11-04T17:15:00+09:00');
    expect(preview.buyLotto({ requestId: 'before-half-past', numbers, payment: 'gold' }).purchase)
      .toMatchObject({ purchaseDate: '2026-11-04', drawDate: '2026-11-04', createdAt: '2026-11-04T08:15:00.000Z' });
    at('2026-11-04T17:29:59+09:00');
    expect(preview.buyLotto({ requestId: 'last-second', numbers, payment: 'gold' }).purchase?.drawDate).toBe('2026-11-04');
    at('2026-11-04T17:30:00+09:00');
    expect(preview.buyLotto({ requestId: 'next-draw', numbers, payment: 'gold' }).purchase)
      .toMatchObject({ purchaseDate: '2026-11-04', drawDate: '2026-11-05' });
    expect(preview.read('lotto').lotto.targetDrawDate).toBe('2026-11-05');
  });

  it('reports only the current drawn round and clears yesterday’s notice on the next day', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const preview = createShopPreview(10000);
    expect(preview.lottoNotice()).toBeNull();
    preview.buyLotto({ requestId: 'notice-ticket', numbers, payment: 'gold' });
    at('2026-11-04T17:29:59+09:00');
    expect(preview.lottoNotice()).toBeNull();
    at('2026-11-04T17:30:00+09:00');
    expect(preview.lottoNotice()).toEqual({ drawDate: '2026-11-04', tickets: 1, winners: 1, prize: LOTTO_RULES.prizes[5] });
    at('2026-11-05T00:00:00+09:00');
    expect(preview.lottoNotice()).toBeNull();
    at('2026-11-05T18:00:00+09:00');
    expect(preview.lottoNotice()).toBeNull();
  });

  it('limits both histories by purchase day but still settles and replays an older receipt once', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0);
    at('2026-11-01T09:00:00+09:00');
    const preview = createShopPreview(10000);
    const lotto = { requestId: 'old-lotto', numbers, payment: 'gold' as const };
    const speetto = { requestId: 'old-speetto', payment: 'gold' as const };
    const id = preview.buyLotto(lotto).purchase!.id;
    preview.buySpeetto(speetto);
    const balanceBeforeSettlement = preview.read().gold;
    const inclusiveBoundary = createShopPreview(10000);
    inclusiveBoundary.buyLotto(lotto);
    inclusiveBoundary.buySpeetto(speetto);
    at('2026-11-07T09:00:00+09:00');
    expect(inclusiveBoundary.read('lotto').lotto.tickets[0]).toMatchObject({ purchaseDate: '2026-11-01' });
    expect(inclusiveBoundary.read('speetto').speetto.tickets).toHaveLength(1);
    at('2026-11-08T09:00:00+09:00');
    expect(preview.read('lotto').lotto.tickets).toEqual([]);
    expect(preview.read('speetto').speetto.tickets).toEqual([]);
    expect(preview.read().gold).toBe(balanceBeforeSettlement + LOTTO_RULES.prizes[5]);
    const retried = preview.buyLotto(lotto);
    expect(retried.purchase).toMatchObject({ id, purchaseDate: '2026-11-01', prize: LOTTO_RULES.prizes[5] });
    expect(retried.lotto.tickets).toEqual([]);
    expect(preview.buySpeetto(speetto).purchase).toMatchObject({ purchaseDate: '2026-11-01', prize: SPEETTO_RULES.prize });
    expect(preview.read().gold).toBe(balanceBeforeSettlement + LOTTO_RULES.prizes[5]);
    expect(preview.ledger.filter(entry => entry.reason.startsWith('데일리 로또 ') && entry.amount > 0)).toHaveLength(1);
  });

  it('provides an evening notice example without crediting its historical prize again', () => {
    at('2026-11-04T18:00:00+09:00');
    const preview = createShopPreview(10000);
    expect(preview.lottoNotice()).toMatchObject({ drawDate: '2026-11-04', tickets: 1 });
    expect(preview.read('lotto').lotto.tickets.map(ticket => ticket.purchaseDate)).toEqual(['2026-11-04', '2026-11-03']);
    expect(preview.read().gold).toBe(10000);
    expect(preview.ledger).toEqual([]);
  });
});

describe('lotto notice account and date memory', () => {
  beforeEach(setupClock);
  it('remembers an actually viewed draw before bootstrap catches up, without hiding an early or background visit', () => {
    const values = new Map<string, string>();
    vi.stubGlobal('localStorage', { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value) });
    const draw = { date: '2026-11-04', numbers };
    markViewedLottoDraw('min', '/shop/lotto', draw, '2026-11-04T17:29:59+09:00');
    expect(hasSeenLotto('min', draw.date)).toBe(false);
    markViewedLottoDraw('min', '/', draw, '2026-11-04T17:30:00+09:00');
    expect(hasSeenLotto('min', draw.date)).toBe(false);
    markViewedLottoDraw('min', '/shop/lotto', { ...draw, numbers: null }, '2026-11-04T17:30:00+09:00');
    expect(hasSeenLotto('min', draw.date)).toBe(false);
    markViewedLottoDraw('min', '/shop/lotto', draw, '2026-11-04T17:30:00+09:00');
    expect(hasSeenLotto('min', draw.date)).toBe(true);
  });

  it('keeps seen flags separate for each account and draw', () => {
    const values = new Map<string, string>();
    vi.stubGlobal('localStorage', { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value) });
    markLottoSeen('min', '2026-11-04');
    expect(values.get(lottoSeenKey('min', '2026-11-04'))).toBe('1');
    expect(hasSeenLotto('min', '2026-11-04')).toBe(true);
    expect(hasSeenLotto('siwon', '2026-11-04')).toBe(false);
    expect(hasSeenLotto('min', '2026-11-05')).toBe(false);
  });

  it('survives blocked storage and expires at KST midnight', () => {
    vi.stubGlobal('localStorage', { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); } });
    expect(() => markLottoSeen('min', '2026-11-04')).not.toThrow();
    expect(hasSeenLotto('min', '2026-11-04')).toBe(false);
    const time = Date.parse('2026-11-04T23:59:59+09:00');
    expect(noticeDate(time)).toBe('2026-11-04');
    expect(nextKstMidnight(time)).toBe(Date.parse('2026-11-05T00:00:00+09:00'));
    expect(noticeDate(nextKstMidnight(time))).toBe('2026-11-05');
    // The device and server can start on different dates. Accept that first
    // correction, then keep a late pre-midnight snapshot from reviving a card.
    const localBeforeMidnight = Date.parse('2026-11-20T23:59:58+09:00');
    const firstSample = '2026-11-04T23:59:58+09:00';
    const offset = advanceNoticeOffset(null, firstSample, localBeforeMidnight);
    expect(localBeforeMidnight + offset).toBe(Date.parse(firstSample));
    expect(noticeDate(localBeforeMidnight + 2000 + offset)).toBe('2026-11-05');
    const arrival = localBeforeMidnight + 21000; // Estimated server time 00:00:19.
    const delayed = advanceNoticeOffset(offset, '2026-11-04T23:59:59+09:00', arrival);
    expect(delayed).toBe(offset);
    expect(noticeDate(arrival + delayed)).toBe('2026-11-05');
    expect(advanceNoticeOffset(delayed, '2026-11-05T00:00:22+09:00', arrival)).toBe(offset + 3000);
  });
});

describe('combined attendance and shop preview cash', () => {
  it('adds attendance coupons from November 3 once without replacing purchases or launch gifts', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-02T00:00:00Z'));
    const engine = createShopPreview(0, 100, '2026-11-02');
    expect(engine.read().inventory).toEqual({ lottoTickets: 2, speettoTickets: 2, tagTickets: NICKNAME_TAG_RULES.welcomeTickets });
    engine.claimLaunchGift();
    expect(engine.read().inventory).toEqual({ lottoTickets: 7, speettoTickets: 7, tagTickets: NICKNAME_TAG_RULES.welcomeTickets });
    vi.setSystemTime(new Date('2026-11-02T15:00:00Z'));
    engine.setAttendanceBonus(0, '2026-11-03');
    expect(engine.read().inventory).toEqual({ lottoTickets: 7, speettoTickets: 7, tagTickets: NICKNAME_TAG_RULES.welcomeTickets });
    engine.setAttendanceBonus(500, '2026-11-03');
    engine.buyLotto({ requestId: 'use-attendance-ticket', numbers: [1, 2, 3, 4, 5], payment: 'ticket' });
    engine.setAttendanceBonus(500, '2026-11-03');
    expect(engine.read().inventory).toEqual({ lottoTickets: 7, speettoTickets: 8, tagTickets: NICKNAME_TAG_RULES.welcomeTickets });
    expect(createShopPreview(0, 100, '2026-11-03').read().inventory).toEqual({ lottoTickets: 3, speettoTickets: 3, tagTickets: NICKNAME_TAG_RULES.welcomeTickets });
  });
  it('makes a Catchmind award spendable without replaying it or undoing prior purchases', () => {
    const engine = createShopPreview(LOTTO_RULES.price * 2 - CATCHMIND_RULES.gold);
    const buy = (requestId: string) => engine.buyLotto({ requestId, numbers: [1, 2, 3, 4, 5], payment: 'gold' });
    buy('before-catchmind');
    expect(() => buy('after-catchmind')).toThrow('골드가 부족해요.');
    engine.setGameGoldBonus(CATCHMIND_RULES.gold);
    engine.setGameGoldBonus(CATCHMIND_RULES.gold);
    expect(buy('after-catchmind').gold).toBe(0);
    engine.setGameGoldBonus(CATCHMIND_RULES.gold);
    expect(engine.read().gold).toBe(0);
    expect(engine.ledger.map(row => row.amount)).toEqual([-LOTTO_RULES.price, -LOTTO_RULES.price]);
  });
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
