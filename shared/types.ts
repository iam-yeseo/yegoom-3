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
  /** Set on a rest day (weekend): no round today; the next one opens at this instant. */
  dayOff?: { reason: 'weekend'; nextOpenAt: string } | null;
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
  santa: SantaSummary;
  /** Curling and penalty home tiles. */
  arcade: { curling: ArcadeSummary; penalty: ArcadeSummary };
  bingo: BingoSummary;
  toilet: ToiletSummary;
  /** Today's free uses left; each item's 이용권 count adds them to owned tickets. */
  dailyFree: DailyFreeLeft;
  launchGift: LaunchGiftState;
  notifications: NotificationSummary;
  /** Ids of the notices (shared/notices.ts) this reader has opened. */
  noticesRead: string[];
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
  /** Scratched open on any device; a scratched ticket is never covered again. */
  revealed: boolean;
}
export interface SpeettoRevealInput { ticketId: string }
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
  /** The drawer's own answer: shown to the drawer once published, and to everyone once ended.
   * A draft has no answer yet; the drawer sends it with the drawing. */
  drawer: CatchmindPlayer; word: string | null;
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
  /** What the viewer's role allows on this round. These depend on the board
   * only, so they change with its version. Whether publishing and guessing are
   * open right now (the 23:50 close) is the response's `play` window. */
  canClaim: boolean; canPublish: boolean; canGuess: boolean; canEnd: boolean; canNext: boolean;
}
/** The daily close on the server's clock: publishing and guessing are closed
 * from 23:50 to midnight KST. It changes with time, not with the board, so
 * every response carries it, an unchanged poll included. (Optional in the
 * types only: a response without it is read by its `serverTime` instead.) */
export interface CatchmindPlayWindow { closed: boolean; changesAt: string }
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
export interface CatchmindResponse { catchmind: CatchmindState; version: number; viewerId: string; serverTime: string; play?: CatchmindPlayWindow }
export interface CatchmindUnchanged { unchanged: true; version: number; viewerId: string; serverTime: string; play?: CatchmindPlayWindow }
export type CatchmindPollResponse = CatchmindResponse | CatchmindUnchanged;
export type CatchmindAction = 'claim' | 'publish' | 'guess' | 'end' | 'next' | 'skip';
export interface CatchmindMutationInput { requestId: string; roundId: string | null; expectedUserId?: string }
/** The drawer writes the answer and publishes it together with the drawing. */
export interface CatchmindPublishInput extends CatchmindMutationInput { word: string; image: string }
export interface CatchmindGuessInput extends CatchmindMutationInput { answer: string }
export interface CatchmindSkipInput extends CatchmindMutationInput { expectedTurnId: string }
export type CatchmindInput = CatchmindMutationInput | CatchmindPublishInput | CatchmindGuessInput | CatchmindSkipInput;

/** Free-throw official sets (docs/plan-freethrow.md §3). A set is played on the
 * device and recorded in one request when its 10th ball lands; a set started
 * but never recorded (the player left) ends unfinished. Times are epoch ms. */
export interface FreeThrowSummary {
  /** A new official set can start now. */
  available: boolean;
  /** This slot's set was started. */
  played: boolean;
  /** This slot's set was recorded in full. */
  completed: boolean;
  made: number;
  nextSlotAt: number; serverNow: number; isAdmin: boolean;
}
export interface FreeThrowShotRecord { index: number; power: number; aim: number; made: boolean; kind: string }
/** One ball of a timed set: its swipe and when it left the hand (ms from the first ball picked up). */
export interface FreeThrowShotInput { power: number; aim: number; t: number }
export interface FreeThrowSet {
  id: string; requestId: string; slot: number; slotStart: number;
  /** The set can be recorded until this time (slot end plus grace). */
  deadline: number; engine: number;
  made: number; shots: FreeThrowShotRecord[];
  /** The set was recorded. */
  completed: boolean;
  /** Completed, or past the deadline. */
  finished: boolean;
  points: number; gold: number;
}
export interface FreeThrowBoardEntry { username: string; slot: number; slotStart: number; made: number; completed: boolean }
export interface FreeThrowState extends FreeThrowSummary {
  date: string; slot: number; slotStart: number;
  /** This slot's set, or the previous slot's while it can still be recorded. */
  current: FreeThrowSet | null;
  /** Every active player's recorded sets that started on this KST date, oldest first. */
  today: FreeThrowBoardEntry[];
}
export interface FreeThrowSetInput { requestId: string }
export interface FreeThrowFinishInput { setId: string; shots: FreeThrowShotInput[] }
export interface FreeThrowFinishResponse extends FreeThrowState {
  /** The set just recorded (it may already be the previous slot's). */
  set: FreeThrowSet;
  replayed: boolean;
}

/** Bingo (worker/bingo.ts): one game at a time, read by polling like Catchmind. */
export type BingoStatus = 'filling' | 'playing' | 'ended' | 'cancelled';
export interface BingoCall { word: string; by: string; at: string }
export interface BingoSeatView {
  player: CatchmindPlayer;
  /** Called words on this board, and how many lines they complete. */
  marked: number; lines: number;
  rank: number | null; points: number;
  /** The board itself: the reader's own while the game runs, everyone's once it is over. */
  cells: string[] | null;
}
export interface BingoGameView {
  id: string; number: number; leader: CatchmindPlayer;
  topic: string; lines: number; words: string[]; source: 'ai' | 'manual';
  status: BingoStatus;
  turn: CatchmindPlayer | null; turnStartedAt: string | null;
  calls: BingoCall[]; seats: BingoSeatView[];
  createdAt: string; startedAt: string | null; endedAt: string | null;
}
export interface BingoState {
  /** The game being filled or played, or the last one that ended. */
  game: BingoGameView | null;
  /** Who opens the next game; null when anyone may. */
  leader: CatchmindPlayer | null;
  waitingSince: string | null;
  canCreate: boolean; canFill: boolean; canStart: boolean; canCall: boolean; canSkip: boolean; canCancel: boolean;
  /** When a player other than the leader may start a filled game. */
  startAvailableAt: string | null;
  /** When another player may pass the waiting turn (or the lead, between games). */
  skipAvailableAt: string | null;
}
export interface BingoResponse { bingo: BingoState; version: number; viewerId: string; serverTime: string; play: CatchmindPlayWindow }
export interface BingoUnchanged { unchanged: true; version: number; viewerId: string; serverTime: string; play: CatchmindPlayWindow }
export type BingoPollResponse = BingoResponse | BingoUnchanged;
export type BingoAction = 'create' | 'board' | 'start' | 'call' | 'skip' | 'cancel';
export interface BingoCreateInput { requestId: string; topic: string; lines: number; words?: string[] }
export interface BingoBoardInput { gameId: string; cells: string[] }
export interface BingoCallInput { gameId: string; word: string }
export interface BingoSkipInput { gameId: string | null; expectedTurnId: string }
export interface BingoGameInput { gameId: string }
export type BingoInput = BingoCreateInput | BingoBoardInput | BingoCallInput | BingoSkipInput | BingoGameInput;
/** The home row: what the reader can do in bingo right now. */
export interface BingoSummary {
  status: 'idle' | BingoStatus;
  topic: string | null;
  leader: { username: string; displayName: string } | null;
  turn: { username: string; displayName: string } | null;
  winner: { username: string; displayName: string } | null;
  /** The reader has a board in this game. */
  joined: boolean;
  players: number;
}

/** 변기 폭파 (worker/toilet.ts): two rounds a day, everyone takes turns until the toilet bursts. */
export type ToiletStatus = 'waiting' | 'playing' | 'burst' | 'void';
export interface ToiletPush {
  /** Whose turn the push was, and who pressed it (another player, when the turn had waited too long). */
  for: string; by: string; at: string;
}
export interface ToiletRoundView {
  id: string; date: string; half: 'am' | 'pm'; label: string;
  startsAt: string; endsAt: string;
  /** Turn order; the first seat moves one along every round. */
  order: CatchmindPlayer[];
  slots: number; pushes: ToiletPush[];
  /** waiting: nobody has pushed yet; void: the window ended before it burst. */
  status: ToiletStatus;
  turn: CatchmindPlayer | null; turnStartedAt: string | null;
  /** The chance the next push bursts (0 once it is over). */
  chance: number;
  loser: CatchmindPlayer | null;
  results: { player: CatchmindPlayer; points: number }[];
  endedAt: string | null;
}
export interface ToiletState {
  /** The round open now; null from 23:50 to midnight or when too few players are active. */
  current: ToiletRoundView | null;
  /** The round before it, when anyone played it. */
  previous: ToiletRoundView | null;
  canPush: boolean; canSkip: boolean;
  /** When another player may push for the waiting turn. */
  skipAvailableAt: string | null;
  /** When the next round opens. */
  nextOpensAt: string;
}
export interface ToiletResponse { toilet: ToiletState; stamp: string; viewerId: string; serverTime: string; play: CatchmindPlayWindow }
export interface ToiletUnchanged { unchanged: true; stamp: string; viewerId: string; serverTime: string; play: CatchmindPlayWindow }
export type ToiletPollResponse = ToiletResponse | ToiletUnchanged;
export type ToiletAction = 'push' | 'skip';
/** `pushes` is how many pushes the screen saw, so a double tap or a stale screen never pushes twice. */
export interface ToiletPushInput { roundId: string; pushes: number }
/** The home row. */
export interface ToiletSummary {
  half: 'am' | 'pm' | null; label: string | null;
  status: ToiletStatus | 'closed';
  turn: { username: string; displayName: string } | null;
  loser: { username: string; displayName: string } | null;
  /** The reader's points from this round once it burst. */
  points: number;
  pushes: number; slots: number;
}

/** Curling and penalty shoot-out sets (worker/arcade.ts). The same shape as a
 * free-throw set: played on the device, recorded in one request. Times are epoch ms. */
export interface ArcadeSummary {
  /** A new official set can start now. */
  available: boolean;
  /** This slot's set was started. */
  played: boolean;
  /** This slot's set was recorded in full. */
  completed: boolean;
  made: number;
  nextSlotAt: number; serverNow: number; isAdmin: boolean;
}
/** `points` is set by games that score each try by itself (curling: 0–10 by where the stone lies). */
export interface ArcadeTryRecord { index: number; made: boolean; kind: string; points?: number }
export interface ArcadeSet {
  id: string; requestId: string; slot: number; slotStart: number;
  /** The set can be recorded until this time (slot end plus grace). */
  deadline: number; engine: number;
  made: number; tries: ArcadeTryRecord[];
  completed: boolean;
  /** Completed, or past the deadline. */
  finished: boolean;
  points: number; gold: number;
}
export interface ArcadeBoardEntry { username: string; slot: number; slotStart: number; made: number; points: number; completed: boolean }
export interface ArcadeState extends ArcadeSummary {
  game: 'curling' | 'penalty';
  date: string; slot: number; slotStart: number;
  /** This slot's set, or the previous slot's while it can still be recorded. */
  current: ArcadeSet | null;
  /** Every active player's recorded sets that started on this KST date, oldest first. */
  today: ArcadeBoardEntry[];
}
export interface ArcadeStartInput { requestId: string }
export interface ArcadeFinishInput { setId: string; inputs: unknown[] }
export interface ArcadeFinishResponse extends ArcadeState {
  set: ArcadeSet;
  replayed: boolean;
}

/** Santa's gift delivery (docs/plan-santa.md §3). A run is played on the device
 * and recorded in one request when its last house is done; a run started but
 * never recorded (the player left) ends unfinished. Times are epoch ms. */
export interface SantaSummary {
  /** The event still takes new runs (until 2026-12-25 24:00 KST). */
  open: boolean;
  /** A new run can start now. */
  available: boolean;
  /** This half day's run was started. */
  played: boolean;
  /** This half day's run was recorded in full. */
  completed: boolean;
  hits: number;
  nextSlotAt: number; endsAt: number; serverNow: number; isAdmin: boolean;
}
export interface SantaDropRecord { index: number; release: number; hit: boolean; kind: string }
export interface SantaRun {
  id: string; requestId: string; slot: number; slotStart: number;
  /** The run can be recorded until this time (slot end plus grace). */
  deadline: number; engine: number;
  hits: number; drops: SantaDropRecord[];
  /** Every house was recorded. */
  completed: boolean;
  /** Completed, or past the deadline. */
  finished: boolean;
  points: number; gold: number;
}
export interface SantaBoardEntry { username: string; slot: number; slotStart: number; hits: number; completed: boolean }
export interface SantaState extends SantaSummary {
  date: string; slot: number; slotStart: number;
  /** This half day's run, or the previous one's while it can still be recorded. */
  current: SantaRun | null;
  /** Every active player's recorded runs that started on this KST date, oldest first. */
  today: SantaBoardEntry[];
}
export interface SantaRunInput { requestId: string }
export interface SantaFinishInput { runId: string; releases: number[] }
export interface SantaFinishResponse extends SantaState {
  /** The run just recorded (it may already be the previous half day's). */
  run: SantaRun;
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
  /** Evolution attempts made today (free ones first, see TAG_EVOLUTION_RULES). */
  evolvesToday: number;
}
/** One evolution attempt. `tag` is the evolved tag after the attempt (its grade
 * rose on success); the material is gone when `materialLost`. */
export interface TagEvolution {
  requestId: string; tag: NicknameTag; text: string;
  fromGrade: NicknameTagGrade; toGrade: NicknameTagGrade; materialGrade: NicknameTagGrade;
  chance: number; success: boolean; materialLost: boolean; cost: number;
}
export interface TagEvolveInput { requestId: string; tagId: string; materialId: string }
export interface TagDrawInput { requestId: string; /** Spend one of today's free draws. */ free?: boolean }
export interface TagEquipInput { tagId: string | null }
export interface TagResponse extends ShopState { tags: NicknameTagState; draw?: NicknameTag; evolution?: TagEvolution }
