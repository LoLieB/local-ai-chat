import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { createSessionForUser } from "../../server/storage/authStore.ts";
import { readStoredGroupChat, saveGroupChatTranscript } from "../../server/storage/chatStore.ts";

test("HTTP persistence rejects stale writes, protects settings and survives restart", async (t) => {
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
  assert.equal((await request("/api/settings", "POST", { temperature: 0.5 })).status, 401);
  assert.equal((await request("/api/models")).status, 401);
  const registered = await request("/api/auth/register", "POST", { username: "qa_http_user", password: "qa-http-only-password" });
  assert.equal(registered.status, 201);
  const { sessionToken: token, userId } = await registered.json();
  assert.equal((await request("/api/settings", "POST", { temperature: 0.5 }, token)).status, 403);
  const admin = await createSessionForUser("u_admin", "admin", join(root, "server-data/common-base"));
  assert.equal((await request("/api/settings", "POST", { streaming: "wrong" }, admin.sessionToken)).status, 400);
  assert.equal((await request("/api/settings", "POST", { temperature: 0.5 }, admin.sessionToken)).status, 200);
  const profile = { id: "qa-profile", name: "QA", baseUrl: "http://localhost:1234/v1", modelId: "qa-model", temperature: 0.3, maxTokens: 128, streaming: false };
  assert.equal((await request("/api/settings", "POST", { modelProfiles: [profile] }, token)).status, 403);
  assert.equal((await request("/api/settings", "POST", { modelProfiles: [profile] }, admin.sessionToken)).status, 200);
  assert.equal((await request("/api/settings", "POST", { modelProfiles: [{ ...profile, top_k: 3 }] }, admin.sessionToken)).status, 400);
  const state = await (await request("/api/user-state", "GET", undefined, token)).json();
  const summary = { id: "qa-empty-chat", kind: "chat", title: "Empty", updatedAt: new Date().toISOString(), messageCount: 0 };
  const first = await request("/api/user-state", "POST", { ...state, chatSummaries: [summary] }, token);
  assert.equal(first.status, 200);
  assert.equal((await request("/api/user-state", "POST", { ...state, chatSummaries: [] }, token)).status, 409);
  assert.equal((await request("/api/user-state", "POST", { ...state, revision: undefined }, token)).status, 400);
  const picked = await request("/api/chat/mutate", "POST", { chatId: "qa-empty-chat", action: "set-profile", modelProfileId: profile.id, revision: 0 }, token);
  assert.equal(picked.status, 200);
  const pickedChat = (await picked.json()).chat;
  assert.equal(pickedChat.title, "Empty");
  assert.equal(pickedChat.modelProfileId, profile.id);
  assert.equal(pickedChat.messages.length, 0);
  assert.equal((await request("/api/chat/mutate", "POST", { chatId: "qa-empty-chat", action: "set-profile", modelProfileId: null, revision: 0 }, token)).status, 409);
  const organized = await request("/api/chat/mutate", "POST", { chatId: "qa-empty-chat", action: "organize", archived: true, tags: [" Work ", "Work"], revision: pickedChat.revision }, token);
  assert.equal(organized.status, 200);
  const archived = (await organized.json()).chat;
  assert.ok(archived.archivedAt);
  assert.deepEqual(archived.tags, ["Work"]);
  assert.equal(archived.updatedAt, pickedChat.updatedAt);
  assert.equal(archived.modelProfileId, profile.id);
  assert.equal((await request("/api/chat/mutate", "POST", { chatId: "qa-empty-chat", action: "organize", archived: false, revision: pickedChat.revision }, token)).status, 409);
  assert.equal((await request("/api/chat/mutate", "POST", { chatId: "qa-empty-chat", action: "organize", tags: ["bad,tag"], revision: archived.revision }, token)).status, 400);
  const restoredChat = await request("/api/chat/mutate", "POST", { chatId: "qa-empty-chat", action: "organize", archived: false, revision: archived.revision }, token);
  assert.equal(restoredChat.status, 200);
  const unarchived = (await restoredChat.json()).chat;
  assert.equal(unarchived.archivedAt, null);
  assert.deepEqual(unarchived.tags, ["Work"]);
  for (const endpoint of ["/api/group-chat", "/api/group-chat/stream"]) {
    const body = { participants: [{ id: "a", name: "Anna" }], messages: [{ role: "user", content: "Hello" }], responseMode: "single-speaker", maxRepliesPerTurn: 1 };
    assert.equal((await request(endpoint, "POST", { ...body, skippedParticipantIds: ["unknown"] }, token)).status, 400);
    assert.equal((await request(endpoint, "POST", { ...body, skippedParticipantIds: ["a"] }, token)).status, 400);
  }
  const group = { roomRules: "QA room rules", participantRoles: {}, title: "QA group", participantIds: [], activeSpeakerCharacterId: null, responseMode: "single-speaker", maxRepliesPerTurn: 1, configRevision: 0 };
  assert.equal((await request("/api/group-chats/qa-room", "PUT", group, token)).status, 200);
  assert.equal((await request("/api/group-chats/qa-room", "PUT", group, token)).status, 409);
  const users = join(root, "server-data/common-base/users");
  const storedGroup = await readStoredGroupChat(userId, "qa-room", users);
  assert.ok(storedGroup);
  assert.equal(storedGroup.roomRules, "QA room rules");
  assert.equal((await request("/api/group-chats/qa-room", "PUT", { ...group, configRevision: 1, participantRoles: { outsider: "role" } }, token)).status, 400);
  await saveGroupChatTranscript(userId, { ...storedGroup, messages: [{ id: "fresh", role: "user", content: "New server history", createdAt: "1" }] }, users);
  assert.equal((await request("/api/group-chat", "POST", { groupChatId: "qa-room", messages: [], participants: [] }, token)).status, 409);
  assert.equal((await request("/api/group-chat/stream", "POST", { groupChatId: "qa-room", messages: [], participants: [] }, token)).status, 409);
  assert.equal((await request("/api/group-chats/qa-room", "DELETE", undefined, token)).status, 200);
  assert.equal((await request("/api/group-chats/qa-room", "PUT", group, token)).status, 409);
  assert.equal((await request("/api/chats/qa-empty-chat", "DELETE", undefined, token)).status, 200);
  assert.equal((await request("/api/chat/mutate", "POST", { chatId: "qa-empty-chat", action: "set-profile", modelProfileId: profile.id, revision: 0 }, token)).status, 409);
  const after = await (await request("/api/user-state", "GET", undefined, token)).json();
  assert.equal(after.chatSummaries.length, 0);
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  child.kill(); await exited;
  child = await start();
  assert.deepEqual((await (await request("/api/settings")).json()).modelProfiles, [profile]);
  assert.equal((await request("/api/group-chats/qa-room", "PUT", group, token)).status, 409);
  const restored = await (await request("/api/user-state", "GET", undefined, token)).json();
  assert.equal(restored.revision, after.revision);
  assert.equal(restored.chatSummaries.length, 0);
});
