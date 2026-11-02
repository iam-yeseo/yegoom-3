import { spawn, type ChildProcess } from 'node:child_process';
import { createWriteStream, type WriteStream } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { expect, test, type Page, type TestInfo } from '@playwright/test';

const NOW = '2026-10-30T00:00:00Z';
const ORIGIN = 'http://localhost:8791';
const PASSWORD = 'e2e-only-password-2026';
const SUCCESS = '비밀번호를 바꿨어요. 다른 기기에서는 다시 로그인해야 해요.';
let server: ChildProcess | undefined;
let serverLog: WriteStream | undefined;
async function stopServer() {
  const child = server; server = undefined;
  if (child?.pid && child.exitCode === null && child.signalCode === null) {
    const closed = new Promise<void>(resolve => child.once('close', () => resolve()));
    try { process.kill(-child.pid, 'SIGTERM'); } catch { /* Already stopped. */ }
    const force = setTimeout(() => { try { process.kill(-child.pid!, 'SIGKILL'); } catch { /* Already stopped. */ } }, 5000);
    await closed; clearTimeout(force);
  }
  serverLog?.end();
}
// Password changes must not alter the credentials used by other browser suites.
test.beforeAll(async ({}, info) => {
  info.setTimeout(120000);
  serverLog = createWriteStream(`/tmp/yegoom-password-worker-${process.pid}.log`);
  server = spawn(process.execPath, ['scripts/e2e-server.mjs'], {
    detached: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, E2E_PORT: '8791', E2E_NOW: NOW },
  });
  server.stdout!.pipe(serverLog, { end: false }); server.stderr!.pipe(serverLog, { end: false });
  try {
    await expect.poll(async () => {
      if (server!.exitCode !== null) throw new Error(`Password fixture exited: ${server!.exitCode}`);
      try { return (await fetch(`${ORIGIN}/api/health`)).ok; } catch { return false; }
    }, { timeout: 90000, intervals: [200, 500] }).toBe(true);
  } catch (error) { await stopServer(); throw error; }
});
test.afterAll(stopServer);
test.beforeEach(async ({ page }) => {
  await page.clock.setFixedTime(new Date(NOW));
  await page.setExtraHTTPHeaders({ 'CF-Connecting-IP': '192.0.2.17' });
});
async function login(page: Page, username: string) {
  await page.clock.setFixedTime(new Date(NOW));
  await page.goto(ORIGIN);
  await page.getByLabel('아이디', { exact: true }).fill(username);
  await page.getByLabel('비밀번호', { exact: true }).fill(PASSWORD);
  await page.getByRole('button', { name: '예굼방 들어가기', exact: true }).click();
  await expect(page.locator('.home')).toBeVisible();
  await page.getByRole('navigation', { name: '주요 메뉴' }).getByRole('button', { name: '내 정보', exact: true }).click();
}
async function screenshot(page: Page, name: string, info: TestInfo) {
  await mkdir('docs/screenshots', { recursive: true });
  await page.evaluate(() => document.fonts.ready);
  const path = `docs/screenshots/password-change-${name}.png`;
  await page.screenshot({ path, animations: 'disabled' });
  await info.attach(name, { path, contentType: 'image/png' });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
}

for (const [width, username] of [[390, 'min'], [560, 'siwon']] as const) {
  test(`password change validates, rotates sessions, and survives reload at ${width}px`, async ({ page, browser }, info) => {
    test.setTimeout(60000);
    await page.setViewportSize({ width, height: 900 });
    await page.emulateMedia({ reducedMotion: width === 560 ? 'reduce' : 'no-preference' });
    await login(page, username);
    const peerContext = await browser.newContext({ viewport: { width, height: 900 } });
    try {
      const peer = await peerContext.newPage();
      await login(peer, username);
      const oldCookie = (await page.context().cookies()).find(cookie => cookie.name === 'yegoom_session')!.value;
      const trigger = page.getByRole('button', { name: '비밀번호 변경', exact: true });
      await trigger.click();
      const sheet = page.getByRole('dialog', { name: '비밀번호 변경', exact: true });
      const current = sheet.getByLabel('현재 비밀번호', { exact: true });
      const next = sheet.getByLabel('새 비밀번호', { exact: true });
      const confirmation = sheet.getByLabel('새 비밀번호 확인', { exact: true });
      await expect(current).toBeFocused();
      await expect(current).toHaveAttribute('autocomplete', 'current-password');
      for (const input of [next, confirmation]) await expect(input).toHaveAttribute('autocomplete', 'new-password');
      await expect(sheet.locator('input[name="username"]')).toHaveValue(username);
      await expect(sheet.locator('input[name="username"]')).toHaveAttribute('autocomplete', 'username');
      await expect(sheet).toContainText('비밀번호를 잊었다면 운영자에게 초기화를 요청하세요');
      await screenshot(page, `authenticated-${width}`, info);
      await page.keyboard.press('Escape');
      await expect(sheet).toHaveCount(0);
      await expect(trigger).toBeFocused();
      await trigger.click();
      const changes: string[] = [];
      page.on('request', request => { if (new URL(request.url()).pathname === '/api/me/password') changes.push(request.method()); });
      await current.fill(PASSWORD);
      await next.fill('short'); await confirmation.fill('short');
      await sheet.getByRole('button', { name: '변경', exact: true }).click();
      await expect(sheet.getByRole('alert')).toContainText('12~128자');
      await next.fill(PASSWORD); await confirmation.fill(PASSWORD);
      await sheet.getByRole('button', { name: '변경', exact: true }).click();
      await expect(sheet.getByRole('alert')).toContainText('현재 비밀번호와 다르게');
      const replacement = `changed-${username}-password-2026`;
      await next.fill(replacement);
      await sheet.getByRole('button', { name: '변경', exact: true }).click();
      await expect(sheet.getByRole('alert')).toContainText('확인이 일치하지');
      expect(changes).toEqual([]);
      for (const label of ['현재 비밀번호', '새 비밀번호', '새 비밀번호 확인']) {
        await sheet.getByRole('button', { name: `${label} 보기`, exact: true }).click();
        await expect(sheet.getByLabel(label, { exact: true })).toHaveAttribute('type', 'text');
        await sheet.getByRole('button', { name: `${label} 숨기기`, exact: true }).click();
        await expect(sheet.getByLabel(label, { exact: true })).toHaveAttribute('type', 'password');
      }
      await current.fill('incorrect-password'); await confirmation.fill(replacement);
      await sheet.getByRole('button', { name: '변경', exact: true }).click();
      await expect(sheet.getByRole('alert')).toHaveText('현재 비밀번호가 맞지 않아요.');
      expect((await page.request.get(`${ORIGIN}/api/auth/me`)).status()).toBe(200);
      await current.fill(PASSWORD);
      await sheet.getByRole('button', { name: '변경', exact: true }).click();
      await expect(sheet).toHaveCount(0);
      await expect(page.locator('.fx-toast')).toHaveText(SUCCESS);
      expect(changes).toEqual(['PUT', 'PUT']);
      expect((await page.context().cookies()).find(cookie => cookie.name === 'yegoom_session')!.value).not.toBe(oldCookie);
      await screenshot(page, `success-${width}`, info);
      await page.reload();
      await expect(trigger).toBeVisible();
      expect((await page.request.get(`${ORIGIN}/api/auth/me`)).status()).toBe(200);
      await peer.reload();
      await expect(peer.getByRole('button', { name: '예굼방 들어가기', exact: true })).toBeVisible();
      expect((await peer.request.get(`${ORIGIN}/api/auth/me`)).status()).toBe(401);
      await trigger.click();
      for (const input of [current, next, confirmation]) await expect(input).toHaveValue('');
    } finally { await peerContext.close(); }
  });
}

test('administrators can change their own password through the same sheet', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await login(page, 'admin');
  await page.getByRole('button', { name: '비밀번호 변경', exact: true }).click();
  const sheet = page.getByRole('dialog', { name: '비밀번호 변경', exact: true });
  await sheet.getByLabel('현재 비밀번호', { exact: true }).fill(PASSWORD);
  await sheet.getByLabel('새 비밀번호', { exact: true }).fill('changed-admin-password');
  await sheet.getByLabel('새 비밀번호 확인', { exact: true }).fill('changed-admin-password');
  await sheet.getByRole('button', { name: '변경', exact: true }).click();
  await expect(sheet).toHaveCount(0);
  await expect(page.locator('.fx-toast')).toHaveText(SUCCESS);
  await page.reload();
  await expect(page.getByRole('button', { name: '비밀번호 변경', exact: true })).toBeEnabled();
  const response = await page.request.get(`${ORIGIN}/api/auth/me`);
  expect(response.ok()).toBe(true);
  expect((await response.json()).user.role).toBe('admin');
});

test('preview explains the disabled password change at both widths without API requests', async ({ page }, info) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const requests: string[] = [];
  page.on('request', request => { if (new URL(request.url()).pathname.startsWith('/api/')) requests.push(request.url()); });
  for (const width of [390, 560]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(`${ORIGIN}/#/preview/profile`);
    await expect(page.getByRole('button', { name: '비밀번호 변경', exact: true })).toBeDisabled();
    await expect(page.locator('.profile-password')).toContainText('미리보기에서는 비밀번호를 바꿀 수 없어요.');
    await page.locator('.profile-password').evaluate(node => node.scrollIntoView({ block: 'center' }));
    await screenshot(page, `preview-${width}`, info);
    await expect(page.getByRole('dialog')).toHaveCount(0);
  }
  expect(requests).toEqual([]);
});
