import { useEffect, useRef, useState, type PointerEvent } from "react";
import { SectionTitle, Toolbar, art, artSrc, type ArtKey } from "../components/UI";
import { BALANCE, kstParts } from "../sample";
import { ShopCards } from "./Home";

export function ShopMain({ go }: { go: (path: string) => void }) {
  return (
    <div className="shop-main">
      <header className="tab-header">
        <h1>상점</h1>
      </header>
      <div className="screen-body stack">
        <SectionTitle title="복권" />
        <ShopCards go={go} />
      </div>
    </div>
  );
}

const winColors = ["#FFD866", "#FF8E7A", "#B9A3F0", "#8CC8F2", "#8FD9C0"];
const winning = [4, 9, 13, 18, 22];
const tickets = [
  [4, 9, 13, 20, 25],
  [1, 7, 12, 16, 24],
];
function clock(seconds: number) {
  return [Math.floor(seconds / 3600), Math.floor((seconds % 3600) / 60), seconds % 60]
    .map((v) => String(v).padStart(2, "0"))
    .join(":");
}
function secondsToDraw() {
  const t = kstParts();
  const now = new Date();
  return Math.max(0, (BALANCE.lotto.drawHour - t.hour) * 3600 - t.minute * 60 - now.getSeconds());
}

export function Lotto({ gold, onBack }: { gold: number; onBack: () => void }) {
  const [left, setLeft] = useState(secondsToDraw);
  const [picks, setPicks] = useState<number[]>([3, 11, 18]);
  const [bought, setBought] = useState(tickets);
  useEffect(() => {
    const timer = window.setInterval(() => setLeft(secondsToDraw()), 1000);
    return () => clearInterval(timer);
  }, []);
  const { picks: need, max, price } = BALANCE.lotto;
  if (left <= 0) {
    return (
      <div className="lotto result">
        <div className="lotto-hero result">
          <Toolbar title="로또" onBack={onBack} gold={gold} />
          <div className="draw">
            <span>
              {kstParts().month}월 {kstParts().day}일 당첨 번호
            </span>
            <div>
              {winning.map((n, i) => (
                <i key={n} style={{ background: winColors[i], color: i ? "#fff" : "#5C4300" }}>
                  {n}
                </i>
              ))}
            </div>
          </div>
        </div>
        <div className="screen-body stack">
          {bought.map((ticket, t) => {
            const matched = ticket.filter((n) => winning.includes(n)).length;
            const won = matched >= 3;
            return (
              <section className="card ticket" key={t}>
                <div className="card-head">
                  <span className={`ticket-tag ${won ? "won" : ""}`}>
                    {won ? `4등 · ${matched}개 일치` : `${matched}개 일치`}
                  </span>
                  <b className={won ? "gain" : "none"}>{won ? "+1,000G" : "꽝"}</b>
                </div>
                <div className="ticket-balls">
                  {ticket.map((n) => {
                    const at = winning.indexOf(n);
                    return (
                      <i
                        key={n}
                        style={at >= 0 ? { background: winColors[at], color: at ? "#fff" : "#5C4300" } : undefined}
                      >
                        {n}
                      </i>
                    );
                  })}
                </div>
              </section>
            );
          })}
          <p className="next-draw">다음 추첨 · 내일 17:00</p>
        </div>
      </div>
    );
  }
  const full = picks.length === need;
  return (
    <div className="lotto">
      <div className="lotto-hero">
        <Toolbar title="로또" onBack={onBack} gold={gold} />
        <div className="hero-number-row">
          <div className="hero-number">
            <span>구매 마감까지</span>
            <strong className="countdown-number">{clock(left)}</strong>
          </div>
          <div className="lotto-meta">
            <span>17:00 추첨</span>
            <small>장당 {price}G</small>
          </div>
        </div>
      </div>
      <div className="screen-body stack">
        <section className="card lotto-picker">
          <div className="card-head">
            <h2>
              {picks.length} / {need}
            </h2>
            <button
              className="auto-button"
              onClick={() => {
                const next = [...picks];
                while (next.length < need) {
                  const n = 1 + Math.floor(Math.random() * max);
                  if (!next.includes(n)) next.push(n);
                }
                setPicks(next);
              }}
            >
              자동
            </button>
          </div>
          <div className="balls">
            {Array.from({ length: max }, (_, i) => {
              const n = i + 1;
              const on = picks.includes(n);
              return (
                <button
                  key={n}
                  aria-pressed={on}
                  onClick={() =>
                    setPicks((prev) =>
                      on ? prev.filter((x) => x !== n) : prev.length < need ? [...prev, n] : prev,
                    )
                  }
                >
                  {n}
                </button>
              );
            })}
          </div>
        </section>
        <section className="card my-tickets">
          <span>오늘 산 로또 {bought.length}장</span>
          {bought.map((ticket, i) => (
            <div key={i}>
              {ticket.map((n) => (
                <i key={n}>{n}</i>
              ))}
            </div>
          ))}
        </section>
      </div>
      <div className="game-actions">
        <button
          className="primary-button"
          disabled={!full}
          onClick={() => {
            setBought((prev) => [...prev, [...picks].sort((a, b) => a - b)]);
            setPicks([]);
          }}
        >
          {full ? `1장 사기 · ${price}G` : `${need - picks.length}개 더 골라주세요`}
        </button>
      </div>
    </div>
  );
}

const symbols: ArtKey[] = ["cat", "cat", "cat"];
export function Speetto({ gold, onBack }: { gold: number; onBack: () => void }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const strokes = useRef(0);
  const scratching = useRef(false);
  const [revealed, setRevealed] = useState(false);
  const [round, setRound] = useState(0);
  useEffect(() => {
    const node = canvas.current;
    const ctx = node?.getContext("2d");
    if (!node || !ctx) return;
    strokes.current = 0;
    ctx.globalCompositeOperation = "source-over";
    const gradient = ctx.createLinearGradient(0, 0, node.width, node.height);
    gradient.addColorStop(0, "#D8CCF7");
    gradient.addColorStop(1, "#C4DFF5");
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, node.width, node.height);
    ctx.fillStyle = "rgba(255,255,255,.35)";
    for (let i = 0; i < 60; i++) {
      ctx.beginPath();
      ctx.arc((i * 97) % node.width, (i * 53) % node.height, 6, 0, 7);
      ctx.fill();
    }
    ctx.fillStyle = "#fff";
    ctx.font = "800 40px Pretendard Variable, Pretendard, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("여기를 긁어보세요", node.width / 2, node.height / 2);
  }, [round]);
  function scratch(e: PointerEvent<HTMLCanvasElement>) {
    const node = canvas.current;
    const ctx = node?.getContext("2d");
    if (!node || !ctx) return;
    const rect = node.getBoundingClientRect();
    ctx.globalCompositeOperation = "destination-out";
    ctx.beginPath();
    ctx.arc(
      ((e.clientX - rect.left) * node.width) / rect.width,
      ((e.clientY - rect.top) * node.height) / rect.height,
      34,
      0,
      7,
    );
    ctx.fill();
    strokes.current += 1;
    if (strokes.current > 90) setRevealed(true);
  }
  return (
    <div className="speetto">
      <Toolbar title="스피또" onBack={onBack} gold={gold} />
      <p className="speetto-rule">같은 캐릭터 3개면 당첨</p>
      <div className="screen-body">
        <section className="scratch-card">
          <div className="card-head">
            <h2>예굼 스피또</h2>
            <span>No. {String(412 + round).padStart(4, "0")}</span>
          </div>
          <div className="scratch-area">
            <div className="scratch-symbols">
              {symbols.map((key, i) => (
                <span key={i} style={{ background: art[key].tint }}>
                  <img className="character" src={artSrc(key)} alt={art[key].name} />
                </span>
              ))}
            </div>
            <canvas
              ref={canvas}
              width="652"
              height="300"
              className={revealed ? "revealed" : ""}
              aria-label="긁는 영역. 손가락이나 마우스로 문질러 주세요."
              onPointerDown={(e) => {
                e.currentTarget.setPointerCapture(e.pointerId);
                scratching.current = true;
                scratch(e);
              }}
              onPointerMove={(e) => scratching.current && scratch(e)}
              onPointerUp={() => {
                scratching.current = false;
              }}
              onPointerCancel={() => {
                scratching.current = false;
              }}
            />
          </div>
          <div className={`scratch-result ${revealed ? "won" : ""}`} aria-live="polite">
            {revealed ? `당첨! +${BALANCE.speetto.prize.toLocaleString("ko-KR")}G` : "?"}
          </div>
          {!revealed && (
            <button className="text-button" onClick={() => setRevealed(true)}>
              한 번에 열기
            </button>
          )}
        </section>
      </div>
      <div className="game-actions">
        <button
          className="primary-button"
          onClick={() => {
            setRevealed(false);
            setRound((r) => r + 1);
          }}
        >
          한 장 더 · {BALANCE.speetto.price}G
        </button>
      </div>
    </div>
  );
}
