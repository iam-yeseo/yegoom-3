import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { BINGO_RULES } from "../../shared/balance";
import { CELLS, bingoWordsProblem, completedLines, BINGO_LINES, usableBingoWords } from "../../shared/bingo";
import type { BingoAction, BingoCreateInput, BingoGameView, BingoInput, BingoPollResponse, BingoResponse, BingoState, BingoSummary, CatchmindPlayer, LedgerEntry, User } from "../../shared/types";
import { api, ApiFailure } from "../api";
import { previewBingo } from "../bingo-preview";
import { playSfx, preloadSfx } from "../sfx";
import { Avatar, Segmented, Toolbar, honorific, useDisplayNameLookup } from "../components/UI";
import "../bingo.css";

/** What the home row needs, taken from the board the screen already holds. */
function summaryOf(state: BingoState, me: string): BingoSummary {
  const game = state.game, short = (player: CatchmindPlayer | null | undefined) => (player ? { username: player.username, displayName: player.displayName } : null);
  const live = game?.status === "filling" || game?.status === "playing";
  return {
    status: !game || game.status === "cancelled" ? "idle" : game.status, topic: game && game.status !== "cancelled" ? game.topic : null,
    leader: short(live ? game!.leader : state.leader), turn: short(game?.status === "playing" ? game.turn : null),
    winner: short(game?.status === "ended" ? game.seats.find(seat => seat.rank === 1)?.player : null),
    joined: !!game?.seats.some(seat => seat.player.id === me), players: game?.seats.length ?? 0,
  };
}
const minutesLeft = (until: number, now: number) => Math.max(1, Math.ceil((until - now) / 60_000));

export function Bingo({ user, onBack, demo = false, onSummary, onPreviewChange, onScored }: {
  user: User; onBack: () => void; demo?: boolean;
  onSummary?: (summary: BingoSummary) => void;
  onPreviewChange?: (summary: BingoSummary, score: number, ledger: LedgerEntry[]) => void;
  /** A place was settled: refresh the reader's score (signed in only). */
  onScored?: () => void;
}) {
  const admin = user.role === "admin";
  const viewer = useMemo<CatchmindPlayer>(() => ({ id: user.id, username: user.username, displayName: user.displayName, photoVersion: user.photoVersion ?? null, character: user.character ?? "axolotl" }),
    [user.id, user.username, user.displayName, user.photoVersion, user.character]);
  const engine = useMemo(() => (demo ? previewBingo(viewer, admin) : null), [demo, viewer, admin]);
  const [state, setState] = useState<BingoState | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [closed, setClosed] = useState(false);
  const [now, setNow] = useState(Date.now());
  const version = useRef<number | null>(null);
  const offset = useRef(0);
  const writing = useRef(false);
  const callbacks = useRef({ onSummary, onPreviewChange, onScored });
  callbacks.current = { onSummary, onPreviewChange, onScored };
  const myPoints = useRef<number | null>(null);
  /** My seat as last seen on this screen: sounds play only for changes seen live. */
  const seen = useRef<{ game: string; lines: number; rank: number | null } | null>(null);
  useEffect(() => { preloadSfx(["bg-mark", "bg-line", "coin", "jackpot"]); }, []);

  const apply = useCallback((next: BingoPollResponse) => {
    offset.current = Date.parse(next.serverTime) - Date.now();
    setClosed(next.play.closed); setNow(Date.now() + offset.current);
    if ("unchanged" in next) return;
    version.current = next.version;
    setState(next.bingo);
    const game = next.bingo.game, seat = game?.seats.find(seat => seat.player.id === user.id);
    const before = seen.current;
    if (game && seat && before?.game === game.id) {
      // A line of my board filled (my call or another player's), then my place was settled.
      const lined = game.status === "playing" || game.status === "ended" ? Math.min(seat.lines, game.lines) > Math.min(before.lines, game.lines) : false;
      if (lined) playSfx("bg-line", { delay: .2 });
      if (seat.rank && !before.rank) playSfx(seat.rank === 1 ? "jackpot" : "coin", { delay: lined ? .9 : .2 });
    }
    seen.current = game && seat ? { game: game.id, lines: seat.lines, rank: seat.rank ?? null } : null;
    const summary = summaryOf(next.bingo, user.id);
    if (engine) callbacks.current.onPreviewChange?.(summary, engine.score, [...engine.ledger]);
    else {
      callbacks.current.onSummary?.(summary);
      // My place in this game was just settled: the weekly score changed.
      const mine = next.bingo.game?.seats.find(seat => seat.player.id === user.id)?.points ?? 0;
      if (myPoints.current !== null && mine > myPoints.current) callbacks.current.onScored?.();
      myPoints.current = mine;
    }
  }, [engine, user.id]);
  const refresh = useCallback(async () => {
    if (writing.current) return;
    try { apply(engine ? engine.read(version.current ?? undefined) : await api.bingo(version.current ?? undefined)); setError(current => (current === LOAD_ERROR ? "" : current)); }
    catch (failure) { if (version.current === null) setError(failure instanceof Error ? failure.message : LOAD_ERROR); }
  }, [apply, engine]);
  // Entry, then a poll while the screen is visible: faster while a game is on.
  const live = state?.game?.status === "filling" || state?.game?.status === "playing";
  useEffect(() => {
    void refresh();
    const tick = () => { if (!document.hidden) void refresh(); };
    const timer = window.setInterval(tick, engine ? 700 : live ? BINGO_RULES.pollIntervalMs : BINGO_RULES.idlePollIntervalMs);
    document.addEventListener("visibilitychange", tick);
    return () => { clearInterval(timer); document.removeEventListener("visibilitychange", tick); };
  }, [refresh, live, engine]);

  /** Opening a game reports the AI's words as they arrive (signed in); the preview
   * has no AI, so it only acts the wait out. */
  const create = useCallback(async (input: BingoCreateInput, onProgress: (words: number, of: number) => void) => {
    if (!engine) return api.bingoCreate(input, onProgress);
    if (!input.words) for (let words = 0; words <= BINGO_RULES.words; words += 3) { onProgress(words, BINGO_RULES.words); await new Promise(resolve => setTimeout(resolve, words ? 70 : 500)); }
    return engine.mutate("create", input);
  }, [engine]);
  const act = useCallback(async (action: BingoAction, input: BingoInput, onProgress?: (words: number, of: number) => void): Promise<boolean> => {
    if (writing.current) return false;
    writing.current = true; setBusy(true); setError("");
    try {
      apply(action === "create" ? await create(input as BingoCreateInput, onProgress ?? (() => {})) : engine ? await engine.mutate(action, input) : await api.bingoAction(action, input));
      return true;
    }
    catch (failure) {
      setError(failure instanceof Error ? failure.message : "요청을 처리하지 못했어요.");
      // The board moved on under this request: show where it is now.
      if (failure instanceof ApiFailure && failure.status === 409) { writing.current = false; void refresh(); }
      throw failure;
    } finally { writing.current = false; setBusy(false); }
  }, [apply, engine, refresh, create]);
  const attempt = (action: BingoAction, input: BingoInput) => { void act(action, input).catch(() => {}); };

  const game = state?.game ?? null;
  return <section className="bingo-page">
    <Toolbar title="빙고" onBack={onBack} gold={user.gold} />
    {!state ? <p className="bingo-note card">{error || "빙고판을 불러오는 중…"}</p> : <>
      {error && <p className="bingo-error card" role="alert">{error}</p>}
      {game?.status === "filling" && <Filling key={game.id} game={game} state={state} me={user.id} admin={admin} busy={busy} now={now} attempt={attempt} />}
      {game?.status === "playing" && <Playing key={game.id} game={game} state={state} me={user.id} busy={busy} closed={closed} now={now} attempt={attempt} />}
      {!live && <>
        {game?.status === "ended" && <Result game={game} me={user.id} />}
        {game?.status === "cancelled" && <p className="bingo-note card">{game.number}번째 빙고 「{game.topic}」는 리더가 취소했어요.</p>}
        <Lead state={state} me={user.id} admin={admin} busy={busy} now={now} act={act} attempt={attempt} />
      </>}
      <Rules />
    </>}
  </section>;
}
const LOAD_ERROR = "빙고판을 불러오지 못했어요.";

function Rules() {
  const [first, second, third] = BINGO_RULES.rankScores;
  return <details className="bingo-rules card"><summary>게임 방법 &amp; 점수</summary><ol>
    <li>리더가 주제와 승리 줄 수(3줄 또는 5줄)를 정하면 AI가 주제에 맞는 단어 {BINGO_RULES.words}개를 만들어요. 리더는 판마다 돌아가며 맡아요.</li>
    <li>모두 그 단어 중 {CELLS}개를 골라 5×5 빙고판을 채워요. 내 판은 끝날 때까지 나만 볼 수 있어요.</li>
    <li>차례가 오면 내 판에서 단어 하나를 고르고 <b>확정</b>을 눌러요. 그 단어는 같은 단어가 있는 모든 사람의 판에서 지워져요.</li>
    <li>가로·세로·대각선 한 줄이 모두 지워지면 1줄이에요. 정해진 줄 수를 먼저 채운 순서대로 등수가 정해져요. 한 단어로 여럿이 동시에 채우면 그 단어를 지운 사람이 먼저예요.</li>
    <li>1등 {first}점, 2등 {second}점, 3등 {third}점을 등수가 정해지는 순간 바로 받아요. 판을 낸 사람만 받을 수 있어요.</li>
    <li>차례가 10분 넘게 멈춰 있으면 다른 참가자가 차례를 넘길 수 있어요. 밤 11시 50분부터 자정까지는 단어를 지울 수 없어요.</li>
  </ol></details>;
}

/** Between games: the leader names a topic, or everyone waits for them. */
function Lead({ state, me, admin, busy, now, act, attempt }: {
  state: BingoState; me: string; admin: boolean; busy: boolean; now: number;
  act: (action: BingoAction, input: BingoInput, onProgress?: (words: number, of: number) => void) => Promise<boolean>; attempt: (action: BingoAction, input: BingoInput) => void;
}) {
  const name = useDisplayNameLookup();
  /** The AI's progress while a game is being opened: words received so far. */
  const [making, setMaking] = useState<{ words: number; of: number; since: number } | null>(null);
  const [topic, setTopic] = useState("");
  const [lines, setLines] = useState<number>(BINGO_RULES.lineChoices[0]);
  const [manual, setManual] = useState(false);
  const [text, setText] = useState("");
  const requestId = useRef(crypto.randomUUID());
  const typed = useMemo(() => usableBingoWords(text.split(/[\n,，、]/)), [text]);
  const skipAt = state.skipAvailableAt ? Date.parse(state.skipAvailableAt) : NaN;
  if (admin) return <p className="bingo-note card">운영자는 빙고에 참여하지 않아요. 진행 중인 판만 볼 수 있어요.</p>;
  if (!state.canCreate) {
    const leader = state.leader;
    return <section className="bingo-card card" aria-label="다음 빙고">
      <h2>다음 빙고를 기다리는 중</h2>
      {leader && <div className="bingo-who"><Avatar username={leader.username} size={38} nameFormat="plain" />
        <p><b>{honorific(name(leader.username, leader.displayName))}</b>이 이번 리더예요. 주제를 정하면 판이 열려요.</p></div>}
      {leader && leader.id !== me && (state.canSkip || now >= skipAt
        ? <button type="button" className="secondary-button" disabled={busy} onClick={() => attempt("skip", { gameId: null, expectedTurnId: leader.id })}>리더 차례 넘기기</button>
        : Number.isFinite(skipAt) && <small className="bingo-hint">{minutesLeft(skipAt, now)}분 뒤부터 리더 차례를 넘길 수 있어요.</small>)}
    </section>;
  }
  const topicReady = topic.trim().length > 0;
  async function open(words?: string[]) {
    if (!words) setMaking({ words: 0, of: BINGO_RULES.words, since: Date.now() });
    try {
      const report = (count: number, of: number) => setMaking(current => (current ? { ...current, words: Math.max(current.words, count), of } : current));
      if (await act("create", { requestId: requestId.current, topic, lines, ...(words ? { words } : {}) }, report)) requestId.current = crypto.randomUUID();
    }
    catch (failure) {
      // No AI today (no key, over budget, or it could not answer): the leader writes the words.
      if (failure instanceof ApiFailure && failure.status === 503) setManual(true);
      requestId.current = crypto.randomUUID();
    } finally { setMaking(null); }
  }
  return <section className="bingo-card card" aria-label="새 빙고 열기">
    <h2>{state.leader ? "내가 이번 리더예요" : "첫 빙고를 열어 보세요"}</h2>
    <p className="bingo-hint">주제를 정하면 AI가 단어 {BINGO_RULES.words}개를 만들고, 모두가 그중 {CELLS}개로 판을 채워요.</p>
    <label className="bingo-field"><span>주제</span>
      <input type="text" value={topic} maxLength={BINGO_RULES.maxTopicLength} placeholder="예: 분식집 메뉴, 놀이공원, 겨울 하면 생각나는 것" disabled={!!making} onChange={event => setTopic(event.target.value)} /></label>
    <div className="bingo-field"><span>몇 줄을 먼저 채우면 이길까요?</span>
      <Segmented label="승리 줄 수" value={lines} options={BINGO_RULES.lineChoices.map(choice => ({ value: choice, label: `${choice}줄` }))} onChange={setLines} /></div>
    {manual && <label className="bingo-field"><span>단어 직접 적기 ({typed.length}/{BINGO_RULES.words})</span>
      <textarea value={text} rows={6} placeholder={`줄을 바꾸거나 쉼표로 나눠서 ${BINGO_RULES.words}개를 적어 주세요. 단어는 ${BINGO_RULES.maxWordLength}글자까지예요.`} onChange={event => setText(event.target.value)} />
      {typed.length > 0 && bingoWordsProblem(typed) && <small className="bingo-hint">{bingoWordsProblem(typed)}</small>}</label>}
    {manual
      ? <button type="button" className="primary-button" disabled={busy || !topicReady || !!bingoWordsProblem(typed)} onClick={() => void open(typed)}>{busy ? "여는 중…" : "이 단어로 빙고 열기"}</button>
      : making ? <MakingProgress making={making} />
        : <button type="button" className="primary-button" disabled={busy || !topicReady} onClick={() => void open()}>{`AI로 단어 ${BINGO_RULES.words}개 만들기`}</button>}
    <button type="button" className="text-button" disabled={busy} onClick={() => setManual(value => !value)}>{manual ? "AI에게 맡기기" : "단어를 직접 적을래요"}</button>
  </section>;
}

/** How far the AI is with the word list. Before the first word arrives the
 * model is still thinking: that part of the bar creeps forward with time (it
 * is an estimate); from then on the bar follows the words actually received. */
const THINKING_SHARE = 0.2, THINKING_PACE_MS = 6000;
function MakingProgress({ making }: { making: { words: number; of: number; since: number } }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const timer = window.setInterval(() => setNow(Date.now()), 200); return () => clearInterval(timer); }, []);
  const thinking = THINKING_SHARE * (1 - Math.exp(-(now - making.since) / THINKING_PACE_MS));
  const share = making.words ? THINKING_SHARE + (1 - THINKING_SHARE) * making.words / making.of : thinking;
  const percent = Math.min(99, Math.round(share * 100)), left = making.of - making.words;
  return <div className="bingo-making" role="status" aria-live="polite">
    <div className="bingo-making-head">
      <strong>{making.words ? `단어 ${making.words}/${making.of}개` : "AI가 주제에 맞는 단어를 떠올리는 중…"}</strong>
      <span>{making.words ? (left > 0 ? `${left}개 남았어요` : "판을 여는 중…") : `${percent}%`}</span>
    </div>
    <div className="bingo-making-bar" role="progressbar" aria-label="단어 만들기 진행" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}><i style={{ width: `${percent}%` }} /></div>
    <small className="bingo-hint">보통 10초 안팎이면 끝나요. 화면을 닫지 말고 기다려 주세요.</small>
  </div>;
}

function Seats({ game, me, turn }: { game: BingoGameView; me: string; turn?: string | null }) {
  const name = useDisplayNameLookup();
  return <ol className="bingo-seats">{game.seats.map(seat => <li key={seat.player.id} className={`${seat.player.id === me ? "is-me" : ""} ${seat.player.id === turn ? "is-turn" : ""}`}>
    <Avatar username={seat.player.username} size={34} nameFormat="plain" />
    <span className="bingo-seat-name"><strong>{name(seat.player.username, seat.player.displayName)}</strong>
      <small>{game.status === "filling" ? "판 제출 완료" : `${seat.lines}줄 · ${seat.marked}칸 지움`}</small></span>
    {seat.rank ? <b className="bingo-rank">{seat.rank}등{seat.points ? <span>+{seat.points}점</span> : null}</b>
      : game.status === "playing" && <b className="bingo-progress">{Math.min(seat.lines, game.lines)}<span>/{game.lines}줄</span></b>}
  </li>)}</ol>;
}

/** A 5x5 board. `called` words are crossed off; cells on a finished line are tinted. */
function Board({ cells, called, selected, onPick, small = false }: {
  cells: (string | null)[]; called?: ReadonlySet<string>; selected?: number | string | null; onPick?: (index: number) => void; small?: boolean;
}) {
  const full = cells.every(cell => cell !== null) && called ? completedLines(cells as string[], called) : [];
  const lined = new Set(full.flatMap(line => BINGO_LINES[line]!));
  return <div className={`bingo-board ${small ? "is-small" : ""}`} role="grid" aria-label="빙고판">
    {cells.map((cell, index) => {
      const crossed = !!cell && !!called?.has(cell), picked = selected === index || (cell !== null && selected === cell);
      const state = `${crossed ? "is-called" : ""} ${lined.has(index) ? "is-line" : ""} ${picked ? "is-picked" : ""} ${cell ? "" : "is-empty"}`;
      return onPick
        ? <button type="button" key={index} role="gridcell" className={`bingo-cell ${state}`} aria-pressed={picked} disabled={crossed} onClick={() => onPick(index)}>{cell ?? ""}</button>
        : <span key={index} role="gridcell" className={`bingo-cell ${state}`}>{cell ?? ""}</span>;
    })}
  </div>;
}

/** Everyone picks 25 of the 30 words and places them. */
function Filling({ game, state, me, admin, busy, now, attempt }: {
  game: BingoGameView; state: BingoState; me: string; admin: boolean; busy: boolean; now: number; attempt: (action: BingoAction, input: BingoInput) => void;
}) {
  const name = useDisplayNameLookup();
  const saved = game.seats.find(seat => seat.player.id === me)?.cells ?? null;
  const [cells, setCells] = useState<(string | null)[]>(() => saved ?? Array.from({ length: CELLS }, () => null));
  const used = new Set(cells.filter((cell): cell is string => cell !== null));
  const filled = used.size === CELLS;
  const dirty = !saved || saved.some((cell, index) => cell !== cells[index]);
  const place = (word: string) => setCells(current => {
    const at = current.indexOf(null);
    return at < 0 || current.includes(word) ? current : current.map((cell, index) => (index === at ? word : cell));
  });
  const clear = (index: number) => setCells(current => current.map((cell, at) => (at === index ? null : cell)));
  function shuffle() {
    const pool = [...game.words];
    for (let i = pool.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [pool[i], pool[j]] = [pool[j]!, pool[i]!]; }
    setCells(pool.slice(0, CELLS));
  }
  const startAt = state.startAvailableAt ? Date.parse(state.startAvailableAt) : NaN;
  const canStart = state.canStart || (!!saved && game.seats.length >= BINGO_RULES.minPlayers && now >= startAt);
  return <>
    <section className="bingo-card card" aria-label="이번 빙고">
      <div className="bingo-head"><strong>「{game.topic}」</strong><span className="bingo-chip">{game.lines}줄 빙고</span></div>
      <p className="bingo-hint">리더 {honorific(name(game.leader.username, game.leader.displayName))} · {game.source === "ai" ? "AI가 만든" : "리더가 적은"} 단어 {game.words.length}개 중 {CELLS}개를 골라 판을 채워 주세요. 모두 판을 내면 바로 시작해요.</p>
      {game.seats.length ? <Seats game={game} me={me} /> : <p className="bingo-hint">아직 판을 낸 사람이 없어요.</p>}
      {canStart ? <button type="button" className="secondary-button" disabled={busy} onClick={() => attempt("start", { gameId: game.id })}>지금 판 낸 사람끼리 시작하기</button>
        : saved && game.seats.length >= BINGO_RULES.minPlayers && Number.isFinite(startAt) && game.leader.id !== me && <small className="bingo-hint">{minutesLeft(startAt, now)}분 뒤부터 기다리지 않고 시작할 수 있어요.</small>}
      {state.canCancel && <button type="button" className="text-button" disabled={busy} onClick={() => attempt("cancel", { gameId: game.id })}>이번 판 취소하기</button>}
    </section>
    {!admin && <section className="bingo-card card" aria-label="내 빙고판 채우기">
      <div className="bingo-head"><strong>내 빙고판</strong><span className="bingo-count">{used.size}/{CELLS}</span></div>
      <Board cells={cells} onPick={clear} />
      <p className="bingo-hint">아래 단어를 누르면 빈칸에 차례로 들어가요. 판에 넣은 단어를 누르면 빠져요.</p>
      <div className="bingo-pool" aria-label="단어 목록">{game.words.map(word =>
        <button type="button" key={word} className="bingo-word" disabled={used.has(word) || filled} aria-pressed={used.has(word)} onClick={() => place(word)}>{word}</button>)}</div>
      <div className="bingo-actions">
        <button type="button" className="secondary-button" onClick={shuffle}>자동으로 채우기</button>
        <button type="button" className="secondary-button" disabled={!used.size} onClick={() => setCells(Array.from({ length: CELLS }, () => null))}>비우기</button>
      </div>
      <button type="button" className="primary-button" disabled={busy || !filled || !dirty} onClick={() => attempt("board", { gameId: game.id, cells: cells as string[] })}>
        {busy ? "내는 중…" : saved ? (dirty ? "고친 판 다시 내기" : "판을 냈어요 · 시작을 기다리는 중") : "이 판으로 내기"}</button>
    </section>}
  </>;
}

/** Turns: the turn player picks a word on their own board and confirms it. */
function Playing({ game, state, me, busy, closed, now, attempt }: {
  game: BingoGameView; state: BingoState; me: string; busy: boolean; closed: boolean; now: number; attempt: (action: BingoAction, input: BingoInput) => void;
}) {
  const name = useDisplayNameLookup();
  const called = useMemo(() => new Set(game.calls.map(call => call.word)), [game.calls]);
  const mine = game.seats.find(seat => seat.player.id === me) ?? null;
  const [picked, setPicked] = useState<string | null>(null);
  const myTurn = state.canCall && !mine?.rank;
  // A pick is only for this turn: it is dropped when the turn or the board changes.
  useEffect(() => { setPicked(null); }, [game.calls.length, game.turn?.id]);
  const last = game.calls[game.calls.length - 1];
  const caller = last ? game.seats.find(seat => seat.player.id === last.by)?.player : null;
  const turn = game.turn;
  const skipAt = state.skipAvailableAt ? Date.parse(state.skipAvailableAt) : NaN;
  const canSkip = !!mine && !!turn && turn.id !== me && (state.canSkip || now >= skipAt);
  return <>
    <section className={`bingo-card card ${myTurn ? "is-my-turn" : ""}`} aria-label="진행 상황">
      <div className="bingo-head"><strong>「{game.topic}」</strong><span className="bingo-chip">{game.lines}줄 빙고</span></div>
      {turn && <div className="bingo-who"><Avatar username={turn.username} size={38} nameFormat="plain" />
        <p role="status" aria-live="polite">{myTurn ? <b>내 차례예요! 지울 단어를 고르고 확정을 눌러 주세요.</b> : <><b>{honorific(name(turn.username, turn.displayName))}</b>이 지울 단어를 고르는 중이에요.</>}</p></div>}
      {last && <p className="bingo-last">방금 {caller ? honorific(name(caller.username, caller.displayName)) : "누군가"}이 <b>「{last.word}」</b>를 지웠어요.</p>}
      {closed && <p className="bingo-hint">밤 11시 50분부터 자정까지는 단어를 지울 수 없어요. 자정에 이어서 해요.</p>}
      {canSkip ? <button type="button" className="secondary-button" disabled={busy} onClick={() => attempt("skip", { gameId: game.id, expectedTurnId: turn!.id })}>기다리던 차례 넘기기</button>
        : mine && turn && turn.id !== me && Number.isFinite(skipAt) && skipAt - now < BINGO_RULES.skipAfterMs - 60_000 && <small className="bingo-hint">{minutesLeft(skipAt, now)}분 뒤부터 이 차례를 넘길 수 있어요.</small>}
    </section>
    {mine?.cells ? <section className="bingo-card card" aria-label="내 빙고판">
      <div className="bingo-head"><strong>내 빙고판</strong><span className="bingo-count">{mine.rank ? `${mine.rank}등 확정` : `${Math.min(mine.lines, game.lines)}/${game.lines}줄`}</span></div>
      <Board cells={mine.cells} called={called} selected={picked} onPick={myTurn && !closed ? index => setPicked(current => (current === mine.cells![index] ? null : mine.cells![index]!)) : undefined} />
      {myTurn && <button type="button" className="primary-button" data-sfx-quiet disabled={busy || closed || !picked} onClick={() => { if (!picked) return; playSfx("bg-mark"); attempt("call", { gameId: game.id, word: picked }); }}>
        {busy ? "지우는 중…" : picked ? `「${picked}」 지우기 확정` : "지울 단어를 골라 주세요"}</button>}
    </section> : <p className="bingo-note card">이번 판에는 참여하지 않았어요. 다음 판에서 판을 내 주세요.</p>}
    <section className="bingo-card card" aria-label="참가자">
      <h2>참가자</h2>
      <Seats game={game} me={me} turn={turn?.id} />
    </section>
    {game.calls.length > 0 && <section className="bingo-card card" aria-label="지워진 단어">
      <h2>지워진 단어 {game.calls.length}개</h2>
      <div className="bingo-pool is-called">{game.calls.map(call => <span key={call.word} className="bingo-word">{call.word}</span>)}</div>
    </section>}
  </>;
}

function Result({ game, me }: { game: BingoGameView; me: string }) {
  const called = useMemo(() => new Set(game.calls.map(call => call.word)), [game.calls]);
  const mine = game.seats.find(seat => seat.player.id === me);
  return <section className="bingo-card card" aria-label="지난 빙고 결과">
    <div className="bingo-head"><strong>{game.number}번째 빙고 「{game.topic}」</strong><span className="bingo-chip">{game.lines}줄 빙고</span></div>
    {mine?.rank === 1 && <img className="bingo-result-art" src="/bingo/result.webp" alt="" />}
    <p className="bingo-hint">{mine?.rank ? `${mine.rank}등으로 마쳤어요${mine.points ? ` · +${mine.points}점` : ""}.` : "이번 판 결과예요."} 단어 {game.calls.length}개가 지워졌어요.</p>
    <Seats game={game} me={me} />
    <details className="bingo-reveal"><summary>모두의 빙고판 보기</summary>
      {game.seats.map(seat => seat.cells && <div key={seat.player.id} className="bingo-reveal-board">
        <small>{seat.player.displayName} · {seat.lines}줄</small><Board cells={seat.cells} called={called} small /></div>)}
    </details>
  </section>;
}
