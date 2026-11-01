import { useEffect, useRef, useState, type PointerEvent } from "react";
import { LOTTO_RULES, SPEETTO_RULES } from "../../shared/balance";
import type { LottoPurchaseInput, LottoTicket, ShopKind, ShopPayment, SpeettoPurchaseInput, SpeettoTicket } from "../../shared/types";
import { SectionTitle, Toolbar, art, artSrc } from "../components/UI";
import { anim, confetti, crumbs, popIn, reduced, shake, toast, tween, useCountUp } from "../motion";
import { useShop } from "../shop";
import { ShopCards } from "./Home";

function InventoryCard({ kind }: { kind?: "lotto" | "speetto" }) {
  const { inventory } = useShop();
  return <section className="card inventory-card" aria-label="보유 이용권">
    <h2>보유 이용권</h2>
    {kind !== "speetto" && <p><span>데일리 로또 이용권</span><strong>{inventory.lottoTickets}장</strong></p>}
    {kind !== "lotto" && <p><span>스피또 이용권</span><strong>{inventory.speettoTickets}장</strong></p>}
  </section>;
}
function ShopNotice({ kind, error }: { kind?: ShopKind; error?: string }) {
  const shop = useShop();
  const message = error || shop.error;
  return <>
    {!shop.canPurchase && !shop.loading && <p className="subtle-note">운영자 계정은 구매에 참여하지 않아요.</p>}
    {shop.loading && <p className="subtle-note" role="status">상점 정보를 불러오는 중…</p>}
    {message && <div className="shop-error"><p className="form-message error" role="alert">{message}</p><button className="text-button" onClick={() => void shop.refresh(kind).catch(() => {})}>다시 불러오기</button></div>}
    {shop.pending && <p className="subtle-note" role="status">아직 확인하지 못한 구매가 있어요. {shop.pending.kind === kind ? "같은 결제 버튼을 눌러 구매를 다시 확인해 주세요." : "해당 게임에서 구매를 다시 확인해 주세요."}</p>}
  </>;
}
/** Fetch once on entry; the provider keeps purchase state across navigation. */
function useLoadShop(kind?: ShopKind) {
  const shop = useShop();
  const latest = useRef(shop);
  latest.current = shop;
  useEffect(() => { void latest.current.refresh(kind).catch(() => {}); }, [kind]);
  return shop;
}
export function ShopMain({ go }: { go: (path: string) => void }) {
  useLoadShop();
  return <div className="shop-main">
    <header className="tab-header"><h1>상점</h1></header>
    <div className="screen-body stack">
      <InventoryCard />
      <SectionTitle title="복권" />
      <ShopCards go={go} />
      <ShopNotice />
    </div>
  </div>;
}

const winColors = ["#FFD866", "#FF8E7A", "#B9A3F0", "#8CC8F2", "#8FD9C0"];
function clock(seconds: number) {
  const safe = Math.max(0, seconds);
  return [Math.floor(safe / 3600), Math.floor((safe % 3600) / 60), safe % 60]
    .map(value => String(value).padStart(2, "0")).join(":");
}
function useServerNow(serverTime: string) {
  const [now, setNow] = useState(() => Date.parse(serverTime));
  useEffect(() => {
    const offset = Date.parse(serverTime) - Date.now();
    setNow(Date.now() + offset);
    const timer = window.setInterval(() => setNow(Date.now() + offset), 1000);
    return () => window.clearInterval(timer);
  }, [serverTime]);
  return now;
}
/** The winning balls retain the original roll-in animation. */
function DrawNumbers({ date, numbers }: { date: string; numbers: number[] }) {
  const [rolled, setRolled] = useState(reduced() ? numbers.length : 0);
  const draw = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (rolled >= numbers.length) return;
    const timer = window.setTimeout(() => setRolled(n => n + 1), rolled ? 520 : 300);
    return () => window.clearTimeout(timer);
  }, [rolled, numbers.length]);
  useEffect(() => {
    if (rolled && !reduced()) anim(draw.current?.children[rolled - 1], [
      { translate: "-220px 0", rotate: "-200deg", opacity: 0 },
      { translate: "0 0", rotate: "0deg", opacity: 1 },
    ], { dur: 560, ease: "out" });
  }, [rolled]);
  return <section className="card lotto-draw"><div className="draw">
    <span>{date} 당첨 번호</span>
    <div ref={draw}>{numbers.map((number, i) => <i key={number} style={{ background: winColors[i], color: i ? "#fff" : "#5C4300", visibility: i < rolled ? "visible" : "hidden" }}>{number}</i>)}</div>
  </div></section>;
}
function TicketCard({ ticket }: { ticket: LottoTicket }) {
  const settled = ticket.matches !== null;
  return <article className="card ticket" data-ticket-id={ticket.id}>
    <div className="card-head">
      <span className={`ticket-tag ${ticket.rank ? "won" : ""}`}>{settled ? `${ticket.rank ? `${ticket.rank}등 · ` : ""}${ticket.matches}개 일치` : "추첨 대기"}</span>
      <b className={ticket.prize ? "gain" : "none"}>{settled ? ticket.prize ? `+${ticket.prize.toLocaleString("ko-KR")}G` : "낙첨" : ""}</b>
    </div>
    <p className="ticket-date">{ticket.drawDate} · {LOTTO_RULES.drawTime.slice(0, 5)} 추첨</p>
    <div className="ticket-balls">{ticket.numbers.map(number => {
      const index = ticket.winningNumbers?.indexOf(number) ?? -1;
      return <i key={number} data-n={number} style={index >= 0 ? { background: winColors[index], color: index ? "#fff" : "#5C4300" } : undefined}>{number}</i>;
    })}</div>
  </article>;
}

export function Lotto({ onBack }: { gold?: number; onBack: () => void }) {
  const shop = useLoadShop("lotto");
  const [picks, setPicks] = useState<number[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const pendingClick = useRef(false);
  const balls = useRef<HTMLDivElement>(null);
  const now = useServerNow(shop.serverTime);
  const round = shop.lotto;
  const pending = shop.pending?.kind === "lotto" ? shop.pending.input as LottoPurchaseInput : null;
  const selected = pending?.numbers ?? picks;
  const target = round ? Date.parse(`${round.targetDrawDate}T${LOTTO_RULES.drawTime}+09:00`) : null;
  const left = target === null ? null : Math.max(0, Math.ceil((target - now) / 1000));
  const expired = left === 0;
  const requestedDraw = useRef("");
  const latest = useRef(shop);
  latest.current = shop;
  useEffect(() => {
    if (!round || !expired || requestedDraw.current === round.targetDrawDate) return;
    requestedDraw.current = round.targetDrawDate;
    void latest.current.refresh("lotto").catch(() => {});
  }, [round?.targetDrawDate, expired]);
  const frozen = busy || Boolean(shop.pending) || !shop.canPurchase;
  const full = selected.length === LOTTO_RULES.pickCount;
  function pickBall(button: HTMLElement, number: number, on: boolean) {
    if (frozen) return;
    if (!on && picks.length >= LOTTO_RULES.pickCount) { shake(button); return; }
    if (!on) anim(button, [{ scale: ".6" }, { scale: "1.18", offset: .6 }, { scale: "1" }], { dur: 340, fill: "none" });
    setPicks(previous => on ? previous.filter(value => value !== number) : [...previous, number]);
    setError("");
  }
  function autoPick() {
    if (frozen) return;
    const next = [...picks];
    const added: number[] = [];
    while (next.length < LOTTO_RULES.pickCount) {
      const number = 1 + Math.floor(Math.random() * LOTTO_RULES.maxNumber);
      if (!next.includes(number)) { next.push(number); added.push(number); }
    }
    setPicks(next);
    added.forEach((number, i) => anim(balls.current?.children[number - 1], [{ scale: ".6" }, { scale: "1.18", offset: .6 }, { scale: "1" }], { dur: 340, delay: reduced() ? 0 : i * 140, fill: "none" }));
    setError("");
  }
  async function purchase(payment: ShopPayment) {
    if (pendingClick.current || !shop.canPurchase || !full || shop.pending && !pending) return;
    pendingClick.current = true;
    setBusy(true);
    setError("");
    try {
      await shop.buyLotto(pending ?? { requestId: crypto.randomUUID(), numbers: [...picks].sort((a, b) => a - b), payment });
      setPicks([]);
      toast("데일리 로또를 샀어요");
    } catch (e) { setError(e instanceof Error ? e.message : "구매를 확인하지 못했어요. 같은 결제 버튼으로 다시 시도해 주세요."); }
    finally { pendingClick.current = false; setBusy(false); }
  }
  const available = Boolean(round) && shop.canPurchase && !busy && !shop.loading && full && (!expired || Boolean(pending)) && (!shop.pending || Boolean(pending));
  return <div className="lotto">
    <div className="lotto-hero">
      <Toolbar title="데일리 로또" onBack={onBack} gold={shop.gold} />
      <div className="hero-number-row">
        <div className="hero-number"><span>다음 추첨까지</span><strong className="countdown-number">{left === null ? "—" : clock(left)}</strong></div>
        <div className="lotto-meta"><span>{LOTTO_RULES.drawTime.slice(0, 5)} 추첨</span><small>장당 {LOTTO_RULES.price}G</small></div>
      </div>
      {round && <p className="lotto-target">지금 사는 표 · {round.targetDrawDate} 추첨</p>}
    </div>
    <div className="screen-body stack">
      <InventoryCard kind="lotto" />
      <section className="card lotto-picker">
        <div className="card-head"><h2>{selected.length} / {LOTTO_RULES.pickCount}</h2><button className="auto-button" disabled={frozen || full} onClick={autoPick}>자동</button></div>
        <div className="balls" ref={balls}>{Array.from({ length: LOTTO_RULES.maxNumber }, (_, i) => {
          const number = i + 1;
          const on = selected.includes(number);
          return <button key={number} aria-label={`번호 ${number}`} aria-pressed={on} disabled={frozen} data-nopress onClick={event => pickBall(event.currentTarget, number, on)}>{number}</button>;
        })}</div>
      </section>
      <div className="shop-purchase-actions">
        {!full && <p className="subtle-note">{LOTTO_RULES.pickCount - selected.length}개 더 골라주세요</p>}
        {full && shop.canPurchase && !pending && shop.gold < LOTTO_RULES.price && <p className="subtle-note">골드가 부족해요. 이용권이 있으면 사용할 수 있어요.</p>}
        <button className="primary-button" disabled={!available || pending?.payment === "ticket" || !pending && shop.gold < LOTTO_RULES.price} onClick={() => void purchase("gold")}>{busy ? "구매 확인 중…" : `골드로 1장 사기 · ${LOTTO_RULES.price}G`}</button>
        <button className="secondary-button" disabled={!available || pending?.payment === "gold" || !pending && shop.inventory.lottoTickets < 1} onClick={() => void purchase("ticket")}>이용권으로 1장 사기</button>
      </div>
      <ShopNotice kind="lotto" error={error} />
      {round?.todayDraw.numbers && <DrawNumbers key={round.todayDraw.date} date={round.todayDraw.date} numbers={round.todayDraw.numbers} />}
      <section className="lotto-tickets" aria-label="내 데일리 로또">
        <h2>내 데일리 로또 {round?.tickets.length ?? 0}장</h2>
        {round?.tickets.length ? round.tickets.map(ticket => <TicketCard key={ticket.id} ticket={ticket} />) : !shop.loading && <p className="card empty-state">아직 구매한 표가 없어요.</p>}
      </section>
      <details className="card shop-rules"><summary>데일리 로또 당첨금</summary><p>{LOTTO_RULES.maxNumber}개 숫자 중 {LOTTO_RULES.pickCount}개를 골라요. 매일 {LOTTO_RULES.drawTime.slice(0, 5)} 이후에는 다음 날 추첨 표를 살 수 있어요.</p>
        <table><thead><tr><th>일치</th><th>당첨금</th></tr></thead><tbody>{Object.entries(LOTTO_RULES.prizes).reverse().map(([matches, prize]) => <tr key={matches}><td>{matches}개</td><td>{prize.toLocaleString("ko-KR")}G</td></tr>)}</tbody></table>
      </details>
    </div>
  </div>;
}

/** Scratching reveals an already purchased ticket; it never changes a balance. */
function ScratchTicket({ ticket }: { ticket: SpeettoTicket }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const strokes = useRef(0);
  const scratching = useRef(false);
  const symbolsRef = useRef<HTMLDivElement>(null);
  const [revealed, setRevealed] = useState(false);
  const [prize, setPrize] = useState(0);
  useEffect(() => {
    if (!revealed) return;
    const symbols = [...(symbolsRef.current?.children ?? [])];
    symbols.forEach((element, i) => popIn(element, { delay: 450 + i * 150 }));
    if (!ticket.won) return;
    let stop = () => {};
    const timer = window.setTimeout(() => {
      confetti(symbolsRef.current);
      stop = tween(0, ticket.prize, 900, value => setPrize(Math.round(value)));
    }, reduced() ? 0 : 450 + symbols.length * 150);
    return () => { window.clearTimeout(timer); stop(); };
  }, [revealed, ticket.won, ticket.prize]);
  useEffect(() => {
    const node = canvas.current;
    const context = node?.getContext("2d");
    if (!node || !context) return;
    context.globalCompositeOperation = "source-over";
    const gradient = context.createLinearGradient(0, 0, node.width, node.height);
    gradient.addColorStop(0, "#D8CCF7");
    gradient.addColorStop(1, "#C4DFF5");
    context.fillStyle = gradient;
    context.fillRect(0, 0, node.width, node.height);
    context.fillStyle = "rgba(255,255,255,.35)";
    for (let i = 0; i < 60; i++) {
      context.beginPath();
      context.arc((i * 97) % node.width, (i * 53) % node.height, 6, 0, 7);
      context.fill();
    }
    context.fillStyle = "#fff";
    context.font = "800 40px TmoneyRoundWind, Pretendard Variable, sans-serif";
    context.textAlign = "center";
    context.textBaseline = "middle";
    context.fillText("여기를 긁어보세요", node.width / 2, node.height / 2);
  }, []);
  function cleared(node: HTMLCanvasElement) {
    const data = node.getContext("2d")!.getImageData(0, 0, node.width, node.height).data;
    let clear = 0;
    let total = 0;
    for (let y = 4; y < node.height; y += 10) for (let x = 4; x < node.width; x += 10) {
      total += 1;
      if (data[(y * node.width + x) * 4 + 3] < 40) clear += 1;
    }
    return clear / total;
  }
  function scratch(event: PointerEvent<HTMLCanvasElement>) {
    const node = canvas.current;
    const context = node?.getContext("2d");
    if (!node || !context || revealed) return;
    const rect = node.getBoundingClientRect();
    context.globalCompositeOperation = "destination-out";
    context.beginPath();
    context.arc((event.clientX - rect.left) * node.width / rect.width, (event.clientY - rect.top) * node.height / rect.height, 34, 0, 7);
    context.fill();
    crumbs(event.clientX, event.clientY);
    strokes.current += 1;
    if (strokes.current % 8 === 0 && cleared(node) > .6) setRevealed(true);
  }
  return <section className="scratch-card" data-ticket-id={ticket.id}>
    <div className="card-head"><h2>예굼 스피또</h2><span className="scratch-ticket-number">No. {ticket.id.slice(-8)}</span></div>
    <div className="scratch-area">
      <div className="scratch-symbols" ref={symbolsRef}>{ticket.cells.map((key, i) => <span key={i} style={{ background: art[key].tint }}><img className="character" src={artSrc(key)} alt={art[key].name} /></span>)}</div>
      <canvas ref={canvas} width="652" height="300" className={revealed ? "revealed" : ""} aria-label="긁는 영역. 손가락이나 마우스로 문질러 주세요."
        onPointerDown={event => { if (event.button !== 0 || !event.isPrimary || revealed) return; event.currentTarget.setPointerCapture(event.pointerId); scratching.current = true; scratch(event); }}
        onPointerMove={event => { if (scratching.current) scratch(event); }} onPointerUp={() => { scratching.current = false; }} onPointerCancel={() => { scratching.current = false; }} onLostPointerCapture={() => { scratching.current = false; }} />
    </div>
    <div className={`scratch-result ${revealed ? ticket.won ? "won" : "lost" : ""}`} aria-live="polite">{revealed ? ticket.won ? `당첨! +${prize.toLocaleString("ko-KR")}G` : "아쉽지만 낙첨이에요" : "?"}</div>
    {!revealed && <button className="text-button" onClick={() => setRevealed(true)}>한 번에 열기</button>}
  </section>;
}
export function Speetto({ onBack }: { gold?: number; onBack: () => void }) {
  const shop = useLoadShop("speetto");
  const shownGold = useCountUp(shop.gold);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const pendingClick = useRef(false);
  const tickets = shop.speetto?.tickets ?? [];
  const ticket = tickets.find(entry => entry.id === selectedId) ?? tickets[0];
  const pending = shop.pending?.kind === "speetto" ? shop.pending.input as SpeettoPurchaseInput : null;
  async function purchase(payment: ShopPayment) {
    if (pendingClick.current || !shop.canPurchase || shop.pending && !pending) return;
    pendingClick.current = true;
    setBusy(true);
    setError("");
    try {
      const result = await shop.buySpeetto(pending ?? { requestId: crypto.randomUUID(), payment });
      if (result.purchase) setSelectedId(result.purchase.id);
      toast("스피또를 샀어요");
    } catch (e) { setError(e instanceof Error ? e.message : "구매를 확인하지 못했어요. 같은 결제 버튼으로 다시 시도해 주세요."); }
    finally { pendingClick.current = false; setBusy(false); }
  }
  const available = Boolean(shop.speetto) && shop.canPurchase && !busy && !shop.loading && (!shop.pending || Boolean(pending));
  return <div className="speetto">
    <Toolbar title="스피또" onBack={onBack} gold={shownGold} />
    <p className="speetto-rule">같은 캐릭터 3개면 {SPEETTO_RULES.prize.toLocaleString("ko-KR")}G 당첨</p>
    <div className="screen-body stack">
      <InventoryCard kind="speetto" />
      {ticket ? <ScratchTicket key={ticket.id} ticket={ticket} /> : !shop.loading && <section className="card empty-state"><h2>오늘의 행운을 긁어볼까요?</h2><p>골드나 이용권으로 스피또를 구매해 주세요.</p></section>}
      <div className="shop-purchase-actions">
        {shop.canPurchase && !pending && shop.gold < SPEETTO_RULES.price && <p className="subtle-note">골드가 부족해요. 이용권이 있으면 사용할 수 있어요.</p>}
        <button className="primary-button" disabled={!available || pending?.payment === "ticket" || !pending && shop.gold < SPEETTO_RULES.price} onClick={() => void purchase("gold")}>{busy ? "구매 확인 중…" : `골드로 1장 사기 · ${SPEETTO_RULES.price}G`}</button>
        <button className="secondary-button" disabled={!available || pending?.payment === "gold" || !pending && shop.inventory.speettoTickets < 1} onClick={() => void purchase("ticket")}>이용권으로 1장 사기</button>
      </div>
      <p className="subtle-note">당첨 확률 {SPEETTO_RULES.winPercent}% · 당첨금은 구매할 때 바로 받아요. 긁다가 나가도 지급은 유지돼요.</p>
      <ShopNotice kind="speetto" error={error} />
      {tickets.length > 1 && <section className="card speetto-history"><h2>내 스피또</h2>{tickets.map((entry, i) => <button key={entry.id} aria-pressed={ticket?.id === entry.id} onClick={() => setSelectedId(entry.id)}><span>구매 기록 {tickets.length - i}</span><strong>{entry.won ? `+${entry.prize.toLocaleString("ko-KR")}G` : "낙첨"}</strong></button>)}</section>}
    </div>
  </div>;
}
