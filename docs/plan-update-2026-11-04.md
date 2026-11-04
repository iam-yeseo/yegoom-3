# 예굼방 3 — 2026-11-04 개선 지시서 (Codex용)

- 대상 저장소: `iam-yeseo/yegoom-3` (main `bc5ac97` 기준으로 조사)
- 참고 저장소: `iam-yeseo/yegoom` (별명 태그 원본. 필요한 내용은 이 문서 부록에 모두 옮겨 두었으므로 열어 보지 않아도 된다)
- 작성 기준일: 2026-11-04 KST
- 이 문서는 사용자(PM)의 요구사항을 코드 조사 결과와 함께 정리한 것이다. **사용자 요구 원문은 각 절의 "요구" 줄에 그대로 두었다.** "결정" 표시는 원문에 없어 이 문서가 정한 기본값이며, 끝의 [확인 필요 목록](#확인-필요-목록)에 모아 두었다.

---

## 0. 작업 방식

### 0-1. 공통 규칙

1. 기존 규칙(`docs/decisions.md`)을 따른다. 서버가 권위(금액·확률·마감은 Worker에서 판단), 원장(`ledger`, `inventory_ledger`)은 append-only, 요청 재시도는 `requestId`로 멱등, KST 기준.
2. 숫자 규칙은 모두 `shared/balance.ts`에 상수로 둔다. 화면·Worker·미리보기·테스트가 같은 상수를 읽는다.
3. **미리보기(`#/preview`, `src/*-preview.ts`, `src/sample.ts`)도 모든 변경을 함께 반영**한다. 서버 없이 동작해야 한다.
4. 마이그레이션은 추가형으로, 번호는 `0010`부터 이어서 쓴다. 기존 테이블의 CHECK 제약을 바꿔야 하면 테이블 재생성 대신 **새 테이블을 추가**하는 쪽을 우선한다.
5. 각 PR마다 `npm run check`(typecheck + vitest + build)와 관련 Playwright 스펙을 통과시킨다. 바뀐 규칙은 `tests/integration.test.ts`에, 화면 흐름은 `tests/e2e/*.spec.ts`에 테스트를 추가·수정한다.
6. `README.md`의 "현재 동작" 목록과 `docs/decisions.md`에 바뀐 규칙을 기록한다. 화면 증거(390px·560px 스크린샷)는 기존처럼 `docs/screenshots/`에 남긴다.
7. 원격 마이그레이션·머지·배포는 하지 않는다. Draft PR까지 만들고 멈춘다.

### 0-2. PR 나누기와 순서

다음 PR은 이전 PR이 main에 머지된 것을 확인한 뒤 시작한다.

| 순서 | PR | 범위 |
| --- | --- | --- |
| 1 | 공통 표시 정리 | §1-1 님 표기, §1-2 오버레이 스크롤바, §1-3 날짜·시각 표기 |
| 2 | 무료 플랜 대비·최적화 기반 | §1-5, §1-6 (잔액 캐시, bootstrap 쿼리 수, 폴링) |
| 3 | 홈 | §2 전체 + §1-1-1 랭킹 이름표 "님" 제거 (§5-1의 홈 로또 안내는 PR 6에서) |
| 4 | 캐치마인드 | §3-1 규칙 변경·차례 순환·제시어 중복 금지·렉 개선 |
| 5 | 캐릭터 뽑기 | §3-2 폭·렉 |
| 6 | 상점: 로또·스피또 | §5-1 전체 + 홈 로또 결과 안내 |
| 7 | 상점: 슬롯머신 | §5-2 |
| 8 | 랭킹 | §4 전체 |
| 9 | 별명 태그 | §1-4 |

PR 2에서 만드는 잔액 캐시와 쿼리 수 측정 도구를 이후 PR이 그대로 쓴다. 그래서 PR 2를 앞에 둔다.

PR 1은 [iam-yeseo/yegoom-3#22](https://github.com/iam-yeseo/yegoom-3/pull/22)로 머지 완료(2026-11-04). 주식 시스템은 별도 지시서 [`docs/plan-stock.md`](plan-stock.md)에 있으며 PR 10~12로 이어진다.

---

## 1. 전체 공통

### 1-1. 닉네임 뒤에는 항상 "님"

**요구:** 텍스트 중 [닉네임] 다음에 무조건 님 붙여줘. 캐치마인드에서는 '플레이어'이 그림 그리는 중 이라고 나오는데, 한국어로는 어색한 표현임. 차라리 [플레이어]님이 그림 그리는 중인 게 더 나음.

**현재:** 이름 뒤 조사를 받침 확인 없이 붙인다.
- `src/screens/Home.tsx:147` `…의 그리기 차례`, `:157` `${drawer}이 그림 그리는 중`, `:158` `${drawer}의 그림`, `:161` `… 정답`, `:514` `2위 …와 N점 차`, `:516` `1위 …까지`
- `src/screens/Catchmind.tsx:54` alt `…이 그린 그림`, `:164` `…이 그림을 그리고 있어요`, `:24` 답 목록 `이름 · 답`, 결과 화면의 `다음 출제`·`맞힌 사람` 이름
- `src/AnnouncementBanner.tsx:62`에는 이미 `님이`가 붙어 있다. 이것을 기준으로 맞춘다.

**지시:**
1. `src/components/UI.tsx`에 이름 표시 함수 하나를 만든다. 예: `honorific(name: string) => \`${name}님\``. 별명 태그(§1-4)가 붙으면 `[태그] 이름님` 순서다.
2. 화면에 닉네임이 나오는 **모든 곳**에 이 함수를 쓴다. 문장 안, 이름표(랭킹 행·시상대·아바타 옆·갤러리 카드·답 목록·결과 카드), `alt`, `aria-label`, 토스트, 배너가 모두 대상이다. 홈 상단 내 이름(§2-1)도 포함한다.
   - 예외: 닉네임 **입력칸의 값**, 로그인 아이디, 운영 탭의 원본 값 표(감사 기록의 before/after JSON)는 그대로 둔다.
   - "나", "내가 맞힘"처럼 이름 대신 쓰는 말은 그대로 둔다.
3. "님"은 받침이 있는 글자이므로 뒤에 붙는 조사를 **받침 있는 형태로 고정**한다: `님이`, `님과`, `님의`, `님을`, `님은`, `님까지`, `님에게`. 이/가, 와/과를 고르는 코드가 있으면 지운다.
4. Worker가 만드는 사용자 노출 문구에 닉네임이 들어가면 같은 규칙을 따른다(현재는 없음. 새로 추가하는 슬롯머신·별명 기능에서 지킬 것).
5. 문구 예:
   - `예서님이 그림을 그리고 있어요`, `예서님이 그림 그리는 중`, `예서님의 그리기 차례`, `예서님의 그림 · 오답 3회`
   - `민님 정답 · 다음 출제 시원님`
   - `2위 시원님과 12점 차`, `1위 민님까지 8점`

### 1-1-1. 변경 (2026-11-04, PR 1 머지 뒤): 랭킹 표시에서는 "님"을 뺀다

**요구:** 랭킹에서는 '님' 빼도 됨!! 전체 글로벌하게 랭킹 쪽 표시할 땐 '님' 빼고 닉네임만 표기할 것.

**지시(PR 3에서 처리):**
1. **순위표 형태로 이름이 나오는 곳**은 `honorific()` 없이 닉네임만 쓴다. `honorific`와 짝이 되는 `plainName()`(또는 `PersonName`의 `honorific={false}` 옵션)을 만들어 쓴다. 별명 태그(§1-4)는 랭킹에서도 그대로 붙인다(`[태그] 닉네임`).
   - 홈 "이번 주 랭킹" 미리보기 카드(`src/screens/Home.tsx`의 `.ranking-preview-row`)
   - 랭킹 화면 전체(`src/screens/Ranking.tsx`): 시상대 이름, 요일별 점수 카드 머리의 내 이름, 지난주 목록, PR 8에서 추가하는 전체 순위 카드와 점수 획득 기록 행
   - 주식 화면의 수익 순위처럼 나중에 생기는 순위 목록도 같은 규칙
2. **문장 속 이름은 그대로 "님"을 붙인다.** 홈 점수 아래 순위 문구(`2위 시원님과 12점 차`, `시원님과 공동 1등`, §2-3)는 문장이므로 유지한다. 랭킹 화면 안이라도 문장(예: 안내·토스트)은 "님"을 붙인다.
3. 랭킹 쪽 e2e 단언(`tests/e2e/common-display.spec.ts` 등)을 새 규칙으로 고친다.

**수용 기준:** `rg "displayNameOf\([^)]*\)\}?(이|가|와|과|의|까지)"` 결과가 0건. 문구가 들어가는 e2e 단언(`tests/e2e/*.spec.ts`)을 새 문구로 고친다.

### 1-2. 하단 오버레이가 뜰 때 스크롤바가 잠깐 보이는 문제

**요구:** 하단에서 오버레이 뜰 때, 스크롤바가 잠깐 나타났다 사라지는 현상이 생기는데 이 현상이 생기지 않도록 조치할 것.

**원인(조사):** 하단 시트는 `<dialog>`에 `overflow-y: auto`를 주고(`src/screens.css:23-25` `.color-picker-dialog`, `src/password.css:5` `.password-dialog` 등), 열 때 **안쪽 첫 자식**을 `translate: 0 100%`에서 올린다(`src/components/ColorPicker.tsx:48`). 애니메이션 동안 자식이 dialog 박스 밖으로 넘쳐서 dialog에 세로 스크롤바가 생겼다가 사라진다. 또 열 때 `document.body.style.overflow = "hidden"`으로 바꾸므로, 데스크톱에서는 페이지 스크롤바가 사라지며 화면이 옆으로 밀릴 수 있다.

**지시:**
1. 시트를 여는 공통 함수(예: `src/motion.ts`의 `openSheet(dialog)`)를 만들고 모든 하단 시트·모달이 이것을 쓰게 한다. 대상: `ColorPicker`, `PasswordSheet`, `PhotoPicker`, `LuckEvidence`, `launch-gift`, `Kuji` 결과/상세 시트, `Claw` 결과, 캐치마인드 확인창·갤러리 모달, `Stock`의 거래 시트, 이번에 추가하는 슬롯머신·별명 결과창.
2. 공통 함수의 동작:
   - 이동 애니메이션은 **dialog 요소 자체**에 준다(안쪽 자식 X). 또는 열리는 동안만 dialog에 `overflow: hidden` 클래스(`.is-entering`)를 주고, 애니메이션 `finished` 후에 떼어 원래 `overflow-y: auto`로 돌린다.
   - 시트 안 스크롤 영역에는 `overscroll-behavior: contain`을 준다.
3. 페이지 스크롤 잠금 때문에 레이아웃이 밀리지 않도록 `html { scrollbar-gutter: stable; }`을 넣거나, 잠글 때 사라지는 스크롤바 너비만큼 `padding-right`를 보정한다. 모바일(오버레이 스크롤바)에서 차이가 없어야 한다.
4. 토스트·당첨 배너·`fxLayer`(색종이·코인)가 화면 밖에서 들어올 때도 문서에 가로·세로 넘침이 생기지 않는지 확인한다. 필요하면 해당 레이어를 `position: fixed; inset: 0; overflow: clip; pointer-events: none;`으로 둔다.

**수용 기준:** Playwright로 Chromium 데스크톱(스크롤바 보이는 환경)에서 각 시트를 열고, 애니메이션 동안 `dialog.scrollHeight <= dialog.clientHeight`이며 `document.documentElement.clientWidth`가 변하지 않음을 검사하는 테스트 1개 이상.

### 1-3. 날짜·시각 표기

**요구:** 날짜 표기 방법 변경 : yyyy-mm-dd -> yyyy년 mm월 dd일 , 시간도 동일하게.

**지시:**
1. `src/format.ts`(신규)에 표시 함수를 모은다. 모두 KST 기준이며 월·일·시·분·초는 **두 자리로 채운다**.
   - `formatDate("2026-11-04" | ISO)` → `2026년 11월 04일`
   - `formatTime("17:30" | "17:30:00" | ISO)` → `17시 30분`
   - `formatTimeSeconds("09:12:36")` → `09시 12분 36초` (초까지 의미가 있는 기상·퇴근 정답·예측값 표시용)
   - `formatDateTime(ISO)` → `2026년 11월 04일 17시 30분`
2. 화면에 `yyyy-mm-dd`, `HH:MM`, `HH:MM:SS` 형태로 나오는 날짜·시각을 모두 바꾼다. 조사로 찾은 곳:
   - `src/components/PredictionGame.tsx:292` 지난 기록 제목 `round.roundDate`, `:293` 증거 사진 라벨, `:450` `roundDate · deadline 마감`, 정답·예측값·마감 표시
   - `src/screens/Home.tsx` 게임 행의 마감 `right: game.rules.deadline`, 공개 시각, 예측값(`내 예측 09:12:36`), 뽑기 코인 충전 시각(`:228`), 로또 카드 `17:00 추첨`(`:275`)
   - `src/screens/Shop.tsx:91` 표 날짜, `:160` 추첨 시각, `:181` 당첨 번호 날짜, `:186` 규칙 설명, `lotto-target` 문구
   - `src/screens/Catchmind.tsx:51` 공개 시각, `src/screens/CatchmindGallery.tsx:8` 종료 시각, `src/screens/Profile.tsx` 내역 시각, `src/screens/Admin.tsx:23,217` 날짜·시각
   - `rg "\d{2}:\d{2}"`, `rg "roundDate|drawDate|createdAt|\.date\b"`로 남은 곳을 다시 찾는다.
3. 바꾸지 않는 것:
   - 입력칸(`<input type="time">`, 예측 입력값 `HH:MM:SS`)과 서버로 보내는 값
   - 남은 시간 카운트다운(`00:12:34` 같은 **기간**)
   - 연도가 없는 짧은 표기(`11월 4일 수요일`, `11월 1주차`)는 이번 범위가 아니므로 그대로 둔다.

### 1-4. 별명 태그 시스템 다시 추가

**요구:** 기존 yegoom 레포지토리 보면 '별명 시스템' 이 있을 거야. 그거 여기서도 다시 추가할 것.

**원본(yegoom) 요약:** 이름 앞에 붙는 작은 태그. 등급 S 5% · A 20% · B 30% · C 45%. 먼저 등급을 정하고, 그 등급이 쓸 수 있는 문구 중 하나를 같은 확률로 고른다. 문구 묶음: **S는 S 문구만, A는 S를 뺀 전부(A+B+C), B는 B+C, C는 C 문구만.** 등급은 모양을 정한다(S 홀로그램 · A 금빛 · B 은빛 · C 테두리). 모은 태그 중 하나만 달 수 있고, 단 태그는 앱 어디서든 이름 앞에 보인다. 원본에서는 상점의 "별명 태그 뽑기권"(하루 5장)을 보관했다가 쓰면 뽑혔다. 문구 원본 전체는 [부록 A](#부록-a-별명-태그-문구-원본)에 있다.

**결정(이식 방식):** yegoom-3에는 이 뽑기권을 주는 쿠지 보상이 없으므로 **"구매 = 즉시 1개 뽑기"**로 단순화한다. 가격은 **골드 300G, 하루 5회**로 한다(원본은 30점·하루 5장). 값은 `shared/balance.ts`의 `NICKNAME_TAG_RULES = { price: 300, dailyLimit: 5, grades: [...] }`에 둔다.

**DB (`migrations/0010_nickname_tags.sql`):**
```sql
CREATE TABLE nickname_tags (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  request_id TEXT NOT NULL,
  grade TEXT NOT NULL CHECK (grade IN ('S','A','B','C')),
  text TEXT NOT NULL,
  equipped INTEGER NOT NULL DEFAULT 0 CHECK (equipped IN (0,1)),
  date TEXT NOT NULL,            -- KST 구매일(하루 한도 계산)
  created_at TEXT NOT NULL,
  UNIQUE (user_id, request_id)
);
CREATE INDEX nickname_tags_user_idx ON nickname_tags(user_id, date);
CREATE UNIQUE INDEX nickname_tags_equipped_idx ON nickname_tags(user_id) WHERE equipped = 1;
```

**Worker (`worker/nickname-tags.ts` 신규):**
- `GET /api/me/nickname-tags` → `{ tags: [{id, grade, text, equipped, createdAt}], equipped, drawsToday, dailyLimit, price }`. 정렬: 단 태그 먼저, 그다음 S→C, 최신순.
- `POST /api/shop/nickname-tag` `{ requestId }` → 플레이어만. 같은 `requestId` 재요청은 처음 뽑힌 태그를 그대로 돌려준다. 하루 한도·잔액 검사, 골드 차감(`ledger` 사유 `별명 태그 뽑기`), 태그 생성을 **한 `db.batch`** 안에서 조건부 INSERT로 처리한다(상점 기존 패턴과 같음). 등급·문구는 `worker/shop.ts`의 `randomInt`로 Worker에서 정한다.
- `PUT /api/me/nickname-tag` `{ tagId: string | null }` → 내 태그 하나 달기, `null`이면 떼기. 한 batch에서 기존 착용 해제 후 새 태그 착용.
- 운영자는 구매·착용 불가(403).

**표시:**
- bootstrap의 `players[]`와 `user`에 `tag: { grade, text } | null`을 더한다(착용 태그를 `LEFT JOIN nickname_tags ... equipped = 1`로 같은 쿼리에서 읽는다. 쿼리 수를 늘리지 않는다).
- `ProfileDirectoryProvider`의 프로필 항목에 `tag`를 넣고, `src/components/UI.tsx`에 `<PersonName username|userId />`(태그 + 이름 + 님)를 만든다. §1-1의 이름 표시를 모두 이 컴포넌트/함수로 바꾸면 별명도 자동으로 붙는다. 캐치마인드·갤러리·결과처럼 서버가 내려준 `CatchmindPlayer`를 쓰는 곳도 `id`로 디렉터리에서 태그를 찾는다.
- 글자만 쓸 수 있는 곳(토스트, 배너, `alt`)은 `"[태그] 이름님"` 글자로 만든다.
- 스타일은 원본을 옮긴다(부록 A-2). S등급 홀로그램 이미지는 없으므로 CSS 그라데이션과 흐르는 애니메이션만 쓴다. `prefers-reduced-motion`이면 멈춘다.
- 좁은 자리에서는 태그가 먼저 말줄임되고 이름은 끝까지 보여야 한다.

**화면:**
- 상점(`ShopMain`)에 "별명 태그 뽑기" 카드. 누르면 확인 → 결과 시트(등급 라벨 `S등급 · 홀로그램` 등, 태그 미리보기, "지금 달기" 버튼). 남은 횟수 `오늘 3/5회`.
- 내 정보(`src/screens/Profile.tsx`)에 "내 별명 태그" 칸: 모은 태그 목록(누르면 달기), "별명 떼기" 버튼, 비어 있으면 상점으로 가는 안내.
- 미리보기: `src/shop-preview.ts`에 같은 규칙을 넣고 기기 안에서만 동작.

**테스트:** 확률 분포(난수 주입), 문구 묶음 규칙, 하루 한도, 잔액 부족, 같은 requestId 재요청, 동시 요청 중복 차감 없음, 착용 1개 유일성, 운영자 거절.

### 1-5. 코드 전체 점검·최적화

**요구:** 전체적으로 코드 체크 해보고, 최적화 가능한 부분 있으면 최대한 최적화를 해줘.

조사에서 찾은 항목이다. 동작은 바꾸지 말고 비용만 줄인다. 각 항목 전후의 측정값(아래 §1-6의 쿼리 수, React Profiler 렌더 횟수 등)을 PR 본문에 남긴다.

1. **잔액 합계가 원장 전체를 매번 읽음.** `publicUser`(`worker/index.ts:84`)와 `readShopState`(`worker/shop.ts:74`)는 사용자의 골드 원장 **전체 행**을 `SUM`한다. `readInventory`(`worker/shop.ts:66`)도 같다. 원장은 계속 늘어나므로 읽는 행 수도 계속 늘어난다.
   → `migrations/0011_balances.sql`에 `user_balances(user_id PK, gold INTEGER NOT NULL DEFAULT 0, lotto_tickets, speetto_tickets)`를 만들고, `ledger`·`inventory_ledger`의 `AFTER INSERT` 트리거로 갱신한다(`INSERT ... ON CONFLICT(user_id) DO UPDATE SET gold = gold + excluded.gold`). `INSERT OR IGNORE`로 무시된 행에는 트리거가 돌지 않으므로 멱등성이 유지된다. 마이그레이션 안에서 기존 합계로 채운다. 읽기는 이 표 한 행으로 바꾼다. 잔액 부족을 검사하는 조건부 INSERT도 이 표를 읽게 바꾼다. 원장 합계와 캐시가 항상 같은지 integration 테스트로 검증한다.
2. **bootstrap 쿼리 수.** `bootstrap`(`worker/index.ts:162`)은 정산 2종 + 12개 병렬 조회이고, `readGame`이 게임마다 6~7개 쿼리를 따로 보낸다. 측정해서 줄인다(§1-6-2). 예: 세 게임의 라운드·내 예측·참여자를 게임별이 아니라 한 번에 `WHERE game_id IN (...)`로 읽기, 출제자 이름은 `players` 결과에서 찾기, 같은 사용자의 `EXISTS (SELECT 1 FROM user_photos ...)` 반복 제거.
3. **정산 확인을 요청마다 수행.** `settlePublishedRounds`·`settleDueLotto`가 bootstrap·게임 조회·상점 조회마다 돈다. 정산할 것이 없을 때 쿼리 1개로 끝나는지 확인하고, 아니면 "정산할 것이 있는지"만 먼저 보는 가벼운 쿼리로 바꾼다. Cron Trigger(무료 플랜에서 사용 가능)로 17:30·18:00 KST 직후 정산을 미리 돌리는 것도 검토한다(요청 시 정산은 안전망으로 남긴다).
4. **캐치마인드 폴링이 무거움**(§3-1-4). 5초마다 판 전체·답 목록·사람 정보·지난 판을 다시 읽는다.
5. **뽑기 화면이 100ms마다 React 렌더**(§3-2-2).
6. **그리기 캔버스가 움직일 때마다 전체 이미지를 다시 씀**(§3-1-4).
7. 자라기만 하는 표 정리: `catchmind_requests`, 만료된 `sessions`, `login_attempts`. 하루 한 번 Cron에서 오래된 행(예: 30일 지난 `catchmind_requests`, 만료 세션)을 지운다. 원장 표는 지우지 않는다.
8. 클라이언트 번들: `vite build` 결과에서 큰 덩어리를 확인하고, 주식(`Stock.tsx`, 기능 꺼짐)·운영 탭·뽑기 물리 엔진은 `React.lazy`로 나눈다.
9. 홈·랭킹의 `standings()`가 렌더마다 정렬하고 `findIndex`로 순위를 구한다(O(n²)). 작지만 §2-3에서 동점 처리를 새로 짜면서 한 번만 계산하도록 정리한다.

### 1-6. Cloudflare 무료 플랜 한도 대비

**요구:** Cloudflare 무료 플랜 사용중이라 한도 초과 되지 않도록 필요한 부분 있으면 선제적 조치할 것.

**기준 한도(작업 전 Cloudflare 문서에서 현재 값을 다시 확인할 것):** Workers 무료 — 하루 요청 100,000건, 요청당 CPU 10ms. D1 무료 — 하루 읽은 행 5,000,000, 쓴 행 100,000, 저장 5GB, **Worker 호출 한 번당 쿼리 50개**. 정적 자산은 `run_worker_first`가 `/api`만이므로 Worker 요청에 세지 않는다.

**지시:**
1. **현재 사용량 추정표를 만든다.** 플레이어 수(현재 3~4명), 하루 접속 시간(예: 10시간)을 가정하고, 화면별 폴링 주기 × 요청당 D1 쿼리 수 × 읽은 행 수를 표로 `docs/free-plan-budget.md`에 정리한다. 이후 PR마다 갱신한다.
2. **요청당 쿼리 수 측정.** integration 테스트에 D1 래퍼를 넣어 요청마다 `prepare` 횟수와 `meta.rows_read` 합을 센다. bootstrap, 캐치마인드 조회, 상점 조회, 랭킹 조회에 상한을 단언한다(예: bootstrap ≤ 30쿼리, 캐치마인드 "변경 없음" 응답 ≤ 2쿼리). 이후 기능 추가로 상한을 넘으면 테스트가 실패하게 한다.
3. **폴링 줄이기.**
   - 앱 전역 bootstrap 폴링(`src/App.tsx:385-400`, 30초): 화면이 보일 때만(현행 유지) + 홈·랭킹 화면에서만 30초, 그 밖의 화면에서는 60초 이상. 사용자가 탭으로 돌아왔을 때 마지막 조회 후 10초가 안 지났으면 다시 읽지 않는다.
   - 캐치마인드는 버전 확인 방식(§3-1-4).
   - 여러 탭이 동시에 열려 있으면 `BroadcastChannel`로 한 탭만 폴링하고 결과를 나눠 쓰는 것을 검토한다.
4. 쓰기 줄이기: 폴링·조회 요청에서 쓰기가 일어나지 않게 한다(정산할 것이 있을 때만 씀). 로그인 시도 표 등 불필요한 쓰기가 없는지 확인한다.
5. CPU 10ms: 비밀번호 해시(`scripts/measure-password-cpu.mjs`가 있음)와 캐치마인드 이미지 검증(`validateDrawing`의 CRC 계산)이 한도 안인지 측정해 기록한다. 이미지 검증이 넘으면 CRC 표를 미리 만들어 두는 방식(테이블 기반 CRC32)으로 바꾼다.
6. 저장 용량: 캐치마인드 그림(판당 최대 300KB base64), 프로필·행운 사진이 D1에 들어간다. 현재 판 수 기준 증가 속도를 추정표에 적는다.

---

## 2. 홈 화면

### 2-1. 상단 "예굼방" → 내 닉네임 + 프로필 사진

**요구:** 화면 상단에 예굼방이라고 텍스트 표기된 부분(room-name), 플레이어 닉네임으로 변경해주고, 옆에는 프로필 사진도 함께 표시해줘

**현재:** `src/screens/Home.tsx:441` `<span className="room-name">예굼방</span>`.

**지시:** `room-name` 자리를 `[작은 원형 아바타 28~32px] [별명 태그] 닉네임님`으로 바꾼다. 아바타는 기존 `Avatar`(사진이 없으면 선택 캐릭터)를 쓴다. 긴 닉네임은 말줄임하고 오른쪽 골드 표시와 겹치지 않게 한다. 저녁 테마에서도 글자 대비를 확인한다. 미리보기에서도 동일.

### 2-2. 점수 영역의 이름 제목 → "이번 주 점수"

**요구:** home-score-row 안에 h1으로 플레이어 이름 들어가있는 거 빼주고, '이번 주 점수' 로 수정

**현재:** `src/screens/Home.tsx:523` `<h1>{displayNameOf(...)}</h1>`.

**지시:** 제목 글자를 `이번 주 점수`로 바꾼다. 페이지의 h1이 하나는 있어야 하므로 이 제목을 h1로 유지하되, 상단 닉네임(§2-1)은 h1이 아니게 둔다. 점수 숫자·`주간 N위` 칩은 그대로.

### 2-3. 순위·점수차 문구의 동점 처리

**요구:** card attendance-card collapsed : 순위랑 점수차 나타내주는 이 부분, 동점일 경우에는 다르게 표시해야 함. 공동 1등일 경우, [플레이어]님과 공동 1등 이라고 표기해야 함.

**대상:** 출석 카드(접힌 상태) 바로 위에 보이는 `.home-score`의 `.rank-line` 버튼과 `.rank-chip`(`src/screens/Home.tsx:510-536`). 지금은 내가 1위이고 2위가 같은 점수여도 `2위 OO와 0점 차`로 나온다.

**지시:** `standings()`가 같은 점수를 같은 순위로 묶는 것은 유지하고, 문구를 아래 규칙으로 만든다. 이름은 §1-1 규칙(`님`).

| 상황 | `.rank-line` 문구 | `.rank-chip` |
| --- | --- | --- |
| 혼자 1위, 2위 1명 | `2위 시원님과 12점 차` | `주간 1위` |
| 혼자 1위, 2위 여러 명 동점 | `2위 시원님 외 1명과 12점 차` | `주간 1위` |
| 혼자 1위, 다른 플레이어 없음 | `이번 주 1위` | `주간 1위` |
| 공동 1위(나 포함 2명) | `시원님과 공동 1등` | `주간 공동 1위` |
| 공동 1위(나 포함 3명 이상) | `시원님, 민님과 공동 1등` (3명 넘으면 `시원님 외 2명과 공동 1등`) | `주간 공동 1위` |
| 모두 0점 | `아직 이번 주 점수가 없어요` | 칩 숨김 |
| 2위 이하, 단독 | `1위 민님까지 8점` | `주간 2위` |
| 2위 이하, 동점 | `시원님과 공동 2등 · 1위 민님까지 8점` | `주간 공동 2위` |
| 1위가 여러 명이고 나는 그 아래 | `1위 민님 외 1명까지 8점` | `주간 3위` |

같은 규칙을 함수 하나(`rankSummary(table, me)`)로 만들고 단위 테스트를 붙인다. 랭킹 화면(§4)의 시상대·목록도 같은 순위 계산을 쓴다.

---

## 3. 게임

### 3-1. 캐치마인드

**요구:**
- 캐치마인드 렉이 좀 걸리던데 최적화 부탁
- 캐치마인드 기회 변경 : 5번째 오답시 힌트 나오고, 10번째 오답 나오면 즉시 게임 종료(점수 없음)
- 그리고 맞힌 사람이 문제 내는 게 아닌, 플레이어별로 1번씩 돌아가면서 문제 내는 방식으로 변경.
- 한 번 나온 제시어는 다시 나오지 않아야 함.

#### 3-1-1. 오답 기회

- `shared/balance.ts:36` `CATCHMIND_RULES.hintAfter: 3 → 5`, `endAfter: 6 → 10`.
- 서버(`worker/catchmind.ts:178` 힌트, `:271-277` 종료 조건)는 상수를 읽으므로 값만 바뀐다. 10번째 오답이면 `status='ended'`, `end_reason='misses'`, 정답자·보상 없음(현행 유지).
- 화면 `FailCount`(`src/screens/Catchmind.tsx:27-43`): 칸이 10개가 되므로 390px에서 한 줄에 들어가는지 확인하고, 안 들어가면 5칸씩 두 줄(첫 줄 끝 = 힌트, 둘째 줄 끝 = 끝)로 배치한다. 문구 `힌트까지 N번`, `종료까지 N번`은 그대로.
- 배포 시 진행 중인 판은 새 기준을 그대로 따른다(이미 오답 3~5개인 판은 힌트가 사라질 수 있음). 이것을 decisions에 적는다.
- 도움말·README·미리보기(`src/catchmind-preview.ts:196-200`, `src/sample.ts:13`)도 새 값.

#### 3-1-2. 출제 차례: 플레이어 순서대로 한 번씩

**현재:** 첫 출제자는 "그리기 맡기"로 정하고, 이후 **정답자가 다음 출제자**가 된다(`worker/catchmind.ts` guess 처리의 `UPDATE catchmind_turn SET drawer_id = COALESCE(winner_id, drawer_id)`). 아무도 못 맞히거나 출제자가 끝내면 같은 사람이 다시 낸다.

**새 규칙:**
1. 출제 순서 = **활성 플레이어(`role='player' AND active=1`)를 `username` 오름차순**으로 돈다. 운영자는 빠진다. 판이 어떻게 끝나든(정답·10오답·수동 종료) 다음 출제자는 **이번 출제자의 다음 사람**이다. 마지막 사람 다음은 처음으로 돈다.
2. 다음 출제자 계산은 판을 끝내는 같은 SQL 문 안에서 한다(별도 조회 후 쓰기 X, 경합 방지):
   ```sql
   COALESCE(
     (SELECT id FROM users WHERE role='player' AND active=1
        AND username > (SELECT username FROM users WHERE id = :drawer) ORDER BY username LIMIT 1),
     (SELECT id FROM users WHERE role='player' AND active=1 ORDER BY username LIMIT 1))
   ```
   정답(guess) 처리와 수동 종료(end) 처리 둘 다 `catchmind_turn.drawer_id`를 이 값으로 바꾼다. 10번째 오답으로 끝날 때도 같다.
3. 판이 끝나면 다음 출제자만 "다음 그림 그리기"(`next`)를 누를 수 있다(현행 `canNext` 유지). 다른 사람에게는 `다음 출제: 시원님` / `시원님의 차례를 기다리고 있어요`.
4. **결정(멈춤 방지):** 다음 출제자가 판이 끝난 뒤 10분 동안 시작하지 않으면, 다른 플레이어에게 "차례 넘기기" 버튼을 보이고 누르면 그다음 사람으로 넘긴다(`skip` 동작, `requestId` 멱등, 판 종료 시각 기준 서버에서 10분 검사). 값은 `CATCHMIND_RULES.skipAfterMs`.
5. 처음(판이 하나도 없을 때)의 "그리기 맡기"는 유지한다. 이후로는 순서대로 돈다.
6. 비활성화된 사람이 차례였다면 다음 사람으로 넘어가야 한다. `board()`를 읽을 때 `turn.drawer_id`가 비활성 사용자면 위 계산으로 바로잡는 쓰기를 한다(그 경우에만 쓰기).
7. 화면 문구 수정:
   - 결과 화면 보상 없는 종료 `출제자가 다음 그림을 그려요` → `다음은 시원님이 그려요`.
   - 수동 종료 확인창 `다음 그리기 차례는 나에게 남아요` → `다음 그리기 차례는 시원님에게 넘어가요`.
   - 홈 캐치마인드 행(`src/screens/Home.tsx:144-164`): `정답 「사과」 · 민님 정답 · 다음 출제 시원님`.
8. 미리보기 엔진(`src/catchmind-preview.ts`)에도 같은 순환을 넣는다.

#### 3-1-3. 제시어 중복 금지

**현재:** 새 판의 제시어는 `chooseWord([])`(`worker/catchmind.ts:249`)로 **전체 400개에서** 고르므로 예전에 나온 단어가 다시 나온다. 바꾸기(reroll)는 그 판 안에서만 중복을 피한다.

**지시:**
1. `migrations/0012_catchmind_used_words.sql`: `catchmind_used_words(word TEXT PRIMARY KEY, round_id TEXT NOT NULL, used_at TEXT NOT NULL)`. 기존 모든 판의 `word_history`(JSON 배열)를 `json_each`로 풀어 채운다.
2. "한 번 나온 제시어" = 출제자에게 **한 번이라도 보여 준 단어**(바꾸기 전 단어 포함)로 정의한다. 새 판 생성(`claim`·`next`)과 바꾸기(`reroll`)에서 단어를 고를 때 이 표에 없는 단어만 고르고, 같은 batch에서 `INSERT INTO catchmind_used_words`를 한다. 이미 있는 단어면 batch 전체가 실패하도록 `INSERT`(OR IGNORE 아님)를 쓰고, 실패하면 다시 고르는 재시도를 1~2회 한다.
3. 400개를 모두 쓰면: 표를 비우고 처음부터 다시 쓴다(가장 오래 전에 쓴 단어부터 다시 쓰는 것과 같음). 이때 `docs/decisions.md`에 기록하고, 남은 단어가 30개 이하가 되면 운영 탭에 "남은 제시어 N개" 경고를 보여 준다(단어 목록은 `shared/catchmind-words.ts`).
4. 테스트: 400번 판을 만들어도 중복이 없음, 바꾸기 단어도 다시 나오지 않음, 소진 후 재시작.

#### 3-1-4. 렉 개선

조사로 찾은 원인과 지시다. 각각 개선 전후를 측정해 PR에 적는다(Chrome Performance 기록, 저사양 모바일 기준 4× CPU throttle).

1. **그리기 캔버스(`src/components/DrawingCanvas.tsx`)**
   - 원인 A: `pointermove`마다 `putImageData`로 680×680 전체를 되돌린 뒤 **획의 처음부터 모든 점을 다시 그린다**(`renderStroke`, `:408-435`). 획이 길수록 점점 느려진다(O(n²)).
   - 원인 B: `pointerdown`마다 `getImageData`로 전체를 읽는다(`:439`). GPU 캔버스에서 동기 읽기는 느리다.
   - 원인 C: 이벤트마다 즉시 그리므로 한 프레임에 여러 번 그린다.
   - 지시: 진행 중인 획은 **위에 겹친 투명 캔버스(오버레이)**에만 그리고, 손을 떼면 본 캔버스에 한 번 합친다. 투명도 있는 펜은 오버레이 캔버스 전체에 `globalAlpha`를 줘서 합칠 때 적용한다(겹쳐 진해지는 문제 없음). 오버레이 그리기는 `requestAnimationFrame`으로 한 프레임에 한 번, 새로 들어온 점만 이어 그린다(불투명 펜·지우개는 이어 그리기, 반투명 펜도 오버레이 위에서는 불투명으로 그리고 합칠 때 알파 적용).
   - 되돌리기용 스냅숏은 `getImageData` 대신 `createImageBitmap(canvas)` 또는 오프스크린 캔버스 복사로 바꾸고 10개 제한은 유지한다. 채우기(flood fill)만 `getImageData`가 필요하므로 그때만 읽는다. 채우기용 캔버스 컨텍스트는 `{ willReadFrequently: true }`인 별도 캔버스를 쓴다.
   - `floodFill`(`src/drawing.ts`)의 `target.every(...)`·`Array.from` 같은 픽셀마다의 배열 생성을 없애고 정수 비교로 바꾼다. 640×640 전체 채우기가 저사양에서 100ms 아래인지 측정.
2. **폴링 비용(서버·네트워크)**
   - 원인: 5초마다 `GET /api/catchmind`가 판·사람 3명·답 목록·지난 판(`readCatchmindGallery` + 사람 조회)을 매번 읽는다(약 8~10쿼리).
   - 지시: `catchmind_turn`에 `version INTEGER NOT NULL DEFAULT 0` 열을 추가하고(0012에 함께), 모든 변경 batch 끝에서 `version = version + 1`. `GET /api/catchmind?since=<version>`이면 먼저 `SELECT version FROM catchmind_turn WHERE id=1` 한 번만 읽고 같으면 `{ unchanged: true, version, serverTime }`을 돌려준다. 클라이언트는 이 응답이면 상태를 그대로 둔다.
   - 폴링 주기: 맞히기 진행 중(`open`) 3~5초, 그리는 중(`draft`)·끝남·대기 10초, 내가 그리는 중(draft의 출제자)에는 폴링하지 않거나 30초. 화면이 안 보이면 멈춤(현행).
   - `previousRound`는 판이 바뀔 때만 필요하므로 버전이 바뀐 응답에서만 포함한다.
3. **불필요한 React 렌더**
   - `CatchmindProvider.apply`(`src/catchmind.tsx`)가 매 폴링마다 새 객체로 `setState`해서 화면 전체가 다시 그려진다. 버전이 같으면 `setState`하지 않는다.
   - `DrawingCanvas`, `GuessLog`, `Picture`, `PreviousCatchmindRound`를 `React.memo`로 감싸고 props를 안정화한다. 그리는 중에는 부모 렌더가 캔버스에 닿지 않아야 한다.
   - 답 목록이 길어지면(최대 10오답 + 정답) 문제없지만, `rise` 애니메이션은 새로 추가된 항목에만 적용되는지 확인.
4. 그림 이미지는 이미 immutable URL이므로 유지. 썸네일·지난 판 이미지는 `loading="lazy"`, `decoding="async"` 확인.

**수용 기준:** 저사양 모드(4× throttle)에서 긴 획(약 3초)을 그릴 때 프레임 드랍이 눈에 띄지 않음(Long Task 50ms 이상 없음), 폴링 "변경 없음" 응답이 D1 쿼리 1~2개.

### 3-2. 캐릭터 뽑기

**요구:**
- 가로 폭 사이즈가 제한되어 있는 거 같음
- 렉이 좀 걸리는데 이것도 체크 후 최적화 필요

#### 3-2-1. 가로 폭

**원인:** `src/claw/claw.css:1` `.claw-page { --claw-machine-width: 400px; }`, 그리고 `src/preview.css:646-650` `.pg-machine, .pg-claw-controls { max-width: var(--claw-machine-width) }`. 앱 폭은 560px(`--app-width`)인데 기계만 400px로 묶여 있다. `.claw-status { max-width: 440px }`도 있다.

**지시:** 기계·지갑·안내 카드가 앱 본문 폭을 그대로 쓰게 한다(`width: calc(100% - 32px)`, 최대 폭 제한 삭제 또는 `--app-width - 32px`). 캔버스는 `aspect-ratio: 600 / 420`을 유지하므로 높이가 함께 커진다. 화면 높이가 낮은 기기(예: 390×700)에서 조작 버튼이 첫 화면에 들어오는지 확인하고, 넘치면 기계 최대 높이를 `min(…, 55dvh)`로 묶는다. 390px·560px 스크린샷을 남긴다.

#### 3-2-2. 렉

조사로 찾은 원인:

1. **100ms마다 React 렌더.** `ClawController.frame`(`src/claw/controller.ts:236`)이 100ms마다 `notify()` → `setView`로 새 객체를 넘겨 `Claw` 화면 전체가 초당 10번 다시 그려진다. 대기 상태에서도 그렇다.
   → `notify()`에서 직전 값과 필드별로 비교해 바뀐 경우에만 `update`를 부른다. 타이머 숫자는 초 단위로만 바뀌므로 초가 바뀔 때만.
2. **대기 중에도 매 프레임 전체를 다시 그림.** rAF 루프가 항상 돌며(`:238`) `draw()`가 배경·트랙·인형을 매번 그린다.
   → 대기(`idle`, `result`)이고 흔들림이 거의 0이면 그리지 않는다(더티 플래그). 화면이 안 보이면(`visibilitychange`) 루프를 멈춘다.
3. **인형마다 `shadowBlur`.** `drawDoll`(`src/claw/render.ts`)이 매 프레임 인형마다 `shadowBlur = 5`로 그린다. 캔버스 그림자는 비싸다.
   → 인형 종류·크기별로 그림자까지 넣은 이미지를 오프스크린 캔버스에 한 번 만들어 두고 `drawImage`만 한다.
4. **움직이지 않는 배경을 매 프레임 그림.** 배경색·바닥·배출구·칸막이·장식 점을 오프스크린 캔버스에 한 번 그려 두고 매 프레임 그 한 장만 복사한다(배출구 깜빡임만 따로).
5. **매 프레임 정렬·계산.** `[...view.dolls].sort(...)`를 매 프레임 하고, `ready`에서 `planDescent(board, claw.x)`를 매 프레임 계산한다. 정렬은 보드가 바뀔 때만, `planDescent`는 `claw.x`가 바뀔 때만(또는 x를 픽셀 단위로 반올림해 캐시).
6. **해상도.** `resize()`가 DPR을 3까지 허용한다(`render.ts` `Math.min(devicePixelRatio, 3)`). 2로 낮춘다.
7. **재생 시작 시 물리 계산이 메인 스레드를 막음.** 결과를 받은 뒤 `simulateAttempt(..., { record: true })`(`controller.ts:138`)를 동기로 돌린다. 측정해서 50ms를 넘으면 Web Worker로 옮기거나, 첫 몇 프레임을 먼저 재생하면서 나머지를 나눠 계산한다.

**수용 기준:** 대기 상태에서 React 렌더 0회/초, 조작 중 60fps 근처(4× throttle에서 Long Task 없음), 결과 재생 시작 지연 100ms 이하.

---

## 4. 랭킹

**요구:**
- 주간 랭킹 위에 토글로 일간 / 주간 / 월간 랭킹 셋 돌아가면서 볼 수 있도록 해줘.
- 랭킹 순위 안에 플레이어별 프로필 사진 나오도록 해줘.(닉네임 옆)
- 그리고 각 랭킹에서 '요일별 점수' 하단에 플레이어별 점수 획득 기록을 남겨줘. 어떤 플레이어가, 언제, 무슨 게임에서, 몇 점을 얻었는지 표기할 것. 프로필에 있는 골드/점수 이거 활용하면 될 듯.

**현재:** `src/screens/Ranking.tsx`는 bootstrap의 `players[].weeklyScore`와 내 `dailyScores`(이번 주 요일별)만 쓴다. 시상대는 캐릭터만 보이고 사진이 없다. 지난주 목록은 미리보기에서만 나온다(`src/App.tsx:734`).

### 4-1. 기간 토글

1. 툴바 아래, 시상대 위에 기존 `Segmented` 컴포넌트(`src/components/UI.tsx:515`)로 `일간 | 주간 | 월간`. 기본값은 `주간`. 고른 값은 `localStorage`에 기억(실패해도 동작).
2. 기간 정의(KST):
   - 일간: 오늘 00:00~24:00
   - 주간: 이번 주 월요일~일요일(현행 `weekStart`)
   - 월간: 이번 달 1일~말일
3. 점수를 어느 날짜에 넣을지는 **게임 날짜** 기준으로 통일한다(현행 `weeklyDailyScores`의 규칙과 같음: 예측 점수는 라운드 날짜, 캐치마인드는 판 날짜, 그 밖은 `created_at`의 KST 날짜). 이 계산을 함수 하나로 묶어 주간·일간·월간 모두에 쓴다.
4. 툴바 제목과 안내 줄: `일간 랭킹 · 오늘 종료까지 5시간 12분`, `주간 랭킹 · 11월 1주차 · 이번 주 종료까지 …`(현행), `월간 랭킹 · 11월 · 이번 달 종료까지 26일 …`.
5. 홈의 "이번 주 랭킹" 미리보기와 홈 점수(§2-2)는 주간 그대로.

### 4-2. 서버 API

`GET /api/ranking?period=day|week|month` (신규, bootstrap에 넣지 않는다 — 쿼리 50개 한도):
```ts
interface RankingResponse {
  period: 'day' | 'week' | 'month';
  range: { start: string; end: string };          // KST 날짜 YYYY-MM-DD
  standings: { userId, username, displayName, photoVersion, character, tag, score }[];
  buckets: { label: string; date: string; score: number }[]; // 내 점수 묶음(아래 4-4)
  history: { id, userId, game: GameKey, label: string, amount: number, createdAt: string }[];
  nextBefore: string | null;                       // 기록 더 보기 커서
  serverTime: string;
}
```
- `standings`: 활성 플레이어 전원(0점 포함), 점수 내림차순, 동점은 username 순. 순위 계산은 §2-3과 같은 공동 순위.
- 읽기 비용: `ledger`에 `(currency, created_at)` 인덱스를 추가한다(`migrations/0013_ranking.sql`). 주간은 기존 `ledger_week_idx`를 쓰고, 일간·월간은 `currency='score' AND created_at BETWEEN start-1일 AND end+1일`로 넉넉히 읽은 뒤 게임 날짜로 다시 거른다.
- 운영자도 조회 가능(읽기 전용).
- 응답은 `Cache-Control: no-store` 유지. 클라이언트는 같은 기간을 30초 안에 다시 요청하지 않는다(메모리 캐시).

### 4-3. 프로필 사진

- 시상대(`.podium-place`)의 이름(`.podium-name`) 옆에 원형 사진 24~28px, 아래 목록(4위 이하·0점 포함 전원 목록을 새로 만든다)과 지난주 목록의 행에는 이름 앞 40px 아바타(현행 `Avatar`). 사진이 없으면 선택 캐릭터.
- 시상대의 큰 캐릭터 스프라이트는 유지한다.
- 시상대에는 3명까지만 나오므로, 그 아래 `전체 순위` 카드에 모든 플레이어를 `순위 · 사진 · 닉네임 · 점수`(§1-1-1: 랭킹은 "님" 없음)로 보여 준다(공동 순위는 같은 숫자).

### 4-4. "요일별 점수" 카드를 기간에 맞추기

- 주간: 지금처럼 요일별 7칸(제목 `요일별 점수`).
- 월간: 주차별(1주차~5주차) 막대, 제목 `주차별 점수`.
- 일간: 게임별 막대(기상·퇴근·행운·캐치마인드·쿠지·캐릭터 뽑기 중 점수가 있는 것), 제목 `게임별 점수`.
- 카드 머리의 이름 표시(`<span>{me}</span>`, 지금은 username이 그대로 나옴)를 닉네임으로 고친다("님" 없음, §1-1-1).

### 4-5. 점수 획득 기록

1. 위 카드 바로 아래 `점수 획득 기록` 카드. 기간 안의 **모든 플레이어**의 점수 원장(`ledger.currency='score'`)을 최신순으로.
2. 한 줄: `[아바타 32px] 닉네임 · 게임 이름 · 날짜·시각(§1-3 형식) · +N점`. 음수가 있으면 `-N점`으로 그대로 표시.
3. 게임 이름은 `reference` 앞부분으로 정한다(사유 글자에 기대지 않는다). 공유 함수 `scoreSource(reference)`:
   - `score:wake:` → 기상시간 맞히기, `score:offwork:` → 퇴근시간 맞히기, `score:luck:` → 행운 점수 맞히기
   - `catchmind:score:` → 캐치마인드
   - `claw:` → 캐릭터 뽑기(인형 / 클리어 보너스 구분 가능하면 `캐릭터 뽑기 · 클리어 보너스`)
   - 쿠지 등급 점수 reference(`worker/shop.ts:177` 근처) → 예굼쿠지
   - 그 밖 → `ledger.reason`
4. 내 정보 화면의 골드/점수 내역(`src/screens/Profile.tsx`, `iconFor` 아이콘 규칙과 행 모양)을 공통 컴포넌트로 빼서 재사용한다.
5. 처음 20개, `더 보기`로 20개씩(`nextBefore` 커서: `created_at`+`id`). 무한 스크롤은 하지 않는다.
6. 플레이어 필터 칩(`전체 | 민님 | 시원님 | 예서님`)을 위에 둔다. **결정** — 원문에 없으므로 선택 사항으로 구현해도 되고 빼도 된다.
7. 미리보기: `src/sample.ts`에 기간별 예시 데이터.

---

## 5. 상점

### 5-1. 데일리 로또·스피또

**요구:**
- 판매 마감 시간 변경 : 17시 30분
- 플레이어가 로또를 샀고, 판매 마감 시간이 지났다면 홈 화면에서도 당첨 결과를 확인해보라는 메시지를 표시.
- 골드로 구매 버튼과 이용권으로 구매 버튼 이 2개는 2x1 배열로 변경할 것. 위아래로 있으니까 안 보임.
- 하나 샀을 때마다 1개씩 박스로 표시하지 말고, 구매일 나오고, 더 샀으면 더 산대로 한 줄씩 배열할 것. 지금 한 박스씩 나오니까 너무 자리 차지가 심함.
- 7일 기록까지만 표기하고 나머지는 표기하지 말 것.
- 스피또에서는 여기를 긁어보세요 글자가 약간 옆으로 찌부되어 있는데 조치할 것.
- 텍스트 수정 : 한 번에 열기 -> 한 번에 긁기

#### 5-1-1. 마감·추첨 17:30

- `shared/balance.ts:61` `LOTTO_RULES.drawTime: '17:00:00' → '17:30:00'`. 판매 마감 = 추첨 시각이다(이후 구매는 다음 날 대상, 현행 `targetDrawDate`).
- Worker(`worker/shop.ts:51,196,198,249,268,310`)는 상수를 읽으므로 값만 바뀐다. 화면·미리보기(`src/shop-preview.ts:10`, `src/sample.ts:15,190`, `src/screens/Home.tsx:275`, `src/screens/Shop.tsx:110,160,186`)도 같은 상수를 쓰는지 확인하고, 하드코딩된 `17:00`이 남지 않게 한다. 예측 게임의 17:00 마감은 **바꾸지 않는다**.
- 문구: `17시 30분 판매 마감·추첨`.
- 배포 주의(decisions·runbook에 기록): 17:00~17:30 KST 사이에 배포하면 그날 17:00에 이미 추첨·정산된 회차와 새 규칙이 엇갈릴 수 있으므로 그 시간대를 피한다. 테스트에 17:00~17:30 사이 구매가 오늘 회차로 들어가는지 추가.

#### 5-1-2. 홈의 로또 결과 안내

- bootstrap에 `lottoNotice: { drawDate: string; tickets: number; winners: number; prize: number } | null`을 추가한다. 조건: 오늘(KST) 추첨 회차 표를 1장 이상 샀고, 지금이 17:30 이후. 쿼리 1개(`lotto_tickets JOIN shop_purchases WHERE user_id=? AND draw_date=?`의 COUNT·SUM).
- 홈 출석 카드 아래(오늘의 게임 위)에 안내 카드: `오늘 산 데일리 로또 3장의 추첨이 끝났어요. 결과를 확인해 보세요 ›` → 누르면 `/shop/lotto`. 당첨 금액은 미리 밝히지 않는다(결과 확인의 재미).
- 로또 화면을 열면(또는 카드의 닫기 ×) 그 회차 안내를 숨긴다. 기억은 `localStorage` 키 `yegoom3:lotto-seen:<userId>:<drawDate>`(실패해도 동작, 그 경우 그날 계속 보임). 다음 날이 되면 자연히 사라진다.
- 미리보기에도 같은 카드.

#### 5-1-3. 구매 버튼 2×1

- `.shop-purchase-actions`(로또 `src/screens/Shop.tsx:174-178`, 스피또 `:299-303`)를 두 칸 그리드로: 왼쪽 `골드로 사기 · 500G`, 오른쪽 `이용권으로 사기 (보유 3장)`. 안내 문구(`N개 더 골라주세요`, `골드가 부족해요…`)는 그리드 위에 한 줄로 전체 폭.
- 390px에서 버튼 글자가 두 줄로 깨지지 않게 문구를 줄인다(`골드 500G` / `이용권 1장`처럼). 버튼 높이는 같게.
- 슬롯머신·별명 뽑기처럼 결제 수단이 하나뿐인 곳은 한 칸 전체 폭.

#### 5-1-4. 구매 기록: 구매일별로 묶고 한 줄씩

- 로또(`.lotto-tickets`, `TicketCard`)와 스피또(`.speetto-history`, `src/screens/Shop.tsx:306`)의 기록을 같은 모양으로 바꾼다.
  ```
  2026년 11월 04일 · 3장
   ① 03 07 12 18 21   2등 +3,000G
   ② 01 05 09 14 25   추첨 대기
   ③ 02 06 11 19 22   낙첨
  2026년 11월 03일 · 1장
   ① …
  ```
  - 묶는 기준: **구매일**(`shop_purchases.date`, KST). 로또 응답의 `LottoTicket`에 `purchaseDate`, `createdAt`을 추가한다.
  - 로또 한 줄: 번호 공(작게, 당첨 번호와 맞은 공은 색), 결과(`추첨 대기` / `N등 · +금액G` / `낙첨`). 추첨일이 구매일과 다르면(17:30 이후 구매) 줄 끝에 `11월 05일 추첨`을 작게 표시.
  - 스피또 한 줄: 구매 시각, 결과(`+1,500G` / `낙첨` / 아직 안 긁었으면 `긁기 전`), 누르면 위 긁기 카드에 그 표를 띄운다(현행 선택 동작 유지).
- 카드 하나에 기록 전체를 넣는다(표마다 카드 X). 그룹 머리에는 그날 합계(`당첨 +3,000G`)를 오른쪽에.

#### 5-1-5. 최근 7일만

- 서버에서 자른다(읽는 행도 줄어든다): `readLottoTickets`(`worker/shop.ts:264`)와 스피또 목록(`:317`)에 `p.date >= <오늘-6일>` 조건. 인덱스 `shop_user_date_idx(user_id, date, kind)`를 그대로 쓴다.
- 7일보다 오래된 미정산 로또가 있으면 정산은 그대로 된다(정산은 표시와 별개).
- 아래에 `최근 7일 기록만 보여요` 안내.

#### 5-1-6. 스피또 "여기를 긁어보세요" 글자 찌그러짐

**원인:** 긁는 캔버스의 내부 크기는 `652×300`(비율 2.17)인데(`src/screens/Shop.tsx:262`), CSS로는 `.scratch-area { height: 150px }`에 폭 100%로 늘린다(`src/screens.css:2055-2093`). 화면 폭에 따라 비율이 달라져(390px에서 약 2.4, 560px에서 약 3.3) 글자와 무늬가 옆으로 늘어나거나 눌린다.

**지시:** 캔버스 내부 크기를 **실제 표시 크기 × DPR(최대 2)**로 맞춘다(`ResizeObserver`). 크기가 정해질 때 덮개를 그리고, 긁기 전에 크기가 바뀌면 다시 그린다(긁기 시작한 뒤에는 다시 그리지 않음). 글자는 `measureText`로 폭의 80%를 넘지 않게 글꼴 크기를 줄인다. 긁는 원 반지름·남은 비율 계산(`cleared`)도 CSS 픽셀 기준으로 맞춘다. 폰트가 늦게 로드돼도 글자가 기본 글꼴로 남지 않게 `document.fonts.load('800 20px TmoneyRoundWind')` 뒤에 그린다.

#### 5-1-7. 문구

- `src/screens/Shop.tsx:267` `한 번에 열기` → `한 번에 긁기`. 테스트 단언도 수정.

### 5-2. 슬롯머신 추가

**요구:**
- 과일(바나나, 사과, 딸기, 포도, 수박, 참외 등) + 7로 구성된 슬롯머신.
- 1게임에 500골드 소모
- 모션도 구현할 것.
- 7 7 7 나올 확률은 7%
- 당첨 시 2000G 즉시 수령

**규칙(`shared/balance.ts`):**
```ts
export const SLOT_RULES = {
  price: 500, jackpotPercent: 7, jackpotPrize: 2000,
  symbols: ['banana', 'apple', 'strawberry', 'grape', 'watermelon', 'chamoe', 'seven'],
  reels: 3,
} as const;
```
- 결제는 **골드만**(이용권 없음).
- 판정: Worker에서 `randomInt(100) < 7`이면 결과 `['seven','seven','seven']`, 상금 2,000G. 아니면 꽝.
- **결정(꽝 결과 모양):** 꽝일 때 세 칸은 무작위로 고르되 **세 칸이 모두 같은 그림이 되지 않게** 한다(`seven` 3개는 물론 같은 과일 3개도 금지 — 당첨처럼 보이는데 상금이 없으면 헷갈리기 때문). 두 칸까지 같은 것은 허용(아깝다 연출).
- 기대값: 0.07 × 2,000 = 140G → 1회당 평균 360G가 사라지는 골드 소모처다. decisions에 적는다.
- 하루 횟수 제한은 원문에 없으므로 두지 않는다(필요해지면 상수 하나로 추가할 수 있게 `dailyLimit: null`).

**DB (`migrations/0014_slot_machine.sql`):** `shop_purchases.kind`의 CHECK에 `slot`이 없으므로 새 표를 쓴다.
```sql
CREATE TABLE slot_spins (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  request_id TEXT NOT NULL,
  cost INTEGER NOT NULL CHECK (cost > 0),
  reels TEXT NOT NULL,          -- JSON ["apple","seven","grape"]
  prize INTEGER NOT NULL CHECK (prize >= 0),
  date TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (user_id, request_id)
);
CREATE INDEX slot_spins_user_date_idx ON slot_spins(user_id, date);
```

**Worker:**
- `GET /api/shop/slot` → `{ ...ShopState, slot: { recent: SlotSpin[] /* 최근 7일, 최대 20개 */ } }`
- `POST /api/shop/slot` `{ requestId }` → 플레이어만. 기존 스피또 구매(`buySpeetto`)와 같은 패턴: 잔액 조건부 `INSERT INTO slot_spins … SELECT … WHERE 잔액 >= 500`, 같은 batch에서 `ledger`에 `-500`(사유 `슬롯머신`, reference `slot:buy:<user>:<requestId>`)과 당첨 시 `+2000`(사유 `슬롯머신 당첨`, reference `slot:prize:<spinId>`). 같은 `requestId` 재요청은 처음 결과를 그대로 돌려준다. 잔액이 부족하면 409 `골드가 부족해요`.
- 당첨 소식 배너(`announcements`)는 `kind` CHECK가 `lotto|speetto`만 허용하므로 이번에는 넣지 않는다. 필요하면 별도 PR.
- 테스트: 확률(난수 주입 경계 6/7), 꽝 결과에 세 칸 같은 그림이 없음, 잔액 부족, 재요청 멱등, 동시 요청 중복 차감 없음, 운영자 거절, 원장 합계 = 잔액 캐시(§1-5-1).

**화면 (`/shop/slot`, `src/screens/Slot.tsx` 신규):**
- 상점 첫 화면(`ShopMain`)과 홈 상점 카드(`ShopCards`, `src/screens/Home.tsx:263`)에 `슬롯머신 · 1회 500G` 타일 추가. 타일 배치가 2열 그리드이므로 3개가 되면 마지막 줄 정렬을 확인한다.
- 구성: 툴바(골드), 기계(위 장식 전구 줄, 가운데 세 릴 창, 아래 결과 표시줄), `돌리기 · 500G` 큰 버튼(옆에 레버를 그려도 됨), 규칙 안내(`7 7 7이 나오면 2,000G · 확률 7%`), 최근 기록(§5-1-4와 같은 한 줄 모양, 최근 7일).
- 그림: 바나나·사과·딸기·포도·수박·참외·7을 **직접 그린 단순 SVG**로 `public/slot/`에 둔다(외부 이미지·이모지 사용 X — 기기마다 모양이 달라서). 앱의 2px 진한 외곽선·파스텔 팔레트에 맞춘다. 출처를 `docs/asset-provenance.md`에 적는다.
- **모션:**
  1. 버튼(또는 레버)을 누르면 레버가 내려갔다 올라오고, 세 릴이 동시에 빠르게 돌기 시작한다(세로 띠 `transform: translateY` 반복, 도는 동안 살짝 `filter: blur(1px)`). 요청은 누르는 순간 보낸다.
  2. 응답이 와도 최소 0.8초는 돈다. 그 뒤 **왼쪽 → 가운데 → 오른쪽** 순서로 0.35초 간격으로 멈춘다. 멈출 때 서버 결과 그림에 정확히 맞춰 살짝 지나쳤다 돌아오는 감속(오버슈트)을 준다.
  3. 앞 두 칸이 7·7이면 마지막 릴을 0.6초 더 천천히 돌려 긴장감을 준다(결과는 이미 정해져 있음).
  4. 당첨: 전구가 빠르게 깜빡이고, 기존 `confetti`·`coinFly`(골드 표시로 코인이 날아감)·`useCountUp`으로 골드가 올라간다. `+2,000G` 표시.
  5. 꽝: 결과 줄에 `아쉬워요`와 가벼운 `shake`.
  6. 애니메이션은 WAAPI/CSS로 하고 React 상태를 프레임마다 바꾸지 않는다(렌더는 시작·릴 정지·끝에만).
  7. `prefers-reduced-motion`: 돌지 않고 0.2초 페이드로 결과를 보여 준다.
- 상태: 도는 중에는 버튼 잠금. 응답을 못 받으면 기존 상점처럼 "같은 요청으로 다시 확인" 흐름(`src/shop.tsx`의 pending 처리)을 그대로 쓴다. 이 경우 릴은 멈춘 채 `결과 확인 중`.
- 골드가 500G 미만이면 버튼 비활성 + `골드가 부족해요`.
- 미리보기: `src/shop-preview.ts`에 같은 규칙(기기 안에서만).

---

## 확인 필요 목록

원문에 없어서 이 문서가 기본값을 정한 항목이다. 사용자 답이 다르면 그 값으로 바꾼다.

1. 별명 태그 얻는 방법: "골드 300G로 구매 즉시 1개 뽑기, 하루 5회"로 정함(원본은 30점짜리 뽑기권을 보관했다가 사용). (§1-4)
2. 캐치마인드 출제 순서: username 오름차순으로 정함. 다음 출제자가 10분 동안 시작하지 않으면 다른 사람이 차례를 넘길 수 있게 함. (§3-1-2)
3. 제시어 400개를 모두 쓰면 처음부터 다시 쓰도록 정함. (§3-1-3)
4. 슬롯머신 꽝일 때 같은 과일 3개가 나오지 않도록 정함. 같은 과일 3개에도 작은 상금을 줄지는 정하지 않음. (§5-2)
5. 랭킹 점수 기록의 플레이어 필터 칩은 선택 사항. (§4-5)
6. "님"은 이름이 단독으로 나오는 곳에도 붙인다. **단, 랭킹 표시는 예외로 "님"을 뺀다(2026-11-04 사용자 결정, §1-1-1).** (§1-1)

---

## 부록 A. 별명 태그 원본

### A-1. 문구 (yegoom `src/lib/nickname-tags-texts.js`, 구글 시트 'YEGOOM Text Database' › '별명 태그' 탭에서 생성된 파일)

`shared/nickname-tags.ts`에 그대로 옮긴다. 같은 문구가 두 등급에 중복되지 않는지 테스트로 확인한다.

```ts
export const TAG_TEXTS = {
  S: [
    '무한한', '개쩌는', '완벽한', '최고의', '미친(P)', '미친(N)', '우월한', '영롱한', '신', '여신', '왕', '여왕', '전설적인', '불멸의', '압도적인', '찬란한', '독보적인', '절대적인', '위대한',
    '경이로운', '무적의', '찬연한', '고결한', '초월적인', '눈부신', '지존의', '숭고한', '신화적인', '범접불가의', '극상의', '영원한', '존엄한', '먼작귀', '치이맘', '하치맘', '우사기맘', '치이카와',
    '하치와레', '우사기', '먼가작고귀여운',
  ],
  A: [
    '귀여운', '예쁜', '어여쁜', '사랑스러운', '행복한', '깜찍한', '멋있는', '강렬한', '치이카와 팬', '하치와레 팬', '우사기 팬', '모몽가 팬', '시사 팬', '쿠리만쥬 팬', '가르마', '아름다운', '빛나는',
    '상큼한', '싱그러운', '다정한', '매혹적인', '사랑스런', '활기찬', '우아한', '포근한', '달콤한', '낭만적인', '화사한', '반짝이는', '감미로운', '산뜻한', '근사한', '매력적인', '따뜻한', '훈훈한',
  ],
  B: [
    '바쁜', '힘든', '쉽지 않은', '그저 그런', '가벼운', '무거운', '지겨운', '심심한', '눌러붙은', '앉아있는', '산책하는', '힘이 없는', '늦잠을 자는', '일찍 일어나는', '밥을 많이 먹는', '졸린', '피곤한',
    '귀찮은', '평범한', '뒹굴거리는', '멍때리는', '멍한', '애매한', '서성이는', '느긋한', '털털한', '덤덤한', '어설픈', '쭈뼛거리는', '늘어져있는', '널부러진', '하품하는', '끄적이는', '서툰', '그럭저럭인',
  ],
  C: [
    '배가 고픈', '배가 부른', '배가 남산만한', '똥이 마려운', '똥이 급한', '오줌이 마려운', '오줌이 급한', '똥쟁이', '오줌쟁이', '방구쟁이', '방구 냄새가 지독한', '입냄새가 지독한', '입냄새의 신', '뿌직',
    '우웨엑', '현란한 토악질', '한교동 팬', '한교동 여친', '한교동 와이프', '방구 뀌는', '꼬질꼬질한', '꾀죄죄한', '꼬랑내 나는', '씻기 싫은', '침 흘리는', '코를 파는', '코를 고는', '방구차 따라가는',
    '뿡뿡거리는', '냄새나는', '덜 닦은', '배탈이 난', '똥을 참는', '땀범벅인', '쿰척거리는', '찔찔 짜는', '헛구역질하는', '꼬질한', '코를 파먹는',
  ],
} as const;

export const TAG_GRADES = [
  { grade: 'S', chance: 5, label: 'S등급', look: '홀로그램' },
  { grade: 'A', chance: 20, label: 'A등급', look: '금빛' },
  { grade: 'B', chance: 30, label: 'B등급', look: '은빛' },
  { grade: 'C', chance: 45, label: 'C등급', look: '테두리' },
] as const;

/** 등급마다 뽑을 수 있는 문구 — S 는 S 만, A 는 S 를 뺀 전부, B 는 B~C, C 는 C 만 */
export const TAG_POOLS = {
  S: TAG_TEXTS.S,
  A: [...TAG_TEXTS.A, ...TAG_TEXTS.B, ...TAG_TEXTS.C],
  B: [...TAG_TEXTS.B, ...TAG_TEXTS.C],
  C: TAG_TEXTS.C,
};
```

### A-2. 모양 (yegoom `public/css/arcade.css`에서 옮김, 색 변수는 yegoom-3 토큰에 맞춰 조정)

```css
.nick-tag { position: relative; display: inline-block; max-width: 11em; padding: .08em .45em; overflow: hidden;
  border: 1.5px solid var(--line); border-radius: 6px; font-size: .74em; font-weight: 800; line-height: 1.4;
  letter-spacing: -.02em; white-space: nowrap; text-overflow: ellipsis; color: var(--text); background: transparent; }
.nick-tag--b, .nick-tag--a, .nick-tag--s { color: #20201f; border-color: #20201f; }
.nick-tag--b { background: linear-gradient(135deg, #fbfbfc 0%, #cfd4db 42%, #f3f4f6 55%, #b7bdc6 100%); }
.nick-tag--a { background: linear-gradient(135deg, #fff6c2 0%, #f5c84c 42%, #fff1a8 55%, #dca523 100%); }
.nick-tag--s { background: linear-gradient(110deg, #ffb8dc, #ffe68f, #aef2d4, #aecbff, #dbb8ff, #ffb8dc) 0 0 / 200% 100%;
  animation: nick-holo 4s linear infinite; }
.nick-tag--s::after, .nick-tag--a::after { content: ''; position: absolute; inset: 0; pointer-events: none;
  background: linear-gradient(105deg, transparent 35%, rgba(255,255,255,.85) 50%, transparent 65%);
  background-size: 250% 100%; background-repeat: no-repeat; animation: nick-sheen 2.4s ease-in-out infinite; }
.nick-tag--a::after { animation-duration: 3.6s; opacity: .7; }
/* 태그 + 이름: 세로 가운데 정렬, 좁으면 태그가 먼저 줄어든다 */
.tagged-name { display: inline-flex; align-items: center; gap: .32em; max-width: 100%; min-width: 0; vertical-align: middle; }
.tagged-name .nick-tag { flex: 0 1 auto; min-width: 2.6em; margin: 0; }
.tagged-name__text { flex: 0 0 auto; }
@keyframes nick-holo { to { background-position: 200% 0; } }
@keyframes nick-sheen { 0% { background-position: 115% 0; } 60%, 100% { background-position: -15% 0; } }
@media (prefers-reduced-motion: reduce) { .nick-tag--s, .nick-tag::after { animation: none; } }
```

원본 화면 동작: 내 정보의 "내 별명 태그" 칸에서 태그를 누르면 바로 달고, 단 태그에는 `달고 있음` 표시, `별명 떼기` 버튼, 아래에 `모은 태그 N개 · 단 태그는 앱 어디서든 내 이름 앞에 보여요.` 안내. 태그가 없으면 `아직 모은 별명 태그가 없어요. 상점의 별명 태그 뽑기로 뽑아 보세요.` + 상점 가기 버튼.
