import { mkdir } from 'node:fs/promises';
import { expect, test, type Page } from '@playwright/test';
import { DAILY_FREE } from '../../shared/balance';
import type { BootstrapResponse } from '../../shared/types';

// 2026-11-07: today's free uses and owned tickets are one 이용권 count, and a
// ticket can be used again on the same screen without leaving it.
const ORIGIN = 'http://localhost:8788';
const IP = '192.0.2.73';
test.use({ serviceWorkers: 'block' });
test.beforeEach(async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.setExtraHTTPHeaders({ 'CF-Connecting-IP': IP });
});

async function signIn(page: Page, username: string): Promise<BootstrapResponse> {
  const login = await page.request.post('/api/auth/login', { headers: { Origin: ORIGIN, 'CF-Connecting-IP': IP }, data: { username, password: 'e2e-only-password-2026' } });
  expect(login.status()).toBe(200);
  return (await page.request.get('/api/bootstrap')).json();
}
async function confirmPurchase(page: Page) {
  const dialog = page.getByRole('dialog', { name: '구매 확인', exact: true });
  await dialog.getByRole('button', { name: /^(구매하기|뽑기)$/ }).click();
  await expect(dialog).toHaveCount(0);
}
async function pick(page: Page, numbers: number[]) {
  for (const number of numbers) await page.getByRole('button', { name: `번호 ${number}`, exact: true }).click();
  await expect(page.locator('.balls button[aria-pressed="true"]')).toHaveCount(5);
}

test('lotto 이용권 can be used again and again on the same screen, today\'s first', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 900 });
  const before = await signIn(page, 'siwon');
  const held = before.inventory.lottoTickets + before.dailyFree.lotto;
  expect(before.dailyFree.lotto).toBe(DAILY_FREE.lotto);
  await page.goto('/#/shop');
  await expect(page.locator('.inventory-card p').filter({ hasText: '데일리 로또 이용권' }).locator('strong')).toHaveText(`${held}장`);
  await page.goto('/#/shop/lotto');
  // One payment button, pinned to the bottom of the screen: 이용권 while any is held.
  const actions = page.locator('body > .shop-buy-bar .shop-purchase-actions');
  const goldButton = page.getByRole('button', { name: '골드로 사기 · 500G', exact: true });
  await expect(actions.getByRole('button')).toHaveCount(1);
  await expect(actions.getByRole('button')).toHaveAccessibleName(`이용권으로 사기 · 1장 · 보유 ${held}장`);
  await expect(goldButton).toHaveCount(0);
  await mkdir('docs/screenshots', { recursive: true });
  for (let used = 0; used < 3; used++) {
    await pick(page, [1 + used, 6, 7, 8, 9]);
    // Without leaving the screen, the button stays usable after every purchase.
    const button = page.getByRole('button', { name: `이용권으로 사기 · 1장 · 보유 ${held - used}장`, exact: true });
    await expect(button).toBeEnabled();
    await button.click();
    await confirmPurchase(page);
    await expect(page.getByRole('button', { name: `이용권으로 사기 · 1장 · 보유 ${held - used - 1}장`, exact: true })).toBeVisible();
    if (used === 0) await page.screenshot({ path: 'docs/screenshots/shop-merged-tickets-lotto-390.png', fullPage: true });
  }
  const after = (await (await page.request.get('/api/bootstrap')).json()) as BootstrapResponse;
  // Today's three went first; owned tickets and gold are untouched.
  expect(after.dailyFree.lotto).toBe(0);
  expect(after.inventory.lottoTickets).toBe(before.inventory.lottoTickets);
  expect(after.user.gold).toBe(before.user.gold);
  // The owned tickets go next, still without gold; the gold button only takes
  // the 이용권 button's place once none is left.
  for (let left = held - 3; left > 0; left--) {
    await expect(goldButton).toHaveCount(0);
    await pick(page, [10 + left, 6, 7, 8, 9]);
    await page.getByRole('button', { name: `이용권으로 사기 · 1장 · 보유 ${left}장`, exact: true }).click();
    await confirmPurchase(page);
    await expect(page.locator('.balls button[aria-pressed="true"]')).toHaveCount(0);
  }
  await expect(page.getByRole('button', { name: /^이용권으로 사기/ })).toHaveCount(0);
  await expect(actions.getByRole('button')).toHaveCount(1);
  await pick(page, [1, 2, 3, 4, 5]);
  await expect(goldButton).toBeEnabled();
  const spent = (await (await page.request.get('/api/bootstrap')).json()) as BootstrapResponse;
  expect(spent.inventory.lottoTickets).toBe(0);
  expect(spent.dailyFree.lotto).toBe(0);
  expect(spent.user.gold).toBe(before.user.gold);
  await goldButton.click();
  await confirmPurchase(page);
  await expect(goldButton).toBeVisible();
  const paid = (await (await page.request.get('/api/bootstrap')).json()) as BootstrapResponse;
  expect(paid.user.gold).toBe(before.user.gold - 500);
  expect(paid.inventory.lottoTickets).toBe(0);
});
