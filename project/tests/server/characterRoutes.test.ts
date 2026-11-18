import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { createServer as httpServer } from "node:http";
import { readFile, readdir } from "node:fs/promises";
import { buildCharacterPrompt, exportCharacterCard, importCharacterCard } from "../../shared/characterCard.ts";


test("character card preview is isolated and greeting persists on start and restart", async (t) => {
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
  let modelRequest: any;
  const model = httpServer(async (req, res) => {
    let raw = ""; for await (const chunk of req) raw += chunk;
    modelRequest = JSON.parse(raw); res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify({ choices: [{ message: { content: "Character preview answer" } }] }));
  });
  await new Promise<void>(resolve => model.listen(0,"127.0.0.1",resolve));
  t.after(() => { model.closeAllConnections(); model.close(); });
  const settings = { baseUrl: `http://127.0.0.1:${(model.address() as any).port}/v1`, modelId: "mock" };
  const card = { id: "card-a", name: "Old character", description: "Original", systemPrompt: "  Original prompt\n", avatar: "A", temperature: 0.7, maxTokens: 100, tags: ["tag"], createdAt: "2026-01-01", updatedAt: "2026-01-01" };
  assert.equal(buildCharacterPrompt(card), card.systemPrompt);
  assert.deepEqual(importCharacterCard(exportCharacterCard(card)), card);
  const extended = { ...card, personality: "Careful", speechStyle: "Concise", scenario: "Workshop", examples: "User: hello\nAssistant: hi", rules: "Do not guess", firstMessage: "Welcome to the workshop!" };
  assert.deepEqual(importCharacterCard(exportCharacterCard(extended)), extended);
  assert.throws(() => importCharacterCard({ format: "local-ai-chat-character", version: 99, character: card }));
  assert.throws(() => importCharacterCard({ ...card, rules: {} }));
  assert.equal((await request("/api/characters/test", "POST", { card: extended, userMessage: "Hello", settings })).status, 401);
  const auth = await (await request("/api/auth/register", "POST", { username: "character_tester", password: "qa-password" })).json();
  const token = auth.sessionToken;
  const state = await (await request("/api/user-state", "GET", undefined, token)).json();
  assert.equal((await request("/api/user-state", "POST", { ...state, characters: [extended] }, token)).status, 200);
  const userDir = join(root, "server-data/common-base/users", auth.userId);
  async function snapshot(dir: string): Promise<Record<string,string>> {
    const result: Record<string,string> = {};
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) Object.assign(result, await snapshot(path));
      else result[path] = await readFile(path, "utf8");
    }
    return result;
  }
  const before = await snapshot(userDir);
  const preview = await request("/api/characters/test", "POST", { card: extended, userMessage: "Hello", settings }, token);
  assert.equal(preview.status, 200); assert.equal((await preview.json()).content, "Character preview answer");
  assert.deepEqual(await snapshot(userDir), before, "Preview must not touch ANY account file");
  assert.equal(modelRequest.messages[0].content, buildCharacterPrompt(extended).trim());
  assert.ok(modelRequest.messages.some((message: any) => message.role === "assistant" && message.content === extended.firstMessage));
  assert.equal((await request("/api/characters/test", "POST", { card: { ...card, maxTokens: -1 }, userMessage: "Hello", settings }, token)).status, 400);
  const startChat = await request("/api/characters/start-chat", "POST", { card: extended, title: "New chat" }, token);
  assert.equal(startChat.status, 201);
  const chat = (await startChat.json()).chat;
  assert.equal(chat.messages[0].content, extended.firstMessage);
  assert.equal(chat.characterId, extended.id);
  assert.equal(chat.title, "New chat");
  const exited = new Promise<void>(resolve => child.once("exit",()=>resolve())); child.kill(); await exited; child = await start();
  const restored = await (await request("/api/chat-state", "GET", undefined, token)).json();
  assert.equal(restored.chats[0].messages[0].content, extended.firstMessage);
  const workspace = await (await request("/api/user-state", "GET", undefined, token)).json();
  assert.deepEqual(workspace.characters[0], extended);
});
