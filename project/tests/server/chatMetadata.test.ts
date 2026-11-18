import assert from "node:assert/strict";
import test from "node:test";
import { normalizeChatTitle, normalizeChatTitleMode, resolveMessageAuthorName } from "../../shared/chatMetadata.ts";

test("normalizes chat titles and legacy title mode", () => {
  assert.equal(normalizeChatTitle("  Long   chat\nname  "), "Long chat name");
  assert.equal(normalizeChatTitleMode(undefined, "Новый чат"), "default");
  assert.equal(normalizeChatTitleMode(undefined, "Existing chat"), "manual");
});

test("resolves current, snapshot and legacy message authors", () => {
  const characters = [{ id: "sveta", name: "Света" }];
  assert.equal(resolveMessageAuthorName({ role: "user" }, characters), "Вы");
  assert.equal(resolveMessageAuthorName({ role: "assistant", authorCharacterId: "sveta" }, characters), "Света");
  assert.equal(resolveMessageAuthorName({ role: "assistant", authorNameSnapshot: "Старая Света" }, characters), "Старая Света");
  assert.equal(resolveMessageAuthorName({ role: "assistant" }, [], { id: "alina", name: "Алина" }), "Алина");
  assert.equal(resolveMessageAuthorName({ role: "assistant" }, []), "Ассистент");
});
