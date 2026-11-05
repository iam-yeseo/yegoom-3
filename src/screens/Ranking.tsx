import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { plainName, Avatar, PersonName, CharacterSprite, Segmented, Toolbar, preloadSprites, useCharacter, useDisplayNameLookup } from "../components/UI";
import { HistoryRow } from "../components/HistoryRow";
import { api } from "../api";
import { formatDateTime } from "../format";
import { previewRanking } from "../ranking-preview";
import { RANKING_RULES, type RankingPeriod } from "../../shared/ranking-periods";
import type { RankingHistoryEntry, RankingResponse } from "../../shared/types";
import { kstParts } from "../sample";
import { anim, confetti, dropIn, reduced, tween } from "../motion";
import { standings, type RankingPlayer } from "../ranking";

/** Heights fit the photo, the tag + nickname line and the score, in that order. */
const podiumStyle = {
  1: { height: 216, bg: "#FFE7A3", fg: "#94700A", size: 140, duration: "3s" },
  2: { height: 180, bg: "#EEE8FC", fg: "#7556C4", size: 120, duration: "3.4s" },
  3: { height: 154, bg: "#D9F2E8", fg: "#2E8C6E", size: 110, duration: "3.8s" },
} as const;
const badge = [
  ["#FFD866", "#5C4300"],
  ["#EEE8FC", "#7556C4"],
  ["#E3F6EE", "#2E8C6E"],
];

function weekOfMonth(date = new Date()) {
  const t = kstParts(date);
  return `${t.month}월 ${Math.ceil(t.day / 7)}주차`;
}
function duration(minutes: number) {
  const safe = Math.max(0, minutes);
  return `${Math.floor(safe / 1440) ? `${Math.floor(safe / 1440)}일 ` : ""}${Math.floor((safe % 1440) / 60)}시간 ${String(safe % 60).padStart(2, "0")}분`;
}
/** Minutes until the current KST day, week or month ends. */
function periodLeft(period: RankingPeriod, now: number) {
  const t = kstParts(new Date(now));
  const ofDay = t.hour * 60 + t.minute;
  if (period === "day") return duration(24 * 60 - ofDay);
  if (period === "week") return duration(7 * 24 * 60 - (t.weekday * 24 * 60 + ofDay));
  const days = new Date(Date.UTC(t.year, t.month, 0)).getUTCDate();
  return duration(days * 24 * 60 - ((t.day - 1) * 24 * 60 + ofDay));
}
const periodOptions = [
  { value: "day", label: "일간" }, { value: "week", label: "주간" }, { value: "month", label: "월간" },
] as const satisfies readonly { value: RankingPeriod; label: string }[];
const periodTitle: Record<RankingPeriod, string> = { day: "일간 랭킹", week: "주간 랭킹", month: "월간 랭킹" };
const chartTitle: Record<RankingPeriod, string> = { day: "게임별 점수", week: "요일별 점수", month: "주차별 점수" };
const PERIOD_KEY = "yegoom3:ranking-period";
function storedPeriod(): RankingPeriod {
  try {
    const value = localStorage.getItem(PERIOD_KEY);
    return value === "day" || value === "month" ? value : "week";
  } catch { return "week"; }
}
/** Same period within 30 seconds reuses the last response (per page load). */
const responseCache = new Map<string, { at: number; data: RankingResponse }>();

/** A score that counts up from 0 after `delay` ms. */
function CountFrom({ value, delay }: { value: number; delay: number }) {
  const [shown, setShown] = useState(reduced() ? value : 0);
  useEffect(() => {
    let stop = () => {};
    const t = setTimeout(() => {
      stop = tween(0, value, 700, (v) => setShown(Math.round(v)));
    }, reduced() ? 0 : delay);
    return () => {
      clearTimeout(t);
      stop();
    };
  }, [value, delay]);
  return <>{shown}</>;
}
/** Podium entrance: blocks rise 3rd → 2nd → 1st, characters drop onto them,
 * daily bars grow, then confetti for 1st place. */
function usePodiumEntrance(ref: { current: HTMLDivElement | null }) {
  useEffect(() => {
    const root = ref.current;
    if (!root) return;
    const places = [...root.querySelectorAll<HTMLElement>(".podium-place")];
    const order = (el: HTMLElement) => 3 - Number(el.dataset.rank);
    places.forEach((place) => {
      const delay = order(place) * 160;
      anim(place.querySelector(".podium-block"), [{ scale: "1 0" }, { scale: "1 1" }], { dur: 520, ease: "spring", delay });
    });
    root.parentElement?.querySelectorAll(".daily-bars i").forEach((bar, i) =>
      anim(bar, [{ scale: "1 0" }, { scale: "1 1" }], { dur: 520, ease: "spring", delay: 400 + i * 50 }),
    );
    const first = places.find((p) => p.dataset.rank === "1");
    const t = setTimeout(() => confetti(first?.querySelector(".podium-block"), { spread: 170 }), reduced() ? 0 : 1300);
    return () => clearTimeout(t);
  }, [ref]);
}

/** Keep the sprite on its first frame until the existing entrance has landed. */
function PodiumCharacter({ username, rank }: { username: string; rank: number }) {
  const key = useCharacter(username);
  const character = useRef<HTMLSpanElement>(null);
  const [landed, setLanded] = useState(reduced);
  useEffect(() => { void preloadSprites(key, ["idle", "happy"]); }, [key]);
  useEffect(() => {
    let active = true;
    setLanded(reduced());
    const entrance = dropIn(character.current, { delay: (3 - rank) * 160 + 240 });
    if (entrance) {
      void entrance.finished.then(() => { if (active) setLanded(true); }, () => {});
    } else setLanded(true);
    return () => { active = false; entrance?.cancel(); };
  }, [rank]);
  return (
    <span ref={character} className={`podium-character${landed ? " landed" : ""}`}>
      <CharacterSprite username={username} state={rank === 1 ? "happy" : "idle"} />
    </span>
  );
}

/** Load one period's ranking; the serverless preview computes the same shape locally. */
function useRankingData(period: RankingPeriod, demo: boolean, viewerId: string) {
  const displayNameOf = useDisplayNameLookup();
  const [data, setData] = useState<RankingResponse | null>(null);
  const [error, setError] = useState("");
  const [moreLoading, setMoreLoading] = useState(false);
  const generation = useRef(0);
  useEffect(() => {
    const current = ++generation.current;
    setError("");
    if (demo) { setData(previewRanking(period, viewerId, username => displayNameOf(username))); return; }
    const cached = responseCache.get(period);
    if (cached && Date.now() - cached.at < RANKING_RULES.clientCacheMs) { setData(cached.data); return; }
    setData(previous => previous?.period === period ? previous : null);
    api.ranking(period).then(next => {
      responseCache.set(period, { at: Date.now(), data: next });
      if (current === generation.current) setData(next);
    }, (cause: unknown) => {
      if (current === generation.current) setError(cause instanceof Error ? cause.message : "랭킹을 불러오지 못했어요.");
    });
  }, [period, demo, viewerId, displayNameOf]);
  const loadMore = useCallback(async () => {
    if (!data?.nextBefore || moreLoading) return;
    const current = generation.current;
    setMoreLoading(true);
    try {
      const cursor = data.nextBefore.split("|");
      const next = demo
        ? previewRanking(period, viewerId, username => displayNameOf(username), { createdAt: cursor[0]!, id: cursor.slice(1).join("|") })
        : await api.ranking(period, data.nextBefore);
      if (current !== generation.current) return;
      const merged = { ...data, history: [...data.history, ...next.history], nextBefore: next.nextBefore };
      if (!demo) responseCache.set(period, { at: responseCache.get(period)?.at ?? Date.now(), data: merged });
      setData(merged);
    } catch (cause) {
      if (current === generation.current) setError(cause instanceof Error ? cause.message : "기록을 더 불러오지 못했어요.");
    } finally { setMoreLoading(false); }
  }, [data, demo, period, viewerId, displayNameOf, moreLoading]);
  return { data, error, loadMore, moreLoading };
}

function ScoreHistory({ entries, nextBefore, loading, onMore }: {
  entries: RankingHistoryEntry[]; nextBefore: string | null; loading: boolean; onMore: () => void;
}) {
  const displayNameOf = useDisplayNameLookup();
  return <section className="card ranking-history" aria-label="점수 획득 기록">
    <div className="card-head"><h2>점수 획득 기록</h2></div>
    {entries.length ? entries.map(entry => <HistoryRow key={entry.id}
      leading={<Avatar userId={entry.userId} username={entry.username} size={32} nameFormat="plain" />}
      title={<><PersonName username={entry.username} fallback={entry.displayName} honorific={false} /><span className="ranking-history-game"> · {entry.label}</span></>}
      detail={formatDateTime(entry.createdAt)} amount={entry.amount} unit="점" />)
      : <p className="history-empty">아직 이 기간에 얻은 점수가 없어요</p>}
    {nextBefore && <button type="button" className="text-button ranking-more" disabled={loading} onClick={onMore}>{loading ? "불러오는 중…" : "더 보기"}</button>}
  </section>;
}

/** The reward rules as decided so far: weekly ranking gold is not paid yet
 * (docs/plan-v2.md "보류 사항", docs/decisions.md §주간 순위), so the card says so
 * instead of showing an amount. Add the amounts here once they are set. */
function RankingRewards() {
  return <details className="card ranking-rules">
    <summary>점수와 보상 규칙</summary>
    <ul>
      <li>주간 점수는 월요일부터 일요일(한국 시간)까지 모아 순위를 정하고, 다음 주에 0점부터 새로 시작해요. 골드 잔액은 그대로 남아요.</li>
      <li>점수가 같으면 공동 순위예요. 1위가 두 명이면 그다음 사람은 3위예요.</li>
      <li><strong>주간 순위 보상 골드는 아직 지급하지 않아요.</strong> 지금은 점수와 순위만 겨뤄요.</li>
      <li>순위별 보상 액수와 월말 랭킹 추가 보상은 정해지면 이 자리에 적어요.</li>
      <li>골드는 출석·게임 참여·1등 보상과 상점·주식에서 오고 가며, 점수와 따로 쌓여요. 주식 수익은 골드만 늘려요.</li>
    </ul>
  </details>;
}

export function Ranking({
  me,
  viewerId,
  gold,
  players,
  lastWeek,
  serverTime,
  demo = false,
  onBack,
}: {
  me: string;
  viewerId: string;
  gold: number;
  /** This week's bootstrap standings, shown until the weekly response arrives. */
  players: RankingPlayer[];
  lastWeek: { username: string; score: number }[] | null;
  serverTime?: string;
  demo?: boolean;
  onBack: () => void;
}) {
  const displayNameOf = useDisplayNameLookup();
  const [period, setPeriodState] = useState<RankingPeriod>(storedPeriod);
  const setPeriod = (next: RankingPeriod) => {
    setPeriodState(next);
    try { localStorage.setItem(PERIOD_KEY, next); } catch { /* The choice still applies for this visit. */ }
  };
  const ranking = useRankingData(period, demo, viewerId);
  const [now, setNow] = useState(() => serverTime ? Date.parse(serverTime) : Date.now());
  useEffect(() => {
    const offset = serverTime ? Date.parse(serverTime) - Date.now() : 0;
    setNow(Date.now() + offset);
    const timer = window.setInterval(() => setNow(Date.now() + offset), 30_000);
    return () => clearInterval(timer);
  }, [serverTime]);
  const loaded = ranking.data?.period === period ? ranking.data : null;
  const table = useMemo(() => standings(loaded
    ? loaded.standings.map(row => ({ id: row.userId, username: row.username, displayName: displayNameOf(row.username, row.displayName), weeklyScore: row.score, photoVersion: row.photoVersion }))
    : period === "week" ? players : []), [loaded, period, players, displayNameOf]);
  const lastWeekTable = useMemo(() => lastWeek ? standings(lastWeek.map(row => ({
    ...row, displayName: displayNameOf(row.username), weeklyScore: row.score,
  }))) : null, [lastWeek, displayNameOf]);
  // Second place on the left, first in the middle, third on the right.
  const podium = [table[1], table[0], table[2]].filter(Boolean);
  const buckets = loaded?.buckets ?? [];
  const max = Math.max(...buckets.map(bucket => bucket.score), 1);
  const lastWeekDate = new Date(now - 7 * 86_400_000);
  const t = kstParts(new Date(now));
  const root = useRef<HTMLDivElement>(null);
  usePodiumEntrance(root);
  const subtitle = period === "day" ? `${t.month}월 ${t.day}일 · 오늘 종료까지`
    : period === "week" ? `${weekOfMonth(new Date(now))} · 이번 주 종료까지` : `${t.month}월 · 이번 달 종료까지`;
  return (
    <div className="ranking" ref={root}>
      <div className="ranking-hero">
        <Toolbar title={periodTitle[period]} onBack={onBack} gold={gold} />
        <div className="ranking-period">
          <Segmented label="랭킹 기간" options={periodOptions} value={period} onChange={setPeriod} />
        </div>
        <div className="ranking-week">
          <span>
            {subtitle} <b>{periodLeft(period, now)}</b>
          </span>
        </div>
        <div className="podium">
          {podium.map((player) => {
            const style = podiumStyle[Math.min(player.rank, 3) as 1 | 2 | 3];
            return (
              <div key={player.username} className="podium-place" data-rank={Math.min(player.rank, 3)}>
                <PodiumCharacter
                  username={player.username}
                  rank={Math.min(player.rank, 3)}
                />
                <div
                  className="podium-block"
                  style={{ height: style.height, background: style.bg }}
                >
                  <span className="podium-rank" style={{ color: style.fg }}>
                    {player.rank}
                  </span>
                  <Avatar username={player.username} size={28} nameFormat="plain" />
                  <span className="podium-name">
                    <PersonName username={player.username} fallback={player.displayName} honorific={false} />
                  </span>
                  <strong>
                    <CountFrom value={player.weeklyScore} delay={(3 - Math.min(player.rank, 3)) * 160 + 500} />
                  </strong>
                </div>
              </div>
            );
          })}
        </div>
      </div>
      <div className="screen-body stack">
        {ranking.error && <p className="form-message error" role="alert">{ranking.error}</p>}
        <section className="card ranking-table" aria-label="전체 순위">
          <div className="card-head"><h2>전체 순위</h2><span>{periodTitle[period].replace(" 랭킹", "")}</span></div>
          {table.length ? table.map(row => (
            <div className="list-row" key={row.username}>
              <span className="rank-dot" style={{ background: badge[Math.min(row.rank, 3) - 1][0], color: badge[Math.min(row.rank, 3) - 1][1] }}>{row.rank}</span>
              <Avatar username={row.username} size={40} nameFormat="plain" />
              <strong><PersonName username={row.username} fallback={row.displayName} honorific={false} /></strong>
              <b>{row.weeklyScore.toLocaleString("ko-KR")}점</b>
            </div>
          )) : <p className="history-empty">{loaded || ranking.error ? "아직 참여한 플레이어가 없어요" : "순위를 불러오는 중…"}</p>}
        </section>
        <section className="card daily-card">
          <div className="card-head">
            <h2>{chartTitle[period]}</h2>
            <span>{plainName(me)}</span>
          </div>
          {buckets.length ? <div className="daily-bars" style={{ gridTemplateColumns: `repeat(${buckets.length}, 1fr)` }}>
            {buckets.map(bucket => (
              <div key={bucket.key} className={bucket.current ? "today" : ""}>
                <span>{bucket.future ? "" : bucket.score}</span>
                <i style={{
                  height: bucket.future ? 6 : Math.max(6, Math.round((bucket.score / max) * 70)),
                  background: bucket.current ? "#FF8E7A" : bucket.score ? "#FFE0D8" : "#F3EEE8",
                }} />
                <small>{period === "week" && bucket.current ? "오늘" : bucket.label}</small>
              </div>
            ))}
          </div> : <p className="history-empty">{loaded ? "아직 오늘 얻은 점수가 없어요" : "불러오는 중…"}</p>}
        </section>
        {loaded && <ScoreHistory entries={loaded.history} nextBefore={loaded.nextBefore} loading={ranking.moreLoading} onMore={() => void ranking.loadMore()} />}
        {lastWeekTable && (
          <section className="card last-week">
            <div className="card-head">
              <h2>지난주</h2>
              <span>{weekOfMonth(lastWeekDate)}</span>
            </div>
            {lastWeekTable.map((row) => (
              <div className="list-row" key={row.username}>
                <span
                  className="rank-dot"
                  style={{ background: badge[Math.min(row.rank, 3) - 1][0], color: badge[Math.min(row.rank, 3) - 1][1] }}
                >
                  {row.rank}
                </span>
                <Avatar username={row.username} size={40} nameFormat="plain" />
                <strong><PersonName username={row.username} fallback={row.displayName} honorific={false} /></strong>
                <b>{row.score}점</b>
              </div>
            ))}
          </section>
        )}
        <RankingRewards />
      </div>
    </div>
  );
}
