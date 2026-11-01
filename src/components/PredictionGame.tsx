import { useCallback, useEffect, useRef, useState } from "react";
import type { GameHistoryRound, GameId, GameResult, GameState, User } from "../../shared/types";
import { GAME_RULES, PREDICTION_REWARDS, SCORE_TABLES, predictionPoints } from "../../shared/balance";
import { api } from "../api";
import { previewHistory, rankOf } from "../sample";
import {
  anim,
  confetti,
  flipY,
  pop,
  reduced,
  rise,
  toast,
  tween,
  useOnChange,
} from "../motion";
import {
  Avatar,
  CharacterSprite,
  Coin,
  Toolbar,
  playerColor,
  preloadSprites,
  useCharacter,
  type CharState,
} from "./UI";

type Props = {
  game: GameState;
  user: User;
  serverTime: string;
  demo?: boolean;
  onBack: () => void;
  onSave: (value: string, hint: string, author: boolean) => Promise<void>;
  onReveal: () => Promise<void>;
  onWake: () => Promise<void>;
};
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
          inputMode="numeric"
          step="1"
          min={low}
          max={high}
          value={String(value).padStart(2, "0")}
          onChange={(event) => {
            const n = Number(event.target.value);
            if (Number.isInteger(n) && n >= low && n <= high) onChange(n);
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
  const [hour, minute, second] = value.split(":").map(Number);
  const set = (part: number) => (n: number) => {
    const next = [hour, minute, second];
    next[part] = n;
    onChange(next.map((v) => String(v).padStart(2, "0")).join(":"));
  };
  return (
    <div className="time-wheel" role="group" aria-label="시각 선택">
      <div className="wheel-selection" />
      <WheelColumn value={hour} low={hours[0]} high={hours[1]} label="시" disabled={disabled} onChange={set(0)} />
      <WheelColumn value={minute} low={0} high={59} label="분" disabled={disabled} onChange={set(1)} />
      <WheelColumn value={second} low={0} high={59} label="초" disabled={disabled} onChange={set(2)} />
      <span className="wheel-unit" aria-hidden="true">시</span>
      <span className="wheel-unit" aria-hidden="true">분</span>
      <span className="wheel-unit" aria-hidden="true">초</span>
      <span className="wheel-colon" aria-hidden="true">:</span>
      <span className="wheel-colon second" aria-hidden="true">:</span>
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
function differenceText(id: GameId, difference: number) {
  return difference === 0 ? "정확히 맞힘" : `${difference}${id === "luck" ? "점" : "초"} 차이`;
}
function ResultCards({ id, results, username, demo }: { id: GameId; results: GameResult[]; username: string; demo?: boolean }) {
  return results.length ? results.map((result) => {
    const rank = rankOf(results, result);
    return <article className="card result-card" key={result.playerId}>
      <div className="result-player">
        <span className={`rank-badge ${result.isFirst ? "first" : ""}`}>{rank}</span>
        <Avatar username={result.username} artKey={demo ? undefined : result.character} size={46} />
        <div className="result-name">
          <strong>{result.displayName}{result.username === username ? " (나)" : ""}</strong>
          <span>{differenceText(id, result.difference)}</span>
        </div>
        <strong className="result-guess">{result.value}{id === "luck" ? "점" : ""}</strong>
      </div>
      <div className="result-rewards">
        <span className="reward points">{result.score > 0 ? "+" : ""}{result.score}점</span>
        <span className="reward gold"><Coin size={20} />+{result.participationGold} 참여</span>
        {result.isFirst && <span className="reward bonus"><Coin size={20} />+{result.firstGold} 1등 보너스</span>}
      </div>
    </article>;
  }) : <div className="card empty-state">이번 라운드에는 제출한 예측이 없어요.</div>;
}
function GameHistory({ game, username, demo }: { game: GameState; username: string; demo?: boolean }) {
  const [history, setHistory] = useState<GameHistoryRound[]>(() => demo ? previewHistory(game.id) : []);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(!demo);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    if (demo) { setHistory(previewHistory(game.id)); setLoading(false); return; }
    let active = true;
    setLoading(true);
    setError("");
    void api.history(game.id).then(({ history: next }) => {
      if (active) setHistory(next);
    }).catch((e: unknown) => {
      if (active) setError(e instanceof Error ? e.message : "기록을 불러오지 못했어요.");
    }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [game.id, game.roundDate, demo, retry]);
  return <section className="screen-body prediction-history" aria-label="최근 결과 기록">
    <h2>최근 결과 기록</h2>
    {loading ? <p className="subtle-note" role="status">기록을 불러오는 중…</p> : error ?
      <div className="card empty-state"><p role="alert">{error}</p><button className="text-button" onClick={() => setRetry(n => n + 1)}>다시 시도</button></div> :
      history.length ? history.map(round => <section className="history-round" key={round.roundDate}>
        <div className="history-heading"><h3>{round.roundDate}</h3><span>정답 <strong>{round.answer}{game.id === "luck" ? "점" : ""}</strong></span></div>
        <ResultCards id={game.id} results={round.results} username={username} demo={demo} />
      </section>) : <p className="card empty-state">아직 공개된 지난 기록이 없어요.</p>}
  </section>;
}
function thresholdLabel(id: GameId, difference: number): string {
  if (difference === 0) return "정확히 일치";
  if (id === "luck") return `${difference}점 차이 이내`;
  const hours = Math.floor(difference / 3600);
  const minutes = Math.floor((difference % 3600) / 60);
  const seconds = difference % 60;
  return [hours ? `${hours}시간` : "", minutes ? `${minutes}분` : "", seconds ? `${seconds}초` : ""].filter(Boolean).join(" ") + " 이내";
}
function GameHelp({ id }: { id: GameId }) {
  const rules = GAME_RULES[id];
  return <div className="screen-body prediction-help"><details className="card">
    <summary>게임 방법</summary>
    <div className="help-content">
      <p>매일 {rules.deadline} (KST)까지 예측할 수 있어요. 정답이 먼저 공개되면 예측도 바로 마감돼요.</p>
      <p>{id === "wake" ? 'min이 “기상했어요”를 누른 서버 시각이 정답이 되어 바로 공개돼요.' : id === "offwork" ? 'siwon이 정한 퇴근 시각에 자동 공개돼요. 미리 공개할 수도 있어요.' : `yeseo의 점수와 힌트를 보고 예측해요. ${GAME_RULES.luck.revealTime}에 자동 공개되며 미리 공개할 수도 있어요.`}</p>
      <p>첫 예측 저장 즉시 참여 보상 {PREDICTION_REWARDS.participationGold}G를 받아요. 수정해도 다시 지급되지 않아요. 정답과 가장 가까운 1등은 {PREDICTION_REWARDS.firstGold}G를 받고, 동점이면 모두 받아요.</p>
      <table><caption>정답과의 차이에 따른 점수</caption><thead><tr><th scope="col">차이</th><th scope="col">점수</th></tr></thead><tbody>
        {SCORE_TABLES[id].map(tier => <tr key={tier.maxDifference}><th scope="row">{thresholdLabel(id, tier.maxDifference)}</th><td>{tier.points}점</td></tr>)}
        <tr><th scope="row">그 밖</th><td>{predictionPoints(id, Infinity)}점</td></tr>
      </tbody></table>
      <p>출제자는 자기 게임을 예측할 수 없어요. 정답이 없는 날은 결과 대기 상태로 남고 참여 보상은 유지돼요.</p>
    </div>
  </details></div>;
}
export function PredictionGame({ game, user, serverTime, demo, onBack, onSave, onReveal, onWake }: Props) {
  const author = user.role === "player" && user.username === game.authorUsername;
  const initial = author ? game.answer : game.prediction;
  const defaultValue = game.id === "luck" ? "65" : game.id === "wake" ? "08:40:00" : "18:00:00";
  const [value, setValue] = useState(initial ?? defaultValue);
  const [hint, setHint] = useState(game.hint);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [now, setNow] = useState(Date.parse(serverTime));
  const confirmation = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const offset = Date.parse(serverTime) - Date.now();
    setNow(Date.now() + offset);
    const timer = window.setInterval(() => setNow(Date.now() + offset), 1000);
    return () => clearInterval(timer);
  }, [serverTime]);
  useEffect(() => { setValue(initial ?? defaultValue); }, [game.id, initial, defaultValue]);
  useEffect(() => { setHint(game.hint); }, [game.hint]);
  const deadline = /^\d{2}:\d{2}:\d{2}$/.test(game.deadline) ? `${game.roundDate}T${game.deadline}+09:00` : game.deadline;
  const left = Math.max(0, Math.ceil((Date.parse(deadline) - now) / 1000));
  const editable = demo || (author ? game.canEditAnswer : game.canPredict && left > 0);
  const revealed = game.phase === "revealed";
  const [savedValue, setSavedValue] = useState<string | null>(null);
  const saved = (savedValue ?? initial) === value && (savedValue ?? initial) !== null;
  const urgent = !revealed && left > 0 && left < 600;
  const countdownRef = useRef<HTMLElement>(null);
  const luckNumber = useRef<HTMLLabelElement>(null);
  const heroKey = useCharacter(game.authorUsername);
  const [oneShot, setOneShot] = useState<CharState | null>(null);
  const playJump = useCallback(() => { setOneShot(state => state === "jump" ? state : "jump"); }, []);
  const finish = useCallback(() => setOneShot(null), []);
  const results = useRef<HTMLDivElement>(null);
  const answerRef = useRef<HTMLElement>(null);
  useOnChange(left, () => {
    if (urgent) anim(countdownRef.current, [{ scale: "1" }, { scale: "1.035" }, { scale: "1" }], { dur: 600, ease: "inOut", fill: "none" });
  });
  useOnChange(value, () => {
    if (game.id === "luck") anim(luckNumber.current, [{ translate: "0 0" }, { translate: "0 -3px" }, { translate: "0 0" }], { dur: 140, fill: "none" });
  });
  useEffect(() => {
    void preloadSprites(heroKey, revealed ? ["jump"] : ["greet", "jump"]);
    setOneShot(null);
    if (revealed) return;
    const timer = window.setTimeout(() => setOneShot(state => state ?? "greet"), 320);
    return () => window.clearTimeout(timer);
    // Only read the reveal state on entry.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [game.id, heroKey]);
  useEffect(() => {
    if (!revealed) return;
    flipY(answerRef.current);
    const cards = [...(results.current?.querySelectorAll(".result-card") ?? [])];
    cards.forEach((card, i) => rise(card, { delay: 520 + i * 140 }));
    const chips = [...(results.current?.querySelectorAll(".reward") ?? [])];
    chips.forEach((chip, i) => anim(chip, [{ scale: ".6", opacity: 0 }, { scale: "1", opacity: 1 }], { dur: 420, ease: "spring", delay: 520 + cards.length * 140 + i * 110 }));
    const done = 520 + cards.length * 140 + chips.length * 110 + 200;
    const t = setTimeout(() => {
      if (cards.length) confetti(cards[0].querySelector(".rank-badge"));
      playJump();
    }, reduced() ? 0 : done);
    return () => clearTimeout(t);
  }, [revealed, playJump]);
  const update = (next: string) => { setValue(next); setError(""); };
  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setError("");
    if (!editable || busy) return;
    if (game.id === "luck" ? !/^(?:0|[1-9][0-9]?|100)$/.test(value) : !/^([01]\d|2[0-3]):[0-5]\d:[0-5]\d$/.test(value)) {
      setError(game.id === "luck" ? "0~100 사이의 정수를 입력해 주세요." : "올바른 시·분·초를 입력해 주세요.");
      return;
    }
    setBusy(true);
    try {
      await onSave(value, hint, author);
      setSavedValue(value);
      toast(author ? "정답을 저장했어요" : "예측을 저장했어요");
    } catch (e) { setError(e instanceof Error ? e.message : "저장하지 못했어요. 다시 시도해 주세요."); }
    finally { setBusy(false); }
  }
  async function reveal(wake = false) {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await (wake ? onWake() : onReveal());
      confirmation.current?.close();
      toast(wake ? "기상 시각을 공개했어요" : "정답을 공개했어요");
    } catch (e) { setError(e instanceof Error ? e.message : "공개하지 못했어요."); confirmation.current?.close(); }
    finally { setBusy(false); }
  }
  const participants = <div className="card submission-list">{[...game.participants]
    .sort((a, b) => Number(a.username === user.username) - Number(b.username === user.username))
    .map(player => <SubmissionRow key={player.playerId} player={demo && player.username === user.username && savedValue !== null ? { ...player, submitted: true } : player} me={player.username === user.username} />)}</div>;
  return <div className={`prediction-page ${game.id} ${revealed ? "revealed" : ""}`}>
    <div className="prediction-hero">
      <Toolbar title={game.title} onBack={onBack} gold={user.gold} />
      <div className="character-stage">
        <div className="character-shadow" />
        <button type="button" className="hero-character-button" aria-label={`${game.authorUsername}의 캐릭터`} data-nopress onClick={playJump}>
          <span className="hero-character-wrap"><CharacterSprite username={game.authorUsername} state={oneShot ?? "idle"} className="hero-character" onDone={finish} /></span>
        </button>
        <span className="author-pill" style={{ color: playerColor[game.authorUsername] }}>출제 {game.authorUsername}</span>
      </div>
    </div>
    {author && <p className="author-date">{game.roundDate} · {GAME_RULES[game.id].deadline} 마감 · 내가 출제하는 게임</p>}
    <div className="countdown-row">
      <div className="countdown"><span>{revealed ? "정답" : author ? "예측 마감까지" : "마감까지"}</span>
        <strong ref={revealed ? answerRef : countdownRef} className={revealed ? "answer-number" : urgent ? "urgent" : ""}>{revealed ? `${game.answer ?? "—"}${game.id === "luck" ? "점" : ""}` : clock(left)}</strong>
      </div>
      <div className="deadline-block">
        <span className={`pill ${revealed ? "yellow" : "mint"}`}>{revealed ? "결과 공개" : `${GAME_RULES[game.id].deadline} 마감`}</span>
        {game.id === "luck" && !revealed && <small>{GAME_RULES.luck.revealTime} 공개</small>}
      </div>
    </div>
    {revealed ? <div className="screen-body result-list" ref={results}>
      <ResultCards id={game.id} results={game.results} username={user.username} demo={demo} />
      <div className="result-caption"><span />{game.authorUsername} {game.answer}{game.id === "offwork" ? " 퇴근" : game.id === "wake" ? " 기상" : "점"}<span /></div>
    </div> : <form onSubmit={submit}>
      <div className="screen-body input-cards">
        {game.id === "luck" && !author && <div className="hint-card"><span aria-hidden="true">“</span><p>{game.hint || "yeseo가 오늘의 힌트를 준비하고 있어요."}</p></div>}
        {author && game.id === "wake" ? <section className="card wake-author">
          <h2>오늘도 잘 잤나요?</h2>
          <span className="subtle-note">현재 시각 (KST)</span>
          <strong className="wake-clock">{new Date(now + 9 * 60 * 60 * 1000).toISOString().slice(11, 19)}</strong>
          <button className="primary-button" type="button" disabled={!editable || busy} onClick={() => confirmation.current?.showModal()}>기상했어요</button>
          <p className="subtle-note">확인하는 순간의 시각이 정답으로 바로 공개돼요.</p>
        </section> : <section className="card prediction-input">
          <h2>{author ? game.id === "luck" ? "오늘의 행운 점수" : "오늘의 퇴근 시각" : questions[game.id]}</h2>
          {game.id === "luck" ? <div className="luck-input">
            <label className="luck-number" ref={luckNumber}><span className="sr-only">{author ? "정답 점수" : "예측 점수"}</span>
              <input type="number" inputMode="numeric" min="0" max="100" step="1" value={value} disabled={!editable || busy} onChange={e => update(e.target.value)} /><span>점</span>
            </label>
            <input aria-label="행운 점수 슬라이더" className="luck-slider" type="range" min="0" max="100" value={Number(value) || 0} disabled={!editable || busy} onChange={e => update(e.target.value)} style={{ "--progress": `${Number(value) || 0}%` } as React.CSSProperties} />
            <div className="range-labels"><span>0</span><span>50</span><span>100</span></div>
          </div> : <TimeWheel value={value} onChange={update} disabled={!editable || busy} />}
          {author && game.id === "luck" && <label className="field-label">함께 볼 힌트
            <textarea value={hint} onChange={e => setHint(e.target.value)} placeholder="오늘의 기분은 어때요?" maxLength={200} disabled={!editable || busy} />
            <span className="subtle-note">{hint.length}/200</span>
          </label>}
          {author && <p className="subtle-note">{game.id === "luck" ? `${GAME_RULES.luck.revealTime}에 자동 공개` : game.answer ? `${game.answer}에 자동 공개` : "퇴근 시각을 저장하면 그 시각에 자동 공개돼요."}</p>}
        </section>}
        {game.participants.length > 0 && participants}
        {error && <p className="form-message error" role="alert">{error}</p>}
        {!editable && <p className="form-message" role="status">{user.role === "admin" ? "운영자 계정은 게임에 참여하지 않아요." : author ? "정답 입력이 마감되었어요." : "예측이 마감되었어요. 결과를 기다려 주세요."}</p>}
      </div>
      {!(author && game.id === "wake") && <div className="game-actions">
        <button className={`primary-button ${saved ? "saved" : ""}`} disabled={!editable || busy} type="submit">
          {saved && !author && <svg className="saved-check" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5" pathLength="1" /></svg>}
          <span key={busy ? "busy" : saved ? "saved" : "idle"} className="button-label">{busy ? "저장 중…" : author ? "정답 저장" : saved ? "제출 완료 · 마감 전까지 수정 가능" : `${value}${game.id === "luck" ? "점" : ""}으로 예측`}</span>
        </button>
        {author && game.canReveal && <><button className="secondary-button reveal-button" type="button" onClick={() => void reveal()} disabled={busy}>지금 공개</button><p className="subtle-note">공개하면 지금부터 예측을 받을 수 없어요.</p></>}
      </div>}
    </form>}
    <GameHistory game={game} username={user.username} demo={demo} />
    <GameHelp id={game.id} />
    <dialog className="wake-confirmation" ref={confirmation} aria-labelledby="wake-confirm-title" aria-describedby="wake-confirm-description" onClick={e => { if (e.target === e.currentTarget && !busy) e.currentTarget.close(); }} onCancel={e => { if (busy) e.preventDefault(); }}>
      <h2 id="wake-confirm-title">기상 시각을 공개할까요?</h2>
      <p id="wake-confirm-description">확인을 누른 순간의 서버 시각이 정답이 돼요. 공개 후에는 되돌릴 수 없고 예측도 마감돼요.</p>
      <button className="primary-button" type="button" disabled={busy} onClick={() => void reveal(true)}>{busy ? "공개 중…" : "기상 시각 확정"}</button>
      <button className="text-button" type="button" disabled={busy} onClick={() => confirmation.current?.close()}>취소</button>
    </dialog>
  </div>;
}
