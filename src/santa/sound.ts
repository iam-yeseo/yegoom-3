// Santa delivery sounds from /sfx (docs/sfx.md 3.7) with the original haptics.
// The audio context starts only after the player presses something.
import { createGameSfx, type SfxId } from "../sfx";

const STORAGE_KEY = "yegoom3:santa:muted";
const IDS: SfxId[] = ["sn-start", "sn-drop", "sn-hit", "sn-rim", "sn-thud", "sn-pass", "coin", "jackpot"];

export function createSantaSound() {
  const sfx = createGameSfx(STORAGE_KEY);
  sfx.preload(IDS);
  return {
    get muted() { return sfx.muted; },
    activate() { sfx.activate(); },
    setMuted(value: boolean) { sfx.setMuted(value); if (!value) sfx.preload(IDS); },
    start() { sfx.play("sn-start"); },
    drop() { sfx.play("sn-drop"); },
    hit() { sfx.play("sn-hit"); sfx.vibrate([10, 30, 10]); },
    rim() { sfx.play("sn-rim"); sfx.vibrate(18); },
    thud() { sfx.play("sn-thud"); },
    pass() { sfx.play("sn-pass"); },
    /** Every chimney: the big win. Otherwise a coin for the deliveries made. */
    finish(perfect: boolean) { sfx.play(perfect ? "jackpot" : "coin", { delay: .2 }); },
    dispose() { sfx.dispose(); },
  };
}
export type SantaSound = ReturnType<typeof createSantaSound>;
