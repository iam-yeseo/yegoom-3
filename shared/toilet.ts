import { TOILET_RULES } from './balance';

// 변기 폭파 rules shared by the Worker and the preview (docs/plan-toilet.md).
// Everything here is pure: the same players, round and pushes always give the
// same order, turn and chance.

export type ToiletHalf = (typeof TOILET_RULES.halves)[number]['half'];
export interface ToiletWindow {
  /** `YYYY-MM-DD:am` or `YYYY-MM-DD:pm` (KST date). */
  id: string; date: string; half: ToiletHalf; label: string;
  /** How many rounds came before this one; the start seat moves one along per round. */
  index: number;
  startsAt: number; endsAt: number;
}
const DAY = 24 * 60 * 60 * 1000;
const kstDate = (time: number) => new Date(time + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
const kstClock = (time: number) => new Date(time + 9 * 60 * 60 * 1000).toISOString().slice(11, 19);
const at = (date: string, clock: string) => Date.parse(`${date}T${clock}+09:00`);

/** The round window of this KST date and half. */
export function toiletWindowOf(date: string, half: ToiletHalf): ToiletWindow {
  const rule = TOILET_RULES.halves.find(entry => entry.half === half)!;
  const day = Math.round(Date.parse(`${date}T00:00:00Z`) / DAY);
  return { id: `${date}:${half}`, date, half, label: rule.label, index: day * 2 + (half === 'pm' ? 1 : 0), startsAt: at(date, rule.start), endsAt: at(date, rule.end) };
}
/** The round open at `now`, or null from 23:50 to midnight. */
export function toiletWindow(now: number): ToiletWindow | null {
  const date = kstDate(now), clock = kstClock(now);
  const rule = TOILET_RULES.halves.find(entry => clock >= entry.start && clock < entry.end);
  return rule ? toiletWindowOf(date, rule.half) : null;
}
/** The round just before the one open at `now` (or before the 23:50 close). */
export function previousToiletWindow(now: number): ToiletWindow {
  const current = toiletWindow(now), date = kstDate(now);
  if (!current) return toiletWindowOf(date, 'pm');
  if (current.half === 'pm') return toiletWindowOf(date, 'am');
  return toiletWindowOf(kstDate(now - DAY), 'pm');
}
/** When the next round opens, for a screen that is waiting through the close. */
export const nextToiletOpen = (now: number): number => (toiletWindow(now) ? toiletWindow(now)!.endsAt : at(kstDate(now + DAY), '00:00:00'));

export interface ToiletPerson { id: string; username: string }
/** Turn order of a round: players by username, started one seat further along each round (1-2-3, 2-3-1, 3-1-2). */
export function toiletOrder(players: readonly ToiletPerson[], index: number): string[] {
  const sorted = [...players].sort((a, b) => (a.username < b.username ? -1 : a.username > b.username ? 1 : 0)).map(person => person.id);
  if (!sorted.length) return [];
  const shift = ((index % sorted.length) + sorted.length) % sorted.length;
  return [...sorted.slice(shift), ...sorted.slice(0, shift)];
}
export const toiletSlots = (players: number): number => players * TOILET_RULES.slotsPerPlayer;
/** The chance the next push bursts: one of the pushes left is the one. */
export const burstChance = (slots: number, pushes: number): number => (pushes >= slots ? 1 : 1 / (slots - pushes));
/** Whether a push bursts, for a random number in [0, 1). The last push always does. */
export const bursts = (random: number, slots: number, pushes: number): boolean => random * Math.max(1, slots - pushes) < 1;
/** The seat whose turn it is: `from`, or the next one still playing. -1 when nobody is. */
export function toiletTurn(order: readonly string[], from: number, playing: (id: string) => boolean): number {
  for (let step = 0; step < order.length; step++) {
    const seat = (from + step) % order.length;
    if (playing(order[seat]!)) return seat;
  }
  return -1;
}
/** The seat after `seat` still playing; `seat` itself when nobody else is. */
export const nextToiletTurn = (order: readonly string[], seat: number, playing: (id: string) => boolean): number => {
  const next = toiletTurn(order, (seat + 1) % order.length, id => id !== order[seat] && playing(id));
  return next < 0 ? seat : next;
};
/** What a burst pays: the loser loses, everyone else in the round still playing gains. */
export function toiletResults(order: readonly string[], loserId: string, playing: (id: string) => boolean): { userId: string; points: number }[] {
  return order.flatMap((id): { userId: string; points: number }[] => (id === loserId ? [{ userId: id, points: TOILET_RULES.loseScore }] : playing(id) ? [{ userId: id, points: TOILET_RULES.winScore }] : []));
}
