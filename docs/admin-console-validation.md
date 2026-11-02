# 운영 개선 PR 2 검증 — 운영 탭과 게임 설정

기준: `docs/plan-admin.md` PR 2. PR #18의 main 머지(`f978282`)를 확인한 뒤 최신 main에서 `codex/admin-console`을 만들었다. 계획 원문은 PR 1에서 이미 커밋되어 있으므로 그대로 보존했다.

## 1. 구현 요약과 변경 파일

- `shared/admin.ts`, `shared/game-settings.ts`, `shared/types.ts`: 설정 계약·범위 검증·사람이 읽는 차이 단위를 공유한다. 예측 게임 초기값은 `shared/balance.ts` 한 곳에 유지한다.
- `worker/game-settings.ts`, `worker/index.ts`, `worker/luck-photos.ts`: 운영자 API, 날짜별 설정, 판별 스냅숏, 변경 기록을 추가한다. 오늘 적용은 활동 여부를 같은 D1 batch에서 다시 검사한다. 예측 저장의 SQL 마감·보상도 판 설정을 읽는다. OFF는 조회로 판을 만들지 않고 입력·공개·행운 사진 변경을 거절한다.
- `src/screens/Admin.tsx`, `src/admin.css`, `src/App.tsx`, `src/api.ts`, `src/components/UI.tsx`, `src/screens.css`, `src/admin-preview.ts`: 운영자 전용 여섯 번째 탭, 배점표·골드·마감·적용일 편집, 최근 20건, 서버 없는 운영 미리보기. 계정이 바뀐 뒤 도착한 운영 응답은 버린다.
- `src/components/PredictionGame.tsx`, `src/screens/Home.tsx`, `src/sample.ts`: 서버 `rules`를 도움말·결과·홈/게임 카드에 반영하고 OFF 안내를 표시한다.
- `worker/claw.ts`, `src/screens/Claw.tsx`, `src/claw-state.tsx`, `src/claw-preview.ts`, `src/claw/controller.ts`, `src/claw/claw.css`: 운영자 개인 기계의 코인 없는 테스트, 보상 0, 강집게 옵션, 다음 플레이부터 적용되는 집게 설정을 추가한다. 설정 전체는 운영 API에만 노출한다.
- `tests/integration.test.ts`, `tests/claw-preview.test.ts`, `tests/launch-reset.test.ts`, `tests/e2e/admin-console.spec.ts`, `tests/e2e/claw.spec.ts`, `scripts/e2e-server.mjs`: 권한·경쟁·정산·설정 비공개·화면 검증. 초기화 SQL을 바꾸지 않고 새 두 테이블이 그대로 보존되는지도 확인한다.
- `tests/e2e/attendance-catchmind.spec.ts`: 실제 API의 지난 판과 종료 판 페이지를 읽어 회차·순서·모달 기대값을 계산한다. 다른 테스트가 종료/새 판을 만든 뒤에도 같은 검증을 유지한다. 모달의 인접 판 조회가 끝나 버튼이 활성화된 뒤 방향키를 보낸다. 실제 환경과 미리보기 고정 fixture를 구분한다.
- `README.md`, `docs/decisions.md`, 이 문서와 스크린샷에 동작·운영 순서·검증 근거를 기록한다.

### 규칙 참조 점검

실제 예측 화면과 Worker의 변경 가능 항목은 `PredictionRules`에서 읽는다. `GAME_RULES`의 직접 참조는 제목·출제자 같은 고정 정보와 기본값 생성에만 남는다. `SCORE_TABLES`, `PREDICTION_REWARDS`, 기본 마감/공개 시각은 `shared/game-settings.ts`의 기본값 생성에서만 실제 규칙으로 들어간다. 미리보기 과거 기록은 그 판의 기본값으로 고정하고 오늘 화면에는 편집한 미리보기 규칙을 전달한다.

`src/sample.ts`의 `BALANCE` 기본값 별칭과 고정 `previewLedger` 예시에는 기본 보상·점수 함수의 직접 참조가 남는다. 이는 실제 지급 경로가 아니며, 편집된 운영 미리보기 규칙은 오늘 게임 화면과 도움말에 적용한다.

집게 설명은 원본 `iam-yeseo/yegoom`의 `public/gatcha.html` blob `3ed2b36d7e6035939a9d58715949872ad21a49b9`을 읽기만 하여 그대로 사용했다. 원본 저장소는 수정하지 않았다. 미리보기 집게 설정은 운영 DB와 무관한 예시 값이다.

## 2. 마이그레이션과 운영 반영 순서

**머지 전에 `npm run db:migrate:remote` 실행 필요.** PR 1에서 `0008_catchmind_gallery.sql`을 사용했으므로 새 파일은 `0009_admin_settings.sql`이다.

- 추가: `game_settings`, `admin_changes`, nullable `game_rounds.settings_json`, 최근 변경 기록 인덱스. 현재 배포와 호환되는 추가형이다.
- 기존 `0001`~`0008` 마이그레이션은 변경하지 않았다.
- `scripts/launch-reset.sql`은 변경하지 않았다. 새 설정·감사 기록 테이블은 런칭 초기화 대상에 추가하지 않았고, 테스트에서 보존을 확인한다.
- 운영 순서: PR 리뷰 → 운영자가 원격 마이그레이션 적용 → 머지·배포 → 운영 탭 확인. 이 작업에서는 원격 DB 변경·머지·배포를 실행하지 않는다.

## 3. 규칙별 테스트와 결과

- `npm run check`: **통과**. 타입 검사, 10개 파일의 **615개 테스트**(Worker·D1 통합 262개 포함), 프로덕션 빌드·PWA 생성 완료. 새 통합 테스트 29개와 미리보기 테스트 2개를 포함한다.
- `npm run test:e2e`: **69/69를 두 번 연속 통과**(6.6분, 7.4분). 이 환경에서는 `CHROMIUM_PATH=/usr/bin/chromium XDG_CONFIG_HOME=/tmp/yegoom-config`를 지정했다.
- 지정된 실제 출석·지난 판·갤러리 테스트: 두 폭 × 5회, **10/10 통과**. 단독 반복은 새 fixture의 12판, 전체 실행은 앞선 테스트가 만든 13판을 검증한다.
- 설정 저장 중 화면 이탈·복귀로 생긴 이전 GET 응답을 PUT 완료 뒤에 전달하는 브라우저 회귀 테스트: **통과**. 저장된 값과 편집 가능 상태를 유지한다.
- Vite는 JS 번들 504.88kB(gzip 163.96kB)에 대해 기본 500kB 크기 권고를 표시한다. 빌드 오류는 아니며 이 PR에 별도 번들 분할 작업을 추가하지 않는다.
- `git diff --check`: 통과. 기존 스크린샷 **151장 SHA256 일치**, 기존 `0001`~`0008` 마이그레이션·계획 원문·런칭 초기화 SQL 변경 없음. 새 스크린샷은 아래 20장뿐이다.

| 규칙 | 검증 내용 |
| --- | --- |
| 권한·계정·조회 순서 | 무로그인 401, 플레이어 운영 API 403, 운영 탭 숨김·직접 경로 홈 이동, 요청 사용자 불일치 거절, 저장 뒤 오래된 GET 응답 무시 |
| 적용 시점 | 기본 다음 날, KST 00:00 적용, 활동 없는 오늘 허용, 예측·정답이 있으면 거절, 첫 예측과 오늘 설정 저장 경합 |
| 스냅숏 | 변경 후에도 지난 판 점수·골드 불변, 레거시 null 스냅숏 기본값, 오늘 첫 활동의 설정 저장 |
| 마감·OFF | 변경 마감 SQL 조건, 경계 시각, 자정 경합, 세 게임 OFF 입력·정답·기상·공개 거절, 판 미생성 |
| 배점·골드 | 1~10행, 기준 중복/역순/음수/소수, 점수 증가·범위, 골드 경계·0 보상, 고정 시각과 행운 마감 검증 |
| 원자성·기록 | 감사 쓰기 실패 시 설정 롤백, before/after 값, 최근 20건, 같은 timestamp에서도 저장 역순 |
| 운영자 뽑기 | 코인 0에서 플레이·쿨다운·재요청, 개인 기계 클리어·새 판, 저장/표시 보상 0, ledger·announcements 없음 |
| 집게 설정 | 운영자 강집게 옵션과 멱등 요청 구분, 플레이어 옵션 403, 범위·정수 퍼센트, 감사 실패 전체 롤백, 다음 플레이 적용·과거 영수증 불변, 플레이어 응답 비공개 |
| 미리보기 | API 차단 상태에서 설정 저장·OFF·집게 변경·보상 없는 테스트, 일반 플레이어 미리보기 분리 |
| 화면 | 390px/560px 여섯 탭 잘림·가로 overflow 없음, 배점 행 추가/삭제·유효성·단위, 적용일, OFF, 슬라이더, 결과, reduced motion |
| 캐치마인드 회귀 | 실제 현재/지난 판과 갤러리 순서를 API에서 확인, 고정 회차 제거, 앞선 테스트가 회차를 바꾸는 실행 순서에서도 검증, 인접 판 조회 완료 후 키보드 이동 |
| 기존 초기화 | 변경 없는 SQL이 기존 기록만 초기화하고 새 game_settings/admin_changes 데이터는 보존, 실패 롤백 |

### 무료 플랜 D1 읽기량

Miniflare 로컬 D1의 `meta.rows_read`를 합산했다. 아래 운영 API 값은 **세션 인증과 저장 후 운영 화면 응답까지 포함**한다. 운영 D1 실측은 아니며 운영 응답에는 측정 헤더를 추가하지 않는다. 측정 헤더는 테스트 빌드에만 주입한다. 게임/원장 기록이 비어 있는 fixture 기준으로 데이터에 따라 총량이 달라질 수 있다.

| 요청·조건 | rows_read |
| --- | ---: |
| `GET /api/admin`, 설정/감사 기록 없음 | 7 |
| `PUT /api/admin/games/offwork`, 오늘 설정 저장 | 12 |
| `PUT /api/admin/claw`, 집게 설정 저장 | 14 |
| `GET /api/admin`, 위 변경 2건 | 10 |
| `GET /api/admin`, 과거 설정 200건 추가 | 10 |
| `GET /api/admin`, 변경 기록 20건 | 46 |
| `GET /api/admin`, 오래된 변경 기록 200건 추가 | 46 |
| 게임당 적용 설정 조회, 과거 설정 200건 포함 | 1 |

적용 설정은 `(game_id, effective_from)` PK에서 `effective_from <= 날짜 ORDER BY effective_from DESC LIMIT 1`로 찾는다. 스냅숏이 있는 판은 그 값을 사용한다. 감사 목록은 최근 20건만 인덱스로 읽고, 같은 시각의 기록은 삽입 역순으로 정렬한다. 오래된 설정·감사 기록 수에 비례하여 읽기량이 증가하지 않음을 검증한다.

## 4. 스크린샷 (390px·560px)

`authenticated`는 실제 로그인·로컬 Worker/D1, `preview`는 API를 차단한 `#/preview/admin`이다. 각 모드에서 아래 5상태를 두 폭으로 확인한다. 테스트 시각은 격리한 로컬 빌드에만 주입하고, 운영 Worker에 시간 변경 API나 시드 경로를 추가하지 않는다.

| 모드·화면 | 390px | 560px |
| --- | --- | --- |
| 실제 · 운영 탭과 하단 바 | [보기](screenshots/admin-pr2-authenticated-tabbar-390.png) | [보기](screenshots/admin-pr2-authenticated-tabbar-560.png) |
| 실제 · 배점표·적용 시점 | [보기](screenshots/admin-pr2-authenticated-prediction-settings-390.png) | [보기](screenshots/admin-pr2-authenticated-prediction-settings-560.png) |
| 실제 · OFF 홈 카드 | [보기](screenshots/admin-pr2-authenticated-off-home-390.png) | [보기](screenshots/admin-pr2-authenticated-off-home-560.png) |
| 실제 · 집게 힘 설정 | [보기](screenshots/admin-pr2-authenticated-claw-settings-390.png) | [보기](screenshots/admin-pr2-authenticated-claw-settings-560.png) |
| 실제 · 보상 없는 운영자 결과 | [보기](screenshots/admin-pr2-authenticated-play-result-390.png) | [보기](screenshots/admin-pr2-authenticated-play-result-560.png) |
| 미리보기 · 운영 탭과 하단 바 | [보기](screenshots/admin-pr2-preview-tabbar-390.png) | [보기](screenshots/admin-pr2-preview-tabbar-560.png) |
| 미리보기 · 배점표·적용 시점 | [보기](screenshots/admin-pr2-preview-prediction-settings-390.png) | [보기](screenshots/admin-pr2-preview-prediction-settings-560.png) |
| 미리보기 · OFF 홈 카드 | [보기](screenshots/admin-pr2-preview-off-home-390.png) | [보기](screenshots/admin-pr2-preview-off-home-560.png) |
| 미리보기 · 집게 힘 설정 | [보기](screenshots/admin-pr2-preview-claw-settings-390.png) | [보기](screenshots/admin-pr2-preview-claw-settings-560.png) |
| 미리보기 · 보상 없는 운영자 결과 | [보기](screenshots/admin-pr2-preview-play-result-390.png) | [보기](screenshots/admin-pr2-preview-play-result-560.png) |

## 5. 보류·판단이 필요한 것

추가 제품 결정은 없다. PR 2와 지정한 캐치마인드 테스트 보완까지만 진행하며 Draft PR에서 멈춘다. 실제 운영 DB 적용과 배포 후 동작은 이 로컬 검증의 범위에 포함하지 않는다.
