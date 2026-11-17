import { expect, test, type Page } from '@playwright/test';
import type { StockMarketView } from '../../shared/stock-types';
import { ServerClock, startClockServers, type ClockServers } from './clock-servers';

// Friday 2026-10-30. The market list is read right after the 18:00 close tick,
// before the closing article exists. The 18:00 Cron then stores the article;
// prices do not move again, yet the open list must show it on its next read.
const INSTANTS = ['2026-10-30T09:00:05Z', '2026-10-30T09:00:40Z'] as const; // 18:00:05 and 18:00:40 KST
const AFTER_CRON = 1;
let servers: ClockServers;
test.use({ serviceWorkers: 'block' });
test.beforeAll(async ({}, info) => { info.setTimeout(240_000); servers = await startClockServers('closing-news', 8805, INSTANTS); });
test.afterAll(async () => { await servers?.stop(); });

async function login(page: Page, username: string) {
  await page.setExtraHTTPHeaders({ 'CF-Connecting-IP': '192.0.2.49' });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const clock = await ServerClock.attach(page, servers, INSTANTS, true);
  await page.goto(`${servers.origins[0]}/`);
  await page.getByLabel('아이디', { exact: true }).fill(username);
  await page.getByLabel('비밀번호', { exact: true }).fill('e2e-only-password-2026');
  await page.getByRole('button', { name: '예굼방 들어가기' }).click();
  await expect(page.locator('.room-name').filter({ hasText: `${username}님` })).toBeVisible();
  return clock;
}

test('the closing article stored after the last tick appears on the open market list', async ({ page }) => {
  test.setTimeout(120_000);
  const clock = await login(page, 'min');
  // Catch the day's ticks up to the close (one read replays at most 60 steps).
  let market = await clock.get<StockMarketView>('/api/stock');
  for (let reads = 0; reads < 5 && market.market.open !== false; reads++) market = await clock.get<StockMarketView>('/api/stock');
  market = await clock.get<StockMarketView>('/api/stock');
  expect(market.market.open).toBe(false);
  expect(market.closing).toEqual({ summary: null, comment: null, weekly: null });

  await page.evaluate(() => { location.hash = '/stock'; });
  await expect(page.locator('.closed-copy h2')).toHaveText('장 마감');
  await expect(page.locator('.stock-closing')).toHaveCount(0);
  const reads: string[] = [];
  page.on('request', request => { if (new URL(request.url()).pathname === '/api/stock') reads.push(new URL(request.url()).search); });

  // The 18:00 Cron of the same day runs on the Worker frozen at 18:00:40.
  expect((await fetch(`${servers.origins[AFTER_CRON]}/cdn-cgi/handler/scheduled?cron=*%2F10+*+*+*+*`)).ok).toBe(true);
  const stored = await clock.get<StockMarketView>('/api/stock', AFTER_CRON);
  expect(stored.closing!.summary).toMatchObject({ id: 'close:2026-10-30', kind: 'close' });
  // Prices and the tick are exactly as the page last saw them.
  expect(stored.stocks.map(stock => [stock.ticker, stock.price, stock.version])).toEqual(market.stocks.map(stock => [stock.ticker, stock.price, stock.version]));
  expect(stored.version.split('.').slice(0, 2)).toEqual(market.version.split('.').slice(0, 2));

  // 35 seconds later the list reads again (with the version it has) and shows the article.
  await clock.advanceTo(AFTER_CRON);
  const card = page.locator('.stock-closing').filter({ hasText: '오늘의 시황' });
  await expect(card).toContainText(stored.closing!.summary!.headline);
  expect(reads.length).toBeGreaterThanOrEqual(1);
  expect(reads.every(search => search.startsWith('?since='))).toBe(true);
  // Once the article is there the list stops asking for it.
  const settledReads = reads.length;
  await page.clock.fastForward(40_000);
  expect(reads.length).toBe(settledReads);
});
