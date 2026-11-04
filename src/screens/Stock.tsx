import { useCallback, useEffect, useRef, useState } from "react";
import { Character, Coin, Segmented, Toolbar } from "../components/UI";
import { anim, openSheet, pop, toast, useCountUp, useMountMotion, useOnChange } from "../motion";
import { formatDate, formatDateTime, formatTime } from "../format";
import { ApiFailure } from "../api";
import { STOCK_RULES, stockInfo, tradeFee, type StockInfo } from "../../shared/stocks";
import { isLimitDown, isLimitUp } from "../../shared/stock-engine";
import type { Candle, MarketClock, StockDetailView, StockMarketView, StockNewsItem, StockQuote, StockTradeResponse } from "../../shared/stock-types";
import type { StockClient } from "../stock-preview";
import "../stock.css";

const won = (n: number) => n.toLocaleString("ko-KR");
const signed = (n: number) => `${n > 0 ? "+" : n < 0 ? "−" : ""}${won(Math.abs(n))}`;
const percent = (n: number) => `${n > 0 ? "+" : n < 0 ? "−" : ""}${Math.abs(n).toFixed(1)}%`;
const upDown = (n: number) => (n > 0 ? "up" : n < 0 ? "down" : "");
const changeOf = (stock: StockQuote) => ((stock.price - stock.prevClose) / stock.prevClose) * 100;
const info = (ticker: string) => stockInfo(ticker)!;
const LIMIT = STOCK_RULES.dailyLimit;
const kstDay = (iso: string) => new Date(Date.parse(iso) + 9 * 3_600_000).toISOString().slice(0, 10);

type Clocked = { market: MarketClock; serverTime: string } | null;
/** Read once now and again just after every 10-minute tick (only while the page
 * is visible); no fixed-interval polling. */
function useTickPolling(load: () => Promise<Clocked>) {
  useEffect(() => {
    let alive = true;
    let timer = 0;
    const run = async () => {
      clearTimeout(timer);
      if (!alive || document.visibilityState !== "visible") return;
      const result = await load();
      if (!alive || !result?.market.nextTickAt) return;
      const serverNow = Date.parse(result.serverTime);
      const wait = Date.parse(result.market.nextTickAt) - serverNow + 5_000;
      timer = window.setTimeout(run, Math.min(Math.max(wait, 5_000), 6 * 3_600_000));
    };
    const visible = () => { if (document.visibilityState === "visible") void run(); };
    void run();
    document.addEventListener("visibilitychange", visible);
    return () => { alive = false; clearTimeout(timer); document.removeEventListener("visibilitychange", visible); };
  }, [load]);
}

function badge(stock: StockQuote) {
  if (stock.status === "delisted") return { label: "상장폐지", className: "delisted" };
  if (stock.halted) return { label: "거래 정지", className: "halted" };
  if (stock.dayOpen !== null && isLimitUp(stock.price, stock.prevClose)) return { label: "상한가", className: "limit-up" };
  if (stock.dayOpen !== null && isLimitDown(stock.price, stock.prevClose)) return { label: "하한가", className: "limit-down" };
  if (stock.status === "warning") return { label: "관리종목", className: "warning" };
  return null;
}
/** A badge that pulses once with a spreading ring when it appears. */
function Badge({ stock, big }: { stock: StockQuote; big?: boolean }) {
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
  return <em ref={ref} className={`${tag.className} ${big ? "big" : ""}`}>{tag.label}</em>;
}
/** Colored circle with the ticker's first two letters (no images). */
export function StockBadge({ stock, size = "row", gray }: { stock: StockInfo; size?: "row" | "detail" | "small"; gray?: boolean }) {
  return (
    <span className={`stock-badge ${size} ${gray ? "gray" : ""}`} style={gray ? undefined : { background: stock.tint, color: stock.ink }} aria-hidden="true">
      {stock.badge}
    </span>
  );
}

function StockRow({ stock, go }: { stock: StockQuote; go: (path: string) => void }) {
  const company = info(stock.ticker);
  const delisted = stock.status === "delisted";
  const row = useRef<HTMLButtonElement>(null);
  const price = useCountUp(stock.price, 320);
  const change = changeOf(stock);
  useOnChange(stock.price, (before) => {
    const color = stock.price > before ? "rgba(255,142,122,.16)" : "rgba(140,200,242,.2)";
    anim(row.current, [{ backgroundColor: color }, { backgroundColor: "rgba(255,255,255,0)" }], { dur: 800, ease: "out", fill: "none" });
  });
  return (
    <button ref={row} onClick={() => go(`/stock/${stock.ticker}`)} className={`stock-row ${delisted ? "delisted" : ""}`}>
      <StockBadge stock={company} gray={delisted} />
      <span className="stock-name">
        <span>
          <strong>{company.name}</strong>
          <Badge stock={stock} />
        </span>
        <small>{delisted ? stock.relistOn ? `${formatDate(stock.relistOn)} 재상장` : "거래 중지" : stock.held ? `${won(stock.held)}주 보유` : company.sector}</small>
      </span>
      <span className="stock-price">
        <strong>{delisted ? "—" : won(price)}</strong>
        {!delisted && <small className={upDown(change)}>{percent(change)}</small>}
      </span>
    </button>
  );
}

function NewsCard({ item, go }: { item: StockNewsItem; go?: (path: string) => void }) {
  const company = item.ticker ? info(item.ticker) : null;
  return (
    <article className={`stock-news-item ${item.kind}`}>
      <header>
        {company && (go
          ? <button className="news-stock" onClick={() => go(`/stock/${company.ticker}`)}><StockBadge stock={company} size="small" />{company.name}</button>
          : <span className="news-stock"><StockBadge stock={company} size="small" />{company.name}</span>)}
        <time dateTime={item.publishAt}>{kstDay(item.publishAt) === kstDay(new Date().toISOString()) ? formatTime(item.publishAt) : formatDateTime(item.publishAt).slice(6)}</time>
        {item.effectBp !== null && item.effectBp !== 0 && <b className={upDown(item.effectBp)}>{percent(item.effectBp / 100)}</b>}
      </header>
      <h3>{item.kind === "rumor" && <span className="rumor-label">[찌라시] </span>}{item.headline}</h3>
      <p>{item.body}</p>
    </article>
  );
}

function holdingsTotal(stocks: StockQuote[]) {
  const held = stocks.filter((stock) => stock.held);
  const value = held.reduce((sum, stock) => sum + (stock.status === "delisted" ? 0 : stock.held * stock.price), 0);
  const cost = held.reduce((sum, stock) => sum + stock.costBasis, 0);
  return { value, cost, count: held.length };
}
function closedLabel(market: MarketClock, serverTime: string) {
  if (market.holiday) return `휴장 · ${market.holiday}`;
  const day = new Date(`${market.date}T00:00:00Z`).getUTCDay();
  if (day === 0 || day === 6) return "주말 휴장";
  return Date.parse(serverTime) < Date.parse(market.opensAt) ? "개장 전" : "장 마감";
}

/** Toasts for articles published while the screen is open. */
function useNewsToasts() {
  const seen = useRef<Set<string> | null>(null);
  return useCallback((news: StockNewsItem[]) => {
    if (seen.current) {
      const fresh = news.filter((item) => !seen.current!.has(item.id));
      if (fresh[0]) toast(`속보 · ${fresh[0].headline}`, { wrap: true });
    }
    seen.current = new Set([...(seen.current ?? []), ...news.map((item) => item.id)]);
  }, []);
}

export function StockMarket({ client, gold, onBack, go }: { client: StockClient; gold: number; onBack: () => void; go: (path: string) => void }) {
  const [view, setView] = useState<StockMarketView | null>(null);
  const [error, setError] = useState("");
  const versionRef = useRef<string | undefined>(undefined);
  const announce = useNewsToasts();
  const load = useCallback(async (): Promise<Clocked> => {
    try {
      const next = await client.market(versionRef.current);
      setError("");
      if ("unchanged" in next) {
        setView((current) => current && { ...current, market: next.market, serverTime: next.serverTime });
        return next;
      }
      versionRef.current = next.version;
      announce(next.news);
      setView(next);
      return next;
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "주식 시장을 불러오지 못했어요.");
      return null;
    }
  }, [client, announce]);
  useTickPolling(load);
  const totals = holdingsTotal(view?.stocks ?? []);
  const value = useCountUp(totals.value);
  if (!view) {
    return (
      <div className="stock">
        <div className="stock-hero"><Toolbar title="주식 시장" onBack={onBack} gold={gold} /></div>
        <div className="screen-body stack">
          <p className="stock-loading" role={error ? "alert" : "status"}>{error || "시장을 불러오는 중…"}</p>
          {error && <button className="secondary-button" onClick={() => void load()}>다시 시도</button>}
        </div>
      </div>
    );
  }
  const { market } = view;
  const pnl = totals.value - totals.cost;
  const newsCard = (
    <section className="card stock-news">
      <div className="card-head">
        <h2>최근 뉴스</h2>
        <button className="text-button" onClick={() => go("/stock/news")}>뉴스 전체 보기</button>
      </div>
      {view.news.length ? view.news.map((item) => <NewsCard key={item.id} item={item} go={go} />) : <p className="empty">아직 뉴스가 없어요.</p>}
    </section>
  );
  const list = (
    <section className="card stock-list" aria-label="종목">
      {view.stocks.map((stock) => <StockRow key={stock.ticker} stock={stock} go={go} />)}
    </section>
  );
  if (!market.open) {
    return (
      <div className="stock closed">
        <div className="stock-hero closed">
          <Toolbar title="주식 시장" onBack={onBack} gold={view.gold} />
          <div className="closed-moon"><Character artKey="moon" className="bob-slow" /></div>
          <div className="closed-copy">
            <h2>{closedLabel(market, view.serverTime)}</h2>
            <p>{market.nextTickAt ? `${formatDateTime(market.nextTickAt)} 개장` : `평일 ${formatTime("09:00")} 개장`}</p>
          </div>
        </div>
        <div className="screen-body stack">
          <section className="card stock-summary">
            <div><span>내 주식</span><strong>{won(totals.value)}G</strong></div>
            <div><span>평가손익</span><strong className={upDown(pnl)}>{totals.count ? `${signed(pnl)}G` : "—"}</strong></div>
          </section>
          {list}
          {newsCard}
        </div>
      </div>
    );
  }
  return (
    <div className="stock">
      <div className="stock-hero">
        <Toolbar title="주식 시장" onBack={onBack} gold={view.gold} />
        <div className="hero-number">
          <div className="hero-number-top">
            <span>내 주식</span>
            <span className="market-pill"><i />장 열림 · {formatTime(market.closesAt)} 마감</span>
          </div>
          <p><strong>{won(value)}</strong><span>G</span></p>
          <b className={upDown(pnl)}>{signed(pnl)}G ({percent(totals.cost ? (pnl / totals.cost) * 100 : 0)})</b>
        </div>
      </div>
      <div className="screen-body stack">
        {error && <p className="form-message error" role="alert">{error}</p>}
        {list}
        {newsCard}
      </div>
    </div>
  );
}

type Range = "day" | "week" | "month";
function line(values: number[], width: number, height: number, low: number, high: number, slots = values.length) {
  return values.map((v, i) => `${i ? "L" : "M"}${(slots > 1 ? (i / (slots - 1)) * width : width).toFixed(1)} ${(height - ((v - low) / (high - low || 1)) * height).toFixed(1)}`).join(" ");
}
/** 1일: the latest trading day's 10-minute prices on the 09:00–18:00 axis with
 * the ±15% limit lines; 1주/1개월: daily closes, plus today's price if trading. */
function Chart({ detail, range }: { detail: StockDetailView; range: Range }) {
  const { stock } = detail;
  const company = info(stock.ticker);
  const day = range === "day";
  const candles: Candle[] = detail.daily.slice(range === "week" ? -5 : -22);
  const today = detail.market.date;
  const values = day ? detail.ticks.map((tick) => tick.price)
    : [...candles.filter((candle) => candle.date !== today).map((candle) => candle.close), ...(stock.dayOpen !== null ? [stock.price] : [])];
  const base = day ? stock.prevClose : values[0] ?? stock.price;
  const limits = day ? [Math.floor(stock.prevClose * (1 + LIMIT)), Math.ceil(stock.prevClose * (1 - LIMIT))] : [];
  const all = values.length ? values : [stock.price];
  const low = Math.min(...all, ...limits) * 0.99;
  const high = Math.max(...all, ...limits) * 1.01;
  const slots = day ? 55 : Math.max(all.length, 2);
  const path = line(all, 330, 150, low, high, slots);
  const y = (v: number) => 150 - ((v - low) / (high - low || 1)) * 150;
  const lastX = slots > 1 ? ((all.length - 1) / (slots - 1)) * 330 : 330;
  const color = all[all.length - 1]! >= base ? "#F47C66" : "#5FA3D6";
  const svg = useMountMotion<SVGSVGElement>((el) => {
    anim(el.querySelector(".chart-line"), [{ strokeDashoffset: 1 }, { strokeDashoffset: 0 }], { dur: 900, ease: "inOut" });
    anim(el.querySelector(".chart-area"), [{ opacity: 0 }, { opacity: 1 }], { dur: 500, delay: 400 });
  });
  const label = { day: "하루", week: "최근 1주", month: "최근 1개월" }[range];
  return (
    <svg ref={svg} viewBox="0 0 334 150" role="img" aria-label={`${label} ${company.name} 가격 흐름`}>
      <defs>
        <linearGradient id="chart-fill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor={color} stopOpacity=".28" />
          <stop offset="1" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      {limits.map((value, i) => <path key={i} d={`M0 ${y(value).toFixed(1)}H334`} stroke={i ? "#C6E2F6" : "#FFD2C8"} strokeWidth="1.5" strokeDasharray="4 5" />)}
      {day && <path d={`M0 ${y(stock.prevClose).toFixed(1)}H334`} stroke="#E6DFE8" strokeWidth="1" />}
      {all.length > 1 && <path className="chart-area" d={`${path} L${lastX.toFixed(1)} 150 L0 150 Z`} fill="url(#chart-fill)" />}
      <path className="chart-line" d={path} pathLength={1} strokeDasharray="1" fill="none" stroke={color} strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
      <circle className="chart-end" cx={lastX} cy={y(all[all.length - 1]!)} r="5" fill={color} stroke="#fff" strokeWidth="2.5" />
    </svg>
  );
}
function ChartCard({ detail }: { detail: StockDetailView }) {
  const [range, setRange] = useState<Range>("day");
  const candles = detail.daily.slice(range === "week" ? -5 : -22);
  const md = (date: string) => `${Number(date.slice(5, 7))}월 ${Number(date.slice(8, 10))}일`;
  const axis = range === "day" ? ["09:00", "11:00", "13:00", "15:00", "18:00"].map(formatTime)
    : candles.length ? [md(candles[0]!.date), md(candles[candles.length - 1]!.date)] : [];
  return (
    <section className="card chart-card">
      <Segmented label="차트 기간" options={[{ value: "day", label: "1일" }, { value: "week", label: "1주" }, { value: "month", label: "1개월" }]} value={range} onChange={setRange} />
      <Chart key={range} detail={detail} range={range} />
      <div className="chart-axis">{axis.map((label, i) => <span key={i}>{label}</span>)}</div>
    </section>
  );
}

function ConfirmSheet({ stock, side, qty, onCancel, onConfirm, busy }: {
  stock: StockQuote; side: "buy" | "sell"; qty: number; onCancel: () => void; onConfirm: () => void; busy: boolean;
}) {
  const sheet = useRef<HTMLDialogElement>(null);
  useEffect(() => { if (sheet.current) return openSheet(sheet.current); }, []);
  const company = info(stock.ticker);
  const amount = stock.price * qty;
  const fee = tradeFee(amount);
  return (
    <dialog className="kuji-modal" ref={sheet} aria-label="거래 확인" onCancel={(event) => { event.preventDefault(); onCancel(); }} onClick={(event) => { if (event.target === event.currentTarget) onCancel(); }}>
      <div className="kuji-sheet trade-sheet">
        <StockBadge stock={company} size="detail" />
        <strong>{company.name} {won(qty)}주 {side === "buy" ? "사기" : "팔기"}</strong>
        <dl className="trade-receipt">
          <div><dt>{won(stock.price)}G × {won(qty)}주</dt><dd>{won(amount)}G</dd></div>
          <div><dt>수수료 1%</dt><dd>{side === "buy" ? "+" : "−"}{won(fee)}G</dd></div>
          <div className="total"><dt>{side === "buy" ? "내는 골드" : "받는 골드"}</dt><dd>{won(side === "buy" ? amount + fee : Math.max(0, amount - fee))}G</dd></div>
        </dl>
        <p className="trade-note">주문하는 순간의 서버 가격으로 체결돼요.</p>
        <div className="sheet-actions">
          <button className="secondary-button" onClick={onCancel} disabled={busy}>취소</button>
          <button className={`primary-button ${side === "sell" ? "sell" : ""}`} onClick={onConfirm} disabled={busy}>{busy ? "주문 중…" : "확인"}</button>
        </div>
      </div>
    </dialog>
  );
}

export function StockDetail({ client, ticker, onBack, onTraded }: {
  client: StockClient; ticker: string; onBack: () => void; onTraded: (result: StockTradeResponse) => void;
}) {
  const [detail, setDetail] = useState<StockDetailView | null>(null);
  const [error, setError] = useState("");
  const [side, setSide] = useState<"buy" | "sell">("buy");
  const [qty, setQty] = useState(1);
  const [qtyDir, setQtyDir] = useState(0);
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const announce = useNewsToasts();
  const load = useCallback(async (): Promise<Clocked> => {
    try {
      const next = await client.detail(ticker);
      setDetail(next);
      announce(next.news);
      setError("");
      return next;
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "종목을 불러오지 못했어요.");
      return null;
    }
  }, [client, ticker, announce]);
  useTickPolling(load);
  const price = useCountUp(detail?.stock.price ?? 0, 320);
  const shownGold = useCountUp(detail?.gold ?? 0);
  const company = stockInfo(ticker);
  if (!company) return <div className="stock"><Toolbar title="주식 시장" onBack={onBack} /><p className="stock-loading" role="alert">없는 종목이에요.</p></div>;
  if (!detail) {
    return (
      <div className="stock">
        <Toolbar title={company.name} onBack={onBack} />
        <div className="screen-body stack">
          <p className="stock-loading" role={error ? "alert" : "status"}>{error || "불러오는 중…"}</p>
          {error && <button className="secondary-button" onClick={() => void load()}>다시 시도</button>}
        </div>
      </div>
    );
  }
  const { stock, market } = detail;
  const newsList = (
    <section className="card stock-news">
      <div className="card-head"><h2>{company.name} 뉴스</h2></div>
      {detail.news.length ? detail.news.map((item) => <NewsCard key={item.id} item={item} />) : <p className="empty">아직 뉴스가 없어요.</p>}
    </section>
  );
  if (stock.status === "delisted") {
    const lost = detail.trades.find((trade) => trade.side === "delist");
    return (
      <div className="stock delisted-page">
        <Toolbar title={company.name} onBack={onBack} gold={detail.gold} />
        <div className="detail-head">
          <div>
            <Badge stock={stock} big />
            <p className="muted-number"><strong>0</strong><span>G</span></p>
            <small>{stock.delistedOn ? `${formatDate(stock.delistedOn)} 상장폐지` : "상장폐지"} · 마지막 {won(stock.price)}G</small>
          </div>
          <StockBadge stock={company} size="detail" gray />
        </div>
        <div className="screen-body stack">
          {lost && (
            <section className="card loss-card">
              <div><span>보유했던 {won(lost.quantity)}주</span><strong>−{won(lost.costBasis)}G</strong></div>
              <span>평균 {won(Math.round(lost.costBasis / lost.quantity))}G</span>
            </section>
          )}
          <section className="card stock-intro">
            <p>{stock.relistOn ? `${formatDate(stock.relistOn)} ${formatTime("09:00")}에 상장가 ${won(company.listingPrice)}G로 다시 상장해요.` : company.intro}</p>
          </section>
          {newsList}
        </div>
        <div className="game-actions"><button className="primary-button" disabled>거래할 수 없어요</button></div>
      </div>
    );
  }
  const change = changeOf(stock);
  const perShare = stock.price * (1 + STOCK_RULES.fee);
  const maxBuy = Math.max(1, Math.min(STOCK_RULES.maxOrder, STOCK_RULES.maxHolding - stock.held, Math.floor(detail.gold / perShare)));
  const max = side === "buy" ? maxBuy : Math.max(1, Math.min(STOCK_RULES.maxOrder, stock.held));
  const quantity = Math.min(qty, max);
  const amount = quantity * stock.price;
  const fee = tradeFee(amount);
  const set = (next: number, dir = 0) => { setQtyDir(dir); setQty(Math.min(max, Math.max(1, next))); };
  const blocked = !detail.canTrade ? "운영자는 거래할 수 없어요"
    : detail.tradeBlock ?? (!market.open ? closedLabel(market, detail.serverTime) : stock.halted ? "거래 정지 · 겨울 근무 중" : null);
  const cannotSell = side === "sell" && !stock.held;
  const full = side === "buy" && stock.held >= STOCK_RULES.maxHolding;
  const poor = side === "buy" && detail.gold < amount + fee;
  const submit = async () => {
    setBusy(true);
    try {
      const result = await client.trade({ requestId: crypto.randomUUID(), ticker: stock.ticker, side, quantity, expectedVersion: stock.version });
      setDetail((current) => current && { ...current, stock: result.stock, gold: result.gold, trades: [result.trade, ...current.trades.filter((trade) => trade.id !== result.trade.id)].slice(0, 10) });
      onTraded(result);
      toast(`${company.name} ${won(result.trade.quantity)}주를 ${won(result.trade.price)}G에 ${side === "buy" ? "샀어요" : "팔았어요"}`);
      setConfirm(false);
      setQty(1);
    } catch (failure) {
      setConfirm(false);
      toast(failure instanceof Error ? failure.message : "주문하지 못했어요.", { wrap: true });
      if (failure instanceof ApiFailure && failure.status === 409) void load();
    } finally {
      setBusy(false);
    }
  };
  const avg = stock.held ? Math.round(stock.costBasis / stock.held) : 0;
  const pnl = stock.held * stock.price - stock.costBasis;
  return (
    <div className="stock">
      <Toolbar title={company.name} onBack={onBack} right={<span className="gold"><Coin />{won(shownGold)}<span className="sr-only"> 골드</span></span>} />
      <div className="detail-head">
        <div>
          <p><strong>{won(price)}</strong><span>G</span></p>
          <span className="detail-change">
            <b className={upDown(change)}>{signed(stock.price - stock.prevClose)} ({percent(change)})</b>
            <Badge stock={stock} />
          </span>
        </div>
        <StockBadge stock={company} size="detail" />
      </div>
      <div className="screen-body stack">
        {stock.status === "warning" && <p className="stock-warning" role="note">관리종목이에요. 다음 종가도 {won(Math.ceil(company.listingPrice * STOCK_RULES.delistRatio))}G 아래면 상장폐지돼요.</p>}
        <ChartCard detail={detail} />
        <section className="card holding">
          <div><span>보유</span><strong>{won(stock.held)}주</strong></div>
          <div><span>평균가</span><strong>{stock.held ? won(avg) : "—"}</strong></div>
          <div><span>평가손익</span><strong className={stock.held ? upDown(pnl) : ""}>{stock.held ? signed(pnl) : "—"}</strong></div>
        </section>
        <section className="card trade">
          <Segmented label="거래 종류" options={[{ value: "buy", label: "사기" }, { value: "sell", label: "팔기" }]}
            colors={{ buy: "#E0644E", sell: "#3B87BF" }} value={side}
            onChange={(value) => { setSide(value); setQty(1); setQtyDir(0); }} />
          <div className="qty">
            <button aria-label="수량 줄이기" onClick={() => set(quantity - 1, -1)}>−</button>
            <div>
              <strong key={quantity} className={qtyDir > 0 ? "slide-up" : qtyDir < 0 ? "slide-down" : ""}>{won(quantity)}주</strong>
              <span>{won(amount)}G · 수수료 {won(fee)}G</span>
            </div>
            <button aria-label="수량 늘리기" onClick={() => set(quantity + 1, 1)}>+</button>
          </div>
          <div className="qty-quick" role="group" aria-label="빠른 수량">
            <button onClick={() => set(1, -1)}>1주</button>
            <button onClick={() => set(10, 1)}>10주</button>
            <button onClick={() => set(max, 1)}>최대</button>
          </div>
          <p className="trade-total">{side === "buy" ? "내는 골드" : "받는 골드"} <b>{won(side === "buy" ? amount + fee : Math.max(0, amount - fee))}G</b></p>
        </section>
        <section className="card stock-intro">
          <div className="card-head"><h2>{company.sector}</h2><span>상장가 {won(company.listingPrice)}G</span></div>
          <p>{company.intro}</p>
        </section>
        {newsList}
      </div>
      <div className="game-actions">
        <button className={`primary-button ${side === "sell" ? "sell" : ""}`} disabled={!!blocked || cannotSell || full || poor} onClick={() => setConfirm(true)}>
          {blocked ?? (cannotSell ? "보유한 주식이 없어요" : full ? `${STOCK_RULES.maxHolding}주까지 가질 수 있어요` : poor ? "골드가 부족해요" : `${won(quantity)}주 ${side === "buy" ? "사기" : "팔기"}`)}
        </button>
      </div>
      {confirm && <ConfirmSheet stock={stock} side={side} qty={quantity} busy={busy} onCancel={() => setConfirm(false)} onConfirm={() => void submit()} />}
    </div>
  );
}

export function StockNews({ client, onBack, go }: { client: StockClient; onBack: () => void; go: (path: string) => void }) {
  const [news, setNews] = useState<StockNewsItem[] | null>(null);
  const [next, setNext] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const more = useCallback(async (before?: string) => {
    setBusy(true);
    try {
      const page = await client.news(before);
      setNews((current) => before ? [...(current ?? []), ...page.news] : page.news);
      setNext(page.nextBefore);
      setError("");
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "뉴스를 불러오지 못했어요.");
    } finally {
      setBusy(false);
    }
  }, [client]);
  useEffect(() => { void more(); }, [more]);
  const days = new Map<string, StockNewsItem[]>();
  for (const item of news ?? []) {
    const date = new Date(Date.parse(item.publishAt) + 9 * 3_600_000).toISOString().slice(0, 10);
    days.set(date, [...(days.get(date) ?? []), item]);
  }
  return (
    <div className="stock">
      <Toolbar title="주식 뉴스" onBack={onBack} />
      <div className="screen-body stack">
        {error && <p className="form-message error" role="alert">{error}</p>}
        {news === null && !error && <p className="stock-loading" role="status">불러오는 중…</p>}
        {news?.length === 0 && <p className="empty">아직 뉴스가 없어요.</p>}
        {[...days].map(([date, items]) => (
          <section key={date} className="card stock-news">
            <div className="card-head"><h2>{formatDate(date)}</h2></div>
            {items.map((item) => <NewsCard key={item.id} item={item} go={go} />)}
          </section>
        ))}
        {next && <button className="secondary-button" disabled={busy} onClick={() => void more(next)}>{busy ? "불러오는 중…" : "더 보기"}</button>}
      </div>
    </div>
  );
}
