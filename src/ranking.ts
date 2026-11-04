import { honorific } from './names';

export interface RankingPlayer {
  username: string;
  displayName: string;
  weeklyScore: number;
}
export type RankedPlayer<T extends RankingPlayer = RankingPlayer> = T & { rank: number };

/** Competition ranking: equal scores share a rank and skip the occupied places.
 * Stable sorting preserves the incoming order within a tie. */
export function standings<T extends RankingPlayer>(players: readonly T[]): RankedPlayer<T>[] {
  const sorted = [...players].sort((left, right) => right.weeklyScore - left.weeklyScore);
  let rank = 0;
  let previousScore: number | undefined;
  return sorted.map((player, index) => {
    if (index === 0 || player.weeklyScore !== previousScore) rank = index + 1;
    previousScore = player.weeklyScore;
    return { ...player, rank };
  });
}

export interface RankSummary { line: string; chip: string | null }

/** Describe a group by one representative when it is not the viewer's tie. */
function groupName(players: readonly RankingPlayer[]): string {
  return `${honorific(players[0]!.displayName)}${players.length > 1 ? ` 외 ${players.length - 1}명` : ''}`;
}

/** Two peers fit by name; larger shared ranks use a compact count. */
function peersName(players: readonly RankingPlayer[]): string {
  return players.length <= 2
    ? players.map(player => honorific(player.displayName)).join(', ')
    : groupName(players);
}

/** Uses the already-ranked table; it never sorts or recalculates ranks. */
export function rankSummary(table: readonly RankedPlayer[], me: string): RankSummary {
  const viewer = table.find(player => player.username === me);
  if (!viewer) return { line: '', chip: null };
  if (table.every(player => player.weeklyScore === 0)) {
    return { line: '아직 이번 주 점수가 없어요', chip: null };
  }
  const peers = table.filter(player => player.rank === viewer.rank && player.username !== me);
  const chip = `주간 ${peers.length ? '공동 ' : ''}${viewer.rank}위`;
  if (viewer.rank === 1) {
    if (peers.length) return { line: `${peersName(peers)}과 공동 1등`, chip };
    const next = table.find(player => player.rank > 1);
    if (!next) return { line: '이번 주 1위', chip };
    const runnersUp = table.filter(player => player.rank === next.rank);
    return { line: `${next.rank}위 ${groupName(runnersUp)}과 ${viewer.weeklyScore - next.weeklyScore}점 차`, chip };
  }
  const leaders = table.filter(player => player.rank === 1);
  const gap = `1위 ${groupName(leaders)}까지 ${leaders[0]!.weeklyScore - viewer.weeklyScore}점`;
  return { line: `${peers.length ? `${peersName(peers)}과 공동 ${viewer.rank}등 · ` : ''}${gap}`, chip };
}
