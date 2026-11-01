import { useEffect, useRef, useState } from "react";
import { ATTENDANCE_RULES } from "../../shared/balance";
import { useAttendance } from "../attendance";
import { useLaunchGift, waitForAttendanceEffects } from "../launch-gift";
import { Chevron, Coin, Gold, Toolbar } from "../components/UI";
import { anim, coinFly, pop, sparkle, toast, useCountUp, useOnChange } from "../motion";

const nodes = [[30, 52], [107, 52], [184, 52], [262, 52], [314, 104], [184, 156], [62, 156]];
const segments = ["M30 52H107", "H184", "H262", "A52 52 0 0 1 314 104", "A52 52 0 0 1 262 156H184", "H62"];

export function Attendance({ attendanceKey, gold, onBack }: {
  attendanceKey: string;
  gold: number;
  onBack: () => void;
}) {
  const { today, days, claimed, cycleDay, reward, monthCount, canClaim, claim, loadMonth } = useAttendance(attendanceKey);
  const gift = useLaunchGift();
  const root = useRef<HTMLDivElement>(null);
  const mounted = useRef(true);
  const pending = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const shownGold = useCountUp(gold);
  const shownCount = useCountUp(monthCount, 480);
  const currentMonth = today.slice(0, 7);
  const [month, setMonth] = useState(currentMonth);
  const [year, monthNumber] = month.split("-").map(Number);
  const current = month === currentMonth;
  const [history, setHistory] = useState<{ month: string; days: string[] } | null>(null);
  const [historyError, setHistoryError] = useState("");
  const [loading, setLoading] = useState(false);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  useEffect(() => {
    if (current) { setLoading(false); setHistoryError(""); return; }
    let active = true;
    setLoading(true);
    setHistoryError("");
    void loadMonth(month).then(result => {
      if (active) setHistory({ month: result.month, days: result.days });
    }).catch((e: unknown) => {
      if (active) setHistoryError(e instanceof Error ? e.message : "출석 기록을 불러오지 못했어요.");
    }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [month, current, loadMonth, retry]);
  async function receive(button: HTMLElement) {
    if (pending.current || !canClaim) return;
    pending.current = true;
    const finishGiftWait = gift.beginAttendance();
    setBusy(true);
    setError("");
    try {
      const result = await claim();
      if (!mounted.current) return;
      if (result.awarded) {
        await new Promise<void>(resolve => coinFly(button, root.current?.querySelector(".game-toolbar .gold"), resolve));
        if (!mounted.current) return;
        toast(`+${result.attendance.reward}G 받았어요`);
        await waitForAttendanceEffects(root.current);
      } else toast("오늘 출석은 이미 완료했어요");
    } catch (e) {
      if (mounted.current) setError(e instanceof Error ? e.message : "출석하지 못했어요. 다시 시도해 주세요.");
    } finally {
      pending.current = false;
      finishGiftWait();
      if (mounted.current) setBusy(false);
    }
  }
  const completed = claimed ? cycleDay : cycleDay - 1;
  useOnChange(claimed, () => {
    if (!claimed || !root.current) return;
    anim(root.current.querySelector(".calendar-day i.today"), [
      { scale: "2", rotate: "-24deg", opacity: 0 },
      { scale: "1", rotate: "0deg", opacity: 1 },
    ], { dur: 480, ease: "out" });
    anim(root.current.querySelector(".streak-fill"), [{ opacity: 0 }, { opacity: 1 }], { dur: 200 });
    const node = root.current.querySelector(".streak-node.today span");
    pop(node, 1.25, { delay: 500 });
    if (cycleDay === ATTENDANCE_RULES.cycleLength) sparkle(node, { n: 8, r: 40, delay: 600 });
  });
  const firstWeekday = new Date(Date.UTC(year, monthNumber - 1, 1)).getUTCDay();
  const length = new Date(Date.UTC(year, monthNumber, 0)).getUTCDate();
  const calendarDays = current ? days : new Set(history?.month === month ? history.days : []);
  const shift = (delta: number) => setMonth(new Date(Date.UTC(year, monthNumber - 1 + delta, 1)).toISOString().slice(0, 7));
  const calendarLoading = !current && (loading || !historyError && history?.month !== month);
  return <div className="attendance" ref={root}>
    <div className="attendance-hero">
      <Toolbar title="출석 체크" onBack={onBack} right={<Gold value={shownGold} />} />
      <div className="hero-number-row">
        <div className="hero-number"><span>{Number(currentMonth.slice(5))}월 출석</span><p><strong>{shownCount}</strong><span>일</span></p></div>
        {claimed && !busy ? <span className="claim-big done">+{reward}G 받음</span> : canClaim || busy ?
          <button className="claim-big" disabled={busy} onClick={e => void receive(e.currentTarget)}>
            <Coin size={28} />{busy ? "받는 중…" : error ? `다시 받기 +${reward}G` : `받기 +${reward}G`}
          </button> : <span className="subtle-note">운영자는 출석에 참여하지 않아요.</span>}
      </div>
    </div>
    <div className="screen-body stack">
      {error && <p className="form-message error" role="alert">{error}</p>}
      {gift.available && !busy && <button className="attendance-gift-button" type="button" onClick={gift.openGift}>선물 받기</button>}
      <section className="card streak-card">
        <div className="card-head"><h2>{cycleDay}일째</h2><span>{ATTENDANCE_RULES.cycleLength}일째 +{ATTENDANCE_RULES.cycleGold}G</span></div>
        <div className="streak-path" aria-label={`${ATTENDANCE_RULES.cycleLength}일 출석 진행`}>
          <svg viewBox="0 0 322 214" aria-hidden="true">
            <path d="M30 52H262A52 52 0 0 1 262 156H30" fill="none" stroke="#F1ECE6" strokeWidth="10" strokeLinecap="round" />
            {completed > 1 && <path className="streak-fill" d={segments.slice(0, completed - 1).join(" ")} fill="none" stroke="#A7E3CF" strokeWidth="10" strokeLinecap="round" />}
          </svg>
          {nodes.map(([x, y], i) => {
            const isDone = i < completed;
            const avail = canClaim && i + 1 === cycleDay;
            const last = i + 1 === ATTENDANCE_RULES.cycleLength;
            return <div key={i} className={`streak-node ${isDone ? "done" : avail ? "avail" : last ? "bonus" : ""} ${claimed && i + 1 === cycleDay ? "today" : ""}`} style={{ left: `${(x / 322) * 100}%`, top: `${(y / 214) * 100}%` }} aria-label={`${i + 1}일째 ${isDone ? "출석 완료" : avail ? "출석 가능" : "출석 전"}`}>
              <span>{isDone ? "✓" : avail ? "G" : i + 1}</span>
              <small>{i + 1}일째<br />+{last ? ATTENDANCE_RULES.cycleGold : ATTENDANCE_RULES.dailyGold}G</small>
            </div>;
          })}
        </div>
      </section>
      <section className="card calendar" aria-busy={calendarLoading}>
        <div className="calendar-head">
          <button aria-label="이전 달" onClick={() => shift(-1)}><Chevron size={20} color="#ADA4B3" /></button>
          <h2>{year}년 {monthNumber}월</h2>
          <button aria-label="다음 달" disabled={current} onClick={() => shift(1)}><Chevron direction="right" size={20} color={current ? "#DDD6DC" : "#ADA4B3"} /></button>
        </div>
        {calendarLoading ? <p className="subtle-note" role="status">출석 기록을 불러오는 중…</p> : historyError && !current ?
          <div><p className="form-message error" role="alert">{historyError}</p><button className="text-button" onClick={() => setRetry(n => n + 1)}>다시 시도</button></div> :
          <div className="calendar-grid">
            {["일", "월", "화", "수", "목", "금", "토"].map((name, i) => <span key={name} className={`dow ${i === 0 ? "sun" : ""}`}>{name}</span>)}
            {Array.from({ length: firstWeekday }, (_, i) => <span key={`blank-${i}`} />)}
            {Array.from({ length }, (_, i) => {
              const day = i + 1;
              const date = `${month}-${String(day).padStart(2, "0")}`;
              const attended = calendarDays.has(date);
              const isToday = date === today;
              const past = date < today;
              const state = attended ? isToday ? "attended today" : "attended" : isToday ? "today" : past ? "missed" : "";
              return <span key={day} className="calendar-day" aria-label={`${date} ${attended ? "출석" : "미출석"}`}><i className={state}>{day}</i></span>;
            })}
          </div>}
      </section>
    </div>
  </div>;
}
