import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type {
  BootstrapResponse,
  AttendanceState,
  GameId,
  User,
  LedgerEntry,
  ShopState,
  CatchmindSummary,
  ClawSummary,
} from "../shared/types";
import { ApiFailure, api } from "./api";
import { anim } from "./motion";
import { CharacterProvider, CharacterSprite, TabBar, tabs, readLegacyCharacter, clearLegacyCharacter, choosePreviewCharacter } from "./components/UI";
import { AttendanceProvider, clearLegacyAttendance, usePreviewAttendance } from "./attendance";
import { defaultCharacter, type ArtKey } from "../shared/characters";
import { PredictionGame } from "./components/PredictionGame";
import { Claw } from "./screens/Claw";
import { ClawProvider } from "./claw-state";
import { previewClawSummary } from "./claw-preview";
import {
  previewDaily,
  previewGame,
  previewGold,
  previewLastWeek,
  previewLedger,
  previewScores,
  previewViewer,
} from "./sample";
import { Attendance } from "./screens/Attendance";
import { Home, SoloGames, TodayGames, type HomeData } from "./screens/Home";
import { Profile } from "./screens/Profile";
import { Ranking } from "./screens/Ranking";
import { Lotto, ShopMain, Speetto } from "./screens/Shop";
import { StockDetail, StockMarket } from "./screens/Stock";
import { Kuji } from "./screens/Kuji";
import { ShopProvider } from "./shop";
import { CatchmindProvider } from "./catchmind";
import { Catchmind } from "./screens/Catchmind";

function navigate(path: string) {
  window.location.hash = path;
  window.scrollTo({ top: 0 });
}
function useRoute() {
  const [route, setRoute] = useState(window.location.hash.slice(1) || "/");
  useEffect(() => {
    const changed = () => {
      setRoute(window.location.hash.slice(1) || "/");
      window.scrollTo({ top: 0 });
    };
    window.addEventListener("hashchange", changed);
    return () => window.removeEventListener("hashchange", changed);
  }, []);
  return route;
}
const previewUser: User = {
  id: "preview",
  username: "yeseo",
  displayName: "yeseo",
  role: "player",
  gold: previewGold,
  weeklyScore: previewScores.yeseo,
  character: null,
};
const gameIds: GameId[] = ["wake", "offwork", "luck"];
const emptyCatchmind: CatchmindSummary = { roundId: null, status: "idle", drawer: null, turn: null, wrongCount: 0, winner: null, answer: null };
function previewHome(): HomeData {
  return {
    username: previewUser.username,
    displayName: previewUser.displayName,
    attendanceKey: "preview",
    gold: previewGold,
    players: Object.entries(previewScores).map(([username, weeklyScore]) => ({
      username,
      displayName: username,
      weeklyScore,
    })),
    games: gameIds.map((id) => previewGame(id)),
    catchmind: emptyCatchmind,
    claw: previewClawSummary(),
  };
}
function homeData(data: BootstrapResponse): HomeData {
  return {
    username: data.user.username,
    displayName: data.user.displayName,
    attendanceKey: data.user.username,
    gold: data.user.gold,
    players: data.players,
    games: data.games,
    catchmind: data.catchmind,
    claw: data.claw,
  };
}
/** Navigation depth: tab pages 0, sub-pages 1, a stock's detail 2. */
function depthOf(path: string) {
  if (/^\/stock\/./.test(path)) return 2;
  if (tabs.some((t) => t.path === path)) return 0;
  return path === "/login" ? 0 : 1;
}
/** Pushes deeper pages in from the right, pops back from the left and fades tab switches. */
function useScreenTransition(path: string) {
  const ref = useRef<HTMLDivElement>(null);
  const previous = useRef(path);
  useLayoutEffect(() => {
    const from = previous.current;
    previous.current = path;
    if (from === path || !ref.current) return;
    const delta = depthOf(path) - depthOf(from);
    if (delta > 0)
      anim(ref.current, [{ translate: "100% 0" }, { translate: "0 0" }], { dur: 300, ease: "out", fill: "none" });
    else if (delta < 0)
      anim(ref.current, [{ translate: "-24% 0", opacity: 0.6 }, { translate: "0 0", opacity: 1 }], { dur: 260, ease: "inOut", fill: "none" });
    else anim(ref.current, [{ opacity: 0 }, { opacity: 1 }], { dur: 240, ease: "inOut", fill: "none" });
  }, [path]);
  return ref;
}
/** The colour painted at the top of the app column, for the phone's status bar. */
function topColor(shell: Element): string {
  const rect = shell.getBoundingClientRect();
  let el = document.elementFromPoint(rect.left + rect.width / 2, Math.max(rect.top, 0) + 1);
  for (; el && el !== document.documentElement; el = el.parentElement) {
    const style = getComputedStyle(el);
    // A gradient counts by its first stop unless that stop is see-through.
    const stop = style.backgroundImage.match(/rgba?\([^)]*\)/)?.[0];
    if (stop && !/,\s*0\)$/.test(stop)) return stop;
    if (!/rgba\(0, 0, 0, 0\)|transparent/.test(style.backgroundColor)) return style.backgroundColor;
  }
  return "#FFF9EE";
}
/** Keeps theme-color and the page background behind the status bar in step
 * with the top of the current screen, so the bar blends into the hero. */
function useStatusBarColor(screen: { current: HTMLElement | null }, path: string) {
  useEffect(() => {
    const node = screen.current;
    const meta = document.querySelector('meta[name="theme-color"]');
    if (!node || !meta) return;
    let frame = 0;
    const update = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const shell = node.closest(".app-shell");
        if (!shell) return;
        const color = topColor(shell);
        meta.setAttribute("content", color);
        document.documentElement.style.setProperty("--top-color", color);
      });
    };
    update();
    // Again once the push/pop transition has settled, and whenever the
    // screen changes its own backgrounds (character swap, claw win…).
    const settle = setTimeout(update, 360);
    const observer = new MutationObserver(update);
    observer.observe(node, { subtree: true, childList: true, attributes: true, attributeFilter: ["class", "style"] });
    return () => {
      clearTimeout(settle);
      cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, [screen, path]);
}
function Skeleton() {
  return (
    <div className="skeleton-page" role="status" aria-label="불러오는 중">
      <div className="skeleton-hero" />
      {[0, 1, 2, 3].map((i) => (
        <div className="skeleton-card" key={i} style={{ animationDelay: `${i * 35}ms` }}>
          <i />
          <span>
            <b />
            <b />
          </span>
        </div>
      ))}
    </div>
  );
}
function Login({
  onLogin,
  online,
}: {
  onLogin: (username: string, password: string) => Promise<void>;
  online: boolean;
}) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setError("");
    setBusy(true);
    try {
      await onLogin(username.trim(), password);
    } catch (e) {
      setError(e instanceof Error ? e.message : "로그인하지 못했어요.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="login-page">
      <div className="login-hero">
        <span className="wordmark">
          예굼방 아케이드<span>3</span>
        </span>
        <span className="login-spark spark-one">✦</span>
        <span className="login-spark spark-two">✦</span>
        <div className="login-characters">
          <CharacterSprite username="min" state="idle" />
          <CharacterSprite username="yeseo" state="idle" />
          <CharacterSprite username="siwon" state="idle" />
        </div>
        <h1>
          어서 와,
          <br />
          우리의 작은 놀이터에.
        </h1>
        <p>함께 맞히고, 그리고, 웃는 하루.</p>
      </div>
      <form className="login-form" onSubmit={submit}>
        <label className="field-label">
          아이디
          <input
            autoComplete="username"
            name="username"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            placeholder="아이디를 입력해 주세요"
            required
            maxLength={32}
            autoCapitalize="none"
            spellCheck={false}
          />
        </label>
        <label className="field-label">
          비밀번호
          <span className="password-field">
            <input
              aria-label="비밀번호"
              autoComplete="current-password"
              name="password"
              type={show ? "text" : "password"}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="비밀번호를 입력해 주세요"
              required
              maxLength={128}
            />
            <button
              type="button"
              onClick={() => setShow((v) => !v)}
              aria-label={show ? "비밀번호 숨기기" : "비밀번호 보기"}
            >
              {show ? "숨김" : "보기"}
            </button>
          </span>
        </label>
        {error && (
          <p className="form-message error" role="alert">
            {error}
          </p>
        )}
        <button className="primary-button" disabled={busy || !online}>
          {busy ? "들어가는 중…" : "예굼방 들어가기"}
        </button>
        <button
          className="text-button"
          type="button"
          onClick={() => navigate("/preview")}
        >
          먼저 체험해 보기 <span aria-hidden="true">→</span>
        </button>
      </form>
      <p className="login-footer">우리끼리, 매일 조금 더 즐겁게.</p>
    </div>
  );
}
export default function App() {
  const route = useRoute();
  const [data, setData] = useState<BootstrapResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [bootError, setBootError] = useState("");
  const [online, setOnline] = useState(navigator.onLine);
  const [previewShop, setPreviewShop] = useState<{ gold: number; score: number; ledger: LedgerEntry[] }>({ gold: previewGold, score: 0, ledger: [] });
  const [previewCatchmind, setPreviewCatchmind] = useState<{ summary: CatchmindSummary; gold: number; score: number; ledger: LedgerEntry[] }>({ summary: emptyCatchmind, gold: 0, score: 0, ledger: [] });
  const [previewClaw, setPreviewClaw] = useState<{ summary: ClawSummary; gold: number; score: number; ledger: LedgerEntry[] }>(() => ({ summary: previewClawSummary(), gold: 0, score: 0, ledger: [] }));
  const demo = route.startsWith("/preview");
  const previewAttendance = usePreviewAttendance(demo);
  useEffect(() => {
    if (demo) {
      setPreviewShop({ gold: previewGold, score: 0, ledger: [] });
      setPreviewClaw({ summary: previewClawSummary(), gold: 0, score: 0, ledger: [] });
    }
  }, [demo]);
  // A refresh may commit only while its generation is current. Mutations
  // invalidate older reads and pause polling until their state is applied.
  const requestGeneration = useRef(0);
  const pendingMutations = useRef(0);
  const mutationQueue = useRef<Promise<unknown>>(Promise.resolve());
  const serverClockOffset = useRef(0);
  const activeUserId = useRef<string | null>(null);
  const characterImports = useRef(new Set<string>());
  const refresh = useCallback(async () => {
    if (pendingMutations.current) return null;
    const generation = ++requestGeneration.current;
    const current = () => generation === requestGeneration.current;
    try {
      const next = await api.bootstrap();
      if (!current()) return null;
      serverClockOffset.current = Date.parse(next.serverTime) - Date.now();
      activeUserId.current = next.user.id;
      clearLegacyAttendance(next.user.username);
      setData(next);
      setBootError("");
      return next;
    } catch (e) {
      if (!current()) return null;
      if (e instanceof ApiFailure && e.status === 401) {
        activeUserId.current = null;
        setData(null);
        setBootError("");
      } else {
        setBootError(e instanceof Error ? e.message : "불러오지 못했어요.");
      }
      return null;
    } finally {
      if (current()) setLoading(false);
    }
  }, []);
  useEffect(() => {
    if (demo) { setLoading(false); return; }
    void refresh();
    return () => {
      requestGeneration.current += 1;
    };
  }, [refresh, demo]);
  useEffect(() => {
    const on = () => {
      setOnline(true);
      if (!demo) void refresh();
    };
    const off = () => setOnline(false);
    window.addEventListener("online", on);
    window.addEventListener("offline", off);
    return () => {
      window.removeEventListener("online", on);
      window.removeEventListener("offline", off);
    };
  }, [refresh, demo]);
  useEffect(() => {
    // The claw screen owns event-driven reads; it must never poll.
    if (!data || demo || route.endsWith("/play/claw")) return;
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible" && navigator.onLine)
        void refresh();
    }, 30000);
    const visible = () => {
      if (document.visibilityState === "visible" && navigator.onLine)
        void refresh();
    };
    document.addEventListener("visibilitychange", visible);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", visible);
    };
  }, [data?.user.id, refresh, demo, route]);
  const path = demo ? route.replace("/preview", "") || "/" : route;
  const gameId = path.match(/^\/game\/(wake|offwork|luck)$/)?.[1] as
    GameId | undefined;
  const play = path.match(/^\/play\/(catchmind|kuji|claw)$/)?.[1] as
    "catchmind" | "kuji" | "claw" | undefined;
  const stockId = path.match(/^\/stock\/([a-z]+)$/)?.[1];
  const go = (to: string) => navigate(demo ? `/preview${to === "/" ? "" : to}` : to);
  const home = () => go("/");
  function mutate<T>(
    action: () => Promise<T>,
    apply: (result: T) => void,
  ): Promise<void> {
    requestGeneration.current += 1;
    pendingMutations.current += 1;
    // Keep writes and their local commits in order even if the user navigates
    // away from a pending save and immediately logs out.
    const operation = mutationQueue.current.then(async () => {
      try {
        const result = await action();
        apply(result);
        setBootError("");
      } catch (e) {
        if (e instanceof ApiFailure && e.status === 401) {
          activeUserId.current = null;
          setData(null);
          setBootError("");
          navigate("/login");
        }
        throw e;
      } finally {
        requestGeneration.current += 1;
        pendingMutations.current -= 1;
      }
    });
    mutationQueue.current = operation.catch(() => undefined);
    return operation;
  }
  const applyBootstrap = (next: BootstrapResponse) => {
    serverClockOffset.current = Date.parse(next.serverTime) - Date.now();
    activeUserId.current = next.user.id;
    clearLegacyAttendance(next.user.username);
    setData(next);
  };
  useEffect(() => {
    if (demo || !data) return;
    const { id, username, character } = data.user;
    const legacy = readLegacyCharacter(username);
    if (character !== null || !legacy) { clearLegacyCharacter(username); return; }
    if (characterImports.current.has(id)) return;
    characterImports.current.add(id);
    // Serialize migration with saves/logout. A later login must never import
    // the previous user's local choice into the new session.
    void mutate(async () => {
      if (activeUserId.current !== id) return null;
      await api.character(legacy, true, id);
      clearLegacyCharacter(username);
      return api.bootstrap();
    }, next => { if (next && activeUserId.current === id) applyBootstrap(next); })
      .catch(() => { /* Keep the legacy key on failure and retry after a refresh. */ })
      .finally(() => characterImports.current.delete(id));
  }, [data, demo]);
  const claimAttendance = async () => {
    let result!: { attendance: AttendanceState; awarded: boolean };
    await mutate(async () => {
      const claim = await api.claimAttendance();
      result = { attendance: claim.attendance, awarded: claim.awarded };
      return api.bootstrap();
    }, applyBootstrap);
    return result;
  };
  const loadAttendanceMonth = async (month: string) => (await api.attendance(month)).attendance;
  const characterMap: Record<string, ArtKey | null> = {};
  if (data) {
    for (const player of data.players) characterMap[player.username] = player.character;
    characterMap[data.user.username] = data.user.character;
  }
  const attendanceContext = !demo && data ? {
    attendance: data.attendance, claim: claimAttendance, loadMonth: loadAttendanceMonth, preview: false,
  } : previewAttendance;
  async function transactShop<T>(action: () => Promise<T>): Promise<T> {
    if (demo) return action();
    let receipt!: T;
    await mutate(async () => { receipt = await action(); return receipt; }, (result) => {
      const balances = result as T & ShopState;
      setData(current => current ? { ...current, user: { ...current.user, gold: balances.gold }, inventory: balances.inventory } : current);
    });
    // A successful purchase remains successful if this follow-up read fails.
    // The receipt already carries current funds; refresh reports its own error.
    await refresh();
    return receipt;
  }
  async function transactCatchmind<T>(action: () => Promise<T>): Promise<T> {
    if (demo) return action();
    let receipt!: T;
    await mutate(async () => { receipt = await action(); return receipt; }, () => {});
    await refresh();
    return receipt;
  }
  const catchmindReadKey = useRef("");
  const signedIn = !demo && !loading && data !== null;
  const view = demo ? { ...previewHome(), gold: previewShop.gold + previewAttendance.goldBonus + previewCatchmind.gold + previewClaw.gold,
    catchmind: previewCatchmind.summary, claw: previewClaw.summary,
    players: previewHome().players.map(player => player.username === previewUser.username ? { ...player, weeklyScore: player.weeklyScore + previewShop.score + previewCatchmind.score + previewClaw.score } : player) } : data ? homeData(data) : null;
  const me = demo ? { ...previewUser, gold: previewShop.gold + previewAttendance.goldBonus + previewCatchmind.gold + previewClaw.gold, weeklyScore: previewUser.weeklyScore + previewShop.score + previewCatchmind.score + previewClaw.score } : data?.user;
  const tab = tabs.find((t) => t.path === path)?.path;
  let content: React.ReactNode;
  if (!demo && loading) content = <Skeleton />;
  else if (!demo && !data)
    content = (
      <>
        <Login
          online={online}
          onLogin={(username, password) =>
            mutate(
              async () => {
                await api.login(username, password);
                return api.bootstrap();
              },
              (next) => {
                applyBootstrap(next);
                navigate("/");
              },
            )
          }
        />
        {bootError && (
          <div className="bootstrap-error">
            <p role="alert">{bootError}</p>
            <button className="text-button" onClick={() => void refresh()}>
              다시 연결하기
            </button>
          </div>
        )}
      </>
    );
  else if (!view || !me) content = null;
  else if (play === "kuji") content = <Kuji onBack={home} />;
  else if (play === "catchmind") content = <Catchmind user={me} demo={demo} onBack={home} />;
  else if (play === "claw") content = <Claw user={me} demo={demo} onBack={home} />;
  else if (gameId && demo) {
    const viewer = previewViewer(gameId);
    content = (
      <PredictionGame
        key={`demo-${gameId}`}
        game={previewGame(gameId)}
        user={{ ...me, username: viewer, displayName: viewer }}
        serverTime={new Date(`${previewGame(gameId).roundDate}T09:12:36+09:00`).toISOString()}
        demo
        onBack={home}
        onSave={async () => {}}
        onReveal={async () => {}}
        onWake={async () => {}}
      />
    );
  } else if (gameId && data) {
    const game = data.games.find((g) => g.id === gameId);
    content = game ? (
      <PredictionGame
        key={`${gameId}-${game.roundDate}`}
        game={game}
        user={data.user}
        serverTime={new Date(
          Date.now() + serverClockOffset.current,
        ).toISOString()}
        onBack={home}
        onSave={(value, hint, author) => mutate(async () => {
          await (author ? api.answer(gameId, value, hint, game.roundDate) : api.predict(gameId, value, game.roundDate));
          return api.bootstrap();
        }, applyBootstrap)}
        onReveal={() => mutate(async () => {
          await api.reveal(gameId, game.roundDate);
          return api.bootstrap();
        }, applyBootstrap)}
        onWake={() => mutate(async () => {
          await api.wake(game.roundDate);
          return api.bootstrap();
        }, applyBootstrap)}
      />
    ) : (
      <div className="empty-state">
        게임을 찾을 수 없어요.
        <button className="text-button" onClick={home}>
          홈으로 돌아가기
        </button>
      </div>
    );
  } else if (path === "/games")
    content = (
      <div className="games-tab">
        <header className="tab-header">
          <h1>게임</h1>
        </header>
        <div className="screen-body stack">
          <TodayGames data={view} go={go} />
          <SoloGames go={go} claw={view.claw} />
        </div>
      </div>
    );
  else if (path === "/ranking")
    content = (
      <Ranking
        me={view.displayName}
        gold={me.gold}
        players={view.players}
        serverTime={demo ? undefined : new Date(Date.now() + serverClockOffset.current).toISOString()}
        daily={demo ? previewDaily : (data?.dailyScores ?? [0, 0, 0, 0, 0, 0, 0])}
        lastWeek={demo ? previewLastWeek : null}
        onBack={home}
      />
    );
  else if (path === "/attendance")
    content = (
      <Attendance attendanceKey={view.attendanceKey} gold={me.gold} onBack={home} />
    );
  else if (path === "/profile")
    content = (
      <Profile
        username={view.username}
        displayName={view.displayName}
        attendanceKey={view.attendanceKey}
        gold={me.gold}
        weeklyScore={me.weeklyScore}
        ledger={demo ? [...previewShop.ledger, ...previewCatchmind.ledger, ...previewClaw.ledger, ...previewLedger(previewAttendance.attendance)].sort((a, b) => b.createdAt.localeCompare(a.createdAt)) : (data?.ledger ?? [])}
        others={view.players.map((p) => p.username).filter((u) => u !== view.username)}
        onBack={home}
        onCharacterChange={async (character) => {
          if (demo) { choosePreviewCharacter(view.username, character); return; }
          await mutate(async () => {
            await api.character(character);
            clearLegacyCharacter(view.username);
            return api.bootstrap();
          }, applyBootstrap);
        }}
        onLogin={demo ? () => navigate("/login") : undefined}
        onLogout={
          signedIn
            ? () =>
                mutate(api.logout, () => {
                  activeUserId.current = null;
                  setData(null);
                  navigate("/login");
                })
            : undefined
        }
      />
    );
  else if (path === "/stock")
    content = <StockMarket gold={me.gold} onBack={home} go={go} />;
  else if (stockId)
    content = <StockDetail id={stockId} gold={me.gold} onBack={() => go("/stock")} />;
  else if (path === "/shop") content = <ShopMain go={go} />;
  else if (path === "/shop/lotto")
    content = <Lotto gold={me.gold} onBack={() => go("/shop")} />;
  else if (path === "/shop/speetto")
    content = <Speetto gold={me.gold} onBack={() => go("/shop")} />;
  else content = <Home data={view} go={go} />;
  // Sub-pages have their own back button instead of the tab bar.
  const subPage =
    !!play || !!gameId || !!stockId ||
    ["/attendance", "/stock", "/shop/lotto", "/shop/speetto"].includes(path);
  const showTabs = !!view && !!me && !subPage;
  const screenRef = useScreenTransition(path);
  useStatusBarColor(screenRef, `${path}|${loading}|${!!data}`);
  return (
    <CharacterProvider characters={characterMap} preview={demo}>
      <AttendanceProvider value={attendanceContext}>
    <ClawProvider key={demo ? "preview" : data?.user.id ?? "anonymous"}
      preview={demo} accountKey={demo ? "preview" : data?.user.id ?? "anonymous"}
      gold={me?.gold ?? 0} transact={transactCatchmind}
      onServerRead={claw => {
        setData(current => current ? { ...current, claw } : current);
        // Recover a failed post-play balance read on the next entry/visibility
        // or refill event, without adding a polling loop to the machine.
        if (bootError) void refresh();
      }}
      onPreviewChange={(summary, gold, score, ledger) => setPreviewClaw({ summary, gold, score, ledger })}>
    <CatchmindProvider key={demo ? "preview" : data?.user.id ?? "anonymous"}
      preview={demo} accountKey={demo ? "preview" : data?.user.id ?? "anonymous"}
      viewer={{ id: me?.id ?? "anonymous", username: me?.username ?? "", displayName: me?.displayName ?? "", character: me?.character ?? defaultCharacter(me?.username ?? "") }}
      transact={transactCatchmind}
      onServerRead={state => {
        const key = `${data?.user.id}:${state.round?.id}:${state.round?.status}:${state.round?.wrongCount}:${state.round?.wordVersion}`;
        if (key !== catchmindReadKey.current) { catchmindReadKey.current = key; void refresh(); }
      }}
      onPreviewChange={(summary, gold, score, ledger) => setPreviewCatchmind({ summary, gold, score, ledger: [...ledger] })}>
    <ShopProvider key={demo ? "preview" : data?.user.id ?? "anonymous"}
      preview={demo} accountKey={demo ? "preview" : data?.user.id ?? "anonymous"}
      previewGoldBonus={previewAttendance.goldBonus}
      previewGameGold={demo ? previewCatchmind.gold + previewClaw.gold : 0}
      previewAttendanceDate={previewAttendance.attendance.today}
      initial={{ gold: demo ? previewGold : me?.gold ?? 0, inventory: data?.inventory ?? { lottoTickets: 0, speettoTickets: 0 },
        canPurchase: !!me && me.role === "player", serverTime: data?.serverTime ?? new Date().toISOString() }}
      transact={transactShop}
      onServerRead={state => {
        if (data && (state.gold !== data.user.gold || state.inventory.lottoTickets !== data.inventory.lottoTickets || state.inventory.speettoTickets !== data.inventory.speettoTickets)) void refresh();
      }}
      onPreviewChange={(state, ledger, score) => setPreviewShop({ gold: state.gold - previewAttendance.goldBonus - previewCatchmind.gold - previewClaw.gold, ledger: [...ledger], score })}>
      <aside className="desktop-brand" aria-hidden="true">
        <span className="wordmark">
          예굼방 아케이드<span>3</span>
        </span>
        <p>
          조금 더 가까워지는
          <br />
          우리만의 작은 놀이터.
        </p>
        <div className="brand-dots">
          <i />
          <i />
          <i />
        </div>
      </aside>
      <main className={`app-shell ${showTabs ? "with-tabs" : ""}`}>
        {!online && (
          <div className="connection-banner" role="status">
            오프라인이에요. 게임 저장은 연결 후 가능해요.
          </div>
        )}
        {data && bootError && (
          <div className="connection-banner" role="status">
            최신 정보를 불러오지 못했어요.{" "}
            <button onClick={() => void refresh()}>다시 시도</button>
          </div>
        )}
        <div className="screen" ref={screenRef}>
          {content}
        </div>
        {showTabs && <TabBar active={tab ?? "/"} onNavigate={go} />}
      </main>
    </ShopProvider>
    </CatchmindProvider>
    </ClawProvider>
      </AttendanceProvider>
    </CharacterProvider>
  );
}
