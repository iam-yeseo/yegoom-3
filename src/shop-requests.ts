/** Orders one screen family's reads and writes, and owns its loading flag.
 *
 * - At most one read counts: a newer read supersedes an older one, whose late
 *   answer is then ignored (`current()` is false).
 * - A write supersedes the read in flight too, and reads asked for during a
 *   write wait for it. Either way the read is run again after the write,
 *   unless the write's own answer already carries what it would have fetched.
 * - `loading` is on while a read or a write that still counts is in flight and
 *   goes off exactly when the last of them ends: never while another is still
 *   running, and never left on by a superseded request. */
export function createRequestGate<Kind>(setLoading: (loading: boolean) => void) {
  let generation = 0;
  let reading: { generation: number; kind: Kind } | null = null;
  let writing = false;
  let deferred: { kind: Kind } | null = null;
  return {
    writing: () => writing,
    /** Starts a read. Null while a write is in flight: the read runs after it. */
    beginRead(kind: Kind): { current(): boolean; end(): void } | null {
      if (writing) { deferred = { kind }; return null; }
      const mine = ++generation;
      reading = { generation: mine, kind };
      setLoading(true);
      return {
        /** False once a newer read or a write has made this answer stale. */
        current: () => mine === generation,
        end() {
          if (reading?.generation !== mine) return;
          reading = null;
          setLoading(false);
        },
      };
    },
    /** Starts a write; the caller has checked that none is in flight. */
    beginWrite(): { end(covered?: (kind: Kind) => boolean): { kind: Kind } | null } {
      generation++;
      // The read this write overtook would have shown the state before it.
      if (reading) { deferred = { kind: reading.kind }; reading = null; }
      writing = true;
      setLoading(true);
      return {
        /** Ends the write. Returns the read to run next, if one is still owed;
         * loading then stays on for it. */
        end(covered) {
          writing = false;
          const next = deferred;
          deferred = null;
          if (next && !covered?.(next.kind)) return next;
          setLoading(false);
          return null;
        },
      };
    },
    /** State was replaced locally: the read in flight is stale and not owed again. */
    supersedeRead() {
      generation++;
      if (!reading) return;
      reading = null;
      if (!writing) setLoading(false);
    },
  };
}
