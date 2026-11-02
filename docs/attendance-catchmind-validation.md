# 운영 개선 PR 1 검증 — 출석 이용권과 캐치마인드 기록

기준: 2026-11-02 KST, `docs/plan-admin.md` PR 1. 최신 main `dff130c`에서 `codex/attendance-catchmind`를 만들고 첫 커밋에 PM 계획 원문을 보존했다.

## 구현과 변경 파일

- `shared/balance.ts`, `worker/index.ts`: 서버 KST 2026-11-03부터 출석 골드와 이용권 각 1장을 동일 batch에 지급한다. 새 골드 지급 ID와 이용권 reference UNIQUE가 중복·동시 요청을 보호한다. 100G/7·14일째 500G, 기존 기록, 11-02 런칭 선물은 유지한다.
- `src/screens/Home.tsx`, `Attendance.tsx`, `src/shop-preview.ts`: 공유 규칙으로 보상·토스트를 표시하고 미리보기 이용권도 중복 없이 반영한다.
- `worker/catchmind.ts`, `worker/index.ts`, `shared/types.ts`, `migrations/0008_catchmind_gallery.sql`: 현재 회차 이전의 최신 종료 판과 종료 판 갤러리 API, exclusive 회차 cursor, `(status, number)` 인덱스를 추가한다. 메타데이터에 이미지 본문이나 진행 중 제시어를 넣지 않는다.
- `src/screens/CatchmindGallery.tsx`, `Catchmind.tsx`, `src/catchmind.tsx`, `catchmind-preview.ts`, `api.ts`, `App.tsx`, CSS: 지난 판 카드, 실제/미리보기 갤러리 경로, 3×3 격자, 더 보기, 공용 모달·키보드·페이지 경계 탐색을 구현한다. 프로필 사진이 없으면 선택 캐릭터를 표시한다.
- `tests/integration.test.ts`, `tests/shop-preview.test.ts`, `tests/e2e/attendance-catchmind.spec.ts`, `tests/e2e/app.spec.ts`, `scripts/e2e-server.mjs`: 경계·멱등·롤백·페이지네이션·읽기량·브라우저 검증을 추가하고 출석 문구를 읽는 기존 테스트를 갱신한다. README와 decisions도 갱신한다.

## 마이그레이션과 운영 반영

**머지 전에 `npm run db:migrate:remote` 실행 필요.** `0008_catchmind_gallery.sql`은 인덱스 추가만 하므로 현재 배포와 호환된다. 기존 마이그레이션과 `scripts/launch-reset.sql`은 수정하지 않았다.

1. 운영자가 원격 마이그레이션을 적용한다.
2. PR 1을 리뷰·머지하고 **2026-11-03 00:00 KST(2026-11-02 15:00 UTC) 전** 배포를 완료한다.
3. 11-02까지 출석은 골드만, 11-03부터는 골드와 이용권 각 1장이 적용된다. 늦게 배포하면 이미 출석한 계정에 소급 지급하지 않는다.

이번 작업은 Draft PR까지만 진행한다. 원격 DB 적용·머지·배포는 실행하지 않으며 PR 2는 사용자 머지 통보를 기다린다. PR 2의 새 마이그레이션 번호는 0009다.

## 테스트 결과

- `npm run check`: **통과**. 타입 검사, 10개 파일의 **584개 테스트**, 프로덕션 빌드·PWA 생성 완료.
- `npm run test:e2e`: **63개 모두 통과**(4.3분). 이 환경에서는 `CHROMIUM_PATH=/usr/bin/chromium XDG_CONFIG_HOME=/tmp/yegoom-config`를 지정했다.
- 새 PR 1 브라우저 시나리오 6개, 390px·560px 실제 로그인/미리보기 스크린샷 20장. 기존 11-02 런칭 선물 흐름도 회귀 테스트 통과.
- `git diff --check`: 통과. 원격 마이그레이션·머지·배포는 실행하지 않음.

| 규칙 | 검증 |
| --- | --- |
| 적용일·서버 시각 | 11-02 23:59:59에는 골드만, 11-03 00:00:00부터 이용권 각 1장. 위조 클라이언트 날짜·수량 무시, 이후 날짜도 지급 |
| 연속 출석 | 7·14일째 500G + 이용권 각 1장, 그 외 100G. 과거 출석 행 불변 |
| 멱등·원자성 | 두 세션 동시 요청과 재요청에서 한 번 지급. 스피또 행 실패 시 출석·골드·로또까지 전체 롤백 후 재시도 성공 |
| 자정·권한 | KST 자정을 넘겨 대기한 SQL 쓰기 409, 기록·보상 없음. 운영자 출석 403 |
| 재고·런칭 선물 | 출석 이후 bootstrap·상점 재고 일치. 11-02 선물 각 5장과 이후 출석 이용권이 분리되고, 사용한 미리보기 이용권 복원 없음 |
| 갤러리 공개 범위 | draft/open 제외, 메타데이터에 base64·private prompt 없음, 이미지 immutable 캐시 유지, 무로그인 401 |
| 페이지 | 최신 회차부터 9/9/3개, 중간에 새 판이 끝나도 기존 cursor 안정, 잘못된 before/limit 400 |
| 지난 판 | 첫 종료 때 비어 있음, 다음 draft/open 때 이전 결과 유지, 현재 ended 때 이전 판 표시, 다음 판 시작 후 방금 끝난 판 표시 |
| 프로필 | 닉네임·프로필 사진·캐릭터 fallback, 실제 로그인 카드의 사진 표시 |
| 모달 | 카드와 갤러리의 공용 모달, 이전/다음 버튼·←/→, 페이지 경계 추가 로드, 처음/끝 경계, Esc·버튼·바깥 클릭 닫기, 포커스 복귀 |
| 미리보기·화면 | API 차단 상태에서 동일 화면·출석·재고 사용, 390/560px 가로 overflow 없음, reduced motion, 빈 목록·오류·재시도 |

브라우저 검증은 실제 로그인·Worker·로컬 D1 경로로 실행한다. 11-03 시각은 격리한 테스트 빌드에만 주입하고 브라우저 시계도 맞춘다. 운영 Worker에는 시간 변경 API·환경변수·시드 endpoint를 추가하지 않는다. 사진·종료 판은 로컬 전용 fixture다.

## 무료 플랜 읽기량

Miniflare 로컬 D1의 실제 `meta.rows_read`를 합산했다. **세션 인증을 포함한 GET `/api/catchmind/gallery` 한 요청**의 값이며 운영 D1 실측은 아니다. 프로덕션 응답에는 측정 헤더를 넣지 않는다.

| 데이터 | 반환 수 | rows_read |
| --- | ---: | ---: |
| 종료 판 없음 | 0 | 3 |
| 종료 판 20개 중 첫 페이지 | 9 | 14 |
| 같은 데이터의 둘째 페이지 | 9 | 14 |
| 과거 5,000판 추가 후 첫 페이지 | 9 | 14 |
| 과거 5,000판 추가 후 둘째 페이지 | 9 | 14 |

위 fixture의 출제자·맞힌 사람은 2명이며 프로필 사진은 없다. 프로필 종류·사진 유무에 따라 총량은 달라진다. 조회량은 오래된 판 수에 비례하지 않는다. gallery는 `limit + 1` 메타데이터와 해당 페이지의 고유 사용자만 읽고, 그림 본문은 기존 이미지 API에서 별도로 받는다. 썸네일은 lazy loading과 고정 크기를 지정한다.

## 스크린샷

모두 2026-11-03 KST 화면이다. `authenticated`는 실제 로그인·로컬 Worker/D1, `preview`는 API 차단 상태다.

| 모드·화면 | 390px | 560px |
| --- | --- | --- |
| 실제 로그인 · 출석 카드 | [보기](screenshots/admin-pr1-authenticated-attendance-card-390.png) | [보기](screenshots/admin-pr1-authenticated-attendance-card-560.png) |
| 실제 로그인 · 출석 화면 | [보기](screenshots/admin-pr1-authenticated-attendance-screen-390.png) | [보기](screenshots/admin-pr1-authenticated-attendance-screen-560.png) |
| 실제 로그인 · 지난 판 | [보기](screenshots/admin-pr1-authenticated-previous-round-390.png) | [보기](screenshots/admin-pr1-authenticated-previous-round-560.png) |
| 실제 로그인 · 갤러리 3×3 | [보기](screenshots/admin-pr1-authenticated-gallery-390.png) | [보기](screenshots/admin-pr1-authenticated-gallery-560.png) |
| 실제 로그인 · 모달 | [보기](screenshots/admin-pr1-authenticated-gallery-modal-390.png) | [보기](screenshots/admin-pr1-authenticated-gallery-modal-560.png) |
| 미리보기 · 출석 카드 | [보기](screenshots/admin-pr1-preview-attendance-card-390.png) | [보기](screenshots/admin-pr1-preview-attendance-card-560.png) |
| 미리보기 · 출석 화면 | [보기](screenshots/admin-pr1-preview-attendance-screen-390.png) | [보기](screenshots/admin-pr1-preview-attendance-screen-560.png) |
| 미리보기 · 지난 판 | [보기](screenshots/admin-pr1-preview-previous-round-390.png) | [보기](screenshots/admin-pr1-preview-previous-round-560.png) |
| 미리보기 · 갤러리 3×3 | [보기](screenshots/admin-pr1-preview-gallery-390.png) | [보기](screenshots/admin-pr1-preview-gallery-560.png) |
| 미리보기 · 모달 | [보기](screenshots/admin-pr1-preview-gallery-modal-390.png) | [보기](screenshots/admin-pr1-preview-gallery-modal-560.png) |

## 보류·판단

PR 1의 추가 제품 결정은 없다. PR 2(운영 탭·예측 설정·인형뽑기 운영)는 구현하지 않았다. 무료 플랜의 실제 운영 D1 비용과 배포 완료 여부는 이 로컬 검증으로 확인하지 않는다.
