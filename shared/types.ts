import type { StockHomeSummary } from './stock-types';
import type { ArtKey } from './characters';
import type { KUJI_RULES, SPEETTO_RULES, SLOT_RULES } from './balance';
import type { Board, Doll, AttemptResult } from './claw-physics';
import type { PredictionRules } from './admin';
import type { RankingPeriod, ScoreGame } from './ranking-periods';
import type { NicknameTagGrade } from './nickname-tags';

export type GameId = 'wake' | 'offwork' | 'luck';
export type Role = 'player' | 'admin';
export interface PhotoMetadata { url: string; version: number }
export interface ProfileMetadata { displayName: string; photoVersion: number | null }
export interface LuckPhotoResponse { photo: PhotoMetadata; serverTime: string }
export type { AppNotification, NotificationSummary, NotificationsResponse } from './notifications';
export type { AchievementsResponse, AchievementProgress, AchievementClaimInput, AchievementEventInput } from './achievements';
import type { NotificationSummary } from './notifications';
import type { RankResult } from './ranking-rewards';
export interface User {
  id: string;
  username: string;
  displayName: string;
  photoVersion: number | null;
  role: Role;
  gold: number;
  weeklyScore: number;
  character: ArtKey | null;
  /** The nickname tag the user is wearing, shown before the nickname everywhere. */
  tag: NicknameTagView | null;
}
export interface Player {
  id: string;
  username: string;
  displayName: string;
  photoVersion: number | null;
  weeklyScore: number;
  character: ArtKey;
  tag: NicknameTagView | null;
}
export interface NicknameTagView { grade: NicknameTagGrade; text: string }
export interface GameResult {
  playerId: string;
  username: string;
  displayName: string;
  photoVersion: number | null;
  character: ArtKey;
  value: string;
  difference: number;
  score: number;
  isFirst: boolean;
  participationGold: number;
  firstGold: number;
  gold: number;
}
export interface GameHistoryRound {
  roundDate: string;
  answer: string;
  results: GameResult[];
}
export interface GameState {
  id: GameId;
  rules: PredictionRules;
  title: string;
  authorUsername: string;
  authorDisplayName: string;
  photo: PhotoMetadata | null;
  deadline: string;
  roundDate: string;
  phase: 'open' | 'closed' | 'revealed';
  hint: string;
  prediction: string | null;
  answer: string | null;
  answerEntered: boolean;
  results: GameResult[];
  participants: { playerId: string; username: string; displayName: string; photoVersion: number | null; submitted: boolean }[];
  canPredict: boolean;
  canEditAnswer: boolean;
  canReveal: boolean;
}
export interface LedgerEntry {
  id: string;
  currency: 'gold' | 'score';
  amount: number;
  reason: string;
  createdAt: string;
}
export interface BootstrapResponse {
  user: User;
  players: Player[];
  games: GameState[];
  ledger: LedgerEntry[];
  dailyScores: number[];
  attendance: AttendanceState;
  inventory: Inventory;
  kuji: KujiSummary;
  lottoNotice: LottoNotice | null;
  catchmind: CatchmindSummary;
  claw: ClawSummary;
  freethrow: FreeThrowSummary;
  /** Today's free uses left; each item's 이용권 count adds them to owned tickets. */
  dailyFree: DailyFreeLeft;
  launchGift: LaunchGiftState;
  notifications: NotificationSummary;
  /** Unseen settled places for the newest finished week/month (the result dialog). */
  rankResults: RankResult[];
  /** Home tile summary; null while the stock market is not open to players. */
  stock: StockHomeSummary | null;
  serverTime: string;
  timeZone: 'Asia/Seoul';
}
export interface AttendanceState {
  today: string;
  claimed: boolean;
  /** Today's stored streak, or the streak a claim today would earn. */
  streak: number;
  cycleDay: number;
  reward: number;
  canClaim: boolean;
  month: string;
  monthCount: number;
  days: string[];
}
export interface AttendanceResponse { attendance: AttendanceState }
export interface AttendanceClaimResponse extends AttendanceResponse { user: User; awarded: boolean }
export interface CharacterInput { character: ArtKey; migrate?: boolean; expectedUserId?: string }
export interface AuthResponse { user: User }
export interface PasswordChangeInput { currentPassword: string; newPassword: string; expectedUserId?: string }
export interface GameResponse { game: GameState }
export interface HistoryResponse { history: GameHistoryRound[] }
export interface ApiError { error: { code: string; message: string } }
export interface GameMutationInput { roundDate: string }
export interface PredictionInput extends GameMutationInput { value: string }
export interface AnswerInput extends GameMutationInput { value: string; hint?: string }

export interface Inventory { lottoTickets: number; speettoTickets: number; tagTickets: number }
export interface LaunchGiftState { available: boolean; claimed: boolean }
export interface LaunchGiftResponse {
  launchGift: LaunchGiftState;
  inventory: Inventory;
  awarded: boolean;
  serverTime: string;
}
export type ShopKind = 'kuji' | 'lotto' | 'speetto' | 'slot' | 'tag';
/** 'ticket' spends 이용권: today's free uses (DAILY_FREE in shared/balance.ts)
 * first, then an owned ticket. 'free' (only today's uses) is the pre-merge form,
 * still accepted from in-flight purchases and shown on old receipts. */
export type ShopPayment = 'gold' | 'ticket' | 'free';
/** Free uses left today, by item. */
export interface DailyFreeLeft { lotto: number; speetto: number; slot: number; tag: number }
export interface ShopState { gold: number; inventory: Inventory; canPurchase: boolean; serverTime: string; free?: DailyFreeLeft }
export type KujiGrade = typeof KUJI_RULES.grades[number]['grade'];
export interface KujiCell { position: number; grade: KujiGrade | null; buyerId: string | null }
/** Read-only card summary. No board yet: null/100; sold out awaiting creation: id/0. */
export interface KujiSummary { boardId: number | null; remaining: number }
/** One purchase on the board, newest first: who drew which grades. */
export interface KujiDraw { id: string; userId: string; createdAt: string; cells: { position: number; grade: KujiGrade }[]; lastOne: boolean }
export interface KujiState {
  boardId: number;
  cells: KujiCell[];
  remaining: number;
  remainingByGrade: Record<KujiGrade, number>;
  purchasedToday: number;
  nextPrice: number;
  /** The latest draws on this board (KUJI_RULES.historyLimit). */
  recent: KujiDraw[];
}
export interface KujiPurchaseInput { requestId: string; boardId: number; positions: number[] }
export interface KujiPurchase {
  requestId: string; boardId: number; cells: { position: number; grade: KujiGrade }[]; cost: number;
  reward: { gold: number; score: number; lottoTickets: number; speettoTickets: number }; lastOne: boolean;
}
export interface KujiResponse extends ShopState { kuji: KujiState; purchase?: KujiPurchase }
export interface LottoPurchaseInput { requestId: string; numbers: number[]; payment: ShopPayment }
export interface LottoTicket {
  id: string; requestId: string; purchaseDate: string; createdAt: string; drawDate: string; numbers: number[]; payment: ShopPayment; cost: number;
  winningNumbers: number[] | null; matches: number | null; rank: number | null; prize: number | null;
}
export interface LottoNotice { drawDate: string; tickets: number; winners: number; prize: number }
export interface LottoState {
  targetDrawDate: string;
  todayDraw: { date: string; numbers: number[] | null };
  tickets: LottoTicket[];
}
export interface LottoResponse extends ShopState { lotto: LottoState; purchase?: LottoTicket }
export type SpeettoSymbol = typeof SPEETTO_RULES.characters[number];
export interface SpeettoPurchaseInput { requestId: string; payment: ShopPayment }
export interface SpeettoTicket {
  id: string; requestId: string; cells: SpeettoSymbol[]; won: boolean; prize: number;
  payment: ShopPayment; cost: number; purchaseDate: string; createdAt: string;
}
export interface SpeettoState { tickets: SpeettoTicket[] }
export interface SpeettoResponse extends ShopState { speetto: SpeettoState; purchase?: SpeettoTicket }

export type SlotSymbol = typeof SLOT_RULES.symbols[number];
export interface SlotSpinInput { requestId: string; /** Spend one of today's free spins. */ free?: boolean }
export interface SlotSpin {
  id: string; requestId: string; reels: SlotSymbol[]; cost: number; prize: number; date: string; createdAt: string;
  /** One of today's free spins (cost 0). */
  free?: boolean;
}
export interface SlotState { recent: SlotSpin[] }
export interface SlotResponse extends ShopState { slot: SlotState; spin?: SlotSpin }

export interface CatchmindPlayer { id: string; username: string; displayName: string; photoVersion: number | null; character: ArtKey }
export interface CatchmindGuess { id: string; player: CatchmindPlayer; answer: string; correct: boolean; createdAt: string }
export interface CatchmindRound {
  id: string; number: number; status: 'draft' | 'open' | 'ended';
  drawer: CatchmindPlayer; word: string | null; wordVersion: number; rerollsLeft: number;
  /** Authenticated image URL in API responses; offline previews may use a data URL. */
  image: string | null;
  wrongCount: number; hint: { firstCharacter: string; length: number } | null;
  winner: CatchmindPlayer | null;
  /** False when the round was solved after its publication day closed (23:50): gold only. */
  winnerScored: boolean;
  endReason: 'correct' | 'misses' | 'manual' | null;
  publishedAt: string | null; endedAt: string | null; guesses: CatchmindGuess[];
}
export interface CatchmindState {
  round: CatchmindRound | null; turn: CatchmindPlayer | null;
  /** Successor of the current drawer, used before an end confirmation. */
  nextDrawer: CatchmindPlayer | null;
  canSkip: boolean; skipAvailableAt: string | null;
  previousRound: CatchmindGalleryRound | null;
  canClaim: boolean; canReroll: boolean; canPublish: boolean; canGuess: boolean; canEnd: boolean; canNext: boolean;
}
/** Finished rounds only; images are served separately through immutable URLs. */
export interface CatchmindGalleryRound {
  id: string; number: number; drawer: CatchmindPlayer; answer: string;
  winner: CatchmindPlayer | null; endReason: 'correct' | 'misses' | 'manual';
  endedAt: string; image: string;
}
export interface CatchmindGalleryResponse { rounds: CatchmindGalleryRound[]; nextBefore: number | null }
export interface CatchmindSummary {
  roundId: string | null; status: 'idle' | 'draft' | 'open' | 'ended';
  drawer: CatchmindPlayer | null; turn: CatchmindPlayer | null; wrongCount: number;
  winner: CatchmindPlayer | null; winnerScored: boolean; answer: string | null;
}
export interface CatchmindResponse { catchmind: CatchmindState; version: number; viewerId: string; serverTime: string }
export interface CatchmindUnchanged { unchanged: true; version: number; viewerId: string; serverTime: string }
export type CatchmindPollResponse = CatchmindResponse | CatchmindUnchanged;
export type CatchmindAction = 'claim' | 'reroll' | 'publish' | 'guess' | 'end' | 'next' | 'skip';
export interface CatchmindMutationInput { requestId: string; roundId: string | null; expectedUserId?: string }
export interface CatchmindRerollInput extends CatchmindMutationInput { wordVersion: number }
export interface CatchmindPublishInput extends CatchmindRerollInput { image: string }
export interface CatchmindGuessInput extends CatchmindMutationInput { answer: string }
export interface CatchmindSkipInput extends CatchmindMutationInput { expectedTurnId: string }
export type CatchmindInput = CatchmindMutationInput | CatchmindRerollInput | CatchmindPublishInput | CatchmindGuessInput | CatchmindSkipInput;

/** Free-throw official sets (docs/plan-freethrow.md §3). Times are epoch ms. */
export interface FreeThrowSummary {
  /** A new official set can start now. */
  available: boolean;
  /** An unfinished set (this slot, or the previous one within its grace time). */
  inProgress: boolean;
  made: number; shots: number;
  nextSlotAt: number; serverNow: number; isAdmin: boolean;
}
export interface FreeThrowShotRecord { index: number; power: number; aim: number; made: boolean; kind: string }
export interface FreeThrowSet {
  id: string; requestId: string; slot: number; slotStart: number;
  /** Shots are accepted until this time (slot end plus grace). */
  deadline: number; engine: number;
  made: number; shots: FreeThrowShotRecord[]; finished: boolean;
  points: number; gold: number;
}
export interface FreeThrowBoardEntry { username: string; slot: number; slotStart: number; made: number; shots: number; finished: boolean }
export interface FreeThrowState extends FreeThrowSummary {
  date: string; slot: number; slotStart: number;
  current: FreeThrowSet | null;
  /** Every active player's sets that started on this KST date, oldest first. */
  today: FreeThrowBoardEntry[];
}
export interface FreeThrowSetInput { requestId: string }
export interface FreeThrowShotInput { setId: string; index: number; power: number; aim: number }
export interface FreeThrowShotResponse extends FreeThrowState {
  shot: FreeThrowShotRecord & { points: number; gold: number };
  replayed: boolean;
}

export interface ClawSummary {
  coins: number; freeCoins: number; purchasedCoins: number;
  nextGrantAt: number; serverNow: number; isAdmin: boolean;
}
export interface ClawState extends ClawSummary {
  board: Board; version: number; generation: number; nextPlayAt: number;
}
export interface ClawPlayInput { requestId: string; version: number; x: number; stop?: number | null; forceStrong?: boolean }
export interface ClawCoinInput { requestId: string; quantity: 1 | 5 }
export interface ClawResult {
  requestId: string; playId: string; engine: number; x: number; stop: number | null;
  grip: { pickup: number; carry: number; strong: boolean };
  caught: boolean; prizes: Doll[]; doll: Doll | null; target: Doll | null;
  /** Total rewards, including the clear bonus. */
  points: number; gold: number; clearBonus: number; clearGold: number;
  /** Machine progression is independent of rewards during administrator play. */
  cleared?: boolean;
  released: AttemptResult['released']; reason: AttemptResult['reason'];
}
export interface ClawResponse extends ClawState {
  result?: ClawResult; replayed?: boolean;
  purchase?: { requestId: string; quantity: 1 | 5; cost: number };
}

export interface RankingStanding {
  userId: string; username: string; displayName: string;
  photoVersion: number | null; character: ArtKey; score: number;
}
/** The viewer's own points, grouped by weekday (week), week of month (month) or game (day). */
export interface RankingBucket { key: string; label: string; score: number; current: boolean; future: boolean }
export interface RankingHistoryEntry {
  id: string; userId: string; username: string; displayName: string; game: ScoreGame; label: string;
  amount: number; createdAt: string; gameDate: string;
}
export interface RankingResponse {
  period: RankingPeriod;
  range: { start: string; end: string };
  standings: RankingStanding[];
  buckets: RankingBucket[];
  history: RankingHistoryEntry[];
  nextBefore: string | null;
  serverTime: string;
}

export interface NicknameTag { id: string; grade: NicknameTagGrade; text: string; equipped: boolean; createdAt: string; payment: ShopPayment }
export interface NicknameTagState {
  /** Equipped first, then S→C, newest first. */
  tags: NicknameTag[];
  equipped: NicknameTag | null;
  drawsToday: number; dailyLimit: number; price: number;
}
export interface TagDrawInput { requestId: string; /** Spend one of today's free draws. */ free?: boolean }
export interface TagEquipInput { tagId: string | null }
export interface TagResponse extends ShopState { tags: NicknameTagState; draw?: NicknameTag }
