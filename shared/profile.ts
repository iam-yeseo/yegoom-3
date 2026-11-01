/** Same nickname alphabet and NFC normalization as the original yegoom. */
export const NICKNAME_MAX = 10;
export const PROFILE_PHOTO = { side: 512, maxBytes: 260 * 1024 } as const;
export const LUCK_PHOTO = { maxSide: 1280, maxBytes: 440 * 1024 } as const;
const nicknamePattern = /^[가-힣ㄱ-ㅎㅏ-ㅣa-zA-Z0-9]+$/u;

export function graphemeLength(value: string): number {
  return typeof Intl !== 'undefined' && Intl.Segmenter
    ? [...new Intl.Segmenter('ko', { granularity: 'grapheme' }).segment(value)].length
    : [...value].length;
}
export function normalizeNickname(input: unknown): { value: string } | { error: string } {
  let value: string;
  try { value = String(input ?? '').normalize('NFC').trim(); }
  catch { return { error: '닉네임은 한글, 영문, 숫자만 쓸 수 있어요.' }; }
  if (!value) return { error: '닉네임을 입력해 주세요.' };
  if (!nicknamePattern.test(value)) return { error: '닉네임은 한글, 영문, 숫자만 쓸 수 있어요.' };
  if (graphemeLength(value) > NICKNAME_MAX) return { error: `닉네임은 ${NICKNAME_MAX}글자까지 가능해요.` };
  return { value };
}
