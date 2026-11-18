import assert from "node:assert/strict";
import test from "node:test";

import {
  isNearScrollEnd,
  normalizeGroupReplyLimit,
  participantSummary,
  shouldShowNewMessages,
  sortPinnedByUpdated
} from "../../shared/stressHelpers.ts";
import { makeLongMessage, makeStressItems } from "../helpers/stressFixtures.ts";

test("participantSummary keeps a compact preview and +N count", () => {
  const result = participantSummary(["A", "B", "C", "D", "E"], 3);
  assert.deepEqual(result, { visible: ["A", "B", "C"], remaining: 2 });
});

test("participantSummary and list helpers handle large collections", () => {
  const items = Array.from({ length: 250 }, (_, index) => index);
  assert.equal(participantSummary(items, 4).remaining, 246);
  assert.equal(items[199], 199);
});

test("stress fixtures cover empty through 250-item collections without network calls", () => {
  for (const count of [0, 1, 20, 100, 250]) {
    assert.equal(makeStressItems(count).length, count);
  }
  assert.equal(makeLongMessage(20_000).length, 20_000);
});

test("normalizeGroupReplyLimit accepts finite integer values only", () => {
  assert.equal(normalizeGroupReplyLimit(2, 3), 2);
  assert.equal(normalizeGroupReplyLimit("3", 3), 3);
  assert.equal(normalizeGroupReplyLimit(1.5, 3), null);
  assert.equal(normalizeGroupReplyLimit(Number.NaN, 3), null);
  assert.equal(normalizeGroupReplyLimit(Number.POSITIVE_INFINITY, 3), null);
  assert.equal(normalizeGroupReplyLimit("1e999", 3), null);
  assert.equal(normalizeGroupReplyLimit(4, 3), null);
  assert.equal(normalizeGroupReplyLimit(1, 0), null);
});

test("sortPinnedByUpdated keeps pinned items first for large lists", () => {
  const items = Array.from({ length: 100 }, (_, index) => ({
    id: index,
    pinnedAt: index === 99 ? "2026-07-14T10:00:00.000Z" : null,
    updatedAt: `2026-07-14T09:${String(index % 60).padStart(2, "0")}:00.000Z`
  }));
  assert.equal(sortPinnedByUpdated(items)[0].id, 99);
  assert.equal(sortPinnedByUpdated(items).length, 100);
});

test("isNearScrollEnd distinguishes follow mode from user scroll-up", () => {
  assert.equal(isNearScrollEnd({ scrollHeight: 1000, scrollTop: 920, clientHeight: 80 }), true);
  assert.equal(isNearScrollEnd({ scrollHeight: 1000, scrollTop: 600, clientHeight: 80 }), false);
});

test("new-message affordance stays available after a stream finishes until the user returns", () => {
  assert.equal(shouldShowNewMessages(false, false, true), true);
  assert.equal(shouldShowNewMessages(true, false, false), true);
  assert.equal(shouldShowNewMessages(true, true, false), false);
});
