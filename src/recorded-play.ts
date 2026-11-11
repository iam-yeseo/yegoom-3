import { useCallback, useRef, useState, type MutableRefObject } from "react";
import { ApiFailure } from "./api";
import type { RecordStatus } from "./components/PlayShell";

/** A run of an event game (산타, 자유투 공식 도전) played on the device and recorded
 * in one request when it ends. A finished run is kept on the device until the
 * server has it, so a reload or a lost response re-sends it. Only a whole run is
 * ever kept: leaving mid-run keeps nothing, and that run ends unfinished. */
export interface PendingStore<I> {
  read(userId: string): I | null;
  write(userId: string, value: I | null): void;
}
export function pendingStore<I>(game: string, valid: (value: unknown) => value is I): PendingStore<I> {
  const key = (userId: string) => `yegoom3:${game}:finish:${userId}`;
  return {
    read(userId) {
      try { const value: unknown = JSON.parse(localStorage.getItem(key(userId)) ?? "null"); return valid(value) ? value : null; } catch { return null; }
    },
    write(userId, value) {
      try { if (value) localStorage.setItem(key(userId), JSON.stringify(value)); else localStorage.removeItem(key(userId)); } catch { /* Memory still holds it. */ }
    },
  };
}

/** Answers that mean the run can never be recorded as sent; anything else is retried. */
export const finalRefusal = (error: unknown) => error instanceof ApiFailure && (error.status === 400 || error.status === 403 || error.status === 404 || error.status === 409);

/** What the result dialog of the run being sent should now show. */
export type ResultPatch = { status: Exclude<RecordStatus, "saved" | "refused"> } | { status: "refused"; message: string };
interface RecordedState { current: { id: string; completed: boolean; finished: boolean } | null }

/** Sending a finished run, re-sending one left from a reload, and loading the
 * game's state (never while a run is waiting to be recorded). */
export function useRecordedPlay<S extends RecordedState, I, F extends S>({ userId, store, idOf, source, apply, mark, onSaved, retryMessage, onLoadError }: {
  userId: string;
  store: PendingStore<I>;
  idOf: (input: I) => string;
  /** Read at call time, so a new source (preview / signed in) is used at once. */
  source: MutableRefObject<{ load(): Promise<S>; finish(input: I): Promise<F> }>;
  apply: (state: S) => void;
  /** Updates the result dialog if it still shows the run with this id. */
  mark: (id: string, patch: ResultPatch) => void;
  /** The server has the run: show what it recorded. */
  onSaved: (response: F, input: I) => void;
  retryMessage: string;
  /** A load failed (the failure) or succeeded (null). */
  onLoadError: (failure: unknown) => void;
}) {
  const pending = useRef<I | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [syncError, setSyncError] = useState("");
  const props = useRef({ apply, mark, onSaved, onLoadError, retryMessage });
  props.current = { apply, mark, onSaved, onLoadError, retryMessage };

  const send = useCallback(async (input: I) => {
    const id = idOf(input);
    pending.current = input; store.write(userId, input);
    setSyncing(true); setSyncError("");
    props.current.mark(id, { status: "saving" });
    try {
      const response = await source.current.finish(input);
      pending.current = null; store.write(userId, null);
      props.current.apply(response);
      props.current.onSaved(response, input);
    } catch (failure) {
      const message = failure instanceof Error ? failure.message : "기록을 보내지 못했어요.";
      if (finalRefusal(failure)) {
        pending.current = null; store.write(userId, null);
        props.current.mark(id, { status: "refused", message });
        setSyncError(message);
        void source.current.load().then(state => props.current.apply(state)).catch(() => {});
      } else {
        props.current.mark(id, { status: "retry" });
        setSyncError(props.current.retryMessage);
      }
    } finally { setSyncing(false); }
  }, [userId, store, idOf, source]);

  const load = useCallback(async () => {
    if (pending.current) return;
    try {
      const state = await source.current.load();
      props.current.apply(state); props.current.onLoadError(null);
      // A run finished just before a reload is sent before anything else.
      const saved = store.read(userId);
      const current = state.current;
      if (saved && current && idOf(saved) === current.id && !current.completed && !current.finished) void send(saved);
      else if (saved) store.write(userId, null);
    } catch (failure) { props.current.onLoadError(failure); }
  }, [userId, store, idOf, source, send]);

  return { pending, syncing, syncError, setSyncError, send, load };
}
