import { useEffect, useRef, useState } from 'react';
import { ANNOUNCEMENT_RULES } from '../shared/balance';
import { isToastWorthy, notificationText, type AppNotification } from '../shared/notifications';
import { honorific, useDisplayNameByIdLookup } from './components/UI';
import './announcements.css';

interface Props {
  notifications: AppNotification[];
  userId: string | null;
  preview: boolean;
  serverTime: string;
}
const storageKey = (userId: string) => `yegoom:announcements:seen:${userId}`;
function readSeen(userId: string): Set<number> {
  try {
    const ids: unknown = JSON.parse(localStorage.getItem(storageKey(userId)) ?? '[]');
    return new Set(Array.isArray(ids) ? ids.filter((id): id is number => Number.isSafeInteger(id) && id > 0) : []);
  } catch { return new Set(); }
}

/** Fresh notifications from other players pop up for four seconds; the
 * notification centre keeps every one of them. The keyed queue is discarded
 * immediately on logout, account switch, or preview. */
export function NotificationToast({ notifications, userId, preview, serverTime }: Props) {
  if (preview || !userId) return null;
  return <ToastQueue key={userId} notifications={notifications} userId={userId} serverTime={serverTime} />;
}
function ToastQueue({ notifications, userId, serverTime }: Omit<Props, 'preview'> & { userId: string }) {
  const nameOf = useDisplayNameByIdLookup();
  const [seen] = useState(() => readSeen(userId));
  const [queue, setQueue] = useState<AppNotification[]>([]);
  const clock = useRef({ server: Date.parse(serverTime), received: performance.now() });
  const current = queue[0];

  useEffect(() => {
    clock.current = { server: Date.parse(serverTime), received: performance.now() };
    const fresh = notifications.filter(item => isToastWorthy(item, userId, clock.current.server) && !seen.has(item.id));
    setQueue(previous => {
      const kept = previous.filter(item => isToastWorthy(item, userId, clock.current.server));
      const queued = new Set(kept.map(item => item.id));
      const added = fresh.filter(item => !queued.has(item.id))
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id - b.id);
      // Every refreshed bootstrap runs this effect. Keeping the same array when
      // nothing joined or expired spares the app a render on quiet screens.
      if (!added.length && kept.length === previous.length) return previous;
      return [...kept, ...added];
    });
  }, [notifications, serverTime, userId, seen]);

  useEffect(() => {
    if (!current) return;
    seen.add(current.id);
    try { localStorage.setItem(storageKey(userId), JSON.stringify([...seen])); } catch { /* Seen ids still persist for this session if storage is unavailable. */ }
    const timer = window.setTimeout(() => {
      const serverNow = clock.current.server + performance.now() - clock.current.received;
      setQueue(previous => previous.filter(item => item.id !== current.id && isToastWorthy(item, userId, serverNow)));
    }, ANNOUNCEMENT_RULES.displayMs);
    return () => window.clearTimeout(timer);
  }, [current?.id, seen, userId]);

  function dismiss() {
    const serverNow = clock.current.server + performance.now() - clock.current.received;
    setQueue(previous => previous.filter(item => item.id !== current?.id && isToastWorthy(item, userId, serverNow)));
  }
  const text = current ? notificationText(current, actorId => honorific(nameOf(actorId, ''))) : null;
  return <div className="announcement-region" role={current ? 'status' : undefined} aria-live="polite" aria-atomic="true">
    {current && text && <button className="announcement-banner" key={current.id} type="button" onClick={dismiss}
      aria-label={`${text.title}. ${text.body}. 알림 닫기`}>
      <span className="announcement-celebration" aria-hidden="true">{text.emoji}</span>
      <span className="announcement-message">{text.title}<strong>{text.body}</strong></span>
      <svg className="announcement-close" aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="m6 6 12 12M18 6 6 18" /></svg>
    </button>}
  </div>;
}
