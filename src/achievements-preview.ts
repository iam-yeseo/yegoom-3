import { ACHIEVEMENT_BY_KEY, type AchievementProgress, type AchievementsResponse } from "../shared/achievements";
import type { AchievementClient } from "./screens/Achievements";

/** The serverless preview: a few sample unlocks the visitor can collect; gold
 * is reported back so the home balance moves like the real thing. */
export function createPreviewAchievements(onGold: (delta: number) => void, gold: () => number): AchievementClient {
  const now = () => new Date().toISOString();
  const today = () => new Date(Date.now() + 9 * 3_600_000).toISOString().slice(0, 10);
  const progress: AchievementProgress[] = [
    { key: "welcome", periodKey: "", unlockedAt: now(), claimedAt: null },
    { key: "attend_first", periodKey: "", unlockedAt: now(), claimedAt: now() },
    { key: "wake_join", periodKey: "", unlockedAt: now(), claimedAt: now() },
    { key: "wake_near", periodKey: today(), unlockedAt: now(), claimedAt: null },
    { key: "kuji_first", periodKey: "", unlockedAt: now(), claimedAt: now() },
    { key: "character", periodKey: "", unlockedAt: now(), claimedAt: null },
  ];
  const claimedCounts: Record<string, number> = { attend_first: 1, wake_join: 1, kuji_first: 1, wake_near: 2 };
  const snapshot = (): AchievementsResponse => structuredClone({ progress, claimedCounts, gold: gold(),
    unclaimed: progress.filter(row => row.claimedAt === null).length, serverTime: now() });
  return {
    load: async () => snapshot(),
    claim: async (key, periodKey) => {
      const row = progress.find(item => item.key === key && item.periodKey === periodKey);
      if (!row) throw new Error("아직 달성하지 않은 도전과제예요.");
      if (row.claimedAt) throw new Error("이미 받은 도전과제 보상이에요.");
      row.claimedAt = now();
      claimedCounts[key] = (claimedCounts[key] ?? 0) + 1;
      onGold(ACHIEVEMENT_BY_KEY.get(key)!.reward);
      return snapshot();
    },
  };
}
