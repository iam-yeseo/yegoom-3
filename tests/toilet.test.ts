import { describe, expect, it } from 'vitest';
import { TOILET_RULES } from '../shared/balance';
import {
  burstChance, bursts, nextToiletOpen, nextToiletTurn, previousToiletWindow, toiletOrder, toiletResults, toiletSlots, toiletTurn, toiletWindow,
} from '../shared/toilet';

const people = ['min', 'siwon', 'yeseo'].map(username => ({ id: username, username }));

describe('변기 폭파 rules', () => {
  it('opens 오전 at midnight and 오후 at noon, and closes at 23:50', () => {
    expect(toiletWindow(Date.parse('2026-11-23T00:00:00+09:00'))).toMatchObject({ id: '2026-11-23:am', label: '오전' });
    expect(toiletWindow(Date.parse('2026-11-23T11:59:59+09:00'))?.half).toBe('am');
    expect(toiletWindow(Date.parse('2026-11-23T12:00:00+09:00'))).toMatchObject({ id: '2026-11-23:pm', label: '오후' });
    expect(toiletWindow(Date.parse('2026-11-23T23:49:59+09:00'))?.half).toBe('pm');
    expect(toiletWindow(Date.parse('2026-11-23T23:50:00+09:00'))).toBeNull();
    expect(previousToiletWindow(Date.parse('2026-11-23T09:00:00+09:00')).id).toBe('2026-11-22:pm');
    expect(previousToiletWindow(Date.parse('2026-11-23T13:00:00+09:00')).id).toBe('2026-11-23:am');
    expect(previousToiletWindow(Date.parse('2026-11-23T23:55:00+09:00')).id).toBe('2026-11-23:pm');
    expect(nextToiletOpen(Date.parse('2026-11-23T23:55:00+09:00'))).toBe(Date.parse('2026-11-24T00:00:00+09:00'));
  });

  it('rotates the first seat one along each round: 1-2-3, 2-3-1, 3-1-2', () => {
    const am = toiletWindow(Date.parse('2026-11-23T09:00:00+09:00'))!, pm = toiletWindow(Date.parse('2026-11-23T15:00:00+09:00'))!;
    const nextAm = toiletWindow(Date.parse('2026-11-24T09:00:00+09:00'))!;
    expect(pm.index).toBe(am.index + 1);
    expect(nextAm.index).toBe(am.index + 2);
    const orders = [am, pm, nextAm].map(window => toiletOrder(people, window.index).join('-'));
    expect(new Set(orders).size).toBe(3);
    // Each next order is the previous one started a seat later.
    const [first, second, third] = [am, pm, nextAm].map(window => toiletOrder(people, window.index));
    expect(second).toEqual([...first!.slice(1), first![0]]);
    expect(third).toEqual([...second!.slice(1), second![0]]);
  });

  it('gets riskier with every push and always bursts on the last slot', () => {
    const slots = toiletSlots(3);
    expect(slots).toBe(3 * TOILET_RULES.slotsPerPlayer);
    expect(burstChance(slots, 0)).toBeCloseTo(1 / slots);
    expect(burstChance(slots, slots - 1)).toBe(1);
    expect(bursts(0.999, slots, slots - 1)).toBe(true);
    // The first push bursts for the lowest 1/slots of random numbers only.
    expect(bursts(1 / slots + 0.001, slots, 0)).toBe(false);
    expect(bursts(1 / slots - 0.001, slots, 0)).toBe(true);
  });

  it('gives every seat the same chance of bursting', () => {
    // Exact: the chance that slot k (0-based) is the one is 1/slots for every k.
    const slots = toiletSlots(3);
    let survive = 1;
    const perSlot: number[] = [];
    for (let k = 0; k < slots; k++) { perSlot.push(survive * burstChance(slots, k)); survive *= 1 - burstChance(slots, k); }
    for (const chance of perSlot) expect(chance).toBeCloseTo(1 / slots);
  });

  it('skips players who left and pays the burst', () => {
    const order = ['a', 'b', 'c'];
    const active = (id: string) => id !== 'b';
    expect(toiletTurn(order, 1, active)).toBe(2);
    expect(nextToiletTurn(order, 0, active)).toBe(2);
    expect(nextToiletTurn(order, 2, active)).toBe(0);
    expect(nextToiletTurn(['a', 'b'], 0, id => id === 'a')).toBe(0);
    expect(toiletResults(order, 'c', active)).toEqual([{ userId: 'a', points: TOILET_RULES.winScore }, { userId: 'c', points: TOILET_RULES.loseScore }]);
  });
});
