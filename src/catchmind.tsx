import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
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
    return value && ["claim", "reroll", "publish", "guess", "end", "next"].includes(value.action) &&
      typeof value.input?.requestId === "string" && (value.input.roundId === null || typeof value.input.roundId === "string") ? value : null;
  } catch { return null; }
}
/** Screen effects own visible-only polling; this provider owns shared state and
 * the identity of a mutation whose response may have been lost. */
export function CatchmindProvider({ children, preview, viewer, accountKey, transact, onServerRead, onPreviewChange }: {
  children: ReactNode;
  preview: boolean;
  viewer: CatchmindPlayer;
  accountKey: string;
  transact: <T>(action: () => Promise<T>) => Promise<T>;
  onServerRead: (state: CatchmindState) => void;
  onPreviewChange: (summary: CatchmindSummary, gold: number, score: number, ledger: LedgerEntry[]) => void;
}) {
  const previewEngine = useRef<ReturnType<typeof createCatchmindPreview> | null>(null);
  if (preview && !previewEngine.current) previewEngine.current = createCatchmindPreview(viewer);
  const storageKey = `yegoom3:catchmind:pending:${accountKey}`;
  const [state, setState] = useState<CatchmindState | null>(() => previewEngine.current?.read().catchmind ?? null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [pending, setPending] = useState<PendingCatchmind | null>(() => preview ? null : readPending(storageKey));
  const pendingRef = useRef(pending);
  const mounted = useRef(true);
  const writeInFlight = useRef(false);
  const deferredRead = useRef(false);
  const generation = useRef(0);
  const callbacks = useRef({ transact, onServerRead, onPreviewChange });
  callbacks.current = { transact, onServerRead, onPreviewChange };
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; generation.current++; }; }, []);
  const apply = useCallback((next: CatchmindResponse) => {
    if (!mounted.current) return;
    setState(next.catchmind);
    const engine = previewEngine.current;
    if (engine) callbacks.current.onPreviewChange(engine.summary(), engine.gold, engine.score, engine.ledger);
  }, []);
  useEffect(() => { if (previewEngine.current) apply(previewEngine.current.read()); }, [apply]);
  const remember = useCallback((attempt: PendingCatchmind | null) => {
    pendingRef.current = attempt;
    if (mounted.current) setPending(attempt);
    if (preview) return;
    try {
      if (attempt) sessionStorage.setItem(storageKey, JSON.stringify(attempt));
      else sessionStorage.removeItem(storageKey);
    } catch { /* In-memory retry still works when storage is unavailable. */ }
  }, [storageKey, preview]);
  const refresh = useCallback(async () => {
    if (writeInFlight.current) { deferredRead.current = true; return; }
    const current = ++generation.current;
    setLoading(true);
    try {
      const next = previewEngine.current ? previewEngine.current.read() : await api.catchmind();
      if (!mounted.current || current !== generation.current) return;
      apply(next);
      setError("");
      if (!previewEngine.current) callbacks.current.onServerRead(next.catchmind);
    } catch (e) {
      if (mounted.current && current === generation.current) setError(e instanceof Error ? e.message : "판을 불러오지 못했어요.");
    } finally { if (mounted.current && current === generation.current) setLoading(false); }
  }, [apply]);
  const mutate = useCallback(async (action: CatchmindAction, input: CatchmindInput): Promise<CatchmindResponse> => {
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
      const next = await callbacks.current.transact(async () => previewEngine.current ? previewEngine.current.mutate(action, input) : api.catchmindAction(action, input));
      apply(next);
      remember(null);
      return next;
    } catch (e) {
      if (preview || e instanceof ApiFailure && e.status >= 400 && e.status < 500) remember(null);
      if (mounted.current) setError(e instanceof Error ? e.message : "요청 결과를 확인하지 못했어요. 다시 확인해 주세요.");
      throw e;
    } finally {
      writeInFlight.current = false;
      if (mounted.current) setBusy(false);
      if (mounted.current && deferredRead.current) { deferredRead.current = false; void refresh(); }
    }
  }, [apply, remember, preview, refresh]);
  const gallery = useCallback(async (before?: number) => previewEngine.current ? previewEngine.current.gallery(before) : api.catchmindGallery(before), []);
  return <Context.Provider value={{ state, loading, busy, error, pending, refresh, mutate, gallery }}>{children}</Context.Provider>;
}
