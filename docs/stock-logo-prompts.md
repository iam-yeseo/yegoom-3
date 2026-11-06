# 주식 종목 로고 아이콘 프롬프트

예굼방 주식 15종목의 로고 아이콘을 이미지 생성기로 만들 때 쓰는 프롬프트입니다. 종목 정보는 운영 시트 `주식 리스트` 탭과 `shared/stocks.ts`를 따릅니다.

## 공통 기준

- **그림체:** 캐릭터 아트(`public/characters`)처럼 무광 점토·소프트 비닐 장난감 느낌의 3D. 크림색 몸체, 파스텔 포인트, 점 눈과 분홍 볼.
- **크기:** 목록에서는 작은 원 배지 크기로 보이므로 물건 하나를 크고 단순하게 가운데 둔다.
- **색:** 지금 종목 배지 색(배경 tint, 글자 ink)을 그대로 따른다.
- **상표:** 실제 회사 로고를 닮지 않게 한다. 구로미해적단은 산리오 캐릭터 구로미를 직접 그리지 않고 리본 단 해골 깃발로 분위기만 살린다.
- **결과물:** 1:1 정사각형, 투명 배경, 글자 없음. 투명 배경이 안 되는 생성기는 흰 배경으로 받는다.
- **파일명:** 티커로 저장한다(예: `YKHX.png`).

## 종목별 프롬프트

### 1. YK하이커스 (YKHX)

다리 달린 반도체 칩, 머리에 외계인 더듬이.

```
Cute 3D app icon, soft matte clay and vinyl toy style, pastel colors, gentle studio lighting, soft shadow, chubby rounded shapes. A plump square microchip character with tiny golden pins as little legs and two small alien antennae with glowing tips on top, tiny dot eyes and rosy pink cheeks, a shy proud smile. Main color pastel sky blue (#E3F1FC) with deeper blue accents (#2F6E9E). Single object, centered, fills 80% of the frame, readable at very small size, 1:1 square, transparent background, no text, no letters, not resembling any real company logo.
```

### 2. SW전자 (SIWN)

아코디언처럼 수십 번 접힌 스마트폰.

```
Cute 3D app icon, soft matte clay and vinyl toy style, pastel colors, gentle studio lighting, soft shadow, chubby rounded shapes. A smartphone folded many times like an accordion or paper fan, zigzag folds, the top panel has a tiny screen face with dot eyes and rosy pink cheeks looking proud. Main color pastel lavender (#EEE8FC) with violet accents (#6A4FB8). Single object, centered, fills 80% of the frame, readable at very small size, 1:1 square, transparent background, no text, no letters, not resembling any real company logo.
```

### 3. MJ일렉트로닉스 (MINJ)

방귀범을 찾는 둥근 CCTV, 옆에 작은 방귀 구름.

```
Cute 3D app icon, soft matte clay and vinyl toy style, pastel colors, gentle studio lighting, soft shadow, chubby rounded shapes. A round dome security camera character with a big glossy lens as one eye and a tiny smile, rosy pink cheeks, a small puffy pastel cloud floating beside it as if it just caught someone farting, playful detective mood. Main color pastel mint (#E3F6EE) with green accents (#2E8C6E). Single object, centered, fills 80% of the frame, readable at very small size, 1:1 square, transparent background, no text, no letters, not resembling any real company logo.
```

### 4. 예도어 (YEDO)

별 모양 머리의 반짝이는 응원봉.

```
Cute 3D app icon, soft matte clay and vinyl toy style, pastel colors, gentle studio lighting, soft shadow, chubby rounded shapes. A K-pop concert light stick with a chubby glowing star-shaped head, the star has tiny dot eyes and rosy pink cheeks and a happy open smile, small sparkles and a mini heart around it. Main color pastel pink (#FFE6EF) with rose accents (#B4466E). Single object, centered, fills 80% of the frame, readable at very small size, 1:1 square, transparent background, no text, no letters, not resembling any real company logo.
```

### 5. 더워스쿨 (DWSC)

땀 흘리는 학사모, 위로 아지랑이.

```
Cute 3D app icon, soft matte clay and vinyl toy style, pastel colors, gentle studio lighting, soft shadow, chubby rounded shapes. A chubby graduation cap character that is sweating from heat, wavy heat lines rising above it and a single sweat drop, tiny dot eyes, rosy flushed cheeks, a determined smile. Main color pastel coral (#FFE6DF) with warm red accents (#C9533E). Single object, centered, fills 80% of the frame, readable at very small size, 1:1 square, transparent background, no text, no letters, not resembling any real company logo.
```

### 6. 민두래곤 (MDRG)

용 뿔과 작은 날개가 달린 통통한 만두.

```
Cute 3D app icon, soft matte clay and vinyl toy style, pastel colors, gentle studio lighting, soft shadow, chubby rounded shapes. A plump steamed dumpling character whose pleats look like little dragon spikes, two tiny dragon horns and small stubby wings, tiny dot eyes, rosy pink cheeks, a proud grin, a wisp of steam on top. Main color pastel butter yellow (#FFF4CC) with golden brown accents (#94700A). Single object, centered, fills 80% of the frame, readable at very small size, 1:1 square, transparent background, no text, no letters, not resembling any real company logo.
```

### 7. 소니항공 (SOAR)

속도선을 달고 쌩 날아가는 통통한 비행기.

```
Cute 3D app icon, soft matte clay and vinyl toy style, pastel colors, gentle studio lighting, soft shadow, chubby rounded shapes. A chubby little airplane zooming forward at full speed with motion lines behind it, the cockpit window forms a face with dot eyes and rosy pink cheeks and a confident smirk, slightly tilted upward. Main color pastel sky cyan (#DDF3FB) with teal blue accents (#2A7F9E). Single object, centered, fills 80% of the frame, readable at very small size, 1:1 square, transparent background, no text, no letters, not resembling any real company logo.
```

### 8. 에바참치 (EEVA)

참치가 빼꼼 나온 삼각김밥.

```
Cute 3D app icon, soft matte clay and vinyl toy style, pastel colors, gentle studio lighting, soft shadow, chubby rounded shapes. A Korean convenience store triangle rice ball (samgak gimbap) half wrapped in seaweed, with a tiny chubby tuna fish peeking out from the top, the rice ball has dot eyes and rosy pink cheeks. Main color pastel sage green (#E8F0E0) with olive green accents (#5B7F2E). Single object, centered, fills 80% of the frame, readable at very small size, 1:1 square, transparent background, no text, no letters, not resembling any real company logo.
```

### 9. 리안뷰티 (RIAN)

반짝이는 립 틴트 병.

```
Cute 3D app icon, soft matte clay and vinyl toy style, pastel colors, gentle studio lighting, soft shadow, chubby rounded shapes. A chubby lip tint bottle with a round cap and a glossy liquid inside, the bottle has tiny dot eyes, rosy pink cheeks and a cheeky smile, a few small sparkles around it. Main color pastel orchid pink (#FCE8F4) with berry accents (#A0457E). Single object, centered, fills 80% of the frame, readable at very small size, 1:1 square, transparent background, no text, no letters, not resembling any real company logo.
```

### 10. 예굼 (YEGM)

작은 전기 불꽃이 튀는 전기 모기채.

```
Cute 3D app icon, soft matte clay and vinyl toy style, pastel colors, gentle studio lighting, soft shadow, chubby rounded shapes. A chubby electric mosquito swatter racket with a tiny spark crackling on its mesh, the racket head has dot eyes, rosy pink cheeks and a fierce but cute expression, a tiny dizzy mosquito with swirl eyes floating beside it. Main color warm cream gray (#F3EEE8) with plum gray accents (#5C5162). Single object, centered, fills 80% of the frame, readable at very small size, 1:1 square, transparent background, no text, no letters, not resembling any real company logo.
```

### 11. GU (GEUU)

음료수 캔을 옆에 둔 푸짐한 도시락.

```
Cute 3D app icon, soft matte clay and vinyl toy style, pastel colors, gentle studio lighting, soft shadow, chubby rounded shapes. An overflowing bento lunch box packed with rice and side dishes, a small soda can leaning next to it, the lunch box lid edge shows dot eyes, rosy pink cheeks and a generous happy smile. Main color pastel aqua mint (#DFF5F0) with deep teal accents (#1F7A6B). Single object, centered, fills 80% of the frame, readable at very small size, 1:1 square, transparent background, no text, no letters, not resembling any real company logo.
```

### 12. 피자대학 (PZUV)

학사모를 쓴 피자 조각.

```
Cute 3D app icon, soft matte clay and vinyl toy style, pastel colors, gentle studio lighting, soft shadow, chubby rounded shapes. A chubby pizza slice wearing a tiny graduation cap with a tassel, melted cheese dripping a little, round pepperoni, dot eyes and rosy pink cheeks with a proud graduate smile. Main color pastel rose red (#FFE0E0) with tomato red accents (#B03030). Single object, centered, fills 80% of the frame, readable at very small size, 1:1 square, transparent background, no text, no letters, not resembling any real company logo.
```

### 13. 구로미해적단 (GURO)

리본 단 해골 깃발과 레이저포를 단 작은 해적선.

```
Cute 3D app icon, soft matte clay and vinyl toy style, pastel colors, gentle studio lighting, soft shadow, chubby rounded shapes. A small chubby dark purple pirate ship with a black flag showing a cute round skull wearing a pastel pink bow, a tiny glowing laser cannon on the deck, the ship hull has dot eyes and rosy cheeks with a mischievous grin. Main color pastel lilac gray (#E9E4F0) with deep purple accents (#4A3F66). Original design, not any existing cartoon character. Single object, centered, fills 80% of the frame, readable at very small size, 1:1 square, transparent background, no text, no letters, not resembling any real company logo.
```

### 14. 고글 (GOOG)

렌즈 한쪽이 돋보기인 고글, 위에 물음표 말풍선.

```
Cute 3D app icon, soft matte clay and vinyl toy style, pastel colors, gentle studio lighting, soft shadow, chubby rounded shapes. A pair of chunky round goggles where one lens is a magnifying glass, the lenses act as big curious eyes, rosy pink cheeks below, a small speech bubble with a question mark floating above. Main color pastel periwinkle (#EAF0FF) with cobalt blue accents (#3F5FD6). Use only these blue tones, not multicolor. Single object, centered, fills 80% of the frame, readable at very small size, 1:1 square, transparent background, no text, no letters, not resembling any real company logo.
```

### 15. 야마존 (AMAZ)

레이저 빛줄기를 타고 날아오는, 살짝 찌그러진 택배 상자.

```
Cute 3D app icon, soft matte clay and vinyl toy style, pastel colors, gentle studio lighting, soft shadow, chubby rounded shapes. A cardboard delivery box flying at the speed of light riding a bright laser beam trail, one corner slightly dented, the box has dot eyes, rosy pink cheeks and a slightly dazed smile, a little packing tape on top. Main color pastel peach orange (#FFEBD2) with burnt orange accents (#A85A12). No arrow or smile logo on the box. Single object, centered, fills 80% of the frame, readable at very small size, 1:1 square, transparent background, no text, no letters, not resembling any real company logo.
```
