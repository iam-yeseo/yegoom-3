# 컬링·승부차기·빙고 — 이미지 프롬프트

> 1~7번은 2026-11-20에 받아서 반영했습니다([출처 기록](asset-provenance.md)). 선택 그림(8~10번)은 아직 없고, 없는 동안에는 준비 자세 그림과 코드로 그린 관중석을 씁니다.

**한 대화창에서 0번부터 차례로** 만들면 그림체가 맞춰집니다.

## 먼저 할 일

1. 새 대화를 열고, 기존 자유투 타일 그림(`public/freethrow/tile.webp`, 농구공 캐릭터)을 첨부해서 "0. 그림체 맞추기"를 먼저 보냅니다.
2. 그다음 1번부터 하나씩 보냅니다. 마음에 안 들면 "같은 그림체로 다시"라고 하면 됩니다.
3. 받은 그림은 표의 파일 이름으로 저장해서 주세요. 여백 정리와 WebP 변환은 제가 합니다.

| 번호 | 파일 이름 | 쓰이는 곳 | 꼭 지킬 것 |
| --- | --- | --- | --- |
| 1 | `curling-tile.png` | 홈 **혼자 하기** 타일, 결과 창 | 정사각형, 캐릭터 하나 |
| 2 | `penalty-tile.png` | 홈 **혼자 하기** 타일, 결과 창 | 정사각형, 캐릭터 하나 |
| 3 | `bingo-tile.png` | 홈 **오늘의 게임** 줄 아이콘 | 정사각형, 아주 작게(48px) 보여도 알아볼 수 있게 단순하게 |
| 4 | `curling-stone.png` | 컬링 시트 위의 스톤 | **정확히 위에서 내려다본** 모습, 손잡이가 **위쪽(12시)**, 그림자 없음 |
| 5 | `penalty-ball.png` | 승부차기 공 | 공 하나만, 그림자 없음 |
| 6 | `keeper-ready.png` | 골키퍼가 좌우로 움직일 때 | **정면**, 온몸, 무릎 살짝 굽히고 두 팔을 벌린 준비 자세 |
| 7 | `keeper-dive.png` | 골키퍼가 몸을 날릴 때 | **보는 사람 기준 오른쪽으로** 수평으로 몸을 날림(왼쪽은 제가 뒤집습니다) |

모든 그림: **투명 배경**, 글자 없음. 6·7번(선택 8번 포함)은 **같은 캐릭터**여야 하니 꼭 이어서 만들어 주세요.

---

## 0. 그림체 맞추기

```
첨부한 농구공 캐릭터 그림의 그림체를 기억해 줘. 앞으로 미니게임용 그림을 여러 장 부탁할 건데, 전부 이 그림체로 맞춰 줘.
- 귀여운 3D 클레이 장난감 렌더링, 둥글고 통통한 형태
- 부드럽고 살짝 광택 있는 재질, 은은한 스튜디오 조명
- 따뜻한 파스텔 색감 (빨강은 코랄빛, 초록은 민트빛, 파랑은 하늘빛)
- 테두리 선 없음, 글자 없음
- 별도 말이 없으면 투명 배경 PNG
이해했으면 "준비됐어"라고만 대답해 줘.
```

## 1. 컬링 타일 — `curling-tile.png`

```
Cute 3D clay toy render of a round chubby curling stone character: a smooth light gray granite stone body with a coral red handle on top, a happy little face on the front with rosy cheeks, sliding on pale blue ice with a tiny sparkle of ice dust behind it. Same style and same composition feel as the basketball character icon I attached: soft glossy clay, rounded chunky shapes, warm pastel colors, soft studio lighting. One character only, fully visible, centered, small empty margin. Transparent background, no text. Square image, 1024 x 1024.
```

## 2. 승부차기 타일 — `penalty-tile.png`

```
Cute 3D clay toy render of a round chubby soccer ball character (white with soft charcoal pentagon patches), a determined happy face with rosy cheeks, wearing a tiny pair of oversized yellow goalkeeper gloves raised up as if celebrating. Same style and same composition feel as the basketball character icon I attached: soft glossy clay, rounded chunky shapes, warm pastel colors, soft studio lighting. One character only, fully visible, centered, small empty margin. Transparent background, no text. Square image, 1024 x 1024.
```

## 3. 빙고 타일 — `bingo-tile.png`

```
Cute 3D clay toy render of a chunky square bingo card standing upright like a little character: a cream-colored card with a 3 by 3 grid of rounded pastel squares, three squares in one diagonal line stamped with coral red circles, a tiny happy face with rosy cheeks at the bottom of the card. No letters, no numbers anywhere. Very simple and bold shapes so it still reads at a tiny size. Same style as the basketball character icon I attached: soft glossy clay, rounded chunky shapes, warm pastel colors, soft studio lighting. Fully visible, centered, small empty margin. Transparent background, no text. Square image, 1024 x 1024.
```

## 4. 컬링 스톤 (위에서 본 모습) — `curling-stone.png`

게임 안에서 지름 26px 정도로 아주 작게 쓰입니다. 얼굴 없이 단순해야 합니다.

```
Cute 3D clay toy render of a single curling stone seen from DIRECTLY ABOVE, perfect top-down orthographic view, no perspective, no tilt. A perfectly round light gray granite stone with a slightly darker gray rim, and on top a coral red round cap with a chunky coral red handle. The handle bar points straight UP toward the top of the image (12 o'clock). No face, no decoration, very simple and bold shapes. The stone is a perfect circle that fills almost the whole image, centered. Soft glossy clay, soft studio lighting from above. Transparent background, NO shadow on the ground, no text. Square image, 1024 x 1024.
```

## 5. 축구공 — `penalty-ball.png`

```
Cute 3D clay toy render of a single classic soccer ball: white with soft charcoal pentagon patches, slightly chunky and glossy like a clay toy. No face. Seen straight on, perfectly round, filling almost the whole image, centered. Same style as before: soft glossy clay, soft studio lighting. Transparent background, NO shadow, no text. Square image, 1024 x 1024.
```

## 6. 골키퍼 준비 자세 — `keeper-ready.png`

```
Cute 3D clay toy render of a chubby little goalkeeper character for a penalty shoot-out game. Round head with short brown hair, rosy cheeks and a focused but friendly face. Wearing a pastel yellow long-sleeve goalkeeper jersey, dark charcoal shorts, and big white goalkeeper gloves. FRONT VIEW, facing the camera directly, full body from head to feet. Ready stance: knees slightly bent, feet apart, both arms spread out to the sides at waist height with open gloves. Symmetrical pose. Same style as before: soft glossy clay, rounded chunky shapes, warm pastel colors, soft studio lighting. Fully visible with a small empty margin, feet at the bottom of the image. Transparent background, NO shadow on the ground, no text. Square image, 1024 x 1024.
```

## 7. 골키퍼 다이빙 — `keeper-dive.png`

6번 바로 다음에 보냅니다.

```
The SAME goalkeeper character as the previous image (same face, same hair, same pastel yellow jersey, charcoal shorts, big white gloves), now diving. Still seen from the FRONT (the camera is where the ball was kicked from). The goalkeeper is flying sideways toward the RIGHT side of the image: the body is stretched out almost horizontally, both arms fully extended to the right with open gloves reaching, head between the arms looking at the gloves, legs trailing to the left. Whole body visible, nothing cut off. Same 3D clay toy style, soft studio lighting. Transparent background, NO shadow, no text. Wide image, 1536 x 1024.
```

---

## (선택) 있으면 좋은 그림

필수는 아닙니다. 없으면 지금처럼 코드로 그리거나 다른 그림을 대신 씁니다.

### 8. 골키퍼 점프 — `keeper-jump.png`

가운데 위로 오는 공을 막을 때 씁니다. 없으면 준비 자세 그림을 위로 띄웁니다.

```
The SAME goalkeeper character again, seen from the FRONT, jumping straight up: both arms stretched straight up above the head with open gloves, legs slightly tucked, eyes looking up. Whole body visible. Same 3D clay toy style. Transparent background, NO shadow, no text. Tall image, 1024 x 1536.
```

### 9. 관중석 배경 — `penalty-stand.png`

골대 뒤쪽 윗부분에만 씁니다(잔디와 골대는 판정 위치와 맞아야 해서 계속 코드로 그립니다).

```
Cute 3D clay toy style background for a soccer penalty game: a stadium stand seen straight on from the pitch, filled with rows of tiny round pastel-colored clay spectators (coral, yellow, mint, sky blue, white), a soft pastel blue sky above the stand, and a plain dark charcoal advertising board running along the very bottom edge with NO text on it. No goal, no players, no grass. Flat straight-on view, no perspective, evenly lit, calm and not too detailed so it works as a background. Full image, no transparency, no text. Wide image, 1536 x 1024.
```

### 10. 결과 창 그림 — `curling-result.png` · `penalty-result.png` · `bingo-result.png`

결과 창에는 타일 그림(1~3번)을 그대로 씁니다. 따로 넣고 싶을 때만 만들어 주세요. 타일 프롬프트 끝에 아래 문장을 덧붙이면 됩니다.

```
Same character as the icon, but now jumping with joy with both arms up and little confetti pieces around it.
```
