import { useServerOffset } from "./clock";
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
  /** Tapping a notice that is about a screen opens it. */
  go: (path: string) => void;
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
export function NotificationToast({ notifications, userId, preview, serverTime, go }: Props) {
  if (preview || !userId) return null;
  return <ToastQueue key={userId} notifications={notifications} userId={userId} serverTime={serverTime} go={go} />;
}
function ToastQueue({ notifications, userId, serverTime, go }: Omit<Props, 'preview'> & { userId: string }) {
  const nameOf = useDisplayNameByIdLookup();
  const [seen] = useState(() => readSeen(userId));
  const [queue, setQueue] = useState<AppNotification[]>([]);
  const clock = useRef({ server: Date.parse(serverTime), received: performance.now() });
  const current = queue[0];

  const offset = useServerOffset(serverTime);
  useEffect(() => {
    clock.current = { server: Date.now() + offset, received: performance.now() };
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
  }, [notifications, offset, userId, seen]);

  useEffect(() => {
    if (!current) return;
    seen.add(current.id);
    try { localStorage.setItem(storageKey(userId), JSON.stringify([...seen])); } catch { /* Seen ids still persist for this session if storage is unavailable. */ }
    const timer = window.setTimeout(() => {
      const serverNow = clock.current.server + performance.now() - clock.current.received;
      const achievement = current.payload.kind === 'achievement';
      setQueue(previous => previous.filter(item => item.id !== current.id && !(achievement && item.payload.kind === 'achievement')
        && isToastWorthy(item, userId, serverNow)));
    }, ANNOUNCEMENT_RULES.displayMs);
    return () => window.clearTimeout(timer);
  }, [current?.id, seen, userId]);

  // Several achievements earned at once (a first visit can complete a handful)
  // share one toast, so the screen is not covered for a minute of banners.
  const grouped = current?.payload.kind === 'achievement' ? queue.filter(item => item.payload.kind === 'achievement') : [];
  const groupIds = new Set(grouped.map(item => item.id));
  useEffect(() => {
    if (grouped.length < 2) return;
    for (const item of grouped) seen.add(item.id);
    try { localStorage.setItem(storageKey(userId), JSON.stringify([...seen])); } catch { /* As above. */ }
  }, [current?.id, grouped.length, seen, userId]);
  function dismiss() {
    const serverNow = clock.current.server + performance.now() - clock.current.received;
    setQueue(previous => previous.filter(item => item.id !== current?.id && !groupIds.has(item.id) && isToastWorthy(item, userId, serverNow)));
  }
  const single = current ? notificationText(current, actorId => honorific(nameOf(actorId, ''))) : null;
  const text = single && grouped.length > 1
    ? { ...single, title: `도전과제 ${grouped.length}개 달성!`, body: '눌러서 보상 받기' } : single;
  // The body opens the screen the notice is about (or just dismisses it when
  // there is none); the × always only dismisses.
  return <div className="announcement-region" role={current ? 'status' : undefined} aria-live="polite" aria-atomic="true">
    {current && text && <div className="announcement-banner" key={current.id}>
      <button className="announcement-open" type="button"
        onClick={() => { dismiss(); if (text.link) go(text.link.replace(/^#/, '')); }}
        aria-label={`${text.title}. ${text.body}. ${text.link ? '열기' : '알림 닫기'}`}>
        <span className="announcement-celebration" aria-hidden="true">{text.emoji}</span>
        <span className="announcement-message">{text.title}<strong>{text.body}</strong></span>
      </button>
      <button className="announcement-close" type="button" aria-label="알림 닫기" onClick={dismiss}>
        <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="m6 6 12 12M18 6 6 18" /></svg>
      </button>
    </div>}
  </div>;
}
