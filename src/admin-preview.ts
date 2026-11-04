import { ADMIN_LIMITS, type AdminChange, type AdminClawConfig, type AdminState, type PredictionRules } from "../shared/admin";
import { defaultPredictionRules, validatePredictionRules } from "../shared/game-settings";
import type { GameId } from "../shared/types";
import { CATCHMIND_WORDS } from "../shared/catchmind-words";

/** Explicit administrator preview only. These sample strengths are unrelated to the server configuration. */
export function createAdminPreview(): AdminState {
  const now = new Date();
  const today = new Date(now.getTime() + 9 * 3600000).toISOString().slice(0, 10);
  const tomorrow = new Date(Date.parse(`${today}T00:00:00Z`) + 86400000).toISOString().slice(0, 10);
  return { today, tomorrow, serverTime: now.toISOString(), changes: [], catchmindWordsRemaining: CATCHMIND_WORDS.length,
    claw: { payoutEvery: 8, weakPickup: .4, weakCarry: .25 },
    games: (["wake", "offwork", "luck"] as GameId[]).map(id => ({ id, rules: defaultPredictionRules(id),
      scheduledRules: null, canApplyToday: id !== "wake",
      activityReason: id === "wake" ? "오늘 이미 예측이 있어요. 다음 날부터 적용할 수 있어요." : null })),
  };
}
function change(state: AdminState, target: string, before: unknown, after: unknown, effectiveFrom: string): AdminChange[] {
  return [{ id: crypto.randomUUID(), adminId: "preview-admin", adminName: "운영 미리보기", target,
    before: structuredClone(before), after: structuredClone(after), effectiveFrom, createdAt: new Date().toISOString() }, ...state.changes].slice(0, 20);
}
export function savePreviewGame(state: AdminState, id: GameId, input: PredictionRules, effectiveFrom: string): AdminState {
  const checked = validatePredictionRules(id, input);
  if ("error" in checked) throw new Error(checked.error);
  if (![state.today, state.tomorrow].includes(effectiveFrom)) throw new Error("오늘 또는 다음 날부터 적용할 수 있어요.");
  const game = state.games.find(value => value.id === id)!;
  const today = effectiveFrom === state.today;
  if (today && !game.canApplyToday) throw new Error(game.activityReason ?? "오늘 활동이 있어요.");
  return { ...state, serverTime: new Date().toISOString(),
    games: state.games.map(value => value.id === id ? { ...value, ...(today ? { rules: checked.rules } : { scheduledRules: checked.rules }) } : value),
    changes: change(state, `game:${id}`, today ? game.rules : game.scheduledRules ?? game.rules, checked.rules, effectiveFrom),
  };
}
export function savePreviewClaw(state: AdminState, config: AdminClawConfig): AdminState {
  const [minimum, maximum] = ADMIN_LIMITS.payoutEvery;
  if (!Number.isInteger(config.payoutEvery) || config.payoutEvery < minimum || config.payoutEvery > maximum
    || [config.weakPickup, config.weakCarry].some(value => !Number.isFinite(value) || value * 100 < ADMIN_LIMITS.weakPowerPercent[0]
      || value * 100 > ADMIN_LIMITS.weakPowerPercent[1] || Math.abs(value * 100 - Math.round(value * 100)) > 1e-8)) {
    throw new Error("집게 힘과 주기를 허용 범위 안에서 골라 주세요.");
  }
  const now = new Date().toISOString();
  return { ...state, claw: { ...config }, serverTime: now, changes: change(state, "claw", state.claw, config, now) };
}
