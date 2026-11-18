import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createMemoryRecord,
  deleteMemoryRecord,
  exportMemory,
  importMemory,
  listMemoryRecords,
  readMemoryContext,
  updateMemoryRecord,
  upsertConversationSummary
} from "../../server/storage/memoryStore.ts";
import { ensureUserWorkspace } from "../../server/storage/userDataStore.ts";

test("room relationships retain their kind and room through backup import", async () => {
  const root = await mkdtemp(join(tmpdir(), "room-relationship-"));
  await createMemoryRecord("u-source", { scope: "group", groupChatId: "room-a", kind: "relationship", text: "Alice trusts Bob", createdBy: "user" }, root);
  await importMemory("u-target", await exportMemory("u-source", root), root);
  const [record] = await listMemoryRecords("u-target", root);
  assert.equal(record.kind, "relationship");
  assert.equal(record.groupChatId, "room-a");
  assert.match(await readMemoryContext("u-target", { groupChatId: "room-a" }, root), /Alice trusts Bob/);
  assert.equal(await readMemoryContext("u-target", { groupChatId: "room-b" }, root), "");
  await updateMemoryRecord("u-target", record.id, { enabled: false }, root);
  assert.equal(await readMemoryContext("u-target", { groupChatId: "room-a" }, root), "");
});

test("context marks only records that fit its character budget as accessed", async () => {
  const root = await mkdtemp(join(tmpdir(), "memory-budget-"));
  for (let i = 0; i < 9; i++) {
    await createMemoryRecord("u-budget", { scope: "user", text: String(i).repeat(980), createdBy: "user" }, root);
  }
  const context = await readMemoryContext("u-budget", {}, root);
  const records = await listMemoryRecords("u-budget", root);
  assert.ok(records.some(record => record.lastAccessedAt === null));
  for (const record of records) assert.equal(record.lastAccessedAt !== null, context.includes(record.text));
});

test("forgotten and corrected facts do not return from extraction or legacy files", async () => {
  const root = await mkdtemp(join(tmpdir(), "memory-forget-"));
  const user = "u-forget";
  const workspace = await ensureUserWorkspace(user, root);
  await writeFile(join(workspace.memoryDir, "global.md"), "User prefers TypeScript", "utf8");
  const original = (await listMemoryRecords(user, root))[0];
  assert.ok(original);
  await deleteMemoryRecord(user, original.id, root);
  await createMemoryRecord(user, { ...original, createdBy: "system" }, root);
  await createMemoryRecord(user, { ...original, scope: "chat", chatId: "another-chat", createdBy: "system" }, root);
  assert.equal((await listMemoryRecords(user, root)).length, 0);
  assert.equal(await readMemoryContext(user, {}, root), "");
  const raw = await readFile(join(workspace.memoryDir, "exclusions.json"), "utf8");
  assert.ok(!raw.includes("TypeScript"), "suppression stores fingerprints, not forgotten text");
  const explicit = await createMemoryRecord(user, { ...original, createdBy: "user" }, root);
  assert.equal((await listMemoryRecords(user, root)).length, 1);
  await updateMemoryRecord(user, explicit.id, { text: "Пользователь предпочитает Python" }, root);
  await createMemoryRecord(user, { ...original, createdBy: "system" }, root);
  const records = await listMemoryRecords(user, root);
  assert.equal(records.length, 1);
  assert.equal(records[0].text, "Пользователь предпочитает Python");
});

test("structured memory migrates legacy facts without losing them", async () => {
  const rootDir = await mkdtemp(join(tmpdir(), "local-ai-chat-memory-"));
  const workspace = await ensureUserWorkspace("u-memory-migrate", rootDir);
  await writeFile(join(workspace.memoryDir, "facts.jsonl"), `${JSON.stringify({ date: "2026-01-02", fact: "User prefers TypeScript", kind: "preference", confidence: 0.9 })}\n`, "utf8");

  const records = await listMemoryRecords("u-memory-migrate", rootDir);
  assert.equal(records.length, 1);
  assert.equal(records[0]?.scope, "user");
  assert.equal(records[0]?.text, "Пользователь предпочитает: TypeScript");
  assert.match(await readFile(join(workspace.memoryDir, "facts.jsonl"), "utf8"), /"id":"mem_/);
});

test("memory repairs legacy UTF-8 mojibake once and preserves valid Cyrillic", async () => {
  const rootDir = await mkdtemp(join(tmpdir(), "local-ai-chat-memory-"));
  const workspace = await ensureUserWorkspace("u-memory-encoding", rootDir);
  const broken = {
    id: "mem_broken_encoding",
    scope: "user",
    text: "User goal: СѓСЃР»С‹С€Р°С‚СЊ РґРѕР±СЂС‹С… СЃР»РѕРІ РѕС‚ С‚РµР±СЏ",
    kind: "goal",
    source: "auto-extract",
    createdBy: "system",
    createdAt: "2026-01-02T00:00:00.000Z",
    updatedAt: "2026-01-02T00:00:00.000Z",
    lastAccessedAt: null,
    pinned: false,
    enabled: true,
    confidence: 0.8,
    importance: 0.6
  };
  const valid = { ...broken, id: "mem_valid_encoding", text: "Света любит спорить и предлагать смелые идеи." };
  const damagedByOldCleanup = { ...broken, id: "mem_old_cleanup_encoding", text: "Alex replied: Р Р°РґР° С‚РµР±СЏ РІРёРґРµС‚СЊ." };
  const mostlyEnglish = { ...broken, id: "mem_mixed_encoding", text: "Alex remembers this interaction: user said QA setup and Alex replied OK." };
  await writeFile(join(workspace.memoryDir, "facts.jsonl"), `${JSON.stringify(broken)}\n${JSON.stringify(damagedByOldCleanup)}\n${JSON.stringify(mostlyEnglish)}\n${JSON.stringify(valid)}\n`, "utf8");

  const records = await listMemoryRecords("u-memory-encoding", rootDir);
  assert.equal(records.find((record) => record.id === broken.id)?.text, "Цель пользователя: услышать добрых слов от тебя");
  assert.equal(records.find((record) => record.id === damagedByOldCleanup.id)?.text, "Alex: Рада тебя видеть.");
  assert.equal(records.find((record) => record.id === mostlyEnglish.id)?.text, "Alex помнит этот разговор: пользователь сказал «QA setup», ответ: «OK».");
  assert.equal(records.find((record) => record.id === valid.id)?.text, valid.text);
  const persisted = await readFile(join(workspace.memoryDir, "facts.jsonl"), "utf8");
  assert.match(persisted, /услышать добрых слов от тебя/);
  assert.doesNotMatch(persisted, /СѓСЃР»/);
});

test("memory handles 100 user and 100 isolated character facts", async () => {
  const rootDir = await mkdtemp(join(tmpdir(), "local-ai-chat-memory-"));
  for (let index = 0; index < 100; index += 1) {
    await createMemoryRecord("u-memory-stress", { scope: "user", text: `QA user fact ${index}`, kind: "context", source: "test", createdBy: "user" }, rootDir);
    await createMemoryRecord("u-memory-stress", { scope: "character", characterId: "char-a", text: `QA character fact ${index}`, kind: "event", source: "test", createdBy: "character" }, rootDir);
  }
  await createMemoryRecord("u-memory-stress", { scope: "character", characterId: "char-b", text: "Private B fact", kind: "context", source: "test", createdBy: "character", pinned: true }, rootDir);

  const records = await listMemoryRecords("u-memory-stress", rootDir);
  assert.equal(records.filter((record) => record.scope === "user").length, 100);
  assert.equal(records.filter((record) => record.characterId === "char-a").length, 100);
  assert.doesNotMatch(await readMemoryContext("u-memory-stress", { characterId: "char-a" }, rootDir), /Private B fact/);
  assert.match(await readMemoryContext("u-memory-stress", { characterId: "char-b" }, rootDir), /Private B fact/);
});

test("memory deduplicates similar facts within the same scope and target", async () => {
  const rootDir = await mkdtemp(join(tmpdir(), "local-ai-chat-memory-"));
  const first = await createMemoryRecord("u-memory-dedup", { scope: "user", text: "User prefers Python for automation", kind: "preference", source: "test", createdBy: "user" }, rootDir);
  const duplicate = await createMemoryRecord("u-memory-dedup", { scope: "user", text: "User prefers Python for automation.", kind: "preference", source: "test", createdBy: "user", pinned: true }, rootDir);
  assert.equal(first.id, duplicate.id);
  assert.equal((await listMemoryRecords("u-memory-dedup", rootDir)).length, 1);
});

test("memory update, pin, disable and delete persist", async () => {
  const rootDir = await mkdtemp(join(tmpdir(), "local-ai-chat-memory-"));
  const created = await createMemoryRecord("u-memory-crud", { scope: "chat", chatId: "chat-a", text: "Initial decision", kind: "decision", source: "test", createdBy: "user" }, rootDir);
  await updateMemoryRecord("u-memory-crud", created.id, { text: "Updated decision", pinned: true, enabled: false }, rootDir);
  const reloaded = await listMemoryRecords("u-memory-crud", rootDir);
  assert.equal(reloaded[0]?.text, "Updated decision");
  assert.equal(reloaded[0]?.pinned, true);
  assert.equal(reloaded[0]?.enabled, false);
  assert.equal(await deleteMemoryRecord("u-memory-crud", created.id, rootDir), true);
  assert.equal((await listMemoryRecords("u-memory-crud", rootDir)).length, 0);
});

test("context prioritizes pins and respects record and character limits", async () => {
  const rootDir = await mkdtemp(join(tmpdir(), "local-ai-chat-memory-"));
  for (let index = 0; index < 25; index += 1) {
    await createMemoryRecord("u-memory-context", { scope: "user", text: `Context fact ${index} ${"x".repeat(180)}`, kind: "context", source: "test", createdBy: "system", importance: index / 25 }, rootDir);
  }
  await createMemoryRecord("u-memory-context", { scope: "character", characterId: "char-a", text: "Pinned character fact", kind: "preference", source: "test", createdBy: "user", pinned: true }, rootDir);
  const context = await readMemoryContext("u-memory-context", { characterId: "char-a" }, rootDir);
  assert.match(context, /Pinned character fact/);
  assert.ok(context.length <= 6100);
  assert.ok(context.split("\n").length <= 17);
});

test("summaries persist and update for chat and group scopes", async () => {
  const rootDir = await mkdtemp(join(tmpdir(), "local-ai-chat-memory-"));
  const messages = Array.from({ length: 18 }, (_, index) => ({ role: index % 2 ? "assistant" : "user", content: `message ${index}` }));
  await upsertConversationSummary("u-memory-summary", "chat", "chat-a", messages, rootDir);
  await upsertConversationSummary("u-memory-summary", "group", "group-a", [...messages, { role: "user", content: "new decision" }], rootDir);
  await upsertConversationSummary("u-memory-summary", "chat", "chat-a", [...messages, { role: "assistant", content: "updated answer" }], rootDir);
  const summaries = (await listMemoryRecords("u-memory-summary", rootDir)).filter((record) => record.kind === "summary");
  assert.equal(summaries.length, 2);
  assert.match(summaries.find((record) => record.chatId === "chat-a")?.text || "", /updated answer/);
});

test("export and import preserve records, deduplicate, and reject corrupt backups atomically", async () => {
  const rootDir = await mkdtemp(join(tmpdir(), "local-ai-chat-memory-"));
  await createMemoryRecord("u-memory-export", { scope: "user", text: "Portable memory", kind: "context", source: "test", createdBy: "user", pinned: true }, rootDir);
  const backup = await exportMemory("u-memory-export", rootDir);
  await importMemory("u-memory-import", backup, rootDir);
  await importMemory("u-memory-import", backup, rootDir);
  assert.equal((await listMemoryRecords("u-memory-import", rootDir)).length, 1);

  const before = await listMemoryRecords("u-memory-import", rootDir);
  const corrupt = { ...backup, records: [...backup.records, { ...backup.records[0], id: "bad/id" }] };
  await assert.rejects(() => importMemory("u-memory-import", corrupt, rootDir), /invalid records/);
  assert.deepEqual(await listMemoryRecords("u-memory-import", rootDir), before);
});

test("oversized and control-only memory is rejected or sanitized", async () => {
  const rootDir = await mkdtemp(join(tmpdir(), "local-ai-chat-memory-"));
  await assert.rejects(() => createMemoryRecord("u-memory-safety", { scope: "user", text: "x".repeat(1001), kind: "context", source: "test", createdBy: "user" }, rootDir), /invalid or too long/);
  const record = await createMemoryRecord("u-memory-safety", { scope: "user", text: "safe\u0000 text", kind: "context", source: "test", createdBy: "user" }, rootDir);
  assert.equal(record.text, "safe text");
});
