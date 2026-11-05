import Anthropic from '@anthropic-ai/sdk';
import { AI_RULES } from '../shared/balance';
import { STOCKS, stockInfo, type Ticker } from '../shared/stocks';
import { kstTimestamp, tickTimes, tradesOn } from '../shared/market-calendar';
import { dayItems, type DayItem, type StockRow } from '../shared/stock-market';
import { subjectParticle } from '../shared/stock-news-templates';

/** AI news (docs/plan-stock.md §8). The server decides every event first; the AI
 * only writes its headline and body. Anything missing, refused, malformed, over
 * budget or switched off falls back to the template article. */
export interface AiUsage { input: number; output: number; cacheWrite: number; cacheRead: number }
export interface AiResult { text: string | null; refused: boolean; fallback: boolean; usage: AiUsage }
export type AiWriter = (request: { system: string; prompt: string; schema: Record<string, unknown> }) => Promise<AiResult>;

/** The real writer: Claude Opus 5.5, medium effort, structured JSON output, the
 * server-side refusal fallback, and a cached stable system prompt. */
export function anthropicWriter(apiKey: string): AiWriter {
  const client = new Anthropic({ apiKey, timeout: AI_RULES.timeoutMs, maxRetries: 1 });
  return async ({ system, prompt, schema }) => {
    const response = await client.beta.messages.create({
      model: AI_RULES.model,
      max_tokens: AI_RULES.maxTokens,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: prompt }],
      output_config: { effort: AI_RULES.effort, format: { type: 'json_schema', schema } },
    });
    const usage: AiUsage = { input: response.usage.input_tokens, output: response.usage.output_tokens,
      cacheWrite: response.usage.cache_creation_input_tokens ?? 0, cacheRead: response.usage.cache_read_input_tokens ?? 0 };
    const fallback = response.model !== AI_RULES.model;
    if (response.stop_reason === 'refusal') return { text: null, refused: true, fallback, usage };
    const text = response.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('');
    return { text, refused: false, fallback, usage };
  };
}

export function costMicroUsd(usage: AiUsage, fallback = false): number {
  const price = fallback ? AI_RULES.fallbackMicroUsdPerToken : AI_RULES.microUsdPerToken;
  return Math.ceil(usage.input * price.input + usage.output * price.output + usage.cacheWrite * price.cacheWrite + usage.cacheRead * price.cacheRead);
}
/** Worst case before a call: every prompt character a cache-written token, plus the full output allowance. */
export function estimateMicroUsd(system: string, prompt: string): number {
  const price = AI_RULES.fallbackMicroUsdPerToken;
  return Math.ceil((system.length + prompt.length) * price.cacheWrite + AI_RULES.maxTokens * price.output);
}

export interface AiStatus { enabled: boolean; keyConfigured: boolean; today: { calls: number; costMicroUsd: number }; month: { calls: number; costMicroUsd: number } }
export async function readAiStatus(db: D1Database, date: string, keyConfigured: boolean): Promise<AiStatus> {
  const [setting, today, month] = await db.batch([
    db.prepare("SELECT value FROM stock_settings WHERE key = 'ai_enabled'"),
    db.prepare('SELECT calls, cost_micro_usd AS costMicroUsd FROM ai_usage WHERE date = ?').bind(date),
    db.prepare('SELECT COALESCE(SUM(calls), 0) AS calls, COALESCE(SUM(cost_micro_usd), 0) AS costMicroUsd FROM ai_usage WHERE date >= ? AND date <= ?')
      .bind(`${date.slice(0, 7)}-01`, date),
  ]);
  return { enabled: (setting!.results[0] as { value: string } | undefined)?.value !== '0', keyConfigured,
    today: (today!.results[0] as AiStatus['today'] | undefined) ?? { calls: 0, costMicroUsd: 0 },
    month: month!.results[0] as AiStatus['month'] };
}
export async function setAiEnabled(db: D1Database, userId: string, enabled: boolean, now: number): Promise<void> {
  await db.prepare(`INSERT INTO stock_settings (key, value, updated_by, updated_at) VALUES ('ai_enabled', ?, ?, ?)
    ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_by = excluded.updated_by, updated_at = excluded.updated_at`)
    .bind(enabled ? '1' : '0', userId, new Date(now).toISOString()).run();
}

const BANNED = ['사세요', '파세요', '사라', '팔아라', '매수하세요', '매도하세요', '매수 추천', '매도 추천', '투자하세요', '추천 종목', '씨발', '시발', '병신', '좆', '개새', '지랄'];
const NAMES = STOCKS.map(stock => stock.name);
/** Headline ≤ 40, body ≤ 200, no banned words, and no company other than `allowed`. */
export function validArticle(article: { headline?: unknown; body?: unknown }, allowed: readonly Ticker[] | 'all', headline = true): boolean {
  const text = `${article.headline ?? ''} ${article.body ?? ''}`;
  if (headline && (typeof article.headline !== 'string' || !article.headline.trim() || article.headline.length > AI_RULES.headlineMax)) return false;
  if (typeof article.body !== 'string' || !article.body.trim() || article.body.length > AI_RULES.bodyMax) return false;
  if (BANNED.some(word => text.includes(word))) return false;
  if (allowed === 'all') return true;
  const own = allowed.map(ticker => stockInfo(ticker)!.name);
  return NAMES.every(name => own.includes(name) || !text.includes(name));
}

/** Stable system prompt: identical bytes every call so the prefix is cached. */
export const SYSTEM_PROMPT = `너는 "예굼방"이라는 친구 넷의 작은 게임 앱 속 가상 주식 시장의 경제 기자다. 짧은 한국어 경제 기사 패러디를 쓴다.

## 세계관
- 실제 회사, 실제 사건, 정치, 재난, 실존 브랜드는 절대 나오지 않는다. 아래 10개 가상 회사만 존재한다.
- 주가는 서버가 이미 정했다. 너는 이미 정해진 사건을 기사로 옮길 뿐, 사건을 바꾸거나 새 사건을 만들지 않는다.
- 정확한 퍼센트, 가격, 숫자 등락률은 쓰지 않는다. 화면이 실제 등락률을 따로 보여 준다.

## 회사
${STOCKS.map(stock => `- ${stock.name} (${stock.ticker}, ${stock.sector}): ${stock.intro}`).join('\n')}

## 말투
- 회사 소개 문구처럼 엉뚱하고 장난스럽게, 하지만 기사 형식(사실 전달 + 한두 줄 묘사)으로.
- 제목은 40자 이내, 본문은 200자 이내의 1~3문장.
- 멤버 닉네임을 쓸 때는 반드시 뒤에 "님"을 붙인다(예: 민님).
- "사라/팔아라" 같은 투자 권유, 매수·매도 추천은 절대 쓰지 않는다.
- 외모, 건강, 연애, 실제 직장, 가족 같은 사적인 내용과 욕설은 쓰지 않는다.
- 한 기사에는 그 사건의 회사 이름만 쓴다. 다른 회사 이름을 끌어들이지 않는다.
- 최근 기사 제목과 겹치지 않게 새로운 표현을 쓴다.

## 사건 종류
- news: 일반 호재(up)·악재(down). size는 작게/보통/크게.
- rumor: 찌라시. 확인되지 않은 소문처럼 쓴다("~라는 이야기가 돈다", "확인되지 않았다"). 제목에 [찌라시]를 넣지 않는다(화면이 붙인다).
- confirm: 앞의 찌라시가 사실로 확인됐다는 후속 보도. relatedTo의 찌라시와 이야기가 이어지게.
- denied: 앞의 찌라시가 사실이 아니라는 후속 보도. relatedTo의 찌라시와 이야기가 이어지게.
- mosquito: 예굼 사냥팀의 모기 사냥 결과(성공 up / 실패 down).
- game: 멤버의 게임 결과(facts에 사실이 있다). facts의 시각·점수는 그대로 써도 된다.

## 예시
{"eventId":"news:2026-11-05:0","headline":"SW전자, 130번 접히는 휴대폰 공개","body":"129번의 벽이 드디어 깨졌다. 다 접으면 각설탕만 해져서 주머니가 남는다는 평가다."}
{"eventId":"rumor:2026-11-05:0","headline":"민두래곤, 비밀 레시피 유출됐다?","body":"민두래곤 공장 앞에서 만두 냄새가 평소와 다르다는 이야기가 돈다. 회사는 확인해 주지 않았다."}

요청한 eventId마다 정확히 하나씩, 요청한 JSON 형식으로만 답한다.`;

const ARTICLES_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['items'],
  properties: { items: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['eventId', 'headline', 'body'],
    properties: { eventId: { type: 'string' }, headline: { type: 'string' }, body: { type: 'string' } } } } },
} as const;
const CLOSE_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['summary', 'comments', 'weekly'],
  properties: {
    summary: { type: 'object', additionalProperties: false, required: ['headline', 'body'], properties: { headline: { type: 'string' }, body: { type: 'string' } } },
    comments: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['userId', 'body'], properties: { userId: { type: 'string' }, body: { type: 'string' } } } },
    weekly: { anyOf: [{ type: 'null' }, { type: 'object', additionalProperties: false, required: ['headline', 'body'], properties: { headline: { type: 'string' }, body: { type: 'string' } } }] },
  },
} as const;

/** One claim per run (morning/close and date) so retried Crons never call twice. */
async function claimRun(db: D1Database, run: string, now: number): Promise<boolean> {
  const result = await db.prepare('INSERT OR IGNORE INTO stock_settings (key, value, updated_at) VALUES (?, ?, ?)')
    .bind(`ai_run:${run}`, 'claimed', new Date(now).toISOString()).run();
  return result.meta.changes === 1;
}
/** Call the writer if the switch is on, a key exists and the estimate fits today's budget. */
async function callAi(db: D1Database, writer: AiWriter | null, date: string, system: string, prompt: string, schema: Record<string, unknown>): Promise<unknown | null> {
  if (!writer) return null;
  const status = await db.batch([
    db.prepare("SELECT value FROM stock_settings WHERE key = 'ai_enabled'"),
    db.prepare('SELECT cost_micro_usd FROM ai_usage WHERE date = ?').bind(date),
  ]);
  if ((status[0]!.results[0] as { value: string } | undefined)?.value === '0') return null;
  const spent = (status[1]!.results[0] as { cost_micro_usd: number } | undefined)?.cost_micro_usd ?? 0;
  if (spent + estimateMicroUsd(system, prompt) > AI_RULES.dailyCapMicroUsd) return null;
  let result: AiResult;
  try { result = await writer({ system, prompt, schema }); }
  catch (error) {
    console.error('AI news call failed', error instanceof Error ? error.name : 'UnknownError');
    return null;
  }
  const cost = costMicroUsd(result.usage, result.fallback);
  await db.prepare(`INSERT INTO ai_usage (date, calls, input_tokens, output_tokens, cache_write_tokens, cache_read_tokens, cost_micro_usd)
    VALUES (?, 1, ?, ?, ?, ?, ?) ON CONFLICT (date) DO UPDATE SET calls = calls + 1, input_tokens = input_tokens + excluded.input_tokens,
      output_tokens = output_tokens + excluded.output_tokens, cache_write_tokens = cache_write_tokens + excluded.cache_write_tokens,
      cache_read_tokens = cache_read_tokens + excluded.cache_read_tokens, cost_micro_usd = cost_micro_usd + excluded.cost_micro_usd`)
    .bind(date, result.usage.input, result.usage.output, result.usage.cacheWrite, result.usage.cacheRead, cost).run();
  if (result.refused || !result.text) return null;
  try { return JSON.parse(result.text) as unknown; } catch { return null; }
}

const sizeOf = (bp: number) => Math.abs(bp) >= 600 ? '크게' : Math.abs(bp) >= 300 ? '보통' : '작게';
interface MorningEvent { id: string; newsId: string; ticker: Ticker; kind: string; effectBp: number; publishAt: number; facts?: unknown; relatedTo?: string }

/** 08:50 on a trading day: write today's scheduled articles (and the overnight game
 * results that move prices at 09:00) in one call. Rows are stored with their
 * future publish time; every read filters publish_at <= now, so nobody (the
 * administrator included) sees them early. Template rows fill anything missing. */
export async function writeMorningNews(db: D1Database, writer: AiWriter | null, seed: string, date: string, rows: readonly StockRow[], now: number): Promise<number> {
  if (!await claimRun(db, `morning:${date}`, now)) return 0;
  const times = tickTimes();
  const listed = (ticker: Ticker) => {
    const row = rows.find(item => item.ticker === ticker)!;
    return tradesOn(ticker, date) && (row.status !== 'delisted' || (!!row.relistOn && row.relistOn <= date));
  };
  const scheduled = dayItems(seed, date).filter(item => listed(item.ticker));
  const overnight = (await db.prepare(`SELECT id, ticker, effect_bp, context_json FROM stock_events
    WHERE applied_at IS NULL AND kind = 'game' AND apply_at <= ?`).bind(kstTimestamp(date, '09:00')).all<{ id: string; ticker: Ticker; effect_bp: number; context_json: string }>()).results
    .filter(event => listed(event.ticker));
  const events: MorningEvent[] = [
    ...scheduled.map((item: DayItem) => ({ id: item.id, newsId: item.id, ticker: item.ticker, kind: item.kind, effectBp: item.effectBp,
      publishAt: kstTimestamp(date, times[item.index]!), relatedTo: item.relatedId })),
    ...overnight.map(event => {
      const { headline: _h, body: _b, ...facts } = JSON.parse(event.context_json) as Record<string, unknown>;
      return { id: event.id, newsId: `event:${event.id}`, ticker: event.ticker, kind: 'game', effectBp: event.effect_bp, publishAt: kstTimestamp(date, '09:00'), facts };
    }),
  ];
  if (!events.length) return 0;
  const recent = (await db.prepare('SELECT headline FROM stock_news WHERE publish_at <= ? AND hidden = 0 ORDER BY publish_at DESC LIMIT ?')
    .bind(now, AI_RULES.recentHeadlines).all<{ headline: string }>()).results.map(row => row.headline);
  const weekday = ['일', '월', '화', '수', '목', '금', '토'][new Date(`${date}T00:00:00Z`).getUTCDay()];
  const prompt = `오늘은 ${date} (${weekday}요일)이다. 아래 사건마다 기사 한 개씩 써 줘.

최근 기사 제목(겹치지 않게): ${JSON.stringify(recent)}

사건 목록:
${events.map(event => JSON.stringify({ eventId: event.id, company: stockInfo(event.ticker)!.name, kind: event.kind,
    direction: event.effectBp > 0 ? 'up' : event.effectBp < 0 ? 'down' : 'flat', size: sizeOf(event.effectBp),
    ...(event.relatedTo ? { relatedTo: event.relatedTo } : {}), ...(event.facts ? { facts: event.facts } : {}) })).join('\n')}`;
  const output = await callAi(db, writer, date, SYSTEM_PROMPT, prompt, ARTICLES_SCHEMA) as { items?: { eventId?: unknown; headline?: unknown; body?: unknown }[] } | null;
  const written = new Map<string, { headline: string; body: string }>();
  const answered = Array.isArray(output?.items) ? output!.items : [];
  for (const item of answered) {
    const event = events.find(candidate => candidate.id === item.eventId);
    // An event answered twice is ambiguous: keep its template.
    if (!event || answered.filter(other => other.eventId === event.id).length !== 1 || !validArticle(item, [event.ticker])) continue;
    written.set(event.id, { headline: (item.headline as string).trim(), body: (item.body as string).trim() });
  }
  if (!written.size) return 0;
  const createdAt = new Date(now).toISOString();
  await db.batch(events.filter(event => written.has(event.id)).map(event => {
    const article = written.get(event.id)!;
    return db.prepare(`INSERT OR IGNORE INTO stock_news (id, event_id, ticker, kind, publish_at, headline, body, effect_bp, source, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'ai', ?)`).bind(event.newsId, event.newsId.startsWith('event:') ? event.id : null, event.ticker, event.kind,
      event.publishAt, article.headline, article.body, event.effectBp, createdAt);
  }));
  return written.size;
}

const percentText = (value: number) => `${value > 0 ? '+' : value < 0 ? '−' : ''}${Math.abs(value).toFixed(1)}%`;
const goldText = (value: number) => `${value > 0 ? '+' : value < 0 ? '−' : ''}${Math.abs(value).toLocaleString('ko-KR')}G`;
interface Holder { userId: string; name: string; holdings: { ticker: Ticker; quantity: number; value: number; cost: number }[] }

/** 18:00 after the close tick: the day's market summary, a one-line comment for
 * each holder (visible only to them), and on Fridays the weekly report. Template
 * articles are always written; the AI version replaces them when it succeeds. */
export async function writeCloseNews(db: D1Database, writer: AiWriter | null, date: string, rows: readonly StockRow[], now: number): Promise<void> {
  if (!await claimRun(db, `close:${date}`, now)) return;
  const publishAt = kstTimestamp(date, '18:00');
  const traded = rows.filter(row => tradesOn(row.ticker, date) && row.status !== 'delisted' && row.dayOpen !== null);
  const moves = traded.map(row => ({ ticker: row.ticker, name: stockInfo(row.ticker)!.name, change: (row.price - row.prevClose) / row.prevClose * 100, price: row.price }))
    .sort((a, b) => b.change - a.change);
  const friday = new Date(`${date}T00:00:00Z`).getUTCDay() === 5;
  const [holdingRows, newsRows, weekRows] = await db.batch([
    db.prepare(`SELECT h.user_id, u.display_name, h.ticker, h.quantity, h.cost_basis FROM stock_holdings h JOIN users u ON u.id = h.user_id
      WHERE h.quantity > 0 AND u.active = 1 AND u.role = 'player' ORDER BY h.user_id, h.ticker`),
    db.prepare(`SELECT headline FROM stock_news WHERE publish_at >= ? AND publish_at <= ? AND hidden = 0 AND audience_user_id IS NULL ORDER BY publish_at`)
      .bind(kstTimestamp(date, '00:00'), publishAt),
    db.prepare(`SELECT ticker, close FROM stock_daily WHERE date = (SELECT MAX(date) FROM stock_daily WHERE date <= ?)`)
      .bind(new Date(Date.parse(`${date}T00:00:00Z`) - 7 * 86_400_000).toISOString().slice(0, 10)),
  ]);
  const holders = new Map<string, Holder>();
  for (const row of holdingRows!.results as { user_id: string; display_name: string; ticker: Ticker; quantity: number; cost_basis: number }[]) {
    const stock = rows.find(item => item.ticker === row.ticker)!;
    const holder = holders.get(row.user_id) ?? { userId: row.user_id, name: row.display_name, holdings: [] };
    holder.holdings.push({ ticker: row.ticker, quantity: row.quantity, value: stock.status === 'delisted' ? 0 : row.quantity * stock.price, cost: row.cost_basis });
    holders.set(row.user_id, holder);
  }
  const weekStartClose = new Map((weekRows!.results as { ticker: Ticker; close: number }[]).map(row => [row.ticker, row.close]));
  const weekly = friday ? rows.filter(row => row.status !== 'delisted' && weekStartClose.has(row.ticker))
    .map(row => ({ name: stockInfo(row.ticker)!.name, change: (row.price - weekStartClose.get(row.ticker)!) / weekStartClose.get(row.ticker)! * 100 }))
    .sort((a, b) => b.change - a.change) : [];

  // Templates first: the closing screen always has something.
  const best = moves[0], worst = moves[moves.length - 1];
  const summary = best && worst ? { headline: `[마감 시황] ${best.name} 웃고 ${worst.name} 울고`,
    body: `오늘 ${best.name}${subjectParticle(best.name)} 가장 많이 올랐고(${percentText(best.change)}), ${worst.name}${subjectParticle(worst.name)} 가장 많이 내렸다(${percentText(worst.change)}). 다음 거래일 09시에 다시 장이 열린다.` }
    : { headline: '[마감 시황] 오늘 시장이 문을 닫았습니다', body: '다음 거래일 09시에 다시 장이 열린다.' };
  const comments = new Map([...holders.values()].map(holder => {
    const pnl = holder.holdings.reduce((sum, item) => sum + item.value - item.cost, 0);
    return [holder.userId, `${holder.name}님의 보유 주식 평가손익은 ${goldText(pnl)}이에요. ${pnl >= 0 ? '오늘도 수고 많았어요!' : '내일은 웃는 하루가 되길!'}`];
  }));
  let weeklyArticle = weekly.length ? { headline: `[주간 실적] 이번 주 1등은 ${weekly[0]!.name}`,
    body: `이번 주 ${weekly[0]!.name} ${percentText(weekly[0]!.change)}, 꼴찌는 ${weekly[weekly.length - 1]!.name} ${percentText(weekly[weekly.length - 1]!.change)}. 다음 주 전망은 늘 그렇듯 아무도 모른다.` } : null;
  let source: 'ai' | 'template' = 'template';

  const prompt = `오늘은 ${date}이고 방금 18시에 장이 마감됐다.
1) summary: 오늘 시황 요약 기사 하나(제목 40자, 본문 200자 이내, 등락률 숫자는 써도 된다).
2) comments: 아래 플레이어마다 본인에게만 보이는 한 줄 코멘트(본문 120자 이내, 닉네임 뒤에 "님", 투자 권유 금지, 보유 종목과 손익을 재치 있게).
3) weekly: ${friday ? '금요일이므로 주간 실적 발표 기사 하나(종목별 한 주 성적과 다음 주 전망 - 전망은 재미로, 가격과 무관하다고 느껴지게)' : 'null'}.

오늘 종목 등락: ${JSON.stringify(moves.map(move => ({ company: move.name, change: percentText(move.change) })))}
오늘 기사 제목: ${JSON.stringify((newsRows!.results as { headline: string }[]).map(row => row.headline))}
플레이어: ${JSON.stringify([...holders.values()].map(holder => ({ userId: holder.userId, nickname: holder.name,
    holdings: holder.holdings.map(item => ({ company: stockInfo(item.ticker)!.name, shares: item.quantity, profit: goldText(item.value - item.cost) })) })))}
${friday ? `이번 주 등락: ${JSON.stringify(weekly.map(item => ({ company: item.name, change: percentText(item.change) })))}` : ''}`;
  const output = (traded.length ? await callAi(db, writer, date, SYSTEM_PROMPT, prompt, CLOSE_SCHEMA) : null) as {
    summary?: { headline?: unknown; body?: unknown }; comments?: { userId?: unknown; body?: unknown }[]; weekly?: { headline?: unknown; body?: unknown } | null } | null;
  let finalSummary = summary;
  if (output?.summary && validArticle(output.summary, 'all')) {
    finalSummary = { headline: (output.summary.headline as string).trim(), body: (output.summary.body as string).trim() };
    source = 'ai';
  }
  const commentSource = new Map<string, 'ai' | 'template'>();
  for (const item of Array.isArray(output?.comments) ? output!.comments : []) {
    if (typeof item.userId !== 'string' || !comments.has(item.userId)) continue;
    if (typeof item.body !== 'string' || item.body.length > AI_RULES.commentMax || !validArticle({ body: item.body }, 'all', false)) continue;
    comments.set(item.userId, item.body.trim()); commentSource.set(item.userId, 'ai');
  }
  let weeklySource: 'ai' | 'template' = 'template';
  if (friday && weeklyArticle && output?.weekly && validArticle(output.weekly, 'all')) {
    weeklyArticle = { headline: (output.weekly.headline as string).trim(), body: (output.weekly.body as string).trim() };
    weeklySource = 'ai';
  }
  const createdAt = new Date(now).toISOString();
  const insert = (id: string, kind: string, article: { headline: string; body: string }, from: 'ai' | 'template', audience: string | null = null) =>
    db.prepare(`INSERT OR IGNORE INTO stock_news (id, ticker, kind, publish_at, headline, body, audience_user_id, source, created_at)
      VALUES (?, NULL, ?, ?, ?, ?, ?, ?, ?)`).bind(id, kind, publishAt, article.headline, article.body, audience, from, createdAt);
  const statements = [insert(`close:${date}`, 'close', finalSummary, source)];
  for (const [userId, body] of comments) statements.push(insert(`comment:${date}:${userId}`, 'comment', { headline: '오늘의 한 줄', body }, commentSource.get(userId) ?? 'template', userId));
  if (weeklyArticle) statements.push(insert(`weekly:${date}`, 'weekly', weeklyArticle, weeklySource));
  await db.batch(statements);
}
