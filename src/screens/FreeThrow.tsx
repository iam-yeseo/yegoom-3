import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FREETHROW_RULES } from "../../shared/balance";
import type { ShotInput, ShotResult } from "../../shared/freethrow-physics";
import type { FreeThrowSetInput, FreeThrowShotInput, FreeThrowShotResponse, FreeThrowState, FreeThrowSummary, LedgerEntry, User } from "../../shared/types";
import { api, ApiFailure } from "../api";
import { Avatar, Toolbar, useDisplayNameLookup } from "../components/UI";
import { previewEngine } from "../freethrow/preview";
import { anim, reduced } from "../motion";
import { FreeThrowController, type ThrowMode } from "../freethrow/controller";
import { STAGE } from "../freethrow/render";
import { createFreeThrowSound, type FreeThrowSound } from "../freethrow/sound";
import "../freethrow/freethrow.css";

const HOURS = Array.from({ length: 24 * 60 * 60 * 1000 / FREETHROW_RULES.setIntervalMs }, (_, i) => String(i * FREETHROW_RULES.setIntervalMs / 3_600_000).padStart(2, "0")).join("·");

/** What the player reads after each shot: what happened, then how to adjust. */
export function shotCopy(result: ShotResult): { title: string; detail: string } {
  const side = (left: boolean) => (left ? "왼쪽" : "오른쪽");
  switch (result.kind) {
    case "swish": return { title: "클린 슛!", detail: "그물만 스쳤어요. 림은 공이 지나간 줄도 몰라요." };
    case "bank": return { title: "뱅크 슛!", detail: "백보드가 한 번 도와줬어요. 계획한 거라고 우기면 계획한 거예요." };
    case "rim-in": return { title: "림 맞고 골!", detail: "림이 잠깐 고민하더니 들여보내 줬어요." };
    case "rim-out":
      if (result.firstRim === "front") return { title: "앞 림에 걸렸어요", detail: "아주 조금 약했어요. 살짝만 더 빠르게 올려 보세요." };
      if (result.firstRim === "back") return { title: "뒷 림 맞고 튕겼어요", detail: "아주 조금 셌어요. 힘을 살짝 빼 보세요." };
      return { title: `림 ${side(result.firstRim === "left")}에 맞았어요`, detail: `방향이 살짝 ${side(result.firstRim === "left")}이었어요. 더 곧게 올려 보세요.` };
    case "board-out": return { title: "백보드 맞고 튕겨 나왔어요", detail: "너무 셌어요. 백보드도 깜짝 놀랐대요. 힘을 빼 보세요." };
    case "short": return { title: "짧았어요", detail: "골대까지 못 갔어요. 더 빠르게 쓸어 올려 보세요." };
    case "long": return { title: "너무 길었어요", detail: "힘을 빼고 조금 천천히 올려 보세요." };
    case "left": case "right": return { title: `${side(result.kind === "left")}으로 빗나갔어요`, detail: `손가락이 ${side(result.kind === "left")}으로 기울었어요. 위로 곧게!` };
  }
}
export const aimLabel = (aim: number) => (aim === 0 ? "가운데" : `${aim < 0 ? "왼쪽" : "오른쪽"} ${Math.abs(aim)}`);

interface Stats { shots: number; made: number; streak: number; best: number; recent: boolean[] }
const emptyStats = (): Stats => ({ shots: 0, made: 0, streak: 0, best: 0, recent: [] });
/** KST clock hour of an epoch time, e.g. "15시". */
export const kstHour = (time: number) => `${String(new Date(time + 9 * 3_600_000).getUTCHours()).padStart(2, "0")}시`;
const kstClock = (time: number) => { const date = new Date(time + 9 * 3_600_000); return `${String(date.getUTCHours()).padStart(2, "0")}시 ${String(date.getUTCMinutes()).padStart(2, "0")}분`; };
type Tab = "practice" | "official";
interface Source {
  load(): Promise<FreeThrowState>;
  start(input: FreeThrowSetInput): Promise<FreeThrowState>;
  shoot(input: FreeThrowShotInput): Promise<FreeThrowShotResponse>;
}
/** The shot sent to the server is remembered until it is acknowledged, so a
 * reload or lost response re-sends it instead of letting the ball be thrown again. */
const pendingKey = (userId: string) => `yegoom3:freethrow:pending:${userId}`;
function readPending(userId: string): FreeThrowShotInput | null {
  try { const value = JSON.parse(localStorage.getItem(pendingKey(userId)) ?? "null"); return typeof value?.setId === "string" ? value : null; } catch { return null; }
}
function writePending(userId: string, value: FreeThrowShotInput | null) {
  try { if (value) localStorage.setItem(pendingKey(userId), JSON.stringify(value)); else localStorage.removeItem(pendingKey(userId)); } catch { /* Memory still holds it. */ }
}
/** Answers that mean the shot can never be recorded as sent; anything else is retried. */
const finalRefusal = (error: unknown) => error instanceof ApiFailure && (error.status === 400 || error.status === 403 || error.status === 404 || error.status === 409);

export function FreeThrow({ user, onBack, demo = false, transact, onSummary, onPreviewChange, onRevealed }: {
  user: User; onBack: () => void; demo?: boolean;
  /** Runs a write and refreshes balances afterwards (signed in only). */
  transact?: <T>(action: () => Promise<T>) => Promise<T>;
  onSummary?: (summary: FreeThrowSummary) => void;
  onPreviewChange?: (summary: FreeThrowSummary, gold: number, score: number, ledger: LedgerEntry[]) => void;
  /** A recorded shot is now visible: refresh balances (signed in only). */
  onRevealed?: () => void;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const controller = useRef<FreeThrowController | null>(null);
  const sound = useRef<FreeThrowSound | null>(null);
  const callout = useRef<HTMLDivElement>(null);
  const [mode, setMode] = useState<ThrowMode>("idle");
  const [tab, setTab] = useState<Tab>("practice");
  const [stats, setStats] = useState(emptyStats);
  const [last, setLast] = useState<{ result: ShotResult; streak: number } | null>(null);
  const [lastInput, setLastInput] = useState<ShotInput | null>(null);
  const [hint, setHint] = useState("");
  const [muted, setMuted] = useState(false);
  const [error, setError] = useState("");
  const [thrown, setThrown] = useState(false);
  const [visible, setVisible] = useState(!document.hidden);
  const [official, setOfficial] = useState<FreeThrowState | null>(null);
  const [officialError, setOfficialError] = useState("");
  const [starting, setStarting] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [syncError, setSyncError] = useState("");
  const streak = useRef(0);
  const officialStreak = useRef(0);
  const tabRef = useRef(tab); tabRef.current = tab;
  const officialRef = useRef(official); officialRef.current = official;
  const pending = useRef<FreeThrowShotInput | null>(null);
  /** A server answer waits until the ball has landed, so the board never spoils the shot. */
  const reveal = useRef<{ response: FreeThrowShotResponse | null; shown: boolean }>({ response: null, shown: true });
  const chose = useRef(false);
  const admin = user.role === "admin";
  const name = useDisplayNameLookup();

  // App passes new callbacks on every render; read the latest through a ref so
  // the canvas controller and the reads below stay stable.
  const props = useRef({ transact, onSummary, onPreviewChange, onRevealed });
  props.current = { transact, onSummary, onPreviewChange, onRevealed };
  const notify = useCallback((state: FreeThrowState) => {
    const summary: FreeThrowSummary = { available: state.available, inProgress: state.inProgress, made: state.made, shots: state.shots, nextSlotAt: state.nextSlotAt, serverNow: state.serverNow, isAdmin: state.isAdmin };
    if (demo) { const engine = previewEngine(user.username, admin); props.current.onPreviewChange?.(summary, engine.gold, engine.score, [...engine.ledger]); }
    else props.current.onSummary?.(summary);
  }, [demo, user.username, admin]);
  const source = useMemo<Source>(() => {
    if (demo) {
      const engine = previewEngine(user.username, admin);
      return { load: () => engine.load(), start: input => engine.start(input), shoot: input => engine.shoot(input) };
    }
    const write = <T,>(action: () => Promise<T>) => (props.current.transact ?? (next => next()))(action) as Promise<T>;
    return { load: () => api.freeThrow(), start: input => write(() => api.startFreeThrowSet(input)), shoot: input => write(() => api.shootFreeThrow(input)) };
  }, [demo, user.username, admin]);
  const sourceRef = useRef(source); sourceRef.current = source;

  const apply = useCallback((state: FreeThrowState) => {
    setOfficial(state); notify(state);
    if (!chose.current) { chose.current = true; if (state.available || state.inProgress) setTab("official"); }
  }, [notify]);
  const show = useCallback((response: FreeThrowShotResponse) => {
    reveal.current = { response: null, shown: true };
    apply(response);
    if (response.shot.made && !demo) props.current.onRevealed?.();
  }, [apply, demo]);
  const send = useCallback(async (input: FreeThrowShotInput) => {
    pending.current = input; writePending(user.id, input);
    setSyncing(true); setSyncError("");
    try {
      const response = await sourceRef.current.shoot(input);
      pending.current = null; writePending(user.id, null);
      if (reveal.current.shown) show(response); else reveal.current.response = response;
    } catch (failure) {
      const message = failure instanceof Error ? failure.message : "기록을 보내지 못했어요.";
      if (finalRefusal(failure)) {
        // The set closed or moved on: drop the shot and show the server's view.
        pending.current = null; writePending(user.id, null);
        reveal.current = { response: null, shown: true };
        setSyncError(message);
        void sourceRef.current.load().then(apply).catch(() => {});
      } else setSyncError("기록을 보내지 못했어요. 다시 보내기를 눌러 주세요.");
    } finally { setSyncing(false); }
  }, [user.id, show, apply]);
  const load = useCallback(async () => {
    if (pending.current) return;
    try {
      const state = await sourceRef.current.load();
      apply(state); setOfficialError("");
      // A shot sent just before a reload is re-sent before anything else.
      const saved = readPending(user.id);
      if (saved && state.current && saved.setId === state.current.id && saved.index === state.current.shots.length && !state.current.finished) void send(saved);
      else if (saved) writePending(user.id, null);
    } catch (failure) { setOfficialError(failure instanceof Error ? failure.message : "공식 도전 기록을 불러오지 못했어요."); }
  }, [apply, send, user.id]);

  const sendRef = useRef(send); sendRef.current = send;
  const showRef = useRef(show); showRef.current = show;
  useEffect(() => {
    const effects = createFreeThrowSound();
    sound.current = effects; setMuted(effects.muted);
    let runtime: FreeThrowController;
    try {
      runtime = new FreeThrowController(canvas.current!, effects, {
        onMode: setMode,
        onThrow: input => {
          setLastInput(input); setHint(""); setThrown(true);
          const set = officialRef.current?.current;
          if (tabRef.current !== "official" || !set || set.finished) return;
          reveal.current = { response: null, shown: false };
          void sendRef.current({ setId: set.id, index: set.shots.length, power: input.power, aim: input.aim });
        },
        onCancel: () => setHint("공을 아래로 당겼다가 위로 빠르게 쓸어 올리며 놓아요."),
        onResult: result => {
          const inOfficial = tabRef.current === "official";
          const counter = inOfficial ? officialStreak : streak;
          counter.current = result.made ? counter.current + 1 : 0;
          const current = counter.current;
          if (!inOfficial) setStats(stats => ({ shots: stats.shots + 1, made: stats.made + Number(result.made), streak: current,
            best: Math.max(stats.best, current), recent: [...stats.recent, result.made].slice(-FREETHROW_RULES.shotsPerSet) }));
          else {
            const waiting = reveal.current.response;
            reveal.current.shown = true;
            if (waiting) showRef.current(waiting);
          }
          setLast({ result, streak: current });
          if (result.made) effects.cheer(current); else if (result.kind !== "rim-out") effects.sad();
          if (!reduced()) anim(callout.current, [{ scale: ".7", opacity: 0 }, { scale: "1.06", opacity: 1, offset: .6 }, { scale: "1", opacity: 1 }], { dur: 320, ease: "spring" });
        },
      });
    } catch (failure) { setError(failure instanceof Error ? failure.message : "코트를 표시하지 못했어요."); return; }
    controller.current = runtime;
    const visibility = () => setVisible(!document.hidden);
    document.addEventListener("visibilitychange", visibility);
    return () => { runtime.destroy(); effects.dispose(); controller.current = null; document.removeEventListener("visibilitychange", visibility); };
  }, []);
  // Entry, returning to the page and the next slot are the only reads (no polling).
  useEffect(() => { if (visible) void load(); }, [visible, load]);
  useEffect(() => {
    if (!official) return;
    const wait = Math.min(official.nextSlotAt, official.current && !official.current.finished ? official.current.deadline : Infinity) - official.serverNow;
    if (!(wait > 0) || wait > 4 * 3_600_000) return;
    const timer = window.setTimeout(() => { if (!document.hidden) void load(); }, wait + 1000);
    return () => clearTimeout(timer);
  }, [official, load]);

  const set = official?.current ?? null;
  const canShootOfficial = !!set && !set.finished && !syncing && !pending.current;
  const throwable = visible && (tab === "practice" || canShootOfficial);
  useEffect(() => { controller.current?.setEnabled(throwable); }, [throwable]);

  async function startSet() {
    if (starting) return;
    setStarting(true); setOfficialError(""); setSyncError("");
    try { officialStreak.current = 0; setLast(null); apply(await source.start({ requestId: crypto.randomUUID() })); }
    catch (failure) { setOfficialError(failure instanceof Error ? failure.message : "세트를 시작하지 못했어요."); void load(); }
    finally { setStarting(false); }
  }
  function choose(next: Tab) {
    if (next === tab || mode !== "idle" || syncing) return;
    chose.current = true; setTab(next); setLast(null); setHint("");
  }
  function toggleSound() {
    const next = !muted;
    sound.current?.setMuted(next); setMuted(next);
  }
  function reset() {
    streak.current = 0; setStats(emptyStats()); setLast(null); setLastInput(null);
  }
  const rate = stats.shots ? Math.round((stats.made / stats.shots) * 100) : 0;
  const copy = last ? shotCopy(last.result) : null;
  const myBest = official ? Math.max(0, ...official.today.filter(entry => entry.username === user.username).map(entry => entry.made)) : 0;
  const lock = tab === "official" && !canShootOfficial && !syncing && mode === "idle"
    ? !official ? "기록을 불러오는 중…" : admin ? "운영자는 연습 모드만 할 수 있어요" : pending.current ? "방금 슛을 기록하면 이어서 던져요"
      : set?.finished ? "이번 세트 끝!" : "세트를 시작하면 던질 수 있어요" : "";
  return <section className="freethrow-page">
    <Toolbar title="자유투 대결" onBack={onBack} gold={user.gold} />
    <div className="freethrow-tabs segmented" role="tablist" aria-label="게임 모드" style={{ "--count": 2, "--index": tab === "practice" ? 0 : 1 } as React.CSSProperties}>
      <button type="button" role="tab" aria-selected={tab === "practice"} onClick={() => choose("practice")} disabled={mode !== "idle" || syncing}>연습</button>
      <button type="button" role="tab" aria-selected={tab === "official"} onClick={() => choose("official")} disabled={mode !== "idle" || syncing}>
        공식 도전{official?.available && <i className="freethrow-dot" aria-label="도전 가능" />}
      </button>
    </div>
    {tab === "practice" ? <>
      <section className="freethrow-mode card" aria-label="연습 모드">
        <div><strong>연습 모드</strong><small>마음껏 던지며 감을 익혀요 · 보상 없음</small></div>
      </section>
      <section className="freethrow-board" aria-label="연습 기록">
        <div><small>성공</small><strong>{stats.made}<span>/{stats.shots}</span></strong></div>
        <div><small>성공률</small><strong>{rate}<span>%</span></strong></div>
        <div><small>연속</small><strong>{stats.streak}</strong></div>
        <div><small>최고 연속</small><strong>{stats.best}</strong></div>
      </section>
    </> : <OfficialPanel official={official} admin={admin} starting={starting} error={officialError} onStart={() => void startSet()} onPractice={() => choose("practice")} myBest={myBest} />}
    {error && <p className="form-message error freethrow-error" role="alert">{error}</p>}
    <div className="freethrow-court" data-mode={mode} data-tab={tab} data-notouchfx>
      <canvas ref={canvas} width={STAGE.width} height={STAGE.height} role="img"
        aria-label="정면에서 본 농구 골대와 손에 든 농구공. 공을 아래로 당겼다가 위로 쓸어 올리며 놓으면 슛이 나가요." data-notouchfx />
      <div ref={callout} className={`freethrow-callout ${last?.result.made ? "is-made" : "is-miss"}`} aria-hidden={!copy}>
        {copy && <><strong>{copy.title}</strong>{last!.streak >= 2 && <em>{last!.streak}연속!</em>}</>}
      </div>
      {!thrown && mode === "idle" && !lock && <div className="freethrow-coach" aria-hidden="true"><i /><span>당겼다가 위로 슉!</span></div>}
      {lock && <div className="freethrow-lock"><span>{lock}</span></div>}
    </div>
    {tab === "official" && (syncing || syncError) && <div className="freethrow-sync" role={syncError ? "alert" : "status"}>
      {syncError ? <><span>{syncError}</span>{pending.current && <button type="button" className="text-button" onClick={() => pending.current && void send(pending.current)}>다시 보내기</button>}</> : <span>기록하는 중…</span>}
    </div>}
    <p className="freethrow-status" role="status" aria-live="polite">{hint || (copy ? copy.detail : "공을 잡고 아래로 살짝 당긴 뒤, 위로 쓸어 올리면서 손을 떼요.")}</p>
    <section className="freethrow-readout card" aria-label="방금 던진 슛">
      <div className="freethrow-meter"><small>세기</small><span className="freethrow-meter-bar"><i style={{ left: `${lastInput?.power ?? 0}%`, opacity: lastInput ? 1 : 0 }} /></span><b>{lastInput ? lastInput.power : "—"}</b></div>
      <div className="freethrow-aim"><small>방향</small><b>{lastInput ? aimLabel(lastInput.aim) : "—"}</b></div>
      {tab === "practice" && <div className="freethrow-recent" aria-label={`최근 ${stats.recent.length}구 중 ${stats.recent.filter(Boolean).length}골`}>
        <small>최근 {FREETHROW_RULES.shotsPerSet}구</small>
        <BallRow results={stats.recent} />
      </div>}
    </section>
    {tab === "official" && official && <TodayBoard official={official} me={user.username} name={name} />}
    <div className="freethrow-tools">
      {tab === "practice" ? <button type="button" className="text-button" onClick={reset} disabled={!stats.shots || mode === "flying"}>기록 지우기</button> : <span />}
      <button type="button" className="freethrow-sound" aria-pressed={!muted} onClick={toggleSound}>소리 {muted ? "꺼짐" : "켜짐"}</button>
    </div>
    <details className="freethrow-guide card"><summary>게임 방법 &amp; 보상</summary><ol>
      <li>공을 누르고 아래로 살짝 당겨 준비해요. 위로 쓸어 올리다가 손을 떼면 슛!</li>
      <li>손을 떼기 직전에 빠를수록 세게 날아가요. 짧으면 더 빠르게, 길면 더 천천히.</li>
      <li>위로 곧게 올리면 가운데로, 기울여 올리면 그쪽으로 빗나가요.</li>
      <li>같은 동작이면 언제나 같은 슛이 나가요. 방금 슛의 세기와 방향을 보고 조절해 보세요.</li>
      <li>PC에서는 마우스로 공을 끌어서 똑같이 던져요.</li>
    </ol>
    <p>연습 모드는 횟수 제한도 보상도 없어요. 공식 도전은 한국 시간 {HOURS}시마다 {FREETHROW_RULES.shotsPerSet}구 한 세트예요. 1골마다 {FREETHROW_RULES.goalScore}점 + {FREETHROW_RULES.goalGold}G를 받고, 랭킹 점수에도 들어가요. 세트를 시작하면 그 시간의 기회를 쓴 거예요. 시간이 끝나도 {FREETHROW_RULES.graceMs / 60_000}분 안에는 마저 던질 수 있고, 그 뒤 남은 공은 실패로 기록돼요. 공식 도전은 밤 11시 50분에 마감하고, 그 뒤에 들어간 골은 골드만 받고 점수에는 들어가지 않아요.</p></details>
  </section>;
}

function BallRow({ results, total = FREETHROW_RULES.shotsPerSet }: { results: boolean[]; total?: number }) {
  return <span className="freethrow-balls">{Array.from({ length: total }, (_, i) => {
    const made = results[i];
    return <i key={i} className={made === undefined ? "" : made ? "is-made" : "is-miss"} />;
  })}</span>;
}

function OfficialPanel({ official, admin, starting, error, onStart, onPractice, myBest }: {
  official: FreeThrowState | null; admin: boolean; starting: boolean; error: string; onStart(): void; onPractice(): void; myBest: number;
}) {
  const set = official?.current ?? null;
  const total = FREETHROW_RULES.shotsPerSet;
  let body;
  if (!official) body = <p className="freethrow-official-note">{error || "공식 도전 기록을 불러오는 중…"}</p>;
  else if (admin) body = <p className="freethrow-official-note">운영자는 공식 도전에 참여하지 않아요. 친구들의 오늘 기록만 볼 수 있어요.</p>;
  else if (set && !set.finished) body = <>
    <div className="freethrow-official-head"><strong>{set.shots.length + 1 > total ? total : set.shots.length + 1}구째 / {total}구</strong><small>{kstClock(set.deadline)}까지 던질 수 있어요</small></div>
    <BallRow results={set.shots.map(shot => shot.made)} />
  </>;
  else if (set && set.finished) body = <>
    <div className="freethrow-official-head is-done"><strong>{set.made}골 성공!</strong><small>{set.made ? `${set.points ? `+${set.points}점 · ` : ""}+${set.gold}G 받았어요${set.points < set.made * FREETHROW_RULES.goalScore ? " (밤 11시 50분 이후 골은 점수에 들어가지 않아요)" : ""}` : "이번엔 골이 없었어요. 다음 세트에서 만회해요!"}</small></div>
    <BallRow results={set.shots.map(shot => shot.made)} />
    <div className="freethrow-official-next"><span>다음 세트 {kstHour(official.nextSlotAt)}</span><button type="button" className="text-button" onClick={onPractice}>연습하러 가기</button></div>
  </>;
  else if (official.available) body = <>
    <div className="freethrow-official-head"><strong>{kstHour(official.slotStart)} 세트</strong><small>{total}구 · 1골마다 {FREETHROW_RULES.goalScore}점 + {FREETHROW_RULES.goalGold}G</small></div>
    <button type="button" className="primary-button freethrow-start" onClick={onStart} disabled={starting}>{starting ? "준비 중…" : `세트 시작하기`}</button>
    <small className="freethrow-official-warn">시작하면 이번 시간의 기회를 써요. 나가도 다시 시작할 수 없어요.</small>
  </>;
  else body = <p className="freethrow-official-note">다음 세트는 {kstHour(official.nextSlotAt)}에 열려요.</p>;
  return <section className="freethrow-official card" aria-label="공식 도전">
    {body}
    {official && error && <p className="form-message error" role="alert">{error}</p>}
    {!admin && official && <small className="freethrow-official-best">오늘 내 최고 {myBest}골</small>}
  </section>;
}

function TodayBoard({ official, me, name }: { official: FreeThrowState; me: string; name: (username: string) => string }) {
  const players = [...new Set(official.today.map(entry => entry.username))].map(username => {
    const sets = official.today.filter(entry => entry.username === username);
    return { username, sets, best: Math.max(...sets.map(entry => entry.made)) };
  }).sort((a, b) => b.best - a.best || a.username.localeCompare(b.username));
  return <section className="freethrow-today card" aria-label="오늘의 기록">
    <h2>오늘의 기록</h2>
    {!players.length ? <p className="freethrow-official-note">아직 오늘 던진 사람이 없어요. 첫 기록의 주인공이 되어 보세요!</p>
      : <ol>{players.map(player => <li key={player.username} className={player.username === me ? "is-me" : ""}>
        <Avatar username={player.username} size={34} nameFormat="plain" />
        <span className="freethrow-today-name"><strong>{name(player.username)}</strong>
          <small>{player.sets.map(entry => `${kstHour(entry.slotStart)} ${entry.made}${entry.finished ? "" : "…"}`).join(" · ")}</small></span>
        <b>{player.best}<span>골</span></b>
      </li>)}</ol>}
  </section>;
}
