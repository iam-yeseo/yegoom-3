/** 예굼방 주식 — the listed companies (from the "[YEGOOM] Text Database" sheet's
 * 주식 리스트 tab; listing prices ×10) and the market rules shared by the Worker,
 * the screens and the preview. Volatility follows the listing price: 1,500 stable,
 * 1,000–750 normal, 500 wild. */
export type Volatility = 'stable' | 'normal' | 'wild';
export type Ticker = 'YKHX' | 'SIWN' | 'MINJ' | 'YEDO' | 'DWSC' | 'MDRG' | 'SOAR' | 'EEVA' | 'RIAN' | 'YEGM'
  | 'GEUU' | 'PZUV' | 'GURO' | 'GOOG' | 'AMAZ';
export interface StockInfo {
  ticker: Ticker; name: string; listingPrice: number; sector: string; volatility: Volatility;
  /** Two-letter badge (ticker initials where unique; YEDO/YEGM would both read "YE", GEUU/GURO both "GU"). */
  badge: string;
  /** Badge colors (tint background, ink text). */
  tint: string; ink: string; intro: string;
}

export const STOCKS: readonly StockInfo[] = [
  { ticker: 'YKHX', badge: 'YK', name: 'YK하이커스', listingPrice: 1500, sector: '반도체 생산', volatility: 'stable', tint: '#E3F1FC', ink: '#2F6E9E',
    intro: '최첨단 반도체를 생산하는 세계 최고의 기업으로, 많은 돈을 벌어들이는 회사입니다. 당신이 방구 뀌는 동안에도 이들은 돈을 벌고 있습니다. 이 기업의 최종 목표는 외계인에게도 반도체를 판매하는 것이라는 소문이 있습니다.' },
  { ticker: 'SIWN', badge: 'SW', name: 'SW전자', listingPrice: 1500, sector: '휴대폰 제조', volatility: 'stable', tint: '#EEE8FC', ink: '#6A4FB8',
    intro: '혁신적인 휴대폰을 만드는 기업입니다. 휴대폰이 1번 접히는 건 석기시대 이야기죠. 이곳은 휴대폰을 129번 접습니다. 휴대폰 사업과 이어폰, 케이블, 배터리 등 돈이 될만한 것들은 전부 다 하는 편입니다.' },
  { ticker: 'MINJ', badge: 'MJ', name: 'MJ일렉트로닉스', listingPrice: 1500, sector: '전자제품 생산', volatility: 'stable', tint: '#E3F6EE', ink: '#2E8C6E',
    intro: '각종 전자기기와 가전제품을 제조하여 판매합니다. 악몽을 꾸지 않게 해주는 침대를 개발하기도 하고, 지하철에서 방귀를 뀐 사람을 특정해주는 CCTV를 제작한 이력도 있습니다. 사생활 침해라며 고소를 당할 뻔 하기도 했습니다.' },
  { ticker: 'YEDO', badge: 'YD', name: '예도어', listingPrice: 1000, sector: '엔터테인먼트', volatility: 'normal', tint: '#FFE6EF', ink: '#B4466E',
    intro: '이 세계관 최고의 엔터테인먼트 기업입니다. 수많은 아이돌이 배출되었고, 수많은 아이돌들의 자녀도 배출되었습니다. 아이돌의 자녀들은 아이돌의 후광에 힘입어 민스타그램에서 인플루언서를 하는 불문율이 있습니다.' },
  { ticker: 'DWSC', badge: 'DW', name: '더워스쿨', listingPrice: 1000, sector: '교육', volatility: 'normal', tint: '#FFE6DF', ink: '#C9533E',
    intro: '에어컨을 절대 켜지 않는 영어학원에서 시작해 이제는 보일러만 떼는 영어학원입니다. 한여름에도 인기가 폭발해 더 덥습니다. 중간고사와 기말고사 기간이 다가올 때면 벼락치기를 하려는 학생들로 북적이지만 잠깐 뿐입니다.' },
  { ticker: 'MDRG', badge: 'MD', name: '민두래곤', listingPrice: 1000, sector: '식품 제조', volatility: 'normal', tint: '#FFF4CC', ink: '#94700A',
    intro: '제일 맛있는 만두가 아니면 상장폐지합니다. 사업자 등록할 때 실수로 만두가 아닌 민두로 작성해 현재까지 가업을 이어오고 있습니다. 세계 최초로 입냄새가 나지 않는 민두를 개발하여 노벨스멜상을 받는 것을 목표로 합니다.' },
  { ticker: 'SOAR', badge: 'SO', name: '소니항공', listingPrice: 750, sector: '항공사', volatility: 'normal', tint: '#DDF3FB', ink: '#2A7F9E',
    intro: '빠르게 날아다니는 항공사입니다. 시간 맞춰 오지 않으면 당신을 버려두고 가차없이 떠나버릴 정도로 빠릅니다. 환불이요? 당신 귀책이라 없습니다. 서울에서 뉴욕까지 단 20분 만에 가는 것을 목표로 하지만 안전 따위는 고려하지 않았죠.' },
  { ticker: 'EEVA', badge: 'EV', name: '에바참치', listingPrice: 500, sector: '편의점 프랜차이즈', volatility: 'wild', tint: '#E8F0E0', ink: '#5B7F2E',
    intro: '동네마다 20개씩은 존재한다는 편의점 프랜차이즈입니다. 경쟁업체인 GU가 망하기만을 기다리며 오늘도 출근할 때마다 직원들이 물을 떠놓는다는 소문이 돌고 있습니다. 하지만 직원들의 점심은 GU가 책임진다는 소문도 돌곤 하죠.' },
  { ticker: 'RIAN', badge: 'RI', name: '리안뷰티', listingPrice: 500, sector: '화장품', volatility: 'wild', tint: '#FCE8F4', ink: '#A0457E',
    intro: '걸리브영에 필수로 입점되어 있는 화장품 브랜드입니다. 환경을 생각하지 않는 행보로 욕을 먹지만, 그게 오히려 환경을 지키는 것이라는 해명을 하곤 합니다. 10대들의 절대적인 인지도를 자랑하고 있으며, 콧구멍에도 틴트를 바르는 제품으로 큰 화제를 모았습니다.' },
  { ticker: 'YEGM', badge: 'YG', name: '예굼', listingPrice: 500, sector: '모기 사냥', volatility: 'wild', tint: '#F3EEE8', ink: '#5C5162',
    intro: '세계 최초, 모기 사냥에 성공하면 주가가 오르는 회사입니다. 모기를 잡지 못하면 주가가 대폭 떨어질 수도 있습니다. 겨울에는 주1일 근무를 합니다. 모기를 잡기 위해 전략폭격기까지 구매하였지만, 현재는 격납고에서 썩어나가고 있는 중이라고 합니다.' },
  { ticker: 'GEUU', badge: 'GU', name: 'GU', listingPrice: 500, sector: '편의점 프랜차이즈', volatility: 'wild', tint: '#DFF5F0', ink: '#1F7A6B',
    intro: '에바참치사의 경쟁사로, 동네마다 19개씩은 존재한다는 편의점 프랜차이즈입니다. 점유율은 에바참치에 비해 부족하지만, 에바참치에서 삼각김밥 1개 사먹을 돈으로 GU에서는 도시락 1판을 사먹고도 음료수까지 사 마실 수 있다고 합니다.' },
  { ticker: 'PZUV', badge: 'PZ', name: '피자대학', listingPrice: 1000, sector: '피자 프랜차이즈', volatility: 'normal', tint: '#FFE0E0', ink: '#B03030',
    intro: '10대 학생들의 워너비 스쿨 중 하나입니다. 이 세계관에서는 돌잔치부터 생일파티, 결혼식, 환갑잔치 심지어 장례식까지도 피자대학에서 진행할만큼 거대한 인프라를 자랑합니다. 당연히 음식은 피자만 제공됩니다. 석사 학위는 아직 받을 수 없다고 합니다.' },
  { ticker: 'GURO', badge: 'GR', name: '구로미해적단', listingPrice: 750, sector: '해적업', volatility: 'normal', tint: '#E9E4F0', ink: '#4A3F66',
    intro: '바다의 평화는 이들이 망칩니다. 인기 캐릭터 구로미를 필두로 하여 해상에서 돌아다니는 무역선들을 약탈하거나 심지어는 나포하여 자신들의 배로 개조하곤 합니다. 이들은 초광선레이저포로 무장하여 쉽사리 퇴치하기 어렵습니다. 그런데 상장은 어떻게 했을까요?' },
  { ticker: 'GOOG', badge: 'GO', name: '고글', listingPrice: 1500, sector: '인터넷 사업', volatility: 'stable', tint: '#EAF0FF', ink: '#3F5FD6',
    intro: '세상에서 가장 쓸데없는 질문이 많은 곳입니다. 겨드랑이가 간지러운데 저 죽을 병 걸린 걸까요? 같은 질문이 하루에도 5억 8천만 건이 들어옵니다! 이런 질문에 대답하는 것 자체만으로도 시간을 허비하는 것이니 여러분들은 쓸데있는 질문에만 대답하십시오.' },
  { ticker: 'AMAZ', badge: 'AM', name: '야마존', listingPrice: 1500, sector: '커머스 사업', volatility: 'stable', tint: '#FFEBD2', ink: '#A85A12',
    intro: '시장이나 마트에 가기 귀찮으신가요? 야마존은 빠릅니다. 총알배송보다 더 빠른 레이저배송으로 물건 주문 이후 30분 이내에 여러분의 집 앞으로 물건을 배송해드립니다. 다만, 빛의 속도로 배송되기 때문에 여러분의 상품이 온전하다고는 장담드릴 수 없습니다.' },
];
export const TICKERS = STOCKS.map(stock => stock.ticker);
export const stockInfo = (ticker: string): StockInfo | undefined => STOCKS.find(stock => stock.ticker === ticker);
export const isTicker = (value: unknown): value is Ticker => typeof value === 'string' && TICKERS.includes(value as Ticker);

export const STOCK_RULES = {
  openTime: '09:00', closeTime: '18:00', tickMinutes: 10,
  /** Daily move limit against the previous close. */
  dailyLimit: 0.15,
  fee: 0.01, maxOrder: 500, maxHolding: 500,
  /** Delisting: two consecutive closes below this share of the listing price (warning, then delisting). */
  delistRatio: 0.8, relistAfterTradingDays: 10,
  /** Per-tick log-return standard deviation by volatility class. */
  sigma: { stable: 0.0035, normal: 0.006, wild: 0.01 } as Record<Volatility, number>,
  /** Per-tick mean reversion toward the listing price. Tuned with the 1,000-run
   * simulation in tests/stock-engine.test.ts (about 0.3 delistings a month). */
  reversion: 0.005,
  /** Price-moving news per trading day (the other news slots are mood pieces), and their effect range (fraction) by class. */
  newsPerDay: [4, 7] as const,
  newsEffect: { stable: [0.01, 0.04], normal: [0.02, 0.06], wild: [0.03, 0.10] } as Record<Volatility, readonly [number, number]>,
  /** 찌라시: spreads at ±2–3%; 2–4 hours (12–24 ticks) later true 60% (±4–8% the same
   * way) or denied (the rumor undone plus 1–2% the other way). */
  rumor: { perDay: [1, 2], truthRate: 0.6, spread: [0.02, 0.03], confirm: [0.04, 0.08], deny: [0.01, 0.02], delaySlots: [4, 8] } as const,
  /** One article every 30 minutes from 09:00 to 17:30 (18 a day); 3 ticks apart. */
  newsSlots: 18, newsSlotTicks: 3,
  /** YEGM trades only on this weekday (0 = Sunday … 3 = Wednesday) in December–February. */
  yegmWinterWeekday: 3,
  /** Free-plan budget: ticks are kept this long, daily candles forever. */
  tickRetentionDays: 30,
  /** One advance computes at most this many 10-minute ticks; a gap longer than
   * `staleGapDays` (e.g. the market was switched off) restarts from today. */
  maxCatchUpTicks: 60, staleGapDays: 3,
} as const;

/** Fee in gold for a trade amount: 1%, rounded up, at least 1G. */
export const tradeFee = (amount: number) => Math.max(1, Math.ceil(amount * STOCK_RULES.fee));
