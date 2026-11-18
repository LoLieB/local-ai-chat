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
import { createMemoryRecord } from "../../server/storage/memoryStore.ts";
import { saveChatTranscript } from "../../server/storage/chatStore.ts";

test("context policies, active branches and source reports survive HTTP generation and restart", async (t) => {
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
  const payloads: any[] = [];
  const model = httpServer(async (req, res) => {
    let raw = ""; for await (const chunk of req) raw += chunk;
    const data = JSON.parse(raw); payloads.push(data);
    if (data.stream) {
      res.setHeader("Content-Type", "text/event-stream");
      res.end('data: {"choices":[{"delta":{"content":"Mock reply"}}]}\n\ndata: [DONE]\n\n');
    } else { res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify({ choices: [{ message: { content: "Mock reply" } }] })); }
  });
  await new Promise<void>(resolve => model.listen(0, "127.0.0.1", resolve));
  t.after(() => { model.closeAllConnections(); model.close(); });
  const settings = { baseUrl: `http://127.0.0.1:${(model.address() as any).port}/v1`, modelId: "mock", maxTokens: 128 };
  const auth = await (await request("/api/auth/register", "POST", { username: "context_user", password: "qa-password" })).json();
  const token = auth.sessionToken;
  const users = join(root, "server-data/common-base/users");
  const send = async (id: string, text: string, messageId: string, stream = false) => {
    const response = await request(stream ? "/api/chat/stream" : "/api/chat", "POST", { chatId: id, userMessage: text, userMessageId: messageId, history: [], settings }, token);
    assert.equal(response.status, 200, await response.clone().text()); await response.text();
  };
  assert.equal((await request("/api/memory-policy/chat/one")).status, 401);
  assert.equal((await request("/api/memory-policy/chat/one", "PATCH", { disabled: true }, token)).status, 200);
  await send("one", "Я предпочитаю запретный чай", "first");
  let records = await (await request("/api/memory", "GET", undefined, token)).json();
  assert.equal(records.records.length, 0);
  await request("/api/memory-policy/chat/one", "PATCH", { disabled: false, messageId: "second", excluded: true }, token);
  await send("one", "Я предпочитаю запретный кофе", "second", true);
  records = await (await request("/api/memory", "GET", undefined, token)).json(); assert.equal(records.records.length, 0);
  await send("one", "Я предпочитаю разрешённый какао", "third");
  records = await (await request("/api/memory", "GET", undefined, token)).json();
  assert.ok(records.records.some((r: any) => r.sourceMessageId === "third" && r.chatId === "one"));
  await send("one", "Продолжай", "fourth");
  let state = await (await request("/api/chat-state", "GET", undefined, token)).json();
  let chat = state.chats.find((c: any) => c.id === "one");
  assert.ok(chat.messages.at(-1).contextReport.memory.some((r: any) => r.text.includes("какао")));
  await request("/api/memory-policy/chat/one", "PATCH", { messageId: "third", excluded: true }, token);
  await send("one", "Ещё", "fifth");
  state = await (await request("/api/chat-state", "GET", undefined, token)).json(); chat = state.chats.find((c: any) => c.id === "one");
  assert.ok(!chat.messages.at(-1).contextReport.memory.some((r: any) => r.text.includes("какао")));
  // Server graph, two sibling branches; older snippets from another branch must not return.
  const messages: any[] = [{ id: "early", parentId: null, role: "user", content: "My name is Aurora.", createdAt: "2026-01-01" }];
  for (let i=0;i<42;i++) messages.push({ id: `h${i}`, parentId: messages.at(-1).id, role: i%2 ? "assistant" : "user", content: `Filler ${i}. `.repeat(40), createdAt: "2026-01-01" });
  const parent = messages.at(-1).id;
  messages.push({ id: "branchA", parentId: parent, role: "user", content: "SECRET_BRANCH_A", createdAt: "2026-01-01" });
  messages.push({ id: "branchB", parentId: parent, role: "user", content: "Active branch B", createdAt: "2026-01-01" });
  await saveChatTranscript(auth.userId, { id: "branches", title: "Branches", characterId: null, messages, activeLeafId: "branchB", createdAt: "2026-01-01", updatedAt: "2026-01-01" }, users);
  await createMemoryRecord(auth.userId, { scope: "chat", chatId: "branches", text: "SECRET_BRANCH_A", source: "auto-extract", sourceMessageId: "branchA", createdBy: "system" }, users);
  await createMemoryRecord(auth.userId, { scope: "user", text: "OLD_LEGACY_SUMMARY", source: "legacy-summary-memory", createdBy: "system" }, users);
  await send("branches", "Continue", "branchNext");
  const actual = JSON.stringify(payloads.at(-1).messages);
  assert.ok(!actual.includes("SECRET_BRANCH_A") && !actual.includes("OLD_LEGACY_SUMMARY"));
  assert.ok(actual.includes("Aurora"));
  state = await (await request("/api/chat-state", "GET", undefined, token)).json();
  const report = state.chats.find((c: any) => c.id === "branches").messages.at(-1).contextReport;
  assert.ok(report.summary.some((entry: any) => entry.messageId === "early"));
  assert.ok(report.inputTokens + report.reserveTokens <= report.windowTokens);
  assert.equal((await request("/api/memory-policy/chat/one", "PATCH", { contextTokens: 100 }, token)).status, 400);
  await send("editCase", "Я предпочитаю красный", "editOriginal");
  state = await (await request("/api/chat-state", "GET", undefined, token)).json();
  const editChat = state.chats.find((c: any) => c.id === "editCase");
  const edited = await request("/api/chat/mutate", "POST", { chatId: "editCase", action: "edit", messageId: "editOriginal", content: "Я предпочитаю синий", revision: editChat.revision }, token);
  assert.equal(edited.status, 200, await edited.clone().text());
  await send("editCase", "Continue", "editNext");
  const editedPayload = JSON.stringify(payloads.at(-1).messages);
  assert.ok(!editedPayload.includes("красный"));
  assert.ok(editedPayload.includes("синий"));
  const before = payloads.length;
  const overflow = await request("/api/chat", "POST", { chatId: "overflow", userMessage: "x".repeat(10000), history: [], settings }, token);
  assert.equal(overflow.status, 400); assert.equal(payloads.length, before);
  // Per-speaker group reports and source IDs survive subsequent turns.
  const participants = [{ id: "actorA", name: "Actor A", systemPrompt: "Be concise." }, { id: "actorB", name: "Actor B", systemPrompt: "Be concise." }];
  const config = { title: "Group", participantIds: participants.map(p => p.id), activeSpeakerCharacterId: "actorA", responseMode: "round-robin", maxRepliesPerTurn: 2, configRevision: 0 };
  assert.equal((await request("/api/group-chats/groupTest", "PUT", config, token)).status, 200);
  await createMemoryRecord(auth.userId, { scope: "character", characterId: "actorA", text: "ONLY_ACTOR_A", createdBy: "user" }, users);
  let response = await request("/api/group-chat", "POST", { ...config, groupChatId: "groupTest", participants, messages: [{ id: "gFirst", role: "user", content: "Hello team" }], settings }, token);
  assert.equal(response.status, 200, await response.clone().text()); await response.text();
  state = await (await request("/api/chat-state", "GET", undefined, token)).json();
  let room = state.groupChats.find((g: any) => g.id === "groupTest");
  assert.equal(room.messages[0].id, "gFirst");
  assert.equal(room.messages.length, 3);
  const reportA = room.messages.find((m: any) => m.characterId === "actorA").contextReport;
  const reportB = room.messages.find((m: any) => m.characterId === "actorB").contextReport;
  assert.ok(reportA.memory.some((m: any) => m.text === "ONLY_ACTOR_A"));
  assert.ok(!reportB.memory.some((m: any) => m.text === "ONLY_ACTOR_A"));
  await request("/api/memory-policy/group/groupTest", "PATCH", { disabled: true }, token);
  const oldIds = room.messages.map((m: any) => m.id);
  response = await request("/api/group-chat/stream", "POST", { ...config, groupChatId: "groupTest", participants, messages: [...room.messages, { id: "gNext", role: "user", content: "Я предпочитаю НЕЗАПОМИНАТЬ" }], settings }, token);
  assert.equal(response.status, 200); const eventText = await response.text(); assert.ok(!eventText.includes("event: error"), eventText);
  state = await (await request("/api/chat-state", "GET", undefined, token)).json(); room = state.groupChats.find((g: any) => g.id === "groupTest");
  assert.deepEqual(room.messages.slice(0,3).map((m: any) => m.id), oldIds);
  assert.deepEqual(room.messages[1].contextReport, reportA);
  records = await (await request("/api/memory", "GET", undefined, token)).json();
  assert.ok(!records.records.some((r: any) => r.text.includes("НЕЗАПОМИНАТЬ")));
  const exited = new Promise<void>(resolve => child.once("exit", () => resolve())); child.kill(); await exited; child = await start();
  const policy = await (await request("/api/memory-policy/chat/one", "GET", undefined, token)).json();
  assert.ok(policy.excludedMessageIds.includes("third"));
  state = await (await request("/api/chat-state", "GET", undefined, token)).json();
  assert.deepEqual(state.chats.find((c: any) => c.id === "branches").messages.at(-1).contextReport, report);
});
