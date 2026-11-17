import { expect, test, type Page } from '@playwright/test';
import type { SlotResponse, SlotSpinInput, SpeettoPurchaseInput, SpeettoResponse } from '../../shared/types';
import { ServerClock, releaseClock, startClockServers, type ClockServers } from './clock-servers';

// A purchase is stored at 23:49:59 KST but its answer is lost. The same request
// is asked again after the 23:50 close, and after midnight: it must return the
// stored result, while a new purchase stays closed until midnight.
const INSTANTS = ['2026-10-30T14:49:59Z', '2026-10-30T14:50:30Z', '2026-10-30T15:00:10Z'] as const; // 23:49:59, 23:50:30, 00:00:10 KST
const [BEFORE_CLOSE, CLOSED, NEXT_DAY] = [0, 1, 2];
let servers: ClockServers;
test.use({ serviceWorkers: 'block' });
test.beforeAll(async ({}, info) => {
  info.setTimeout(240_000);
  servers = await startClockServers('close-receipt', 8794, INSTANTS);
});
test.afterAll(async () => { await servers?.stop(); });
test.afterEach(async ({ page }) => { await releaseClock(page); });

async function login(page: Page, username: string) {
  await page.setExtraHTTPHeaders({ 'CF-Connecting-IP': '192.0.2.45' });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const clock = await ServerClock.attach(page, servers, INSTANTS);
  await page.goto(`${servers.origins[0]}/`);
  await page.getByLabel('아이디', { exact: true }).fill(username);
  await page.getByLabel('비밀번호', { exact: true }).fill('e2e-only-password-2026');
  await page.getByRole('button', { name: '예굼방 들어가기' }).click();
  await expect(page.locator('.room-name').filter({ hasText: `${username}님` })).toBeVisible();
  return clock;
}
const open = (page: Page, path: string) => page.evaluate(value => { location.hash = value; }, path);
/** The purchase reaches the Worker and is stored; while `lose` is on, its answer never comes back. */
async function loseAnswers<T extends { requestId: string }>(page: Page, clock: ServerClock, path: string) {
  const state = { lose: true, sent: [] as T[] };
  await page.route(`${servers.origins[0]}${path}`, async route => {
    if (route.request().method() !== 'POST') return route.fallback();
    state.sent.push(route.request().postDataJSON() as T);
    if (!state.lose) return route.fallback();
    await clock.fetch(route);
    await route.abort('connectionreset');
  });
  return state;
}

test('a slot spin stored at 23:49:59 is shown when its request is retried after the 23:50 close', async ({ page }) => {
  test.setTimeout(90_000);
  const clock = await login(page, 'min');
  const spins = await loseAnswers<SlotSpinInput>(page, clock, '/api/shop/slot');
  await open(page, '/shop/slot');
  await page.getByRole('button', { name: /^돌리기 · 이용권 1장/ }).click();
  const retry = page.getByRole('button', { name: '같은 요청으로 다시 확인', exact: true });
  await expect(retry).toBeEnabled();
  await expect(page.locator('.slot-result')).toHaveText('결과 확인 중');
  const stored = (await clock.get<SlotResponse>('/api/shop/slot')).slot.recent;
  expect(stored.map(spin => spin.requestId)).toEqual([spins.sent[0]!.requestId]);

  // 23:50:30: the day is closed, and the same request still gets its stored result.
  await clock.moveTo(CLOSED);
  spins.lose = false;
  await retry.click();
  await expect(page.locator('.slot-result')).toHaveText(stored[0]!.prize > 0 ? /^7 7 7!/ : '아쉬워요, 다음 기회에!');
  await expect(page.locator(`.slot-history-row[data-spin-id="${stored[0]!.id}"]`)).toHaveCount(1);
  expect(spins.sent.map(sent => sent.requestId)).toEqual([spins.sent[0]!.requestId, spins.sent[0]!.requestId]);
  expect(await page.evaluate(() => sessionStorage.getItem('yegoom3:shop:pending:e2e-min'))).toBeNull();

  // A new spin is a new purchase: closed until midnight, and nothing more is stored.
  await page.getByRole('button', { name: /^돌리기 · / }).click();
  await expect(page.getByRole('alert').filter({ hasText: '밤 11시 50분에 마감' })).toBeVisible();
  expect(spins.sent).toHaveLength(3);
  expect(spins.sent[2]!.requestId).not.toBe(spins.sent[0]!.requestId);
  expect((await clock.get<SlotResponse>('/api/shop/slot')).slot.recent.map(spin => spin.id)).toEqual([stored[0]!.id]);
  // Past midnight the same request is still only that one spin.
  await clock.moveTo(NEXT_DAY);
  const again = await page.request.post(`${clock.origin}/api/shop/slot`, { headers: { Origin: clock.origin }, data: spins.sent[0] });
  expect(((await again.json()) as SlotResponse).spin).toMatchObject({ id: stored[0]!.id, requestId: spins.sent[0]!.requestId });
  expect((await clock.get<SlotResponse>('/api/shop/slot')).slot.recent.map(spin => spin.id)).toEqual([stored[0]!.id]);
});

test('a speetto bought at 23:49:59 is confirmed after midnight with its stored result, and nothing is bought again', async ({ page }) => {
  test.setTimeout(90_000);
  const clock = await login(page, 'siwon');
  const purchases = await loseAnswers<SpeettoPurchaseInput>(page, clock, '/api/shop/speetto');
  await open(page, '/shop/speetto');
  const pay = page.getByRole('button', { name: /^이용권으로 사기/ });
  await pay.click();
  await page.getByRole('dialog', { name: '구매 확인', exact: true }).getByRole('button', { name: '구매하기' }).click();
  await expect(page.getByText('아직 확인하지 못한 구매가 있어요.')).toBeVisible();
  const before = await clock.get<SpeettoResponse>('/api/shop/speetto');
  const ticket = before.speetto.tickets.find(entry => entry.requestId === purchases.sent[0]!.requestId)!;
  expect(ticket).toBeTruthy();

  // 00:00:10 the next day: the retry returns the purchase stored yesterday.
  await clock.moveTo(NEXT_DAY);
  purchases.lose = false;
  await expect(pay).toBeEnabled();
  await pay.click();
  const result = page.getByRole('dialog', { name: '스피또 결과' });
  await expect(result).toBeVisible();
  await expect(result).toContainText(ticket.won ? '당첨!' : '아쉽지만 낙첨이에요');
  await expect(result).toContainText(`No. ${ticket.id.slice(-8)}`);
  expect(purchases.sent.map(sent => sent.requestId)).toEqual([purchases.sent[0]!.requestId, purchases.sent[0]!.requestId]);
  expect(await page.evaluate(() => sessionStorage.getItem('yegoom3:shop:pending:e2e-siwon'))).toBeNull();
  // Nothing was bought on the new day, and yesterday still holds exactly that one ticket.
  expect((await clock.get<SpeettoResponse>('/api/shop/speetto')).speetto.tickets).toEqual([]);
  expect((await clock.get<SpeettoResponse>('/api/shop/speetto', BEFORE_CLOSE)).speetto.tickets.filter(entry => entry.requestId === ticket.requestId)).toHaveLength(1);
  expect((await clock.get<SpeettoResponse>('/api/shop/speetto', BEFORE_CLOSE)).speetto.tickets).toHaveLength(before.speetto.tickets.length);
});
