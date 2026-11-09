import { GAME_RULES, PLAY_RULES, PREDICTION_REWARDS, SCORE_TABLES } from './balance';
import { ADMIN_LIMITS, type PredictionRules } from './admin';
import type { GameId } from './types';

/** Defaults remain in balance.ts; persisted rules and previews use this shape. */
export function defaultPredictionRules(id: GameId): PredictionRules {
  return { enabled: true, scoreTable: SCORE_TABLES[id].map(row => ({ ...row })),
    ...PREDICTION_REWARDS, deadline: GAME_RULES[id].deadline,
    revealTime: id === 'luck' ? GAME_RULES.luck.revealTime : null };
}
const integerBetween = (value: unknown, bounds: readonly [number, number]): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= bounds[0] && value <= bounds[1];
const clock = /^(?:[01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9]$/;
export function validatePredictionRules(id: GameId, input: unknown): { rules: PredictionRules } | { error: string } {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { error: '게임 설정을 확인해 주세요.' };
  const value = input as Record<string, unknown>;
  if (typeof value.enabled !== 'boolean') return { error: '게임 ON/OFF를 선택해 주세요.' };
  if (!Array.isArray(value.scoreTable) || value.scoreTable.length < ADMIN_LIMITS.scoreRows[0] || value.scoreTable.length > ADMIN_LIMITS.scoreRows[1]) {
    return { error: `배점표는 ${ADMIN_LIMITS.scoreRows[0]}~${ADMIN_LIMITS.scoreRows[1]}행이어야 해요.` };
  }
  const scoreTable: PredictionRules['scoreTable'] = [];
  for (const row of value.scoreTable) {
    if (!row || typeof row !== 'object' || Array.isArray(row)
      || typeof row.maxDifference !== 'number' || !Number.isSafeInteger(row.maxDifference) || row.maxDifference < 0
      || !integerBetween(row.points, ADMIN_LIMITS.points)) return { error: `차이 기준은 0 이상의 정수, 점수는 ${ADMIN_LIMITS.points[0]}~${ADMIN_LIMITS.points[1]} 정수로 입력해 주세요.` };
    const previous = scoreTable.at(-1);
    if (previous && row.maxDifference <= previous.maxDifference) return { error: '차이 기준은 중복 없이 작은 값부터 입력해 주세요.' };
    if (previous && row.points > previous.points) return { error: '점수는 아래 행으로 갈수록 같거나 작아야 해요.' };
    scoreTable.push({ maxDifference: row.maxDifference, points: row.points });
  }
  if (!integerBetween(value.participationGold, ADMIN_LIMITS.participationGold)) return { error: `참여 골드는 ${ADMIN_LIMITS.participationGold[0]}~${ADMIN_LIMITS.participationGold[1].toLocaleString('ko-KR')} 정수로 입력해 주세요.` };
  if (!integerBetween(value.firstGold, ADMIN_LIMITS.firstGold)) return { error: `1등 골드는 ${ADMIN_LIMITS.firstGold[0]}~${ADMIN_LIMITS.firstGold[1].toLocaleString('ko-KR')} 정수로 입력해 주세요.` };
  if (typeof value.deadline !== 'string' || !clock.test(value.deadline)) return { error: '마감 시각을 HH:MM:SS로 입력해 주세요.' };
  const defaults = defaultPredictionRules(id);
  if (id === 'wake' && value.deadline !== defaults.deadline) return { error: '기상시간 마감은 고정되어 있어요.' };
  if (value.deadline > PLAY_RULES.closeTime) return { error: '예측 마감은 게임이 닫히는 밤 11시 50분 이전이어야 해요.' };
  if (value.revealTime !== defaults.revealTime) return { error: '자동 공개 방식은 변경할 수 없어요.' };
  if (id === 'luck' && value.deadline >= defaults.revealTime!) return { error: '행운 점수 마감은 자동 공개 시각보다 앞이어야 해요.' };
  return { rules: { enabled: value.enabled, scoreTable, participationGold: value.participationGold,
    firstGold: value.firstGold, deadline: value.deadline, revealTime: defaults.revealTime } };
}
export function predictionPointsForRules(rules: PredictionRules, difference: number): number {
  return rules.scoreTable.find(row => difference <= row.maxDifference)?.points ?? 0;
}
export function scoreThresholdLabel(id: GameId, difference: number): string {
  if (difference === 0) return '정확히 일치';
  if (id === 'luck') return `${difference}점 차이 이내`;
  return `${durationLabel(difference)} 이내`;
}
/** 4727 -> "1시간 18분 47초" */
export function durationLabel(totalSeconds: number): string {
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor(totalSeconds % 3600 / 60);
  const seconds = totalSeconds % 60;
  return [hours ? `${hours}시간` : '', minutes ? `${minutes}분` : '', seconds ? `${seconds}초` : ''].filter(Boolean).join(' ') || '0초';
}
