import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { ARCADE_RULES } from '../shared/balance';
import { GOAL, KICK, judgeKick, judgeShootout, keeperAt, kickTarget, penaltyKeepers, validKick, type Keeper } from '../shared/penalty-engine';

const FINGERPRINT = 'ae90aa3be49bf68bc13cdbba710be6761af534e0e497808e50109fcf5e49e392';
const fingerprint = () => {
  const hash = createHash('sha256');
  for (const seed of [0, 1, 590123, 590124]) penaltyKeepers(seed, 5).forEach((keeper, index) => {
    for (let t = 0; t <= KICK.windowMs; t += 730) for (let power = 0; power <= 100; power += 10) for (let aim = -100; aim <= 100; aim += 20) {
      const kick = judgeKick(keeper, { power, aim, t });
      hash.update(`${seed}.${index}.${t}.${power}.${aim}:${kick.kind}${kick.frame ? 'f' : ''}${kick.corner ? 'c' : ''}:${kick.keeper.dive.x.toFixed(6)};`);
    }
  });
  return hash.digest('hex');
};
/** A keeper who never moves, standing in the middle. */
const STILL: Keeper = { amplitude: 0, period: 2, phase: 0, wobble: 0, wobblePeriod: 1, wobblePhase: 0, reach: 1 };

describe('penalty engine', () => {
  it('gives the same keepers and the same result for the same seed and kick', () => {
    expect(penaltyKeepers(42, 5)).toEqual(penaltyKeepers(42, 5));
    expect(penaltyKeepers(42, 5)).not.toEqual(penaltyKeepers(43, 5));
    // A set is ten kicks now: ten keepers, each a step wider-reaching than the one before.
    const ten = penaltyKeepers(42, ARCADE_RULES.penalty.tries);
    expect(ten).toHaveLength(10);
    ten.slice(1).forEach((keeper, i) => expect(keeper.reach).toBeGreaterThan(ten[i]!.reach));
    expect(judgeShootout(42, Array.from({ length: 10 }, () => ({ power: 0, aim: 0, t: -1 }))).kicks.map(kick => kick.kind)).toEqual(Array(10).fill('timeout'));
    const kicks = [{ power: 70, aim: 60, t: 1234 }, { power: 20, aim: 0, t: 400 }, { power: 100, aim: -100, t: 0 }, { power: 0, aim: 0, t: -1 }, { power: 66, aim: -58, t: 9999 }];
    expect(JSON.stringify(judgeShootout(42, kicks))).toBe(JSON.stringify(judgeShootout(42, kicks.map(kick => ({ ...kick })))));
  });

  it('keeps every outcome stable (update this hash only when the keepers are retuned on purpose)', () => {
    // The Worker judges recorded sets again; a silent change here would make the
    // browser and the Worker disagree. Bump ARCADE_RULES.penalty.engine with it.
    expect(fingerprint()).toBe(FINGERPRINT);
  });

  it('sends the ball where the swipe pointed, higher and faster the harder it is struck', () => {
    expect(kickTarget({ power: 50, aim: 0, t: 0 }).x).toBe(0);
    expect(kickTarget({ power: 50, aim: -100, t: 0 }).x).toBeCloseTo(-KICK.aimReach, 9);
    expect(kickTarget({ power: 0, aim: 0, t: 0 }).y).toBeCloseTo(GOAL.ballRadius, 9);
    expect(kickTarget({ power: 90, aim: 0, t: 0 }).y).toBeGreaterThan(kickTarget({ power: 60, aim: 0, t: 0 }).y);
    expect(kickTarget({ power: 90, aim: 0, t: 0 }).flight).toBeLessThan(kickTarget({ power: 60, aim: 0, t: 0 }).flight);
  });

  it('misses over the bar, wide of the posts, and off the frame in between', () => {
    expect(judgeKick(STILL, { power: 100, aim: 0, t: 0 }).kind).toBe('over');
    expect(judgeKick(STILL, { power: 60, aim: 100, t: 0 }).kind).toBe('wide');
    expect(judgeKick(STILL, { power: 60, aim: -100, t: 0 }).kind).toBe('wide');
    // Just outside the post's centre: off the post and out.
    expect(judgeKick(STILL, { power: 60, aim: 81, t: 0 }).kind).toBe('post');
    expect(judgeKick(STILL, { power: 88, aim: 70, t: 0 }).kind).toBe('post');
    // Just inside it: in off the post.
    expect(judgeKick(STILL, { power: 60, aim: 78, t: 0 })).toMatchObject({ kind: 'goal', frame: true, made: true });
    expect(judgeKick(STILL, { power: 0, aim: 0, t: -1 })).toMatchObject({ kind: 'timeout', made: false });
  });

  it('lets a still keeper save what is near and slow, and beats them in the corners', () => {
    expect(judgeKick(STILL, { power: 70, aim: 0, t: 0 }).kind).toBe('saved');
    expect(judgeKick(STILL, { power: 70, aim: 30, t: 0 }).kind).toBe('saved');
    // A roller gives the keeper time to cross the whole goal.
    expect(judgeKick(STILL, { power: 15, aim: 70, t: 0 }).kind).toBe('saved');
    expect(judgeKick(STILL, { power: 74, aim: 72, t: 0 })).toMatchObject({ kind: 'goal', corner: true });
    expect(judgeKick(STILL, { power: 74, aim: -72, t: 0 })).toMatchObject({ kind: 'goal', corner: true });
    // The dive never goes further than the keeper can reach.
    const beaten = judgeKick(STILL, { power: 74, aim: 72, t: 0 });
    expect(Math.abs(beaten.keeper.dive.x)).toBeCloseTo(beaten.keeper.reach, 9);
    expect(Math.abs(beaten.target.x)).toBeGreaterThan(beaten.keeper.reach);
  });

  it('rewards kicking away from the way the keeper is stepping', () => {
    const [keeper] = penaltyKeepers(7, 5);
    // Find a moment the keeper is well to one side and still heading that way.
    let moment = -1;
    for (let t = 0; t < 4000; t += 10) { const at = keeperAt(keeper!, t); if (at.x > 0.5 && at.v > 1) { moment = t; break; } }
    expect(moment).toBeGreaterThanOrEqual(0);
    const away = judgeKick(keeper!, { power: 70, aim: -55, t: moment }), toward = judgeKick(keeper!, { power: 70, aim: 55, t: moment });
    expect(away.made).toBe(true);
    expect(toward.made).toBe(false);
  });

  it('makes each keeper of a set harder than the one before', () => {
    const share = (keeper: Keeper) => {
      let goals = 0, kicks = 0;
      for (let t = 0; t < 6000; t += 131) for (let aim = -100; aim <= 100; aim += 5) for (let power = 20; power <= 100; power += 5) { kicks++; if (judgeKick(keeper, { power, aim, t }).made) goals++; }
      return goals / kicks;
    };
    for (const seed of [3, 590123]) {
      const shares = penaltyKeepers(seed, 5).map(share);
      expect(shares[0]!).toBeGreaterThan(shares[4]!);
      // Never impossible, never a walkover.
      for (const value of shares) { expect(value).toBeGreaterThan(0.03); expect(value).toBeLessThan(0.2); }
    }
  });

  it('keeps the keeper on the line between the posts', () => {
    for (const keeper of penaltyKeepers(99, 5)) for (let t = 0; t <= KICK.windowMs; t += 37) expect(Math.abs(keeperAt(keeper, t).x)).toBeLessThan(GOAL.halfWidth - 1.5);
  });

  it('accepts only whole numbers in range, and a timeout only as an empty kick', () => {
    expect(validKick({ power: 0, aim: -100, t: 0 })).toBe(true);
    expect(validKick({ power: 100, aim: 100, t: KICK.windowMs })).toBe(true);
    expect(validKick({ power: 0, aim: 0, t: -1 })).toBe(true);
    for (const bad of [{ power: 50, aim: 10, t: -1 }, { power: 101, aim: 0, t: 5 }, { power: 50, aim: 0, t: KICK.windowMs + 1 }, { power: 50, aim: 0, t: 1.5 }, { power: 50, aim: 0 }, { power: 50, aim: 0, t: -2 }, null]) expect(validKick(bad)).toBe(false);
  });
});
