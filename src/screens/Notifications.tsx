import { useCallback, useEffect, useState } from "react";
import { NOTIFICATION_RULES, notificationText, type AppNotification } from "../../shared/notifications";
import { Toolbar, honorific, useDisplayNameByIdLookup } from "../components/UI";
import { api } from "../api";
import { formatDateTime } from "../format";
import { previewNotifications } from "../notifications-preview";

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

export function Notifications({ demo, viewerId, onBack, go }: {
  demo: boolean; viewerId: string; onBack: () => void; go: (path: string) => void;
}) {
  const displayNameOf = useDisplayNameByIdLookup();
  const nameOf = useCallback((actorId: string) => honorific(displayNameOf(actorId, "")), [displayNameOf]);
  const [items, setItems] = useState<AppNotification[] | null>(null);
  const [nextBefore, setNextBefore] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [loadingMore, setLoadingMore] = useState(false);
  useEffect(() => {
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
  }, [demo, viewerId]);
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
    <div className="screen-body stack">
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
    </div>
  </div>;
}

/** Shown next to the bell; the cap keeps a long absence readable. */
export function unreadLabel(unread: number): string {
  return unread > NOTIFICATION_RULES.unreadCap ? `${NOTIFICATION_RULES.unreadCap}+` : String(unread);
}
