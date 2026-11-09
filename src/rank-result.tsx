import { useEffect, useRef } from "react";
import type { RankResult } from "../shared/ranking-rewards";
import { LaunchDialog } from "./launch-gift";
import { pop } from "./motion";

const shortDate = (date: string) => `${Number(date.slice(5, 7))}/${Number(date.slice(8, 10))}`;
const periodName = (result: RankResult) => result.period === "week" ? "지난주" : "지난달";
const periodRange = (result: RankResult) => result.period === "week"
  ? `${shortDate(result.start)}~${shortDate(result.end)}` : `${Number(result.start.slice(5, 7))}월`;

/** The first visit after a weekly or monthly settlement: the player's place and
 * reward, once. The gold is already in the wallet; closing marks it seen. */
export function RankResultDialog({ results, onClose, onRanking }: { results: RankResult[]; onClose: () => void; onRanking: () => void }) {
  const cards = useRef<HTMLDivElement>(null);
  useEffect(() => {
    cards.current?.querySelectorAll(".rank-result-place").forEach((place, i) => pop(place, 1.18, { delay: 160 + i * 120 }));
  }, []);
  const title = results.length > 1 ? "랭킹 집계 완료!" : results[0]!.period === "week" ? "주간 랭킹 집계 완료!" : "월간 랭킹 집계 완료!";
  return <LaunchDialog title={title} onClose={onClose} className="rank-result-dialog">
    <div className="rank-result-cards" ref={cards}>
      {results.map(result => <section key={`${result.period}:${result.key}`} className={`rank-result-card ${result.gold > 0 ? "paid" : ""}`}
        aria-label={`${periodName(result)} 랭킹 결과`}>
        <small>{periodName(result)} · {periodRange(result)}</small>
        <p className="rank-result-line">{periodName(result)} 랭킹은 <strong className="rank-result-place">{result.place}위</strong>!</p>
        <span className="rank-result-meta">{result.players}명 중 {result.place}위 · {result.score.toLocaleString("ko-KR")}점</span>
        {result.gold > 0
          ? <p className="rank-result-reward">보상은 <strong>{result.gold.toLocaleString("ko-KR")}G</strong>! 벌써 지갑에 넣어 뒀어요.</p>
          : <p className="rank-result-reward">이번엔 보상이 없어요. 다음엔 시상대에서 만나요!</p>}
      </section>)}
    </div>
    <button className="primary-button" type="button" onClick={onClose}>확인</button>
    <button className="text-button rank-result-ranking" type="button" onClick={onRanking}>랭킹 보러 가기</button>
  </LaunchDialog>;
}
