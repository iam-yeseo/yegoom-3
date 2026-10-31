import { useEffect, useRef, useState, type PointerEvent } from "react";
import { Coin, SectionTitle, Toolbar, art, artSrc, type ArtKey } from "../components/UI";
import { anim, confetti, crumbs, popIn, reduced, shake, tween, useCountUp } from "../motion";
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

/** 17:00 draw: winning balls roll in one by one, then my matching numbers light up. */
function LottoResult({ gold, onBack, bought }: { gold: number; onBack: () => void; bought: number[][] }) {
  const [rolled, setRolled] = useState(reduced() ? winning.length : 0);
  const done = rolled >= winning.length;
  const draw = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (done) return;
    const t = setTimeout(() => setRolled((n) => n + 1), rolled ? 520 : 300);
    return () => clearTimeout(t);
  }, [rolled, done]);
  useEffect(() => {
    if (!rolled) return;
    anim(draw.current?.children[rolled - 1], [
      { translate: "-220px 0", rotate: "-200deg", opacity: 0 },
      { translate: "0 0", rotate: "0deg", opacity: 1 },
    ], { dur: 560, ease: "out" });
    document.querySelectorAll(`.ticket-balls i[data-n="${winning[rolled - 1]}"]`).forEach((el) =>
      anim(el, [{ scale: "1" }, { scale: "1.25", offset: 0.4 }, { scale: "1" }], { dur: 420, delay: 420, ease: "out", fill: "none" }),
    );
  }, [rolled]);
  return (
    <div className="lotto result">
      <div className="lotto-hero result">
        <Toolbar title="로또" onBack={onBack} gold={gold} />
        <div className="draw">
          <span>
            {kstParts().month}월 {kstParts().day}일 당첨 번호
          </span>
          <div ref={draw}>
            {winning.map((n, i) => (
              <i key={n} style={{ background: winColors[i], color: i ? "#fff" : "#5C4300", visibility: i < rolled ? "visible" : "hidden" }}>
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
                <span className={`ticket-tag ${won && done ? "won" : ""}`} style={{ opacity: done ? 1 : 0 }}>
                  {won ? `4등 · ${matched}개 일치` : `${matched}개 일치`}
                </span>
                <b className={won ? "gain" : "none"} style={{ opacity: done ? 1 : 0 }}>
                  {won ? "+1,000G" : "꽝"}
                </b>
              </div>
              <div className="ticket-balls">
                {ticket.map((n) => {
                  const at = winning.indexOf(n);
                  const lit = at >= 0 && at < rolled;
                  return (
                    <i
                      key={n}
                      data-n={n}
                      style={lit ? { background: winColors[at], color: at ? "#fff" : "#5C4300" } : undefined}
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

export function Lotto({ gold, onBack }: { gold: number; onBack: () => void }) {
  const [left, setLeft] = useState(secondsToDraw);
  const [picks, setPicks] = useState<number[]>([3, 11, 18]);
  const [bought, setBought] = useState(tickets);
  useEffect(() => {
    const timer = window.setInterval(() => setLeft(secondsToDraw()), 1000);
    return () => clearInterval(timer);
  }, []);
  const { picks: need, max, price } = BALANCE.lotto;
  const balls = useRef<HTMLDivElement>(null);
  const pickBall = (button: HTMLElement, n: number, on: boolean) => {
    if (!on && picks.length >= need) {
      shake(button);
      return;
    }
    if (!on) anim(button, [{ scale: ".6" }, { scale: "1.18", offset: 0.6 }, { scale: "1" }], { dur: 340, fill: "none" });
    setPicks((prev) => (on ? prev.filter((x) => x !== n) : [...prev, n]));
  };
  const autoPick = () => {
    const next = [...picks];
    const added: number[] = [];
    while (next.length + added.length < need) {
      const n = 1 + Math.floor(Math.random() * max);
      if (!next.includes(n) && !added.includes(n)) added.push(n);
    }
    // Fill the empty places one at a time.
    added.forEach((n, i) =>
      setTimeout(() => {
        setPicks((prev) => (prev.length < need && !prev.includes(n) ? [...prev, n] : prev));
        anim(balls.current?.children[n - 1], [{ scale: ".6" }, { scale: "1.18", offset: 0.6 }, { scale: "1" }], { dur: 340, fill: "none" });
      }, reduced() ? 0 : i * 140),
    );
  };
  if (left <= 0) return <LottoResult gold={gold} onBack={onBack} bought={bought} />;
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
            <button className="auto-button" onClick={autoPick}>
              자동
            </button>
          </div>
          <div className="balls" ref={balls}>
            {Array.from({ length: max }, (_, i) => {
              const n = i + 1;
              const on = picks.includes(n);
              return (
                <button key={n} aria-pressed={on} data-nopress onClick={(e) => pickBall(e.currentTarget, n, on)}>
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
export function Speetto({ gold: startGold, onBack }: { gold: number; onBack: () => void }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const strokes = useRef(0);
  const scratching = useRef(false);
  const symbolsRef = useRef<HTMLDivElement>(null);
  const [revealed, setRevealed] = useState(false);
  const [round, setRound] = useState(0);
  const [prize, setPrize] = useState(0);
  const [gold, setGold] = useState(startGold);
  const shownGold = useCountUp(gold);
  // On a win: the coating fades, symbols pop in turn, confetti, then the
  // prize counts up and lands in the gold pill.
  useEffect(() => {
    if (!revealed) return;
    const syms = [...(symbolsRef.current?.children ?? [])];
    syms.forEach((el, i) => popIn(el, { delay: 450 + i * 150 }));
    const t = setTimeout(() => {
      confetti(symbolsRef.current);
      tween(0, BALANCE.speetto.prize, 900, (v) => setPrize(Math.round(v)), () => setGold((g) => g + BALANCE.speetto.prize));
    }, reduced() ? 0 : 450 + syms.length * 150);
    return () => clearTimeout(t);
  }, [revealed]);
  /** Share of the coating already scratched off, sampled on a coarse grid. */
  function cleared(node: HTMLCanvasElement) {
    const data = node.getContext("2d")!.getImageData(0, 0, node.width, node.height).data;
    let clear = 0;
    let total = 0;
    for (let y = 4; y < node.height; y += 10)
      for (let x = 4; x < node.width; x += 10) {
        total += 1;
        if (data[(y * node.width + x) * 4 + 3] < 40) clear += 1;
      }
    return clear / total;
  }
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
    ctx.font = "800 40px TmoneyRoundWind, Pretendard Variable, sans-serif";
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
    crumbs(e.clientX, e.clientY);
    strokes.current += 1;
    if (strokes.current % 8 === 0 && cleared(node) > 0.6) setRevealed(true);
  }
  return (
    <div className="speetto">
      <Toolbar
        title="스피또"
        onBack={onBack}
        right={
          <span className="gold">
            <Coin />
            {shownGold.toLocaleString("ko-KR")}
            <span className="sr-only"> 골드</span>
          </span>
        }
      />
      <p className="speetto-rule">같은 캐릭터 3개면 당첨</p>
      <div className="screen-body">
        <section className="scratch-card">
          <div className="card-head">
            <h2>예굼 스피또</h2>
            <span>No. {String(412 + round).padStart(4, "0")}</span>
          </div>
          <div className="scratch-area">
            <div className="scratch-symbols" ref={symbolsRef}>
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
            {revealed ? `당첨! +${prize.toLocaleString("ko-KR")}G` : "?"}
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
            setPrize(0);
            setGold((g) => g - BALANCE.speetto.price);
            setRound((r) => r + 1);
          }}
        >
          한 장 더 · {BALANCE.speetto.price}G
        </button>
      </div>
    </div>
  );
}
