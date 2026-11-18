import test from "node:test";
import assert from "node:assert/strict";
import { roomDiscussionPrompt, validRoomDiscussion } from "../../shared/roomDiscussion.ts";

test("room instructions validate lengths and reject foreign or malformed roles", () => {
  assert.equal(validRoomDiscussion({}, ["a"]), true);
  assert.equal(validRoomDiscussion({ roomRules: "x".repeat(4000), participantRoles: { a: "x".repeat(500) } }, ["a"]), true);
  assert.equal(validRoomDiscussion({ roomRules: "x".repeat(4001) }, ["a"]), false);
  assert.equal(validRoomDiscussion({ participantRoles: { a: "x".repeat(501) } }, ["a"]), false);
  assert.equal(validRoomDiscussion({ participantRoles: { unknown: "role" } }, ["a"]), false);
  assert.equal(validRoomDiscussion({ participantRoles: [] as unknown as Record<string, string> }, ["a"]), false);
});

test("participants receive common rules and only their own role", () => {
  const room = { roomRules: " Be brief ", participantRoles: { a: "Invent ideas", b: "Review risks" } };
  const prompt = roomDiscussionPrompt(room, "a");
  assert.ok(prompt.includes("Be brief") && prompt.includes("Invent ideas"));
  assert.ok(!prompt.includes("Review risks"));
  assert.equal(roomDiscussionPrompt(null, "a"), "");
  assert.equal(roomDiscussionPrompt({ roomRules: "  " }, "a"), "");
});

test("scene time limits reject fractions, negative and oversized values", () => {
  for (const sceneTimeLimitSeconds of [0, 1, 3600]) assert.equal(validRoomDiscussion({ sceneTimeLimitSeconds }, []), true);
  for (const sceneTimeLimitSeconds of [-1, 1.5, 3601, NaN]) assert.equal(validRoomDiscussion({ sceneTimeLimitSeconds }, []), false);
  assert.equal(validRoomDiscussion({ sceneDeadlineAt: NaN }, []), false);
});
