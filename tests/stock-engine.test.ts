import { describe, expect, it } from 'vitest';
import { STOCKS, STOCK_RULES, tradeFee } from '../shared/stocks';
import { addTradingDays, holidayName, isTradingDay, kstTimestamp, marketStatus, tickTimes, tradesOn, TICKS_PER_DAY } from '../shared/market-calendar';
import { clampToLimit, stepPrice } from '../shared/stock-engine';
import { advanceMarket, advanceStart, dayItems, initialRows, marketSteps, NEWS_SLOTS, nextTickAt, pendingTicks, type StockRow } from '../shared/stock-market';
import { companyPhase, featureArticle, PHASES, type Phase } from '../shared/stock-lifecycle';
import { gameArticle, gameEffectBp, usualTime } from '../shared/stock-games';
import { applyEffect } from '../shared/stock-engine';
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
    expect(stockCronDue(at('2026-11-05', '08:40'))).toBe(false);
    expect(stockCronDue(at('2026-11-05', '08:50'))).toBe(true); // morning AI news
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
  it('publishes exactly one article every 30 minutes from 09:00 to 17:30, with the usual number of price-moving items', () => {
    expect(NEWS_SLOTS.map(index => tickTimes()[index])).toEqual(['09:00', '09:30', '10:00', '10:30', '11:00', '11:30', '12:00', '12:30', '13:00',
      '13:30', '14:00', '14:30', '15:00', '15:30', '16:00', '16:30', '17:00', '17:30']);
    for (let day = 1; day <= 60; day++) {
      const items = dayItems(`seed${day}`, '2026-11-05', `phase${day}`);
      expect(items.map(item => item.index)).toEqual(NEWS_SLOTS);
      const news = items.filter(item => item.kind === 'news');
      expect(news.length).toBeGreaterThanOrEqual(STOCK_RULES.newsPerDay[0]);
      expect(news.length).toBeLessThanOrEqual(STOCK_RULES.newsPerDay[1]);
      for (const item of items.filter(item => item.kind === 'feature')) expect(item.effectBp).toBe(0);
      for (const item of news) {
        const [low, high] = STOCK_RULES.newsEffect[STOCKS.find(stock => stock.ticker === item.ticker)!.volatility];
        expect(Math.abs(item.effectBp)).toBeGreaterThanOrEqual(Math.floor(low * 0.7 * 10_000));
        expect(Math.abs(item.effectBp)).toBeLessThanOrEqual(Math.ceil(high * 1.25 * 10_000));
      }
      // A rumor's confirmation or denial comes 2–4 hours later.
      for (const outcome of items.filter(item => item.relatedId)) {
        const rumor = items.find(item => item.id === outcome.relatedId)!;
        expect(outcome.index - rumor.index).toBeGreaterThanOrEqual(12);
        expect(outcome.index - rumor.index).toBeLessThanOrEqual(24);
      }
      expect(items.every(item => item.headline.length <= 40 && item.body.length <= 200)).toBe(true);
    }
    // YEGM is never in the news on a winter Thursday.
    expect(dayItems('x', '2026-12-03').some(item => item.ticker === 'YEGM')).toBe(false);
  });
  it('moves each company through hidden 5–15 day phases that shape its news', () => {
    for (const stock of STOCKS) {
      let previous: Phase | null = null, run = 0;
      const lengths: number[] = [];
      for (let d = 0; d < 365; d++) {
        const date = new Date(Date.parse('2026-01-01T00:00:00Z') + d * 86_400_000).toISOString().slice(0, 10);
        const phase = companyPhase('secret', stock.ticker, date);
        expect(companyPhase('secret', stock.ticker, date)).toBe(phase);
        if (phase === previous) run++;
        else { if (previous) lengths.push(run); previous = phase; run = 1; }
      }
      expect(lengths.length).toBeGreaterThan(15);
    }
    // Crisis news leans bad and growth news leans good across many days.
    const tally: Record<string, [number, number]> = {};
    for (let day = 0; day < 400; day++) {
      const date = new Date(Date.parse('2027-03-01T00:00:00Z') + day * 86_400_000).toISOString().slice(0, 10);
      for (const item of dayItems(`d${day}`, date, 'phases').filter(item => item.kind === 'news')) {
        const entry = tally[item.phase] ??= [0, 0];
        entry[item.effectBp > 0 ? 0 : 1]++;
      }
    }
    const upShare = (phase: Phase) => tally[phase]![0] / (tally[phase]![0] + tally[phase]![1]);
    expect(upShare('crisis')).toBeLessThan(upShare('growth'));
    for (const phase of Object.keys(PHASES) as Phase[]) {
      for (let variant = 0; variant < 3; variant++) {
        const article = featureArticle('YEDO', phase, variant);
        expect(article.headline.length).toBeLessThanOrEqual(40);
        expect(article.body).not.toContain('이(가)');
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

describe('game linkage (PR 11)', () => {
  it('compares a result with the usual time: 30 minutes earlier is +4%, capped at ±8%; luck maps 0–100 to ∓8%', () => {
    expect(usualTime(['08:10:00', '07:50:00'], 'wake')).toBe('08:00:00'); // fewer than 3 → default
    expect(usualTime(['07:00:00', '07:30:00', '09:00:00', '07:20:00'], 'wake')).toBe('07:25:00');
    expect(usualTime(['18:00:00', '19:00:00', '18:30:00'], 'offwork')).toBe('18:30:00');
    expect(gameEffectBp('wake', '07:30:00', '08:00:00')).toBe(400);
    expect(gameEffectBp('wake', '08:15:00', '08:00:00')).toBe(-200);
    expect(gameEffectBp('offwork', '15:00:00', '18:00:00')).toBe(800);
    expect(gameEffectBp('offwork', '23:00:00', '18:00:00')).toBe(-800);
    expect(gameEffectBp('luck', '100')).toBe(800);
    expect(gameEffectBp('luck', '50')).toBe(0);
    expect(gameEffectBp('luck', '0')).toBe(-800);
    const article = gameArticle('wake', '07:42:10', '민', '08:20:00', 507);
    expect(article.headline).toBe('[속보] 민님 07시 42분 기상, MJ일렉트로닉스 들썩');
    expect(article.body).toContain('평소(08시 20분)보다 38분 일찍');
  });
  it('moves a stock the instant an event is published in market hours, and at the next open otherwise', () => {
    const start = at('2026-11-05', '10:00');
    const rows = advanceMarket(initialRows(at('2026-11-04', '18:00')), pendingTicks(at('2026-11-04', '18:00'), start, none), seedOf, [], none).rows;
    const event = { id: 'game:wake:2026-11-05', ticker: 'MINJ' as const, effectBp: 400, applyAt: at('2026-11-05', '10:04') + 17_000, kind: 'game', headline: '기상', body: '본문' };
    const steps = marketSteps(start, at('2026-11-05', '10:05'), none, [event]);
    expect(steps).toEqual([{ at: event.applyAt, date: '2026-11-05', index: -1, ticker: 'MINJ' }]);
    const before = rows.find(row => row.ticker === 'MINJ')!;
    const moved = advanceMarket(rows, steps, seedOf, [event], none);
    const after = moved.rows.find(row => row.ticker === 'MINJ')!;
    expect(after.price).toBe(applyEffect(before.price, before.prevClose, 0.04));
    expect(after.version).toBe(before.version + 1);
    expect(moved.rows.find(row => row.ticker === 'YKHX')!.version).toBe(rows.find(row => row.ticker === 'YKHX')!.version);
    expect(moved.news).toEqual([{ id: `event:${event.id}`, ticker: 'MINJ', kind: 'game', publishAt: event.applyAt, headline: '기상', body: '본문', effectBp: 400 }]);
    expect(moved.appliedEvents).toEqual([{ id: event.id, at: event.applyAt }]);
    // Published after the close: no step; the next open applies it.
    const evening = { ...event, applyAt: at('2026-11-05', '18:30') };
    expect(marketSteps(at('2026-11-05', '18:00'), at('2026-11-05', '23:00'), none, [evening])).toEqual([]);
    const open = advanceMarket(rows, pendingTicks(at('2026-11-05', '18:00'), at('2026-11-06', '09:00'), none), seedOf, [evening], none);
    expect(open.appliedEvents).toEqual([{ id: event.id, at: at('2026-11-06', '09:00') }]);
  });
  it('hunts mosquitoes 0–2 times on YEGM trading days, succeeding about 55% of the time', () => {
    let hunts = 0, wins = 0;
    for (let day = 0; day < 2000; day++) {
      const items = dayItems(`m${day}`, '2026-11-05').filter(item => item.kind === 'mosquito');
      expect(items.length).toBeLessThanOrEqual(2);
      for (const item of items) {
        hunts++; if (item.effectBp > 0) wins++;
        expect(Math.abs(item.effectBp)).toBeGreaterThanOrEqual(500);
        expect(Math.abs(item.effectBp)).toBeLessThanOrEqual(1200);
      }
    }
    expect(wins / hunts).toBeGreaterThan(0.5);
    expect(wins / hunts).toBeLessThan(0.6);
    expect(dayItems('x', '2026-12-03').filter(item => item.kind === 'mosquito')).toEqual([]); // winter Thursday: YEGM is halted
  });
});
