import { spawnSync } from 'node:child_process';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('..', import.meta.url));
const json = (results: unknown[]) => JSON.stringify([{ results, success: true, meta: {} }]);
const existingUsers = { stdout: json([{ name: 'users' }]) };
interface Reply { stdout: string; stderr?: string; status?: number }

async function run(replies: Reply[]) {
  const directory = await mkdtemp(join(tmpdir(), 'yegoom-profile-preflight-'));
  const log = join(directory, 'calls.jsonl'); const scenario = join(directory, 'replies.json');
  try {
    // Only this local fake npx is executable by the script under test. No test
    // invokes Wrangler, connects to Cloudflare, or reads a production database.
    await writeFile(join(directory, 'npx'), `#!${process.execPath}
const fs = require('node:fs');
const log = process.env.PROFILE_PREFLIGHT_TEST_LOG;
const call = fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\\n').length : 0;
fs.appendFileSync(log, JSON.stringify(process.argv.slice(2)) + '\\n');
const reply = JSON.parse(fs.readFileSync(process.env.PROFILE_PREFLIGHT_TEST_REPLIES, 'utf8'))[call];
if (!reply) process.exit(99);
process.stdout.write(reply.stdout);
process.stderr.write(reply.stderr || '');
process.exit(reply.status || 0);
`);
    await chmod(join(directory, 'npx'), 0o700);
    await writeFile(scenario, JSON.stringify(replies));
    const result = spawnSync(process.execPath, ['scripts/launch-profile-preflight.mjs'], {
      cwd: root, encoding: 'utf8', timeout: 5000,
      env: { ...process.env, PATH: `${directory}:${process.env.PATH}`,
        PROFILE_PREFLIGHT_TEST_LOG: log, PROFILE_PREFLIGHT_TEST_REPLIES: scenario },
    });
    const calls = (await readFile(log, 'utf8')).trim().split('\n').map(line => JSON.parse(line) as string[]);
    for (const call of calls) {
      expect(call.slice(0, 6)).toEqual(['wrangler', 'd1', 'execute', 'yegoom-db', '--remote', '--command']);
      expect(call[6]).toMatch(/^SELECT\b/);
      expect(call.slice(7)).toEqual(['--json']);
      expect(call[6]).not.toMatch(/\b(?:INSERT|UPDATE|DELETE|CREATE|ALTER|DROP)\b/);
    }
    return { ...result, calls };
  } finally { await rm(directory, { recursive: true, force: true }); }
}

describe('read-only launch profile preflight', () => {
  it('accepts canonical unique active names without applying new nickname alphabet rules to legacy data', async () => {
    const result = await run([existingUsers, { stdout: json([
      { id: 'min', display_name: '민' }, { id: 'siwon', display_name: 'SIWON' },
      { id: 'legacy', display_name: 'Legacy Nickname!' },
    ]) }]);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('활성 사용자 3명');
    expect(result.calls).toHaveLength(2);
    expect(result.calls[1]![6]).toBe('SELECT id, display_name FROM users WHERE active = 1 ORDER BY id;');
  });

  it('allows a fresh database without querying the missing users table', async () => {
    const result = await run([{ stdout: json([]) }]);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('새 DB');
    expect(result.calls).toHaveLength(1);
    expect(result.calls[0]![6]).toContain('sqlite_master');
  });

  it('rejects case-insensitive duplicates among active users', async () => {
    const result = await run([existingUsers, { stdout: json([
      { id: 'first', display_name: 'Yeseo' }, { id: 'second', display_name: 'yeseo' },
    ]) }]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('중복 닉네임 1그룹');
    expect(result.stderr).toContain('"first", "second"');
  });

  it.each(['가', ' 가', '가 ', '\t가\n'])('rejects a noncanonical existing name %j without renaming it', async displayName => {
    const result = await run([existingUsers, { stdout: json([{ id: 'existing', display_name: displayName }]) }]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('NFC 정규화·앞뒤 공백 확인');
    expect(result.stderr).toContain('DB를 변경하지 않았습니다');
  });

  it('also catches duplicates revealed only by NFC normalization and trimming', async () => {
    const result = await run([existingUsers, { stdout: json([
      { id: 'nfd', display_name: '가 ' }, { id: 'nfc', display_name: '가' },
    ]) }]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('활성 계정 1개');
    expect(result.stderr).toContain('중복 닉네임 1그룹');
  });

  it.each([0, 1])('fails closed on Wrangler failure at query %i and never prints raw diagnostics', async query => {
    const failure = { stdout: 'credential-stdout-secret', stderr: 'credential-stderr-secret', status: 1 };
    const result = await run(query ? [existingUsers, failure] : [failure]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Wrangler 인증·연결');
    expect(result.stdout + result.stderr).not.toContain('credential-');
    expect(result.calls).toHaveLength(query + 1);
  });

  it.each([
    'not JSON', '{}', '[{"success":false,"results":[]}]', '[{"success":true,"results":{}}]',
    '[{"success":true,"results":[{"name":"unexpected"}]}]',
  ])('fails closed on malformed schema response %s', async stdout => {
    const result = await run([{ stdout }]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('응답 형식');
    expect(result.calls).toHaveLength(1);
  });

  it.each([
    { rows: [{ display_name: 'missingId' }] }, { rows: [{ id: 'invalid', display_name: null }] },
    { rows: [{ id: 'same', display_name: 'first' }, { id: 'same', display_name: 'second' }] },
  ])('rejects malformed user rows $rows', async ({ rows }) => {
    const result = await run([existingUsers, { stdout: json(rows) }]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('응답 형식');
  });
});
