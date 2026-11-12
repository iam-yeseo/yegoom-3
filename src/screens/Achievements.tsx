import { useEffect, useMemo, useRef, useState } from "react";
import { ACHIEVEMENT_GROUPS, ACHIEVEMENT_REPEAT_LABEL, ACHIEVEMENTS, achievementViews, type AchievementClaim, type AchievementGroup, type AchievementView, type AchievementsResponse } from "../../shared/achievements";
import { Coin, SectionTitle } from "../components/UI";
import { anim, coinFly, pop, toast } from "../motion";

/** Where the list comes from: the Worker, or the serverless preview's sample. */
export interface AchievementClient {
  load: () => Promise<AchievementsResponse>;
  /** Collects every listed row in one request. */
  claim: (claims: AchievementClaim[]) => Promise<AchievementsResponse>;
}
const GROUP_ORDER: readonly AchievementGroup[] = ["welcome", "games", "attendance", "shop", "stock", "claw", "ranking", "misc"];
const gold = (value: number) => `${value.toLocaleString("ko-KR")}G`;

function Row({ item, busy, onClaim }: { item: AchievementView; busy: boolean; onClaim: (button: HTMLButtonElement) => void }) {
  const repeat = ACHIEVEMENT_REPEAT_LABEL[item.repeat];
  const button = useRef<HTMLButtonElement>(null);
  return <div className={`achievement-row ${item.status}`} data-key={item.key}>
    <span className="achievement-mark" aria-hidden="true">
      {item.status === "claimed" ? <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3.2" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5" /></svg>
        : item.status === "unlocked" ? "🏅" : <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><rect x="5" y="11" width="14" height="10" rx="2" /><path d="M8 11V7a4 4 0 0 1 8 0v4" /></svg>}
    </span>
    <span className="achievement-text">
      <strong>{item.title}{repeat && <em className="achievement-repeat">{repeat}</em>}</strong>
      {/* A one-time achievement keeps its condition secret until it is earned;
          daily and weekly ones show it, since they are meant to be repeated. */}
      <small>{item.status === "locked" && item.repeat === "once" ? "달성하면 조건이 공개돼요" : item.condition}{item.repeat !== "once" && item.claimedCount > 0 ? ` · ${item.claimedCount}회 받음` : ""}</small>
    </span>
    {item.status === "unlocked"
      ? <button ref={button} type="button" className="achievement-claim" disabled={busy} onClick={() => onClaim(button.current!)}
        aria-label={`${item.title} 보상 ${gold(item.reward)} 받기`}><Coin size={16} />{gold(item.reward)} 받기</button>
      : <span className={`achievement-reward ${item.status}`}><Coin size={14} />{gold(item.reward)}</span>}
  </div>;
}

/** 게임 탭 › 도전과제: what the player has earned, what is still waiting, and
 * a 받기 button on each unlocked row (or 모두 받기 at the top). */
export function Achievements({ client, viewerId }: { client: AchievementClient; viewerId: string }) {
  const [data, setData] = useState<AchievementsResponse | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const summary = useRef<HTMLElement>(null);
  // The client object is rebuilt on every app render (each balance refresh);
  // reading it through a ref keeps the list from reloading and blinking.
  const clientRef = useRef(client); clientRef.current = client;
  const generation = useRef(0);
  useEffect(() => {
    const current = ++generation.current;
    setData(null); setError("");
    clientRef.current.load().then(next => { if (generation.current === current) setData(next); }, (cause: unknown) => {
      if (generation.current === current) setError(cause instanceof Error ? cause.message : "도전과제를 불러오지 못했어요.");
    });
    return () => { generation.current++; };
  }, [viewerId]);
  const views = useMemo(() => data ? achievementViews(data.progress, data.claimedCounts) : [], [data]);
  const unlocked = views.filter(item => item.status === "unlocked");
  const claimedOnce = views.filter(item => item.repeat === "once" && item.status === "claimed").length + views.filter(item => item.repeat !== "once" && item.claimedCount > 0).length;
  const waiting = unlocked.reduce((sum, item) => sum + item.reward, 0);
  async function claim(items: AchievementView[], from: HTMLElement | null) {
    if (pending.current || !items.length) return;
    pending.current = true; setBusy(true); setError("");
    const before = data?.gold ?? 0;
    const current = ++generation.current;
    const earned = items.reduce((sum, item) => sum + item.reward, 0);
    try {
      const next = await clientRef.current.claim(items.map(item => ({ key: item.key, periodKey: item.periodKey })));
      if (generation.current !== current) return;
      // Coins leave the button first; the list changes once, as they land.
      await new Promise<void>(resolve => coinFly(from?.isConnected ? from : summary.current, summary.current?.querySelector(".achievement-gold"), resolve, Math.min(10, 4 + items.length)));
      if (generation.current !== current) return;
      setData(next);
      pop(summary.current?.querySelector(".achievement-gold"), 1.15);
      toast(`+${gold(Math.max(0, next.gold - before) || earned)} 받았어요`);
    } catch (cause) {
      if (generation.current !== current) return;
      setError(cause instanceof Error ? cause.message : "보상을 받지 못했어요. 다시 시도해 주세요.");
      // The list may have moved on (another device claimed it); show the truth.
      clientRef.current.load().then(fresh => { if (generation.current === current) setData(fresh); }, () => undefined);
    } finally { pending.current = false; setBusy(false); }
  }
  useEffect(() => {
    if (data) anim(summary.current, [{ opacity: 0, translate: "0 8px" }, { opacity: 1, translate: "0 0" }], { dur: 220, ease: "out", fill: "none" });
  }, [data === null]);
  return <div className="screen-body stack achievements" aria-label="도전과제">
    {error && <p className="form-message error" role="alert">{error}</p>}
    {data === null ? !error && <p className="subtle-note" role="status">도전과제를 불러오는 중…</p> : <>
      <section className="card achievement-summary" ref={summary}>
        <div className="achievement-summary-main">
          <span className="achievement-summary-label">달성한 도전과제</span>
          <strong className="achievement-count">{claimedOnce + unlocked.length}<small>/ {ACHIEVEMENTS.length}</small></strong>
          <span className="bar"><i style={{ width: `${Math.round(((claimedOnce + unlocked.length) / ACHIEVEMENTS.length) * 100)}%` }} /></span>
        </div>
        <div className="achievement-summary-side">
          <span className="achievement-gold"><Coin size={16} />{gold(data.gold)}</span>
          {unlocked.length > 0
            ? <button type="button" className="achievement-claim all" disabled={busy} onClick={event => void claim(unlocked, event.currentTarget)}>
              {busy ? "받는 중…" : `${unlocked.length}개 모두 받기 · ${gold(waiting)}`}</button>
            : <span className="subtle-note">받을 보상이 없어요</span>}
        </div>
      </section>
      {GROUP_ORDER.map(group => {
        const items = views.filter(item => item.group === group);
        if (!items.length) return null;
        const done = items.filter(item => item.status !== "locked").length;
        return <section key={group} className="achievement-group">
          <SectionTitle title={ACHIEVEMENT_GROUPS[group]} right={`${done} / ${items.length}`} />
          <div className="card achievement-list">
            {items.map(item => <Row key={item.key} item={item} busy={busy} onClaim={button => void claim([item], button)} />)}
          </div>
        </section>;
      })}
      <p className="subtle-note">매일·매주 과제는 날이 바뀌면 다시 도전할 수 있어요. 받지 않은 보상은 사라지지 않아요.</p>
    </>}
  </div>;
}
