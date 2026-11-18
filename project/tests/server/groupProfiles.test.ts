import test from "node:test";
import assert from "node:assert/strict";
import { requestGroupChatCompletion, requestGroupCharacterStream } from "../../server/lmStudio.ts";
import type { GroupChatRequest } from "../../server/types.ts";

test("group speakers use individual connections while unassigned speakers retain group defaults", async t => {
  const defaults = { baseUrl: "http://localhost:1234/v1", modelId: "default", streaming: true, temperature: 0.7, maxTokens: 100 };
  const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
  t.mock.method(globalThis, "fetch", async (url: unknown, init: RequestInit) => {
    calls.push({ url: String(url), body: JSON.parse(String(init.body)) });
    return new Response(JSON.stringify({ choices: [{ message: { content: "A reply" } }] }), { headers: { "Content-Type": "application/json" } });
  });
  const request: GroupChatRequest = {
    settings: defaults, messages: [{ role: "user", content: "Hello" }], responseMode: "round-robin", maxRepliesPerTurn: 2,
    participants: [{ id: "a", name: "A", systemPrompt: "Be helpful", resolvedSettings: { ...defaults, baseUrl: "http://localhost:4321/v1", modelId: "personal", temperature: 0.3, maxTokens: 60 } }, { id: "b", name: "B", systemPrompt: "Be helpful" }]
  };
  await requestGroupChatCompletion(request, defaults);
  assert.deepEqual(calls.map(call => call.body.model), ["personal", "default"]);
  assert.deepEqual(calls.map(call => call.body.max_tokens), [60, 100]);
  assert.equal(calls[0].url, "http://localhost:4321/v1/chat/completions");
  assert.equal(calls[1].url, "http://localhost:1234/v1/chat/completions");
  const skippedReplies = await requestGroupChatCompletion({ ...request, skippedParticipantIds: ["a"] }, defaults);
  assert.deepEqual(skippedReplies.map(reply => reply.characterId), ["b"]);
  assert.equal(calls[2].body.model, "default");
  const stream = await requestGroupCharacterStream(request, request.participants[0], defaults);
  await stream.cancel();
  assert.equal(calls[3].body.model, "personal");
  assert.equal(calls[3].body.stream, true);
});
