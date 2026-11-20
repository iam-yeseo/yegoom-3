# 캐릭터 뽑기 인형 이미지 출처

사용자가 제공한 이미지, 원본 yegoom `public/assets/gatcha-*.png`에서 최적화, 지인용 비공개 서비스 전용.

- 원본: `iam-yeseo/yegoom`의 커밋 [`5a8017247c365b7233f4dfb2209a6bf27a30c678`](https://github.com/iam-yeseo/yegoom/tree/5a8017247c365b7233f4dfb2209a6bf27a30c678/public/assets)에 있는 `gatcha-1.png` ~ `gatcha-11.png`. 원본 레포는 읽기만 했으며 변경하지 않았다.
- 결과: `public/claw/dolls/doll-1.webp` ~ `doll-11.webp`. 번호는 물리 엔진의 인형 `type` 1~11과 같다. 원본 결과 장면 그림은 가져오지 않았다.
- 변환: 종횡비 유지, 긴 변 320px, Lanczos 축소, RGB 품질 85, WebP `alpha_quality=100`, `method=6`, `exact=True`. 축소한 RGBA 이미지와 WebP를 다시 디코딩한 이미지의 알파 채널이 바이트 단위로 같은지 검사했다.
- 제작 환경: Python 3, Pillow 12.3.0, libwebp 1.6.0. 같은 바이트를 재현하려면 Pillow와 libwebp 버전도 같아야 한다.
- PWA: 11장 모두 기존 정적 파일 precache에 포함한다. 합계 169,940바이트(약 166KiB)이며 `/api`는 계속 서비스 워커 캐시에서 제외한다.

재생성 시 원본 PNG의 로컬 복사본 경로를 넘긴다. 스크립트는 원본을 읽기만 하며, 장당 40,000바이트 초과 또는 알파 채널 변경 시 실패한다.

```sh
python3 scripts/prepare-claw-dolls.py /path/to/yegoom/public/assets
```

| type | 원본 PNG (바이트) | WebP (바이트) | 크기 |
| --- | ---: | ---: | --- |
| 1 | 426,969 | 18,472 | 320×291 |
| 2 | 262,188 | 18,296 | 313×320 |
| 3 | 356,369 | 14,470 | 235×320 |
| 4 | 320,703 | 17,662 | 320×303 |
| 5 | 183,133 | 11,606 | 320×247 |
| 6 | 413,724 | 21,012 | 320×246 |
| 7 | 394,751 | 18,846 | 320×252 |
| 8 | 300,163 | 13,914 | 320×251 |
| 9 | 243,170 | 11,586 | 283×320 |
| 10 | 309,006 | 14,842 | 320×309 |
| 11 | 193,029 | 9,234 | 258×320 |
| **합계** | **3,403,205** | **169,940** | **95.01% 감소** |

## 슬롯머신 그림 (개선 PR 7)

- `public/slot/banana.svg`, `apple.svg`, `strawberry.svg`, `grape.svg`, `watermelon.svg`, `chamoe.svg`, `seven.svg`는 이 작업에서 직접 작성한 원본 SVG다. 외부 이미지·이모지·폰트 글리프를 사용하지 않았다. 2026-11-05에 Claude Design `Yegoom Stock and Shop` 3j 시안의 과일 도형(테두리 없는 파스텔)으로 다시 그렸다. `seven.svg`는 시안의 글꼴 숫자 대신 같은 색(#F47C66)의 도형으로 그렸다.
- 80×80 공통 viewBox에 과일 6종과 숫자 7을 path·ellipse·circle로 그렸다. 진한 `#493f46` 2px 선, 둥근 선 끝·모서리, 앱의 노랑·코랄·민트·보라 파스텔 색을 사용한다.
- 별도 다운로드·변환·빌드 도구 없이 파일 자체가 원본이며 기기 글꼴에 영향을 받지 않는다. 기존 정적 자산 빌드와 서비스 워커 precache에 함께 포함된다.

## 자유투 대결 그림

- `public/freethrow/tile.webp`(홈 타일 아이콘, 농구공 캐릭터)와 `public/freethrow/ball.webp`(게임 속 농구공)는 사용자가 2026-11-07에 제공한 이미지다. 사용자가 [이미지 프롬프트](plan-freethrow.md)로 이미지 생성기에서 만들었다. 지인용 비공개 서비스 전용이다.
- `scripts/prepare-freethrow-art.py`로 투명 여백을 잘라 정사각형 가운데에 두고, 타일 210px·공 256px WebP(RGB quality 85, 알파 무손실)로 줄였다. 둘 다 서비스 워커 precache에 들어간다.

| 파일 | 원본 WebP (바이트) | 최적화 (바이트) | 크기 |
| --- | ---: | ---: | --- |
| tile | 167,718 | 13,172 | 210×210 |
| ball | 139,426 | 14,486 | 256×256 |

## 산타 선물 배달 그림

- `public/santa/*.webp` 13장은 사용자가 2026-11-10에 제공한 이미지다. 사용자가 [이미지 프롬프트](santa-image-prompts.md)로 이미지 생성기에서 만들었다. 지인용 비공개 서비스 전용이다.
- `scripts/prepare-santa-art.py`가 원본 PNG를 읽기만 하고 다듬는다. 알파 24 이하의 옅은 잡티를 투명으로 바꾸고 투명 여백을 자른 뒤 화면 크기의 약 2배로 줄여 WebP(RGB quality 85, 알파 무손실)로 저장한다. 밤하늘은 좌우를 뒤집고 달이 오른쪽 위에 오도록 화면 비율만큼 잘라 quality 82로 저장한다.
- 같은 스크립트가 그림에서 잰 크기와 집 지붕선, 굴뚝 입구 위치를 `src/santa/art.ts`로 쓴다. 그림을 바꾸면 스크립트를 다시 돌린다.
- 모두 서비스 워커 precache에 들어간다. 합계 약 236KB.

| 파일 | 원본 | 결과 (바이트) | 크기 |
| --- | --- | ---: | --- |
| sleigh | santa-sleigh.png 1536×1024 | 23,984 | 360×189 |
| gift-red · green · blue | 1254×1254 | 1,968 · 2,002 · 1,894 | 44×44 |
| house-1 ~ 4 | 1254×1254 | 27,894 · 29,802 · 34,416 · 20,118 | 높이 500 |
| chimney | 1024×1536 | 19,604 | 158×634 |
| sky | 1774×887 | 10,634 | 570×887 |
| tile | 1254×1254 | 15,864 | 210×210 |
| result · oops | santa-result · santa-oops 1254×1254 | 21,174 · 20,022 | 240×240 |

```sh
python3 scripts/prepare-santa-art.py /path/to/santa-images
```

## 별명 태그 진화 그림

- `public/tags/evolve-{working,success,fail,lost}.webp` 4장은 사용자가 2026-11-17에 제공한 이미지다. 사용자가 [이미지 프롬프트](tag-evolution-image-prompts.md)로 이미지 생성기에서 만들었다(원본 1254×1254 PNG).
- `scripts/prepare-tag-evolution-art.py`가 알파 24 이하의 옅은 잡티를 지우고 투명 여백을 자른 뒤 정사각형 가운데에 두어 360px WebP(quality 85, 알파 무손실)로 줄였다. 각 20~28KB.

## 컬링·승부차기·빙고 그림

- `public/curling/{tile,result,stone}.webp`, `public/penalty/{tile,result,ball,keeper-ready,keeper-dive,keeper-jump,stand}.webp`, `public/bingo/{tile,result}.webp` 12장은 사용자가 2026-11-20에 제공한 이미지다(먼저 7장, 이어서 골키퍼 점프·관중석·결과 그림 3장). 사용자가 [이미지 프롬프트](arcade-image-prompts.md)로 이미지 생성기에서 만들었다. 지인용 비공개 서비스 전용이다.
- 먼저 받은 7장의 원본 PNG(1024×1024, 골키퍼 다이빙만 1536×1024, 장당 0.7~1.7MB)는 커밋 `91a0e84`의 `public/arcade/`에 있다. 그대로 두면 서비스 워커가 미리 받아 두는 파일에 들어가므로 변환한 뒤 작업 트리에서는 지웠다. 나중에 받은 5장은 압축 파일로 받아 변환만 했고 원본은 저장소에 없다.
- `scripts/prepare-arcade-art.py`가 알파 24 이하의 옅은 잡티를 지우고 투명 여백을 자른 뒤 WebP(RGB quality 85, 알파 무손실)로 줄인다. 관중석은 불투명 배경이라 여백을 자르지 않고, 지붕 조금 위부터 무대 윗부분 모양(360:166)만큼 잘라 쓴다(맨 앞줄 아래는 코드로 그리는 광고판이 가린다). 골키퍼 세 장의 가로세로 비율은 `src/penalty/art.ts`로 쓴다. 그림을 바꾸면 스크립트를 다시 돌린다.

| 파일 | 원본 | WebP 바이트 | 크기 |
| --- | --- | ---: | --- |
| curling/tile | curling-tile.png 1024×1024 | 11,928 | 210×210 |
| penalty/tile | penalty-tile.png 1024×1024 | 13,072 | 210×210 |
| bingo/tile | bingo-tile.png 1024×1024 | 10,974 | 210×210 |
| curling/stone | curling-stone.png 1024×1024 | 3,362 | 96×96 |
| penalty/ball | penalty-ball.png 1024×1024 | 5,400 | 128×128 |
| penalty/keeper-ready | keeper-ready.png 1024×1024 | 16,346 | 252×256 |
| penalty/keeper-dive | keeper-dive.png 1536×1024 | 16,274 | 320×165 |
| penalty/keeper-jump | keeper-jump.png 1024×1536 | 18,780 | 236×320 |
| curling/result | curling-result.png 1254×1254 | 16,636 | 240×240 |
| penalty/result | penalty-result.png 1254×1254 | 18,996 | 240×240 |
| bingo/result | bingo-result.png 1254×1254 | 17,602 | 240×240 |
| penalty/stand | penalty-stand.png 1536×1024 | 43,080 | 720×332 |

```sh
git show 91a0e84 --stat   # 원본 PNG가 들어 있는 커밋
python3 scripts/prepare-arcade-art.py /path/to/arcade-images
```
