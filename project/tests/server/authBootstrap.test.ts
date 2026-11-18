import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import { createServer as createHttpServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import { setTimeout as delay } from "node:timers/promises";

test("HTTP bootstrap, restart and existing authorization preserve access without logging secrets", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "local-ai-chat-bootstrap-http-"));
  const project = fileURLToPath(new URL("../../", import.meta.url));
  const probe = createServer();
  await new Promise<void>(resolve => probe.listen(0, "127.0.0.1", resolve));
  const port = (probe.address() as { port: number }).port;
  await new Promise<void>(resolve => probe.close(() => resolve()));
  const base = `http://127.0.0.1:${port}`;
  let responseMode = "normal";
  const model = createHttpServer((req, res) => {
    req.resume();
    if (responseMode === "stream-empty") {
      res.setHeader("Content-Type", "text/event-stream");
      res.end('data: {"choices":[{"delta":{"reasoning_content":"internal only"}}]}\n\ndata: [DONE]\n\n');
      return;
    }
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(req.url === "/v1/models" ? { data: [{ id: "release-test-model" }] }
      : { choices: [{ message: { content: responseMode === "empty" ? " " : "Synthetic provider reply" } }] }));
  });
  await new Promise<void>(resolve => model.listen(0, "127.0.0.1", resolve));
  const modelPort = (model.address() as { port: number }).port;
  t.after(() => { model.closeAllConnections(); model.close(); });
  let child: ChildProcess | undefined;
  let logs = "";
  const stop = async () => {
    if (child && child.exitCode === null && child.signalCode === null) {
      const closed = once(child, "close"); child.kill(); await closed;
    }
  };
  t.after(stop);
  const start = async (password = "") => {
    await writeFile(join(root, ".env"), `INITIAL_ADMIN_PASSWORD=${password}\n`);
    const env = { ...process.env, HOST: "127.0.0.1", PORT: String(port), SERVER_TOKEN: "" };
    delete env.INITIAL_ADMIN_PASSWORD;
    child = spawn(process.execPath, ["--import", pathToFileURL(join(project, "node_modules/tsx/dist/loader.mjs")).href, join(project, "server/index.ts")], {
      cwd: root, env,
      stdio: ["ignore", "pipe", "pipe"], windowsHide: true
    });
    child.stdout!.on("data", data => { logs += data.toString(); });
    child.stderr!.on("data", data => { logs += data.toString(); });
    for (let i = 0; i < 100; i++) {
      if (child.exitCode !== null) throw new Error("Test server exited before readiness");
      try { if ((await fetch(base + "/api/health")).ok) return; } catch {}
      await delay(50);
    }
    throw new Error("Test server did not become ready");
  };
  const request = (path: string, body?: unknown, token?: string) => fetch(base + path, {
    method: body === undefined ? "GET" : "POST",
    headers: { "Content-Type": "application/json", ...(token ? { "X-Session-Token": token } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const password = randomBytes(24).toString("hex");
  const replacement = randomBytes(24).toString("hex");
  const weak = randomBytes(4).toString("hex");
  await start();
  assert.equal((await request("/api/auth/register", { username: "Admin", password })).status, 400);
  assert.equal((await request("/api/auth/login", { username: "admin", password })).status, 401);
  const registered = await request("/api/auth/register", { username: "existing", password });
  assert.equal(registered.status, 201);
  const user = await registered.json();
  assert.equal(user.showStudioWelcome, true);
  const initialState = await (await request("/api/user-state", undefined, user.sessionToken)).json();
  assert.equal((await request("/api/user-state", { ...initialState, userProfile: { ...initialState.userProfile, label: "Preserved profile" } }, user.sessionToken)).status, 200);
  const before = await (await request("/api/user-state", undefined, user.sessionToken)).json();
  await stop();
  await assert.rejects(start(weak), /exited before readiness/);
  await stop(); await start(password);
  const login = await request("/api/auth/login", { username: "admin", password });
  assert.equal(login.status, 200);
  const admin = await login.json();
  assert.equal(admin.showStudioWelcome, true);
  assert.equal((await (await request("/api/auth/login", { username: "admin", password })).json()).showStudioWelcome, false);
  assert.equal((await request("/api/settings", { temperature: 0.5 }, admin.sessionToken)).status, 200);
  assert.equal((await request("/api/settings", { temperature: 0.5 }, user.sessionToken)).status, 403);
  assert.equal((await request("/api/settings", { baseUrl: `http://127.0.0.1:${modelPort}/v1`, modelId: "release-test-model", streaming: false }, admin.sessionToken)).status, 200);
  assert.equal((await request("/api/models", undefined, user.sessionToken)).status, 200);
  const reply = await request("/api/chat", { chatId: "release-smoke", history: [], userMessage: "Synthetic test message", revision: 0 }, user.sessionToken);
  assert.equal(reply.status, 200);
  assert.equal((await reply.json()).content, "Synthetic provider reply");
  const chatsBefore = await (await request("/api/chat-state", undefined, user.sessionToken)).json();
  const stateAfterChat = await (await request("/api/user-state", undefined, user.sessionToken)).json();
  assert.ok(JSON.stringify(chatsBefore).includes("Synthetic provider reply"));
  await stop(); await start(replacement);
  assert.equal((await request("/api/auth/login", { username: "admin", password })).status, 200);
  assert.equal((await request("/api/auth/login", { username: "admin", password: replacement })).status, 401);
  assert.equal((await request("/api/auth/login", { username: "existing", password })).status, 200);
  assert.equal((await request("/api/auth/session", undefined, admin.sessionToken)).status, 200);
  const after = await (await request("/api/user-state", undefined, user.sessionToken)).json();
  assert.deepEqual(after.userProfile, before.userProfile);
  assert.deepEqual(after, stateAfterChat);
  assert.deepEqual(await (await request("/api/chat-state", undefined, user.sessionToken)).json(), chatsBefore);
  await stop(); await start();
  assert.equal((await request("/api/auth/login", { username: "admin", password })).status, 200);
  responseMode = "empty";
  const empty = await request("/api/chat", { chatId: "empty-test", history: [], userMessage: "Test", revision: 0 }, user.sessionToken);
  assert.equal(empty.status, 502);
  assert.match(await empty.text(), /в LM Studio включены рассуждения, уменьшите их лимит токенов/);
  responseMode = "stream-empty";
  const emptyStream = await request("/api/chat/stream", { chatId: "empty-stream-test", history: [], userMessage: "Test", revision: 0 }, user.sessionToken);
  const events = await emptyStream.text();
  assert.match(events, /event: error/);
  assert.match(events, /в LM Studio включены рассуждения, уменьшите их лимит токенов/);
  assert.doesNotMatch(events, /event: done/);
  await stop();
  for (const secret of [password, replacement, weak, user.sessionToken, admin.sessionToken]) assert.equal(logs.includes(secret), false);
});
