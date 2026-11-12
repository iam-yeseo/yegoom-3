import { mkdir } from 'node:fs/promises';
import { expect, test, type Page, type TestInfo } from '@playwright/test';

// The isolated Worker fixture is frozen at Friday 2026-10-30 09:00 KST: the market just opened.
const TEST_NOW = '2026-10-30T00:00:00Z';
test.use({ serviceWorkers: 'block' });

async function login(page: Page, username: string) {
  await page.setExtraHTTPHeaders({ 'CF-Connecting-IP': '192.0.2.31' });
  await page.clock.setFixedTime(new Date(TEST_NOW));
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/');
  await page.getByLabel('아이디', { exact: true }).fill(username);
  await page.getByLabel('비밀번호', { exact: true }).fill('e2e-only-password-2026');
  await page.getByRole('button', { name: '예굼방 들어가기' }).click();
  await expect(page.locator('.room-name').filter({ hasText: `${username}님` })).toBeVisible();
}
async function shot(page: Page, name: string, info: TestInfo) {
  await mkdir('docs/screenshots', { recursive: true });
  for (const width of [390, 560]) {
    await page.setViewportSize({ width, height: 900 });
    const path = `docs/screenshots/stock-pr12-${name}-${width}.png`;
    await page.screenshot({ path, fullPage: true, animations: 'disabled' });
    await info.attach(`${name}-${width}`, { path, contentType: 'image/png' });
  }
  await page.setViewportSize({ width: 390, height: 844 });
}

test('players open the real market, buy at the server price and see it in their gold history', async ({ page }, info) => {
  test.setTimeout(60_000);
  await login(page, 'min');
  await page.evaluate(() => { location.hash = '/games'; });
  const tile = page.getByRole('button').filter({ hasText: '주식 시장' });
  await expect(tile).toContainText('장 열림');
  await tile.click();
  await expect(page).toHaveURL(/#\/stock$/);
  const rows = page.getByRole('region', { name: '종목' }).getByRole('button');
  await expect(rows).toHaveCount(15);
  await expect(page.locator('.market-pill')).toContainText('장 열림');
  await shot(page, 'list', info);

  await rows.filter({ hasText: 'YK하이커스' }).click();
  await expect(page).toHaveURL(/#\/stock\/YKHX$/);
  const price = Number((await page.locator('.detail-head p strong').innerText()).replace(/,/g, ''));
  const tradeResponse = page.waitForResponse(response => response.url().endsWith('/api/stock/trade'));
  await page.getByRole('button', { name: '1주 사기' }).click();
  await page.getByRole('dialog', { name: '거래 확인' }).getByRole('button', { name: '확인' }).click();
  const trade = await (await tradeResponse).json() as { trade: { price: number; fee: number; total: number } };
  expect(trade.trade).toMatchObject({ price, fee: Math.max(1, Math.ceil(price / 100)), total: price + Math.max(1, Math.ceil(price / 100)) });
  await expect(page.locator('.holding')).toContainText('1주');
  await shot(page, 'detail', info);

  await page.evaluate(() => { location.hash = '/profile'; });
  await expect(page.getByText('주식 매수 · YK하이커스 1주')).toBeVisible();
});

test('a game author sees the trading lock on the linked stock, and other stocks stay tradable', async ({ page }) => {
  await login(page, 'siwon');
  await page.evaluate(() => { location.hash = '/stock/SIWN'; });
  await expect(page.getByRole('button', { name: '오늘은 출제자라서 거래할 수 없어요 · 결과 반영 후 거래 가능' })).toBeDisabled();
  await page.evaluate(() => { location.hash = '/stock/MINJ'; });
  await expect(page.getByRole('button', { name: '1주 사기' })).toBeEnabled();
});

test('administrators see the stock news card and cannot trade', async ({ page }) => {
  await login(page, 'admin');
  await page.evaluate(() => { location.hash = '/admin'; });
  const card = page.getByRole('region', { name: '주식 뉴스 운영' });
  await expect(card).toContainText('OpenAI 키 없음 · 템플릿');
  await card.getByRole('button', { name: /주식 뉴스/ }).click();
  await expect(card.getByText('오늘', { exact: true })).toBeVisible();
  // Switch the engine to Claude and back.
  await card.getByRole('tab', { name: 'Claude' }).click();
  await expect(card).toContainText('Claude 키 없음 · 템플릿');
  // The card ignores a tap while the previous change is still finishing (its
  // follow-up refresh), so tap again until the switch back is taken.
  await expect(async () => {
    await card.getByRole('tab', { name: 'OpenAI' }).click();
    await expect(card).toContainText('OpenAI 키 없음 · 템플릿', { timeout: 1500 });
  }).toPass({ timeout: 15000 });
  await page.evaluate(() => { location.hash = '/stock/YEGM'; });
  await expect(page.getByRole('button', { name: '운영자는 거래할 수 없어요' })).toBeDisabled();
});
