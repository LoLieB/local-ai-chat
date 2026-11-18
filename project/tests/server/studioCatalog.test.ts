import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { artPath, factoryCards, portraitLibrary, resolveStudioCard, thumbnail } from "../../shared/studioCatalog.js";
import { exportUserBackup, restoreUserBackup } from "../../server/storage/backupStore.js";
import { registerUser } from "../../server/storage/authStore.js";
import { readUserWorkspaceState, syncUserWorkspace } from "../../server/storage/userDataStore.js";
import { createMemoryRecord, listMemoryRecords } from "../../server/storage/memoryStore.js";

test("the six factory IDs are stable in both languages and all 21 pictures have thumbnails", async () => {
  const en = factoryCards("en-US"), ru = factoryCards("ru-RU");
  assert.equal(new Set(en.map(card => card.id)).size, 6);
  assert.deepEqual(en.map(card => card.id), ru.map(card => card.id));
  assert.ok(en.every((card, i) => card.firstMessage !== ru[i].firstMessage));
  const pictures = [artPath("muse"), ...en.map(card => card.posterUrl!), ...portraitLibrary.map(key => artPath(key))];
  assert.equal(new Set(pictures).size, 21);
  for (const url of [...pictures, ...pictures.map(url => thumbnail(url)!)]) {
    assert.ok((await stat(new URL("../../public" + url, import.meta.url))).size > 0);
  }
  const changed = {...ru[0], name: "Private name", firstMessage: "Changed greeting"};
  assert.deepEqual(resolveStudioCard(changed, "ru-RU"), ru[0]);
  assert.equal(resolveStudioCard({...changed, id: "private_copy"}).name, changed.name);
});

test("workspace writes protect originals, private copies and their memory survive independently", async t => {
  const root = await mkdtemp(join(tmpdir(), "studio-catalog-"));
  t.after(() => rm(root, {recursive:true, force:true}));
  const users = join(root, "users");
  const pass = randomBytes(24).toString("hex");
  const alice = await registerUser("alice", pass, root);
  const bob = await registerUser("bob", pass, root);
  const original = factoryCards()[0];
  const state = await readUserWorkspaceState(alice.userId, users);
  await assert.rejects(syncUserWorkspace({...state, characters:[original]}, users), /Invalid workspace character/);
  const copied = {...original, id:"private_copy", name:"Private edits", posterUrl:artPath(portraitLibrary[4])};
  await syncUserWorkspace({...state, characters:[copied]}, users);
  await createMemoryRecord(alice.userId, {scope:"character", characterId:original.id, text:"Test memory", createdBy:"user"}, users);
  const after = await readUserWorkspaceState(alice.userId, users);
  await syncUserWorkspace(after, users);
  assert.deepEqual((await readUserWorkspaceState(alice.userId, users)).characters, [copied]);
  assert.deepEqual((await readUserWorkspaceState(bob.userId, users)).characters, []);
  assert.equal((await listMemoryRecords(bob.userId, users)).length, 0);
  assert.deepEqual((await listMemoryRecords(alice.userId, users)).map(m=>m.characterId), [original.id]);
  const backup = await exportUserBackup(alice.userId, root);
  const restored = await restoreUserBackup(backup, "restored", pass, root);
  assert.deepEqual((await readUserWorkspaceState(restored.userId, users)).characters, [copied]);
  assert.deepEqual(factoryCards()[0], original);
});
