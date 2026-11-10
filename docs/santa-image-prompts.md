# 산타 선물 배달 — 이미지 프롬프트

지피티에 순서대로 붙여 넣으세요. **한 대화창에서 1번부터 차례로** 만들면 그림체가 맞춰집니다.

## 먼저 할 일

1. 새 대화를 열고, 기존 자유투 타일 그림(`public/freethrow/tile.webp`, 농구공 캐릭터)을 첨부해서 아래 "0. 그림체 맞추기"를 먼저 보냅니다.
2. 그다음 1번부터 하나씩 보냅니다. 마음에 안 들면 "같은 그림체로 다시"라고 하면 됩니다.
3. 받은 그림은 표의 파일 이름으로 저장해서 주세요. 크기·여백 정리와 WebP 변환은 제가 합니다.

| 번호 | 파일 이름 | 꼭 지킬 것 |
| --- | --- | --- |
| 1 | `santa-sleigh.png` | 옆모습, **오른쪽을 향해** 날기 |
| 2 | `gift-red.png` · `gift-green.png` · `gift-blue.png` | 한 장에 상자 하나 |
| 3 | `house-1.png` ~ `house-4.png` | **굴뚝 없음**, 정면 옆모습, 바닥선 맞추기 |
| 4 | `chimney.png` | **세로로 아주 길게**, 위 입구가 보이게 |
| 5 | `sky.png` | **좌우가 이어지는** 가로 배경 |
| 6 | `tile.png` | 홈 화면 아이콘 |

모든 그림: **투명 배경**(5번 배경만 제외), 글자 없음.

---

## 0. 그림체 맞추기

```
첨부한 농구공 캐릭터 그림의 그림체를 기억해 줘. 앞으로 크리스마스 게임용 그림을 여러 장 부탁할 건데, 전부 이 그림체로 맞춰 줘.
- 귀여운 3D 클레이 장난감 렌더링, 둥글고 통통한 형태
- 부드럽고 살짝 광택 있는 재질, 은은한 스튜디오 조명, 부드러운 그림자
- 따뜻한 파스텔 색감 (빨강은 코랄빛, 초록은 민트빛)
- 테두리 선 없음, 글자 없음
- 별도 말이 없으면 투명 배경 PNG
이해했으면 "준비됐어"라고만 대답해 줘.
```

## 1. 산타와 루돌프 썰매 — `santa-sleigh.png`

```
Cute 3D clay toy render of Santa Claus riding a red sleigh pulled by one chubby Rudolph reindeer with a glowing red nose, flying through the air. Pure side view, everyone facing RIGHT, moving to the right. Santa is round and cheerful, waving one hand, with a big gift sack in the back of the sleigh. Rudolph is in front of the sleigh, legs mid-gallop, connected with simple golden reins. Same style as the basketball character: soft glossy clay, rounded chunky shapes, warm pastel colors (coral red, mint green, cream, gold), soft studio lighting. Whole group fully visible with nothing cropped, small empty margin around it. Transparent background, no shadow on the ground, no snow, no text. Wide landscape image, at least 1536 px wide.
```

## 2. 선물 상자 — `gift-red.png` · `gift-green.png` · `gift-blue.png`

색만 바꿔서 세 번 보냅니다.

```
Cute 3D clay toy render of a single small Christmas gift box with a big ribbon bow on top. Coral red box with a cream ribbon. Slightly chunky, rounded edges, seen from the front with a tiny bit of the top visible. Same style as before: soft glossy clay, warm pastel colors, soft studio lighting. One box only, centered, fully visible. Transparent background, no shadow, no text. Square image, 512 x 512.
```

- 두 번째: `Coral red box with a cream ribbon` → `Mint green box with a coral red ribbon`
- 세 번째: `Coral red box with a cream ribbon` → `Pastel sky blue box with a gold ribbon`

## 3. 집 — `house-1.png` ~ `house-4.png`

지붕 모양만 바꿔서 네 번 보냅니다. **굴뚝은 따로 그려서 집 뒤에 세우니, 집에는 굴뚝이 없어야 합니다.**

```
Cute 3D clay toy render of a small cozy house at night for a side-scrolling game. Pure straight-on side view, no perspective, no isometric angle. Steep triangular roof covered with a thick layer of soft snow, warm glowing yellow windows, a little wooden door, a small wreath on the door. IMPORTANT: NO chimney anywhere on the house. Pastel walls (cream) and a coral red roof under the snow. The house stands on a flat bottom edge with nothing below it. Same style as before: soft glossy clay, rounded chunky shapes, soft lighting. Fully visible, centered, small empty margin. Transparent background, no ground, no sky, no text. Square image, 1024 x 1024.
```

- 두 번째: `Pastel walls (cream) and a coral red roof` → `Pastel mint walls and a chocolate brown roof`
- 세 번째: `Pastel walls (cream) and a coral red roof` → `Pastel pink walls and a dark green roof`, 그리고 `a small cozy house` → `a slightly wider two-story house`
- 네 번째: `Pastel walls (cream) and a coral red roof` → `Pastel lavender walls and a navy blue roof`, 그리고 `a small cozy house` → `a tiny narrow cottage`

## 4. 굴뚝 — `chimney.png`

**하나만** 만듭니다. 게임에서 이 굴뚝을 집 뒤에 세우고, 지붕 위로 얼마나 솟게 할지로 높이를 바꿉니다. 그래서 아래쪽이 길게 쭉 이어져야 합니다.

```
Cute 3D clay toy render of a single tall brick chimney for a side-scrolling game. Pure straight-on side view, but the top opening is tilted very slightly toward the camera so the dark round hole inside is clearly visible. The chimney is VERY tall and thin: about 1 part wide to 4 parts tall. It has the same width from top to bottom, with a slightly wider cap at the top and a small pile of snow on the cap edges (but the hole stays open and dark). Coral red bricks with cream mortar lines, evenly repeating so the lower part looks the same all the way down. The bottom is cut straight and flat. Same style as before: soft glossy clay, rounded edges, soft lighting. Fully visible, centered. Transparent background, no smoke, no roof, no text. Tall portrait image, at least 1536 px tall.
```

## 5. 밤하늘 배경 — `sky.png`

```
Cute 3D clay style background of a snowy Christmas night sky for a side-scrolling game. Soft gradient from deep navy at the top to dusty purple near the bottom, a big round cream moon in the upper left, scattered tiny twinkling stars, gentle falling snowflakes, and a few soft rounded clouds. Far in the bottom, very faint low rolling snowy hills silhouette. NO houses, NO characters, NO text. IMPORTANT: the image must tile seamlessly left to right — the left edge and right edge must match perfectly so it can repeat horizontally. Same soft pastel clay style as before. Wide landscape image, 2048 x 1024.
```

## 6. 홈 타일 아이콘 — `tile.png`

```
Cute 3D clay toy render of a round chubby Santa Claus character hugging a big coral red gift box with a cream ribbon, smiling with rosy cheeks and a confident little grin, small Rudolph reindeer head peeking out from behind with a glowing red nose. Same style and same composition feel as the basketball character icon I attached: soft glossy clay, rounded chunky shapes, warm pastel colors, soft studio lighting. Fully visible, centered, small empty margin. Transparent background, no text. Square image, 1024 x 1024.
```

---

## (선택) 있으면 좋은 그림

필수는 아닙니다. 없으면 코드로 그립니다.

### 결과 화면 산타 — `santa-result.png`

```
Cute 3D clay toy render of the same round Santa Claus character jumping with joy, both arms up, an empty gift sack flying in one hand, small confetti and snowflakes around him. Front view. Same style as before. Transparent background, no text. Square image, 1024 x 1024.
```

### 배달 실패 산타 — `santa-oops.png`

```
Cute 3D clay toy render of the same round Santa Claus character scratching his head with an awkward embarrassed smile, a small sweat drop, Rudolph next to him covering his eyes with a hoof. Front view. Same style as before. Transparent background, no text. Square image, 1024 x 1024.
```

## 받은 뒤 확인할 것

- 1번 썰매가 **오른쪽**을 향하는지 (왼쪽이면 제가 뒤집어도 되지만, 산타가 들고 있는 물건 방향이 어색해질 수 있음)
- 3번 집에 **굴뚝이 없는지**
- 4번 굴뚝이 충분히 **길고**, 위쪽 **구멍이 보이는지**
- 5번 배경을 두 장 나란히 붙였을 때 **이음새가 안 보이는지** (안 맞으면 제가 이어 붙이는 쪽을 다듬음)
- 배경이 투명이어야 하는 그림에 체크무늬나 흰 배경이 **그려져** 있지 않은지
