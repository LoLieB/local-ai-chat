import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { createHash } from "node:crypto";

test("HTTP backup authenticates, restores a new account and survives restart", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "local-ai-chat-http-"));
  const project = resolve(fileURLToPath(new URL("../..", import.meta.url)));
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const port = (probe.address() as { port: number }).port;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  const base = `http://127.0.0.1:${port}`;
  const start = async () => {
    const child = spawn(process.execPath, ["--import", pathToFileURL(join(project, "node_modules/tsx/dist/loader.mjs")).href, join(project, "server/index.ts")], {
      cwd: root, env: { ...process.env, HOST: "127.0.0.1", PORT: String(port), SERVER_TOKEN: "" }, stdio: "ignore", windowsHide: true
    });
    t.after(() => { child.kill(); });
    for (let i = 0; i < 100; i++) {
      if (child.exitCode !== null) throw new Error("Isolated server exited before readiness");
      try { if ((await fetch(`${base}/api/health`)).ok) return child; } catch {}
      await delay(50);
    }
    throw new Error("Isolated server did not start");
  };
  let child = await start();
  const request = (path: string, method = "GET", body?: unknown, token?: string) => fetch(base + path, {
    method, headers: { "Content-Type": "application/json", ...(token ? { "X-Session-Token": token } : {}) }, body: body === undefined ? undefined : JSON.stringify(body)
  });
  for (const [path, method] of [["/api/backup", "GET"], ["/api/backup/inspect", "POST"], ["/api/backup/restore", "POST"]]) {
    assert.equal((await request(path, method, method === "POST" ? {} : undefined)).status, 401);
  }
  const registered = await (await request("/api/auth/register", "POST", { username: "backup_source", password: "qa-password" })).json();
  const token = registered.sessionToken;
  const state = await (await request("/api/user-state", "GET", undefined, token)).json();
  assert.equal((await request("/api/user-state", "POST", { ...state, chatSummaries: [{ id: "empty", kind: "chat", title: "Empty preserved", updatedAt: new Date().toISOString(), messageCount: 0 }] }, token)).status, 200);
  const exported = await request("/api/backup", "GET", undefined, token);
  assert.equal(exported.status, 200);
  const backup = await exported.json();
  assert.ok(!backup.files.some((f: { path: string }) => /credentials|sessions|settings/.test(f.path)));
  // A valid archive over the ordinary 1 MiB API body limit must be accepted.
  const content = "large memory\n".repeat(100000);
  backup.files = backup.files.filter((f: { path: string }) => f.path !== "memory/global.md");
  backup.files.push({ path: "memory/global.md", content, sha256: createHash("sha256").update(content).digest("hex") });
  assert.equal((await request("/api/backup/inspect", "POST", { backup }, token)).status, 200);
  const invalid = structuredClone(backup); invalid.files[0].sha256 = "0".repeat(64);
  assert.equal((await request("/api/backup/restore", "POST", { backup: invalid, username: "invalid_backup", password: "qa-password" }, token)).status, 400);
  assert.equal((await request("/api/auth/login", "POST", { username: "invalid_backup", password: "qa-password" })).status, 401);
  assert.equal((await request("/api/backup/restore", "POST", { backup, username: {}, password: "qa-password" }, token)).status, 400);
  const restoredResponse = await request("/api/backup/restore", "POST", { backup, username: "backup_restored", password: "qa-password" }, token);
  assert.equal(restoredResponse.status, 201);
  const restored = await restoredResponse.json();
  assert.ok(restored.sessionToken);
  assert.notEqual(restored.userId, registered.userId);
  assert.equal((await request("/api/backup/restore", "POST", { backup, username: "backup_restored", password: "qa-password" }, token)).status, 409);
  const copy = await (await request("/api/user-state", "GET", undefined, restored.sessionToken)).json();
  assert.equal(copy.userProfile.id, restored.userId);
  assert.equal(copy.chatSummaries[0].title, "Empty preserved");
  const roundtrip = await (await request("/api/backup", "GET", undefined, restored.sessionToken)).json();
  assert.equal(roundtrip.files.find((f: { path: string }) => f.path === "memory/global.md").content, content);
  const source = await (await request("/api/backup", "GET", undefined, token)).json();
  assert.notEqual(source.files.find((f: { path: string }) => f.path === "memory/global.md").content, content);
  const malformed = await fetch(base + "/api/backup/inspect", { method: "POST", headers: { "Content-Type": "application/json", "X-Session-Token": token }, body: "{" });
  assert.equal(malformed.status, 400);
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  child.kill(); await exited;
  child = await start();
  const login = await request("/api/auth/login", "POST", { username: "backup_restored", password: "qa-password" });
  assert.equal(login.status, 200);
  const persisted = await (await request("/api/user-state", "GET", undefined, (await login.json()).sessionToken)).json();
  assert.deepEqual(persisted.chatSummaries, copy.chatSummaries);
});
