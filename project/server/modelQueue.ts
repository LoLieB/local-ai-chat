import { ApiError } from "./types.js";
type Entry = { start: () => void };
const queues = new Map<string, Entry[]>();

// One in-flight generation per backend, including consumption of its response.
export function acquireModelSlot(key: string, signal?: AbortSignal): Promise<() => void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(signal.reason); return; }
    const queue = queues.get(key) || [];
    if (queue.length >= 128) { reject(new ApiError(503, "BAD_REQUEST", "Очередь модели заполнена. Повторите позже.")); return; }
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      signal?.removeEventListener("abort", abort);
      const index = queue.indexOf(entry);
      if (index < 0) return;
      queue.splice(index, 1);
      if (!queue.length) queues.delete(key);
      else if (index === 0) queue[0].start();
    };
    const abort = () => { release(); reject(signal?.reason || new Error("Запрос отменён.")); };
    const entry: Entry = { start: () => resolve(release) };
    queue.push(entry); queues.set(key, queue);
    signal?.addEventListener("abort", abort, { once: true });
    if (queue.length === 1) entry.start();
  });
}

export async function queuedModelFetch(url: string, init: RequestInit): Promise<Response> {
  const key = new URL(url).origin;
  const release = await acquireModelSlot(key, init.signal || undefined);
  try {
    init.signal?.throwIfAborted();
    const response = await fetch(url, init);
    if (!response.body) { release(); return response; }
    const reader = response.body.getReader();
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const result = await reader.read();
          if (result.done) { release(); controller.close(); }
          else controller.enqueue(result.value);
        } catch (error) { release(); controller.error(error); }
      },
      async cancel(reason) { try { await reader.cancel(reason); } finally { release(); } }
    }, { highWaterMark: 0 });
    return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
  } catch (error) { release(); throw error; }
}
