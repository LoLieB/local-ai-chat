import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { saveTextFile, readSavedTextFile, listSavedTextFiles, deleteSavedTextFile } from "../../server/storage/textFileStore.ts";
import { registerUser } from "../../server/storage/authStore.ts";
import { exportUserBackup, inspectUserBackup, restoreUserBackup } from "../../server/storage/backupStore.ts";

test("saved files deduplicate concurrent uploads, isolate users and reject unsafe names", async t => {
  const root = await mkdtemp(join(tmpdir(), "text-files-")); t.after(() => rm(root, { recursive: true, force: true }));
  const [a, b] = await Promise.all([saveTextFile("u-a", "notes.txt", "Привет", root), saveTextFile("u-a", "notes.txt", "Привет", root)]);
  assert.equal(a.id, b.id); assert.equal((await listSavedTextFiles("u-a", root)).length, 1);
  await assert.rejects(readSavedTextFile("u-b", a.id, root), { status: 404 });
  await assert.rejects(saveTextFile("u-a", "../notes.txt", "text", root));
  await assert.rejects(saveTextFile("u-a", "notes.txt", "x".repeat(16001), root));
  await assert.rejects(readSavedTextFile("u-a", "../notes", root));
  await deleteSavedTextFile("u-b", a.id, root);
  assert.equal((await readSavedTextFile("u-a", a.id, root)).text, "Привет");
  await deleteSavedTextFile("u-a", a.id, root); assert.deepEqual(await listSavedTextFiles("u-a", root), []);
});

test("workspace backup restores saved files and rejects forged file content", async t => {
  const root = await mkdtemp(join(tmpdir(), "text-files-backup-")); t.after(() => rm(root, { recursive: true, force: true }));
  const user = await registerUser("source", "password", root);
  const file = await saveTextFile(user.userId, "plan.md", "# План\nСохранить текст", join(root, "users"));
  const backup = await exportUserBackup(user.userId, root);
  inspectUserBackup(backup);
  const restored = await restoreUserBackup(backup, "restored", "password", root);
  assert.deepEqual(await readSavedTextFile(restored.userId, file.id, join(root, "users")), file);
  const broken = structuredClone(backup);
  const entry = broken.files.find(item => item.path.startsWith("text-files/"))!;
  entry.content = JSON.stringify({ ...file, text: "tampered" });
  entry.sha256 = createHash("sha256").update(entry.content).digest("hex");
  assert.throws(() => inspectUserBackup(broken));
});
