import { useCallback, useEffect, useState } from "react";
import { NOTIFICATION_RULES, notificationText, type AppNotification } from "../../shared/notifications";
import { NOTICES, noticeDateText, type Notice } from "../../shared/notices";
import { Segmented, Toolbar, honorific, useDisplayNameByIdLookup } from "../components/UI";
import { api } from "../api";
import { formatDateTime } from "../format";
import { previewNotifications } from "../notifications-preview";
import { NOTICES_PATH } from "./notices-path";

/** One line of the centre: who it is about, what happened, and when. */
function Row({ notification, nameOf, go }: {
  notification: AppNotification; nameOf: (userId: string) => string; go: (path: string) => void;
}) {
  const text = notificationText(notification, nameOf);
  const body = <>
    <span className="notification-emoji" aria-hidden="true">{text.emoji}</span>
    <span className="notification-text">
      <strong>{text.title}</strong>
      {text.body && <span>{text.body}</span>}
      <small>{formatDateTime(notification.createdAt)}</small>
    </span>
    {notification.unread && <span className="notification-dot" aria-label="안 읽음" />}
  </>;
  const className = `notification-row${notification.unread ? " unread" : ""}`;
  return text.link
    ? <button type="button" className={className} onClick={() => go(text.link!.replace(/^#/, ""))}>{body}</button>
    : <div className={className}>{body}</div>;
}

/** One 공지 as a post: date and title in the list; opening it shows what changed and marks it read. */
function NoticePost({ notice, unread, open, onToggle }: { notice: Notice; unread: boolean; open: boolean; onToggle: () => void }) {
  return <article className={`card notice-post${unread ? " unread" : ""}${open ? " open" : ""}`}>
    <button type="button" className="notice-head" aria-expanded={open} aria-controls={`notice-${notice.id}`} onClick={onToggle}>
      <span className="notice-meta"><time dateTime={notice.date}>{noticeDateText(notice.date)}</time>{unread && <i className="notice-new">NEW</i>}</span>
      <strong>{notice.title}</strong>
      <span className="notice-summary">{notice.summary}</span>
      <span className="notice-more" aria-hidden="true">{open ? "접기" : "자세히 보기"}</span>
    </button>
    {open && <div className="notice-body" id={`notice-${notice.id}`}>
      <ul>{notice.items.map(item => <li key={item.title}><strong>{item.title}</strong><p>{item.body}</p></li>)}</ul>
    </div>}
  </article>;
}

export type NotificationTab = "notifications" | "notices";
export function Notifications({ demo, viewerId, onBack, go, tab, noticesRead, onNoticesRead }: {
  demo: boolean; viewerId: string; onBack: () => void; go: (path: string) => void;
  /** Which side of the 알림 | 공지 toggle is showing (the route decides). */
  tab: NotificationTab;
  /** Ids of the notices this reader has opened, and what to call when one more is. */
  noticesRead: readonly string[]; onNoticesRead: (ids: string[]) => void;
}) {
  const [openNotice, setOpenNotice] = useState<string | null>(null);
  /** Read marks as they were when the screen opened, so NEW stays on a post while it is being read. */
  const [readAtOpen] = useState(() => new Set(noticesRead));
  const unreadNotices = NOTICES.filter(notice => !noticesRead.includes(notice.id)).length;
  function toggleNotice(id: string) {
    setOpenNotice(current => (current === id ? null : id));
    if (!noticesRead.includes(id)) onNoticesRead([id]);
  }
  const displayNameOf = useDisplayNameByIdLookup();
  const nameOf = useCallback((actorId: string) => honorific(displayNameOf(actorId, "")), [displayNameOf]);
  const [items, setItems] = useState<AppNotification[] | null>(null);
  const [nextBefore, setNextBefore] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [loadingMore, setLoadingMore] = useState(false);
  // Reading the list marks the alarms read, so it waits until the 알림 side is actually showing.
  const showing = tab === "notifications";
  const [wanted, setWanted] = useState(showing);
  if (showing && !wanted) setWanted(true);
  useEffect(() => {
    if (!wanted) return;
    let active = true;
    const load = demo ? Promise.resolve(previewNotifications(viewerId)) : api.notifications();
    load.then(response => {
      if (!active) return;
      setItems(response.notifications);
      setNextBefore(response.nextBefore);
    }, (cause: unknown) => {
      if (active) setError(cause instanceof Error ? cause.message : "알림을 불러오지 못했어요.");
    });
    return () => { active = false; };
  }, [demo, viewerId, wanted]);
  async function loadMore() {
    if (!nextBefore || loadingMore) return;
    setLoadingMore(true);
    try {
      const next = demo ? previewNotifications(viewerId, nextBefore) : await api.notifications(nextBefore);
      setItems(previous => [...(previous ?? []), ...next.notifications]);
      setNextBefore(next.nextBefore);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "알림을 더 불러오지 못했어요.");
    } finally { setLoadingMore(false); }
  }
  return <div className="notifications">
    <Toolbar title="알림" onBack={onBack} />
    <div className="notifications-toggle">
      <Segmented label="알림 또는 공지" value={tab}
        options={[{ value: "notifications", label: "알림" }, { value: "notices", label: "공지", badge: unreadNotices }]}
        onChange={next => go(next === "notices" ? NOTICES_PATH : "/notifications")} />
    </div>
    {tab === "notices" ? <div className="screen-body stack" role="tabpanel" aria-label="공지">
      {NOTICES.length ? NOTICES.map(notice => <NoticePost key={notice.id} notice={notice} unread={!noticesRead.includes(notice.id) || (openNotice === notice.id && !readAtOpen.has(notice.id))}
        open={openNotice === notice.id} onToggle={() => toggleNotice(notice.id)} />)
        : <p className="history-empty">아직 올라온 공지가 없어요</p>}
      <p className="subtle-note">게임이 업데이트되면 여기에 소식을 올려요.</p>
    </div> : <div className="screen-body stack" role="tabpanel" aria-label="알림">
      {error && <p className="form-message error" role="alert">{error}</p>}
      <section className="card notification-list" aria-label="받은 알림">
        {items === null ? <p className="history-empty">알림을 불러오는 중…</p>
          : items.length ? items.map(notification =>
            <Row key={notification.id} notification={notification} nameOf={nameOf} go={go} />)
          : <p className="history-empty">아직 받은 알림이 없어요</p>}
        {nextBefore && <button type="button" className="text-button notification-more"
          disabled={loadingMore} onClick={() => void loadMore()}>{loadingMore ? "불러오는 중…" : "더 보기"}</button>}
      </section>
      <p className="subtle-note">알림은 {NOTIFICATION_RULES.retentionDays}일 동안 보관해요.</p>
    </div>}
  </div>;
}

/** Shown next to the bell; the cap keeps a long absence readable. */
export function unreadLabel(unread: number): string {
  return unread > NOTIFICATION_RULES.unreadCap ? `${NOTIFICATION_RULES.unreadCap}+` : String(unread);
}
