import { useEffect, useRef, useState } from "react";
import type { GameState, User } from "../../shared/types";
import { BALANCE, predictionPoints, rankOf } from "../sample";
import {
  anim,
  confetti,
  flipY,
  greet,
  hop,
  pop,
  reduced,
  rise,
  squishJump,
  toast,
  tween,
  useOnChange,
} from "../motion";
import { Avatar, Character, Coin, Toolbar, playerColor } from "./UI";

type Props = {
  game: GameState;
  user: User;
  serverTime: string;
  demo?: boolean;
  onBack: () => void;
  onSave: (value: string, hint: string, author: boolean) => Promise<void>;
  onReveal: () => Promise<void>;
};
const deadlines = { wake: "10:30", offwork: "17:00", luck: "17:00" };
const questions = {
  wake: "min은 몇 시에 일어날까?",
  offwork: "siwon은 몇 시에 퇴근할까?",
  luck: "yeseo의 오늘 행운 점수는?",
};
function clock(seconds: number) {
  const n = Math.max(0, seconds);
  return [Math.floor(n / 3600), Math.floor((n % 3600) / 60), n % 60]
    .map((v) => String(v).padStart(2, "0"))
    .join(":");
}
const ROW = 40;
/**
 * One column of the time wheel. Drag or flick it: it follows the finger, keeps
 * going with momentum (×0.9 per frame) and snaps to the nearest value. Rows
 * tilt, shrink and fade with distance. The centre stays a number input for
 * keyboard and screen-reader use.
 */
function WheelColumn({
  value,
  low,
  high,
  label,
  disabled,
  onChange,
}: {
  value: number;
  low: number;
  high: number;
  label: string;
  disabled: boolean;
  onChange: (n: number) => void;
}) {
  const span = high - low + 1;
  const wrap = (n: number) => ((((n - low) % span) + span) % span) + low;
  const [offset, setOffset] = useState(0);
  const [dragging, setDragging] = useState(false);
  const live = useRef({ offset: 0, value });
  live.current.value = value;
  const gesture = useRef<{ y: number; start: number; lastY: number; lastT: number; v: number; moved: boolean } | null>(null);
  const frame = useRef(0);
  const stopTween = useRef<() => void>(() => {});
  useEffect(() => () => {
    cancelAnimationFrame(frame.current);
    stopTween.current();
  }, []);
  const move = (next: number) => {
    live.current.offset = next;
    setOffset(next);
  };
  function settle(velocity: number) {
    let v = reduced() ? 0 : velocity;
    const step = () => {
      if (Math.abs(v) > 0.6) {
        move(live.current.offset + v);
        v *= 0.9;
        frame.current = requestAnimationFrame(step);
        return;
      }
      const steps = Math.round(live.current.offset / ROW);
      if (steps) onChange(wrap(live.current.value - steps));
      const rest = live.current.offset - steps * ROW;
      move(rest);
      stopTween.current = tween(rest, 0, 320, move, () => setDragging(false));
    };
    step();
  }
  const rows = Math.ceil(Math.abs(offset) / ROW) + 3;
  const items = [];
  for (let i = -rows; i <= rows; i++) {
    const y = i * ROW + offset;
    const distance = Math.abs(y) / ROW;
    if (distance > 2.6 || (i === 0 && !dragging)) continue;
    items.push(
      <span
        key={i}
        className={`wheel-item ${distance < 0.5 ? "near" : ""}`}
        style={{
          transform: `translateY(${y}px) rotateX(${(-y / ROW) * 18}deg) scale(${1 - Math.min(distance, 2) * 0.12})`,
          opacity: 1 - Math.min(distance, 2.6) * 0.32,
        }}
        aria-hidden="true"
      >
        {String(wrap(value + i)).padStart(2, "0")}
      </span>,
    );
  }
  return (
    <div
      className={`time-column ${dragging ? "dragging" : ""} ${disabled ? "disabled" : ""}`}
      onPointerDown={(e) => {
        if (disabled || e.button !== 0) return;
        cancelAnimationFrame(frame.current);
        stopTween.current();
        gesture.current = { y: e.clientY, start: live.current.offset, lastY: e.clientY, lastT: e.timeStamp, v: 0, moved: false };
      }}
      onPointerMove={(e) => {
        const g = gesture.current;
        if (!g) return;
        if (!g.moved && Math.abs(e.clientY - g.y) > 4) {
          g.moved = true;
          setDragging(true);
          e.currentTarget.setPointerCapture(e.pointerId);
        }
        if (!g.moved) return;
        const dt = Math.max(1, e.timeStamp - g.lastT);
        g.v = ((e.clientY - g.lastY) / dt) * 16;
        g.lastY = e.clientY;
        g.lastT = e.timeStamp;
        move(g.start + e.clientY - g.y);
      }}
      onPointerUp={(e) => {
        const g = gesture.current;
        gesture.current = null;
        if (!g) return;
        if (g.moved) {
          settle(g.v);
          return;
        }
        // A tap on a neighbouring row selects it.
        const rect = e.currentTarget.getBoundingClientRect();
        const steps = Math.round((e.clientY - (rect.top + rect.height / 2)) / ROW);
        if (steps && (e.target as Element).tagName !== "INPUT") onChange(wrap(value + steps));
      }}
      onPointerCancel={() => {
        if (gesture.current?.moved) settle(0);
        gesture.current = null;
      }}
    >
      {items}
      <label className="wheel-active" style={{ opacity: dragging ? 0 : 1 }}>
        <span className="sr-only">{label}</span>
        <input
          type="number"
          min={low}
          max={high}
          value={String(value).padStart(2, "0")}
          onChange={(event) => {
            const n = Number(event.target.value);
            if (Number.isInteger(n) && n >= 0 && n <= (label === "분" ? 59 : 23)) onChange(n);
          }}
          disabled={disabled}
        />
      </label>
    </div>
  );
}
function TimeWheel({
  value,
  onChange,
  disabled,
  hours = [0, 23],
}: {
  value: string;
  onChange: (v: string) => void;
  disabled: boolean;
  /** Inclusive hour range the wheel cycles through. */
  hours?: [number, number];
}) {
  const [hour, minute] = value.split(":").map(Number);
  const set = (part: number) => (n: number) => {
    const next = [hour, minute];
    next[part] = n;
    onChange(next.map((v) => String(v).padStart(2, "0")).join(":"));
  };
  return (
    <div className="time-wheel" role="group" aria-label="예측 시간 선택">
      <div className="wheel-selection" />
      <WheelColumn value={hour} low={hours[0]} high={hours[1]} label="시" disabled={disabled} onChange={set(0)} />
      <WheelColumn value={minute} low={0} high={59} label="분" disabled={disabled} onChange={set(1)} />
      <span className="wheel-colon" aria-hidden="true">
        :
      </span>
    </div>
  );
}
/** A submission row whose status chip pops when it turns to 제출 완료. */
function SubmissionRow({
  player,
  me,
}: {
  player: GameState["participants"][number];
  me: boolean;
}) {
  const chip = useRef<HTMLSpanElement>(null);
  useOnChange(player.submitted, () => player.submitted && pop(chip.current, 1.2));
  return (
    <div className="submission-card">
      <Avatar username={player.username} />
      <strong>
        {player.displayName}
        {me ? " (나)" : ""}
      </strong>
      <span ref={chip} className={`pill ${player.submitted ? "mint" : "muted"}`}>
        {player.submitted ? "제출 완료" : "아직"}
      </span>
    </div>
  );
}
export function PredictionGame({
  game,
  user,
  serverTime,
  demo,
  onBack,
  onSave,
  onReveal,
}: Props) {
  const author =
    user.role === "player" && user.username === game.authorUsername;
  const initial = author ? game.answer : game.prediction;
  const [value, setValue] = useState(
    initial ??
      (game.id === "luck" ? "65" : game.id === "wake" ? "08:40" : "18:00"),
  );
  const [hint, setHint] = useState(game.hint);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [now, setNow] = useState(Date.parse(serverTime));
  useEffect(() => {
    const offset = Date.parse(serverTime) - Date.now();
    setNow(Date.now() + offset);
    const timer = window.setInterval(() => setNow(Date.now() + offset), 1000);
    return () => clearInterval(timer);
  }, [serverTime]);
  useEffect(() => {
    setValue(
      initial ??
        (game.id === "luck" ? "65" : game.id === "wake" ? "08:40" : "18:00"),
    );
  }, [game.id, initial]);
  useEffect(() => {
    setHint(game.hint);
  }, [game.hint]);
  const deadline = /^\d{2}:\d{2}$/.test(game.deadline)
    ? `${game.roundDate}T${game.deadline}:00+09:00`
    : game.deadline;
  const left = Math.max(0, Math.ceil((Date.parse(deadline) - now) / 1000));
  const editable =
    demo || (author ? game.canEditAnswer : game.canPredict && left > 0);
  const revealed = game.phase === "revealed";
  // Remember the last saved value so the button turns to 제출 완료 right away.
  const [savedValue, setSavedValue] = useState<string | null>(null);
  const saved = (savedValue ?? initial) === value && (savedValue ?? initial) !== null;
  const urgent = !revealed && left > 0 && left < 600;
  const countdownRef = useRef<HTMLElement>(null);
  const luckNumber = useRef<HTMLLabelElement>(null);
  const hero = useRef<HTMLButtonElement>(null);
  const results = useRef<HTMLDivElement>(null);
  const answerRef = useRef<HTMLElement>(null);
  useOnChange(left, () => {
    if (urgent) anim(countdownRef.current, [{ scale: "1" }, { scale: "1.035" }, { scale: "1" }], { dur: 600, ease: "inOut", fill: "none" });
  });
  useOnChange(value, () => {
    if (game.id === "luck") anim(luckNumber.current, [{ translate: "0 0" }, { translate: "0 -3px" }, { translate: "0 0" }], { dur: 140, fill: "none" });
  });
  useEffect(() => {
    const character = hero.current?.firstElementChild;
    if (!revealed) {
      const t = setTimeout(() => greet(character), 320);
      return () => clearTimeout(t);
    }
    // Result reveal: answer flips, cards rise by rank, chips pop one by one,
    // then confetti for 1st place and a hop from the setter.
    flipY(answerRef.current);
    const cards = [...(results.current?.querySelectorAll(".result-card") ?? [])];
    cards.forEach((card, i) => rise(card, { delay: 520 + i * 140 }));
    const chips = [...(results.current?.querySelectorAll(".reward") ?? [])];
    chips.forEach((chip, i) => anim(chip, [{ scale: ".6", opacity: 0 }, { scale: "1", opacity: 1 }], { dur: 420, ease: "spring", delay: 520 + cards.length * 140 + i * 110 }));
    const done = 520 + cards.length * 140 + chips.length * 110 + 200;
    const t = setTimeout(() => {
      if (cards.length) confetti(cards[0].querySelector(".rank-badge"));
      hop(character);
    }, reduced() ? 0 : done);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [revealed]);
  
  const update = (next: string) => {
    setValue(next);
    setError("");
  };
  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setError("");
    if (!editable) return;
    if (
      game.id === "luck"
        ? !/^\d{1,3}$/.test(value) || Number(value) > 100
        : !/^([01]\d|2[0-3]):[0-5]\d$/.test(value)
    ) {
      setError(
        game.id === "luck"
          ? "0~100 사이의 정수를 입력해 주세요."
          : "올바른 시간을 입력해 주세요.",
      );
      return;
    }
    if (author && game.id === "luck" && !hint.trim()) {
      setError("함께 볼 힌트를 입력해 주세요.");
      return;
    }
    setBusy(true);
    try {
      await onSave(value, hint, author);
      setSavedValue(value);
      toast(author ? "정답을 저장했어요" : "예측을 저장했어요");
    } catch (e) {
      setError(
        e instanceof Error
          ? e.message
          : "저장하지 못했어요. 다시 시도해 주세요.",
      );
    } finally {
      setBusy(false);
    }
  }
  async function reveal() {
    setBusy(true);
    setError("");
    try {
      await onReveal();
      toast("정답을 공개했어요");
    } catch (e) {
      setError(e instanceof Error ? e.message : "공개하지 못했어요.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className={`prediction-page ${game.id} ${revealed ? "revealed" : ""}`}>
      <div className="prediction-hero">
        <Toolbar
          title={game.title}
          onBack={onBack}
          gold={user.gold}
        />
        <div className="character-stage">
          <div className="character-shadow" />
          <button
            ref={hero}
            type="button"
            className="hero-character-button"
            aria-label={`${game.authorUsername}의 캐릭터`}
            data-nopress
            onClick={(e) => squishJump(e.currentTarget.firstElementChild)}
          >
            <span className="hero-character-wrap">
              <Character username={game.authorUsername} className="hero-character" />
            </span>
          </button>
          <span className="author-pill" style={{ color: playerColor[game.authorUsername] }}>
            출제 {game.authorUsername}
          </span>
        </div>
      </div>
      <div className="countdown-row">
        <div className="countdown">
          <span>
            {revealed ? "정답" : author ? "예측 마감까지" : "마감까지"}
          </span>
          <strong
            ref={revealed ? answerRef : countdownRef}
            className={revealed ? "answer-number" : urgent ? "urgent" : ""}
          >
            {revealed
              ? `${game.answer ?? "—"}${game.id === "luck" ? "점" : ""}`
              : clock(left)}
          </strong>
        </div>
        <div className="deadline-block">
          <span className={`pill ${revealed ? "yellow" : "mint"}`}>
            {revealed ? "결과 공개" : `${deadlines[game.id]} 마감`}
          </span>
          {game.id === "luck" && !revealed && <small>18:00 공개</small>}
        </div>
      </div>
      {revealed ? (
        <div className="screen-body result-list" ref={results}>
          {game.results.length ? (
            game.results.map((result) => {
              const rank = rankOf(game.results, result);
              return (
                <article className="card result-card" key={result.playerId}>
                  <div className="result-player">
                    <span className={`rank-badge ${rank === 1 ? "first" : ""}`}>
                      {rank}
                    </span>
                    <Avatar username={result.username} size={46} />
                    <div className="result-name">
                      <strong>
                        {result.displayName}
                        {result.username === user.username ? " (나)" : ""}
                      </strong>
                      <span>
                        {result.difference === 0
                          ? "정확히 맞힘"
                          : `${result.difference}${game.id === "luck" ? "점" : "분"} 차이`}
                      </span>
                    </div>
                    <strong className="result-guess">
                      {result.value}
                      {game.id === "luck" ? "점" : ""}
                    </strong>
                  </div>
                  <div className="result-rewards">
                    <span className="reward points">+{predictionPoints(rank)}점</span>
                    <span className="reward gold">
                      <Coin size={20} />+{BALANCE.participationGold} 참여
                    </span>
                    {rank === 1 && (
                      <span className="reward bonus">
                        <Coin size={20} />+{BALANCE.firstPlaceGold} 1등 보너스
                      </span>
                    )}
                  </div>
                </article>
              );
            })
          ) : (
            <div className="card empty-state">
              이번 라운드에는 제출한 예측이 없어요.
            </div>
          )}
          <div className="result-caption">
            <span />
            {game.authorUsername} {game.answer}
            {game.id === "offwork"
              ? " 퇴근"
              : game.id === "wake"
                ? " 기상"
                : "점"}
            <span />
          </div>
        </div>
      ) : (
        <form onSubmit={submit}>
          <div className="screen-body input-cards">
            {author && (
              <div className="pill author-note">내가 출제하는 게임이에요</div>
            )}
            {game.id === "luck" && !author && (
              <div className="hint-card">
                <span aria-hidden="true">“</span>
                <p>{game.hint || "yeseo가 오늘의 힌트를 준비하고 있어요."}</p>
              </div>
            )}
            <section className="card prediction-input">
              <h2>
                {author
                  ? game.id === "luck"
                    ? "오늘의 행운 점수"
                    : "오늘의 실제 시간"
                  : questions[game.id]}
              </h2>
              {game.id === "luck" ? (
                <div className="luck-input">
                  <label className="luck-number" ref={luckNumber}>
                    <span className="sr-only">
                      {author ? "정답 점수" : "예측 점수"}
                    </span>
                    <input
                      type="number"
                      min="0"
                      max="100"
                      step="1"
                      value={value}
                      disabled={!editable || busy}
                      onChange={(e) => update(e.target.value)}
                    />
                    <span>점</span>
                  </label>
                  <input
                    aria-label="행운 점수 슬라이더"
                    className="luck-slider"
                    type="range"
                    min="0"
                    max="100"
                    value={Number(value) || 0}
                    disabled={!editable || busy}
                    onChange={(e) => update(e.target.value)}
                    style={
                      {
                        "--progress": `${Number(value) || 0}%`,
                      } as React.CSSProperties
                    }
                  />
                  <div className="range-labels">
                    <span>0</span>
                    <span>50</span>
                    <span>100</span>
                  </div>
                </div>
              ) : (
                <TimeWheel
                  value={value}
                  onChange={update}
                  disabled={!editable || busy}
                  hours={game.id === "wake" && !author ? [5, 12] : [0, 23]}
                />
              )}
              {author && game.id === "luck" && (
                <label className="field-label">
                  함께 볼 힌트
                  <textarea
                    value={hint}
                    onChange={(e) => setHint(e.target.value)}
                    placeholder="오늘의 기분은 어때요?"
                    maxLength={200}
                    required
                    disabled={!editable || busy}
                  />
                </label>
              )}
            </section>
            {!author && game.participants.length > 0 && (
              <div className="card submission-list">
                {[...game.participants]
                  .sort((a, b) => Number(a.username === user.username) - Number(b.username === user.username))
                  .map((player) => (
                    <SubmissionRow
                      key={player.playerId}
                      player={
                        // The preview has no server, so mark my row once saved.
                        demo && player.username === user.username && savedValue !== null
                          ? { ...player, submitted: true }
                          : player
                      }
                      me={player.username === user.username}
                    />
                  ))}
              </div>
            )}
            {error && (
              <p className="form-message error" role="alert">
                {error}
              </p>
            )}
            {!editable && (
              <p className="form-message" role="status">
                {user.role === "admin"
                  ? "운영자 계정은 게임에 참여하지 않아요."
                  : author
                    ? "정답 입력이 마감되었어요."
                    : "예측이 마감되었어요. 결과를 기다려 주세요."}
              </p>
            )}
          </div>
          <div className="game-actions">
            <button
              className={`primary-button ${saved ? "saved" : ""}`}
              disabled={!editable || busy}
              type="submit"
            >
              {saved && !author && (
                <svg className="saved-check" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M5 12.5l4.5 4.5L19 7.5" pathLength="1" />
                </svg>
              )}
              <span key={busy ? "busy" : saved ? "saved" : "idle"} className="button-label">
                {busy
                  ? "저장 중…"
                  : author
                    ? "정답 저장"
                    : saved
                      ? "제출 완료 · 마감 전까지 수정 가능"
                      : `${value}${game.id === "luck" ? "점" : ""}으로 예측`}
              </span>
            </button>
            {author && game.canReveal && !demo && (
              <button
                className="secondary-button reveal-button"
                type="button"
                onClick={reveal}
                disabled={busy}
              >
                정답 공개 · 예측 마감
              </button>
            )}
            {author && game.canReveal && (
              <p className="subtle-note">
                공개하면 지금부터 예측을 받을 수 없어요.
              </p>
            )}
          </div>
        </form>
      )}
    </div>
  );
}
