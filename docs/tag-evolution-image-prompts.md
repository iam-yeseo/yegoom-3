# 별명 태그 진화 — 이미지 프롬프트

별명 태그 진화 화면(진화 중 → 성공/실패 모달)에 넣을 전용 그림입니다.
그림을 받기 전까지는 **내 캐릭터 스프라이트**(진화 중·성공은 `happy`, 실패는 `sleepy`)와 CSS 무지개 링으로 대신 보여 주고 있어요.
아래 그림을 받으면 `src/screens/NicknameTagShop.tsx`의 `EvolvingOverlay`·`EvolutionResult`에서 캐릭터 스프라이트 자리에 바꿔 넣습니다.

## 먼저 할 일

1. 새 대화를 열고 기존 캐릭터 그림 한 장(`public/characters/cat.png`)을 첨부해서 "0. 그림체 맞추기"를 먼저 보냅니다.
2. 1번부터 차례로 보냅니다. 마음에 안 들면 "같은 그림체로 다시"라고 하면 됩니다.
3. 받은 그림은 표의 파일 이름으로 저장해서 주세요. 여백 정리와 WebP 변환(`public/tags/*.webp`)은 제가 합니다.

| 번호 | 파일 이름 | 쓰는 곳 | 꼭 지킬 것 |
| --- | --- | --- | --- |
| 1 | `evolve-working.png` | "진화 중…" 화면 | 가운데 정렬, 둥근 구도(위에 무지개 링이 돌아요) |
| 2 | `evolve-success.png` | 성공 모달 | 위쪽이 밝게 터지는 구도 |
| 3 | `evolve-fail.png` | 실패 모달(재료 태그는 무사) | 너무 슬프지 않게, 머쓱한 느낌 |
| 4 | `evolve-lost.png` | 실패 모달(재료 태그가 사라짐) | 3번과 같은 소품, 한 장이 사라진 모습 |

모든 그림: **투명 배경 PNG**, 정사각형(1024×1024), 글자 없음.

---

## 0. 그림체 맞추기

```
첨부한 고양이 캐릭터 그림의 그림체를 기억해 줘. 앞으로 게임용 그림을 여러 장 부탁할 건데, 전부 이 그림체로 맞춰 줘.
- 귀여운 3D 클레이 장난감 렌더링, 둥글고 통통한 형태
- 부드럽고 살짝 광택 있는 재질, 은은한 스튜디오 조명, 부드러운 그림자
- 따뜻한 파스텔 색감 (크림, 코랄, 라벤더, 민트, 버터 옐로)
- 테두리 선 없음, 글자 없음, 투명 배경 PNG, 정사각형
이해했으면 "준비됐어"라고만 대답해 줘.
```

## 1. 진화 중 — `evolve-working.png`

```
Cute 3D clay toy render, same style as the reference. Two small blank name-tag labels (rounded rectangle tags with a tiny string hole, one cream-white and one pale silver, no text) floating and spiraling toward each other above a round pastel lavender cauldron-like magic pot. Soft glowing swirl of pastel rainbow light (pink, butter yellow, mint, sky blue, lavender) rising from the pot, small star sparkles around. Centered round composition, front view, slightly from above. No characters, no letters. Transparent background, square 1024x1024.
```

## 2. 진화 성공 — `evolve-success.png`

```
Cute 3D clay toy render, same style as the reference. One shiny upgraded name-tag label (rounded rectangle tag with a tiny string hole, no text) with a holographic pastel rainbow surface (pink, butter yellow, mint, sky blue, lavender), floating proudly in the center with a soft glow, small golden stars and confetti bursting upward behind it, a tiny gold crown resting on its top corner. Joyful, triumphant mood. No characters, no letters. Transparent background, square 1024x1024.
```

## 3. 진화 실패(재료 무사) — `evolve-fail.png`

```
Cute 3D clay toy render, same style as the reference. Two small blank name-tag labels (rounded rectangle tags with a tiny string hole, cream-white, no text) lying side by side, slightly tilted, with a small puff of pale gray-lavender smoke fizzling out above them and one tiny drooping star. Awkward "oops, it didn't work" mood, not sad. Soft pastel colors. No characters, no letters. Transparent background, square 1024x1024.
```

## 4. 진화 실패(재료 사라짐) — `evolve-lost.png`

```
Cute 3D clay toy render, same style as the reference. One small blank name-tag label (rounded rectangle tag with a tiny string hole, cream-white, no text) sitting alone on the left, and on the right an empty dotted outline on the ground where a second tag used to be, with a few fading sparkles drifting up from the empty spot and a small pale lavender smoke puff. Gentle "it vanished" mood, slightly comical. Soft pastel colors. No characters, no letters. Transparent background, square 1024x1024.
```
