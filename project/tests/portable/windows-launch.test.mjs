import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, copyFile, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { createServer } from "node:net";

test("Windows launcher refuses occupied ports and concurrent setup without touching data", { skip: process.platform !== "win32" }, async t => {
  const root = await mkdtemp(join(tmpdir(), "chat launcher тест "));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "scripts"));
  for (const name of ["windows-launch.mjs", "portable-core.mjs"]) await copyFile(new URL(`../../scripts/${name}`, import.meta.url), join(root, "scripts", name));
  await writeFile(join(root, "user-data.txt"), "keep this data");
  const server = createServer();
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  await writeFile(join(root, ".env"), `PORT=${server.address().port}\n`);
  const run = (action, lang) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [join(root, "scripts/windows-launch.mjs"), action, lang], { stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", chunk => output += chunk); child.stderr.on("data", chunk => output += chunk);
    child.on("error", reject); child.on("exit", code => resolve({ code, output }));
  });
  const occupied = await run("start", "en");
  assert.equal(occupied.code, 1); assert.match(occupied.output, /occupied/);
  await writeFile(join(root, ".windows-launch.lock"), String(process.pid));
  const busy = await run("install", "ru");
  assert.equal(busy.code, 1); assert.match(busy.output, /уже выполняется/);
  assert.equal(await readFile(join(root, "user-data.txt"), "utf8"), "keep this data");
  assert.equal(await readFile(join(root, ".windows-launch.lock"), "utf8"), String(process.pid));
});
