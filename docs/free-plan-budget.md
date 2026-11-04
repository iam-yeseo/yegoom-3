# 무료 플랜 예산 — 개선 PR 2~4

측정일 2026-11-04. 기준 main `c873ae8`과 PR 2 코드를 같은 로컬 D1 fixture로 비교했다. 실제 운영 계정의 사용량이나 Workers CPU를 측정한 결과는 아니다. 원자료는 [D1 측정 JSON](free-plan-measurements.json), [CPU 측정 JSON](free-plan-cpu.json)이다.

## 개선 PR 4 — 캐치마인드

기준 main `4ccc82d`의 별도 작업 복사본과 같은 인증 포함 D1 계측 wrapper/fixture를 비교했다. [PR 4 요청 원자료](free-plan-pr4-measurements.json)는 읽기·변경 15개 표본과 기존 큰 원장 bootstrap 12개 표본을 담는다. 이는 로컬 D1/workerd 측정이며 운영 DB에 접근하지 않았다.

표의 값은 **실행 SQL 문장 수 / rows_read**다. 각 batch 내부 문장도 센 수이며, 호출당 50회 한도에 사용하는 binding 호출 수는 원자료에서 별도로 센다. 작은 판·빈 단어 묶음 부근의 동일 fixture다.

| 요청 | PR 3 main | PR 4 |
| --- | ---: | ---: |
| GET 대기 | 3 / 4 | 3 / 6 |
| GET 타인 초안 | 6 / 7 | 5 / 13 |
| GET 공개 판 전체 | 6 / 7 | 5 / 13 |
| GET 공개 판, 변경 없음 | 6 / 7 | **2 / 4** |
| POST 첫 맡기 | 12 / 19 | 13 / 32 |
| POST 제시어 바꾸기 | 11 / 15 | 12 / 29 |
| POST 그림 공개 | 11 / 16 | 10 / 28 |
| POST 오답 | 15 / 35 | 13 / 44 |
| 같은 오답 재시도 | 7 / 10 | 6 / 16 |
| POST 수동 종료 | 11 / 19 | 10 / 39 |
| GET 종료 판 | 6 / 9 | 5 / 15 |
| POST 다음 판 | 13 / 23 | 14 / 39 |

조회·저장된 재시도는 rows_written=0이다. 새 변경은 접수 영수증·버전·차례·단어의 원자적 보호 때문에 행 읽기/쓰기가 늘어날 수 있다. 단어 예약 쿼리는 사용 표를 읽으므로 묶음이 차면 위 작은 fixture보다 최대 400행 가까이 더 읽는다. 전체 응답도 답변 수·이전 판·프로필에 따라 커진다. 모든 요청이 더 싸졌다는 뜻은 아니다. 운영 화면은 남은 단어를 읽는 조회 1개가 추가된다.

기존 큰 원장(각 100/10,000행) bootstrap **12개 표본은 prepare·문장·binding 호출·rows_read 모두 동일**하다. 10,000행 기준 오전 idle 15/161·open 17/164, 오후 idle 15/162·open 17/165이며 정산 없는 쓰기는 0이다. 계정 확인용 viewerId와 단어 사용 정보는 bootstrap에 별도 쿼리를 추가하지 않는다.

### 하루 10시간, 3~4명 폴링

상태가 변하지 않는 구간의 계산이다. `since`가 같은 GET은 인증 포함 2문장·최대 4행, bootstrap은 기존 큰 fixture의 17문장·165행을 사용했다. 시작·화면 복귀·사진·게임 변경 요청과 그에 따른 bootstrap은 다음 문단처럼 별도로 더한다.

| 상태·요청 | 주기 | 3명 요청/일 | 4명 요청/일 | 4명 SQL 문장/일 | 4명 rows_read/일 |
| --- | --- | ---: | ---: | ---: | ---: |
| 캐치마인드 화면 bootstrap | 60초 | 1,800 | 2,400 | 40,800 | 396,000 |
| 공개 판 변경 없음 GET | 5초 | 21,600 | 28,800 | 57,600 | 115,200 |
| 공개 판 화면 합계 | 위 두 요청 | 23,400 | 31,200 | 98,400 | **511,200** |
| 대기·종료 변경 없음 GET | 10초 | 10,800 | 14,400 | 28,800 | 57,600 |
| 대기·종료 화면 합계 | bootstrap 포함 | 12,600 | 16,800 | 69,600 | **453,600** |
| 그리는 중 GET(출제자 1명 중단, 나머지 조회) | 10초 | 7,200 | 10,800 | 21,600 | 43,200 |
| 그리는 중 화면 합계 | bootstrap 포함 | 9,000 | 13,200 | 62,400 | **439,200** |
| 숨김·오프라인·미리보기의 서버 요청 | 중단 | 0 | 0 | 0 | 0 |

공개 판의 이전 PR 3 예상은 597,600행/일이었다. 이제 같은 가정은 511,200행(읽기 한도의 약 10.22%)이며 Worker 요청 수는 open의 5초 주기를 유지하므로 같다. 대기·종료는 GET 주기가 5→10초로 늘어 서버 요청도 줄어든다. 자기 초안은 주기 GET이 없지만 가시성·온라인 복귀 때 인증 상태를 확인한다.

실제 게임이 변할 때는 전체 응답과 저장 후 갱신을 더한다. 예를 들어 20판/일, 판당 시작 1·공개 1·바꾸기 3·오답 10이면 변경 요청 300건이다. 변경마다 다른 3명이 한 번씩 관측한다고 넉넉히 잡으면 기존 GET 중 최대 900건을 전체 응답으로 바꾸고, 본인/동료의 bootstrap 갱신을 최대 1,200건 더한다. 전체 응답과 변경의 기본 행 읽기를 각각 100행, 단어 선택 80회의 추가 스캔을 각각 400행으로 **가정**하면 약 857,600행/32,700요청/일이다. 이 100행은 측정 상한이나 코드 보장이 아니며, 실제 답변·사진·점수 데이터에 맞춰 원자료와 운영 지표로 다시 계산한다.

계산식은 `bootstrap 수 × 실제 bootstrap 행 + unchanged 수 × 4 + 전체 GET 행의 합 + 변경 요청 행의 합`이다. 전체 GET은 unchanged와 중복해서 세지 않는다. 여러 탭·기기·다른 게임은 추가 예산을 사용하며, 쓰기는 D1의 트리거·인덱스 갱신까지 포함한 실제 rows_written으로 확인한다.

### 브라우저 측정

이전 main/새 코드의 동일한 실제 그리기 UI를 로컬 Chromium 4배 CPU 감속에서 비교했다. 매 프레임 하나의 DOM pointermove에 8개의 coalesced 좌표를 담아 180프레임·1,440점·약 3초를 그렸다. 양쪽 기존/새 핸들러 모두 같은 샘플을 소비한다. 폰트·이미지·진입 애니메이션을 마치고 시작 전 초기화 과정의 GC를 수집한다. 획이 시작된 뒤에는 GC나 Long Task 필터링을 하지 않는다.

| 실제 UI 그리기 구간 | 변경 전 | 변경 후 3회 |
| --- | ---: | ---: |
| 50ms 초과 Long Task | 0 | **0 / 0 / 0** |
| `getImageData` | 1 | 0 |
| `putImageData` | 182 | 0 |
| `quadraticCurveTo` | 131,761 | 1,441 |
| 비트맵 스냅숏 | 0 | 1 |
| 640×640 floodFill 계산 중앙값 | 109.5ms | 29.5 / 39.3 / 35.1ms |
| floodFill 계산 최대 | 124.4ms | 43.8ms(15표본 전체 최대) |

채우기는 같은 감속 브라우저에서 실제 `floodFill` 모듈의 계산 구간을 잰 값이며 픽셀 읽기·쓰기와 도구 입력 처리 시간은 포함하지 않는다.

기준 코드에서도 이 입력 방식의 Long Task는 없었으므로 이를 ‘제거했다’고 주장하지 않는다. 새 코드의 작업량 감소와 수용 기준을 각각 확인한 값이다. 브라우저가 보통 합쳐 전달하는 입력 대신 프레임마다 **독립 DOM 이벤트 8개**를 보내는 별도 과부하도 측정했다. 이 조건에서는 기준 최대 107ms, 변경 후 55ms·94ms·0의 긴 작업이 관측됐으며 GPU 합성 지연이 남는다. 이 결과도 버리지 않고 [브라우저 원자료](free-plan-pr4-performance.json)에 보존한다. 모든 기기·임의의 입력률에서 50ms 이하라는 보장은 아니다.

`scripts/measure-catchmind-browser.mjs`로 두 입력 방식을 재현한다. 픽셀·알파·지우개·되돌리기·채우기 흐름과 엄격한 기본 입력 성능 기준은 E2E에서 검사한다. 측정은 로컬 브라우저이며 외부 API를 호출하지 않는다.

PR 4 검증: `npm run check` **13파일/664개**(D1 통합 **284개**, 미리보기 신규 **4개**, 채우기 **7개** 포함) 통과. 전체 Playwright **91개**와 배포 dry-run도 통과했다. [오답 10칸 390px](screenshots/update-pr4-ten-chances-390.png)·[560px](screenshots/update-pr4-ten-chances-560.png), [힌트 390px](screenshots/update-pr4-hint-390.png)·[560px](screenshots/update-pr4-hint-560.png), [다음 출제자 대기 390px](screenshots/update-pr4-next-drawer-wait-390.png)·[560px](screenshots/update-pr4-next-drawer-wait-560.png), [차례 넘기기 390px](screenshots/update-pr4-skip-turn-390.png)·[560px](screenshots/update-pr4-skip-turn-560.png), [그리기 390px](screenshots/update-pr4-drawing-390.png)·[560px](screenshots/update-pr4-drawing-560.png)를 저장하고 확인했다.

## 개선 PR 3 재측정

PR #24 머지 main `6b52972`에서 홈·동점 문구·랭킹 이름 표시만 바꿨다. PR 2와 같은 `tests/integration.test.ts`의 인증 포함 fixture를 다시 실행했다. [PR 3 원자료](free-plan-pr3-measurements.json)의 bootstrap 12개 표본 모두 prepare 수·실행 SQL·binding 호출·rows_read가 기존 값과 정확히 같으며, 정산 없는 rows_written은 0이다. 테스트가 PR 2 원자료를 읽어 각 표본의 비용 증가를 거절한다.

과거 골드/이용권 원장 각각 10,000행 기준(쿼리/rows_read):

| bootstrap 상태 | PR 2 → PR 3, 09:00 KST | PR 2 → PR 3, 18:00 KST |
| --- | --- | --- |
| 캐치마인드 없음·첫 조회/반복 | 15/161 → 15/161 | 15/162 → 15/162 |
| 캐치마인드 공개 | 17/164 → 17/164 | 17/165 → 17/165 |

폴링은 홈·랭킹 30초/나머지 60초, 숨김·뽑기·미리보기 중단으로 동일하다. 일일 예산은 아래 PR 2 표를 유지한다. 로컬 D1 측정이며 운영 관측값은 아니다. 마이그레이션과 새 API 경로는 없다. 상단 사진은 랭킹 행과 같은 기존 버전 URL을 사용한다.

클라이언트 순위 계산은 `6b52972`의 실제 `standings()`와 새 함수를 같은 점수 내림차순·전원 다른 점수 입력으로 비교했다. `weeklyScore` getter로 정렬·행 복사·순위 탐색의 점수 접근 횟수를 세면 4명은 **30→17회**, 1,000명은 **1,003,998→4,997회**이며 반환 순위는 같다. `findIndex` 반복을 없앤 작업량 비교로, CPU 시간이나 운영 렌더 횟수 측정은 아니다. 상세 방법과 값은 PR 3 원자료의 `standingsWork`에 있다. 새 함수는 정렬 O(n log n) 후 순위 배정 O(n)이며 화면에서 메모화해 쓴다.

PR 3 최종 검증: `npm run check` **12파일/646개**(순위 단위 **19개**, D1 통합 **272개** 포함), 전체 Playwright **82개** 통과. [아침 홈 390px](screenshots/update-pr3-morning-home-390.png)·[560px](screenshots/update-pr3-morning-home-560.png), [저녁 홈 390px](screenshots/update-pr3-evening-home-390.png)·[560px](screenshots/update-pr3-evening-home-560.png), [공동 1위 390px](screenshots/update-pr3-joint-first-390.png)·[560px](screenshots/update-pr3-joint-first-560.png), [랭킹 390px](screenshots/update-pr3-ranking-390.png)·[560px](screenshots/update-pr3-ranking-560.png)를 저장하고 확인했다.

## 공식 한도 확인

| 항목 | 무료 한도 | 근거 |
| --- | --- | --- |
| Worker 요청 | 계정당 100,000/일, UTC 자정 초기화 | [Workers limits](https://developers.cloudflare.com/workers/platform/limits/) |
| Worker CPU | HTTP·Cron 모두 10ms/실행 | [Workers limits](https://developers.cloudflare.com/workers/platform/limits/) |
| D1 읽기·쓰기 | 5,000,000 rows_read/일·100,000 rows_written/일 | [D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/) |
| D1 크기 | 계정 합계 5GB, **DB 하나는 500MB** | [D1 limits](https://developers.cloudflare.com/d1/platform/limits/) |
| D1 호출 | Worker 실행당 50회; `batch()`는 문장 수와 별개로 1회 | [D1 limits, 2026-10-30 갱신](https://developers.cloudflare.com/d1/platform/limits/) |
| 정적 파일 | 정적 파일 요청은 무료·무제한, Worker를 호출하면 요청 한도 적용 | [Static Assets billing](https://developers.cloudflare.com/workers/static-assets/billing-and-limitations/) |

확인일은 2026-11-04다. 지시서의 5GB만으로 한 DB의 저장 수명을 계산하면 안 된다. 현재 `run_worker_first`는 `/api`, `/api/*`뿐이다. 문서·폰트·분리한 JS 파일은 정적 자산이지만, 프로필/행운/캐치마인드 이미지의 `/api` 요청은 인증 Worker 요청이다.

## 재현 방법과 측정 경계

`tests/integration.test.ts`의 `free-plan request budgets`가 실제 Worker 번들 안의 D1 binding을 감싼다. `prepare` 횟수, 실행 SQL 문장 수, binding 호출 수, 각 결과의 `meta.rows_read`·`meta.rows_written` 합을 측정한다. 테스트 번들에만 진단 헤더를 넣으며 운영 API에는 진단 헤더·시계 override를 추가하지 않는다. `first()`는 같은 SQL의 `all()` 결과에서 첫 행을 선택해 소실될 metadata를 수집한다. batch의 각 SQL은 문장 수에 포함하고 binding 호출 수에는 batch 한 번으로 센다.

```sh
FREE_PLAN_MEASUREMENTS=/tmp/free-plan-after.json npm test -- tests/integration.test.ts -t 'bounds authenticated polling queries'
node scripts/measure-drawing-cpu.mjs
node scripts/measure-password-cpu.mjs
```

변경 전에는 `c873ae8` 별도 작업 복사본에 **동일한 계측 wrapper와 fixture**만 복사하고, 개선 후 상한 검사는 제거해 측정했다. Node 24.19.0, Miniflare 4.20260730.0, Vitest 3.2.7의 로컬 D1/workerd다. 플레이어 3명·운영자 1명, 오늘 세 게임·예측 6개·현재 주 점수 45행은 고정했다. 과거 골드 원장과 이용권 원장을 각각 100행/10,000행으로 바꿨다. KST 09:00와 18:00를 각각 측정하며, 오후 fixture에는 이미 생성된 당일 추첨을 넣어 정산이 필요 없는 폴링을 비교한다. 인증 조회는 모두 포함한다. catchmind open fixture는 공개 그림 1개, 답변 0개다.

## 요청당 실제 비용

아래 값은 **SQL 문장 수 / rows_read**다. 이 표의 정산 없는 요청은 batch가 없어 문장 수와 binding 호출 수가 같다. 역사 원장은 각각 10,000행이다.

| 요청·상태 | 09:00 변경 전 | 09:00 변경 후 | 18:00 변경 전 | 18:00 변경 후 |
| --- | ---: | ---: | ---: | ---: |
| bootstrap 첫 조회, 캐치마인드 없음 | 32 / 6,848 | 15 / 161 | 35 / 6,850 | 15 / 162 |
| bootstrap 반복, 캐치마인드 없음 | 30 / 6,847 | 15 / 161 | 33 / 6,849 | 15 / 162 |
| bootstrap, 공개 캐치마인드 있음 | 32 / 6,850 | 17 / 164 | 35 / 6,852 | 17 / 165 |
| GET /api/shop | 4 / 13,338 | 3 / 6 | 7 / 13,340 | 3 / 7 |
| GET /api/catchmind, 판 없음 | 3 / 4 | 3 / 4 | 3 / 4 | 3 / 4 |
| GET /api/catchmind, 공개 후 새 답변 없음 | 6 / 7 | 6 / 7 | 6 / 7 | 6 / 7 |

첫 bootstrap은 변경 전 뽑기 지갑 초기화로 rows_written=2였으며, 변경 후 표의 **모든 요청에서 rows_written=0**이다. 미정산 지급·당일 최초 추첨 생성·실제 플레이는 이 읽기 전용 fixture와 별도다. 랭킹은 현재 bootstrap을 사용하므로 같은 비용이며, 별도 랭킹 GET은 PR 8에서 측정한다. 캐치마인드 버전 확인을 1~2쿼리로 줄이는 작업은 PR 4다.

18:00에 원장을 각각 **100→10,000행**으로 늘렸을 때:

| 요청 | 변경 전 rows_read | 변경 후 rows_read |
| --- | ---: | ---: |
| bootstrap 첫 조회, 판 없음 | 248 → 6,850 | 160 → 162 |
| bootstrap, 공개 판 있음 | 250 → 6,852 | 163 → 165 |
| shop | 140 → 13,340 | 7 → 7 |

캐시는 골드·이용권의 전체 합산을 제거한다. 현재 주 점수·월 출석·응답에 필요한 기록은 여전히 읽으므로 데이터 종류에 관계없이 영원히 일정하다는 뜻은 아니다. 회귀 검사는 bootstrap ≤30문장/200행, shop ≤3문장/10행, catchmind idle ≤3문장/10행·open ≤6문장/12행, 원장 증가에 따른 추가 읽기 ≤10행을 고정 fixture에서 검사한다.

## 정산·쓰기 비용

- 예측 정산은 할 일이 없을 때 1 SELECT, 밀린 판이 있을 때 판·규칙 조회 → 해당 예측 조회 → 지급/완료 batch로 **최대 3 binding 호출**이다. 30일치 판 30개를 한 요청에서 모두 정산하고 각 골드·점수 30행을 지급하는 회귀 검사가 있다. 인증 포함 실제 bootstrap 전체는 **17 binding 호출·106 SQL 문장·371 rows_read·361 rows_written**이다. SQL 문장은 50개를 넘지만 HTTP 전체 binding 호출은 50 이하다. 반복 조회는 지급을 만들지 않는다.
- 로또는 추첨이 이미 있고 정산할 표가 없으면 오전·오후 모두 1 SELECT다. 누락 추첨 생성 batch와 모든 해당 표 조회, 지급·알림·정산 batch를 합해 **최대 4 binding 호출**이다. 같은 날짜의 동시 추첨은 저장된 당첨 번호를 사용한다. 과거 정산을 일부만 처리하거나 미지급 잔액을 반환하지 않는다.
- 실제 정산의 rows_read/rows_written와 CPU는 지급할 판·표 수에 비례한다. 장기간 미접속 뒤의 대량 정산은 단순 폴링 예산과 다르며, 아래 일일 표에는 포함하지 않는다. batch로 호출 한도를 낮췄지만 무제한 크기의 batch나 운영 CPU 충족을 보장하지 않는다.
- 골드 또는 이용권 원장 INSERT마다 파생 잔액 INSERT/UPDATE가 한 번 추가된다. D1 쓰기 비용에는 인덱스 갱신도 포함되므로 논리적 지급 수를 rows_written와 동일시하지 않는다. 중복 reference로 무시된 INSERT와 실패 batch는 캐시를 바꾸지 않는다. 기존 동시 구매·재시도·실패 테스트에서도 두 원장 합계와 캐시를 비교한다.
- Cron은 하루 한 번 3개 DELETE를 한 batch로 실행하며 테이블별 최대 500개를 삭제한다. 논리 삭제 최대 1,500행에 인덱스 비용이 더해진다. 남은 만료 기록은 다음 날 처리한다. 살아 있는 제한 버킷·세션, 원장·그림·답변은 보존한다. guess 영수증은 FK 때문에 지우지 않고, 현재/진행 중 판의 영수증도 보존한다.
- 성공 로그인은 자기 버킷/이전 세션만 정리한다. 한도+1에 도달한 버킷은 계속 요청해도 추가 쓰기가 없고 만료 뒤 재시작한다. 두 로그인 버킷 중 하나가 아직 한도에 이르지 않았으면 그 버킷에는 계속 제한 기록을 남긴다.

## 3~4명, 하루 10시간의 폴링 예산

브라우저 탭 하나가 계속 보이고 온라인인 경우다. 시작·화면 진입·저장·탭 복귀·인증·사진 요청은 별도이며, 모두 같은 한도를 사용한다. 정산 없는 가장 큰 fixture 값인 bootstrap 17문장/165행을 사용한 **예상값**이며 4명 DB 자체를 실측한 값은 아니다.

| 화면·요청 | 새 주기 | 3명 요청/일 | 4명 요청/일 | 4명 SQL 문장/일 | 4명 rows_read/일 |
| --- | --- | ---: | ---: | ---: | ---: |
| 홈 또는 랭킹 bootstrap | 30초 | 3,600 | 4,800 | 81,600 | 792,000 |
| 다른 화면 bootstrap | 60초 | 1,800 | 2,400 | 40,800 | 396,000 |
| 캐치마인드 추가 GET, 공개 판 | 5초, 기존 유지 | 21,600 | 28,800 | 172,800 | 201,600 |
| 캐치마인드 화면 합계 | bootstrap + GET | 23,400 | 31,200 | 213,600 | 597,600 |
| 숨긴 탭·미리보기 | 중단 | 0 | 0 | 0 | 0 |
| 뽑기 화면 bootstrap | 중단, 기존 유지 | 0 | 0 | 0 | 0 |
| shop GET | 진입·행동 때만 | 사용량 의존 | 사용량 의존 | 요청당 3 | 요청당 최대 7 |

홈과 캐치마인드의 하루 합계를 중복해 더하지 않는다. 한 탭은 한 화면을 표시한다. 홈 고정은 무료 읽기의 15.84%, 캐치마인드 고정은 11.95%, 후자는 Worker 요청의 31.2%다. 변경 전에는 모든 일반 화면 bootstrap이 30초여서 같은 4명·10시간 홈의 큰 원장 fixture는 32,889,600행/일(한도의 약 6.58배), 캐치마인드는 bootstrap 포함 33,091,200행/일이었다.

현재 주 데이터가 늘어 bootstrap이 테스트 상한인 200행이 되면 홈 예상은 960,000행/일이다. 이 상한은 위 fixture에 대한 회귀 조건이며 실제 트래픽의 절대 보장은 아니다. 별도 기존 통합 측정에서 쿠지 요약은 빈 판 1행/완판 101행이다. 이를 반영해 위 표보다 100행을 더 읽는 경우 홈 예상은 1,272,000행/일(25.44%)이다. 실제 이용은 숨김 중단으로 줄어들 수 있다. 반대로 다중 창·기기·활성 탭, 기록·이미지·쓰기 요청은 늘린다. BroadcastChannel 리더 선출은 이번에 넣지 않았으므로 표시 중인 탭 수만큼 예산을 곱해야 한다. 운영 대시보드에서 다른 Worker/D1 사용량과 합산해 확인한다.

## CPU와 번들

30회 로컬 Node process CPU(user+system) 측정이다. PNG/WebP는 실제 validator에 들어가는 300KiB 경계 fixture이며 base64 검증·디코딩·컨테이너 검사를 모두 포함한다. 실제 이미지 픽셀 디코딩 비용 측정은 아니다.

| 대상 | 변경 전 중앙값 / p95 | 변경 후 중앙값 / p95 |
| --- | ---: | ---: |
| PNG 검증 | 29.227 / 80.466ms | 2.167 / 4.762ms |
| WebP 검증 | 19.554 / 73.858ms | 1.372 / 1.809ms |
| CRC 단독 | 9.467 / 10.181ms | 0.683 / 0.759ms |
| 로그인 KDF 확인, 변경 없음 | 13.600 / 16.439ms | 동일 구현 |
| 비밀번호 확인+교체, 변경 없음 | 27.327 / 31.423ms | 동일 구현 |

CRC 표만으로는 PNG 중앙값 20.517ms였으므로, `atob` 결과를 `Uint8Array.from` callback 대신 직접 복사해 추가 비용을 줄였다. 손상 CRC·잘못된 형식·치수·상한 검사는 유지한다. 비밀번호 강도를 낮추지 않았다. 로컬 비밀번호 CPU가 10ms를 넘으므로 **운영 무료 CPU 한도 충족은 미확인**이다. 운영 observability에서 실제 CPU p95와 exceededCpu 여부를 확인해야 하며, 이 PR은 배포나 실 API 호출로 확인하지 않는다.

main JS는 기존 약 504kB에서 **437.06kB, gzip 140.92kB**로 줄었다. 운영·주식·뽑기·물리 엔진은 별도 chunk다. 서비스 워커는 오프라인 미리보기의 정적 파일을 계속 사전 캐시하므로 이 수치는 초기 평가 대상 감소이며 최초 설치 전체 다운로드 감소를 뜻하지 않는다.

## 저장 공간 전망

캐치마인드는 디코딩된 이미지 최대 300KiB를 base64 TEXT로 저장하므로 한 그림은 최대 약 **400KiB**다. 프로필 최대 260KiB BLOB은 사용자당 한 장이고 교체된다. 행운 사진은 날짜당 최대 440KiB BLOB이다. 원장·정산·답변과 인덱스 공간은 별도로 계속 증가한다. 정리 Cron은 그림을 삭제하지 않는다.

| 최댓값 가정 | 사진 본문 증가량 | 500MB 도달 단순 예상 |
| --- | ---: | ---: |
| 그림 5판/일 + 행운 사진 1장/일 | 약 2.50MB/일 | 약 200일 |
| 그림 10판/일 + 행운 사진 1장/일 | 약 4.55MB/일 | 약 110일 |
| 그림 20판/일 + 행운 사진 1장/일 | 약 8.64MB/일 | 약 58일 |

십진 MB로 계산한 본문만의 상한 시나리오이며 프로필 4장 약 1.06MB, 기존 데이터·페이지·인덱스·신규 주식 데이터 때문에 실제 여유 기간은 짧아진다. 실제 압축된 그림이 작으면 늘어난다. DB 크기 70% 지점부터 증가 속도를 확인하고 후속 저장 방식/보존 정책을 결정해야 한다. 이 PR에서 영구 그림·점수·골드 내역을 임의로 삭제하거나 외부 스토리지로 옮기지 않는다.

## 화면 자료와 후속 범위

- 뽑기 미리보기: [390px](screenshots/update-pr2-preview-claw-390.png), [560px](screenshots/update-pr2-preview-claw-560.png)
- 운영 미리보기: [390px](screenshots/update-pr2-preview-admin-390.png), [560px](screenshots/update-pr2-preview-admin-560.png)

랭킹 이름·동률은 PR 3, 캐치마인드 버전 폴링·그리기 최적화는 PR 4, 뽑기 프레임·CPU 계측은 PR 5에서 진행한다. PR 8의 순위 API와 PR 10~12의 주식 요청을 추가할 때 이 표와 fixture를 갱신한다. 지시서 번호·기본값을 바꾸지 않았으며 실제 코드와 달랐던 마이그레이션 번호, 영수증 FK 보존, 공식 한도 보충은 [결정 기록](decisions.md)에 남겼다.

## PR 2 최종 검증

- `npm run check`: 타입 검사·Vitest **11파일/626개**(D1 통합 **271개**)·프로덕션 빌드 통과.
- `npm run test:e2e`: 전체 **79개 통과**. 새 무료 플랜 화면 흐름 4개 포함. 고정 시계를 사용하는 기존 테스트는 lazy 화면이 표시될 때까지 시계를 진행하고, 계정 전환 시 10초 복귀 유예를 지난 뒤 조회하도록 맞췄다.
- `wrangler deploy --dry-run`: 성공. 실제 배포·원격 마이그레이션·secret 변경은 수행하지 않았다.
- 390px/560px 스크린샷과 로컬 문서 링크, `git diff --check` 확인.
