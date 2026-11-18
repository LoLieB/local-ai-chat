import test from "node:test";
import assert from "node:assert/strict";

import { formatMemoryConfirmation, parseExplicitMemoryCommand } from "../../shared/memoryCommand.ts";

test("explicit memory command defaults to user memory", () => {
  assert.deepEqual(parseExplicitMemoryCommand("Запомни: я предпочитаю короткие ответы", { chatId: "chat-a" }), {
    text: "я предпочитаю короткие ответы",
    scope: "user"
  });
});

test("explicit memory command resolves chat, character and group targets", () => {
  assert.equal(parseExplicitMemoryCommand("Запомни для этого чата: выбран React", { chatId: "chat-a" })?.chatId, "chat-a");
  assert.equal(parseExplicitMemoryCommand("Запомни для персонажа: пользователь любит спорить", { characterId: "char-a" })?.characterId, "char-a");
  assert.equal(parseExplicitMemoryCommand("Запомни для группы: релиз в пятницу", { groupChatId: "group-a" })?.groupChatId, "group-a");
});

test("explicit memory confirmation reports fact, category and source", () => {
  const command = parseExplicitMemoryCommand("Remember: use TypeScript")!;
  const confirmation = formatMemoryConfirmation(command, "explicit command");
  assert.match(confirmation, /use TypeScript/);
  assert.match(confirmation, /Общая память/);
  assert.match(confirmation, /explicit command/);
});
