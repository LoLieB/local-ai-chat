import assert from "node:assert/strict";
import test from "node:test";
import { createWorkspaceSyncQueue, type WorkspaceSaveStatus } from "../../src/workspaceSync";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
function setup() {
  const calls: Array<{ payload: string; revision: number; signal: AbortSignal; request: ReturnType<typeof deferred<{ revision: number }>> }> = [];
  const statuses: WorkspaceSaveStatus[] = [];
  const revisions: number[] = [];
  const queue = createWorkspaceSyncQueue<string>({
    revision: 4,
    send(payload, revision, signal) {
      const request = deferred<{ revision: number }>();
      calls.push({ payload, revision, signal, request });
      return request.promise;
    },
    onRevision: (revision) => revisions.push(revision),
    onStatus: (status) => statuses.push(status),
    isConflict: (error) => error === "conflict"
  });
  return { calls, statuses, revisions, queue };
}

test("failed in-flight save retains newest pending edit and uses explicit retry", async () => {
  const { calls, queue, statuses } = setup();
  queue.enqueue("old"); queue.enqueue("middle"); queue.enqueue("latest");
  calls[0].request.reject(new Error("offline")); await tick();
  assert.equal(calls.length, 1);
  assert.equal(statuses.at(-1), "error");
  queue.retry();
  assert.equal(calls[1].payload, "latest");
  assert.equal(calls[1].revision, 4);
  calls[1].request.resolve({ revision: 5 }); await tick();
  assert.equal(statuses.at(-1), "saved");
});

test("revision advances before the queued edit is sent, without an extra write", async () => {
  const { calls, queue, revisions } = setup();
  queue.enqueue("one"); queue.enqueue("two");
  assert.equal(calls.length, 1);
  calls[0].request.resolve({ revision: 5 }); await tick();
  assert.equal(calls[1].revision, 5);
  calls[1].request.resolve({ revision: 6 }); await tick();
  assert.deepEqual(revisions, [5, 6]);
  assert.equal(calls.length, 2);
});

test("conflict halts automatic writes and cannot be retried over server state", async () => {
  const { calls, queue, statuses } = setup();
  queue.enqueue("draft"); calls[0].request.reject("conflict"); await tick();
  queue.enqueue("newer draft"); queue.retry(); await tick();
  assert.equal(calls.length, 1);
  assert.equal(statuses.at(-1), "conflict");
});

test("logout aborts and ignores a late successful response including old pending work", async () => {
  const { calls, queue, revisions, statuses } = setup();
  queue.enqueue("old user"); queue.enqueue("old pending"); queue.dispose();
  assert.equal(calls[0].signal.aborted, true);
  calls[0].request.resolve({ revision: 5 }); await tick();
  queue.enqueue("ignored"); queue.retry();
  assert.deepEqual(revisions, []);
  assert.deepEqual(statuses, ["saving"]);
  assert.equal(calls.length, 1);
});

test("late failure from a disposed session does not disturb a new session", async () => {
  const old = setup(); const next = setup();
  old.queue.enqueue("old"); old.queue.dispose(); next.queue.enqueue("new");
  old.calls[0].request.reject(new Error("aborted")); await tick();
  next.calls[0].request.resolve({ revision: 5 }); await tick();
  assert.deepEqual(old.statuses, ["saving"]);
  assert.equal(next.statuses.at(-1), "saved");
  assert.deepEqual(next.revisions, [5]);
});

test("failed payload is retained when there is no newer edit", async () => {
  const { calls, queue } = setup();
  queue.enqueue("draft"); calls[0].request.reject(new Error("offline")); await tick();
  queue.retry(); assert.equal(calls[1].payload, "draft");
  calls[1].request.resolve({ revision: 5 }); await tick();
});
