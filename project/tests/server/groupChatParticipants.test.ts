import test from "node:test";
import assert from "node:assert/strict";

import { getRoomParticipants } from "../../src/groupChatParticipants.ts";
import type { CharacterCard, GroupChat } from "../../src/types/domain.ts";

const characters: CharacterCard[] = [
  {
    id: "a",
    name: "A",
    description: "",
    systemPrompt: "A prompt",
    avatar: "A",
    temperature: 0.7,
    maxTokens: 1024,
    tags: [],
    createdAt: "2026-06-18T00:00:00.000Z",
    updatedAt: "2026-06-18T00:00:00.000Z"
  },
  {
    id: "b",
    name: "B",
    description: "",
    systemPrompt: "B prompt",
    avatar: "B",
    temperature: 0.7,
    maxTokens: 1024,
    tags: [],
    createdAt: "2026-06-18T00:00:00.000Z",
    updatedAt: "2026-06-18T00:00:00.000Z"
  }
];

const room = (participantIds: string[]): Pick<GroupChat, "participantIds"> => ({ participantIds });

test("resolved room participants ignore missing character ids", () => {
  assert.deepEqual(
    getRoomParticipants(room(["a", "deleted"]), characters).map((character) => character.id),
    ["a"]
  );
});

test("resolved room participants remove duplicate ids while preserving order", () => {
  assert.deepEqual(
    getRoomParticipants(room(["a", "a", "b", "a"]), characters).map((character) => character.id),
    ["a", "b"]
  );
});

test("resolved room participants keep all valid unique characters", () => {
  assert.deepEqual(
    getRoomParticipants(room(["a", "b"]), characters).map((character) => character.id),
    ["a", "b"]
  );
});
