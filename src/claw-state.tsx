import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import type { Board } from "../shared/claw-physics";
import type { ClawCoinInput, ClawPlayInput, ClawResponse, ClawSummary, LedgerEntry } from "../shared/types";
import { api, ApiFailure } from "./api";
import { createClawPreview } from "./claw-preview";

export interface PendingClawPlay { input: ClawPlayInput; board: Board; response?: ClawResponse }
export interface PendingClawPurchase { input: ClawCoinInput }
interface ClawContextValue {
  preview: boolean; state: ClawResponse | null; loading: boolean; busy: boolean; error: string;
  pendingPlay: PendingClawPlay | null; pendingPurchase: PendingClawPurchase | null;
  load(): Promise<ClawResponse | void>;
  buy(quantity: 1 | 5): Promise<ClawResponse>;
  play(input: ClawPlayInput): Promise<ClawResponse>;
  retryPlay(): Promise<ClawResponse>;
  completePlay(): void;
}
const Context = createContext<ClawContextValue | null>(null);
export function useClaw() {
  const value = useContext(Context);
  if (!value) throw new Error("ClawProvider is missing");
  return value;
}
function restore(key: string): { play: PendingClawPlay | null; purchase: PendingClawPurchase | null } {
  try {
    const saved = JSON.parse(sessionStorage.getItem(key) ?? "null");
    const play = saved?.play;
    const purchase = saved?.purchase;
    return {
      play: typeof play?.input?.requestId === "string" && Array.isArray(play.board) ? play : null,
      purchase: typeof purchase?.input?.requestId === "string" && [1, 5].includes(purchase.input.quantity) ? purchase : null,
    };
  } catch { return { play: null, purchase: null }; }
}
export function clawSummaryOf(state: ClawSummary): ClawSummary {
  const { coins, freeCoins, purchasedCoins, nextGrantAt, serverNow, isAdmin } = state;
  return { coins, freeCoins, purchasedCoins, nextGrantAt, serverNow, isAdmin };
}
/** Keep request identities and the pre-play board across navigation/reloads.
 * Screen entry/visibility/refill events own reads; there is no polling here. */
export function ClawProvider({ children, preview, accountKey, gold, transact, onServerRead, onPreviewChange }: {
  children: ReactNode; preview: boolean; accountKey: string; gold: number;
  transact: <T>(action: () => Promise<T>) => Promise<T>;
  onServerRead: (summary: ClawSummary) => void;
  onPreviewChange: (summary: ClawSummary, gold: number, score: number, ledger: LedgerEntry[]) => void;
}) {
  const engine = useRef<ReturnType<typeof createClawPreview> | null>(null);
  if (preview && !engine.current) engine.current = createClawPreview();
  const key = `yegoom3:claw:pending:${accountKey}`;
  const saved = useRef(preview ? { play: null, purchase: null } : restore(key));
  const [state, setState] = useState<ClawResponse | null>(null);
  const stateRef = useRef(state);
  const [pendingPlay, setPendingPlay] = useState<PendingClawPlay | null>(saved.current.play);
  const [pendingPurchase, setPendingPurchase] = useState<PendingClawPurchase | null>(saved.current.purchase);
  const playRef = useRef(pendingPlay), purchaseRef = useRef(pendingPurchase);
  const [loading, setLoading] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const writing = useRef(false), mounted = useRef(true), generation = useRef(0), deferredRead = useRef(false);
  const callbacks = useRef({ gold, transact, onServerRead, onPreviewChange });
  callbacks.current = { gold, transact, onServerRead, onPreviewChange };
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; generation.current++; }; }, []);
  const remember = useCallback((play: PendingClawPlay | null, purchase: PendingClawPurchase | null) => {
    playRef.current = play; purchaseRef.current = purchase;
    if (mounted.current) { setPendingPlay(play); setPendingPurchase(purchase); }
    if (preview) return;
    try {
      if (play || purchase) sessionStorage.setItem(key, JSON.stringify({ play, purchase }));
      else sessionStorage.removeItem(key);
    } catch { /* Retry remains available in memory if browser storage is blocked. */ }
  }, [key, preview]);
  const apply = useCallback((next: ClawResponse) => {
    if (!mounted.current) return;
    stateRef.current = next; setState(next);
    const local = engine.current;
    if (local) callbacks.current.onPreviewChange(clawSummaryOf(next), local.gold, local.score, [...local.ledger]);
    else callbacks.current.onServerRead(clawSummaryOf(next));
  }, []);
  const load = useCallback(async () => {
    if (writing.current) { deferredRead.current = true; return; }
    const read = ++generation.current;
    setLoading(true);
    try {
      const next = engine.current ? engine.current.read() : await api.claw();
      if (!mounted.current || read !== generation.current) return;
      apply(next); setError(""); return next;
    } catch (e) {
      if (mounted.current && read === generation.current) setError(e instanceof Error ? e.message : "기계를 불러오지 못했어요.");
    } finally { if (mounted.current && read === generation.current) setLoading(false); }
  }, [apply]);
  const run = useCallback(async (action: () => Promise<ClawResponse>, success: (response: ClawResponse) => void, rejected: () => void) => {
    if (writing.current) throw new Error("이전 요청을 확인하고 있어요.");
    writing.current = true; generation.current++;
    setBusy(true); setLoading(false); setError("");
    try {
      const response = await callbacks.current.transact(action);
      // Persist a committed receipt before any following read or UI transition.
      success(response); apply(response); return response;
    } catch (e) {
      // Network/5xx outcomes can hide a commit. Keep exactly the same request.
      if (preview || e instanceof ApiFailure && e.status >= 400 && e.status < 500) rejected();
      if (mounted.current) setError(e instanceof Error ? e.message : "결과를 확인하지 못했어요. 다시 확인해 주세요.");
      throw e;
    } finally {
      writing.current = false;
      if (mounted.current) setBusy(false);
      if (mounted.current && deferredRead.current) { deferredRead.current = false; void load(); }
    }
  }, [apply, load, preview]);
  const play = useCallback(async (input: ClawPlayInput) => {
    if (writing.current || purchaseRef.current) throw new Error("진행 중인 요청 결과를 먼저 확인해 주세요.");
    const previous = playRef.current;
    if (previous && JSON.stringify(previous.input) !== JSON.stringify(input)) throw new Error("이전 플레이 결과를 먼저 확인해 주세요.");
    // A cached receipt is only for replay, never a new server clock/state snapshot.
    if (previous?.response) return previous.response;
    if (!stateRef.current && !previous) throw new Error("기계를 먼저 불러와 주세요.");
    const attempt = previous ?? { input, board: structuredClone(stateRef.current!.board) };
    remember(attempt, null);
    return run(async () => engine.current ? engine.current.play(input) : api.playClaw(input),
      response => remember({ ...attempt, response }, null), () => remember(null, null));
  }, [remember, run]);
  const retryPlay = useCallback(async () => {
    const pending = playRef.current;
    if (!pending) throw new Error("확인할 플레이가 없어요.");
    return play(pending.input);
  }, [play]);
  const completePlay = useCallback(() => { if (!writing.current) remember(null, purchaseRef.current); }, [remember]);
  const buy = useCallback(async (quantity: 1 | 5) => {
    if (writing.current || playRef.current) throw new Error("진행 중인 요청 결과를 먼저 확인해 주세요.");
    const previous = purchaseRef.current;
    if (previous && previous.input.quantity !== quantity) throw new Error("이전 구매 결과를 먼저 확인해 주세요.");
    const attempt = previous ?? { input: { requestId: crypto.randomUUID(), quantity } };
    remember(null, attempt);
    return run(async () => engine.current ? engine.current.buy(attempt.input, callbacks.current.gold) : api.buyClawCoins(attempt.input),
      () => remember(null, null), () => remember(null, null));
  }, [remember, run]);
  return <Context.Provider value={{ preview, state, loading, busy, error, pendingPlay, pendingPurchase, load, buy, play, retryPlay, completePlay }}>{children}</Context.Provider>;
}
