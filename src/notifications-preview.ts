import { NOTIFICATION_RULES, type AppNotification, type NotificationsResponse } from '../shared/notifications';

/** The serverless preview shows the same five kinds the server can send, with a
 * fixed seed so the screen looks the same on every visit. Nothing is stored. */
const MINUTE = 60_000;
function seed(viewerId: string, now: Date): AppNotification[] {
  const at = (minutes: number) => new Date(now.getTime() - minutes * MINUTE).toISOString();
  return [
    { id: 6, actorId: null, createdAt: at(3), unread: true,
      payload: { kind: 'admin', title: '이번 주 토요일은 쉬어요', body: '기상시간 맞히기는 일요일에 다시 열려요.' } },
    { id: 5, actorId: viewerId, createdAt: at(40), unread: true,
      payload: { kind: 'rank', period: 'week', place: 2, gold: 1360 } },
    { id: 4, actorId: 'siwon', createdAt: at(90), unread: false,
      payload: { kind: 'lotto', rank: 3, prize: 1000 } },
    { id: 3, actorId: null, createdAt: at(180), unread: false,
      payload: { kind: 'game', game: 'wake', title: '기상시간 맞히기', answer: '07:12:30' } },
    { id: 2, actorId: null, createdAt: at(300), unread: false,
      payload: { kind: 'stock', event: 'whale', ticker: 'YKHX', name: 'YK하이커스', detail: '120주 매수 · 186,000G' } },
    { id: 1, actorId: 'min', createdAt: at(720), unread: false,
      payload: { kind: 'speetto', prize: 1500 } },
  ];
}
export function previewNotifications(viewerId: string, before?: string): NotificationsResponse {
  const now = new Date();
  const all = seed(viewerId, now);
  const cursor = before ? Number(before.split('|')[1] ?? '0') : Number.POSITIVE_INFINITY;
  const page = all.filter(notification => notification.id < cursor).slice(0, NOTIFICATION_RULES.pageSize);
  const last = page[page.length - 1];
  const more = last ? all.some(notification => notification.id < last.id) : false;
  return { notifications: page, unread: 0, serverTime: now.toISOString(),
    nextBefore: more && last ? `${last.createdAt}|${last.id}` : null };
}
/** The bell badge and the toast queue use the same seed before any API exists. */
export function previewNotificationSummary(viewerId: string) {
  const now = new Date();
  const all = seed(viewerId, now);
  return { unread: all.filter(notification => notification.unread).length,
    recent: all.slice(0, NOTIFICATION_RULES.recentLimit) };
}