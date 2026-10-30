import { expect, test, type Page } from '@playwright/test';
async function login(page: Page, username: string) {
  await page.goto('/');
  await page.getByLabel('아이디', { exact: true }).fill(username);
  await page.getByLabel('비밀번호', { exact: true }).fill('e2e-only-password-2026');
  await page.getByRole('button', { name: '예굼방 들어가기' }).click();
  await expect(page.getByRole('heading', { name: `${username}의 예굼방` })).toBeVisible();
}

test('mobile and desktop previews render all game screens without errors or overflow', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  for (const width of [320, 390, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    for (const route of ['/preview','/preview/game/wake','/preview/game/luck','/preview/game/offwork','/preview/play/catchmind','/preview/play/kuji','/preview/play/claw']) {
      await page.goto(`/#${route}`);
      await expect(page.locator('main')).toBeVisible();
      await expect(page.locator('main')).not.toContainText('NaN');
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
      expect(overflow, `${width}px ${route}`).toBe(false);
      expect(await page.locator('img').evaluateAll(images => images.every(image => (image as HTMLImageElement).complete && (image as HTMLImageElement).naturalWidth > 0))).toBe(true);
    }
  }
  expect(errors).toEqual([]);
});

test('login persists an author answer, hides it from another player, and logout clears access', async ({ page, browser }) => {
  await login(page, 'min');
  await page.goto('/#/game/wake');
  await expect(page.locator('.countdown')).not.toContainText('NaN');
  await page.getByRole('spinbutton', { name: '시', exact: true }).fill('8');
  await page.getByRole('spinbutton', { name: '분', exact: true }).fill('37');
  await page.getByRole('button', { name: '정답 저장', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('정답을 저장했어요');
  await page.reload();
  await expect(page.getByRole('spinbutton', { name: '분', exact: true })).toHaveValue('37');
  const other = await browser.newContext();
  const otherPage = await other.newPage();
  await login(otherPage, 'yeseo');
  const response = await otherPage.request.get('/api/bootstrap');
  const body = await response.json();
  expect(body.games.find((game: { id: string }) => game.id === 'wake').answer).toBeNull();
  await other.close();
  await page.goto('/#/profile');
  await page.getByRole('button', { name: '로그아웃', exact: true }).click();
  await expect(page.getByRole('button', { name: '예굼방 들어가기' })).toBeVisible();
  expect((await page.request.get('/api/auth/me')).status()).toBe(401);
});

test('PWA caches the app shell and previews offline but never caches authenticated API data', async ({ page, context }) => {
  await page.goto('/#/preview');
  await page.evaluate(async () => { await navigator.serviceWorker.ready; });
  await page.reload();
  await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true);
  const manifest = await (await page.request.get('/manifest.webmanifest')).json();
  expect(manifest.display).toBe('standalone');
  expect(manifest.icons.some((icon: { purpose: string }) => icon.purpose === 'maskable')).toBe(true);
  const cached = await page.evaluate(async () => (await Promise.all((await caches.keys()).map(async name => (await (await caches.open(name)).keys()).map(r => r.url)))).flat());
  expect(cached.some(url => new URL(url).pathname.startsWith('/api'))).toBe(false);
  await context.setOffline(true);
  await page.reload();
  await expect(page.getByRole('status')).toContainText('오프라인');
  await expect(page.getByRole('heading', { name: '우리의 작은 놀이터' })).toBeVisible();
  await page.goto('/#/preview/game/wake');
  await expect(page.getByRole('heading', { name: 'min은 몇 시에 일어날까?' })).toBeVisible();
});

test('a delayed bootstrap cannot restore the previous user after logout', async ({ page }) => {
  let holdNext = false;
  let held = false;
  let release: () => void = () => {};
  const gate = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/api/bootstrap', async route => {
    const response = await route.fetch();
    if (holdNext) { holdNext = false; held = true; await gate; }
    await route.fulfill({ response });
  });
  await login(page, 'siwon');
  holdNext = true;
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await expect.poll(() => held).toBe(true);
  await page.goto('/#/profile');
  await page.getByRole('button', { name: '로그아웃', exact: true }).click();
  await expect(page.getByRole('button', { name: '예굼방 들어가기' })).toBeVisible();
  const completed = page.waitForResponse('**/api/bootstrap');
  release();
  await completed;
  await expect(page.getByRole('button', { name: '예굼방 들어가기' })).toBeVisible();
  expect((await page.request.get('/api/auth/me')).status()).toBe(401);
});
