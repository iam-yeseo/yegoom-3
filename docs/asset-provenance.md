# 캐릭터 뽑기 인형 이미지 출처

2026-11-24(KST)에 사용자가 제공한 흰 배경의 JPEG 사진 15장을 지인용 비공개 서비스의 캐릭터 뽑기에 사용한다. 배포 파일은 `public/claw/dolls/doll-{type}.webp`이며, 원본 JPEG는 저장소 밖에 보관한다. 원본 번호 02~16에 순서대로 게임 번호(type) 1~15를 배정했다.

- 배경은 사진 가장자리 픽셀의 중앙값을 기준으로, 밝기와 색차가 모두 가까우면서 가장자리에서 이어진 영역을 찾아 투명하게 처리했다. 바닥 그림자가 없는 사진이어서 게임 화면에서 그리는 그림자만 보인다.
- 15장 모두 큰 열쇠고리 안으로 흰 배경이 보여 사진별 시작점을 두고 해당 영역을 제거했다. 작은 연결 고리까지 배경이 보이는 type 1·2·3·5·6·7·8·9·11·13·15는 그 안쪽도 투명하게 처리했다. 나머지 네 장은 작은 고리 안이 가려져 있다. 사진별 시작점은 변환 스크립트의 `RING_HOLES`에 기록돼 있다.
- 인형과 떨어진 작은 조각을 제거하고 알파 경계를 부드럽게 했다. 알파가 24 이하인 픽셀과 투명 여백을 제거한 뒤 종횡비를 유지하면서 Lanczos로 긴 변을 320px로 줄였다. WebP 압축은 RGB 품질 85, `alpha_quality=100`, `method=6`, `exact=True`다. 저장한 파일을 다시 읽어 크기와 알파 채널을 대조하고 장당 40,000바이트 한도를 검사한다.
- 제작 환경은 Python 3.12.14, NumPy 2.3.5, Pillow 12.3.0, libwebp 1.6.0이다.

저장소 루트에서 아래 명령을 실행하면 인형 WebP 15장과 기계 배경색·어두운색·체크무늬 위에 놓은 모아보기 세 장을 생성한다.

```sh
python3 scripts/prepare-claw-dolls.py /tmp/claw-dolls-src --first-number 2 --preview /tmp/claw-dolls-preview
```

| type | 원본 파일 | 원본 크기(px) | 원본(바이트) | WebP 크기(px) | WebP(바이트) | 반지름 | 상대 무게 |
| ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | `02_간호사_치이카와.jpg` | 1200×1200 | 52,848 | 201×320 | 11,168 | 32 | 1.00 |
| 2 | `03_간호사_하치와레.jpg` | 1200×1200 | 69,400 | 208×320 | 12,424 | 30 | 0.90 |
| 3 | `04_간호사_우사기.jpg` | 1200×1200 | 73,328 | 250×320 | 13,060 | 34 | 1.15 |
| 4 | `05_간호사_치이카와_뒷모습.jpg` | 1200×1200 | 40,943 | 205×320 | 9,650 | 29 | 0.85 |
| 5 | `06_간호사_모몽가.jpg` | 1200×1200 | 65,102 | 252×320 | 13,960 | 33 | 1.05 |
| 6 | `07_간호사_쿠리만쥬.jpg` | 1200×1200 | 83,881 | 217×320 | 12,928 | 31 | 0.95 |
| 7 | `08_간호사_시사.jpg` | 1200×1200 | 90,231 | 234×320 | 15,136 | 35 | 1.20 |
| 8 | `09_간호사_랏코.jpg` | 1200×1200 | 90,709 | 227×320 | 13,424 | 28 | 0.80 |
| 9 | `10_간호사_헌책방.jpg` | 1200×1200 | 74,074 | 221×320 | 12,880 | 33 | 1.10 |
| 10 | `11_간호사_풍뎅이.jpg` | 1200×1200 | 61,152 | 261×320 | 13,620 | 30 | 0.90 |
| 11 | `12_간호사_오데.jpg` | 1200×1200 | 73,632 | 178×320 | 11,706 | 32 | 1.00 |
| 12 | `13_간호사_포셰트_갑옷상.jpg` | 1200×1200 | 81,832 | 162×320 | 11,962 | 32 | 1.00 |
| 13 | `14_간호사_그_녀석.jpg` | 1200×1200 | 56,694 | 197×320 | 12,646 | 30 | 1.00 |
| 14 | `15_의사_우사기.jpg` | 1200×1200 | 76,602 | 176×320 | 12,528 | 34 | 1.00 |
| 15 | `16_의사_랏코.jpg` | 1200×1200 | 76,804 | 187×320 | 12,566 | 29 | 1.00 |
| **합계** | **15장** | | **1,067,232** | | **189,658** | | |

이전 인형 11종은 `iam-yeseo/yegoom`의 `public/assets/gatcha-1.png`~`gatcha-11.png`에서 변환했다. 해당 WebP 파일은 이 저장소의 커밋 이력에 남아 있다. [이전 원본 커밋 5a8017247c365b7233f4dfb2209a6bf27a30c678](https://github.com/iam-yeseo/yegoom/tree/5a8017247c365b7233f4dfb2209a6bf27a30c678/public/assets)

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

## 변기 폭파 그림

- `public/toilet/{tile,calm,nervous,boom,poop,result-safe,result-lose}.webp` 7장은 사용자가 2026-11-23에 제공한 이미지다. 사용자가 [이미지 프롬프트](toilet-image-prompts.md)로 이미지 생성기에서 만들었다(압축 파일로 받음, 원본 PNG는 저장소에 없음). 지인용 비공개 서비스 전용이다.
- `scripts/prepare-toilet-art.py`가 알파 24 이하의 옅은 잡티를 지우고 WebP(RGB quality 85, 알파 무손실)로 줄인다. 아이콘·똥·결과 그림은 투명 여백을 자르고 정사각형 가운데에 둔다(홈 아이콘은 홈 줄에서 위아래가 잘리지 않게 18% 여백을 둔다).
- 게임 화면에서 바꿔 끼우는 변기 세 장(평소·불안·폭파)은 따로 자르지 않는다. 파란 시트의 폭을 평소 그림에 맞춰 크기를 맞추고(불안 1.008배, 폭파 1.019배), 시트 가운데와 받침 바닥을 기준으로 같은 폭의 틀로 자른다. 그래서 같은 폭으로 보여 주면 세 변기가 같은 자리에 겹친다. 폭파 그림은 위로 솟는 물줄기 때문에 세로로 길다.

| 파일 | 원본 | WebP 바이트 | 크기 |
| --- | --- | ---: | --- |
| toilet/tile | toilet-tile.png 1024×1024 | 9,020 | 210×210 |
| toilet/poop | poop.png 512×512 | 7,154 | 160×160 |
| toilet/result-safe | toilet-result-safe.png 1024×1024 | 18,852 | 240×240 |
| toilet/result-lose | toilet-result-lose.png 1024×1024 | 13,084 | 240×240 |
| toilet/calm | toilet-calm.png 1024×1024 | 13,706 | 360×360 |
| toilet/nervous | toilet-nervous.png 1024×1024 | 16,532 | 360×360 |
| toilet/boom | toilet-boom.png 1024×1536 | 58,356 | 360×540 |

```sh
python3 scripts/prepare-toilet-art.py /path/to/toilet-images
```
