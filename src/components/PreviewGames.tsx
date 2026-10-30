import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type FormEvent,
  type PointerEvent,
} from "react";
import "../preview.css";

type Game = "catchmind" | "kuji" | "claw";
const art = (name: string) => `/characters/${name}.png`;
const titles: Record<Game, string> = {
  catchmind: "캐치마인드",
  kuji: "예굼쿠지",
  claw: "캐릭터 뽑기",
};

export function PreviewGames({
  game,
  onBack,
}: {
  game: Game;
  onBack: () => void;
}) {
  return (
    <section className={`preview-game pg-${game}`}>
      <header className="game-toolbar">
        <button className="icon-button" onClick={onBack} aria-label="홈으로">
          ‹
        </button>
        <h1>{titles[game]}</h1>
        <span className="preview-label">체험</span>
      </header>
      {game === "catchmind" ? (
        <Catchmind />
      ) : game === "kuji" ? (
        <Kuji />
      ) : (
        <Claw />
      )}
      <p className="pg-disclaimer">
        화면 체험이에요. 실제 골드·점수는 변하지 않아요.
      </p>
    </section>
  );
}

function Avatar({
  name,
  tint,
  size = 40,
}: {
  name: string;
  tint: string;
  size?: number;
}) {
  return (
    <span
      className="pg-avatar"
      style={{ background: tint, width: size, height: size }}
    >
      <img src={art(name)} alt="" />
    </span>
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

function Catchmind() {
  const [view, setView] = useState<"guess" | "draw" | "result">("guess");
  return (
    <>
      <nav className="pg-tabs" aria-label="캐치마인드 체험 화면">
        {(
          [
            ["guess", "맞히기"],
            ["draw", "그리기"],
            ["result", "결과 보기"],
          ] as const
        ).map(([value, label]) => (
          <button
            key={value}
            type="button"
            aria-pressed={view === value}
            onClick={() => setView(value)}
          >
            {label}
          </button>
        ))}
      </nav>
      {view === "guess" ? (
        <Guess />
      ) : view === "draw" ? (
        <Drawing />
      ) : (
        <CatchResult />
      )}
    </>
  );
}

function Guess() {
  const [guess, setGuess] = useState("");
  const [log, setLog] = useState([
    { who: "min", word: "구름" },
    { who: "min", word: "만두" },
  ]);
  const [solved, setSolved] = useState(false);
  const fails = log.length;
  const ended = fails >= 6;
  const points = fails >= 3 ? 30 : 50;
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
          <Avatar name="cat" tint="#FFF4CC" size={32} />
          <strong>siwon</strong>
          <span className="pg-muted">07:58</span>
          <span className={`pg-chip ${fails >= 3 ? "yellow" : "coral"}`}>
            샘플 {points}점
          </span>
        </div>
        <div className="pg-picture">
          <Snowman />
        </div>
      </div>
      <div className="pg-fails">
        <div className="pg-between">
          <span>모두의 오답</span>
          <strong>
            {solved
              ? "정답!"
              : ended
                ? "체험 종료"
                : fails >= 3
                  ? `종료까지 ${6 - fails}번`
                  : `힌트까지 ${3 - fails}번`}
          </strong>
        </div>
        <div
          className="pg-fail-nodes"
          aria-label={`오답 ${fails}회, 6회면 종료`}
        >
          {Array.from({ length: 6 }, (_, i) => (
            <span
              key={i}
              className={`${i < fails ? "hit" : ""} ${i === 2 ? "hint" : ""} ${i === fails && !solved && !ended ? "next" : ""}`}
            >
              {i < fails ? "×" : i === 2 ? "힌트" : i === 5 ? "끝" : ""}
            </span>
          ))}
        </div>
      </div>
      {fails >= 3 && !solved && !ended && (
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
            <Avatar name="bunny" tint="#EEE8FC" size={48} />
            <div>
              <small>내가 맞힘</small>
              <strong>눈사람</strong>
            </div>
            <b>
              +{points}점 <small>샘플</small>
            </b>
          </div>
        )}
        {ended && !solved && (
          <div className="pg-ended">
            <strong>정답은 눈사람!</strong>
            <span>다음 그림에서 다시 도전해요.</span>
          </div>
        )}
      </div>
      <form className="pg-answer" onSubmit={submit}>
        <input
          aria-label="캐치마인드 정답"
          value={guess}
          onChange={(e) => setGuess(e.target.value)}
          placeholder={
            solved ? "맞혔어요" : ended ? "체험이 끝났어요" : "정답 입력"
          }
          maxLength={40}
          disabled={solved || ended}
          autoComplete="off"
        />
        <button type="submit" disabled={solved || ended || !guess.trim()}>
          정답
        </button>
      </form>
      {(solved || ended) && (
        <button
          className="pg-text-button"
          onClick={() => {
            setSolved(false);
            setLog([]);
            setGuess("");
          }}
        >
          다시 체험하기
        </button>
      )}
    </div>
  );
}

function CatchResult() {
  return (
    <div className="pg-stack">
      <div className="pg-card pg-result-picture">
        <div className="pg-picture">
          <Snowman />
        </div>
        <span>눈사람</span>
      </div>
      <div className="pg-card pg-winner">
        <Avatar name="axolotl" tint="#E3F6EE" size={64} />
        <div>
          <small>맞힌 사람</small>
          <strong>min</strong>
        </div>
        <div className="pg-winner-points">
          <b>+30점</b>
          <small>샘플 · 힌트 후 오답 4회</small>
        </div>
      </div>
      <div className="pg-card pg-next-player">
        <div className="pg-avatar-pair">
          <Avatar name="axolotl" tint="#E3F6EE" />
          <Avatar name="bunny" tint="#EEE8FC" />
        </div>
        <div>
          <small>다음 출제</small>
          <strong>min</strong>
        </div>
        <span>min → yeseo → siwon</span>
      </div>
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
  const [message, setMessage] = useState("");
  const [hasDrawing, setHasDrawing] = useState(false);
  function point(e: PointerEvent<HTMLCanvasElement>) {
    const node = canvas.current!;
    const rect = node.getBoundingClientRect();
    return [
      ((e.clientX - rect.left) * node.width) / rect.width,
      ((e.clientY - rect.top) * node.height) / rect.height,
    ];
  }
  function down(e: PointerEvent<HTMLCanvasElement>) {
    if (e.button !== 0) return;
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
    setMessage("");
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
    setMessage("그림을 지웠어요.");
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
          onPointerUp={() => {
            drawing.current = false;
          }}
          onPointerCancel={() => {
            drawing.current = false;
          }}
          onLostPointerCapture={() => {
            drawing.current = false;
          }}
        >
          마우스 또는 터치로 우산을 그려보세요.
        </canvas>
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
        disabled={!hasDrawing}
        onClick={() =>
          setMessage(
            "체험 그림을 완성했어요. 다른 플레이어에게는 전송되지 않아요.",
          )
        }
      >
        그림 완성
      </button>
      <p className="pg-message" role="status">
        {message}
      </p>
    </div>
  );
}

const gradeColors = [
  "#FFD866",
  "#FF8E7A",
  "#B9A3F0",
  "#8CC8F2",
  "#8FD9C0",
  "#FFE6DF",
  "#EEE8FC",
  "#E3F1FC",
];
const gradeText = [
  "#5C4300",
  "#fff",
  "#fff",
  "#fff",
  "#fff",
  "#C9533E",
  "#7556C4",
  "#3B7FB3",
];
const totals = [1, 2, 3, 6, 10, 15, 25, 38];
function makeBoard() {
  let seed = 7;
  const random = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const pool = totals.flatMap((count, grade) =>
    Array.from({ length: count }, () => grade),
  );
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
function Kuji() {
  const [board, setBoard] = useState(makeBoard);
  const [selected, setSelected] = useState<number[]>([]);
  const [drawn, setDrawn] = useState<number[]>([]);
  const [count, setCount] = useState(4);
  const remaining = board.filter((cell) => !cell.taken).length;
  const cost = selected.reduce(
    (sum, _, i) => sum + (count + i + 1 > 5 ? 400 : 300),
    0,
  );
  function draw() {
    if (!selected.length) return;
    setDrawn(selected.map((i) => board[i].grade));
    setBoard((previous) =>
      previous.map((cell, i) =>
        selected.includes(i) ? { ...cell, taken: true } : cell,
      ),
    );
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
        <img src={art("drop")} alt="" />
      </div>
      <div className="pg-stack">
        <div className="pg-card pg-kuji-board" aria-label="쿠지 체험판 100칸">
          {board.map((cell, i) => (
            <button
              key={i}
              type="button"
              aria-label={`${i + 1}번 칸${cell.taken ? `, 이미 뽑힌 ${String.fromCharCode(65 + cell.grade)}상` : selected.includes(i) ? ", 선택됨" : ""}`}
              aria-pressed={selected.includes(i)}
              disabled={cell.taken}
              className={selected.includes(i) ? "selected" : ""}
              onClick={() => {
                setSelected((value) =>
                  value.includes(i)
                    ? value.filter((n) => n !== i)
                    : [...value, i],
                );
                setDrawn([]);
              }}
            >
              {cell.taken
                ? String.fromCharCode(65 + cell.grade)
                : selected.includes(i)
                  ? "✓"
                  : ""}
            </button>
          ))}
        </div>
        <div className="pg-kuji-legend">
          {totals.map((total, i) => (
            <div key={i}>
              <b style={{ background: gradeColors[i], color: gradeText[i] }}>
                {String.fromCharCode(65 + i)}
              </b>
              <span>
                {board.filter((cell) => cell.grade === i && !cell.taken).length}
                <small>/{total}</small>
              </span>
            </div>
          ))}
        </div>
        <div className="pg-kuji-cost">
          <b>↑</b>
          <span>체험 {count}장 · 6장째부터 장당 400G</span>
          <div>
            {Array.from({ length: 5 }, (_, i) => (
              <i
                key={i}
                style={{
                  background:
                    i < count + selected.length ? "#F2C94C" : "#EDE3C4",
                }}
              />
            ))}
          </div>
        </div>
        <button
          className="primary-button pg-full"
          disabled={!selected.length}
          onClick={draw}
        >
          {selected.length
            ? `${selected.length}장 체험 · ${cost.toLocaleString()}G`
            : "칸을 골라주세요"}
        </button>
        {drawn.length > 0 && (
          <div className="pg-card pg-kuji-result" role="status">
            <strong>체험 결과</strong>
            <div>
              {drawn.map((grade, i) => (
                <span
                  key={i}
                  style={{
                    background: gradeColors[grade],
                    color: gradeText[grade],
                  }}
                >
                  {String.fromCharCode(65 + grade)}상
                </span>
              ))}
            </div>
            <small>실제 구매·보상 지급은 없어요.</small>
          </div>
        )}
        <button
          className="pg-text-button"
          onClick={() => {
            setBoard(makeBoard());
            setSelected([]);
            setDrawn([]);
            setCount(4);
          }}
        >
          체험판 다시 시작
        </button>
      </div>
    </>
  );
}

type Phase = "idle" | "down" | "close" | "up" | "carry" | "won" | "missed";
const prizes = [
  { name: "manta", x: 2, y: 0, size: 96, rotate: -8 },
  { name: "sprite", x: 24, y: -4, size: 92, rotate: 6 },
  { name: "drop", x: 49, y: -6, size: 90, rotate: -4 },
  { name: "popcorn", x: 13, y: 58, size: 82, rotate: 10 },
  { name: "moon", x: 38, y: 62, size: 78, rotate: -12 },
  { name: "axolotl", x: 63, y: 44, size: 74, rotate: 8 },
];
function Claw() {
  const [x, setX] = useState(0.32);
  const [phase, setPhase] = useState<Phase>("idle");
  const [tries, setTries] = useState(3);
  const [success, setSuccess] = useState(false);
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);
  const busyRef = useRef(false);
  useEffect(() => () => timers.current.forEach(clearTimeout), []);
  const busy = !["idle", "missed", "won"].includes(phase);
  const holding = success && ["up", "carry"].includes(phase);
  function grab() {
    if (busyRef.current || busy || tries <= 0 || phase === "won") return;
    busyRef.current = true;
    const caught = Math.abs(x - 0.38) <= 0.09;
    setSuccess(caught);
    setPhase("down");
    setTries((value) => value - 1);
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
  function retry() {
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
          <img src={art("sprite")} alt="별귀 꿈 요정 캐릭터" />
        </div>
        <div className="pg-success-copy">
          <span>뽑았다!</span>
          <strong>성공!</strong>
          <b>
            +30점 <small>샘플</small>
          </b>
          <small>체험 남은 횟수 {tries} / 5</small>
        </div>
        <div className="pg-success-actions">
          <button onClick={retry}>확인</button>
          <button disabled={!tries} onClick={retry}>
            한 번 더 · 체험
          </button>
        </div>
      </div>
    );
  return (
    <>
      <div className="pg-claw-heading">
        <div>
          <span>체험 남은 횟수</span>
          <strong>
            {tries}
            <small> / 5</small>
          </strong>
        </div>
        <span className="pg-claw-price">
          <i>G</i>200 / 회 · 샘플
        </span>
      </div>
      <div className="pg-machine">
        <div className="pg-machine-glass">
          <div className="pg-machine-rail" />
          <div className="pg-claw" style={{ left: `${x * 100}%` }}>
            <div className="pg-claw-cart" />
            <div
              className="pg-claw-rope"
              style={{ height: ["down", "close"].includes(phase) ? 206 : 24 }}
            />
            <div className="pg-claw-head">
              <i />
              <span
                style={{
                  transform: `rotate(${phase === "close" || holding ? -8 : 24}deg)`,
                }}
              />
              <span
                style={{
                  transform: `rotate(${phase === "close" || holding ? 8 : -24}deg)`,
                }}
              />
            </div>
            {holding && <img src={art("sprite")} alt="" />}
          </div>
          <div className="pg-out">OUT</div>
          {prizes
            .filter((_, i) => !(holding && i === 1))
            .map((prize) => (
              <img
                key={prize.name}
                className="pg-prize"
                src={art(prize.name)}
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
          ‹
        </button>
        <button
          aria-label="집게 오른쪽으로"
          disabled={busy || !tries}
          onClick={() => {
            setX((value) => Math.min(0.7, value + 0.1));
            setPhase("idle");
          }}
        >
          ›
        </button>
        <button disabled={busy || !tries} onClick={grab}>
          {busy ? "두근두근…" : !tries ? "체험 완료" : "잡기"}
        </button>
      </div>
      <p className="pg-message" aria-live="polite">
        {phase === "missed"
          ? "앗, 놓쳤어요! 별귀 요정 위에 집게를 맞춰보세요."
          : "집게를 움직여 별귀 요정을 잡아보세요."}
      </p>
      {!tries && (
        <button
          className="pg-text-button"
          onClick={() => {
            setTries(3);
            retry();
          }}
        >
          다시 체험하기
        </button>
      )}
    </>
  );
}
