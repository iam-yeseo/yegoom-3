import { useRef, useState } from "react";
import { claimToday, useAttendance } from "../attendance";
import { Chevron, Coin, Gold, Toolbar } from "../components/UI";
import { BALANCE, kstParts } from "../sample";
import { anim, coinFly, pop, sparkle, toast, useCountUp, useOnChange } from "../motion";

// Node positions on the 322×214 streak path: three along the top, round the
// bend, and back along the bottom.
const nodes = [
  [30, 52],
  [107, 52],
  [184, 52],
  [262, 52],
  [314, 104],
  [184, 156],
  [62, 156],
];
const segments = ["M30 52H107", "H184", "H262", "A52 52 0 0 1 314 104", "A52 52 0 0 1 262 156H184", "H62"];

export function Attendance({
  attendanceKey,
  gold,
  onBack,
}: {
  attendanceKey: string;
  gold: number;
  onBack: () => void;
}) {
  const { days, claimed, streak, monthCount } = useAttendance(attendanceKey);
  const root = useRef<HTMLDivElement>(null);
  // The preview shows the attendance gold; real claims are not credited yet.
  const [bonus, setBonus] = useState(0);
  const shownGold = useCountUp(gold + bonus);
  const shownCount = useCountUp(monthCount, 480);
  const claim = (button: HTMLElement) =>
    coinFly(button, root.current?.querySelector(".game-toolbar .gold"), () => {
      claimToday(attendanceKey);
      if (attendanceKey === "preview") setBonus(BALANCE.attendanceGold);
      toast(`+${BALANCE.attendanceGold}G 받았어요`);
    });
  // Stamp today on the calendar, fill the streak path, pop today's node and
  // sparkle on the 7th day.
  useOnChange(claimed, () => {
    if (!claimed || !root.current) return;
    anim(root.current.querySelector(".calendar-day i.today"), [
      { scale: "2", rotate: "-24deg", opacity: 0 },
      { scale: "1", rotate: "0deg", opacity: 1 },
    ], { dur: 480, ease: "out" });
    anim(root.current.querySelector(".streak-fill"), [{ strokeDashoffset: 0.12 }, { strokeDashoffset: 0 }], { dur: 700, ease: "out" });
    const node = root.current.querySelector(".streak-node.today span");
    pop(node, 1.25, { delay: 500 });
    if (done === 7) sparkle(node, { n: 8, r: 40, delay: 600 });
  });
  const t = kstParts();
  const [view, setView] = useState({ year: t.year, month: t.month });
  const current = view.year === t.year && view.month === t.month;
  // Position within the 7-day cycle; day 7 pays double.
  const done = streak === 0 ? 0 : ((streak - 1) % 7) + 1;
  const firstWeekday = new Date(Date.UTC(view.year, view.month - 1, 1)).getUTCDay();
  const length = new Date(Date.UTC(view.year, view.month, 0)).getUTCDate();
  const prefix = `${view.year}-${String(view.month).padStart(2, "0")}-`;
  const shift = (delta: number) =>
    setView(({ year, month }) => {
      const m = month + delta;
      return m < 1 ? { year: year - 1, month: 12 } : m > 12 ? { year: year + 1, month: 1 } : { year, month: m };
    });
  return (
    <div className="attendance" ref={root}>
      <div className="attendance-hero">
        <Toolbar title="출석 체크" onBack={onBack} right={<Gold value={shownGold} />} />
        <div className="hero-number-row">
          <div className="hero-number">
            <span>{t.month}월 출석</span>
            <p>
              <strong>{shownCount}</strong>
              <span>일</span>
            </p>
          </div>
          {claimed ? (
            <span className="claim-big done">+{BALANCE.attendanceGold}G 받음</span>
          ) : (
            <button className="claim-big" onClick={(e) => claim(e.currentTarget)}>
              <Coin size={28} />
              받기 +{BALANCE.attendanceGold}
            </button>
          )}
        </div>
      </div>
      <div className="screen-body stack">
        <section className="card streak-card">
          <div className="card-head">
            <h2>연속 {streak}일</h2>
            <span>7일째 두 배</span>
          </div>
          <div className="streak-path">
            <svg viewBox="0 0 322 214" aria-hidden="true">
              <path d="M30 52H262A52 52 0 0 1 262 156H30" fill="none" stroke="#F1ECE6" strokeWidth="10" strokeLinecap="round" />
              {done > 1 && (
                <path
                  className="streak-fill"
                  d={segments.slice(0, done - 1).join(" ")}
                  pathLength={1}
                  strokeDasharray="1"
                  fill="none"
                  stroke="#A7E3CF"
                  strokeWidth="10"
                  strokeLinecap="round"
                />
              )}
            </svg>
            {nodes.map(([x, y], i) => {
              const isDone = i < done;
              const avail = !claimed && i === done;
              const last = i === 6;
              return (
                <div
                  key={i}
                  className={`streak-node ${isDone ? "done" : avail ? "avail" : last ? "bonus" : ""} ${claimed && i === done - 1 ? "today" : ""}`}
                  style={{ left: `${(x / 322) * 100}%`, top: `${(y / 214) * 100}%` }}
                >
                  <span>{isDone ? "✓" : avail ? "G" : last ? "×2" : ""}</span>
                  <small>+{last ? BALANCE.attendanceGold * 2 : BALANCE.attendanceGold}</small>
                </div>
              );
            })}
          </div>
        </section>
        <section className="card calendar">
          <div className="calendar-head">
            <button aria-label="이전 달" onClick={() => shift(-1)}>
              <Chevron size={20} color="#ADA4B3" />
            </button>
            <h2>
              {view.year}년 {view.month}월
            </h2>
            <button aria-label="다음 달" disabled={current} onClick={() => shift(1)}>
              <Chevron direction="right" size={20} color={current ? "#DDD6DC" : "#ADA4B3"} />
            </button>
          </div>
          <div className="calendar-grid">
            {["일", "월", "화", "수", "목", "금", "토"].map((name, i) => (
              <span key={name} className={`dow ${i === 0 ? "sun" : ""}`}>
                {name}
              </span>
            ))}
            {Array.from({ length: firstWeekday }, (_, i) => (
              <span key={`blank-${i}`} />
            ))}
            {Array.from({ length }, (_, i) => {
              const day = i + 1;
              const attended = days.has(prefix + String(day).padStart(2, "0"));
              const isToday = current && day === t.day;
              const past = !current || day < t.day;
              const state = attended
                ? isToday
                  ? "attended today"
                  : "attended"
                : isToday
                  ? "today"
                  : past
                    ? "missed"
                    : "";
              return (
                <span key={day} className="calendar-day">
                  <i className={state}>{day}</i>
                </span>
              );
            })}
          </div>
        </section>
      </div>
    </div>
  );
}
