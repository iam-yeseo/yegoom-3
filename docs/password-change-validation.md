# 사용자 비밀번호 변경 검증

기준: `main`의 `3d4fd02`, 브랜치 `codex/password-change`. 로컬 Worker·D1과 실제 Chromium을 사용했으며 운영 DB·계정은 변경하지 않았다.

## 구현과 반영

- `worker/index.ts`: `PUT /api/me/password`, 사용자별 확인 시도 제한, 검증한 해시를 조건으로 변경, 기존 트리거의 세션 폐기 직후 현재 기기용 세션 생성.
- `shared/password.ts`: 새 비밀번호 12~128자, UTF-8 512바이트/필드, JSON 본문 2,048바이트, 15분당 확인 10회. 로그인·CLI와 같은 UTF-16 길이를 사용하고 공백을 보존한다.
- `src/components/PasswordSheet.tsx`, `src/password.css`, Profile/App/API: 플레이어·운영자용 시트, 비밀번호 관리자 자동완성, 보기/숨기기, 입력 검증, 성공 토스트, 미리보기 비활성화.
- `tests/integration.test.ts`, `tests/e2e/password-change.spec.ts`: 아래 회귀 검증. `scripts/measure-password-cpu.mjs`: 암호 연산 측정.
- 마이그레이션 없음. `npm run db:migrate:remote` 실행 불필요. 리뷰 → 머지 → 배포 순서이며 이번 작업은 Draft PR에서 멈춘다.

## 전체 검증

| 명령 | 결과 |
| --- | --- |
| `npm run check` | 571개 통과(Worker·D1 통합 222개 포함), TypeScript·Vite/PWA 빌드 통과 |
| `CHROMIUM_PATH=/usr/bin/chromium npm run test:e2e` | 57개 통과 |
| `wrangler deploy --dry-run` | 원격 배포 없이 Worker·정적 자산 패키징 통과 |
| `git diff --check` | 통과 |

## 추가 통합 테스트

실제 Worker 번들·D1로 19개 모두 통과했다.

| 규칙 | 확인 결과 |
| --- | --- |
| 현재 비밀번호 오류 | 400, 사용자 버킷에 1회 기록, 기존 로그인 유지, 응답에 비밀번호/해시 없음 |
| 15분당 10회 | 10회 확인 허용, 11번째 429, 창 연장 없음, 정확한 만료 경계에서 해제, 다른 사용자 영향 없음 |
| 길이·타입 | 빈 값·11자·129자·null·숫자 400, 12자·한글 128자 허용, 앞뒤 공백 보존 |
| 동일값·입력 상한 | 현재와 같은 새 비밀번호 400, 긴 현재 비밀번호 400, 큰 UTF-8 본문 413, 검증 슬롯 미소비 |
| 플레이어·운영자 성공 | 새 비밀번호 로그인 200, 이전 비밀번호 로그인 401, 시도 버킷 삭제 |
| 세션 교체 | 같은 사용자의 기존 두 세션 401, 새 쿠키 200, 다른 사용자의 세션 200 |
| 동시 변경 | 두 요청 모두 기존 해시 확인을 마친 상태에서 경합해 200/409, 승자 해시·세션만 저장 |
| 권한·Origin | 비활성 사용자 401, Origin 없는 요청 403, 다른 계정의 탭 409 |
| 변경 중 권한 회수 | 해시 생성 중 비활성화·로그아웃 시 409, 새 세션 없음 |
| 저장 실패 | 세션 INSERT 실패 시 비밀번호 해시와 기존 세션 폐기를 함께 롤백 |
| KDF 횟수 | 성공 변경 2회, 로그인/틀린 현재 비밀번호 1회, 차단/잘못된 입력 0회 |

## 추가 브라우저 테스트

실제 로그인과 별도 브라우저 컨텍스트로 4개 모두 통과했다. 비밀번호 변경 전용 Worker·D1(8791)을 사용해 기존 테스트 계정의 비밀번호에 영향을 주지 않는다.

- 390px 일반 모션, 560px reduced motion: 현재·새 비밀번호 자동완성과 숨은 username, 개별 보기/숨기기, 짧은 값·같은 값·확인 불일치의 서버 요청 전 안내, 현재 비밀번호 오류 후 재시도.
- 닫을 때 버튼으로 포커스 복귀, 다시 열면 빈 입력, 성공 토스트 전체 문구 표시. 새 쿠키로 새로고침 후 로그인 유지, 다른 컨텍스트는 새로고침 후 로그인 화면/401.
- 운영자도 같은 시트로 성공하고 새로고침 후 운영자 상태 유지.
- 미리보기 390px·560px: 항목 비활성화와 안내, API 요청 0회.

## CPU 측정

`node scripts/measure-password-cpu.mjs`는 실제 `worker/crypto.ts`를 묶어 Node v24.19.0 WebCrypto로 측정한다. 각 경로 3회 예열 후 30회, `process.cpuUsage()`의 user+system 합계다. 합성 비밀번호만 사용하며 DB/HTTP 비용은 포함하지 않는다.

| 경로 | PBKDF2 | CPU 중앙값 | CPU p95 | 경과 시간 중앙값 | 경과 시간 p95 |
| --- | ---: | ---: | ---: | ---: | ---: |
| 로그인 확인 | 1회 | 26.780ms | 39.684ms | 29.414ms | 42.941ms |
| 비밀번호 변경 확인+생성 | 2회 | 54.218ms | 63.348ms | 55.438ms | 67.971ms |

같은 100,000회 PBKDF2를 확인 1번·생성 1번만 실행한다. 이 측정에서 변경 CPU 중앙값은 로그인 확인의 약 2.02배다. 실제 Worker 번들에도 테스트 전용 계측을 넣어 호출 수를 확인했으며 운영 코드에 계측은 없다. 위 시간은 **로컬 Node 암호 연산 CPU**로, 운영 Cloudflare Workers CPU/과금 측정값은 아니다. 운영 배포를 하지 않아 운영 CPU는 측정하지 않았다.

## 스크린샷

테스트용 계정·데이터이며 비밀번호는 촬영하지 않았다.

| 화면 | 390px | 560px |
| --- | --- | --- |
| 로그인한 사용자의 시트 | [390px](screenshots/password-change-authenticated-390.png) | [560px](screenshots/password-change-authenticated-560.png) |
| 변경 성공 토스트 | [390px](screenshots/password-change-success-390.png) | [560px](screenshots/password-change-success-560.png) |
| 미리보기 안내 | [390px](screenshots/password-change-preview-390.png) | [560px](screenshots/password-change-preview-560.png) |

기능상 보류 사항 없음. 운영 CPU 측정은 배포 후 별도로 확인할 항목이다.
