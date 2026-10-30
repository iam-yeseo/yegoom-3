import { useState } from "react";
import { Avatar, Character, Segmented, Toolbar, art, artSrc } from "../components/UI";
import { LIMIT, marketOpen, stocks, type Stock } from "../sample";

const won = (n: number) => n.toLocaleString("ko-KR");
const signed = (n: number) => `${n > 0 ? "+" : n < 0 ? "−" : ""}${won(Math.abs(n))}`;
const percent = (n: number) => `${n > 0 ? "+" : n < 0 ? "−" : ""}${Math.abs(n).toFixed(1)}%`;
const upDown = (n: number) => (n > 0 ? "up" : "down");

function badge(stock: Stock) {
  if (stock.change === null) return { label: "상장폐지", className: "delisted" };
  if (stock.change >= LIMIT) return { label: "상한가", className: "limit-up" };
  if (stock.change <= -LIMIT) return { label: "하한가", className: "limit-down" };
  return null;
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

function StockRows({ list, dim, go }: { list: Stock[]; dim?: boolean; go: (path: string) => void }) {
  return (
    <>
      {list.map((stock) => {
        const tag = badge(stock);
        const delisted = stock.change === null;
        return (
          <button key={stock.id} onClick={() => go(`/stock/${stock.id}`)} className={`stock-row ${delisted ? "delisted" : ""}`}>
            <span className="stock-icon" style={{ background: dim ? "#F3EEE8" : delisted ? "#F1ECE6" : art[stock.art].tint }}>
              <img className={`character ${dim ? "dim" : ""}`} src={artSrc(stock.art)} alt="" />
            </span>
            <span className="stock-name">
              <span>
                <strong>{stock.name}</strong>
                {tag && !dim && <em className={tag.className}>{tag.label}</em>}
              </span>
              {!dim && <small>{delisted ? "거래 중지" : stock.held ? `${stock.held}주 보유` : ""}</small>}
            </span>
            <span className="stock-price">
              <strong>{delisted ? "—" : won(stock.price)}</strong>
              {stock.change !== null && <small className={upDown(stock.change)}>{percent(stock.change)}</small>}
            </span>
          </button>
        );
      })}
    </>
  );
}

export function StockMarket({ gold, onBack, go }: { gold: number; onBack: () => void; go: (path: string) => void }) {
  const holdings = stocks.filter((s) => s.held && s.change !== null);
  const value = holdings.reduce((sum, s) => sum + s.held * s.price, 0);
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
            <p>평일 09:00 개장</p>
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
                <strong>{name}</strong>
                <b className={upDown(amount)}>{signed(amount)}G</b>
              </div>
            ))}
          </section>
          <section className="card stock-list">
            <StockRows list={[stocks[0], stocks[2], stocks[5], stocks[3]]} dim go={go} />
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
              18:00 마감
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
          <StockRows list={stocks} go={go} />
        </section>
      </div>
    </div>
  );
}

export function StockDetail({ id, gold, onBack }: { id: string; gold: number; onBack: () => void }) {
  const stock = stocks.find((s) => s.id === id) ?? stocks[0];
  const [side, setSide] = useState<"buy" | "sell">("buy");
  const [qty, setQty] = useState(1);
  const [message, setMessage] = useState("");
  const open = marketOpen();
  if (stock.change === null) {
    const down = line(series(5, 26, 260, 0, 120), 206, 146, 0, 320, 26);
    return (
      <div className="stock delisted-page">
        <Toolbar title={stock.name} onBack={onBack} gold={gold} />
        <div className="detail-head">
          <div>
            <span className="delisted-tag">상장폐지</span>
            <p className="muted-number">
              <strong>0</strong>
              <span>G</span>
            </p>
            <small>11:42 상장폐지 · 직전 {won(stock.average)}G</small>
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
  const previous = Math.round(stock.price / (1 + change / 100));
  const values = series(11 + stocks.indexOf(stock), 40, previous, stock.price, previous * 0.07);
  const low = Math.min(...values) * 0.97;
  const high = Math.max(...values, previous * (1 + LIMIT / 100));
  const path = line(values, 330, 150, low, high);
  const limitY = 150 - ((previous * (1 + LIMIT / 100) - low) / (high - low)) * 150;
  const lastY = 150 - ((stock.price - low) / (high - low)) * 150;
  const up = change >= 0;
  const color = up ? "#F47C66" : "#5FA3D6";
  const max = side === "buy" ? Math.max(1, Math.floor(gold / stock.price)) : Math.max(1, stock.held);
  const tag = badge(stock);
  return (
    <div className="stock">
      <Toolbar title={stock.name} onBack={onBack} gold={gold} />
      <div className="detail-head">
        <div>
          <p>
            <strong>{won(stock.price)}</strong>
            <span>G</span>
          </p>
          <span className="detail-change">
            <b className={upDown(change)}>
              {signed(stock.price - previous)} ({percent(change)})
            </b>
            {tag && <em className={tag.className}>{tag.label}</em>}
          </span>
        </div>
        <span className="detail-icon" style={{ background: art[stock.art].tint }}>
          <img className="character" src={artSrc(stock.art)} alt="" />
        </span>
      </div>
      <div className="screen-body stack">
        <section className="card chart-card">
          <svg viewBox="0 0 334 150" aria-label={`오늘 ${stock.name} 가격 흐름`}>
            <defs>
              <linearGradient id="chart-fill" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0" stopColor={color} stopOpacity=".28" />
                <stop offset="1" stopColor={color} stopOpacity="0" />
              </linearGradient>
            </defs>
            <path d={`M0 ${limitY.toFixed(1)}H334`} stroke="#FFD2C8" strokeWidth="1.5" strokeDasharray="4 5" />
            <path d={`${path} L330 150 L0 150 Z`} fill="url(#chart-fill)" />
            <path d={path} fill="none" stroke={color} strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
            <circle cx="330" cy={lastY} r="5" fill={color} stroke="#fff" strokeWidth="2.5" />
          </svg>
          <div className="chart-axis">
            <span>09:00</span>
            <span>11:00</span>
            <span>13:00</span>
            <span>15:00</span>
            <span>18:00</span>
          </div>
        </section>
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
              setMessage("");
            }}
          />
          <div className="qty">
            <button aria-label="수량 줄이기" onClick={() => setQty((q) => Math.max(1, q - 1))}>
              −
            </button>
            <div>
              <strong>{qty}주</strong>
              <span>{won(qty * stock.price)}G</span>
            </div>
            <button aria-label="수량 늘리기" onClick={() => setQty((q) => Math.min(max, q + 1))}>
              +
            </button>
          </div>
        </section>
      </div>
      <div className="game-actions">
        <button
          className={`primary-button ${side === "sell" ? "sell" : ""}`}
          disabled={!open || (side === "sell" && !stock.held)}
          onClick={() => setMessage(`${stock.name} ${qty}주를 ${side === "buy" ? "샀어요" : "팔았어요"}.`)}
        >
          {!open ? "장 마감" : `${qty}주 ${side === "buy" ? "사기" : "팔기"}`}
        </button>
        <p className="form-message success" role="status">
          {message}
        </p>
      </div>
    </div>
  );
}
