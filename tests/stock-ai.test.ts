import { readFile, readdir, rm } from 'node:fs/promises';
import { Miniflare } from 'miniflare';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { kstTimestamp, tickTimes } from '../shared/market-calendar';
import { dayItems } from '../shared/stock-market';
import { advanceStocks, daySeeds } from '../worker/stocks';
import { costMicroUsd, estimateMicroUsd, readAiStatus, saveAiSettings, SYSTEM_PROMPT, validArticle, writeCloseNews, writeMorningNews, type AiResult, type AiWriter } from '../worker/stock-ai';

const SECRET = 'test-only-stock-seed-secret-2026';
const kst = (date: string, time: string) => kstTimestamp(date, time);
type Database = Awaited<ReturnType<Miniflare['getD1Database']>>;
let migration = '';
let worker: Miniflare;
let db: D1Database;
let persist = '';

async function applyMigration(database: Database, sql: string) {
  let statement = '';
  for (const sourceLine of sql.split('\n')) {
    const line = sourceLine.trim();
    if (!line || line.startsWith('--')) continue;
    statement += `${line}\n`;
    const trigger = /^CREATE TRIGGER\b/i.test(statement);
    if (line.endsWith(';') && (!trigger || /\bEND;$/i.test(line))) { await database.prepare(statement).run(); statement = ''; }
  }
}
beforeAll(async () => {
  const files = (await readdir(new URL('../migrations/', import.meta.url))).filter(file => file.endsWith('.sql')).sort();
  migration = (await Promise.all(files.map(file => readFile(new URL(`../migrations/${file}`, import.meta.url), 'utf8')))).join('\n');
});
beforeEach(async () => {
  persist = `.test-build/stock-ai-${crypto.randomUUID()}`;
  worker = new Miniflare({ modules: true, script: 'export default { fetch() { return new Response("") } }', compatibilityDate: '2026-08-06', d1Databases: ['DB'], d1Persist: persist });
  const database = await worker.getD1Database('DB');
  await applyMigration(database, migration);
  for (const [id, role] of [['min', 'player'], ['siwon', 'player'], ['admin', 'admin']]) {
    await database.prepare("INSERT INTO users (id, username, display_name, password_hash, role) VALUES (?, ?, ?, 'x', ?)").bind(id, id, id === 'min' ? '민' : id, role).run();
  }
  await database.prepare('UPDATE stock_state SET last_tick_at = ?').bind(kst('2026-11-05', '18:00')).run();
  db = database as unknown as D1Database;
});
afterEach(async () => { await worker.dispose(); await rm(persist, { recursive: true, force: true }); });

const usage = { input: 3000, output: 2000, cacheWrite: 0, cacheRead: 2500 };
function fake(respond: (prompt: string) => Partial<AiResult> | Error): AiWriter & { calls: string[] } {
  const calls: string[] = [];
  const writer = (async ({ prompt }: { prompt: string }) => {
    calls.push(prompt);
    const result = respond(prompt);
    if (result instanceof Error) throw result;
    return { text: null, refused: false, fallback: false, usage, ...result };
  }) as unknown as AiWriter & { calls: string[] };
  writer.calls = calls;
  return writer;
}
const date = '2026-11-06'; // Friday
const morning = kst(date, '08:50');
const eventIds = (prompt: string) => [...prompt.matchAll(/"eventId":"([^"]+)"/g)].map(match => match[1]!);
const rows = async () => (await advanceStocks(db, SECRET, morning)).rows;
const seed = async () => (await daySeeds(SECRET, [date])).get(date)!;
const aiNews = async () => (await db.prepare("SELECT id, publish_at, source, headline FROM stock_news WHERE source = 'ai' ORDER BY id").all<{ id: string; publish_at: number; source: string; headline: string }>()).results;

describe('AI morning news', () => {
  it('writes every scheduled article ahead of time, hidden until its tick, and the tick keeps the AI text', async () => {
    const writer = fake(prompt => ({ text: JSON.stringify({ items: eventIds(prompt).map((eventId, n) => ({ eventId, headline: `AI 기사 ${n}`, body: '짧은 본문이다.' })) }) }));
    const stocks = await rows();
    const written = await writeMorningNews(db, { openai: writer }, await seed(), date, stocks, morning);
    const items = dayItems(await seed(), date);
    expect(written).toBe(items.length);
    expect(writer.calls).toHaveLength(1);
    expect(writer.calls[0]).not.toMatch(/\d+(\.\d+)?%/); // no exact percentages in the request
    const rowsBefore = await aiNews();
    expect(rowsBefore.map(row => row.id).sort()).toEqual(items.map(item => item.id).sort());
    for (const item of items) expect(rowsBefore.find(row => row.id === item.id)!.publish_at).toBe(kst(date, tickTimes()[item.index]!));
    // Visible to nobody before publication: every read filters publish_at <= now.
    expect(rowsBefore.every(row => row.publish_at > morning)).toBe(true);
    // Run the day: the ticks publish the same rows (no duplicates, AI text kept).
    for (let at = kst(date, '09:00'); at <= kst(date, '18:00'); at += 6 * 3_600_000) await advanceStocks(db, SECRET, at);
    await advanceStocks(db, SECRET, kst(date, '18:00'));
    const ids = items.map(item => item.id);
    const published = (await db.prepare(`SELECT id, source FROM stock_news WHERE id IN (SELECT value FROM json_each(?))`).bind(JSON.stringify(ids)).all<{ id: string; source: string }>()).results;
    expect(published).toHaveLength(ids.length);
    expect(published.every(row => row.source === 'ai')).toBe(true);
    // The same morning never calls twice.
    await writeMorningNews(db, { openai: writer }, await seed(), date, stocks, morning);
    expect(writer.calls).toHaveLength(1);
    const status = await readAiStatus(db, date, { anthropic: false, openai: true });
    expect(status).toMatchObject({ provider: 'openai', keyConfigured: true, today: { calls: 1, costMicroUsd: costMicroUsd(usage, false, 'openai') } });
  });

  it('keeps templates for items that fail validation, malformed output, refusals, errors and a missing key', async () => {
    const stocks = await rows();
    const items = dayItems(await seed(), date);
    // First item: too long and answered twice; second: investment advice; plus an unknown event.
    const partial = fake(prompt => ({ text: JSON.stringify({ items: [
      ...eventIds(prompt).map((eventId, n) => ({ eventId, headline: n === 0 ? '가'.repeat(41) : `기사 ${n}`, body: n === 1 ? '지금 당장 사세요.' : '본문.' })),
      { eventId: items[0]!.id, headline: '중복', body: '두 번째' },
      { eventId: 'news:unknown', headline: '없는 사건', body: '본문.' },
    ] }) }));
    expect(await writeMorningNews(db, { openai: partial }, await seed(), date, stocks, morning)).toBe(items.length - 2);
    const ai = await aiNews();
    expect(ai.map(row => row.id)).not.toContain(items[0]!.id);
    expect(ai.map(row => row.id)).not.toContain(items[1]!.id);
    expect(ai.find(row => row.headline === '중복' || row.headline === '없는 사건')).toBeUndefined();
    // Another company's name, banned words and length limits.
    expect(validArticle({ headline: '제목', body: '예굼과 에바참치' }, ['YEGM'])).toBe(false);
    expect(validArticle({ headline: '제목', body: '예굼 사냥 성공' }, ['YEGM'])).toBe(true);
    expect(validArticle({ headline: '제목', body: '가'.repeat(201) }, 'all')).toBe(false);
    expect(validArticle({ headline: '제목', body: '이 종목 팔아라' }, 'all')).toBe(false);

    for (const [day, writer] of [
      ['2026-11-09', fake(() => ({ text: '{"items": [' }))],
      ['2026-11-10', fake(() => ({ refused: true }))],
      ['2026-11-11', fake(() => new Error('timeout'))],
    ] as const) {
      const at = kst(day, '08:50');
      const dayRows = (await advanceStocks(db, SECRET, at)).rows;
      expect(await writeMorningNews(db, { openai: writer }, (await daySeeds(SECRET, [day])).get(day)!, day, dayRows, at)).toBe(0);
      expect(writer.calls).toHaveLength(1);
    }
    const calls = await db.prepare('SELECT date, calls FROM ai_usage ORDER BY date').all();
    // Malformed and refused calls are billed and recorded; a thrown error has no usage.
    expect(calls.results).toEqual([{ date, calls: 1 }, { date: '2026-11-09', calls: 1 }, { date: '2026-11-10', calls: 1 }]);
    const noKey = (await advanceStocks(db, SECRET, kst('2026-11-12', '08:50'))).rows;
    expect(await writeMorningNews(db, {}, (await daySeeds(SECRET, ['2026-11-12'])).get('2026-11-12')!, '2026-11-12', noKey, kst('2026-11-12', '08:50'))).toBe(0);
  });

  it('does not call when switched off or when the estimate would pass the $0.80 daily cap', async () => {
    const stocks = await rows();
    const writer = fake(() => ({ text: '{"items":[]}' }));
    await db.prepare("UPDATE stock_settings SET value = '0' WHERE key = 'ai_enabled'").run();
    await writeMorningNews(db, { openai: writer }, await seed(), date, stocks, morning);
    expect(writer.calls).toHaveLength(0);
    await db.prepare("UPDATE stock_settings SET value = '1' WHERE key = 'ai_enabled'").run();
    await db.prepare("INSERT INTO ai_usage (date, calls, cost_micro_usd) VALUES ('2026-11-09', 2, 700000)").run();
    const monday = kst('2026-11-09', '08:50');
    const mondayRows = (await advanceStocks(db, SECRET, monday)).rows;
    await writeMorningNews(db, { openai: writer }, (await daySeeds(SECRET, ['2026-11-09'])).get('2026-11-09')!, '2026-11-09', mondayRows, monday);
    expect(writer.calls).toHaveLength(0);
    expect(700_000 + estimateMicroUsd(SYSTEM_PROMPT, 'x', 'openai')).toBeGreaterThan(800_000);
  });

  it('prices usage per million tokens: $4 in, $20 out, $5 cache write, $0.20 cache read', () => {
    expect(costMicroUsd({ input: 1000, output: 2000, cacheWrite: 3000, cacheRead: 10000 })).toBe(4000 + 40000 + 15000 + 2000);
    expect(costMicroUsd({ input: 1000, output: 0, cacheWrite: 0, cacheRead: 0 }, true)).toBe(5000);
    expect(estimateMicroUsd('a'.repeat(1000), 'b'.repeat(1000))).toBe(2000 * 6.25 + 16000 * 25);
    // OpenAI gpt-6.1-sol: $2 input, $0.20 cached input, $10 output.
    expect(costMicroUsd({ input: 1000, output: 2000, cacheWrite: 0, cacheRead: 10000 }, false, 'openai')).toBe(2000 + 20000 + 2000);
    expect(estimateMicroUsd('a'.repeat(1000), 'b'.repeat(1000), 'openai')).toBe(2000 * 2 + 16000 * 10);
  });
});

describe('AI engine choice', () => {
  it('uses the engine the administrator picked, and never switches engines when its key is missing', async () => {
    const stocks = await rows();
    const respond = (prompt: string) => ({ text: JSON.stringify({ items: eventIds(prompt).map(eventId => ({ eventId, headline: '제목', body: '본문.' })) }) });
    const openai = fake(respond), anthropic = fake(respond);
    // Default engine: OpenAI.
    await writeMorningNews(db, { openai, anthropic }, await seed(), date, stocks, morning);
    expect([openai.calls.length, anthropic.calls.length]).toEqual([1, 0]);
    await saveAiSettings(db, 'admin', { provider: 'anthropic' }, morning);
    const monday = kst('2026-11-09', '08:50');
    const mondayRows = (await advanceStocks(db, SECRET, monday)).rows;
    await writeMorningNews(db, { openai, anthropic }, (await daySeeds(SECRET, ['2026-11-09'])).get('2026-11-09')!, '2026-11-09', mondayRows, monday);
    expect([openai.calls.length, anthropic.calls.length]).toEqual([1, 1]);
    // Claude chosen but only an OpenAI key: templates, no call to OpenAI.
    const tuesday = kst('2026-11-10', '08:50');
    const tuesdayRows = (await advanceStocks(db, SECRET, tuesday)).rows;
    expect(await writeMorningNews(db, { openai }, (await daySeeds(SECRET, ['2026-11-10'])).get('2026-11-10')!, '2026-11-10', tuesdayRows, tuesday)).toBe(0);
    expect(openai.calls).toHaveLength(1);
    expect(await readAiStatus(db, '2026-11-10', { anthropic: false, openai: true })).toMatchObject({ enabled: true, provider: 'anthropic', keyConfigured: false });
    await saveAiSettings(db, 'admin', { enabled: false, provider: 'openai' }, tuesday);
    expect(await readAiStatus(db, '2026-11-10', { anthropic: false, openai: true })).toMatchObject({ enabled: false, provider: 'openai', keyConfigured: true });
  });
});

describe('closing news', () => {
  it('writes the summary, per-holder comments only they can read, and the Friday weekly report; AI replaces valid parts', async () => {
    await db.prepare("INSERT INTO stock_holdings (user_id, ticker, quantity, cost_basis) VALUES ('min', 'YEGM', 10, 5000)").run();
    await db.prepare("INSERT INTO stock_daily (ticker, date, open, high, low, close) VALUES ('YKHX', '2026-10-30', 1500, 1500, 1500, 1400)").run();
    const close = kst(date, '18:00');
    const dayRows = (await advanceStocks(db, SECRET, close)).rows;
    const writer = fake(() => ({ text: JSON.stringify({ summary: { headline: 'AI 마감 시황', body: '오늘 시장은 조용했다.' },
      comments: [{ userId: 'min', body: '민님, 모기 사냥팀과 함께 버티는 중!' }, { userId: 'ghost', body: '없는 사람' }], weekly: { headline: 'AI 주간 실적', body: '한 주가 지났다.' } }) }));
    await writeCloseNews(db, { openai: writer }, date, dayRows, close);
    const news = (await db.prepare("SELECT id, kind, headline, body, audience_user_id, source, publish_at FROM stock_news WHERE kind IN ('close', 'comment', 'weekly') ORDER BY id").all()).results;
    expect(news).toEqual([
      { id: `close:${date}`, kind: 'close', headline: 'AI 마감 시황', body: '오늘 시장은 조용했다.', audience_user_id: null, source: 'ai', publish_at: close },
      { id: `comment:${date}:min`, kind: 'comment', headline: '오늘의 한 줄', body: '민님, 모기 사냥팀과 함께 버티는 중!', audience_user_id: 'min', source: 'ai', publish_at: close },
      { id: `weekly:${date}`, kind: 'weekly', headline: 'AI 주간 실적', body: '한 주가 지났다.', audience_user_id: null, source: 'ai', publish_at: close },
    ]);
    // Templates when the AI is unavailable (Monday, no weekly).
    const monday = kst('2026-11-09', '18:00');
    const mondayRows = (await advanceStocks(db, SECRET, monday)).rows;
    await writeCloseNews(db, {}, '2026-11-09', mondayRows, monday);
    const templates = (await db.prepare("SELECT id, source, headline, body FROM stock_news WHERE kind IN ('close', 'comment', 'weekly') AND id LIKE '%2026-11-09%' ORDER BY id").all<{ id: string; source: string; headline: string; body: string }>()).results;
    expect(templates.map(row => [row.id, row.source])).toEqual([['close:2026-11-09', 'template'], ['comment:2026-11-09:min', 'template']]);
    expect(templates[0]!.headline).toMatch(/^\[마감 시황\] .+ 웃고 .+ 울고$/);
    expect(templates[1]!.body).toMatch(/^민님의 보유 주식 평가손익은 [+−]?[\d,]+G이에요\./);
  });
});
