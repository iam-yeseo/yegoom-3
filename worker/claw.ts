import { CLAW_RULES } from '../shared/balance';
import { ADMIN_LIMITS, type AdminClawConfig } from '../shared/admin';
import { CLAW, MACHINE, createBoard, simulateAttempt, type Board } from '../shared/claw-physics';
import type { ClawCoinInput, ClawPlayInput, ClawResponse, ClawResult, ClawState, ClawSummary } from '../shared/types';
import { weekStart } from './rules';

interface Actor { id: string; role: 'player' | 'admin' }
interface WalletRow { free_coins: number; purchased_coins: number; last_grant_slot: number }
interface MachineRow extends WalletRow { board_json: string | null; generation: number; version: number; next_play_at: number }
interface AccountRow extends MachineRow { power_counter: number }
interface ConfigRow { payout_every: number; weak_pickup: number; weak_carry: number }
interface PlayRow { id: string; version: number; claw_x: number; stop: number | null; result_json: string }
interface PurchaseRow { id: string; quantity: 1 | 5; cost: number }
export class ClawError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); }
}
export const coinSlot = (now: number): number => Math.floor(now / CLAW_RULES.coinIntervalMs);
export const nextCoinGrant = (now: number): number => (coinSlot(now) + 1) * CLAW_RULES.coinIntervalMs;
const randomSeed = () => crypto.getRandomValues(new Uint32Array(1))[0]!;
export function randomUnit(): number { return randomSeed() / 0x100000000; }
const requestIdValid = (value: unknown): value is string => typeof value === 'string' && /^[a-zA-Z0-9_-]{16,80}$/.test(value);
const machineColumns = 'free_coins, purchased_coins, last_grant_slot, board_json, generation, version, next_play_at';

/** Only authenticated admin routes call this; regular claw responses omit it. */
export async function readAdminClawConfig(db: D1Database): Promise<AdminClawConfig> {
  const row = await db.prepare('SELECT payout_every, weak_pickup, weak_carry FROM claw_config WHERE id = 1').first<ConfigRow>();
  if (!row) throw new Error('Missing claw configuration');
  return { payoutEvery: row.payout_every, weakPickup: row.weak_pickup / 100, weakCarry: row.weak_carry / 100 };
}

export async function saveAdminClawConfig(db: D1Database, user: Actor, input: Record<string, unknown>, now: Date | number = Date.now()): Promise<AdminClawConfig> {
  if (user.role !== 'admin') throw new ClawError(403, 'ADMIN_ONLY', '운영자만 집게 힘을 바꿀 수 있어요.');
  const { payoutEvery, weakPickup, weakCarry } = input;
  const wholePercent = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)
    && value >= ADMIN_LIMITS.weakPowerPercent[0] / 100 && value <= ADMIN_LIMITS.weakPowerPercent[1] / 100
    && Math.abs(value * 100 - Math.round(value * 100)) < 1e-9;
  if (!Number.isInteger(payoutEvery) || Number(payoutEvery) < ADMIN_LIMITS.payoutEvery[0] || Number(payoutEvery) > ADMIN_LIMITS.payoutEvery[1]
    || !wholePercent(weakPickup) || !wholePercent(weakCarry)) {
    throw new ClawError(400, 'INVALID_CLAW_CONFIG', '강집게 주기와 약집게 힘의 범위를 확인해 주세요.');
  }
  const next: AdminClawConfig = { payoutEvery: payoutEvery as number, weakPickup, weakCarry };
  const id = crypto.randomUUID(); const createdAt = (now instanceof Date ? now : new Date(now)).toISOString();
  // Read the before value in the same transaction as the update. Concurrent
  // settings saves each leave an accurate audit entry, and either write rolls back.
  const result = await db.batch([
    db.prepare(`INSERT INTO admin_changes (id, admin_id, target, before_json, after_json, effective_from, created_at)
      SELECT ?, u.id, 'claw', json_object('payoutEvery', c.payout_every, 'weakPickup', c.weak_pickup / 100.0, 'weakCarry', c.weak_carry / 100.0), ?, ?, ?
      FROM claw_config c JOIN users u ON u.id = ? AND u.role = 'admin' AND u.active = 1 WHERE c.id = 1`)
      .bind(id, JSON.stringify(next), createdAt, createdAt, user.id),
    db.prepare(`UPDATE claw_config SET payout_every = ?, weak_pickup = ?, weak_carry = ?, updated_at = ?
      WHERE id = 1 AND EXISTS (SELECT 1 FROM admin_changes WHERE id = ?)`)
      .bind(next.payoutEvery, Math.round(next.weakPickup * 100), Math.round(next.weakCarry * 100), createdAt, id),
  ]);
  if (!result[0]!.meta.changes) throw new ClawError(403, 'ADMIN_ONLY', '활성 운영자만 집게 힘을 바꿀 수 있어요.');
  return next;
}

async function wallet(db: D1Database, user: Actor, now: number): Promise<WalletRow> {
  const slot = coinSlot(now);
  const read = () => db.prepare('SELECT free_coins, purchased_coins, last_grant_slot FROM claw_accounts WHERE user_id = ?').bind(user.id).first<WalletRow>();
  let row = await read();
  if (!row) {
    // A bootstrap request initializes only this wallet, never anybody else's
    // account or a physical board. No player/ledger/history scan is needed.
    await db.prepare(`INSERT OR IGNORE INTO claw_accounts (user_id, free_coins, last_grant_slot)
      SELECT id, ?, ? FROM users WHERE id = ? AND role = ? AND active = 1`)
      .bind(user.role === 'admin' ? 0 : CLAW_RULES.freeCoins, slot, user.id, user.role).run();
    row = await read();
  }
  if (!row) throw new ClawError(403, 'CANNOT_PLAY', '활성 계정에서만 기계를 사용할 수 있어요.');
  if (user.role === 'player' && row.last_grant_slot < slot) {
    // The watermark and replacement balance change together. Older in-flight
    // requests cannot refill a newer slot or erase purchased coins.
    await db.prepare(`UPDATE claw_accounts SET free_coins = ?, last_grant_slot = ?
      WHERE user_id = ? AND last_grant_slot < ?
      AND EXISTS (SELECT 1 FROM users WHERE id = ? AND role = 'player' AND active = 1)`)
      .bind(CLAW_RULES.freeCoins, slot, user.id, slot, user.id).run();
    row = (await read())!;
  }
  return row;
}
function summary(user: Actor, row: WalletRow | null, now: number): ClawSummary {
  const freeCoins = user.role === 'admin' ? 0 : row?.free_coins ?? 0;
  const purchasedCoins = user.role === 'admin' ? 0 : row?.purchased_coins ?? 0;
  return { coins: freeCoins + purchasedCoins, freeCoins, purchasedCoins, nextGrantAt: nextCoinGrant(now), serverNow: now, isAdmin: user.role === 'admin' };
}
export async function getClawSummary(db: D1Database, user: Actor, now = Date.now()): Promise<ClawSummary> {
  return summary(user, user.role === 'admin' ? null : await wallet(db, user, now), now);
}
async function machine(db: D1Database, user: Actor, now: number): Promise<MachineRow> {
  await wallet(db, user, now);
  const read = () => db.prepare(`SELECT ${machineColumns} FROM claw_accounts WHERE user_id = ?`).bind(user.id).first<MachineRow>();
  let row = (await read())!;
  if (row.board_json === null) {
    // This is one-time pile creation, not a play simulation. Existing machines
    // are read verbatim and never re-settled by GET or bootstrap.
    const board = createBoard(row.generation, randomSeed());
    await db.prepare(`UPDATE claw_accounts SET board_json = ? WHERE user_id = ? AND board_json IS NULL AND version = ?
      AND EXISTS (SELECT 1 FROM users WHERE id = ? AND role = ? AND active = 1)`)
      .bind(JSON.stringify(board), user.id, row.version, user.id, user.role).run();
    row = (await read())!;
    if (row.board_json === null) throw new ClawError(403, 'CANNOT_PLAY', '활성 계정에서만 기계를 사용할 수 있어요.');
  }
  return row;
}
export async function getClawState(db: D1Database, user: Actor, now = Date.now()): Promise<ClawState> {
  const account = await machine(db, user, now);
  return { ...summary(user, account, now), board: JSON.parse(account.board_json!) as Board,
    version: account.version, generation: account.generation, nextPlayAt: account.next_play_at };
}

async function priorPurchase(db: D1Database, user: Actor, input: ClawCoinInput): Promise<PurchaseRow | null> {
  const old = await db.prepare('SELECT id, quantity, cost FROM claw_coin_purchases WHERE user_id = ? AND request_id = ?')
    .bind(user.id, input.requestId).first<PurchaseRow>();
  if (old && old.quantity !== input.quantity) throw new ClawError(409, 'REQUEST_CONFLICT', '이미 다른 구매에 사용한 요청 번호예요.');
  return old;
}
export async function purchaseClawCoins(db: D1Database, user: Actor, input: Record<string, unknown>, now = Date.now()): Promise<ClawResponse> {
  if (user.role !== 'player') throw new ClawError(403, 'CANNOT_PURCHASE', '플레이어만 코인을 구매할 수 있어요.');
  if (!requestIdValid(input.requestId) || !CLAW_RULES.purchaseQuantities.includes(input.quantity as 1 | 5)) {
    throw new ClawError(400, 'INVALID_PURCHASE', '요청 번호와 구매할 코인 수를 확인해 주세요.');
  }
  const purchase = input as unknown as ClawCoinInput;
  let recorded = await priorPurchase(db, user, purchase);
  if (recorded) return { ...await getClawState(db, user, now), purchase: { requestId: purchase.requestId, quantity: recorded.quantity, cost: recorded.cost }, replayed: true };
  await wallet(db, user, now);
  const id = crypto.randomUUID(); const cost = purchase.quantity * CLAW_RULES.coinPrice; const createdAt = new Date(now).toISOString();
  await db.batch([
    db.prepare(`INSERT OR IGNORE INTO claw_coin_purchases (id, user_id, request_id, quantity, cost, created_at)
      SELECT ?, u.id, ?, ?, ?, ? FROM users u JOIN claw_accounts a ON a.user_id = u.id
      WHERE u.id = ? AND u.role = 'player' AND u.active = 1
      AND COALESCE((SELECT SUM(amount) FROM ledger WHERE user_id = u.id AND currency = 'gold'), 0) >= ?`)
      .bind(id, purchase.requestId, purchase.quantity, cost, createdAt, user.id, cost),
    db.prepare(`INSERT OR IGNORE INTO ledger (id, user_id, currency, amount, reason, reference, created_at)
      SELECT ?, user_id, 'gold', -cost, '뽑기 코인 구매', 'claw:coins:' || user_id || ':' || request_id, created_at
      FROM claw_coin_purchases WHERE id = ?`).bind(crypto.randomUUID(), id),
    db.prepare(`UPDATE claw_accounts SET purchased_coins = purchased_coins + ?
      WHERE user_id = ? AND EXISTS (SELECT 1 FROM claw_coin_purchases WHERE id = ?)`)
      .bind(purchase.quantity, user.id, id),
  ]);
  recorded = await priorPurchase(db, user, purchase);
  if (!recorded) {
    const active = await db.prepare("SELECT 1 FROM users WHERE id = ? AND active = 1 AND role = 'player'").bind(user.id).first();
    if (!active) throw new ClawError(403, 'CANNOT_PURCHASE', '플레이어만 코인을 구매할 수 있어요.');
    throw new ClawError(409, 'INSUFFICIENT_GOLD', '코인을 구매할 골드가 부족해요.');
  }
  return { ...await getClawState(db, user, now), purchase: { requestId: purchase.requestId, quantity: recorded.quantity, cost: recorded.cost }, replayed: recorded.id !== id };
}

/** Keep the original input bounds and two-decimal stop normalization. */
export function validatePlay(value: unknown): string | null {
  const input = value && typeof value === 'object' ? value as Record<string, unknown> : null;
  if (!input || typeof input.x !== 'number' || !Number.isFinite(input.x) || input.x < MACHINE.clawMin || input.x > MACHINE.clawMax) return '집게 위치가 올바르지 않아요.';
  if (!requestIdValid(input.requestId)) return '플레이 요청 번호가 올바르지 않아요.';
  if (!Number.isSafeInteger(input.version) || Number(input.version) < 0) return '기계 상태를 새로고침해 주세요.';
  if (input.stop != null && (typeof input.stop !== 'number' || !Number.isFinite(input.stop) || input.stop < CLAW.top || input.stop > MACHINE.height)) return '집게 높이가 올바르지 않아요.';
  return null;
}
async function priorPlay(db: D1Database, user: Actor, input: ClawPlayInput, stop: number | null): Promise<PlayRow | null> {
  const old = await db.prepare('SELECT id, version, claw_x, stop, result_json FROM claw_plays WHERE user_id = ? AND request_id = ?')
    .bind(user.id, input.requestId).first<PlayRow>();
  if (old && (old.version !== input.version || old.claw_x !== input.x || old.stop !== stop
    || Boolean((JSON.parse(old.result_json) as { forceStrong?: boolean }).forceStrong) !== (input.forceStrong === true))) throw new ClawError(409, 'REQUEST_CONFLICT', '이미 다른 플레이에 사용한 요청 번호예요.');
  return old;
}
async function replay(db: D1Database, user: Actor, old: PlayRow, now: number, replayed = true): Promise<ClawResponse> {
  const { forceStrong: _forceStrong, ...result } = JSON.parse(old.result_json) as ClawResult & { forceStrong?: boolean };
  return { ...await getClawState(db, user, now), result, replayed };
}
export async function playClaw(db: D1Database, user: Actor, input: Record<string, unknown>, now = Date.now(), random: () => number = randomUnit): Promise<ClawResponse> {
  const admin = user.role === 'admin';
  if (!admin && input.forceStrong !== undefined) throw new ClawError(403, 'ADMIN_ONLY', '운영자만 강집게 테스트를 할 수 있어요.');
  if (input.forceStrong !== undefined && typeof input.forceStrong !== 'boolean') throw new ClawError(400, 'INVALID_PLAY', '강집게 테스트 설정을 확인해 주세요.');
  const invalid = validatePlay(input);
  if (invalid) throw new ClawError(400, 'INVALID_PLAY', invalid);
  const play = input as unknown as ClawPlayInput;
  const stop = play.stop == null ? null : Number(play.stop.toFixed(2));
  const old = await priorPlay(db, user, play, stop);
  if (old) return replay(db, user, old, now);
  await machine(db, user, now);
  const [account, config] = await Promise.all([
    db.prepare(`SELECT ${machineColumns}, power_counter FROM claw_accounts WHERE user_id = ?`).bind(user.id).first<AccountRow>(),
    db.prepare('SELECT payout_every, weak_pickup, weak_carry FROM claw_config WHERE id = 1').first<ConfigRow>(),
  ]);
  const blocked = !account || account.version !== play.version ? '기계 상태가 바뀌었어요. 새로고침한 뒤 다시 시도해 주세요.'
    : !admin && account.free_coins + account.purchased_coins < 1 ? '코인이 부족해요. 다음 코인 지급을 기다려 주세요.'
    : account.next_play_at > now ? '집게가 아직 움직이고 있어요. 잠시 기다려 주세요.' : null;
  if (blocked) {
    // A concurrent retry may have committed since the first receipt lookup.
    const raced = await priorPlay(db, user, play, stop);
    if (raced) return replay(db, user, raced, now);
    throw new ClawError(409, 'PLAY_UNAVAILABLE', blocked);
  }
  if (!config) throw new Error('Missing claw configuration');
  const strong = (admin && play.forceStrong === true) || account!.power_counter + 1 >= config.payout_every;
  const jitter = (percent: number) => Number((percent / 100 * (.9 + random() * .2)).toFixed(3));
  const grip = strong ? { pickup: 1, carry: 1, strong } : { pickup: jitter(config.weak_pickup), carry: jitter(config.weak_carry), strong };
  // Exactly one attempt simulation per new request, and none on saved retries.
  const sim = simulateAttempt(JSON.parse(account!.board_json!) as Board, { x: play.x, stop, pickup: grip.pickup, carry: grip.carry });
  const caught = sim.prizes.length > 0; const cleared = caught && sim.board.length === 0;
  const clearBonus = !admin && cleared ? CLAW_RULES.clearScore : 0; const clearGold = !admin && cleared ? CLAW_RULES.clearGold : 0;
  const generation = account!.generation + (cleared ? 1 : 0);
  const nextBoard = cleared ? createBoard(generation, randomSeed()) : sim.board;
  const powerCounter = strong || caught ? 0 : account!.power_counter + 1;
  const id = crypto.randomUUID(); const date = new Date(now); const createdAt = date.toISOString();
  const result: ClawResult = { requestId: play.requestId, playId: id, engine: CLAW_RULES.engine, x: play.x, stop, grip, caught, prizes: sim.prizes,
    doll: sim.prizes[0] ?? null, target: sim.target, points: admin ? 0 : sim.prizes.length * CLAW_RULES.dollScore + clearBonus,
    gold: admin ? 0 : sim.prizes.length * CLAW_RULES.dollGold + clearGold, clearBonus, clearGold, cleared, released: sim.released, reason: sim.reason };
  const slot = coinSlot(now); const slotStart = slot * CLAW_RULES.coinIntervalMs;
  const writes: D1PreparedStatement[] = [
    db.prepare(`INSERT OR IGNORE INTO claw_plays (id, user_id, request_id, generation, version, claw_x, stop, caught, score, gold, clear_bonus, result_json, created_at)
      SELECT ?, a.user_id, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ? FROM claw_accounts a JOIN users u ON u.id = a.user_id
      WHERE a.user_id = ? AND u.role = ? AND u.active = 1 AND a.version = ?
        AND a.next_play_at <= ?
        AND (u.role = 'admin' OR (a.free_coins + a.purchased_coins >= 1 AND a.last_grant_slot = ?
          AND unixepoch('now') * 1000 >= ? AND unixepoch('now') * 1000 < ?))`)
      .bind(id, play.requestId, account!.generation, account!.version, play.x, stop, sim.prizes.length, result.points, result.gold, clearBonus, JSON.stringify({ ...result, forceStrong: play.forceStrong === true }), createdAt,
        user.id, user.role, play.version, now, slot, slotStart, slotStart + CLAW_RULES.coinIntervalMs),
    db.prepare(`UPDATE claw_accounts SET purchased_coins = purchased_coins - CASE WHEN ? = 0 AND free_coins = 0 THEN 1 ELSE 0 END,
      free_coins = CASE WHEN ? = 1 THEN free_coins ELSE MAX(0, free_coins - 1) END, board_json = ?, generation = ?, version = version + 1, next_play_at = ?, power_counter = ?
      WHERE user_id = ? AND version = ? AND EXISTS (SELECT 1 FROM claw_plays WHERE id = ?)`)
      .bind(Number(admin), Number(admin), JSON.stringify(nextBoard), generation, now + CLAW_RULES.playDurationMs, powerCounter, user.id, play.version, id),
  ];
  // The original play-id prefix identifies the reward; each currency needs its
  // own suffix because this repository's ledger reference is globally UNIQUE.
  for (const [kind, currency, amount] of [
    ['doll', 'score', sim.prizes.length * CLAW_RULES.dollScore], ['doll', 'gold', sim.prizes.length * CLAW_RULES.dollGold],
    ['clear', 'score', clearBonus], ['clear', 'gold', clearGold],
  ] as const) {
    if (admin || amount === 0) continue;
    writes.push(db.prepare(`INSERT OR IGNORE INTO ledger (id, user_id, currency, amount, reason, reference, created_at, week_start)
      SELECT ?, user_id, ?, ?, ?, ?, created_at, ? FROM claw_plays WHERE id = ?`)
      .bind(crypto.randomUUID(), currency, amount, kind === 'clear' ? '캐릭터 뽑기 클리어' : '캐릭터 뽑기 인형 획득',
        `claw:${kind}:${id}:${currency}`, currency === 'score' ? weekStart(date) : null, id));
  }
  await db.batch(writes);
  const recorded = await priorPlay(db, user, play, stop);
  if (!recorded) {
    const active = await db.prepare("SELECT 1 FROM users WHERE id = ? AND active = 1 AND role = ?").bind(user.id, user.role).first();
    if (!active) throw new ClawError(403, 'CANNOT_PLAY', '활성 계정에서만 기계를 사용할 수 있어요.');
    throw new ClawError(409, 'PLAY_UNAVAILABLE', '코인 지급 시각이나 기계 상태가 바뀌었어요. 새로고침하고 다시 시도해 주세요.');
  }
  return replay(db, user, recorded, now, recorded.id !== id);
}
