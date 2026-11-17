import { expect, test, type Page, type Route } from '@playwright/test';
import type { NicknameTag, TagResponse } from '../../shared/types';

// A slow re-read of the tag inventory overlaps a change (wear, discard,
// evolve). Whichever answer arrives first, the change's state stays and the
// loading state ends, so the draw button works again.
const MORNING = '2026-10-30T00:00:00Z';
const ORIGIN = 'http://localhost:8788';
test.use({ serviceWorkers: 'block' });
test.beforeEach(async ({ page }) => {
  await page.clock.setFixedTime(new Date(MORNING));
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.setExtraHTTPHeaders({ 'CF-Connecting-IP': '192.0.2.43' });
});
async function login(page: Page, username: string) {
  const response = await page.request.post('/api/auth/login', { headers: { Origin: ORIGIN, 'CF-Connecting-IP': '192.0.2.43' }, data: { username, password: 'e2e-only-password-2026' } });
  expect(response.status(), 'isolated fixture login').toBe(200);
}
const navigate = (page: Page, path: string) => page.evaluate(value => { location.hash = value; }, path);

/** Holds chosen responses back until the test releases them, so it decides the
 * order in which a read and a write are answered. A held read was already
 * answered by the Worker: what it carries is the state before the write. */
async function gate(page: Page, url: string, method: string) {
  const state = { hold: false, waiting: [] as (() => void)[], transform: null as null | ((body: string) => string) };
  await page.route(url, async (route: Route) => {
    if (route.request().method() !== method) return route.fallback();
    const response = await route.fetch();
    let body = await response.text();
    if (state.transform && response.ok()) body = state.transform(body);
    if (state.hold) await new Promise<void>(resolve => state.waiting.push(resolve));
    await route.fulfill({ response, body });
  });
  return { state, held: () => state.waiting.length, release() { state.waiting.splice(0).forEach(resolve => resolve()); } };
}
const drawButton = (page: Page) => page.getByRole('button', { name: /^뽑기 · / });
const tab = (page: Page, name: RegExp) => page.getByRole('tab', { name });
const tagSheet = (page: Page) => page.locator('dialog.tag-draw-dialog');
async function ownedTags(page: Page) {
  return (await (await page.request.get('/api/shop/tag')).json() as TagResponse).tags;
}
/** Draws until the player owns at least `count` tags that are not worn. */
async function ensureTags(page: Page, count: number) {
  await page.request.put('/api/me/nickname-tag', { headers: { Origin: ORIGIN }, data: { tagId: null } });
  for (let owned = (await ownedTags(page)).tags.length; owned < count; owned++) {
    const drawn = await page.request.post('/api/shop/tag', { headers: { Origin: ORIGIN }, data: { requestId: crypto.randomUUID() } });
    expect(drawn.status(), 'fixture draw').toBe(200);
  }
}
/** Opens the inventory while its re-read is held back: the cached tags show. */
async function openInventoryWithSlowRead(page: Page, reads: Awaited<ReturnType<typeof gate>>) {
  await page.goto('/#/shop/tag');
  await expect(drawButton(page)).toBeEnabled(); // tags are cached now
  reads.state.hold = true;
  await navigate(page, '/shop/tag/inventory');
  await expect.poll(() => reads.held()).toBe(1);
  reads.state.hold = false; // only this one read is slow
  await expect(page.locator('ul.tag-collection button').first()).toBeVisible();
}
async function expectDrawUsable(page: Page) {
  await tab(page, /^뽑기$/).click();
  await expect(drawButton(page)).toBeEnabled();
  await tab(page, /^인벤토리 \d+$/).click();
}

test('wearing a tag during a slow re-read: the change stays and loading ends, in either answer order', async ({ page }) => {
  test.setTimeout(90_000);
  await login(page, 'siwon');
  await ensureTags(page, 1);
  const reads = await gate(page, '**/api/shop/tag', 'GET');
  const wears = await gate(page, '**/api/me/nickname-tag', 'PUT');
  const worn = page.locator('ul.tag-collection button[aria-pressed="true"]');

  // 1) The change is answered first, the stale read afterwards.
  await openInventoryWithSlowRead(page, reads);
  await page.locator('ul.tag-collection button').first().click();
  await tagSheet(page).getByRole('button', { name: '이 별명 달기', exact: true }).click();
  await expect(tagSheet(page)).toHaveCount(0);
  await expect(worn).toHaveCount(1);
  // Nothing that still counts is in flight: the draw button works although the old read never answered.
  await expectDrawUsable(page);
  reads.release(); // the read from before the change says "not worn"
  await page.waitForTimeout(300);
  await expect(worn).toHaveCount(1);
  await expectDrawUsable(page);
  expect((await ownedTags(page)).equipped).not.toBeNull();

  // 2) The stale read is answered first, while the change is still on its way.
  await openInventoryWithSlowRead(page, reads);
  wears.state.hold = true;
  await page.locator('section[aria-label="지금 내 별명"]').getByRole('button', { name: '별명 떼기', exact: true }).click();
  await expect.poll(() => wears.held()).toBe(1);
  reads.release();
  await page.waitForTimeout(300);
  // The change is still running: loading is not released early, and the stale "worn" read changed nothing.
  await tab(page, /^뽑기$/).click();
  await expect(drawButton(page)).toBeDisabled();
  wears.state.hold = false;
  wears.release();
  await expect(drawButton(page)).toBeEnabled();
  await tab(page, /^인벤토리 \d+$/).click();
  await expect(worn).toHaveCount(0);
  expect((await ownedTags(page)).equipped).toBeNull();
});

test('discarding during a slow re-read keeps the tag gone, and a failed change reloads and ends loading', async ({ page }) => {
  test.setTimeout(90_000);
  await login(page, 'siwon');
  await ensureTags(page, 2);
  const reads = await gate(page, '**/api/shop/tag', 'GET');
  const before = (await ownedTags(page)).tags.length;

  await openInventoryWithSlowRead(page, reads);
  await expect(page.locator('ul.tag-collection button')).toHaveCount(before);
  await page.locator('ul.tag-collection button').first().click();
  await tagSheet(page).getByRole('button', { name: '버리기', exact: true }).click();
  await expect(tagSheet(page)).toHaveCount(0);
  await expect(page.locator('ul.tag-collection button')).toHaveCount(before - 1);
  await expectDrawUsable(page);
  reads.release(); // still lists the discarded tag
  await page.waitForTimeout(300);
  await expect(page.locator('ul.tag-collection button')).toHaveCount(before - 1);
  await expectDrawUsable(page);
  expect((await ownedTags(page)).tags).toHaveLength(before - 1);

  // A change that fails: the overtaken read is asked again, then loading ends.
  await page.route('**/api/me/nickname-tag', route => route.request().method() === 'PUT'
    ? route.fulfill({ status: 500, json: { error: { code: 'INTERNAL_ERROR', message: '잠시 문제가 생겼어요. 다시 시도해 주세요.' } } }) : route.fallback());
  await openInventoryWithSlowRead(page, reads);
  await page.locator('ul.tag-collection button').first().click();
  await tagSheet(page).getByRole('button', { name: '이 별명 달기', exact: true }).click();
  await expect(page.getByRole('alert').filter({ hasText: '잠시 문제가 생겼어요' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(tagSheet(page)).toHaveCount(0);
  await expect(page.locator('ul.tag-collection button[aria-pressed="true"]')).toHaveCount(0);
  await expectDrawUsable(page);
  reads.release();
  await page.waitForTimeout(300);
  await expectDrawUsable(page);
  expect((await ownedTags(page)).equipped).toBeNull();
});

test('evolving during a slow re-read shows the result and ends loading', async ({ page }) => {
  test.setTimeout(90_000);
  await login(page, 'siwon');
  await ensureTags(page, 1);
  // Two tags with the same phrase are needed; the inventory read is extended
  // with a matching pair and the attempt is answered for it. The provider and
  // the screen under test are the real ones.
  const pair: NicknameTag[] = ['base', 'material'].map(id => ({ id: `e2e-evolve-${id}`, grade: 'C', text: '배가 고픈', equipped: false, createdAt: MORNING, payment: 'free' }));
  let evolved = false;
  const withPair = (body: string) => {
    const data = JSON.parse(body) as TagResponse;
    const extra = evolved ? [{ ...pair[0]!, grade: 'B' as const }] : pair;
    return JSON.stringify({ ...data, tags: { ...data.tags, tags: [...extra, ...data.tags.tags] } });
  };
  const reads = await gate(page, '**/api/shop/tag', 'GET');
  reads.state.transform = withPair;
  await page.route('**/api/me/nickname-tag/evolve', async route => {
    const stale = JSON.parse(withPair(await (await page.request.get('/api/shop/tag')).text())) as TagResponse;
    evolved = true;
    const tag = { ...pair[0]!, grade: 'B' as const };
    await route.fulfill({ json: { ...stale, tags: { ...stale.tags, evolvesToday: stale.tags.evolvesToday + 1, tags: [tag, ...stale.tags.tags.filter(entry => !entry.id.startsWith('e2e-evolve-'))] },
      evolution: { requestId: 'e2e', tag, text: tag.text, fromGrade: 'C', toGrade: 'B', materialGrade: 'C', chance: 30, success: true, materialLost: true, cost: 0 } } });
  });

  await openInventoryWithSlowRead(page, reads);
  await page.locator('button[data-tag-id="e2e-evolve-base"]').click();
  await tagSheet(page).getByRole('button', { name: '진화 도전', exact: true }).click();
  await tagSheet(page).getByRole('button', { name: /^진화 도전 · / }).click();
  const result = page.getByRole('dialog', { name: '별명 태그 진화 결과' });
  await expect(result).toContainText('진화 성공!');
  await result.getByRole('button', { name: '확인', exact: true }).click();
  await expect(page.locator('section[aria-label="B등급 별명 태그"] button[data-tag-id="e2e-evolve-base"]')).toBeVisible();
  await expect(page.locator('button[data-tag-id="e2e-evolve-material"]')).toHaveCount(0);
  await expectDrawUsable(page);
  // The read from before the attempt still lists the C pair; it must not come back.
  reads.release();
  await page.waitForTimeout(300);
  await expect(page.locator('section[aria-label="B등급 별명 태그"] button[data-tag-id="e2e-evolve-base"]')).toBeVisible();
  await expect(page.locator('button[data-tag-id="e2e-evolve-material"]')).toHaveCount(0);
  await expectDrawUsable(page);
});
