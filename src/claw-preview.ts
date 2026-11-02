import { CLAW_RULES } from '../shared/balance';
import type { AdminClawConfig } from '../shared/admin';
import { CLAW, MACHINE, createBoard, simulateAttempt, type Board } from '../shared/claw-physics';
import type { ClawCoinInput, ClawPlayInput, ClawResponse, ClawResult, ClawSummary, LedgerEntry } from '../shared/types';

const coinSlot = (now: number) => Math.floor(now / CLAW_RULES.coinIntervalMs);
const nextGrantAt = (now: number) => (coinSlot(now) + 1) * CLAW_RULES.coinIntervalMs;
const randomSeed = () => typeof globalThis.crypto !== 'undefined'
  ? crypto.getRandomValues(new Uint32Array(1))[0] : Math.floor(Math.random() * 0x100000000);
const randomUnit = () => randomSeed() / 0x100000000;
const validRequest = (value: string) => typeof value === 'string' && /^[a-zA-Z0-9_-]{16,80}$/.test(value);

/** The home preview does not need to construct or simulate a machine. */
export function previewClawSummary(now = Date.now()): ClawSummary {
  return { coins: CLAW_RULES.freeCoins, freeCoins: CLAW_RULES.freeCoins, purchasedCoins: 0,
    nextGrantAt: nextGrantAt(now), serverNow: now, isAdmin: false };
}

/** One offline visit owns its machine, wallet and receipts. Nothing is persisted
 * or uploaded. Player preview grip is sampled independently of server settings;
 * an explicitly selected admin preview uses only that visit's editable config. */
export function createClawPreview(options: { admin?: boolean; getConfig?: () => AdminClawConfig | undefined } = {}) {
  const admin = Boolean(options.admin);
  let powerCounter = 0;
  let freeCoins: number = admin ? 0 : CLAW_RULES.freeCoins;
  let purchasedCoins = 0;
  let lastGrantSlot = coinSlot(Date.now());
  let generation = 1;
  let version = 0;
  let nextPlayAt = 0;
  let board: Board | null = null;
  let gold = 0;
  let score = 0;
  const ledger: LedgerEntry[] = [];
  const plays = new Map<string, { payload: string; result: ClawResult }>();
  const purchases = new Map<string, NonNullable<ClawResponse['purchase']>>();

  function grant(now: number) {
    const slot = coinSlot(now);
    if (!admin && slot > lastGrantSlot) { freeCoins = CLAW_RULES.freeCoins; lastGrantSlot = slot; }
  }
  function summary(now = Date.now()): ClawSummary {
    grant(now);
    return { coins: freeCoins + purchasedCoins, freeCoins, purchasedCoins,
      nextGrantAt: nextGrantAt(now), serverNow: now, isAdmin: admin };
  }
  function state(now: number): ClawResponse {
    const wallet = summary(now);
    board ??= createBoard(generation, randomSeed());
    return structuredClone({ ...wallet, board, generation, version, nextPlayAt });
  }
  function record(currency: LedgerEntry['currency'], amount: number, reason: string, reference: string, now: number) {
    if (!amount) return;
    ledger.unshift({ id: `${reference}:${currency}`, currency, amount, reason, createdAt: new Date(now).toISOString() });
    if (currency === 'gold') gold += amount;
    else score += amount;
  }
  function read(): ClawResponse { return state(Date.now()); }

  function buy(input: ClawCoinInput, availableGold: number): ClawResponse {
    if (admin) throw new Error('운영자 테스트는 코인을 구매하지 않아요.');
    if (!validRequest(input.requestId)) throw new Error('구매 요청 번호를 확인해 주세요.');
    if (!CLAW_RULES.purchaseQuantities.includes(input.quantity)) throw new Error('코인은 1개 또는 5개씩 살 수 있어요.');
    const now = Date.now();
    grant(now);
    const old = purchases.get(input.requestId);
    if (old) {
      if (old.quantity !== input.quantity) throw new Error('다른 구매에 사용한 요청 번호예요.');
      return { ...state(now), purchase: { ...old }, replayed: true };
    }
    const cost = input.quantity * CLAW_RULES.coinPrice;
    if (!Number.isFinite(availableGold) || availableGold < cost) throw new Error('골드가 부족해요.');
    const purchase = { requestId: input.requestId, quantity: input.quantity, cost };
    record('gold', -cost, `캐릭터 뽑기 코인 ${input.quantity}개 구매`, `claw:coins:${input.requestId}`, now);
    purchasedCoins += input.quantity;
    purchases.set(input.requestId, purchase);
    return { ...state(now), purchase: { ...purchase }, replayed: false };
  }

  function play(input: ClawPlayInput): ClawResponse {
    if (!admin && input.forceStrong !== undefined) throw new Error('운영자만 강집게 테스트를 할 수 있어요.');
    if (!validRequest(input.requestId)) throw new Error('플레이 요청 번호를 확인해 주세요.');
    if (!Number.isSafeInteger(input.version) || input.version < 0) throw new Error('기계 상태를 다시 확인해 주세요.');
    if (!Number.isFinite(input.x) || input.x < MACHINE.clawMin || input.x > MACHINE.clawMax) throw new Error('집게 위치가 올바르지 않아요.');
    if (input.stop != null && (!Number.isFinite(input.stop) || input.stop < CLAW.top || input.stop > MACHINE.height)) throw new Error('집게 높이가 올바르지 않아요.');
    const now = Date.now();
    grant(now);
    const stop = input.stop == null ? null : Number(input.stop.toFixed(2));
    const payload = JSON.stringify({ version: input.version, x: input.x, stop, forceStrong: input.forceStrong === true });
    const old = plays.get(input.requestId);
    if (old) {
      if (old.payload !== payload) throw new Error('다른 플레이에 사용한 요청 번호예요.');
      return { ...state(now), result: structuredClone(old.result), replayed: true };
    }
    if (input.version !== version) throw new Error('기계 상태가 바뀌었어요. 다시 확인해 주세요.');
    if (!admin && freeCoins + purchasedCoins < 1) throw new Error('코인이 부족해요. 다음 충전을 기다려 주세요.');
    if (nextPlayAt > now) throw new Error('집게가 아직 움직이고 있어요. 잠시 기다려 주세요.');
    board ??= createBoard(generation, randomSeed());
    // Player demos never read the private server payout cadence or config.
    const config = admin ? options.getConfig?.() : undefined;
    const strong = admin && input.forceStrong === true || (config ? powerCounter + 1 >= config.payoutEvery : randomUnit() < .5);
    const jitter = (power: number) => Number((power * (.9 + randomUnit() * .2)).toFixed(3));
    const grip = strong ? { pickup: 1, carry: 1, strong } : config
      ? { pickup: jitter(config.weakPickup), carry: jitter(config.weakCarry), strong }
      : { pickup: randomUnit(), carry: randomUnit(), strong };
    const simulation = simulateAttempt(board, { x: input.x, stop, pickup: grip.pickup, carry: grip.carry });
    const count = simulation.prizes.length;
    const cleared = count > 0 && simulation.board.length === 0;
    const clearBonus = !admin && cleared ? CLAW_RULES.clearScore : 0;
    const clearGold = !admin && cleared ? CLAW_RULES.clearGold : 0;
    const nextGeneration = generation + (cleared ? 1 : 0);
    const nextBoard = cleared ? createBoard(nextGeneration, randomSeed()) : simulation.board;
    const playId = `preview-${input.requestId}`;
    const result: ClawResult = {
      requestId: input.requestId, playId, engine: CLAW_RULES.engine, x: input.x, stop, grip,
      caught: count > 0, prizes: simulation.prizes, doll: simulation.prizes[0] ?? null, target: simulation.target,
      points: admin ? 0 : count * CLAW_RULES.dollScore + clearBonus, gold: admin ? 0 : count * CLAW_RULES.dollGold + clearGold,
      clearBonus, clearGold, cleared, released: simulation.released, reason: simulation.reason,
    };
    if (!admin) {
      if (freeCoins > 0) freeCoins -= 1;
      else purchasedCoins -= 1;
    }
    powerCounter = strong || count > 0 ? 0 : powerCounter + 1;
    board = nextBoard;
    generation = nextGeneration;
    version += 1;
    nextPlayAt = now + CLAW_RULES.playDurationMs;
    if (!admin) record('score', count * CLAW_RULES.dollScore, '캐릭터 뽑기 인형 보상', `claw:doll:${playId}`, now);
    if (!admin) record('gold', count * CLAW_RULES.dollGold, '캐릭터 뽑기 인형 보상', `claw:doll:${playId}`, now);
    record('score', clearBonus, '캐릭터 뽑기 클리어 보너스', `claw:clear:${playId}`, now);
    record('gold', clearGold, '캐릭터 뽑기 클리어 보너스', `claw:clear:${playId}`, now);
    plays.set(input.requestId, { payload, result });
    return { ...state(now), result: structuredClone(result), replayed: false };
  }
  return { read, buy, play, summary,
    get gold() { return gold; }, get score() { return score; },
    get ledger() { return structuredClone(ledger); },
  };
}
