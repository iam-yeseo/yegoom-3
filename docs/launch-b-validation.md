# 런칭 준비 PR B 검증

사용자의 PR #14 머지 알림과 main 반영을 확인하고 `2e66839b0307312432ec38fd4018750f6ea50bf0`에서 `codex/launch-b`를 만들었다. [PM 계획](plan-launch.md)의 PR B만 진행했다. 계획 원문은 PR A 첫 커밋에 이미 추가되어 있으며 수정하지 않았다. 원본 `iam-yeseo/yegoom`은 읽기만 했다.

## 1. 구현과 변경 파일

- `shared/profile.ts`, `worker/profile.ts`, `worker/photos.ts`, `worker/index.ts`: 닉네임 NFC·trim·grapheme 1~10글자와 활성 사용자 대소문자 무시 중복 검사, 사진 검증·저장·삭제·버전별 조회. 로그인 아이디는 유지한다. 삭제 후 재업로드도 예전 immutable 주소를 재사용하지 않는다.
- `src/components/PhotoPicker.tsx`, `src/image-processing.ts`, `src/screens/Profile.tsx`, `src/components/UI.tsx`, `src/App.tsx`, `src/api.ts`와 관련 CSS: EXIF 방향 반영, 정사각형 드래그·핀치·슬라이더 자르기, 512px·260KiB WebP/JPEG. 모든 원형 Avatar에 사진을 표시하고 큰 캐릭터는 유지한다. 계정 전환 시 편집 초안을 폐기하고 다른 계정 쿠키로 이전 계정의 프로필 요청을 보내면 거절한다.
- `shared/types.ts`, `worker/catchmind.ts`, `src/screens/Home.tsx`, `src/screens/Ranking.tsx`, `src/screens/Catchmind.tsx`, `src/screens/Stock.tsx`: 참여자·결과·답변의 닉네임과 사진 버전, 현재 닉네임의 전역 표시. 비활성화된 주식 화면도 이름 표시만 갱신한다.
- `shared/balance.ts`, `worker/announcements.ts`, `worker/shop.ts`, `src/AnnouncementBanner.tsx`, `src/announcements.css`: 스피또와 로또 1~3등 지급과 동일 batch에 고유 reference 알림을 생성한다. 최근 10분·최대 5건, 본인 제외, 사용자별 본 ID 저장, 4초 순차 배너·클릭 닫기·polite status·reduced motion 페이드.
- `worker/luck-photos.ts`, `src/components/PredictionGame.tsx`, `src/components/LuckEvidence.tsx`, `src/luck-evidence.css`, `src/sample.ts`: 행운 점수 새 정답 저장에 사진 필수, 공개 전 교체, 긴 변 1280px·440KiB로 축소, 공개 전 출제자만 조회, 오늘 결과와 최근 3판에서 확대 보기. 미리보기는 서버 없이 동작하며 가짜 당첨 배너는 없다.
- `migrations/0007_launch_profiles.sql`, `scripts/launch-profile-preflight.mjs`, 초기화 스크립트·런북·README·결정 문서 및 통합/E2E 테스트를 추가·갱신했다.

`username` 전체 검색에서 남긴 용도는 로그인 입력·인증, 출제자/본인 식별, 캐릭터 조회, React key, 저장소 키, API의 안정적인 계정 식별자다. 화면의 사람 이름과 출제자 표시는 `displayName`을 사용한다. 실제 이름이 없는 미리보기 샘플에서는 계정 이름을 초기 닉네임으로 사용한다.

원본 참고: `public/js/photo-picker.js` blob `352af6c20fd48dc638662aabe767bcf729b9b3f2`, `src/lib/util.js` blob `2e41c3a75b459e8c3e114ecf60a41a7b5e835e30`과 프로필·사진 라우트. 새 외부 런타임 의존성은 추가하지 않았다.

## 2. 마이그레이션과 운영 반영

**머지 전에 `npm run db:migrate:remote` 실행이 필요하다.** 새 파일은 `0007_launch_profiles.sql` 하나이며 기존 `0001`~`0006`은 수정하지 않았다. 활성 닉네임 유니크 인덱스, nullable `users.photo_version`, `user_photos`, `announcements`, `luck_photos`를 추가한다. 기존 배포가 사용하는 컬럼·테이블은 유지한다.

운영 순서는 리뷰 → 인증된 운영자 환경에서 읽기 전용 닉네임 사전 검사 → `0007` 적용 → 머지·배포다. `npm run db:migrate:remote`는 npm pre-hook으로 사전 검사를 자동 실행하며 중복·비정규 이름·조회 실패 시 멈춘다. 독립 점검은 `npm run launch:profiles:preflight:remote`다. 기존 닉네임을 자동으로 바꾸지 않는다.

운영 중복 조회는 Cloudflare 인증 토큰이 없어 완료하지 못했다. 개발 중 원격 마이그레이션·기록 초기화·머지·배포는 실행하지 않았다. 런칭 초기화는 운영자가 [런북](launch-runbook.md)에 따라 별도 실행한다. 기록 19개 테이블을 비우고 사용자 사진을 포함한 보존 테이블 5개와 세션·캐릭터·닉네임·사진 버전은 유지한다.

## 3. 검증

| 검증 | 결과 |
| --- | --- |
| `npm run check` | 통과: 타입 검사·548개 테스트(Worker·D1 통합 199개 포함)·빌드 |
| PR B 집중 E2E | 5/5 통과 (1.0분) |
| `npm run test:e2e` 최종 전체 실행 | 49/49 통과 (4.3분), 재시도 없음 |
| `git diff --check` | 통과 |

최종 빌드의 PWA 지문은 `yegoom3-8ff37817daa0`이며 전체 E2E에 사용한 빌드와 같다. 관리형 기본 샌드박스에서 Node 자식 프로세스 출력 캡처가 `EPERM`으로 실패한 검사는 중단하고, 자식 프로세스 실행을 허용한 환경에서 전체 명령을 다시 실행해 통과했다. 이 검증은 로컬 D1과 가짜 원격 CLI만 사용하며 운영 DB를 수정하지 않는다.

브라우저 테스트 5개는 실제 EXIF 방향 6 JPEG의 픽셀 방향·512px 결과, 자르기 드래그/핀치/슬라이더/키보드, 다른 사용자의 닉네임·사진 반영과 삭제 복귀, 계정 전환 시 초안 폐기, 행운 사진 공개 권한·최근 3판·확대 창, 서버 없는 미리보기, 4초 알림 순서·본인 제외·본 ID 저장·reduced motion 페이드를 검증한다. 사진 API가 서비스 워커 캐시에 들어가지 않는지도 확인한다.

기존 E2E는 필수 증거 사진을 첨부하도록 갱신하고, 새 닉네임 문구·여러 status 요소·지연 로딩 썸네일에 맞춰 검사 대상을 명확히 했다. 캐치마인드 제시어에 공백이 있을 때 힌트 길이를 잘못 계산하던 기대값도 공백을 제외하는 기존 규칙에 맞췄다. 화면 캡처는 유한한 등장 애니메이션과 이미지 디코딩이 끝난 뒤 수행하고, 프로필 입력칸/버튼의 카드 내 배치와 결과 카드의 불투명도를 확인한다.

추가 통합 테스트 27개는 아래를 검증한다.

- 닉네임 NFC·공백·grapheme·허용 문자·길이, 로그인 아이디 유지, 동시 대소문자 중복, 비활성 이름 재사용과 충돌하는 재활성화 거절.
- WebP/JPEG 사진 실제 바이트, 로그인 401, 형식·크기·정사각형·512px 제한, 교체/삭제/재업로드와 동시 버전 증가, 다른 사용자 bootstrap·결과·캐치마인드 반영, 폴링 본문 제외, 계정 전환 요청 거절과 데이터 보존.
- 행운 사진 없는 새 정답 거절, 출제자·관리자·비활성 권한, 공개 전 403·공개 후 200, 날짜·자동/조기 공개·교체 경계, 버전·캐시 헤더·크기 제한, 과거 사진 없는 판 호환.
- 스피또 당첨/낙첨, 로또 1~3등만 알림, 재시도·동시 정산 중복 방지, 알림 INSERT 실패 시 지급까지 롤백, 본인·정확히 10분 지난 항목·미래 항목 제외, 최신 닉네임·최대 5개·인덱스 읽기량.

초기화·마이그레이션 테스트 5개는 기존 스키마 호환, 활성 닉네임 충돌 시 마이그레이션 롤백, 19개 기록 삭제·5개 테이블 모든 값 보존(사진 BLOB 포함), 포인터 초기화·원래 트리거 복구·원자적 실패 롤백과 초기화 후 첫 게임을 검증한다. 사전 검사 테스트 18개는 가짜 Wrangler만 사용해 중복/정규화/인증 실패·잘못된 응답·새 DB를 검사하며 원격 쓰기를 하지 않는다.

로컬 D1 `meta.rows_read` 실측:

| 요청·범위 | 읽은 행 |
| --- | ---: |
| `PUT /api/me/profile`, 인증 포함 | 6 |
| `PUT /api/me/photo`, 인증 포함 | 9 |
| `GET /api/users/:id/photo?v=N`, 인증 포함 | 5 |
| `DELETE /api/me/photo`, 인증 포함 | 8 |
| `PUT /api/games/luck/photo`, 인증 포함 | 5 |
| `GET /api/games/luck/rounds/:date/photo?v=N`, 출제자 인증 포함 | 4 |
| bootstrap 당첨 알림 모듈, 최근 타인 5건 | 10 |
| 같은 모듈, 만료 기록 200건 추가 후 | 10 |
| 같은 모듈, 최근 본인 당첨 200건 | 5 |

API 수치는 기존 원장 기록이 없는 계정에서 측정했다. 프로필 변경 응답의 잔액 합산 등은 해당 계정의 기록 수에 따라 늘 수 있다. 알림 수치는 전체 bootstrap의 인증·다른 게임 조회를 제외한다. 최신 전역 5건을 인덱스로 먼저 제한한 뒤 본인을 제외하므로 본인 당첨이 섞이면 반환 수가 5개보다 적다. 계측은 테스트 번들에만 있다.

사진 응답은 `Cache-Control: private, max-age=31536000, immutable`·`Vary: Cookie`, 오류·JSON은 no-store다. bootstrap·게임·기록에는 이미지 본문을 넣지 않고 서비스 워커는 모든 `/api`를 캐시하지 않는다.

## 4. 화면

실제 로그인과 서버 없는 미리보기에서 390px·560px를 확인하고 아래 26장을 촬영했다. 기존 99장 스크린샷은 SHA256이 모두 원본과 같다. 사진은 테스트에서 생성한 예시 이미지이며 실제 개인정보를 사용하지 않는다. 배너는 로컬 테스트 DB의 당첨 기록과 실제 정산으로 생성한 알림을 사용한다. 랭킹 사진은 원형 Avatar를 사용하는 홈의 주간 랭킹 목록에서 확인하고, 별도 랭킹 시상대는 캐릭터가 유지되는지도 검사한다.

| 화면 | 실제 390px | 실제 560px | 미리보기 390px | 미리보기 560px |
| --- | --- | --- | --- | --- |
| 내 정보·닉네임 | [보기](screenshots/launch-b-authenticated-profile-390.png) | [보기](screenshots/launch-b-authenticated-profile-560.png) | [보기](screenshots/launch-b-preview-profile-390.png) | [보기](screenshots/launch-b-preview-profile-560.png) |
| 사진 자르기 | [보기](screenshots/launch-b-authenticated-crop-390.png) | [보기](screenshots/launch-b-authenticated-crop-560.png) | [보기](screenshots/launch-b-preview-crop-390.png) | [보기](screenshots/launch-b-preview-crop-560.png) |
| 랭킹 사진 | [보기](screenshots/launch-b-authenticated-ranking-390.png) | [보기](screenshots/launch-b-authenticated-ranking-560.png) | [보기](screenshots/launch-b-preview-ranking-390.png) | [보기](screenshots/launch-b-preview-ranking-560.png) |
| 결과 사진 | [보기](screenshots/launch-b-authenticated-result-390.png) | [보기](screenshots/launch-b-authenticated-result-560.png) | [보기](screenshots/launch-b-preview-result-390.png) | [보기](screenshots/launch-b-preview-result-560.png) |
| 당첨 배너 | [보기](screenshots/launch-b-authenticated-announcement-390.png) | [보기](screenshots/launch-b-authenticated-announcement-560.png) | 표시하지 않음 | 표시하지 않음 |
| 행운 출제자·사진 첨부 | [보기](screenshots/launch-b-authenticated-luck-author-390.png) | [보기](screenshots/launch-b-authenticated-luck-author-560.png) | [보기](screenshots/launch-b-preview-luck-author-390.png) | [보기](screenshots/launch-b-preview-luck-author-560.png) |
| 공개 후 증거 | [보기](screenshots/launch-b-authenticated-luck-revealed-390.png) | [보기](screenshots/launch-b-authenticated-luck-revealed-560.png) | [보기](screenshots/launch-b-preview-luck-revealed-390.png) | [보기](screenshots/launch-b-preview-luck-revealed-560.png) |

## 5. 보류 사항

운영 닉네임 중복 조회는 인증된 운영자 환경에서 완료해야 한다. 자동 사전 검사가 통과하기 전에는 마이그레이션을 진행하지 않는다. 이 외 PR B의 제품 규칙 결정 대기는 없다. Draft PR을 연 뒤 멈추며 이후 작업을 시작하지 않는다.
