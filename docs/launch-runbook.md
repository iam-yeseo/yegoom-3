# 런칭 전 기록 초기화

2026-11-02 KST 00:00 런칭 직전에 운영자가 한 번 실행한다. 이 문서를 추가한 PR에서는 운영 DB 초기화, 머지, 배포를 실행하지 않았다. 초기화는 계정과 로그인 세션을 유지하고 모든 게임·골드·점수·출석·구매 기록을 비운다.

PR B에는 추가형 `0007_launch_profiles.sql`이 필요하다. 머지 전에 운영자가 `npm run db:migrate:remote`를 실행한다. 이 npm 명령은 먼저 읽기 전용 닉네임 점검을 실행하며, 활성 사용자의 대소문자 무시 중복이나 NFC·공백 정규화가 필요한 값이 있으면 마이그레이션을 시작하지 않는다. 기존 값은 자동으로 바꾸지 않는다. 독립 점검 명령은 다음과 같다.

```bash
npm run launch:profiles:preflight:remote
```

이번 개발 환경은 Cloudflare 인증 토큰이 없어 운영 중복 조회를 완료하지 못했다. 운영자는 인증된 환경에서 위 점검을 통과한 뒤 마이그레이션 → PR 머지·배포 순서로 반영한다. 로컬에서는 중복이 있는 경우 마이그레이션의 유니크 인덱스 생성이 실패하고 전체가 롤백되는 것을 검증한다.

초기화는 `announcements`, `luck_photos`까지 지우고 `user_photos`와 사용자 프로필·사진 버전은 보존한다. `0007`까지 적용된 최신 배포와 같은 리비전에서 실행한다.

1. 플레이어가 접속하지 않는 런칭 전 시간에 시작하고, 검증을 마칠 때까지 앱을 열거나 출석·구매 요청을 보내지 않는다. 인증된 Cloudflare 운영자 계정과 레포의 `yegoom-db` 설정을 확인한다. 백업 지점을 조회해 출력된 **bookmark를 별도로 메모**한다.

   ```bash
   npx wrangler d1 time-travel info yegoom-db
   ```

2. 레포 루트에서 초기화 명령을 실행한다.

   ```bash
   npm run launch:reset:remote
   ```

   `yegoom-db의 기록을 모두 지웁니다. 계속하려면 RESET 입력`에 **정확히 `RESET`**을 입력해야 한다. 빈 입력, 다른 대소문자, 앞뒤 공백, EOF, Ctrl+C는 취소한다. 입력 전에는 DB 명령을 실행하지 않는다. 확인을 생략하는 옵션이나 환경 변수는 없다. Wrangler가 추가 실행 확인을 표시하면 내용을 확인한다.

   실행 순서는 보존 테이블 행 수 조회 → `npx wrangler d1 execute yegoom-db --remote --file scripts/launch-reset.sql` → 확인 SELECT 조회다. 초기화 전 출력도 보관한다. SQL 전체 파일은 D1 import 한 번으로 실행되며, import 실패 시 D1이 실행 전 상태로 되돌린다. 트리거 제거·삭제·복구를 따로 실행하거나 SQL을 여러 명령으로 나누지 않는다.

3. 출력된 확인 결과를 읽는다. 원격 `--file`은 import 요약만 출력하므로 스크립트가 파일 끝의 읽기 전용 SELECT를 다시 실행해 보여 준다.

   - `cleared_table`의 19개 행에서 `remaining`이 모두 **0**이어야 한다.
   - `users`, `sessions`, `d1_migrations`, `claw_config`, `user_photos`의 `rows_kept`는 초기화 전과 같아야 한다. 스크립트는 이 다섯 테이블의 행·컬럼을 수정하지 않는다.
   - `catchmind_turn`은 `id = 1` 행이 남고 `drawer_id`, `round_id`가 모두 `NULL`이어야 한다.
   - `restored_append_only_triggers`는 **4**여야 한다. 뒤에 출력되는 `ledger_no_update`, `ledger_no_delete`, `inventory_no_update`, `inventory_no_delete` 정의가 각각 수정·삭제를 `RAISE(ABORT, ...)`로 거절해야 한다.

   검증 후 기존 로그인으로 홈을 열면 캐릭터 뽑기 지갑이 다시 만들어지고, 쿠지에 들어가면 첫 판이 생성된다. 새 출석은 1일째부터 시작한다. 앱 조회가 다시 생성하는 정상 기록 때문에 검증 전에는 앱을 열지 않는다.

4. 오류나 예상과 다른 결과가 있으면 앱을 열지 않고 백업 bookmark로 복구한다. 실패한 import는 원상 복구되지만, 연결이 끊겼거나 확인 SELECT만 실패한 경우에는 초기화 성공 여부를 먼저 확인해야 한다. 완료 여부를 모른 채 초기화 명령을 반복하지 않는다.

   ```bash
   npx wrangler d1 time-travel restore yegoom-db --bookmark=<메모한 값>
   ```

   `<메모한 값>` 전체를 1단계의 bookmark로 바꾼다. 복구는 그 시점 이후 변경도 되돌리므로 저장한 값을 확인하고 Wrangler의 확인 절차를 따른다. 복구 후 보존 계정·세션과 기존 기록을 확인한다.

로컬 검증은 `npx vitest run tests/launch-reset.test.ts`로 실행한다. 모든 현행 테이블을 채운 격리 D1에서 삭제·보존, 원래 트리거 정의와 쓰기 차단, 실패 시 원자적 롤백, 초기화 후 첫 쿠지판·뽑기 지갑·출석을 검사한다. 이 테스트는 운영 초기화 명령을 실행하지 않는다.
