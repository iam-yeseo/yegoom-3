import { mkdir } from 'node:fs/promises';
import { expect, test, type Page, type TestInfo } from '@playwright/test';
import type { BootstrapResponse } from '../../shared/types';

// Match the isolated Worker fixture; performance/animation timers still run.
const TEST_NOW = '2026-10-30T00:00:00Z';
test.beforeEach(async ({ page }) => { await page.clock.setFixedTime(new Date(TEST_NOW)); });

async function login(page: Page, username: string) {
  await page.clock.setFixedTime(new Date(TEST_NOW));
  await page.goto('/');
  await page.getByLabel('아이디', { exact: true }).fill(username);
  await page.getByLabel('비밀번호', { exact: true }).fill('e2e-only-password-2026');
  await page.getByRole('button', { name: '예굼방 들어가기' }).click();
  await expect(page.getByRole('heading', { name: username, exact: true })).toBeVisible();
}

test('mobile and desktop previews render all game screens without errors or overflow', async ({ page }) => {
  test.setTimeout(60000);
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  for (const width of [320, 390, 560, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    for (const route of ['/preview','/preview/games','/preview/ranking','/preview/attendance','/preview/profile','/preview/game/wake','/preview/game/luck','/preview/game/offwork','/preview/play/catchmind','/preview/play/kuji','/preview/play/claw','/preview/stock','/preview/stock/upa','/preview/stock/bang','/preview/shop','/preview/shop/lotto','/preview/shop/speetto']) {
      await page.goto(`/#${route}`);
      await expect(page.locator('main')).toBeVisible();
      await expect(page.locator('main')).not.toContainText('NaN');
      if (width === 1440) {
        const appWidth = await page.locator('.app-shell').evaluate(element => element.getBoundingClientRect().width);
        expect(appWidth).toBe(560);
        if (route === '/preview/play/claw') {
          expect(await page.locator('.pg-machine').evaluate(element => element.getBoundingClientRect().width)).toBe(400);
        }
        if (await page.locator('.tabbar').count()) {
          expect(await page.locator('.tabbar').evaluate(element => element.getBoundingClientRect().width)).toBe(appWidth);
        }
      }
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
      expect(overflow, `${width}px ${route}`).toBe(false);
      expect(await page.locator('img').evaluateAll(images => images.every(image => (image as HTMLImageElement).complete && (image as HTMLImageElement).naturalWidth > 0))).toBe(true);
    }
  }
  expect(errors).toEqual([]);
});

test('preview heroes greet only before the answer is revealed', async ({ page }, testInfo) => {
  type HeroHistory = { states: string[]; startedAt: number };
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.addInitScript(() => {
    const observed = window as typeof window & { heroHistory: HeroHistory };
    observed.heroHistory = { states: [], startedAt: 0 };
    new MutationObserver(() => {
      const state = document.querySelector('.hero-character')?.getAttribute('data-state');
      const history = observed.heroHistory;
      if (state && state !== history.states.at(-1)) {
        if (!history.states.length) history.startedAt = performance.now();
        history.states.push(state);
      }
    }).observe(document, { subtree: true, childList: true, attributes: true, attributeFilter: ['data-state'] });
  });
  const states = () => page.evaluate(() =>
    (window as typeof window & { heroHistory: HeroHistory }).heroHistory.states,
  );

  await page.goto('/#/preview/game/offwork');
  await page.locator('.hero-character').waitFor({ state: 'attached' });
  await expect.poll(() => page.evaluate(() => {
    const history = (window as typeof window & { heroHistory: HeroHistory }).heroHistory;
    return history.states.length ? performance.now() - history.startedAt : 0;
  }), { timeout: 2000, intervals: [50] }).toBeGreaterThanOrEqual(1500);
  expect(await states()).not.toContain('greet');
  await expect.poll(states, { timeout: 2500, intervals: [50] }).toEqual(['idle', 'jump', 'idle']);
  const offwork = await states();

  // A full navigation gives the open round its own observer and history.
  await page.goto('about:blank');
  await page.goto('/#/preview/game/wake');
  await page.locator('.hero-character').waitFor({ state: 'attached' });
  await expect.poll(states, { timeout: 1500, intervals: [50] }).toContain('greet');
  await expect.poll(states, { timeout: 4000, intervals: [50] }).toEqual(['idle', 'greet', 'idle']);
  await testInfo.attach('hero-state-history', {
    body: JSON.stringify({ offwork, wake: await states() }, null, 2),
    contentType: 'application/json',
  });
});

async function fillTime(page: Page, hour: string, minute: string, second: string) {
  await page.getByRole('spinbutton', { name: '시', exact: true }).fill(hour);
  await page.getByRole('spinbutton', { name: '분', exact: true }).fill(minute);
  await page.getByRole('spinbutton', { name: '초', exact: true }).fill(second);
}
async function snapshot(page: Page): Promise<BootstrapResponse> {
  const response = await page.request.get('/api/bootstrap');
  expect(response.status()).toBe(200);
  return response.json();
}
async function captureWidths(page: Page, name: string, info: TestInfo, phase = 1) {
  await mkdir('docs/screenshots', { recursive: true });
  await expect(page.locator('.fx-toast')).toHaveCount(0);
  for (const width of [390, 560]) {
    await page.setViewportSize({ width, height: 900 });
    await expect(page.locator('main')).not.toContainText('NaN');
    expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
    await page.evaluate(() => document.fonts.ready);
    const path = phase === 2 ? `docs/screenshots/v2-p2-${name}-${width}.png` : info.outputPath(`${name}-${width}.png`);
    await page.screenshot({ path, fullPage: true, animations: 'disabled' });
    await info.attach(`${name}-${width}px`, { path, contentType: 'image/png' });
  }
}

test('preview seconds, history and help work without API access at both target widths', async ({ page }, info) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const requests: string[] = [];
  await page.route('**/api/**', route => { requests.push(route.request().url()); return route.abort(); });
  await page.goto('/#/preview/game/wake');
  await fillTime(page, '8', '37', '42');
  await expect(page.getByRole('spinbutton', { name: '초', exact: true })).toHaveValue('42');
  await expect(page.locator('input[type="time"]')).toHaveCount(0);
  const help = page.locator('.prediction-help details');
  await expect(help).not.toHaveAttribute('open');
  const history = page.getByRole('region', { name: '최근 결과 기록' });
  await expect(history.locator('.history-round')).toHaveCount(3);
  await captureWidths(page, 'preview-input', info);
  await page.getByText('게임 방법', { exact: true }).click();
  await expect(help).toHaveAttribute('open', '');
  await expect(help).toContainText('10:30:00');
  await expect(help).toContainText('참여 보상 100G');
  await expect(help).toContainText('동점이면 모두');
  await expect(help.getByRole('row', { name: '1분 이내 25점' })).toBeVisible();
  await expect(help.getByRole('row', { name: '1시간 이내 5점' })).toBeVisible();
  await expect(help.getByRole('row', { name: '정확히 일치 30점' })).toBeVisible();
  await captureWidths(page, 'help-wake', info, 2);
  await page.goto('/#/preview/game/offwork');
  await expect(page.locator('.result-list .result-card')).not.toHaveCount(0);
  await captureWidths(page, 'preview-results', info);
  await page.getByText('게임 방법', { exact: true }).click();
  await expect(help.getByRole('row', { name: '15초 이내 25점' })).toBeVisible();
  await page.goto('/#/preview/game/luck');
  await page.getByText('게임 방법', { exact: true }).click();
  await expect(help.getByRole('row', { name: '10점 차이 이내 3점' })).toBeVisible();
  await expect(help.getByRole('row', { name: '정확히 일치 30점' })).toBeVisible();
  // Reduced motion has no indefinitely repeating sprite animations.
  expect(await page.locator('.hero-character').evaluate(element => element.getAnimations().some(animation => animation.effect?.getTiming().iterations === Infinity))).toBe(false);
  for (const route of ['/preview', '/preview/ranking']) {
    await page.goto(`/#${route}`);
    await expect(page.locator('.reward-chip')).toHaveCount(0);
    await expect(page.locator('main')).not.toContainText(/3,000G|1,800G|1,000G/);
  }
  expect(requests).toEqual([]);
});

test('offwork author saves seconds privately and rewards appear in results, home and ledger', async ({ page, browser }, info) => {
  test.setTimeout(60000);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await login(page, 'siwon');
  await page.goto('/#/game/offwork');
  await expect(page.getByRole('heading', { name: '오늘의 퇴근 시각' })).toBeVisible();
  await fillTime(page, '18', '37', '42');
  await page.getByRole('button', { name: '정답 저장', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('정답을 저장했어요');
  await page.reload();
  await expect(page.getByRole('spinbutton', { name: '초', exact: true })).toHaveValue('42');
  await expect(page.locator('.prediction-input')).toContainText('18:37:42에 자동 공개');
  await expect(page.locator('.submission-card')).toHaveCount(2);
  await captureWidths(page, 'authenticated-offwork-author', info);
  const other = await browser.newContext({ reducedMotion: 'reduce' });
  try {
    const player = await other.newPage();
    await login(player, 'yeseo');
    const before = await snapshot(player);
    expect(before.games.find(game => game.id === 'offwork')?.answer).toBeNull();
    await player.goto('/#/game/offwork');
    await fillTime(player, '18', '37', '42');
    await player.locator('.game-actions button[type="submit"]').click();
    await expect(player.getByRole('status')).toContainText('예측을 저장했어요');
    expect((await snapshot(player)).user.gold).toBe(before.user.gold + 100);
    await fillTime(player, '18', '37', '43');
    await player.locator('.game-actions button[type="submit"]').click();
    await expect(player.locator('.game-actions button[type="submit"]')).toContainText('제출 완료');
    expect((await snapshot(player)).user.gold).toBe(before.user.gold + 100);
    await page.reload();
    const submitted = page.locator('.submission-card').filter({ hasText: 'yeseo' });
    await expect(submitted).toContainText('제출 완료');
    await expect(submitted).not.toContainText('18:37:43');
    await page.getByRole('button', { name: '지금 공개', exact: true }).click();
    await expect(page.locator('.answer-number')).toHaveText('18:37:42');
    await player.reload();
    const result = player.locator('.result-list .result-card');
    await expect(result).toHaveCount(1);
    await expect(result).toContainText('1초 차이');
    await expect(result.locator('.reward.points')).toHaveText('+25점');
    await expect(result.locator('.reward.gold')).toContainText('+100 참여');
    await expect(result.locator('.reward.bonus')).toContainText('+100 1등 보너스');
    const after = await snapshot(player);
    expect(after.user.gold).toBe(before.user.gold + 200);
    expect(after.user.weeklyScore).toBe(before.user.weeklyScore + 25);
    await expect(player.getByRole('region', { name: '최근 결과 기록' }).locator('.history-heading h3')).toHaveText(['2026-10-29', '2026-10-27', '2026-10-24']);
    await captureWidths(player, 'authenticated-results', info);
    await player.goto('/#/');
    await expect(player.locator('.room-top .gold')).toContainText(after.user.gold.toLocaleString('ko-KR'));
    await player.goto('/#/profile');
    await expect(player.locator('.profile-summary .stats')).toContainText(after.user.gold.toLocaleString('ko-KR'));
    await expect(player.locator('.profile-summary .stats')).toContainText(`${after.user.weeklyScore}점`);
    await expect(player.locator('.history-row').filter({ hasText: '퇴근시간 맞히기 참여' })).toContainText('+100G');
    await player.getByRole('tab', { name: '점수', exact: true }).click();
    await expect(player.locator('.history-row').filter({ hasText: '퇴근시간 맞히기 예측 점수' }).first()).toContainText('+25점');
  } finally { await other.close(); }
  await page.goto('/#/profile');
  await page.getByRole('button', { name: '로그아웃', exact: true }).click();
  await expect(page.getByRole('button', { name: '예굼방 들어가기' })).toBeVisible();
  expect((await page.request.get('/api/auth/me')).status()).toBe(401);
});

test('wake author confirms once, shows the server clock and cannot undo the reveal', async ({ page }, info) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await login(page, 'min');
  await page.goto('/#/game/wake');
  await expect(page.locator('.author-date')).toContainText('2026-10-30');
  await expect(page.locator('.wake-clock')).toHaveText(/09:00:\d{2}/);
  await expect(page.getByRole('spinbutton')).toHaveCount(0);
  await captureWidths(page, 'authenticated-wake-author', info);
  await page.getByRole('button', { name: '기상했어요', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '기상 시각을 공개할까요?' });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText('되돌릴 수 없고');
  expect((await snapshot(page)).games.find(game => game.id === 'wake')?.answer).toBeNull();
  await dialog.getByRole('button', { name: '취소', exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await page.getByRole('button', { name: '기상했어요', exact: true }).click();
  await dialog.getByRole('button', { name: '기상 시각 확정', exact: true }).click();
  await expect(page.locator('.answer-number')).toHaveText('09:00:00');
  await expect(page.getByRole('button', { name: '기상했어요', exact: true })).toHaveCount(0);
  await page.reload();
  await expect(page.locator('.answer-number')).toHaveText('09:00:00');
  await expect(page.getByRole('button', { name: '기상했어요', exact: true })).toHaveCount(0);
});

test('luck author edits a bounded hint and publishes the saved score', async ({ page, browser }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await login(page, 'yeseo');
  await page.goto('/#/game/luck');
  await expect(page.locator('.prediction-input')).toContainText('18:00:00에 자동 공개');
  await page.getByRole('spinbutton', { name: /^정답 점수/ }).fill('77');
  const hint = page.getByLabel('함께 볼 힌트');
  await expect(hint).toHaveAttribute('maxlength', '200');
  await hint.fill('행운이 가득한 하루');
  await page.getByRole('button', { name: '정답 저장', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('정답을 저장했어요');
  const other = await browser.newContext({ reducedMotion: 'reduce' });
  try {
    const player = await other.newPage();
    await login(player, 'min');
    await player.goto('/#/game/luck');
    await expect(player.locator('.hint-card')).toContainText('행운이 가득한 하루');
    const hidden = (await snapshot(player)).games.find(game => game.id === 'luck');
    expect(hidden?.answer).toBeNull();
    expect(hidden?.results).toEqual([]);
    await page.getByRole('spinbutton', { name: /^정답 점수/ }).fill('78');
    await hint.fill('조금 더 행운이 가득한 하루');
    await page.getByRole('button', { name: '정답 저장', exact: true }).click();
    await expect(page.getByRole('button', { name: '지금 공개', exact: true })).toBeEnabled();
    await page.getByRole('button', { name: '지금 공개', exact: true }).click();
    await expect(page.locator('.answer-number')).toHaveText('78점');
    await player.reload();
    await expect(player.locator('.answer-number')).toHaveText('78점');
    await expect(page.getByRole('spinbutton', { name: /^정답 점수/ })).toHaveCount(0);
  } finally { await other.close(); }
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
  await expect(page.getByRole('heading', { name: 'yeseo', exact: true })).toBeVisible();
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

test('seventh attendance claim waits for the celebration, collapses and loads past months from the server', async ({ page }, info) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await login(page, 'min');
  const before = await snapshot(page);
  expect(before.attendance).toMatchObject({ today: '2026-10-30', claimed: false, cycleDay: 7, reward: 500, monthCount: 6 });
  const card = page.locator('.attendance-card');
  await expect(card).toContainText('500G');
  await expect(card.locator('.week-day')).toHaveCount(7);
  await card.getByRole('button', { name: '받기', exact: true }).click();
  await expect(page.locator('.fx-coin').first()).toBeVisible();
  await expect(card.locator('.week-path')).toBeVisible();
  await expect(page.locator('.room-character')).toHaveAttribute('data-state', 'jump');
  await expect(card.locator('.week-path')).toBeVisible();
  const toggle = card.getByRole('button', { name: '오늘 출석 완료 · 7일째', exact: true });
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await expect(card.locator('.week-path')).not.toBeVisible();
  const after = await snapshot(page);
  expect(after.user.gold).toBe(before.user.gold + 500);
  expect(after.attendance).toMatchObject({ claimed: true, streak: 7, cycleDay: 7, reward: 500, monthCount: 7 });
  expect(after.ledger.filter(entry => entry.reason.includes('출석') && entry.createdAt.startsWith('2026-10-30'))).toEqual([
    expect.objectContaining({ currency: 'gold', amount: 500 }),
  ]);
  await expect(page.locator('.room-top .gold')).toContainText(after.user.gold.toLocaleString('ko-KR'));
  await captureWidths(page, 'authenticated-home', info, 2);
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  await expect(card.locator('.week-path')).toBeVisible();
  await page.reload();
  await expect(card.getByRole('button', { name: '오늘 출석 완료 · 7일째', exact: true })).toHaveAttribute('aria-expanded', 'false');
  const duplicate = await page.request.post('/api/me/attendance', { data: {}, headers: { Origin: new URL(page.url()).origin } });
  expect(duplicate.status()).toBe(200);
  expect(await duplicate.json()).toMatchObject({ awarded: false, user: { gold: after.user.gold } });
  await page.goto('/#/attendance');
  await expect(page.getByRole('heading', { name: '2026년 10월' })).toBeVisible();
  await expect(page.getByLabel('2026-10-30 출석', { exact: true })).toBeVisible();
  await expect(page.locator('.streak-node')).toHaveCount(7);
  await expect(page.locator('.streak-node').last()).toContainText('500');
  await captureWidths(page, 'authenticated-attendance', info, 2);
  const previousMonth = page.waitForResponse(response => response.url().includes('/api/me/attendance?month=2026-09'));
  await page.getByRole('button', { name: '이전 달', exact: true }).click();
  expect((await previousMonth).status()).toBe(200);
  await expect(page.getByRole('heading', { name: '2026년 9월' })).toBeVisible();
  await expect(page.getByLabel('2026-09-29 출석', { exact: true })).toBeVisible();
  await expect(page.getByLabel('2026-09-28 미출석', { exact: true })).toBeVisible();
  await page.goto('/#/profile');
  await expect(page.locator('.profile-summary .stats')).toContainText('7일');
  await expect(page.locator('.history-row').filter({ hasText: '출석' }).first()).toContainText('+500G');
});

test('legacy attendance is discarded and a reduced-motion claim pays only the server reward', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/#/preview');
  await page.evaluate(() => localStorage.setItem('yegoom3:attendance:yeseo', '2026-10-24,2026-10-25,2026-10-26,2026-10-27,2026-10-28,2026-10-29,2026-10-30'));
  await login(page, 'yeseo');
  const before = await snapshot(page);
  expect(before.attendance).toMatchObject({ claimed: false, cycleDay: 1, streak: 1, reward: 100, monthCount: 0 });
  expect(await page.evaluate(() => localStorage.getItem('yegoom3:attendance:yeseo'))).toBeNull();
  const card = page.locator('.attendance-card');
  const paid = page.waitForResponse(response => response.url().endsWith('/api/me/attendance') && response.request().method() === 'POST');
  await card.getByRole('button', { name: '받기', exact: true }).click();
  expect((await paid).status()).toBe(200);
  await expect(card.getByRole('button', { name: '오늘 출석 완료 · 1일째', exact: true })).toHaveAttribute('aria-expanded', 'false', { timeout: 1000 });
  await expect(page.locator('.fx-coin')).toHaveCount(0);
  const after = await snapshot(page);
  expect(after.user.gold).toBe(before.user.gold + 100);
  expect(after.attendance).toMatchObject({ claimed: true, streak: 1, monthCount: 1 });
  await page.reload();
  await expect(card.getByRole('button', { name: '오늘 출석 완료 · 1일째', exact: true })).toHaveAttribute('aria-expanded', 'false');
  expect((await snapshot(page)).user.gold).toBe(after.user.gold);
});

test('administrators cannot claim attendance through the screen or the API', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await login(page, 'admin');
  const before = await snapshot(page);
  expect(before.attendance.canClaim).toBe(false);
  const homeClaims = page.locator('.attendance-card button').filter({ hasText: /^받기$/ });
  expect(await homeClaims.count() === 0 || await homeClaims.first().isDisabled()).toBe(true);
  await page.goto('/#/attendance');
  await expect(page.getByRole('heading', { name: '출석 체크', exact: true })).toBeVisible();
  const claims = page.getByRole('button', { name: /^받기/ });
  expect(await claims.count() === 0 || await claims.first().isDisabled()).toBe(true);
  const claim = await page.request.post('/api/me/attendance', { data: {}, headers: { Origin: new URL(page.url()).origin } });
  expect(claim.status()).toBe(403);
  expect((await snapshot(page)).user.gold).toBe(before.user.gold);
});

test('character import runs only for a null server choice and selected characters persist across contexts', async ({ page, browser }, info) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/#/preview');
  await page.evaluate(() => localStorage.setItem('yegoom3:character:siwon', 'moon'));
  const imports: unknown[] = [];
  page.on('request', request => {
    if (request.url().endsWith('/api/me/character') && request.method() === 'PUT' && request.postDataJSON()?.migrate) imports.push(request.postDataJSON());
  });
  await login(page, 'siwon');
  await expect.poll(async () => (await snapshot(page)).user.character).toBe('moon');
  expect(imports).toEqual([{ character: 'moon', migrate: true, expectedUserId: 'e2e-siwon' }]);
  expect(await page.evaluate(() => localStorage.getItem('yegoom3:character:siwon'))).toBeNull();
  await page.reload();
  await expect(page.getByRole('heading', { name: 'siwon', exact: true })).toBeVisible();
  expect(imports).toHaveLength(1);
  await page.goto('/#/profile');
  const bread = page.getByRole('button', { name: /^빵빵/ });
  await bread.click();
  await expect(bread).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('.profile-character [data-character="bread"]')).toBeVisible();
  expect((await snapshot(page)).user.character).toBe('bread');
  await captureWidths(page, 'authenticated-profile', info, 2);
  const other = await browser.newContext({ reducedMotion: 'reduce' });
  try {
    const anotherDevice = await other.newPage();
    await anotherDevice.goto('/#/preview');
    await anotherDevice.evaluate(() => localStorage.setItem('yegoom3:character:siwon', 'cat'));
    let unwantedImport = false;
    anotherDevice.on('request', request => {
      if (request.url().endsWith('/api/me/character') && request.method() === 'PUT' && request.postDataJSON()?.migrate) unwantedImport = true;
    });
    await login(anotherDevice, 'siwon');
    await anotherDevice.goto('/#/profile');
    await expect(anotherDevice.getByRole('button', { name: /^빵빵/ })).toHaveAttribute('aria-pressed', 'true');
    expect((await snapshot(anotherDevice)).user.character).toBe('bread');
    expect(await anotherDevice.evaluate(() => localStorage.getItem('yegoom3:character:siwon'))).toBeNull();
    expect(unwantedImport).toBe(false);
    await anotherDevice.getByRole('button', { name: '로그아웃', exact: true }).click();
    await login(anotherDevice, 'min');
    const data = await snapshot(anotherDevice);
    expect(data.players.find(player => player.username === 'siwon')?.character).toBe('bread');
    await anotherDevice.goto('/#/game/luck');
    const row = anotherDevice.getByRole('region', { name: '최근 결과 기록' }).locator('.result-card').filter({ hasText: 'siwon' }).first();
    await expect(row.locator('[data-character="bread"]')).toBeVisible();
    // Duplicate choices are permitted; ownership labels are informational.
    await anotherDevice.goto('/#/profile');
    await anotherDevice.getByRole('button', { name: /^빵빵/ }).click();
    await expect(anotherDevice.getByRole('button', { name: /^빵빵/ })).toHaveAttribute('aria-pressed', 'true');
    expect((await snapshot(anotherDevice)).user.character).toBe('bread');
  } finally { await other.close(); }
});

test('preview attendance and character choices stay local at both target widths', async ({ page }, info) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const requests: string[] = [];
  await page.route('**/api/**', route => { requests.push(route.request().url()); return route.abort(); });
  await page.goto('/#/preview');
  await page.evaluate(() => {
    const today = new Date(Date.now() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const midnight = Date.parse(`${today}T00:00:00Z`);
    const days = Array.from({ length: 6 }, (_, index) => new Date(midnight - (index + 1) * 86400000).toISOString().slice(0, 10));
    localStorage.setItem('yegoom3:attendance:preview', days.join(','));
  });
  await page.reload();
  const card = page.locator('.attendance-card');
  await expect(card).toContainText('500G');
  await card.getByRole('button', { name: '받기', exact: true }).click();
  await expect(card.getByRole('button', { name: '오늘 출석 완료 · 7일째', exact: true })).toHaveAttribute('aria-expanded', 'false');
  await captureWidths(page, 'preview-home', info, 2);
  await page.goto('/#/preview/attendance');
  await expect(page.locator('.claim-big')).toContainText('500');
  await captureWidths(page, 'preview-attendance', info, 2);
  await page.goto('/#/preview/profile');
  const moon = page.getByRole('button', { name: /^달빛/ });
  await moon.click();
  await expect(moon).toHaveAttribute('aria-pressed', 'true');
  await captureWidths(page, 'preview-profile', info, 2);
  await page.reload();
  await expect(page.getByRole('button', { name: /^달빛/ })).toHaveAttribute('aria-pressed', 'true');
  expect(await page.evaluate(() => localStorage.getItem('yegoom3:character:yeseo'))).toBeNull();
  expect(requests).toEqual([]);
});
