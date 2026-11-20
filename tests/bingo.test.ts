import { describe, expect, it } from 'vitest';
import { BINGO_RULES } from '../shared/balance';
import {
  BINGO_LINES, bingoBoardProblem, bingoKey, bingoLines, bingoTopicProblem, bingoWordsProblem, firstBingoTurn, nextBingoTurn, settleBingoCall, usableBingoWords, type BingoSeat,
} from '../shared/bingo';
import { countStreamedWords, wordsFromAnswer } from '../worker/bingo-ai';

const WORDS = Array.from({ length: 30 }, (_, i) => `단어${i + 1}`);
const board = (offset = 0) => Array.from({ length: 25 }, (_, i) => WORDS[(i + offset) % 30]!);
const seat = (username: string, cells: string[], rank: number | null = null, active = true): BingoSeat => ({ userId: username, username, cells, rank, active });

describe('bingo rules', () => {
  it('compares words without spaces or case', () => {
    expect(bingoKey(' 아이스 크림 ')).toBe(bingoKey('아이스크림'));
    expect(bingoKey('BTS')).toBe(bingoKey('bts'));
    expect(usableBingoWords(['사과', ' 사 과 ', '', 7, '열한글자가넘는아주긴단어', '배'])).toEqual(['사과', '배']);
  });

  it('accepts exactly 30 distinct short words as a pool', () => {
    expect(bingoWordsProblem(WORDS)).toBeNull();
    expect(bingoWordsProblem(WORDS.slice(0, 29))).toContain('30개');
    expect(bingoWordsProblem([...WORDS.slice(0, 29), '단어 1'])).toContain('겹치는');
    expect(bingoWordsProblem([...WORDS.slice(0, 29), '가'.repeat(BINGO_RULES.maxWordLength + 1)])).toContain('글자');
    expect(bingoWordsProblem('단어')).not.toBeNull();
    expect(bingoTopicProblem('  ')).not.toBeNull();
    expect(bingoTopicProblem('가'.repeat(BINGO_RULES.maxTopicLength + 1))).not.toBeNull();
    expect(bingoTopicProblem('분식집 메뉴')).toBeNull();
  });

  it('accepts a board of 25 different words from the pool', () => {
    expect(bingoBoardProblem(board(), WORDS)).toBeNull();
    expect(bingoBoardProblem(board().slice(0, 24), WORDS)).not.toBeNull();
    expect(bingoBoardProblem([...board().slice(0, 24), '없는 단어'], WORDS)).toContain('목록에 없는');
    expect(bingoBoardProblem([...board().slice(0, 24), WORDS[0]], WORDS)).toContain('두 번');
  });

  it('counts rows, columns and both diagonals', () => {
    expect(BINGO_LINES).toHaveLength(12);
    const cells = board();
    expect(bingoLines(cells, new Set())).toBe(0);
    expect(bingoLines(cells, new Set(cells.slice(0, 5)))).toBe(1);
    expect(bingoLines(cells, new Set([0, 5, 10, 15, 20].map(i => cells[i]!)))).toBe(1);
    expect(bingoLines(cells, new Set([0, 6, 12, 18, 24, 4, 8, 16, 20].map(i => cells[i]!)))).toBe(2);
    expect(bingoLines(cells, new Set(cells))).toBe(12);
    // Four of five is not a line, and words that are not on the board change nothing.
    expect(bingoLines(cells, new Set([...cells.slice(0, 4), WORDS[27]!]))).toBe(0);
  });

  it('takes turns in username order, skipping players who are placed or gone', () => {
    const seats = [seat('siwon', board()), seat('min', board(1)), seat('yeseo', board(2))];
    expect(firstBingoTurn(seats, 'siwon')!.username).toBe('siwon');
    // A leader without a board: the next player after them starts.
    expect(firstBingoTurn(seats, 'noboard')!.username).toBe('siwon');
    expect(nextBingoTurn(seats, 'min')!.username).toBe('siwon');
    expect(nextBingoTurn(seats, 'yeseo')!.username).toBe('min');
    expect(nextBingoTurn([seat('min', board()), seat('siwon', board(), 1), seat('yeseo', board(), null, false)], 'min')).toBeNull();
    expect(nextBingoTurn([seat('min', board()), seat('siwon', board(), 1), seat('yeseo', board())], 'min')!.username).toBe('yeseo');
  });

  it('places the caller first when several boards finish on one word, and ends on the scoring places', () => {
    // All three share the same top row; the word that completes it finishes everyone at once.
    const row = WORDS.slice(0, 5), rest = (shift: number) => Array.from({ length: 20 }, (_, i) => WORDS[5 + (i + shift) % 25]!);
    const seats = [seat('min', [...row, ...rest(0)]), seat('siwon', [...row, ...rest(3)]), seat('yeseo', [...row, ...rest(7)])];
    const settled = settleBingoCall(seats, 1, new Set(row), 'siwon');
    expect(settled.ranked).toEqual([{ userId: 'siwon', rank: 1, points: 5 }, { userId: 'yeseo', rank: 2, points: 3 }, { userId: 'min', rank: 3, points: 1 }]);
    expect(settled).toMatchObject({ ended: true, next: null });
  });

  it('gives the last player left the next place, so nobody plays on alone', () => {
    const row = WORDS.slice(0, 5), filler = WORDS.slice(5, 25);
    const winner = [...row, ...filler], others = [...filler, ...WORDS.slice(25, 30)];
    const three = [seat('min', winner), seat('siwon', others), seat('yeseo', [...others].reverse())];
    const first = settleBingoCall(three, 1, new Set(row), 'min');
    expect(first.ranked).toEqual([{ userId: 'min', rank: 1, points: 5 }]);
    expect(first).toMatchObject({ ended: false });
    expect(first.next!.username).toBe('siwon');
    // Two players: the winner's line settles both places.
    const two = settleBingoCall([seat('min', winner), seat('siwon', others)], 1, new Set(row), 'min');
    expect(two.ranked).toEqual([{ userId: 'min', rank: 1, points: 5 }, { userId: 'siwon', rank: 2, points: 3 }]);
    expect(two.ended).toBe(true);
    // A call that finishes nobody passes the turn on.
    const none = settleBingoCall(three, 1, new Set(row.slice(0, 4)), 'yeseo');
    expect(none).toMatchObject({ ranked: [], ended: false });
    expect(none.next!.username).toBe('min');
  });

  it('with more than three players, ends once three are placed and leaves the rest without a place', () => {
    const row = WORDS.slice(0, 5), filler = WORDS.slice(5, 25), other = [...filler, ...WORDS.slice(25, 30)];
    const seats = [seat('a', [...row, ...filler], 1), seat('b', [...row, ...filler], 2), seat('c', [...row, ...filler]), seat('d', other), seat('e', other)];
    const settled = settleBingoCall(seats, 1, new Set(row), 'c');
    expect(settled.ranked).toEqual([{ userId: 'c', rank: 3, points: 1 }]);
    expect(settled.ended).toBe(true);
  });

  it('takes the first 30 usable words from an AI answer, or none at all', () => {
    const answer = (words: unknown) => JSON.stringify({ words });
    expect(wordsFromAnswer(answer([...WORDS, '여분1', '여분2']))).toEqual(WORDS);
    expect(wordsFromAnswer(answer([...WORDS.slice(0, 29), '단어1', '', '보충']))).toEqual([...WORDS.slice(0, 29), '보충']);
    expect(wordsFromAnswer(answer(WORDS.slice(0, 29)))).toBeNull();
    expect(wordsFromAnswer('not json')).toBeNull();
    expect(wordsFromAnswer(answer('단어'))).toBeNull();
    expect(wordsFromAnswer(null)).toBeNull();
  });

  it('counts the words that have fully arrived in a streamed answer', () => {
    const full = JSON.stringify({ words: ['떡볶이', '순대', '"따옴표"', '김밥'] });
    expect(countStreamedWords('')).toBe(0);
    expect(countStreamedWords('{"words"')).toBe(0);
    expect(countStreamedWords('{"words":["떡볶')).toBe(0);
    // A word counts once its closing quote and the comma (or bracket) after it are in.
    expect(countStreamedWords('{"words":["떡볶이"')).toBe(0);
    expect(countStreamedWords('{"words":["떡볶이",')).toBe(1);
    expect(countStreamedWords('{"words":["떡볶이", "순대" ,"')).toBe(2);
    // An escaped quote inside a word does not end it.
    expect(countStreamedWords(full.slice(0, full.indexOf('김밥')))).toBe(3);
    expect(countStreamedWords(full)).toBe(4);
    // It only ever grows as the text does.
    let last = 0;
    for (let end = 0; end <= full.length; end++) { const count = countStreamedWords(full.slice(0, end)); expect(count).toBeGreaterThanOrEqual(last); last = count; }
  });
});
