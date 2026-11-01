# Phase 6 검증 보고

## 1. 구현 요약과 변경 파일

Phase 5 보완 PR #12의 머지를 확인한 main `aa90e5e`에서 `codex/v3-claw`를 만들고 첫 커밋 `da3b2b4`에 [PM 이식 계획](plan-claw.md)을 원문 그대로 추가했다. 원본 `iam-yeseo/yegoom`은 커밋 `5a8017247c365b7233f4dfb2209a6bf27a30c678`을 읽기만 했다.

| 영역 | 변경 |
| --- | --- |
| 물리 | `shared/claw-physics.ts`, 원본 fixture, 골든 테스트. 계산식·상수·순서를 유지한 타입 이식 |
| 서버 | `worker/claw.ts`, 라우트·bootstrap, `shared/balance.ts`·타입. 개인 기계·무료/구매 코인·보상·원자적 처리·멱등 복구 |
| 화면 | `src/screens/Claw.tsx`, `src/claw/*`, 상태/미리보기 provider, App·홈. 기존 위치 판정 화면과 `BALANCE.claw` 제거 |
| 자산 | 인형 WebP 11장, 재생성 스크립트, [출처와 용량](asset-provenance.md), 정적 PWA 캐시 포함 |
| 검증·문서 | 통합·골든·미리보기·E2E 테스트, 격리 E2E fixture, README·결정 기록·스크린샷 |

사용자별 30개·11종 기계, 10초 조작·수동 정지, 단계별 연출·소리·진동과 실제 서버 물리 결과 재생을 유지했다. 코랄 프레임은 최대 400px이며 캔버스는 600×420 논리 좌표와 표시 크기×DPR(최대 3) 버퍼를 사용한다. 동작 줄이기는 2배속 재생과 흔들림·깜빡임·컨페티 생략이다.

## 2. 마이그레이션과 운영 반영 순서

`0006_claw.sql`에 `claw_config`, `claw_accounts`, `claw_plays`, `claw_coin_purchases`를 추가했다. 기존 `0001`~`0005`는 수정하지 않았다. 설정은 DB 한 행에만 있고 클라이언트에는 판별 실제 집게 힘만 전달한다. 운영자는 데모 조회만 가능하다.

**리뷰 → 운영자가 머지 전에 `npm run db:migrate:remote` 실행 → 머지 → main 배포** 순서다. 새 테이블만 추가해 현재 배포와 호환된다. 이번 작업에서는 운영 DB 변경·머지·배포를 실행하지 않았다.

## 3. 규칙별 테스트와 결과

`npm run check` 통과: 타입 검사, **484개 테스트**, 빌드. Worker·D1 통합 파일은 기존 128개에 30개를 추가해 **158개**다. `npm run test:e2e`도 기존 34개와 새 뽑기 5개, 총 **39개**가 모두 통과했다. 고정된 테스트 시각에서 로그인 횟수가 누적되지 않도록 뽑기 E2E의 요청 IP만 격리했으며 운영 로그인 제한은 변경하지 않았다.

| 규칙 | 검증 |
| --- | --- |
| 무료·구매 코인 | KST 08:59:59/09:00:00, 미사용·미접속분 이월 없음, 무료 우선, 구매 코인 유지, 수량/요청 검증, 구매 멱등·충돌, 잔액 부족, 동시 구매 |
| 플레이 | 입력 범위, 동일 요청 복구와 시뮬레이션 생략, 변경된 요청·낡은 버전 거절, 쿨다운 전/정확한 경계, 코인 0개, 동시 플레이 중 1회만 반영, SQL 슬롯 경계 |
| 확률기 | N번째 강집게, 획득 또는 강집게 후 카운터 초기화, 주입 난수로 약집게 ±10% 경계, 설정 CHECK 범위, API 비공개 |
| 보상·원장 | 실제 물리로 인형 1개·2개, 클리어 보너스·새 세대, 멱등, KST 주차, 차감/지급 실패 시 기록·코인·판까지 롤백 |
| 권한·조회 | 로그인 필수, 운영자 구매/플레이 403, 개인 행만 지연 지급, GET·bootstrap 요약에서 시뮬레이션 생략 |
| 미리보기 | 브라우저 메모리 코인, 공유 경제, 구매·플레이 재시도, 잔액·버전·쿨다운, 반환 데이터 격리, 실제 재생 일치 |
| 브라우저 | 포인터·키보드·Space·10초 자동 하강·수동 멈춤, 실제 성공·2개 배출·실패, 재생 일치, 소리 설정 유지, 동작 줄이기, 미리보기 API 요청 없음, 주기적 조회 없음, 운영자 제한 |
| 응답 유실 | 서버 커밋 후 응답 유실→새로고침→기계 GET 실패에도 같은 POST 요청으로 복구, 코인·보상 1회. 구매 후 bootstrap 실패는 다음 화면 복귀 때 잔액 동기화 |

### 골든 테스트

원본 JS fixture의 Git blob SHA는 `b564c2a993f8dff328ff1c6c63810a1993a98a4c`로 원본과 바이트 단위로 일치한다. **240가지 조합**의 `createBoard` 및 `simulateAttempt` 전체 JSON(모든 재생 프레임 포함)이 완전히 일치했다. 원본 파일 무결성 검사까지 241개 테스트가 통과했다. 조합에는 성공 32회(동시 2개 배출 포함), 놓침 150회, 상승 중 낙하 41회, 이동 중 낙하 17회가 포함된다. 최대 재생 589프레임으로 검증 상한 1,024 이내이며 원본의 360프레임 정착 상한을 유지했다.

### CPU와 D1 읽기

Node에서 무작위 입력 **300회**의 시뮬레이션만 측정했다. 전체 `npm run check` 실행에서 중앙값 **2.387ms**, 상위 1%(p99) **8.877ms**로 실패 기준 40ms 미만이다. 운영 Worker의 CPU 측정값은 아니다.

| 조회 | D1 `meta.rows_read` |
| --- | ---: |
| 이미 생성된 개인 기계의 `GET /api/claw` 처리 | 2 |
| bootstrap의 뽑기 코인 요약 처리 | 1 |

격리 D1에 실제 쿼리를 실행해 합산한 **뽑기 모듈 자체**의 읽기량이다. 세션 인증과 기존 bootstrap의 다른 게임·잔액·순위 쿼리는 제외한다. 다른 플레이어의 오래된 계정은 건드리지 않으며, GET/요약은 과거 기록 전체 SUM을 하지 않는다. 첫 계정/판 생성에는 별도 초기화 읽기·쓰기가 있다.

### 인형 이미지

총 **3,403,205B → 169,940B(95.01% 감소)**, 장당 최대 **21,012B**다. 11장 모두 긴 변 320px, RGB q85 WebP이며 축소한 원본과 디코딩 WebP의 알파 채널이 일치한다. 같은 도구 버전으로 재생성한 11장의 바이트 일치와 PWA precache 포함도 확인했다. 상세 크기는 [자산 출처](asset-provenance.md)에 있다.

## 4. 스크린샷

격리 D1에 원본 엔진으로 생성한 판과 강집게 카운터를 준비하고 실제 API·브라우저 조작으로 촬영했다. 운영 코드에 시드/강제 결과 API를 추가하지 않았다. 두 화면 폭에서 가로 넘침·400px 기계 폭·DPR 버퍼·이미지 표시를 검증했다. 실제 DPR 4 브라우저 컨텍스트에서도 버퍼 배율 3 제한과 인형 11장의 CacheStorage 저장을 확인했다. 기존 Phase PNG 71장은 SHA256이 모두 원본과 같음을 확인해 보존했다. 새 16장은 시각 검토와 PNG 디코딩·크기 검증을 통과했다.

| 실제 로그인 화면 | 390px | 560px |
| --- | --- | --- |
| 대기 | [390px](screenshots/v3-claw-authenticated-idle-390.png) | [560px](screenshots/v3-claw-authenticated-idle-560.png) |
| 조작 중 | [390px](screenshots/v3-claw-authenticated-controls-390.png) | [560px](screenshots/v3-claw-authenticated-controls-560.png) |
| 경품 배출 순간 | [390px](screenshots/v3-claw-authenticated-prize-chute-390.png) | [560px](screenshots/v3-claw-authenticated-prize-chute-560.png) |
| 성공 결과 | [390px](screenshots/v3-claw-authenticated-success-390.png) | [560px](screenshots/v3-claw-authenticated-success-560.png) |
| 실패 결과 | [390px](screenshots/v3-claw-authenticated-failure-390.png) | [560px](screenshots/v3-claw-authenticated-failure-560.png) |
| 코인 구매 | [390px](screenshots/v3-claw-authenticated-coin-purchase-390.png) | [560px](screenshots/v3-claw-authenticated-coin-purchase-560.png) |

| 서버 없는 미리보기 | 390px | 560px |
| --- | --- | --- |
| 대기 | [390px](screenshots/v3-claw-preview-idle-390.png) | [560px](screenshots/v3-claw-preview-idle-560.png) |
| 결과 | [390px](screenshots/v3-claw-preview-result-390.png) | [560px](screenshots/v3-claw-preview-result-560.png) |

## 5. 보류와 판단 사항

구현을 막는 보류 사항은 없다. 원본 결과 장면 그림·운영자 웹 화면·도감·다른 사용자 기계·캐릭터 모션 개선·주식 서버화는 계획대로 범위 밖이다. 미리보기는 실제 서버의 비공개 확률기 설정을 복제하지 않고 현재 판의 힘만 기기에서 샘플링한다. Draft PR에서 리뷰를 기다리며 운영 반영은 위 순서대로 운영자가 진행한다.
