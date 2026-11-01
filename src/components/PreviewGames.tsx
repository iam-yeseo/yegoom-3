import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type FormEvent,
  type PointerEvent,
} from "react";
import "../preview.css";
import { BALANCE } from "../sample";
import {
  anim,
  confetti,
  dropIn,
  flipY,
  hop,
  pop,
  popIn,
  reduced,
  rise,
  shake,
  toast,
  tween,
  useMountMotion,
  useOnChange,
} from "../motion";
import { Avatar, CharacterSprite, Chevron, Coin, Toolbar, artSrc, preloadSprites, type ArtKey } from "./UI";

type Game = "catchmind" | "claw";
type CatchView = "guess" | "draw" | "result";

// These games have no server yet: boards, tries and gold change only on this
// screen. The drawer of today's 캐치마인드 picture is siwon; min draws next.
const DRAWER = "siwon";
const NEXT_DRAWER = "min";

export function PreviewGames({
  game,
  me,
  gold: startGold,
  evening,
  onBack,
}: {
  game: Game;
  me: string;
  gold: number;
  evening: boolean;
  onBack: () => void;
}) {
  const [gold, setGold] = useState(startGold);
  const [catchView, setCatchView] = useState<CatchView>(
    evening ? "result" : me === NEXT_DRAWER ? "draw" : "guess",
  );
  const [won, setWon] = useState(false);
  const spend = (amount: number) => setGold((value) => value - amount);
  const title = game === "claw" ? "캐릭터 뽑기" : catchView === "draw" ? "그림 그리기" : "캐치마인드";
  return (
    <section className={`preview-game pg-${game} ${won ? "won" : ""}`}>
      <Toolbar title={title} onBack={onBack} gold={gold} />
      {game === "catchmind" ? (
        catchView === "guess" ? (
          <Guess />
        ) : catchView === "draw" ? (
          <Drawing />
        ) : (
          <CatchResult canDraw={me === NEXT_DRAWER} onDraw={() => setCatchView("draw")} />
        )
      ) : (
        <Claw spend={spend} onWon={setWon} onBack={onBack} />
      )}
    </section>
  );
}

function Snowman() {
  return (
    <svg
      className="pg-snowman"
      width="260"
      height="280"
      viewBox="0 0 260 280"
      fill="none"
      stroke="#5E6A8A"
      strokeWidth="5"
      strokeLinecap="round"
      strokeLinejoin="round"
      role="img"
      aria-label="크고 작은 동그라미 두 개, 모자와 목도리, 나뭇가지 팔이 그려진 그림"
    >
      <path d="M130 118c-48 2-76 34-74 78s34 70 76 68 72-30 70-74-26-74-72-72z" />
      <path d="M131 46c-26 0-44 18-43 40s20 36 44 34 40-18 38-40-14-34-39-34z" />
      <path d="M114 78h.5M146 76h.5" strokeWidth="9" />
      <path d="M130 88l22 6-22 4" stroke="#FF8E7A" fill="#FFB9A6" />
      <path d="M112 102c10 7 26 7 36-1" />
      <path d="M60 170l-38-30M28 146l-12-4M30 146l-6 12M200 168l36-34M228 140l12-6M228 140l4 12" />
      <path d="M131 160h.5M131 190h.5M132 220h.5" strokeWidth="10" />
      <path d="M98 50h68M110 50l4-36h38l4 36" stroke="#B9A3F0" />
      <path d="M86 120c20 14 66 16 92 0" stroke="#FF8E7A" strokeWidth="9" />
    </svg>
  );
}

function Guess() {
  const { points, hintedPoints, hintAfter, endAfter } = BALANCE.catchmind;
  const [guess, setGuess] = useState("");
  const [log, setLog] = useState([
    { who: "min", word: "구름" },
    { who: "min", word: "만두" },
  ]);
  const [solved, setSolved] = useState(false);
  const fails = log.length;
  const ended = fails >= endAfter;
  const hinted = fails >= hintAfter;
  const worth = hinted ? hintedPoints : points;
  const form = useRef<HTMLFormElement>(null);
  const nodes = useRef<HTMLDivElement>(null);
  const words = useRef<HTMLDivElement>(null);
  const correct = useRef<HTMLDivElement>(null);
  useOnChange(fails, (before) => {
    if (fails <= before) return;
    shake(form.current);
    pop(nodes.current?.children[fails - 1], 1.25);
    rise(words.current?.lastElementChild);
  });
  useOnChange(solved, () => {
    if (!solved) return;
    popIn(correct.current);
    confetti(correct.current);
    hop(correct.current?.querySelector(".avatar"));
  });
  function submit(event: FormEvent) {
    event.preventDefault();
    const word = guess.trim();
    if (!word || solved || ended) return;
    if (word.replace(/\s/g, "") === "눈사람") setSolved(true);
    else setLog((prev) => [...prev, { who: "나", word }]);
    setGuess("");
  }
  return (
    <div className="pg-stack">
      <div className="pg-card pg-drawing-card">
        <div className="pg-author">
          <Avatar username={DRAWER} size={32} />
          <strong>{DRAWER}</strong>
          <span className="pg-muted">07:58</span>
          <span className={`pg-chip ${hinted ? "yellow" : "coral"}`}>{worth}점</span>
        </div>
        <div className="pg-picture">
          <Snowman />
        </div>
      </div>
      <div className="pg-fails">
        <div className="pg-between">
          <span>모두의 오답</span>
          <strong className={hinted && !solved ? "hinted" : ""}>
            {solved
              ? "정답!"
              : ended
                ? "판 종료"
                : hinted
                  ? `종료까지 ${endAfter - fails}번`
                  : `힌트까지 ${hintAfter - fails}번`}
          </strong>
        </div>
        <div className="pg-fail-nodes" ref={nodes} aria-label={`오답 ${fails}회, ${endAfter}회면 종료`}>
          {Array.from({ length: endAfter }, (_, i) => (
            <span
              key={i}
              className={`${i < fails ? "hit" : ""} ${i === hintAfter - 1 ? "hint" : ""} ${i === fails && !solved && !ended ? "next" : ""}`}
            >
              {i < fails ? "×" : i === hintAfter - 1 ? "힌트" : i === endAfter - 1 ? "끝" : ""}
            </span>
          ))}
        </div>
      </div>
      {hinted && !solved && !ended && <HintTiles />}
      {!solved && (
        <div className="pg-wrong-words" ref={words}>
          {log.map((item, i) => (
            <span key={i}>
              {item.who} · {item.word}
            </span>
          ))}
        </div>
      )}
      <div aria-live="polite">
        {solved && (
          <div className="pg-correct" ref={correct}>
            <Avatar username="yeseo" size={48} />
            <div>
              <small>내가 맞힘</small>
              <strong>눈사람</strong>
            </div>
            <b>+{worth}점</b>
          </div>
        )}
        {ended && !solved && (
          <div className="pg-ended">
            <strong>정답은 눈사람</strong>
            <span>아무도 맞히지 못했어요</span>
          </div>
        )}
      </div>
      <form className="pg-answer" onSubmit={submit} ref={form}>
        <input
          aria-label="캐치마인드 정답"
          value={guess}
          onChange={(e) => setGuess(e.target.value)}
          placeholder={solved ? "맞혔어요" : ended ? "판이 끝났어요" : "정답 입력"}
          maxLength={40}
          disabled={solved || ended}
          autoComplete="off"
        />
        <button type="submit" disabled={solved || ended || !guess.trim()}>
          정답
        </button>
      </form>
    </div>
  );
}

function HintTiles() {
  const first = useMountMotion<HTMLSpanElement>((el) => flipY(el));
  return (
    <div className="pg-hint" aria-label="첫 글자 힌트: 눈, 세 글자">
      <span ref={first}>눈</span>
      <span />
      <span />
    </div>
  );
}

function CatchResult({ canDraw, onDraw }: { canDraw: boolean; onDraw: () => void }) {
  const next = (
    <>
      <div className="pg-avatar-pair">
        <Avatar username="min" />
        <Avatar username="yeseo" />
      </div>
      <div>
        <small>다음 출제</small>
        <strong>{NEXT_DRAWER}</strong>
      </div>
      {canDraw ? <Chevron direction="right" size={20} color="#ADA4B3" /> : <span>min → yeseo → siwon</span>}
    </>
  );
  return (
    <div className="pg-stack">
      <div className="pg-card pg-result-picture">
        <div className="pg-picture">
          <Snowman />
        </div>
        <span>눈사람</span>
      </div>
      <div className="pg-card pg-winner">
        <Avatar username="min" size={64} />
        <div>
          <small>맞힌 사람</small>
          <strong>min</strong>
        </div>
        <div className="pg-winner-points">
          <b>+{BALANCE.catchmind.hintedPoints}점</b>
          <small>힌트 후 · 오답 4회</small>
        </div>
      </div>
      {canDraw ? (
        <button className="pg-card pg-next-player" onClick={onDraw}>
          {next}
        </button>
      ) : (
        <div className="pg-card pg-next-player">{next}</div>
      )}
    </div>
  );
}

const inks = [
  ["#5E6A8A", "먹색"],
  ["#FF8E7A", "코랄"],
  ["#8FD9C0", "민트"],
  ["#8CC8F2", "하늘색"],
  ["#B9A3F0", "보라색"],
  ["#FFD866", "노란색"],
] as const;
function Drawing() {
  const canvas = useRef<HTMLCanvasElement>(null);
  const last = useRef<{ x: number; y: number } | null>(null);
  const history = useRef<ImageData[]>([]);
  const [ink, setInk] = useState("#5E6A8A");
  const [size, setSize] = useState(1);
  const [eraser, setEraser] = useState(false);
  const [strokes, setStrokes] = useState(0);
  const [posted, setPosted] = useState(false);
  const context = () => canvas.current?.getContext("2d") ?? null;
  function point(e: { clientX: number; clientY: number }) {
    const node = canvas.current!;
    const rect = node.getBoundingClientRect();
    return {
      x: ((e.clientX - rect.left) * node.width) / rect.width,
      y: ((e.clientY - rect.top) * node.height) / rect.height,
    };
  }
  function down(e: PointerEvent<HTMLCanvasElement>) {
    const ctx = context();
    if (e.button !== 0 || posted || !ctx || !canvas.current) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    // Undo works per stroke: keep the canvas as it was before this one.
    history.current = [...history.current.slice(-19), ctx.getImageData(0, 0, canvas.current.width, canvas.current.height)];
    const p = point(e);
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.lineWidth = [6, 12, 24][size] * (eraser ? 2.5 : 1);
    ctx.strokeStyle = ink;
    ctx.globalCompositeOperation = eraser ? "destination-out" : "source-over";
    ctx.beginPath();
    ctx.moveTo(p.x, p.y);
    ctx.lineTo(p.x + 0.1, p.y);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(p.x, p.y);
    last.current = p;
    setStrokes((n) => n + 1);
  }
  function move(e: PointerEvent<HTMLCanvasElement>) {
    const ctx = context();
    if (!last.current || !ctx) return;
    // Coalesced events and midpoint curves keep fast strokes smooth.
    const events = e.nativeEvent.getCoalescedEvents?.() ?? [e.nativeEvent];
    for (const ev of events.length ? events : [e.nativeEvent]) {
      const p = point(ev);
      const prev = last.current;
      const mid = { x: (prev.x + p.x) / 2, y: (prev.y + p.y) / 2 };
      ctx.quadraticCurveTo(prev.x, prev.y, mid.x, mid.y);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(mid.x, mid.y);
      last.current = p;
    }
  }
  const stop = () => {
    last.current = null;
  };
  function undo() {
    const ctx = context();
    const snapshot = history.current.pop();
    if (!ctx || !snapshot) return;
    ctx.putImageData(snapshot, 0, 0);
    setStrokes((n) => Math.max(0, n - 1));
  }
  function clear() {
    const node = canvas.current;
    const ctx = context();
    if (!node || !ctx) return;
    history.current = [...history.current.slice(-19), ctx.getImageData(0, 0, node.width, node.height)];
    ctx.clearRect(0, 0, node.width, node.height);
    setStrokes(0);
  }
  return (
    <div className="pg-stack">
      <div className="pg-prompt">
        <span>제시어</span>
        <strong>우산</strong>
      </div>
      <div className="pg-card pg-canvas-card">
        <canvas
          ref={canvas}
          width="680"
          height="680"
          aria-label="우산을 그리는 캔버스. 마우스 또는 터치로 그릴 수 있어요."
          onPointerDown={down}
          onPointerMove={move}
          onPointerUp={stop}
          onPointerCancel={stop}
          onLostPointerCapture={stop}
        />
      </div>
      <div className="pg-card pg-draw-tools">
        <div className="pg-inks">
          {inks.map(([color, name]) => (
            <button
              key={color}
              aria-label={`${name} 펜`}
              aria-pressed={!eraser && ink === color}
              style={{ background: color, "--ink": color } as CSSProperties}
              onClick={() => {
                setInk(color);
                setEraser(false);
              }}
            />
          ))}
        </div>
        <div className="pg-brushes">
          {[8, 14, 22].map((diameter, i) => (
            <button
              key={i}
              aria-label={`펜 두께 ${i + 1}`}
              aria-pressed={!eraser && size === i}
              onClick={() => {
                setSize(i);
                setEraser(false);
              }}
            >
              <span style={{ width: diameter, height: diameter }} />
            </button>
          ))}
          <button aria-pressed={eraser} onClick={() => setEraser((v) => !v)}>
            지우개
          </button>
          <button onClick={undo} disabled={!history.current.length || posted} aria-label="한 획 되돌리기">
            되돌리기
          </button>
          <button onClick={clear} disabled={posted}>
            전체 지우기
          </button>
        </div>
      </div>
      <button
        className="primary-button pg-full"
        disabled={!strokes || posted}
        onClick={() => {
          setPosted(true);
          toast("그림을 올렸어요");
        }}
      >
        {posted ? "올렸어요" : "올리기"}
      </button>
    </div>
  );
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
