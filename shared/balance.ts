import type { GameId, Inventory } from './types';

export const ANNOUNCEMENT_RULES = { recentMs: 10 * 60_000, limit: 5, displayMs: 4000, lottoRanks: [1, 2, 3] as const } as const;

export const FEATURES = { stock: true };
/** AI stock news (docs/plan-stock.md §8). Prices per million tokens for Claude
 * Opus 5.5 ($4 input, $20 output, $5 cache write, $0.20 cache read), checked
 * 2026-11-05 against the Claude API reference; when a server-side fallback model
 * answers, the higher Opus rates ($5/$25/$6.25/$0.50) are charged to be safe.
 * The daily cap keeps spending under the user's $1/day limit. */
export const AI_RULES = {
  model: 'claude-opus-5-5', effort: 'medium', maxTokens: 16000, timeoutMs: 90_000,
  dailyCapMicroUsd: 800_000,
  microUsdPerToken: { input: 4, output: 20, cacheWrite: 5, cacheRead: 0.2 },
  fallbackMicroUsdPerToken: { input: 5, output: 25, cacheWrite: 6.25, cacheRead: 0.5 },
  /** OpenAI alternative (the administrator picks the engine). gpt-6.1-sol: $2 input,
   * $10 output per million tokens; cached input is listed at $0.10–$0.20 by different
   * sources (checked 2026-11-05, secondary pricing pages), so the higher is charged.
   * Prompt caching is automatic; reasoning tokens are billed as output. */
  openai: { model: 'gpt-6.1-sol', reasoningEffort: 'medium', microUsdPerToken: { input: 2, output: 10, cacheWrite: 2, cacheRead: 0.2 } },
  providers: ['openai', 'anthropic'],
  headlineMax: 40, bodyMax: 200, commentMax: 120, recentHeadlines: 20,
  /** Whale trades: anonymous news, no price effect, once an hour per person and stock. */
  whaleGold: 20_000, whaleShares: 100,
} as const;
export const LAUNCH_GIFT = { date: '2026-11-02', lottoTickets: 5, speettoTickets: 5 } as const;

/** Every game closes at 23:50 KST each day (Catchmind, predictions, the shop
 * games, the claw and free throw). Whatever is still played, guessed or revealed
 * after that may show its result, but it never counts toward score or ranking:
 * the last ten minutes keep each day's ranking final before midnight. */
export const PLAY_RULES = { closeTime: '23:50:00', closedMessage: '오늘 게임은 밤 11시 50분에 마감했어요. 자정에 다시 열려요.' } as const;
/** When the given KST game day stops taking play and scores. */
export const playCloseAt = (date: string): number => Date.parse(`${date}T${PLAY_RULES.closeTime}+09:00`);
/** True from 23:50 to midnight KST. */
export const playClosed = (now: number): boolean =>
  new Date(now + 9 * 60 * 60 * 1000).toISOString().slice(11, 19) >= PLAY_RULES.closeTime;
/** The play window at `now`: whether the 23:50 close is on, and the instant it
 * next flips (23:50 today, or the coming midnight). A screen that knows the
 * server's clock can close and reopen its inputs on time from this alone. */
export function playWindow(now: number): { closed: boolean; changesAt: string } {
  const date = new Date(now + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const closed = playClosed(now);
  const changesAt = closed ? Date.parse(`${date}T00:00:00+09:00`) + 24 * 60 * 60 * 1000 : playCloseAt(date);
  return { closed, changesAt: new Date(changesAt).toISOString() };
}
/** A score belongs to its game day only if it was earned before that day closed. */
export const scoreCounts = (gameDate: string, earnedAt: number): boolean => earnedAt < playCloseAt(gameDate);

/** The published prediction rules, shared by settlement, help, and previews. */
export const GAME_RULES = {
  wake: { title: '기상시간 맞히기', author: 'min', deadline: '10:30:00' },
  offwork: { title: '퇴근시간 맞히기', author: 'siwon', deadline: '17:00:00' },
  luck: { title: '행운 점수 맞히기', author: 'yeseo', deadline: '17:00:00', revealTime: '18:00:00' },
} as const satisfies Record<GameId, { title: string; author: string; deadline: string; revealTime?: string }>;

/** The three prediction games rest on Saturday and Sunday (KST): no round opens
 * on those dates, whatever the administrator's ON/OFF setting says. */
export const predictionDayOff = (date: string): boolean => [0, 6].includes(new Date(`${date}T00:00:00Z`).getUTCDay());
/** When the next round after a rest day opens: 00:00 KST of the next weekday. */
export function nextPredictionOpenAt(date: string): number {
  let next = Date.parse(`${date}T00:00:00+09:00`);
  do next += 86_400_000; while (predictionDayOff(new Date(next + 9 * 3_600_000).toISOString().slice(0, 10)));
  return next;
}

export const PREDICTION_REWARDS = { participationGold: 100, firstGold: 100 } as const;
export const ATTENDANCE_RULES = {
  cycleLength: 7, dailyGold: 100, cycleGold: 500,
  /** Attendance paid one lotto and one speetto ticket from 11/3 to 11/6; from
   * 11/7 the daily free items (DAILY_FREE) replace them. */
  ticketsFrom: '2026-11-03', ticketsUntil: '2026-11-07', lottoTickets: 1, speettoTickets: 1,
} as const;
/** Every KST day each player may use this many of each item for free. Unused
 * ones are not carried over: the count starts again at midnight. */
export const DAILY_FREE = { lotto: 3, speetto: 3, slot: 3, tag: 3 } as const;
export type DailyFreeKind = keyof typeof DAILY_FREE;
/** date is the server's KST attendance day (the local KST day in previews). */
export function attendanceTickets(date: string): Inventory {
  const active = date >= ATTENDANCE_RULES.ticketsFrom && date < ATTENDANCE_RULES.ticketsUntil;
  return { lottoTickets: active ? ATTENDANCE_RULES.lottoTickets : 0, speettoTickets: active ? ATTENDANCE_RULES.speettoTickets : 0, tagTickets: 0 };
}
export function attendanceRewardLabel(gold: number, date: string): string {
  const tickets = attendanceTickets(date);
  return `${gold}G${tickets.lottoTickets ? ` + 로또 ${tickets.lottoTickets}` : ''}${tickets.speettoTickets ? ` + 스피또 ${tickets.speettoTickets}` : ''}`;
}
export function attendanceCycleDay(streak: number): number {
  return ((streak - 1) % ATTENDANCE_RULES.cycleLength) + 1;
}
export function attendanceReward(streak: number): number {
  return streak % ATTENDANCE_RULES.cycleLength === 0 ? ATTENDANCE_RULES.cycleGold : ATTENDANCE_RULES.dailyGold;
}
export const CATCHMIND_RULES = {
  hintAfter: 5, endAfter: 10, score: 3, gold: 5,
  pollIntervalMs: 5000, idlePollIntervalMs: 10000,
  skipAfterMs: 10 * 60 * 1000,
  maxImageBytes: 300 * 1024, maxAnswerLength: 80, maxWordLength: 20, galleryPageSize: 9,
  // A drawing's decoded size is bounded as well as its file size: a few hundred
  // kilobytes can encode an image that decodes to gigabytes. The canvas is
  // 680px and exports at 680, 544, 408 or 340px (DrawingCanvas), so one side of
  // 1,024px leaves room; 1,024 x 1,024 pixels decode to 4MiB of RGBA.
  canvasSide: 680, maxImageSide: 1024, maxImagePixels: 1024 * 1024,
} as const;
/** Public claw economy only; grip settings and counters stay in the server DB. */
export const CLAW_RULES = {
  coinIntervalMs: 3 * 60 * 60 * 1000, freeCoins: 5,
  coinPrice: 100, purchaseQuantities: [1, 5],
  dollScore: 1, dollGold: 10, clearScore: 5, clearGold: 300,
  playDurationMs: 6000, controlDurationMs: 10000, engine: 2,
} as const;
/** Free-throw duel (docs/plan-freethrow.md). Practice is unlimited and pays
 * nothing. An official set of shotsPerSet balls opens every setIntervalMs (KST
 * 00·03·06·…·21시, like the claw's coins) and each goal pays goalScore + goalGold.
 * A set started near the end of its slot may finish within graceMs after it.
 * engine is stored with each set; bump it whenever shared/freethrow-physics.ts
 * changes outcomes. */
export const FREETHROW_RULES = {
  shotsPerSet: 10, setIntervalMs: 3 * 60 * 60 * 1000, graceMs: 10 * 60 * 1000,
  goalScore: 1, goalGold: 5, engine: 1, officialOpen: true,
} as const;
export const freeThrowSlot = (now: number): number => Math.floor(now / FREETHROW_RULES.setIntervalMs);
export const freeThrowSlotStart = (slot: number): number => slot * FREETHROW_RULES.setIntervalMs;
export const freeThrowDeadline = (slot: number): number => (slot + 1) * FREETHROW_RULES.setIntervalMs + FREETHROW_RULES.graceMs;
/** Curling and the penalty shoot-out (docs/plan-curling.md, docs/plan-penalty.md).
 * Like the free throw, each opens one set every three hours, but an hour apart
 * so a new solo game opens every hour: free throw at KST 00·03·…·21시, curling
 * at 01·04·…·22시 and penalties at 02·05·…·23시. A set is `tries` throws or
 * kicks, recorded in one request; each one that counts pays score + gold. A set
 * started near the end of its slot may finish within graceMs after it. engine
 * is stored with each set; bump it whenever the game's shared engine changes
 * outcomes. */
export const ARCADE_RULES = {
  curling: { tries: 5, slotMs: 3 * 60 * 60 * 1000, offsetMs: 1 * 60 * 60 * 1000, graceMs: 10 * 60 * 1000, score: 1, gold: 10, engine: 1 },
  penalty: { tries: 5, slotMs: 3 * 60 * 60 * 1000, offsetMs: 2 * 60 * 60 * 1000, graceMs: 10 * 60 * 1000, score: 1, gold: 10, engine: 1 },
} as const;
export type ArcadeGame = keyof typeof ARCADE_RULES;
export const ARCADE_GAMES = Object.keys(ARCADE_RULES) as ArcadeGame[];
export const isArcadeGame = (value: unknown): value is ArcadeGame => typeof value === 'string' && Object.hasOwn(ARCADE_RULES, value);
export const arcadeSlot = (game: ArcadeGame, now: number): number => Math.floor((now - ARCADE_RULES[game].offsetMs) / ARCADE_RULES[game].slotMs);
export const arcadeSlotStart = (game: ArcadeGame, slot: number): number => slot * ARCADE_RULES[game].slotMs + ARCADE_RULES[game].offsetMs;
export const arcadeDeadline = (game: ArcadeGame, slot: number): number => arcadeSlotStart(game, slot + 1) + ARCADE_RULES[game].graceMs;
/** Bingo (docs/plan-bingo.md): the leader names a topic and the winning line
 * count, 30 words are made from it, and everyone fills a 5x5 board from them. */
export const BINGO_RULES = {
  size: 5, words: 30, lineChoices: [3, 5] as const,
  /** Points for the first three to finish, paid the moment each place is settled. */
  rankScores: [5, 3, 1] as const,
  minPlayers: 2,
  /** After this long another player may pass a waiting turn, start a filled game, or pass the lead. */
  skipAfterMs: 10 * 60 * 1000,
  maxTopicLength: 40, maxWordLength: 10,
  pollIntervalMs: 5000, idlePollIntervalMs: 10000,
  /** The word list is written by OpenAI (worker/bingo-ai.ts); the daily cap is shared with stock news. */
  ai: { reasoningEffort: 'low' as const, maxTokens: 4000, timeoutMs: 45_000 },
} as const;
/** Santa's gift delivery, a limited Christmas event (docs/plan-santa.md). One run
 * of `houses` chimneys per KST half day (오전 00–12시, 오후 12–24시). Each gift in a
 * chimney pays hitScore, all of them adds perfectBonus, and finishing the run
 * (every house thrown at or passed) pays clearGold whatever the hits. A run
 * started near the end of its half day may finish within graceMs after it.
 * engine is stored with each run; bump it whenever shared/santa-engine.ts
 * changes outcomes. */
export const SANTA_RULES = {
  houses: 10, slotMs: 12 * 60 * 60 * 1000, graceMs: 10 * 60 * 1000,
  hitScore: 1, perfectBonus: 3, clearGold: 100, engine: 1,
  /** No new run starts from this moment (2026-12-26 00:00 KST). */
  endsAt: Date.parse('2026-12-26T00:00:00+09:00'),
  lastDay: '2026-12-25',
} as const;
const KST_OFFSET = 9 * 60 * 60 * 1000;
/** Half-day slots are aligned to KST midnight and noon, not to UTC. */
export const santaSlot = (now: number): number => Math.floor((now + KST_OFFSET) / SANTA_RULES.slotMs);
export const santaSlotStart = (slot: number): number => slot * SANTA_RULES.slotMs - KST_OFFSET;
export const santaDeadline = (slot: number): number => santaSlotStart(slot + 1) + SANTA_RULES.graceMs;
/** The event takes new runs until endsAt; it has no start date (it opens with the release). */
export const santaOpen = (now: number): boolean => now < SANTA_RULES.endsAt;
/** "오전" or "오후" for a slot. */
export const santaHalf = (slot: number): '오전' | '오후' => (slot % 2 === 0 ? '오전' : '오후');
/** Shop prices, odds and rewards are shared by the Worker and every screen. */
export const KUJI_RULES = {
  size: 100, basePrice: 300, higherPrice: 400, basePriceCount: 5, lastOneGold: 1000, historyLimit: 20,
  grades: [
    { grade: 'A', count: 1, score: 10, gold: 100, lottoTickets: 0, speettoTickets: 0 },
    { grade: 'B', count: 2, score: 5, gold: 50, lottoTickets: 0, speettoTickets: 0 },
    { grade: 'C', count: 3, score: 3, gold: 30, lottoTickets: 0, speettoTickets: 0 },
    { grade: 'D', count: 6, score: 1, gold: 10, lottoTickets: 0, speettoTickets: 0 },
    { grade: 'E', count: 10, score: 0, gold: 0, lottoTickets: 3, speettoTickets: 0 },
    { grade: 'F', count: 15, score: 0, gold: 0, lottoTickets: 1, speettoTickets: 0 },
    { grade: 'G', count: 25, score: 0, gold: 0, lottoTickets: 0, speettoTickets: 3 },
    { grade: 'H', count: 38, score: 0, gold: 0, lottoTickets: 0, speettoTickets: 1 },
  ],
} as const;
export const LOTTO_RULES = {
  price: 500, maxNumber: 25, pickCount: 5, drawTime: '17:30:00',
  prizes: { 5: 5000, 4: 3000, 3: 1000, 2: 500 },
} as const;
export const SHOP_HISTORY_DAYS = 7;
/** Nickname tags: buying draws one tag immediately (grades and phrases in shared/nickname-tags.ts). */
/** `welcomeTickets` is the one-off grant every active player received in
 * migration 0018; a draw spends a ticket first and only then gold. */
export const NICKNAME_TAG_RULES = { price: 300, dailyLimit: 5, welcomeTickets: 5 } as const;
/** Evolution: two of my tags with the same phrase. The one being evolved rises a
 * grade on success; the other (the material) is always spent on success and
 * half the time on failure. `chance` is the percent to reach each grade; every
 * grade step between the two tags adds `bonusPerStep`, up to `maxBonusSteps`.
 * The first `dailyFree` attempts of a KST day cost nothing, later ones `price`. */
export const TAG_EVOLUTION_RULES = {
  dailyFree: 3, price: 100, chance: { B: 30, A: 15, S: 5 }, bonusPerStep: 3, maxBonusSteps: 2, loseOnFailPercent: 50,
} as const;
export const SLOT_RULES = {
  price: 500, jackpotPercent: 7, jackpotPrize: 2000,
  symbols: ['banana', 'apple', 'strawberry', 'grape', 'watermelon', 'chamoe', 'seven'],
  reels: 3, dailyLimit: null, historyLimit: 20,
} as const;
export const SPEETTO_RULES = {
  price: 300, winPercent: 10, prize: 1500,
  characters: ['axolotl', 'drop', 'cat', 'bunny', 'bread', 'manta', 'moon', 'monkey'],
} as const;
export function kujiCost(purchasedToday: number, quantity: number): number {
  const baseCount = Math.min(quantity, Math.max(0, KUJI_RULES.basePriceCount - purchasedToday));
  return baseCount * KUJI_RULES.basePrice + (quantity - baseCount) * KUJI_RULES.higherPrice;
}
export function lottoPrize(matches: number): number {
  return LOTTO_RULES.prizes[matches as keyof typeof LOTTO_RULES.prizes] ?? 0;
}
export function lottoRank(matches: number): number | null {
  return lottoPrize(matches) ? LOTTO_RULES.pickCount - matches + 1 : null;
}
export const SCORE_TABLES = {
  wake: [
    { maxDifference: 0, points: 30 }, { maxDifference: 60, points: 25 },
    { maxDifference: 180, points: 20 }, { maxDifference: 600, points: 15 },
    { maxDifference: 1800, points: 10 }, { maxDifference: 3600, points: 5 },
    { maxDifference: 7200, points: 3 },
  ],
  offwork: [
    { maxDifference: 0, points: 30 }, { maxDifference: 15, points: 25 },
    { maxDifference: 30, points: 20 }, { maxDifference: 60, points: 15 },
    { maxDifference: 180, points: 10 }, { maxDifference: 300, points: 5 },
    { maxDifference: 600, points: 1 },
  ],
  luck: [
    { maxDifference: 0, points: 15 }, { maxDifference: 1, points: 12 },
    { maxDifference: 2, points: 10 }, { maxDifference: 3, points: 8 },
    { maxDifference: 4, points: 6 }, { maxDifference: 5, points: 4 },
    { maxDifference: 10, points: 2 }, { maxDifference: 15, points: 1 },
  ],
} as const satisfies Record<GameId, readonly { maxDifference: number; points: number }[]>;

export function predictionPoints(game: GameId, difference: number): number {
  return SCORE_TABLES[game].find(tier => difference <= tier.maxDifference)?.points ?? 0;
}
