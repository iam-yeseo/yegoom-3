import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ARCADE_RULES, type ArcadeGame } from "../../shared/balance";
import type { ArcadeFinishInput, ArcadeFinishResponse, ArcadeSet, ArcadeStartInput, ArcadeState, ArcadeSummary, LedgerEntry, User } from "../../shared/types";
import { api, ApiFailure } from "../api";
import { ResultDialog, type RecordStatus } from "../components/PlayShell";
import { Avatar, Toolbar, useDisplayNameLookup } from "../components/UI";
import { previewArcade } from "./preview";
import { kstHour } from "./summary";
import "./arcade.css";

/** Everything a game says about itself around the shared set rules. */
export interface ArcadeCopy {
  title: string;
  /** Counter for what a set scores: "골", "개". */
  unit: string;
  /** "5구", "스톤 5개". */
  tries: string;
  /** What a set pays, in full: "1골마다 1점 + 10G". */
  pay: string;
  /** What the board and "오늘 내 최고" compare: tries that counted, or the set's points. */
  rank?: "made" | "points";
  /** Unit of that number when it is not `unit`: "점". */
  rankUnit?: string;
  /** Heading of a recorded set; "N골 성공!" when absent. */
  doneTitle?(set: ArcadeSet): string;
  practice: string;
  startLabel: string;
  /** Shown when a set is over with nothing scored. */
  nothing: string;
  resultTitle(made: number, points: number): string;
  resultLine(made: number, points: number): string;
  art?: string;
  guide: ReactNode;
}
export interface ArcadeScreenProps {
  user: User; onBack: () => void; demo?: boolean;
  /** Runs a write and refreshes balances afterwards (signed in only). */
  transact?: <T>(action: () => Promise<T>) => Promise<T>;
  onSummary?: (summary: ArcadeSummary) => void;
  onPreviewChange?: (summary: ArcadeSummary, gold: number, score: number, ledger: LedgerEntry[]) => void;
  /** A recorded set is now visible: refresh balances (signed in only). */
  onRevealed?: () => void;
}
export interface ArcadePlayProps {
  mode: "practice" | "official";
  /** The official set's slot (the penalty keepers come from it). */
  slot: number;
  /** An official set's last try is done: hand every input over. `points` is
   * given by games that score each try by itself. */
  onFinish(inputs: unknown[], made: number, points?: number): void;
  onQuit(): void;
}
interface Source {
  load(): Promise<ArcadeState>;
  start(input: ArcadeStartInput): Promise<ArcadeState>;
  finish(input: ArcadeFinishInput): Promise<ArcadeFinishResponse>;
}
/** A finished set is kept on the device until the server has it, so a reload or
 * lost response re-sends it. Only a whole set is ever kept: leaving mid-set
 * keeps nothing, and that set ends unfinished. */
const pendingKey = (game: ArcadeGame, userId: string) => `yegoom3:${game}:finish:${userId}`;
function readPending(game: ArcadeGame, userId: string): ArcadeFinishInput | null {
  try { const value = JSON.parse(localStorage.getItem(pendingKey(game, userId)) ?? "null"); return typeof value?.setId === "string" && Array.isArray(value.inputs) ? value : null; } catch { return null; }
}
function writePending(game: ArcadeGame, userId: string, value: ArcadeFinishInput | null) {
  try { if (value) localStorage.setItem(pendingKey(game, userId), JSON.stringify(value)); else localStorage.removeItem(pendingKey(game, userId)); } catch { /* Memory still holds it. */ }
}
/** Answers that mean the set can never be recorded as sent; anything else is retried. */
const finalRefusal = (error: unknown) => error instanceof ApiFailure && (error.status === 400 || error.status === 403 || error.status === 404 || error.status === 409);
type Playing = { mode: "practice" } | { mode: "official"; set: ArcadeSet };
interface Result { setId: string; made: number; points: number; gold: number; status: RecordStatus; message: string }

/** The waiting screen of a set game: practice, the official set of this slot,
 * today's board and the rules. `play` draws the full-screen game itself. */
export function ArcadeScreen({ game, copy, play, user, onBack, demo = false, transact, onSummary, onPreviewChange, onRevealed }: ArcadeScreenProps & {
  game: ArcadeGame; copy: ArcadeCopy; play: (props: ArcadePlayProps) => ReactNode;
}) {
  const rules = ARCADE_RULES[game];
  const [official, setOfficial] = useState<ArcadeState | null>(null);
  const [loadError, setLoadError] = useState("");
  const [starting, setStarting] = useState(false);
  /** The set (or practice) being played right now, held only in memory. */
  const [playing, setPlaying] = useState<Playing | null>(null);
  const [result, setResult] = useState<Result | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [syncError, setSyncError] = useState("");
  const [visible, setVisible] = useState(!document.hidden);
  const pending = useRef<ArcadeFinishInput | null>(null);
  const admin = user.role === "admin";
  const name = useDisplayNameLookup();

  const props = useRef({ transact, onSummary, onPreviewChange, onRevealed });
  props.current = { transact, onSummary, onPreviewChange, onRevealed };
  const notify = useCallback((state: ArcadeState) => {
    const summary: ArcadeSummary = { available: state.available, played: state.played, completed: state.completed, made: state.made, nextSlotAt: state.nextSlotAt, serverNow: state.serverNow, isAdmin: state.isAdmin };
    if (demo) { const engine = previewArcade(game, user.username, admin); props.current.onPreviewChange?.(summary, engine.gold, engine.score, [...engine.ledger]); }
    else props.current.onSummary?.(summary);
  }, [demo, game, user.username, admin]);
  const source = useMemo<Source>(() => {
    if (demo) {
      const engine = previewArcade(game, user.username, admin);
      return { load: () => engine.load(), start: input => engine.start(input), finish: input => engine.finish(input) };
    }
    const write = <T,>(action: () => Promise<T>) => (props.current.transact ?? (next => next()))(action) as Promise<T>;
    return { load: () => api.arcade(game), start: input => write(() => api.startArcadeSet(game, input)), finish: input => write(() => api.finishArcadeSet(game, input)) };
  }, [demo, game, user.username, admin]);
  const sourceRef = useRef(source); sourceRef.current = source;
  const apply = useCallback((state: ArcadeState) => { setOfficial(state); notify(state); }, [notify]);

  const send = useCallback(async (input: ArcadeFinishInput) => {
    pending.current = input; writePending(game, user.id, input);
    setSyncing(true); setSyncError("");
    setResult(current => current && current.setId === input.setId ? { ...current, status: "saving" } : current);
    try {
      const response = await sourceRef.current.finish(input);
      pending.current = null; writePending(game, user.id, null);
      apply(response);
      setResult(current => current && current.setId === input.setId ? { ...current, made: response.set.made, points: response.set.points, gold: response.set.gold, status: "saved" } : current);
      if (!demo && response.set.made) props.current.onRevealed?.();
    } catch (failure) {
      const message = failure instanceof Error ? failure.message : "기록을 보내지 못했어요.";
      if (finalRefusal(failure)) {
        pending.current = null; writePending(game, user.id, null);
        setResult(current => current && current.setId === input.setId ? { ...current, status: "refused", message } : current);
        setSyncError(message);
        void sourceRef.current.load().then(apply).catch(() => {});
      } else {
        setResult(current => current && current.setId === input.setId ? { ...current, status: "retry" } : current);
        setSyncError("세트 기록을 보내지 못했어요. 다시 보내기를 눌러 주세요.");
      }
    } finally { setSyncing(false); }
  }, [game, user.id, apply, demo]);
  const load = useCallback(async () => {
    if (pending.current) return;
    try {
      const state = await sourceRef.current.load();
      apply(state); setLoadError("");
      // A set finished just before a reload is sent before anything else.
      const saved = readPending(game, user.id);
      if (saved && state.current && saved.setId === state.current.id && !state.current.completed && !state.current.finished) void send(saved);
      else if (saved) writePending(game, user.id, null);
    } catch (failure) { setLoadError(failure instanceof Error ? failure.message : "공식 도전 기록을 불러오지 못했어요."); }
  }, [apply, send, game, user.id]);

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
      if (set && !set.completed && !set.finished && !set.tries.length) setPlaying({ mode: "official", set });
    } catch (failure) { setLoadError(failure instanceof Error ? failure.message : "세트를 시작하지 못했어요."); void load(); }
    finally { setStarting(false); }
  }
  function finished(setId: string, inputs: unknown[], made: number, points = made * rules.score) {
    setResult({ setId, made, points, gold: made * rules.gold, status: "saving", message: "" });
    void send({ setId, inputs });
  }
  function quit() { setPlaying(null); void load(); }

  const set = official?.current ?? null;
  const unfinished = !!set && !set.completed && !pending.current && playing?.mode !== "official";
  const ranked = (entry: { made: number; points: number }) => (copy.rank === "points" ? entry.points : entry.made);
  const rankUnit = copy.rankUnit ?? copy.unit;
  const myBest = official ? Math.max(0, ...official.today.filter(entry => entry.username === user.username).map(ranked)) : 0;
  const next = official && <div className="arcade-official-next"><span>다음 세트 {kstHour(official.nextSlotAt)}</span></div>;
  let body;
  if (!official) body = <p className="arcade-official-note">{loadError || "공식 도전 기록을 불러오는 중…"}</p>;
  else if (admin) body = <p className="arcade-official-note">운영자는 공식 도전에 참여하지 않아요. 친구들의 오늘 기록만 볼 수 있어요.</p>;
  else if (official.available) body = <>
    <div className="arcade-official-head"><strong>{kstHour(official.slotStart)} 세트</strong><small>{copy.tries} · {copy.pay}</small></div>
    <button type="button" className="primary-button arcade-start" onClick={() => void startSet()} disabled={starting}>{starting ? "준비 중…" : copy.startLabel}</button>
    <small className="arcade-official-warn">시작하면 이번 시간의 기회를 써요. 끝까지 해야 기록돼요!</small>
  </>;
  else if (set && set.completed) body = <>
    <div className="arcade-official-head is-done"><strong>{copy.doneTitle?.(set) ?? `${set.made}${copy.unit} 성공!`}</strong><small>{set.made ? `${set.points ? `+${set.points}점 · ` : ""}+${set.gold}G 받았어요${set.points ? "" : " (밤 11시 50분 이후 기록은 점수에 들어가지 않아요)"}` : copy.nothing}</small></div>
    <span className="arcade-balls">{set.tries.map(entry => <i key={entry.index} className={entry.made ? "is-made" : "is-miss"} />)}</span>
    {next}
  </>;
  else if (set && unfinished) body = <>
    <div className="arcade-official-head"><strong>미완료로 끝났어요</strong></div>
    <p className="arcade-official-note">중간에 나가서 이번 세트는 기록되지 않았어요. 점수와 골드도 없어요.</p>
    {next}
  </>;
  else if (set) body = <p className="arcade-official-note">세트 기록을 보내는 중…</p>;
  else body = <p className="arcade-official-note">다음 세트는 {kstHour(official.nextSlotAt)}에 열려요.</p>;

  const players = official ? [...new Set(official.today.map(entry => entry.username))].map(username => {
    const sets = official.today.filter(entry => entry.username === username);
    return { username, sets, best: Math.max(...sets.map(ranked)) };
  }).sort((a, b) => b.best - a.best || a.username.localeCompare(b.username)) : [];
  return <section className="arcade-page" data-game={game}>
    <Toolbar title={copy.title} onBack={onBack} gold={user.gold} />
    <section className="arcade-mode card" aria-label="연습 모드">
      <div><strong>연습 모드</strong><small>{copy.practice}</small></div>
      <button type="button" className="secondary-button arcade-practice" onClick={() => setPlaying({ mode: "practice" })}>연습하기</button>
    </section>
    <section className="arcade-official card" aria-label="공식 도전">
      {body}
      {official && loadError && <p className="form-message error" role="alert">{loadError}</p>}
      {!admin && official && <small className="arcade-official-best">오늘 내 최고 {myBest}{rankUnit}</small>}
    </section>
    {(syncing || syncError) && <div className="arcade-sync card" role={syncError ? "alert" : "status"}>
      {syncError ? <><span>{syncError}</span>{pending.current && <button type="button" className="text-button" onClick={() => pending.current && void send(pending.current)}>다시 보내기</button>}</> : <span>세트 기록을 보내는 중…</span>}
    </div>}
    {official && <section className="arcade-today card" aria-label="오늘의 기록">
      <h2>오늘의 기록</h2>
      {!players.length ? <p className="arcade-official-note">아직 오늘 기록이 없어요. 첫 기록의 주인공이 되어 보세요!</p>
        : <ol>{players.map(player => <li key={player.username} className={player.username === user.username ? "is-me" : ""}>
          <Avatar username={player.username} size={34} nameFormat="plain" />
          <span className="arcade-today-name"><strong>{name(player.username)}</strong>
            <small>{player.sets.map(entry => `${kstHour(entry.slotStart)} ${ranked(entry)}`).join(" · ")}</small></span>
          <b>{player.best}<span>{rankUnit}</span></b>
        </li>)}</ol>}
    </section>}
    <details className="arcade-guide card"><summary>게임 방법 &amp; 보상</summary>{copy.guide}</details>
    {playing && play({
      mode: playing.mode, slot: playing.mode === "official" ? playing.set.slot : 0,
      onFinish: (inputs, made, points) => { if (playing.mode === "official") finished(playing.set.id, inputs, made, points); }, onQuit: quit,
    })}
    {result && <ResultDialog title={copy.resultTitle(result.made, result.points)} art={copy.art}
      lines={<>
        <strong>{result.made ? `${result.points ? `+${result.points}점 · ` : ""}+${result.gold}G` : copy.nothing}</strong>
        <span>{copy.resultLine(result.made, result.points)}</span>
      </>}
      status={result.status} message={result.message} onRetry={() => pending.current && void send(pending.current)}
      onClose={() => { setResult(null); setPlaying(null); }} />}
  </section>;
}
/** KST hours a game's set opens at, e.g. "01·04·07·…". */
export const arcadeHours = (game: ArcadeGame) => Array.from({ length: 24 * 3_600_000 / ARCADE_RULES[game].slotMs },
  (_, i) => String((i * ARCADE_RULES[game].slotMs + ARCADE_RULES[game].offsetMs) / 3_600_000).padStart(2, "0")).join("·");
