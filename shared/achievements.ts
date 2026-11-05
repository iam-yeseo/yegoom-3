/** Achievements, mirrored from the "도전과제" tab of the operations spreadsheet
 * ([YEGOOM] Text Database). The Worker decides when one is unlocked from the
 * tables it already keeps; this file holds the wording, the reward and how
 * often each one can be earned, so every screen reads the same list. */
export type AchievementRepeat = 'once' | 'daily' | 'weekly';
export type AchievementGroup = 'welcome' | 'games' | 'attendance' | 'shop' | 'claw' | 'ranking' | 'misc';

export interface AchievementDefinition {
  key: string;
  group: AchievementGroup;
  title: string;
  /** The condition as written in the sheet; shown under the title. */
  condition: string;
  /** Gold paid when the player collects it. */
  reward: number;
  repeat: AchievementRepeat;
}

/** The games tab with the 도전과제 toggle selected; notifications link here. */
export const ACHIEVEMENTS_PATH = '/games/achievements';

export const ACHIEVEMENT_GROUPS: Record<AchievementGroup, string> = {
  welcome: '환영인사', games: '게임하기', attendance: '출석', shop: '상점', claw: '캐릭터 뽑기', ranking: '랭킹', misc: '기타',
};
export const ACHIEVEMENT_REPEAT_LABEL: Record<AchievementRepeat, string | null> = { once: null, daily: '매일', weekly: '매주' };

export const ACHIEVEMENT_RULES = {
  /** A daily achievement looks back this many calendar days for a late reveal. */
  lookbackDays: 3,
  /** Rank thresholds, in seconds (time games) or points (luck). */
  wake: { near: 600, close: 180 }, offwork: { near: 180, close: 60 }, luck: { near: 3 },
  attendance: { streak: 30, total: 100 },
  slot: { dailySpins: 10 },
  /** Client-reported events the Worker accepts as unlocks. */
  clientEvents: ['font_size'] as const,
} as const;
export type AchievementClientEvent = typeof ACHIEVEMENT_RULES.clientEvents[number];

const once = (key: string, group: AchievementGroup, title: string, condition: string, reward: number): AchievementDefinition =>
  ({ key, group, title, condition, reward, repeat: 'once' });
const daily = (key: string, group: AchievementGroup, title: string, condition: string, reward: number): AchievementDefinition =>
  ({ key, group, title, condition, reward, repeat: 'daily' });

export const ACHIEVEMENTS: readonly AchievementDefinition[] = [
  // 환영인사
  once('welcome', 'welcome', '예굼방 아케이드에 어서오세요', '회원가입', 50),
  once('nickname', 'welcome', '자기소개하기', '닉네임 변경하기', 50),
  once('photo', 'welcome', '내 얼굴 바꾸기', '프로필 사진 변경하기', 50),
  once('password', 'welcome', '보안이 생명입니다', '비밀번호 변경하기', 50),
  once('character', 'welcome', '귀여운 내 캐릭터를 보세요', '캐릭터 변경하기', 50),
  // 게임하기
  once('wake_join', 'games', '기상시간은 처음이지?', '기상시간 게임 참여', 50),
  daily('wake_near', 'games', '진짜 지금 일어난다고?', '기상시간 게임 정답(10분 이내)', 100),
  daily('wake_close', 'games', '진짜 지금 일어났다고?', '기상시간 게임 정답(3분 이내)', 500),
  daily('wake_exact', 'games', '어제 도대체 언제 잔 거야?', '기상시간 게임 정답(정확히 일치)', 1000),
  once('offwork_join', 'games', '이 시간만을 기다리고 있었어', '퇴근시간 게임 참여', 50),
  daily('offwork_near', 'games', '일찍 온 거 아니지?', '퇴근시간 게임 정답(3분 이내)', 50),
  daily('offwork_close', 'games', '나 사실 너 봤어', '퇴근시간 게임 정답(1분 이내)', 50),
  daily('offwork_exact', 'games', '너 내 옆자리야?', '퇴근시간 게임 정답(정확히 일치)', 500),
  once('luck_join', 'games', '바나프레소에 오신 것을 환영합니다!', '행운 점수 맞히기 참여', 50),
  daily('luck_near', 'games', '에티의 가호가 느껴지나요?', '행운 점수 맞히기 정답(3점 이내)', 50),
  daily('luck_exact', 'games', '임캐치에게 행운을 주세요!', '행운 점수 맞히기 정답(정확히 일치)', 500),
  once('catchmind_guess', 'games', '너 그림 정말 ... 그린다!', '캐치마인드 참여(맞히는 사람)', 50),
  once('catchmind_draw', 'games', '내 마음은 이게 아닌데...', '캐치마인드 참여(출제자)', 50),
  daily('catchmind_last', 'games', '발가락으로 그렸니?', '캐치마인드 마지막 기회에서 맞힘', 100),
  daily('catchmind_first', 'games', '우리 서로 통했어.', '캐치마인드 한 번에 정답', 100),
  once('catchmind_misses', 'games', '피카소도 처음엔 그랬대요', '캐치마인드 출제 판이 10번째 오답으로 끝남', 50),
  daily('catchmind_drawn_first', 'games', '말 안 해도 아는 사이', '내 출제를 누군가 한 번에 맞힘', 100),
  // 출석
  once('attend_first', 'attendance', '출근 도장 찍으면 반은 한 거임', '첫 출석', 50),
  once('attend_streak', 'attendance', '출석 중꺾마', '30일 연속 출석', 1000),
  once('attend_total', 'attendance', '100일 케이크는 없습니다', '누적 100일 출석', 2000),
  // 상점
  once('kuji_first', 'shop', '지갑아 미안해', '예굼쿠지 첫 구매', 50),
  once('kuji_a', 'shop', '이거 완전 럭키비키잖아', '예굼쿠지 A상 당첨', 300),
  once('kuji_last', 'shop', '남은 건 원래 다 내 거였음', '예굼쿠지 라스트원 획득', 300),
  once('lotto_first', 'shop', '1등 되면 뭐부터 살지 고민 중', '데일리 로또 첫 구매', 50),
  daily('lotto_zero', 'shop', '이것도 재능입니다', '로또 한 장에서 번호 0개 일치', 50),
  once('lotto_win', 'shop', '퇴근시간 게임은 이제 안녕', '데일리 로또 1등 당첨', 500),
  once('speetto_win', 'shop', '손톱이 일했다', '스피또 첫 당첨', 100),
  once('slot_jackpot', 'shop', '7이 세 개면 행운도 세 배라는 소문이 있습니다', '슬롯머신 7·7·7 첫 당첨', 200),
  daily('slot_ten', 'shop', '손목은 안녕하신가요?', '슬롯머신 하루 10회 돌리기', 100),
  once('tag_first', 'shop', '이름값 하러 왔습니다', '별명 태그 첫 뽑기', 50),
  once('tag_s', 'shop', 'S급 뽑음 ㅇㅈ?', 'S등급 별명 태그 획득', 500),
  once('tag_equip', 'shop', '닉네임 풀착장 완료', '별명 태그 달기', 50),
  // 캐릭터 뽑기
  once('claw_first', 'claw', '집게도 하면 된다', '인형 첫 획득', 50),
  once('claw_clear', 'claw', '기계 거덜 낸 사람', '뽑기 기계 클리어(인형 전부 획득)', 500),
  // 랭킹
  { key: 'rank_week', group: 'ranking', title: '왕관은 무겁지만 써 봅니다', condition: '주간 랭킹 1위(공동 포함)', reward: 300, repeat: 'weekly' },
  once('rank_month', 'ranking', '메달 색은 중요하지 않음(중요함)', '월간 랭킹 3위 안', 300),
  // 기타
  once('notifications', 'misc', '알림 0개 강박', '알림센터 처음 열기', 50),
  once('font_size', 'misc', '눈이 편안해졌어요', '글자 크기 바꾸기', 50),
];

export const ACHIEVEMENT_BY_KEY: ReadonlyMap<string, AchievementDefinition> = new Map(ACHIEVEMENTS.map(item => [item.key, item]));
export const isAchievementKey = (value: unknown): value is string => typeof value === 'string' && ACHIEVEMENT_BY_KEY.has(value);

/** One row of a player's progress: a `once` achievement has the empty period
 * key, a `daily` one the KST date and a `weekly` one the week's Monday. */
export interface AchievementProgress { key: string; periodKey: string; unlockedAt: string; claimedAt: string | null }
export interface AchievementsResponse {
  progress: AchievementProgress[];
  /** How many times each repeatable one has been collected, by key. */
  claimedCounts: Record<string, number>;
  unclaimed: number;
  gold: number;
  serverTime: string;
}
export interface AchievementClaimInput { key: string; periodKey: string }
export interface AchievementEventInput { event: AchievementClientEvent }

/** What the screen shows for one definition: the current period's row (or the
 * oldest unclaimed one, so yesterday's can still be collected). */
export interface AchievementView extends AchievementDefinition {
  status: 'locked' | 'unlocked' | 'claimed';
  periodKey: string;
  claimedCount: number;
}
export function achievementViews(progress: AchievementProgress[], claimedCounts: Record<string, number>): AchievementView[] {
  return ACHIEVEMENTS.map(definition => {
    const rows = progress.filter(row => row.key === definition.key);
    const unclaimed = rows.filter(row => row.claimedAt === null).sort((a, b) => a.periodKey.localeCompare(b.periodKey))[0];
    const claimed = rows.filter(row => row.claimedAt !== null).sort((a, b) => b.periodKey.localeCompare(a.periodKey))[0];
    const row = unclaimed ?? claimed;
    return { ...definition, status: !row ? 'locked' : row.claimedAt === null ? 'unlocked' : 'claimed',
      periodKey: row?.periodKey ?? '', claimedCount: claimedCounts[definition.key] ?? 0 };
  });
}
export const unclaimedCount = (progress: AchievementProgress[]) => progress.filter(row => row.claimedAt === null).length;
