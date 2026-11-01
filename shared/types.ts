import type { ArtKey } from './characters';

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
