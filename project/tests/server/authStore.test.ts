import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createSessionForUser,
  initializeAdmin,
  hashPassword,
  findCredentialByUsername,
  normalizeUsername,
  registerUser,
  revokeSession,
  validateSession,
  verifyPassword
} from "../../server/storage/authStore.ts";
import { listStoredChats } from "../../server/storage/chatStore.ts";
import { readUserWorkspaceState } from "../../server/storage/userDataStore.ts";

test("administrator setup is explicit, reserved, serialized and never resets existing access", async () => {
  const root = await mkdtemp(join(tmpdir(), "local-ai-chat-bootstrap-"));
  assert.equal(await initializeAdmin(undefined, root), false);
  assert.equal(await findCredentialByUsername("admin", root), null);
  await assert.rejects(registerUser(" ADMIN ", "test-reserved-name", root), /reserved/);
  await assert.rejects(initializeAdmin("short", root), /INITIAL_ADMIN_PASSWORD/);
  const normal = await registerUser("existing", "normal-test-password", root);
  const session = await createSessionForUser(normal.userId, normal.username, root);
  const first = randomBytes(24).toString("hex");
  const second = randomBytes(24).toString("hex");
  await Promise.all([initializeAdmin(first, root), initializeAdmin(second, root)]);
  const stored = await findCredentialByUsername("admin", root);
  assert.equal(verifyPassword(first, stored!.passwordHash), true);
  assert.equal(verifyPassword(second, stored!.passwordHash), false);
  await initializeAdmin(undefined, root);
  await initializeAdmin("short", root);
  assert.deepEqual(await findCredentialByUsername("admin", root), stored);
  assert.equal((await validateSession(session.sessionToken, root))?.userId, normal.userId);
  assert.equal(verifyPassword("normal-test-password", (await findCredentialByUsername("existing", root))!.passwordHash), true);

  const legacyRoot = await mkdtemp(join(tmpdir(), "local-ai-chat-legacy-auth-"));
  const legacyPassword = randomBytes(4).toString("hex");
  const legacy = { username: "admin", userId: "u_admin", passwordHash: hashPassword(legacyPassword), createdAt: "2020-01-01", updatedAt: "2020-01-01" };
  await writeFile(join(legacyRoot, "credentials.json"), JSON.stringify({ users: { admin: legacy } }));
  const legacySession = await createSessionForUser(legacy.userId, legacy.username, legacyRoot);
  await initializeAdmin(second, legacyRoot);
  assert.deepEqual(await findCredentialByUsername("admin", legacyRoot), legacy);
  assert.equal(verifyPassword(legacyPassword, legacy.passwordHash), true);
  assert.equal((await validateSession(legacySession.sessionToken, legacyRoot))?.userId, legacy.userId);
});

test("bootstrap cannot replace damaged credentials or expose their content in errors", async () => {
  const root = await mkdtemp(join(tmpdir(), "local-ai-chat-damaged-auth-"));
  for (const raw of ["", '{"users":', '{"users":null}', '{"users":[]}']) {
    await writeFile(join(root, "credentials.json"), raw);
    await assert.rejects(initializeAdmin(randomBytes(24).toString("hex"), root), {
      message: "Invalid authentication store. Restore it from a trusted backup."
    });
    assert.equal(await readFile(join(root, "credentials.json"), "utf8"), raw);
  }
});

test("normalizeUsername trims and lowercases valid usernames", () => {
  assert.equal(normalizeUsername("  Gamer_123 "), "gamer_123");
  assert.equal(normalizeUsername("ab"), null);
  assert.equal(normalizeUsername("bad name"), null);
});

test("registerUser stores credential and creates user workspace", async () => {
  const rootDir = await mkdtemp(join(tmpdir(), "local-ai-chat-auth-"));
  const credential = await registerUser("Gamer123", "secret42", rootDir);
  const stored = await findCredentialByUsername("gamer123", rootDir);

  assert.equal(credential.username, "Gamer123");
  assert.ok(credential.userId.startsWith("u_"));
  assert.ok(stored);
  assert.equal(stored?.userId, credential.userId);
  assert.equal(verifyPassword("secret42", stored?.passwordHash || ""), true);
});

test("registerUser rejects duplicate usernames", async () => {
  const rootDir = await mkdtemp(join(tmpdir(), "local-ai-chat-auth-"));
  await registerUser("Gamer123", "secret42", rootDir);

  await assert.rejects(
    () => registerUser("gamer123", "another42", rootDir),
    /already taken/i
  );
});

test("session lifecycle validates and revokes tokens", async () => {
  const rootDir = await mkdtemp(join(tmpdir(), "local-ai-chat-auth-"));
  const credential = await registerUser("Rin", "speed99", rootDir);
  const session = await createSessionForUser(credential.userId, credential.username, rootDir);

  const resolved = await validateSession(session.sessionToken, rootDir);
  assert.equal(resolved?.userId, credential.userId);
  assert.equal(await revokeSession(session.sessionToken, rootDir), true);
  assert.equal(await validateSession(session.sessionToken, rootDir), null);
});

test("corrupt auth files fail closed without resetting credentials", async () => {
  const rootDir = await mkdtemp(join(tmpdir(), "local-ai-chat-auth-"));
  await writeFile(join(rootDir, "credentials.json"), "{", "utf8");
  await writeFile(join(rootDir, "sessions.json"), "{", "utf8");

  await assert.rejects(findCredentialByUsername("ghost", rootDir), /Invalid authentication store/);
  await assert.rejects(validateSession("st_missing", rootDir), /Invalid authentication store/);
});

test("administrator starts with no characters or chats", async () => {
  const rootDir = await mkdtemp(join(tmpdir(), "local-ai-chat-auth-"));
  await initializeAdmin("test-initial-admin-password", rootDir);
  const credential = await findCredentialByUsername("admin", rootDir);
  assert.ok(credential);
  assert.equal(verifyPassword("test-initial-admin-password", credential.passwordHash), true);
  const workspaceRoot = join(rootDir, "users");
  assert.deepEqual((await readUserWorkspaceState("u_admin", workspaceRoot)).characters, []);
  assert.deepEqual(await listStoredChats("u_admin", workspaceRoot), []);
  await findCredentialByUsername("admin", rootDir);
  assert.deepEqual((await readUserWorkspaceState("u_admin", workspaceRoot)).characters, []);
});