import { memo, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { DAILY_FREE, SHOP_HISTORY_DAYS, SLOT_RULES } from "../../shared/balance";
import type { SlotSpin, SlotSpinInput, SlotSymbol } from "../../shared/types";
import { ApiFailure } from "../api";
import { Toolbar } from "../components/UI";
import { formatDate, formatTime } from "../format";
import { anim, coinFly, confetti, reduced, shake, useCountUp } from "../motion";
import { useShop } from "../shop";
import "../slot.css";

const labels: Record<SlotSymbol, string> = {
  banana: "바나나", apple: "사과", strawberry: "딸기", grape: "포도", watermelon: "수박", chamoe: "참외", seven: "7",
};
const initialSymbols: SlotSymbol[] = ["banana", "apple", "seven"];
const stripSymbols = [...SLOT_RULES.symbols, ...SLOT_RULES.symbols];
type Phase = "idle" | "spinning" | "checking" | "won" | "lost";

// The numeric tween updates this small toolbar, never the spinning reels.
const SlotToolbar = memo(function SlotToolbar({ gold, onBack }: { gold: number; onBack: () => void }) {
  const shown = useCountUp(gold);
  return <Toolbar title="슬롯머신" onBack={onBack} gold={shown} />;
});

const SlotHistory = memo(function SlotHistory({ spins, loading }: { spins: SlotSpin[]; loading: boolean }) {
  const groups = useMemo(() => {
    const days = new Map<string, { date: string; spins: SlotSpin[]; prize: number }>();
    for (const spin of spins) {
      let day = days.get(spin.date);
      if (!day) { day = { date: spin.date, spins: [], prize: 0 }; days.set(spin.date, day); }
      day.spins.push(spin);
      day.prize += spin.prize;
    }
    return [...days.values()].sort((a, b) => b.date.localeCompare(a.date));
  }, [spins]);
  return <section className="card slot-history shop-ticket-history" aria-label="내 슬롯머신 기록">
    <h2>최근 기록</h2>
    {groups.map(day => <section className="shop-history-group" data-purchase-date={day.date} key={day.date}>
      <div className="shop-history-heading"><h3>{formatDate(day.date)} <span>· {day.spins.length}회</span></h3>
        {day.prize > 0 && <strong>당첨 +{day.prize.toLocaleString("ko-KR")}G</strong>}
      </div>
      <ol className="shop-ticket-list">{day.spins.map((spin, index) => <li className="slot-history-row" data-spin-id={spin.id} key={spin.id}>
        <span className="shop-ticket-order" aria-hidden="true">{index + 1}</span>
        <time dateTime={spin.createdAt}>{formatTime(spin.createdAt)}</time>
        <span className="slot-history-symbols" role="img" aria-label={spin.reels.map(symbol => labels[symbol]).join(" · ")}>
          {spin.reels.map((symbol, i) => <span key={i}><img src={`/slot/${symbol}.svg`} alt="" width="20" height="20" /></span>)}
        </span>
        <strong className={spin.prize > 0 ? "gain" : "none"}>{spin.prize > 0 ? `+${spin.prize.toLocaleString("ko-KR")}G` : "낙첨"}</strong>
      </li>)}</ol>
    </section>)}
    {!spins.length && !loading && <p className="empty-state">아직 돌린 기록이 없어요.</p>}
    <p className="subtle-note shop-history-note">최근 {SHOP_HISTORY_DAYS}일 · 최대 {SLOT_RULES.historyLimit}회 기록만 보여요</p>
  </section>;
});

export function Slot({ onBack }: { onBack: () => void }) {
  const shop = useShop();
  const latestShop = useRef(shop);
  latestShop.current = shop;
  const [phase, setPhase] = useState<Phase>(() => shop.pending?.kind === "slot" ? "checking" : "idle");
  const [working, setWorking] = useState(false);
  const [symbols, setSymbols] = useState<SlotSymbol[]>(initialSymbols);
  const [spinning, setSpinning] = useState([false, false, false]);
  const [anticipating, setAnticipating] = useState(false);
  const [prize, setPrize] = useState(0);
  const [gold, setGold] = useState(shop.gold);
  const [error, setError] = useState("");
  const [shownRecent, setShownRecent] = useState(() => shop.slot?.recent.filter(spin => spin.requestId !== (shop.pending?.kind === "slot" ? shop.pending.input.requestId : null)) ?? []);
  const machine = useRef<HTMLElement>(null);
  const resultLine = useRef<HTMLDivElement>(null);
  const lever = useRef<HTMLSpanElement>(null);
  const strips = useRef<(HTMLDivElement | null)[]>([]);
  const faces = useRef<(HTMLDivElement | null)[]>([]);
  const loops = useRef<(Animation | null)[]>([null, null, null]);
  const animations = useRef(new Set<Animation>());
  const waits = useRef(new Map<number, (active: boolean) => void>());
  const mounted = useRef(true);
  const running = useRef(false);
  const generation = useRef(0);
  // A response can complete after the initiating screen was left. Keep the
  // mounted screen's original request even if the provider clears its pending.
  const unresolved = useRef<SlotSpinInput | null>(shop.pending?.kind === "slot" ? shop.pending.input : null);

  function cancelMotion() {
    animations.current.forEach(animation => animation.cancel());
    animations.current.clear();
    loops.current = [null, null, null];
  }
  function track(animation: Animation | null) {
    if (animation) {
      animations.current.add(animation);
      void animation.finished.then(() => animations.current.delete(animation), () => animations.current.delete(animation));
    }
    return animation;
  }
  function wait(ms: number, run: number): Promise<boolean> {
    if (ms <= 0) return Promise.resolve(mounted.current && generation.current === run);
    return new Promise(resolve => {
      const timer = window.setTimeout(() => { waits.current.delete(timer); resolve(mounted.current && generation.current === run); }, ms);
      waits.current.set(timer, resolve);
    });
  }

  useEffect(() => {
    mounted.current = true;
    void latestShop.current.refresh("slot").catch(() => {});
    return () => {
      mounted.current = false;
      generation.current++;
      cancelMotion();
      waits.current.forEach((resolve, timer) => { clearTimeout(timer); resolve(false); });
      waits.current.clear();
    };
  }, []);
  useEffect(() => {
    if (running.current) return;
    setGold(shop.gold);
    const pendingId = shop.pending?.kind === "slot" ? shop.pending.input.requestId : unresolved.current?.requestId;
    setShownRecent((shop.slot?.recent ?? []).filter(spin => phase !== "checking" || spin.requestId !== pendingId));
  }, [shop.gold, shop.slot, shop.pending, phase]);

  async function spin() {
    if (running.current) return;
    const current = latestShop.current;
    const pending = current.pending?.kind === "slot" ? current.pending.input : phase === "checking" ? unresolved.current : null;
    if (phase === "checking" && !pending) {
      setError("이전 요청 번호를 확인할 수 없어요. 최근 기록을 다시 불러와 확인해 주세요.");
      return;
    }
    if (!current.canPurchase || current.loading || current.pending && current.pending.kind !== "slot" || !pending && (current.free?.slot ?? 0) <= 0 && current.gold < SLOT_RULES.price) return;
    const input = pending ?? { requestId: crypto.randomUUID() };
    unresolved.current = input;
    const run = ++generation.current;
    running.current = true;
    setWorking(true);
    const started = performance.now();
    // A pending request confirms an existing spin; keep its reels still.
    const motionReduced = Boolean(pending) || reduced();
    cancelMotion();
    setError("");
    setPrize(0);
    setAnticipating(false);
    setPhase(pending ? "checking" : "spinning");
    setSpinning([!motionReduced, !motionReduced, !motionReduced]);
    if (!motionReduced) {
      track(anim(lever.current, [{ rotate: "0deg" }, { rotate: "28deg", offset: .4 }, { rotate: "0deg" }], { dur: 420, ease: "inOut", fill: "none" }));
      loops.current = strips.current.map(strip => {
        if (!strip) return null;
        const cell = strip.firstElementChild?.getBoundingClientRect().height ?? 96;
        return track(strip.animate([{ transform: "translateY(0)" }, { transform: `translateY(-${cell * SLOT_RULES.symbols.length}px)` }], {
          duration: 420, iterations: Infinity, easing: "linear",
        }));
      });
    }
    try {
      // The request starts in this click, before any animation wait.
      const response = await current.spinSlot(input);
      if (!mounted.current || generation.current !== run) return;
      const spinResult = response.spin;
      if (!spinResult) throw new Error("결과를 확인하지 못했어요. 같은 요청으로 다시 확인해 주세요.");
      // A retried receipt carries today's wallet, which may already have spent
      // its prize. Only a new spin stages the jackpot count-up before reveal.
      setGold(pending ? response.gold : Math.max(0, response.gold - spinResult.prize));
      if (motionReduced || reduced()) {
        cancelMotion();
        setSymbols(spinResult.reels);
        setSpinning([false, false, false]);
        const fade = track(anim(machine.current?.querySelector(".slot-reels"), [{ opacity: 0 }, { opacity: 1 }], { dur: 200, ease: "linear", fill: "none" }));
        await fade?.finished.catch(() => {});
      } else {
        const stopAt = Math.max(started + 800, performance.now());
        const suspense = spinResult.reels[0] === "seven" && spinResult.reels[1] === "seven";
        await Promise.all(spinResult.reels.map(async (symbol, index) => {
          if (!await wait(stopAt + index * 350 + (suspense && index === 2 ? 600 : 0) - performance.now(), run)) return;
          loops.current[index]?.cancel();
          setSymbols(previous => previous.map((entry, i) => i === index ? symbol : entry));
          setSpinning(previous => previous.map((entry, i) => i === index ? false : entry));
          if (suspense && index === 1) {
            setAnticipating(true);
            loops.current[2]?.updatePlaybackRate(.4);
          }
          const settle = track(anim(faces.current[index], [
            { transform: "translateY(-22%)" }, { transform: "translateY(9%)", offset: .68 }, { transform: "translateY(0)" },
          ], { dur: 220, ease: "out", fill: "none" }));
          await settle?.finished.catch(() => {});
        }));
      }
      if (!mounted.current || generation.current !== run) return;
      running.current = false;
      setWorking(false);
      unresolved.current = null;
      setAnticipating(false);
      setPrize(spinResult.prize);
      setShownRecent(response.slot.recent);
      setPhase(spinResult.prize > 0 ? "won" : "lost");
      setGold(response.gold);
      if (spinResult.prize > 0) {
        confetti(machine.current, { n: 32, spread: 140 });
        coinFly(resultLine.current, machine.current?.closest(".slot")?.querySelector(".game-toolbar .gold"));
      } else track(shake(resultLine.current));
    } catch (cause) {
      if (!mounted.current || generation.current !== run) return;
      cancelMotion();
      running.current = false;
      setWorking(false);
      setSpinning([false, false, false]);
      setAnticipating(false);
      const rejected = cause instanceof ApiFailure && cause.status >= 400 && cause.status < 500;
      setPhase(rejected ? "idle" : "checking");
      setError(cause instanceof Error ? cause.message : "결과를 확인하지 못했어요. 같은 요청으로 다시 확인해 주세요.");
      if (rejected) { unresolved.current = null; void latestShop.current.refresh("slot").catch(() => {}); }
    }
  }

  const pending = shop.pending?.kind === "slot" || phase === "checking";
  const missingRequest = phase === "checking" && shop.pending?.kind !== "slot" && !unresolved.current;
  const busy = working;
  const freeSpins = shop.free?.slot ?? 0;
  const disabled = busy || missingRequest || shop.loading || !shop.canPurchase || !shop.slot || Boolean(shop.pending && shop.pending.kind !== "slot") || !pending && freeSpins <= 0 && shop.gold < SLOT_RULES.price;
  const buttonLabel = pending && phase !== "spinning" ? "같은 요청으로 다시 확인"
    : freeSpins > 0 ? `무료로 돌리기 · 오늘 ${freeSpins}/${DAILY_FREE.slot}회` : `돌리기 · ${SLOT_RULES.price.toLocaleString("ko-KR")}G`;
  const message = error || shop.error || (missingRequest ? "이전 요청 번호를 확인할 수 없어요. 최근 기록을 다시 불러와 확인해 주세요." : "");
  return <div className="slot">
    <SlotToolbar gold={gold} onBack={onBack} />
    <div className="screen-body stack">
      <p className="slot-intro">과일 사이에 숨어 있는 오늘의 행운</p>
      <section ref={machine} className="slot-machine" data-phase={phase} data-anticipating={anticipating} aria-label="슬롯머신">
        <div className="slot-bulbs" aria-hidden="true">{Array.from({ length: 9 }, (_, index) => <i key={index} style={{ "--i": index } as CSSProperties} />)}</div>
        <div className="slot-marquee"><strong>예굼 슬롯</strong><span className="slot-jackpot">7 · 7 · 7 = +{SLOT_RULES.jackpotPrize.toLocaleString("ko-KR")}G</span></div>
        <div className="slot-cabinet">
          <div className="slot-reels" aria-label="슬롯 결과">
            {symbols.map((symbol, index) => <div className="slot-reel" key={index} data-symbol={symbol} data-spinning={spinning[index]}
              role="img" aria-label={`${index + 1}번째 릴: ${spinning[index] ? "회전 중" : labels[symbol]}`}>
              <div className="slot-reel-face" ref={element => { faces.current[index] = element; }}><img src={`/slot/${symbol}.svg`} alt="" width="80" height="80" /></div>
              <div className="slot-strip" ref={element => { strips.current[index] = element; }} aria-hidden="true">
                {stripSymbols.map((entry, i) => <div className="slot-strip-cell" key={i}><img src={`/slot/${entry}.svg`} alt="" width="80" height="80" /></div>)}
              </div>
            </div>)}
          </div>
          <button className="slot-lever-button" type="button" aria-label="슬롯머신 레버 당기기" onClick={() => void spin()} disabled={disabled} data-nopress data-notouchfx>
            <span className="slot-lever" ref={lever} aria-hidden="true"><i /><b /></span>
            <span className="slot-lever-base" aria-hidden="true" />
          </button>
        </div>
        <div ref={resultLine} className="slot-result" role="status" aria-live="polite" aria-atomic="true">
          {phase === "won" ? `7 7 7! +${prize.toLocaleString("ko-KR")}G`
            : phase === "lost" ? "아쉬워요, 다음 기회에!"
            : phase === "checking" ? "결과 확인 중"
            : phase === "spinning" ? anticipating ? "마지막 한 칸, 두근두근" : "두근두근…"
            : "레버를 당겨 행운을 만나 보세요"}
        </div>
      </section>
      <button type="button" className="primary-button slot-spin-button" onClick={() => void spin()} disabled={disabled} aria-label={buttonLabel}>
        {busy ? phase === "checking" ? "결과 확인 중…" : "돌아가는 중…" : buttonLabel}
      </button>
      <p className="slot-rule"><strong>7 7 7이 나오면 {SLOT_RULES.jackpotPrize.toLocaleString("ko-KR")}G</strong><span>당첨 확률 {SLOT_RULES.jackpotPercent}% · 1회 {SLOT_RULES.price.toLocaleString("ko-KR")}G{SLOT_RULES.dailyLimit === null ? " · 횟수 제한 없음" : ""}</span></p>
      {!shop.canPurchase && !shop.loading && <p className="subtle-note">운영자 계정은 구매에 참여하지 않아요.</p>}
      {!pending && freeSpins <= 0 && shop.gold < SLOT_RULES.price && shop.canPurchase && <p className="subtle-note">골드가 부족해요</p>}
      {shop.loading && !busy && <p className="subtle-note" role="status">상점 정보를 불러오는 중…</p>}
      {message && <p className="form-message error" role="alert">{message}</p>}
      {(!shop.slot || missingRequest) && !busy && message && <button type="button" className="text-button" onClick={() => void shop.refresh("slot").catch(() => {})}>다시 불러오기</button>}
      {shop.pending && shop.pending.kind !== "slot" && <p className="subtle-note" role="status">진행 중인 구매 화면에서 구매 결과를 먼저 확인해 주세요.</p>}
      {pending && !busy && <p className="subtle-note">같은 요청으로 다시 확인하면 처음 결과를 불러와요.</p>}
      <SlotHistory spins={shownRecent} loading={shop.loading} />
    </div>
  </div>;
}
