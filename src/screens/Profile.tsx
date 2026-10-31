import { useRef, useState } from "react";
import type { LedgerEntry } from "../../shared/types";
import { useAttendance } from "../attendance";
import {
  Character,
  Segmented,
  Toolbar,
  art,
  artKeys,
  artSrc,
  characterOf,
  chooseCharacter,
  useCharacter,
  type ArtKey,
} from "../components/UI";
import { KST, weekdayNames } from "../sample";
import { anim, pop, reduced, useOnChange } from "../motion";

/** Picks an icon for a ledger reason by the game it mentions. */
function reasonIcon(reason: string): ArtKey {
  if (reason.includes("기상")) return "moon";
  if (reason.includes("퇴근")) return "manta";
  if (reason.includes("행운") || reason.includes("주식")) return "monkey";
  if (reason.includes("캐치") || reason.includes("로또")) return "bread";
  if (reason.includes("쿠지") || reason.includes("스피또")) return "drop";
  if (reason.includes("뽑기")) return "cat";
  return "axolotl";
}
function dateLabel(iso: string) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: KST,
      month: "numeric",
      day: "numeric",
      weekday: "short",
    })
      .formatToParts(new Date(iso))
      .map((p) => [p.type, p.value]),
  );
  const weekday = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].indexOf(parts.weekday);
  return `${parts.month}월 ${parts.day}일 ${weekdayNames[weekday]}`;
}
const timeLabel = (iso: string) =>
  new Intl.DateTimeFormat("ko-KR", {
    timeZone: KST,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(new Date(iso));

export function Profile({
  username,
  displayName,
  attendanceKey,
  gold,
  weeklyScore,
  ledger,
  others,
  onBack,
  onLogin,
  onLogout,
}: {
  username: string;
  displayName: string;
  attendanceKey: string;
  gold: number;
  weeklyScore: number;
  ledger: LedgerEntry[];
  /** Other players, to label the characters they use. */
  others: string[];
  onBack: () => void;
  onLogin?: () => void;
  onLogout?: () => Promise<void>;
}) {
  const mine = useCharacter(username);
  const { monthCount } = useAttendance(attendanceKey);
  const [currency, setCurrency] = useState<"gold" | "score">("gold");
  const stage = useRef<HTMLDivElement>(null);
  const grid = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLDivElement>(null);
  // Swap: the old character flattens away, then the new one springs up.
  const pick = (key: ArtKey) => {
    if (key === mine) return;
    const out = anim(stage.current?.querySelector(".profile-character"), [
      { scale: "1 1", opacity: 1 },
      { scale: "1.25 .2", opacity: 0 },
    ], { dur: 200, ease: "inOut" });
    const swap = () => {
      out?.cancel();
      chooseCharacter(username, key);
    };
    if (out && !reduced()) out.finished.then(swap, swap);
    else swap();
  };
  useOnChange(mine, () => {
    anim(stage.current?.querySelector(".profile-character"), [
      { scale: ".3 1.3", translate: "0 20px", opacity: 0 },
      { scale: "1.18 .84", translate: "0 0", opacity: 1, offset: 0.55 },
      { scale: ".95 1.05", offset: 0.8 },
      { scale: "1 1", translate: "0 0", opacity: 1 },
    ], { dur: 560, ease: "inOut" });
    pop(grid.current?.querySelector("[aria-pressed='true'] .check"), 1.35);
  });
  useOnChange(currency, () => {
    const dx = currency === "score" ? 28 : -28;
    anim(list.current, [{ translate: `${dx}px 0`, opacity: 0 }, { translate: "0 0", opacity: 1 }], { dur: 280, ease: "spring" });
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const owners = new Map(others.map((name) => [characterOf(name), name]));
  const rows = ledger.filter((entry) => entry.currency === currency);
  let lastDate = "";
  return (
    <div className="profile">
      <div className="profile-hero" style={{ backgroundColor: art[mine].tint }}>
        <Toolbar title="내 정보" onBack={onBack} gold={gold} />
        <div className="profile-stage" ref={stage}>
          <i />
          <Character username={username} className="profile-character" />
        </div>
        <div className="profile-summary">
          <h1>{displayName}</h1>
          <div className="stats">
            <div>
              <span>골드</span>
              <strong>{gold.toLocaleString("ko-KR")}</strong>
            </div>
            <div>
              <span>이번 주</span>
              <strong>{weeklyScore}점</strong>
            </div>
            <div>
              <span>출석</span>
              <strong>{monthCount}일</strong>
            </div>
          </div>
        </div>
      </div>
      <div className="screen-body stack">
        <section className="card character-picker">
          <h2>내 캐릭터</h2>
          <div className="character-grid" ref={grid}>
            {artKeys.map((key) => (
              <button
                key={key}
                style={{ background: art[key].tint }}
                aria-pressed={key === mine}
                aria-label={`${art[key].name}${owners.has(key) ? `, ${owners.get(key)}의 캐릭터` : ""}`}
                onClick={() => pick(key)}
              >
                <img className="character" src={artSrc(key)} alt="" />
                {owners.has(key) && <span className="owner">{owners.get(key)}</span>}
                {key === mine && (
                  <span className="check" aria-hidden="true">
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M5 12.5l4.5 4.5L19 7.5" />
                    </svg>
                  </span>
                )}
              </button>
            ))}
          </div>
        </section>
        <section className="card history">
          <Segmented
            label="내역 종류"
            options={[
              { value: "gold", label: "골드" },
              { value: "score", label: "점수" },
            ]}
            value={currency}
            onChange={setCurrency}
          />
          <div ref={list}>
          {rows.length ? (
            rows.map((entry) => {
              const date = dateLabel(entry.createdAt);
              const header = date !== lastDate;
              lastDate = date;
              const icon = reasonIcon(entry.reason);
              return (
                <div key={entry.id}>
                  {header && <h3 className="history-date">{date}</h3>}
                  <div className="history-row">
                    <span className="history-icon" style={{ background: art[icon].tint }}>
                      <img className="character" src={artSrc(icon)} alt="" />
                    </span>
                    <span className="history-text">
                      <strong>{entry.reason}</strong>
                      <small>{timeLabel(entry.createdAt)}</small>
                    </span>
                    <b className={entry.amount > 0 ? "gain" : "loss"}>
                      {entry.amount > 0 ? "+" : "−"}
                      {Math.abs(entry.amount).toLocaleString("ko-KR")}
                      {currency === "gold" ? "G" : "점"}
                    </b>
                  </div>
                </div>
              );
            })
          ) : (
            <p className="history-empty">아직 내역이 없어요</p>
          )}
          </div>
        </section>
        {error && (
          <p role="alert" className="form-message error">
            {error}
          </p>
        )}
        {onLogin && (
          <button className="primary-button" onClick={onLogin}>
            로그인하고 함께하기
          </button>
        )}
        {onLogout && (
          <button
            className="text-button logout-button"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              try {
                await onLogout();
              } catch (e) {
                setError(e instanceof Error ? e.message : "로그아웃하지 못했어요.");
              } finally {
                setBusy(false);
              }
            }}
          >
            {busy ? "로그아웃 중…" : "로그아웃"}
          </button>
        )}
      </div>
    </div>
  );
}
