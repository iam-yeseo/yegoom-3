import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { TOILET_RULES } from "../../shared/balance";
import type { CatchmindPlayer, LedgerEntry, ToiletAction, ToiletPollResponse, ToiletRoundView, ToiletState, ToiletSummary, User } from "../../shared/types";
import { api, ApiFailure } from "../api";
import { Avatar, Toolbar, honorific, useDisplayNameLookup } from "../components/UI";
import { playSfx, preloadSfx } from "../sfx";
import { previewToilet } from "../toilet-preview";
import "../toilet.css";

/** What the home row needs, taken from the round the screen already holds. */
function summaryOf(state: ToiletState, me: string): ToiletSummary {
  const round = state.current, short = (player: CatchmindPlayer | null | undefined) => (player ? { username: player.username, displayName: player.displayName } : null);
  if (!round) return { half: null, label: null, status: "closed", turn: null, loser: null, points: 0, pushes: 0, slots: 0 };
  return {
    half: round.half, label: round.label, status: round.status, turn: short(round.turn), loser: short(round.loser),
    points: round.results.find(entry => entry.player.id === me)?.points ?? 0, pushes: round.pushes.length, slots: round.slots,
  };
}
const minutesLeft = (until: number, now: number) => Math.max(1, Math.ceil((until - now) / 60_000));
const clock = (iso: string) => { const date = new Date(Date.parse(iso) + 9 * 3_600_000); return `${date.getUTCHours()}시${date.getUTCMinutes() ? ` ${date.getUTCMinutes()}분` : ""}`; };
const percent = (chance: number) => `${Math.round(chance * 100)}%`;
/** Past the nervous share of its slots, the toilet shakes (until it bursts or the round ends). */
const nervousRound = (round: ToiletRoundView) => (round.status === "waiting" || round.status === "playing") && round.pushes.length >= round.slots * TOILET_RULES.nervousShare;

/** A picture that may not be there yet: until it loads, the emoji stands in. */
function Art({ src, fallback, className }: { src: string; fallback: string; className: string }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [src]);
  return failed ? <span className={`${className} toilet-emoji`} aria-hidden="true">{fallback}</span>
    : <img className={className} src={src} alt="" onError={() => setFailed(true)} />;
}

/** What the toilet is doing on screen right now. */
type Scene = "idle" | "drop" | "flush" | "boom";

export function Toilet({ user, onBack, demo = false, onSummary, onPreviewChange, onScored }: {
  user: User; onBack: () => void; demo?: boolean;
  onSummary?: (summary: ToiletSummary) => void;
  onPreviewChange?: (summary: ToiletSummary, score: number, ledger: LedgerEntry[]) => void;
  /** The toilet burst: refresh the reader's score (signed in only). */
  onScored?: () => void;
}) {
  const admin = user.role === "admin";
  const viewer = useMemo<CatchmindPlayer>(() => ({ id: user.id, username: user.username, displayName: user.displayName, photoVersion: user.photoVersion ?? null, character: user.character ?? "axolotl" }),
    [user.id, user.username, user.displayName, user.photoVersion, user.character]);
  const engine = useMemo(() => (demo ? previewToilet(viewer, admin) : null), [demo, viewer, admin]);
  const [state, setState] = useState<ToiletState | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(Date.now());
  const [scene, setScene] = useState<Scene>("idle");
  const stamp = useRef<string | null>(null);
  const offset = useRef(0);
  const writing = useRef(false);
  const callbacks = useRef({ onSummary, onPreviewChange, onScored });
  callbacks.current = { onSummary, onPreviewChange, onScored };
  const scored = useRef<string | null>(null);
  /** The round as last seen on this screen: sounds play only for changes seen live. */
  const seen = useRef<{ id: string; status: string; nervous: boolean } | null>(null);
  useEffect(() => { preloadSfx(["tl-flush", "tl-nervous", "tl-boom", "coin", "fail"]); }, []);

  const apply = useCallback((next: ToiletPollResponse) => {
    offset.current = Date.parse(next.serverTime) - Date.now();
    setNow(Date.now() + offset.current);
    if ("unchanged" in next) return;
    stamp.current = next.stamp;
    setState(next.toilet);
    const current = next.toilet.current, before = seen.current;
    if (current && before?.id === current.id) {
      if (current.status === "burst" && before.status !== "burst") {
        playSfx("tl-boom");
        const mine = current.results.find(entry => entry.player.id === user.id);
        if (mine) playSfx(mine.points < 0 ? "fail" : "coin", { delay: 1.6 });
      } else if (nervousRound(current) && !before.nervous) playSfx("tl-nervous", { delay: 1 });
    }
    seen.current = current ? { id: current.id, status: current.status, nervous: nervousRound(current) } : null;
    const summary = summaryOf(next.toilet, user.id);
    if (engine) callbacks.current.onPreviewChange?.(summary, engine.score, [...engine.ledger]);
    else {
      callbacks.current.onSummary?.(summary);
      // The round just burst while this screen watched: the weekly score changed.
      const round = next.toilet.current;
      if (round?.status === "burst") { if (scored.current !== null && scored.current !== round.id) callbacks.current.onScored?.(); scored.current = round.id; }
      else if (round) scored.current = "";
    }
  }, [engine, user.id]);
  const refresh = useCallback(async () => {
    if (writing.current) return;
    try { apply(engine ? engine.read(stamp.current ?? undefined) : await api.toilet(stamp.current ?? undefined)); setError(current => (current === LOAD_ERROR ? "" : current)); }
    catch (failure) { if (stamp.current === null) setError(failure instanceof Error ? failure.message : LOAD_ERROR); }
  }, [apply, engine]);
  const live = state?.current?.status === "waiting" || state?.current?.status === "playing";
  useEffect(() => {
    void refresh();
    const tick = () => { if (!document.hidden) void refresh(); };
    const timer = window.setInterval(tick, engine ? 600 : live ? TOILET_RULES.pollIntervalMs : TOILET_RULES.idlePollIntervalMs);
    document.addEventListener("visibilitychange", tick);
    return () => { clearInterval(timer); document.removeEventListener("visibilitychange", tick); };
  }, [refresh, live, engine]);
  // The clock moves the skip countdown and the round's end even between polls.
  useEffect(() => { const timer = window.setInterval(() => setNow(Date.now() + offset.current), 15_000); return () => clearInterval(timer); }, []);

  const act = useCallback(async (action: ToiletAction) => {
    const round = state?.current;
    if (writing.current || !round) return;
    writing.current = true; setBusy(true); setError(""); setScene("drop");
    const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    try {
      // The poop falls while the server decides; the answer is shown once it lands.
      const [next] = await Promise.all([
        engine ? engine.mutate(action, { roundId: round.id, pushes: round.pushes.length }) : api.toiletAction(action, { roundId: round.id, pushes: round.pushes.length }),
        new Promise(resolve => setTimeout(resolve, reduced ? 0 : 900)),
      ]);
      apply(next);
      const burst = next.toilet.current?.id === round.id && next.toilet.current.status === "burst";
      setScene(burst ? "boom" : "flush");
      if (!burst) playSfx("tl-flush");
      if (!burst) window.setTimeout(() => setScene(current => (current === "flush" ? "idle" : current)), reduced ? 600 : 1400);
    } catch (failure) {
      setScene("idle");
      setError(failure instanceof Error ? failure.message : "요청을 처리하지 못했어요.");
      if (failure instanceof ApiFailure && failure.status === 409) { writing.current = false; void refresh(); }
    } finally { writing.current = false; setBusy(false); }
  }, [state, engine, apply, refresh]);

  const round = state?.current ?? null;
  // A new round starts with a calm toilet.
  useEffect(() => { setScene("idle"); }, [round?.id]);
  return <section className="toilet-page">
    <Toolbar title="변기 폭파" onBack={onBack} gold={user.gold} />
    {!state ? <p className="toilet-note card">{error || "변기를 살펴보는 중…"}</p> : <>
      {error && <p className="toilet-error card" role="alert">{error}</p>}
      {round ? <Stage round={round} state={state} me={user.id} admin={admin} busy={busy} now={now} scene={scene} act={act} />
        : <section className="toilet-card card" aria-label="변기 폭파">
          <Art className="toilet-art is-small" src="/toilet/calm.webp" fallback="🚽" />
          <p className="toilet-hint toilet-center">{Date.parse(state.nextOpensAt) - now < 15 * 60_000
            ? "오늘 변기는 문을 닫았어요. 자정에 오전 판이 열려요."
            : `플레이어가 ${TOILET_RULES.minPlayers}명은 있어야 변기가 열려요.`}</p>
        </section>}
      {round && <Seats round={round} me={user.id} />}
      {state.previous && <Previous round={state.previous} me={user.id} />}
      <Rules />
    </>}
  </section>;
}
const LOAD_ERROR = "변기 상황을 불러오지 못했어요.";

/** The toilet, its level, whose turn it is, and the button. */
function Stage({ round, state, me, admin, busy, now, scene, act }: {
  round: ToiletRoundView; state: ToiletState; me: string; admin: boolean; busy: boolean; now: number; scene: Scene; act: (action: ToiletAction) => Promise<void>;
}) {
  const name = useDisplayNameLookup();
  const who = (player: CatchmindPlayer) => (player.id === me ? "나" : honorific(name(player.username, player.displayName)));
  const burst = round.status === "burst", over = burst || round.status === "void";
  const myTurn = state.canPush;
  const nervous = nervousRound(round);
  const mood = burst || scene === "boom" ? "boom" : nervous ? "nervous" : "calm";
  const level = Math.min(1, round.pushes.length / round.slots);
  const skipAt = state.skipAvailableAt ? Date.parse(state.skipAvailableAt) : NaN;
  const seated = round.order.some(player => player.id === me);
  const canSkip = !admin && seated && !!round.turn && round.turn.id !== me && (state.canSkip || now >= skipAt);
  const last = round.pushes[round.pushes.length - 1];
  const lastBy = last ? round.order.find(player => player.id === last.by) : null, lastFor = last ? round.order.find(player => player.id === last.for) : null;
  const mine = round.results.find(entry => entry.player.id === me);
  return <section className={`toilet-card card toilet-stage ${myTurn && !busy ? "is-my-turn" : ""}`} aria-label={`${round.label} 변기`}>
    <div className="toilet-head"><strong>{round.label} 변기</strong>
      <span className="toilet-chip">{over ? (burst ? "펑!" : "무효") : `${clock(round.endsAt)}까지`}</span></div>
    <div className={`toilet-scene is-${mood} scene-${scene}`}>
      {mood === "boom"
        ? <Art key="boom" className="toilet-art is-boom" src="/toilet/boom.webp" fallback="💥" />
        : <Art key={mood} className="toilet-art" src={`/toilet/${mood}.webp`} fallback="🚽" />}
      {scene === "drop" && <Art className="toilet-poop" src="/toilet/poop.webp" fallback="💩" />}
      {scene === "flush" && <span className="toilet-swirl" aria-hidden="true" />}
    </div>
    {!over && <div className="toilet-gauge">
      <div className="toilet-gauge-head"><span>수위 {round.pushes.length}/{round.slots}</span><b>다음에 터질 확률 {percent(round.chance)}</b></div>
      <div className="toilet-gauge-bar" role="progressbar" aria-label="변기 수위" aria-valuemin={0} aria-valuemax={round.slots} aria-valuenow={round.pushes.length}><i style={{ width: `${level * 100}%` }} /></div>
    </div>}
    <p className="toilet-status" role="status" aria-live="polite">{
      burst ? <>{round.loser ? <b>{who(round.loser)}</b> : "누군가"}의 차례에 변기가 터졌어요!{mine ? ` ${mine.points > 0 ? `+${mine.points}` : mine.points}점` : ""}</>
        : round.status === "void" ? "이번 판은 끝까지 안 터져서 무효예요."
          : scene === "drop" ? "끄응…"
            : scene === "flush" ? "휴, 무사히 내려갔어요."
              : myTurn ? <b>내 차례예요! 볼일을 보고 물을 내려 주세요.</b>
                : round.turn ? <><b>{who(round.turn)}</b>의 차례예요.</> : null
    }</p>
    {last && !burst && scene === "idle" && <p className="toilet-last">방금 {lastBy ? who(lastBy) : "누군가"}{lastFor && lastBy && lastFor.id !== lastBy.id ? `이 ${who(lastFor)} 대신` : "이"} 볼일을 보고 무사히 물을 내렸어요.</p>}
    {burst && mine && <Art className="toilet-result-art" src={mine.points < 0 ? "/toilet/result-lose.webp" : "/toilet/result-safe.webp"} fallback={mine.points < 0 ? "🪠" : "🧻"} />}
    {myTurn && <button type="button" className="primary-button toilet-push" disabled={busy} onClick={() => void act("push")}>{busy ? "볼일 보는 중…" : "💩 볼일 보고 물 내리기"}</button>}
    {!myTurn && !over && canSkip && round.turn && <button type="button" className="secondary-button" disabled={busy} onClick={() => void act("skip")}>
      {busy ? "누르는 중…" : `${who(round.turn)} 대신 누르기`}</button>}
    {!myTurn && !over && !canSkip && seated && round.turn && round.turn.id !== me && Number.isFinite(skipAt) && skipAt - now < TOILET_RULES.skipAfterMs - 60_000
      && <small className="toilet-hint toilet-center">{minutesLeft(skipAt, now)}분 뒤부터 대신 누를 수 있어요. 대신 눌러도 터지면 원래 차례인 사람이 져요.</small>}
    {!over && !seated && !admin && <small className="toilet-hint toilet-center">이번 판이 시작된 뒤에 들어와서 다음 판부터 참여해요.</small>}
    {admin && <small className="toilet-hint toilet-center">운영자는 변기 폭파에 참여하지 않아요. 구경만 할 수 있어요.</small>}
  </section>;
}

/** Turn order: whose go it is, how often each has pushed, and what the burst paid. */
function Seats({ round, me }: { round: ToiletRoundView; me: string }) {
  const name = useDisplayNameLookup();
  const counts = new Map<string, number>();
  for (const push of round.pushes) counts.set(push.for, (counts.get(push.for) ?? 0) + 1);
  return <section className="toilet-card card" aria-label="차례">
    <h2>이번 판 순서</h2>
    <ol className="toilet-seats">{round.order.map((player, index) => {
      const result = round.results.find(entry => entry.player.id === player.id);
      return <li key={player.id} className={`${player.id === me ? "is-me" : ""} ${round.turn?.id === player.id ? "is-turn" : ""} ${round.loser?.id === player.id ? "is-loser" : ""}`}>
        <span className="toilet-seat-number">{index + 1}</span>
        <Avatar username={player.username} size={34} nameFormat="plain" />
        <span className="toilet-seat-name"><strong>{name(player.username, player.displayName)}</strong>
          <small>{round.loser?.id === player.id ? "여기서 펑!" : `${counts.get(player.id) ?? 0}번 무사히 내림`}</small></span>
        {result ? <b className={result.points < 0 ? "toilet-lose" : "toilet-gain"}>{result.points > 0 ? `+${result.points}` : result.points}점</b>
          : round.turn?.id === player.id && <b className="toilet-now">차례</b>}
      </li>;
    })}</ol>
  </section>;
}

function Previous({ round, me }: { round: ToiletRoundView; me: string }) {
  const name = useDisplayNameLookup();
  const mine = round.results.find(entry => entry.player.id === me);
  return <section className="toilet-card card" aria-label="지난 판">
    <h2>지난 판 · {round.label}</h2>
    <p className="toilet-hint">{round.status === "burst" && round.loser
      ? `${round.loser.id === me ? "내" : `${honorific(name(round.loser.username, round.loser.displayName))}의`} 차례에 ${round.pushes.length}번째로 터졌어요.${mine ? ` 나는 ${mine.points > 0 ? `+${mine.points}` : mine.points}점.` : ""}`
      : `${round.pushes.length}번 볼일을 봤지만 끝까지 안 터져서 무효가 됐어요.`}</p>
  </section>;
}

function Rules() {
  const slots = TOILET_RULES.slotsPerPlayer;
  return <details className="toilet-rules card"><summary>게임 방법 &amp; 점수</summary><ol>
    <li>오전(0시~12시)과 오후(12시~밤 11시 50분)에 한 판씩 열려요. 활성 플레이어는 모두 자동으로 참여해요.</li>
    <li>정해진 순서대로 한 명씩 볼일을 보고 물을 내려요. 첫 차례는 판마다 한 칸씩 돌아가요(1-2-3 → 2-3-1 → 3-1-2).</li>
    <li>변기는 참가자 수 × {slots}번 안에 반드시 한 번 터져요. 물을 내릴수록 다음에 터질 확률이 올라가요. 누가 걸릴지는 모두 똑같이 운이에요.</li>
    <li>터진 차례의 사람은 {Math.abs(TOILET_RULES.loseScore)}점을 잃고, 나머지는 모두 {TOILET_RULES.winScore}점을 받아요.</li>
    <li>차례가 10분 넘게 멈춰 있으면 다른 참가자가 대신 누를 수 있어요. 대신 누르다 터지면 원래 차례인 사람이 져요.</li>
    <li>판이 끝날 때까지 안 터지면 그 판은 무효예요. 점수는 아무도 받지 않아요.</li>
  </ol></details>;
}
