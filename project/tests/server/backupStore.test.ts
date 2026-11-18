import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exportUserBackup, inspectUserBackup, restoreUserBackup, BackupValidationError } from "../../server/storage/backupStore.js";
import { registerUser, findCredentialByUsername } from "../../server/storage/authStore.js";
import { createMemoryRecord, deleteMemoryRecord, listMemoryRecords, updateMemoryPolicy, readMemoryPolicy } from "../../server/storage/memoryStore.js";

test("full backup preserves forgotten fact suppression in the restored account", async t => {
  const { root, user } = await fixture(t);
  const users = join(root, "users");
  const input = { scope: "user" as const, text: "Do not remember this repeated fact", createdBy: "system" as const };
  const record = await createMemoryRecord(user.userId, input, users);
  await deleteMemoryRecord(user.userId, record.id, users);
  await updateMemoryPolicy(user.userId, "chat", "c1", { disabled: true, messageId: "m1", excluded: true, contextTokens: 4096 }, users);
  const backup = await exportUserBackup(user.userId, root);
  const restored = await restoreUserBackup(backup, "suppressed_copy", "password", root);
  assert.deepEqual(await readMemoryPolicy(restored.userId, "chat", "c1", users), { disabled: true, excludedMessageIds: ["m1"], contextTokens: 4096 });
  await createMemoryRecord(restored.userId, input, users);
  assert.ok(!(await listMemoryRecords(restored.userId, users)).some(r => r.text === input.text));
  const broken = structuredClone(backup);
  const file = broken.files.find(f => f.path === "memory/exclusions.json")!;
  file.content = JSON.stringify({ hashes: ["invalid"] });
  file.sha256 = createHash("sha256").update(file.content).digest("hex");
  assert.throws(() => inspectUserBackup(broken), BackupValidationError);
});

async function fixture(t: any) {
  const root = await mkdtemp(join(tmpdir(), "backup-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const user = await registerUser("source", "password", root);
  const dir = join(root, "users", user.userId);
  await mkdir(join(dir, "chats"));
  await mkdir(join(dir, "group-chats"));
  const messages = [
    { id: "m1", parentId: null, role: "user", content: "hello", createdAt: "now" },
    { id: "m2", parentId: "m1", role: "assistant", content: "branch one", createdAt: "now" },
    { id: "m3", parentId: "m1", role: "assistant", content: "branch two", createdAt: "now" }
  ];
  await writeFile(join(dir, "chats/chat-c1.json"), JSON.stringify({ id: "c1", schemaVersion: 2, title: "Branches", characterId: null, messages, activeLeafId: "m3", revision: 7, pinnedMessageIds: ["m2"], createdAt: "now", updatedAt: "now" }));
  await writeFile(join(dir, "chats/chat-gone.json.deleted"), JSON.stringify({ deletedAt: "now" }));
  await writeFile(join(dir, "group-chats/group-g1.json"), JSON.stringify({ id: "g1", title: "Group", messages: [], participantIds: ["char_old"], activeSpeakerCharacterId: "char_old", responseMode: "round-robin", maxRepliesPerTurn: 2, revision: 3, configRevision: 4, createdAt: "now", updatedAt: "now" }));
  await writeFile(join(dir, "memory/facts.jsonl"), JSON.stringify({ fact: "legacy fact", date: "2026-09-06" }) + "\n");
  await writeFile(join(dir, "daily-logs/06-09-2026.md"), "legacy log\n");
  return { root, user, dir };
}

test("backup preserves raw graph, revisions, groups, tombstones, memory and logs into a new identity", async t => {
  const { root, user, dir } = await fixture(t);
  const backup = await exportUserBackup(user.userId, root);
  assert.equal(inspectUserBackup(backup).chats, 1);
  assert.equal(inspectUserBackup(backup).groups, 1);
  assert.equal(inspectUserBackup(backup).memories, 1);
  assert.ok(!backup.files.some(file => /credentials|sessions|settings/.test(file.path)));
  const restored = await restoreUserBackup(backup, "restored", "password", root);
  assert.notEqual(restored.userId, user.userId);
  assert.equal((await findCredentialByUsername("restored", root))?.userId, restored.userId);
  for (const file of backup.files) {
    assert.equal(await readFile(join(dir, file.path), "utf8"), file.content);
    const result = await readFile(join(root, "users", restored.userId, file.path), "utf8");
    if (file.path === "profile.json" || file.path === "manifest.json") {
      const value = JSON.parse(result);
      assert.equal((value.userProfile || value).id, restored.userId);
    } else assert.equal(result, file.content);
  }
});

test("malformed paths, duplicates, hashes and graphs reject before creating any account", async t => {
  const { root, user } = await fixture(t);
  const backup = await exportUserBackup(user.userId, root);
  const before = await readFile(join(root, "credentials.json"), "utf8");
  const directories = await readdir(join(root, "users"));
  const cases = ["../credentials.json", "C:/secret.json", "memory/../../settings.json", "memory/global.md:secret", "credentials.json"];
  for (const path of cases) {
    await assert.rejects(restoreUserBackup({ ...backup, files: [{ ...backup.files[0], path }] }, "baduser", "password", root), BackupValidationError);
  }
  assert.throws(() => inspectUserBackup({ ...backup, files: [...backup.files, backup.files[0]] }), BackupValidationError);
  const broken = structuredClone(backup);
  const file = broken.files.find(file => file.path === "chats/chat-c1.json")!;
  const graph = JSON.parse(file.content); graph.messages[0].parentId = "m3";
  file.content = JSON.stringify(graph); file.sha256 = createHash("sha256").update(file.content).digest("hex");
  await assert.rejects(restoreUserBackup(broken, "baduser", "password", root), BackupValidationError);
  file.sha256 = "0".repeat(64);
  assert.throws(() => inspectUserBackup(broken), BackupValidationError);
  assert.equal(await readFile(join(root, "credentials.json"), "utf8"), before);
  assert.deepEqual(await readdir(join(root, "users")), directories);
});

test("initializer failure publishes no credential or workspace", async t => {
  const { root } = await fixture(t);
  const before = await readdir(join(root, "users"));
  await assert.rejects(registerUser("failed", "password", root, async (id, usersRoot) => {
    await mkdir(join(usersRoot, id));
    throw new Error("initializer failed");
  }), /initializer failed/);
  assert.equal(await findCredentialByUsername("failed", root), null);
  assert.deepEqual(await readdir(join(root, "users")), before);
});

test("export rejects symlinked directories", async t => {
  const { root, user, dir } = await fixture(t);
  await symlink(join(dir, "memory"), join(dir, "linked"), "junction");
  await assert.rejects(exportUserBackup(user.userId, root), /Unable to export/);
});
