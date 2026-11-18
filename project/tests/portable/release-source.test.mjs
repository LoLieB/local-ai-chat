import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { exportSource } from "../../scripts/release-source.mjs";

test("release contains only explicit sources and refuses overwriting a destination", async () => {
  const target = join(await mkdtemp(join(tmpdir(), "chat-release-")), "source");
  const files = await exportSource(target);
  assert.ok(files.includes("server/index.ts"));
  assert.ok(files.includes("src/App.tsx"));
  assert.ok(files.includes("package-lock.json"));
  assert.ok(files.includes(".env.example"));
  assert.ok(files.every(file => !/(server-data|node_modules|runtime|artifacts|HANDOFF|^\.env$)/.test(file)));
  assert.equal((await readFile(join(target, "SHA256SUMS.txt"), "utf8")).trim().split("\n").length, files.length);
  assert.equal(files.filter(f=>f.startsWith("public/studio/")&&f.endsWith(".webp")).length,42);
  assert.ok(files.filter(f=>f.endsWith(".png")).every(f=>/^public\/studio\/icon-(32|180|192|512)\.png$/.test(f)));
  await assert.rejects(exportSource(target), { code: "EEXIST" });
});
