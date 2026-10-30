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
import { Avatar, Chevron, Coin, Toolbar, artSrc, type ArtKey } from "./UI";

type Game = "catchmind" | "kuji" | "claw";
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
  const title =
    game === "kuji"
      ? "예굼쿠지"
      : game === "claw"
        ? "캐릭터 뽑기"
        : catchView === "draw"
          ? "그림 그리기"
          : "캐치마인드";
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
      ) : game === "kuji" ? (
        <Kuji spend={spend} />
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
        <div className="pg-fail-nodes" aria-label={`오답 ${fails}회, ${endAfter}회면 종료`}>
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
      {hinted && !solved && !ended && (
        <div className="pg-hint" aria-label="첫 글자 힌트: 눈, 세 글자">
          <span>눈</span>
          <span />
          <span />
        </div>
      )}
      {!solved && (
        <div className="pg-wrong-words">
          {log.map((item, i) => (
            <span key={i}>
              {item.who} · {item.word}
            </span>
          ))}
        </div>
      )}
      <div aria-live="polite">
        {solved && (
          <div className="pg-correct">
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
      <form className="pg-answer" onSubmit={submit}>
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
  const drawing = useRef(false);
  const [ink, setInk] = useState("#5E6A8A");
  const [size, setSize] = useState(1);
  const [eraser, setEraser] = useState(false);
  const [hasDrawing, setHasDrawing] = useState(false);
  const [posted, setPosted] = useState(false);
  function point(e: PointerEvent<HTMLCanvasElement>) {
    const node = canvas.current!;
    const rect = node.getBoundingClientRect();
    return [
      ((e.clientX - rect.left) * node.width) / rect.width,
      ((e.clientY - rect.top) * node.height) / rect.height,
    ];
  }
  function down(e: PointerEvent<HTMLCanvasElement>) {
    if (e.button !== 0 || posted) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    const ctx = canvas.current?.getContext("2d");
    if (!ctx) return;
    const [x, y] = point(e);
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.lineWidth = [6, 12, 24][size] * (eraser ? 2.5 : 1);
    ctx.strokeStyle = ink;
    ctx.globalCompositeOperation = eraser ? "destination-out" : "source-over";
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + 0.1, y);
    ctx.stroke();
    drawing.current = true;
    setHasDrawing(true);
  }
  function move(e: PointerEvent<HTMLCanvasElement>) {
    if (!drawing.current) return;
    const ctx = canvas.current?.getContext("2d");
    if (!ctx) return;
    const [x, y] = point(e);
    ctx.lineTo(x, y);
    ctx.stroke();
  }
  function clear() {
    const node = canvas.current;
    node?.getContext("2d")?.clearRect(0, 0, node.width, node.height);
    setHasDrawing(false);
  }
  const stop = () => {
    drawing.current = false;
  };
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
          <button onClick={clear}>전체 지우기</button>
        </div>
      </div>
      <button
        className="primary-button pg-full"
        disabled={!hasDrawing || posted}
        onClick={() => setPosted(true)}
      >
        {posted ? "올렸어요" : "올리기"}
      </button>
    </div>
  );
}

const gradeColors = ["#FFD866", "#FF8E7A", "#B9A3F0", "#8CC8F2", "#8FD9C0", "#FFE6DF", "#EEE8FC", "#E3F1FC"];
const gradeText = ["#5C4300", "#fff", "#fff", "#fff", "#fff", "#C9533E", "#7556C4", "#3B7FB3"];
const totals = [1, 2, 3, 6, 10, 15, 25, 38];
function makeBoard() {
  let seed = 7;
  const random = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const pool = totals.flatMap((count, grade) => Array.from({ length: count }, () => grade));
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  const indices = Array.from({ length: 100 }, (_, i) => i);
  for (let i = indices.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [indices[i], indices[j]] = [indices[j], indices[i]];
  }
  const used = new Set(indices.slice(0, 37));
  return pool.map((grade, i) => ({ grade, taken: used.has(i) }));
}
function Kuji({ spend }: { spend: (amount: number) => void }) {
  const { price, raisedPrice, raiseFrom, boughtToday } = BALANCE.kuji;
  const [board, setBoard] = useState(makeBoard);
  const [selected, setSelected] = useState<number[]>([]);
  const [drawn, setDrawn] = useState<number[]>([]);
  const [count, setCount] = useState(boughtToday);
  const remaining = board.filter((cell) => !cell.taken).length;
  const cost = selected.reduce((sum, _, i) => sum + (count + i + 1 >= raiseFrom ? raisedPrice : price), 0);
  function draw() {
    if (!selected.length) return;
    spend(cost);
    setDrawn(selected.map((i) => board[i].grade));
    setBoard((previous) => previous.map((cell, i) => (selected.includes(i) ? { ...cell, taken: true } : cell)));
    setCount((value) => value + selected.length);
    setSelected([]);
  }
  return (
    <>
      <div className="pg-kuji-heading">
        <div>
          <span>남은 칸</span>
          <strong>
            {remaining}
            <small>/ 100</small>
          </strong>
        </div>
        <img src={artSrc("drop")} alt="" />
      </div>
      <div className="pg-stack">
        <div className="pg-card pg-kuji-board" aria-label="쿠지판 100칸">
          {board.map((cell, i) => (
            <button
              key={i}
              type="button"
              aria-label={`${i + 1}번 칸${cell.taken ? `, 이미 뽑힌 ${String.fromCharCode(65 + cell.grade)}상` : selected.includes(i) ? ", 선택됨" : ""}`}
              aria-pressed={selected.includes(i)}
              disabled={cell.taken}
              className={selected.includes(i) ? "selected" : ""}
              onClick={() => {
                setSelected((value) => (value.includes(i) ? value.filter((n) => n !== i) : [...value, i]));
                setDrawn([]);
              }}
            >
              {cell.taken ? String.fromCharCode(65 + cell.grade) : selected.includes(i) ? "✓" : ""}
            </button>
          ))}
        </div>
        <div className="pg-kuji-legend">
          {totals.map((total, i) => {
            const left = board.filter((cell) => cell.grade === i && !cell.taken).length;
            return (
              <div key={i}>
                <b style={{ background: gradeColors[i], color: gradeText[i] }}>{String.fromCharCode(65 + i)}</b>
                <span className={left ? "" : "gone"}>
                  {left}
                  <small>/{total}</small>
                </span>
              </div>
            );
          })}
        </div>
        <div className="pg-kuji-cost">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#94700A" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M12 19V5M6 11l6-6 6 6" />
          </svg>
          <span>
            오늘 {count}장 · {raiseFrom}장째부터 장당 {raisedPrice}G
          </span>
          <div aria-hidden="true">
            {Array.from({ length: raiseFrom - 1 }, (_, i) => (
              <i key={i} style={{ background: i < count + selected.length ? "#F2C94C" : "#EDE3C4" }} />
            ))}
          </div>
        </div>
        <button className="primary-button pg-full" disabled={!selected.length} onClick={draw}>
          {selected.length ? `${selected.length}장 뽑기 · ${cost.toLocaleString("ko-KR")}G` : "칸을 골라주세요"}
        </button>
        {drawn.length > 0 && (
          <div className="pg-card pg-kuji-result" role="status">
            <strong>뽑은 쿠지</strong>
            <div>
              {drawn.map((grade, i) => (
                <span key={i} style={{ background: gradeColors[grade], color: gradeText[grade] }}>
                  {String.fromCharCode(65 + grade)}상
                </span>
              ))}
            </div>
          </div>
        )}
      </div>
    </>
  );
}

type Phase = "idle" | "down" | "close" | "up" | "carry" | "won" | "missed";
const TARGET: ArtKey = "monkey";
const prizes: { art: ArtKey; x: number; y: number; size: number; rotate: number }[] = [
  { art: "manta", x: 2, y: 0, size: 96, rotate: -8 },
  { art: "monkey", x: 24, y: -4, size: 92, rotate: 6 },
  { art: "drop", x: 49, y: -6, size: 90, rotate: -4 },
  { art: "bread", x: 13, y: 58, size: 82, rotate: 10 },
  { art: "moon", x: 38, y: 62, size: 78, rotate: -12 },
  { art: "axolotl", x: 63, y: 44, size: 74, rotate: 8 },
];
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
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);
  const busyRef = useRef(false);
  useEffect(() => () => timers.current.forEach(clearTimeout), []);
  useEffect(() => onWon(phase === "won"), [phase, onWon]);
  const busy = !["idle", "missed", "won"].includes(phase);
  const holding = success && ["up", "carry"].includes(phase);
  function grab() {
    if (busyRef.current || busy || tries <= 0 || phase === "won") return;
    busyRef.current = true;
    const caught = Math.abs(x - 0.38) <= 0.09;
    setSuccess(caught);
    setPhase("down");
    setTries((value) => value - 1);
    spend(cost);
    const later = (fn: () => void, delay: number) => {
      timers.current.push(setTimeout(fn, delay));
    };
    later(() => setPhase("close"), 750);
    later(() => setPhase("up"), 1100);
    later(() => {
      if (caught) {
        setPhase("carry");
        setX(0.86);
      }
    }, 1900);
    later(() => {
      setPhase(caught ? "won" : "missed");
      busyRef.current = false;
    }, 2400);
  }
  function reset() {
    setPhase("idle");
    setX(0.32);
    setSuccess(false);
  }
  if (phase === "won")
    return (
      <div className="pg-claw-success">
        <div className="pg-celebration">
          <i />
          <i />
          <i />
          <i />
          <i />
          <span />
          <img src={artSrc(TARGET)} alt="별숭이" />
        </div>
        <div className="pg-success-copy" role="status">
          <span>뽑았다!</span>
          <strong>+{points}점</strong>
          <small>
            오늘 남은 횟수 {tries} / {dailyTries}
          </small>
        </div>
        <div className="pg-success-actions">
          <button onClick={onBack}>확인</button>
          <button disabled={!tries} onClick={reset}>
            한 번 더 · {cost}G
          </button>
        </div>
      </div>
    );
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
            <div className="pg-claw-rope" style={{ height: ["down", "close"].includes(phase) ? 206 : 24 }} />
            <div className="pg-claw-head">
              <i />
              <span style={{ transform: `rotate(${phase === "close" || holding ? -8 : 24}deg)` }} />
              <span style={{ transform: `rotate(${phase === "close" || holding ? 8 : -24}deg)` }} />
            </div>
            {holding && <img src={artSrc(TARGET)} alt="" />}
          </div>
          <div className="pg-out">OUT</div>
          {prizes
            .filter((prize) => !(holding && prize.art === TARGET))
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
          {busy ? "두근두근…" : !tries ? "내일 다시" : phase === "missed" ? "놓쳤어요 · 다시" : "잡기"}
        </button>
      </div>
    </>
  );
}
