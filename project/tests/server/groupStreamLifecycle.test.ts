import test from "node:test";
import assert from "node:assert/strict";

import {
  createGroupStreamTracker,
  GROUP_STREAM_EMPTY_REPLY
} from "../../src/groupStreamTracker.ts";
import {
  createStreamCompletionGuard,
  extractLmStudioStreamDelta,
  splitLmStudioStreamLines
} from "../../server/groupStream.ts";

test("LM Studio stream parser extracts SSE and JSON response content", () => {
  assert.equal(
    extractLmStudioStreamDelta('data: {"choices":[{"delta":{"content":"Привет"}}]}'),
    "Привет"
  );
  assert.equal(
    extractLmStudioStreamDelta('{"choices":[{"message":{"content":"Готовый ответ"}}]}'),
    "Готовый ответ"
  );
  assert.equal(extractLmStudioStreamDelta("data: [DONE]"), "");
});

test("LM Studio stream parser flushes a final line without newline", () => {
  const first = splitLmStudioStreamLines("", 'data: {"choices":[{"delta":{"content":"Ответ"}}]}');
  assert.deepEqual(first.lines, []);
  assert.notEqual(first.buffer, "");

  const flushed = splitLmStudioStreamLines(first.buffer, "", true);
  assert.equal(flushed.buffer, "");
  assert.equal(extractLmStudioStreamDelta(flushed.lines[0] || ""), "Ответ");
});

test("three participant stream updates matching pending messages", () => {
  const tracker = createGroupStreamTracker();
  tracker.start("maria", "message-maria");
  tracker.start("sveta", "message-sveta");
  tracker.start("alina", "message-alina");

  assert.deepEqual(tracker.append("maria", "Ответ Марии"), {
    messageId: "message-maria",
    content: "Ответ Марии"
  });
  assert.deepEqual(tracker.append("sveta", "Ответ Светы"), {
    messageId: "message-sveta",
    content: "Ответ Светы"
  });
  assert.deepEqual(tracker.append("alina", "Ответ Алины"), {
    messageId: "message-alina",
    content: "Ответ Алины"
  });

  assert.equal(tracker.finish("maria")?.unresolved, false);
  assert.equal(tracker.finish("sveta")?.unresolved, false);
  assert.equal(tracker.finish("alina")?.unresolved, false);
  assert.deepEqual(tracker.drainUnresolved(), []);
});

test("empty and aborted streams cannot leave unresolved pending messages", () => {
  const tracker = createGroupStreamTracker();
  tracker.start("maria", "message-maria");
  tracker.start("sveta", "message-sveta");

  assert.deepEqual(tracker.finish("maria"), {
    messageId: "message-maria",
    content: GROUP_STREAM_EMPTY_REPLY,
    unresolved: true
  });
  assert.deepEqual(tracker.drainUnresolved(), [
    {
      characterId: "sveta",
      messageId: "message-sveta",
      content: GROUP_STREAM_EMPTY_REPLY,
      unresolved: true
    }
  ]);
});

test("upstream stream must complete and must not report an error", () => {
  const interrupted = createStreamCompletionGuard();
  interrupted.inspect('data: {"choices":[{"delta":{"content":"partial"}}]}');
  assert.throws(() => interrupted.finish(), /interrupted/);
  for (const line of ['event: error', 'data: {"error":{"message":"failed"}}']) {
    assert.throws(() => createStreamCompletionGuard().inspect(line), /error/);
  }
  const completed = createStreamCompletionGuard();
  completed.inspect('data: [DONE]');
  assert.doesNotThrow(() => completed.finish());
});
