import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { CatchmindAction, CatchmindGalleryResponse, CatchmindInput, CatchmindPlayer, CatchmindResponse, CatchmindState, CatchmindSummary, LedgerEntry } from "../shared/types";
import { api, ApiFailure } from "./api";
import { createCatchmindPreview } from "./catchmind-preview";

export interface PendingCatchmind { action: CatchmindAction; input: CatchmindInput }
interface CatchmindContextValue {
  state: CatchmindState | null;
  loading: boolean;
  busy: boolean;
  error: string;
  pending: PendingCatchmind | null;
  refresh: () => Promise<void>;
  serverNow: () => number;
  gallery: (before?: number) => Promise<CatchmindGalleryResponse>;
  mutate: (action: CatchmindAction, input: CatchmindInput) => Promise<CatchmindResponse>;
}
const Context = createContext<CatchmindContextValue | null>(null);
export function useCatchmind(): CatchmindContextValue {
  const value = useContext(Context);
  if (!value) throw new Error("CatchmindProvider is missing");
  return value;
}
function readPending(key: string): PendingCatchmind | null {
  try {
    const value = JSON.parse(sessionStorage.getItem(key) ?? "null") as PendingCatchmind | null;
    return value && ["claim", "reroll", "publish", "guess", "end", "next", "skip"].includes(value.action) &&
      typeof value.input?.requestId === "string" && (value.input.roundId === null || typeof value.input.roundId === "string") ? value : null;
  } catch { return null; }
}
/** Screen effects own visible-only polling; this provider owns shared state and
 * the identity of a mutation whose response may have been lost. */
export function CatchmindProvider({ children, preview, viewer, accountKey, transact, onServerRead, onPreviewChange, onAccountChanged }: {
  children: ReactNode;
  preview: boolean;
  viewer: CatchmindPlayer;
  accountKey: string;
  transact: <T>(action: () => Promise<T>) => Promise<T>;
  onServerRead: (state: CatchmindState) => void;
  onAccountChanged: () => void;
  onPreviewChange: (summary: CatchmindSummary, gold: number, score: number, ledger: LedgerEntry[], wordsRemaining: number) => void;
}) {
  const previewEngine = useRef<ReturnType<typeof createCatchmindPreview> | null>(null);
  if (preview && !previewEngine.current) previewEngine.current = createCatchmindPreview(viewer);
  const initial = useRef<CatchmindResponse | null>(null);
  if (previewEngine.current && !initial.current) initial.current = previewEngine.current.read();
  const storageKey = `yegoom3:catchmind:pending:${accountKey}`;
  const [state, setState] = useState<CatchmindState | null>(() => initial.current?.catchmind ?? null);
  const stateRef = useRef(state);
  const version = useRef<number | null>(initial.current?.version ?? null);
  const clockOffset = useRef(0);
  const serverNow = useCallback(() => Date.now() + clockOffset.current, []);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [pending, setPending] = useState<PendingCatchmind | null>(() => preview ? null : readPending(storageKey));
  const pendingRef = useRef(pending);
  const mounted = useRef(true);
  const writeInFlight = useRef(false);
  const deferredRead = useRef(false);
  const generation = useRef(0);
  const readInFlight = useRef<number | null>(null);
  const callbacks = useRef({ transact, onServerRead, onPreviewChange, onAccountChanged, viewerId: viewer.id });
  callbacks.current = { transact, onServerRead, onPreviewChange, onAccountChanged, viewerId: viewer.id };
  const accountInvalid = useRef(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; generation.current++; }; }, []);
  const apply = useCallback((next: CatchmindResponse) => {
    clockOffset.current = Date.parse(next.serverTime) - Date.now();
    if (!mounted.current || (stateRef.current && version.current === next.version)) return;
    // A previous round is immutable. Keep its identity through guesses in the
    // current round, while still allowing refreshed profile metadata to appear.
    const previous = stateRef.current?.previousRound;
    const nextState = previous && next.catchmind.previousRound
      && JSON.stringify(previous) === JSON.stringify(next.catchmind.previousRound)
      ? { ...next.catchmind, previousRound: previous } : next.catchmind;
    version.current = next.version;
    stateRef.current = nextState;
    setState(nextState);
    const engine = previewEngine.current;
    if (engine) callbacks.current.onPreviewChange(engine.summary(), engine.gold, engine.score, engine.ledger, engine.wordsRemaining);
  }, []);
  useEffect(() => {
    const engine = previewEngine.current;
    if (engine) callbacks.current.onPreviewChange(engine.summary(), engine.gold, engine.score, engine.ledger, engine.wordsRemaining);
  }, []);
  const remember = useCallback((attempt: PendingCatchmind | null) => {
    pendingRef.current = attempt;
    if (mounted.current) setPending(attempt);
    if (preview) return;
    try {
      if (attempt) sessionStorage.setItem(storageKey, JSON.stringify(attempt));
      else sessionStorage.removeItem(storageKey);
    } catch { /* In-memory retry still works when storage is unavailable. */ }
  }, [storageKey, preview]);
  const invalidateAccount = useCallback(() => {
    if (!mounted.current || preview || accountInvalid.current) return;
    accountInvalid.current = true;
    generation.current++;
    stateRef.current = null; version.current = null; pendingRef.current = null;
    setState(null); setPending(null); setLoading(false);
    setError("로그인한 계정이 바뀌었어요. 화면을 새로고침하고 있어요.");
    // Keep the old account's scoped receipt in sessionStorage: its unknown
    // mutation may have committed and must remain retryable after signing back in.
    callbacks.current.onAccountChanged();
  }, [preview]);
  const refresh = useCallback(async () => {
    if (accountInvalid.current) return;
    if (writeInFlight.current) { deferredRead.current = true; return; }
    if (readInFlight.current === generation.current) return;
    const current = ++generation.current;
    readInFlight.current = current;
    // Background polling must not redraw an unchanged board merely to show a
    // loading flag. Initial entry still exposes the existing loading state.
    if (!stateRef.current) setLoading(true);
    try {
      const next = previewEngine.current ? previewEngine.current.read(version.current ?? undefined) : await api.catchmind(version.current ?? undefined);
      if (!mounted.current || current !== generation.current) return;
      if (!previewEngine.current && next.viewerId !== callbacks.current.viewerId) { invalidateAccount(); return; }
      clockOffset.current = Date.parse(next.serverTime) - Date.now();
      if ('unchanged' in next) { setError(""); return; }
      const changed = version.current !== next.version || !stateRef.current;
      apply(next);
      setError("");
      if (!previewEngine.current && changed) callbacks.current.onServerRead(next.catchmind);
    } catch (e) {
      if (!mounted.current || current !== generation.current) return;
      if (e instanceof ApiFailure && e.status === 401) { invalidateAccount(); return; }
      setError(e instanceof Error ? e.message : "판을 불러오지 못했어요.");
    } finally {
      if (readInFlight.current === current) readInFlight.current = null;
      if (mounted.current && current === generation.current) setLoading(false);
    }
  }, [apply, invalidateAccount]);
  const mutate = useCallback(async (action: CatchmindAction, input: CatchmindInput): Promise<CatchmindResponse> => {
    if (accountInvalid.current) throw new Error("로그인한 계정을 다시 확인하고 있어요.");
    if (writeInFlight.current) throw new Error("요청을 확인하고 있어요. 잠시 기다려 주세요.");
    const attempt = { action, input };
    if (pendingRef.current && JSON.stringify(pendingRef.current) !== JSON.stringify(attempt)) throw new Error("이전 요청 결과를 먼저 다시 확인해 주세요.");
    generation.current++;
    writeInFlight.current = true;
    setBusy(true);
    setLoading(false);
    setError("");
    remember(attempt);
    try {
      const next = await callbacks.current.transact(async () => previewEngine.current ? previewEngine.current.mutate(action, input)
        : api.catchmindAction(action, { ...input, expectedUserId: callbacks.current.viewerId }));
      if (!previewEngine.current && next.viewerId !== callbacks.current.viewerId) {
        invalidateAccount(); throw new Error("로그인한 계정이 바뀌었어요. 화면을 새로고침하고 있어요.");
      }
      apply(next);
      remember(null);
      return next;
    } catch (e) {
      if (e instanceof ApiFailure && (e.code === 'ACCOUNT_CHANGED' || e.status === 401)) {
        invalidateAccount(); throw e;
      }
      if (accountInvalid.current) throw e;
      if (preview || e instanceof ApiFailure && e.status >= 400 && e.status < 500) remember(null);
      if (mounted.current) setError(e instanceof Error ? e.message : "요청 결과를 확인하지 못했어요. 다시 확인해 주세요.");
      throw e;
    } finally {
      writeInFlight.current = false;
      if (mounted.current) setBusy(false);
      if (mounted.current && deferredRead.current) { deferredRead.current = false; void refresh(); }
    }
  }, [apply, remember, preview, refresh, invalidateAccount]);
  const gallery = useCallback(async (before?: number) => previewEngine.current ? previewEngine.current.gallery(before) : api.catchmindGallery(before), []);
  const value = useMemo(() => ({ state, loading, busy, error, pending, refresh, mutate, gallery, serverNow }),
    [state, loading, busy, error, pending, refresh, mutate, gallery, serverNow]);
  return <Context.Provider value={value}>{children}</Context.Provider>;
}
