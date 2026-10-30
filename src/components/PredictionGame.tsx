import { useEffect, useState } from "react";
import type { GameState, User } from "../../shared/types";
import { Avatar, Character, Toolbar, characters } from "./UI";

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
function TimeWheel({
  value,
  onChange,
  disabled,
}: {
  value: string;
  onChange: (v: string) => void;
  disabled: boolean;
}) {
  const [hour, minute] = value.split(":").map(Number);
  function change(n: number, part: number) {
    const next = [hour, minute];
    next[part] = n;
    onChange(next.map((v) => String(v).padStart(2, "0")).join(":"));
  }
  return (
    <div className="time-wheel" role="group" aria-label="예측 시간 선택">
      <div className="wheel-selection" />
      {[hour, minute].map((v, part) => (
        <div className="time-column" key={part}>
          {[-2, -1, 0, 1, 2].map((offset) => {
            const max = part ? 60 : 24;
            const number = (v + offset + max) % max;
            return offset === 0 ? (
              <label key={offset} className="wheel-active">
                <span className="sr-only">{part ? "분" : "시"}</span>
                <input
                  type="number"
                  min="0"
                  max={max - 1}
                  value={String(v).padStart(2, "0")}
                  onChange={(event) => {
                    const n = Number(event.target.value);
                    if (Number.isInteger(n) && n >= 0 && n < max)
                      change(n, part);
                  }}
                  disabled={disabled}
                />
              </label>
            ) : (
              <button
                type="button"
                className={`wheel-option ${Math.abs(offset) === 2 ? "far" : ""}`}
                disabled={disabled}
                onClick={() => change(number, part)}
                key={offset}
                aria-label={`${number}${part ? "분" : "시"} 선택`}
              >
                {String(number).padStart(2, "0")}
              </button>
            );
          })}
        </div>
      ))}
      <span className="wheel-colon" aria-hidden="true">
        :
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
  const [notice, setNotice] = useState("");
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
  const saved = initial === value && initial !== null;
  const palette = characters[game.authorUsername];
  const update = (next: string) => {
    setValue(next);
    setNotice("");
    setError("");
  };
  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setError("");
    setNotice("");
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
      setNotice(
        demo
          ? "체험 입력을 확인했어요. 실제 게임에는 저장되지 않아요."
          : author
            ? "정답을 저장했어요. 공개 전까지 수정할 수 있어요."
            : "예측을 저장했어요. 마감 전까지 수정할 수 있어요.",
      );
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
      setNotice("정답을 공개했어요. 예측도 마감되었어요.");
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
          right={demo ? <span className="preview-label">체험</span> : undefined}
        />
        <div className="character-stage">
          <div className="character-shadow" />
          <Character
            username={game.authorUsername}
            className="hero-character"
          />
          <span className="author-pill" style={{ color: palette?.color }}>
            출제 {game.authorUsername}
          </span>
        </div>
      </div>
      <div className="countdown-row">
        <div className="countdown">
          <span>
            {revealed ? "정답" : author ? "예측 마감까지" : "마감까지"}
          </span>
          <strong className={revealed ? "answer-number" : ""}>
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
        <div className="screen-body result-list">
          {game.results.length ? (
            game.results.map((result) => (
              <article className="card result-card" key={result.playerId}>
                <div className="result-player">
                  <span
                    className={`rank-badge ${result.difference === game.results[0].difference ? "first" : ""}`}
                  >
                    {game.results.findIndex(
                      (r) => r.difference === result.difference,
                    ) + 1}
                  </span>
                  <Avatar username={result.username} size={46} />
                  <div className="result-name">
                    <strong>
                      {result.displayName}
                      {result.username === user.username ? " (나)" : ""}
                    </strong>
                    <span>
                      {result.difference}
                      {game.id === "luck" ? "점" : "분"} 차이
                    </span>
                  </div>
                  <strong className="result-guess">
                    {result.value}
                    {game.id === "luck" ? "점" : ""}
                  </strong>
                </div>
                <div className="result-rewards">
                  <span className="pill peach">
                    {result.difference === 0
                      ? "정확히 맞혔어요!"
                      : result.difference === game.results[0].difference
                        ? "가장 가까운 예측"
                        : "참여 완료"}
                  </span>
                </div>
              </article>
            ))
          ) : (
            <div className="card empty-state">
              이번 라운드에는 제출한 예측이 없어요.
            </div>
          )}
          <div className="result-caption">
            <span />
            {game.authorUsername} · {game.answer}
            {game.id === "offwork"
              ? " 퇴근"
              : game.id === "wake"
                ? " 기상"
                : "점"}
            <span />
          </div>
          <p className="subtle-note">
            {demo
              ? "화면 체험용 결과예요. 실제 점수·골드는 변하지 않아요."
              : "점수와 골드 보상은 배점 확정 후 적용돼요."}
          </p>
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
                  <label className="luck-number">
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
                />
              )}
              {author && game.id === "luck" && (
                <label className="field-label">
                  함께 볼 힌트
                  <textarea
                    value={hint}
                    onChange={(e) => {
                      setHint(e.target.value);
                      setNotice("");
                    }}
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
                {game.participants.map(player => (
                  <div className="submission-card" key={player.playerId}>
                    <Avatar username={player.username} />
                    <strong>{player.displayName}{player.username === user.username ? " (나)" : ""}</strong>
                    <span className={`pill ${player.submitted ? "mint" : "muted"}`}>
                      {player.submitted ? "제출 완료" : "아직"}
                    </span>
                  </div>
                ))}
              </div>
            )}
            {error && (
              <p className="form-message error" role="alert">
                {error}
              </p>
            )}
            {notice && (
              <p className="form-message success" role="status">
                {notice}
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
              {busy
                ? "저장 중…"
                : author
                  ? "정답 저장"
                  : saved
                    ? "제출 완료 · 마감 전까지 수정 가능"
                    : `${value}${game.id === "luck" ? "점" : ""}으로 예측`}
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
