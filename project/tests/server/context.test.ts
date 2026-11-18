import assert from "node:assert/strict";
import test from "node:test";
import { composeContext, estimateTokens } from "../../server/context.js";
import type { MemoryRecord } from "../../shared/memory.js";

const policy = { disabled: false, excludedMessageIds: [] as string[], contextTokens: 2600 };
const base = { systemPrompt: "Helpful assistant.", userMessage: "Continue.", history: [], records: [], policy, reserveTokens: 200 };
const record = (id: string, text: string, extra: Partial<MemoryRecord> = {}): MemoryRecord => ({
  id, text, scope: "chat", kind: "context", source: "manual", createdBy: "user", createdAt: "2026-01-01",
  updatedAt: "2026-01-01", lastAccessedAt: null, pinned: false, enabled: true, confidence: 1, importance: 1, ...extra,
});
const longHistory = () => [
  { id: "early", role: "user", content: "My name is Alice and I am allergic to peanuts." },
  ...Array.from({ length: 40 }, (_, i) => ({ id: `turn-${i}`, role: i % 2 ? "assistant" : "user", content: "Ordinary discussion ".repeat(22) + "." })),
  { id: "decision", role: "assistant", content: "We decided to use SQLite." },
];

test("retains early facts beyond 24 turns with genuine extractive provenance", () => {
  const history = longHistory();
  const result = composeContext({ ...base, history });
  assert(result.report.summary.some(item => item.messageId === "early" && item.text === history[0].content));
  assert(result.systemPrompt.includes("Extractive conversation digest"));
  for (const item of result.report.summary) assert(history.find(message => message.id === item.messageId)?.content.includes(item.text));
  assert(result.history.some(message => message.id === "decision"));
  assert(result.report.inputTokens + result.report.reserveTokens <= policy.contextTokens);
});

test("uses only the active branch history supplied by caller and is pure", () => {
  const input = { ...base, history: [{ id: "active", role: "user", content: "Current branch." }] };
  const before = JSON.stringify(input);
  const result = composeContext(input);
  assert.equal(JSON.stringify(input), before);
  assert.deepEqual(result.history, input.history);
  assert(!JSON.stringify(result).includes("other-branch"));
});

test("budgets long Unicode messages and rejects mandatory overflow", () => {
  const result = composeContext({ ...base, history: [{ id: "huge", role: "user", content: "🙂".repeat(4000) }] });
  assert.equal(result.history.length, 0);
  assert.equal(result.report.summary.length, 0);
  assert.equal(estimateTokens("🙂"), 4);
  assert(result.report.inputTokens + result.report.reserveTokens <= policy.contextTokens);
  assert.throws(() => composeContext({ ...base, userMessage: "x".repeat(3000) }), /too small/);
});

test("exclusions suppress digest and source memory but preserve recent conversation", () => {
  const sourced = { ...record("derived", "Secret fact."), sourceMessageId: "early" };
  const result = composeContext({ ...base, history: longHistory(), records: [sourced], policy: { ...policy, excludedMessageIds: ["early", "decision"] } });
  assert(!result.report.summary.some(item => item.messageId === "early"));
  assert.equal(result.report.memory.length, 0);
  assert(result.history.some(item => item.id === "decision"));
  assert(result.report.excluded.some(item => item.id === "derived" && item.reason === "source-message-excluded"));
});

test("disabled memory disables digest while retaining recent history", () => {
  const result = composeContext({ ...base, history: longHistory(), records: [record("a", "Fact.", { createdBy: "system" }), record("manual", "User supplied fact.")], policy: { ...policy, disabled: true } });
  assert.equal(result.report.summary.length, 0);
  assert.deepEqual(result.report.memory.map(item => item.id), ["manual"]);
  assert(result.history.some(item => item.id === "decision"));
});

test("pinned snapshots win and report only memories actually inserted", () => {
  const result = composeContext({ ...base, records: [record("oversize", "x".repeat(4000)), record("pinned", "Pinned fact.", { pinned: true }), record("legacy", "Legacy summary.", { source: "automatic-summary" })] });
  assert.deepEqual(result.report.memory.map(item => item.id), ["pinned"]);
  assert(result.systemPrompt.includes("Pinned fact."));
  assert(!result.systemPrompt.includes("Legacy summary."));
  assert(result.report.excluded.some(item => item.id === "oversize" && item.reason === "budget"));
});
