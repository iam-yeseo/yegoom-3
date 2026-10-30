# 디자인 기준

사용자가 제공한 `예굼방 게임 화면.html`은 9개 휴대전화 화면을 나열한 디자인 캔버스다. 원본은 custom template/runtime으로 묶여 있어 HTML·스타일·로컬 폰트·이미지를 복원한 뒤 React 컴포넌트로 구현했다. 해당 런타임이나 외부 스크립트를 서비스에 넣지 않았다.

기상시간 입력, 행운 점수 입력, 퇴근 결과, 캐치마인드 맞히기/결과/그리기, 쿠지, 뽑기/성공 화면을 기준으로 삼았다. 홈(아침/저녁)·하단 탭·랭킹·출석·내 정보·주식·로또·스피또는 Claude Design 내보내기의 `Yegoom Arcade Home`, `Yegoom Ranking & Me`, `Yegoom Stock & Shop` 시안을 따른다. 시안에 없는 로그인, 게임 탭, 상점 탭 첫 화면만 같은 규칙으로 구성했다. 시안의 샘플 값(보상, 배점, 가격, 실패 횟수 등)은 `src/sample.ts`의 `BALANCE`에 모았다. 실제 휴대전화에서는 OS 상태바가 표시되므로 원본의 가짜 9:41·배터리 영역은 앱 내부에 중복해서 넣지 않았다.

| 요소 | 기준 |
| --- | --- |
| 글꼴 | Pretendard Variable, 로컬 WOFF2 |
| 바탕 | `#FFF9EE` |
| 본문/보조 | `#3A3340` / `#7C7383` |
| CTA | `#F47C66`, 높이 56px, radius 20px |
| 카드 | 흰색, radius 24px, `0 6px 24px rgba(120,90,60,.06)` |
| 민트 | `#E3F6EE` / `#8FD9C0` / `#2E8C6E` |
| 코랄 | `#FFE6DF` / `#FF8E7A` / `#C9533E` |
| 보라 | `#EEE8FC` / `#B9A3F0` / `#7556C4` |
| 노랑 | `#FFF4CC` / `#FFD866` / `#94700A` |
| 파랑 | `#E3F1FC` / `#8CC8F2` / `#3B7FB3` |
| 기준 폭 | 390px, 좁은 화면에도 맞춤 |
| 본문 여백 | 16px, 카드 간격 12px |
| 제목/카운트다운 | 17px 800 / 44px 800 |

캐릭터 8종의 원본은 크림색 배경의 1254px RGB 이미지다. 시안처럼 `mix-blend-mode:multiply`로 배경을 녹이면 색이 있는 배경 위에서 네모 테두리가 드러나므로, `scripts/cutout-characters.py`로 배경을 투명하게 오리고 바닥 그림자만 반투명으로 남긴 640px PNG를 `public/characters`에 넣었다. 캐릭터 그림 자체는 수정하지 않았다. 파일 이름은 시안과 같다(`bread`, `monkey` 등). 현재 애니메이션은 CSS의 가벼운 움직임이며 `prefers-reduced-motion`을 지원한다. 최종 투명 캐릭터나 Rive/Lottie는 후속 작업이다.

Pretendard 라이선스는 `public/fonts/OFL.txt`에 포함한다. 캐릭터는 사용자 제공 자료로서 별도 재배포 라이선스를 임의 부여하지 않는다. 앱 아이콘은 별도 SVG로 만들었으며 `scripts/build-icons.mjs`로 PNG를 재생성할 수 있다.
