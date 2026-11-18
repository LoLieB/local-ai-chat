import assert from "node:assert/strict";
import test from "node:test";
import { CHAT_EXPORT_FORMAT, validateImportedChat } from "../../shared/chatTransfer.ts";

const message = (id: string, parentId: string | null = null) => ({ id, role: "user" as const, content: id, createdAt: "2026-01-01T00:00:00.000Z", parentId });

test("validates current graph backup and pins", () => {
  const result = validateImportedChat({ format: CHAT_EXPORT_FORMAT, version: 1, chat: { title: "QA", messages: [message("a"), { ...message("b", "a"), role: "assistant" as const }], activeLeafId: "b", pinnedMessageIds: ["a"] } });
  assert.equal(result.activeLeafId, "b");
  assert.deepEqual(result.pinnedMessageIds, ["a"]);
});

test("preserves author metadata and chat naming metadata", () => {
  const result = validateImportedChat({
    format: CHAT_EXPORT_FORMAT,
    version: 1,
    chat: {
      title: "Ideas",
      titleMode: "manual",
      pinnedAt: "2026-01-01T00:00:00.000Z",
      messages: [{ ...message("a"), authorCharacterId: "char-sveta", authorNameSnapshot: "Света" }],
      pinnedMessageIds: ["a"]
    }
  });
  assert.equal(result.titleMode, "manual");
  assert.equal(result.messages[0]?.authorNameSnapshot, "Света");
});

test("rejects duplicate ids, dangling parents and cycles", () => {
  assert.throws(() => validateImportedChat({ title: "bad", messages: [message("a"), message("a")] }));
  assert.throws(() => validateImportedChat({ title: "bad", messages: [message("a", "missing")] }));
  assert.throws(() => validateImportedChat({ title: "bad", messages: [message("a", "b"), message("b", "a")] }));
});
