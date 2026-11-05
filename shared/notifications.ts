/** Notification payloads and their wording, shared by the Worker, the bell, the
 * notification centre, the toast and the preview. The Worker stores only the
 * numbers and who it is about, so a name or nickname tag that changes later
 * still reads correctly, and every screen words a notification the same way. */
export const NOTIFICATION_RULES = {
  /** A notification this new still pops up as a toast when it arrives. */
  toastMs: 10 * 60_000,
  /** Rows carried in bootstrap for the toast; the centre pages the rest. */
  recentLimit: 5,
  pageSize: 20,
  /** Older notifications are deleted by the nightly housekeeping. */
  retentionDays: 30,
  /** The badge stops counting here, so a long absence stays cheap to read. */
  unreadCap: 99,
  titleMax: 40, bodyMax: 200,
} as const;

import { subjectParticle } from './stock-news-templates';

export type NotificationKind = 'lotto' | 'speetto' | 'rank' | 'game' | 'stock' | 'admin';

export type NotificationPayload =
  | { kind: 'lotto'; rank: number; prize: number }
  | { kind: 'speetto'; prize: number }
  | { kind: 'rank'; period: 'week' | 'month'; place: number; gold: number }
  | { kind: 'game'; game: string; title: string; answer: string }
  | { kind: 'turn'; game: 'catchmind' }
  | { kind: 'stock'; event: 'delisted' | 'whale'; ticker: string; name: string; detail: string }
  | { kind: 'admin'; title: string; body: string };

export interface AppNotification {
  id: number;
  /** Whose news it is, when it is about a player. */
  actorId: string | null;
  payload: NotificationPayload;
  createdAt: string;
  /** Newer than the reader's watermark when the list was read. */
  unread: boolean;
}
export interface NotificationSummary {
  unread: number;
  /** Newest first; the toast picks the ones that just arrived. */
  recent: AppNotification[];
}
export interface NotificationsResponse {
  notifications: AppNotification[];
  nextBefore: string | null;
  unread: number;
  serverTime: string;
}

const gold = (value: number) => `${value.toLocaleString('ko-KR')}G`;
/** 을/를 after a company name, by the final syllable's batchim. */
function objectParticle(name: string): string {
  const code = name.charCodeAt(name.length - 1) - 0xAC00;
  return code >= 0 && code < 11172 && code % 28 !== 0 ? '을' : '를';
}
/** The same wording the game screens use: `07:12:30` reads as `7시 12분 30초`. */
function answerText(game: string, answer: string): string {
  if (game === 'luck') return `${answer}점`;
  const match = /^(\d{2}):(\d{2}):(\d{2})$/.exec(answer);
  return match ? `${Number(match[1])}시 ${match[2]}분 ${match[3]}초` : answer;
}

/** `name` turns an account id into a display name; it is only called for
 * notifications that are about a player. */
export function notificationText(notification: AppNotification, name: (userId: string) => string):
{ title: string; body: string; link: string | null; emoji: string } {
  const payload = notification.payload;
  // An unknown account (a deleted player, say) simply drops the subject.
  const who = notification.actorId ? `${name(notification.actorId)}이 `.replace(/^이 $/, '') : '';
  switch (payload.kind) {
    case 'lotto':
      return { title: `${who}데일리 로또 ${payload.rank}등에 당첨됐어요`, body: `+${gold(payload.prize)}`,
        link: '#/shop/lotto', emoji: '🎉' };
    case 'speetto':
      return { title: `${who}스피또에 당첨됐어요`, body: `+${gold(payload.prize)}`,
        link: '#/shop/speetto', emoji: '🎉' };
    case 'rank':
      return { title: `${payload.period === 'week' ? '주간' : '월간'} 랭킹 ${payload.place}위 보상이 들어왔어요`,
        body: `+${gold(payload.gold)}`, link: '#/ranking', emoji: '🏆' };
    case 'game':
      return { title: `${payload.title} 정답이 공개됐어요`, body: `정답은 ${answerText(payload.game, payload.answer)}`,
        link: `#/game/${payload.game}`, emoji: '🎯' };
    case 'turn':
      return { title: '캐치마인드 내 차례예요', body: '그림을 그릴 차례가 돌아왔어요.',
        link: '#/play/catchmind', emoji: '✏️' };
    case 'stock':
      return payload.event === 'delisted'
        ? { title: `${payload.name}${subjectParticle(payload.name)} 상장폐지됐어요`, body: payload.detail, link: '#/stock', emoji: '📉' }
        : { title: `익명의 큰손이 ${payload.name}${objectParticle(payload.name)} 움직였어요`, body: payload.detail, link: '#/stock', emoji: '🐋' };
    case 'admin':
      return { title: payload.title, body: payload.body, link: null, emoji: '📣' };
  }
}

/** The toast only shows other people's fresh news, exactly as it did before. */
export function isToastWorthy(notification: AppNotification, viewerId: string, serverNow: number): boolean {
  const age = serverNow - Date.parse(notification.createdAt);
  return notification.actorId !== viewerId && age >= 0 && age < NOTIFICATION_RULES.toastMs;
}
