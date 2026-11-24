// Claw machine sounds from /sfx (docs/sfx.md 3.7) and the original gatcha-sound.js haptics.
// No audio context is created until the player interacts with the machine.
import { createGameSfx, type LoopHandle } from "../sfx";

const STORAGE_KEY = "yegoom3:claw:muted";
/** One motor sound for every direction; only its pitch changes. */
const MOTOR_RATE = { up: 1.12, down: .9, side: 1 } as const;

export function createSound() {
  const sfx = createGameSfx(STORAGE_KEY);
  let motor: LoopHandle | null = null;
  const stopMotor = () => { motor?.stop(); motor = null; };
  sfx.preload(["coin", "clw-motor", "clw-clack", "clw-slip", "clw-thud", "clw-tick", "jackpot", "fail"]);
  return {
    get muted() { return sfx.muted; },
    activate() { sfx.activate(); },
    setMuted(value: boolean) {
      sfx.setMuted(value);
      if (value) { stopMotor(); try { navigator.vibrate?.(0); } catch { /* Unsupported. */ } }
      else { stopMotor(); sfx.preload(["coin", "clw-motor", "clw-clack", "clw-slip", "clw-thud", "clw-tick", "jackpot", "fail"]); }
    },
    buzz(pattern: VibratePattern) { sfx.vibrate(pattern); },
    coin() { sfx.play("coin"); },
    tick(urgent = false) { sfx.play("clw-tick", { rate: urgent ? 1.26 : 1 }); },
    clack() { sfx.play("clw-clack"); },
    slip() { sfx.play("clw-slip"); },
    thud() { sfx.play("clw-thud"); },
    prize() { sfx.play("jackpot"); },
    sad() { sfx.play("fail"); },
    motor(kind: "up" | "down" | "side" | null) {
      if (!kind) { stopMotor(); return; }
      if (motor) { motor.setRate(MOTOR_RATE[kind]); return; }
      motor = sfx.loop("clw-motor", { rate: MOTOR_RATE[kind] });
    },
    stop() { stopMotor(); },
    dispose() { stopMotor(); sfx.dispose(); },
  };
}
export function buzz(pattern: VibratePattern) { try { navigator.vibrate?.(pattern); } catch { /* Unsupported devices stay silent. */ } }
