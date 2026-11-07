import type { ReactNode } from "react";
import type { ScoreGame } from "../../shared/ranking-periods";
import { art, artSrc, type ArtKey } from "./UI";

/** Icons for ledger rows, shared by 내 정보 내역 and 랭킹 점수 기록. */
export const SCORE_GAME_ICONS: Record<ScoreGame, ArtKey> = {
  wake: "moon", offwork: "manta", luck: "monkey", catchmind: "bread", kuji: "drop", claw: "cat", freethrow: "bunny", other: "axolotl",
};
/** Picks an icon for a ledger reason by the game it mentions (gold rows have no game reference). */
export function reasonIcon(reason: string): ArtKey {
  if (reason.includes("기상")) return "moon";
  if (reason.includes("퇴근")) return "manta";
  if (reason.includes("행운") || reason.includes("주식")) return "monkey";
  if (reason.includes("캐치") || reason.includes("로또")) return "bread";
  if (reason.includes("쿠지") || reason.includes("스피또") || reason.includes("슬롯")) return "drop";
  if (reason.includes("뽑기")) return "cat";
  if (reason.includes("자유투")) return "bunny";
  return "axolotl";
}

/** One ledger line: leading icon (or avatar), title, detail and a signed amount. */
export function HistoryRow({ icon, leading, title, detail, amount, unit }: {
  icon?: ArtKey; leading?: ReactNode; title: ReactNode; detail: ReactNode; amount: number; unit: "G" | "점";
}) {
  return <div className="history-row">
    {leading ?? (icon && <span className="history-icon" style={{ background: art[icon].tint }}>
      <img className="character" src={artSrc(icon)} alt="" />
    </span>)}
    <span className="history-text">
      <strong>{title}</strong>
      <small>{detail}</small>
    </span>
    <b className={amount > 0 ? "gain" : "loss"}>
      {amount > 0 ? "+" : "−"}
      {Math.abs(amount).toLocaleString("ko-KR")}
      {unit}
    </b>
  </div>;
}
