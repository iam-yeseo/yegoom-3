import { seededRandom } from './stock-engine';
import { stockInfo, type Ticker } from './stocks';
import { subjectParticle } from './stock-news-templates';

/** Hidden company life cycles. Each company moves through phases lasting 5–15
 * days; the phase and its length come from a secret seed, so nobody can see or
 * predict them. A phase only shapes which companies make the news, whether
 * their price-moving news is good or bad, and the story the articles tell. */
export type Phase = 'growth' | 'peak' | 'stagnation' | 'crisis' | 'recovery' | 'venture';
export const PHASES: Record<Phase, { label: string; upRate: number; weight: number; size: number; next: readonly (readonly [Phase, number])[] }> = {
  growth: { label: '성장기', upRate: 0.65, weight: 1.3, size: 1, next: [['peak', 0.6], ['crisis', 0.2], ['venture', 0.2]] },
  peak: { label: '전성기', upRate: 0.55, weight: 1.1, size: 0.9, next: [['stagnation', 0.5], ['crisis', 0.3], ['venture', 0.2]] },
  stagnation: { label: '정체기', upRate: 0.5, weight: 0.7, size: 0.7, next: [['crisis', 0.4], ['venture', 0.3], ['growth', 0.3]] },
  crisis: { label: '위기', upRate: 0.35, weight: 1.4, size: 1, next: [['recovery', 0.7], ['venture', 0.3]] },
  recovery: { label: '회복기', upRate: 0.62, weight: 1.2, size: 1, next: [['growth', 0.7], ['stagnation', 0.3]] },
  venture: { label: '신사업 도전', upRate: 0.5, weight: 1.3, size: 1.25, next: [['growth', 0.5], ['crisis', 0.5]] },
};
const ORDER = Object.keys(PHASES) as Phase[];
export const LIFECYCLE_RULES = { epoch: '2026-01-01', minDays: 5, maxDays: 15 } as const;

const dayNumber = (date: string) => Math.floor(Date.parse(`${date}T00:00:00Z`) / 86_400_000);
const cache = new Map<string, { ends: number[]; phases: Phase[] }>();
/** The phase of a company on a date (deterministic for the same seed). */
export function companyPhase(seed: string, ticker: Ticker, date: string): Phase {
  const key = `${seed}|${ticker}`;
  let run = cache.get(key);
  if (!run) {
    if (cache.size > 200) cache.clear();
    cache.set(key, run = { ends: [], phases: [] });
  }
  const day = Math.max(0, dayNumber(date) - dayNumber(LIFECYCLE_RULES.epoch));
  while (!run.ends.length || run.ends[run.ends.length - 1]! <= day) {
    const k = run.ends.length;
    const random = seededRandom(`${seed}|${ticker}|phase|${k}`);
    const start = k ? run.ends[k - 1]! : 0;
    const length = LIFECYCLE_RULES.minDays + Math.floor(random() * (LIFECYCLE_RULES.maxDays - LIFECYCLE_RULES.minDays + 1));
    let phase: Phase;
    if (!k) phase = ORDER[Math.floor(random() * ORDER.length)]!;
    else {
      let roll = random();
      const choices = PHASES[run.phases[k - 1]!].next;
      phase = choices[choices.length - 1]![0];
      for (const [candidate, chance] of choices) { if ((roll -= chance) < 0) { phase = candidate; break; } }
    }
    run.ends.push(start + length);
    run.phases.push(phase);
  }
  return run.phases[run.ends.findIndex(end => end > day)]!;
}

/** Mood pieces (no price effect) for empty news slots, by phase. */
const FEATURES: Record<Phase, readonly ((name: string, josa: string) => readonly [string, string])[]> = {
  growth: [
    (n, j) => [`${n}, 채용 공고 두 배로 늘려`, `${n}${j} 사람을 더 뽑는다. 면접 대기실 의자가 모자라 회의실 의자까지 동원됐다는 후문이다.`],
    (n) => [`${n} 사옥, 주차장이 꽉 찼다`, `${n} 직원들이 아침마다 주차 자리를 두고 눈치 싸움을 벌이고 있다. 회사는 주차장 증설을 검토 중이다.`],
    (n) => [`${n} 사내 식당 메뉴 한 가지 추가`, `바빠진 직원들을 위해 ${n} 사내 식당이 반찬을 하나 더 내놓기로 했다. 직원들은 조용히 환호했다.`],
  ],
  peak: [
    (n) => [`${n}, 사보 표지에 대표 얼굴`, `${n} 사보 이번 호 표지는 대표의 활짝 웃는 얼굴이다. 인쇄소는 잉크가 모자랐다고 전했다.`],
    (n, j) => [`${n}, 창립 기념 떡 돌려`, `${n}${j} 이웃 회사에 떡을 돌렸다. 받은 사람들은 맛은 있는데 왜 주는지는 모르겠다고 했다.`],
    (n) => [`${n} 로비에 트로피 진열장 등장`, `${n} 로비에 트로피 진열장이 생겼다. 아직 칸이 많이 비어 있지만 회사는 곧 채우겠다고 했다.`],
  ],
  stagnation: [
    (n) => [`${n}, 이번 주 회의 안건 "다음 회의 일정"`, `${n} 주간 회의의 안건은 다음 회의 날짜를 정하는 것이었다. 결론은 다음 회의에서 나올 예정이다.`],
    (n) => [`${n} 직원들, 점심 메뉴 고민이 업무의 절반`, `${n} 사무실에서 가장 오래 걸리는 결정은 점심 메뉴라는 제보가 들어왔다. 회사는 부인하지 않았다.`],
    (n) => [`${n}, 탕비실 커피 원두 교체`, `${n} 탕비실 원두가 바뀌었다. 직원들은 이번 분기 가장 큰 변화라고 입을 모았다.`],
  ],
  crisis: [
    (n) => [`${n} 고객센터, 대기 음악만 세 시간째`, `${n} 고객센터에 전화가 몰려 대기 음악이 끊이지 않는다. 일부 고객은 음악이 꽤 좋다고 평가했다.`],
    (n) => [`${n} 대표, 사내 게시판에 "힘내자" 글`, `${n} 대표가 사내 게시판에 짧은 응원 글을 올렸다. 댓글 창은 아직 조용하다.`],
    (n) => [`${n}, 비상 회의실 불 밤늦게까지`, `${n} 회의실 불이 밤늦게까지 꺼지지 않고 있다. 배달 음식 주문도 평소의 두 배라고 한다.`],
  ],
  recovery: [
    (n) => [`${n} 사무실에 다시 웃음소리`, `한동안 조용하던 ${n} 사무실에서 웃음소리가 들리기 시작했다. 탕비실 간식도 다시 채워졌다.`],
    (n, j) => [`${n}, 직원 단체 산책 재개`, `${n}${j} 점심 산책 모임을 다시 시작했다. 참가자들은 발걸음이 가벼워졌다고 말했다.`],
    (n) => [`${n} 대표, 오랜만에 넥타이 풀어`, `${n} 대표가 오랜만에 넥타이를 풀고 출근했다. 직원들은 좋은 징조로 받아들이고 있다.`],
  ],
  venture: [
    (n, j) => [`${n}, 사내에 "신사업 아이디어함" 설치`, `${n}${j} 아이디어함을 만들었다. 첫날 들어온 쪽지 대부분은 간식 추가 요청이었다.`],
    (n) => [`${n} 연구실 문에 "출입 금지" 팻말`, `${n} 연구실 문에 새 팻말이 붙었다. 안에서 무엇을 하는지는 아무도 말해 주지 않는다.`],
    (n) => [`${n} 직원들, 낯선 분야 책 읽기 열풍`, `${n} 사무실 책상마다 처음 보는 분야의 책이 쌓이고 있다. 회사는 "공부 중"이라고만 밝혔다.`],
  ],
};
export function featureArticle(ticker: Ticker, phase: Phase, variant: number): { headline: string; body: string } {
  const name = stockInfo(ticker)!.name;
  const list = FEATURES[phase];
  const [headline, body] = list[variant % list.length]!(name, subjectParticle(name));
  return { headline, body };
}
