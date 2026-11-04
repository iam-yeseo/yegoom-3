/** 예굼방 주식 — the ten listed companies (from the user's "예굼방 주식" sheet; listing
 * prices ×10) and the market rules shared by the Worker, the screens and the preview. */
export type Volatility = 'stable' | 'normal' | 'wild';
export type Ticker = 'YKHX' | 'SIWN' | 'MINJ' | 'YEDO' | 'DWSC' | 'MDRG' | 'SOAR' | 'EEVA' | 'RIAN' | 'YEGM';
export interface StockInfo {
  ticker: Ticker; name: string; listingPrice: number; sector: string; volatility: Volatility;
  /** Badge colors (tint background, ink text). */
  tint: string; ink: string; intro: string;
}

export const STOCKS: readonly StockInfo[] = [
  { ticker: 'YKHX', name: 'YK하이커스', listingPrice: 1500, sector: '반도체 생산', volatility: 'stable', tint: '#E3F1FC', ink: '#2F6E9E',
    intro: '최첨단 반도체를 생산하는 세계 최고의 기업으로, 많은 돈을 벌어들이는 회사입니다. 당신이 방구 뀌는 동안에도 이들은 돈을 벌고 있습니다.' },
  { ticker: 'SIWN', name: 'SW전자', listingPrice: 1500, sector: '휴대폰 제조', volatility: 'stable', tint: '#EEE8FC', ink: '#6A4FB8',
    intro: '혁신적인 휴대폰을 만드는 기업입니다. 휴대폰이 1번 접히는 건 석기시대 이야기죠. 이곳은 휴대폰을 129번 접습니다.' },
  { ticker: 'MINJ', name: 'MJ일렉트로닉스', listingPrice: 1500, sector: '전자제품 생산', volatility: 'stable', tint: '#E3F6EE', ink: '#2E8C6E',
    intro: '각종 전자기기를 만드는 곳입니다. 이곳에서 만들지 않는 것이라고는 오직 당신이 쓸 돈. 그거 하나뿐입니다.' },
  { ticker: 'YEDO', name: '예도어', listingPrice: 1000, sector: '엔터테인먼트', volatility: 'normal', tint: '#FFE6EF', ink: '#B4466E',
    intro: '이 세계관 최고의 엔터테인먼트 기업입니다. 수많은 아이돌이 배출되었고, 수많은 아이돌들의 자녀도 배출되었습니다.' },
  { ticker: 'DWSC', name: '더워스쿨', listingPrice: 1000, sector: '교육', volatility: 'normal', tint: '#FFE6DF', ink: '#C9533E',
    intro: '에어컨을 절대 켜지 않는 영어학원에서 시작해 이제는 보일러만 떼는 영어학원입니다. 한여름에도 인기가 폭발해 더 덥습니다.' },
  { ticker: 'MDRG', name: '민두래곤', listingPrice: 1000, sector: '식품 제조', volatility: 'normal', tint: '#FFF4CC', ink: '#94700A',
    intro: '제일 맛있는 만두가 아니면 상장폐지합니다. 사업자 등록할 때 실수로 만두가 아닌 민두로 작성해 현재까지 가업을 이어오고 있습니다.' },
  { ticker: 'SOAR', name: '소니항공', listingPrice: 750, sector: '항공사', volatility: 'normal', tint: '#DDF3FB', ink: '#2A7F9E',
    intro: '빠르게 날아다니는 항공사입니다. 시간 맞춰 오지 않으면 당신을 버려두고 가차없이 떠나버릴 정도로 빠릅니다. 환불이요? 당신 귀책이라 없습니다.' },
  { ticker: 'EEVA', name: '에바참치', listingPrice: 500, sector: '편의점 프랜차이즈', volatility: 'wild', tint: '#E8F0E0', ink: '#5B7F2E',
    intro: '동네마다 5개씩은 있는 편의점 프랜차이즈입니다. 이곳에서 삼각김밥을 하나 샀다간 알바에게 눈치가 보일지도?' },
  { ticker: 'RIAN', name: '리안뷰티', listingPrice: 500, sector: '화장품', volatility: 'wild', tint: '#FCE8F4', ink: '#A0457E',
    intro: '걸리브영에 필수로 입점되어 있는 화장품 브랜드입니다. 환경을 생각하지 않는 행보로 욕을 먹지만, 그게 오히려 환경을 지키는 겁니다.' },
  { ticker: 'YEGM', name: '예굼', listingPrice: 500, sector: '모기 사냥', volatility: 'wild', tint: '#F3EEE8', ink: '#5C5162',
    intro: '세계 최초, 모기 사냥에 성공하면 주가가 오르는 회사입니다. 모기를 잡지 못하면 주가가 대폭 떨어질 수도 있습니다. 겨울에는 주1일 근무를 합니다.' },
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
  /** Scheduled template news per trading day, and their effect range (fraction) by class. */
  newsPerDay: [4, 7] as const,
  newsEffect: { stable: [0.01, 0.04], normal: [0.02, 0.06], wild: [0.03, 0.10] } as Record<Volatility, readonly [number, number]>,
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
