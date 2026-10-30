import type { GameState } from "../../shared/types";
import { claimToday, useAttendance } from "../attendance";
import {
  Avatar,
  Character,
  Chevron,
  Coin,
  SectionTitle,
  art,
  artSrc,
  type ArtKey,
} from "../components/UI";
import {
  BALANCE,
  kstDateText,
  kstParts,
  marketOpen,
  predictionPoints,
  rankOf,
  weekdayNames,
} from "../sample";

export interface HomePlayer {
  username: string;
  displayName: string;
  weeklyScore: number;
}
export interface HomeData {
  username: string;
  displayName: string;
  /** Key for device-local attendance claims. */
  attendanceKey: string;
  gold: number;
  players: HomePlayer[];
  games: GameState[];
}
type Go = (path: string) => void;

const chips = {
  avail: ["예측 가능", "#E3F6EE", "#2E8C6E"],
  closed: ["마감", "#F3EEE8", "#8A8190"],
  done: ["결과 공개", "#FFF1C7", "#94700A"],
  try: ["도전 가능", "#E3F6EE", "#2E8C6E"],
  open: ["진행 중", "#E3F1FC", "#3B7FB3"],
  host: ["출제", "#EEE8FC", "#7556C4"],
} as const;
type ChipKind = keyof typeof chips;
interface GameRow {
  path: string;
  name: string;
  icon: ArtKey;
  chip: ChipKind;
  sub: string;
  right: string;
}
const icons: Record<GameState["id"], ArtKey> = {
  wake: "moon",
  offwork: "manta",
  luck: "monkey",
};
const deadlines: Record<GameState["id"], string> = {
  wake: "10:30",
  offwork: "17:00",
  luck: "17:00",
};

export const isEvening = () => kstParts().hour >= 18;

function left(deadline: string, roundDate: string) {
  const at = /^\d{2}:\d{2}$/.test(deadline)
    ? Date.parse(`${roundDate}T${deadline}:00+09:00`)
    : Date.parse(deadline);
  const minutes = Math.max(0, Math.floor((at - Date.now()) / 60_000));
  const h = Math.floor(minutes / 60);
  return h ? `${h}시간 ${minutes % 60}분 남음` : `${minutes}분 남음`;
}
function predictionRow(game: GameState, me: string): GameRow {
  const unit = (value: string | null) =>
    value === null ? "" : game.id === "luck" ? `${value}점` : value;
  const row = {
    path: `/game/${game.id}`,
    name: game.title,
    icon: icons[game.id],
  };
  const author = game.authorUsername === me;
  if (game.phase === "revealed") {
    const mine = game.results.find((result) => result.username === me);
    const answer = `정답 ${unit(game.answer)}`;
    return {
      ...row,
      chip: "done",
      sub: mine ? `${answer} · 내 예측 ${unit(mine.value)}` : answer,
      right: mine ? `+${predictionPoints(rankOf(game.results, mine))}점` : "",
    };
  }
  if (author)
    return {
      ...row,
      chip: "host",
      sub:
        game.id === "wake"
          ? game.answerEntered
            ? "정답 입력 완료"
            : "정답 입력 대기"
          : game.id === "offwork"
            ? "퇴근하면 자동 공개"
            : "18:00 공개",
      right: deadlines[game.id],
    };
  if (game.phase === "closed")
    return {
      ...row,
      chip: "closed",
      sub: game.prediction ? `내 예측 ${unit(game.prediction)}` : "결과 대기",
      right: deadlines[game.id],
    };
  return {
    ...row,
    chip: "avail",
    sub: game.prediction
      ? `내 예측 ${unit(game.prediction)}`
      : game.id === "luck" && game.hint
        ? `힌트 「${game.hint.split(/[.。]/)[0]}」`
        : left(game.deadline, game.roundDate),
    right: deadlines[game.id],
  };
}
export function gameRows(games: GameState[], me: string): GameRow[] {
  const evening = isEvening();
  return [
    ...games.map((game) => predictionRow(game, me)),
    {
      path: "/play/catchmind",
      name: "캐치마인드",
      icon: "bread",
      ...(evening
        ? { chip: "done", sub: "정답 「눈사람」 · 내가 맞힘", right: `+${BALANCE.catchmind.points}점` }
        : { chip: "try", sub: "siwon의 그림 · 오답 2회", right: "" }),
    },
    {
      path: "/play/kuji",
      name: "예굼쿠지",
      icon: "drop",
      chip: "open",
      sub: evening ? "41 / 100칸 남음" : "63 / 100칸 남음",
      right: "",
    },
  ];
}

export function TodayGames({ data, go }: { data: HomeData; go: Go }) {
  const rows = gameRows(data.games, data.username);
  const earned = rows.reduce(
    (sum, row) => sum + (row.right.startsWith("+") ? parseInt(row.right.slice(1), 10) : 0),
    0,
  );
  return (
    <>
      <SectionTitle
        title="오늘의 게임"
        right={isEvening() ? `오늘 +${earned}점` : kstDateText()}
      />
      {rows.map((row) => {
        const [label, bg, fg] = chips[row.chip];
        return (
          <button key={row.path} className="card game-row" onClick={() => go(row.path)}>
            <span className="game-row-icon" style={{ background: art[row.icon].tint }}>
              <img className="character" src={artSrc(row.icon)} alt="" />
            </span>
            <span className="game-row-text">
              <strong>{row.name}</strong>
              <small>{row.sub}</small>
            </span>
            <span className="game-row-side">
              <span className="chip" style={{ background: bg, color: fg }}>
                {label}
              </span>
              {row.right && (
                <b className={row.right.startsWith("+") ? "gain" : ""}>{row.right}</b>
              )}
            </span>
          </button>
        );
      })}
    </>
  );
}

export function SoloGames({ go }: { go: Go }) {
  const tries = 3;
  const open = marketOpen();
  return (
    <>
      <SectionTitle title="혼자 하기" />
      <div className="tile-grid">
        <button className="card solo-tile" onClick={() => go("/play/claw")}>
          <span className="solo-icon" style={{ background: "#FFF4CC" }}>
            <img className="character" src={artSrc("cat")} alt="" />
          </span>
          <span className="solo-text">
            <strong>캐릭터 뽑기</strong>
            <small>오늘 남은 횟수</small>
          </span>
          <span className="tries">
            {Array.from({ length: BALANCE.claw.dailyTries }, (_, i) => (
              <i key={i} className={i < tries ? "on" : ""} />
            ))}
            <b>
              {tries}/{BALANCE.claw.dailyTries}
            </b>
          </span>
        </button>
        <button className="card solo-tile" onClick={() => go("/stock")}>
          <span className="solo-icon" style={{ background: open ? "#E3F6EE" : "#F3EEE8" }}>
            <svg width="34" height="26" viewBox="0 0 34 26" fill="none" stroke={open ? "#4FB892" : "#C9C0C8"} strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M2 20l7-7 6 5 8-10 9 6" />
            </svg>
          </span>
          <span className="solo-text">
            <strong>주식 시장</strong>
            <small>{open ? "내 수익 +1,240G" : "오늘 수익 +860G"}</small>
          </span>
          <span className={`market-state ${open ? "open" : ""}`}>
            <i />
            {open ? "장 열림" : "장 마감"}
          </span>
        </button>
      </div>
    </>
  );
}

export function ShopCards({ go }: { go: Go }) {
  const drawn = kstParts().hour >= BALANCE.lotto.drawHour;
  return (
    <div className="tile-grid">
      <button className="card shop-tile" onClick={() => go("/shop/lotto")}>
        <span className="lotto-icon" aria-hidden="true">
          <i>7</i>
          <i>12</i>
          <i>21</i>
        </span>
        <span className="solo-text">
          <strong>로또</strong>
          <small className={drawn ? "gain" : ""}>{drawn ? "4등 당첨" : "17:00 추첨"}</small>
        </span>
      </button>
      <button className="card shop-tile" onClick={() => go("/shop/speetto")}>
        <span className="speetto-icon" aria-hidden="true">
          <i>
            <b />
          </i>
        </span>
        <span className="solo-text">
          <strong>스피또</strong>
          <small>바로 긁기</small>
        </span>
      </button>
    </div>
  );
}

const rankColors = [
  ["#FFD866", "#7A5A00", "#FFD866"],
  ["#EEE8FC", "#7556C4", "#B9A3F0"],
  ["#E3F6EE", "#2E8C6E", "#A7E3CF"],
];
export function standings(players: HomePlayer[]) {
  const sorted = [...players].sort((a, b) => b.weeklyScore - a.weeklyScore);
  return sorted.map((player) => ({
    ...player,
    rank: sorted.findIndex((p) => p.weeklyScore === player.weeklyScore) + 1,
  }));
}
function settleText() {
  const days = 6 - kstParts().weekday;
  return days ? `정산까지 ${days}일` : "오늘 정산";
}

function AttendanceCard({ data, go }: { data: HomeData; go: Go }) {
  const { days, claimed, streak } = useAttendance(data.attendanceKey);
  const t = kstParts();
  const monday = new Date(Date.now() - t.weekday * 86_400_000);
  const week = weekdayNames.map((name, i) => {
    const date = new Date(monday.getTime() + i * 86_400_000);
    const key = new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Seoul" }).format(date);
    const today = i === t.weekday;
    return {
      name: today ? "오늘" : name,
      today,
      state: days.has(key) ? "claimed" : today ? "avail" : "locked",
      bonus: i === 6,
    };
  });
  const reached = week.filter((d) => d.state === "claimed").length;
  return (
    <section className="card attendance-card">
      <div className="attendance-head">
        <button className="attendance-title" onClick={() => go("/attendance")}>
          <strong>출석체크</strong>
          <small>
            {claimed
              ? `${streak}일 연속 · +${BALANCE.attendanceGold}G 받음`
              : `${streak + 1}일째 · +${BALANCE.attendanceGold}G`}
          </small>
        </button>
        {claimed ? (
          <span className="claim-button done">받음</span>
        ) : (
          <button className="claim-button" onClick={() => claimToday(data.attendanceKey)}>
            <Coin size={24} />
            받기
          </button>
        )}
      </div>
      <div className="week-path">
        <span className="week-track" />
        <span
          className="week-fill"
          style={{ width: `calc((100% - 36px) * ${Math.max(reached - 1, 0) / 6})` }}
        />
        {week.map((day) => (
          <div key={day.name} className={`week-day ${day.today ? "today" : ""}`}>
            <span className={`node ${day.state}`}>
              {day.state === "claimed" ? (
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="3.4" strokeLinecap="round" strokeLinejoin="round" aria-label="출석함">
                  <path d="M5 12.5l4.5 4.5L19 7.5" />
                </svg>
              ) : day.state === "avail" ? (
                "G"
              ) : day.bonus ? (
                "×2"
              ) : (
                ""
              )}
            </span>
            <small>{day.name}</small>
          </div>
        ))}
      </div>
    </section>
  );
}

function Room({ data, evening }: { data: HomeData; evening: boolean }) {
  return (
    <div className={`room ${evening ? "evening" : ""}`}>
      <div className="room-top">
        <span className="room-name">예굼방</span>
        <span className="gold">
          <Coin size={22} />
          {data.gold.toLocaleString("ko-KR")}
          <span className="sr-only"> 골드</span>
        </span>
      </div>
      <div className="room-window" aria-hidden="true">
        <div>
          <i className="room-orb" />
          <i className="room-cloud one" />
          <i className="room-cloud two" />
          <i className="room-bar v" />
          <i className="room-bar h" />
        </div>
      </div>
      <div className="room-frame" aria-hidden="true">
        <img src={artSrc("moon")} alt="" />
      </div>
      <div className="room-plant" aria-hidden="true">
        <div>
          <i />
          <i />
          <i />
        </div>
        <span />
      </div>
      <div className="room-floor" />
      <div className="room-rug" />
      <Character username={data.username} className="room-character" />
      <div className="room-fade" />
    </div>
  );
}

export function Home({ data, go }: { data: HomeData; go: Go }) {
  const evening = isEvening();
  const table = standings(data.players);
  const me = table.find((p) => p.username === data.username);
  const top = table[0];
  const max = Math.max(top?.weeklyScore ?? 0, 1);
  const rankLine = !me
    ? ""
    : me.rank === 1
      ? table[1]
        ? `2위 ${table[1].displayName}와 ${me.weeklyScore - table[1].weeklyScore}점 차`
        : "이번 주 1위"
      : `1위 ${top.displayName}까지 ${top.weeklyScore - me.weeklyScore}점`;
  return (
    <div className={`home ${evening ? "evening" : ""}`}>
      <Room data={data} evening={evening} />
      <div className="home-score">
        <div className="home-score-row">
          <div>
            <h1>{data.displayName}</h1>
            <p>
              <strong>{me?.weeklyScore ?? 0}</strong>
              <span>점</span>
            </p>
          </div>
          {me && <span className="rank-chip">주간 {me.rank}위</span>}
        </div>
        {rankLine && (
          <button className="rank-line" onClick={() => go("/ranking")}>
            {rankLine}
            <Chevron direction="right" size={14} width={2.6} />
          </button>
        )}
      </div>
      <div className="home-body">
        <AttendanceCard data={data} go={go} />
        <TodayGames data={data} go={go} />
        <SoloGames go={go} />
        <SectionTitle title="상점" right="전체" onClick={() => go("/shop")} />
        <ShopCards go={go} />
        <SectionTitle title="이번 주 랭킹" right={settleText()} />
        <button className="card ranking-preview" onClick={() => go("/ranking")}>
          {table.map((player) => {
            const [badgeBg, badgeFg, bar] = rankColors[Math.min(player.rank, 3) - 1];
            return (
              <span className="ranking-preview-row" key={player.username}>
                <span className="rank-dot" style={{ background: badgeBg, color: badgeFg }}>
                  {player.rank}
                </span>
                <Avatar username={player.username} size={46} />
                <span className="ranking-preview-main">
                  <span>
                    <strong>{player.displayName}</strong>
                    {player.username === data.username && <em>나</em>}
                    <b>{player.weeklyScore.toLocaleString("ko-KR")}</b>
                  </span>
                  <span className="bar">
                    <i style={{ width: `${Math.round((player.weeklyScore / max) * 100)}%`, background: bar }} />
                  </span>
                </span>
                <span className="reward-chip">
                  <Coin size={16} />
                  {(BALANCE.weeklyRewards[player.rank - 1] ?? 0).toLocaleString("ko-KR")}
                </span>
              </span>
            );
          })}
        </button>
      </div>
    </div>
  );
}
