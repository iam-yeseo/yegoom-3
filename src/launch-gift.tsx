import { createContext, useCallback, useContext, useEffect, useId, useRef, useState, type ReactNode } from "react";
import { LAUNCH_GIFT } from "../shared/balance";
import type { LaunchGiftResponse, LaunchGiftState, Role } from "../shared/types";
import { useAttendance } from "./attendance";
import { useShop } from "./shop";
import { openSheet, pop, toast, useOnChange } from "./motion";
import "./launch.css";

/** Later coin arrivals start new target pops after the first coin's callback. */
export async function waitForAttendanceEffects(root: Element | null) {
  // Reduced-motion coin flight resolves immediately, before React's stamp fade.
  await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
  for (let pass = 0; pass < 2; pass++) {
    const effects = [...(root?.getAnimations({ subtree: true }) ?? []), ...(document.querySelector(".fx-layer")?.getAnimations({ subtree: true }) ?? [])];
    await Promise.all(effects.filter(effect => effect.effect?.getComputedTiming().iterations !== Infinity).map(effect => effect.finished.catch(() => {})));
  }
}

function LaunchDialog({ title, onClose, children, className = "" }: { title: string; onClose: () => void; children: ReactNode; className?: string }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const node = dialog.current!;
    return openSheet(node);
  }, []);
  return <dialog ref={dialog} className={`launch-dialog ${className}`} aria-labelledby={titleId}
    onCancel={event => { event.preventDefault(); onClose(); }} onClick={event => { if (event.target === event.currentTarget) onClose(); }}>
    <button className="launch-dialog-close" type="button" aria-label="닫기" onClick={onClose}><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18" /></svg></button>
    <h2 id={titleId}>{title}</h2>
    {children}
  </dialog>;
}
export function StockNotice({ onClose }: { onClose: () => void }) {
  return <LaunchDialog title="주식 시장은 준비 중이에요" onClose={onClose} className="stock-notice">
    <p>곧 문을 열어요. 조금만 기다려 주세요!</p>
    <button className="primary-button" type="button" onClick={onClose}>확인</button>
  </LaunchDialog>;
}
function TicketIcon({ kind }: { kind: "lotto" | "speetto" }) {
  return <svg className={`launch-ticket-icon launch-ticket-${kind}`} width="72" height="54" viewBox="0 0 72 54" fill="none" aria-hidden="true">
    <path d="M9 5h54a5 5 0 0 1 5 5v10a7 7 0 0 0 0 14v10a5 5 0 0 1-5 5H9a5 5 0 0 1-5-5V34a7 7 0 0 0 0-14V10a5 5 0 0 1 5-5Z" fill="currentColor" />
    <path d="M51 11v32" stroke="#fff9ee" strokeWidth="2" strokeDasharray="3 4" />
    {kind === "lotto" ? <><circle cx="23" cy="27" r="10" fill="#fff9ee" /><path d="M20 22h7l-5 10" stroke="#94700a" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" /></>
      : <path d="m27 16 3.3 6.7 7.4 1.1-5.3 5.2 1.2 7.3-6.6-3.5-6.6 3.5 1.2-7.3-5.3-5.2 7.4-1.1L27 16Z" fill="#fff9ee" />}
  </svg>;
}
function GiftDialog({ claimed, busy, error, receive, close }: { claimed: boolean; busy: boolean; error: string; receive: () => void; close: () => void }) {
  const tickets = useRef<HTMLDivElement>(null);
  useOnChange(claimed, () => {
    if (claimed) tickets.current?.querySelectorAll(".launch-ticket-icon").forEach((icon, i) => pop(icon, 1.15, { delay: i * 70 }));
  });
  return <LaunchDialog title="예굼방 아케이드 3 오픈 기념 선물" onClose={close} className="launch-gift-dialog">
    <p>{claimed ? "함께해 줘서 고마워요. 이용권으로 즐겨 보세요!" : "오픈 첫날, 출석해 준 여러분께 드려요."}</p>
    <div className="launch-gift-tickets" ref={tickets}>
      <div><TicketIcon kind="lotto" /><span>데일리 로또 이용권</span><strong>{LAUNCH_GIFT.lottoTickets}장</strong></div>
      <div><TicketIcon kind="speetto" /><span>스피또 이용권</span><strong>{LAUNCH_GIFT.speettoTickets}장</strong></div>
    </div>
    {claimed && <p className="launch-gift-complete" role="status">선물을 받았어요</p>}
    {error && !claimed && <p className="form-message error" role="alert">{error}</p>}
    <button className="primary-button" type="button" disabled={!claimed && busy} onClick={claimed ? close : receive}>{claimed ? "확인" : busy ? "수령 중…" : "수령하기"}</button>
  </LaunchDialog>;
}
interface LaunchGiftContextValue {
  available: boolean;
  openGift: () => void;
  /** Release only after coin/character attendance effects have completed. */
  beginAttendance: () => () => void;
}
const Context = createContext<LaunchGiftContextValue | null>(null);
export function useLaunchGift() {
  const value = useContext(Context);
  if (!value) throw new Error("LaunchGiftProvider is required");
  return value;
}
const startsAt = Date.parse(`${LAUNCH_GIFT.date}T00:00:00+09:00`);
const endsAt = startsAt + 86_400_000;

/** Eligibility comes from bootstrap; only the serverless preview uses its local attendance. */
export function LaunchGiftProvider({ children, state, preview, role, serverTime, path, suspended, claim }: {
  children: ReactNode; state: LaunchGiftState; preview: boolean; role?: Role;
  serverTime: string; path: string; suspended: boolean; claim: () => Promise<LaunchGiftResponse>;
}) {
  const attendance = useAttendance();
  const shop = useShop();
  const [previewClaimed, setPreviewClaimed] = useState(false);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [blocked, setBlocked] = useState(false);
  const [afterAttendance, setAfterAttendance] = useState(false);
  const [now, setNow] = useState(() => Date.parse(serverTime));
  const depth = useRef(0);
  const inFlight = useRef(false);
  const shownHome = useRef(false);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    const offset = preview ? 0 : Date.parse(serverTime) - Date.now();
    const update = () => setNow(Date.now() + offset);
    update();
    const current = Date.now() + offset;
    const boundary = current < startsAt ? startsAt : current < endsAt ? endsAt : null;
    const timer = boundary === null ? undefined : window.setTimeout(update, Math.min(2_147_483_647, Math.max(1, boundary - current + 1)));
    document.addEventListener("visibilitychange", update);
    return () => { window.clearTimeout(timer); document.removeEventListener("visibilitychange", update); };
  }, [serverTime, preview]);
  const onDate = now >= startsAt && now < endsAt;
  const claimed = preview ? previewClaimed : state.claimed;
  const available = role === "player" && onDate && !claimed && (preview ? attendance.claimed && attendance.today === LAUNCH_GIFT.date : state.available);
  const openGift = useCallback(() => { if (available && !blocked && !suspended) { setError(""); setOpen(true); shownHome.current = true; } }, [available, blocked, suspended]);
  const close = useCallback(() => setOpen(false), []);
  useEffect(() => { if (!onDate || role !== "player") setOpen(false); }, [onDate, role]);
  useEffect(() => {
    if (path !== "/") shownHome.current = false;
    if (path !== "/attendance" && path !== "/") setAfterAttendance(false);
    if (!available || blocked || suspended) return;
    if (path === "/" && !shownHome.current || path === "/attendance" && afterAttendance) {
      shownHome.current = true; setAfterAttendance(false); setOpen(true);
    }
  }, [path, available, blocked, suspended, afterAttendance]);
  const beginAttendance = useCallback(() => {
    depth.current++; setBlocked(true);
    let released = false;
    return () => {
      if (released) return;
      released = true; depth.current = Math.max(0, depth.current - 1);
      if (mounted.current && !depth.current) { setBlocked(false); setAfterAttendance(true); }
    };
  }, []);
  async function receive() {
    if (!available || inFlight.current) return;
    inFlight.current = true; setBusy(true); setError("");
    try {
      let awarded: boolean;
      if (preview) { awarded = shop.claimPreviewLaunchGift().awarded; setPreviewClaimed(true); }
      else awarded = (await claim()).awarded;
      if (mounted.current) toast(awarded ? "런칭 선물을 받았어요" : "이미 받은 선물이에요");
    } catch (e) {
      if (mounted.current) setError(e instanceof Error ? e.message : "선물을 받지 못했어요. 다시 시도해 주세요.");
    } finally { inFlight.current = false; if (mounted.current) setBusy(false); }
  }
  return <Context.Provider value={{ available, openGift, beginAttendance }}>
    {children}
    {open && onDate && role === "player" && <GiftDialog claimed={claimed} busy={busy} error={error} receive={() => void receive()} close={close} />}
  </Context.Provider>;
}
