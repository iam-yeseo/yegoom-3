import { STOCK_RULES, type Volatility } from './stocks';

/** One 10-minute move. `z` is a standard normal draw; `effect` is the summed
 * fractional effect of events applied at this tick (e.g. +0.06). The result is
 * an integer price within ±15% of the previous close and at least 1G. */
export function stepPrice(price: number, listingPrice: number, previousClose: number, volatility: Volatility, z: number, effect = 0): number {
  const drift = STOCK_RULES.reversion * Math.log(listingPrice / price);
  const next = price * Math.exp(drift + STOCK_RULES.sigma[volatility] * z + Math.log1p(Math.max(-0.9, effect)));
  return clampToLimit(Math.round(next), previousClose);
}
/** Apply only events (the 09:00 open and relistings carry no random move). */
export function applyEffect(price: number, previousClose: number, effect: number): number {
  return clampToLimit(Math.round(price * (1 + Math.max(-0.9, effect))), previousClose);
}
export function clampToLimit(price: number, previousClose: number): number {
  const low = Math.ceil(previousClose * (1 - STOCK_RULES.dailyLimit));
  const high = Math.floor(previousClose * (1 + STOCK_RULES.dailyLimit));
  return Math.max(1, Math.min(high, Math.max(low, price)));
}
export const isLimitUp = (price: number, previousClose: number) => price >= Math.floor(previousClose * (1 + STOCK_RULES.dailyLimit));
export const isLimitDown = (price: number, previousClose: number) => price <= Math.ceil(previousClose * (1 - STOCK_RULES.dailyLimit));

/** Two uniforms in (0, 1] → one standard normal (Box–Muller). */
export function normalFrom(u1: number, u2: number): number {
  return Math.sqrt(-2 * Math.log(Math.max(u1, 1e-12))) * Math.cos(2 * Math.PI * u2);
}
/** Synchronous seeded PRNG for the serverless preview and tests (never for real prices). */
export function seededRandom(seed: string): () => number {
  let state = 2166136261;
  for (const character of seed) state = Math.imul(state ^ character.charCodeAt(0), 16777619) >>> 0;
  return () => {
    state = (state + 0x6D2B79F5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return (((t ^ (t >>> 14)) >>> 0) + 1) / 4294967297;
  };
}
