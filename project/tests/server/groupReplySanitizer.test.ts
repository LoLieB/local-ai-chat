import test from "node:test";
import assert from "node:assert/strict";

import { sanitizeGroupReplyContent } from "../../server/lmStudio.ts";

const participants = ["Алина", "Мария", "Света"];

test("removes current speaker prefix from group reply", () => {
  assert.equal(
    sanitizeGroupReplyContent("Алина: Привет. Я на связи.", "Алина", participants),
    "Привет. Я на связи."
  );
});

test("cuts reply when another participant label appears", () => {
  assert.equal(
    sanitizeGroupReplyContent(
      "Сначала отвечу по делу.\n\nМария: А теперь я продолжу сцену.",
      "Алина",
      participants
    ),
    "Сначала отвечу по делу."
  );
});

test("keeps normal prose mentions of other participants", () => {
  assert.equal(
    sanitizeGroupReplyContent(
      "Я согласна с Марией: её идея звучит разумно.",
      "Алина",
      participants
    ),
    "Я согласна с Марией: её идея звучит разумно."
  );
});

test("removes corrupted duplicate speaker prefix at the start", () => {
  assert.equal(
    sanitizeGroupReplyContent("АлинаАлина: Привет, я здесь.", "Алина", participants),
    "Привет, я здесь."
  );
});

test("collapses repeated paragraphs without touching unique text", () => {
  assert.equal(
    sanitizeGroupReplyContent(
      "Первый абзац.\n\nПервый абзац.\n\nВторой абзац.",
      "Алина",
      participants
    ),
    "Первый абзац.\n\nВторой абзац."
  );
});
