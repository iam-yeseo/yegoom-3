import { expect, test, type Page } from '@playwright/test';
import type { BootstrapResponse, CatchmindResponse } from '../../shared/types';
import { CATCHMIND_RULES } from '../../shared/balance';

test.use({ serviceWorkers: 'block' });

async function signIn(page: Page) {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const response = await page.request.post('/api/auth/login', {
    headers: { Origin: 'http://localhost:8788', 'CF-Connecting-IP': '192.0.2.27' },
    data: { username: 'yeseo', password: 'e2e-only-password-2026' },
  });
  expect(response.status()).toBe(200);
  return (await page.request.get('/api/bootstrap')).json() as Promise<BootstrapResponse>;
}

function draft(snapshot: BootstrapResponse, version: number): CatchmindResponse {
  const player = snapshot.players.find(player => player.id === snapshot.user.id)!;
  const next = snapshot.players.find(candidate => candidate.id !== player.id) ?? snapshot.players[0];
  const drawer = { ...player, character: player.character ?? 'cat' as const };
  return { version, viewerId: player.id, serverTime: snapshot.serverTime, catchmind: {
    round: { id: 'auth-draft', number: 1, status: 'draft', drawer, word: version === 7 ? '사과' : '바나나',
      wordVersion: version - 7, rerollsLeft: CATCHMIND_RULES.rerolls - (version - 7), image: null, wrongCount: 0, hint: null,
      winner: null, winnerScored: false, endReason: null, publishedAt: null, endedAt: null, guesses: [] },
    turn: drawer, nextDrawer: next ? { ...next, character: next.character ?? 'cat' } : drawer,
    previousRound: null, canClaim: false, canReroll: true, canPublish: true,
    canGuess: false, canEnd: false, canNext: false, canSkip: false, skipAvailableAt: null,
  } };
}

test('an obsolete unauthorized read cannot erase a newer successful drawing mutation', async ({ page }) => {
  const snapshot = await signIn(page);
  let current = draft(snapshot, 7), held = false, bootstrapReads = 0;
  let release = () => {};
  const gate = new Promise<void>(resolve => { release = resolve; });
  page.on('request', request => { if (new URL(request.url()).pathname === '/api/bootstrap') bootstrapReads++; });
  await page.route('**/api/catchmind', route => route.fulfill({ json: current }));
  await page.route('**/api/catchmind?*', async route => {
    held = true;
    await gate;
    await route.fulfill({ status: 401, json: { error: { code: 'UNAUTHENTICATED', message: 'old session' } } });
  });
  await page.route('**/api/catchmind/reroll', route => {
    current = draft(snapshot, 8);
    return route.fulfill({ json: current });
  });
  try {
    await page.goto('/#/play/catchmind');
    await expect(page.locator('.pg-prompt')).toContainText('사과');
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    await expect.poll(() => held).toBe(true);
    await page.getByRole('button', { name: /제시어 바꾸기/ }).click();
    await expect(page.locator('.pg-prompt')).toContainText('바나나');
    const readsAfterMutation = bootstrapReads;
    const completed = page.waitForResponse(response => response.url().includes('/api/catchmind?') && response.status() === 401);
    release();
    await completed;
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await expect(page.locator('.pg-prompt')).toContainText('바나나');
    expect(bootstrapReads).toBe(readsAfterMutation);
  } finally { release(); }
});

test('a renewed session for the same account recovers a cleared private view', async ({ page }) => {
  const snapshot = await signIn(page);
  let fullReads = 0, rejected = false;
  await page.route('**/api/catchmind', route => {
    fullReads++;
    return route.fulfill({ json: draft(snapshot, fullReads === 1 ? 7 : 8) });
  });
  await page.route('**/api/catchmind?*', route => {
    if (!rejected) {
      rejected = true;
      return route.fulfill({ status: 401, json: { error: { code: 'UNAUTHENTICATED', message: 'renew session' } } });
    }
    return route.fulfill({ json: { unchanged: true, version: 8, viewerId: snapshot.user.id, serverTime: snapshot.serverTime } });
  });
  await page.goto('/#/play/catchmind');
  await expect(page.locator('.pg-prompt')).toContainText('사과');
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await expect(page.locator('.pg-prompt')).toContainText('바나나');
  expect(fullReads).toBe(2);
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await expect(page.locator('.pg-prompt')).toContainText('바나나');
});

test('a later same-account bootstrap recovers private drawing after the first recovery bootstrap fails', async ({ page }) => {
  const snapshot = await signIn(page);
  let fullReads = 0, rejected = false, failedRecovery = 0, successfulBootstraps = 0;
  await page.route('**/api/bootstrap', route => {
    if (rejected && failedRecovery === 0) {
      failedRecovery++;
      return route.fulfill({ status: 503, json: { error: { code: 'TEMPORARY_BOOTSTRAP', message: 'fixture: retry bootstrap' } } });
    }
    successfulBootstraps++;
    return route.fulfill({ json: snapshot });
  });
  await page.route('**/api/catchmind', route => {
    fullReads++;
    return route.fulfill({ json: draft(snapshot, fullReads === 1 ? 7 : 8) });
  });
  await page.route('**/api/catchmind?*', route => {
    if (!rejected) {
      rejected = true;
      return route.fulfill({ status: 401, json: { error: { code: 'UNAUTHENTICATED', message: 'fixture: renewed session' } } });
    }
    return route.fulfill({ json: { unchanged: true, version: 8, viewerId: snapshot.user.id, serverTime: snapshot.serverTime } });
  });
  await page.goto('/#/play/catchmind');
  await expect(page.locator('.pg-prompt')).toContainText('사과');
  // Let the initial board's normal balance-refresh bootstrap finish first so
  // the injected failure belongs to the subsequent authentication recovery.
  await expect.poll(() => successfulBootstraps).toBeGreaterThanOrEqual(2);
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await expect.poll(() => failedRecovery).toBe(1);
  await expect(page.locator('.connection-banner')).toContainText('최신 정보를 불러오지 못했어요');
  await expect(page.locator('.pg-prompt')).toHaveCount(0);
  await expect(page.getByText('바나나', { exact: true })).toHaveCount(0);
  expect(fullReads).toBe(1);

  // Online recovery bypasses the normal polling interval. A successful
  // authoritative bootstrap for the same user must release the invalid cache.
  const successfulRetry = page.waitForResponse(response => response.url().endsWith('/api/bootstrap') && response.status() === 200);
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await successfulRetry;
  await expect(page.locator('.pg-prompt')).toContainText('바나나');
  await expect(page.locator('.connection-banner')).toHaveCount(0);
  expect(failedRecovery).toBe(1);
  expect(fullReads).toBe(2);
});
