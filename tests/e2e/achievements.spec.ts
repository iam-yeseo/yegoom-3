import { expect, test, type Page } from '@playwright/test';

const MORNING = '2026-10-30T00:00:00Z';
const ORIGIN = 'http://localhost:8788';
test.use({ serviceWorkers: 'block' });
test.beforeEach(async ({ page }) => {
  await page.clock.setFixedTime(new Date(MORNING));
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.setExtraHTTPHeaders({ 'CF-Connecting-IP': '192.0.2.41' });
});
async function login(page: Page, username: string) {
  const response = await page.request.post('/api/auth/login', {
    headers: { Origin: ORIGIN, 'CF-Connecting-IP': '192.0.2.41' },
    data: { username, password: 'e2e-only-password-2026' },
  });
  expect(response.status(), 'isolated fixture login').toBe(200);
}

test('the preview games tab toggles to the achievement list and pays a sample reward without APIs', async ({ page }) => {
  const apiCalls: string[] = [];
  page.on('request', request => { if (new URL(request.url()).pathname.startsWith('/api/')) apiCalls.push(request.url()); });
  await page.goto('/#/preview/games');
  await expect(page.locator('.games-toggle [role="tab"][aria-selected="true"]')).toHaveText('게임');
  await page.getByRole('tab', { name: '도전과제' }).click();
  await expect(page).toHaveURL(/#\/preview\/games\/achievements$/);
  await expect(page.locator('.tab-header h1')).toHaveText('도전과제');
  await expect(page.locator('.tabbar button.on')).toContainText('게임');
  const welcome = page.locator('.achievement-row[data-key="welcome"]');
  await expect(welcome).toHaveClass(/unlocked/);
  await expect(page.locator('.achievement-row.locked').first()).toBeVisible();
  await expect(page.locator('.achievement-claim.all')).toContainText('3개 모두 받기');
  await welcome.getByRole('button', { name: /받기/ }).click();
  await expect(welcome).toHaveClass(/claimed/);
  await expect(page.locator('.achievement-claim.all')).toContainText('2개 모두 받기');
  // 모두 받기 collects the rest in one go: the list never drops back to its loading line.
  await page.evaluate(() => {
    const seen = (window as unknown as { loadingSeen: number }).loadingSeen = 0;
    new MutationObserver(() => { if (document.querySelector('.achievements [role="status"]')) (window as unknown as { loadingSeen: number }).loadingSeen = seen + 1; })
      .observe(document.querySelector('.achievements')!, { childList: true, subtree: true });
  });
  await page.locator('.achievement-claim.all').click();
  await expect(page.locator('.achievements')).toContainText('받을 보상이 없어요');
  await expect(page.locator('.achievement-row.unlocked')).toHaveCount(0);
  await expect(page.locator('.fx-toast').last()).toContainText('받았어요');
  expect(await page.evaluate(() => (window as unknown as { loadingSeen: number }).loadingSeen)).toBe(0);
  await page.getByRole('tab', { name: '게임' }).click();
  await expect(page).toHaveURL(/#\/preview\/games$/);
  await expect(page.locator('.game-row').first()).toBeVisible();
  expect(apiCalls).toEqual([]);
});

test('a signed-in player is notified of a new achievement, opens it from the toast and collects the gold', async ({ page }) => {
  await login(page, 'yeseo');
  await page.goto('/#/games/achievements');
  const welcome = page.locator('.achievement-row[data-key="welcome"]');
  await expect(welcome).toHaveClass(/unlocked/);
  await expect(page.locator('.achievement-row[data-key="font_size"]')).toHaveClass(/locked/);
  // Changing the text size is reported to the Worker as a client event and
  // completes 눈이 편안해졌어요; the bootstrap that follows carries the notice
  // and the toast opens the achievement list. (Attendance is left to the
  // attendance tests, which share this fixture database.)
  await page.goto('/#/profile');
  const event = page.waitForResponse(response => response.url().endsWith('/api/achievements/events') && response.request().method() === 'POST');
  await page.getByRole('tab', { name: '작게', exact: true }).click();
  expect((await event).status()).toBe(200);
  const toast = page.locator('.announcement-banner', { hasText: '도전과제' });
  await expect(toast).toBeVisible({ timeout: 15000 });
  await toast.locator('.announcement-open').click();
  await expect(page).toHaveURL(/#\/games\/achievements$/);
  const fontSize = page.locator('.achievement-row[data-key="font_size"]');
  await expect(fontSize).toHaveClass(/unlocked/);
  const gold = () => page.evaluate(() => fetch('/api/bootstrap', { credentials: 'same-origin', cache: 'no-store' })
    .then(response => response.json() as Promise<{ user: { gold: number } }>).then(body => body.user.gold));
  const before = await gold();
  await fontSize.getByRole('button', { name: /받기/ }).click();
  await expect(fontSize).toHaveClass(/claimed/);
  await expect(page.locator('.fx-toast').last()).toContainText('+50G 받았어요');
  await expect.poll(gold).toBe(before + 50);
  await expect(page.locator('.achievement-row[data-key="font_size"] .achievement-reward.claimed')).toBeVisible();
  // The centre lists the same notice with a link back here.
  await page.goto('/#/notifications');
  const row = page.locator('.notification-row', { hasText: '도전과제 달성! 눈이 편안해졌어요' });
  await expect(row).toBeVisible();
  await row.click();
  await expect(page).toHaveURL(/#\/games\/achievements$/);
  await page.evaluate(() => localStorage.removeItem('yegoom3:font-size'));
});
