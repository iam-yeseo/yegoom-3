import { spawn, type ChildProcess } from 'node:child_process';
import { createWriteStream, type WriteStream } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { expect, test, type Page, type TestInfo, type Locator } from '@playwright/test';
import type { BootstrapResponse, LuckPhotoResponse, LottoResponse } from '../../shared/types';

const NOW = '2026-10-30T00:00:00Z';
const ORIGIN = 'http://localhost:8790';
const PASSWORD = 'e2e-only-password-2026';
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
test.beforeAll(async ({}, info) => {
  info.setTimeout(120000);
  serverLog = createWriteStream(`/tmp/yegoom-launch-b-worker-${process.pid}.log`);
  server = spawn(process.execPath, ['scripts/e2e-server.mjs'], {
    detached: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, E2E_PORT: '8790', E2E_NOW: NOW, E2E_PROFILE: 'launch-b' },
  });
  server.stdout!.pipe(serverLog, { end: false }); server.stderr!.pipe(serverLog, { end: false });
  try {
    await expect.poll(async () => {
      if (server!.exitCode !== null) throw new Error(`Launch B fixture exited: ${server!.exitCode}`);
      try { return (await fetch(`${ORIGIN}/api/health`)).ok; } catch { return false; }
    }, { timeout: 90000, intervals: [200, 500] }).toBe(true);
  } catch (error) { await stopServer(); throw error; }
});
test.afterAll(stopServer);
test.beforeEach(async ({ page }) => {
  await page.clock.setFixedTime(new Date(NOW));
  await page.setExtraHTTPHeaders({ 'CF-Connecting-IP': '192.0.2.12' });
  await page.setViewportSize({ width: 390, height: 900 });
});
async function login(page: Page, username: string) {
  await page.clock.setFixedTime(new Date(NOW));
  await page.goto(`${ORIGIN}/`);
  await page.getByLabel('아이디', { exact: true }).fill(username);
  await page.getByLabel('비밀번호', { exact: true }).fill(PASSWORD);
  await page.getByRole('button', { name: '예굼방 들어가기', exact: true }).click();
  await expect(page.locator('.home')).toBeVisible();
}
async function navigate(page: Page, path: string) {
  await page.evaluate(value => { location.hash = value; }, path);
}
async function snapshot(page: Page): Promise<BootstrapResponse> {
  const response = await page.request.get(`${ORIGIN}/api/bootstrap`);
  expect(response.status()).toBe(200); return response.json();
}
async function mutate(page: Page, path: string, data: unknown) {
  const response = await page.request.fetch(`${ORIGIN}/api${path}`, { method: path.endsWith('/reveal') ? 'POST' : 'PUT', data, headers: { Origin: ORIGIN } });
  expect(response.status(), await response.text()).toBe(200); return response;
}
async function dismissAnnouncements(page: Page) {
  for (let i = 0; i < 5 && await page.locator('.announcement-banner').count(); i++) {
    await page.locator('.announcement-banner').click();
  }
  await expect(page.locator('.announcement-banner')).toHaveCount(0);
}
async function finished(locator: Locator) {
  await locator.evaluate(element => Promise.all(element.getAnimations({ subtree: true })
    .filter(animation => animation.effect?.getTiming().iterations !== Infinity)
    .map(animation => animation.finished.catch(() => {}))));
}
async function capture(page: Page, mode: 'authenticated' | 'preview', state: string, width: number, info: TestInfo) {
  await page.setViewportSize({ width, height: 900 });
  await page.evaluate(() => document.fonts.ready);
  await expect(page.locator('.fx-toast')).toHaveCount(0);
  // Scroll lazy historical photos into view before a full-page capture.
  if (state.startsWith('luck-')) {
    for (const photo of await page.locator('img[loading=lazy]').all()) await photo.scrollIntoViewIfNeeded();
  }
  await expect.poll(() => page.locator('img').evaluateAll(images => images.filter(image => image.getBoundingClientRect().height > 0)
    .every(image => (image as HTMLImageElement).complete && (image as HTMLImageElement).naturalWidth > 0))).toBe(true);
  if (state !== 'announcement') {
    // Keep the actual entry/reward animations, but capture after their delayed
    // opacity and translation finish. Sprite idle loops deliberately continue.
    await finished(page.locator('main'));
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    await finished(page.locator('main'));
    const screen = await page.locator('.screen').boundingBox();
    expect(screen!.x).toBeGreaterThanOrEqual(-.02); expect(screen!.x + screen!.width).toBeLessThanOrEqual(width + .02);
    if (state === 'result' || state === 'luck-revealed') {
      const visible = await page.locator('.result-list .result-card, .result-list .reward').evaluateAll(elements => elements.every(element => Number(getComputedStyle(element).opacity) >= .999));
      expect(visible).toBe(true);
    }
  }
  if (state === 'crop') await finished(page.getByRole('dialog', { name: '프로필 사진 자르기' }));
  if (state === 'profile' || state === 'crop') {
    const layout = await page.locator('.profile-editor').evaluate(card => {
      const bounds = card.getBoundingClientRect();
      const input = card.querySelector('input[autocomplete=nickname]')!.getBoundingClientRect();
      const button = card.querySelector('.profile-nickname-row button')!.getBoundingClientRect();
      return { inputWidth: input.width, contained: input.left >= bounds.left && input.right <= bounds.right && button.left >= bounds.left && button.right <= bounds.right };
    });
    expect(layout.inputWidth).toBeGreaterThanOrEqual(100); expect(layout.contained).toBe(true);
  }
  if (state === 'ranking') await page.locator('.ranking-preview').scrollIntoViewIfNeeded();
  else await page.evaluate(() => scrollTo(0, 0));
  expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
  await mkdir('docs/screenshots', { recursive: true });
  const path = `docs/screenshots/launch-b-${mode}-${state}-${width}.png`;
  await page.screenshot({ path, fullPage: !['crop', 'ranking', 'announcement'].includes(state) });
  await info.attach(`${mode}-${state}-${width}`, { path, contentType: 'image/png' });
}
async function fixturePhoto(page: Page, evidence = false) {
  const url = await page.evaluate(evidence => {
    const canvas = document.createElement('canvas'); canvas.width = evidence ? 1800 : 600; canvas.height = evidence ? 1000 : 300;
    const ctx = canvas.getContext('2d')!;
    if (evidence) {
      ctx.fillStyle = '#eee8fc'; ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.fillStyle = '#fff9ee'; ctx.fillRect(300, 80, 1200, 840);
      ctx.fillStyle = '#7c7383'; ctx.textAlign = 'center'; ctx.font = '50px sans-serif'; ctx.fillText('오늘의 행운 점수', 900, 250);
      ctx.fillStyle = '#3a3340'; ctx.font = 'bold 350px sans-serif'; ctx.fillText('77', 900, 650);
      ctx.fillStyle = '#7c7383'; ctx.font = '45px sans-serif'; ctx.fillText('점 · 2026.10.30', 900, 780);
    } else {
      ctx.fillStyle = '#ff8e7a'; ctx.fillRect(0, 0, 300, 300);
      ctx.fillStyle = '#729ccf'; ctx.fillRect(300, 0, 300, 300);
      ctx.fillStyle = '#fff9ee';
      for (const [x, y, r] of [[110, 70, 25], [490, 230, 35], [200, 245, 18], [400, 60, 15]]) {
        ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
      }
    }
    return canvas.toDataURL('image/jpeg', .94);
  }, evidence);
  let buffer = Buffer.from(url.split(',')[1], 'base64');
  if (!evidence) {
    // A real orientation-6 JPEG: the decoder must rotate the landscape pixels
    // into a portrait before calculating the square crop, just like iPhone EXIF.
    const exif = Buffer.from('45786966000049492a0008000000010012010300010000000600000000000000', 'hex');
    const marker = Buffer.alloc(4); marker.writeUInt16BE(0xffe1, 0); marker.writeUInt16BE(exif.length + 2, 2);
    buffer = Buffer.concat([buffer.subarray(0, 2), marker, exif, buffer.subarray(2)]);
  }
  return { name: evidence ? 'fortune-77.jpg' : 'iphone-oriented.jpg', mimeType: 'image/jpeg', buffer };
}
async function beginCrop(page: Page) {
  await page.locator('input[aria-label="프로필 사진 선택"]').setInputFiles(await fixturePhoto(page));
  const dialog = page.getByRole('dialog', { name: '프로필 사진 자르기', exact: true });
  await expect(dialog).toBeVisible(); await expect(dialog.getByRole('slider', { name: '확대 정도' })).toBeEnabled();
  await finished(dialog); return dialog;
}
async function inspectImage(page: Page, url: string) {
  return page.evaluate(async url => {
    let blob: Blob; let cache: string | null = null;
    if (url.startsWith('data:')) {
      const [header, encoded] = url.split(',');
      blob = new Blob([Uint8Array.from(atob(encoded), char => char.charCodeAt(0))], { type: header.slice(5).split(';')[0] });
    } else {
      const response = await fetch(url); blob = await response.blob(); cache = response.headers.get('cache-control');
    }
    const image = await createImageBitmap(blob);
    const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height;
    const ctx = canvas.getContext('2d')!; ctx.drawImage(image, 0, 0);
    const pixel = (y: number) => [...ctx.getImageData(Math.floor(image.width / 2), Math.floor(image.height * y), 1, 1).data];
    const result = { width: image.width, height: image.height, size: blob.size, type: blob.type, top: pixel(.2), bottom: pixel(.8), cache };
    image.close(); return result;
  }, url);
}
async function noApiCache(page: Page) {
  await page.evaluate(() => navigator.serviceWorker.ready);
  const urls = await page.evaluate(async () => (await Promise.all((await caches.keys()).map(async key => (await (await caches.open(key)).keys()).map(item => item.url)))).flat());
  expect(urls.some(url => new URL(url).pathname.startsWith('/api/'))).toBe(false);
}

// Separate DB avoids changing the account names or publishing rounds used by
// the pre-existing 44 browser cases. All images and writes use real endpoints.
test('real profile crop respects EXIF, shares nickname and photo, and deletes back to the character', async ({ page, browser }, info) => {
  test.setTimeout(90000);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await login(page, 'min'); await dismissAnnouncements(page); await navigate(page, '/profile');
  await page.getByLabel('닉네임', { exact: true }).fill('  해피민  ');
  await page.getByRole('button', { name: '닉네임 저장', exact: true }).click();
  await expect(page.locator('.profile-summary h1')).toHaveText('해피민님');
  await expect(page.getByLabel('닉네임', { exact: true })).toHaveValue('해피민');
  expect((await snapshot(page)).user.username).toBe('min');
  const dialog = await beginCrop(page);
  for (const width of [390, 560]) await capture(page, 'authenticated', 'crop', width, info);
  await dialog.getByRole('button', { name: '이 부분으로 저장', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  const avatar = page.locator('.profile-editor img.avatar-photo');
  await expect(avatar).toHaveAttribute('src', /\/api\/users\/e2e-min\/photo\?v=1$/);
  await expect(avatar).toHaveAttribute('alt', '해피민님 프로필 사진');
  const url = (await avatar.getAttribute('src'))!;
  const image = await inspectImage(page, url);
  expect([image.width, image.height]).toEqual([512, 512]); expect(image.size).toBeLessThanOrEqual(260 * 1024);
  expect(['image/webp', 'image/jpeg']).toContain(image.type);
  expect(image.cache).toBe('private, max-age=31536000, immutable');
  await info.attach('profile-photo-metadata', { body: JSON.stringify(image), contentType: 'application/json' });
  expect(image.top[0]).toBeGreaterThan(image.top[2] + 60); expect(image.bottom[2]).toBeGreaterThan(image.bottom[0] + 60);
  await expect(page.locator('.profile-character [data-character]')).toHaveCount(1);
  for (const width of [390, 560]) await capture(page, 'authenticated', 'profile', width, info);
  const other = await browser.newContext({ reducedMotion: 'reduce', viewport: { width: 390, height: 900 } });
  try {
    const viewer = await other.newPage(); await login(viewer, 'siwon'); await dismissAnnouncements(viewer);
    const row = viewer.locator('.ranking-preview-row').filter({ hasText: '해피민' });
    await expect(row.locator('.ranking-preview-main strong')).toHaveText('해피민');
    await expect(row.locator('img.avatar-photo')).toHaveAttribute('src', url);
    for (const width of [390, 560]) await capture(viewer, 'authenticated', 'ranking', width, info);
    await navigate(viewer, '/ranking'); await expect(viewer.locator('.podium-name').filter({ hasText: '해피민' })).toHaveText('해피민');
    await expect(viewer.locator('.podium img.avatar-photo')).toHaveCount(0);
    await navigate(viewer, '/game/wake'); await expect(viewer.locator('.prediction-hero')).toContainText('해피민님');
    await expect(viewer.locator('.prediction-hero img.avatar-photo')).toHaveCount(0);
    await mutate(page, '/games/offwork/prediction', { roundDate: '2026-10-30', value: '18:12:30' });
    await mutate(viewer, '/games/offwork/answer', { roundDate: '2026-10-30', value: '18:12:30', hint: '' });
    await mutate(viewer, '/games/offwork/reveal', { roundDate: '2026-10-30' });
    await page.reload(); await navigate(page, '/game/offwork');
    const result = page.locator('.result-list .result-card').filter({ hasText: '해피민님' });
    await expect(result.locator('img.avatar-photo')).toHaveAttribute('src', url);
    for (const width of [390, 560]) await capture(page, 'authenticated', 'result', width, info);
    expect(JSON.stringify(await snapshot(page))).not.toContain('data:image/');
    await noApiCache(page);
    const anonymous = await browser.newContext();
    try { expect((await anonymous.request.get(`${ORIGIN}${url}`)).status()).toBe(401); } finally { await anonymous.close(); }
    await navigate(page, '/profile'); await page.getByRole('button', { name: '사진 삭제', exact: true }).click();
    await expect(page.locator('.profile-editor img.avatar-photo')).toHaveCount(0);
    await expect(page.locator('.profile-editor [data-character]')).toHaveCount(1);
    await viewer.goto(`${ORIGIN}/`); await viewer.reload(); await dismissAnnouncements(viewer);
    await expect(row.locator('img.avatar-photo')).toHaveCount(0); await expect(row.locator('[data-character]')).toHaveCount(1);
    const second = await beginCrop(page); await second.getByRole('button', { name: '이 부분으로 저장', exact: true }).click();
    await expect(avatar).toHaveAttribute('src', /\?v=3$/);
    expect((await snapshot(page)).user.username).toBe('min');
    // Another tab can replace the session cookie while a crop is still open.
    // A real bootstrap refresh must discard the old account's unsaved editor.
    const staleDraft = await beginCrop(page);
    const switched = await page.request.post(`${ORIGIN}/api/auth/login`, { data: { username: 'siwon', password: PASSWORD }, headers: { Origin: ORIGIN } });
    expect(switched.status()).toBe(200);
    // Visibility refreshes reuse a successful bootstrap for ten seconds. The
    // fixed wall clock must cross that window before simulating the return.
    await page.clock.setFixedTime(new Date(Date.parse(NOW) + 10000));
    await expect.poll(async () => {
      await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
      return page.locator('.profile-summary h1').textContent();
    }).toBe('siwon님');
    await expect(staleDraft).toHaveCount(0);
    expect((await snapshot(page)).user.photoVersion).toBeNull();
  } finally { await other.close(); }
});

test('preview profile supports drag, pinch and keyboard zoom without API calls and updates every avatar', async ({ browser }, info) => {
  test.setTimeout(90000);
  for (const width of [390, 560]) {
    const context = await browser.newContext({ viewport: { width, height: 900 }, reducedMotion: width === 560 ? 'reduce' : 'no-preference' });
    const page = await context.newPage(); const requests: string[] = [];
    await page.clock.setFixedTime(new Date(NOW));
    await context.route('**/api/**', route => { requests.push(route.request().url()); return route.abort(); });
    try {
      await page.goto(`${ORIGIN}/#/preview/profile`);
      await page.getByLabel('닉네임', { exact: true }).fill('사진예서');
      await page.getByRole('button', { name: '닉네임 저장', exact: true }).click();
      await expect(page.locator('.profile-summary h1')).toHaveText('사진예서님');
      await expect(page.getByLabel('닉네임', { exact: true })).toHaveValue('사진예서');
      const dialog = await beginCrop(page); const canvas = dialog.locator('canvas'); const range = dialog.getByRole('slider', { name: '확대 정도' });
      const original = await canvas.evaluate((node: HTMLCanvasElement) => node.toDataURL());
      const box = (await canvas.boundingBox())!;
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await page.mouse.down();
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2 + 45, { steps: 6 }); await page.mouse.up();
      expect(await canvas.evaluate((node: HTMLCanvasElement) => node.toDataURL())).not.toBe(original);
      await range.focus(); await page.keyboard.press('ArrowRight'); await expect(range).toHaveValue('101');
      await canvas.focus(); const beforeKeys = await canvas.evaluate((node: HTMLCanvasElement) => node.toDataURL());
      await page.keyboard.press('ArrowUp'); expect(await canvas.evaluate((node: HTMLCanvasElement) => node.toDataURL())).not.toBe(beforeKeys);
      const cdp = await context.newCDPSession(page);
      const x = box.x + box.width / 2; const y = box.y + box.height / 2;
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: x - 35, y, id: 1 }, { x: x + 35, y, id: 2 }] });
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: x - 65, y, id: 1 }, { x: x + 65, y, id: 2 }] });
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }); await cdp.detach();
      await expect.poll(async () => Number(await range.inputValue())).toBeGreaterThan(150);
      await expect(page.locator('.fx-touch-effect')).toHaveCount(0);
      await capture(page, 'preview', 'crop', width, info);
      await dialog.getByRole('button', { name: '이 부분으로 저장', exact: true }).click(); await expect(dialog).toHaveCount(0);
      const avatar = page.locator('.profile-editor img.avatar-photo'); await expect(avatar).toHaveAttribute('src', /^data:image\/(webp|jpeg);base64,/);
      const url = (await avatar.getAttribute('src'))!; const image = await inspectImage(page, url);
      expect([image.width, image.height]).toEqual([512, 512]); expect(image.size).toBeLessThanOrEqual(260 * 1024);
      await capture(page, 'preview', 'profile', width, info);
      await navigate(page, '/preview');
      await expect(page.locator('.ranking-preview-row').filter({ hasText: '사진예서' }).locator('.ranking-preview-main strong')).toHaveText('사진예서');
      await expect(page.locator('.ranking-preview-row').filter({ hasText: '사진예서' }).locator('img.avatar-photo')).toHaveAttribute('src', url);
      await capture(page, 'preview', 'ranking', width, info);
      await navigate(page, '/preview/game/offwork');
      await expect(page.locator('.result-list .result-card').filter({ hasText: '사진예서님' }).locator('img.avatar-photo')).toHaveAttribute('src', url);
      await capture(page, 'preview', 'result', width, info);
      await navigate(page, '/preview/profile'); await page.getByRole('button', { name: '사진 삭제', exact: true }).click();
      await expect(page.locator('.profile-editor img.avatar-photo')).toHaveCount(0);
      await expect(page.locator('.profile-editor [data-character]')).toHaveCount(1);
      const cancelled = await beginCrop(page); await page.keyboard.press('Escape'); await expect(cancelled).toHaveCount(0);
      await expect(page.locator('.announcement-banner')).toHaveCount(0); expect(requests).toEqual([]);
    } finally { await context.close(); }
  }
});

async function evidenceUpload(page: Page) {
  await page.locator('input[type=file][aria-label="행운 점수 증거 사진"]').setInputFiles(await fixturePhoto(page, true));
  await expect(page.locator('.luck-photo-status.is-saved')).toHaveText('증거 사진을 저장했어요');
  await expect(page.getByRole('button', { name: '정답 저장', exact: true })).toBeEnabled();
}
async function inspectEvidenceViewers(page: Page, preview: boolean) {
  const today = page.getByRole('button', { name: '오늘의 증거 크게 보기', exact: true });
  await today.click(); let dialog = page.getByRole('dialog', { name: '오늘의 증거', exact: true });
  await expect(dialog.locator('img')).toBeVisible(); await page.keyboard.press('Escape'); await expect(dialog).toHaveCount(0);
  await today.click(); await dialog.getByRole('button', { name: '닫기', exact: true }).click(); await expect(dialog).toHaveCount(0);
  const history = page.getByRole('region', { name: '최근 결과 기록', exact: true });
  await expect(history.locator('.luck-photo-thumbnail')).toHaveCount(3);
  for (const button of await history.locator('.luck-photo-thumbnail').all()) {
    const label = (await button.getAttribute('aria-label'))!.replace(' 크게 보기', '');
    await button.click(); dialog = page.getByRole('dialog', { name: label, exact: true });
    await expect(dialog.locator('img')).toHaveAttribute('src', preview ? /^data:image\// : /\/api\/games\/luck\/rounds\/2026-10-(29|27|24)\/photo\?v=1$/);
    await expect.poll(() => dialog.locator('img').evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0)).toBe(true);
    await page.keyboard.press('Escape'); await expect(dialog).toHaveCount(0);
  }
}
test('real luck evidence stays private until publication, replaces its version and appears in three past rounds', async ({ page, browser }, info) => {
  test.setTimeout(90000);
  await page.emulateMedia({ reducedMotion: 'reduce' }); await login(page, 'yeseo'); await dismissAnnouncements(page);
  await navigate(page, '/game/luck'); await expect(page.getByRole('button', { name: '정답 저장', exact: true })).toBeDisabled();
  await page.getByRole('spinbutton', { name: /^정답 점수/ }).fill('77'); await page.getByLabel('함께 볼 힌트').fill('오늘은 좋은 일이 가득할 것 같아요');
  const firstResponse = page.waitForResponse(response => response.url().endsWith('/api/games/luck/photo') && response.request().method() === 'PUT');
  await evidenceUpload(page); const first: LuckPhotoResponse = await (await firstResponse).json(); expect(first.photo.version).toBe(1);
  const image = await inspectImage(page, first.photo.url);
  await info.attach('luck-photo-metadata', { body: JSON.stringify(image), contentType: 'application/json' });
  expect([image.width, image.height]).toEqual([1280, 711]); expect(image.size).toBeLessThanOrEqual(440 * 1024);
  expect(image.cache).toBe('private, max-age=31536000, immutable');
  const other = await browser.newContext({ reducedMotion: 'reduce', viewport: { width: 390, height: 900 } });
  try {
    const viewer = await other.newPage(); await login(viewer, 'min'); await dismissAnnouncements(viewer);
    expect((await snapshot(viewer)).games.find(game => game.id === 'luck')?.photo).toBeNull();
    expect((await viewer.request.get(`${ORIGIN}${first.photo.url}`)).status()).toBe(403);
    const replacement = page.waitForResponse(response => response.url().endsWith('/api/games/luck/photo') && response.request().method() === 'PUT');
    await evidenceUpload(page); const second: LuckPhotoResponse = await (await replacement).json();
    expect(second.photo.version).toBe(2); expect(second.photo.url).not.toBe(first.photo.url);
    await page.getByRole('button', { name: '정답 저장', exact: true }).click();
    await expect(page.getByRole('button', { name: '지금 공개', exact: true })).toBeEnabled();
    for (const width of [390, 560]) await capture(page, 'authenticated', 'luck-author', width, info);
    await mutate(viewer, '/games/luck/prediction', { roundDate: '2026-10-30', value: '77' });
    await page.getByRole('button', { name: '지금 공개', exact: true }).click(); await expect(page.locator('.answer-number')).toHaveText('77점');
    await viewer.goto(`${ORIGIN}/#/game/luck`); await viewer.reload(); await dismissAnnouncements(viewer);
    await expect(viewer.getByRole('button', { name: '오늘의 증거 크게 보기' }).locator('img')).toHaveAttribute('src', second.photo.url);
    expect((await viewer.request.get(`${ORIGIN}${second.photo.url}`)).status()).toBe(200);
    for (const width of [390, 560]) await capture(viewer, 'authenticated', 'luck-revealed', width, info);
    await inspectEvidenceViewers(viewer, false); await noApiCache(viewer);
    const history = await (await viewer.request.get(`${ORIGIN}/api/games/luck/history`)).text(); expect(history).not.toContain('data:image/');
    expect(JSON.stringify(await snapshot(viewer))).not.toContain('base64');
    await expect(page.getByRole('button', { name: '다시 고르기', exact: true })).toHaveCount(0);
  } finally { await other.close(); }
});

test('preview luck requires local evidence and keeps upload, results and recent viewers serverless', async ({ browser }, info) => {
  test.setTimeout(90000);
  for (const width of [390, 560]) {
    const context = await browser.newContext({ viewport: { width, height: 900 }, reducedMotion: 'reduce' });
    const page = await context.newPage(); const requests: string[] = [];
    await page.clock.setFixedTime(new Date(NOW));
    await context.route('**/api/**', route => { requests.push(route.request().url()); return route.abort(); });
    try {
      await page.goto(`${ORIGIN}/#/preview/game/luck`);
      await expect(page.getByRole('button', { name: '정답 저장', exact: true })).toBeDisabled();
      await page.getByRole('spinbutton', { name: /^정답 점수/ }).fill('77'); await page.getByLabel('함께 볼 힌트').fill('사진으로 남긴 오늘의 행운');
      await evidenceUpload(page); await page.getByRole('button', { name: '정답 저장', exact: true }).click();
      await expect(page.getByRole('button', { name: '지금 공개', exact: true })).toBeEnabled();
      await capture(page, 'preview', 'luck-author', width, info);
      await page.getByRole('button', { name: '지금 공개', exact: true }).click(); await expect(page.locator('.answer-number')).toHaveText('77점');
      await expect(page.getByRole('button', { name: '오늘의 증거 크게 보기' }).locator('img')).toHaveAttribute('src', /^data:image\/(webp|jpeg);base64,/);
      await capture(page, 'preview', 'luck-revealed', width, info); await inspectEvidenceViewers(page, true);
      await expect(page.locator('.announcement-banner')).toHaveCount(0); expect(requests).toEqual([]);
    } finally { await context.close(); }
  }
});

test('real announcements queue for four seconds, exclude self and expired events, and persist dismissal', async ({ page, browser }, info) => {
  test.setTimeout(60000);
  // Authenticate via the real endpoint before freezing timers, so pointer effects
  // from the login button cannot interfere with precise banner deadlines.
  const response = await page.request.post(`${ORIGIN}/api/auth/login`, { data: { username: 'min', password: PASSWORD }, headers: { Origin: ORIGIN } });
  expect(response.status()).toBe(200);
  await page.clock.install({ time: new Date(NOW) }); await page.clock.pauseAt(new Date(Date.parse(NOW) + 1000));
  await page.goto(`${ORIGIN}/`);
  const banner = page.locator('.announcement-banner'); await expect(banner).toContainText('siwon님이 스피또');
  await expect(page.locator('.announcement-region')).toHaveAttribute('role', 'status'); await expect(page.locator('.announcement-region')).toHaveAttribute('aria-live', 'polite');
  const data = await snapshot(page);
  expect(data.announcements.every(row => ![1001, 1002, 1005].includes(row.id))).toBe(true);
  expect(data.announcements.every(row => row.userId !== data.user.id && row.rank !== 4)).toBe(true);
  const lotto: LottoResponse = await (await page.request.get(`${ORIGIN}/api/shop/lotto`)).json();
  expect(lotto.lotto.tickets.find(row => row.id === '00000000-0000-4000-8000-000000000004')).toMatchObject({ rank: 4, prize: 500 });
  // Move the browser clock 200ms for the banner's unmodified entrance, then
  // capture both widths with the remaining 3.8 second lifetime held still.
  await page.clock.runFor(200);
  for (const width of [390, 560]) await capture(page, 'authenticated', 'announcement', width, info);
  await page.clock.runFor(3799); await expect(banner).toContainText('siwon님이 스피또');
  await page.clock.runFor(1); await expect(banner).toContainText('yeseo님이 데일리 로또 2등');
  await banner.evaluate((button: HTMLButtonElement) => button.click()); await expect(banner).toContainText('yeseo님이 데일리 로또 1등');
  await page.clock.runFor(4000); await expect(banner).toHaveCount(0);
  const ids = await page.evaluate(() => JSON.parse(localStorage.getItem('yegoom:announcements:seen:e2e-min')!));
  expect(ids).toHaveLength(3); expect(ids).toEqual(expect.arrayContaining([1003, 1004]));
  await page.reload(); await page.clock.runFor(500); await expect(banner).toHaveCount(0);
  const other = await browser.newContext({ reducedMotion: 'reduce' });
  try {
    const viewer = await other.newPage(); await login(viewer, 'yeseo');
    const own = await snapshot(viewer); expect(own.announcements.every(row => row.userId !== 'e2e-yeseo')).toBe(true);
    const visible = viewer.locator('.announcement-banner'); await expect(visible).toBeVisible();
    expect(await visible.evaluate(element => getComputedStyle(element).animationName)).toBe('announcement-fade');
    const frames = await visible.evaluate(element => element.getAnimations().flatMap(animation => (animation.effect as KeyframeEffect).getKeyframes()));
    expect(frames.every(frame => !('transform' in frame))).toBe(true);
  } finally { await other.close(); }
});
