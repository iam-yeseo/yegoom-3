# 런칭 준비 PR A 검증

PR #13의 main 머지를 확인하고 `e6fcbb85efbbc032c62bea3aaeeab916be2becec`에서 `codex/launch-a`를 만들었다. 첫 커밋 `ee82bc7`에는 첨부 원문과 바이트가 같은 `docs/plan-launch.md`만 추가했다. 이 보고는 PR A만 다룬다.

## 1. 구현과 변경 파일

- `shared/balance.ts`의 `FEATURES.stock`을 진입 경로와 카드가 함께 읽는다. `false`일 때 홈·게임 탭은 안내 모달, 실제·미리보기의 직접 주식 주소는 홈과 같은 안내를 보여 준다. 기존 `Stock.tsx` 코드는 그대로 보존했다.
- `worker/launch-gift.ts`, `worker/index.ts`, `shared/types.ts`: 출석한 활성 플레이어에게만 KST 2026-11-02 하루 동안 이용권을 지급한다. 두 종류를 같은 조건부 INSERT와 D1 batch로 기록하고 고유 reference로 중복을 막는다. bootstrap은 자격·수령 여부만 제공한다.
- `src/launch-gift.tsx`, `src/launch.css`, `src/App.tsx`, `src/screens/Home.tsx`, `src/screens/Attendance.tsx`, `src/api.ts`: 출석 연출 종료 후 모달, 미수령 재진입·수동 열기, 수령 완료와 날짜 종료를 처리한다. `src/shop.tsx`, `src/shop-preview.ts`는 미리보기 선물을 기존 이용권 잔량에 더한다.
- `scripts/launch-reset.sql`, `scripts/launch-reset.mjs`, `package.json`, `docs/launch-runbook.md`: 정확한 `RESET` 입력 후에만 실행하는 운영자용 초기화와 검증·복구 절차를 제공한다.
- `tests/e2e/app.spec.ts`, `tests/e2e/claw.spec.ts`의 두 불안정한 테스트는 테스트 코드에서 대기 방식을 고쳤다. `tests/e2e/launch.spec.ts`와 테스트 서버는 행사 당일을 별도의 로컬 Worker·D1에서 검증한다. 운영 Worker에는 시각 변경·데이터 주입·계측 API를 추가하지 않았다.

## 2. 마이그레이션과 운영 반영

새 마이그레이션은 없고 기존 `0001`~`0006` 파일도 수정하지 않았다. PR A 때문에 머지 전 `npm run db:migrate:remote`를 새로 실행할 필요는 없다. 기존 스키마가 모두 적용된 DB를 전제로 한다.

이번 작업은 Draft PR에서 멈춘다. 사용자 리뷰·머지 후 사용자가 PR A 머지를 알리면 PR B를 시작한다. 최종 런칭 기록 초기화는 PR B에서 추가되는 기록 테이블까지 반영한 뒤 운영자가 [런북](launch-runbook.md)에 따라 백업 bookmark 기록 → 정확한 `RESET` 확인 → 결과 확인 순으로 직접 수행한다. 운영 DB 초기화·원격 마이그레이션·머지·배포는 실행하지 않았다.

## 3. 검증

| 검증 | 결과 |
| --- | --- |
| `npm run check` | 통과: 타입 검사·501개 테스트(Worker·D1 통합 172개 포함)·빌드 |
| 지연 bootstrap 테스트 `--repeat-each=5` | 5/5 통과 (21.8초) |
| 뽑기 미리보기 자동 하강 테스트 `--repeat-each=5` | 5/5 통과 (57.6초) |
| `npm run test:e2e` 연속 1회차 | 44/44 통과 (3.2분) |
| `npm run test:e2e` 연속 2회차 | 44/44 통과 (3.2분), 코드·테스트 변경 없이 연속 실행 |

최종 UI 보완 후 타입 검사와 빌드를 다시 통과했고, 런칭 집중 E2E 5개도 통과했다. 두 전체 E2E는 재시도 없이 각각 44개를 통과했다.

런칭 선물 통합 테스트 14개는 11월 1일·3일 거절, 출석 전 거절, 정확한 자정 시작, 활성 플레이어/관리자/로그인 권한, 클라이언트 날짜·수량 무시, 각 5장 지급과 bootstrap·상점 반영, 중복·동시 1회 지급, 이용권 사용 후 재지급 방지, 두 번째 지급 실패 롤백, DB 실행이 자정을 넘긴 요청 거절을 검증한다.

초기화 테스트 3개는 모든 현행 테이블에 데이터를 넣은 로컬 D1에서 17개 기록 테이블 0행, `users`·`sessions`·`d1_migrations`·`claw_config` 모든 값 보존, `catchmind_turn` 포인터 초기화, 트리거 4개의 원래 SQL 및 수정·삭제 차단을 확인한다. 중간 실패 시 삭제와 트리거 제거가 함께 롤백되는지, 기존 세션으로 첫 쿠지판·5코인 지갑·출석 1일째가 정상인지도 확인한다. 래퍼 테스트는 가짜 `npx`로만 실행해 잘못된 확인 입력에서 DB 명령이 0회임을 검사한다.

D1 `meta.rows_read` 실측:

| 범위 | 읽은 행 |
| --- | ---: |
| `POST /api/events/launch-gift` 최초 수령, 인증 포함 | 12 |
| 같은 API 재요청, 인증 포함 | 12 |
| bootstrap의 선물 요약만, 미수령 / 수령 후 | 2 / 4 |
| 선물 지급 모듈만, 최초 / 재요청 | 10 / 10 |

최초 이용권 기록이 없는 사용자에서 측정했다. API 값에는 세션·사용자 인증 조회가 포함되고, bootstrap 요약 값에는 다른 게임·잔액·랭킹 조회가 포함되지 않는다. 이용권 잔량 합산 비용은 해당 사용자의 기록 수에 따라 달라진다. 계측은 테스트 번들에서만 수행한다.

## 4. 화면

모든 화면은 실제 로그인과 서버 없는 미리보기에서 확인했다. 아래 12장은 390×900px 또는 560×900px이며, 잘림·겹침·아이콘 넘침 없이 표시된다. 기존 87장 스크린샷은 SHA-256이 모두 원본과 같은 것을 확인했다.

| 화면 | 실제 390px | 실제 560px | 미리보기 390px | 미리보기 560px |
| --- | --- | --- | --- | --- |
| 주식 준비 중 | [보기](screenshots/launch-a-authenticated-stock-390.png) | [보기](screenshots/launch-a-authenticated-stock-560.png) | [보기](screenshots/launch-a-preview-stock-390.png) | [보기](screenshots/launch-a-preview-stock-560.png) |
| 선물 수령 전 | [보기](screenshots/launch-a-authenticated-gift-before-390.png) | [보기](screenshots/launch-a-authenticated-gift-before-560.png) | [보기](screenshots/launch-a-preview-gift-before-390.png) | [보기](screenshots/launch-a-preview-gift-before-560.png) |
| 선물 수령 후 | [보기](screenshots/launch-a-authenticated-gift-after-390.png) | [보기](screenshots/launch-a-authenticated-gift-after-560.png) | [보기](screenshots/launch-a-preview-gift-after-390.png) | [보기](screenshots/launch-a-preview-gift-after-560.png) |

## 5. 보류 사항

PR B의 프로필·당첨 소식·행운 점수 사진·0007 마이그레이션은 시작하지 않았다. 사용자가 PR A 머지를 알린 뒤 진행한다. PR A 범위에서 추가 판단이 필요한 제품 규칙은 없다.
