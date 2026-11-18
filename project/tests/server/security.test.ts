import test from "node:test";
import assert from "node:assert/strict";

import { isValidServerToken, resolveServerToken } from "../../server/security.ts";

test("resolveServerToken trims configured token", () => {
  assert.equal(resolveServerToken({ SERVER_TOKEN: "  secret-token  " } as NodeJS.ProcessEnv), "secret-token");
  assert.equal(resolveServerToken({} as NodeJS.ProcessEnv), "");
});

test("isValidServerToken allows requests when token is disabled", () => {
  assert.equal(isValidServerToken("", undefined), true);
  assert.equal(isValidServerToken("", "anything"), true);
});

test("isValidServerToken requires exact match when enabled", () => {
  assert.equal(isValidServerToken("secret-token", "secret-token"), true);
  assert.equal(isValidServerToken("secret-token", "wrong-token"), false);
  assert.equal(isValidServerToken("secret-token", undefined), false);
});
