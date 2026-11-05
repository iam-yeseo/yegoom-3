import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { ATTENDANCE_RULES, attendanceRewardLabel, CATCHMIND_RULES, KUJI_RULES, LOTTO_RULES, NICKNAME_TAG_RULES, SLOT_RULES } from "../../shared/balance";
import { useShop } from "../shop";
import { formatTime, formatTimeSeconds } from "../format";
import type { CatchmindSummary, ClawSummary, GameState, KujiSummary, LottoNotice } from "../../shared/types";
import type { StockHomeSummary } from "../../shared/stock-types";
import { advanceNoticeOffset, hasSeenLotto, lottoSeenKey, markLottoSeen, nextKstMidnight, noticeDate } from "../lotto-notice";
import "../home-shop.css";
import { useAttendance } from "../attendance";
import { useLaunchGift, waitForAttendanceEffects } from "../launch-gift";
import {
  Avatar,
  PersonName,
  honorific,
  plainName,
  CharacterSprite,
  Chevron,
  Coin,
  SectionTitle,
  art,
  artSrc,
  preloadSprites,
  useCharacter,
  useDisplayNameLookup,
  type ArtKey,
  type CharState,
} from "../components/UI";
import {
  kstDateText,
  kstParts,
} from "../sample";
import {
  anim,
  coinFly,
  flip,
  toast,
  useCountUp,
  useOnChange,
} from "../motion";
import { rankSummary, standings, type RankingPlayer } from "../ranking";
import { unreadLabel } from "./Notifications";

export type HomePlayer = RankingPlayer;
export interface HomeData {
  userId: string;
  username: string;
  displayName: string;
  /** Legacy identity key; attendance itself is provided by the session context. */
  attendanceKey: string;
  gold: number;
  players: HomePlayer[];
  games: GameState[];
  /** Only the serverless preview uses the original example card. */
  kuji: KujiSummary | null;
  catchmind: CatchmindSummary;
  claw: ClawSummary;
  lottoNotice: LottoNotice | null;
  /** null while the market is not open to players. */
  stock: StockHomeSummary | null;
  /** Unread notifications behind the bell in the top right. */
  unreadNotifications: number;
  serverTime: string;
}
type Go = (path: string) => void;

const chips = {
  avail: ["예측 가능", "#E3F6EE", "#2E8C6E"],
  closed: ["마감", "#F3EEE8", "#8A8190"],
  done: ["결과 공개", "#FFF1C7", "#94700A"],
  try: ["도전 가능", "#E3F6EE", "#2E8C6E"],
  open: ["진행 중", "#E3F1FC", "#3B7FB3"],
  host: ["출제", "#EEE8FC", "#7556C4"],
  waiting: ["새 판 대기", "#F3EEE8", "#8A8190"],
  off: ["오늘은 쉬어요", "#F3EEE8", "#8A8190"],
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


export const isEvening = () => kstParts().hour >= 18;

function left(deadline: string, roundDate: string) {
  const at = /^\d{2}:\d{2}:\d{2}$/.test(deadline)
    ? Date.parse(`${roundDate}T${deadline}+09:00`)
    : Date.parse(deadline);
  const minutes = Math.max(0, Math.floor((at - Date.now()) / 60_000));
  const h = Math.floor(minutes / 60);
  return h ? `${h}시간 ${minutes % 60}분 남음` : `${minutes}분 남음`;
}
function predictionRow(game: GameState, me: string): GameRow {
  const unit = (value: string | null) =>
    value === null ? "" : game.id === "luck" ? `${value}점` : formatTimeSeconds(value);
  const row = {
    path: `/game/${game.id}`,
    name: game.title,
    icon: icons[game.id],
  };
  if (!game.rules.enabled) return { ...row, chip: "off", sub: "오늘은 이 게임을 쉬어요", right: "" };
  const author = game.authorUsername === me;
  if (game.phase === "revealed") {
    const mine = game.results.find((result) => result.username === me);
    const answer = `정답 ${unit(game.answer)}`;
    return {
      ...row,
      chip: "done",
      sub: mine ? `${answer} · 내 예측 ${unit(mine.value)}` : answer,
      right: mine ? `+${mine.score}점` : "",
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
            : "기상했어요로 바로 공개"
          : game.id === "offwork"
            ? "퇴근하면 자동 공개"
            : `${formatTime(game.rules.revealTime!)} 공개`,
      right: formatTime(game.rules.deadline),
    };
  if (game.phase === "closed")
    return {
      ...row,
      chip: "closed",
      sub: game.prediction ? `내 예측 ${unit(game.prediction)}` : "결과 대기",
      right: formatTime(game.rules.deadline),
    };
  return {
    ...row,
    chip: "avail",
    sub: game.prediction
      ? `내 예측 ${unit(game.prediction)}`
      : game.id === "luck" && game.hint
        ? `힌트 「${game.hint.split(/[.。]/)[0]}」`
        : left(game.rules.deadline, game.roundDate),
    right: formatTime(game.rules.deadline),
  };
}
type DisplayNameLookup = (username: string, fallback?: string) => string;
function catchmindRow(game: CatchmindSummary, me: string, displayNameOf: DisplayNameLookup): GameRow {
  const row = { path: "/play/catchmind", name: "캐치마인드", icon: "bread" as const, right: "" };
  if (game.status === "idle") return {
    ...row, chip: "try", sub: game.turn ? `${honorific(displayNameOf(game.turn.username, game.turn.displayName))}의 그리기 차례` : "먼저 그리기를 맡아 보세요",
  };
  const drawer = honorific(game.drawer ? displayNameOf(game.drawer.username, game.drawer.displayName) : "출제자");
  const mine = game.drawer?.username === me;
  if (game.status === "draft") return {
    ...row, chip: mine ? "host" : "open", sub: mine ? "내가 그림 그리는 중" : `${drawer}이 그림 그리는 중`,
  };
  if (game.status === "open") return {
    ...row, chip: mine ? "host" : "try", sub: `${mine ? "내 그림" : `${drawer}의 그림`} · 오답 ${game.wrongCount}회`,
  };
  const answer = game.answer ? `정답 「${game.answer}」` : "판 종료";
  return {
    ...row, chip: "done",
    sub: game.winner
      ? `${answer} · ${game.winner.username === me ? "내가 맞힘" : `${honorific(displayNameOf(game.winner.username, game.winner.displayName))} 정답`} · 다음 출제 ${game.turn ? honorific(displayNameOf(game.turn.username, game.turn.displayName)) : "대기"}`
      : `${answer} · 다음 출제 ${game.turn ? honorific(displayNameOf(game.turn.username, game.turn.displayName)) : drawer}`,
    right: game.winner?.username === me ? `+${CATCHMIND_RULES.score}점` : "",
  };
}
export function gameRows(games: GameState[], me: string, catchmind: CatchmindSummary, kuji: KujiSummary | null, displayNameOf: DisplayNameLookup = (username, fallback) => fallback ?? username): GameRow[] {
  return [
    ...games.map((game) => predictionRow(game, me)),
    catchmindRow(catchmind, me, displayNameOf),
    {
      path: "/play/kuji",
      name: "예굼쿠지",
      icon: "drop",
      chip: kuji?.remaining === 0 ? "waiting" : "open",
      sub: kuji !== null ? `남은 쿠지 ${kuji.remaining} / ${KUJI_RULES.size}` : isEvening() ? "41 / 100칸 남음" : "63 / 100칸 남음",
      right: "",
    },
  ];
}

export function TodayGames({ data, go }: { data: HomeData; go: Go }) {
  const displayNameOf = useDisplayNameLookup();
  const rows = gameRows(data.games, data.username, data.catchmind, data.kuji, displayNameOf);
  // Catchmind rounds can span several days; their result is not today's total.
  const earned = data.games.reduce(
    (sum, game) => sum + (game.phase === "revealed" ? game.results.find(result => result.username === data.username)?.score ?? 0 : 0),
    0,
  );
  return (
    <>
      <SectionTitle
        title="오늘의 게임"
        right={isEvening() ? `오늘 +${earned}점` : kstDateText()}
      />
      {rows.map((row) => (
        <GameRowButton key={row.path} row={row} go={go} />
      ))}
    </>
  );
}
/** A game row whose status chip flips when its state changes. */
function GameRowButton({ row, go }: { row: GameRow; go: Go }) {
  const [label, bg, fg] = chips[row.chip];
  const chip = useRef<HTMLSpanElement>(null);
  useOnChange(label, () => flip(chip.current));
  return (
          <button className="card game-row" onClick={() => go(row.path)}>
            <span className="game-row-icon" style={{ background: art[row.icon].tint }}>
              <img className="character" src={artSrc(row.icon)} alt="" />
            </span>
            <span className="game-row-text">
              <strong>{row.name}</strong>
              <small>{row.sub}</small>
            </span>
            <span className="game-row-side">
              <span className="chip" ref={chip} style={{ background: bg, color: fg }}>
                {label}
              </span>
              {row.right && (
                <b className={row.right.startsWith("+") ? "gain" : ""}>{row.right}</b>
              )}
            </span>
          </button>
  );
}

export function SoloGames({ go, claw, stock }: { go: Go; claw: ClawSummary; stock: StockHomeSummary | null }) {
  const nextGrant = formatTime(new Date(claw.nextGrantAt).toISOString());
  const open = !!stock?.open;
  const pnl = stock ? stock.value - stock.cost : 0;
  const pnlText = `${pnl > 0 ? "+" : pnl < 0 ? "−" : ""}${Math.abs(pnl).toLocaleString("ko-KR")}G`;
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
            <small>{claw.isAdmin ? "무제한 플레이 · 보상 없음" : <>코인 {claw.coins}개 · <span className="home-schedule">{nextGrant} 충전</span></>}</small>
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
            <small>{!stock ? "곧 문을 열어요" : stock.cost || stock.value ? `내 손익 ${pnlText}` : open ? "지금 거래할 수 있어요" : "10종목 상장 중"}</small>
          </span>
          <span className={`market-state ${open ? "open" : ""}`}>
            <i />
            {!stock ? "준비 중" : open ? "장 열림" : stock.holiday ? `휴장(${stock.holiday})` : "장 마감"}
          </span>
        </button>
      </div>
    </>
  );
}

export function ShopCards({ go }: { go: Go }) {
  const { inventory } = useShop();
  const tiles = [
    { path: "/shop/lotto", title: "데일리 로또", schedule: `${formatTime(LOTTO_RULES.drawTime)} 추첨`, tickets: inventory.lottoTickets, icon: "lotto" },
    { path: "/shop/speetto", title: "스피또", schedule: "바로 긁기", tickets: inventory.speettoTickets, icon: "speetto" },
    { path: "/shop/slot", title: "슬롯머신", schedule: `1회 ${SLOT_RULES.price.toLocaleString("ko-KR")}G`, tickets: null, icon: "slot" },
    { path: "/shop/tag", title: "별명 태그 뽑기", schedule: `1회 ${NICKNAME_TAG_RULES.price.toLocaleString("ko-KR")}G`, tickets: inventory.tagTickets, icon: "tag" },
  ] as const;
  return (
    <div className="tile-grid shop-tile-grid">
      {tiles.map(tile => <button key={tile.path} className="card shop-tile" onClick={() => go(tile.path)}>
        {tile.icon === "lotto" ? <span className="lotto-icon" aria-hidden="true"><i>7</i><i>12</i><i>21</i></span>
          : tile.icon === "speetto" ? <span className="speetto-icon" aria-hidden="true"><i><b /></i></span>
          : tile.icon === "tag" ? <span className="tag-tile-icon" aria-hidden="true"><i /></span>
          : <span className="slot-tile-icon" aria-hidden="true"><i /><i /><i /></span>}
        <span className="solo-text">
          <strong>{tile.title}</strong>
          <small className={tile.icon === "lotto" ? "home-schedule" : undefined}>{tile.schedule}</small>
          {tile.tickets !== null && <small>{tile.icon === "tag" ? "뽑기권" : "이용권"} {tile.tickets}장</small>}
        </span>
      </button>)}
    </div>
  );
}

function LottoNoticeCard({ data, go }: { data: HomeData; go: Go }) {
  const notice = data.lottoNotice;
  const [closedKey, setClosedKey] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const clock = useRef({ sample: "", offset: 0 });
  if (clock.current.sample !== data.serverTime) clock.current = { sample: data.serverTime,
    offset: advanceNoticeOffset(clock.current.sample ? clock.current.offset : null, data.serverTime, Date.now()) };
  const now = Date.now() + clock.current.offset;
  const current = notice?.drawDate === noticeDate(now);
  const key = notice ? lottoSeenKey(data.userId, notice.drawDate) : null;
  useEffect(() => {
    if (!current) return;
    const timer = window.setTimeout(() => setRevision(value => value + 1), Math.max(1, nextKstMidnight(now) - now));
    return () => clearTimeout(timer);
  }, [current, data.serverTime, notice?.drawDate, revision]);
  useEffect(() => {
    const changed = (event: StorageEvent) => { if (event.key === key || event.key === null) setRevision(value => value + 1); };
    window.addEventListener("storage", changed);
    return () => window.removeEventListener("storage", changed);
  }, [key]);
  if (!notice || !current || key === closedKey || hasSeenLotto(data.userId, notice.drawDate)) return null;
  const close = () => { markLottoSeen(data.userId, notice.drawDate); setClosedKey(key); };
  return <section className="card lotto-notice" aria-label="데일리 로또 결과 안내" data-draw-date={notice.drawDate}>
    <button type="button" className="lotto-notice-open" onClick={() => { close(); go("/shop/lotto"); }}>
      <span className="lotto-notice-copy"><strong>오늘 산 데일리 로또 {notice.tickets}장의 추첨이 끝났어요.</strong>
        <span>결과를 확인해 보세요 <Chevron direction="right" size={14} /></span></span>
    </button>
    <button type="button" className="lotto-notice-close" aria-label="데일리 로또 안내 닫기" onClick={close}>×</button>
  </section>;
}

const rankColors = [
  ["#FFD866", "#7A5A00", "#FFD866"],
  ["#EEE8FC", "#7556C4", "#B9A3F0"],
  ["#E3F6EE", "#2E8C6E", "#A7E3CF"],
];
function settleText() {
  const days = 6 - kstParts().weekday;
  return days ? `이번 주 종료까지 ${days}일` : "오늘 주간 집계 종료";
}

function AttendanceCard({ data, go, onClaimed }: {
  data: HomeData;
  go: Go;
  onClaimed: () => Promise<void>;
}) {
  const { today, claimed, cycleDay, reward, canClaim, claim } = useAttendance(data.attendanceKey);
  const gift = useLaunchGift();
  const [expanded, setExpanded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const pending = useRef(false);
  const mounted = useRef(true);
  const card = useRef<HTMLElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const contentId = useId();
  const collapsed = claimed && !expanded && !busy && !error;
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  useEffect(() => { setExpanded(false); setError(""); }, [today]);
  useEffect(() => { if (claimed && !busy) setError(""); }, [claimed, busy]);
  useEffect(() => {
    if (!collapsed) anim(content.current, [{ opacity: 0 }, { opacity: 1 }], { dur: 180, fill: "none" });
  }, [collapsed]);
  useOnChange(claimed, () => {
    if (claimed) anim(card.current?.querySelector(".week-day.today .node"), [
      { scale: "1.8", rotate: "-20deg", opacity: 0 },
      { scale: "1", rotate: "0deg", opacity: 1 },
    ], { dur: 420, ease: "spring" });
  });
  async function receive(button: HTMLElement) {
    if (pending.current || !canClaim) return;
    pending.current = true;
    const finishGiftWait = gift.beginAttendance();
    setBusy(true);
    setError("");
    try {
      const result = await claim();
      if (!mounted.current) return;
      if (result.awarded) {
        await new Promise<void>(resolve => coinFly(button, document.querySelector(".room-top .gold"), resolve));
        if (!mounted.current) return;
        toast(`+${attendanceRewardLabel(result.attendance.reward, result.attendance.today)} 받았어요`);
        await onClaimed();
        await waitForAttendanceEffects(card.current?.closest(".home") ?? null);
      } else toast("오늘 출석은 이미 완료했어요");
      if (mounted.current) setExpanded(false);
    } catch (e) {
      if (mounted.current) setError(e instanceof Error ? e.message : "출석하지 못했어요. 다시 시도해 주세요.");
    } finally {
      pending.current = false;
      finishGiftWait();
      if (mounted.current) setBusy(false);
    }
  }
  const completed = claimed ? cycleDay : cycleDay - 1;
  const week = Array.from({ length: ATTENDANCE_RULES.cycleLength }, (_, i) => ({
    day: i + 1,
    today: i + 1 === cycleDay,
    state: i < completed ? "claimed" : i + 1 === cycleDay && canClaim ? "avail" : "locked",
    bonus: i + 1 === ATTENDANCE_RULES.cycleLength,
  }));
  return <section className={`card attendance-card ${collapsed ? "collapsed" : ""}`} ref={card} aria-busy={busy}>
    {claimed && !busy && <button className="attendance-summary" aria-expanded={!collapsed} aria-controls={contentId} onClick={() => setExpanded(value => !value)}>
      <span>오늘 출석 완료 · {cycleDay}일째</span>
      <span className={`attendance-chevron ${collapsed ? "" : "expanded"}`} aria-hidden="true"><Chevron direction="right" size={18} /></span>
    </button>}
    <div id={contentId} ref={content} hidden={collapsed} className="attendance-content">
      <div className="attendance-head">
        <button className="attendance-title" onClick={() => go("/attendance")}>
          <strong>출석체크</strong>
          <small>{cycleDay}일째 · {attendanceRewardLabel(reward, today)}{claimed ? " 받음" : ""}</small>
        </button>
        {claimed && !busy ? <span className="claim-button done">받음</span> : canClaim || busy ?
          <button className="claim-button" disabled={busy} onClick={e => void receive(e.currentTarget)}>
            <Coin size={24} />{busy ? "받는 중…" : error ? "다시 받기" : "받기"}
          </button> : <span className="subtle-note">참여 불가</span>}
      </div>
      <div className="week-path" aria-label={`${ATTENDANCE_RULES.cycleLength}일 출석 진행`}>
        <span className="week-track" />
        <span className="week-fill" style={{ width: `calc((100% - 36px) * ${Math.max(completed - 1, 0) / (ATTENDANCE_RULES.cycleLength - 1)})` }} />
        {week.map(day => <div key={day.day} className={`week-day ${day.today ? "today" : ""}`}>
          <span className={`node ${day.state}`} aria-label={`${day.day}일째 ${day.state === "claimed" ? "출석 완료" : day.state === "avail" ? "출석 가능" : "출석 전"}`}>
            {day.state === "claimed" ? <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="3.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5" /></svg> : day.state === "avail" ? "G" : day.day}
          </span>
          <small>{day.day}일째</small>
          {day.bonus && <b className="cycle-bonus">{ATTENDANCE_RULES.cycleGold}G</b>}
        </div>)}
      </div>
      {error && <p className="form-message error" role="alert">{error}</p>}
    </div>
    {gift.available && !busy && <button className="attendance-gift-button" type="button" onClick={gift.openGift}>선물 받기</button>}
  </section>;
}

function Room({ data, gold, evening, jumpRequest, onJumpDone, go }: {
  data: HomeData;
  gold: number;
  go: Go;
  evening: boolean;
  jumpRequest: number;
  onJumpDone: () => void;
}) {
  const displayNameOf = useDisplayNameLookup();
  const shown = useCountUp(gold);
  const chosen = useCharacter(data.username);
  const [oneShot, setOneShot] = useState<CharState | null>(null);
  const playJump = useCallback(() => {
    setOneShot((state) => state === "jump" ? state : "jump");
  }, []);
  const finish = useCallback(() => {
    if (oneShot === "jump") onJumpDone();
    setOneShot(null);
  }, [oneShot, onJumpDone]);
  useEffect(() => {
    void preloadSprites(chosen, ["greet", "jump", "sleepy"]);
    // A server character refresh can interrupt a claim celebration. Release
    // its completion promise when this effect cancels the active jump.
    if (oneShot === "jump") onJumpDone();
    setOneShot(null);
    if (evening) return;
    const timer = window.setTimeout(() => setOneShot((state) => state ?? "greet"), 300);
    return () => window.clearTimeout(timer);
    // Reset only when the character or time-of-day scene changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chosen, evening, onJumpDone]);
  useOnChange(jumpRequest, playJump);
  return (
    <div className={`room ${evening ? "evening" : ""}`}>
      <div className="room-top">
        <span className="room-identity">
          <Avatar username={data.username} size={32} />
          <span className="room-identity-text">
            <span className="room-name"><PersonName username={data.username} fallback={data.displayName} /></span>
            <span className="gold"><Coin size={14} />{shown.toLocaleString("ko-KR")}<span className="sr-only"> 골드</span></span>
          </span>
        </span>
        <button type="button" className="room-bell" onClick={() => go("/notifications")}
          aria-label={data.unreadNotifications > 0 ? `알림 ${unreadLabel(data.unreadNotifications)}개 안 읽음` : "알림"}>
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M18 8a6 6 0 1 0-12 0c0 7-3 9-3 9h18s-3-2-3-9" /><path d="M13.7 21a2 2 0 0 1-3.4 0" />
          </svg>
          {data.unreadNotifications > 0 && <span className="room-bell-badge">{unreadLabel(data.unreadNotifications)}</span>}
        </button>
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
      <button
        className="room-character-button"
        aria-label="내 캐릭터"
        data-nopress
        onClick={playJump}
      >
        <span className="room-character-wrap">
          <CharacterSprite
            username={data.username}
            state={oneShot ?? (evening ? "sleepy" : "idle")}
            className={`room-character ${evening ? "sleepy" : ""}`}
            onDone={finish}
          />
        </span>
      </button>
      <div className="room-fade" />
    </div>
  );
}

export function Home({ data, go }: { data: HomeData; go: Go }) {
  const displayNameOf = useDisplayNameLookup();
  const evening = isEvening();
  const [jumpRequest, setJumpRequest] = useState(0);
  const jumpFinished = useRef<(() => void) | null>(null);
  const finishJump = useCallback(() => {
    jumpFinished.current?.();
    jumpFinished.current = null;
  }, []);
  useEffect(() => finishJump, [finishJump]);
  const celebrateClaim = () => new Promise<void>(resolve => {
    finishJump();
    jumpFinished.current = resolve;
    setJumpRequest(request => request + 1);
  });
  const table = useMemo(() => standings(data.players.map(player => ({
    ...player, displayName: displayNameOf(player.username, player.displayName),
  }))), [data.players, displayNameOf]);
  const me = table.find((p) => p.username === data.username);
  const top = table[0];
  const max = Math.max(top?.weeklyScore ?? 0, 1);
  const score = useCountUp(me?.weeklyScore ?? 0);
  const summary = rankSummary(table, data.username);
  return (
    <div className={`home ${evening ? "evening" : ""}`}>
      <Room data={data} gold={data.gold} evening={evening} jumpRequest={jumpRequest} onJumpDone={finishJump} go={go} />
      <div className="home-score">
        <div className="home-score-row">
          <div>
            <h1>이번 주 점수</h1>
            <p>
              <strong>{score}</strong>
              <span>점</span>
            </p>
          </div>
          {summary.chip && <span className="rank-chip">{summary.chip}</span>}
        </div>
        {summary.line && (
          <button className="rank-line" onClick={() => go("/ranking")}>
            {summary.line}
            <Chevron direction="right" size={14} width={2.6} />
          </button>
        )}
      </div>
      <div className="home-body">
        <AttendanceCard
          data={data}
          go={go}
          onClaimed={celebrateClaim}
        />
        <LottoNoticeCard data={data} go={go} />
        <TodayGames data={data} go={go} />
        <SoloGames go={go} claw={data.claw} stock={data.stock} />
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
                <Avatar username={player.username} size={46} nameFormat="plain" />
                <span className="ranking-preview-main">
                  <span>
                    <strong><PersonName username={player.username} fallback={player.displayName} honorific={false} /></strong>
                    {player.username === data.username && <em>나</em>}
                    <b>{player.weeklyScore.toLocaleString("ko-KR")}</b>
                  </span>
                  <span className="bar">
                    <i style={{ width: `${Math.round((player.weeklyScore / max) * 100)}%`, background: bar }} />
                  </span>
                </span>
              </span>
            );
          })}
        </button>
      </div>
    </div>
  );
}
