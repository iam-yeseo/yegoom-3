import { readFile, readdir } from 'node:fs/promises';
import { Miniflare } from 'miniflare';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getFreeThrowState } from '../worker/freethrow';

// Migration 0036 rebuilds freethrow_sets for the 30-second rule. Sets recorded
// under the 10-ball rule keep their balls, points and gold; a 3-goal reward
// that was earned but never collected is paid.
type Database = Awaited<ReturnType<Miniflare['getD1Database']>>;
const MIGRATION = '0036_freethrow_timed_notices.sql';
async function apply(database: Database, names: string[]) {
  for (const name of names) {
    let statement = '';
    for (const sourceLine of (await readFile(new URL(`../migrations/${name}`, import.meta.url), 'utf8')).split('\n')) {
      const line = sourceLine.trim();
      if (!line || line.startsWith('--')) continue;
      statement += `${line}\n`;
      const trigger = /^CREATE TRIGGER\b/i.test(statement);
      if (line.endsWith(';') && (!trigger || /\bEND;$/i.test(line))) { await database.prepare(statement).run(); statement = ''; }
    }
  }
}
let mf: Miniflare; let db: Database;
beforeAll(async () => {
  mf = new Miniflare({ modules: true, script: 'export default { fetch() { return new Response("") } }', compatibilityDate: '2026-08-06', d1Databases: ['DB'] });
  db = await mf.getD1Database('DB');
  const all = (await readdir(new URL('../migrations/', import.meta.url))).filter(file => file.endsWith('.sql')).sort();
  await apply(db, all.filter(name => name < MIGRATION));
  for (const id of ['min', 'siwon']) await db.prepare('INSERT INTO users (id, username, display_name, password_hash, role) VALUES (?, ?, ?, ?, ?)').bind(id, id, id, 'x', 'player').run();
  const at = '2026-11-19T03:10:00.000Z';
  // A recorded 10-ball set (7 goals), a set that was left, and one recorded ball by ball under the first rule.
  await db.batch([
    db.prepare("INSERT INTO freethrow_sets (id, user_id, request_id, slot, date, engine, shots, made, created_at) VALUES ('set-done', 'min', 'r1', 165050, '2026-11-19', 1, 10, 7, ?), ('set-left', 'siwon', 'r2', 165050, '2026-11-19', 1, 0, 0, ?), ('set-old', 'siwon', 'r3', 165000, '2026-11-13', 1, 3, 1, ?)").bind(at, at, at),
    ...Array.from({ length: 10 }, (_, i) => db.prepare("INSERT INTO freethrow_shots (id, set_id, shot_index, power, aim, made, kind, created_at) VALUES (?, 'set-done', ?, ?, 0, ?, ?, ?)")
      .bind(`shot-${i}`, i, i < 7 ? 55 : 10, i < 7 ? 1 : 0, i < 7 ? 'swish' : 'short', '2026-11-19T03:12:00.000Z')),
    ...Array.from({ length: 3 }, (_, i) => db.prepare("INSERT INTO freethrow_shots (id, set_id, shot_index, power, aim, made, kind, created_at) VALUES (?, 'set-old', ?, 55, 0, ?, 'swish', ?)").bind(`old-${i}`, i, i === 0 ? 1 : 0, at)),
    db.prepare("INSERT INTO ledger (id, user_id, currency, amount, reason, reference, created_at, week_start) VALUES ('l1', 'min', 'score', 7, '자유투 대결 골', 'freethrow:set:set-done:score', ?, '2026-11-16'), ('l2', 'min', 'gold', 35, '자유투 대결 골', 'freethrow:set:set-done:gold', ?, NULL), ('l3', 'siwon', 'score', 1, '자유투 대결 골', 'freethrow:goal:set-old:0:score', ?, '2026-11-09'), ('l4', 'siwon', 'gold', 5, '자유투 대결 골', 'freethrow:goal:set-old:0:gold', ?, NULL)").bind(at, at, at, at),
    db.prepare("INSERT INTO achievements (user_id, key, period_key, unlocked_at, claimed_at) VALUES ('min', 'freethrow_3', '2026-11-19', ?, NULL), ('min', 'freethrow_3', '2026-11-18', ?, ?), ('min', 'freethrow_5', '2026-11-19', ?, NULL)").bind(at, at, at, at),
  ]);
  await apply(db, all.filter(name => name >= MIGRATION));
});
afterAll(async () => { await mf.dispose(); });

describe('migration 0036: free-throw sets for the 30-second rule', () => {
  it('keeps every recorded set with its balls, points and gold, and drops the per-ball table', async () => {
    expect(await db.prepare("SELECT name FROM sqlite_master WHERE name IN ('freethrow_shots', 'freethrow_sets_next')").all().then(result => result.results)).toEqual([]);
    const done = await db.prepare("SELECT shots, made, points, gold, inputs_json, results_json, finished_at, finish_token FROM freethrow_sets WHERE id = 'set-done'").first<Record<string, string | number | null>>();
    expect(done).toMatchObject({ shots: 10, made: 7, points: 7, gold: 35, finished_at: '2026-11-19T03:12:00.000Z', finish_token: null });
    const results = JSON.parse(done!.results_json as string) as unknown[];
    expect(results).toHaveLength(10);
    expect(results[0]).toEqual({ index: 0, power: 55, aim: 0, made: true, kind: 'swish' });
    expect(results[9]).toEqual({ index: 9, power: 10, aim: 0, made: false, kind: 'short' });
    expect(JSON.parse(done!.inputs_json as string)[0]).toEqual({ power: 55, aim: 0 });
    // The day's board reads the old set like any other.
    const state = await getFreeThrowState(db as unknown as D1Database, { id: 'min', role: 'player' }, Date.parse('2026-11-19T03:30:00Z'));
    expect(state.today).toEqual([expect.objectContaining({ username: 'min', made: 7, completed: true })]);
  });

  it('leaves unrecorded sets unfinished, including the ones recorded ball by ball', async () => {
    expect(await db.prepare("SELECT shots, made, points, gold, results_json, finished_at FROM freethrow_sets WHERE id = 'set-left'").first())
      .toEqual({ shots: 0, made: 0, points: 0, gold: 0, results_json: null, finished_at: null });
    expect(await db.prepare("SELECT shots, made, points, gold, finished_at FROM freethrow_sets WHERE id = 'set-old'").first())
      .toEqual({ shots: 3, made: 1, points: 1, gold: 5, finished_at: null });
  });

  it('pays a 3-goal reward that was never collected, once, and leaves other rewards alone', async () => {
    expect(await db.prepare("SELECT period_key, claimed_at IS NOT NULL AS claimed FROM achievements WHERE key = 'freethrow_3' ORDER BY period_key").all().then(result => result.results))
      .toEqual([{ period_key: '2026-11-18', claimed: 1 }, { period_key: '2026-11-19', claimed: 1 }]);
    expect(await db.prepare("SELECT user_id, currency, amount, reference FROM ledger WHERE reference LIKE 'achievement:%'").all().then(result => result.results))
      .toEqual([{ user_id: 'min', currency: 'gold', amount: 50, reference: 'achievement:freethrow_3:2026-11-19:min' }]);
    expect(await db.prepare("SELECT claimed_at FROM achievements WHERE key = 'freethrow_5'").first('claimed_at')).toBeNull();
    expect(await db.prepare("SELECT gold FROM user_balances WHERE user_id = 'min'").first('gold')).toBe(85);
  });
});
