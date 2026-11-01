import type { ArtKey } from './characters';
import type { KUJI_RULES, SPEETTO_RULES } from './balance';

export type GameId = 'wake' | 'offwork' | 'luck';
export type Role = 'player' | 'admin';
export interface User {
  id: string;
  username: string;
  displayName: string;
  role: Role;
  gold: number;
  weeklyScore: number;
  character: ArtKey | null;
}
export interface Player {
  id: string;
  username: string;
  displayName: string;
  weeklyScore: number;
  character: ArtKey;
}
export interface GameResult {
  playerId: string;
  username: string;
  displayName: string;
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
  title: string;
  authorUsername: string;
  deadline: string;
  roundDate: string;
  phase: 'open' | 'closed' | 'revealed';
  hint: string;
  prediction: string | null;
  answer: string | null;
  answerEntered: boolean;
  results: GameResult[];
  participants: { playerId: string; username: string; displayName: string; submitted: boolean }[];
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
export interface GameResponse { game: GameState }
export interface HistoryResponse { history: GameHistoryRound[] }
export interface ApiError { error: { code: string; message: string } }
export interface GameMutationInput { roundDate: string }
export interface PredictionInput extends GameMutationInput { value: string }
export interface AnswerInput extends GameMutationInput { value: string; hint?: string }

export interface Inventory { lottoTickets: number; speettoTickets: number }
export type ShopKind = 'kuji' | 'lotto' | 'speetto';
export type ShopPayment = 'gold' | 'ticket';
export interface ShopState { gold: number; inventory: Inventory; canPurchase: boolean; serverTime: string }
export type KujiGrade = typeof KUJI_RULES.grades[number]['grade'];
export interface KujiCell { position: number; grade: KujiGrade | null; buyerId: string | null }
export interface KujiState {
  boardId: number;
  cells: KujiCell[];
  remaining: number;
  remainingByGrade: Record<KujiGrade, number>;
  purchasedToday: number;
  nextPrice: number;
}
export interface KujiPurchaseInput { requestId: string; boardId: number; positions: number[] }
export interface KujiPurchase {
  requestId: string; boardId: number; cells: { position: number; grade: KujiGrade }[]; cost: number;
  reward: { gold: number; score: number; lottoTickets: number; speettoTickets: number }; lastOne: boolean;
}
export interface KujiResponse extends ShopState { kuji: KujiState; purchase?: KujiPurchase }
export interface LottoPurchaseInput { requestId: string; numbers: number[]; payment: ShopPayment }
export interface LottoTicket {
  id: string; requestId: string; drawDate: string; numbers: number[]; payment: ShopPayment; cost: number;
  winningNumbers: number[] | null; matches: number | null; rank: number | null; prize: number | null;
}
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
  payment: ShopPayment; cost: number; createdAt: string;
}
export interface SpeettoState { tickets: SpeettoTicket[] }
export interface SpeettoResponse extends ShopState { speetto: SpeettoState; purchase?: SpeettoTicket }
