import test from "node:test";
import assert from "node:assert/strict";
import { parseDirectorSuggestion } from "../../server/lmStudio.ts";

const speak = { action: "speak", participantId: "a", task: "Review risks", reason: "Independent review", stopCondition: "Risks listed" };

test("director accepts an existing speaker and an explicit stop recommendation", () => {
  assert.deepEqual(parseDirectorSuggestion(JSON.stringify(speak), ["a"]), speak);
  const stop = { action: "stop", reason: "Complete", stopCondition: "Goal reached" };
  assert.deepEqual(parseDirectorSuggestion("```json\n" + JSON.stringify(stop) + "\n```", ["a"]), stop);
});

test("director rejects malformed, incomplete and foreign-speaker suggestions", () => {
  const invalid = ["not json", "null", "[]", "1", ...[
    {}, { ...speak, participantId: "foreign" }, { ...speak, task: " " },
    { ...speak, reason: "x".repeat(501) }, { ...speak, stopCondition: "x".repeat(301) },
    { ...speak, task: "x".repeat(501) }, { ...speak, action: "send" }
  ].map(value => JSON.stringify(value))];
  for (const content of invalid) assert.throws(() => parseDirectorSuggestion(content, ["a"]), { code: "DIRECTOR_RESPONSE_INVALID" });
});
