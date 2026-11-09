import { mkdir } from 'node:fs/promises';
import { expect, test, type Page, type TestInfo } from '@playwright/test';
import type { BootstrapResponse, CatchmindPlayer, CatchmindResponse } from '../../shared/types';
import { CATCHMIND_RULES } from '../../shared/balance';

const NOW = '2026-10-30T00:00:00.000Z';
const ORIGIN = 'http://localhost:8788';
declare global { interface Window { __pr4PictureChanges: number } }
test.use({ serviceWorkers: 'block' });
test.beforeEach(async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.setExtraHTTPHeaders({ 'CF-Connecting-IP': '192.0.2.26' });
});

async function login(page: Page) {
  const response = await page.request.post('/api/auth/login', {
    headers: { Origin: ORIGIN, 'CF-Connecting-IP': '192.0.2.26' },
    data: { username: 'yeseo', password: 'e2e-only-password-2026' },
  });
  expect(response.status()).toBe(200);
  const bootstrap = await page.request.get('/api/bootstrap');
  expect(bootstrap.status()).toBe(200);
  return bootstrap.json() as Promise<BootstrapResponse>;
}
async function capture(page: Page, name: string, info: TestInfo) {
  await mkdir('docs/screenshots', { recursive: true });
  for (const width of [390, 560]) {
    await page.setViewportSize({ width, height: 900 });
    await page.evaluate(() => document.fonts.ready);
    await expect.poll(() => page.locator('img').evaluateAll(images => images
      .filter(image => image.getBoundingClientRect().height > 0)
      .every(image => (image as HTMLImageElement).complete))).toBe(true);
    await page.evaluate(() => Promise.all(document.getAnimations()
      .filter(animation => animation.effect?.getComputedTiming().iterations !== Infinity)
      .map(animation => animation.finished.catch(() => {}))));
    expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
    const path = `docs/screenshots/update-pr4-${name}-${width}.png`;
    await page.screenshot({ path, fullPage: true, animations: 'disabled' });
    await info.attach(`${name}-${width}`, { path, contentType: 'image/png' });
  }
}
function fixture(snapshot: BootstrapResponse, wrongCount: number, ended = false, overdue = false): CatchmindResponse {
  const people = new Map(snapshot.players.map(player => [player.username, {
    id: player.id, username: player.username, displayName: ({ min: '민', siwon: '시원', yeseo: '예서' } as Record<string, string>)[player.username] ?? player.displayName,
    photoVersion: null, character: player.character ?? 'cat',
  } satisfies CatchmindPlayer]));
  const drawer = people.get('min')!, turn = people.get('siwon')!, viewer = people.get('yeseo')!;
  const endedAt = overdue ? '2026-10-29T23:49:59.000Z' : NOW;
  return {
    version: 20 + wrongCount + Number(ended), viewerId: snapshot.user.id, serverTime: NOW,
    catchmind: {
      round: { id: 'browser-pr4-round', number: 40, status: ended ? 'ended' : 'open', drawer,
        word: ended ? '인형' : null, wordVersion: 0, rerollsLeft: CATCHMIND_RULES.rerolls,
        image: '/claw/dolls/doll-1.webp', wrongCount, hint: wrongCount >= CATCHMIND_RULES.hintAfter ? { firstCharacter: '인', length: 2 } : null,
        winner: null, winnerScored: false, endReason: ended ? 'manual' : null, publishedAt: '2026-10-29T23:45:00.000Z', endedAt: ended ? endedAt : null,
        guesses: Array.from({ length: wrongCount }, (_, index) => ({ id: `browser-wrong-${index}`, player: viewer,
          answer: `틀린 답 ${index + 1}`, correct: false, createdAt: NOW })),
      },
      turn: ended ? turn : drawer, nextDrawer: turn, previousRound: null,
      canClaim: false, canPublish: false, canReroll: false, canGuess: !ended, canEnd: false, canNext: false,
      canSkip: ended && overdue,
      skipAvailableAt: ended ? new Date(Date.parse(endedAt) + CATCHMIND_RULES.skipAfterMs).toISOString() : null,
    },
  };
}

test('ten chances, the fifth-answer hint, waiting and skipping show the new rules at both widths', async ({ page }, info) => {
  await page.clock.setFixedTime(new Date(NOW));
  const snapshot = await login(page);
  const names: Record<string, string> = { min: '민', siwon: '시원', yeseo: '예서' };
  await page.route('**/api/bootstrap', route => route.fulfill({ json: { ...snapshot, announcements: [],
    user: { ...snapshot.user, displayName: '예서' },
    players: snapshot.players.map(player => ({ ...player, displayName: names[player.username] ?? player.displayName })) } }));
  let current = fixture(snapshot, 0);
  await page.route('**/api/catchmind?*', route => route.fulfill({ json: current }));
  await page.route('**/api/catchmind', route => route.fulfill({ json: current }));
  await page.goto('/#/play/catchmind');
  const slots = page.locator('.pg-fail-nodes > span');
  await expect(slots).toHaveCount(10);
  await expect(page.locator('.pg-fails')).toContainText('힌트까지 5번');
  await capture(page, 'ten-chances', info);
  for (const width of [390, 560]) {
    await page.setViewportSize({ width, height: 900 });
    const fits = await slots.evaluateAll(nodes => {
      const parent = nodes[0].parentElement!.getBoundingClientRect();
      return nodes.every(node => { const box = node.getBoundingClientRect(); return box.left >= parent.left && box.right <= parent.right + 1; });
    });
    expect(fits).toBe(true);
  }
  current = fixture(snapshot, 5);
  await page.reload();
  await expect(page.locator('.pg-hint')).toHaveAttribute('aria-label', '첫 글자 힌트: 인, 2글자');
  await expect(page.locator('.pg-fails')).toContainText('종료까지 5번');
  await capture(page, 'hint', info);

  current = fixture(snapshot, 5, true);
  await page.reload();
  await expect(page.locator('.pg-next-player')).toContainText('시원님');
  await expect(page.getByRole('button', { name: '차례 넘기기', exact: true })).toHaveCount(0);
  await capture(page, 'next-drawer-wait', info);
  current = fixture(snapshot, 5, true, true);
  await page.reload();
  const skip = page.getByRole('button', { name: '차례 넘기기', exact: true });
  await expect(skip).toBeEnabled();
  await capture(page, 'skip-turn', info);
  let submitted: Record<string, unknown> | null = null;
  await page.route('**/api/catchmind/skip', async route => {
    submitted = route.request().postDataJSON();
    current = { ...current, version: current.version + 1, catchmind: { ...current.catchmind,
      turn: { id: snapshot.user.id, username: 'yeseo', displayName: '예서', photoVersion: null, character: snapshot.user.character ?? 'bunny' },
      canSkip: false, canNext: true } };
    await route.fulfill({ json: current });
  });
  await skip.click();
  await expect.poll(() => submitted).toMatchObject({ roundId: current.catchmind.round!.id, expectedTurnId: 'e2e-siwon' });
  await expect(page.getByRole('button', { name: '다음 그림 그리기', exact: true })).toBeEnabled();
});

test('unchanged version polls preserve picture DOM and drafts do not poll their own drawing', async ({ page }) => {
  const snapshot = await login(page);
  let current = fixture(snapshot, 0);
  await page.clock.install({ time: new Date(NOW) });
  await page.clock.pauseAt(new Date(NOW));
  let reads = 0;
  await page.route('**/api/catchmind**', route => {
    const url = new URL(route.request().url());
    if (url.pathname !== '/api/catchmind') return route.continue();
    reads++;
    return route.fulfill({ json: url.searchParams.get('since') === String(current.version)
      ? { unchanged: true, version: current.version, viewerId: current.viewerId, serverTime: NOW } : current });
  });
  await page.goto('/#/play/catchmind');
  await expect(page.locator('.pg-picture img')).toBeVisible();
  await page.evaluate(() => {
    const picture = document.querySelector('.pg-picture')!;
    window.__pr4PictureChanges = 0;
    new MutationObserver(records => { window.__pr4PictureChanges += records.length; })
      .observe(picture, { attributes: true, subtree: true, childList: true, characterData: true });
  });
  const initial = reads;
  await page.clock.fastForward(4999); expect(reads).toBe(initial);
  await page.clock.fastForward(1); await expect.poll(() => reads).toBe(initial + 1);
  await page.clock.fastForward(5000); await expect.poll(() => reads).toBe(initial + 2);
  expect(await page.evaluate(() => window.__pr4PictureChanges)).toBe(0);
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  const hidden = reads;
  await page.clock.fastForward(30000); expect(reads).toBe(hidden);
  current = { ...current, version: current.version + 1, catchmind: { ...current.catchmind,
    round: { ...current.catchmind.round!, status: 'draft', drawer: { id: snapshot.user.id, username: snapshot.user.username,
      displayName: snapshot.user.displayName, photoVersion: null, character: snapshot.user.character ?? 'bunny' }, word: '사과', image: null },
    canGuess: false, canPublish: true, canReroll: true } };
  await page.reload();
  await expect(page.getByLabel('그림 그리는 캔버스', { exact: true })).toBeVisible();
  const drawingReads = reads;
  await page.clock.fastForward(30000);
  expect(reads).toBe(drawingReads);
});

test('a changed login clears a cached private prompt even when the global version is unchanged', async ({ page }) => {
  const snapshot = await login(page);
  const current = fixture(snapshot, 0);
  let viewerId = snapshot.user.id;
  const secret = '이전계정만보는제시어';
  const author: CatchmindPlayer = { id: snapshot.user.id, username: snapshot.user.username, displayName: snapshot.user.displayName,
    photoVersion: null, character: snapshot.user.character ?? 'bunny' };
  const privateState: CatchmindResponse = { ...current, catchmind: { ...current.catchmind, turn: author,
    round: { ...current.catchmind.round!, status: 'draft', word: secret, image: null,
      drawer: author },
    canGuess: false, canPublish: true, canReroll: true } };
  await page.route('**/api/catchmind**', route => {
    const url = new URL(route.request().url());
    if (url.pathname !== '/api/catchmind') return route.continue();
    if (url.searchParams.has('since')) return route.fulfill({ json: {
      unchanged: true, version: current.version, viewerId, serverTime: NOW,
    } });
    return route.fulfill({ json: viewerId === snapshot.user.id ? privateState : {
      ...privateState, viewerId, catchmind: { ...privateState.catchmind,
        round: { ...privateState.catchmind.round!, word: null }, canPublish: false, canReroll: false },
    } });
  });
  await page.goto('/#/play/catchmind');
  await expect(page.locator('.pg-prompt')).toContainText(secret);
  const switched = await page.request.post('/api/auth/login', {
    headers: { Origin: ORIGIN, 'CF-Connecting-IP': '192.0.2.26' },
    data: { username: 'min', password: 'e2e-only-password-2026' },
  });
  expect(switched.status()).toBe(200);
  const response = await switched.json(); viewerId = response.user.id;
  const changedBootstrap = page.waitForResponse(async response => response.url().endsWith('/api/bootstrap')
    && response.ok() && (await response.json()).user.id === viewerId);
  // Own drafts do not have a timer poll; a visible return still checks identity.
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await changedBootstrap;
  await expect(page.locator('.pg-prompt')).toHaveCount(0);
  await expect(page.getByText(secret, { exact: true })).toHaveCount(0);
});

test('serverless drawing uses the cyclic next drawer and keeps drawing, fill and undo local', async ({ page }, info) => {
  await page.clock.setFixedTime(new Date(NOW));
  const requests: string[] = [];
  await page.route('**/api/**', route => { requests.push(route.request().url()); return route.abort(); });
  await page.goto('/#/preview/play/catchmind');
  await page.getByLabel('캐치마인드 정답', { exact: true }).fill('선인장');
  await page.getByRole('button', { name: '정답', exact: true }).click();
  await expect(page.locator('.pg-next-player')).toContainText('yeseo님');
  await page.getByRole('button', { name: '다음 그림 그리기', exact: true }).click();
  const canvas = page.getByLabel('그림 그리는 캔버스', { exact: true });
  await expect(canvas).toBeVisible();
  await expect(page.locator('canvas.drawing-stroke-overlay')).toHaveCount(1);
  const box = await canvas.boundingBox();
  await page.mouse.move(box!.x + 30, box!.y + 30); await page.mouse.down();
  await page.mouse.move(box!.x + 160, box!.y + 130, { steps: 20 }); await page.mouse.up();
  await expect(page.getByRole('button', { name: '한 획 되돌리기' })).toBeEnabled();
  await capture(page, 'drawing', info);
  await page.getByRole('button', { name: '한 획 되돌리기' }).click();
  await expect(page.getByRole('button', { name: '그림 올리기', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: '채우기', exact: true }).click();
  await canvas.click({ position: { x: 20, y: 20 } });
  const pixel = await canvas.evaluate(node => Array.from((node as HTMLCanvasElement).getContext('2d')!.getImageData(0, 0, 1, 1).data));
  expect(pixel).toEqual([94, 106, 138, 255]);
  expect(requests).toEqual([]);
});

test('administrator word warnings start at thirty remaining words and previews stay serverless', async ({ page }) => {
  const authenticated = await page.request.post('/api/auth/login', {
    headers: { Origin: ORIGIN, 'CF-Connecting-IP': '192.0.2.26' },
    data: { username: 'admin', password: 'e2e-only-password-2026' },
  });
  expect(authenticated.status()).toBe(200);
  const actual = await (await page.request.get('/api/admin')).json();
  let remaining = 31;
  await page.route('**/api/admin', route => route.fulfill({ json: { ...actual, catchmindWordsRemaining: remaining } }));
  await page.goto('/#/admin');
  await expect(page.locator('.admin-page')).toBeVisible();
  await expect(page.locator('.admin-word-warning')).toHaveCount(0);
  for (const count of [30, 0]) {
    remaining = count;
    await page.reload();
    await expect(page.locator('.admin-word-warning')).toContainText(`남은 제시어 ${count}개`);
  }
  const apiCalls: string[] = [];
  await page.route('**/api/**', route => { apiCalls.push(route.request().url()); return route.abort(); });
  await page.goto('/#/preview/admin');
  await expect(page.locator('.admin-page')).toBeVisible();
  await expect(page.locator('.admin-word-warning')).toHaveCount(0);
  expect(apiCalls).toEqual([]);
});
