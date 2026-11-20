import { BINGO_RULES } from './balance';

// Bingo rules shared by the Worker and the preview (docs/plan-bingo.md). Words
// are plain text; everything here is pure, so the same board and the same
// calls always give the same lines, places and next turn.

/** What words are compared by: spaces removed and case folded, so "아이스 크림"
 * and "아이스크림" are one word. NFC keeps composed and decomposed Hangul equal. */
export const bingoKey = (value: string) => value.normalize('NFC').replace(/\s/gu, '').toLowerCase();
/** A word as stored and shown: trimmed, runs of spaces collapsed. */
export const cleanBingoWord = (value: string) => value.normalize('NFC').trim().replace(/\s+/gu, ' ');
export const cleanBingoTopic = cleanBingoWord;
export const CELLS = BINGO_RULES.size * BINGO_RULES.size;

/** Why this topic cannot start a game, or null when it can. */
export function bingoTopicProblem(value: unknown): string | null {
  if (typeof value !== 'string' || !bingoKey(value)) return '빙고 주제를 적어 주세요.';
  if (Array.from(cleanBingoTopic(value)).length > BINGO_RULES.maxTopicLength) return `주제는 ${BINGO_RULES.maxTopicLength}글자까지 적을 수 있어요.`;
  return null;
}
/** Words fit for a board: cleaned, not empty, short enough, no repeats. */
export function usableBingoWords(values: readonly unknown[]): string[] {
  const seen = new Set<string>(), words: string[] = [];
  for (const value of values) {
    if (typeof value !== 'string') continue;
    const word = cleanBingoWord(value), key = bingoKey(word);
    if (!key || Array.from(word).length > BINGO_RULES.maxWordLength || seen.has(key)) continue;
    seen.add(key); words.push(word);
  }
  return words;
}
/** Why this list cannot be a game's word pool, or null when it can. */
export function bingoWordsProblem(values: unknown): string | null {
  if (!Array.isArray(values)) return `단어 ${BINGO_RULES.words}개가 필요해요.`;
  if (values.some(value => typeof value !== 'string' || Array.from(cleanBingoWord(value)).length > BINGO_RULES.maxWordLength)) return `단어는 ${BINGO_RULES.maxWordLength}글자까지 적을 수 있어요.`;
  const usable = usableBingoWords(values);
  if (usable.length !== values.length) return '빈 칸이나 겹치는 단어가 있어요.';
  if (usable.length !== BINGO_RULES.words) return `단어가 정확히 ${BINGO_RULES.words}개여야 해요. 지금은 ${usable.length}개예요.`;
  return null;
}
/** Why these 25 cells cannot be a board for this pool, or null when they can. */
export function bingoBoardProblem(cells: unknown, words: readonly string[]): string | null {
  if (!Array.isArray(cells) || cells.length !== CELLS || cells.some(cell => typeof cell !== 'string')) return `${CELLS}칸을 모두 채워 주세요.`;
  const pool = new Set(words);
  if ((cells as string[]).some(cell => !pool.has(cell))) return '단어 목록에 없는 단어가 있어요.';
  if (new Set(cells as string[]).size !== CELLS) return '같은 단어를 두 번 넣을 수 없어요.';
  return null;
}

/** The twelve lines of a board as cell indexes: five rows, five columns, two diagonals. */
export const BINGO_LINES: readonly (readonly number[])[] = (() => {
  const n = BINGO_RULES.size, range = Array.from({ length: n }, (_, i) => i);
  return [
    ...range.map(row => range.map(column => row * n + column)),
    ...range.map(column => range.map(row => row * n + column)),
    range.map(i => i * n + i), range.map(i => i * n + (n - 1 - i)),
  ];
})();
/** The lines of a board that are fully called. */
export function completedLines(cells: readonly string[], called: ReadonlySet<string>): number[] {
  return BINGO_LINES.flatMap((line, index) => (line.every(cell => called.has(cells[cell]!)) ? [index] : []));
}
export const bingoLines = (cells: readonly string[], called: ReadonlySet<string>): number => completedLines(cells, called).length;

export interface BingoSeat { userId: string; username: string; cells: readonly string[]; rank: number | null; active: boolean }
/** Turns go round in username order, like Catchmind's drawers. */
const inOrder = (seats: readonly BingoSeat[]) => [...seats].sort((a, b) => (a.username < b.username ? -1 : a.username > b.username ? 1 : 0));
/** The next seat still playing after `username` (which need not be seated), going round once. */
export function nextBingoTurn(seats: readonly BingoSeat[], username: string, includeSelf = false): BingoSeat | null {
  const order = inOrder(seats);
  const from = order.findIndex(seat => (includeSelf ? seat.username >= username : seat.username > username));
  const start = from < 0 ? 0 : from;
  for (let step = 0; step < order.length; step++) {
    const seat = order[(start + step) % order.length]!;
    if (seat.rank === null && seat.active && (includeSelf || seat.username !== username)) return seat;
  }
  return null;
}
export interface BingoSettlement {
  /** Places decided by this call, in the order they were given. */
  ranked: { userId: string; rank: number; points: number }[];
  ended: boolean;
  /** Who calls next; null when the game is over. */
  next: BingoSeat | null;
}
/** What a call changes. `called` already holds the new word. Everyone who
 * reaches the winning line count at once is placed caller first, then in turn
 * order. When a single player is left without a place they take the next one,
 * and the game ends there, or as soon as the scoring places are all taken. */
export function settleBingoCall(seats: readonly BingoSeat[], lines: number, called: ReadonlySet<string>, caller: string): BingoSettlement {
  const callerSeat = seats.find(seat => seat.userId === caller);
  const order = inOrder(seats), pivot = callerSeat ? order.findIndex(seat => seat.userId === caller) : 0;
  const fromCaller = [...order.slice(pivot), ...order.slice(0, pivot)];
  let place = seats.filter(seat => seat.rank !== null).length;
  const ranked: BingoSettlement['ranked'] = [];
  const give = (seat: BingoSeat) => { place++; ranked.push({ userId: seat.userId, rank: place, points: BINGO_RULES.rankScores[place - 1] ?? 0 }); };
  for (const seat of fromCaller) if (seat.rank === null && bingoLines(seat.cells, called) >= lines) give(seat);
  const decided = new Set(ranked.map(entry => entry.userId));
  const left = seats.filter(seat => seat.rank === null && !decided.has(seat.userId));
  if (left.length === 1 && place >= 1) { give(left[0]!); left.length = 0; }
  const ended = left.length === 0 || place >= BINGO_RULES.rankScores.length;
  const after = seats.map(seat => (decided.has(seat.userId) || ranked.some(entry => entry.userId === seat.userId) ? { ...seat, rank: 0 } : seat));
  return { ranked, ended, next: ended ? null : nextBingoTurn(after, callerSeat?.username ?? '') };
}
/** Who calls first: the leader if seated, else whoever follows them. */
export const firstBingoTurn = (seats: readonly BingoSeat[], leaderUsername: string): BingoSeat | null => nextBingoTurn(seats, leaderUsername, true);
