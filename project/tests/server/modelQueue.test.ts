import test from "node:test";
import assert from "node:assert/strict";
import { acquireModelSlot, queuedModelFetch } from "../../server/modelQueue.ts";

test("model queue is FIFO, cancellation removes waiting work, backends are independent", async () => {
  const first = await acquireModelSlot("a");
  const controller = new AbortController();
  const cancelled = acquireModelSlot("a", controller.signal);
  const rejected = assert.rejects(cancelled);
  let started = false;
  const next = acquireModelSlot("a").then(release => { started = true; return release; });
  const independent = await acquireModelSlot("b");
  assert.equal(started, false);
  controller.abort(); await rejected;
  first(); first();
  const release = await next;
  assert.equal(started, true);
  release(); independent();
  const already = new AbortController(); already.abort();
  await assert.rejects(acquireModelSlot("a", already.signal));
});

test("generation slot covers response consumption and releases on reader cancellation", async t => {
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => {
    calls++;
    return new Response(calls === 1 ? new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode("partial")); } }) : "done");
  });
  const first = await queuedModelFetch("http://localhost:9876/chat/completions", {});
  const second = queuedModelFetch("http://localhost:9876/chat/completions", {});
  await Promise.resolve();
  assert.equal(calls, 1);
  await first.body!.cancel();
  assert.equal(await (await second).text(), "done");
  assert.equal(calls, 2);
  assert.equal(await (await queuedModelFetch("http://localhost:9876/chat/completions", {})).text(), "done");
});
