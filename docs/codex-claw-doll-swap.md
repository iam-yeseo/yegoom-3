# 작업 지침: 캐릭터 뽑기 인형 그림 교체 (Codex용)

## 0. 한 줄 요약

캐릭터 뽑기(인형뽑기 기계)에 들어 있는 **인형 그림 11종을, 사용자가 준 새 인형 그림 N종으로 바꾼다.**
게임 규칙·물리·보상·화면 구성·DB는 그대로 둔다. **바뀌는 것은 "기계 안에 보이는 인형 그림"과 "인형 종류 수" 둘뿐이다.**

- N = 사용자가 준 원본 이미지 장수. 11이 아니다(사용자 확인). 시작할 때 세어서 보고서 맨 위에 적는다.
- 원본 이미지에는 **배경이 있다**(투명 PNG가 아님). 배경을 지우는 일이 이 작업의 큰 부분이다.

---

## 1. 절대 하지 말 것

아래 중 하나라도 필요해 보이면 **멈추고 사용자에게 물어본다.** 임의로 진행하지 않는다.

1. **그림을 새로 그리거나, 생성하거나, 고쳐 그리지 않는다.** 색 보정·필터·외곽선 추가·업스케일 AI도 쓰지 않는다. 할 일은 배경 제거, 여백 자르기, 크기 줄이기, WebP 변환뿐이다.
2. **물리 엔진 계산을 건드리지 않는다.** `shared/claw-physics.ts`에서 바꿀 수 있는 것은 3-3절에 적은 상수 3개와 새 함수 1개뿐이다. `MACHINE`, `CLAW`, `DOLL_COUNT`(30), `MAX_RADIUS`, `createBoard`·`simulateAttempt`·`stepBoard` 등 함수 본문은 그대로 둔다.
3. **`tests/fixtures/gatcha-physics.original.js`는 한 글자도 바꾸지 않는다.** 이 파일의 Git blob SHA를 검사하는 테스트가 있다. 원본 엔진과의 대조 기준이다.
4. **DB를 건드리지 않는다.** 새 마이그레이션을 만들지 않고, 사용자들의 기계(`claw_accounts.board_json`)를 비우거나 다시 만들지 않는다. 원격 DB 명령(`--remote`), 배포(`npm run deploy`), `launch:reset` 같은 스크립트는 실행하지 않는다.
5. **보상·확률·코인·도전과제·운영 설정은 바꾸지 않는다.** `shared/balance.ts`의 `CLAW_RULES`, `worker/claw.ts`, `shared/achievements.ts`, 운영 탭(`src/screens/Admin.tsx`)은 손대지 않는다.
6. **기계 화면 디자인을 바꾸지 않는다.** 배경·배출구·집게 그림, 그림자, 소리(`src/claw/sound.ts`), 문구, 레이아웃은 그대로 둔다.
7. 인형에 이름·등급·희귀도 같은 **새 기능을 추가하지 않는다.** 지금 게임에는 인형 이름이 없다. 그대로 둔다.
8. **원본 이미지(큰 PNG)를 `public/` 아래나 저장소에 넣지 않는다.** `public/` 아래 파일은 전부 서비스 워커가 미리 받아 두므로, 큰 원본이 들어가면 모든 사용자가 몇 MB를 받게 된다. 원본은 저장소 밖 임시 폴더에 두고 커밋하지 않는다.
9. 위 목록에 없는 파일을 "김에 정리"하지 않는다. 리팩터링·포맷 변경·의존성 업데이트 금지.

---

## 2. 지금 구조 (꼭 알아야 할 것)

### 2-1. 인형 번호(type)와 그림 파일

- 인형마다 `type` 번호(1부터)가 있고, 그림 파일은 `public/claw/dolls/doll-{type}.webp`다. 지금은 `doll-1.webp` ~ `doll-11.webp`.
- 경로는 `src/claw/render.ts`의 `dollSrc(type)`가 만든다. 같은 함수를 결과 창(`src/screens/Claw.tsx`)도 쓴다.
- 지금 그림들은 **투명 여백 없이 인형 테두리에 딱 맞게 잘려 있다**(알파 bbox = 이미지 전체). 긴 변 320px.
- 렌더러는 인형을 **긴 변이 `radius × 2.3`이 되게** 그린다(`drawDoll`). 그래서 새 그림도 **투명 여백을 완전히 잘라내야** 인형이 지금과 같은 크기로 보인다. 여백이 남으면 인형이 작아 보이고 집게가 허공을 잡는 것처럼 보인다.
- 그림을 못 불러오면 🧸 이모지로 대신 그린다. 화면에 🧸가 보이면 그림 연결이 잘못된 것이다.

### 2-2. 종류별 크기·무게

`shared/claw-physics.ts`:

```ts
export const DOLL_TYPES = 11;
export const DOLL_WEIGHT = Object.freeze([1, 1, .9, 1.15, .85, 1.05, .95, 1.2, .8, 1.1, .9, 1]);
export const DOLL_RADIUS = Object.freeze([32, 32, 30, 34, 29, 33, 31, 35, 28, 33, 30, 32]);
```

배열의 0번 칸은 쓰지 않는다(type은 1부터). 즉 지금 슬롯은:

| type | 반지름 | 무게 | 느낌 |
| ---: | ---: | ---: | --- |
| 1 | 32 | 1 | 보통 |
| 2 | 30 | .9 | 조금 작고 가벼움 |
| 3 | 34 | 1.15 | 크고 무거움 |
| 4 | 29 | .85 | 작고 가벼움 |
| 5 | 33 | 1.05 | 조금 큼 |
| 6 | 31 | .95 | 보통 |
| 7 | 35 | 1.2 | **가장 크고 무거움** |
| 8 | 28 | .8 | **가장 작고 가벼움** |
| 9 | 33 | 1.1 | 크고 무거움 |
| 10 | 30 | .9 | 조금 작고 가벼움 |
| 11 | 32 | 1 | 보통 |

새 인형 k번째 그림은 type k 슬롯의 크기·무게를 그대로 받는다. 그래서 **원본 파일 번호 = type 번호**다(3-1절).

### 2-3. 이미 쌓여 있는 기계 (중요)

- 플레이어마다 기계가 하나씩 있고, 쌓인 인형 30개가 DB(`claw_accounts.board_json`)에 `{ id, type, x, y, radius, angle }`로 저장되어 있다. 지난 플레이 결과(`claw_plays.result_json`)에도 뽑은 인형의 `type`이 남아 있다. 미리보기 모드는 브라우저 저장소에 판을 둔다.
- **이 저장된 판은 그대로 둔다.** 다 뽑으면 다음 기계부터 새 종류 수(N)로 만들어진다.
- 그래서:
  - N > 11이면: 지금 기계에는 type 1~11만 있으므로 새 인형 1~11번 그림으로 보인다. type 12~N은 다음 기계부터 나온다. 추가 처리 필요 없음.
  - N < 11이면: 저장된 판에 type N+1~11 인형이 남아 있는데 그 그림 파일은 없어진다. **그림만** 범위 안 번호로 접어서 보여 준다(3-3절의 `dollSprite`). 물리(크기·무게)는 저장된 값과 기존 배열 값 그대로 쓴다.
- 서버가 판을 계산하고 브라우저가 같은 엔진으로 재생해서 결과를 맞춘다. 물리 값이 한쪽만 바뀌면 재생이 어긋난다. 그래서 **기존 type 1~11의 크기·무게는 절대 바꾸지 않는다.**

### 2-4. 원본 엔진 대조 테스트

`tests/claw-physics.test.ts`는 240가지 경우에 대해 **우리 `createBoard`·`simulateAttempt` 결과가 원본 JS(`tests/fixtures/gatcha-physics.original.js`)와 JSON까지 똑같은지** 검사한다. 원본은 `DOLL_TYPES = 11`이 박혀 있으므로, N이 바뀌면 "생성된 판이 같다" 검사는 깨진다. 이 테스트를 어떻게 고칠지는 3-4절에 정해 두었다. 그 방식대로만 고친다.

### 2-5. 서비스 워커

`scripts/build-sw.mjs`가 빌드 결과 전체를 해시해서 캐시 이름을 만들고, `/claw/dolls/*.webp`는 전부 미리 받아 둔다. 그림을 바꾸면 캐시 이름이 자동으로 바뀌어 새 그림이 내려간다. **별도 캐시 처리 코드는 필요 없다.** 파일 이름 규칙(`doll-{type}.webp`)도 그대로 쓴다.

---

## 3. 작업 순서

브랜치는 최신 `main`에서 새로 딴다. 한 PR로 낸다.

### 3-1. 원본 받기·번호 정하기

1. 사용자가 준 원본을 저장소 **밖** 임시 폴더(예: `/tmp/claw-dolls-src/`)에 둔다. 압축 파일이면 거기서 푼다.
2. 번호 규칙:
   - 파일 이름에 번호가 있으면(`1.png`, `doll-03.png`, `인형_7.jpg` 등) 그 번호를 type으로 쓴다.
   - 번호가 없으면 **파일 이름 오름차순**으로 1, 2, 3… 을 매기고, 보고서에 "type ↔ 원본 파일 이름" 표를 꼭 적는다. 사용자가 순서를 바꾸고 싶으면 다시 돌리면 된다.
   - 번호가 빠지거나 겹치면(예: 1, 2, 4) 멈추고 묻는다.
3. N을 센다. N이 1~30 범위가 아니면 멈추고 묻는다.

### 3-2. 그림 준비 스크립트: `scripts/prepare-claw-dolls.py` 고쳐 쓰기

기존 스크립트는 투명 PNG `gatcha-1~11.png`만 받는다. 이것을 **배경 있는 원본 N장**을 받도록 고친다. 같은 파일을 고치고, 새 스크립트를 따로 만들지 않는다.

사용법(목표):

```sh
python3 scripts/prepare-claw-dolls.py /tmp/claw-dolls-src [--output public/claw/dolls] [--preview /tmp/claw-dolls-preview]
```

처리 순서(장마다):

1. **원본은 읽기만 한다.** 덮어쓰지 않는다.
2. **배경 제거.** `scripts/cutout-characters.py`의 방식(테두리 색의 중앙값을 배경색으로 보고, 테두리에서 시작해 배경색과 가까운 픽셀만 번지듯 채우는 flood fill, 밝기·색차 둘 다 사용, 경계 살짝 부드럽게)을 참고해서 만든다. 아래를 지킨다.
   - **바닥 그림자는 남기지 않는다.** (`cutout-characters.py`는 바닥 그림자를 살리지만, 인형뽑기 렌더러는 그림자를 직접 그린다. 그림자가 그림에 남으면 이중 그림자가 되고 인형이 떠 보인다.)
   - 인형과 이어지지 않은 작은 조각(섬)은 지운다. 알파 24 이하의 옅은 잡티는 0으로 만든다.
   - **인형 안쪽의 흰색·밝은 부분(눈, 배, 리본 등)을 지우지 않는다.** 테두리와 이어진 배경만 지운다. 팔과 몸 사이처럼 배경이 갇힌 구멍은 기본적으로 건드리지 않는다. 눈으로 봐서 배경이 분명하게 남은 장만, 그 장에만 적용되는 설정으로 처리하고 보고서에 적는다.
   - 장마다 허용 오차가 달라야 하면, 스크립트 안에 **type별 설정 표**(예: `OVERRIDES = {4: {"tol": 20}}`)를 두고 이유를 주석으로 적는다. 장마다 손으로 지우는 작업은 하지 않는다(다시 돌렸을 때 같은 결과가 나와야 한다).
   - 원본이 이미 진짜 투명(알파 있음)이면 배경 제거를 건너뛴다.
   - 배경이 **체크무늬(가짜 투명 무늬)**거나, 그라데이션·무늬·사진 배경이라 깔끔히 안 지워지면 그 장은 만들지 말고 멈춰서 어떤 파일인지 보고한다.
3. **투명 여백을 끝까지 자른다**(알파 > 0인 영역의 bbox로 crop). 결과의 알파 bbox가 이미지 전체여야 한다.
4. **긴 변 320px**로 Lanczos 축소, 종횡비 유지. (원본이 320보다 작으면 키우지 말고 멈춰서 보고한다.)
5. WebP 저장: RGB `quality=85`, `alpha_quality=100`, `method=6`, `exact=True` (기존과 같음). 저장 후 다시 읽어 크기와 알파 채널이 그대로인지 검사한다(기존 스크립트의 검사 유지).
6. 장당 **40,000바이트 이하**. 넘으면 실패시키고 보고한다(품질을 몰래 낮추지 않는다).
7. 출력은 `public/claw/dolls/doll-1.webp` ~ `doll-N.webp`. **N < 11이면 `doll-(N+1).webp` ~ `doll-11.webp`는 지운다.** 폴더에 `doll-1~N` 외의 파일이 남지 않게 한다.
8. `--preview` 폴더(저장소 밖)에 **확인용 모아보기 이미지**를 만든다: 모든 인형을 ① 기계 배경색 `#E3F1FC` 위, ② 어두운 색(`#3A3340`) 위, ③ 체크무늬 위에 나란히 놓은 그림. 배경 찌꺼기·흰 테두리·구멍을 눈으로 확인하는 용도다. 이 파일은 커밋하지 않는다.
9. 기존처럼 표준출력에 Pillow·libwebp 버전, type별 원본 파일 이름·원본 바이트·WebP 바이트·크기, 합계를 찍는다.

스크립트 맨 위 docstring도 새 사용법에 맞게 고친다.

### 3-3. 코드 수정 (이 범위만)

**(a) `shared/claw-physics.ts`**

- `DOLL_TYPES = N`.
- `DOLL_WEIGHT`, `DOLL_RADIUS`:
  - **앞의 12칸(0번~11번)은 지금 값 그대로 둔다.** N < 11이어도 지우지 않는다(저장된 판의 type 12 미만 인형이 계속 이 값을 쓴다).
  - N > 11이면 type 12~N 칸을 뒤에 붙인다.
    - 무게: **모두 `1`**. (원본 엔진은 모르는 type의 무게를 1로 본다. 1이어야 원본 대조 테스트가 새 판에서도 맞는다.)
    - 반지름: type 1~11의 반지름 순서를 반복한다. type t의 반지름 = `DOLL_RADIUS[((t - 12) % 11) + 1]` → 12번부터 32, 30, 34, 29, 33, 31, 35, 28, 33, 30, 32, 32, 30… . 계산식을 코드에 쓰지 말고 숫자를 배열에 그대로 적는다. 모든 값은 `MAX_RADIUS`(36) 이하여야 한다.
  - 주석 `(1..11)`을 실제 범위에 맞게 고친다.
- 그림 번호를 정하는 함수를 하나 추가해 export한다:

  ```ts
  /** Saved boards may hold types from an older, larger set; fold them onto today's sprites. Display only. */
  export const dollSprite = (type: number) => Number.isInteger(type) && type >= 1 ? 1 + (type - 1) % DOLL_TYPES : 1;
  ```

  물리 계산(`simulateAttempt` 등)에서는 **쓰지 않는다.** 그림 고를 때만 쓴다.

**(b) `src/claw/render.ts`**

- `dollSrc(type)`가 `doll-${dollSprite(type)}.webp`를 돌려주게 한다.
- `drawDoll`에서 스프라이트를 고를 때 `sprites[d.type]` 대신 `sprites[dollSprite(d.type)]`를 쓰고, 그림 캐시 키도 그림 번호 기준(`${dollSprite(d.type)}:${radius}`)으로 한다. `image.onload`의 캐시 무효화가 이 키 앞부분과 맞는지 확인한다.
- 그 밖의 렌더링 코드는 건드리지 않는다.

**(c) `src/screens/Claw.tsx`**

- 결과 창 `<img alt={`뽑은 인형 ${doll.type}번`}>`의 번호를 `dollSprite(doll.type)`로 바꾼다. 다른 것은 그대로. (안내 문구의 `{DOLL_TYPES}종`은 상수를 따라 자동으로 바뀐다.)

**(d) `scripts/build-sw.mjs`**

- 주석 `all 11 /claw/dolls/*.webp`의 숫자만 고친다(예: "all doll sprites"). 동작은 바꾸지 않는다.

### 3-4. 테스트 수정

**(a) `tests/claw-physics.test.ts`** — 원본 대조를 유지하는 방식으로 고친다. fixture 파일은 건드리지 않는다.

- blob SHA 테스트는 그대로.
- 240개 경우마다 아래 두 가지를 검사한다(입력 `input`을 만드는 방식은 지금 코드 그대로):
  1. **저장된 옛 판:** `const oldBoard = original.createBoard(g, s)`에 대해 `simulateAttempt(oldBoard, input, {record:true})`와 `original.simulateAttempt(oldBoard, input, {record:true})`의 JSON이 같다. (이미 쌓여 있는 기계가 예전과 똑같이 움직인다는 보장.)
  2. **새 판:** `const board = createBoard(g, s)`에 대해 `simulateAttempt(board, …)`와 `original.simulateAttempt(board, …)`의 JSON이 같다.
  3. 기존의 프레임 수 범위 검사(`> 0`, `<= 1024`)는 둘 다 유지.
- `createBoard`에 대해 따로 검사를 추가한다: 30개, id 중복 없음, 모든 type이 1~N 정수, 각 인형 `radius === DOLL_RADIUS[type]`, 같은 (세대, 시드)면 같은 판, 240개 경우를 합치면 1~N이 모두 한 번 이상 나온다.
- `createBoard(새) === original.createBoard(옛)` 검사는 N이 11이 아니라서 성립할 수 없으므로 이 검사만 빼고, 위 검사로 대신한다. 빼는 이유를 주석으로 한 줄 남긴다.
- `dollSprite` 테스트: 1~N은 자기 자신, N+1 → 1, 11 → `1 + 10 % N`, 0·음수·소수 → 1.

**(b) `tests/integration.test.ts`** — `doll.type <= 11`을 `doll.type <= DOLL_TYPES`(import)로.

**(c) `tests/e2e/claw.spec.ts`** — 미리 받아 둔 인형 그림 수 `toBe(11)`을 N으로.

**(d) `tests/claw-render.test.ts`** — 저장된 판에 type이 N보다 큰 인형(예: N < 11이면 type 11, N > 11이면 이 항목은 type N+1)이 있어도 🧸 대신 그림으로 그려진다는 경우를 하나 추가한다. 기존 테스트 기대값은 바꾸지 않는다.

`tests/e2e/catchmind-pr4.spec.ts`는 `/claw/dolls/doll-1.webp`를 아무 그림으로 쓸 뿐이다. `doll-1.webp`는 계속 있으므로 건드리지 않는다.

### 3-5. 문서

- `docs/asset-provenance.md`의 맨 위 **「캐릭터 뽑기 인형 이미지 출처」** 절을 새 그림 기준으로 다시 쓴다. 다른 절은 건드리지 않는다. 담을 것:
  - 사용자가 YYYY-MM-DD(작업일, KST)에 제공한 배경 있는 이미지 N장, 지인용 비공개 서비스 전용. 원본은 저장소에 없음.
  - 처리 방법(배경 제거 방식, 그림자 제거, 여백 자르기, 긴 변 320px, WebP 설정), type별 설정 표를 쓴 장과 이유.
  - 제작 환경(Python, Pillow, libwebp 버전).
  - type ↔ 원본 파일 이름 ↔ 원본 크기·바이트 ↔ WebP 바이트·크기 표와 합계.
  - 재생성 명령.
  - 이전 11종은 커밋 히스토리에 있다는 한 줄(이전 절 내용의 출처 커밋을 남긴다).
- `docs/decisions.md`의 캐릭터 뽑기 관련 결정 근처에 한 줄 추가: 인형을 N종으로 교체, 저장된 판은 유지하고 그림만 `dollSprite`로 접어 보여 줌, 기존 type 1~11의 크기·무게 유지, 새 type은 무게 1.
- `README.md`, `docs/plan-claw.md`, `docs/phase6-validation.md`의 "11종"은 당시 기록이므로 **고치지 않는다.**

### 3-6. 공지 (`shared/notices.ts`)

이 저장소 규칙(`CLAUDE.md`)에 따라 플레이어가 느끼는 변화이므로 공지를 쓴다.

- `NOTICES` 배열 **맨 위**에 추가. `date`는 작업일 KST `YYYY-MM-DD`, `id`는 `YYYY-MM-DD-new-claw-dolls`.
- **같은 날짜의 공지가 이미 맨 위에 있으면** 새 글을 만들지 말고 그 글의 `items`에 항목을 하나 더한다(`id`는 그대로).
- 플레이어가 읽는 글이다. 파일·코드·DB 같은 기술 내용은 쓰지 않는다. 간략하게. 예시(N에 맞게 숫자만 바꿔 쓴다):

  ```ts
  {
    id: 'YYYY-MM-DD-new-claw-dolls',
    date: 'YYYY-MM-DD',
    title: '캐릭터 뽑기에 새 인형들이 들어왔어요',
    summary: '뽑기 기계 속 인형이 새 얼굴 N종으로 바뀌었어요.',
    items: [
      { title: '새 인형 N종',
        body: '기계 속 인형 그림이 모두 새 인형으로 바뀌었어요. 뽑는 방법과 보상은 그대로예요.' },
      { title: '지금 기계도 그대로',
        body: '이미 쌓여 있던 인형은 그 자리 그대로 새 그림으로 보여요. 다 뽑으면 다음 기계부터 새 인형 N종이 골고루 섞여 나와요.' },
    ],
  },
  ```

  (N > 11일 때 두 번째 항목의 "다음 기계부터 새 인형 N종이 골고루 섞여 나와요"가 정확하다. N < 11일 때도 문장은 그대로 써도 맞다.)

---

## 4. 바꿔도 되는 파일 (이 목록 밖은 바꾸지 않는다)

| 파일 | 바꿀 내용 |
| --- | --- |
| `public/claw/dolls/doll-*.webp` | 새 그림 N장으로 교체, 남는 번호 삭제 |
| `scripts/prepare-claw-dolls.py` | 배경 제거·여백 자르기·N장 처리 |
| `shared/claw-physics.ts` | `DOLL_TYPES`, `DOLL_WEIGHT`·`DOLL_RADIUS` 뒤에 붙이기, `dollSprite` 추가, 관련 주석 |
| `src/claw/render.ts` | `dollSrc`, `drawDoll`의 그림 고르기·캐시 키 |
| `src/screens/Claw.tsx` | 결과 창 `alt` 번호 |
| `scripts/build-sw.mjs` | 주석 숫자 |
| `tests/claw-physics.test.ts` | 3-4 (a) |
| `tests/integration.test.ts` | type 범위 한 줄 |
| `tests/e2e/claw.spec.ts` | 그림 수 |
| `tests/claw-render.test.ts` | 옛 type 그림 테스트 추가 |
| `docs/asset-provenance.md` | 인형 절 교체 |
| `docs/decisions.md` | 결정 한 줄 |
| `shared/notices.ts` | 공지 |

---

## 5. 검증 (전부 하고 결과를 보고한다)

1. `npm run check` (타입 검사 + 단위·통합 테스트 + 빌드) 통과.
2. `npx playwright test tests/e2e/claw.spec.ts tests/e2e/claw-pr5.spec.ts --trace off` 통과. 시간이 되면 `npm run test:e2e` 전체.
3. 빌드 로그의 `PWA precache` 줄에서 정적 파일 수가 (이전 수 − 11 + N)인지 확인.
4. `public/claw/dolls/`에 `doll-1.webp`~`doll-N.webp`만 있는지, 각 파일 알파 bbox가 이미지 전체인지, 긴 변 320px인지, 40,000바이트 이하인지 확인.
5. **눈으로 확인:**
   - 3-2의 모아보기 이미지 3장(밝은 배경·어두운 배경·체크무늬)을 직접 보고, 배경 찌꺼기·흰 테두리(헤일로)·인형 안쪽이 뚫린 곳·그림자 잔재가 없는지 확인한다.
   - 미리보기 기계 화면(`/#/preview/play/claw`, 서버 없이 동작)을 폭 390px로 스크린샷 찍어 확인한다: 🧸가 없고, 인형 크기가 지금 기계와 비슷하고(너무 작거나 크지 않음), 한 판 뽑아서 결과 창에 새 인형 그림이 나온다.
   - 문제가 보이면 3-2의 type별 설정으로 고치고 다시 확인한다. 고칠 수 없으면 숨기지 말고 보고한다.

---

## 6. 완료 보고 형식

PR 설명(또는 작업 보고)에 아래를 적는다.

1. N과 **type ↔ 원본 파일 이름 표** (사용자가 순서를 확인할 수 있게, 2-2절의 크기·무게 느낌도 같이).
2. type별 원본 크기·바이트, WebP 크기·바이트, 합계.
3. type별 설정(`OVERRIDES`)을 쓴 장과 이유.
4. 모아보기 이미지와 기계 화면 스크린샷 첨부.
5. 실행한 검증 명령과 결과(통과/실패 수). 실패가 있으면 출력 그대로.
6. 하지 못한 것, 애매해서 사용자 판단이 필요한 것.

## 7. 멈추고 물어볼 때

- 원본 장수·번호가 이상할 때(빠진 번호, 겹치는 번호, 30장 초과).
- 배경을 깔끔하게 못 지우는 장이 있을 때(체크무늬 가짜 투명, 무늬 배경, 인형과 배경색이 거의 같음).
- 원본이 너무 작거나(긴 변 320px 미만) WebP가 40,000바이트를 넘을 때.
- 이 문서의 "바꿔도 되는 파일" 밖을 바꿔야 할 것 같을 때.
- 테스트가 이 문서에 적은 방법으로 고쳐지지 않을 때(특히 원본 엔진 대조).
