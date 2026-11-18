export type WorkspaceSaveStatus = "idle" | "saving" | "saved" | "error" | "conflict";

// One queue belongs to one hydrated session. Disposing it invalidates late responses.
export function createWorkspaceSyncQueue<T>(options: {
  revision: number;
  debounceMs?: number;
  send: (payload: T, revision: number, signal: AbortSignal) => Promise<{ revision: number }>;
  onRevision: (revision: number) => void;
  onStatus: (status: WorkspaceSaveStatus) => void;
  isConflict: (error: unknown) => boolean;
}) {
  let revision = options.revision;
  let pending: { payload: T } | null = null;
  let controller: AbortController | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;
  let paused = false;
  let conflicted = false;

  const flush = async () => {
    if (disposed || paused || controller || !pending) return;
    const next = pending;
    pending = null;
    const request = new AbortController();
    controller = request;
    options.onStatus("saving");
    try {
      const result = await options.send(next.payload, revision, request.signal);
      if (disposed) return;
      revision = result.revision;
      options.onRevision(revision);
      options.onStatus(pending ? "saving" : "saved");
    } catch (error) {
      if (disposed) return;
      // An older failed request must never replace edits queued while it ran.
      pending ??= next;
      paused = true;
      conflicted = options.isConflict(error);
      options.onStatus(conflicted ? "conflict" : "error");
    } finally {
      if (!disposed) {
        controller = null;
        void flush();
      }
    }
  };

  return {
    enqueue(payload: T) {
      if (disposed) return;
      pending = { payload };
      if (paused || controller) return;
      if (timer) clearTimeout(timer);
      if (options.debounceMs) {
        options.onStatus("saving");
        timer = setTimeout(() => { timer = null; void flush(); }, options.debounceMs);
      } else void flush();
    },
    retry() {
      if (disposed || conflicted) return;
      paused = false;
      if (timer) { clearTimeout(timer); timer = null; }
      void flush();
    },
    dispose() {
      disposed = true;
      if (timer) clearTimeout(timer);
      pending = null;
      controller?.abort();
    }
  };
}
