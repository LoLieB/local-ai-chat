import test from "node:test";
import assert from "node:assert/strict";

import {
  CHAT_GENERATION_TIMEOUT_MS,
  DEFAULT_API_TIMEOUT_MS,
  classifyChatRequestError,
  formatChatRequestError,
  shouldPreservePartialResponse
} from "../../shared/chatRequestPolicy.ts";

test("chat generation timeout is long enough for local model cold starts", () => {
  assert.equal(DEFAULT_API_TIMEOUT_MS, 10_000);
  assert.equal(CHAT_GENERATION_TIMEOUT_MS, 10 * 60 * 1000);
});

test("chat request errors classify timeout and stream aborts", () => {
  assert.equal(classifyChatRequestError(new Error("Request timed out.")), "timeout");
  assert.equal(classifyChatRequestError(new Error("BodyStreamBuffer was aborted")), "stream-abort");
  assert.equal(classifyChatRequestError(new Error("HTTP 502")), "technical");
});

test("chat request errors are formatted for users", () => {
  assert.equal(
    formatChatRequestError(new Error("Request timed out."), "generic"),
    "Локальная модель не успела ответить. Первый запуск может занять больше времени. Попробуйте повторить запрос."
  );
  assert.equal(
    formatChatRequestError(new Error("BodyStreamBuffer was aborted"), "generic"),
    "Ответ был прерван из-за обрыва потока. Часть текста могла сохраниться."
  );
  assert.equal(
    formatChatRequestError(new Error("HTTP 500"), "generic"),
    "Не удалось получить ответ модели."
  );
});

test("custom fallbacks are preserved for non-chat surfaces", () => {
  assert.equal(
    formatChatRequestError(new Error("Request timed out."), "Не удалось подключиться"),
    "Не удалось подключиться"
  );
});

test("partial response is preserved only when streamed text exists", () => {
  assert.equal(shouldPreservePartialResponse("уже есть текст", new Error("BodyStreamBuffer was aborted")), true);
  assert.equal(shouldPreservePartialResponse("", new Error("BodyStreamBuffer was aborted")), false);
});
