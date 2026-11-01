import { useEffect, useRef, useState, type FormEvent } from "react";
import { CATCHMIND_RULES } from "../../shared/balance";
import type { CatchmindAction, CatchmindInput, CatchmindRound, CatchmindState, User } from "../../shared/types";
import { useCatchmind } from "../catchmind";
import { DrawingCanvas } from "../components/DrawingCanvas";
import { Avatar, Chevron, Toolbar } from "../components/UI";
import { confetti, flipY, hop, pop, popIn, rise, shake, toast, useMountMotion, useOnChange } from "../motion";
import "../preview.css";

function HintTiles({ hint }: { hint: NonNullable<CatchmindRound["hint"]> }) {
  const first = useMountMotion<HTMLSpanElement>(element => flipY(element));
  return <div className="pg-hint" role="status" aria-label={`첫 글자 힌트: ${hint.firstCharacter}, ${hint.length}글자`}>
    {Array.from({ length: hint.length }, (_, i) => <span key={i} ref={i === 0 ? first : undefined}>{i === 0 ? hint.firstCharacter : ""}</span>)}
  </div>;
}
function GuessLog({ round }: { round: CatchmindRound }) {
  const words = useRef<HTMLUListElement>(null);
  useOnChange(round.guesses.length, before => {
    if (round.guesses.length > before) rise(words.current?.lastElementChild);
  });
  return <ul className="pg-wrong-words" ref={words} aria-label="모두의 답">
    {round.guesses.map(guess => <li key={guess.id}><span className={guess.correct ? "correct" : ""}>{guess.player.displayName} · {guess.answer}{guess.correct ? " · 정답" : ""}</span></li>)}
  </ul>;
}
function FailCount({ round }: { round: CatchmindRound }) {
  const nodes = useRef<HTMLDivElement>(null);
  const ended = round.status === "ended";
  const hinted = round.wrongCount >= CATCHMIND_RULES.hintAfter;
  useOnChange(round.wrongCount, before => {
    if (round.wrongCount > before) pop(nodes.current?.children[round.wrongCount - 1], 1.25);
  });
  return <div className="pg-fails">
    <div className="pg-between"><span>모두의 오답</span><strong className={hinted && !ended ? "hinted" : ""}>
      {ended ? round.winner ? "정답!" : "판 종료" : hinted ? `종료까지 ${CATCHMIND_RULES.endAfter - round.wrongCount}번` : `힌트까지 ${CATCHMIND_RULES.hintAfter - round.wrongCount}번`}
    </strong></div>
    <div className="pg-fail-nodes" ref={nodes} aria-label={`오답 ${round.wrongCount}회, ${CATCHMIND_RULES.endAfter}회면 종료`}>
      {Array.from({ length: CATCHMIND_RULES.endAfter }, (_, i) => <span key={i} className={`${i < round.wrongCount ? "hit" : ""} ${i === CATCHMIND_RULES.hintAfter - 1 ? "hint" : ""} ${i === round.wrongCount && !ended ? "next" : ""}`}>
        {i < round.wrongCount ? "×" : i === CATCHMIND_RULES.hintAfter - 1 ? "힌트" : i === CATCHMIND_RULES.endAfter - 1 ? "끝" : ""}
      </span>)}
    </div>
  </div>;
}
function Picture({ round, result = false, demo }: { round: CatchmindRound; result?: boolean; demo: boolean }) {
  return <div className={`pg-card ${result ? "pg-result-picture" : "pg-drawing-card"}`}>
    {!result && <div className="pg-author">
      <Avatar username={round.drawer.username} artKey={demo ? undefined : round.drawer.character} size={32} />
      <strong>{round.drawer.displayName}</strong>
      {round.publishedAt && <span className="pg-muted">{new Intl.DateTimeFormat("ko-KR", { timeZone: "Asia/Seoul", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(round.publishedAt))}</span>}
      <span className="pg-chip coral">{CATCHMIND_RULES.score}점 · {CATCHMIND_RULES.gold}G</span>
    </div>}
    <div className="pg-picture">{round.image ? <img src={round.image} alt={`${round.drawer.displayName}이 그린 그림`} /> : <p className="pg-muted">공개된 그림이 없어요.</p>}</div>
    {result && <span>{round.word}</span>}
  </div>;
}
function Result({ state, user, locked, onNext, demo }: { state: CatchmindState; user: User; locked: boolean; onNext: () => void; demo: boolean }) {
  const round = state.round!;
  const winner = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!round.winner) return;
    popIn(winner.current);
    confetti(winner.current);
    hop(winner.current?.querySelector(".avatar"));
  }, [round.id, round.winner?.id]);
  const nextPlayer = <>
    {state.turn && <Avatar username={state.turn.username} artKey={demo ? undefined : state.turn.character} size={42} />}
    <div><small>다음 출제</small><strong>{state.turn?.displayName ?? "차례를 기다리고 있어요"}</strong></div>
    {state.canNext ? <><span>다음 그림 그리기</span><Chevron direction="right" size={20} color="#ADA4B3" /></> : <span>다음 그림을 기다려 주세요</span>}
  </>;
  return <>
    <Picture round={round} result demo={demo} />
    {round.winner ? <div className="pg-card pg-winner" ref={winner}>
      <Avatar username={round.winner.username} artKey={demo ? undefined : round.winner.character} size={64} />
      <div><small>{round.winner.id === user.id ? "내가 맞힘" : "맞힌 사람"}</small><strong>{round.winner.displayName}</strong></div>
      <div className="pg-winner-points"><b>+{CATCHMIND_RULES.score}점</b><b>+{CATCHMIND_RULES.gold}G</b></div>
    </div> : <div className="pg-ended" role="status"><strong>{round.endReason === "manual" ? "출제자가 판을 마쳤어요" : "아무도 맞히지 못했어요"}</strong><span>보상 없이 판이 끝났어요. 출제자가 다음 그림을 그려요.</span></div>}
    <FailCount round={round} />
    <GuessLog round={round} />
    {state.canNext ? <button className="pg-card pg-next-player" aria-label="다음 그림 그리기" disabled={locked} onClick={onNext}>{nextPlayer}</button> : <div className="pg-card pg-next-player">{nextPlayer}</div>}
  </>;
}

export function Catchmind({ user, onBack, demo = false }: { user: User; onBack: () => void; demo?: boolean }) {
  const game = useCatchmind();
  const latest = useRef(game);
  latest.current = game;
  const [answer, setAnswer] = useState("");
  const [acting, setActing] = useState(false);
  const actionInFlight = useRef(false);
  const form = useRef<HTMLFormElement>(null);
  const confirmation = useRef<HTMLDialogElement>(null);
  const round = game.state?.round ?? null;
  const locked = acting || game.busy || Boolean(game.pending);
  const isDrawer = round?.drawer.id === user.id && user.role === "player";
  useEffect(() => {
    const refresh = () => {
      if (document.visibilityState === "visible") void latest.current.refresh().catch(() => {});
    };
    refresh();
    const timer = window.setInterval(refresh, CATCHMIND_RULES.pollIntervalMs);
    document.addEventListener("visibilitychange", refresh);
    window.addEventListener("online", refresh);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", refresh);
      window.removeEventListener("online", refresh);
    };
  }, []);
  useEffect(() => { setAnswer(""); }, [round?.id]);
  useEffect(() => { if (!game.state?.canEnd) confirmation.current?.close(); }, [game.state?.canEnd]);
  useOnChange(round?.wrongCount, before => {
    if (typeof before === "number" && round && round.wrongCount > before) shake(form.current);
  });
  async function run(action: CatchmindAction, input: CatchmindInput, success?: string) {
    if (actionInFlight.current || game.busy) return false;
    actionInFlight.current = true;
    setActing(true);
    try {
      await game.mutate(action, input);
      if (success) toast(success);
      return true;
    } catch { return false; }
    finally { actionInFlight.current = false; setActing(false); }
  }
  const mutation = () => ({ requestId: crypto.randomUUID(), roundId: round?.id ?? null });
  async function guess(event: FormEvent) {
    event.preventDefault();
    if (!game.state?.canGuess || locked || !answer.replace(/\s/g, "")) return;
    if (await run("guess", { ...mutation(), answer })) setAnswer("");
  }
  async function publish(image: string) {
    if (!round || !game.state?.canPublish || locked) throw new Error("그림을 올릴 차례인지 확인해 주세요.");
    // Preserve the round and prompt shown by this canvas, even if polling finds a new one.
    await game.mutate("publish", { ...mutation(), wordVersion: round.wordVersion, image });
    toast("그림을 올렸어요");
  }
  const state = game.state;
  return <section className="preview-game pg-catchmind">
    <Toolbar title={round?.status === "draft" && isDrawer ? "그림 그리기" : "캐치마인드"} onBack={onBack} gold={user.gold} />
    <div className="pg-stack">
      {round && <p className="cm-round-label">제 {round.number}판</p>}
      {user.role === "admin" && <p className="subtle-note">운영자 계정은 게임에 참여하지 않아요.</p>}
      {game.error && <div className="cm-error"><p className="form-message error" role="alert">{game.error}</p><button className="text-button" disabled={acting || game.busy} onClick={() => void game.refresh().catch(() => {})}>다시 불러오기</button></div>}
      {game.pending && <div className="pg-card cm-pending" role="status"><p>아직 처리 결과를 확인하지 못했어요. 같은 요청으로 다시 확인해 주세요.</p><button className="secondary-button" disabled={acting || game.busy} onClick={() => { if (game.pending) void run(game.pending.action, game.pending.input); }}>처리 결과 다시 확인</button></div>}
      {game.loading && !state && <p className="subtle-note" role="status">그림을 불러오는 중…</p>}
      {state && !round && <div className="pg-card cm-waiting">
        <h2>누가 먼저 그려볼까요?</h2><p>그릴 차례를 맡으면 나만 볼 수 있는 제시어가 나와요.</p>
        {state.canClaim && <button className="primary-button" disabled={locked} onClick={() => void run("claim", mutation())}>그리기 맡기</button>}
      </div>}
      {state && round?.status === "draft" && (isDrawer ? <>
        <div className="pg-prompt"><span>제시어</span><strong>{round.word ?? "불러오는 중"}</strong></div>
        <div className="cm-draft-note"><span>나에게만 보이는 제시어예요.</span><button className="text-button" disabled={locked || !state.canReroll} onClick={() => void run("reroll", { ...mutation(), wordVersion: round.wordVersion })}>제시어 바꾸기 ({round.rerollsLeft}회 남음)</button></div>
        <DrawingCanvas key={`${round.id}:${round.wordVersion}`} disabled={locked || !state.canPublish} publishing={game.busy && game.pending?.action === "publish"} onPublish={publish} />
      </> : <div className="pg-card cm-waiting">
        <Avatar username={round.drawer.username} artKey={demo ? undefined : round.drawer.character} size={64} />
        <h2>{round.drawer.displayName}이 그림을 그리고 있어요</h2><p>그림이 올라오면 함께 맞혀 보세요.</p>
      </div>)}
      {state && round?.status === "open" && <>
        {isDrawer && <div className="pg-prompt"><span>제시어</span><strong>{round.word}</strong></div>}
        <Picture round={round} demo={demo} />
        <FailCount round={round} />
        {round.hint && <HintTiles key={round.id} hint={round.hint} />}
        <GuessLog round={round} />
        {user.role === "player" && !isDrawer ? <form className="pg-answer" onSubmit={guess} ref={form}>
          <input aria-label="캐치마인드 정답" value={answer} onChange={event => setAnswer(event.target.value)} placeholder="정답 입력" maxLength={CATCHMIND_RULES.maxAnswerLength} disabled={locked || !state.canGuess} autoComplete="off" />
          <button type="submit" disabled={locked || !state.canGuess || !answer.replace(/\s/g, "")}>{acting || game.busy ? "확인 중…" : "정답"}</button>
        </form> : isDrawer && <p className="subtle-note">내가 낸 그림에는 답할 수 없어요. 친구들의 답을 기다려 주세요.</p>}
      </>}
      {state && round?.status === "ended" && <Result key={round.id} state={state} user={user} locked={locked} demo={demo} onNext={() => void run("next", mutation())} />}
      {state?.canEnd && <button className="text-button cm-end-button" disabled={locked} onClick={() => confirmation.current?.showModal()}>이번 판 끝내기</button>}
    </div>
    <dialog className="cm-confirmation" ref={confirmation} aria-labelledby="cm-end-title" aria-describedby="cm-end-description" onClick={event => { if (event.target === event.currentTarget && !locked) event.currentTarget.close(); }}>
      <h2 id="cm-end-title">이번 판을 끝낼까요?</h2><p id="cm-end-description">정답을 공개하고 보상 없이 판을 끝내요. 다음 그리기 차례는 나에게 남아요.</p>
      <button className="primary-button" disabled={locked || !state?.canEnd} onClick={() => { confirmation.current?.close(); void run("end", mutation()); }}>판 종료</button>
      <button className="text-button" onClick={() => confirmation.current?.close()}>취소</button>
    </dialog>
  </section>;
}
