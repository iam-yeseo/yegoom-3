import { CATCHMIND_RULES } from './balance';
import { CATCHMIND_WORDS } from './catchmind-words';

/** What answers are compared by: every space removed, so "피사의 사탑" and
 * "피사의사탑" are the same answer. NFC keeps composed and decomposed Hangul equal. */
export const catchmindKey = (value: string) => value.normalize('NFC').replace(/\s/gu, '');

/** The drawer's answer as stored and revealed: trimmed, runs of spaces collapsed. */
export const cleanCatchmindWord = (value: string) => value.normalize('NFC').trim().replace(/\s+/gu, ' ');

/** Why this answer cannot be published, or null when it can. */
export function catchmindWordProblem(value: string): string | null {
  const word = cleanCatchmindWord(value);
  if (!catchmindKey(word)) return '정답을 적어 주세요.';
  if (Array.from(word).length > CATCHMIND_RULES.maxWordLength) return `정답은 ${CATCHMIND_RULES.maxWordLength}글자까지 적을 수 있어요.`;
  return null;
}

/** A random prompt from the shared word list, for a drawer who has no idea yet. */
export function suggestCatchmindWord(exclude: readonly (string | null | undefined)[] = [], random: () => number = Math.random): string {
  const skipped = new Set(exclude);
  const choices = CATCHMIND_WORDS.filter(word => !skipped.has(word));
  const pool = choices.length ? choices : CATCHMIND_WORDS;
  return pool[Math.floor(random() * pool.length)]!;
}
