import { expect, test, type Page, type Route } from '@playwright/test';
import type { BootstrapResponse } from '../../shared/types';
import type { StockDetailView, StockTradeInput, StockTradeResponse } from '../../shared/stock-types';

// The isolated Worker fixture is frozen at Friday 2026-10-30 09:00 KST: the market just opened.
const TEST_NOW = '2026-10-30T00:00:00Z';
const ORDER_KEY = (userId: string) => `yegoom3:stock:order:${userId}`;
test.use({ serviceWorkers: 'block' });

async function login(page: Page, username: string) {
  await page.setExtraHTTPHeaders({ 'CF-Connecting-IP': '192.0.2.41' });
  await page.clock.setFixedTime(new Date(TEST_NOW));
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/');
  await page.getByLabel('아이디', { exact: true }).fill(username);
  await page.getByLabel('비밀번호', { exact: true }).fill('e2e-only-password-2026');
  await page.getByRole('button', { name: '예굼방 들어가기' }).click();
  await expect(page.locator('.room-name').filter({ hasText: `${username}님` })).toBeVisible();
}
async function logout(page: Page) {
  await page.evaluate(() => { location.hash = '/profile'; });
  await page.getByRole('button', { name: '로그아웃', exact: true }).click();
  await expect(page.getByRole('button', { name: '예굼방 들어가기' })).toBeVisible();
}
const open = (page: Page, path: string) => page.evaluate(value => { location.hash = value; }, path);
/** What the server holds for the signed-in player: the stock's trades and the gold ledger. */
async function serverState(page: Page, ticker: string, reason: string) {
  const detail = await (await page.request.get(`/api/stock/${ticker}`)).json() as StockDetailView;
  const bootstrap = await (await page.request.get('/api/bootstrap')).json() as BootstrapResponse;
  return { trades: detail.trades.length, held: detail.stock.held, debits: bootstrap.ledger.filter(entry => entry.reason === reason).length, gold: bootstrap.user.gold };
}
/** Lets every order reach the Worker (it fills there) but, while `lose` is on,
 * cuts the connection before the answer gets back to the browser. */
async function interceptTrades(page: Page) {
  const state = { lose: true, sent: [] as StockTradeInput[], answers: [] as StockTradeResponse[] };
  await page.route('**/api/stock/trade', async (route: Route) => {
    state.sent.push(route.request().postDataJSON() as StockTradeInput);
    if (!state.lose) return route.continue();
    const response = await route.fetch();
    if (response.ok()) state.answers.push(await response.json() as StockTradeResponse);
    await route.abort('connectionreset');
  });
  return state;
}
const notice = (page: Page) => page.getByRole('status', { name: '결과를 확인 중인 주문' });
async function orderOne(page: Page) {
  await page.getByRole('button', { name: '1주 사기' }).click();
  await page.getByRole('dialog', { name: '거래 확인' }).getByRole('button', { name: '확인' }).click();
}

test('an order whose answer was lost fills once: the screen asks again with the same order', async ({ page }) => {
  test.setTimeout(60_000);
  await login(page, 'yeseo');
  const before = await serverState(page, 'MDRG', '주식 매수 · 민두래곤 1주');
  const trades = await interceptTrades(page);
  await open(page, '/stock/MDRG');
  await orderOne(page);

  // The Worker filled the order; the browser never heard back.
  await expect(notice(page)).toContainText('주문 결과를 아직 확인하지 못했어요');
  await expect(notice(page)).toContainText('민두래곤 1주 사기');
  expect(trades.answers[0]).toMatchObject({ replayed: false, trade: { ticker: 'MDRG', quantity: 1 } });
  // No second order can be sent while this one is unsettled.
  await expect(page.getByRole('button', { name: '이전 주문 결과를 먼저 확인해 주세요' })).toBeDisabled();
  const saved = await page.evaluate(key => JSON.parse(localStorage.getItem(key)!) as { input: StockTradeInput }, ORDER_KEY('e2e-yeseo'));
  expect(saved.input).toEqual(trades.sent[0]);
  expect(saved.input).toMatchObject({ ticker: 'MDRG', side: 'buy', quantity: 1, expectedUserId: 'e2e-yeseo' });

  // The retry from the screen carries the same id and input, and shows the one trade.
  trades.lose = false;
  await notice(page).getByRole('button', { name: '주문 결과 다시 확인' }).click();
  await expect(page.locator('.fx-toast').filter({ hasText: '민두래곤 1주를' })).toBeVisible();
  await expect(notice(page)).toHaveCount(0);
  await expect(page.locator('.holding')).toContainText(`${before.held + 1}주`);
  await expect(page.getByRole('button', { name: '1주 사기' })).toBeEnabled();
  expect(trades.sent.length).toBeGreaterThanOrEqual(2);
  for (const sent of trades.sent) expect(sent).toEqual(trades.sent[0]);
  expect(await page.evaluate(key => localStorage.getItem(key), ORDER_KEY('e2e-yeseo'))).toBeNull();

  // One trade and one debit on the server, however many times the order was sent.
  const after = await serverState(page, 'MDRG', '주식 매수 · 민두래곤 1주');
  expect(after).toMatchObject({ trades: before.trades + 1, held: before.held + 1, debits: before.debits + 1 });
  expect(before.gold - after.gold).toBe(trades.answers[0]!.trade.total);
});

test('the unsettled order survives a reload and another screen, and is settled from the market list', async ({ page }) => {
  test.setTimeout(60_000);
  await login(page, 'yeseo');
  const before = await serverState(page, 'SOAR', '주식 매수 · 소니항공 1주');
  const trades = await interceptTrades(page);
  await open(page, '/stock/SOAR');
  await orderOne(page);
  await expect(notice(page)).toContainText('소니항공 1주 사기');
  const first = trades.sent[0]!;

  // Reload on another stock's page: the order is still there, and still blocks a new one.
  await page.goto('/#/stock/YKHX');
  await page.reload();
  await expect(notice(page)).toContainText('소니항공 1주 사기');
  await expect(page.getByRole('button', { name: '이전 주문 결과를 먼저 확인해 주세요' })).toBeDisabled();

  // The market list offers the same re-check and shows the holding once it settles.
  await open(page, '/stock');
  await expect(notice(page)).toContainText('소니항공 1주 사기');
  trades.lose = false;
  await notice(page).getByRole('button', { name: '주문 결과 다시 확인' }).click();
  await expect(page.locator('.fx-toast').filter({ hasText: '소니항공 1주를' })).toBeVisible();
  await expect(notice(page)).toHaveCount(0);
  await page.getByRole('tab', { name: /내 주식/ }).click();
  await expect(page.getByRole('region', { name: '내 주식' })).toContainText('소니항공');
  for (const sent of trades.sent) expect(sent).toEqual(first);
  expect(await serverState(page, 'SOAR', '주식 매수 · 소니항공 1주')).toMatchObject({ trades: before.trades + 1, held: before.held + 1, debits: before.debits + 1 });
});

test('another account on the same browser neither sees nor sends the order; its owner settles it later', async ({ page }) => {
  test.setTimeout(90_000);
  await login(page, 'yeseo');
  const before = await serverState(page, 'EEVA', '주식 매수 · 에바참치 1주');
  const trades = await interceptTrades(page);
  await open(page, '/stock/EEVA');
  await orderOne(page);
  await expect(notice(page)).toContainText('에바참치 1주 사기');
  const first = trades.sent[0]!;
  await logout(page);

  // siwon signs in on this browser: nothing of yeseo's order is shown or sent.
  await login(page, 'siwon');
  const sentBefore = trades.sent.length;
  const siwonBefore = await serverState(page, 'EEVA', '주식 매수 · 에바참치 1주');
  await open(page, '/stock/EEVA');
  await expect(page.getByRole('button', { name: '1주 사기' })).toBeEnabled();
  await expect(notice(page)).toHaveCount(0);
  await open(page, '/stock');
  await expect(page.getByRole('region', { name: '종목' })).toBeVisible();
  await expect(notice(page)).toHaveCount(0);
  expect(trades.sent.length).toBe(sentBefore);
  expect(await serverState(page, 'EEVA', '주식 매수 · 에바참치 1주')).toEqual(siwonBefore);
  // The order is still saved under its owner, not under siwon.
  expect(await page.evaluate(key => localStorage.getItem(key), ORDER_KEY('e2e-siwon'))).toBeNull();
  expect(await page.evaluate(key => JSON.parse(localStorage.getItem(key)!).input.requestId as string, ORDER_KEY('e2e-yeseo'))).toBe(first.requestId);
  await logout(page);

  // Back as yeseo: the order is found again and settles with its one trade.
  trades.lose = false;
  await login(page, 'yeseo');
  await open(page, '/stock/EEVA');
  await expect(page.locator('.fx-toast').filter({ hasText: '에바참치 1주를' })).toBeVisible();
  await expect(notice(page)).toHaveCount(0);
  await expect(page.locator('.holding')).toContainText(`${before.held + 1}주`);
  for (const sent of trades.sent) expect(sent).toEqual(first);
  expect(await serverState(page, 'EEVA', '주식 매수 · 에바참치 1주')).toMatchObject({ trades: before.trades + 1, held: before.held + 1, debits: before.debits + 1 });
});

test('a refusal the server confirms clears the order, and the next order is a new one', async ({ page }) => {
  test.setTimeout(60_000);
  await login(page, 'yeseo');
  const before = await serverState(page, 'RIAN', '주식 매수 · 리안뷰티 1주');
  const sent: StockTradeInput[] = [];
  let stale = true;
  // The first order arrives with an outdated price version: the Worker refuses it.
  await page.route('**/api/stock/trade', async route => {
    const body = route.request().postDataJSON() as StockTradeInput;
    sent.push(body);
    await route.continue(stale ? { postData: JSON.stringify({ ...body, expectedVersion: body.expectedVersion + 1 }) } : {});
  });
  await open(page, '/stock/RIAN');
  await orderOne(page);
  await expect(page.locator('.fx-toast').filter({ hasText: '가격이' })).toBeVisible();
  await expect(notice(page)).toHaveCount(0);
  expect(await page.evaluate(key => localStorage.getItem(key), ORDER_KEY('e2e-yeseo'))).toBeNull();
  expect(await serverState(page, 'RIAN', '주식 매수 · 리안뷰티 1주')).toMatchObject({ trades: before.trades, held: before.held, debits: before.debits });

  // Nothing is pending, so a new order goes out under a new id and fills once.
  stale = false;
  await expect(page.getByRole('button', { name: '1주 사기' })).toBeEnabled();
  await orderOne(page);
  await expect(page.locator('.fx-toast').filter({ hasText: '리안뷰티 1주를' })).toBeVisible();
  expect(sent).toHaveLength(2);
  expect(sent[1]!.requestId).not.toBe(sent[0]!.requestId);
  expect(await serverState(page, 'RIAN', '주식 매수 · 리안뷰티 1주')).toMatchObject({ trades: before.trades + 1, held: before.held + 1, debits: before.debits + 1 });
});
