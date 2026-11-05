import { spawn, type ChildProcess } from 'node:child_process';
import { createWriteStream, type WriteStream } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { expect, test, type Locator, type Page, type TestInfo } from '@playwright/test';
import type { AdminState, PredictionRules } from '../../shared/admin';
import type { BootstrapResponse, ClawResponse } from '../../shared/types';

const NOW = '2026-11-03T00:00:00Z'; // 09:00 KST, independent of every other suite.
const ORIGIN = 'http://localhost:8793';
let server: ChildProcess | undefined;
let log: WriteStream | undefined;
async function stopServer() {
  const child = server; server = undefined;
  if (child?.pid && child.exitCode === null && child.signalCode === null) {
    const closed = new Promise<void>(resolve => child.once('close', () => resolve()));
    try { process.kill(-child.pid, 'SIGTERM'); } catch { /* Already stopped. */ }
    const force = setTimeout(() => { try { process.kill(-child.pid!, 'SIGKILL'); } catch { /* Already stopped. */ } }, 5000);
    await closed; clearTimeout(force);
  }
  log?.end();
}
test.beforeAll(async ({}, info) => {
  info.setTimeout(120000);
  log = createWriteStream(`/tmp/yegoom-admin-console-worker-${process.pid}.log`);
  server = spawn(process.execPath, ['scripts/e2e-server.mjs'], {
    detached: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, E2E_PORT: '8793', E2E_NOW: NOW, E2E_PROFILE: 'admin-console' },
  });
  server.stdout!.pipe(log, { end: false }); server.stderr!.pipe(log, { end: false });
  try {
    await expect.poll(async () => {
      if (server!.exitCode !== null) throw new Error(`Admin fixture exited: ${server!.exitCode}`);
      try { return (await fetch(`${ORIGIN}/api/health`)).ok; } catch { return false; }
    }, { timeout: 90000, intervals: [200, 500] }).toBe(true);
  } catch (error) { await stopServer(); throw error; }
});
test.afterAll(stopServer);
test.beforeEach(async ({ page }) => {
  await page.clock.setFixedTime(new Date(NOW));
  await page.setExtraHTTPHeaders({ 'CF-Connecting-IP': '192.0.2.18' });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.setViewportSize({ width: 390, height: 900 });
});
async function login(page: Page, username: string) {
  await page.goto(`${ORIGIN}/`);
  await page.getByLabel('아이디', { exact: true }).fill(username);
  await page.getByLabel('비밀번호', { exact: true }).fill('e2e-only-password-2026');
  await page.getByRole('button', { name: '예굼방 들어가기', exact: true }).click();
  await expect(page.locator('.home')).toBeVisible();
}
async function navigate(page: Page, path: string) { await page.evaluate(value => { location.hash = value; }, path); }
async function readAdmin(page: Page): Promise<AdminState> {
  const response = await page.request.get(`${ORIGIN}/api/admin`);
  expect(response.status()).toBe(200); return response.json();
}
async function snapshot(page: Page): Promise<BootstrapResponse> {
  const response = await page.request.get(`${ORIGIN}/api/bootstrap`);
  expect(response.status()).toBe(200); return response.json();
}
async function saveGame(page: Page, rules: PredictionRules, effectiveFrom: string) {
  const response = await page.request.put(`${ORIGIN}/api/admin/games/offwork`, { headers: { Origin: ORIGIN }, data: { rules, effectiveFrom } });
  expect(response.status(), await response.text()).toBe(200);
}
async function openCard(page: Page, name: string) {
  const card = page.getByRole('region', { name: `${name} 운영 설정`, exact: true });
  const toggle = card.locator('.admin-card-toggle');
  if (await toggle.getAttribute('aria-expanded') !== 'true') await toggle.click();
  return card;
}
async function tabLayout(page: Page, count: number) {
  const nav = page.getByRole('navigation', { name: '주요 메뉴' });
  await expect(nav.getByRole('button')).toHaveCount(count);
  expect(await nav.evaluate(nav => {
    const bounds = nav.getBoundingClientRect();
    return [...nav.querySelectorAll('button')].every(button => {
      const rect = button.getBoundingClientRect();
      const text = button.querySelector('span')!;
      const textBounds = text.getBoundingClientRect();
      return rect.left >= bounds.left && rect.right <= bounds.right + 1 && textBounds.left >= rect.left && textBounds.right <= rect.right + 1 && text.scrollWidth <= text.clientWidth + 1;
    });
  })).toBe(true);
}
async function capture(page: Page, mode: 'authenticated' | 'preview', state: string, width: number, info: TestInfo) {
  await page.setViewportSize({ width, height: 900 });
  await page.evaluate(() => document.fonts.ready);
  await expect(page.locator('.fx-toast')).toHaveCount(0);
  if (!await page.getByRole('dialog').count()) {
    for (let i = 0; i < 5 && await page.locator('.announcement-banner').count(); i++) await page.locator('.announcement-close').click();
  }
  await page.evaluate(() => Promise.all(document.getAnimations().filter(animation => animation.effect?.getTiming().iterations !== Infinity)
    .map(animation => animation.finished.catch(() => {}))));
  await expect.poll(() => page.locator('img').evaluateAll(images => images.filter(image => image.getBoundingClientRect().height > 0)
    .every(image => (image as HTMLImageElement).complete && (image as HTMLImageElement).naturalWidth > 0))).toBe(true);
  if (state === 'prediction-settings') {
    const height = await page.evaluate(() => document.documentElement.scrollHeight);
    await page.setViewportSize({ width, height });
  }
  if (state === 'off-home') await page.locator('.game-row').filter({ hasText: '퇴근시간' }).evaluate(row => row.scrollIntoView({ block: 'center' }));
  else if (state === 'claw-settings') await page.getByRole('region', { name: '인형뽑기 운영 설정' }).scrollIntoViewIfNeeded();
  else await page.evaluate(() => scrollTo(0, 0));
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  if (state !== 'play-result') await tabLayout(page, 6);
  else await expect.poll(() => page.locator('.claw-glass canvas').evaluate(canvas => (canvas as HTMLCanvasElement).getContext('2d')!.getImageData(10, 10, 1, 1).data[3])).toBe(255);
  await mkdir('docs/screenshots', { recursive: true });
  const path = `docs/screenshots/admin-pr2-${mode}-${state}-${width}.png`;
  await page.screenshot({ path, fullPage: state === 'prediction-settings' });
  await info.attach(`${mode}-${state}-${width}`, { path, contentType: 'image/png' });
  await page.setViewportSize({ width, height: 900 });
}
async function editOffwork(page: Page, preview: boolean, width: number, info: TestInfo) {
  const card = await openCard(page, '퇴근시간');
  const form = card.getByRole('form', { name: '퇴근시간 설정', exact: true });
  await expect(form.getByRole('radio', { name: /내일부터 적용/ })).toBeChecked();
  const today = form.getByRole('radio', { name: /오늘부터 적용/ });
  await expect(today).toBeEnabled();
  const count = await form.locator('.admin-score-tier').count();
  await form.getByRole('button', { name: /배점 행 추가/ }).click();
  await expect(form.locator('.admin-score-tier')).toHaveCount(count + 1);
  await form.getByRole('button', { name: `퇴근시간 배점표 ${count + 1}행 삭제`, exact: true }).click();
  await expect(form.locator('.admin-score-tier')).toHaveCount(count);
  await form.getByLabel('퇴근시간 배점표 1행 점수', { exact: true }).fill('55');
  await form.getByLabel('퇴근시간 배점표 2행 점수', { exact: true }).fill('60');
  await form.getByRole('button', { name: '퇴근시간 설정 저장', exact: true }).click();
  await expect(form.getByRole('alert')).toContainText('점수는 아래 행으로 갈수록');
  await form.getByLabel('퇴근시간 배점표 2행 점수', { exact: true }).fill('25');
  await form.getByLabel('퇴근시간 배점표 3행 차이 기준 초', { exact: true }).fill('45');
  await expect(form.locator('.admin-tier-preview').nth(2)).toHaveText('45초 이내 → 20점');
  await expect(form.locator('.admin-tier-preview').nth(3)).toHaveText('1분 이내 → 15점');
  await form.getByLabel('퇴근시간 참여 골드', { exact: true }).fill('125');
  await form.getByLabel('퇴근시간 1등 골드', { exact: true }).fill('375');
  for (const [unit, value] of [['시', '16'], ['분', '45'], ['초', '30']]) {
    await form.getByLabel(`퇴근시간 예측 마감 ${unit}`, { exact: true }).fill(value);
    await form.getByLabel(`퇴근시간 예측 마감 ${unit}`, { exact: true }).blur();
  }
  await capture(page, preview ? 'preview' : 'authenticated', 'prediction-settings', width, info);
  await form.getByRole('button', { name: '퇴근시간 설정 저장', exact: true }).click();
  await expect(form.locator('.admin-form-success')).toContainText('00시 00분부터 적용');
  await expect(card).toContainText('내일 변경 예정');
  await expect(page.getByRole('region', { name: '최근 변경 기록', exact: true })).toContainText('참여 100G → 125G');
  return form;
}
async function showOffHome(page: Page, form: Locator, prefix: string, mode: 'authenticated' | 'preview', width: number, info: TestInfo) {
  await form.getByRole('radio', { name: /오늘부터 적용/ }).check();
  await form.getByRole('switch', { name: '퇴근시간 게임 운영', exact: true }).uncheck();
  await form.getByRole('button', { name: '퇴근시간 설정 저장', exact: true }).click();
  await expect(form.locator('.admin-form-success')).toContainText('오늘 판에 적용');
  await page.getByRole('navigation', { name: '주요 메뉴' }).getByRole('button', { name: '홈', exact: true }).click();
  const row = page.locator('.game-row').filter({ hasText: '퇴근시간' });
  await expect(row).toContainText('오늘은 쉬어요');
  await capture(page, mode, 'off-home', width, info);
  await row.click();
  await expect(page.getByRole('heading', { name: '오늘은 이 게임을 쉬어요', exact: true })).toBeVisible();
  await expect(page.locator('.prediction-input, .game-actions, .prediction-history')).toHaveCount(0);
  await navigate(page, `${prefix}/games`);
  await expect(page.locator('.game-row').filter({ hasText: '퇴근시간' })).toContainText('오늘은 쉬어요');
}
async function setRange(page: Page, name: string, value: number) {
  const slider = page.getByRole('slider', { name, exact: true });
  await slider.focus(); await slider.press('Home');
  const min = Number(await slider.getAttribute('min'));
  for (let index = min; index < value; index++) await slider.press('ArrowRight');
  await expect(slider).toHaveValue(String(value));
}
async function editClaw(page: Page, mode: 'authenticated' | 'preview', widths: number[], info: TestInfo) {
  const card = await openCard(page, '인형뽑기');
  await expect(card).toContainText('플레이어마다 넣은 코인을 세어, 정한 횟수째 판에 강집게(100%)가 나와요.');
  await setRange(page, '강집게 주기', 7);
  await setRange(page, '약집게 들어 올리는 힘', 55);
  await setRange(page, '약집게 옮기는 힘', 65);
  await card.getByRole('button', { name: '집게 힘 저장', exact: true }).click();
  await expect(card.locator('.admin-form-success')).toContainText('다음 플레이부터 적용');
  for (const width of widths) await capture(page, mode, 'claw-settings', width, info);
  return card;
}
async function playAdmin(page: Page, mode: 'authenticated' | 'preview', widths: number[], info: TestInfo) {
  await page.getByRole('button', { name: '운영자 기계 플레이', exact: true }).click();
  await expect(page.getByRole('region', { name: '운영자 테스트', exact: true })).toContainText('무제한');
  await expect(page.getByRole('button', { name: /코인 .* 사기/ })).toHaveCount(0);
  await page.getByRole('checkbox', { name: '이번 판 강집게로', exact: true }).check();
  await page.getByRole('button', { name: '테스트 시작', exact: true }).click();
  await expect(page.locator('.claw-cabinet')).toHaveAttribute('data-state', 'ready');
  await expect(page.getByRole('checkbox', { name: '이번 판 강집게로', exact: true })).toBeDisabled();
  const response = mode === 'authenticated' ? page.waitForResponse(response => response.url().endsWith('/api/claw/play') && response.request().method() === 'POST') : null;
  await page.getByRole('button', { name: '집게 내리기', exact: true }).click();
  if (response) {
    const result = await response; expect(result.status()).toBe(200);
    const receipt = await result.json() as ClawResponse;
    expect(receipt).toMatchObject({ coins: 0, result: { points: 0, gold: 0, clearBonus: 0, clearGold: 0, grip: { strong: true } } });
    expect(result.request().postDataJSON().forceStrong).toBe(true);
    await info.attach('admin-play-receipt', { body: JSON.stringify(receipt, null, 2), contentType: 'application/json' });
  }
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible({ timeout: 15000 });
  await expect(dialog).toContainText('보상 없음 · 운영자 테스트');
  await expect(dialog.locator('.claw-result-rewards')).toHaveCount(0);
  for (const width of widths) await capture(page, mode, 'play-result', width, info);
}

test('real administrator settings keep today stable, preview readable score tiers and turn an inactive game off', async ({ page }, info) => {
  test.setTimeout(120000);
  await login(page, 'admin');
  const original = await readAdmin(page);
  const originalRules = original.games.find(game => game.id === 'offwork')!.rules;
  for (const width of [390, 560]) {
    await page.setViewportSize({ width, height: 900 });
    await navigate(page, '/admin');
    await expect(page.getByRole('region', { name: '예측 게임 운영', exact: true })).toBeVisible();
    await tabLayout(page, 6); await capture(page, 'authenticated', 'tabbar', width, info);
    const form = await editOffwork(page, false, width, info);
    const after = await readAdmin(page);
    expect(after.games.find(game => game.id === 'offwork')!.rules).toEqual(originalRules);
    expect(after.games.find(game => game.id === 'offwork')!.scheduledRules).toMatchObject({ participationGold: 125, firstGold: 375, deadline: '16:45:30' });
    await showOffHome(page, form, '', 'authenticated', width, info);
    expect((await snapshot(page)).games.find(game => game.id === 'offwork')!.rules.enabled).toBe(false);
    await saveGame(page, originalRules, original.today);
    await page.reload();
  }
});

test('real admin claw settings apply to an unlimited zero-reward play and remain secret from players', async ({ page, browser }, info) => {
  test.setTimeout(90000);
  await login(page, 'admin'); await navigate(page, '/admin');
  await editClaw(page, 'authenticated', [390, 560], info);
  expect((await readAdmin(page)).claw).toEqual({ payoutEvery: 7, weakPickup: .55, weakCarry: .65 });
  const before = await snapshot(page);
  await playAdmin(page, 'authenticated', [390, 560], info);
  const after = await snapshot(page);
  expect(after.user.gold).toBe(before.user.gold); expect(after.user.weeklyScore).toBe(before.user.weeklyScore);
  expect(after.ledger).toEqual(before.ledger);
  expect(after.players.some(player => player.id === after.user.id)).toBe(false);
  const context = await browser.newContext({ reducedMotion: 'reduce' });
  try {
    const player = await context.newPage(); await login(player, 'min');
    const state = await (await player.request.get(`${ORIGIN}/api/claw`)).json();
    const payload = JSON.stringify([state, await snapshot(player)]);
    for (const secret of ['payoutEvery', 'weakPickup', 'weakCarry', 'power_counter', 'payout_every', 'weak_pickup', 'weak_carry']) expect(payload).not.toContain(secret);
    expect((await player.request.get(`${ORIGIN}/api/admin`)).status()).toBe(403);
  } finally { await context.close(); }
});

test('a delayed admin read cannot replace a saved setting after leaving and returning', async ({ page }) => {
  await login(page, 'admin'); await navigate(page, '/admin');
  await openCard(page, '인형뽑기');
  const original = (await readAdmin(page)).claw;
  const nextPeriod = original.payoutEvery === 6 ? 9 : 6;
  await setRange(page, '강집게 주기', nextPeriod);
  let releasePut!: () => void, putStarted!: () => void, releaseGet!: () => void;
  let receivedOldState!: (state: AdminState) => void;
  const putHeld = new Promise<void>(resolve => { releasePut = resolve; });
  const putWaiting = new Promise<void>(resolve => { putStarted = resolve; });
  const getHeld = new Promise<void>(resolve => { releaseGet = resolve; });
  const oldState = new Promise<AdminState>(resolve => { receivedOldState = resolve; });
  await page.route('**/api/admin/claw', async route => {
    putStarted(); await putHeld; await route.continue();
  });
  try {
    await page.getByRole('button', { name: '집게 힘 저장', exact: true }).click();
    await putWaiting;
    await navigate(page, '/'); await expect(page.locator('.home')).toBeVisible();
    await page.route('**/api/admin', async route => {
      const response = await route.fetch();
      receivedOldState(await response.json() as AdminState);
      await getHeld; await route.fulfill({ response });
    });
    await navigate(page, '/admin');
    expect((await oldState).claw).toEqual(original);
    const saved = page.waitForResponse(response => response.url().endsWith('/api/admin/claw') && response.request().method() === 'PUT');
    releasePut(); expect((await saved).status()).toBe(200);
    await openCard(page, '인형뽑기');
    const slider = page.getByRole('slider', { name: '강집게 주기', exact: true });
    await expect(slider).toHaveValue(String(nextPeriod));
    await expect(slider).toBeEnabled();
    const staleRead = page.waitForResponse(response => new URL(response.url()).pathname === '/api/admin');
    releaseGet(); await (await staleRead).finished();
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    await expect(slider).toHaveValue(String(nextPeriod));
    await expect(slider).toBeEnabled();
    expect((await readAdmin(page)).claw.payoutEvery).toBe(nextPeriod);
  } finally {
    releasePut(); releaseGet();
    await page.unroute('**/api/admin/claw'); await page.unroute('**/api/admin');
    const restored = await page.request.put(`${ORIGIN}/api/admin/claw`, { headers: { Origin: ORIGIN }, data: original });
    expect(restored.status()).toBe(200);
  }
});

test('player admin navigation is hidden and a real prediction disables applying settings today', async ({ page, browser }) => {
  test.setTimeout(60000);
  await login(page, 'min'); await tabLayout(page, 5);
  const adminRequests: string[] = [];
  page.on('request', request => { if (new URL(request.url()).pathname.startsWith('/api/admin')) adminRequests.push(request.url()); });
  await navigate(page, '/admin');
  await expect(page).toHaveURL(/#\/$/); await expect(page.locator('.home')).toBeVisible();
  await expect(page.getByRole('navigation', { name: '주요 메뉴' }).getByRole('button', { name: '운영', exact: true })).toHaveCount(0);
  expect(adminRequests).toEqual([]);
  const bootstrap = await snapshot(page);
  const prediction = await page.request.put(`${ORIGIN}/api/games/offwork/prediction`, { headers: { Origin: ORIGIN }, data: { roundDate: bootstrap.games.find(game => game.id === 'offwork')!.roundDate, value: '18:12:30' } });
  expect(prediction.status()).toBe(200);
  const context = await browser.newContext({ reducedMotion: 'reduce' });
  try {
    const admin = await context.newPage(); await login(admin, 'admin'); await navigate(admin, '/admin');
    const card = await openCard(admin, '퇴근시간');
    const form = card.getByRole('form', { name: '퇴근시간 설정', exact: true });
    await expect(form.getByRole('radio', { name: /오늘부터 적용/ })).toBeDisabled();
    await expect(form.getByRole('radio', { name: /내일부터 적용/ })).toBeChecked();
    await expect(form.locator('.admin-effective-date')).toContainText('예측');
    expect((await readAdmin(admin)).games.find(game => game.id === 'offwork')!.canApplyToday).toBe(false);
  } finally { await context.close(); }
});

for (const width of [390, 560]) test(`administrator preview remains serverless through rule changes, OFF cards and claw play at ${width}px`, async ({ page }, info) => {
  test.setTimeout(120000);
  await page.setViewportSize({ width, height: 900 });
  await page.emulateMedia({ reducedMotion: width === 390 ? 'no-preference' : 'reduce' });
  const requests: string[] = [];
  await page.route('**/api/**', route => { requests.push(route.request().url()); return route.abort(); });
  await page.goto(`${ORIGIN}/#/preview/admin`);
  await expect(page.getByText('운영 화면 미리보기', { exact: true })).toBeVisible();
  await tabLayout(page, 6); await capture(page, 'preview', 'tabbar', width, info);
  const wake = await openCard(page, '기상시간');
  await expect(wake.getByRole('radio', { name: /오늘부터 적용/ })).toBeDisabled();
  await wake.locator('.admin-card-toggle').click();
  const form = await editOffwork(page, true, width, info);
  await showOffHome(page, form, '/preview', 'preview', width, info);
  await navigate(page, '/preview/admin');
  await editClaw(page, 'preview', [width], info);
  await playAdmin(page, 'preview', [width], info);
  expect(requests).toEqual([]);
});
