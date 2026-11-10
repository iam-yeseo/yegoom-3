import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { SANTA_RULES, santaHalf } from "../../shared/balance";
import { santaCourse, type DropResult } from "../../shared/santa-engine";
import type { LedgerEntry, SantaDropInput, SantaDropResponse, SantaRunInput, SantaState, SantaSummary, User } from "../../shared/types";
import { api, ApiFailure } from "../api";
import { Avatar, Toolbar, useDisplayNameLookup } from "../components/UI";
import { anim, reduced } from "../motion";
import { SantaController, type SantaMode } from "../santa/controller";
import { previewSantaEngine } from "../santa/preview";
import { STAGE } from "../santa/render";
import { createSantaSound, type SantaSound } from "../santa/sound";
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
const kstClock = (time: number) => { const date = new Date(time + 9 * 3_600_000); return `${String(date.getUTCHours()).padStart(2, "0")}시 ${String(date.getUTCMinutes()).padStart(2, "0")}분`; };
/** "오전 배달" / "오후 배달" opening time for a slot start. */
const opensAt = (time: number) => (new Date(time + 9 * 3_600_000).getUTCHours() === 12 ? "오후 12시" : "자정");
interface Source {
  load(): Promise<SantaState>;
  start(input: SantaRunInput): Promise<SantaState>;
  drop(input: SantaDropInput): Promise<SantaDropResponse>;
}
/** The drop sent to the server is remembered until it is acknowledged, so a
 * reload or lost response re-sends it instead of letting the house be thrown again. */
const pendingKey = (userId: string) => `yegoom3:santa:pending:${userId}`;
function readPending(userId: string): SantaDropInput | null {
  try { const value = JSON.parse(localStorage.getItem(pendingKey(userId)) ?? "null"); return typeof value?.runId === "string" ? value : null; } catch { return null; }
}
function writePending(userId: string, value: SantaDropInput | null) {
  try { if (value) localStorage.setItem(pendingKey(userId), JSON.stringify(value)); else localStorage.removeItem(pendingKey(userId)); } catch { /* Memory still holds it. */ }
}
/** Answers that mean the drop can never be recorded as sent; anything else is retried. */
const finalRefusal = (error: unknown) => error instanceof ApiFailure && (error.status === 400 || error.status === 403 || error.status === 404 || error.status === 409);
type Mark = boolean | null;

export function Santa({ user, onBack, demo = false, transact, onSummary, onPreviewChange, onRevealed }: {
  user: User; onBack: () => void; demo?: boolean;
  /** Runs a write and refreshes balances afterwards (signed in only). */
  transact?: <T>(action: () => Promise<T>) => Promise<T>;
  onSummary?: (summary: SantaSummary) => void;
  onPreviewChange?: (summary: SantaSummary, gold: number, score: number, ledger: LedgerEntry[]) => void;
  /** A recorded reward is now visible: refresh balances (signed in only). */
  onRevealed?: () => void;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const controller = useRef<SantaController | null>(null);
  const sound = useRef<SantaSound | null>(null);
  const callout = useRef<HTMLDivElement>(null);
  const throwButton = useRef<HTMLButtonElement>(null);
  const [mode, setMode] = useState<SantaMode>("idle");
  const [houseIndex, setHouseIndex] = useState(0);
  const [throwable, setThrowable] = useState(false);
  const [marks, setMarks] = useState<Mark[]>([]);
  const [last, setLast] = useState<{ index: number; result: DropResult } | null>(null);
  const [muted, setMuted] = useState(false);
  const [error, setError] = useState("");
  const [visible, setVisible] = useState(!document.hidden);
  const [state, setState] = useState<SantaState | null>(null);
  const [loadError, setLoadError] = useState("");
  const [starting, setStarting] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [syncError, setSyncError] = useState("");
  const [finishedHere, setFinishedHere] = useState(false);
  const stateRef = useRef(state); stateRef.current = state;
  const pending = useRef<SantaDropInput | null>(null);
  /** A server answer waits until the gift has landed, so the board never spoils the drop. */
  const reveal = useRef<{ response: SantaDropResponse | null; shown: boolean }>({ response: null, shown: true });
  const marksRef = useRef<Mark[]>([]);
  const admin = user.role === "admin";
  const name = useDisplayNameLookup();

  const props = useRef({ transact, onSummary, onPreviewChange, onRevealed });
  props.current = { transact, onSummary, onPreviewChange, onRevealed };
  const notify = useCallback((next: SantaState) => {
    const summary: SantaSummary = { open: next.open, available: next.available, inProgress: next.inProgress, hits: next.hits, drops: next.drops,
      nextSlotAt: next.nextSlotAt, endsAt: next.endsAt, serverNow: next.serverNow, isAdmin: next.isAdmin };
    if (demo) { const engine = previewSantaEngine(user.username, admin); props.current.onPreviewChange?.(summary, engine.gold, engine.score, [...engine.ledger]); }
    else props.current.onSummary?.(summary);
  }, [demo, user.username, admin]);
  const source = useMemo<Source>(() => {
    if (demo) {
      const engine = previewSantaEngine(user.username, admin);
      return { load: () => engine.load(), start: input => engine.start(input), drop: input => engine.drop(input) };
    }
    const write = <T,>(action: () => Promise<T>) => (props.current.transact ?? (next => next()))(action) as Promise<T>;
    return { load: () => api.santa(), start: input => write(() => api.startSantaRun(input)), drop: input => write(() => api.dropSantaGift(input)) };
  }, [demo, user.username, admin]);
  const sourceRef = useRef(source); sourceRef.current = source;

  const setMarksBoth = (next: Mark[]) => { marksRef.current = next; setMarks(next); };
  const apply = useCallback((next: SantaState) => { setState(next); notify(next); }, [notify]);
  const show = useCallback((response: SantaDropResponse) => {
    reveal.current = { response: null, shown: true };
    apply(response);
    if (!demo && (response.drop.hit || response.current?.completed)) props.current.onRevealed?.();
  }, [apply, demo]);
  const send = useCallback(async (input: SantaDropInput) => {
    pending.current = input; writePending(user.id, input);
    setSyncing(true); setSyncError("");
    try {
      const response = await sourceRef.current.drop(input);
      pending.current = null; writePending(user.id, null);
      if (reveal.current.shown) show(response); else reveal.current.response = response;
    } catch (failure) {
      const message = failure instanceof Error ? failure.message : "기록을 보내지 못했어요.";
      if (finalRefusal(failure)) {
        // The run closed or moved on: drop the record, stop flying and show the server's view.
        pending.current = null; writePending(user.id, null);
        reveal.current = { response: null, shown: true };
        controller.current?.stop();
        setSyncError(message);
        void sourceRef.current.load().then(apply).catch(() => {});
      } else setSyncError("기록을 보내지 못했어요. 다시 보내기를 눌러 주세요. 산타가 하늘에서 기다릴게요.");
    } finally { setSyncing(false); }
  }, [user.id, show, apply]);
  const load = useCallback(async () => {
    if (pending.current) return;
    try {
      const next = await sourceRef.current.load();
      apply(next); setLoadError("");
      // A drop sent just before a reload is re-sent before anything else.
      const saved = readPending(user.id);
      if (saved && next.current && saved.runId === next.current.id && saved.index === next.current.drops.length && !next.current.finished) void send(saved);
      else if (saved) writePending(user.id, null);
    } catch (failure) { setLoadError(failure instanceof Error ? failure.message : "배달 기록을 불러오지 못했어요."); }
  }, [apply, send, user.id]);

  const sendRef = useRef(send); sendRef.current = send;
  const showRef = useRef(show); showRef.current = show;
  useEffect(() => {
    const effects = createSantaSound();
    sound.current = effects; setMuted(effects.muted);
    let runtime: SantaController;
    try {
      runtime = new SantaController(canvas.current!, effects, {
        onState: next => { setMode(next.mode); setHouseIndex(next.index); setThrowable(next.throwable); },
        canContinue: () => !pending.current,
        onDrop: (index, release) => {
          const run = stateRef.current?.current;
          if (!run || run.finished) return;
          // An answer still waiting for its gift is shown before the next drop takes the slot.
          const waiting = reveal.current.response;
          if (waiting) showRef.current(waiting);
          reveal.current = { response: null, shown: false };
          void sendRef.current({ runId: run.id, index, release });
        },
        onResult: (index, result) => {
          const next = [...marksRef.current]; next[index] = result.hit;
          setMarksBoth(next);
          setLast({ index, result });
          const waiting = reveal.current.response;
          reveal.current.shown = true;
          if (waiting) showRef.current(waiting);
          if (!reduced()) anim(callout.current, [{ scale: ".7", opacity: 0 }, { scale: "1.06", opacity: 1, offset: .6 }, { scale: "1", opacity: 1 }], { dur: 320, ease: "spring" });
        },
        onFinish: () => {
          setFinishedHere(true);
          effects.finish(marksRef.current.filter(Boolean).length === houses);
        },
      });
    } catch (failure) { setError(failure instanceof Error ? failure.message : "하늘을 표시하지 못했어요."); return; }
    controller.current = runtime;
    const visibility = () => setVisible(!document.hidden);
    document.addEventListener("visibilitychange", visibility);
    return () => { runtime.destroy(); effects.dispose(); controller.current = null; document.removeEventListener("visibilitychange", visibility); };
  }, []);
  // Entry, returning to the page and the next slot are the only reads (no polling).
  useEffect(() => { if (visible) void load(); }, [visible, load]);
  useEffect(() => { if (visible) controller.current?.resume(); else controller.current?.pause(); }, [visible]);
  useEffect(() => {
    if (!state) return;
    const wait = Math.min(state.nextSlotAt, state.current && !state.current.finished ? state.current.deadline : Infinity) - state.serverNow;
    if (!(wait > 0) || wait > 13 * 3_600_000) return;
    const timer = window.setTimeout(() => { if (!document.hidden) void load(); }, wait + 1000);
    return () => clearTimeout(timer);
  }, [state, load]);
  // Space or Enter drops the gift on a keyboard.
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (event.repeat || (event.code !== "Space" && event.key !== "Enter")) return;
      if (controller.current?.current !== "flying") return;
      event.preventDefault();
      controller.current.throwGift(event.timeStamp);
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, []);

  const run = state?.current ?? null;
  const running = mode === "countdown" || mode === "flying" || mode === "waiting";
  // The calm scene previews this run's next house, or a sample house before a run.
  useEffect(() => {
    if (running || mode === "done") return;
    const course = run ? santaCourse(run.slot, houses) : null;
    controller.current?.showIdle(course && !run!.finished ? course[run!.drops.length] ?? null : null);
    if (run) setMarksBoth(Array.from({ length: houses }, (_, i) => run.drops[i]?.hit ?? null));
    else setMarksBoth([]);
  }, [run?.id, run?.drops.length, run?.finished, running, mode]); // eslint-disable-line react-hooks/exhaustive-deps

  async function start() {
    if (starting) return;
    setStarting(true); setLoadError(""); setSyncError(""); setLast(null); setFinishedHere(false);
    try {
      const next = await source.start({ requestId: crypto.randomUUID() });
      apply(next);
      if (next.current && !next.current.finished) fly(next.current.slot, next.current.drops.length);
    } catch (failure) { setLoadError(failure instanceof Error ? failure.message : "출발하지 못했어요."); void load(); }
    finally { setStarting(false); }
  }
  function fly(slot: number, from: number) {
    const current = stateRef.current?.current;
    setMarksBoth(Array.from({ length: houses }, (_, i) => current?.drops[i]?.hit ?? null));
    setLast(null); setFinishedHere(false);
    controller.current?.run(santaCourse(slot, houses), from);
    // The sky and the throw button fit one phone screen: bring both into view.
    requestAnimationFrame(() => throwButton.current?.scrollIntoView?.({ block: "end", behavior: reduced() ? "auto" : "smooth" }));
  }
  function toggleSound() {
    const next = !muted;
    sound.current?.setMuted(next); setMuted(next);
  }
  const copy = last ? dropCopy(last.index, last.result) : null;
  const hitsNow = marks.filter(Boolean).length;
  const lock = !running && mode !== "done" ? !state ? "기록을 불러오는 중…" : "" : "";
  return <section className="santa-page">
    <Toolbar title="산타 선물 배달" onBack={onBack} gold={user.gold} />
    <section className="santa-event card" aria-label="이벤트 안내">
      <strong>🎄 크리스마스 한정</strong>
      <small>12월 25일까지 · 오전·오후 1번씩</small>
    </section>
    <RunPanel state={state} admin={admin} running={running} mode={mode} houseIndex={houseIndex} marks={marks} hitsNow={hitsNow}
      starting={starting} error={loadError} finishedHere={finishedHere}
      onStart={() => void start()} onResume={() => run && fly(run.slot, run.drops.length)} />
    {error && <p className="form-message error santa-error" role="alert">{error}</p>}
    <div className="santa-sky" data-mode={mode} data-notouchfx>
      <canvas ref={canvas} width={STAGE.width} height={STAGE.height} role="img"
        aria-label="밤하늘을 나는 산타 썰매와 아래를 지나가는 집. 굴뚝이 다가올 때 선물 던지기를 누르면 선물이 떨어져요." data-notouchfx />
      {running && <div className="santa-hud" aria-hidden="true"><b>{Math.min(houseIndex + 1, houses)}</b><span>/{houses}집</span></div>}
      {mode === "countdown" && <div className="santa-banner" aria-live="polite"><strong>{houseIndex ? "다시 출발!" : "산타 출발!"}</strong></div>}
      {mode === "waiting" && <div className="santa-banner is-small"><strong>{syncError ? "기록을 기다리는 중" : "기록하는 중…"}</strong></div>}
      <div ref={callout} className={`santa-callout ${last?.result.hit ? "is-hit" : "is-miss"}`} aria-hidden={!copy || mode === "countdown"}>
        {copy && mode !== "countdown" && <strong>{copy.title}</strong>}
      </div>
      {lock && <div className="santa-lock"><span>{lock}</span></div>}
    </div>
    <button ref={throwButton} type="button" className="primary-button santa-throw" disabled={!throwable}
      onPointerDown={event => { if (event.button === 0 && controller.current?.throwGift(event.timeStamp)) event.preventDefault(); }}>
      🎁 선물 던지기
    </button>
    {(syncing || syncError) && <div className="santa-sync" role={syncError ? "alert" : "status"}>
      {syncError ? <><span>{syncError}</span>{pending.current && <button type="button" className="text-button" onClick={() => pending.current && void send(pending.current)}>다시 보내기</button>}</> : <span>기록하는 중…</span>}
    </div>}
    <p className="santa-status" role="status" aria-live="polite">{copy && mode !== "countdown" ? copy.detail : running ? "굴뚝이 다가오면 타이밍을 맞춰 선물을 던져요. 화면을 눌러도 돼요." : "굴뚝 높이가 집마다 달라요. 높을수록 늦게, 낮을수록 일찍!"}</p>
    {state && <TodayBoard state={state} me={user.username} name={name} />}
    <div className="santa-tools">
      <span />
      <button type="button" className="santa-sound" aria-pressed={!muted} onClick={toggleSound}>소리 {muted ? "꺼짐" : "켜짐"}</button>
    </div>
    <details className="santa-guide card"><summary>게임 방법 &amp; 보상</summary><ol>
      <li>[산타 출발!]을 누르면 썰매가 집 {houses}곳 위를 차례로 날아가요.</li>
      <li>굴뚝이 다가올 때 [선물 던지기]를 누르면 선물이 떨어져요. 화면을 눌러도, PC에서는 스페이스 바를 눌러도 돼요.</li>
      <li>선물은 썰매와 같은 속도로 앞으로 가면서 떨어져요. 굴뚝 바로 위가 아니라 조금 앞에서 던져야 해요.</li>
      <li>굴뚝 높이가 집마다 달라요. 높은 굴뚝은 금방 닿으니 늦게, 낮은 굴뚝은 오래 떨어지니 일찍 던져요.</li>
      <li>집마다 선물은 한 번만 던질 수 있어요. 뒤로 갈수록 썰매가 조금씩 빨라져요.</li>
    </ol>
    <p>연습 모드는 없어요. 한국 시간 오전(0~12시)과 오후(12~24시)에 한 번씩 배달할 수 있어요. 굴뚝에 들어간 선물 1개마다 {hitScore}점, {houses}곳 모두 성공하면 보너스 {perfectBonus}점을 받고 랭킹 점수에 들어가요. 성공 수와 상관없이 {houses}곳을 끝까지 배달하면 {clearGold}G를 받아요. 출발하면 그 시간의 기회를 쓴 거예요. 중간에 나가도 다음 집부터 이어서 할 수 있고, 시간이 끝나도 {graceMs / 60_000}분 안에는 마저 배달할 수 있어요. 그 뒤 남은 집은 미배달로 기록되고 완료 골드는 받지 못해요. 밤 11시 50분 이후 성공은 점수에 들어가지 않아요. 이벤트는 12월 25일까지예요.</p></details>
  </section>;
}

function HouseRow({ marks, current }: { marks: Mark[]; current?: number }) {
  return <span className="santa-houses">{Array.from({ length: houses }, (_, i) => {
    const mark = marks[i];
    return <i key={i} className={mark === true ? "is-hit" : mark === false ? "is-miss" : i === current ? "is-now" : ""} />;
  })}</span>;
}

function RunPanel({ state, admin, running, mode, houseIndex, marks, hitsNow, starting, error, finishedHere, onStart, onResume }: {
  state: SantaState | null; admin: boolean; running: boolean; mode: SantaMode; houseIndex: number; marks: Mark[]; hitsNow: number;
  starting: boolean; error: string; finishedHere: boolean; onStart(): void; onResume(): void;
}) {
  const run = state?.current ?? null;
  let body;
  if (!state) body = <p className="santa-note">{error || "배달 기록을 불러오는 중…"}</p>;
  else if (admin) body = <p className="santa-note">운영자는 배달에 참여하지 않아요. 친구들의 오늘 기록만 볼 수 있어요.</p>;
  else if (running || (mode === "done" && !run?.finished)) body = <>
    <div className="santa-head"><strong>{Math.min(houseIndex + 1, houses)}번째 집</strong><small>{hitsNow}곳 배달 성공</small></div>
    <HouseRow marks={marks} current={houseIndex} />
  </>;
  else if (run && run.finished) {
    const perfect = run.hits === houses;
    body = <>
      <div className="santa-head is-done"><strong>{perfect ? "완벽한 배달!" : `${run.hits}곳 배달 성공`}</strong>
        <small>{run.completed ? `${run.points ? `+${run.points}점 · ` : ""}+${run.gold}G 받았어요` : "시간이 끝나 완료하지 못했어요"}</small></div>
      <HouseRow marks={run.drops.map(entry => entry.hit)} />
      {finishedHere && run.completed && <p className="santa-note">{perfect ? `${houses}곳 모두 성공해서 보너스 ${perfectBonus}점까지! 루돌프가 코로 박수를 쳐요.` : run.hits ? "수고했어요, 산타! 굴뚝을 놓친 집은 다음 배달에 챙겨요." : "선물은 마음이 중요한 거래요. 완료 골드는 챙겼어요!"}</p>}
      <div className="santa-next">{state.nextSlotAt >= state.endsAt ? <span>올해 배달은 이게 마지막이었어요. 메리 크리스마스!</span> : <span>다음 배달 {opensAt(state.nextSlotAt)}</span>}</div>
    </>;
  }
  else if (run) body = <>
    <div className="santa-head"><strong>{run.drops.length + 1}번째 집부터</strong><small>{kstClock(run.deadline)}까지 배달할 수 있어요</small></div>
    <HouseRow marks={run.drops.map(entry => entry.hit)} current={run.drops.length} />
    <button type="button" className="primary-button santa-start" onClick={onResume}>이어서 배달하기</button>
  </>;
  else if (state.available) body = <>
    <div className="santa-head"><strong>{santaHalf(state.slot)} 배달</strong><small>굴뚝 1곳 {hitScore}점 · 모두 성공 +{perfectBonus}점 · 완료 {clearGold}G</small></div>
    <button type="button" className="primary-button santa-start" onClick={onStart} disabled={starting}>{starting ? "썰매 준비 중…" : "🛷 산타 출발!"}</button>
    <small className="santa-warn">출발하면 이번 시간의 기회를 써요. 연습 모드는 없어요!</small>
  </>;
  else if (!state.open) body = <p className="santa-note">올해 크리스마스 배달은 끝났어요. 산타는 내년에 다시 출발해요!</p>;
  else body = <p className="santa-note">{state.nextSlotAt >= state.endsAt ? "올해 배달은 모두 끝났어요. 메리 크리스마스!" : `다음 배달은 ${opensAt(state.nextSlotAt)}에 열려요.`}</p>;
  return <section className="santa-run card" aria-label="이번 배달">
    {body}
    {state && error && <p className="form-message error" role="alert">{error}</p>}
  </section>;
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
          <small>{player.runs.map(entry => `${santaHalf(entry.slot)} ${entry.hits}${entry.finished ? "" : "…"}`).join(" · ")}</small></span>
        <b>{player.best}<span>곳</span></b>
      </li>)}</ol>}
  </section>;
}
