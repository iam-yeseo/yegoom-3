import { useServerOffset } from "../clock";
import { memo, useEffect, useMemo, useRef, useState } from "react";
import { DAILY_FREE, LOTTO_RULES, SHOP_HISTORY_DAYS, SPEETTO_RULES } from "../../shared/balance";
import type { LottoPurchaseInput, LottoTicket, ShopKind, ShopPayment, SpeettoPurchaseInput, SpeettoTicket } from "../../shared/types";
import { Gold, SectionTitle, Toolbar } from "../components/UI";
import { usePurchaseConfirm } from "../components/PurchaseConfirm";
import { ScratchTicket } from "../components/ScratchTicket";
import { anim, reduced, shake, toast, useCountUp } from "../motion";
import { ticketCount, useShop } from "../shop";
import { formatDate, formatTime } from "../format";
import { ShopCards } from "./Home";

function InventoryCard({ kind }: { kind?: "lotto" | "speetto" }) {
  const shop = useShop();
  const rows = ([["lotto", "데일리 로또 이용권"], ["speetto", "스피또 이용권"], ["slot", "슬롯머신 이용권"], ["tag", "별명 뽑기권"]] as const)
    .filter(([item]) => !kind || item === kind);
  return <section className="card inventory-card" aria-label="보유 이용권">
    <h2>보유 이용권</h2>
    {rows.map(([item, label]) => <p key={item}><span>{label}</span><strong>{ticketCount(item, shop)}장</strong></p>)}
    <p className="inventory-note">매일 자정 아이템마다 {DAILY_FREE.lotto}장씩 새로 받아요. 그날 받은 이용권부터 쓰고, 남은 몫은 다음 날로 넘어가지 않아요.</p>
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
/** 이용권 first (today's free ones, then owned), gold second. A purchase still
 * awaiting its receipt can only be retried with the payment it was sent with;
 * a pre-merge 'free' purchase retries through the 이용권 button. */
function PayButtons({ price, tickets, available, busy, pending, gold, onPay }: {
  kind?: "lotto" | "speetto"; price: number; tickets: number; available: boolean; busy: boolean; pending: ShopPayment | null; gold: number; onPay(payment: ShopPayment): void;
}) {
  const ticketPayment: ShopPayment = pending === "free" ? "free" : "ticket";
  const ticketFirst = tickets > 0 || pending === "ticket" || pending === "free";
  const ticketButton = <button key="ticket" className={ticketFirst ? "primary-button" : "secondary-button"} aria-label={`이용권으로 사기 · 1장 · 보유 ${tickets}장`}
    disabled={!available || Boolean(pending && pending === "gold") || !pending && tickets < 1} onClick={() => onPay(ticketPayment)}>
    {busy && ticketFirst ? "구매 확인 중…" : <><span>이용권 1장</span><small>보유 {tickets}장</small></>}</button>;
  const goldButton = <button key="gold" className={ticketFirst ? "secondary-button" : "primary-button"} aria-label={`골드로 사기 · ${price}G`}
    disabled={!available || Boolean(pending && pending !== "gold") || !pending && gold < price} onClick={() => onPay("gold")}>
    {busy && !ticketFirst ? "구매 확인 중…" : `골드 ${price}G`}</button>;
  // Direct children of .shop-purchase-actions, which lays the two buttons out side by side.
  return <>{ticketFirst ? [ticketButton, goldButton] : [goldButton, ticketButton]}</>;
}
/** Fetch once on entry; the provider keeps purchase state across navigation. */
function useLoadShop(kind?: ShopKind) {
  const shop = useShop();
  const latest = useRef(shop);
  latest.current = shop;
  useEffect(() => { void latest.current.refresh(kind).catch(() => {}); }, [kind]);
  return shop;
}
export function ShopMain({ go, gold }: { go: (path: string) => void; gold: number }) {
  useLoadShop();
  return <div className="shop-main">
    <header className="tab-header with-gold"><h1>상점</h1><Gold value={gold} /></header>
    <div className="screen-body stack">
      <InventoryCard />
      <SectionTitle title="구매 가능한 아이템" />
      <ShopCards go={go} detailed />
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
  const offset = useServerOffset(serverTime);
  useEffect(() => {
    setNow(Date.now() + offset);
    const timer = window.setInterval(() => setNow(Date.now() + offset), 1000);
    return () => window.clearInterval(timer);
  }, [offset]);
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
    <span>{formatDate(date)} 당첨 번호</span>
    <div ref={draw}>{numbers.map((number, i) => <i key={number} style={{ background: winColors[i], color: i ? "#fff" : "#5C4300", visibility: i < rolled ? "visible" : "hidden" }}>{number}</i>)}</div>
  </div></section>;
}
/** Keep the server's order within each purchase day, newest days first. */
function purchaseGroups<T extends { purchaseDate: string; prize: number | null }>(tickets: T[], visiblePrize = (ticket: T) => ticket.prize ?? 0) {
  const groups = new Map<string, { date: string; tickets: T[]; prize: number }>();
  for (const ticket of tickets) {
    let group = groups.get(ticket.purchaseDate);
    if (!group) { group = { date: ticket.purchaseDate, tickets: [], prize: 0 }; groups.set(ticket.purchaseDate, group); }
    group.tickets.push(ticket);
    group.prize += visiblePrize(ticket);
  }
  return [...groups.values()].sort((left, right) => right.date.localeCompare(left.date));
}
function HistoryHeading({ date, tickets, prize }: { date: string; tickets: number; prize: number }) {
  return <div className="shop-history-heading"><h3>{formatDate(date)} <span>· {tickets}장</span></h3>{prize > 0 && <strong>당첨 +{prize.toLocaleString("ko-KR")}G</strong>}</div>;
}
const LottoTicketRow = memo(function LottoTicketRow({ ticket, number }: { ticket: LottoTicket; number: number }) {
  const settled = ticket.matches !== null;
  const result = settled ? ticket.rank ? `${ticket.rank}등 · +${(ticket.prize ?? 0).toLocaleString("ko-KR")}G` : "낙첨" : "추첨 대기";
  return <li className="ticket lotto-ticket-row" data-ticket-id={ticket.id}>
    <span className="shop-ticket-order" aria-label={`${number}번째 표`}>{number}</span>
    <div className="ticket-balls" aria-label="선택 번호">{ticket.numbers.map(value => {
      const index = ticket.winningNumbers?.indexOf(value) ?? -1;
      return <i key={value} data-n={value} style={index >= 0 ? { background: winColors[index], color: index ? "#fff" : "#5C4300" } : undefined}>{String(value).padStart(2, "0")}</i>;
    })}</div>
    <span className="ticket-outcome"><strong className={`ticket-result ${ticket.prize ? "gain" : "none"}`}>{result}</strong>
      {ticket.drawDate !== ticket.purchaseDate && <small className="ticket-date">{formatDate(ticket.drawDate).replace(/^\d+년 /, "")} 추첨</small>}
    </span>
  </li>;
});
const LottoHistory = memo(function LottoHistory({ tickets, loading }: { tickets: LottoTicket[]; loading: boolean }) {
  const groups = useMemo(() => purchaseGroups(tickets), [tickets]);
  return <section className="card lotto-tickets shop-ticket-history" aria-label="내 데일리 로또">
    <h2>내 데일리 로또 {tickets.length}장</h2>
    {groups.map(group => <section className="shop-history-group" data-purchase-date={group.date} key={group.date}>
      <HistoryHeading date={group.date} tickets={group.tickets.length} prize={group.prize} />
      <ol className="shop-ticket-list">{group.tickets.map((ticket, index) => <LottoTicketRow key={ticket.id} ticket={ticket} number={index + 1} />)}</ol>
    </section>)}
    {!tickets.length && !loading && <p className="empty-state">아직 구매한 표가 없어요.</p>}
    <p className="subtle-note shop-history-note">{`최근 ${SHOP_HISTORY_DAYS}일 기록만 보여요`}</p>
  </section>;
});

export function Lotto({ onBack }: { gold?: number; onBack: () => void }) {
  const shop = useLoadShop("lotto");
  const [picks, setPicks] = useState<number[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const pendingClick = useRef(false);
  const [confirmSheet, ask] = usePurchaseConfirm();
  const lottoTickets = ticketCount("lotto", shop);
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
    // A retry of an unconfirmed purchase never charges twice, so only a new one asks.
    if (!pending && !(await ask({ title: "데일리 로또를 살까요?", cost: payment === "gold" ? `골드 ${LOTTO_RULES.price}G` : "이용권 1장",
      detail: `고른 번호 ${[...picks].sort((a, b) => a - b).join(" · ")}` }))) { pendingClick.current = false; return; }
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
        <div className="lotto-meta"><span>{formatTime(LOTTO_RULES.drawTime)} 추첨</span><small>장당 {LOTTO_RULES.price}G</small></div>
      </div>
      {round && <p className="lotto-target">지금 사는 표 · {formatDate(round.targetDrawDate)} 추첨</p>}
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
        {full && shop.canPurchase && !pending && lottoTickets <= 0 && shop.gold < LOTTO_RULES.price && <p className="subtle-note">골드와 이용권이 부족해요.</p>}
        <PayButtons kind="lotto" price={LOTTO_RULES.price} tickets={lottoTickets} available={available} busy={busy} pending={pending?.payment ?? null} gold={shop.gold} onPay={payment => void purchase(payment)} />
      </div>
      <ShopNotice kind="lotto" error={error} />
      {round?.todayDraw.numbers && <DrawNumbers key={round.todayDraw.date} date={round.todayDraw.date} numbers={round.todayDraw.numbers} />}
      <LottoHistory tickets={round?.tickets ?? []} loading={shop.loading} />
      <details className="card shop-rules"><summary>데일리 로또 당첨금</summary><p>{LOTTO_RULES.maxNumber}개 숫자 중 {LOTTO_RULES.pickCount}개를 골라요. 매일 {formatTime(LOTTO_RULES.drawTime)} 판매 마감·추첨 후에는 다음 날 추첨 표를 살 수 있어요.</p>
        <table><thead><tr><th>일치</th><th>당첨금</th></tr></thead><tbody>{Object.entries(LOTTO_RULES.prizes).reverse().map(([matches, prize]) => <tr key={matches}><td>{matches}개</td><td>{prize.toLocaleString("ko-KR")}G</td></tr>)}</tbody></table>
      </details>
    </div>
    {confirmSheet}
  </div>;
}

export function Speetto({ onBack }: { gold?: number; onBack: () => void }) {
  const shop = useLoadShop("speetto");
  const shownGold = useCountUp(shop.gold);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [revealedIds, setRevealedIds] = useState(() => new Set<string>());
  const scratchCard = useRef<HTMLDivElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const pendingClick = useRef(false);
  const [confirmSheet, ask] = usePurchaseConfirm();
  const speettoTickets = ticketCount("speetto", shop);
  const tickets = shop.speetto?.tickets ?? [];
  const groups = useMemo(() => purchaseGroups(tickets, entry => revealedIds.has(entry.id) ? entry.prize : 0), [tickets, revealedIds]);
  const ticket = tickets.find(entry => entry.id === selectedId) ?? tickets[0];
  const pending = shop.pending?.kind === "speetto" ? shop.pending.input as SpeettoPurchaseInput : null;
  function reveal(id: string) { setRevealedIds(previous => previous.has(id) ? previous : new Set(previous).add(id)); }
  function select(id: string) {
    setSelectedId(id);
    requestAnimationFrame(() => scratchCard.current?.scrollIntoView({ behavior: reduced() ? "auto" : "smooth", block: "start" }));
  }
  async function purchase(payment: ShopPayment) {
    if (pendingClick.current || !shop.canPurchase || shop.pending && !pending) return;
    pendingClick.current = true;
    if (!pending && !(await ask({ title: "스피또를 살까요?", cost: payment === "gold" ? `골드 ${SPEETTO_RULES.price}G` : "이용권 1장" }))) { pendingClick.current = false; return; }
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
      {ticket ? <div ref={scratchCard} className="scratch-ticket-slot"><ScratchTicket key={ticket.id} ticket={ticket} revealed={revealedIds.has(ticket.id)} onReveal={() => reveal(ticket.id)} /></div> : !shop.loading && <section className="card empty-state"><h2>오늘의 행운을 긁어볼까요?</h2><p>골드나 이용권으로 스피또를 구매해 주세요.</p></section>}
      <div className="shop-purchase-actions">
        {shop.canPurchase && !pending && speettoTickets <= 0 && shop.gold < SPEETTO_RULES.price && <p className="subtle-note">골드와 이용권이 부족해요.</p>}
        <PayButtons kind="speetto" price={SPEETTO_RULES.price} tickets={speettoTickets} available={available} busy={busy} pending={pending?.payment ?? null} gold={shop.gold} onPay={payment => void purchase(payment)} />
      </div>
      <p className="subtle-note">당첨 확률 {SPEETTO_RULES.winPercent}% · 당첨금은 구매할 때 바로 받아요. 긁다가 나가도 지급은 유지돼요.</p>
      <ShopNotice kind="speetto" error={error} />
      <section className="card speetto-history shop-ticket-history" aria-label="내 스피또">
        <h2>내 스피또 {tickets.length}장</h2>
        {groups.map(group => <section className="shop-history-group" data-purchase-date={group.date} key={group.date}>
          <HistoryHeading date={group.date} tickets={group.tickets.length} prize={group.prize} />
          <ol className="shop-ticket-list">{group.tickets.map((entry, index) => {
            const revealed = revealedIds.has(entry.id);
            const result = revealed ? entry.won ? `+${entry.prize.toLocaleString("ko-KR")}G` : "낙첨" : "긁기 전";
            return <li key={entry.id}><button className="shop-ticket-row speetto-ticket-row" data-ticket-id={entry.id} aria-pressed={ticket?.id === entry.id}
              aria-label={`${formatDate(entry.purchaseDate)} ${formatTime(entry.createdAt)} 구매한 스피또 ${index + 1}번 · ${result}`} onClick={() => select(entry.id)}>
              <span className="shop-ticket-order" aria-hidden="true">{index + 1}</span><time dateTime={entry.createdAt}>{formatTime(entry.createdAt)}</time><strong className={revealed && entry.won ? "gain" : "none"}>{result}</strong>
            </button></li>;
          })}</ol>
        </section>)}
        {!tickets.length && !shop.loading && <p className="empty-state">아직 구매한 표가 없어요.</p>}
        <p className="subtle-note shop-history-note">{`최근 ${SHOP_HISTORY_DAYS}일 기록만 보여요`}</p>
      </section>
    </div>
    {confirmSheet}
  </div>;
}
