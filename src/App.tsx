import { useCallback, useEffect, useRef, useState } from "react";
import type {
  BootstrapResponse,
  GameId,
  GameState,
  User,
} from "../shared/types";
import { ApiFailure, api } from "./api";
import { Avatar, Character, GameIcon, Gold, Toolbar } from "./components/UI";
import { PredictionGame } from "./components/PredictionGame";
import { PreviewGames } from "./components/PreviewGames";

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
const demoUser: User = {
  id: "preview",
  username: "yeseo",
  displayName: "yeseo",
  role: "player",
  gold: 0,
  weeklyScore: 0,
};
function sampleGame(id: GameId): GameState {
  const base: GameState = {
    id,
    title:
      id === "wake"
        ? "기상시간 맞히기"
        : id === "offwork"
          ? "퇴근시간 맞히기"
          : "행운 점수 맞히기",
    authorUsername:
      id === "wake" ? "min" : id === "offwork" ? "siwon" : "yeseo",
    deadline: new Date(
      Date.now() + (id === "luck" ? 28044 : 4644) * 1000,
    ).toISOString(),
    roundDate: "체험",
    phase: "open",
    hint: "비 와도 기분 좋음. 점심이 맛있었다",
    prediction: null,
    answer: null,
    answerEntered: true,
    results: [],
    participants: (id === "luck" ? ["siwon", "min"] : ["yeseo", "siwon"]).map((username, index) => ({
      playerId: username, username, displayName: username, submitted: index === 1,
    })),
    canPredict: true,
    canEditAnswer: false,
    canReveal: false,
  };
  if (id === "offwork")
    return {
      ...base,
      phase: "revealed",
      answer: "18:12",
      results: [
        {
          playerId: "preview",
          username: "yeseo",
          displayName: "yeseo",
          value: "18:20",
          difference: 8,
        },
        {
          playerId: "min",
          username: "min",
          displayName: "min",
          value: "17:50",
          difference: 22,
        },
      ],
    };
  return base;
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
          예굼방<span>3</span>
        </span>
        <span className="login-spark spark-one">✦</span>
        <span className="login-spark spark-two">✦</span>
        <div className="login-characters">
          <Character username="min" />
          <Character username="yeseo" />
          <Character username="siwon" />
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
function Home({
  data,
  demo = false,
}: {
  data: BootstrapResponse | null;
  demo?: boolean;
}) {
  const user = data?.user ?? demoUser;
  const prefix = demo ? "/preview" : "";
  const games = [
    {
      id: "wake",
      title: "기상시간",
      sub: "min의 아침을 맞혀 봐",
      tint: "mint",
      time: "10:30 마감",
    },
    {
      id: "offwork",
      title: "퇴근시간",
      sub: "siwon의 하루는 언제 끝날까",
      tint: "peach",
      time: "17:00 마감",
    },
    {
      id: "luck",
      title: "행운 점수",
      sub: "yeseo의 오늘을 예측해 봐",
      tint: "lavender",
      time: "17:00 마감",
    },
  ];
  return (
    <div className="home-page">
      <header className="home-header">
        <span className="wordmark">
          예굼방<span>3</span>
        </span>
        <button
          className="profile-button"
          onClick={() => navigate(demo ? "/login" : "/profile")}
          aria-label={demo ? "로그인 화면으로" : "내 정보"}
        >
          {demo ? (
            <span className="preview-label">체험</span>
          ) : (
            <Avatar username={user.username} size={36} />
          )}
        </button>
      </header>
      <section className="personal-room">
        <div className="room-window">
          <span className="window-cloud" />
        </div>
        <span className="room-star">✧</span>
        <span className="room-frame">✦</span>
        <div className="room-floor" />
        <div className="room-rug" />
        <div className="room-greeting">오늘도 반가워!</div>
        <Character username={user.username} className="room-character" />
        <div className="room-plant">
          <span>♧</span>
          <i />
        </div>
      </section>
      <section className="home-profile">
        <div>
          <p>{demo ? "미리 만나는 예굼방" : "나의 작은 아지트"}</p>
          <h1>
            {demo ? "우리의 작은 놀이터" : `${user.displayName}의 예굼방`}
          </h1>
        </div>
        {!demo && <Gold value={user.gold} />}
      </section>
      {demo ? (
        <div className="demo-intro">
          <span className="status-dot" />
          체험 중에는 실제 기록과 재화가 바뀌지 않아요.
        </div>
      ) : (
        <button className="weekly-card" onClick={() => navigate("/ranking")}>
          <span className="weekly-icon">✦</span>
          <div>
            <span>이번 주 나의 점수</span>
            <strong>
              {user.weeklyScore}
              <small>점</small>
            </strong>
          </div>
          <span className="weekly-link">
            순위 보기 <span aria-hidden="true">›</span>
          </span>
        </button>
      )}
      <section className="home-games">
        <div className="section-heading">
          <h2>함께하는 게임</h2>
          <span>매일 새로운 한 판</span>
        </div>
        <div className="game-grid">
          {games.map((game) => (
            <button
              key={game.id}
              className={`game-tile ${game.tint}`}
              onClick={() => navigate(`${prefix}/game/${game.id}`)}
            >
              <span className="tile-icon">
                <GameIcon type={game.id} />
              </span>
              <strong>
                {game.title}
                <br />
                맞히기
              </strong>
              <small>{game.time}</small>
              <span className="tile-arrow" aria-hidden="true">
                ↗
              </span>
            </button>
          ))}
          <button
            className="game-tile sky"
            onClick={() => navigate(`${prefix}/play/catchmind`)}
          >
            <span className="tile-icon">
              <GameIcon type="catchmind" />
            </span>
            <strong>캐치마인드</strong>
            <small>그림 속 정답은? · 체험</small>
            <span className="tile-arrow" aria-hidden="true">
              ↗
            </span>
          </button>
          <button
            className="game-tile yellow"
            onClick={() => navigate(`${prefix}/play/kuji`)}
          >
            <span className="tile-icon">
              <GameIcon type="kuji" />
            </span>
            <strong>예굼쿠지</strong>
            <small>행운의 한 칸 · 체험</small>
            <span className="tile-arrow" aria-hidden="true">
              ↗
            </span>
          </button>
          <div className="game-tile coming">
            <span className="coming-plus" aria-hidden="true">
              +
            </span>
            <strong>다음 놀이는?</strong>
            <small>새로운 게임 준비 중</small>
          </div>
        </div>
      </section>
      <section className="home-games solo-games">
        <div className="section-heading">
          <h2>혼자서도 즐겁게</h2>
        </div>
        <button
          className="wide-game claw-tile"
          onClick={() => navigate(`${prefix}/play/claw`)}
        >
          <div>
            <span className="preview-label">체험</span>
            <h3>캐릭터 뽑기</h3>
            <p>말랑한 친구들을 만나 봐!</p>
          </div>
          <img src="/characters/sprite.png" alt="" className="character" />
        </button>
        <div className="soon-row">
          <span className="small-game-icon">
            <GameIcon type="stock" />
          </span>
          <strong>주식 시장</strong>
          <span className="pill muted">준비 중</span>
        </div>
        <div className="soon-row">
          <span className="small-game-icon">
            <GameIcon type="shop" />
          </span>
          <strong>예굼 상점</strong>
          <span className="pill muted">준비 중</span>
        </div>
      </section>
      <footer className="home-footer">예굼방에서, 오늘도 좋은 하루.</footer>
      {demo && (
        <div className="demo-login">
          <button className="primary-button" onClick={() => navigate("/login")}>
            로그인하고 함께하기
          </button>
        </div>
      )}
    </div>
  );
}
function Profile({
  data,
  onLogout,
}: {
  data: BootstrapResponse;
  onLogout: () => Promise<void>;
}) {
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <>
      <Toolbar title="내 정보" onBack={() => navigate("/")} />
      <div className="screen-body profile-page">
        <div className="card profile-card">
          <Avatar username={data.user.username} size={80} />
          <h2>{data.user.displayName}</h2>
          <span className="pill lavender">
            {data.user.role === "admin" ? "운영자" : "플레이어"}
          </span>
          <Gold value={data.user.gold} />
        </div>
        <h2 className="small-heading">골드 · 점수 내역</h2>
        <div className="card ledger-list">
          {data.ledger.length ? (
            data.ledger.map((entry) => (
              <div className="ledger-entry" key={entry.id}>
                <div>
                  <strong>{entry.reason}</strong>
                  <small>
                    {new Date(entry.createdAt).toLocaleString("ko-KR", {
                      timeZone: "Asia/Seoul",
                    })}
                  </small>
                </div>
                <span>
                  {entry.amount > 0 ? "+" : ""}
                  {entry.amount}
                  {entry.currency === "gold" ? "G" : "점"}
                </span>
              </div>
            ))
          ) : (
            <p className="empty-state">아직 변동 내역이 없어요.</p>
          )}
        </div>
        {error && (
          <p role="alert" className="form-message error">
            {error}
          </p>
        )}
        <button
          className="secondary-button"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            try {
              await onLogout();
            } catch (e) {
              setError(
                e instanceof Error ? e.message : "로그아웃하지 못했어요.",
              );
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy ? "로그아웃 중…" : "로그아웃"}
        </button>
      </div>
    </>
  );
}
function Ranking({ data }: { data: BootstrapResponse }) {
  const players = [...data.players].sort(
    (a, b) => b.weeklyScore - a.weeklyScore,
  );
  return (
    <>
      <Toolbar
        title="이번 주 순위"
        onBack={() => navigate("/")}
        gold={data.user.gold}
      />
      <div className="screen-body ranking-page">
        <div className="ranking-hero">
          <span>✦</span>
          <h1>같이 놀면 더 즐거워</h1>
          <p>월요일부터 일요일까지, 우리의 한 주</p>
        </div>
        {players.map((player) => (
          <div className="card ranking-player" key={player.id}>
            <span className="rank-badge first">
              {players.findIndex((p) => p.weeklyScore === player.weeklyScore) +
                1}
            </span>
            <Avatar username={player.username} size={48} />
            <strong>{player.displayName}</strong>
            <b>
              {player.weeklyScore}
              <small>점</small>
            </b>
          </div>
        ))}
        <p className="subtle-note">점수 배점과 주간 보상은 준비 중이에요.</p>
      </div>
    </>
  );
}

export default function App() {
  const route = useRoute();
  const [data, setData] = useState<BootstrapResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [bootError, setBootError] = useState("");
  const [online, setOnline] = useState(navigator.onLine);
  const demo = route.startsWith("/preview");
  // A refresh may commit only while its generation is current. Mutations
  // invalidate older reads and pause polling until their state is applied.
  const requestGeneration = useRef(0);
  const pendingMutations = useRef(0);
  const mutationQueue = useRef<Promise<unknown>>(Promise.resolve());
  const serverClockOffset = useRef(0);
  const refresh = useCallback(async () => {
    if (pendingMutations.current) return null;
    const generation = ++requestGeneration.current;
    const current = () => generation === requestGeneration.current;
    try {
      const next = await api.bootstrap();
      if (!current()) return null;
      serverClockOffset.current = Date.parse(next.serverTime) - Date.now();
      setData(next);
      setBootError("");
      return next;
    } catch (e) {
      if (!current()) return null;
      if (e instanceof ApiFailure && e.status === 401) {
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
    void refresh();
    return () => {
      requestGeneration.current += 1;
    };
  }, [refresh]);
  useEffect(() => {
    const on = () => {
      setOnline(true);
      void refresh();
    };
    const off = () => setOnline(false);
    window.addEventListener("online", on);
    window.addEventListener("offline", off);
    return () => {
      window.removeEventListener("online", on);
      window.removeEventListener("offline", off);
    };
  }, [refresh]);
  useEffect(() => {
    if (!data) return;
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
  }, [data?.user.id, refresh]);
  const [sample, setSample] = useState<{ id: GameId; game: GameState } | null>(
    null,
  );
  const path = demo ? route.replace("/preview", "") || "/" : route;
  const gameId = path.match(/^\/game\/(wake|offwork|luck)$/)?.[1] as
    GameId | undefined;
  const play = path.match(/^\/play\/(catchmind|kuji|claw)$/)?.[1] as
    "catchmind" | "kuji" | "claw" | undefined;
  useEffect(() => {
    if (demo && gameId) setSample({ id: gameId, game: sampleGame(gameId) });
  }, [demo, gameId]);
  const home = () => navigate(demo ? "/preview" : "/");
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
  let content: React.ReactNode;
  if (demo) {
    if (play) content = <PreviewGames key={play} game={play} onBack={home} />;
    else if (gameId && sample?.id === gameId)
      content = (
        <PredictionGame
          key={`demo-${gameId}`}
          game={sample.game}
          user={
            gameId === "luck"
              ? { ...demoUser, username: "siwon", displayName: "siwon" }
              : demoUser
          }
          serverTime={new Date().toISOString()}
          demo
          onBack={home}
          onSave={async () => {}}
          onReveal={async () => {}}
        />
      );
    else content = <Home data={null} demo />;
  } else if (loading)
    content = (
      <div className="loading-page" role="status">
        <Character username="min" />
        <p>예굼방 문을 여는 중…</p>
      </div>
    );
  else if (!data)
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
                serverClockOffset.current =
                  Date.parse(next.serverTime) - Date.now();
                setData(next);
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
  else if (play)
    content = <PreviewGames key={play} game={play} onBack={home} />;
  else if (gameId) {
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
        onSave={(value, hint, author) =>
          mutate(
            () =>
              author
                ? api.answer(gameId, value, hint, game.roundDate)
                : api.predict(gameId, value, game.roundDate),
            (result) =>
              setData((prev) =>
                prev
                  ? {
                      ...prev,
                      games: prev.games.map((g) =>
                        g.id === gameId ? result.game : g,
                      ),
                    }
                  : prev,
              ),
          )
        }
        onReveal={() =>
          mutate(
            () => api.reveal(gameId, game.roundDate),
            (result) =>
              setData((prev) =>
                prev
                  ? {
                      ...prev,
                      games: prev.games.map((g) =>
                        g.id === gameId ? result.game : g,
                      ),
                    }
                  : prev,
              ),
          )
        }
      />
    ) : (
      <div className="empty-state">
        게임을 찾을 수 없어요.
        <button className="text-button" onClick={home}>
          홈으로 돌아가기
        </button>
      </div>
    );
  } else if (path === "/profile")
    content = (
      <Profile
        data={data}
        onLogout={() =>
          mutate(api.logout, () => {
            setData(null);
            navigate("/login");
          })
        }
      />
    );
  else if (path === "/ranking") content = <Ranking data={data} />;
  else content = <Home data={data} />;
  return (
    <>
      <aside className="desktop-brand" aria-hidden="true">
        <span className="wordmark">
          예굼방<span>3</span>
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
      <main className="app-shell">
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
        {content}
      </main>
    </>
  );
}
