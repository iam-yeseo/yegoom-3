import { useEffect, useRef, useState } from "react";
import "../preview.css";
import { BALANCE } from "../sample";
import { anim, confetti, dropIn, reduced, toast, tween, useOnChange } from "../motion";
import { CharacterSprite, Chevron, Coin, Toolbar, artSrc, preloadSprites, type ArtKey } from "./UI";

// The claw machine remains a device-local preview until its rules are settled.
export function PreviewGames({ gold: startGold, onBack }: {
  game?: "claw";
  me?: string;
  gold: number;
  evening?: boolean;
  onBack: () => void;
}) {
  const [gold, setGold] = useState(startGold);
  const [won, setWon] = useState(false);
  const spend = (amount: number) => setGold(value => value - amount);
  return <section className={`preview-game pg-claw ${won ? "won" : ""}`}>
    <Toolbar title="캐릭터 뽑기" onBack={onBack} gold={gold} />
    <Claw spend={spend} onWon={setWon} onBack={onBack} />
  </section>;
}

type Phase = "idle" | "down" | "close" | "up" | "carry" | "drop" | "won" | "missed";
const TARGET: ArtKey = "monkey";
const prizes: { art: ArtKey; x: number; y: number; size: number; rotate: number }[] = [
  { art: "manta", x: 2, y: 0, size: 96, rotate: -8 },
  { art: "monkey", x: 24, y: -4, size: 92, rotate: 6 },
  { art: "drop", x: 49, y: -6, size: 90, rotate: -4 },
  { art: "bread", x: 13, y: 58, size: 82, rotate: 10 },
  { art: "moon", x: 38, y: 62, size: 78, rotate: -12 },
  { art: "axolotl", x: 63, y: 44, size: 74, rotate: 8 },
];
function ClawSuccess({ tries, onBack, onAgain }: { tries: number; onBack: () => void; onAgain: () => void }) {
  const { cost, dailyTries, points } = BALANCE.claw;
  const [score, setScore] = useState(0);
  const character = useRef<HTMLDivElement>(null);
  const [landed, setLanded] = useState(reduced);
  useEffect(() => {
    let active = true;
    void preloadSprites(TARGET, ["happy"]);
    const entrance = dropIn(character.current);
    if (entrance) {
      void entrance.finished.then(() => { if (active) setLanded(true); }, () => {});
    } else setLanded(true);
    const particles = setTimeout(() => confetti(character.current, { spread: 170 }), reduced() ? 0 : 500);
    return () => { active = false; clearTimeout(particles); entrance?.cancel(); };
  }, []);
  useEffect(() => tween(0, points, 700, (v) => setScore(Math.round(v))), [points]);
  return (
    <div className="pg-claw-success">
      <div className="pg-celebration">
        <i />
        <i />
        <i />
        <i />
        <i />
        <span />
        <div ref={character} className={`pg-win-character${landed ? " landed" : ""}`}>
          <CharacterSprite artKey={TARGET} state="happy" />
        </div>
      </div>
      <div className="pg-success-copy" role="status">
        <span>뽑았다!</span>
        <strong>+{score}점</strong>
        <small>
          오늘 남은 횟수 {tries} / {dailyTries}
        </small>
      </div>
      <div className="pg-success-actions">
        <button onClick={onBack}>확인</button>
        <button disabled={!tries} onClick={onAgain}>
          한 번 더 · {cost}G
        </button>
      </div>
    </div>
  );
}
function Claw({
  spend,
  onWon,
  onBack,
}: {
  spend: (amount: number) => void;
  onWon: (won: boolean) => void;
  onBack: () => void;
}) {
  const { cost, dailyTries, points } = BALANCE.claw;
  const [x, setX] = useState(0.32);
  const [phase, setPhase] = useState<Phase>("idle");
  const [tries, setTries] = useState(3);
  const [success, setSuccess] = useState(false);
  const [slipping, setSlipping] = useState(false);
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);
  const busyRef = useRef(false);
  const arm = useRef<HTMLDivElement>(null);
  const slip = useRef<HTMLImageElement>(null);
  const out = useRef<HTMLDivElement>(null);
  useEffect(() => () => timers.current.forEach(clearTimeout), []);
  useEffect(() => onWon(phase === "won"), [phase, onWon]);
  // The claw swings like a pendulum whenever the carriage moves.
  useOnChange(x, (before) => {
    const dir = x > before ? 1 : -1;
    anim(arm.current, [{ rotate: "0deg" }, { rotate: `${-8 * dir}deg`, offset: 0.3 }, { rotate: `${4 * dir}deg`, offset: 0.65 }, { rotate: "0deg" }], {
      dur: 620,
      ease: "inOut",
      fill: "none",
    });
  });
  useEffect(() => {
    if (!slipping || !slip.current) return;
    anim(slip.current, [
      { translate: "0 0", rotate: "0deg", opacity: 1 },
      { translate: "6px 150px", rotate: "18deg", opacity: 1, offset: 0.55 },
      { translate: "10px 120px", rotate: "10deg", opacity: 1, offset: 0.72 },
      { translate: "12px 150px", rotate: "14deg", opacity: 1, offset: 0.86 },
      { translate: "12px 150px", rotate: "14deg", opacity: 0 },
    ], { dur: 900, ease: "inOut" });
  }, [slipping]);
  const busy = !["idle", "missed", "won"].includes(phase);
  const holding = success && ["up", "carry"].includes(phase);
  function grab() {
    if (busyRef.current || busy || tries <= 0 || phase === "won") return;
    busyRef.current = true;
    const caught = Math.abs(x - 0.38) <= 0.09;
    const near = !caught && Math.abs(x - 0.38) <= 0.2;
    setSuccess(caught);
    setPhase("down");
    setTries((value) => value - 1);
    spend(cost);
    const later = (fn: () => void, delay: number) => {
      timers.current.push(setTimeout(fn, delay));
    };
    later(() => setPhase("close"), 750);
    later(() => {
      setPhase("up");
      if (near) setSlipping(true);
    }, 1100);
    later(() => {
      if (caught) {
        setPhase("carry");
        setX(0.86);
      }
    }, 1900);
    later(() => {
      setSlipping(false);
      if (!caught) {
        setPhase("missed");
        busyRef.current = false;
        return;
      }
      setPhase("drop");
      confetti(out.current);
      toast(`+${points}점`);
    }, 2400);
    later(() => {
      if (!caught) return;
      setPhase("won");
      busyRef.current = false;
    }, 3100);
  }
  function reset() {
    setPhase("idle");
    setX(0.32);
    setSuccess(false);
  }
  if (phase === "won") return <ClawSuccess tries={tries} onBack={onBack} onAgain={reset} />;
  return (
    <>
      <div className="pg-claw-heading">
        <div>
          <span>오늘 남은 횟수</span>
          <strong>
            {tries}
            <small> / {dailyTries}</small>
          </strong>
        </div>
        <span className="pg-claw-price">
          <Coin size={22} />
          {cost} / 회
        </span>
      </div>
      <div className="pg-machine">
        <div className="pg-machine-glass">
          <div className="pg-machine-rail" />
          <div className="pg-claw" style={{ left: `${x * 100}%` }}>
            <div className="pg-claw-cart" />
            <div className="pg-claw-arm" ref={arm}>
              <div className="pg-claw-rope" style={{ height: ["down", "close"].includes(phase) ? 206 : 24 }} />
              <div className="pg-claw-head">
                <i />
                <span style={{ transform: `rotate(${phase === "close" || holding || slipping ? -8 : 24}deg)` }} />
                <span style={{ transform: `rotate(${phase === "close" || holding || slipping ? 8 : -24}deg)` }} />
              </div>
              {holding && <img className={phase === "carry" ? "carrying" : ""} src={artSrc(TARGET)} alt="" />}
              {slipping && <img ref={slip} src={artSrc(TARGET)} alt="" />}
            </div>
          </div>
          <div className="pg-out" ref={out}>
            OUT
          </div>
          {prizes
            .filter((prize) => !((holding || slipping || phase === "drop") && prize.art === TARGET))
            .map((prize) => (
              <img
                key={prize.art}
                className="pg-prize"
                src={artSrc(prize.art)}
                alt=""
                style={{
                  left: `${prize.x}%`,
                  bottom: prize.y,
                  width: prize.size,
                  height: prize.size,
                  transform: `rotate(${prize.rotate}deg)`,
                }}
              />
            ))}
        </div>
      </div>
      <div className="pg-claw-controls">
        <button
          aria-label="집게 왼쪽으로"
          disabled={busy || !tries}
          onClick={() => {
            setX((value) => Math.max(0.12, value - 0.1));
            setPhase("idle");
          }}
        >
          <Chevron size={26} width={2.8} />
        </button>
        <button
          aria-label="집게 오른쪽으로"
          disabled={busy || !tries}
          onClick={() => {
            setX((value) => Math.min(0.7, value + 0.1));
            setPhase("idle");
          }}
        >
          <Chevron direction="right" size={26} width={2.8} />
        </button>
        <button disabled={busy || !tries} onClick={grab} aria-live="polite">
          {busy ? "두근두근…" : !tries ? "내일 다시" : phase === "missed" ? "아깝다!" : "잡기"}
        </button>
      </div>
    </>
  );
}
