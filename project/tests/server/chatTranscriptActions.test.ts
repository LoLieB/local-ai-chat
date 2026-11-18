import test from "node:test";
import assert from "node:assert/strict";

import {
  appendToLatestAssistantMessage,
  mergeAssistantContinuation,
  deleteMessageById,
  editLatestUserMessage,
  replaceLatestAssistantMessage
} from "../../shared/chatTranscriptActions.ts";

const messages = [
  { id: "u1", role: "user" as const, content: "first", createdAt: "2026-01-01T00:00:00.000Z" },
  { id: "a1", role: "assistant" as const, content: "answer", createdAt: "2026-01-01T00:00:01.000Z" },
  { id: "u2", role: "user" as const, content: "second", createdAt: "2026-01-01T00:00:02.000Z" }
];

test("editLatestUserMessage keeps the id and removes invalid later replies", () => {
  const edited = editLatestUserMessage([...messages, { id: "a2", role: "assistant", content: "old", createdAt: "2026-01-01T00:00:03.000Z" }], "u2", "updated");
  assert.deepEqual(edited?.map((message) => message.id), ["u1", "a1", "u2"]);
  assert.equal(edited?.[2]?.content, "updated");
  assert.equal(editLatestUserMessage(messages, "u1", "no"), null);
});

test("deleteMessageById changes only the selected message", () => {
  assert.deepEqual(deleteMessageById(messages, "a1")?.map((message) => message.id), ["u1", "u2"]);
  assert.equal(deleteMessageById(messages, "missing"), null);
});

test("replaceLatestAssistantMessage preserves the original when replacement is invalid", () => {
  const source = [...messages, { id: "a2", role: "assistant" as const, content: "old", createdAt: "2026-01-01T00:00:03.000Z" }];
  assert.equal(replaceLatestAssistantMessage(source, "a2", "new")?.[3]?.content, "new");
  assert.equal(replaceLatestAssistantMessage(source, "a1", "new"), null);
});

test("appendToLatestAssistantMessage preserves spacing and partial content", () => {
  const source = [...messages, { id: "a2", role: "assistant" as const, content: "partial", createdAt: "2026-01-01T00:00:03.000Z" }];
  assert.equal(appendToLatestAssistantMessage(source, "a2", "reply")?.[3]?.content, "partial reply");
  assert.equal(appendToLatestAssistantMessage(source, "a2", " continuation")?.[3]?.content, "partial continuation");
});

test("mergeAssistantContinuation removes repeated existing and generated sentences", () => {
  const existing = "Первая длинная мысль уже была полностью изложена. Вторая мысль тоже уже присутствует в ответе.";
  const addition = "Первая длинная мысль уже была полностью изложена. Новая полезная мысль продолжает ответ. Новая полезная мысль продолжает ответ.";

  assert.equal(
    mergeAssistantContinuation(existing, addition),
    `${existing} Новая полезная мысль продолжает ответ.`
  );
});

test("mergeAssistantContinuation keeps genuinely new continuation text", () => {
  assert.equal(mergeAssistantContinuation("Ответ закончился здесь.", "Новая часть начинается отсюда."), "Ответ закончился здесь. Новая часть начинается отсюда.");
});
