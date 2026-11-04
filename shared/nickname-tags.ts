/** Nickname tags ported from iam-yeseo/yegoom (src/lib/nickname-tags*.js; phrases from the
 * "YEGOOM Text Database" sheet's 별명 태그 tab). A tag is a short phrase shown before a
 * player's nickname; its grade decides the look (S hologram · A gold · B silver · C outline). */
export type NicknameTagGrade = 'S' | 'A' | 'B' | 'C';

/** Phrases introduced at each grade. A grade draws from its pool (TAG_POOLS). */
export const TAG_TEXTS = {
  S: [
    '무한한', '개쩌는', '완벽한', '최고의', '미친(P)', '미친(N)', '우월한', '영롱한', '신', '여신', '왕', '여왕', '전설적인', '불멸의', '압도적인', '찬란한', '독보적인', '절대적인', '위대한',
    '경이로운', '무적의', '찬연한', '고결한', '초월적인', '눈부신', '지존의', '숭고한', '신화적인', '범접불가의', '극상의', '영원한', '존엄한', '먼작귀', '치이맘', '하치맘', '우사기맘', '치이카와',
    '하치와레', '우사기', '먼가작고귀여운',
  ],
  A: [
    '귀여운', '예쁜', '어여쁜', '사랑스러운', '행복한', '깜찍한', '멋있는', '강렬한', '치이카와 팬', '하치와레 팬', '우사기 팬', '모몽가 팬', '시사 팬', '쿠리만쥬 팬', '가르마', '아름다운', '빛나는',
    '상큼한', '싱그러운', '다정한', '매혹적인', '사랑스런', '활기찬', '우아한', '포근한', '달콤한', '낭만적인', '화사한', '반짝이는', '감미로운', '산뜻한', '근사한', '매력적인', '따뜻한', '훈훈한',
  ],
  B: [
    '바쁜', '힘든', '쉽지 않은', '그저 그런', '가벼운', '무거운', '지겨운', '심심한', '눌러붙은', '앉아있는', '산책하는', '힘이 없는', '늦잠을 자는', '일찍 일어나는', '밥을 많이 먹는', '졸린', '피곤한',
    '귀찮은', '평범한', '뒹굴거리는', '멍때리는', '멍한', '애매한', '서성이는', '느긋한', '털털한', '덤덤한', '어설픈', '쭈뼛거리는', '늘어져있는', '널부러진', '하품하는', '끄적이는', '서툰', '그럭저럭인',
  ],
  C: [
    '배가 고픈', '배가 부른', '배가 남산만한', '똥이 마려운', '똥이 급한', '오줌이 마려운', '오줌이 급한', '똥쟁이', '오줌쟁이', '방구쟁이', '방구 냄새가 지독한', '입냄새가 지독한', '입냄새의 신', '뿌직',
    '우웨엑', '현란한 토악질', '한교동 팬', '한교동 여친', '한교동 와이프', '방구 뀌는', '꼬질꼬질한', '꾀죄죄한', '꼬랑내 나는', '씻기 싫은', '침 흘리는', '코를 파는', '코를 고는', '방구차 따라가는',
    '뿡뿡거리는', '냄새나는', '덜 닦은', '배탈이 난', '똥을 참는', '땀범벅인', '쿰척거리는', '찔찔 짜는', '헛구역질하는', '꼬질한', '코를 파먹는',
  ],
} as const satisfies Record<NicknameTagGrade, readonly string[]>;


export const TAG_GRADES = [
  { grade: 'S', chance: 5, label: 'S등급', look: '홀로그램' },
  { grade: 'A', chance: 20, label: 'A등급', look: '금빛' },
  { grade: 'B', chance: 30, label: 'B등급', look: '은빛' },
  { grade: 'C', chance: 45, label: 'C등급', look: '테두리' },
] as const satisfies readonly { grade: NicknameTagGrade; chance: number; label: string; look: string }[];

/** S draws only S phrases, A everything except S, B draws B and C, C only C. */
export const TAG_POOLS: Record<NicknameTagGrade, readonly string[]> = {
  S: TAG_TEXTS.S,
  A: [...TAG_TEXTS.A, ...TAG_TEXTS.B, ...TAG_TEXTS.C],
  B: [...TAG_TEXTS.B, ...TAG_TEXTS.C],
  C: TAG_TEXTS.C,
};
export const gradeLabel = (grade: NicknameTagGrade) => {
  const rule = TAG_GRADES.find(entry => entry.grade === grade)!;
  return `${rule.label} · ${rule.look}`;
};
export const isTagGrade = (value: unknown): value is NicknameTagGrade => value === 'S' || value === 'A' || value === 'B' || value === 'C';

/** Grade first (5/20/30/45 out of 100), then one phrase of that grade's pool with equal odds.
 * `randomInt(max)` returns an integer in [0, max). The Worker passes its unbiased crypto RNG. */
export function drawNicknameTag(randomInt: (max: number) => number): { grade: NicknameTagGrade; text: string } {
  const roll = randomInt(100);
  let cumulative = 0;
  const grade = TAG_GRADES.find(entry => roll < (cumulative += entry.chance))?.grade ?? 'C';
  const pool = TAG_POOLS[grade];
  return { grade, text: pool[randomInt(pool.length)]! };
}
