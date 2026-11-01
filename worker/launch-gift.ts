import { LAUNCH_GIFT } from '../shared/balance';
import type { LaunchGiftResponse, LaunchGiftState } from '../shared/types';
import { kstDate, kstTimestamp } from './rules';
import { readInventory } from './shop';

interface Actor { id: string; role: 'player' | 'admin' }
interface Eligibility { active: number; attended: number; dayOpen: number; lotto: number; speetto: number }
export class LaunchGiftError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); }
}
const giftReference = (userId: string, item: 'lotto' | 'speetto') => `event:launch:${LAUNCH_GIFT.date}:${userId}:${item}`;
const dayStart = () => kstTimestamp(LAUNCH_GIFT.date, '00:00:00');

function eligibilityQuery(db: D1Database, userId: string): D1PreparedStatement {
  return db.prepare(`SELECT
    EXISTS (SELECT 1 FROM users WHERE id = ? AND role = 'player' AND active = 1) AS active,
    EXISTS (SELECT 1 FROM attendance WHERE user_id = ? AND date = ?) AS attended,
    unixepoch('now') * 1000 >= ? AND unixepoch('now') * 1000 < ? AS dayOpen,
    EXISTS (SELECT 1 FROM inventory_ledger WHERE reference = ?) AS lotto,
    EXISTS (SELECT 1 FROM inventory_ledger WHERE reference = ?) AS speetto`)
    .bind(userId, userId, LAUNCH_GIFT.date, dayStart(), dayStart() + 86_400_000,
      giftReference(userId, 'lotto'), giftReference(userId, 'speetto'));
}
function stateFrom(row: Eligibility, user: Actor, now: Date): LaunchGiftState {
  const claimed = Boolean(row.lotto && row.speetto);
  return { available: user.role === 'player' && Boolean(row.active && row.attended && row.dayOpen)
    && kstDate(now) === LAUNCH_GIFT.date && !claimed, claimed };
}
/** Fixed-reference and composite-PK lookups; no attendance or inventory history scan. */
export async function getLaunchGiftState(db: D1Database, user: Actor, now = new Date()): Promise<LaunchGiftState> {
  if (user.role !== 'player') return { available: false, claimed: false };
  const row = await eligibilityQuery(db, user.id).first<Eligibility>();
  return stateFrom(row!, user, now);
}

export async function claimLaunchGift(db: D1Database, user: Actor, now = new Date()): Promise<LaunchGiftResponse> {
  if (user.role !== 'player') throw new LaunchGiftError(403, 'CANNOT_CLAIM_GIFT', '플레이어만 런칭 선물을 받을 수 있어요.');
  if (kstDate(now) !== LAUNCH_GIFT.date) throw new LaunchGiftError(409, 'GIFT_CLOSED', '런칭 선물은 오픈 당일에만 받을 수 있어요.');
  const createdAt = now.toISOString();
  const writes = await db.batch([
    // Both gifts use one conditional statement, so even a batch crossing KST
    // midnight cannot insert one ticket kind before the other becomes ineligible.
    // A trigger failure rolls back both rows; UNIQUE references make retries safe.
    db.prepare(`WITH gifts (id, item, amount, reference) AS (VALUES (?, ?, ?, ?), (?, ?, ?, ?))
      INSERT OR IGNORE INTO inventory_ledger (id, user_id, item, amount, reason, reference, created_at)
      SELECT gifts.id, u.id, gifts.item, gifts.amount, '런칭 기념 선물', gifts.reference, ?
      FROM users u CROSS JOIN gifts WHERE u.id = ? AND u.role = 'player' AND u.active = 1
        AND EXISTS (SELECT 1 FROM attendance WHERE user_id = u.id AND date = ?)
        AND unixepoch('now') * 1000 >= ? AND unixepoch('now') * 1000 < ?`)
      .bind(crypto.randomUUID(), 'lotto_ticket', LAUNCH_GIFT.lottoTickets, giftReference(user.id, 'lotto'),
        crypto.randomUUID(), 'speetto_ticket', LAUNCH_GIFT.speettoTickets, giftReference(user.id, 'speetto'),
        createdAt, user.id, LAUNCH_GIFT.date, dayStart(), dayStart() + 86_400_000),
    eligibilityQuery(db, user.id),
  ]);
  const row = writes[1]!.results[0] as unknown as Eligibility;
  const awarded = writes[0]!.meta.changes > 0;
  if (!row.active) throw new LaunchGiftError(403, 'CANNOT_CLAIM_GIFT', '활성 플레이어만 런칭 선물을 받을 수 있어요.');
  // A successful write was eligible at its atomic write time. A queued request
  // that made no write after midnight must be rejected, including old retries.
  if (!awarded && !row.dayOpen) throw new LaunchGiftError(409, 'GIFT_CLOSED', '런칭 선물 기간이 끝났어요. 화면을 새로고침해 주세요.');
  if (!row.attended) throw new LaunchGiftError(409, 'ATTENDANCE_REQUIRED', '오늘 출석 체크를 먼저 해 주세요.');
  const launchGift = stateFrom(row, user, now);
  if (!launchGift.claimed) throw new LaunchGiftError(409, 'GIFT_UNAVAILABLE', '선물 상태를 새로고침하고 다시 시도해 주세요.');
  return { launchGift, inventory: await readInventory(db, user.id), awarded, serverTime: createdAt };
}
