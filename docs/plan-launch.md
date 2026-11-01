# 예굼방 아케이드 3 — 런칭 준비 (Codex 작업 지시서)

**런칭일: 2026-11-02(월) KST 00:00.** 오늘 밤 안에 끝내야 한다. `docs/plan-v2.md`의 **0장 공통 규칙**(단일 규칙 소스, ledger 원칙, 추가형 마이그레이션, 테스트·보고 형식)을 그대로 따른다. 문서에 없는 결정이 필요하면 추측하지 말고 멈춘 뒤 보고한다.

시간이 촉박하므로 **PR 두 개로 나눈다.** PR A를 먼저 끝내고 보고한 뒤 멈춘다. PM이 머지했다고 알리면 PR B를 시작한다. 첫 커밋에서 이 문서를 `docs/plan-launch.md`로 추가한다.

| PR | 브랜치 | 내용 | 마이그레이션 |
| --- | --- | --- | --- |
| A | `codex/launch-a` | 1. 주식 시장 비활성화 · 3. 런칭 선물 · 4. 기록 초기화 스크립트 · 가끔 실패하는 e2e 2건 정리 | 없음(필요하면 추가형) |
| B | `codex/launch-b` | 2. 닉네임·프로필 사진 · 5. 당첨 소식 알림 · 6. 행운 점수 증거 사진 | `0007_*` |

---

## PR A

### A-1. 주식 시장 비활성화
- 기능과 코드는 지우지 않는다. **진입점만 막는다.**
- 홈, 게임 탭, 그 밖에 주식 시장으로 가는 모든 카드·버튼을 누르면 이동하지 않고 **안내 모달**을 띄운다.
  - 제목: "주식 시장은 준비 중이에요"
  - 본문: "곧 문을 열어요. 조금만 기다려 주세요!"
  - 확인 버튼 하나. 기존 시트·다이얼로그 스타일을 쓰고, 닫기 버튼·바깥 누르기·Esc로 닫힌다.
- 카드에는 "준비 중" 배지를 단다(기존 디자인 토큰).
- `#/stock`, `#/stock/*`로 직접 들어오면 홈으로 돌려보내고 같은 모달을 띄운다(미리보기 포함).
- 켜고 끄는 값은 `shared/balance.ts`의 `FEATURES.stock = false` 하나로 둔다. 나중에 `true`로 바꾸면 원래대로 동작해야 한다.

### A-2. 런칭 기념 선물 (2026-11-02 하루 한정)
- 대상: 활성 플레이어 전원(운영자 제외)
- 조건: **2026-11-02(KST)에 출석 체크를 한 사람**
- 흐름: 그날 출석 "받기"를 누르고 출석 연출이 끝나면 **런칭 선물 모달**이 뜬다.
  - 제목: "예굼방 아케이드 3 오픈 기념 선물"
  - 내용: 데일리 로또 이용권 5장 + 스피또 이용권 5장
  - "수령하기" 버튼을 누르면 즉시 지급하고, 완료 상태(이용권 아이콘 팝, 토스트)를 보여 준다.
- 모달을 닫고 수령하지 않았다면, 그날 홈을 다시 열 때 또는 출석 카드의 "선물 받기" 버튼으로 다시 띄울 수 있어야 한다. 받은 뒤에는 다시 뜨지 않는다.
- 서버 규칙
  - 기간은 `shared/balance.ts`의 `LAUNCH_GIFT = { date: '2026-11-02', lottoTickets: 5, speettoTickets: 5 }`처럼 한 곳에 둔다.
  - 지급 API(`POST /api/events/launch-gift`)는 서버 KST 날짜가 그 날짜이고 오늘 출석 기록이 있을 때만 성공한다.
  - `inventory_ledger`에 reference `event:launch:2026-11-02:<userId>:lotto`, `…:speetto`로 넣는다. 두 행을 한 batch로 넣고, 중복 요청·동시 요청은 한 번만 지급한다.
  - 날짜가 지나면 거절(409)하고 모달도 뜨지 않는다.
- bootstrap에 `launchGift: { available, claimed }`를 넣어 화면이 상태를 안다.
- 테스트: 11-01/11-03 거절, 출석 전 거절, 출석 후 지급, 중복·동시 1회, 운영자 403, 이용권 수량 반영

### A-3. 런칭 전 기록 초기화 스크립트
런칭 직전에 운영자가 한 번 실행한다. **Codex는 운영 DB에 직접 실행하지 않는다.** 스크립트와 실행 문서만 만든다.

- 파일: `scripts/launch-reset.sql`, npm 스크립트 `launch:reset:remote`(실행 전에 "yegoom-db의 기록을 모두 지웁니다. 계속하려면 RESET 입력" 확인을 받는다)
- **남기는 것**: `users`(아이디, 비밀번호, 권한, 활성 여부, 캐릭터, 닉네임, 프로필 사진 포함), `sessions`(로그인 유지), `d1_migrations`, 설정 테이블(`claw_config`)
- **지우는 것(전부)**: `ledger`, `attendance`, `game_rounds`, `predictions`, `inventory_ledger`, `shop_purchases`, `kuji_claims`, `kuji_boards`, `lotto_tickets`, `lotto_draws`, `catchmind_guesses`, `catchmind_requests`, `catchmind_rounds`, `claw_plays`, `claw_coin_purchases`, `claw_accounts`, `login_attempts`. PR B에서 생기는 기록 테이블(당첨 소식, 행운 점수 사진)도 PR B에서 이 스크립트에 추가한다.
- `catchmind_turn`은 행을 지우지 말고 `drawer_id = NULL, round_id = NULL`로 되돌린다.
- `ledger`와 `inventory_ledger`의 수정·삭제 금지 트리거는 **잠깐 지운 뒤 삭제하고, 같은 파일 안에서 원래 정의 그대로 다시 만든다.** 외래 키 순서에 맞춰 자식 테이블부터 지운다.
- 파일 끝에 확인용 SELECT를 둔다: 각 테이블 행 수가 0인지, `users` 수가 그대로인지, 트리거 4개가 다시 있는지.
- 문서 `docs/launch-runbook.md`
  1. 실행 전 백업 지점 기록: `npx wrangler d1 time-travel info yegoom-db` (출력된 bookmark를 메모)
  2. 초기화 실행: `npm run launch:reset:remote`
  3. 문제가 생기면 복구: `npx wrangler d1 time-travel restore yegoom-db --bookmark=<메모한 값>`
  4. 확인 SELECT 결과 보는 법
- 로컬 테스트: 로컬 D1에 모든 테이블 데이터를 넣고 스크립트를 돌린 뒤, 지울 것은 0행이고 남길 것은 그대로이며 트리거가 복구되는지 검사한다. 초기화 뒤 앱이 정상 동작하는지도 확인한다(첫 쿠지판·뽑기 지갑 자동 생성, 출석 1일째).

### A-4. 가끔 실패하는 e2e 2건 (앱 코드는 바꾸지 않음)
- `tests/e2e/app.spec.ts` "a delayed bootstrap cannot restore the previous user after logout": `visibilitychange`를 한 번만 보내서, 진행 중인 변경 요청이 있으면 bootstrap이 오지 않는다. `held`가 true가 될 때까지 `expect.poll` 안에서 다시 보내게 고친다.
- `tests/e2e/claw.spec.ts` "claw preview stays serverless, … auto-drops after ten seconds": 전체 실행 중에만 가끔 실패한다. 시간과 상태 대기를 결정적으로 만든다.
- 두 테스트를 각각 `--repeat-each=5`로 돌리고, 전체 e2e를 2번 연속 돌려 통과를 보고한다.

---

## PR B (PR A 머지 후 시작)

### B-1. 닉네임과 프로필 사진
기존 `iam-yeseo/yegoom`의 `src/lib/util.js`(`normalizeNickname`), `src/routes/profile.js`, `src/routes/avatar.js`, `public/js/photo-picker.js`를 참고한다.

- **닉네임** = 기존 `users.display_name`. 로그인 아이디(`username`)는 바뀌지 않는다.
  - 규칙(원본과 같음): NFC 정규화, 앞뒤 공백 제거, 한글·영문·숫자만, 1~10글자(글자 수는 grapheme 기준)
  - 활성 사용자끼리 대소문자 무시하고 중복 금지(유니크 인덱스, 마이그레이션 전에 기존 값 중복이 없는지 확인)
  - `PUT /api/me/profile { displayName }`
- **프로필 사진**
  - 내 정보 화면에서 사진 선택 → **정사각형 자르기 창**(드래그 이동·핀치/슬라이더 확대, 원본 photo-picker 방식) → 512px 정사각형 WebP(실패 시 JPEG), 260KB 이하로 클라이언트에서 줄인다. 아이폰 사진 회전(EXIF)을 반영한다.
  - 서버: `user_photos(user_id PK, mime, data, updated_at)`, `users.photo_version`. 업로드 `PUT /api/me/photo`(형식·크기·정사각형 검증), 삭제 `DELETE /api/me/photo`.
  - 내려받기: `GET /api/users/:id/photo?v=<version>`, 로그인 필요, `Cache-Control: private, max-age=31536000, immutable`, 버전이 바뀌면 주소가 바뀐다. 폴링 응답에는 사진 본문을 넣지 않는다.
- **전역 반영**
  - 원형 프로필 자리(`Avatar` 컴포넌트를 쓰는 모든 곳: 랭킹, 결과 카드, 참여자 목록, 캐치마인드 답, 홈 상단 등)는 **사진이 있으면 사진, 없으면 지금처럼 캐릭터**를 보여 준다.
  - **캐릭터 자체가 나오는 자리**(홈 방, 예측 게임 히어로, 시상대, 로그인 화면, 내 정보 큰 캐릭터, 캐릭터 선택)는 그대로 캐릭터를 쓴다.
  - 화면에 사람 이름이 나오는 모든 곳은 `username` 대신 **닉네임(displayName)**을 쓴다. 코드 전체를 검색해 빠진 곳이 없게 하고, 남겨 둔 곳(로그인 입력 등)은 보고에 이유를 적는다. 출제자 표시("출제 min" 같은 것)도 닉네임이다.
  - bootstrap의 players와 결과 응답에 `displayName`, `photoVersion`을 넣는다.
- 테스트: 닉네임 규칙·중복·NFC, 사진 형식·크기·정사각형 거절, 버전 증가, 다른 사용자 화면에 반영, 사진 삭제 후 캐릭터로 복귀, 로그인 없이 사진 401

### B-2. 당첨 소식 알림 (앱 안 배너, 푸시 아님)
- 다른 사람이 상점 복권에 당첨되면, 앱을 보고 있는 사람에게 **화면 위쪽 배너**로 알려 준다. 예: "🎉 {닉네임}님이 데일리 로또 2등에 당첨됐어요! +3,000G", "🎉 {닉네임}님이 스피또에 당첨됐어요! +1,500G"
- 대상 사건
  - 스피또 당첨: 구매 순간(서버가 당첨을 정하고 지급하는 같은 batch)
  - 데일리 로또 **1~3등**: 추첨 정산 batch. 4등(2개 일치)은 표 다섯 장 중 한 장꼴로 나와서 알림이 너무 잦아지므로 제외한다.
- 서버: `announcements(id INTEGER PK AUTOINCREMENT, kind, user_id, payload_json, created_at)`, 지급과 같은 batch에서 INSERT하고 reference로 중복을 막는다(같은 표·같은 구매에 한 번).
- 전달: bootstrap(30초 갱신)에 **최근 10분, 최대 5개**를 담는다. 인덱스로 몇 행만 읽어야 한다.
  - 클라이언트는 본 알림 id를 localStorage에 기억하고, **처음 보는 것만** 차례로 띄운다(한 번에 하나, 4초, 눌러서 닫기).
  - **당첨자 본인에게는 띄우지 않는다.**
  - 앱을 처음 켤 때 10분이 지난 소식은 띄우지 않는다.
- 배너는 `role="status"` / `aria-live="polite"`로 읽히게 한다. 동작 줄이기에서는 미끄러짐 없이 페이드만 쓴다.
- 테스트: 지급과 알림의 원자성, 중복 없음, 4등 제외, 본인 제외, 10분 지난 것 제외, 미리보기 모드는 가짜 알림 없음

### B-3. 행운 점수 증거 사진
- 출제자(yeseo)가 매일 행운 점수와 힌트를 등록할 때 **증거 사진 1장을 필수로 첨부**한다. 공개 전까지는 사진을 바꿀 수 있다.
- 사진은 **정답 공개 후에만** 다른 플레이어에게 보인다(증거이므로 공개 전에 보이면 정답이 드러난다). 출제자 본인은 항상 볼 수 있다.
- 클라이언트에서 긴 변 1280px, 440KB 이하 WebP(실패 시 JPEG)로 줄인다(원본 `shrinkPhoto` 방식, EXIF 회전 반영). 자르기는 하지 않는다.
- 서버: `luck_photos(round_date PK, mime, data, version, updated_at)`, 답 저장 API에 사진을 함께 받거나 별도 `PUT /api/games/luck/photo`로 받는다. 내려받기는 B-1과 같은 방식(로그인 필요, 버전 주소, immutable 캐시, 공개 전에는 출제자 외 403)이다.
- 화면
  - 출제자 화면: 사진 선택 칸(미리보기, 다시 고르기), 점수, 힌트, 저장. 사진이 없으면 저장 버튼이 비활성이고 이유를 보여 준다.
  - 공개 후: 결과 영역 위에 "오늘의 증거" 사진 카드, 누르면 크게 보기(닫기·Esc)
  - 최근 3판 기록에도 사진 썸네일(누르면 크게)
- 테스트: 사진 없는 저장 거절, 공개 전 비출제자 403, 공개 후 200, 교체 시 버전 증가, 크기 제한

### B-4. 마이그레이션과 초기화 스크립트
- `migrations/0007_launch_profiles.sql` 하나로 B-1~B-3 테이블·컬럼·인덱스를 추가한다(추가형).
- `scripts/launch-reset.sql`에 `announcements`, `luck_photos`를 지우는 줄을 추가한다(`user_photos`는 계정 정보이므로 남긴다).

---

## 공통 확인
- `npm run check`, `npm run test:e2e`
- 390px·560px 스크린샷
  - PR A: 주식 준비 중 모달, 런칭 선물 모달(수령 전·후)
  - PR B: 내 정보(닉네임 수정, 사진 자르기 창), 랭킹·결과에 사진 반영, 당첨 배너, 행운 점수 출제자 화면(사진 첨부), 공개 후 증거 사진
- 무료 플랜: 새 API의 요청당 D1 `rows_read`를 보고에 적는다. 사진 본문은 폴링 응답에 넣지 않는다.
