import { useEffect, useState } from "react";
import { Avatar, Character, Coin, Toolbar } from "../components/UI";
import { BALANCE, kstParts, weekdayNames } from "../sample";
import { standings, type HomePlayer } from "./Home";

const podiumStyle = {
  1: { height: 186, bg: "#FFE7A3", fg: "#94700A", size: 140, duration: "3s" },
  2: { height: 150, bg: "#EEE8FC", fg: "#7556C4", size: 120, duration: "3.4s" },
  3: { height: 124, bg: "#D9F2E8", fg: "#2E8C6E", size: 110, duration: "3.8s" },
} as const;
const badge = [
  ["#FFD866", "#5C4300"],
  ["#EEE8FC", "#7556C4"],
  ["#E3F6EE", "#2E8C6E"],
];

function weekOfMonth(date = new Date()) {
  const t = kstParts(date);
  return `${t.month}월 ${Math.ceil(t.day / 7)}주차`;
}
/** Time until Sunday 24:00 KST, when the week settles. */
function settleLeft(now: number) {
  const t = kstParts(new Date(now));
  const elapsed = (t.weekday * 24 + t.hour) * 60 + t.minute;
  const minutes = Math.max(0, 7 * 24 * 60 - elapsed);
  return `${Math.floor(minutes / 1440)}일 ${Math.floor((minutes % 1440) / 60)}시간 ${String(minutes % 60).padStart(2, "0")}분`;
}

export function Ranking({
  me,
  gold,
  players,
  daily,
  lastWeek,
  onBack,
}: {
  me: string;
  gold: number;
  players: HomePlayer[];
  /** My points per weekday (Mon–Sun) this week. */
  daily: number[];
  lastWeek: { username: string; score: number }[] | null;
  onBack: () => void;
}) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);
  const table = standings(players);
  // Second place on the left, first in the middle, third on the right.
  const podium = [table[1], table[0], table[2]].filter(Boolean);
  const today = kstParts().weekday;
  const max = Math.max(...daily, 1);
  const lastWeekDate = new Date(now - 7 * 86_400_000);
  return (
    <div className="ranking">
      <div className="ranking-hero">
        <Toolbar title="주간 랭킹" onBack={onBack} gold={gold} />
        <div className="ranking-week">
          <span>
            {weekOfMonth()} · 정산까지 <b>{settleLeft(now)}</b>
          </span>
        </div>
        <div className="podium">
          {podium.map((player) => {
            const style = podiumStyle[Math.min(player.rank, 3) as 1 | 2 | 3];
            return (
              <div key={player.username} className="podium-place">
                <Character
                  username={player.username}
                  className="podium-character"
                  alt=""
                />
                <div
                  className="podium-block"
                  style={{ height: style.height, background: style.bg }}
                >
                  <span className="podium-rank" style={{ color: style.fg }}>
                    {player.rank}
                  </span>
                  <span className="podium-name">{player.displayName}</span>
                  <strong>{player.weeklyScore}</strong>
                  <span className="podium-reward">
                    <Coin size={18} />
                    {(BALANCE.weeklyRewards[player.rank - 1] ?? 0).toLocaleString("ko-KR")}
                  </span>
                </div>
              </div>
            );
          })}
        </div>
      </div>
      <div className="screen-body stack">
        <section className="card daily-card">
          <div className="card-head">
            <h2>요일별 점수</h2>
            <span>{me}</span>
          </div>
          <div className="daily-bars">
            {weekdayNames.map((name, i) => {
              const past = i <= today;
              const isToday = i === today;
              return (
                <div key={name} className={isToday ? "today" : ""}>
                  <span>{past ? daily[i] : ""}</span>
                  <i
                    style={{
                      height: past ? Math.round((daily[i] / max) * 70) : 6,
                      background: isToday ? "#FF8E7A" : past ? "#FFE0D8" : "#F3EEE8",
                    }}
                  />
                  <small>{isToday ? "오늘" : name}</small>
                </div>
              );
            })}
          </div>
        </section>
        {lastWeek && (
          <section className="card last-week">
            <div className="card-head">
              <h2>지난주</h2>
              <span>{weekOfMonth(lastWeekDate)}</span>
            </div>
            {lastWeek.map((row, i) => (
              <div className="list-row" key={row.username}>
                <span
                  className="rank-dot"
                  style={{ background: badge[i][0], color: badge[i][1] }}
                >
                  {i + 1}
                </span>
                <Avatar username={row.username} size={40} />
                <strong>{row.username}</strong>
                <b>{row.score}점</b>
                <em>+{(BALANCE.weeklyRewards[i] ?? 0).toLocaleString("ko-KR")}G</em>
              </div>
            ))}
          </section>
        )}
      </div>
    </div>
  );
}
