// Measures what the D1 cost work reads, on synthetic local data:
//   node scripts/measure-d1-reads.mjs            (markdown tables)
//   node scripts/measure-d1-reads.mjs --json     (the raw numbers)
// It bundles this checkout's Worker modules, applies this checkout's
// migrations to a fresh local D1 (Miniflare) and calls the same functions the
// routes call, counting statements and D1's own rows_read / rows_written.
// Run it in two checkouts (before and after a change) to compare like for like:
// the data and the calls are identical, only the code and migrations differ.
// These are local counts for synthetic data, not production latency.
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';

const SECRET = 'measure-only-stock-seed-secret-2026';
const kst = (date, time) => Date.parse(`${date}T${time}:00+09:00`);
const NOW = kst('2026-11-06', '12:00'); // Friday noon KST
const TODAY = '2026-11-06';
const day = back => new Date(Date.parse(`${TODAY}T00:00:00Z`) - back * 86_400_000).toISOString().slice(0, 10);

mkdirSync('.test-build', { recursive: true });
const bundlePath = `.test-build/measure-${process.pid}.mjs`;
await build({
  stdin: { contents: `export { syncAchievements } from './worker/achievements';
    export { advanceStocks, readStockMarket } from './worker/stocks';
    export { readTagState } from './worker/nickname-tags';`, resolveDir: process.cwd(), loader: 'ts' },
  bundle: true, format: 'esm', platform: 'node', outfile: bundlePath, logLevel: 'silent',
});
const worker = await import(pathToFileURL(bundlePath).href);
rmSync(bundlePath, { force: true });
const migrations = readdirSync('migrations').filter(file => file.endsWith('.sql')).sort();

async function database() {
  const instance = new Miniflare({ modules: true, script: 'export default { fetch() { return new Response("ok"); } };', compatibilityDate: '2026-08-06', d1Databases: ['DB'] });
  const db = await instance.getD1Database('DB');
  for (const file of migrations) {
    let statement = '';
    for (const sourceLine of readFileSync(`migrations/${file}`, 'utf8').split('\n')) {
      const line = sourceLine.trim();
      if (!line || line.startsWith('--')) continue;
      statement += `${line}\n`;
      const trigger = /^CREATE TRIGGER\b/i.test(statement);
      if (line.endsWith(';') && (!trigger || /\bEND;$/i.test(line))) { await db.prepare(statement).run(); statement = ''; }
    }
  }
  for (const [id, role] of [['min', 'player'], ['siwon', 'player'], ['admin', 'admin']]) {
    await db.prepare("INSERT INTO users (id, username, display_name, password_hash, role) VALUES (?, ?, ?, 'x', ?)").bind(id, id, id, role).run();
  }
  return { instance, db };
}
/** Wraps a D1 binding: every statement's rows, as D1 reports them. */
function metered(db, now = NOW) {
  const log = [];
  const record = (sql, meta) => log.push({ sql, rowsRead: meta.rows_read ?? 0, rowsWritten: meta.rows_written ?? 0 });
  const sources = new WeakMap();
  const wrap = (statement, sql) => {
    const wrapped = {
      bind: (...values) => wrap(statement.bind(...values), sql),
      async all() { const result = await statement.all(); record(sql, result.meta); return result; },
      async run() { const result = await statement.run(); record(sql, result.meta); return result; },
      async first(column) { const result = await statement.all(); record(sql, result.meta); return column ? result.results[0]?.[column] ?? null : result.results[0] ?? null; },
    };
    sources.set(wrapped, { statement, sql });
    return wrapped;
  };
  const binding = {
    prepare: sql => wrap(db.prepare(sql.replaceAll("unixepoch('now') * 1000", String(now))), sql),
    async batch(statements) {
      const originals = statements.map(statement => sources.get(statement));
      const results = await db.batch(originals.map(item => item.statement));
      results.forEach((result, index) => record(originals[index].sql, result.meta));
      return results;
    },
  };
  const take = () => { const cost = { statements: log.length, rowsRead: log.reduce((sum, entry) => sum + entry.rowsRead, 0), rowsWritten: log.reduce((sum, entry) => sum + entry.rowsWritten, 0) }; log.length = 0; return cost; };
  return { binding, log, take };
}
const chunks = (total, size = 500) => Array.from({ length: Math.ceil(total / size) }, (_, index) => Array.from({ length: Math.min(size, total - index * size) }, (_, item) => index * size + item));

// 1. Achievement checks after each kind of write, by the player's trade history (작업 7).
async function achievements() {
  const { instance, db } = await database();
  const meter = metered(db);
  const tickers = (await db.prepare('SELECT ticker FROM stock_state ORDER BY rowid').all()).results.map(row => row.ticker);
  // 60 finished trading days of candles for every stock; attendance and a profile change to check.
  await db.prepare(`INSERT INTO stock_daily (ticker, date, open, high, low, close) SELECT t.value, date(?, '-' || d.value || ' days'), 1000, 1010, 990, 1000 FROM json_each(?) t, json_each(?) d`)
    .bind(TODAY, JSON.stringify(tickers), JSON.stringify(Array.from({ length: 60 }, (_, index) => index + 1))).run();
  await db.prepare("INSERT INTO attendance (user_id, date, streak, created_at) VALUES ('min', ?, 1, 'x')").bind(TODAY).run();
  await db.prepare("UPDATE users SET display_name = '민이' WHERE id = 'min'").run();
  const checks = [['출석 체크 뒤', ['attendance']], ['프로필 변경 뒤', ['profile']], ['주식 거래 뒤', ['stock-trade', 'stock-market']], ['도전과제 화면(전체 판정)', undefined]];
  const rows = [];
  let trades = 0;
  for (const total of [0, 1000, 10_000]) {
    for (const numbers of chunks(total - trades)) {
      await db.prepare(`INSERT INTO stock_trades (id, user_id, request_id, ticker, side, quantity, price, fee, total, cost_basis, date, created_at)
        SELECT 'bulk' || value, 'min', 'bulk' || value, CASE value % 4 WHEN 0 THEN 'YKHX' WHEN 1 THEN 'SIWN' WHEN 2 THEN 'MINJ' ELSE 'YEDO' END,
          CASE WHEN value % 8 < 4 THEN 'buy' ELSE 'sell' END, 1, 1000, 10, 1000 + (value % 7) * 10, 1000,
          date(?, '-' || (50 - value % 50) || ' days'), date(?, '-' || (50 - value % 50) || ' days') || 'T01:00:' || printf('%02d', value % 60) || '.' || printf('%03d', value % 1000) || 'Z'
        FROM json_each(?)`).bind(TODAY, TODAY, JSON.stringify(numbers.map(value => value + trades))).run();
    }
    trades = total;
    // Bring the player up to date first: the measured checks find nothing new.
    await worker.syncAchievements(meter.binding, 'min', new Date(NOW));
    meter.take();
    for (const [label, scopes] of checks) {
      await worker.syncAchievements(meter.binding, 'min', new Date(NOW), [], scopes);
      rows.push({ trades: total, check: label, ...meter.take() });
    }
  }
  await instance.dispose();
  return rows;
}

// 2. The stock advance's lookup of recently published game results, by how many older rounds exist (작업 8).
async function gameRounds() {
  const { instance, db } = await database();
  await db.prepare('UPDATE stock_state SET last_tick_at = ?').bind(kst('2026-11-05', '18:00')).run();
  for (const [game, date, answer] of [['wake', '2026-11-05', '07:50:00'], ['offwork', '2026-11-05', '17:40:00'], ['luck', '2026-11-04', '90']]) {
    await db.prepare('INSERT INTO game_rounds (game_id, round_date, answer, revealed_at, settled_at, updated_at) VALUES (?, ?, ?, ?, ?, 0)').bind(game, date, answer, kst(date, '19:00'), kst(date, '19:01')).run();
  }
  const lookupSql = /FROM game_rounds r\s+WHERE r\.answer IS NOT NULL/;
  const rows = [];
  let rounds = 0;
  for (const total of [0, 3334]) {
    for (const numbers of chunks(total - rounds)) {
      await db.prepare(`INSERT INTO game_rounds (game_id, round_date, answer, revealed_at, settled_at, updated_at)
        SELECT g.value, date('2026-10-01', '-' || d.value || ' days'), CASE g.value WHEN 'luck' THEN '50' ELSE '08:00:00' END, 1, 2, 0
        FROM json_each('["wake","offwork","luck"]') g, json_each(?) d`).bind(JSON.stringify(numbers.map(value => value + rounds))).run();
    }
    rounds = total;
    const meter = metered(db);
    await worker.advanceStocks(meter.binding, SECRET, NOW + rounds);
    const lookup = meter.log.find(entry => lookupSql.test(entry.sql));
    const plan = (await db.prepare(`EXPLAIN QUERY PLAN ${lookup.sql}`).bind(NOW, '2026-11-02').all()).results.map(row => row.detail).join(' / ');
    rows.push({ olderRounds: total * 3, statements: 1, rowsRead: lookup.rowsRead, rowsWritten: lookup.rowsWritten, plan,
      events: (await db.prepare("SELECT COUNT(*) AS n FROM stock_events WHERE kind = 'game'").first('n')) });
  }
  await instance.dispose();
  return rows;
}

// 3. The nickname-tag inventory read, by how many tags were discarded before (작업 9).
async function tagState() {
  const { instance, db } = await database();
  const insert = (prefix, count, discarded, date) => db.prepare(`INSERT INTO nickname_tags (id, user_id, request_id, grade, text, equipped, date, created_at, payment, discarded)
    SELECT ? || value, 'min', ? || value, CASE value % 4 WHEN 0 THEN 'S' WHEN 1 THEN 'A' WHEN 2 THEN 'B' ELSE 'C' END, '느긋한', 0, ?, ? || 'T03:00:00.000Z', 'gold', ? FROM json_each(?)`)
    .bind(prefix, prefix, date, date, discarded, JSON.stringify(Array.from({ length: count }, (_, index) => index)));
  await insert('owned-', 10, 0, day(3)).run();
  await insert('today-', 2, 1, TODAY).run(); // drawn today, then discarded
  const rows = [];
  let discarded = 0;
  for (const total of [0, 2000]) {
    for (const numbers of chunks(total - discarded)) await insert(`gone-${discarded + numbers[0]}-`, numbers.length, 1, day(30)).run();
    discarded = total;
    const meter = metered(db);
    const state = await worker.readTagState(meter.binding, { id: 'min', role: 'player' }, new Date(NOW));
    rows.push({ discardedBefore: total, ...meter.take(), tags: state.tags.length, drawsToday: state.drawsToday });
  }
  await instance.dispose();
  return rows;
}

// 4. The market list read after the close, full and conditional, by the news history (작업 6).
async function marketPoll() {
  const { instance, db } = await database();
  const closed = kst('2026-11-05', '18:00') + 30_000;
  await db.prepare('UPDATE stock_state SET last_tick_at = ?').bind(kst('2026-11-05', '18:00')).run();
  await db.prepare("INSERT INTO ledger (id, user_id, currency, amount, reason, reference, created_at) VALUES ('seed', 'min', 'gold', 100000, '측정', 'fixture:measure', '2026-11-01T00:00:00.000Z')").run();
  await db.prepare("INSERT INTO stock_holdings (user_id, ticker, quantity, cost_basis) VALUES ('min', 'YKHX', 3, 4500), ('min', 'MDRG', 2, 2000)").run();
  const article = (id, kind, at, audience = null) => db.prepare("INSERT INTO stock_news (id, ticker, kind, publish_at, headline, body, audience_user_id, source, created_at) VALUES (?, NULL, ?, ?, '기사', '본문', ?, 'template', 'x')").bind(id, kind, at, audience);
  await db.batch([
    ...Array.from({ length: 8 }, (_, index) => article(`today-${index}`, 'news', kst('2026-11-05', '17:00') + index * 60_000)),
    article('close:2026-11-05', 'close', kst('2026-11-05', '18:00')), article('comment:2026-11-05:min', 'comment', kst('2026-11-05', '18:00'), 'min'),
    article('close:2026-11-04', 'close', kst('2026-11-04', '18:00')), article('comment:2026-11-04:min', 'comment', kst('2026-11-04', '18:00'), 'min'),
  ]);
  const user = { id: 'min', role: 'player', username: 'min' };
  const rows = [];
  let older = 0;
  for (const total of [0, 3000]) {
    for (const numbers of chunks(total - older)) {
      await db.prepare(`INSERT INTO stock_news (id, ticker, kind, publish_at, headline, body, source, created_at)
        SELECT 'old:' || value, 'YEGM', 'news', ? - value * 60000, '지난 기사', '본문', 'template', 'x' FROM json_each(?)`).bind(kst('2026-11-04', '17:00'), JSON.stringify(numbers.map(value => value + older))).run();
    }
    older = total;
    const meter = metered(db, closed);
    const full = await worker.readStockMarket(meter.binding, SECRET, user, closed);
    rows.push({ olderArticles: total, read: '전체 조회', ...meter.take() });
    const again = await worker.readStockMarket(meter.binding, SECRET, user, closed, full.version);
    rows.push({ olderArticles: total, read: `조건부 조회(변경 없음${'unchanged' in again ? '' : ' → 전체 응답'})`, ...meter.take() });
    // A closing article is stored for the same prices; does the conditional read notice?
    await db.prepare("UPDATE stock_news SET hidden = 1 WHERE id = 'close:2026-11-05'").run();
    const changed = await worker.readStockMarket(meter.binding, SECRET, user, closed, full.version);
    rows.push({ olderArticles: total, read: `조건부 조회(같은 시세, 마감 기사 변경) → ${'unchanged' in changed ? 'unchanged(누락)' : '전체 응답'}`, ...meter.take() });
    await db.prepare("UPDATE stock_news SET hidden = 0 WHERE id = 'close:2026-11-05'").run();
  }
  await instance.dispose();
  return rows;
}

const results = { achievements: await achievements(), gameRounds: await gameRounds(), tagState: await tagState(), marketPoll: await marketPoll() };
if (process.argv.includes('--json')) console.log(JSON.stringify(results, null, 2));
else {
  const table = (title, columns, rows) => {
    console.log(`\n### ${title}\n\n| ${columns.map(([name]) => name).join(' | ')} |\n| ${columns.map(() => '---').join(' | ')} |`);
    for (const row of rows) console.log(`| ${columns.map(([, key]) => typeof row[key] === 'number' ? row[key].toLocaleString('en-US') : row[key]).join(' | ')} |`);
  };
  table('도전과제 판정 (새 달성 없음)', [['거래 이력', 'trades'], ['판정 시점', 'check'], ['SQL 문장', 'statements'], ['rows_read', 'rowsRead'], ['rows_written', 'rowsWritten']], results.achievements);
  table('주식 연동 게임 결과 조회 (advanceStocks)', [['과거 판 수', 'olderRounds'], ['rows_read', 'rowsRead'], ['만든 이벤트', 'events'], ['실행 계획', 'plan']], results.gameRounds);
  table('별명 태그 상태 조회 (readTagState)', [['이전 폐기 태그', 'discardedBefore'], ['SQL 문장', 'statements'], ['rows_read', 'rowsRead'], ['보유 목록', 'tags'], ['오늘 뽑기', 'drawsToday']], results.tagState);
  table('장 마감 후 시장 목록 조회 (readStockMarket)', [['과거 기사', 'olderArticles'], ['조회', 'read'], ['SQL 문장', 'statements'], ['rows_read', 'rowsRead']], results.marketPoll);
}
