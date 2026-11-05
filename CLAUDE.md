# CLAUDE.md

## 게임 운영 데이터 — 구글 스프레드시트

게임 운영과 관련된 데이터(문구·제시어·종목 등)는 앞으로 아래 구글 스프레드시트에서 관리합니다.
운영 데이터를 바꾸거나 확인할 때는 코드보다 **이 시트를 원본으로** 보고, 코드에 반영할 때 시트 내용과 맞춥니다.

- 시트: [[YEGOOM] Text Database](https://docs.google.com/spreadsheets/d/17-qv3w_IR3qAKVFadRZhuKenMq0AecKKpRBF5n1EFzA/edit)
- 스프레드시트 ID: `17-qv3w_IR3qAKVFadRZhuKenMq0AecKKpRBF5n1EFzA`
- 읽기·쓰기는 Google Sheets 커넥터(`mcp__Google_Sheets__*`)를 사용합니다.

| 탭 | 내용 | 코드에서 쓰는 곳 |
| --- | --- | --- |
| 별명 태그 | 등급(S·A·B·C)별 확률·모양·문구 | `shared/nickname-tags.ts` |
| 캐치마인드 제시어 | 번호·제시어·글자 수·단어 수 (4행이 헤더) | `shared/catchmind-words.ts` |
| 주식 리스트 | 종목명·티커·상장가·기업규모·업종·연동 게임·회사 소개 (2행이 헤더) | `shared/stocks.ts`, `shared/stock-news-templates.ts`, `migrations/0015_stock_market.sql` |
| 도전과제 | 유형·제목·달성조건·보상(골드)·반복 (2행이 헤더, 유형은 묶음의 첫 행에만) | `shared/achievements.ts`(문구·보상·반복), `worker/achievements.ts`(달성 판정) |

운영 문구(도전과제 제목 등)는 주식 리스트의 회사 소개 말투를 따릅니다: 태연하게 황당한 설정, 살짝 비튼 패러디 이름, 끝에서 한 번 비틀기, 요즘 유행어를 섞은 가벼운 농담.

새 운영 데이터(탭)가 생기면 이 표에 추가합니다.
