import { describe, expect, it } from 'vitest';
import { STOCKS, STOCK_RULES, tradeFee } from '../shared/stocks';
import { addTradingDays, holidayName, isTradingDay, kstTimestamp, marketStatus, tickTimes, tradesOn, TICKS_PER_DAY } from '../shared/market-calendar';
import { clampToLimit, stepPrice } from '../shared/stock-engine';
import { advanceMarket, advanceStart, initialRows, nextTickAt, pendingTicks, scheduledNews, type StockRow } from '../shared/stock-market';
import { newsArticle, NEWS_TEMPLATES, subjectParticle } from '../shared/stock-news-templates';
import { stockCronDue } from '../worker/stocks';

const none = new Map<string, string>();
const seedOf = (date: string) => `test|${date}`;
const at = (date: string, time: string) => kstTimestamp(date, time);

describe('market calendar', () => {
  it('opens 09:00–18:00 KST on weekdays, closed on weekends, holidays and admin holidays', () => {
    expect(tickTimes()).toHaveLength(55);
    expect(TICKS_PER_DAY).toBe(55);
    expect(marketStatus(at('2026-11-05', '09:00')).open).toBe(true);
    expect(marketStatus(at('2026-11-05', '08:59')).open).toBe(false);
    expect(marketStatus(at('2026-11-05', '18:00')).open).toBe(false);
    expect(marketStatus(at('2026-11-07', '12:00')).open).toBe(false); // Saturday
    expect(marketStatus(at('2026-12-25', '12:00'))).toMatchObject({ open: false, holiday: '성탄절' });
    expect(isTradingDay('2027-02-08')).toBe(false); // 설날 연휴
    expect(holidayName('2027-09-15')).toBe('추석');
    const extra = new Map([['2026-11-06', '임시 휴장']]);
    expect(marketStatus(at('2026-11-06', '12:00'), extra)).toMatchObject({ open: false, holiday: '임시 휴장' });
    expect(addTradingDays('2026-11-05', 2, extra)).toBe('2026-11-10');
  });
  it('runs the stock Cron only on weekdays from the open through the close tick', () => {
    expect(stockCronDue(at('2026-11-05', '08:50'))).toBe(false);
    expect(stockCronDue(at('2026-11-05', '09:00'))).toBe(true);
    expect(stockCronDue(at('2026-11-05', '18:00'))).toBe(true);
    expect(stockCronDue(at('2026-11-05', '18:10'))).toBe(false);
    expect(stockCronDue(at('2026-11-07', '12:00'))).toBe(false);
  });
  it('trades YEGM only on Wednesdays in December–February', () => {
    expect(tradesOn('YEGM', '2026-12-02')).toBe(true); // Wednesday
    expect(tradesOn('YEGM', '2026-12-03')).toBe(false);
    expect(tradesOn('YEGM', '2027-03-04')).toBe(true);
    expect(tradesOn('YKHX', '2026-12-03')).toBe(true);
  });
});

describe('price engine', () => {
  it('keeps every move within ±15% of the previous close, as whole gold of at least 1', () => {
    expect(clampToLimit(2000, 1000)).toBe(1150);
    expect(clampToLimit(10, 1000)).toBe(850);
    expect(clampToLimit(0, 1)).toBe(1);
    for (const z of [-50, -3, 0, 3, 50]) {
      const price = stepPrice(1000, 1000, 1000, 'wild', z, z > 0 ? 0.5 : -0.5);
      expect(price).toBeGreaterThanOrEqual(850);
      expect(price).toBeLessThanOrEqual(1150);
      expect(Number.isInteger(price)).toBe(true);
    }
  });
  it('charges a 1% fee, rounded up, at least 1G', () => {
    expect(tradeFee(1500)).toBe(15);
    expect(tradeFee(1501)).toBe(16);
    expect(tradeFee(50)).toBe(1);
  });
  it('is deterministic and a catch-up in pieces equals one pass', () => {
    const start = at('2026-11-04', '18:00');
    const until = at('2026-11-06', '18:00');
    const ticks = pendingTicks(start, until, none, 1000);
    expect(ticks).toHaveLength(110);
    const once = advanceMarket(initialRows(start), ticks, seedOf, [], none);
    let rows: StockRow[] = initialRows(start);
    const pieces: number[] = [];
    for (let from = start; ;) {
      const part = pendingTicks(from, until, none, 7);
      if (!part.length) break;
      const result = advanceMarket(rows, part, seedOf, [], none);
      rows = result.rows; pieces.push(...result.ticks.map(tick => tick.price));
      from = part[part.length - 1]!.at;
    }
    expect(rows).toEqual(once.rows);
    expect(pieces).toEqual(once.ticks.map(tick => tick.price));
    expect(advanceMarket(initialRows(start), ticks, seedOf, [], none)).toEqual(once);
    expect(advanceMarket(initialRows(start), ticks, date => `other|${date}`, [], none).rows).not.toEqual(once.rows);
  });
  it('opens at the previous close, applies overnight events at 09:00 and writes a candle at 18:00', () => {
    const start = at('2026-11-04', '18:00');
    const events = [{ id: 'game:1', ticker: 'MINJ' as const, effectBp: 400, applyAt: at('2026-11-04', '20:00') }];
    const result = advanceMarket(initialRows(start), pendingTicks(start, at('2026-11-05', '09:00'), none), seedOf, events, none);
    const minj = result.rows.find(row => row.ticker === 'MINJ')!;
    expect(minj).toMatchObject({ prevClose: 1500, price: 1560, dayOpen: 1560 });
    expect(result.appliedEvents).toEqual([{ id: 'game:1', at: at('2026-11-05', '09:00') }]);
    const day = advanceMarket(result.rows, pendingTicks(at('2026-11-05', '09:00'), at('2026-11-05', '18:00'), none), seedOf, [], none);
    expect(day.daily).toHaveLength(10);
    const candle = day.daily.find(item => item.ticker === 'MINJ')!;
    expect(candle.open).toBe(1560);
    expect(candle.close).toBe(day.rows.find(row => row.ticker === 'MINJ')!.price);
  });
  it('does not move on weekends, holidays or YEGM winter days, and publishes news with the move', () => {
    const friday = at('2026-12-04', '18:00');
    expect(pendingTicks(friday, at('2026-12-06', '23:00'), none)).toHaveLength(0);
    const thursday = advanceMarket(initialRows(at('2026-12-02', '18:00')), pendingTicks(at('2026-12-02', '18:00'), at('2026-12-03', '18:00'), none), seedOf, [], none);
    expect(thursday.ticks.some(tick => tick.ticker === 'YEGM')).toBe(false);
    expect(thursday.rows.find(row => row.ticker === 'YEGM')!.price).toBe(500);
    for (const item of thursday.news) {
      expect(item.ticker).not.toBe('YEGM');
      expect(thursday.ticks.some(tick => tick.ticker === item.ticker && tick.at === item.publishAt)).toBe(true);
    }
    expect(nextTickAt(at('2026-12-04', '18:01'), none)).toBe(at('2026-12-07', '09:00'));
  });
  it('restarts at today after a long gap instead of replaying days nobody saw', () => {
    expect(advanceStart(at('2026-10-01', '18:00'), at('2026-11-05', '10:00'))).toBe(at('2026-11-05', '00:00'));
    expect(advanceStart(at('2026-11-04', '18:00'), at('2026-11-05', '10:00'))).toBe(at('2026-11-04', '18:00'));
  });
});

describe('delisting', () => {
  const base = (price: number, status: StockRow['status'] = 'listed'): StockRow[] => initialRows(at('2026-11-05', '17:50'))
    .map(row => row.ticker === 'EEVA' ? { ...row, price, prevClose: price, dayOpen: price, dayHigh: price, dayLow: price, status, warningSince: status === 'warning' ? '2026-11-04' : null } : row);
  const close = (rows: StockRow[]) => advanceMarket(rows, pendingTicks(at('2026-11-05', '17:50'), at('2026-11-05', '18:00'), none), seedOf, [], none);
  it('warns on the first close below 80% of listing, delists on the next, then relists after 10 trading days', () => {
    const warned = close(base(300));
    expect(warned.rows.find(row => row.ticker === 'EEVA')).toMatchObject({ status: 'warning', warningSince: '2026-11-05' });
    expect(warned.news.map(item => item.headline)).toContain('[공시] 에바참치, 관리종목 지정');
    const delisted = close(base(300, 'warning'));
    const eeva = delisted.rows.find(row => row.ticker === 'EEVA')!;
    expect(eeva).toMatchObject({ status: 'delisted', delistedOn: '2026-11-05', relistOn: '2026-11-19' });
    expect(delisted.delisted).toEqual([{ ticker: 'EEVA', date: '2026-11-05' }]);
    // Delisted: no ticks until the relisting day's open, then the listing price.
    const quiet = advanceMarket(delisted.rows, pendingTicks(at('2026-11-05', '18:00'), at('2026-11-18', '18:00'), none, 1000), seedOf, [], none);
    expect(quiet.ticks.some(tick => tick.ticker === 'EEVA')).toBe(false);
    const relisted = advanceMarket(quiet.rows, pendingTicks(at('2026-11-18', '18:00'), at('2026-11-19', '09:00'), none), seedOf, [], none);
    expect(relisted.rows.find(row => row.ticker === 'EEVA')).toMatchObject({ status: 'listed', price: 500, prevClose: 500, relistOn: null });
    expect(relisted.news.map(item => item.headline)).toContain('[공시] 에바참치, 재상장');
  });
  it('releases the warning when the close recovers', () => {
    const recovered = close(base(450, 'warning'));
    expect(recovered.rows.find(row => row.ticker === 'EEVA')).toMatchObject({ status: 'listed', warningSince: null });
  });
  it('lands near 0–2 delistings a month across ten stocks (1,000 simulated months)', () => {
    const counts: number[] = [];
    let warnings = 0;
    for (let run = 0; run < 1000; run++) {
      let rows = initialRows(at('2026-11-01', '18:00'));
      let delisted = 0;
      let from = at('2026-11-01', '18:00');
      // 20 trading days.
      const until = at('2026-11-27', '18:00');
      while (true) {
        const ticks = pendingTicks(from, until, none, 1000);
        if (!ticks.length) break;
        const result = advanceMarket(rows, ticks, date => `sim${run}|${date}`, [], none);
        rows = result.rows; delisted += result.delisted.length;
        warnings += result.news.filter(item => item.id.startsWith('disclosure:warning')).length;
        from = ticks[ticks.length - 1]!.at;
      }
      counts.push(delisted);
    }
    const histogram = [0, 1, 2, 3].map(n => counts.filter(count => (n === 3 ? count >= 3 : count === n)).length);
    const mean = counts.reduce((sum, count) => sum + count, 0) / counts.length;
    console.log(`Stock simulation (1,000 months × 10 stocks): delistings 0/1/2/3+ = ${histogram.join('/')}, mean ${mean.toFixed(2)}, warnings/month ${(warnings / 1000).toFixed(2)}`);
    expect(mean).toBeGreaterThan(0.05);
    expect(mean).toBeLessThan(1.5);
    expect(histogram[3]! / 1000).toBeLessThan(0.05);
  }, 120_000);
});

describe('template news', () => {
  it('schedules 4–7 items between 09:10 and 17:50 with effects inside the class range', () => {
    for (let day = 1; day <= 30; day++) {
      const items = scheduledNews(`seed${day}`, '2026-11-05');
      expect(items.length).toBeGreaterThanOrEqual(STOCK_RULES.newsPerDay[0]);
      expect(items.length).toBeLessThanOrEqual(STOCK_RULES.newsPerDay[1]);
      for (const item of items) {
        expect(item.index).toBeGreaterThanOrEqual(1);
        expect(item.index).toBeLessThanOrEqual(TICKS_PER_DAY - 2);
        const [low, high] = STOCK_RULES.newsEffect[STOCKS.find(stock => stock.ticker === item.ticker)!.volatility];
        expect(Math.abs(item.effectBp)).toBeGreaterThanOrEqual(Math.floor(low * 10_000));
        expect(Math.abs(item.effectBp)).toBeLessThanOrEqual(Math.ceil(high * 10_000));
      }
    }
  });
  it('has short articles for every stock and direction, never telling anyone to buy or sell', () => {
    for (const stock of STOCKS) {
      for (const direction of ['up', 'down'] as const) {
        const list = NEWS_TEMPLATES[stock.ticker][direction];
        expect(list.length).toBeGreaterThanOrEqual(2);
        for (const [headline, body] of list) {
          expect(headline.length).toBeLessThanOrEqual(40);
          expect(body.length).toBeLessThanOrEqual(200);
          expect(`${headline}${body}`).not.toMatch(/사세요|파세요|매수하|매도하/);
        }
      }
    }
    expect(newsArticle('YEGM', true, 7).headline).toContain('예굼');
    expect(subjectParticle('예굼')).toBe('이');
    expect(subjectParticle('에바참치')).toBe('가');
  });
});
