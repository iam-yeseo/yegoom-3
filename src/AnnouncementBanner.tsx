import { useEffect, useRef, useState } from 'react';
import { ANNOUNCEMENT_RULES } from '../shared/balance';
import type { Announcement } from '../shared/types';
import { honorific, useDisplayNameByIdLookup } from './components/UI';
import './announcements.css';

interface Props {
  announcements: Announcement[];
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
function recent(announcement: Announcement, serverNow: number, userId: string): boolean {
  const age = serverNow - Date.parse(announcement.createdAt);
  return announcement.userId !== userId && age >= 0 && age < ANNOUNCEMENT_RULES.recentMs;
}

/** The keyed queue is discarded immediately on logout, account switch, or preview. */
export function AnnouncementBanner({ announcements, userId, preview, serverTime }: Props) {
  if (preview || !userId) return null;
  return <AnnouncementQueue key={userId} announcements={announcements} userId={userId} serverTime={serverTime} />;
}
function AnnouncementQueue({ announcements, userId, serverTime }: Omit<Props, 'preview'> & { userId: string }) {
  const nameOf = useDisplayNameByIdLookup();
  const [seen] = useState(() => readSeen(userId));
  const [queue, setQueue] = useState<Announcement[]>([]);
  const clock = useRef({ server: Date.parse(serverTime), received: performance.now() });
  const current = queue[0];

  useEffect(() => {
    clock.current = { server: Date.parse(serverTime), received: performance.now() };
    const fresh = announcements.filter(item => recent(item, clock.current.server, userId) && !seen.has(item.id));
    setQueue(previous => {
      const kept = previous.filter(item => recent(item, clock.current.server, userId));
      const queued = new Set(kept.map(item => item.id));
      const added = fresh.filter(item => !queued.has(item.id))
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id - b.id);
      return [...kept, ...added];
    });
  }, [announcements, serverTime, userId, seen]);

  useEffect(() => {
    if (!current) return;
    seen.add(current.id);
    try { localStorage.setItem(storageKey(userId), JSON.stringify([...seen])); } catch { /* Seen ids still persist for this session if storage is unavailable. */ }
    const timer = window.setTimeout(() => {
      const serverNow = clock.current.server + performance.now() - clock.current.received;
      setQueue(previous => previous.filter(item => item.id !== current.id && recent(item, serverNow, userId)));
    }, ANNOUNCEMENT_RULES.displayMs);
    return () => window.clearTimeout(timer);
  }, [current?.id, seen, userId]);

  function dismiss() {
    const serverNow = clock.current.server + performance.now() - clock.current.received;
    setQueue(previous => previous.filter(item => item.id !== current?.id && recent(item, serverNow, userId)));
  }
  const message = current ? `${honorific(nameOf(current.userId, current.displayName))}이 ${current.kind === 'lotto' ? `데일리 로또 ${current.rank}등` : '스피또'}에 당첨됐어요!` : '';
  return <div className="announcement-region" role={current ? 'status' : undefined} aria-live="polite" aria-atomic="true">
    {current && <button className="announcement-banner" key={current.id} type="button" onClick={dismiss} aria-label={`${message} +${current.prize.toLocaleString('ko-KR')}G. 알림 닫기`}>
      <span className="announcement-celebration" aria-hidden="true">🎉</span>
      <span className="announcement-message">{message}<strong>+{current.prize.toLocaleString('ko-KR')}G</strong></span>
      <svg className="announcement-close" aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="m6 6 12 12M18 6 6 18" /></svg>
    </button>}
  </div>;
}
