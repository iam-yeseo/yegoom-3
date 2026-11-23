# 변기 폭파 게임 — 이미지 프롬프트

> 1~7번을 모두 2026-11-23에 받아서 반영했습니다([출처 기록](asset-provenance.md)).

지피티에 순서대로 붙여 넣으세요. **한 대화창에서 0번부터 차례로** 만들면 그림체가 맞춰집니다.

화면 흐름(그림이 쓰이는 곳): 가운데에 변기가 있고, 내 차례에 **볼일 보기**를 누르면 똥이 위에서 변기로 떨어집니다. 무사하면 물이 내려가고, 차례가 지날수록 변기가 점점 불안해합니다. 걸리면 변기가 터집니다.

## 먼저 할 일

1. 새 대화를 열고, 기존 자유투 타일 그림(`public/freethrow/tile.webp`, 농구공 캐릭터)을 첨부해서 "0. 그림체 맞추기"를 먼저 보냅니다.
2. 그다음 1번부터 하나씩 보냅니다. 마음에 안 들면 "같은 그림체로 다시"라고 하면 됩니다.
3. 받은 그림은 표의 파일 이름으로 저장해서 주세요. 여백 정리와 WebP 변환은 제가 합니다.

| 번호 | 파일 이름 | 쓰이는 곳 | 꼭 지킬 것 |
| --- | --- | --- | --- |
| 1 | `toilet-tile.png` | 홈 **오늘의 게임** 줄 아이콘 | 정사각형, 아주 작게(48px) 보여도 알아볼 수 있게 단순하게 |
| 2 | `toilet-calm.png` | 게임 화면 가운데 변기(평소) | **정면에서 살짝 위**, 뚜껑 열림, 변기 안쪽이 보이게 |
| 3 | `toilet-nervous.png` | 차례가 쌓여 불안할 때 | 2번과 **같은 변기·같은 구도·같은 크기** |
| 4 | `toilet-boom.png` | 터지는 순간 | 2번과 같은 변기, **세로로 긴** 그림, 변기는 아래쪽 |
| 5 | `poop.png` | 차례마다 변기로 떨어지는 똥 | 똥 하나만, 그림자 없음 |
| 6 | `toilet-result-safe.png` | 결과 창(살아남은 사람) | 정사각형, 캐릭터 하나 |
| 7 | `toilet-result-lose.png` | 결과 창(걸린 사람) | 정사각형, 2번과 같은 변기 |

모든 그림: **투명 배경**, 글자 없음. 똥은 이모지처럼 귀여운 소프트아이스크림 모양으로, 더럽거나 사실적이지 않게. 2·3·4·7번은 **같은 변기**여야 하니 꼭 이어서 만들어 주세요.

---

## 0. 그림체 맞추기

```
첨부한 농구공 캐릭터 그림의 그림체를 기억해 줘. 앞으로 "변기 폭파 게임"이라는 귀여운 파티 게임용 그림을 여러 장 부탁할 건데, 전부 이 그림체로 맞춰 줘.
- 귀여운 3D 클레이 장난감 렌더링, 둥글고 통통한 형태
- 부드럽고 살짝 광택 있는 재질, 은은한 스튜디오 조명
- 따뜻한 파스텔 색감 (빨강은 코랄빛, 초록은 민트빛, 파랑은 하늘빛)
- 똥은 이모지처럼 귀여운 초콜릿색 소프트아이스크림 모양 (더럽거나 사실적이지 않게, 장난감처럼)
- 테두리 선 없음, 글자 없음
- 별도 말이 없으면 투명 배경 PNG
이해했으면 "준비됐어"라고만 대답해 줘.
```

## 1. 홈 아이콘 — `toilet-tile.png`

```
Cute 3D clay toy render of a chubby little white toilet character with a pastel sky blue seat and lid. The lid is popping open by itself and a tiny cute chocolate-brown swirl poop (emoji style, like soft-serve ice cream, with a small happy face) is peeking out over the rim. The toilet has a nervous little face on the front of the tank: wide eyes, a wobbly smile, one sweat drop, rosy cheeks. Very simple and bold shapes so it still reads at a tiny size. Same style and same composition feel as the basketball character icon I attached: soft glossy clay, rounded chunky shapes, warm pastel colors, soft studio lighting. One character only, fully visible, centered, small empty margin. Transparent background, no text. Square image, 1024 x 1024.
```

## 2. 변기 평소 — `toilet-calm.png`

게임 화면 가운데에 크게 놓이는 변기입니다. 똥이 위에서 안쪽으로 떨어져야 해서 **변기 안쪽이 보여야** 합니다.

```
Cute 3D clay toy render of a chubby white toilet character for a party game, seen from the FRONT and slightly from above, so the open bowl and the dark water inside the bowl are clearly visible. The seat is pastel sky blue and the lid is fully raised up against the tank. A calm, sleepy, content little face on the front of the tank: relaxed half-closed eyes, a small smile, rosy cheeks. Symmetrical, standing on a flat bottom edge. Same style as before: soft glossy clay, rounded chunky shapes, warm pastel colors, soft studio lighting. The toilet fills most of the image, fully visible, centered, small empty margin, base touching near the bottom of the image. Transparent background, NO shadow on the ground, no text. Square image, 1024 x 1024.
```

## 3. 변기 불안 — `toilet-nervous.png`

2번 바로 다음에 보냅니다. 게임에서 2번과 겹쳐 바꿔 끼우므로 **크기와 위치가 똑같아야** 합니다.

```
The SAME toilet character as the previous image, with EXACTLY the same camera angle, size, position and framing, so the two images can be swapped without moving. Same white body, pastel sky blue seat, lid raised. Only the mood changes: now it is very nervous. Wide panicked eyes, a tight wobbly grimace, big sweat drops flying off, a few small round bubbles rising out of the bowl, tiny motion lines on both sides as if it is trembling. Same 3D clay toy style, soft studio lighting. Transparent background, NO shadow, no text. Square image, 1024 x 1024.
```

## 4. 변기 폭파 — `toilet-boom.png`

3번 다음에 보냅니다. 위로 솟구치는 모습이라 세로로 깁니다. 변기 아래쪽 위치는 제가 2번과 맞춥니다.

```
The SAME toilet character again, same front-and-slightly-above angle, now EXPLODING in a funny cartoon way. The toilet stays at the bottom of the image with its base on the bottom edge. The lid is blown off and flying up, and a huge fountain shoots straight up out of the bowl: a burst of blue water splashes mixed with lots of cute chocolate-brown swirl poops (emoji style, like soft-serve ice cream, some with tiny surprised faces) flying upward and outward. The toilet's face is dizzy with X-shaped eyes and an open mouth. Add a soft cartoon burst shape and little stars around the blast. Cute and silly, not gross. Same 3D clay toy style, soft studio lighting. Transparent background, NO shadow, no text. Tall image, 1024 x 1536.
```

## 5. 똥 — `poop.png`

차례마다 변기 위에서 떨어지는 똥입니다. 게임 안에서 작게(지름 60px 정도) 쓰입니다.

```
Cute 3D clay toy render of a single chocolate-brown swirl poop, emoji style, like a three-layer soft-serve ice cream with a little curled tip on top. A tiny cute face with shiny dot eyes and a small smile, rosy cheeks. Glossy and chunky like a clay toy, cute and not gross. Seen from the front, centered, filling most of the image. Same style as before: soft glossy clay, soft studio lighting. One poop only. Transparent background, NO shadow, no text. Square image, 512 x 512.
```

## 6. 결과 — 살아남음 — `toilet-result-safe.png`

```
Cute 3D clay toy render of the same little swirl poop character, now jumping with joy with both tiny arms up, proudly holding a fluffy white roll of toilet paper above its head like a trophy, a long strip of toilet paper waving like a ribbon, little confetti pieces around it. Front view. Same style as before: soft glossy clay, rounded chunky shapes, warm pastel colors, soft studio lighting. One character only, fully visible, centered, small empty margin. Transparent background, no text. Square image, 1024 x 1024.
```

## 7. 결과 — 걸림 — `toilet-result-lose.png`

```
Cute 3D clay toy render of the same toilet character right after it exploded: still standing, but dazed with swirly spiral eyes and a crooked lid, a coral red rubber plunger stuck on top of its head, a few small brown splats and water droplets on its body, a little cloud of dust and tiny stars circling above. Funny and silly, not gross. Front view. Same style as before: soft glossy clay, rounded chunky shapes, warm pastel colors, soft studio lighting. One character only, fully visible, centered, small empty margin. Transparent background, no text. Square image, 1024 x 1024.
```

---

## 받은 뒤 확인할 것

- 1번 아이콘이 작게 줄여도 **변기로 보이는지**
- 2번에서 **변기 안쪽(물)이 보이는지** — 안 보이면 똥이 들어가는 모습이 어색해짐
- 2·3번을 겹쳐 봤을 때 **변기 크기·위치가 같은지** (조금 다르면 제가 맞춤)
- 2·3·4·7번이 **같은 변기**인지 (시트 색, 얼굴 위치)
- 배경이 투명이어야 하는 그림에 체크무늬나 흰 배경이 **그려져** 있지 않은지
