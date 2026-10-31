# 디자인 기준

사용자가 제공한 `예굼방 게임 화면.html`은 9개 휴대전화 화면을 나열한 디자인 캔버스다. 원본은 custom template/runtime으로 묶여 있어 HTML·스타일·로컬 폰트·이미지를 복원한 뒤 React 컴포넌트로 구현했다. 해당 런타임이나 외부 스크립트를 서비스에 넣지 않았다.

기상시간 입력, 행운 점수 입력, 퇴근 결과, 캐치마인드 맞히기/결과/그리기, 쿠지, 뽑기/성공 화면을 기준으로 삼았다. 홈(아침/저녁)·하단 탭·랭킹·출석·내 정보·주식·로또·스피또는 Claude Design 내보내기의 `Yegoom Arcade Home`, `Yegoom Ranking & Me`, `Yegoom Stock & Shop` 시안을 따른다. 시안에 없는 로그인, 게임 탭, 상점 탭 첫 화면만 같은 규칙으로 구성했다. 시안의 샘플 값(보상, 배점, 가격, 실패 횟수 등)은 `src/sample.ts`의 `BALANCE`에 모았다. 실제 휴대전화에서는 OS 상태바가 표시되므로 원본의 가짜 9:41·배터리 영역은 앱 내부에 중복해서 넣지 않았다.

| 요소 | 기준 |
| --- | --- |
| 글꼴 | 티머니 둥근바람체(TmoneyRoundWind) Regular·ExtraBold. 한글·숫자·영문 모두 이 글꼴로 표시한다. `public/fonts`의 WOFF2는 기존 yegoom 레포의 파일(사용자가 제공한 `01_otf.zip`을 윤곽 그대로 압축한 것)과 같다. 불러오는 동안은 Pretendard Variable |
| 바탕 | `#FFF9EE` |
| 본문/보조 | `#3A3340` / `#7C7383` |
| CTA | `#F47C66`, 높이 56px, radius 20px |
| 카드 | 흰색, radius 24px, `0 6px 24px rgba(120,90,60,.06)` |
| 민트 | `#E3F6EE` / `#8FD9C0` / `#2E8C6E` |
| 코랄 | `#FFE6DF` / `#FF8E7A` / `#C9533E` |
| 보라 | `#EEE8FC` / `#B9A3F0` / `#7556C4` |
| 노랑 | `#FFF4CC` / `#FFD866` / `#94700A` |
| 파랑 | `#E3F1FC` / `#8CC8F2` / `#3B7FB3` |
| 기준 폭 | 휴대전화에서는 화면 전체 폭, 600px 이상 화면에서는 560px 열(기존 yegoom과 같음)을 가운데 정렬 |
| 본문 여백 | 16px, 카드 간격 12px |
| 제목/카운트다운 | 17px 800 / 44px 800 |

캐릭터 8종은 사용자가 완성한 투명 RGBA 아트다. 원본은 Google Drive의 [YEGOOM 3/characterImg](https://drive.google.com/drive/folders/1PTne7e8qwR8GlWlDRXyHTMHcZ_MDo71O)에 읽기 전용으로 보관한다. 캐릭터마다 `idle`, `happy`, `sleepy`, `greet`, `jump` 시트가 하나씩 있으며, 각 시트는 1536×1024px, 3열×2행의 512×512px 칸 6개로 구성된다. 프레임 순서는 좌→우, 위→아래이며 발 기준선은 칸 안의 y=470이다. 공중 프레임과 포즈별 차이를 포함해 원본 위치를 그대로 유지한다.

`scripts/prepare-characters.py`는 칸을 자르고 이어 붙이거나 포맷을 변환할 뿐, 앱에 쓰는 프레임을 리샘플하거나 이동·보정하지 않는다. `idle`의 f0을 그대로 저장한 512px RGBA PNG 8장을 `public/characters/<key>.png`에, 6프레임을 가로로 이어 붙인 3072×512px WebP 40장을 `public/characters/sprites/<key>-<state>.webp`에 둔다. WebP는 RGB quality 85와 무손실 alpha를 사용한다. 키·캐릭터 이름·tint는 유지한다. 분리한 프레임, 미리보기 GIF, 검사 시트와 `manifest.csv`는 [characterImg_web](https://drive.google.com/drive/folders/1mtBQMxxZqBEpQ2uk532ZtcuBg98o8FER)에 보관한다.

`src/components/UI.tsx`의 `CharacterSprite`는 `background-position-x`를 `steps(6, jump-none)`으로 옮겨 6프레임을 같은 시간씩 표시한다. 재생 설정은 한 곳에 모은다.

| state | 길이 | 재생 |
| --- | --- | --- |
| `idle` | 1800ms | 반복 |
| `sleepy` | 2400ms | 반복 |
| `happy` | 1200ms | 반복 |
| `greet` | 900ms | 1회 후 기본 state로 복귀 |
| `jump` | 680ms | 1회 후 기본 state로 복귀 |

홈 방은 아침에 `greet` 후 `idle`, 저녁에 인사 없이 `sleepy`를 재생하며 탭하면 `jump` 후 해당 기본 state로 돌아온다. 예측 게임 히어로는 기존 지연 시간을 유지해 진입 인사와 공개 후 점프를 재생한다. 로그인 3마리는 `idle`을 0·−0.6·−1.2초 지연으로 시작하고, 랭킹 시상대는 착지 후 1위가 `happy`, 2·3위가 `idle`을 반복한다. 내 정보는 `idle`, 뽑기 성공 화면은 착지 후 `happy`를 반복한다. Avatar, 캐릭터 선택 그리드, 목록·배너·방 액자, 주식·상점·쿠지, 뽑기 기계 안과 집게의 인형은 정지 PNG를 사용한다.

스프라이트가 로드되기 전이나 FAIL 판정일 때는 정지 이미지를 표시하며, 1회 재생은 로드가 끝난 뒤 시작한다. `prefers-reduced-motion: reduce`에서는 f0 정지 이미지만 표시하고 1회 재생 완료 콜백을 바로 호출한다. 스프라이트에는 같은 의미의 `bob`·`sway`나 기존 인사·점프 모션을 겹치지 않는다. `dropIn`, 내 정보의 캐릭터 교체, `popIn`은 바깥 요소에서 유지한다. Rive/Lottie는 후속 작업이다.

Pretendard 라이선스는 `public/fonts/OFL.txt`에 포함한다. 캐릭터는 사용자 제공 자료로서 별도 재배포 라이선스를 임의 부여하지 않는다. 앱 아이콘은 별도 SVG로 만들었으며 `scripts/build-icons.mjs`로 PNG를 재생성할 수 있다.

## 모션

Claude Design의 `Yegoom Motion Spec`과 `yegoom-motion.js`를 `src/motion.ts`로 옮겼다. 토큰(시간 120–1200ms, `out`·`inOut`·`spring` 곡선), 기존 캐릭터 동작 함수, 컨페티·반짝이·코인·토스트는 이 파일에 유지한다. 위에서 정한 스프라이트 적용 위치의 인사·점프·반복 동작만 프레임 재생으로 바꾼다. 나머지 모션 규칙은 시안과 같다.

- `src/motion.ts`의 모션은 transform(scale·translate·rotate)과 opacity만 움직인다. 스프라이트는 안쪽 요소의 `background-position`만 움직이며, 레이아웃 속성은 애니메이션하지 않는다.
- 반복 모션은 위 표의 캐릭터 상태와 인형 운반 흔들림에 사용한다. 기존 축하 연출은 1.2초 이하, 컨페티는 화면당 한 번이다.
- `prefers-reduced-motion`이면 이동·크기·회전을 끄고 200ms 이하 페이드만 남긴다. 숫자는 바로 바뀌고 입자와 반복 모션은 없다.

시안과 다른 점: 하위 화면 push/pop은 새 화면만 움직인다(이전 화면은 바로 사라진다). 화면 전환에서 이전 화면을 함께 밀어내려면 라우터가 두 화면을 동시에 유지해야 해서 후속 작업으로 남겼다.

티머니 둥근바람체는 Regular(400)과 ExtraBold(800)만 있어 600 이하는 Regular, 700·800은 ExtraBold로 표시된다. 글꼴 파일의 라이선스는 배포처의 이용 약관을 따른다.
