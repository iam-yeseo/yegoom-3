// Free throw sounds from /sfx (docs/sfx.md 3.7) with the original haptics.
// The audio context starts only after the player touches the ball.
import { createGameSfx, type SfxId } from "../sfx";

const STORAGE_KEY = "yegoom3:freethrow:muted";
const IDS: SfxId[] = ["ft-throw", "ft-rim", "ft-board", "ft-floor", "ft-net", "coin", "jackpot", "fail"];

export function createFreeThrowSound() {
  const sfx = createGameSfx(STORAGE_KEY);
  return {
    get muted() { return sfx.muted; },
    /** Fetches the sounds as the court opens, so the first throw is on time. */
    prepare() { sfx.preload(IDS); },
    activate() { sfx.activate(); },
    setMuted(value: boolean) { sfx.setMuted(value); if (!value) sfx.preload(IDS); },
    // FT-01 (picking up the ball) is being made again; it stays silent until then.
    grab() {},
    throw() { sfx.play("ft-throw"); },
    rim() { sfx.play("ft-rim"); sfx.vibrate(18); },
    board() { sfx.play("ft-board"); },
    net() { sfx.play("ft-net"); sfx.vibrate([12, 30, 12]); },
    floor() { sfx.play("ft-floor"); },
    /** The net already celebrates one basket; a streak adds a coin, every fourth in a row the big cheer. */
    cheer(streak: number) { if (streak >= 2) sfx.play(streak % 4 === 0 ? "jackpot" : "coin", { delay: .15 }); },
    /** Misses come often in practice, so the music box winds down a little quieter here. */
    sad() { sfx.play("fail", { gain: .7 }); },
    dispose() { sfx.dispose(); },
  };
}
export type FreeThrowSound = ReturnType<typeof createFreeThrowSound>;
