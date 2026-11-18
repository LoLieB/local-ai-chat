import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_CHAT_FILTERS, filterChats, normalizeChatTags, validChatOrganization } from "../../shared/chatOrganization.ts";

test("chat tags normalize duplicates and reject malformed imported metadata", () => {
  assert.deepEqual(normalizeChatTags([" Работа ", "Работа", "Идеи"]), ["Работа", "Идеи"]);
  for (const tags of [null, [""], ["a,b"], ["a\nb"], ["x".repeat(41)], Array(21).fill("a")]) {
    assert.throws(() => normalizeChatTags(tags));
    assert.equal(validChatOrganization({ tags }), false);
  }
  assert.equal(validChatOrganization({}), true);
  assert.equal(validChatOrganization({ archivedAt: "invalid" }), false);
});

test("chat filters combine archive, title, character, tags, local dates and pins without reordering", () => {
  const base = { title: "Рабочая идея", characterId: "c1", updatedAt: new Date(2026, 8, 14, 12).toISOString(), tags: ["Идеи"], pinnedAt: "2026-09-01" };
  const chats = [{ ...base, id: "a" }, { ...base, id: "b", archivedAt: "2026-09-14" }, { ...base, id: "c", characterId: "c2", pinnedAt: null }];
  const snapshot = JSON.stringify(chats);
  assert.deepEqual(filterChats(chats, DEFAULT_CHAT_FILTERS).map(c => c.id), ["a", "c"]);
  assert.deepEqual(filterChats(chats, { ...DEFAULT_CHAT_FILTERS, archive: "all" }).map(c => c.id), ["a", "b", "c"]);
  const filters = { ...DEFAULT_CHAT_FILTERS, archive: "archived" as const, query: " РАБОЧАЯ ", characterId: "c1", tag: "Идеи", pinned: true, from: "2026-09-14", to: "2026-09-14" };
  assert.deepEqual(filterChats(chats, filters).map(c => c.id), ["b"]);
  assert.equal(filterChats(chats, { ...filters, from: "2026-09-15" }).length, 0);
  assert.equal(filterChats(chats, { ...filters, tag: "Other" }).length, 0);
  assert.equal(JSON.stringify(chats), snapshot);
});
