import { mkdir, writeFile } from 'node:fs/promises';
import { expect, test, type Locator, type Page, type TestInfo } from '@playwright/test';
import type { BootstrapResponse, CatchmindResponse, KujiResponse, LottoPurchaseInput, LottoResponse, ShopState, SpeettoResponse } from '../../shared/types';

// Match the isolated Worker fixture; performance/animation timers still run.
const TEST_NOW = '2026-10-30T00:00:00Z';
const SAVED_LOTTO_ID = '00000000-0000-4000-8000-000000000002';
const SAVED_SPEETTO_ID = '00000000-0000-4000-8000-000000000001';
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
      // Evidence thumbnails intentionally load lazily below the author form.
      for (const image of await page.locator('img[loading=lazy]').all()) await image.scrollIntoViewIfNeeded();
      await expect.poll(() => page.locator('img').evaluateAll(images => images.every(image => (image as HTMLImageElement).complete && (image as HTMLImageElement).naturalWidth > 0)), { message: `${width}px ${route} images decode` }).toBe(true);
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
    if (width === 390) {
      const titles = page.locator('.shop-tile strong').filter({ hasText: /^데일리 로또$/ });
      const layouts = await titles.evaluateAll(elements => elements.map(element => {
        const text = element.firstChild;
        if (!text || text.nodeType !== Node.TEXT_NODE) throw new Error('Daily lotto title must have readable text');
        const wordLineCounts = ['데일리', '로또'].map(word => {
          const start = text.textContent!.indexOf(word);
          const range = document.createRange();
          range.setStart(text, start);
          range.setEnd(text, start + word.length);
          return Array.from(range.getClientRects()).filter(rect => rect.width > 0).length;
        });
        return { wordBreak: getComputedStyle(element).wordBreak, wordLineCounts };
      }));
      for (const layout of layouts) expect(layout).toEqual({ wordBreak: 'keep-all', wordLineCounts: [1, 1] });
    }
    const path = phase === 5 ? `docs/screenshots/v2-p5-${name}-${width}.png` : info.outputPath(`${name}-${width}.png`);
    await page.screenshot({ path, fullPage: !name.endsWith('picker'), animations: 'disabled' });
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
  await expect(page.locator('.fx-toast').filter({ hasText: '정답을 저장했어요' })).toBeVisible();
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
    await expect(player.locator('.fx-toast').filter({ hasText: '예측을 저장했어요' })).toBeVisible();
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
  const evidence = await page.evaluate(() => {
    const canvas = document.createElement('canvas'); canvas.width = 320; canvas.height = 240;
    const context = canvas.getContext('2d')!;
    context.fillStyle = '#fff4cc'; context.fillRect(0, 0, 320, 240);
    context.fillStyle = '#3a3340'; context.font = 'bold 80px sans-serif'; context.fillText('77', 110, 150);
    return canvas.toDataURL('image/jpeg');
  });
  await page.locator('input[type=file][aria-label="행운 점수 증거 사진"]').setInputFiles({
    name: 'luck-evidence.jpg', mimeType: 'image/jpeg', buffer: Buffer.from(evidence.split(',')[1], 'base64'),
  });
  await expect(page.getByRole('button', { name: '정답 저장', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: '정답 저장', exact: true }).click();
  await expect(page.locator('.fx-toast').filter({ hasText: '정답을 저장했어요' })).toBeVisible();
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
  await expect(page.getByRole('heading', { name: 'min님은 몇 시에 일어날까?' })).toBeVisible();
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
  await expect.poll(async () => {
    if (!held) await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    return held;
  }).toBe(true);
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
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  await expect(card.locator('.week-path')).toBeVisible();
  await captureWidths(page, 'authenticated-home', info, 3);
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
  await card.getByRole('button', { name: '오늘 출석 완료 · 7일째', exact: true }).click();
  await expect(card.locator('.week-path')).toBeVisible();
  await captureWidths(page, 'preview-home', info, 3);
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

async function displayedGold(page: Page, selector: string) {
  const text = await page.locator(selector).innerText();
  const value = Number(text.match(/[0-9][0-9,]*/)?.[0].replaceAll(',', ''));
  expect(Number.isFinite(value)).toBe(true);
  return value;
}

async function shopSnapshot<T extends ShopState>(page: Page, kind = ''): Promise<T> {
  const response = await page.request.get(`/api/shop${kind ? `/${kind}` : ''}`);
  expect(response.status()).toBe(200);
  return response.json();
}
async function chooseLottoNumbers(page: Page, numbers: number[]) {
  const selected = page.locator('.balls button[aria-pressed="true"]');
  while (await selected.count()) await selected.first().click();
  for (const number of numbers) await page.getByRole('button', { name: `번호 ${number}`, exact: true }).click();
  await expect(page.locator('.balls button[aria-pressed="true"]')).toHaveCount(5);
}
function purchaseResponse(page: Page, kind: string) {
  return page.waitForResponse(response => new URL(response.url()).pathname === `/api/shop/${kind}` && response.request().method() === 'POST');
}

test('shop previews run purchases and grade dialogs without API access at both target widths', async ({ page }, info) => {
  test.setTimeout(60000);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const requests: string[] = [];
  await page.route('**/api/**', route => { requests.push(route.request().url()); return route.abort(); });
  await page.goto('/#/preview/shop');
  await expect(page.locator('.inventory-card')).toContainText('데일리 로또 이용권');
  await expect(page.getByText('데일리 로또', { exact: true })).toBeVisible();
  await captureWidths(page, 'preview-shop', info, 3);
  await page.goto('/#/preview/play/kuji');
  await expect(page.getByRole('group', { name: '쿠지판 100장' }).getByRole('button')).toHaveCount(100);
  await expect(page.locator('.pg-kuji-heading')).toContainText('남은 쿠지');
  await expect(page.locator('main')).not.toContainText('남은 칸');
  await page.getByRole('button', { name: '라스트원 보상 보기', exact: true }).click();
  const last = page.getByRole('dialog', { name: '라스트원 보상', exact: true });
  await expect(last).toContainText('1,000G');
  await page.keyboard.press('Escape');
  await expect(last).toHaveCount(0);
  await captureWidths(page, 'preview-kuji', info, 3);
  await page.locator('.pg-kuji-board button:not(:disabled)').first().click();
  await page.getByRole('button', { name: /^1장 뽑기/ }).click();
  await expect(page.getByRole('dialog', { name: '뽑은 쿠지', exact: true })).toContainText('받은 보상');
  await page.getByRole('dialog', { name: '뽑은 쿠지', exact: true }).getByRole('button', { name: '닫기', exact: true }).click();
  await page.goto('/#/preview/shop/lotto');
  await expect(page.getByRole('heading', { name: '데일리 로또', exact: true })).toBeVisible();
  await chooseLottoNumbers(page, [1, 2, 3, 4, 5]);
  const beforeGold = await displayedGold(page, '.game-toolbar .gold');
  await page.getByRole('button', { name: '골드로 1장 사기 · 500G', exact: true }).click();
  await expect(page.locator('.lotto-tickets .ticket').first()).toContainText('추첨 대기');
  await expect(page.locator('.game-toolbar .gold')).toContainText((beforeGold - 500).toLocaleString('ko-KR'));
  await page.goto('/#/preview');
  await expect(page.locator('.room-top .gold')).toContainText((beforeGold - 500).toLocaleString('ko-KR'));
  const attendance = page.locator('.attendance-card');
  const reward = Number((await attendance.locator('.attendance-title small').innerText()).match(/\+(\d+)G/)![1]);
  await attendance.getByRole('button', { name: '받기', exact: true }).click();
  await expect(attendance.locator('.attendance-summary')).toHaveAttribute('aria-expanded', 'false');
  await expect(page.locator('.room-top .gold')).toContainText((beforeGold - 500 + reward).toLocaleString('ko-KR'));
  await page.goto('/#/preview/shop/lotto');
  await expect(page.locator('.game-toolbar .gold')).toContainText((beforeGold - 500 + reward).toLocaleString('ko-KR'));
  await chooseLottoNumbers(page, [6, 7, 8, 9, 10]);
  await page.getByRole('button', { name: '골드로 1장 사기 · 500G', exact: true }).click();
  const finalGold = beforeGold - 1000 + reward;
  await expect(page.locator('.game-toolbar .gold')).toContainText(finalGold.toLocaleString('ko-KR'));
  await captureWidths(page, 'preview-lotto', info, 3);
  await page.goto('/#/preview');
  await expect(page.locator('.room-top .gold')).toContainText(finalGold.toLocaleString('ko-KR'));
  await page.goto('/#/preview/profile');
  await expect(page.locator('.profile-summary .stats')).toContainText(finalGold.toLocaleString('ko-KR'));
  const attendanceLedger = page.locator('.history-row').filter({ hasText: '출석 체크' });
  await expect(attendanceLedger).toHaveCount(1);
  await expect(attendanceLedger).toContainText(`+${reward}G`);
  await page.goto('/#/preview/shop/speetto');
  await page.getByRole('button', { name: '골드로 1장 사기 · 300G', exact: true }).click();
  await expect(page.locator('.scratch-card')).toBeVisible();
  await page.getByRole('button', { name: '한 번에 열기', exact: true }).click();
  await expect(page.locator('.scratch-result')).not.toHaveText('?');
  expect(await page.locator('.scratch-symbols').evaluate(element => element.getAnimations({ subtree: true }).some(animation => animation.effect?.getTiming().iterations === Infinity))).toBe(false);
  await captureWidths(page, 'preview-speetto', info, 3);
  expect(requests).toEqual([]);
});

test('kuji grade modals close accessibly and a multi-purchase updates real gold, score and tickets', async ({ page }, info) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await login(page, 'min');
  await page.goto('/#/shop');
  await expect(page.locator('.inventory-card')).toContainText('데일리 로또 이용권');
  await expect(page.locator('.inventory-card')).toContainText('스피또 이용권');
  await captureWidths(page, 'authenticated-shop', info, 3);
  await page.goto('/#/play/kuji');
  const before = await snapshot(page);
  const shopBefore = await shopSnapshot<KujiResponse>(page, 'kuji');
  await expect(page.locator('.pg-kuji-heading')).toContainText(`제${shopBefore.kuji.boardId}판`);
  await page.getByRole('button', { name: 'A상 보상 보기', exact: true }).click();
  const grade = page.getByRole('dialog', { name: 'A상 보상', exact: true });
  await expect(grade).toContainText('+10점');
  await expect(grade).toContainText('+100G');
  await grade.getByRole('button', { name: '닫기', exact: true }).click();
  await expect(grade).toHaveCount(0);
  await page.getByRole('button', { name: '라스트원 보상 보기', exact: true }).click();
  const last = page.getByRole('dialog', { name: '라스트원 보상', exact: true });
  await expect(last).toContainText('1,000G');
  await page.keyboard.press('Escape');
  await expect(last).toHaveCount(0);
  await page.getByRole('button', { name: 'A상 보상 보기', exact: true }).click();
  await page.mouse.click(5, 5);
  await expect(grade).toHaveCount(0);
  const positions = shopBefore.kuji.cells.filter(cell => cell.grade === null).slice(0, 2).map(cell => cell.position);
  for (const position of positions) await page.getByRole('button', { name: `${position + 1}번 쿠지`, exact: true }).click();
  await expect(page.getByRole('button', { name: '2장 뽑기 · 600G', exact: true })).toBeEnabled();
  const purchased = purchaseResponse(page, 'kuji');
  await page.getByRole('button', { name: '2장 뽑기 · 600G', exact: true }).click();
  const response = await purchased;
  expect(response.status()).toBe(200);
  const data = await response.json() as KujiResponse;
  expect(data.purchase).toBeDefined();
  expect(data.purchase!.cost).toBe(600);
  expect(data.purchase!.reward).toEqual({ gold: 100, score: 10, lottoTickets: 3, speettoTickets: 0 });
  expect(data.purchase!.cells.map(cell => cell.position).sort()).toEqual([...positions].sort());
  const receipt = page.getByRole('dialog', { name: '뽑은 쿠지', exact: true });
  await expect(receipt.locator('.kuji-ticket')).toHaveCount(2);
  await expect(receipt).toContainText('받은 보상');
  await receipt.getByRole('button', { name: '닫기', exact: true }).click();
  const after = await snapshot(page);
  expect(after.user.gold).toBe(before.user.gold - 600 + data.purchase!.reward.gold);
  expect(after.user.weeklyScore).toBe(before.user.weeklyScore + data.purchase!.reward.score);
  expect(after.inventory.lottoTickets).toBe(before.inventory.lottoTickets + data.purchase!.reward.lottoTickets);
  expect(after.inventory.speettoTickets).toBe(before.inventory.speettoTickets + data.purchase!.reward.speettoTickets);
  for (const cell of data.purchase!.cells) {
    await expect(page.getByRole('button', { name: `${cell.position + 1}번 쿠지, 이미 뽑힌 ${cell.grade}상`, exact: true })).toBeDisabled();
  }
  await expect(page.locator('.game-toolbar .gold')).toContainText(after.user.gold.toLocaleString('ko-KR'));
  await captureWidths(page, 'authenticated-kuji', info, 3);
  await page.goto('/#/');
  await expect(page.locator('.room-top .gold')).toContainText(after.user.gold.toLocaleString('ko-KR'));
  await expect(page.locator('.home-score strong').first()).toHaveText(String(after.user.weeklyScore));
  await page.goto('/#/profile');
  await expect(page.locator('.history-row').filter({ hasText: '예굼쿠지 구매' }).first()).toContainText('600G');
  await page.getByRole('tab', { name: '점수', exact: true }).click();
  await expect(page.locator('.history-row').filter({ hasText: '예굼쿠지 등급 보상' }).first()).toContainText('+10점');
});

test('daily lotto shows past winnings and retries a lost purchase response once across navigation and reload', async ({ page }, info) => {
  test.setTimeout(60000);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await login(page, 'yeseo');
  await page.goto('/#/shop/lotto');
  await expect(page.getByRole('heading', { name: '데일리 로또', exact: true })).toBeVisible();
  const history = page.locator(`.ticket[data-ticket-id="${SAVED_LOTTO_ID}"]`);
  await expect(history).toContainText('1등 · 5개 일치');
  await expect(history).toContainText('+5,000G');
  await expect(page.locator('.lotto-target')).toContainText('2026-10-30');
  const before = await shopSnapshot<LottoResponse>(page, 'lotto');
  const attempts: LottoPurchaseInput[] = [];
  let dropped = false;
  await page.route('**/api/shop/lotto', async route => {
    if (route.request().method() !== 'POST') return route.continue();
    attempts.push(route.request().postDataJSON() as LottoPurchaseInput);
    if (!dropped) {
      dropped = true;
      const committed = await route.fetch();
      expect(committed.status()).toBe(200);
      await route.abort('failed');
    } else await route.continue();
  });
  await chooseLottoNumbers(page, [1, 2, 3, 4, 5]);
  await page.getByRole('button', { name: '번호 6', exact: true }).click();
  await expect(page.getByRole('button', { name: '번호 6', exact: true })).toHaveAttribute('aria-pressed', 'false');
  await page.getByRole('button', { name: '이용권으로 1장 사기', exact: true }).click();
  await expect(page.getByRole('alert')).toBeVisible();
  await expect(page.getByRole('button', { name: '번호 1', exact: true })).toBeDisabled();
  const committed = await shopSnapshot<LottoResponse>(page, 'lotto');
  expect(committed.inventory.lottoTickets).toBe(before.inventory.lottoTickets - 1);
  expect(committed.gold).toBe(before.gold);
  expect(committed.lotto.tickets).toHaveLength(before.lotto.tickets.length + 1);
  await page.goto('/#/shop');
  await page.goto('/#/shop/lotto');
  await page.reload();
  await expect(page.getByRole('button', { name: '번호 1', exact: true })).toBeDisabled();
  const retried = purchaseResponse(page, 'lotto');
  await page.getByRole('button', { name: '이용권으로 1장 사기', exact: true }).click();
  expect((await retried).status()).toBe(200);
  await expect(page.getByRole('button', { name: '번호 1', exact: true })).toBeEnabled();
  expect(attempts).toHaveLength(2);
  expect(attempts[1]).toEqual(attempts[0]);
  const afterRetry = await shopSnapshot<LottoResponse>(page, 'lotto');
  expect(afterRetry.inventory.lottoTickets).toBe(before.inventory.lottoTickets - 1);
  expect(afterRetry.lotto.tickets).toHaveLength(before.lotto.tickets.length + 1);
  await chooseLottoNumbers(page, [6, 7, 8, 9, 10]);
  const paid = purchaseResponse(page, 'lotto');
  await page.getByRole('button', { name: '골드로 1장 사기 · 500G', exact: true }).click();
  const paidResponse = await paid;
  expect(paidResponse.status()).toBe(200);
  const paidData = await paidResponse.json() as LottoResponse;
  expect(paidData.purchase).toMatchObject({ payment: 'gold', cost: 500, drawDate: '2026-10-30', numbers: [6, 7, 8, 9, 10] });
  await expect(page.locator(`.ticket[data-ticket-id="${paidData.purchase!.id}"]`)).toContainText('추첨 대기');
  expect((await snapshot(page)).user.gold).toBe(before.gold - 500);
  await captureWidths(page, 'authenticated-lotto', info, 3);
  await page.goto('/#/profile');
  await expect(page.locator('.history-row').filter({ hasText: '데일리 로또 1등' })).toContainText('+5,000G');
  await expect(page.locator('.history-row').filter({ hasText: '데일리 로또 구매' }).first()).toContainText('500G');
});

test('speetto pays at purchase, restores owned tickets after leaving and scratching never changes the balance', async ({ page }, info) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await login(page, 'siwon');
  await page.goto('/#/shop/speetto');
  await expect(page.locator('.scratch-card')).toHaveAttribute('data-ticket-id', SAVED_SPEETTO_ID);
  await expect(page.locator('.scratch-result')).toHaveText('?');
  const restored = await shopSnapshot<SpeettoResponse>(page, 'speetto');
  expect(restored.speetto.tickets[0]).toMatchObject({ id: SAVED_SPEETTO_ID, won: true, prize: 1500 });
  await page.goto('/#/shop');
  await page.goto('/#/shop/speetto');
  await expect(page.locator('.scratch-card')).toHaveAttribute('data-ticket-id', SAVED_SPEETTO_ID);
  await page.getByRole('button', { name: '한 번에 열기', exact: true }).click();
  await expect(page.locator('.scratch-result')).toHaveText('당첨! +1,500G');
  expect((await snapshot(page)).user.gold).toBe(restored.gold);
  await captureWidths(page, 'authenticated-speetto', info, 3);
  const paid = purchaseResponse(page, 'speetto');
  await page.getByRole('button', { name: '골드로 1장 사기 · 300G', exact: true }).click();
  const response = await paid;
  expect(response.status()).toBe(200);
  const data = await response.json() as SpeettoResponse;
  const ticket = data.purchase!;
  expect(ticket).toMatchObject({ payment: 'gold', cost: 300 });
  expect(ticket.cells).toHaveLength(3);
  expect(ticket.prize).toBe(ticket.won ? 1500 : 0);
  expect(new Set(ticket.cells).size === 1).toBe(ticket.won);
  await expect(page.locator('.scratch-card')).toHaveAttribute('data-ticket-id', ticket.id);
  await expect(page.locator('.scratch-result')).toHaveText('?');
  expect((await snapshot(page)).user.gold).toBe(restored.gold - 300 + ticket.prize);
  await page.goto('/#/shop');
  await page.goto('/#/shop/speetto');
  await page.reload();
  await expect(page.locator('.scratch-card')).toHaveAttribute('data-ticket-id', ticket.id);
  const afterPurchase = (await snapshot(page)).user.gold;
  await page.getByRole('button', { name: '한 번에 열기', exact: true }).click();
  await expect(page.locator('.scratch-result')).toHaveText(ticket.won ? '당첨! +1,500G' : '아쉽지만 낙첨이에요');
  expect((await snapshot(page)).user.gold).toBe(afterPurchase);
  const coupon = purchaseResponse(page, 'speetto');
  await page.getByRole('button', { name: '이용권으로 1장 사기', exact: true }).click();
  const couponData = await (await coupon).json() as SpeettoResponse;
  expect(couponData.purchase).toMatchObject({ payment: 'ticket', cost: 0 });
  expect(couponData.inventory.speettoTickets).toBe(restored.inventory.speettoTickets - 1);
  expect((await snapshot(page)).user.gold).toBe(afterPurchase + couponData.purchase!.prize);
});

test('administrators cannot purchase any shop item through UI or API', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await login(page, 'admin');
  const before = await snapshot(page);
  const kuji = await shopSnapshot<KujiResponse>(page, 'kuji');
  for (const [route, selector] of [
    ['/play/kuji', '.pg-kuji-board button'],
    ['/shop/lotto', '.shop-purchase-actions button'],
    ['/shop/speetto', '.shop-purchase-actions button'],
  ]) {
    await page.goto(`/#${route}`);
    await expect(page.locator(selector).first()).toBeVisible();
    await expect(page.locator(selector).first()).toBeDisabled();
    await expect(page.locator('main')).toContainText('운영자 계정은');
  }
  for (const [kind, input] of [
    ['kuji', { boardId: kuji.kuji.boardId, positions: [99] }],
    ['lotto', { numbers: [1, 2, 3, 4, 5], payment: 'gold' }],
    ['speetto', { payment: 'gold' }],
  ] as const) {
    const response = await page.request.post(`/api/shop/${kind}`, { data: { requestId: crypto.randomUUID(), ...input }, headers: { Origin: new URL(page.url()).origin } });
    expect(response.status()).toBe(403);
  }
  const after = await snapshot(page);
  expect(after.user.gold).toBe(before.user.gold);
  expect(after.inventory).toEqual(before.inventory);
});

for (const outcome of ['success', 'conflict'] as const) {
  test(`opening another shop during a delayed kuji ${outcome} still loads the new screen`, async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await login(page, 'min');
    await page.goto('/#/play/kuji');
    const board = await shopSnapshot<KujiResponse>(page, 'kuji');
    const position = board.kuji.cells.find(cell => cell.grade === null)!.position;
    let held = false;
    let release: () => void = () => {};
    const gate = new Promise<void>(resolve => { release = resolve; });
    await page.route('**/api/shop/kuji', async route => {
      if (route.request().method() !== 'POST') return route.continue();
      held = true;
      await gate;
      const response = await route.fetch();
      await route.fulfill({ response });
    });
    try {
      await page.getByRole('button', { name: `${position + 1}번 쿠지`, exact: true }).click();
      const completed = purchaseResponse(page, 'kuji');
      await page.getByRole('button', { name: /^1장 뽑기/ }).click();
      await expect.poll(() => held).toBe(true);
      await page.goto('/#/shop/speetto');
      await expect(page.getByRole('heading', { name: '스피또', exact: true })).toBeVisible();
      await expect(page.getByRole('button', { name: '골드로 1장 사기 · 300G', exact: true })).toBeDisabled();
      if (outcome === 'conflict') {
        // A second HTTP client takes the selected cell while the browser's
        // original purchase is in flight. Its later response is a real 409.
        const competitor = await page.request.post('/api/shop/kuji', {
          data: { requestId: crypto.randomUUID(), boardId: board.kuji.boardId, positions: [position] },
          headers: { Origin: new URL(page.url()).origin },
        });
        expect(competitor.status()).toBe(200);
      }
      const loaded = page.waitForResponse(response => new URL(response.url()).pathname === '/api/shop/speetto' && response.request().method() === 'GET', { timeout: 5000 });
      release();
      expect((await completed).status()).toBe(outcome === 'success' ? 200 : 409);
      expect((await loaded).status()).toBe(200);
      await expect(page.getByRole('button', { name: '골드로 1장 사기 · 300G', exact: true })).toBeEnabled();
      await expect(page.locator('.inventory-card')).toContainText('스피또 이용권');
    } finally { release(); }
  });
}

test('a shop read refreshes home and profile after a purchase by another HTTP client', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await login(page, 'min');
  const before = await snapshot(page);
  await expect(page.locator('.room-top .gold')).toContainText(before.user.gold.toLocaleString('ko-KR'));
  const external = await page.request.post('/api/shop/lotto', {
    data: { requestId: crypto.randomUUID(), numbers: [16, 17, 18, 19, 20], payment: 'gold' },
    headers: { Origin: new URL(page.url()).origin },
  });
  expect(external.status()).toBe(200);
  const receipt = await external.json() as LottoResponse;
  expect(receipt.gold).toBe(before.user.gold - 500);
  // APIRequestContext does not update React state: the view still has its
  // original balance until entering the shop reads the new server state.
  await expect(page.locator('.room-top .gold')).toContainText(before.user.gold.toLocaleString('ko-KR'));
  const refreshed = page.waitForResponse(response => new URL(response.url()).pathname === '/api/bootstrap', { timeout: 5000 });
  await page.goto('/#/shop');
  expect((await refreshed).status()).toBe(200);
  await page.goto('/#/');
  await expect(page.locator('.room-top .gold')).toContainText(receipt.gold.toLocaleString('ko-KR'));
  await page.goto('/#/profile');
  await expect(page.locator('.profile-summary .stats')).toContainText(receipt.gold.toLocaleString('ko-KR'));
  await expect(page.locator('.history-row').filter({ hasText: '데일리 로또 구매' }).first()).toContainText('500G');
});


async function catchmindState(page: Page) {
  const response = await page.request.get('/api/catchmind');
  expect(response.status()).toBe(200);
  return (await response.json() as CatchmindResponse).catchmind;
}
function catchmindResponse(page: Page, action: string) {
  return page.waitForResponse(response => new URL(response.url()).pathname === `/api/catchmind/${action}` && response.request().method() === 'POST');
}
async function canvasPoint(page: Page, x: number, y: number) {
  const box = await page.getByLabel('그림 그리는 캔버스', { exact: true }).boundingBox();
  expect(box).not.toBeNull();
  return { x: box!.x + box!.width * x, y: box!.y + box!.height * y };
}
async function drawStroke(page: Page, points: [number, number][]) {
  await page.getByLabel('그림 그리는 캔버스', { exact: true }).scrollIntoViewIfNeeded();
  const first = await canvasPoint(page, ...points[0]);
  await page.mouse.move(first.x, first.y);
  await page.mouse.down();
  for (const [x, y] of points.slice(1)) {
    const point = await canvasPoint(page, x, y);
    await page.mouse.move(point.x, point.y, { steps: 8 });
  }
  await page.mouse.up();
}
async function clickCanvas(page: Page, x: number, y: number) {
  await page.getByLabel('그림 그리는 캔버스', { exact: true }).scrollIntoViewIfNeeded();
  const point = await canvasPoint(page, x, y);
  await page.mouse.click(point.x, point.y);
}
async function canvasPixel(page: Page, x: number, y: number) {
  return page.getByLabel('그림 그리는 캔버스', { exact: true }).evaluate((element, point) => {
    const canvas = element as HTMLCanvasElement;
    return Array.from(canvas.getContext('2d')!.getImageData(Math.floor(canvas.width * point.x), Math.floor(canvas.height * point.y), 1, 1).data);
  }, { x, y });
}
async function openPicker(page: Page) {
  await page.getByRole('button', { name: '색상 고르기', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '색상 고르기', exact: true });
  await expect(dialog).toBeVisible();
  return dialog;
}
async function setDrawingColor(page: Page, hex: string) {
  const dialog = await openPicker(page);
  await dialog.getByRole('textbox', { name: 'HEX 색상', exact: true }).fill(hex);
  await dialog.getByRole('button', { name: '색상 선택 닫기', exact: true }).click();
  await expect(dialog).toHaveCount(0);
}
async function sliderArrow(slider: Locator, key: string, count = 1) {
  await slider.focus();
  for (let index = 0; index < count; index++) await slider.press(key);
}
async function guessCatchmind(page: Page, answer: string) {
  await page.getByRole('textbox', { name: '캐치마인드 정답', exact: true }).fill(answer);
  await page.getByRole('button', { name: '정답', exact: true }).click();
}
async function previewDrawing(page: Page) {
  await page.goto('/#/preview/play/catchmind');
  await guessCatchmind(page, '선 인 장');
  await expect(page.locator('.pg-winner')).toBeVisible();
  await page.getByRole('button', { name: '다음 그림 그리기', exact: true }).click();
  await expect(page.getByLabel('그림 그리는 캔버스', { exact: true })).toBeVisible();
}


test('catchmind preview keeps hints, rewards, drawing tools and color selection local', async ({ page }, info) => {
  test.setTimeout(90000);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const requests: string[] = [];
  await page.route('**/api/**', route => { requests.push(route.request().url()); return route.abort(); });
  await page.addInitScript(() => localStorage.setItem('yegoom3:preview:character:yeseo', 'cat'));
  await page.goto('/#/preview');
  const beforeScore = Number(await page.locator('.home-score strong').first().innerText());
  await page.goto('/#/preview/play/catchmind');
  const beforeGold = await displayedGold(page, '.game-toolbar .gold');
  await guessCatchmind(page, '브라우저 오답');
  await expect(page.locator('.pg-hint')).toContainText('선');
  await captureWidths(page, 'preview-hint', info, 4);
  await guessCatchmind(page, '선 인 장');
  await expect(page.locator('.pg-winner')).toContainText('3점');
  await expect(page.locator('.pg-winner')).toContainText('5G');
  await expect(page.locator('.pg-winner [data-character="cat"]')).toBeVisible();
  await expect(page.locator('.pg-next-player [data-character="cat"]')).toBeVisible();
  await expect(page.locator('.game-toolbar .gold')).toContainText((beforeGold + 5).toLocaleString('ko-KR'));
  await captureWidths(page, 'preview-result', info, 4);
  await page.goto('/#/preview');
  await expect(page.locator('.room-top .gold')).toContainText((beforeGold + 5).toLocaleString('ko-KR'));
  await expect(page.locator('.home-score strong').first()).toHaveText(String(beforeScore + 3));
  await page.goto('/#/preview/profile');
  const rewardRows = page.locator('.history-row').filter({ hasText: '캐치마인드 정답' });
  await expect(rewardRows).toHaveCount(1);
  await expect(rewardRows).toContainText('+5G');
  await page.getByRole('tab', { name: '점수', exact: true }).click();
  await expect(rewardRows).toHaveCount(1);
  await expect(rewardRows).toContainText('+3점');
  await page.goto('/#/preview/shop/lotto');
  await expect(page.locator('.game-toolbar .gold')).toContainText((beforeGold + 5).toLocaleString('ko-KR'));
  await chooseLottoNumbers(page, [1, 2, 3, 4, 5]);
  await page.getByRole('button', { name: '골드로 1장 사기 · 500G', exact: true }).click();
  await expect(page.locator('.game-toolbar .gold')).toContainText((beforeGold + 5 - 500).toLocaleString('ko-KR'));
  await page.goto('/#/preview');
  await expect(page.locator('.room-top .gold')).toContainText((beforeGold + 5 - 500).toLocaleString('ko-KR'));
  await expect(page.locator('.home-score strong').first()).toHaveText(String(beforeScore + 3));
  await page.goto('/#/preview/play/catchmind');
  await expect(page.locator('.game-toolbar .gold')).toContainText((beforeGold + 5 - 500).toLocaleString('ko-KR'));
  await page.getByRole('button', { name: '다음 그림 그리기', exact: true }).click();
  const canvas = page.getByLabel('그림 그리는 캔버스', { exact: true });
  await expect(canvas).toBeVisible();
  await expect(canvas).toHaveAttribute('data-notouchfx');
  expect(await canvas.evaluate(element => getComputedStyle(element).touchAction)).toBe('none');
  expect(await canvas.evaluate(element => {
    const image = element as HTMLCanvasElement;
    return image.width === image.height;
  })).toBe(true);
  const background = await canvasPixel(page, .05, .05);
  expect(background).toEqual([255, 253, 248, 255]);
  for (const name of ['펜', '지우개', '채우기']) {
    const tool = page.getByRole('button', { name, exact: true });
    await expect(tool.locator('svg')).toHaveCount(1);
    await expect(tool).toHaveText('');
  }

  let picker = await openPicker(page);
  await expect(picker).toHaveAttribute('data-notouchfx');
  const selection = picker.getByRole('slider', { name: '채도와 명도', exact: true });
  expect(await selection.evaluate(element => getComputedStyle(element).touchAction)).toBe('none');
  await picker.getByRole('textbox', { name: 'HEX 색상', exact: true }).fill('#FF0000');
  await picker.getByRole('textbox', { name: 'HEX 색상', exact: true }).press('Tab');
  const box = await selection.boundingBox();
  expect(box).not.toBeNull();
  await page.mouse.move(box!.x + box!.width * .25, box!.y + box!.height * .25);
  await page.mouse.down();
  await expect(selection).toHaveAttribute('data-saturation', '25');
  await expect(selection).toHaveAttribute('data-value', '75');
  await page.mouse.move(box!.x + box!.width * .75, box!.y + box!.height * .75, { steps: 5 });
  await page.mouse.up();
  await expect(selection).toHaveAttribute('data-saturation', '75');
  await expect(selection).toHaveAttribute('data-value', '25');
  await selection.press('ArrowRight');
  await selection.press('ArrowUp');
  await expect(selection).toHaveAttribute('data-saturation', '76');
  await expect(selection).toHaveAttribute('data-value', '26');
  const hue = picker.getByRole('slider', { name: '색상', exact: true });
  await sliderArrow(hue, 'Home');
  await sliderArrow(hue, 'ArrowRight', 2);
  await expect(hue).toHaveValue('2');
  const alpha = picker.getByRole('slider', { name: /^불투명도/ });
  await sliderArrow(alpha, 'Home');
  await sliderArrow(alpha, 'ArrowRight', 50);
  await expect(alpha).toHaveValue('50');
  const hex = picker.getByRole('textbox', { name: 'HEX 색상', exact: true });
  await hex.fill('#123456');
  await hex.press('Tab');
  await expect(hex).toHaveValue('#123456');
  await expect(selection).toHaveAttribute('data-saturation', '79');
  await expect(selection).toHaveAttribute('data-value', '34');
  await picker.getByRole('button', { name: '민트 선택', exact: true }).click();
  await expect(hex).toHaveValue('#8FD9C0');
  await expect(selection).toHaveAttribute('data-saturation', '34');
  await expect(selection).toHaveAttribute('data-value', '85');
  const recentHexes = ['#102030', '#203040', '#304050', '#405060', '#506070', '#607080'];
  for (const color of recentHexes) {
    await hex.fill(color);
    await hex.press('Tab');
  }
  const recent = picker.getByRole('group', { name: '최근 색상', exact: true });
  await expect(recent.getByRole('button')).toHaveCount(5);
  await expect(recent.getByRole('button', { name: '최근 색상 #102030', exact: true })).toHaveCount(0);
  await expect(recent.getByRole('button').first()).toHaveAttribute('aria-label', '최근 색상 #607080');
  await recent.getByRole('button', { name: '최근 색상 #203040', exact: true }).click();
  await expect(hex).toHaveValue('#203040');
  await page.keyboard.press('Escape');
  await expect(picker).toHaveCount(0);
  picker = await openPicker(page);
  await expect(picker.getByRole('textbox', { name: 'HEX 색상', exact: true })).toHaveValue('#203040');
  await expect(picker.getByRole('slider', { name: /^불투명도/ })).toHaveValue('50');
  await page.mouse.click(2, 2);
  await expect(picker).toHaveCount(0);

  await setDrawingColor(page, '#FF0000');
  await page.getByRole('button', { name: '펜 두께 3', exact: true }).click();
  await drawStroke(page, [[.2, .3], [.8, .3]]);
  const red = await canvasPixel(page, .53, .3);
  expect(red[0]).toBe(255);
  expect(red[1]).toBeGreaterThanOrEqual(125);
  expect(red[1]).toBeLessThanOrEqual(128);
  expect(red[2]).toBeGreaterThanOrEqual(123);
  expect(red[2]).toBeLessThanOrEqual(125);
  expect(red[3]).toBe(255);
  await page.getByRole('button', { name: '지우개', exact: true }).click();
  await expect(page.getByRole('button', { name: '지우개', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await drawStroke(page, [[.4, .3], [.6, .3]]);
  expect(await canvasPixel(page, .53, .3)).toEqual(background);
  await page.getByRole('button', { name: '한 획 되돌리기', exact: true }).click();
  expect(await canvasPixel(page, .53, .3)).toEqual(red);

  await page.getByRole('button', { name: '펜', exact: true }).click();
  picker = await openPicker(page);
  await picker.getByRole('textbox', { name: 'HEX 색상', exact: true }).fill('#5E6A8A');
  await sliderArrow(picker.getByRole('slider', { name: /^불투명도/ }), 'End');
  await picker.getByRole('button', { name: '색상 선택 닫기', exact: true }).click();
  await drawStroke(page, [[.2, .4], [.8, .4], [.8, .8], [.2, .8], [.2, .4]]);
  picker = await openPicker(page);
  await picker.getByRole('button', { name: '민트 선택', exact: true }).click();
  await sliderArrow(picker.getByRole('slider', { name: /^불투명도/ }), 'Home');
  await sliderArrow(picker.getByRole('slider', { name: /^불투명도/ }), 'ArrowRight', 50);
  await picker.getByRole('button', { name: '색상 선택 닫기', exact: true }).click();
  await page.getByRole('button', { name: '채우기', exact: true }).click();
  await clickCanvas(page, .5, .6);
  expect(await canvasPixel(page, .5, .6)).toEqual([143, 217, 192, 255]);
  expect(await canvasPixel(page, .05, .6)).toEqual(background);
  await page.getByRole('button', { name: '한 획 되돌리기', exact: true }).click();
  expect(await canvasPixel(page, .5, .6)).toEqual(background);
  await clickCanvas(page, .5, .6);
  const beforeClear = await canvas.evaluate(element => (element as HTMLCanvasElement).toDataURL());
  await page.getByRole('button', { name: '전체 지우기', exact: true }).click();
  expect(await canvasPixel(page, .5, .6)).toEqual(background);
  await expect(page.getByRole('button', { name: '그림 올리기', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: '한 획 되돌리기', exact: true }).click();
  expect(await canvas.evaluate(element => (element as HTMLCanvasElement).toDataURL())).toBe(beforeClear);
  await expect(page.getByRole('button', { name: '그림 올리기', exact: true })).toBeEnabled();
  await captureWidths(page, 'preview-drawing', info, 4);
  picker = await openPicker(page);
  await expect(picker.getByRole('slider', { name: /^불투명도/ })).toBeDisabled();
  await expect(picker).toContainText('채우기는 불투명');
  await captureWidths(page, 'preview-picker', info, 4);
  await picker.getByRole('button', { name: '색상 선택 닫기', exact: true }).click();
  await expect(picker).toHaveCount(0);
  expect(await page.locator('main').evaluate(element => element.getAnimations({ subtree: true }).some(animation => animation.effect?.getTiming().iterations === Infinity))).toBe(false);
  expect(requests).toEqual([]);
});


test('real catchmind keeps prompts private, publishes a square drawing and pays the first correct player', async ({ page, browser }, info) => {
  test.setTimeout(90000);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await login(page, 'min');
  await page.goto('/#/play/catchmind');
  await page.getByRole('button', { name: '그리기 맡기', exact: true }).click();
  await expect(page.locator('.pg-prompt strong')).not.toHaveText('불러오는 중');
  let state = await catchmindState(page);
  expect(state.round).toMatchObject({ status: 'draft', drawer: { username: 'min' }, rerollsLeft: 3 });
  const other = await browser.newContext({ reducedMotion: 'reduce' });
  try {
    const guesser = await other.newPage();
    await login(guesser, 'yeseo');
    await guesser.goto('/#/play/catchmind');
    await expect(guesser.getByRole('heading', { name: 'min이 그림을 그리고 있어요', exact: true })).toBeVisible();
    for (const remaining of [3, 2, 1]) {
      const changed = catchmindResponse(page, 'reroll');
      await page.getByRole('button', { name: `제시어 바꾸기 (${remaining}회 남음)`, exact: true }).click();
      expect((await changed).status()).toBe(200);
      await expect(page.getByRole('button', { name: `제시어 바꾸기 (${remaining - 1}회 남음)`, exact: true })).toBeVisible();
    }
    await expect(page.getByRole('button', { name: '제시어 바꾸기 (0회 남음)', exact: true })).toBeDisabled();
    state = await catchmindState(page);
    const word = state.round!.word!;
    expect(word.length).toBeGreaterThan(0);
    await expect(page.locator('.pg-prompt strong')).toHaveText(word);
    const secret = await catchmindState(guesser);
    expect(secret.round).toMatchObject({ status: 'draft', word: null });
    expect(JSON.stringify(secret)).not.toContain(JSON.stringify(word));
    await expect(guesser.locator('.pg-prompt')).toHaveCount(0);
    await expect(guesser.getByLabel('그림 그리는 캔버스', { exact: true })).toHaveCount(0);

    await page.getByRole('button', { name: '펜 두께 3', exact: true }).click();
    await drawStroke(page, [[.25, .2], [.75, .2], [.75, .75], [.25, .75], [.25, .2]]);
    await setDrawingColor(page, '#8FD9C0');
    await page.getByRole('button', { name: '채우기', exact: true }).click();
    await clickCanvas(page, .5, .5);
    await captureWidths(page, 'authenticated-drawing', info, 4);
    await page.getByRole('button', { name: '펜', exact: true }).click();
    const picker = await openPicker(page);
    await captureWidths(page, 'authenticated-picker', info, 4);
    await picker.getByRole('button', { name: '색상 선택 닫기', exact: true }).click();
    const published = catchmindResponse(page, 'publish');
    await page.getByRole('button', { name: '그림 올리기', exact: true }).click();
    const publishResponse = await published;
    expect(publishResponse.status()).toBe(200);
    const payload = publishResponse.request().postDataJSON() as { image: string; wordVersion: number };
    expect(payload.image).toMatch(/^data:image\/(png|webp);base64,/);
    expect(Buffer.from(payload.image.split(',')[1], 'base64').byteLength).toBeLessThanOrEqual(300 * 1024);
    expect(payload.wordVersion).toBe(state.round!.wordVersion);
    await expect(page.getByLabel('그림 그리는 캔버스', { exact: true })).toHaveCount(0);
    await expect(page.getByRole('textbox', { name: '캐치마인드 정답', exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: '그림 올리기', exact: true })).toHaveCount(0);
    await guesser.reload();
    const picture = guesser.getByRole('img', { name: 'min이 그린 그림', exact: true });
    await expect(picture).toBeVisible();
    await expect.poll(() => picture.evaluate(element => {
      const image = element as HTMLImageElement;
      return image.complete && image.naturalWidth > 0 && image.naturalWidth === image.naturalHeight;
    })).toBe(true);
    expect((await catchmindState(guesser)).round?.word).toBeNull();
    const before = await snapshot(guesser);
    for (const answer of ['첫 오답', '두 번째 오답', '세 번째 오답']) {
      const guessed = catchmindResponse(guesser, 'guess');
      await guessCatchmind(guesser, answer);
      expect((await guessed).status()).toBe(200);
      await expect(guesser.getByRole('list', { name: '모두의 답', exact: true })).toContainText(answer);
    }
    await expect(guesser.locator('.pg-hint')).toHaveAttribute('aria-label', `첫 글자 힌트: ${Array.from(word)[0]}, ${Array.from(word.replace(/\s/gu, '')).length}글자`);
    expect((await catchmindState(guesser)).round).toMatchObject({ word: null, wrongCount: 3 });
    await captureWidths(guesser, 'authenticated-hint', info, 4);
    const winningAttempts: { requestId: string; answer: string }[] = [];
    let discardWinningResponse = true;
    await guesser.route('**/api/catchmind/guess', async route => {
      winningAttempts.push(route.request().postDataJSON());
      const response = await route.fetch();
      if (discardWinningResponse) { discardWinningResponse = false; await route.abort('failed'); }
      else await route.fulfill({ response });
    });
    await guessCatchmind(guesser, ` ${Array.from(word).join(' ')} `);
    await expect(guesser.getByRole('button', { name: '처리 결과 다시 확인', exact: true })).toBeVisible();
    // The server already paid; navigation/reload must retain the same request identity.
    await guesser.goto('/#/profile');
    await guesser.goto('/#/play/catchmind');
    await guesser.reload();
    await expect(guesser.locator('.pg-winner')).toContainText('yeseo');
    const retried = catchmindResponse(guesser, 'guess');
    await guesser.getByRole('button', { name: '처리 결과 다시 확인', exact: true }).click();
    expect((await retried).status()).toBe(200);
    expect(winningAttempts).toHaveLength(2);
    expect(winningAttempts[1]).toEqual(winningAttempts[0]);
    await expect(guesser.getByRole('button', { name: '처리 결과 다시 확인', exact: true })).toHaveCount(0);
    await expect(guesser.getByRole('list', { name: '모두의 답', exact: true }).getByRole('listitem')).toHaveCount(4);
    await expect(guesser.locator('.pg-winner')).toContainText('yeseo');
    await expect(guesser.locator('.pg-winner')).toContainText('+3점');
    await expect(guesser.locator('.pg-winner')).toContainText('+5G');
    const after = await snapshot(guesser);
    expect(after.user.gold).toBe(before.user.gold + 5);
    expect(after.user.weeklyScore).toBe(before.user.weeklyScore + 3);
    const ended = await catchmindState(guesser);
    expect(ended.round).toMatchObject({ status: 'ended', word, endReason: 'correct', winner: { username: 'yeseo' } });
    expect(ended.turn?.username).toBe('yeseo');
    await expect(guesser.locator('.game-toolbar .gold')).toContainText(after.user.gold.toLocaleString('ko-KR'));
    await captureWidths(guesser, 'authenticated-result', info, 4);
    await page.reload();
    await expect(page.locator('.pg-winner')).toContainText('yeseo');
    await expect(page.getByRole('button', { name: '다음 그림 그리기', exact: true })).toHaveCount(0);
    await guesser.goto('/#/profile');
    await expect(guesser.locator('.history-row').filter({ hasText: '캐치마인드' }).first()).toContainText('+5G');
    await guesser.getByRole('tab', { name: '점수', exact: true }).click();
    await expect(guesser.locator('.history-row').filter({ hasText: '캐치마인드' }).first()).toContainText('+3점');
    await guesser.goto('/#/play/catchmind');
    await guesser.getByRole('button', { name: '다음 그림 그리기', exact: true }).click();
    await expect(guesser.locator('.pg-prompt strong')).toBeVisible();
    expect((await catchmindState(guesser)).round).toMatchObject({ status: 'draft', drawer: { username: 'yeseo' }, rerollsLeft: 3 });
  } finally { await other.close(); }
});

test('six misses and a manual end keep the drawer turn without awarding gold or points', async ({ page, browser }) => {
  test.setTimeout(60000);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await login(page, 'yeseo');
  await page.goto('/#/play/catchmind');
  await expect(page.getByLabel('그림 그리는 캔버스', { exact: true })).toBeVisible();
  await drawStroke(page, [[.25, .25], [.75, .75]]);
  await page.getByRole('button', { name: '그림 올리기', exact: true }).click();
  await expect(page.getByRole('img', { name: 'yeseo이 그린 그림', exact: true })).toBeVisible();
  const other = await browser.newContext({ reducedMotion: 'reduce' });
  try {
    const guesser = await other.newPage();
    await login(guesser, 'min');
    await guesser.goto('/#/play/catchmind');
    const before = await snapshot(guesser);
    const drawerBefore = await snapshot(page);
    for (let count = 1; count <= 6; count++) {
      const guessed = catchmindResponse(guesser, 'guess');
      await guessCatchmind(guesser, `정답 아닌 문장 ${count}`);
      expect((await guessed).status()).toBe(200);
      await expect(guesser.getByRole('list', { name: '모두의 답', exact: true }).getByRole('listitem')).toHaveCount(count);
      if (count === 2) await expect(guesser.locator('.pg-hint')).toHaveCount(0);
      if (count === 3) await expect(guesser.locator('.pg-hint')).toBeVisible();
    }
    await expect(guesser.locator('.pg-ended')).toContainText('아무도 맞히지 못했어요');
    await expect(guesser.getByRole('textbox', { name: '캐치마인드 정답', exact: true })).toHaveCount(0);
    const ended = await catchmindState(guesser);
    expect(ended.round).toMatchObject({ status: 'ended', endReason: 'misses', wrongCount: 6, winner: null });
    expect(ended.turn?.username).toBe('yeseo');
    const after = await snapshot(guesser);
    expect(after.user.gold).toBe(before.user.gold);
    expect(after.user.weeklyScore).toBe(before.user.weeklyScore);
    await page.reload();
    await page.getByRole('button', { name: '다음 그림 그리기', exact: true }).click();
    await expect(page.locator('.pg-prompt strong')).toBeVisible();
    await drawStroke(page, [[.25, .75], [.75, .25]]);
    await page.getByRole('button', { name: '그림 올리기', exact: true }).click();
    await expect(page.getByRole('img', { name: 'yeseo이 그린 그림', exact: true })).toBeVisible();
    await page.getByRole('button', { name: '이번 판 끝내기', exact: true }).click();
    const confirmation = page.getByRole('dialog', { name: '이번 판을 끝낼까요?', exact: true });
    await confirmation.getByRole('button', { name: '취소', exact: true }).click();
    await expect(confirmation).not.toBeVisible();
    expect((await catchmindState(page)).round?.status).toBe('open');
    await page.getByRole('button', { name: '이번 판 끝내기', exact: true }).click();
    await confirmation.getByRole('button', { name: '판 종료', exact: true }).click();
    await expect(page.locator('.pg-ended')).toContainText('출제자가 판을 마쳤어요');
    const manual = await catchmindState(page);
    expect(manual.round).toMatchObject({ status: 'ended', endReason: 'manual', winner: null });
    expect(manual.turn?.username).toBe('yeseo');
    const drawerAfter = await snapshot(page);
    expect(drawerAfter.user.gold).toBe(drawerBefore.user.gold);
    expect(drawerAfter.user.weeklyScore).toBe(drawerBefore.user.weeklyScore);
  } finally { await other.close(); }
});


test('color picker releases active drags across closing and canvas rerenders, including touch input', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const requests: string[] = [];
  await page.route('**/api/**', route => { requests.push(route.request().url()); return route.abort(); });
  await previewDrawing(page);
  let picker = await openPicker(page);
  let selection = picker.getByRole('slider', { name: '채도와 명도', exact: true });
  let box = await selection.boundingBox();
  await page.mouse.move(box!.x + box!.width * .3, box!.y + box!.height * .4);
  await page.mouse.down();
  const chosen = await picker.getByRole('textbox', { name: 'HEX 색상', exact: true }).inputValue();
  await page.keyboard.press('Escape');
  await expect(picker).toHaveCount(0);
  await page.mouse.move(5, 5);
  await page.mouse.up();
  picker = await openPicker(page);
  await expect(picker.getByRole('textbox', { name: 'HEX 색상', exact: true })).toHaveValue(chosen);
  await picker.getByRole('button', { name: '색상 선택 닫기', exact: true }).click();
  await page.getByRole('button', { name: '제시어 바꾸기 (3회 남음)', exact: true }).click();
  await expect(page.getByRole('button', { name: '제시어 바꾸기 (2회 남음)', exact: true })).toBeVisible();
  picker = await openPicker(page);
  await expect(picker.getByRole('textbox', { name: 'HEX 색상', exact: true })).toHaveValue('#5E6A8A');
  selection = picker.getByRole('slider', { name: '채도와 명도', exact: true });
  box = await selection.boundingBox();
  const session = await page.context().newCDPSession(page);
  await session.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 1 });
  await session.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: box!.x + box!.width * .2, y: box!.y + box!.height * .2 }] });
  await session.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: box!.x + box!.width * .8, y: box!.y + box!.height * .7 }] });
  await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await expect(selection).toHaveAttribute('data-saturation', '80');
  await expect(selection).toHaveAttribute('data-value', '30');
  await session.send('Emulation.setTouchEmulationEnabled', { enabled: false });
  await session.detach();
  await picker.getByRole('button', { name: '색상 선택 닫기', exact: true }).click();
  expect(requests).toEqual([]);
});

test('catchmind polls every five visible seconds and stops while hidden or after leaving', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await login(page, 'siwon');
  await page.clock.install({ time: new Date(TEST_NOW) });
  await page.clock.pauseAt(new Date('2026-10-30T00:00:01Z'));
  let requests = 0;
  page.on('request', request => {
    if (new URL(request.url()).pathname === '/api/catchmind' && request.method() === 'GET') requests++;
  });
  const initial = page.waitForResponse(response => new URL(response.url()).pathname === '/api/catchmind' && response.request().method() === 'GET');
  await page.goto('/#/play/catchmind');
  await initial;
  await expect(page.locator('.cm-round-label')).toBeVisible();
  const first = requests;
  await page.clock.runFor(4999);
  expect(requests).toBe(first);
  const next = page.waitForResponse(response => new URL(response.url()).pathname === '/api/catchmind' && response.request().method() === 'GET');
  await page.clock.runFor(1);
  await next;
  expect(requests).toBe(first + 1);
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await page.clock.runFor(15000);
  expect(requests).toBe(first + 1);
  const resumed = page.waitForResponse(response => new URL(response.url()).pathname === '/api/catchmind' && response.request().method() === 'GET');
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await resumed;
  expect(requests).toBe(first + 2);
  await page.goto('/#/profile');
  await expect(page.locator('.profile-summary')).toBeVisible();
  await page.clock.runFor(10000);
  expect(requests).toBe(first + 2);
});

test('administrators can view catchmind but cannot take a turn or submit a game action', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await login(page, 'admin');
  await page.goto('/#/play/catchmind');
  await expect(page.locator('main')).toContainText('운영자 계정은 게임에 참여하지 않아요.');
  for (const name of ['그리기 맡기', '다음 그림 그리기', '이번 판 끝내기', '그림 올리기']) {
    await expect(page.getByRole('button', { name, exact: true })).toHaveCount(0);
  }
  await expect(page.getByRole('textbox', { name: '캐치마인드 정답', exact: true })).toHaveCount(0);
  const before = await snapshot(page);
  const state = await catchmindState(page);
  const claim = await page.request.post('/api/catchmind/claim', {
    data: { requestId: crypto.randomUUID(), roundId: state.round?.id ?? null },
    headers: { Origin: new URL(page.url()).origin },
  });
  expect(claim.status()).toBe(403);
  const after = await snapshot(page);
  expect(after.user.gold).toBe(before.user.gold);
  expect(after.user.weeklyScore).toBe(before.user.weeklyScore);
});


async function pauseTouchEffects(page: Page) {
  await page.locator('.fx-touch-effect').evaluateAll(groups => {
    for (const group of groups) for (const animation of group.getAnimations({ subtree: true })) {
      animation.pause();
      animation.currentTime = 60;
    }
  });
}
async function touchPointer(page: Page, options: { selector?: string; x?: number; y?: number; pointerType?: string; button?: number; isPrimary?: boolean; pointerId?: number } = {}) {
  return page.evaluate(options => {
    const target = document.querySelector(options.selector ?? 'main')!;
    const event = new PointerEvent('pointerdown', {
      bubbles: true, composed: true, cancelable: true, isPrimary: true,
      pointerType: 'touch', pointerId: 80, button: 0,
      ...options, clientX: options.x ?? 150, clientY: options.y ?? 250,
    });
    const accepted = target.dispatchEvent(event);
    for (const group of document.querySelectorAll('.fx-touch-effect')) for (const animation of group.getAnimations({ subtree: true })) {
      animation.pause();
      animation.currentTime = 120;
    }
    return { accepted, prevented: event.defaultPrevented };
  }, options);
}
async function freezeBrowserClock(page: Page) {
  await page.clock.install({ time: new Date(TEST_NOW) });
  await page.clock.pauseAt(new Date('2026-10-30T00:00:01Z'));
}

test('touch feedback uses primary left pointers, respects throttle and bounds, and always cleans up', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await freezeBrowserClock(page);
  await page.goto('/#/preview');
  const effects = page.locator('.fx-touch-effect');
  for (const options of [{ isPrimary: false }, { pointerType: 'mouse', button: 1 }, { pointerType: 'mouse', button: 2 }]) {
    expect(await touchPointer(page, options)).toEqual({ accepted: true, prevented: false });
    await expect(effects).toHaveCount(0);
  }
  expect(await touchPointer(page, { pointerType: 'mouse', button: 0 })).toEqual({ accepted: true, prevented: false });
  await expect(effects).toHaveCount(1);
  await expect(effects.locator('.fx-touch-dot')).toHaveCount(4);
  await expect(effects.locator('.fx-touch-ring')).toHaveCount(1);
  const animations = await effects.evaluate(element => element.getAnimations({ subtree: true }).map(animation => ({
    duration: animation.effect!.getTiming().duration,
    properties: Array.from(new Set((animation.effect as KeyframeEffect).getKeyframes().flatMap(frame => Object.keys(frame).filter(key => !['offset', 'easing', 'composite', 'computedOffset'].includes(key))))).sort(),
  })));
  expect(animations).toHaveLength(5);
  for (const animation of animations) {
    expect(Number(animation.duration)).toBeLessThanOrEqual(400);
    expect(animation.properties).toEqual(['opacity', 'transform']);
  }
  const dimensions = await effects.evaluate(element => ({ width: element.getBoundingClientRect().width, height: element.getBoundingClientRect().height }));
  expect(dimensions).toEqual({ width: 44, height: 44 });
  await touchPointer(page);
  await expect(effects).toHaveCount(1);
  await page.clock.runFor(59);
  await touchPointer(page);
  await expect(effects).toHaveCount(1);
  await page.clock.runFor(1);
  await touchPointer(page);
  await expect(effects).toHaveCount(2);
  await page.clock.runFor(400);
  await expect(effects).toHaveCount(0);

  // A blocked event loop can defer cleanup. Keep timers still while advancing
  // event time to exercise the memory cap, then restore the browser clock.
  const capped = await page.evaluate(() => {
    const original = Object.getOwnPropertyDescriptor(performance, 'now');
    let now = performance.now();
    const first: Element[] = [];
    Object.defineProperty(performance, 'now', { configurable: true, value: () => now });
    try {
      for (let index = 0; index < 10; index++) {
        now += 60;
        document.querySelector('main')!.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, composed: true, isPrimary: true, pointerType: 'touch', pointerId: index + 100, clientX: 80 + index * 5, clientY: 200 }));
        if (index < 2) first.push(document.querySelectorAll('.fx-touch-effect')[index]);
        for (const group of document.querySelectorAll('.fx-touch-effect')) for (const animation of group.getAnimations({ subtree: true })) animation.pause();
      }
      return { count: document.querySelectorAll('.fx-touch-effect').length, evicted: first.every(element => !element.isConnected) };
    } finally {
      if (original) Object.defineProperty(performance, 'now', original);
      else Reflect.deleteProperty(performance, 'now');
    }
  });
  expect(capped).toEqual({ count: 8, evicted: true });
  await page.clock.runFor(400);
  await expect(effects).toHaveCount(0);
  const cdp = await page.context().newCDPSession(page);
  const documentObject = await cdp.send('Runtime.evaluate', { expression: 'document' });
  const listeners = await cdp.send('DOMDebugger.getEventListeners', { objectId: documentObject.result.objectId! });
  expect(listeners.listeners.some(listener => listener.type === 'pointerdown' && listener.useCapture && listener.passive)).toBe(true);
  await cdp.detach();
  expect(await page.locator('.fx-layer').evaluate(element => getComputedStyle(element).pointerEvents)).toBe('none');
});

test('touch feedback creates no nodes for reduced motion or excluded elements and descendants', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await freezeBrowserClock(page);
  await page.goto('/#/preview');
  await touchPointer(page);
  await expect(page.locator('.fx-touch-effect')).toHaveCount(0);
  await expect(page.locator('.fx-layer')).toHaveCount(0);
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await touchPointer(page);
  await expect(page.locator('.fx-touch-effect')).toHaveCount(1);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await expect(page.locator('.fx-touch-effect')).toHaveCount(0);
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.evaluate(() => {
    const fixture = document.createElement('section');
    fixture.id = 'touch-exclusion-fixture';
    fixture.innerHTML = '<input id="touch-input"><textarea id="touch-textarea"></textarea><select id="touch-select"><option id="touch-option">옵션</option></select><canvas id="touch-canvas"></canvas><div contenteditable="true" id="touch-editable"><span id="touch-editable-child">편집</span></div><div contenteditable="false" id="touch-static-editable"><span id="touch-static-child">고정</span></div><div data-notouchfx id="touch-excluded"><button id="touch-excluded-button"><svg><path id="touch-svg-path" d="M0 0h10v10Z"></path></svg></button></div>';
    document.querySelector('main')!.appendChild(fixture);
    const shadowHost = document.createElement('div');
    shadowHost.setAttribute('data-notouchfx', '');
    shadowHost.id = 'touch-shadow-host';
    const shadow = shadowHost.attachShadow({ mode: 'open' });
    shadow.innerHTML = '<span>shadow child</span>';
    fixture.appendChild(shadowHost);
  });
  for (const id of ['input', 'textarea', 'select', 'option', 'canvas', 'editable', 'editable-child', 'static-editable', 'static-child', 'excluded', 'excluded-button', 'svg-path']) {
    await page.clock.runFor(60);
    expect(await touchPointer(page, { selector: `#touch-${id}` })).toEqual({ accepted: true, prevented: false });
    await expect(page.locator('.fx-touch-effect')).toHaveCount(0);
  }
  await page.clock.runFor(60);
  await page.evaluate(() => document.querySelector('#touch-shadow-host')!.shadowRoot!.querySelector('span')!.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, composed: true, isPrimary: true, pointerType: 'touch', pointerId: 81, clientX: 100, clientY: 100 })));
  await expect(page.locator('.fx-touch-effect')).toHaveCount(0);
  await page.evaluate(() => document.querySelector('#touch-exclusion-fixture')!.remove());
});

test('touch feedback leaves scrolling and real canvas and picker drags usable', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  const requests: string[] = [];
  await page.route('**/api/**', route => { requests.push(route.request().url()); return route.abort(); });
  await page.goto('/#/preview');
  await page.mouse.wheel(0, 420);
  await expect.poll(() => page.evaluate(() => scrollY)).toBeGreaterThan(200);
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 1 });
  const previousScroll = await page.evaluate(() => scrollY);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: 5, y: 700 }] });
  for (const y of [650, 550, 450, 350]) await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: 5, y }] });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await expect.poll(() => page.evaluate(() => scrollY)).toBeGreaterThan(previousScroll);
  await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: false });
  await cdp.detach();
  await previewDrawing(page);
  await expect(page.locator('.fx-touch-effect')).toHaveCount(0);
  await page.evaluate(() => {
    const observed = window as typeof window & { touchEffectAdditions: number };
    observed.touchEffectAdditions = 0;
    new MutationObserver(records => {
      for (const record of records) for (const node of record.addedNodes) {
        if (node instanceof Element) observed.touchEffectAdditions += Number(node.matches('.fx-touch-effect')) + node.querySelectorAll('.fx-touch-effect').length;
      }
    }).observe(document.body, { childList: true, subtree: true });
  });
  const before = await canvasPixel(page, .5, .5);
  await drawStroke(page, [[.2, .5], [.8, .5]]);
  expect(await canvasPixel(page, .5, .5)).not.toEqual(before);
  await expect(page.locator('.fx-touch-effect')).toHaveCount(0);
  const picker = await openPicker(page);
  await expect(page.locator('.fx-touch-effect')).toHaveCount(0);
  const selection = picker.getByRole('slider', { name: '채도와 명도', exact: true });
  await picker.locator('.color-picker-sheet').evaluate(element => Promise.all(element.getAnimations().map(animation => animation.finished.catch(() => {}))));
  await selection.click({ trial: true });
  const box = await selection.boundingBox();
  await page.mouse.move(box!.x + box!.width * .2, box!.y + box!.height * .2);
  await page.mouse.down();
  await page.mouse.move(box!.x + box!.width * .8, box!.y + box!.height * .7, { steps: 8 });
  await page.mouse.up();
  await expect(selection).toHaveAttribute('data-saturation', '80');
  await expect(selection).toHaveAttribute('data-value', '30');
  await expect(page.locator('.fx-touch-effect')).toHaveCount(0);
  await picker.getByRole('textbox', { name: 'HEX 색상', exact: true }).fill('#123456');
  await picker.getByRole('textbox', { name: 'HEX 색상', exact: true }).press('Tab');
  await expect(picker.getByRole('textbox', { name: 'HEX 색상', exact: true })).toHaveValue('#123456');
  await expect(page.locator('.fx-touch-effect')).toHaveCount(0);
  expect(await page.evaluate(() => (window as typeof window & { touchEffectAdditions: number }).touchEffectAdditions)).toBe(0);
  expect(requests).toEqual([]);
});

for (const mode of ['preview', 'authenticated'] as const) {
  test(`${mode} touch feedback stays at viewport coordinates across widths and scrolling`, async ({ page }, info) => {
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await freezeBrowserClock(page);
    const requests: string[] = [];
    if (mode === 'preview') {
      await page.route('**/api/**', route => { requests.push(route.request().url()); return route.abort(); });
      await page.goto('/#/preview');
    } else await login(page, 'min');
    await page.clock.runFor(1000);
    await expect(page.locator('.fx-touch-effect')).toHaveCount(0);
    await mkdir('docs/screenshots', { recursive: true });
    for (const width of [390, 560, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      await page.evaluate(() => { scrollTo(0, 0); return document.fonts.ready; });
      await page.clock.runFor(500);
      const point = { x: width / 2 + 35, y: 315 };
      await page.mouse.click(point.x, point.y);
      await pauseTouchEffects(page);
      await expect(page.locator('.fx-touch-effect')).toHaveCount(1);
      const center = await page.locator('.fx-touch-effect').evaluate(element => {
        const bounds = element.getBoundingClientRect();
        return { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 };
      });
      expect(center).toEqual(point);
      expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
      if (width !== 1440) {
        const path = `docs/screenshots/v2-p5-${mode}-touch-${width}.png`;
        await page.screenshot({ path, fullPage: false, animations: 'allow' });
        await info.attach(`${mode}-touch-${width}px`, { path, contentType: 'image/png' });
      }
      await page.clock.runFor(400);
      await page.evaluate(() => scrollTo(0, 500));
      expect(await page.evaluate(() => scrollY)).toBeGreaterThan(0);
      await touchPointer(page, { x: point.x, y: 240 });
      const scrolledCenter = await page.locator('.fx-touch-effect').evaluate(element => {
        const bounds = element.getBoundingClientRect();
        return { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 };
      });
      expect(scrolledCenter).toEqual({ x: point.x, y: 240 });
      await page.clock.runFor(400);
      await touchPointer(page, { x: width - 1, y: 1 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
      await page.clock.runFor(400);
      await expect(page.locator('.fx-touch-effect')).toHaveCount(0);
    }
    if (mode === 'preview') expect(requests).toEqual([]);
  });
}

test('catchmind image URLs decode once, stay out of polls and reuse private HTTP cache', async ({ page }, info) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await login(page, 'siwon');
  await page.evaluate(async () => { await navigator.serviceWorker.ready; });
  await page.reload();
  await expect.poll(() => page.evaluate(() => Boolean(navigator.serviceWorker.controller))).toBe(true);
  let state = await catchmindState(page);
  if (!state.round?.image) {
    const headers = { Origin: new URL(page.url()).origin };
    if (state.round?.drawer.username && state.round.drawer.username !== 'siwon') {
      await page.request.post('/api/auth/logout', { data: {}, headers });
      await login(page, state.round.drawer.username);
    }
    if (!state.round) {
      const claimed = await page.request.post('/api/catchmind/claim', { data: { requestId: crypto.randomUUID(), roundId: null }, headers });
      expect(claimed.status()).toBe(200);
      state = (await claimed.json() as CatchmindResponse).catchmind;
    }
    const image = await page.evaluate(() => {
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = 64;
      const context = canvas.getContext('2d')!;
      context.fillStyle = '#FFFDF8';
      context.fillRect(0, 0, 64, 64);
      context.fillStyle = '#8FD9C0';
      context.fillRect(12, 12, 40, 40);
      return canvas.toDataURL('image/png');
    });
    const published = await page.request.post('/api/catchmind/publish', {
      data: { requestId: crypto.randomUUID(), roundId: state.round!.id, wordVersion: state.round!.wordVersion, image }, headers,
    });
    expect(published.status()).toBe(200);
    state = (await published.json() as CatchmindResponse).catchmind;
  }
  const imagePath = state.round!.image!;
  expect(imagePath).toMatch(/^\/api\/catchmind\/rounds\/[^/]+\/image$/);
  expect(JSON.stringify(state)).not.toContain('data:image');
  const imageUrl = new URL(imagePath, page.url()).href;
  const transfers: { requestId: string; url: string; encodedBytes: number; cached: boolean }[] = [];
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Network.enable');
  await cdp.send('Network.setCacheDisabled', { cacheDisabled: false });
  cdp.on('Network.requestWillBeSent', event => {
    if (event.request.url === imageUrl) transfers.push({ requestId: event.requestId, url: event.request.url, encodedBytes: -1, cached: false });
  });
  cdp.on('Network.requestServedFromCache', event => {
    const transfer = transfers.find(item => item.requestId === event.requestId);
    if (transfer) transfer.cached = true;
  });
  cdp.on('Network.responseReceived', event => {
    const transfer = transfers.find(item => item.requestId === event.requestId);
    if (transfer) transfer.cached ||= Boolean(event.response.fromDiskCache || event.response.fromPrefetchCache);
  });
  cdp.on('Network.loadingFinished', event => {
    const transfer = transfers.find(item => item.requestId === event.requestId);
    if (transfer) transfer.encodedBytes = event.encodedDataLength;
  });
  await freezeBrowserClock(page);
  const loaded = page.waitForResponse(response => response.url() === imageUrl);
  await page.goto('/#/play/catchmind');
  const response = await loaded;
  expect(response.headers()['content-type']).toMatch(/^image\/(png|webp)/);
  expect(response.headers()['cache-control']).toContain('private');
  expect(response.headers()['cache-control']).toContain('immutable');
  expect(response.headers()['vary']).toContain('Cookie');
  const picture = page.locator('.pg-picture img');
  await expect(picture).toHaveAttribute('src', imagePath);
  await expect.poll(() => picture.evaluate(element => {
    const image = element as HTMLImageElement;
    return image.complete && image.naturalWidth > 0 && image.naturalWidth === image.naturalHeight;
  })).toBe(true);
  await expect.poll(() => transfers[0]?.encodedBytes ?? -1).toBeGreaterThan(0);
  const initialBytes = transfers[0].encodedBytes;
  await captureWidths(page, 'authenticated-image', info, 5);
  for (let count = 0; count < 3; count++) {
    const polled = page.waitForResponse(response => new URL(response.url()).pathname === '/api/catchmind' && response.request().method() === 'GET');
    await page.clock.runFor(5000);
    const metadata = await (await polled).json() as CatchmindResponse;
    expect(metadata.catchmind.round?.image).toBe(imagePath);
    expect(JSON.stringify(metadata)).not.toContain('data:image');
    await expect(picture).toHaveAttribute('src', imagePath);
    expect(transfers).toHaveLength(1);
  }
  await page.goto('/#/profile');
  await expect(page.locator('.profile-summary')).toBeVisible();
  await expect(picture).toHaveCount(0);
  await page.goto('/#/play/catchmind');
  await expect.poll(() => picture.evaluate(element => {
    const image = element as HTMLImageElement;
    return image.complete && image.naturalWidth > 0 && image.naturalWidth === image.naturalHeight;
  })).toBe(true);
  // Force an observable second request with normal HTTP caching, even if the
  // img remount reused Chromium's decoded-image memory without a request.
  const cachedRead = await page.evaluate(async path => {
    const response = await fetch(path, { cache: 'default' });
    return { status: response.status, size: (await response.arrayBuffer()).byteLength };
  }, imagePath);
  expect(cachedRead.status).toBe(200);
  expect(cachedRead.size).toBeGreaterThan(0);
  await expect.poll(() => transfers.length).toBeGreaterThan(1);
  await expect.poll(() => transfers.every(transfer => transfer.encodedBytes >= 0)).toBe(true);
  expect(transfers.reduce((total, transfer) => total + transfer.encodedBytes, 0)).toBe(initialBytes);
  expect(transfers.slice(1).some(transfer => transfer.cached)).toBe(true);
  expect(transfers.slice(1).every(transfer => transfer.encodedBytes === 0)).toBe(true);
  const cachedUrls = await page.evaluate(async () => (await Promise.all((await caches.keys()).map(async name => (await (await caches.open(name)).keys()).map(request => request.url)))).flat());
  expect(cachedUrls.some(url => new URL(url).pathname.startsWith('/api/'))).toBe(false);
  const evidencePath = info.outputPath('catchmind-image-transfers.json');
  await writeFile(evidencePath, JSON.stringify({ polls: 3, transfers }, null, 2));
  await info.attach('catchmind-image-transfers', { path: evidencePath, contentType: 'application/json' });
  await cdp.detach();
});

test('touch feedback appears above native dialogs without intercepting focus or clicks', async ({ page }, info) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await freezeBrowserClock(page);
  const requests: string[] = [];
  await page.route('**/api/**', route => { requests.push(route.request().url()); return route.abort(); });
  await page.goto('/#/preview/play/kuji');
  await page.getByRole('button', { name: 'A상 보상 보기', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'A상 보상', exact: true });
  const heading = dialog.getByRole('heading', { name: 'A상 보상', exact: true });
  await heading.click({ trial: true });
  await page.clock.runFor(400);
  await expect(page.locator('.fx-touch-effect')).toHaveCount(0);
  const close = dialog.getByRole('button', { name: '닫기', exact: true });
  await close.focus();
  const box = await heading.boundingBox();
  const point = { x: box!.x + box!.width / 2, y: box!.y + box!.height / 2 };
  expect(await touchPointer(page, { selector: '.kuji-sheet h2', ...point })).toEqual({ accepted: true, prevented: false });
  const effect = page.locator('.fx-touch-effect:popover-open');
  await expect(effect).toHaveCount(1);
  await expect(dialog).toBeVisible();
  expect(await close.evaluate(element => document.activeElement === element)).toBe(true);
  expect(await page.evaluate(point => document.elementFromPoint(point.x, point.y) === document.querySelector('.kuji-sheet h2'), point)).toBe(true);
  const placement = await effect.evaluate(element => {
    const bounds = element.getBoundingClientRect();
    return { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2, width: bounds.width, height: bounds.height, pointerEvents: getComputedStyle(element).pointerEvents, backdropPointerEvents: getComputedStyle(element, '::backdrop').pointerEvents };
  });
  expect(placement).toMatchObject({ width: 44, height: 44, pointerEvents: 'none', backdropPointerEvents: 'none' });
  expect(Math.abs(placement.x - point.x)).toBeLessThanOrEqual(.02);
  expect(Math.abs(placement.y - point.y)).toBeLessThanOrEqual(.02);
  const screenshot = info.outputPath('native-dialog-touch.png');
  await pauseTouchEffects(page);
  await page.screenshot({ path: screenshot, fullPage: false, animations: 'allow' });
  await info.attach('native-dialog-touch', { path: screenshot, contentType: 'image/png' });
  await page.clock.runFor(400);
  await expect(effect).toHaveCount(0);
  await close.click();
  await expect(dialog).toHaveCount(0);
  await page.clock.runFor(400);
  await expect(page.locator('.fx-touch-effect')).toHaveCount(0);
  expect(requests).toEqual([]);
});
