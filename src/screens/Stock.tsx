import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Avatar, Character, Coin, Segmented, Toolbar, art, artSrc, honorific, useDisplayNameLookup } from "../components/UI";
import { anim, openSheet, pop, toast, useCountUp, useMountMotion, useOnChange } from "../motion";
import { formatTime } from "../format";
import { LIMIT, marketOpen, stocks as sampleStocks, type Stock } from "../sample";

const won = (n: number) => n.toLocaleString("ko-KR");
const signed = (n: number) => `${n > 0 ? "+" : n < 0 ? "−" : ""}${won(Math.abs(n))}`;
const percent = (n: number) => `${n > 0 ? "+" : n < 0 ? "−" : ""}${Math.abs(n).toFixed(1)}%`;
const upDown = (n: number) => (n > 0 ? "up" : "down");

// Sample market: while it is open, every listed stock moves a little every
// 2.6 seconds, capped at ±15% of the previous close. Shared by the list and
// the detail screen; nothing is stored.
let market: Stock[] = sampleStocks.map((s) => ({ ...s }));
const closes = new Map(sampleStocks.map((s) => [s.id, s.change === null ? 0 : Math.round(s.price / (1 + s.change / 100))]));
const listeners = new Set<() => void>();
let ticker = 0;
function tick() {
  market = market.map((s) => {
    if (s.change === null || Math.random() < 0.35) return s;
    const close = closes.get(s.id)!;
    const next = Math.round(s.price * (1 + (Math.random() - 0.5) * 0.03));
    const price = Math.min(Math.round(close * (1 + LIMIT / 100)), Math.max(Math.round(close * (1 - LIMIT / 100)), next));
    return { ...s, price, change: Math.round(((price - close) / close) * 1000) / 10 };
  });
  listeners.forEach((l) => l());
}
function subscribe(listener: () => void) {
  listeners.add(listener);
  if (!ticker) ticker = window.setInterval(() => marketOpen() && tick(), 2600);
  return () => {
    listeners.delete(listener);
    if (!listeners.size) {
      clearInterval(ticker);
      ticker = 0;
    }
  };
}
function useMarket() {
  return useSyncExternalStore(subscribe, () => market);
}
function trade(id: string, qty: number) {
  market = market.map((s) => {
    if (s.id !== id) return s;
    const held = Math.max(0, s.held + qty);
    const average = qty > 0 ? Math.round((s.average * s.held + s.price * qty) / held) : held ? s.average : 0;
    return { ...s, held, average };
  });
  listeners.forEach((l) => l());
}

function badge(stock: Stock) {
  if (stock.change === null) return { label: "상장폐지", className: "delisted" };
  if (stock.change >= LIMIT) return { label: "상한가", className: "limit-up" };
  if (stock.change <= -LIMIT) return { label: "하한가", className: "limit-down" };
  return null;
}
/** A badge that pulses once with a spreading ring when it appears. */
function Badge({ stock, big }: { stock: Stock; big?: boolean }) {
  const tag = badge(stock);
  const ref = useRef<HTMLElement>(null);
  useEffect(() => {
    if (!tag || !ref.current) return;
    pop(ref.current, 1.14, { dur: 700 });
    ref.current.classList.remove("ring");
    void ref.current.offsetWidth;
    ref.current.classList.add("ring");
  }, [tag?.label]);
  if (!tag) return null;
  return (
    <em ref={ref} className={`${tag.className} ${big ? "big" : ""}`}>
      {tag.label}
    </em>
  );
}
/** Deterministic random walk from `start` to `end`, used for sample charts. */
function series(seed: number, n: number, start: number, end: number, volatility: number) {
  let value = start;
  let s = seed;
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    s = (s * 16807) % 2147483647;
    const t = i / (n - 1);
    value = start + (end - start) * t + (s / 2147483647 - 0.5) * volatility * (1 - t * 0.6);
    out.push(value);
  }
  out[n - 1] = end;
  return out;
}
function line(values: number[], width: number, height: number, low: number, high: number, slots = values.length) {
  return values
    .map((v, i) => `${i ? "L" : "M"}${((i / (slots - 1)) * width).toFixed(1)} ${(height - ((v - low) / (high - low)) * height).toFixed(1)}`)
    .join(" ");
}

function StockRow({ stock, dim, go }: { stock: Stock; dim?: boolean; go: (path: string) => void }) {
  const delisted = stock.change === null;
  const row = useRef<HTMLButtonElement>(null);
  const price = useCountUp(stock.price, 320);
  useOnChange(stock.price, (before) => {
    const color = stock.price > before ? "rgba(255,142,122,.16)" : "rgba(140,200,242,.2)";
    anim(row.current, [{ backgroundColor: color }, { backgroundColor: "rgba(255,255,255,0)" }], { dur: 800, ease: "out", fill: "none" });
  });
  return (
    <button ref={row} onClick={() => go(`/stock/${stock.id}`)} className={`stock-row ${delisted ? "delisted" : ""}`}>
      <span className="stock-icon" style={{ background: dim ? "#F3EEE8" : delisted ? "#F1ECE6" : art[stock.art].tint }}>
        <img className={`character ${dim ? "dim" : ""}`} src={artSrc(stock.art)} alt="" />
      </span>
      <span className="stock-name">
        <span>
          <strong>{stock.name}</strong>
          {!dim && <Badge stock={stock} />}
        </span>
        {!dim && <small>{delisted ? "거래 중지" : stock.held ? `${stock.held}주 보유` : ""}</small>}
      </span>
      <span className="stock-price">
        <strong>{delisted ? "—" : won(price)}</strong>
        {stock.change !== null && <small className={upDown(stock.change)}>{percent(stock.change)}</small>}
      </span>
    </button>
  );
}

export function StockMarket({ gold, onBack, go }: { gold: number; onBack: () => void; go: (path: string) => void }) {
  const displayNameOf = useDisplayNameLookup();
  const list = useMarket();
  const holdings = list.filter((s) => s.held && s.change !== null);
  const value = useCountUp(holdings.reduce((sum, s) => sum + s.held * s.price, 0));
  const cost = holdings.reduce((sum, s) => sum + s.held * s.average, 0);
  if (!marketOpen()) {
    const profits = [
      ["yeseo", 2140],
      ["min", 480],
      ["siwon", -320],
    ] as const;
    return (
      <div className="stock closed">
        <div className="stock-hero closed">
          <Toolbar title="주식 시장" onBack={onBack} gold={gold} />
          <div className="closed-moon">
            <Character artKey="moon" className="bob-slow" />
          </div>
          <div className="closed-copy">
            <h2>장 마감</h2>
            <p>평일 {formatTime("09:00")} 개장</p>
          </div>
        </div>
        <div className="screen-body stack">
          <section className="card profit-rank">
            <div className="card-head">
              <h2>이번 주 수익</h2>
              <span>금액 순위로 점수</span>
            </div>
            {profits.map(([name, amount], i) => (
              <div className="list-row" key={name}>
                <span className="plain-rank">{i + 1}</span>
                <Avatar username={name} size={38} />
                <strong>{honorific(displayNameOf(name))}</strong>
                <b className={upDown(amount)}>{signed(amount)}G</b>
              </div>
            ))}
          </section>
          <section className="card stock-list">
            {[list[0], list[2], list[5], list[3]].map((stock) => (
              <StockRow key={stock.id} stock={stock} dim go={go} />
            ))}
          </section>
        </div>
      </div>
    );
  }
  return (
    <div className="stock">
      <div className="stock-hero">
        <Toolbar title="주식 시장" onBack={onBack} gold={gold} />
        <div className="hero-number">
          <div className="hero-number-top">
            <span>내 주식</span>
            <span className="market-pill">
              <i />
              {formatTime("18:00")} 마감
            </span>
          </div>
          <p>
            <strong>{won(value)}</strong>
            <span>G</span>
          </p>
          <b className={upDown(value - cost)}>
            {signed(value - cost)}G ({percent(cost ? ((value - cost) / cost) * 100 : 0)})
          </b>
        </div>
      </div>
      <div className="screen-body stack">
        <section className="card stock-list">
          {list.map((stock) => (
            <StockRow key={stock.id} stock={stock} go={go} />
          ))}
        </section>
      </div>
    </div>
  );
}

/** The chart draws left to right, the area fades in and the end point pops. */
function Chart({ stock }: { stock: Stock }) {
  const change = stock.change ?? 0;
  const close = closes.get(stock.id)!;
  const [values] = useState(() => series(11 + sampleStocks.findIndex((s) => s.id === stock.id), 40, close, stock.price, close * 0.07));
  const all = [...values.slice(0, -1), stock.price];
  const low = Math.min(...all, close * (1 - LIMIT / 100)) * 0.98;
  const high = Math.max(...all, close * (1 + LIMIT / 100));
  const path = line(all, 330, 150, low, high);
  const limitY = 150 - ((close * (1 + LIMIT / 100) - low) / (high - low)) * 150;
  const lastY = 150 - ((stock.price - low) / (high - low)) * 150;
  const color = change >= 0 ? "#F47C66" : "#5FA3D6";
  const svg = useMountMotion<SVGSVGElement>((el) => {
    anim(el.querySelector(".chart-line"), [{ strokeDashoffset: 1 }, { strokeDashoffset: 0 }], { dur: 1100, ease: "inOut" });
    anim(el.querySelector(".chart-area"), [{ opacity: 0 }, { opacity: 1 }], { dur: 500, delay: 500 });
    anim(el.querySelector(".chart-end"), [{ scale: "0" }, { scale: "1.4", offset: 0.6 }, { scale: "1" }], { dur: 420, delay: 1000, ease: "spring" });
  });
  return (
    <section className="card chart-card">
      <svg ref={svg} viewBox="0 0 334 150" aria-label={`오늘 ${stock.name} 가격 흐름`}>
        <defs>
          <linearGradient id="chart-fill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor={color} stopOpacity=".28" />
            <stop offset="1" stopColor={color} stopOpacity="0" />
          </linearGradient>
        </defs>
        <path d={`M0 ${limitY.toFixed(1)}H334`} stroke="#FFD2C8" strokeWidth="1.5" strokeDasharray="4 5" />
        <path className="chart-area" d={`${path} L330 150 L0 150 Z`} fill="url(#chart-fill)" />
        <path className="chart-line" d={path} pathLength={1} strokeDasharray="1" fill="none" stroke={color} strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
        <circle className="chart-end" cx="330" cy={lastY} r="5" fill={color} stroke="#fff" strokeWidth="2.5" />
      </svg>
      <div className="chart-axis">
        <span>{formatTime("09:00")}</span>
        <span>{formatTime("11:00")}</span>
        <span>{formatTime("13:00")}</span>
        <span>{formatTime("15:00")}</span>
        <span>{formatTime("18:00")}</span>
      </div>
    </section>
  );
}

function ConfirmSheet({
  stock,
  side,
  qty,
  onCancel,
  onConfirm,
}: {
  stock: Stock;
  side: "buy" | "sell";
  qty: number;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const sheet = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    if (sheet.current) return openSheet(sheet.current);
  }, []);
  return (
    <dialog className="kuji-modal" ref={sheet} aria-label="거래 확인" onCancel={event => { event.preventDefault(); onCancel(); }} onClick={event => { if (event.target === event.currentTarget) onCancel(); }}>
      <div className="kuji-sheet trade-sheet">
        <span className="detail-icon" style={{ background: art[stock.art].tint }}>
          <img className="character" src={artSrc(stock.art)} alt="" />
        </span>
        <strong>
          {stock.name} {qty}주 {side === "buy" ? "사기" : "팔기"}
        </strong>
        <p>
          {won(stock.price)}G × {qty} = <b>{won(stock.price * qty)}G</b>
        </p>
        <div className="sheet-actions">
          <button className="secondary-button" onClick={onCancel}>
            취소
          </button>
          <button className={`primary-button ${side === "sell" ? "sell" : ""}`} onClick={onConfirm}>
            확인
          </button>
        </div>
      </div>
    </dialog>
  );
}

export function StockDetail({ id, gold: startGold, onBack }: { id: string; gold: number; onBack: () => void }) {
  const list = useMarket();
  const stock = list.find((s) => s.id === id) ?? list[0];
  const [side, setSide] = useState<"buy" | "sell">("buy");
  const [qty, setQty] = useState(1);
  const [qtyDir, setQtyDir] = useState(0);
  const [confirm, setConfirm] = useState(false);
  const [gold, setGold] = useState(startGold);
  const shownGold = useCountUp(gold);
  const price = useCountUp(stock.price, 320);
  const open = marketOpen();
  if (stock.change === null) {
    const down = line(series(5, 26, 260, 0, 120), 206, 146, 0, 320, 26);
    return (
      <div className="stock delisted-page">
        <Toolbar title={stock.name} onBack={onBack} gold={gold} />
        <div className="detail-head">
          <div>
            <Badge stock={stock} big />
            <p className="muted-number">
              <strong>0</strong>
              <span>G</span>
            </p>
            <small>{formatTime("11:42")} 상장폐지 · 직전 {won(stock.average)}G</small>
          </div>
          <span className="detail-icon gray">
            <img className="character" src={artSrc(stock.art)} alt="" />
          </span>
        </div>
        <div className="screen-body stack">
          <section className="card chart-card">
            <svg viewBox="0 0 334 150" aria-label="상장폐지까지의 가격 흐름">
              <path d={down} fill="none" stroke="#C9C0C8" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
              <path d="M206 146H334" stroke="#E2DCE0" strokeWidth="3" strokeDasharray="2 6" strokeLinecap="round" />
              <circle cx="206" cy="146" r="5" fill="#3A3340" stroke="#fff" strokeWidth="2.5" />
            </svg>
          </section>
          <section className="card loss-card">
            <div>
              <span>보유했던 {stock.held}주</span>
              <strong>−{won(stock.held * stock.average)}G</strong>
            </div>
            <span>평균 {won(stock.average)}G</span>
          </section>
        </div>
        <div className="game-actions">
          <button className="primary-button" disabled>
            거래할 수 없어요
          </button>
        </div>
      </div>
    );
  }
  const change = stock.change;
  const close = closes.get(stock.id)!;
  const max = side === "buy" ? Math.max(1, Math.floor(gold / stock.price)) : Math.max(1, stock.held);
  const step = (delta: number) => {
    setQtyDir(delta);
    setQty((q) => Math.min(max, Math.max(1, q + delta)));
  };
  return (
    <div className="stock">
      <Toolbar title={stock.name} onBack={onBack} right={<span className="gold"><Coin />{won(shownGold)}<span className="sr-only"> 골드</span></span>} />
      <div className="detail-head">
        <div>
          <p>
            <strong>{won(price)}</strong>
            <span>G</span>
          </p>
          <span className="detail-change">
            <b className={upDown(change)}>
              {signed(stock.price - close)} ({percent(change)})
            </b>
            <Badge stock={stock} />
          </span>
        </div>
        <span className="detail-icon" style={{ background: art[stock.art].tint }}>
          <img className="character" src={artSrc(stock.art)} alt="" />
        </span>
      </div>
      <div className="screen-body stack">
        <Chart stock={stock} />
        <section className="card holding">
          <div>
            <span>보유</span>
            <strong>{stock.held}주</strong>
          </div>
          <div>
            <span>평균가</span>
            <strong>{stock.held ? won(stock.average) : "—"}</strong>
          </div>
          <div>
            <span>수익</span>
            <strong className={stock.held ? upDown(stock.price - stock.average) : ""}>
              {stock.held ? signed((stock.price - stock.average) * stock.held) : "—"}
            </strong>
          </div>
        </section>
        <section className="card trade">
          <Segmented
            label="거래 종류"
            options={[
              { value: "buy", label: "사기" },
              { value: "sell", label: "팔기" },
            ]}
            colors={{ buy: "#E0644E", sell: "#3B87BF" }}
            value={side}
            onChange={(value) => {
              setSide(value);
              setQty(1);
              setQtyDir(0);
            }}
          />
          <div className="qty">
            <button aria-label="수량 줄이기" onClick={() => step(-1)}>
              −
            </button>
            <div>
              <strong key={qty} className={qtyDir > 0 ? "slide-up" : qtyDir < 0 ? "slide-down" : ""}>
                {qty}주
              </strong>
              <span>{won(qty * stock.price)}G</span>
            </div>
            <button aria-label="수량 늘리기" onClick={() => step(1)}>
              +
            </button>
          </div>
        </section>
      </div>
      <div className="game-actions">
        <button
          className={`primary-button ${side === "sell" ? "sell" : ""}`}
          disabled={!open || (side === "sell" && !stock.held)}
          onClick={() => setConfirm(true)}
        >
          {!open ? "장 마감" : `${qty}주 ${side === "buy" ? "사기" : "팔기"}`}
        </button>
      </div>
      {confirm && (
        <ConfirmSheet
          stock={stock}
          side={side}
          qty={qty}
          onCancel={() => setConfirm(false)}
          onConfirm={() => {
            const amount = stock.price * qty;
            trade(stock.id, side === "buy" ? qty : -qty);
            setGold((g) => g + (side === "buy" ? -amount : amount));
            setConfirm(false);
            setQty(1);
            toast(`${stock.name} ${qty}주를 ${side === "buy" ? "샀어요" : "팔았어요"}`);
          }}
        />
      )}
    </div>
  );
}
