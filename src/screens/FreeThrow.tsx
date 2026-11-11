import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FREETHROW_RULES, PLAY_RULES } from "../../shared/balance";
import type { ShotInput, ShotResult } from "../../shared/freethrow-physics";
import type { FreeThrowFinishInput, FreeThrowFinishResponse, FreeThrowSet, FreeThrowSetInput, FreeThrowState, FreeThrowSummary, LedgerEntry, User } from "../../shared/types";
import { api } from "../api";
import { PlayProgress, PlayShell, QuitDialog, ResultDialog, type RecordStatus } from "../components/PlayShell";
import { Avatar, Toolbar, useDisplayNameLookup } from "../components/UI";
import { previewEngine } from "../freethrow/preview";
import { anim, reduced } from "../motion";
import { usePlayClosed } from "../play-window";
import { pendingStore, useRecordedPlay } from "../recorded-play";
import { FreeThrowController, type ThrowMode } from "../freethrow/controller";
import { STAGE } from "../freethrow/render";
import { createFreeThrowSound, type FreeThrowSound } from "../freethrow/sound";
import { SoundIcon } from "./Santa";
import "../freethrow/freethrow.css";

const { shotsPerSet, goalScore, goalGold, graceMs } = FREETHROW_RULES;
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
/** KST clock hour of an epoch time, e.g. "15시". */
export const kstHour = (time: number) => `${String(new Date(time + 9 * 3_600_000).getUTCHours()).padStart(2, "0")}시`;
interface Source {
  load(): Promise<FreeThrowState>;
  start(input: FreeThrowSetInput): Promise<FreeThrowState>;
  finish(input: FreeThrowFinishInput): Promise<FreeThrowFinishResponse>;
}
const pendingSets = pendingStore("freethrow", (value): value is FreeThrowFinishInput =>
  typeof (value as FreeThrowFinishInput | null)?.setId === "string" && Array.isArray((value as FreeThrowFinishInput).shots));
const setIdOf = (input: FreeThrowFinishInput) => input.setId;
type Playing = { mode: "practice" } | { mode: "official"; set: FreeThrowSet };
interface Result { setId: string; made: number; points: number; gold: number; status: RecordStatus; message: string }

export function FreeThrow({ user, onBack, demo = false, transact, onSummary, onPreviewChange, onRevealed }: {
  user: User; onBack: () => void; demo?: boolean;
  /** Runs a write and refreshes balances afterwards (signed in only). */
  transact?: <T>(action: () => Promise<T>) => Promise<T>;
  onSummary?: (summary: FreeThrowSummary) => void;
  onPreviewChange?: (summary: FreeThrowSummary, gold: number, score: number, ledger: LedgerEntry[]) => void;
  /** A recorded set is now visible: refresh balances (signed in only). */
  onRevealed?: () => void;
}) {
  const [official, setOfficial] = useState<FreeThrowState | null>(null);
  const [loadError, setLoadError] = useState("");
  const [starting, setStarting] = useState(false);
  /** The set (or practice) being played right now, held only in memory. */
  const [playing, setPlaying] = useState<Playing | null>(null);
  const [result, setResult] = useState<Result | null>(null);
  const [visible, setVisible] = useState(!document.hidden);
  const admin = user.role === "admin";
  const name = useDisplayNameLookup();

  const props = useRef({ transact, onSummary, onPreviewChange, onRevealed });
  props.current = { transact, onSummary, onPreviewChange, onRevealed };
  const notify = useCallback((state: FreeThrowState) => {
    const summary: FreeThrowSummary = { available: state.available, played: state.played, completed: state.completed, made: state.made, nextSlotAt: state.nextSlotAt, serverNow: state.serverNow, isAdmin: state.isAdmin };
    if (demo) { const engine = previewEngine(user.username, admin); props.current.onPreviewChange?.(summary, engine.gold, engine.score, [...engine.ledger]); }
    else props.current.onSummary?.(summary);
  }, [demo, user.username, admin]);
  const source = useMemo<Source>(() => {
    if (demo) {
      const engine = previewEngine(user.username, admin);
      return { load: () => engine.load(), start: input => engine.start(input), finish: input => engine.finish(input) };
    }
    const write = <T,>(action: () => Promise<T>) => (props.current.transact ?? (next => next()))(action) as Promise<T>;
    return { load: () => api.freeThrow(), start: input => write(() => api.startFreeThrowSet(input)), finish: input => write(() => api.finishFreeThrowSet(input)) };
  }, [demo, user.username, admin]);
  const sourceRef = useRef(source); sourceRef.current = source;
  const apply = useCallback((state: FreeThrowState) => { setOfficial(state); notify(state); }, [notify]);

  const { pending, syncing, syncError, setSyncError, send, load } = useRecordedPlay({
    userId: user.id, store: pendingSets, idOf: setIdOf, source: sourceRef, apply,
    mark: (setId, patch) => setResult(current => current && current.setId === setId ? { ...current, ...patch } : current),
    onSaved: (response, input) => {
      setResult(current => current && current.setId === input.setId ? { ...current, points: response.set.points, gold: response.set.gold, status: "saved" } : current);
      if (!demo && response.set.made) props.current.onRevealed?.();
    },
    retryMessage: "세트 기록을 보내지 못했어요. 다시 보내기를 눌러 주세요.",
    onLoadError: failure => setLoadError(failure === null ? "" : failure instanceof Error ? failure.message : "공식 도전 기록을 불러오지 못했어요."),
  });

  useEffect(() => {
    const visibility = () => setVisible(!document.hidden);
    document.addEventListener("visibilitychange", visibility);
    return () => document.removeEventListener("visibilitychange", visibility);
  }, []);
  // Entry, returning to the page and the next slot are the only reads (no polling).
  useEffect(() => { if (visible && playing?.mode !== "official") void load(); }, [visible, load, playing]);
  useEffect(() => {
    if (!official || playing) return;
    const wait = official.nextSlotAt - official.serverNow;
    if (!(wait > 0) || wait > 4 * 3_600_000) return;
    const timer = window.setTimeout(() => { if (!document.hidden) void load(); }, wait + 1000);
    return () => clearTimeout(timer);
  }, [official, load, playing]);

  async function startSet() {
    if (starting) return;
    setStarting(true); setLoadError(""); setSyncError("");
    try {
      const state = await source.start({ requestId: crypto.randomUUID() });
      apply(state);
      const set = state.current;
      if (set && !set.completed && !set.finished && !set.shots.length) setPlaying({ mode: "official", set });
    } catch (failure) { setLoadError(failure instanceof Error ? failure.message : "세트를 시작하지 못했어요."); void load(); }
    finally { setStarting(false); }
  }
  function finished(setId: string, shots: ShotInput[], made: number) {
    setResult({ setId, made, points: made * goalScore, gold: made * goalGold, status: "saving", message: "" });
    void send({ setId, shots: shots.map(shot => ({ power: shot.power, aim: shot.aim })) });
  }
  function quit() { setPlaying(null); void load(); }

  const set = official?.current ?? null;
  const unfinished = !!set && !set.completed && !pending.current && playing?.mode !== "official";
  const myBest = official ? Math.max(0, ...official.today.filter(entry => entry.username === user.username).map(entry => entry.made)) : 0;
  return <section className="freethrow-page">
    <Toolbar title="자유투 대결" onBack={onBack} gold={user.gold} />
    <section className="freethrow-mode card" aria-label="연습 모드">
      <div><strong>연습 모드</strong><small>마음껏 던지며 감을 익혀요 · 보상 없음</small></div>
      <button type="button" className="secondary-button freethrow-practice" onClick={() => setPlaying({ mode: "practice" })}>연습하기</button>
    </section>
    <OfficialPanel official={official} admin={admin} unfinished={unfinished} starting={starting} error={loadError} onStart={() => void startSet()} myBest={myBest} />
    {(syncing || syncError) && <div className="freethrow-sync card" role={syncError ? "alert" : "status"}>
      {syncError ? <><span>{syncError}</span>{pending.current && <button type="button" className="text-button" onClick={() => pending.current && void send(pending.current)}>다시 보내기</button>}</> : <span>세트 기록을 보내는 중…</span>}
    </div>}
    {official && <TodayBoard official={official} me={user.username} name={name} />}
    <details className="freethrow-guide card"><summary>게임 방법 &amp; 보상</summary><ol>
      <li>공을 누르고 아래로 살짝 당겨 준비해요. 위로 쓸어 올리다가 손을 떼면 슛!</li>
      <li>손을 떼기 직전에 빠를수록 세게 날아가요. 짧으면 더 빠르게, 길면 더 천천히.</li>
      <li>위로 곧게 올리면 가운데로, 기울여 올리면 그쪽으로 빗나가요.</li>
      <li>같은 동작이면 언제나 같은 슛이 나가요. 아래에 나오는 방금 슛의 세기와 방향을 보고 조절해 보세요.</li>
      <li>PC에서는 마우스로 공을 끌어서 똑같이 던져요.</li>
    </ol>
    <p>연습 모드는 횟수 제한도 보상도 없어요. 공식 도전은 한국 시간 {HOURS}시마다 {shotsPerSet}구 한 세트예요. 세트를 시작하면 그 시간의 기회를 쓴 거예요. {shotsPerSet}구를 다 던지면 한 번에 기록되고, 1골마다 {goalScore}점 + {goalGold}G를 받아 랭킹 점수에도 들어가요. <strong>중간에 나가면 그 세트는 미완료로 끝나고</strong> 점수·골드를 받지 못해요. 늦게 시작했다면 시간이 끝난 뒤 {graceMs / 60_000}분 안에 마치면 돼요. 밤 11시 50분 이후 기록은 골드만 받고 점수에는 들어가지 않아요.</p></details>
    {playing && <FreeThrowPlay key={playing.mode === "official" ? playing.set.id : "practice"} mode={playing.mode}
      onFinish={(shots, made) => { if (playing.mode === "official") finished(playing.set.id, shots, made); }} onQuit={quit} />}
    {result && <ResultDialog title={result.made === shotsPerSet ? "퍼펙트!" : `${result.made}골 성공!`} art="/freethrow/tile.webp"
      lines={<>
        <strong>{result.made ? `${result.points ? `+${result.points}점 · ` : ""}+${result.gold}G` : "이번엔 골이 없었어요"}</strong>
        <span>{result.made >= 7 ? "손끝이 살아 있어요. 오늘의 기록판을 확인해 보세요!" : result.made ? "다음 세트에서는 몇 골 더! 연습 모드로 감을 다듬어 보세요." : "내 손가락을 탓하지 말아주세요. 다음 세트에서 만회해요!"}</span>
      </>}
      status={result.status} message={result.message} onRetry={() => pending.current && void send(pending.current)}
      onClose={() => { setResult(null); setPlaying(null); }} />}
  </section>;
}

interface Stats { shots: number; made: number; streak: number; best: number }
/** The full-screen court: progress (or practice stats) on top, the last shot's
 * power and direction below. An official set's balls stay on the device until
 * the tenth lands; then the whole set is handed over. */
function FreeThrowPlay({ mode, onFinish, onQuit }: { mode: "practice" | "official"; onFinish: (shots: ShotInput[], made: number) => void; onQuit: () => void }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const controller = useRef<FreeThrowController | null>(null);
  const sound = useRef<FreeThrowSound | null>(null);
  const callout = useRef<HTMLDivElement>(null);
  const shots = useRef<ShotInput[]>([]);
  const marksRef = useRef<boolean[]>([]);
  const finishRef = useRef(onFinish); finishRef.current = onFinish;
  const official = mode === "official";
  const [throwMode, setThrowMode] = useState<ThrowMode>("idle");
  const [marks, setMarks] = useState<boolean[]>([]);
  const [stats, setStats] = useState<Stats>({ shots: 0, made: 0, streak: 0, best: 0 });
  const [last, setLast] = useState<{ result: ShotResult; streak: number } | null>(null);
  const [lastInput, setLastInput] = useState<ShotInput | null>(null);
  const [hint, setHint] = useState("");
  const [muted, setMuted] = useState(false);
  const [thrown, setThrown] = useState(0);
  const [visible, setVisible] = useState(!document.hidden);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState("");
  const streak = useRef(0);

  useEffect(() => {
    const effects = createFreeThrowSound();
    sound.current = effects; setMuted(effects.muted);
    let runtime: FreeThrowController;
    try {
      runtime = new FreeThrowController(canvas.current!, effects, {
        onMode: setThrowMode,
        onThrow: input => { shots.current.push(input); setLastInput(input); setHint(""); setThrown(shots.current.length); },
        onCancel: () => setHint("공을 아래로 당겼다가 위로 빠르게 쓸어 올리며 놓아요."),
        onResult: result => {
          streak.current = result.made ? streak.current + 1 : 0;
          const current = streak.current;
          marksRef.current = [...marksRef.current, result.made]; setMarks(marksRef.current);
          setStats(value => ({ shots: value.shots + 1, made: value.made + Number(result.made), streak: current, best: Math.max(value.best, current) }));
          setLast({ result, streak: current });
          if (result.made) effects.cheer(current); else if (result.kind !== "rim-out") effects.sad();
          if (!reduced()) anim(callout.current, [{ scale: ".7", opacity: 0 }, { scale: "1.06", opacity: 1, offset: .6 }, { scale: "1", opacity: 1 }], { dur: 320, ease: "spring" });
          if (official && marksRef.current.length === shotsPerSet) finishRef.current(shots.current.slice(0, shotsPerSet), marksRef.current.filter(Boolean).length);
        },
      });
    } catch (failure) { setError(failure instanceof Error ? failure.message : "코트를 표시하지 못했어요."); return; }
    controller.current = runtime;
    const visibility = () => setVisible(!document.hidden);
    document.addEventListener("visibilitychange", visibility);
    return () => { runtime.destroy(); effects.dispose(); controller.current = null; document.removeEventListener("visibilitychange", visibility); };
  }, [official]);
  const done = official && thrown >= shotsPerSet;
  const throwable = visible && !confirming && !done;
  useEffect(() => { controller.current?.setEnabled(throwable); }, [throwable]);

  function askQuit() {
    if (!official || marks.length >= shotsPerSet) { onQuit(); return; }
    setConfirming(true);
  }
  function toggleSound() { const next = !muted; sound.current?.setMuted(next); setMuted(next); }
  const copy = last ? shotCopy(last.result) : null;
  const rate = stats.shots ? Math.round((stats.made / stats.shots) * 100) : 0;
  return <PlayShell label={official ? "자유투 공식 도전" : "자유투 연습"} theme={{ background: "#eee8fc", text: "#3a3340", tone: "light" }} onClose={askQuit}
    top={official ? <PlayProgress marks={marks} total={shotsPerSet} current={done ? null : marks.length} label="던진 공" />
      : <div className="freethrow-practice-stats" aria-label="연습 기록"><strong>연습</strong><span>성공 <b>{stats.made}/{stats.shots}</b></span><span>{rate}%</span><span>연속 <b>{stats.streak}</b></span></div>}
    right={<button type="button" className="play-icon-button" aria-pressed={!muted} aria-label={muted ? "소리 켜기" : "소리 끄기"} onClick={toggleSound}><SoundIcon muted={muted} /></button>}
    stage={{ width: STAGE.width, height: STAGE.height, content: <div className="freethrow-court" data-mode={throwMode}>
      <canvas ref={canvas} width={STAGE.width} height={STAGE.height} role="img"
        aria-label="정면에서 본 농구 골대와 손에 든 농구공. 공을 아래로 당겼다가 위로 쓸어 올리며 놓으면 슛이 나가요." />
      <div ref={callout} className={`freethrow-callout ${last?.result.made ? "is-made" : "is-miss"}`} aria-hidden={!copy}>
        {copy && <><strong>{copy.title}</strong>{last!.streak >= 2 && <em>{last!.streak}연속!</em>}</>}
      </div>
      {!thrown && throwMode === "idle" && <div className="freethrow-coach" aria-hidden="true"><i /><span>당겼다가 위로 슉!</span></div>}
      {done && throwMode === "idle" && <div className="freethrow-lock"><span>세트 끝!</span></div>}
      {error && <p className="freethrow-play-error" role="alert">{error}</p>}
    </div> }}
    bottom={<>
      <p className="freethrow-status" role="status" aria-live="polite">{hint || (copy ? copy.detail : "공을 잡고 아래로 살짝 당긴 뒤, 위로 쓸어 올리면서 손을 떼요.")}</p>
      <div className="freethrow-readout" aria-label="방금 던진 슛">
        <div className="freethrow-meter"><small>세기</small><span className="freethrow-meter-bar"><i style={{ left: `${lastInput?.power ?? 0}%`, opacity: lastInput ? 1 : 0 }} /></span><b>{lastInput ? lastInput.power : "—"}</b></div>
        <div className="freethrow-aim"><small>방향</small><b>{lastInput ? aimLabel(lastInput.aim) : "—"}</b></div>
      </div>
    </>}>
    {confirming && <QuitDialog title="세트를 그만둘까요?" detail="지금 나가면 이번 세트는 미완료로 끝나요. 점수와 골드를 받지 못하고, 이번 시간에는 다시 시작할 수 없어요."
      stay="계속 던지기" onStay={() => setConfirming(false)} onQuit={() => { setConfirming(false); onQuit(); }} />}
  </PlayShell>;
}

function BallRow({ results, total = shotsPerSet }: { results: boolean[]; total?: number }) {
  return <span className="freethrow-balls">{Array.from({ length: total }, (_, i) => {
    const made = results[i];
    return <i key={i} className={made === undefined ? "" : made ? "is-made" : "is-miss"} />;
  })}</span>;
}

function OfficialPanel({ official, admin, unfinished, starting, error, onStart, myBest }: {
  official: FreeThrowState | null; admin: boolean; unfinished: boolean; starting: boolean; error: string; onStart(): void; myBest: number;
}) {
  const set = official?.current ?? null;
  // 23:50~24:00 the Worker refuses an official start (practice stays open).
  const closed = usePlayClosed();
  const next = official && <div className="freethrow-official-next"><span>다음 세트 {kstHour(official.nextSlotAt)}</span></div>;
  let body;
  if (!official) body = <p className="freethrow-official-note">{error || "공식 도전 기록을 불러오는 중…"}</p>;
  else if (admin) body = <p className="freethrow-official-note">운영자는 공식 도전에 참여하지 않아요. 친구들의 오늘 기록만 볼 수 있어요.</p>;
  else if (official.available) body = <>
    <div className="freethrow-official-head"><strong>{kstHour(official.slotStart)} 세트</strong><small>{shotsPerSet}구 · 1골마다 {goalScore}점 + {goalGold}G</small></div>
    <button type="button" className="primary-button freethrow-start" onClick={onStart} disabled={starting || closed}>{starting ? "준비 중…" : "세트 시작하기"}</button>
    <small className="freethrow-official-warn" role={closed ? "status" : undefined}>{closed ? PLAY_RULES.closedMessage : `시작하면 이번 시간의 기회를 써요. ${shotsPerSet}구를 끝까지 던져야 기록돼요!`}</small>
  </>;
  else if (set && set.completed) body = <>
    <div className="freethrow-official-head is-done"><strong>{set.made}골 성공!</strong><small>{set.made ? `${set.points ? `+${set.points}점 · ` : ""}+${set.gold}G 받았어요${set.points < set.made * goalScore ? " (밤 11시 50분 이후 기록은 점수에 들어가지 않아요)" : ""}` : "이번엔 골이 없었어요. 다음 세트에서 만회해요!"}</small></div>
    <BallRow results={set.shots.map(shot => shot.made)} />
    {next}
  </>;
  else if (set && unfinished) body = <>
    <div className="freethrow-official-head"><strong>미완료로 끝났어요</strong></div>
    <p className="freethrow-official-note">중간에 나가서 이번 세트는 기록되지 않았어요. 점수와 골드도 없어요.</p>
    {next}
  </>;
  else if (set) body = <p className="freethrow-official-note">세트 기록을 보내는 중…</p>;
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
          <small>{player.sets.map(entry => `${kstHour(entry.slotStart)} ${entry.made}`).join(" · ")}</small></span>
        <b>{player.best}<span>골</span></b>
      </li>)}</ol>}
  </section>;
}
