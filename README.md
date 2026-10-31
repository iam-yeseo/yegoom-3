# 예굼방 아케이드 3

첨부된 게임 화면 HTML의 디자인을 React로 옮긴 예굼방의 새 시작입니다. Cloudflare Workers가 화면과 API를 제공하고 D1에 계정·세션·게임 기록을 저장합니다. Cloudflare 계정을 연결하지 않아도 로컬에서 실행할 수 있습니다.

## 현재 동작

- 아이디·비밀번호 로그인, 서버 세션, 로그아웃, 운영자/플레이어 구분
- 기상시간·퇴근시간·행운 점수: 예측 저장/수정, 출제자 정답·힌트 입력, 정답 공개, 공개 후 결과 비교
- 한국 시간 기준 마감, 공개 전 정답 보호, 날짜가 바뀐 화면의 제출 차단
- Claude Design 시안대로 만든 홈(아침/저녁), 하단 탭, 주간 랭킹, 출석 체크, 내 정보(캐릭터 선택·골드/점수 내역)
- 캐치마인드·쿠지·캐릭터 뽑기, 주식 시장(목록·상세·장 마감·상장폐지), 로또·스피또 화면
- 로그인 전 미리보기(`#/preview`)
- 설치 가능한 PWA, 로컬 폰트와 정적 화면의 오프라인 재방문

캐치마인드·쿠지·뽑기·주식·로또·스피또·출석은 아직 서버 기능이 없는 **화면 단계**입니다. 화면 안에서만 동작하고 저장되지 않으며 실제 골드·점수가 변하지 않습니다. 출석 받기와 내 캐릭터 선택은 이 기기에만 기억됩니다. 화면에 보이는 보상·배점·가격은 시안의 잠정값이며 모두 `src/sample.ts`의 `BALANCE`에 모여 있습니다. 실제 보상/정산과 운영자 관리 화면은 후속 범위입니다.

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

서비스 워커는 빌드 결과에서만 등록됩니다. 개발 서버에서는 등록하지 않습니다. PWA 설치에는 HTTPS 또는 localhost가 필요합니다. iOS에서는 Safari의 공유 → 홈 화면에 추가를 사용합니다. API·로그인·게임 저장은 오프라인에서 이용할 수 없으며, 제출을 나중에 자동 전송하지 않습니다. 오프라인에서는 저장된 화면과 미리보기를 이용할 수 있습니다.

## 계정 관리

같은 사용자명으로 `user:create`를 실행하면 비밀번호와 표시 이름을 갱신하고 기존 세션을 모두 해제합니다. 새 사용자명으로 실행하면 플레이어를 추가합니다. 운영자 비밀번호를 초기화할 때도 `--role admin`을 반드시 함께 지정합니다. 기존 기록을 보존하면서 계정을 중지하려면:

```sh
npm run user:create -- --username siwon --deactivate
```

운영자 계정은 예측·출제에 참여하지 않습니다. 현재 운영은 CLI로 수행하며 웹 관리 화면은 아직 없습니다. 초기 출제자는 `min`, `siwon`, `yeseo`로 지정되어 있습니다. 원격 DB 계정을 만들거나 중지하려면 별도로 `--remote`를 지정해야 합니다. 비밀번호를 CLI 인수나 저장소에 기록하지 마세요. 자동화에서는 `YEGOOM_PASSWORD` 환경변수를 사용할 수 있습니다.

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

Workers Static Assets와 D1 이외의 서비스는 초기 실행에 필요하지 않습니다. 자동 정답 공개는 서버가 매 요청 시 공개 시각을 판단하므로 Cron 없이도 동작합니다. 열린 화면은 30초마다 갱신하며 다시 활성화될 때도 갱신합니다. 실제 보상 정산·주식 시세·추첨을 추가할 때는 재시도 가능한 작업과 예약 실행을 별도로 설계해야 합니다.

## 검증

```sh
npm run check                    # TypeScript + 단위/Worker·D1 통합 테스트 + 빌드
npx playwright install chromium
npm run test:e2e                 # build 이후 실행: 실제 브라우저·D1·PWA 검증
npm run deploy:check             # 원격 배포 없이 Worker 패키징 검사
```

브라우저 테스트는 별도의 `.test-build/e2e` D1과 8788 포트를 사용하며 개발 DB를 수정하지 않습니다. 시스템 Chromium을 쓰려면 `CHROMIUM_PATH=/usr/bin/chromium npm run test:e2e`로 실행합니다. GitHub Actions에서도 타입·API·브라우저·빌드를 확인하며 자동 배포는 하지 않습니다.

## 코드 안내

| 경로 | 역할 |
| --- | --- |
| `src/components/PredictionGame.tsx` | 세 예측 게임의 입력·출제·결과 화면 |
| `src/components/PreviewGames.tsx` | 캐치마인드·쿠지·뽑기 화면 |
| `src/screens/` | 홈·랭킹·출석·내 정보·주식·상점 화면 |
| `src/sample.ts` | 잠정 밸런스 값(`BALANCE`)과 미리보기 데이터 |
| `src/motion.ts` | 모션 토큰·캐릭터 동작·컨페티·토스트 (Claude Design 모션 스펙) |
| `scripts/cutout-characters.py` | 캐릭터 원본의 크림색 배경 제거 |
| `src/styles.css`, `src/preview.css`, `src/screens.css` | 시안에서 옮긴 디자인 값과 반응형 화면 |
| `shared/types.ts` | 프런트엔드/Worker API 계약 |
| `worker/index.ts` | 인증, 권한 검사, D1 저장·조회 |
| `worker/rules.ts` | 출제자·마감·KST 날짜 정책 |
| `migrations/` | 명시적인 D1 스키마 변경 |
| `scripts/build-sw.mjs` | 파일 내용에 따라 버전이 바뀌는 정적 캐시 |

설계 기준과 변경 예정 항목은 [docs/decisions.md](docs/decisions.md), 디자인 출처는 [docs/design.md](docs/design.md)에 정리했습니다. 첨부 기획안 원문은 [docs/planning-reference.md](docs/planning-reference.md)에 별도로 보존했습니다.
