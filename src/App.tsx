import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type {
  BootstrapResponse,
  AttendanceState,
  GameId,
  User,
  LedgerEntry,
  ShopState,
  KujiResponse,
  CatchmindSummary,
  ClawSummary,
  LottoNotice,
  LaunchGiftResponse, AuthResponse, LuckPhotoResponse, TagResponse, NicknameTagView,
} from "../shared/types";
import { normalizeNickname } from "../shared/profile";
import type { AdminState, AdminClawConfig, PredictionRules } from "../shared/admin";
import { createAdminPreview, savePreviewGame, savePreviewClaw } from "./admin-preview";
import { AnnouncementBanner } from "./AnnouncementBanner";
import { FEATURES } from "../shared/balance";
import { CATCHMIND_WORDS } from "../shared/catchmind-words";
import { ApiFailure, api } from "./api";
import { markLottoSeen, markViewedLottoDraw } from "./lotto-notice";
import { anim } from "./motion";
import { ProfileDirectoryProvider, CharacterProvider, CharacterSprite, TabBar, tabs, readLegacyCharacter, clearLegacyCharacter, choosePreviewCharacter } from "./components/UI";
import { AttendanceProvider, clearLegacyAttendance, usePreviewAttendance } from "./attendance";
import { defaultCharacter, type ArtKey } from "../shared/characters";
import { PredictionGame } from "./components/PredictionGame";
import { ClawProvider } from "./claw-state";
import { previewClawSummary } from "./claw-summary";
import {
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
import { Slot } from "./screens/Slot";
import { NicknameTagShop } from "./screens/NicknameTagShop";
import { Kuji } from "./screens/Kuji";
import { ShopProvider } from "./shop";
import { CatchmindProvider } from "./catchmind";
import { Catchmind } from "./screens/Catchmind";
import { CatchmindGallery } from "./screens/CatchmindGallery";
import { LaunchGiftProvider, StockNotice } from "./launch-gift";
import { createPreviewStockClient, previewStockHome, resetPreviewStock, type StockClient } from "./stock-preview";

/** The real stock client: plain API calls (polling is paced by the screens). */
const serverStock: StockClient = {
  market: (since) => api.stock(since),
  detail: (ticker) => api.stockDetail(ticker),
  news: (before) => api.stockNews(before),
  trade: (input) => api.tradeStock(input),
};

const Admin = lazy(() => import("./screens/Admin").then(module => ({ default: module.Admin })));
const Claw = lazy(() => import("./screens/Claw").then(module => ({ default: module.Claw })));
const StockMarket = lazy(() => import("./screens/Stock").then(module => ({ default: module.StockMarket })));
const StockDetail = lazy(() => import("./screens/Stock").then(module => ({ default: module.StockDetail })));
const StockNews = lazy(() => import("./screens/Stock").then(module => ({ default: module.StockNews })));

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
  photoVersion: null,
  role: "player",
  gold: previewGold,
  weeklyScore: previewScores.yeseo,
  character: null,
  tag: null,
};
const gameIds: GameId[] = ["wake", "offwork", "luck"];
const emptyCatchmind: CatchmindSummary = { roundId: null, status: "idle", drawer: null, turn: null, wrongCount: 0, winner: null, answer: null };
function previewHome(): HomeData {
  return {
    userId: previewUser.id,
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
    kuji: null,
    stock: null,
    catchmind: emptyCatchmind,
    claw: previewClawSummary(),
    lottoNotice: null,
    serverTime: new Date().toISOString(),
  };
}
function homeData(data: BootstrapResponse): HomeData {
  return {
    userId: data.user.id,
    username: data.user.username,
    displayName: data.user.displayName,
    attendanceKey: data.user.username,
    gold: data.user.gold,
    players: data.players,
    games: data.games,
    kuji: data.kuji,
    catchmind: data.catchmind,
    claw: data.claw,
    lottoNotice: data.lottoNotice,
    stock: data.stock,
    serverTime: data.serverTime,
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
  const [stockNoticeOpen, setStockNoticeOpen] = useState(false);
  const [previewAdmin, setPreviewAdmin] = useState(() => route.startsWith("/preview/admin"));
  const [previewAdminState, setPreviewAdminState] = useState(createAdminPreview);
  const previewAdminStateRef = useRef(previewAdminState);
  previewAdminStateRef.current = previewAdminState;
  const [adminData, setAdminData] = useState<{ owner: string; state: AdminState } | null>(null);
  const [adminLoading, setAdminLoading] = useState(false);
  const [adminError, setAdminError] = useState<string | null>(null);
  const adminGeneration = useRef(0);
  const [previewProfile, setPreviewProfile] = useState<{ displayName: string; photoVersion: number | null; photoUrl: string | null }>({ displayName: previewUser.displayName, photoVersion: null, photoUrl: null });
  const previewPhotoCounter = useRef(0);
  const [previewShop, setPreviewShop] = useState<{ gold: number; score: number; ledger: LedgerEntry[]; lottoNotice: LottoNotice | null; tag: NicknameTagView | null }>({ gold: previewGold, score: 0, ledger: [], lottoNotice: null, tag: null });
  const [previewCatchmind, setPreviewCatchmind] = useState<{ summary: CatchmindSummary; gold: number; score: number; ledger: LedgerEntry[]; wordsRemaining: number }>({ summary: emptyCatchmind, gold: 0, score: 0, ledger: [], wordsRemaining: CATCHMIND_WORDS.length });
  const [previewClaw, setPreviewClaw] = useState<{ summary: ClawSummary; gold: number; score: number; ledger: LedgerEntry[] }>(() => ({ summary: previewClawSummary(), gold: 0, score: 0, ledger: [] }));
  const [previewStock, setPreviewStock] = useState<{ gold: number; ledger: LedgerEntry[] }>({ gold: 0, ledger: [] });
  const previewGoldRef = useRef(0);
  const previewAdminRef = useRef(false);
  const [previewStockClient] = useState(() => createPreviewStockClient({
    gold: () => previewGoldRef.current,
    canTrade: () => !previewAdminRef.current,
    spend: (amount, reason) => {
      previewGoldRef.current -= amount;
      const entry: LedgerEntry = { id: crypto.randomUUID(), currency: "gold", amount: -amount, reason, createdAt: new Date().toISOString() };
      setPreviewStock(current => ({ gold: current.gold - amount, ledger: [entry, ...current.ledger] }));
    },
  }));
  const demo = route.startsWith("/preview");
  const adminDemo = demo && (previewAdmin || route.startsWith("/preview/admin"));
  const adminAllowed = adminDemo || !demo && data?.user.role === "admin";
  const adminOwner = !demo && data?.user.role === "admin" ? data.user.id : null;
  useEffect(() => {
    if (!demo) setPreviewAdmin(false);
    else if (route.startsWith("/preview/admin")) setPreviewAdmin(true);
  }, [demo, route]);
  const previewAttendance = usePreviewAttendance(demo);
  useLayoutEffect(() => {
    if (demo) {
      setPreviewAdminState(createAdminPreview());
      setPreviewShop({ gold: previewGold, score: 0, ledger: [], lottoNotice: null, tag: null });
      setPreviewClaw({ summary: previewClawSummary(), gold: 0, score: 0, ledger: [] });
      setPreviewStock({ gold: 0, ledger: [] });
      resetPreviewStock();
    }
  }, [demo]);
  // A refresh may commit only while its generation is current. Mutations
  // invalidate older reads and pause polling until their state is applied.
  const requestGeneration = useRef(0);
  const pendingMutations = useRef(0);
  const mutationQueue = useRef<Promise<unknown>>(Promise.resolve());
  const serverClockOffset = useRef(0);
  const activeUserId = useRef<string | null>(null);
  const catchmindReauthPending = useRef(false);
  const [catchmindEpoch, setCatchmindEpoch] = useState(0);
  const completeCatchmindReauth = useCallback(() => {
    if (!catchmindReauthPending.current) return;
    catchmindReauthPending.current = false;
    setCatchmindEpoch(value => value + 1);
  }, []);
  const characterImports = useRef(new Set<string>());
  const lastBootstrapSuccessAt = useRef(-Infinity);
  // Only the current generation can pause polling. An invalidated request may
  // remain on the network after a mutation or account switch.
  const pendingBootstrap = useRef<number | null>(null);
  const refresh = useCallback(async () => {
    if (pendingMutations.current) return null;
    const generation = ++requestGeneration.current;
    const current = () => generation === requestGeneration.current;
    pendingBootstrap.current = generation;
    try {
      const next = await api.bootstrap();
      if (!current()) return null;
      lastBootstrapSuccessAt.current = Date.now();
      serverClockOffset.current = Date.parse(next.serverTime) - Date.now();
      activeUserId.current = next.user.id;
      clearLegacyAttendance(next.user.username);
      completeCatchmindReauth();
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
      if (pendingBootstrap.current === generation) pendingBootstrap.current = null;
      if (current()) setLoading(false);
    }
  }, [completeCatchmindReauth]);
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
    const poll = () => {
      if (document.visibilityState === "visible" && navigator.onLine
        && pendingBootstrap.current !== requestGeneration.current && Date.now() - lastBootstrapSuccessAt.current >= 10000)
        void refresh();
    };
    const timer = window.setInterval(poll, route === "/" || route === "/ranking" ? 30000 : 60000);
    // Rapid tab switches and a still-pending read must not create extra requests.
    const visible = poll;
    document.addEventListener("visibilitychange", visible);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", visible);
    };
  }, [data?.user.id, refresh, demo, route]);
  const requestedPath = demo ? route.replace("/preview", "") || "/" : route;
  // The serverless preview can always open the market (sample seeds, no server).
  const stockBlocked = !FEATURES.stock && !demo && /^\/stock(?:\/|$)/.test(requestedPath);
  const adminBlocked = /^\/admin(?:\/|$)/.test(requestedPath) && !adminAllowed && !loading && !!data;
  const path = stockBlocked || adminBlocked ? "/" : requestedPath;
  const noticeUserId = demo ? adminDemo ? "preview-admin" : previewUser.id : data?.user.id;
  const noticeDrawDate = demo ? adminDemo ? null : previewShop.lottoNotice?.drawDate : data?.lottoNotice?.drawDate;
  useEffect(() => {
    if (path === "/shop/lotto" && noticeUserId && noticeDrawDate) markLottoSeen(noticeUserId, noticeDrawDate);
  }, [path, noticeUserId, noticeDrawDate]);
  useEffect(() => {
    if (adminBlocked) window.location.replace("#/");
  }, [adminBlocked]);
  const reloadAdmin = useCallback(async () => {
    if (!adminOwner || demo) return;
    const generation = ++adminGeneration.current;
    setAdminLoading(true);
    setAdminError(null);
    try {
      const next = await api.admin();
      if (generation === adminGeneration.current && activeUserId.current === adminOwner) setAdminData({ owner: adminOwner, state: next });
    } catch (error) {
      if (generation === adminGeneration.current) setAdminError(error instanceof Error ? error.message : "운영 설정을 불러오지 못했어요.");
    } finally {
      if (generation === adminGeneration.current) setAdminLoading(false);
    }
  }, [adminOwner, demo]);
  useEffect(() => {
    setAdminData(null);
    setAdminError(null);
    setAdminLoading(false);
    if (path === "/admin" && adminOwner && !demo) void reloadAdmin();
    return () => { adminGeneration.current++; };
  }, [path, adminOwner, demo, reloadAdmin]);
  useEffect(() => {
    if (stockBlocked) {
      setStockNoticeOpen(true);
      window.location.replace(demo ? "#/preview" : "#/");
    }
  }, [stockBlocked, demo, route]);
  const gameId = path.match(/^\/game\/(wake|offwork|luck)$/)?.[1] as
    GameId | undefined;
  const play = path.match(/^\/play\/(catchmind|kuji|claw)$/)?.[1] as
    "catchmind" | "kuji" | "claw" | undefined;
  const stockId = path.match(/^\/stock\/([A-Z]{4})$/)?.[1];
  const go = (to: string) => {
    if (!FEATURES.stock && !demo && /^\/stock(?:\/|$)/.test(to)) { setStockNoticeOpen(true); return; }
    navigate(demo ? `/preview${to === "/" ? "" : to}` : to);
  };
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
    lastBootstrapSuccessAt.current = Date.now();
    serverClockOffset.current = Date.parse(next.serverTime) - Date.now();
    activeUserId.current = next.user.id;
    clearLegacyAttendance(next.user.username);
    completeCatchmindReauth();
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
  const claimLaunchGift = async () => {
    const owner = data?.user.id;
    let receipt!: LaunchGiftResponse;
    await mutate(async () => { receipt = await api.launchGift(); return receipt; }, result => {
      serverClockOffset.current = Date.parse(result.serverTime) - Date.now();
      setData(current => current && current.user.id === owner ? { ...current, launchGift: result.launchGift, inventory: result.inventory, serverTime: result.serverTime } : current);
    });
    // The receipt already carries the grant; a later read failure cannot undo it.
    await refresh();
    return receipt;
  };
  async function changeProfile(action: (owner: string) => Promise<AuthResponse>) {
    const owner = data?.user.id;
    await mutate(async () => {
      if (activeUserId.current !== owner) throw new ApiFailure(409, "로그인한 계정이 바뀌었어요. 다시 시도해 주세요.");
      return action(owner!);
    }, result => {
      setData(current => current && current.user.id === owner ? { ...current, user: result.user,
        players: current.players.map(player => player.id === owner ? { ...player, displayName: result.user.displayName, photoVersion: result.user.photoVersion } : player) } : current);
    });
    // The saved profile is applied even when a later refresh is unavailable.
    await refresh();
  }
  const loadAttendanceMonth = async (month: string) => (await api.attendance(month)).attendance;
  const characterMap: Record<string, ArtKey | null> = {};
  if (data) {
    for (const player of data.players) characterMap[player.username] = player.character;
    characterMap[data.user.username] = data.user.character;
  }
  const attendanceContext = !demo && data ? {
    attendance: data.attendance, claim: claimAttendance, loadMonth: loadAttendanceMonth, preview: false,
  } : adminDemo ? { ...previewAttendance, attendance: { ...previewAttendance.attendance, canClaim: false } } : previewAttendance;
  async function transactShop<T>(action: () => Promise<T>): Promise<T> {
    if (demo) return action();
    let receipt!: T;
    await mutate(async () => { receipt = await action(); return receipt; }, (result) => {
      const balances = result as T & ShopState & Partial<Pick<KujiResponse, "kuji">> & Partial<Pick<TagResponse, "tags">>;
      // Wearing or removing a tag shows everywhere at once, before the follow-up read.
      const tag = balances.tags ? balances.tags.equipped && { grade: balances.tags.equipped.grade, text: balances.tags.equipped.text } : undefined;
      setData(current => current ? { ...current, user: { ...current.user, gold: balances.gold, ...(tag !== undefined ? { tag: tag || null } : {}) },
        players: tag !== undefined ? current.players.map(player => player.id === current.user.id ? { ...player, tag: tag || null } : player) : current.players,
        inventory: balances.inventory,
        // Keep the card current even if the follow-up bootstrap is unavailable.
        // A saved receipt can refer to an older board, so never move backwards.
        kuji: balances.kuji && balances.kuji.boardId >= (current.kuji.boardId ?? 0)
          ? { boardId: balances.kuji.boardId, remaining: balances.kuji.remaining } : current.kuji } : current);
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
  async function transactClaw<T>(action: () => Promise<T>): Promise<T> {
    if (demo) return action();
    let receipt!: T;
    await mutate(async () => { receipt = await action(); return receipt; }, () => {});
    // Start replay from the saved play receipt without waiting for a second
    // network request. Coin purchases still refresh balances before completing.
    if (receipt && typeof receipt === "object" && "result" in receipt) void refresh();
    else await refresh();
    return receipt;
  }
  async function saveAdmin(action: (owner: string) => Promise<AdminState>) {
    const owner = adminOwner;
    if (!owner) throw new ApiFailure(403, "운영자만 설정을 바꿀 수 있어요.");
    adminGeneration.current++;
    setAdminLoading(false);
    await mutate(async () => {
      if (activeUserId.current !== owner) throw new ApiFailure(409, "로그인한 계정이 바뀌었어요. 다시 열어 주세요.");
      return action(owner);
    }, state => {
      if (activeUserId.current === owner) {
        // A read started while this write was pending must not replace its receipt.
        adminGeneration.current++;
        setAdminLoading(false);
        setAdminError(null);
        setAdminData({ owner, state });
      }
    }).catch(async error => {
      if (activeUserId.current === owner) await reloadAdmin();
      throw error;
    });
    await refresh();
  }
  async function saveAdminGame(id: GameId, rules: PredictionRules, effectiveFrom: string) {
    if (adminDemo) {
      const next = savePreviewGame(previewAdminStateRef.current, id, rules, effectiveFrom);
      previewAdminStateRef.current = next;
      setPreviewAdminState(next);
    } else await saveAdmin(owner => api.saveGameSettings(id, rules, effectiveFrom, owner));
  }
  async function setStockAi(setting: { enabled?: boolean; provider?: "anthropic" | "openai" }) {
    if (adminDemo) {
      const current = previewAdminStateRef.current;
      const ai = { ...current.stock.ai, ...setting };
      const next = { ...current, stock: { ...current.stock, ai: { ...ai, keyConfigured: ai.keys[ai.provider] } } };
      previewAdminStateRef.current = next;
      setPreviewAdminState(next);
    } else await saveAdmin(() => api.setStockAi(setting));
  }
  async function hideStockNews(id: string, hidden: boolean) {
    if (!adminDemo) await saveAdmin(() => api.setStockNewsHidden(id, hidden));
  }
  async function saveAdminHoliday(date: string, reason: string | null) {
    if (adminDemo) {
      const current = previewAdminStateRef.current;
      const marketHolidays = reason === null ? current.marketHolidays.filter(item => item.date !== date)
        : [...current.marketHolidays.filter(item => item.date !== date), { date, reason }].sort((a, b) => a.date.localeCompare(b.date));
      const next = { ...current, marketHolidays };
      previewAdminStateRef.current = next;
      setPreviewAdminState(next);
    } else await saveAdmin(owner => reason === null ? api.removeMarketHoliday(date) : api.addMarketHoliday(date, reason, owner));
  }
  async function saveAdminClaw(config: AdminClawConfig) {
    if (adminDemo) {
      const next = savePreviewClaw(previewAdminStateRef.current, config);
      previewAdminStateRef.current = next;
      setPreviewAdminState(next);
    } else await saveAdmin(owner => api.saveClawSettings(config, owner));
  }
  const catchmindReadKey = useRef("");
  const signedIn = !demo && !loading && data !== null;
  const view = demo ? { ...previewHome(), displayName: previewProfile.displayName, gold: previewShop.gold + previewAttendance.goldBonus + previewCatchmind.gold + previewClaw.gold + previewStock.gold,
    catchmind: previewCatchmind.summary, claw: previewClaw.summary, lottoNotice: previewShop.lottoNotice, stock: previewStockHome(),
    ...(adminDemo ? { userId: "preview-admin", username: "preview-admin", displayName: "운영 미리보기", lottoNotice: null,
      games: previewAdminState.games.map(game => previewGame(game.id, game.rules)),
      claw: { ...previewClaw.summary, coins: 0, freeCoins: 0, purchasedCoins: 0, isAdmin: true } } : {}),
    players: previewHome().players.map(player => player.username === previewUser.username ? { ...player, displayName: previewProfile.displayName, weeklyScore: player.weeklyScore + previewShop.score + previewCatchmind.score + previewClaw.score } : player) } : data ? homeData(data) : null;
  const me = demo ? { ...previewUser, displayName: previewProfile.displayName, photoVersion: previewProfile.photoVersion, gold: previewShop.gold + previewAttendance.goldBonus + previewCatchmind.gold + previewClaw.gold + previewStock.gold, weeklyScore: previewUser.weeklyScore + previewShop.score + previewCatchmind.score + previewClaw.score,
    ...(adminDemo ? { id: "preview-admin", username: "preview-admin", displayName: "운영 미리보기", role: "admin" as const, photoVersion: null, weeklyScore: 0 } : {}) } : data?.user;
  if (demo) { previewGoldRef.current = me?.gold ?? 0; previewAdminRef.current = adminDemo; }
  const stockClient = demo ? previewStockClient : serverStock;
  const profileDirectory = demo
    ? Object.keys(previewScores).map(username => ({ id: username === previewUser.username ? previewUser.id : username, username,
      displayName: username === previewUser.username ? previewProfile.displayName : username,
      photoVersion: username === previewUser.username ? previewProfile.photoVersion : null,
      photoUrl: username === previewUser.username ? previewProfile.photoUrl : null,
      tag: username === previewUser.username ? previewShop.tag : null }))
    : data ? [...data.players.filter(player => player.id !== data.user.id), data.user] : [];
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
  else if (path === "/admin" && adminAllowed) content = <Admin key={adminDemo ? "preview-admin" : me.id}
    state={adminDemo ? { ...previewAdminState, catchmindWordsRemaining: previewCatchmind.wordsRemaining } : adminData?.owner === me.id ? adminData.state : null}
    loading={adminLoading} error={adminError} onReload={() => void reloadAdmin()}
    onSaveGame={saveAdminGame} onSaveClaw={saveAdminClaw} onSaveHoliday={saveAdminHoliday} onSetStockAi={setStockAi} onHideStockNews={hideStockNews} onPlayClaw={() => go("/play/claw")} preview={adminDemo} />;
  else if (play === "kuji") content = <Kuji onBack={home} />;
  else if (path === "/play/catchmind/gallery") content = <CatchmindGallery demo={demo} gold={me.gold} onBack={() => go("/play/catchmind")} />;
  else if (play === "catchmind") content = <Catchmind user={me} demo={demo} onBack={home} />;
  else if (play === "claw") content = <Claw user={me} demo={demo} onBack={home} />;
  else if (gameId && demo) {
    const viewer = previewViewer(gameId);
    content = (
      <PredictionGame
        key={`demo-${gameId}`}
        game={previewGame(gameId, adminDemo ? previewAdminState.games.find(game => game.id === gameId)!.rules : undefined)}
        user={{ ...me, username: viewer, displayName: viewer === me.username ? me.displayName : viewer }}
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
        onPhotoUpload={async image => {
          const owner = data.user.id;
          let receipt!: LuckPhotoResponse;
          await mutate(async () => {
            if (activeUserId.current !== owner) throw new ApiFailure(409, "로그인한 계정이 바뀌었어요. 다시 시도해 주세요.");
            receipt = await api.uploadLuckPhoto(game.roundDate, image);
            return receipt;
          }, result => setData(current => current?.user.id === owner ? { ...current,
            games: current.games.map(value => value.id === "luck" && value.roundDate === game.roundDate ? { ...value, photo: result.photo } : value) } : current));
          await refresh();
          return receipt.photo;
        }}
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
          <SoloGames go={go} claw={view.claw} stock={view.stock} />
        </div>
      </div>
    );
  else if (path === "/ranking")
    content = (
      <Ranking
        me={view.displayName}
        viewerId={me.id}
        gold={me.gold}
        players={view.players}
        serverTime={demo ? undefined : new Date(Date.now() + serverClockOffset.current).toISOString()}
        lastWeek={demo ? previewLastWeek : null}
        demo={demo}
        onBack={home}
      />
    );
  else if (path === "/attendance")
    content = (
      <Attendance attendanceKey={view.attendanceKey} gold={me.gold} onBack={home} />
    );
  else if (path === "/profile")
    content = (
      <Profile key={demo ? "preview" : me.id}
        username={view.username}
        displayName={view.displayName}
        attendanceKey={view.attendanceKey}
        gold={me.gold}
        weeklyScore={me.weeklyScore}
        ledger={demo ? [...previewShop.ledger, ...previewCatchmind.ledger, ...previewClaw.ledger, ...previewStock.ledger, ...previewLedger(previewAttendance.attendance)].sort((a, b) => b.createdAt.localeCompare(a.createdAt)) : (data?.ledger ?? [])}
        others={view.players.map((p) => p.username).filter((u) => u !== view.username)}
        tagShopHref={demo ? "#/preview/shop/tag" : "#/shop/tag"}
        onBack={home}
        onDisplayNameChange={async displayName => {
          if (demo) {
            const result = normalizeNickname(displayName);
            if ("error" in result) throw new Error(result.error);
            if (Object.keys(previewScores).some(username => username !== previewUser.username && username.toLowerCase() === result.value.toLowerCase())) throw new Error("이미 사용 중인 닉네임이에요.");
            setPreviewProfile(current => ({ ...current, displayName: result.value }));
          } else await changeProfile(owner => api.updateProfile(displayName, owner));
        }}
        onPasswordChange={demo ? undefined : async (currentPassword, newPassword) => {
          const owner = me.id;
          await mutate(async () => {
            if (activeUserId.current !== owner) throw new ApiFailure(409, "로그인한 계정이 바뀌었어요. 다시 시도해 주세요.");
            return api.changePassword({ currentPassword, newPassword, expectedUserId: owner });
          }, () => {});
        }}
        onPhotoChange={async photo => {
          if (demo) setPreviewProfile(current => ({ ...current, photoVersion: ++previewPhotoCounter.current, photoUrl: photo }));
          else await changeProfile(owner => api.uploadProfilePhoto(photo, owner));
        }}
        onPhotoDelete={async () => {
          if (demo) setPreviewProfile(current => ({ ...current, photoVersion: null, photoUrl: null }));
          else await changeProfile(api.deleteProfilePhoto);
        }}
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
    content = <StockMarket client={stockClient} gold={me.gold} onBack={home} go={go} />;
  else if (path === "/stock/news")
    content = <StockNews client={stockClient} onBack={() => go("/stock")} go={go} />;
  else if (stockId)
    content = <StockDetail key={stockId} client={stockClient} ticker={stockId} onBack={() => go("/stock")}
      onTraded={() => { if (!demo) void refresh(); }} />;
  else if (path === "/shop") content = <ShopMain go={go} />;
  else if (path === "/shop/lotto")
    content = <Lotto gold={me.gold} onBack={() => go("/shop")} />;
  else if (path === "/shop/speetto")
    content = <Speetto gold={me.gold} onBack={() => go("/shop")} />;
  else if (path === "/shop/slot")
    content = <Slot onBack={() => go("/shop")} />;
  else if (path === "/shop/tag")
    content = <NicknameTagShop onBack={() => go("/shop")} go={go} />;
  else content = <Home data={view} go={go} />;
  // Sub-pages have their own back button instead of the tab bar.
  const subPage =
 !!play || !!gameId || !!stockId ||
    ["/attendance", "/stock", "/stock/news", "/shop/lotto", "/shop/speetto", "/shop/slot", "/shop/tag"].includes(path);
  const showTabs = !!view && !!me && !subPage;
  const screenRef = useScreenTransition(path);
  useStatusBarColor(screenRef, `${path}|${loading}|${!!data}`);
  return (
    <ProfileDirectoryProvider profiles={profileDirectory} preview={demo}>
    <CharacterProvider characters={characterMap} preview={demo}>
      <AttendanceProvider value={attendanceContext}>
    <ClawProvider key={demo ? adminDemo ? "preview-admin" : "preview-player" : data?.user.id ?? "anonymous"}
      preview={demo} adminPreview={adminDemo} previewConfig={adminDemo ? previewAdminState.claw : undefined}
      accountKey={demo ? adminDemo ? "preview-admin" : "preview-player" : data?.user.id ?? "anonymous"}
      gold={me?.gold ?? 0} transact={transactClaw}
      onServerRead={claw => {
        setData(current => current ? { ...current, claw } : current);
        // Recover a failed post-play balance read on the next entry/visibility
        // or refill event, without adding a polling loop to the machine.
        if (bootError) void refresh();
      }}
      onPreviewChange={(summary, gold, score, ledger) => setPreviewClaw({ summary, gold, score, ledger })}>
    <CatchmindProvider key={demo ? "preview" : `${data?.user.id ?? "anonymous"}:${catchmindEpoch}`}
      preview={demo} accountKey={demo ? "preview" : data?.user.id ?? "anonymous"}
      viewer={{ id: me?.id ?? "anonymous", username: me?.username ?? "", displayName: me?.displayName ?? "", photoVersion: me?.photoVersion ?? null, character: me?.character ?? defaultCharacter(me?.username ?? "") }}
      transact={transactCatchmind}
      onAccountChanged={() => {
        catchmindReadKey.current = "";
        if (!demo) {
          // Keep recovery pending if this read fails or a write defers it. Any
          // later authoritative bootstrap may renew the same account safely.
          catchmindReauthPending.current = true;
          void refresh();
        }
      }}
      onServerRead={state => {
        const key = `${data?.user.id}:${state.round?.id}:${state.round?.status}:${state.round?.wrongCount}:${state.round?.wordVersion}:${state.turn?.id}`;
        if (key !== catchmindReadKey.current) { catchmindReadKey.current = key; void refresh(); }
      }}
      onPreviewChange={(summary, gold, score, ledger, wordsRemaining) => setPreviewCatchmind({ summary, gold, score, ledger: [...ledger], wordsRemaining })}>
    <ShopProvider key={demo ? "preview" : data?.user.id ?? "anonymous"}
      preview={demo} accountKey={demo ? "preview" : data?.user.id ?? "anonymous"}
      previewGoldBonus={previewAttendance.goldBonus}
      previewGameGold={demo ? previewCatchmind.gold + previewClaw.gold + previewStock.gold : 0}
      previewAttendanceDate={previewAttendance.attendance.today}
      initial={{ gold: demo ? previewGold : me?.gold ?? 0, inventory: data?.inventory ?? { lottoTickets: 0, speettoTickets: 0 },
        canPurchase: !!me && me.role === "player", serverTime: data?.serverTime ?? new Date().toISOString() }}
      transact={transactShop}
      onServerRead={state => {
        if (data) markViewedLottoDraw(data.user.id, path, "lotto" in state ? state.lotto.todayDraw : null, state.serverTime);
        if (data && (state.gold !== data.user.gold || state.inventory.lottoTickets !== data.inventory.lottoTickets || state.inventory.speettoTickets !== data.inventory.speettoTickets
          || "kuji" in state && (state.kuji.boardId !== data.kuji.boardId || state.kuji.remaining !== data.kuji.remaining))) void refresh();
      }}
      onPreviewChange={(state, ledger, score, lottoNotice, tag) => {
        markViewedLottoDraw(adminDemo ? "preview-admin" : previewUser.id, path, "lotto" in state ? state.lotto.todayDraw : null, state.serverTime);
        setPreviewShop({ gold: state.gold - previewAttendance.goldBonus - previewCatchmind.gold - previewClaw.gold - previewStock.gold, ledger: [...ledger], score, lottoNotice, tag });
      }}>
    <LaunchGiftProvider preview={demo} role={me?.role} state={data?.launchGift ?? { available: false, claimed: false }}
      serverTime={new Date(Date.now() + (demo ? 0 : serverClockOffset.current)).toISOString()}
      path={path} suspended={stockNoticeOpen || stockBlocked} claim={claimLaunchGift}>
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
        <AnnouncementBanner announcements={data?.announcements ?? []} userId={data?.user.id ?? null} preview={demo}
          serverTime={new Date(Date.now() + (demo ? 0 : serverClockOffset.current)).toISOString()} />
        <div className="screen" ref={screenRef}>
          <Suspense fallback={<Skeleton />}>{content}</Suspense>
        </div>
        {showTabs && <TabBar active={tab ?? "/"} onNavigate={go} admin={me?.role === "admin"} />}
        {stockNoticeOpen && <StockNotice onClose={() => setStockNoticeOpen(false)} />}
      </main>
    </LaunchGiftProvider>
    </ShopProvider>
    </CatchmindProvider>
    </ClawProvider>
      </AttendanceProvider>
    </CharacterProvider>
    </ProfileDirectoryProvider>
  );
}
