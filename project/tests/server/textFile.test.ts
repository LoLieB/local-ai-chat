import test from "node:test";
import assert from "node:assert/strict";
import { formatTextFile } from "../../src/textFile.ts";
import { extractMentionedCharacterTurns } from "../../shared/groupTurnPlan.ts";
const bytes = (text: string) => new TextEncoder().encode(text).buffer;

test("text file import preserves content and contains embedded markdown fences", () => {
  assert.equal(formatTextFile("notes.md", bytes("Привет\n```\nкод")), "Файл: notes.md\n````text\nПривет\n```\nкод\n````");
});
test("text file import rejects binary, unsupported, empty and oversized input", () => {
  for (const [name, data] of [
    ["a.png", bytes("image")], ["a.txt", bytes("\u0000binary")], ["a.txt", bytes(" ")],
    ["a.txt", new Uint8Array([255]).buffer], ["a.txt", bytes("x".repeat(16001))],
    ["a.txt", bytes("я".repeat(17000))]
  ] as const) assert.throws(() => formatTextFile(name, data));
});

test("speaker labels inside imported text do not redirect the group turn", () => {
  const file = formatTextFile("dialogue.txt", bytes("Anna: this is quoted file content"));
  const participants = [{ id: "a", name: "Anna" }, { id: "b", name: "Boris" }];
  assert.deepEqual(extractMentionedCharacterTurns(file, participants), []);
  assert.deepEqual(extractMentionedCharacterTurns("@Boris: read this\n\n" + file, participants).map(turn => turn.characterId), ["b"]);
});
