import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import type { CatchmindResponse } from '../../shared/types';
import { ServerClock, startClockServers, type ClockServers } from './clock-servers';

// One Catchmind round is kept across the 23:50 close and midnight. Its board
// (and version) never changes, so nothing but the clock can close and reopen
// the inputs: by 23:50 they are closed, after midnight they are open again,
// and what the player was writing or drawing is still there.
const INSTANTS = ['2026-10-30T14:49:30Z', '2026-10-30T14:50:05Z', '2026-10-30T14:55:00Z', '2026-10-30T15:00:05Z'] as const; // 23:49:30, 23:50:05, 23:55:00, 00:00:05 KST
const [, CLOSED, LATE, NEXT_DAY] = [0, 1, 2, 3];
const CLOSED_NOTE = '오늘 게임은 밤 11시 50분에 마감했어요';
const DRAWING = `data:image/webp;base64,${readFileSync('tests/fixtures/drawing-canvas-680.webp').toString('base64')}`;
test.use({ serviceWorkers: 'block' });

async function login(page: Page, servers: ClockServers, username: string) {
  await page.setExtraHTTPHeaders({ 'CF-Connecting-IP': '192.0.2.47' });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  // A running clock: the screen's own timers fire as the test lets time pass.
  const clock = await ServerClock.attach(page, servers, INSTANTS, true);
  await page.goto(`${servers.origins[0]}/`);
  await page.getByLabel('아이디', { exact: true }).fill(username);
  await page.getByLabel('비밀번호', { exact: true }).fill('e2e-only-password-2026');
  await page.getByRole('button', { name: '예굼방 들어가기' }).click();
  await expect(page.locator('.room-name').filter({ hasText: `${username}님` })).toBeVisible();
  return clock;
}
const open = (page: Page, path: string) => page.evaluate(value => { location.hash = value; }, path);
async function setHidden(page: Page, hidden: boolean) {
  await page.evaluate(value => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => value ? 'hidden' : 'visible' });
    document.dispatchEvent(new Event('visibilitychange'));
  }, hidden);
}
const canvas = (page: Page) => page.getByLabel('그림 그리는 캔버스', { exact: true });
async function drawLine(page: Page) {
  await canvas(page).scrollIntoViewIfNeeded();
  const box = (await canvas(page).boundingBox())!;
  await page.mouse.move(box.x + box.width * .25, box.y + box.height * .5);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * .75, box.y + box.height * .5, { steps: 8 });
  await page.mouse.up();
}
const inkAtCentre = (page: Page) => canvas(page).evaluate(element => {
  const node = element as HTMLCanvasElement;
  return Array.from(node.getContext('2d')!.getImageData(node.width / 2, node.height / 2, 1, 1).data).join(',');
});

test.describe('the drawer of a draft (no polling)', () => {
  let servers: ClockServers;
  test.beforeAll(async ({}, info) => { info.setTimeout(240_000); servers = await startClockServers('catchmind-drawer', 8797, INSTANTS); });
  test.afterAll(async () => { await servers?.stop(); });

  test('publishing closes at 23:50 and reopens after midnight on the same draft, keeping the answer and the drawing', async ({ page }) => {
    test.setTimeout(120_000);
    const clock = await login(page, servers, 'min');
    await open(page, '/play/catchmind');
    await page.getByRole('button', { name: '그리기 맡기', exact: true }).click();
    const word = page.getByLabel('정답', { exact: true });
    await word.fill('피사의 사탑');
    await drawLine(page);
    const publish = page.getByRole('button', { name: '그림 올리기', exact: true });
    await expect(publish).toBeEnabled();
    const drawn = await inkAtCentre(page);
    const round = (await clock.get<CatchmindResponse>('/api/catchmind')).catchmind.round!;
    expect(round.status).toBe('draft');
    const reads: string[] = [];
    page.on('request', request => { if (new URL(request.url()).pathname === '/api/catchmind') reads.push(request.url()); });

    // 23:49:30 → 23:50:05. Nobody polls for the drawer: the clock alone closes publishing.
    await clock.advanceTo(CLOSED);
    await expect(page.getByText(CLOSED_NOTE)).toBeVisible();
    await expect(publish).toBeDisabled();
    await expect(canvas(page)).toHaveAttribute('aria-disabled', 'true');
    await expect(word).toHaveValue('피사의 사탑');
    expect(await inkAtCentre(page)).toBe(drawn);
    // The screen asked the server once at the boundary, and the board had not changed.
    await expect.poll(() => reads.length).toBeGreaterThanOrEqual(1);
    expect(reads.every(url => /since=\d+/.test(url))).toBe(true);

    // 23:55: still closed. The tab then sleeps through midnight (no timer runs).
    await clock.advanceTo(LATE);
    await expect(publish).toBeDisabled();
    await setHidden(page, true);
    await clock.sleepTo(NEXT_DAY);
    await setHidden(page, false);
    // Back on the tab at 00:00:05: open again, same draft, nothing lost.
    await expect(page.getByText(CLOSED_NOTE)).toHaveCount(0);
    await expect(publish).toBeEnabled();
    await expect(word).toHaveValue('피사의 사탑');
    expect(await inkAtCentre(page)).toBe(drawn);
    expect((await clock.get<CatchmindResponse>('/api/catchmind')).catchmind.round).toMatchObject({ id: round.id, status: 'draft' });

    await publish.click();
    await expect(page.locator('.pg-prompt')).toContainText('피사의 사탑');
    expect((await clock.get<CatchmindResponse>('/api/catchmind')).catchmind.round).toMatchObject({ id: round.id, status: 'open' });
  });
});

test.describe('a guesser on an open round', () => {
  let servers: ClockServers;
  test.beforeAll(async ({}, info) => { info.setTimeout(240_000); servers = await startClockServers('catchmind-guesser', 8801, INSTANTS); });
  test.afterAll(async () => { await servers?.stop(); });

  test('guessing closes at 23:50 and reopens after midnight on the same round, keeping the typed answer', async ({ page, browser }) => {
    test.setTimeout(120_000);
    // siwon publishes a round at 23:49:30 through the API.
    const drawer = await browser.newContext();
    try {
      const api = drawer.request;
      const origin = servers.origins[0]!;
      const headers = { Origin: origin, 'CF-Connecting-IP': '192.0.2.48' };
      expect((await api.post(`${origin}/api/auth/login`, { headers, data: { username: 'siwon', password: 'e2e-only-password-2026' } })).status()).toBe(200);
      const claimed = await (await api.post(`${origin}/api/catchmind/claim`, { headers, data: { requestId: crypto.randomUUID(), roundId: null } })).json() as CatchmindResponse;
      const published = await api.post(`${origin}/api/catchmind/publish`, { headers, data: { requestId: crypto.randomUUID(), roundId: claimed.catchmind.round!.id, word: '선인장', image: DRAWING } });
      expect(published.status()).toBe(200);
    } finally { await drawer.close(); }

    const clock = await login(page, servers, 'min');
    await open(page, '/play/catchmind');
    const answer = page.getByRole('textbox', { name: '캐치마인드 정답', exact: true });
    await expect(answer).toBeEnabled();
    await answer.fill('아직 생각 중');
    const submit = page.getByRole('button', { name: '정답', exact: true });
    await expect(submit).toBeEnabled();
    const round = (await clock.get<CatchmindResponse>('/api/catchmind')).catchmind.round!;

    // 23:49:30 → 23:50:05: closed, with the half-written answer still in the box.
    await clock.advanceTo(CLOSED);
    await expect(page.getByText(CLOSED_NOTE)).toBeVisible();
    await expect(answer).toBeDisabled();
    await expect(submit).toBeDisabled();
    await expect(answer).toHaveValue('아직 생각 중');

    // 23:55 on a tab that was hidden and comes back: still closed.
    await setHidden(page, true);
    await clock.sleepTo(LATE);
    await setHidden(page, false);
    await expect(answer).toBeDisabled();
    await expect(page.getByText(CLOSED_NOTE)).toBeVisible();

    // 23:55 → 00:00:05 with the tab open: guessing reopens on the same round.
    await clock.advanceTo(NEXT_DAY);
    await expect(page.getByText(CLOSED_NOTE)).toHaveCount(0);
    await expect(answer).toBeEnabled();
    await expect(answer).toHaveValue('아직 생각 중');
    const current = (await clock.get<CatchmindResponse>('/api/catchmind')).catchmind.round!;
    expect(current).toMatchObject({ id: round.id, status: 'open', wrongCount: 0 });
    await submit.click();
    await expect.poll(async () => (await clock.get<CatchmindResponse>('/api/catchmind')).catchmind.round!.wrongCount).toBe(1);
    await expect(answer).toHaveValue('');
  });
});
