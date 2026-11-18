import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

test("Git excludes local data while retaining the reproducible source files", () => {
  const ignored = ["server-data/credentials.json", "server-data/users/example/chat.json",
    ".env", ".env.local", ".env.production", "runtime/logs/server.log",
    "runtime/node/node.exe", "node_modules/example/index.js", "dist/index.html",
    "tsconfig.app.tsbuildinfo", "server.log", ".codex/state.json", ".agents/state.json",
    "artifacts/screenshot.png"];
  const source = [".gitignore", ".env.example", "package.json", "package-lock.json",
    "src/App.tsx", "src/assets/background.png", "server/index.ts", "shared/chatImage.ts",
    "scripts/portable-launch.mjs", "start-local-ai-chat.cmd", "README.md",
    "tests/portable/gitignore.test.mjs"];
  const result = spawnSync("git", ["check-ignore", "--no-index", "--stdin"], {
    cwd: fileURLToPath(new URL("../../", import.meta.url)),
    input: [...ignored, ...source].join("\n") + "\n",
    encoding: "utf8"
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.stdout.trim().split(/\r?\n/), ignored);
});
