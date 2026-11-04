import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { KUJI_RULES, kujiCost } from "../../shared/balance";
import type { KujiGrade, KujiPurchase } from "../../shared/types";
import { ApiFailure } from "../api";
import { Toolbar, artSrc } from "../components/UI";
import { anim, confetti, flipY, hop, openSheet, pop, reduced, sparkle } from "../motion";
import { useShop } from "../shop";
import "../preview.css";

const gradeColors = ["#FFD866", "#FF8E7A", "#B9A3F0", "#8CC8F2", "#8FD9C0", "#FFE6DF", "#EEE8FC", "#E3F1FC"];
const gradeText = ["#5C4300", "#fff", "#fff", "#fff", "#fff", "#C9533E", "#7556C4", "#3B7FB3"];
const gradeIndex = (grade: KujiGrade) => KUJI_RULES.grades.findIndex(rule => rule.grade === grade);

function Sheet({ title, children, onClose }: { title: string; children: ReactNode; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const node = dialog.current!;
    return openSheet(node);
  }, []);
  return <dialog className="kuji-modal" ref={dialog} aria-labelledby={titleId}
    onCancel={event => { event.preventDefault(); onClose(); }}
    onClick={event => { if (event.target === event.currentTarget) onClose(); }}>
    <div className="kuji-sheet">
      <h2 id={titleId}>{title}</h2>
      {children}
      <button className="primary-button" type="button" onClick={onClose}>닫기</button>
    </div>
  </dialog>;
}

function Rewards({ reward }: { reward: KujiPurchase["reward"] }) {
  return <div className="kuji-reward-summary">
    {reward.score > 0 && <span>+{reward.score}점</span>}
    {reward.gold > 0 && <span>+{reward.gold.toLocaleString("ko-KR")}G</span>}
    {reward.lottoTickets > 0 && <span>데일리 로또 이용권 {reward.lottoTickets}장</span>}
    {reward.speettoTickets > 0 && <span>스피또 이용권 {reward.speettoTickets}장</span>}
  </div>;
}

function PurchaseSheet({ purchase, onClose }: { purchase: KujiPurchase; onClose: () => void }) {
  const [shown, setShown] = useState(reduced() ? purchase.cells.length : 0);
  const tickets = useRef<HTMLDivElement>(null);
  const done = shown === purchase.cells.length;
  useEffect(() => {
    if (reduced()) return;
    // Even a large selection completes its reveal within the existing motion budget.
    const timers = purchase.cells.map((_, index) => window.setTimeout(() => {
      setShown(index + 1);
      flipY(tickets.current?.children[index]);
    }, 320 + Math.min(index * 100, 420)));
    return () => timers.forEach(window.clearTimeout);
  }, [purchase]);
  useEffect(() => {
    if (!done || reduced()) return;
    const best = purchase.cells.reduce((left, cell) => gradeIndex(cell.grade) < gradeIndex(left.grade) ? cell : left);
    const ticket = tickets.current?.querySelector(`[data-position="${best.position}"]`);
    if (best.grade === "A") {
      pop(ticket, 1.12);
      confetti(ticket, { n: 44, spread: 190 });
      sparkle(ticket, { n: 10, r: 46 });
      hop(document.querySelector(".pg-kuji-heading img"));
    } else if (gradeIndex(best.grade) <= 2) sparkle(ticket);
  }, [done, purchase]);
  return <Sheet title="뽑은 쿠지" onClose={onClose}>
    <p className="kuji-sheet-note">제{purchase.boardId}판 · {purchase.cells.length}장 · {purchase.cost.toLocaleString("ko-KR")}G 사용</p>
    <div className="kuji-tickets" ref={tickets}>
      {purchase.cells.map((cell, index) => <span key={cell.position} data-position={cell.position}
        aria-label={index < shown ? `${cell.position + 1}번 쿠지 ${cell.grade}상` : "쿠지 공개 중"}
        className={`kuji-ticket ${index < shown ? "open" : ""} ${index < shown && cell.grade === "A" ? "grand" : ""}`}
        style={index < shown ? { background: gradeColors[gradeIndex(cell.grade)], color: gradeText[gradeIndex(cell.grade)] } : undefined}>
        {index < shown ? `${cell.grade}상` : "?"}
      </span>)}
    </div>
    <div className="kuji-earned" aria-live="polite">
      {done && <><strong>받은 보상</strong><Rewards reward={purchase.reward} />
        {purchase.lastOne && <p>라스트원 보너스 {KUJI_RULES.lastOneGold.toLocaleString("ko-KR")}G 포함</p>}</>}
    </div>
  </Sheet>;
}

export function Kuji({ onBack }: { onBack: () => void }) {
  const shop = useShop();
  const { kuji, pending } = shop;
  const [selected, setSelected] = useState<number[]>([]);
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  const active = useRef(false);
  const [error, setError] = useState("");
  const [purchase, setPurchase] = useState<KujiPurchase | null>(null);
  const [detail, setDetail] = useState<KujiGrade | "last" | null>(null);
  const pendingPurchase = pending?.kind === "kuji" ? pending.input : null;
  useEffect(() => {
    active.current = true;
    void shop.refresh("kuji").catch(() => {});
    return () => { active.current = false; };
  }, [shop.refresh]);
  useEffect(() => { setSelected([]); }, [kuji?.boardId]);
  useEffect(() => {
    if (!kuji) return;
    setSelected(previous => previous.filter(position => kuji.cells.some(cell => cell.position === position && cell.grade === null)));
  }, [kuji?.cells]);
  const activeSelection = pendingPurchase && pendingPurchase.boardId === kuji?.boardId ? pendingPurchase.positions : selected;
  const cost = kuji ? kujiCost(kuji.purchasedToday, selected.length) : 0;
  const anotherPending = pending !== null && pending.kind !== "kuji";
  async function buy() {
    if (!kuji || inFlight.current || !shop.canPurchase || anotherPending || (!pendingPurchase && selected.length === 0)) return;
    inFlight.current = true;
    setBusy(true);
    setError("");
    const input = pendingPurchase ?? { requestId: crypto.randomUUID(), boardId: kuji.boardId, positions: [...selected] };
    try {
      const response = await shop.buyKuji(input);
      setDetail(null);
      if (response.purchase) setPurchase(response.purchase);
      setSelected([]);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "쿠지를 뽑지 못했어요. 다시 시도해 주세요.");
      if (active.current && caught instanceof ApiFailure && caught.status >= 400 && caught.status < 500) await shop.refresh("kuji");
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }
  const retry = () => { setError(""); void shop.refresh("kuji").catch(() => {}); };
  const detailRule = detail && detail !== "last" ? KUJI_RULES.grades.find(rule => rule.grade === detail) : null;
  return <section className="preview-game pg-kuji">
    <Toolbar title="예굼쿠지" onBack={onBack} gold={shop.gold} />
    {!kuji ? <div className="screen-body">
      {shop.loading || !shop.error ? <p role="status">쿠지판을 불러오는 중…</p> : <><p className="form-message error" role="alert">{shop.error}</p><button className="text-button" onClick={retry}>다시 시도</button></>}
    </div> : <>
      <div className="pg-kuji-heading">
        <div><span>제{kuji.boardId}판 · 남은 쿠지</span><strong>{kuji.remaining}<small>/ {KUJI_RULES.size}</small></strong></div>
        <img src={artSrc("drop")} alt="" />
      </div>
      <div className="pg-stack">
        <div className="pg-card pg-kuji-board" role="group" aria-label={`쿠지판 ${KUJI_RULES.size}장`}>
          {kuji.cells.map(cell => {
            const chosen = activeSelection.includes(cell.position);
            return <button key={cell.position} type="button" data-nopress
              aria-label={`${cell.position + 1}번 쿠지${cell.grade ? `, 이미 뽑힌 ${cell.grade}상` : chosen ? ", 선택됨" : ""}`}
              aria-pressed={chosen} disabled={cell.grade !== null || busy || pending !== null || !shop.canPurchase}
              className={chosen ? "selected" : ""}
              onClick={event => {
                anim(event.currentTarget, chosen ? [{ scale: ".85" }, { scale: "1" }] : [{ scale: ".6" }, { scale: "1.15", offset: 0.6 }, { scale: "1" }], { dur: chosen ? 200 : 320, ease: "out", fill: "none" });
                setError("");
                setSelected(previous => chosen ? previous.filter(position => position !== cell.position) : [...previous, cell.position]);
              }}>{cell.grade ?? (chosen ? "✓" : "")}</button>;
          })}
        </div>
        <div className="pg-kuji-legend kuji-legend-buttons" aria-label="등급별 남은 쿠지와 보상">
          {KUJI_RULES.grades.map((rule, index) => <button type="button" key={rule.grade} aria-label={`${rule.grade}상 보상 보기`} onClick={() => setDetail(rule.grade)}>
            <b style={{ background: gradeColors[index], color: gradeText[index] }}>{rule.grade}</b>
            <span className={kuji.remainingByGrade[rule.grade] ? "" : "gone"}>{kuji.remainingByGrade[rule.grade]}<small>/{rule.count}</small></span>
          </button>)}
          <button className="kuji-last-one" type="button" aria-label="라스트원 보상 보기" onClick={() => setDetail("last")}><b>★</b><span>라스트원</span><small>{KUJI_RULES.lastOneGold.toLocaleString("ko-KR")}G</small></button>
        </div>
        <div className="pg-kuji-cost"><span>오늘 {kuji.purchasedToday}장 · {KUJI_RULES.basePriceCount + 1}장째부터 장당 {KUJI_RULES.higherPrice}G</span>
          <div aria-hidden="true">{Array.from({ length: KUJI_RULES.basePriceCount }, (_, index) => <i key={index} style={{ background: index < kuji.purchasedToday + activeSelection.length ? "#F2C94C" : "#EDE3C4" }} />)}</div>
        </div>
        <p className="kuji-next-price">다음 쿠지 1장 {kuji.nextPrice.toLocaleString("ko-KR")}G</p>
        {(error || shop.error) && <p className="form-message error" role="alert">{error || shop.error}</p>}
        {!shop.canPurchase && <p className="form-message">운영자 계정은 쿠지를 구매할 수 없어요.</p>}
        {anotherPending && <p className="form-message">진행 중인 다른 구매 결과를 먼저 확인해 주세요.</p>}
        <button className="primary-button pg-full" disabled={busy || !shop.canPurchase || anotherPending || (!pendingPurchase && selected.length === 0)} onClick={() => void buy()}>
          {busy ? "쿠지를 확인하는 중…" : pendingPurchase ? "구매 결과 다시 확인" : selected.length ? `${selected.length}장 뽑기 · ${cost.toLocaleString("ko-KR")}G` : "쿠지를 골라주세요"}
        </button>
        <button className="text-button" disabled={busy} onClick={retry}>쿠지판 새로고침</button>
      </div>
      {detail && <Sheet title={detail === "last" ? "라스트원 보상" : `${detail}상 보상`} onClose={() => setDetail(null)}>
        {detailRule ? <><p className="kuji-sheet-note">남은 쿠지 {kuji.remainingByGrade[detailRule.grade]} / {detailRule.count}장</p><Rewards reward={detailRule} /></> : <>
          <p className="kuji-sheet-note">남은 보상 {kuji.remaining > 0 ? 1 : 0}개</p>
          <Rewards reward={{ gold: KUJI_RULES.lastOneGold, score: 0, lottoTickets: 0, speettoTickets: 0 }} />
          <p className="kuji-sheet-note">판의 마지막 쿠지를 뽑으면 그 쿠지의 보상과 함께 받아요.</p>
        </>}
      </Sheet>}
    </>}
    {purchase && <PurchaseSheet purchase={purchase} onClose={() => {
      setPurchase(null);
      if (kuji?.remaining === 0) void shop.refresh("kuji");
    }} />}
  </section>;
}
