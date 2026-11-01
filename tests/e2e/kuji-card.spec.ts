import { expect, test, type Page } from '@playwright/test';
import type { BootstrapResponse, KujiResponse } from '../../shared/types';

const NOW = '2026-10-30T00:00:00Z';
const card = (page: Page) => page.locator('.game-row').filter({ hasText: '예굼쿠지' });
const tab = (page: Page, name: string) => page.getByRole('navigation', { name: '주요 메뉴' }).getByRole('button', { name, exact: true });

test.beforeEach(async ({ page }) => {
  await page.setExtraHTTPHeaders({ 'CF-Connecting-IP': '192.0.2.16' });
  await page.clock.setFixedTime(new Date(NOW));
  await page.emulateMedia({ reducedMotion: 'reduce' });
});

async function login(page: Page) {
  await page.goto('/');
  await page.getByLabel('아이디', { exact: true }).fill('min');
  await page.getByLabel('비밀번호', { exact: true }).fill('e2e-only-password-2026');
  await page.getByRole('button', { name: '예굼방 들어가기' }).click();
  await expect(card(page)).toBeVisible();
}

for (const failRefresh of [false, true]) {
  test(`buying one kuji updates home and games cards${failRefresh ? ' even when follow-up bootstrap fails' : ''}`, async ({ page }) => {
    await login(page);
    const beforeResponse = await page.request.get('/api/bootstrap');
    expect(beforeResponse.ok()).toBe(true);
    const before = await beforeResponse.json() as BootstrapResponse;
    const remaining = before.kuji.remaining;
    expect(remaining).toBeGreaterThan(1);
    await expect(card(page).locator('small')).toHaveText(`남은 쿠지 ${remaining} / 100`);
    await tab(page, '게임').click();
    await expect(card(page).locator('small')).toHaveText(`남은 쿠지 ${remaining} / 100`);

    const loaded = page.waitForResponse(response => response.url().endsWith('/api/shop/kuji') && response.request().method() === 'GET');
    await card(page).click();
    const board = await (await loaded).json() as KujiResponse;
    const position = board.kuji.cells.find(cell => cell.grade === null)!.position;
    await page.getByRole('button', { name: `${position + 1}번 쿠지`, exact: true }).click();
    if (failRefresh) await page.route('**/api/bootstrap', route => route.fulfill({
      status: 503, contentType: 'application/json', body: JSON.stringify({ error: { code: 'TEST_UNAVAILABLE', message: '새로고침을 잠시 사용할 수 없어요.' } }),
    }));
    const purchased = page.waitForResponse(response => response.url().endsWith('/api/shop/kuji') && response.request().method() === 'POST');
    await page.getByRole('button', { name: /^1장 뽑기 ·/ }).click();
    const response = await purchased;
    expect(response.ok()).toBe(true);
    const receipt = await response.json() as KujiResponse;
    expect(receipt.purchase?.cells).toHaveLength(1);
    expect(receipt.kuji.remaining).toBe(remaining - 1);
    await page.getByRole('dialog', { name: '뽑은 쿠지', exact: true }).getByRole('button', { name: '닫기', exact: true }).click();
    await page.getByRole('button', { name: '뒤로 가기', exact: true }).click();
    await expect(card(page).locator('small')).toHaveText(`남은 쿠지 ${remaining - 1} / 100`);
    await tab(page, '게임').click();
    await expect(card(page).locator('small')).toHaveText(`남은 쿠지 ${remaining - 1} / 100`);
    if (failRefresh) await page.unroute('**/api/bootstrap');
    const after = await (await page.request.get('/api/bootstrap')).json() as BootstrapResponse;
    expect(after.kuji).toEqual({ boardId: board.kuji.boardId, remaining: remaining - 1 });
    await page.reload();
    await expect(card(page).locator('small')).toHaveText(`남은 쿠지 ${remaining - 1} / 100`);
    // Real counts also survive the evening presentation branch.
    await page.clock.setFixedTime(new Date('2026-10-30T10:00:00Z'));
    await tab(page, '홈').click();
    await expect(card(page).locator('small')).toHaveText(`남은 쿠지 ${remaining - 1} / 100`);
  });
}

test('cards distinguish a missing board from a sold-out board awaiting the next one', async ({ page }) => {
  await login(page);
  for (const kuji of [{ boardId: null, remaining: 100 }, { boardId: 42, remaining: 0 }]) {
    await page.route('**/api/bootstrap', async route => {
      const response = await route.fetch();
      await route.fulfill({ response, json: { ...await response.json(), kuji } });
    });
    await page.reload();
    for (const name of ['홈', '게임']) {
      await tab(page, name).click();
      await expect(card(page).locator('small')).toHaveText(`남은 쿠지 ${kuji.remaining} / 100`);
      await expect(card(page).locator('.chip')).toHaveText(kuji.remaining === 0 ? '새 판 대기' : '진행 중');
    }
    await page.unroute('**/api/bootstrap');
  }
});

test('serverless previews retain their daytime and evening example cards', async ({ page }) => {
  const requests: string[] = [];
  page.on('request', request => { if (new URL(request.url()).pathname.startsWith('/api/')) requests.push(request.url()); });
  for (const [time, label] of [[NOW, '63 / 100칸 남음'], ['2026-10-30T10:00:00Z', '41 / 100칸 남음']]) {
    await page.clock.setFixedTime(new Date(time));
    for (const route of ['/preview', '/preview/games']) {
      await page.goto(`/#${route}`);
      await expect(card(page).locator('small')).toHaveText(label);
    }
  }
  expect(requests).toEqual([]);
});
