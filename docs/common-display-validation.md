# 공통 표시 정리 검증 — 2026-11-04 KST

대상은 [개선 지시서](plan-update-2026-11-04.md)의 PR 1 (§1-1~1-3)이다. `claude/intelligent-bardeen-zffzu0`에서 진행했으며, 새 마이그레이션과 게임 경제·정산 규칙 변경은 없다.

## 구현과 확인 범위

- 이름표·예측 결과·캐치마인드·갤러리·랭킹·아바타 alt·당첨 배너에 공통 `honorific`를 적용했다. 닉네임 입력값과 로그인 아이디는 원본을 유지하며, 원래 닉네임이 `별님`인 경우에도 표시용 접미사를 붙여 `별님님`으로 표시한다.
- 공통 날짜·시각 함수는 KST와 두 자리 숫자를 사용한다. 날짜만/시각만 있는 값은 이미 KST인 것으로 처리하고, ISO 타임스탬프는 KST로 변환한다. UTC 자정·연도 변경, 오프셋 있는/없는 ISO를 검사했다. API와 입력값·기간 카운트다운은 그대로 유지한다.
- 모든 모달이 `openSheet`를 사용한다. 이동 애니메이션은 dialog 자체에 적용하고, 내부 콘텐츠의 원래 스크롤을 유지한다. 스크롤 잠금은 현재 위치에 body를 고정하되 기존 데스크톱 스크롤바를 유지한다(`scrollbar-gutter`만으로는 Chromium의 clientWidth 변화를 막지 못함). 종료 시 애니메이션·잠금·기존 스타일·스크롤 위치·포커스를 정리한다. 다른 경로로 이동한 경우에는 이전 스크롤 위치 대신 새 화면의 맨 위를 유지하며, 이전 close 이벤트가 다시 열린 dialog를 닫지 않도록 처리한다.
- 긴 한글 시각을 위해 예측 정답·결과 카드·지난 기록의 좁은 화면 레이아웃을 조정했다. 이펙트 레이어는 clip하고 긴 토스트는 화면 안에서 줄바꿈한다.

## 자동 검증

환경: Node 24.19.0, Chromium 154.0.8037.57, 로컬 Miniflare/D1. 테스트 시각은 기존 E2E fixture의 2026-10-30 09:00 KST이며, 일부 기존 운영·런칭 시나리오는 별도 로컬 날짜와 DB를 사용한다.

- `npm run check`: 타입 검사, Vitest **618개(11개 파일)**, 프로덕션 빌드 통과. 기존 통합 테스트 263개가 입력·저장·보상·마감·원장 멱등성을 계속 검사한다. 표시 변경이므로 별도의 서버 규칙 테스트는 추가하지 않았다.
- `CHROMIUM_PATH=/usr/bin/chromium npm run test:e2e`: 전체 수집된 **74개 통과**. 이후 추가한 뒤로 가기 검사까지 포함해 별도 포트에서 시트 스펙 3개를 다시 통과했다(중복 제외 총 **75개 시나리오**). 인증·미리보기·운영·사진·출석·상점·갤러리·뽑기·비밀번호·오프라인 흐름을 포함한다.
- `tests/format.test.ts`: 날짜/시각 형식과 KST 자정·연도 경계 검사.
- `tests/e2e/common-display.spec.ts`: **3개 통과**. 브라우저 시간대를 `America/Los_Angeles`로 설정해 KST가 유지되는지, 서버 없는 미리보기, 닉네임 원본 입력/표시 분리, 실제 프로필 내역, 모달 닫기와 스크롤 잠금을 확인했다.
- `tests/e2e/sheet-scroll.spec.ts`: **3개 통과**. Chromium의 숨긴 스크롤바 옵션을 해제하고 16px 실제 스크롤바가 있는 상태에서 쿠지·컬러 피커·비밀번호 시트의 매 프레임 너비와 넘침을 측정했다. 배경 스크롤 차단·위치/스타일/포커스 복원, 사진 시트가 겹친 경우의 잠금 유지, 낮은 화면에서의 실제 내용 스크롤과 재열기, 스크롤한 모달에서 브라우저 뒤로 가기 후 새 화면이 맨 위로 열리는 것도 검사했다.
- `wrangler deploy --dry-run`: 로컬 번들·자산·바인딩 검사 통과. 실제 배포는 실행하지 않았다.
- 지정 닉네임 조사 검색과 `git diff --check`: 이상 없음.

빌드의 500kB 초과 청크 경고는 남아 있다(JS 약 504kB, gzip 약 164kB). 코드 분할·무료 플랜 최적화는 지시서의 PR 2 범위다.

## 화면 증거

각 화면은 폰트·이미지와 유한 애니메이션이 끝난 뒤 캡처했다. 일시적인 당첨 배너는 닫고 화면 본문을 기록했다.

| 화면 | 390px | 560px |
| --- | --- | --- |
| 미리보기 홈 | [이미지](screenshots/update-pr1-preview-home-390.png) | [이미지](screenshots/update-pr1-preview-home-560.png) |
| 초 단위 예측 결과·지난 기록 | [이미지](screenshots/update-pr1-preview-prediction-result-390.png) | [이미지](screenshots/update-pr1-preview-prediction-result-560.png) |
| 쿠지 모달 | [이미지](screenshots/update-pr1-preview-kuji-modal-390.png) | [이미지](screenshots/update-pr1-preview-kuji-modal-560.png) |
| 로그인 후 프로필·내역 | [이미지](screenshots/update-pr1-authenticated-profile-390.png) | [이미지](screenshots/update-pr1-authenticated-profile-560.png) |

## 반영 순서

Draft PR 리뷰 → main 머지 → 운영자가 배포한다. PR 2는 이 PR의 main 머지를 확인한 뒤 시작하며, 이번 작업에서 원격 DB 변경·머지·배포는 하지 않는다.
