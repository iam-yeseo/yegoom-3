import { GAME_RULES } from './balance';
import type { GameId } from './types';
import type { Ticker } from './stocks';

/** Game results that move stocks (docs/plan-stock.md §7). Authors come from
 * GAME_RULES, never hard-coded names. */
export const GAME_STOCK: Record<GameId, Ticker> = { wake: 'MINJ', offwork: 'SIWN', luck: 'YEDO' };
export const STOCK_GAME_RULES = {
  /** Every 30 minutes earlier than usual: +4%, capped at ±8%. */
  minutesPerStep: 30, bpPerStep: 400, maxBp: 800,
  /** "Usual" = median of the last 14 published answers before today; fewer than 3 → default. */
  baselineRounds: 14, minRounds: 3,
  defaults: { wake: '08:00:00', offwork: '18:00:00' } as const,
  /** Results published within this many days still become events (weekend gap). */
  lookbackDays: 4,
  /** YEGM mosquito hunts: 0–2 per YEGM trading day, 55% success, ±5–12%. */
  mosquito: { maxPerDay: 2, successRate: 0.55, effect: [0.05, 0.12] as const },
} as const;

export const gameForTicker = (ticker: string): GameId | null =>
  (Object.keys(GAME_STOCK) as GameId[]).find(game => GAME_STOCK[game] === ticker) ?? null;
export const isAuthorOf = (username: string, game: GameId) => GAME_RULES[game].author === username.toLowerCase();

const seconds = (time: string) => Number(time.slice(0, 2)) * 3600 + Number(time.slice(3, 5)) * 60 + Number(time.slice(6, 8) || 0);
const clock = (total: number) => `${String(Math.floor(total / 3600)).padStart(2, '0')}:${String(Math.floor(total / 60) % 60).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
/** Median of HH:MM:SS answers (the mean of the two middle values when even). */
export function usualTime(answers: readonly string[], game: 'wake' | 'offwork'): string {
  if (answers.length < STOCK_GAME_RULES.minRounds) return STOCK_GAME_RULES.defaults[game];
  const sorted = answers.map(seconds).sort((a, b) => a - b);
  const middle = sorted.length >> 1;
  return clock(sorted.length % 2 ? sorted[middle]! : Math.round((sorted[middle - 1]! + sorted[middle]!) / 2));
}
/** The price effect of a published answer, in basis points. Earlier is better. */
export function gameEffectBp(game: GameId, answer: string, usual?: string): number {
  const { maxBp, bpPerStep, minutesPerStep } = STOCK_GAME_RULES;
  const clamp = (value: number) => Math.round(Math.max(-maxBp, Math.min(maxBp, value)));
  if (game === 'luck') return clamp(((Number(answer) - 50) / 50) * maxBp);
  const minutesEarlier = (seconds(usual!) - seconds(answer)) / 60;
  return clamp((minutesEarlier / minutesPerStep) * bpPerStep);
}

const hm = (time: string) => `${time.slice(0, 2)}시 ${time.slice(3, 5)}분`;
/** Template article for a game result (AI news may replace it in PR 12). */
export function gameArticle(game: GameId, answer: string, author: string, usual: string | null, effectBp: number): { headline: string; body: string } {
  const up = effectBp > 0, flat = effectBp === 0;
  const mood = flat ? '보합' : up ? '들썩' : '주춤';
  if (game === 'luck') {
    return { headline: `[속보] 행운 점수 ${answer}점, 예도어 ${mood}`,
      body: flat ? `${author}님의 행운이 딱 중간이라 예도어 연습생들도 평소처럼 연습했다.`
        : up ? `${author}님의 행운 기운이 예도어 연습실까지 번졌다. 신곡 반응이 심상치 않다는 후문이다.`
          : `${author}님의 행운이 잠시 쉬어 가는 날, 예도어 연습실 거울에도 김이 서렸다.` };
  }
  const minutes = Math.round(Math.abs(seconds(usual!) - seconds(answer)) / 60);
  const versus = minutes === 0 ? '평소와 같은 시각' : `평소(${hm(usual!)})보다 ${minutes}분 ${up ? '일찍' : '늦게'}`;
  if (game === 'wake') {
    return { headline: `[속보] ${author}님 ${hm(answer)} 기상, MJ일렉트로닉스 ${mood}`,
      body: `${versus} 일어났다는 소식이다. ${flat ? 'MJ일렉트로닉스 공장도 평소 속도로 돌아갔다.' : up ? '알람시계 주문이 몰리며 공장이 바빠졌다.' : '알람시계 반품 문의가 늘어 공장이 잠시 멈췄다.'}` };
  }
  return { headline: `[속보] ${author}님 ${hm(answer)} 퇴근, SW전자 ${mood}`,
    body: `${versus} 퇴근했다는 소식이다. ${flat ? 'SW전자 휴대폰도 평소처럼 접혔다.' : up ? '남는 저녁 시간에 휴대폰을 한 번 더 접는 사람이 늘었다.' : '야근 소식에 휴대폰 접는 손이 느려졌다.'}` };
}

const MOSQUITO = {
  success: [
    ['[속보] 예굼 사냥팀, 모기 포획 성공', '천장 구석에 숨어 있던 모기를 한 번에 잡아냈다. 사냥팀은 오늘 밤 푹 잘 수 있을 전망이다.'],
    ['[속보] 예굼, 귓가 "위잉" 모기 퇴치', '소리만 듣고 정확히 손뼉을 마주쳤다. 박수 소리가 사무실에 울려 퍼졌다.'],
    ['[속보] 예굼 전기채, 모기 세 마리 연속 명중', '전기채에서 경쾌한 소리가 연달아 났다. 사냥팀장은 은퇴 경기 같았다고 말했다.'],
  ],
  fail: [
    ['[속보] 예굼 사냥팀, 모기 놓쳐', '불을 켜는 순간 모기가 사라졌다. 사냥팀은 밤새 귓가 소리에 시달릴 예정이다.'],
    ['[속보] 예굼, 모기 대신 벽만 때려', '벽에 손자국만 남았고 모기는 유유히 날아갔다. 주주들의 한숨이 이어졌다.'],
    ['[속보] 예굼 본사, 모기에 열 군데 물려', '사냥은커녕 사냥팀이 사냥당했다. 긁느라 오늘 업무는 사실상 중단됐다.'],
  ],
} as const;
export function mosquitoArticle(success: boolean, variant: number): { headline: string; body: string } {
  const list = MOSQUITO[success ? 'success' : 'fail'];
  const [headline, body] = list[variant % list.length]!;
  return { headline, body };
}
