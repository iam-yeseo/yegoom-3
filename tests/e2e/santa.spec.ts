import { mkdir } from 'node:fs/promises';
import { expect, test, type Page } from '@playwright/test';
import { expectPageScrolls } from './page-scroll';

test.use({ serviceWorkers: 'block' });
const shell = (page: Page) => page.getByRole('region', { name: '산타 선물 배달' });

test('santa runs full screen: the sky and the throw button fit without scrolling on any screen', async ({ page }) => {
  await page.route('**/api/**', route => route.abort());
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/#/preview');
  const tile = page.locator('.solo-tile', { hasText: '산타 선물 배달' });
  await expect(tile).toContainText('지금 출발할 수 있어요');
  await tile.click();
  await expect(page).toHaveURL(/#\/preview\/play\/santa$/);
  await mkdir('docs/screenshots', { recursive: true });
  await page.screenshot({ path: 'docs/screenshots/santa-lobby-390.png', fullPage: true });
  await page.getByRole('button', { name: /산타 출발/ }).click();
  await expect(shell(page)).toBeVisible();
  await expect(page.locator('.santa-banner')).toContainText('산타 출발!');
  await expect(page.locator('.play-progress')).toContainText('0/10');
  const button = page.getByRole('button', { name: /선물 던지기/ });
  // The first house is on its way: the button turns on once the countdown ends.
  await expect(button).toBeEnabled({ timeout: 4000 });
  for (const [width, height] of [[390, 844], [390, 600], [1280, 720]] as const) {
    await page.setViewportSize({ width, height });
    await page.waitForTimeout(150);
    const sky = (await page.locator('.santa-canvas').boundingBox())!;
    expect(sky.width / sky.height).toBeCloseTo(360 / 560, 2);
    expect(sky.y + sky.height).toBeLessThanOrEqual(height);
    const box = (await button.boundingBox())!;
    expect(box.y + box.height).toBeLessThanOrEqual(height);
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: 'docs/screenshots/santa-play-390.png' });
});

test('a finished santa run leaves the page scrollable once the result is closed', async ({ page }) => {
  // Ten houses fly by one after another; let every one pass without a throw.
  test.setTimeout(120_000);
  await page.route('**/api/**', route => route.abort());
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/#/preview/play/santa');
  await page.getByRole('button', { name: /산타 출발/ }).click();
  await expect(shell(page)).toBeVisible();
  const result = page.locator('.play-result-dialog');
  await expect(result).toContainText('0곳 배달 성공!', { timeout: 100_000 });
  await result.getByRole('button', { name: '확인' }).click();
  await expect(shell(page)).toHaveCount(0);
  await page.locator('.santa-guide summary').click();
  await expectPageScrolls(page);
});

test('leaving a santa run midway asks first, ends it unfinished and does not offer a second start', async ({ page }) => {
  await page.setExtraHTTPHeaders({ 'CF-Connecting-IP': '192.0.2.73' });
  await page.setViewportSize({ width: 390, height: 844 });
  const login = await page.request.post('/api/auth/login', {
    headers: { Origin: 'http://localhost:8788', 'CF-Connecting-IP': '192.0.2.73' },
    data: { username: 'yeseo', password: 'e2e-only-password-2026' },
  });
  expect(login.status()).toBe(200);
  const finishes: string[] = [];
  page.on('request', request => { if (request.url().includes('/api/santa/finish')) finishes.push(request.url()); });
  await page.goto('/#/play/santa');
  await page.getByRole('button', { name: /산타 출발/ }).click();
  await expect(page.getByRole('button', { name: /선물 던지기/ })).toBeEnabled({ timeout: 4000 });
  await page.getByRole('button', { name: /선물 던지기/ }).dispatchEvent('pointerdown', { button: 0, isPrimary: true });
  await page.getByRole('button', { name: '나가기' }).click();
  await expect(page.locator('.play-quit-dialog')).toContainText('미완료로 끝나요');
  await page.getByRole('button', { name: '계속 배달하기' }).click();
  await expect(page.locator('.santa-banner')).toBeVisible();
  await page.getByRole('button', { name: '나가기' }).click();
  await page.getByRole('button', { name: '그만두기' }).click();
  await expect(shell(page)).toHaveCount(0);
  await expect(page.locator('.santa-run')).toContainText('미완료로 끝났어요');
  await expect(page.getByRole('button', { name: /산타 출발/ })).toHaveCount(0);
  // Nothing was sent for the abandoned run, and the server keeps it unrecorded.
  expect(finishes).toEqual([]);
  const state = await (await page.request.get('/api/santa')).json();
  expect(state).toMatchObject({ available: false, played: true, completed: false });
  expect(state.current.drops).toEqual([]);
  await page.reload();
  await expect(page.locator('.santa-run')).toContainText('미완료로 끝났어요');
});
