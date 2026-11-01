# 예굼방 아케이드 3

첨부된 게임 화면 HTML의 디자인을 React로 옮긴 예굼방의 새 시작입니다. Cloudflare Workers가 화면과 API를 제공하고 D1에 계정·세션·게임 기록을 저장합니다. Cloudflare 계정을 연결하지 않아도 로컬에서 실행할 수 있습니다.

## 현재 동작

- 아이디·비밀번호 로그인, 서버 세션, 로그아웃, 운영자/플레이어 구분
- 기상시간·퇴근시간은 `HH:MM:SS`, 행운 점수는 0~100 정수로 예측 저장/수정
- 출제자 전용 화면: 기상은 확인 후 서버 시각으로 즉시 공개, 퇴근은 입력 시각에 자동 공개, 행운 점수는 힌트와 함께 18:00 자동 공개(퇴근·행운은 조기 공개 가능)
- 첫 예측 저장 시 게임별 참여 100G, 공개 후 정확도 점수와 공동 1등 모두 100G를 append-only 원장에 멱등 지급
- 게임별 최근 공개 3판 기록(오늘 제외), 공통 규칙으로 생성한 게임 방법·점수표, 주간 점수 순위(주간 보상 없음)
- 서버 KST 기준 하루 한 번 출석: 연속 7·14일째마다 500G, 그 밖에는 100G 지급, 서버 월간 기록과 7일 주기 표시
- 출석 완료 후 홈 카드는 연출이 끝나면 한 줄로 접히며 다시 펼칠 수 있음
- 캐릭터 선택 서버 저장: 다른 기기의 홈·랭킹·결과·아바타에도 반영, 기존 기기 선택은 서버 값이 없을 때 한 번 이관
- 예굼쿠지: 서버 공용 100장 판, 6번째부터 누진 가격, 등급별 골드·점수·이용권과 라스트원 지급
- 데일리 로또: 1~25 중 5개 선택, 매일 KST 17:00 추첨, 이후 구매는 다음 날 대상, 표별 당첨금 멱등 정산
- 스피또: 구매 순간 서버에서 10% 당첨 여부·캐릭터 배치·1,500G 지급 확정, 나중에 다시 긁어도 결과 유지
- 골드 또는 이용권 결제, 보유 이용권 표시, 구매 요청 재시도·동시 요청의 중복 차감 방지
- 캐치마인드: 차례 맡기·비공개 제시어·3회 바꾸기·그림 출제·공개 답변, 오답 3개 힌트·6개 종료, 첫 정답자에게 3점·5G와 다음 차례
- 펜·지우개·영역 채우기·실행 취소, HSV·투명도·HEX·견본·최근 색을 지원하는 컬러 피커
- 전역 터치 이펙트: 누른 위치에 2px 코랄 테두리 링과 6px 색 점이 잠깐 나타나며, 입력·그리기 영역과 reduced motion에서는 생략
- 한국 시간 기준 마감, 공개 전 정답 보호, 날짜가 바뀐 화면의 제출 차단
- Claude Design 시안대로 만든 홈(아침/저녁), 하단 탭, 주간 랭킹, 출석 체크, 내 정보(캐릭터 선택·골드/점수 내역)
- 캐릭터 뽑기: 개인별 물리 기계, 10초 조작·하강 멈춤·서버 결과 재생, 무료/구매 코인, 인형·클리어 보상
- 주식 시장(목록·상세·장 마감·상장폐지) 화면
- 로그인 전 미리보기(`#/preview`)
- 설치 가능한 PWA, 로컬 폰트와 정적 화면의 오프라인 재방문

주식은 아직 서버 기능이 없는 **화면 단계**입니다. 화면 안에서만 동작하고 저장되지 않으며 실제 골드·점수가 변하지 않습니다. 예측 게임·출석·상점·캐치마인드·캐릭터 뽑기의 공개 규칙은 `shared/balance.ts`에서 Worker와 화면이 함께 읽습니다. 도움말의 시간 차이는 점수표 값에서 계산한 시·분·초 단위로 표시합니다. 나머지 화면의 잠정값과 미리보기 데이터는 `src/sample.ts`에 남아 있습니다. 홈의 골드·주간 점수와 내 정보 내역은 실제 원장 합계·기록을 표시합니다. 기존 기기 출석 기록은 서버로 옮기지 않고 정리하며, 미리보기의 출석·캐릭터 선택은 기기 안에서만 동작합니다. 미리보기의 상점·캐치마인드·캐릭터 뽑기도 서버 없이 동작하며 실제 계정에 반영되지 않습니다. 후속 개발 범위는 [2차 계획](docs/plan-v2.md)을 따릅니다.

## 로컬 시작

Node.js 22.12 이상을 권장합니다.

```sh
npm ci
npm run build
npm run db:migrate
npm run user:create -- --username min --display-name min
npm run user:create -- --username siwon --display-name siwon
npm run user:create -- --username yeseo --display-name yeseo
npm run user:create -- --username admin --display-name 운영자 --role admin
npm run dev
```

각 계정의 비밀번호를 터미널에서 입력합니다(12–128자, 화면에 표시되지 않음). 기본 비밀번호는 없습니다. `http://localhost:5173`에서 사용합니다. 계정 생성 없이 로그인 화면의 **먼저 체험해 보기**로 디자인을 확인할 수도 있습니다.

`npm run dev`는 Vite와 로컬 Worker를 함께 실행합니다. 처음에는 정적 파일을 빌드한 뒤 시작합니다. 프런트엔드 변경은 Vite가 바로 반영하고 Worker 변경은 Wrangler가 반영합니다. 로컬 D1은 `.wrangler/state`에 보존되며 Git에서 제외됩니다.

빌드 결과와 서비스 워커를 확인하려면:

```sh
npm run build
npm run preview
# http://localhost:8787
```

서비스 워커는 빌드 결과에서만 등록됩니다. 개발 서버에서는 등록하지 않습니다. PWA 설치에는 HTTPS 또는 localhost가 필요합니다. iOS에서는 Safari의 공유 → 홈 화면에 추가를 사용합니다. 로그인·상태 조회·게임 저장은 오프라인에서 이용할 수 없으며, 제출을 나중에 자동 전송하지 않습니다. 오프라인에서는 저장된 화면과 미리보기를 이용할 수 있습니다. 서비스 워커는 캐치마인드 이미지를 포함한 모든 `/api` 경로를 캐시하지 않습니다.

## 계정 관리

같은 사용자명으로 `user:create`를 실행하면 비밀번호와 표시 이름을 갱신하고 기존 세션을 모두 해제합니다. 새 사용자명으로 실행하면 플레이어를 추가합니다. 운영자 비밀번호를 초기화할 때도 `--role admin`을 반드시 함께 지정합니다. 기존 기록을 보존하면서 계정을 중지하려면:

```sh
npm run user:create -- --username siwon --deactivate
```

운영자 계정은 예측·출제·출석·상점 구매·캐치마인드·뽑기 플레이 및 코인 구매에 참여하지 않습니다. 뽑기는 데모 기계만 볼 수 있습니다. 현재 운영은 CLI로 수행하며 웹 관리 화면은 아직 없습니다. 초기 예측 출제자는 `min`, `siwon`, `yeseo`로 지정되어 있습니다. 원격 DB 계정을 만들거나 중지하려면 별도로 `--remote`를 지정해야 합니다. 비밀번호를 CLI 인수나 저장소에 기록하지 마세요. 자동화에서는 `YEGOOM_PASSWORD` 환경변수를 사용할 수 있습니다.

## Cloudflare 연결 후 배포

원격 D1은 `yegoom-db`(`088d5d45-6dea-43c1-b9b2-a972aa5a01d0`)이며 `wrangler.jsonc`에 연결되어 있습니다. 기존 yegoom의 DB와 기록은 연결하지 않습니다. Cloudflare 대시보드의 Git 연결 빌드는 main에 푸시될 때 이 설정으로 배포합니다. 다른 DB로 바꿀 때는 `database_name`과 `database_id`를 함께 바꿉니다. 존재하지 않는 ID면 배포가 `D1 binding 'DB' references database … which was not found [code: 10181]` 오류로 실패합니다.

배포는 테이블을 만들지 않습니다. 처음 한 번, 그리고 `migrations/`가 바뀔 때마다 원격 마이그레이션을 실행하고 계정을 만듭니다.

```sh
npx wrangler login
npm run db:migrate:remote
npm run user:create -- --username min --display-name min --remote
npm run user:create -- --username siwon --display-name siwon --remote
npm run user:create -- --username yeseo --display-name yeseo --remote
npm run user:create -- --username admin --display-name 운영자 --role admin --remote
npm run deploy:check
npm run deploy
```

Phase 6은 **`0006_claw.sql` 마이그레이션이 필요합니다**. 기존 `0001`~`0005`는 수정하지 않았습니다. 운영 반영 순서는 **PR 리뷰 → 운영자가 머지 전에 `npm run db:migrate:remote` 실행 → PR 머지 → main 배포**입니다. 새 테이블만 추가하므로 기존 배포와 호환됩니다. 이번 개발 작업에서는 원격 DB 변경·머지·배포를 실행하지 않습니다.

Workers Static Assets와 D1 이외의 서비스는 초기 실행에 필요하지 않습니다. 자동 정답 공개는 서버가 요청 시 공개 시각을 판단하므로 Cron 없이도 동작합니다. bootstrap·게임·기록 조회는 공개됐지만 정산되지 않은 판을 정산하며, 지급 고유 reference로 중복을 막습니다. 점수의 주차는 정산 시각이 아닌 게임 날짜의 KST 월요일입니다. 정답 없는 판은 정산하지 않으며 이미 받은 참여 보상은 유지됩니다. 일반 화면은 30초마다 갱신하며 다시 활성화될 때도 갱신합니다. 뽑기 화면에서는 이 폴링을 중지합니다.

데일리 로또는 bootstrap과 상점 요청에서 추첨 시간이 지난 표를 정산하므로 며칠 뒤 접속해도 누락된 당첨금을 받습니다. 이용권도 append-only 원장의 합계이며 구매는 잔액 검사·차감·결과 저장을 같은 D1 batch로 처리합니다. 구매 응답을 받지 못하면 같은 요청 번호로 결과를 재확인하며, 이미 처리한 구매를 다시 차감하지 않습니다.

캐치마인드는 날짜와 무관하게 한 판씩 이어집니다. 제시어는 출제자만 보고, 끝난 판은 결과를 유지하다가 다음 출제자가 새 판을 시작합니다. 답변·종료·차례 이동·보상은 같은 D1 batch에서 처리하며 재요청은 오답 횟수나 지급을 늘리지 않습니다. 점수 주차와 일별 그래프는 그림을 공개한 KST 날짜를 사용합니다. 공개한 그림은 바꿀 수 없으며 정사각형 PNG/WebP의 디코딩된 이미지 바이트가 300KiB 이하여야 합니다. 화면이 보일 때만 5초마다 새로 조회합니다.

캐치마인드 상태 응답은 그림 본문 대신 판 ID별 이미지 주소를 제공합니다. 그림은 `GET /api/catchmind/rounds/:id/image`에서 PNG/WebP로 받고, `Cache-Control: private, max-age=31536000, immutable`로 브라우저 HTTP 캐시를 재사용합니다. 로그인은 필수이며 공개 전에는 출제자만 접근할 수 있습니다. 상태·오류 응답은 계속 `no-store`입니다. 미리보기는 로컬 그림을 사용해 서버 없이 동작합니다.

다음 Phase 작업은 이전 Phase PR이 main에 머지되었는지 확인한 뒤 시작합니다. 미머지 상태이면 시작하지 않고 알립니다.

Phase 6은 Phase 5 보완 PR #12의 머지를 확인한 최신 main `aa90e5e`에서 `codex/v3-claw`로 시작했습니다. 첫 커밋에 PM 확정 [이식 계획](docs/plan-claw.md)을 그대로 추가했습니다. 원본 `iam-yeseo/yegoom`은 읽기만 했습니다.

## 캐릭터 뽑기 운영

무료 코인은 한국 시간 00·03·06·09·12·15·18·21시에 요청이 오면 5개로 채웁니다. 남은 무료 코인과 놓친 충전은 이월하지 않습니다. 구매 코인은 1개 100G이며 한 번에 1개 또는 5개를 살 수 있고, 무료 코인을 먼저 씁니다. 인형 한 개당 1점·10G, 30개를 모두 뽑으면 추가 5점·300G를 지급합니다. 공개 경제 규칙은 `shared/balance.ts`의 `CLAW_RULES`를 사용합니다.

기계 조회는 저장된 판을 읽으며, bootstrap은 코인 요약만 제공합니다. 시뮬레이션은 새 플레이 요청에서 한 번 실행하고 재시도는 저장된 결과를 반환합니다. 화면 진입·플레이 후·화면 복귀·다음 충전 때만 조회하며 주기적으로 서버를 호출하지 않습니다. 응답이 끊기면 같은 요청 번호로 결과를 확인하고 코인을 중복 사용하지 않습니다. 미리보기는 서버 없이 같은 물리 엔진과 기기 메모리의 코인으로 동작합니다.

확률기 설정은 서버 DB의 `claw_config` 한 행에만 있습니다. 기본값은 강집게 주기 10, 약집게 들어 올리기 45%, 옮기기 30%입니다. 주기는 1~50, 약집게 힘은 각각 5~100 범위이며 강집게 또는 인형 획득 후 개인 카운터를 초기화합니다. API는 현재 판에 사용한 힘만 반환하며 설정과 카운터를 내려주지 않습니다. 운영자가 값을 바꿀 때 사용하는 명령의 예시는 다음과 같습니다(이번 개발 작업에서 실행하지 않음).

```sh
npx wrangler d1 execute DB --remote --command "SELECT payout_every, weak_pickup, weak_carry FROM claw_config WHERE id = 1;"
npx wrangler d1 execute DB --remote --command "UPDATE claw_config SET payout_every = 10, weak_pickup = 45, weak_carry = 30, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = 1;"
```

물리 원본은 `iam-yeseo/yegoom@5a8017247c365b7233f4dfb2209a6bf27a30c678`이며 테스트 fixture와 완전 일치 검증을 유지합니다. 인형 출처·최적화·재생성 방법은 [자산 출처](docs/asset-provenance.md)에 기록했습니다. 원본 결과 장면 그림은 사용하지 않습니다.

## 검증

```sh
npm run check                    # TypeScript + 단위/Worker·D1 통합 테스트 + 빌드
npx playwright install chromium
npm run test:e2e                 # build 이후 실행: 실제 브라우저·D1·PWA 검증
npm run deploy:check             # 원격 배포 없이 Worker 패키징 검사
```

브라우저 테스트는 실행마다 별도의 `.test-build/e2e-*` D1과 8788 포트를 사용하며 개발 DB를 수정하지 않습니다. 테스트 번들에서만 서버·SQL 시각을 고정해 마감 전 예측과 공개를 재현하며, 운영 코드에는 테스트용 시각 설정이나 데이터 주입 API를 두지 않습니다. 시스템 Chromium을 쓰려면 `CHROMIUM_PATH=/usr/bin/chromium npm run test:e2e`로 실행합니다. GitHub Actions에서도 타입·API·브라우저·빌드를 확인하며 자동 배포는 하지 않습니다.

Phase 5 검증: `npm run check`의 209개 테스트(Worker·D1 통합 128개 포함)와 `npm run test:e2e`의 34개가 통과했습니다. 터치 입력·제외·제거·모달 표시와 이미지 권한·HTTP 캐시 재사용·서비스 워커 제외를 검증했습니다. 실제 로그인·미리보기의 터치 효과와 실제 이미지 화면을 390px·560px로 확인한 6장은 [스크린샷 폴더](docs/screenshots)의 `v2-p5-*.png`에 있으며 기존 Phase 스크린샷도 보존했습니다.

터치 효과 가시성 보완은 Phase 5 PR #11이 머지된 main `99841fb`에서 진행했고 두 검증 명령을 다시 통과했습니다. 390px 실제 로그인 홈에서 누른 뒤 90ms 시점의 [크림 배경](docs/screenshots/v2-p5-touch-contrast-home-390.png)·[흰 카드](docs/screenshots/v2-p5-touch-contrast-card-390.png)·[코랄 버튼](docs/screenshots/v2-p5-touch-contrast-button-390.png)을 촬영했습니다.

Phase 6 검증: `npm run check`의 **484개 테스트**(Worker·D1 통합 158개 포함)·타입 검사·빌드, `npm run test:e2e` **39개**가 통과했습니다. 원본 물리 골든 240조합이 전체 JSON과 일치했고, 300회 시뮬레이션의 중앙값은 2.387ms, p99는 8.877ms였습니다. 뽑기 모듈의 D1 읽기량은 기계 조회 2행·bootstrap 요약 1행입니다. 인형 11장은 3,403,205B에서 169,940B로 줄였습니다. 규칙별 검증과 390px·560px 화면 16장은 [Phase 6 검증 보고](docs/phase6-validation.md)에 있습니다.

## 코드 안내

| 경로 | 역할 |
| --- | --- |
| `src/components/PredictionGame.tsx` | 세 예측 게임의 입력·출제·결과 화면 |
| `src/screens/Claw.tsx`, `src/claw/*` | 물리 뽑기 화면·조작·캔버스·소리·결과 |
| `src/claw-state.tsx`, `src/claw-preview.ts` | 뽑기 상태·응답 유실 복구·서버 없는 미리보기 |
| `src/screens/Catchmind.tsx`, `src/catchmind.tsx`, `src/catchmind-preview.ts` | 캐치마인드 화면·서버 상태·서버 없는 미리보기 |
| `src/components/DrawingCanvas.tsx`, `src/components/ColorPicker.tsx` | 그리기 도구·컬러 피커 |
| `src/drawing.ts`, `src/color.ts` | 영역 채우기·HSV/HEX 변환 |
| `src/screens/Kuji.tsx`, `src/screens/Shop.tsx` | 쿠지·데일리 로또·스피또·이용권 화면 |
| `src/shop.tsx`, `src/shop-preview.ts` | 서버 구매·재시도 상태와 서버 없는 미리보기 상점 |
| `src/screens/` | 홈·랭킹·출석·내 정보·주식·상점 화면 |
| `src/sample.ts` | 후속 게임의 잠정값(`BALANCE`)과 공통 규칙을 참조하는 미리보기 데이터 |
| `src/motion.ts` | 모션 토큰·캐릭터 동작·컨페티·토스트 (Claude Design 모션 스펙) |
| `scripts/prepare-characters.py` | 최종 캐릭터 시트를 프레임·정지 PNG·웹 스프라이트·QA 자료로 분리 |
| `scripts/cutout-characters.py` | 캐릭터 원본의 크림색 배경 제거 (이전 임시 아트용) |
| `src/styles.css`, `src/preview.css`, `src/screens.css` | 시안에서 옮긴 디자인 값과 반응형 화면 |
| `shared/types.ts` | 프런트엔드/Worker API 계약 |
| `shared/balance.ts` | 예측·출석·상점·캐치마인드·뽑기 공개 경제 규칙과 보상 단일 소스 |
| `shared/claw-physics.ts` | 원본과 계산이 같은 결정적 뽑기 물리 엔진 |
| `shared/catchmind-words.ts` | 기존 yegoom에서 가져온 제시어 400개와 원본 blob 식별자 |
| `shared/characters.ts` | 캐릭터 8종과 기본 매핑 |
| `src/attendance.ts` | 서버 출석 상태와 서버 없이 동작하는 미리보기 출석 |
| `worker/index.ts` | 인증, 권한 검사, D1 저장·조회·예측 보상 정산 |
| `worker/shop.ts` | 원자적 구매·이용권·쿠지판·로또 정산·스피또 결과 |
| `worker/catchmind.ts` | 캐치마인드 차례·제시어·그림 검증·답변·원자적 정산 |
| `worker/claw.ts` | 개인 기계·무료/구매 코인·비공개 확률기·물리 플레이·원자적 보상 |
| `scripts/prepare-claw-dolls.py` | 원본 인형 PNG 11장의 투명 WebP 최적화·검증 |
| `worker/rules.ts` | 초 단위 입력 검증·차이 계산·KST 날짜 정책 |
| `migrations/` | 명시적인 D1 스키마 변경 |
| `scripts/build-sw.mjs` | 파일 내용에 따라 버전이 바뀌는 정적 캐시 |

설계 기준과 변경 예정 항목은 [docs/decisions.md](docs/decisions.md), 디자인 출처는 [docs/design.md](docs/design.md)에 정리했습니다. 첨부 기획안 원문은 [docs/planning-reference.md](docs/planning-reference.md)에 별도로 보존했습니다.
