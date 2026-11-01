#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const sql = await readFile(new URL('./launch-reset.sql', import.meta.url), 'utf8');
const marker = '-- RESET VERIFICATION:';
const verification = sql.slice(sql.indexOf(marker));
if (!sql.includes(marker)) throw new Error('초기화 확인 SELECT를 찾을 수 없습니다.');

console.log('먼저 docs/launch-runbook.md의 백업 bookmark를 기록하세요.');
console.log('yegoom-db의 기록을 모두 지웁니다. 계속하려면 RESET 입력');
const input = createInterface({ input: process.stdin, output: process.stdout });
input.on('SIGINT', () => input.close());
let confirmation;
for await (const line of input) {
  confirmation = line;
  break;
}
input.close();
if (confirmation !== 'RESET') {
  console.log('초기화를 취소했습니다. DB 명령을 실행하지 않았습니다.');
  process.exit(1);
}

function execute(args) {
  const result = spawnSync('npx', ['wrangler', 'd1', 'execute', 'yegoom-db', '--remote', ...args], {
    cwd: root, stdio: 'inherit', shell: false,
  });
  if (result.error || result.status !== 0) {
    console.error('명령을 완료하지 못했습니다. 다시 초기화하기 전에 runbook의 확인·복구 절차를 따르세요.');
    process.exit(result.status || 1);
  }
}

console.log('초기화 전 보존 테이블 행 수입니다. 초기화 후 결과와 비교하세요.');
execute(['--command', `SELECT 'users' AS preserved_table, COUNT(*) AS rows_kept FROM users;
SELECT 'sessions' AS preserved_table, COUNT(*) AS rows_kept FROM sessions;
SELECT 'd1_migrations' AS preserved_table, COUNT(*) AS rows_kept FROM d1_migrations;
SELECT 'claw_config' AS preserved_table, COUNT(*) AS rows_kept FROM claw_config;
SELECT 'user_photos' AS preserved_table, COUNT(*) AS rows_kept FROM user_photos;`]);
execute(['--file', 'scripts/launch-reset.sql']);
// Remote file imports return an import summary, not the SELECT result rows.
// Re-run only the file's read-only verification block so operators can inspect them.
console.log('초기화 후 확인 결과입니다. 지운 테이블 0행, 보존 행 수 일치, 트리거 4개를 확인하세요.');
execute(['--command', verification]);
