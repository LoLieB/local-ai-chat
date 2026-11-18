import test from "node:test";
import assert from "node:assert/strict";
import { planGroupTurn } from "../../shared/groupTurnPlan.ts";

const participants = [{ id: "a", name: "Анна" }, { id: "b", name: "Борис" }, { id: "c", name: "Вера" }];

test("skips keep rotation anchored to the last speaker and fill the reply limit", () => {
  const request = { participants, responseMode: "round-robin", maxRepliesPerTurn: 2, skippedParticipantIds: ["b"], messages: [{ role: "assistant", characterId: "b", content: "Done" }, { role: "user", content: "Continue" }] };
  assert.deepEqual(planGroupTurn(request).map(turn => turn.participant.id), ["c", "a"]);
  assert.deepEqual(planGroupTurn({ ...request, skippedParticipantIds: ["a", "b", "c"] }), []);
  assert.deepEqual(planGroupTurn({ ...request, responseMode: "single-speaker", activeSpeakerCharacterId: "b" }), []);
});

test("skipping addressed speakers never redirects their task to an unaddressed speaker", () => {
  const request = { participants, maxRepliesPerTurn: 1, skippedParticipantIds: ["a"], messages: [{ role: "user", content: "@Анна: первая задача\n@Борис: вторая задача" }] };
  assert.deepEqual(planGroupTurn(request).map(turn => [turn.participant.id, turn.task]), [["b", "вторая задача"]]);
  assert.deepEqual(planGroupTurn({ ...request, skippedParticipantIds: ["a", "b"] }), []);
});

test("group preview continues the round after the last actual reply and respects the limit", () => {
  const request = { participants, responseMode: "round-robin", maxRepliesPerTurn: 2, messages: [{ role: "assistant", characterId: "b", content: "Done" }, { role: "user", content: "Continue" }] };
  assert.deepEqual(planGroupTurn(request).map(turn => turn.participant.id), ["c", "a"]);
  assert.equal(planGroupTurn({ ...request, maxRepliesPerTurn: 100 }).length, 3);
  assert.deepEqual(planGroupTurn({ ...request, participants: [] }), []);
});

test("addressed tasks override the room speaker and preserve explicit order", () => {
  const request = { participants, responseMode: "single-speaker", activeSpeakerCharacterId: "a", maxRepliesPerTurn: 2, messages: [{ role: "user", content: "@Вера: проверь риски\n@Борис: предложи решение" }] };
  assert.deepEqual(planGroupTurn(request).map(turn => [turn.participant.id, turn.task]), [["c", "проверь риски"], ["b", "предложи решение"]]);
  assert.equal(planGroupTurn({ ...request, maxRepliesPerTurn: 1 }).length, 1);
  assert.equal(planGroupTurn({ ...request, messages: [{ role: "user", content: "Обычный текст" }] })[0].participant.id, "a");
});

test("plain name tasks remain compatible and ordinary mentions do not redirect replies", () => {
  const request = { participants, responseMode: "single-speaker", activeSpeakerCharacterId: "a", messages: [{ role: "user", content: "Борис: проверь" }] };
  assert.equal(planGroupTurn(request)[0].participant.id, "b");
  assert.equal(planGroupTurn({ ...request, messages: [{ role: "user", content: "Расскажи о @Борис и его идеях" }] })[0].participant.id, "a");
});

test("resumed scene uses the saved remaining order and retains addressed tasks", () => {
  const plan = planGroupTurn({ participants, remainingParticipantIds: ["b"], maxRepliesPerTurn: 1, messages: [{ role: "user", content: "@Анна: первая задача\n@Борис: вторая задача" }, { role: "assistant", characterId: "a", content: "Ответ" }] });
  assert.deepEqual(plan.map(turn => [turn.participant.id, turn.task]), [["b", "вторая задача"]]);
});
