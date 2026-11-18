import test from "node:test";
import assert from "node:assert/strict";
import { resolveProfile } from "../../shared/modelProfile.ts";
import { exportCharacterCard, importCharacterCard } from "../../shared/characterCard.ts";

test("profile precedence preserves legacy parameters and refuses dangling profile IDs", () => {
  const defaults = { baseUrl: "http://localhost:1234/v1", modelId: "default", streaming: true, temperature: 0.7, maxTokens: 100 };
  const character = { temperature: 0.2, maxTokens: 200, modelProfileId: "character" };
  const settings = { ...defaults, modelProfiles: [{ ...defaults, id: "character", name: "Character", modelId: "character-model", temperature: 0.4 }, { ...defaults, id: "chat", name: "Chat", modelId: "chat-model", temperature: 0.9 }] };
  assert.equal(resolveProfile(settings, character, "chat").modelId, "chat-model");
  assert.equal(resolveProfile(settings, character).temperature, 0.4);
  assert.equal(resolveProfile(defaults, { temperature: 0.2, maxTokens: 200 }).maxTokens, 200);
  assert.equal(resolveProfile(defaults, null).modelId, "default");
  assert.throws(() => resolveProfile(settings, character, "deleted"));
  assert.throws(() => resolveProfile(defaults, character));
  const card = { ...character, id: "c", name: "Card", description: "", systemPrompt: "", avatar: "", tags: [], createdAt: "", updatedAt: "" };
  assert.equal(importCharacterCard(exportCharacterCard(card)).modelProfileId, "character");
});
