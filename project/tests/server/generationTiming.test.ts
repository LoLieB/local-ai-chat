import { setLocale } from "../../src/i18n/index.ts";
import test from "node:test";
import assert from "node:assert/strict";
import { generationTiming } from "../../src/generationTiming.ts";

test("request timing reports measured latency and omits unknown token rates", t => {
  setLocale("ru-RU");
  let now = 0;
  t.mock.method(performance, "now", () => now);
  const measured = generationTiming();
  now = 1000; measured.text("first");
  now = 2000; measured.text("later"); measured.tokens(100);
  assert.match(measured.finish(true), /2,0 с; первый текст через 1,0 с; средняя скорость запроса 50,0 ток\/с/);
  assert.doesNotMatch(measured.finish(false), /первый текст/);
  const unknown = generationTiming();
  unknown.tokens(100, "a"); unknown.tokens(undefined, "b");
  now = 3000;
  assert.doesNotMatch(unknown.finish(true), /ток\/с/);
});
