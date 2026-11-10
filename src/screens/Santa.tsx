import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { SANTA_RULES, santaHalf } from "../../shared/balance";
import { santaCourse, type DropResult, type SantaHouse } from "../../shared/santa-engine";
import type { LedgerEntry, SantaFinishInput, SantaFinishResponse, SantaRun, SantaRunInput, SantaState, SantaSummary, User } from "../../shared/types";
import { api, ApiFailure } from "../api";
import { PlayProgress, PlayShell, QuitDialog, ResultDialog, type RecordStatus } from "../components/PlayShell";
import { Avatar, Toolbar, useDisplayNameLookup } from "../components/UI";
import { anim, reduced } from "../motion";
import { SantaController, type SantaMode } from "../santa/controller";
import { previewSantaEngine } from "../santa/preview";
import { STAGE } from "../santa/render";
import { createSantaSound, type SantaSound } from "../santa/sound";
import { santaOpensAt } from "../santa/summary";
import "../santa/santa.css";

const { houses, hitScore, perfectBonus, clearGold, graceMs } = SANTA_RULES;
const HIT_LINES = [
  "아이가 깨지 않게 조용히 들어갔어요.",
  "굴뚝 안에서 '퉁' 소리가 났어요. 완벽해요.",
  "루돌프가 코를 두 번 깜빡였어요. 칭찬이래요.",
  "이 집 고양이만 봤어요. 비밀로 해 준대요.",
];
/** What the player reads after each house: what happened, then how to adjust. */
export function dropCopy(index: number, result: DropResult): { title: string; detail: string } {
  switch (result.kind) {
    case "in": return { title: index % 3 === 1 ? "굴뚝에 쏙!" : index % 3 === 2 ? "정확히 배달!" : "배달 성공!", detail: HIT_LINES[index % HIT_LINES.length]! };
    case "rim-early": return { title: "아깝다! 조금 빨랐어요", detail: "굴뚝 테두리에 걸렸어요. 아주 살짝만 늦게 던져 보세요." };
    case "rim-late": return { title: "아깝다! 조금 늦었어요", detail: "굴뚝 테두리에 걸렸어요. 아주 살짝만 일찍 던져 보세요." };
    case "early": return { title: "너무 빨랐어요", detail: "선물이 지붕에 먼저 도착했어요. 굴뚝이 더 다가올 때까지 기다려요." };
    case "late": return { title: "너무 늦었어요", detail: "굴뚝이 이미 지나갔어요. 조금 더 일찍 던져요." };
    case "pass": return { title: "그냥 지나쳤어요", detail: "이 집 아이는 내년을 기약해요…" };
  }
}
interface Source {
  load(): Promise<SantaState>;
  start(input: SantaRunInput): Promise<SantaState>;
  finish(input: SantaFinishInput): Promise<SantaFinishResponse>;
}
/** A finished run is kept on the device until the server has it, so a reload or
 * lost response re-sends it. Only a whole run is ever kept: leaving mid-run
 * keeps nothing, and that run ends unfinished. */
const pendingKey = (userId: string) => `yegoom3:santa:finish:${userId}`;
function readPending(userId: string): SantaFinishInput | null {
  try { const value = JSON.parse(localStorage.getItem(pendingKey(userId)) ?? "null"); return typeof value?.runId === "string" && Array.isArray(value.releases) ? value : null; } catch { return null; }
}
function writePending(userId: string, value: SantaFinishInput | null) {
  try { if (value) localStorage.setItem(pendingKey(userId), JSON.stringify(value)); else localStorage.removeItem(pendingKey(userId)); } catch { /* Memory still holds it. */ }
}
/** Answers that mean the run can never be recorded as sent; anything else is retried. */
const finalRefusal = (error: unknown) => error instanceof ApiFailure && (error.status === 400 || error.status === 403 || error.status === 404 || error.status === 409);
/** Points as the server will count them (hits before 23:50 of the run's day). */
const pointsOf = (hits: number) => hits * hitScore + (hits === houses ? perfectBonus : 0);
interface Result { runId: string; hits: number; points: number; status: RecordStatus; message: string }

export function Santa({ user, onBack, demo = false, transact, onSummary, onPreviewChange, onRevealed }: {
  user: User; onBack: () => void; demo?: boolean;
  /** Runs a write and refreshes balances afterwards (signed in only). */
  transact?: <T>(action: () => Promise<T>) => Promise<T>;
  onSummary?: (summary: SantaSummary) => void;
  onPreviewChange?: (summary: SantaSummary, gold: number, score: number, ledger: LedgerEntry[]) => void;
  /** A recorded reward is now visible: refresh balances (signed in only). */
  onRevealed?: () => void;
}) {
  const [state, setState] = useState<SantaState | null>(null);
  const [loadError, setLoadError] = useState("");
  const [starting, setStarting] = useState(false);
  /** The run being played right now, held only in memory. */
  const [playing, setPlaying] = useState<{ run: SantaRun; course: SantaHouse[] } | null>(null);
  const [result, setResult] = useState<Result | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [syncError, setSyncError] = useState("");
  const [visible, setVisible] = useState(!document.hidden);
  const pending = useRef<SantaFinishInput | null>(null);
  const admin = user.role === "admin";
  const name = useDisplayNameLookup();

  const props = useRef({ transact, onSummary, onPreviewChange, onRevealed });
  props.current = { transact, onSummary, onPreviewChange, onRevealed };
  const notify = useCallback((next: SantaState) => {
    const summary: SantaSummary = { open: next.open, available: next.available, played: next.played, completed: next.completed, hits: next.hits,
      nextSlotAt: next.nextSlotAt, endsAt: next.endsAt, serverNow: next.serverNow, isAdmin: next.isAdmin };
    if (demo) { const engine = previewSantaEngine(user.username, admin); props.current.onPreviewChange?.(summary, engine.gold, engine.score, [...engine.ledger]); }
    else props.current.onSummary?.(summary);
  }, [demo, user.username, admin]);
  const source = useMemo<Source>(() => {
    if (demo) {
      const engine = previewSantaEngine(user.username, admin);
      return { load: () => engine.load(), start: input => engine.start(input), finish: input => engine.finish(input) };
    }
    const write = <T,>(action: () => Promise<T>) => (props.current.transact ?? (next => next()))(action) as Promise<T>;
    return { load: () => api.santa(), start: input => write(() => api.startSantaRun(input)), finish: input => write(() => api.finishSantaRun(input)) };
  }, [demo, user.username, admin]);
  const sourceRef = useRef(source); sourceRef.current = source;
  const apply = useCallback((next: SantaState) => { setState(next); notify(next); }, [notify]);

  const send = useCallback(async (input: SantaFinishInput) => {
    pending.current = input; writePending(user.id, input);
    setSyncing(true); setSyncError("");
    setResult(current => current && current.runId === input.runId ? { ...current, status: "saving" } : current);
    try {
      const response = await sourceRef.current.finish(input);
      pending.current = null; writePending(user.id, null);
      apply(response);
      setResult(current => current && current.runId === input.runId ? { ...current, points: response.run.points, status: "saved" } : current);
      if (!demo) props.current.onRevealed?.();
    } catch (failure) {
      const message = failure instanceof Error ? failure.message : "기록을 보내지 못했어요.";
      if (finalRefusal(failure)) {
        pending.current = null; writePending(user.id, null);
        setResult(current => current && current.runId === input.runId ? { ...current, status: "refused", message } : current);
        setSyncError(message);
        void sourceRef.current.load().then(apply).catch(() => {});
      } else {
        setResult(current => current && current.runId === input.runId ? { ...current, status: "retry" } : current);
        setSyncError("배달 기록을 보내지 못했어요. 다시 보내기를 눌러 주세요.");
      }
    } finally { setSyncing(false); }
  }, [user.id, apply, demo]);
  const load = useCallback(async () => {
    if (pending.current) return;
    try {
      const next = await sourceRef.current.load();
      apply(next); setLoadError("");
      // A run finished just before a reload is sent before anything else.
      const saved = readPending(user.id);
      if (saved && next.current && saved.runId === next.current.id && !next.current.completed && !next.current.finished) void send(saved);
      else if (saved) writePending(user.id, null);
    } catch (failure) { setLoadError(failure instanceof Error ? failure.message : "배달 기록을 불러오지 못했어요."); }
  }, [apply, send, user.id]);

  useEffect(() => {
    const visibility = () => setVisible(!document.hidden);
    document.addEventListener("visibilitychange", visibility);
    return () => document.removeEventListener("visibilitychange", visibility);
  }, []);
  // Entry, returning to the page and the next slot are the only reads (no polling).
  useEffect(() => { if (visible && !playing) void load(); }, [visible, load, playing]);
  useEffect(() => {
    if (!state || playing) return;
    const wait = state.nextSlotAt - state.serverNow;
    if (!(wait > 0) || wait > 13 * 3_600_000) return;
    const timer = window.setTimeout(() => { if (!document.hidden) void load(); }, wait + 1000);
    return () => clearTimeout(timer);
  }, [state, load, playing]);

  async function start() {
    if (starting) return;
    setStarting(true); setLoadError(""); setSyncError("");
    try {
      const next = await source.start({ requestId: crypto.randomUUID() });
      apply(next);
      const run = next.current;
      if (run && !run.completed && !run.finished && !run.drops.length) setPlaying({ run, course: santaCourse(run.slot, houses) });
    } catch (failure) { setLoadError(failure instanceof Error ? failure.message : "출발하지 못했어요."); void load(); }
    finally { setStarting(false); }
  }
  function finished(runId: string, releases: number[], hits: number) {
    setResult({ runId, hits, points: pointsOf(hits), status: "saving", message: "" });
    void send({ runId, releases });
  }
  function quit() { setPlaying(null); void load(); }

  const run = state?.current ?? null;
  const unfinished = !!run && !run.completed && !pending.current && !playing;
  return <section className="santa-page">
    <Toolbar title="산타 선물 배달" onBack={onBack} gold={user.gold} />
    <section className="santa-event card" aria-label="이벤트 안내">
      <strong>🎄 크리스마스 한정</strong>
      <small>12월 25일까지 · 오전·오후 1번씩</small>
    </section>
    <RunPanel state={state} admin={admin} unfinished={unfinished} starting={starting} error={loadError} onStart={() => void start()} />
    {(syncing || syncError) && <div className="santa-sync card" role={syncError ? "alert" : "status"}>
      {syncError ? <><span>{syncError}</span>{pending.current && <button type="button" className="text-button" onClick={() => pending.current && void send(pending.current)}>다시 보내기</button>}</> : <span>배달 기록을 보내는 중…</span>}
    </div>}
    {state && <TodayBoard state={state} me={user.username} name={name} />}
    <details className="santa-guide card"><summary>게임 방법 &amp; 보상</summary><ol>
      <li>[산타 출발!]을 누르면 화면 전체에서 썰매가 집 {houses}곳 위를 차례로 날아가요.</li>
      <li>굴뚝이 다가올 때 아래 [선물 던지기]를 누르면 선물이 떨어져요. 하늘을 눌러도, PC에서는 스페이스 바를 눌러도 돼요.</li>
      <li>선물은 썰매와 같은 속도로 앞으로 가면서 떨어져요. 굴뚝 바로 위가 아니라 조금 앞에서 던져야 해요.</li>
      <li>굴뚝 높이가 집마다 달라요. 높은 굴뚝은 금방 닿으니 늦게, 낮은 굴뚝은 오래 떨어지니 일찍 던져요.</li>
      <li>집마다 선물은 한 번만 던질 수 있어요. 뒤로 갈수록 썰매가 조금씩 빨라져요.</li>
    </ol>
    <p>연습 모드는 없어요. 한국 시간 오전(0~12시)과 오후(12~24시)에 한 번씩 배달할 수 있어요. 출발하면 그 시간의 기회를 쓴 거예요. 10곳을 다 돌면 한 번에 기록돼요. 굴뚝에 들어간 선물 1개마다 {hitScore}점, {houses}곳 모두 성공하면 보너스 {perfectBonus}점을 받고 랭킹 점수에 들어가요. 성공 수와 상관없이 끝까지 배달하면 {clearGold}G를 받아요. <strong>중간에 나가면 그 배달은 미완료로 끝나고</strong> 점수·골드를 받지 못해요. 다른 앱을 잠깐 봤다 오는 건 괜찮아요(그 집부터 다시 출발해요). 늦게 출발했다면 시간이 끝난 뒤 {graceMs / 60_000}분 안에 마치면 돼요. 밤 11시 50분 이후 기록은 점수에 들어가지 않아요. 이벤트는 12월 25일까지예요.</p></details>
    {playing && <SantaPlay key={playing.run.id} course={playing.course}
      onFinish={(releases, hits) => finished(playing.run.id, releases, hits)} onQuit={quit} />}
    {result && <ResultDialog title={result.hits === houses ? "완벽한 배달!" : `${result.hits}곳 배달 성공!`}
      art={result.hits >= houses / 2 ? "/santa/result.webp" : "/santa/oops.webp"}
      lines={<>
        <strong>{result.points ? `+${result.points}점 · ` : ""}+{clearGold}G</strong>
        <span>{result.hits === houses ? `${houses}곳 모두 성공해서 보너스 ${perfectBonus}점까지! 루돌프가 코로 박수를 쳐요.` : result.hits ? "수고했어요, 산타! 굴뚝을 놓친 집은 다음 배달에 챙겨요." : "선물은 마음이 중요한 거래요. 완료 골드는 챙겼어요!"}</span>
      </>}
      status={result.status} message={result.message} onRetry={() => pending.current && void send(pending.current)}
      onClose={() => { setResult(null); setPlaying(null); }} />}
  </section>;
}

/** The full-screen run: the sky, a progress bar on top and the throw button below.
 * Outcomes stay on the device until the last house; then the whole run is handed over. */
function SantaPlay({ course, onFinish, onQuit }: { course: SantaHouse[]; onFinish: (releases: number[], hits: number) => void; onQuit: () => void }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const controller = useRef<SantaController | null>(null);
  const sound = useRef<SantaSound | null>(null);
  const callout = useRef<HTMLDivElement>(null);
  const releases = useRef<number[]>([]);
  const marksRef = useRef<(boolean | null)[]>([]);
  const finishRef = useRef(onFinish); finishRef.current = onFinish;
  const [mode, setMode] = useState<SantaMode>("idle");
  const [index, setIndex] = useState(0);
  const [throwable, setThrowable] = useState(false);
  const [marks, setMarks] = useState<(boolean | null)[]>([]);
  const [last, setLast] = useState<{ index: number; result: DropResult } | null>(null);
  const [muted, setMuted] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState("");
  const confirmingRef = useRef(confirming); confirmingRef.current = confirming;

  useEffect(() => {
    const effects = createSantaSound();
    sound.current = effects; setMuted(effects.muted);
    let runtime: SantaController;
    try {
      runtime = new SantaController(canvas.current!, effects, {
        onState: next => { setMode(next.mode); setIndex(next.index); setThrowable(next.throwable); },
        canContinue: () => true,
        onDrop: (house, release) => { releases.current[house] = release; },
        onResult: (house, result) => {
          const next = [...marksRef.current]; next[house] = result.hit;
          marksRef.current = next; setMarks(next);
          setLast({ index: house, result });
          if (!reduced()) anim(callout.current, [{ scale: ".7", opacity: 0 }, { scale: "1.06", opacity: 1, offset: .6 }, { scale: "1", opacity: 1 }], { dur: 320, ease: "spring" });
        },
        onFinish: () => {
          const hits = marksRef.current.filter(Boolean).length;
          effects.finish(hits === houses);
          finishRef.current(Array.from({ length: houses }, (_, i) => releases.current[i] ?? -1), hits);
        },
      });
    } catch (failure) { setError(failure instanceof Error ? failure.message : "하늘을 표시하지 못했어요."); return; }
    controller.current = runtime;
    runtime.run(course, 0);
    // Another app for a moment: freeze, then start that house over.
    const visibility = () => { if (document.hidden) runtime.pause(); else if (!confirmingRef.current) runtime.resume(); };
    document.addEventListener("visibilitychange", visibility);
    const key = (event: KeyboardEvent) => {
      if (event.repeat || (event.code !== "Space" && event.key !== "Enter") || runtime.current !== "flying") return;
      event.preventDefault();
      runtime.throwGift(event.timeStamp);
    };
    window.addEventListener("keydown", key);
    return () => { runtime.destroy(); effects.dispose(); controller.current = null; document.removeEventListener("visibilitychange", visibility); window.removeEventListener("keydown", key); };
  }, [course]);
  function askQuit() {
    if (controller.current?.current === "done") { onQuit(); return; }
    controller.current?.pause(); setConfirming(true);
  }
  function stay() { setConfirming(false); controller.current?.resume(); }
  function toggleSound() { const next = !muted; sound.current?.setMuted(next); setMuted(next); }
  const copy = last ? dropCopy(last.index, last.result) : null;
  const running = mode === "countdown" || mode === "flying" || mode === "waiting";
  return <PlayShell label="산타 선물 배달" theme={{ background: "linear-gradient(180deg, #1c2150 0%, #3c3772 60%, #6b5c9a 100%)" }} onClose={askQuit}
    top={<PlayProgress marks={marks} total={houses} current={running ? index : null} label="배달한 집" />}
    right={<button type="button" className="play-icon-button" aria-pressed={!muted} aria-label={muted ? "소리 켜기" : "소리 끄기"} onClick={toggleSound}>
      <SoundIcon muted={muted} />
    </button>}
    stage={{ width: STAGE.width, height: STAGE.height, content: <>
      <canvas ref={canvas} width={STAGE.width} height={STAGE.height} role="img" className="santa-canvas"
        aria-label="밤하늘을 나는 산타 썰매와 아래를 지나가는 집. 굴뚝이 다가올 때 선물 던지기를 누르면 선물이 떨어져요." />
      {mode === "countdown" && <div className="santa-banner" aria-live="polite"><strong>{index ? "다시 출발!" : "산타 출발!"}</strong></div>}
      <div ref={callout} className={`santa-callout ${last?.result.hit ? "is-hit" : "is-miss"}`} aria-hidden={!copy || mode === "countdown"}>
        {copy && mode !== "countdown" && <><strong>{copy.title}</strong><small>{copy.detail}</small></>}
      </div>
      {error && <p className="santa-play-error" role="alert">{error}</p>}
    </> }}
    bottom={<button type="button" className="primary-button santa-throw" disabled={!throwable}
      onPointerDown={event => { if (event.button === 0 && controller.current?.throwGift(event.timeStamp)) event.preventDefault(); }}>
      🎁 선물 던지기
    </button>}>
    {confirming && <QuitDialog title="배달을 그만둘까요?" detail="지금 나가면 이번 배달은 미완료로 끝나요. 점수와 골드를 받지 못하고, 이번 시간에는 다시 출발할 수 없어요."
      stay="계속 배달하기" onStay={stay} onQuit={() => { setConfirming(false); onQuit(); }} />}
  </PlayShell>;
}
export function SoundIcon({ muted }: { muted: boolean }) {
  return <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M4 9v6h4l5 4V5L8 9H4Z" fill="currentColor" />
    {muted ? <path d="m17 9 5 6m0-6-5 6" /> : <path d="M16.5 8.5a5 5 0 0 1 0 7M19 6a8.5 8.5 0 0 1 0 12" />}
  </svg>;
}

function RunPanel({ state, admin, unfinished, starting, error, onStart }: {
  state: SantaState | null; admin: boolean; unfinished: boolean; starting: boolean; error: string; onStart(): void;
}) {
  const run = state?.current ?? null;
  let body;
  if (!state) body = <p className="santa-note">{error || "배달 기록을 불러오는 중…"}</p>;
  else if (admin) body = <p className="santa-note">운영자는 배달에 참여하지 않아요. 친구들의 오늘 기록만 볼 수 있어요.</p>;
  else if (state.available) body = <>
    <div className="santa-head"><strong>{santaHalf(state.slot)} 배달</strong><small>굴뚝 1곳 {hitScore}점 · 모두 성공 +{perfectBonus}점 · 완료 {clearGold}G</small></div>
    <img className="santa-hero" src="/santa/tile.webp" alt="" />
    <button type="button" className="primary-button santa-start" onClick={onStart} disabled={starting}>{starting ? "썰매 준비 중…" : "🛷 산타 출발!"}</button>
    <small className="santa-warn">출발하면 이번 시간의 기회를 써요. 끝까지 배달해야 기록돼요!</small>
  </>;
  else if (run && run.completed) {
    const perfect = run.hits === houses;
    body = <>
      <div className="santa-done">
        <img src={run.hits >= houses / 2 ? "/santa/result.webp" : "/santa/oops.webp"} alt="" />
        <div className="santa-head is-done"><strong>{perfect ? "완벽한 배달!" : `${run.hits}곳 배달 성공`}</strong>
          <small>{`${run.points ? `+${run.points}점 · ` : ""}+${run.gold}G 받았어요`}</small></div>
      </div>
      <HouseRow marks={run.drops.map(entry => entry.hit)} />
      <NextRun state={state} />
    </>;
  }
  else if (run && unfinished) body = <>
    <div className="santa-head"><strong>미완료로 끝났어요</strong></div>
    <p className="santa-note">중간에 나가서 이번 배달은 기록되지 않았어요. 점수와 골드도 없어요.</p>
    <NextRun state={state} />
  </>;
  else if (run) body = <p className="santa-note">배달 기록을 보내는 중…</p>;
  else if (!state.open) body = <p className="santa-note">올해 크리스마스 배달은 끝났어요. 산타는 내년에 다시 출발해요!</p>;
  else body = <p className="santa-note">{state.nextSlotAt >= state.endsAt ? "올해 배달은 모두 끝났어요. 메리 크리스마스!" : `다음 배달은 ${santaOpensAt(state.nextSlotAt)}에 열려요.`}</p>;
  return <section className="santa-run card" aria-label="이번 배달">
    {body}
    {state && error && <p className="form-message error" role="alert">{error}</p>}
  </section>;
}
function NextRun({ state }: { state: SantaState }) {
  return <div className="santa-next">{state.nextSlotAt >= state.endsAt ? <span>올해 배달은 이게 마지막이었어요. 메리 크리스마스!</span> : <span>다음 배달 {santaOpensAt(state.nextSlotAt)}</span>}</div>;
}
function HouseRow({ marks }: { marks: (boolean | null)[] }) {
  return <span className="santa-houses">{Array.from({ length: houses }, (_, i) => {
    const mark = marks[i];
    return <i key={i} className={mark === true ? "is-hit" : mark === false ? "is-miss" : ""} />;
  })}</span>;
}

function TodayBoard({ state, me, name }: { state: SantaState; me: string; name: (username: string) => string }) {
  const players = [...new Set(state.today.map(entry => entry.username))].map(username => {
    const runs = state.today.filter(entry => entry.username === username);
    return { username, runs, best: Math.max(...runs.map(entry => entry.hits)) };
  }).sort((a, b) => b.best - a.best || a.username.localeCompare(b.username));
  return <section className="santa-today card" aria-label="오늘의 기록">
    <h2>오늘의 기록</h2>
    {!players.length ? <p className="santa-note">아직 오늘 배달한 사람이 없어요. 첫 배달의 주인공이 되어 보세요!</p>
      : <ol>{players.map(player => <li key={player.username} className={player.username === me ? "is-me" : ""}>
        <Avatar username={player.username} size={34} nameFormat="plain" />
        <span className="santa-today-name"><strong>{name(player.username)}</strong>
          <small>{player.runs.map(entry => `${santaHalf(entry.slot)} ${entry.hits}`).join(" · ")}</small></span>
        <b>{player.best}<span>곳</span></b>
      </li>)}</ol>}
  </section>;
}
