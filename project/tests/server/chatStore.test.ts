import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  activeChatMessages,
  clientChatTranscript,
  deleteStoredChat,
  listStoredChats,
  listStoredGroupChats,
  readStoredChat,
  readStoredGroupChat,
  saveChatTranscript,
  saveGroupChatTranscript
} from "../../server/storage/chatStore.ts";
import { deleteStoredGroupChat, saveGroupChatConfig, reconcileStoredTranscripts, isStoredTranscriptDeleted, TranscriptDeletedError, TranscriptConflictError, GroupConfigConflictError, InvalidTranscriptIdError } from "../../server/storage/chatStore.ts";
import { ensureUserWorkspace } from "../../server/storage/userDataStore.ts";

test("stale summaries cannot delete chats and explicit deletion prevents late resurrection", async () => {
  const root = await mkdtemp(join(tmpdir(), "local-ai-chat-delete-"));
  const chat = { id: "new-chat", title: "New", characterId: null, messages: [], createdAt: "1", updatedAt: "1" };
  await saveChatTranscript("u-test", chat, root);
  await reconcileStoredTranscripts("u-test", [], root);
  assert.ok(await readStoredChat("u-test", chat.id, root));
  await deleteStoredChat("u-test", chat.id, root);
  assert.equal(await isStoredTranscriptDeleted("u-test", chat.id, "chat", root), true);
  await assert.rejects(saveChatTranscript("u-test", chat, root), TranscriptDeletedError);
  assert.equal(await readStoredChat("u-test", chat.id, root), null);
  await assert.rejects(deleteStoredChat("u-test", "../escape", root), InvalidTranscriptIdError);
});

test("group configuration and generation preserve each other and reject stale revisions", async () => {
  const root = await mkdtemp(join(tmpdir(), "local-ai-chat-group-cas-"));
  const base = { roomRules: "Common rule", participantRoles: { a: "Reviewer" }, id: "group-new", title: "Group", participantIds: ["a"], activeSpeakerCharacterId: "a", messages: [], responseMode: "single-speaker" as const, maxRepliesPerTurn: 1, createdAt: "1", updatedAt: "1" };
  const first = await saveGroupChatConfig("u-test", base, root);
  assert.equal(first.configRevision, 1);
  const changed = await saveGroupChatConfig("u-test", { ...first, title: "Renamed" }, root);
  await assert.rejects(saveGroupChatConfig("u-test", first, root), GroupConfigConflictError);
  const message = { id: "m1", role: "user" as const, content: "hello", createdAt: "2" };
  const generated = await saveGroupChatTranscript("u-test", { ...base, messages: [message], pendingSpeakerIds: ["a"], sceneDeadlineAt: 123456 }, root, 0);
  assert.equal(generated.roomRules, "Common rule");
  assert.deepEqual(generated.participantRoles, { a: "Reviewer" });
  assert.equal(generated.title, "Renamed");
  assert.equal(generated.configRevision, changed.configRevision);
  await assert.rejects(saveGroupChatTranscript("u-test", base, root, 0), TranscriptConflictError);
  const nextConfig = await saveGroupChatConfig("u-test", { ...changed, title: "Again" }, root);
  assert.deepEqual(nextConfig.pendingSpeakerIds, ["a"]);
  assert.equal(nextConfig.sceneDeadlineAt, 123456);
  assert.deepEqual((await readStoredGroupChat("u-test", base.id, root))?.pendingSpeakerIds, ["a"]);
  const finished = await saveGroupChatTranscript("u-test", { ...nextConfig, pendingSpeakerIds: [] }, root, generated.revision);
  assert.deepEqual(finished.pendingSpeakerIds, []);
  assert.equal(nextConfig.messages.length, 1);
  assert.equal(nextConfig.messages[0].id, message.id);
  assert.equal(nextConfig.messages[0].content, "hello");
  await deleteStoredGroupChat("u-test", base.id, root);
  await assert.rejects(saveGroupChatConfig("u-test", nextConfig, root), TranscriptDeletedError);
  await assert.rejects(saveGroupChatTranscript("u-test", generated, root), TranscriptDeletedError);
});

test("saveChatTranscript persists and reloads full chat history", async () => {
  const rootDir = await mkdtemp(join(tmpdir(), "local-ai-chat-chat-store-"));

  await saveChatTranscript(
    "u-chat-user",
    {
      id: "chat-rin",
      title: "Rin talk",
      characterId: "char-rin",
      messages: [
        { id: "m1", role: "user", content: "hey", createdAt: "2026-05-24T10:00:00.000Z" },
        { id: "m2", role: "assistant", content: "hello", createdAt: "2026-05-24T10:00:02.000Z" }
      ],
      createdAt: "2026-05-24T10:00:00.000Z",
      updatedAt: "2026-05-24T10:00:02.000Z"
    },
    rootDir
  );

  const chat = await readStoredChat("u-chat-user", "chat-rin", rootDir);
  assert.equal(chat?.id, "chat-rin");
  assert.equal(chat?.messages.length, 2);
  assert.equal(chat?.messages[1]?.content, "hello");
});

test("saveGroupChatTranscript persists and reloads full group history", async () => {
  const rootDir = await mkdtemp(join(tmpdir(), "local-ai-chat-chat-store-"));

  await saveGroupChatTranscript(
    "u-group-user",
    {
      id: "group-1",
      title: "Night group",
      participantIds: ["char-a", "char-b"],
      activeSpeakerCharacterId: "char-b",
      messages: [
        { id: "g1", role: "user", content: "start", createdAt: "2026-05-24T10:00:00.000Z" },
        {
          id: "g2",
          role: "assistant",
          characterId: "char-b",
          characterName: "B",
          content: "reply",
          createdAt: "2026-05-24T10:00:05.000Z"
        }
      ],
      responseMode: "single-speaker",
      maxRepliesPerTurn: 1,
      createdAt: "2026-05-24T10:00:00.000Z",
      updatedAt: "2026-05-24T10:00:05.000Z"
    },
    rootDir
  );

  const chat = await readStoredGroupChat("u-group-user", "group-1", rootDir);
  assert.equal(chat?.participantIds.length, 2);
  assert.equal(chat?.messages[1]?.characterName, "B");
});

test("listStoredChats and deleteStoredChat keep files in sync", async () => {
  const rootDir = await mkdtemp(join(tmpdir(), "local-ai-chat-chat-store-"));

  await saveChatTranscript(
    "u-list-user",
    {
      id: "chat-a",
      title: "A",
      characterId: "char-a",
      messages: [],
      createdAt: "2026-05-24T10:00:00.000Z",
      updatedAt: "2026-05-24T10:00:00.000Z"
    },
    rootDir
  );
  await saveGroupChatTranscript(
    "u-list-user",
    {
      id: "group-a",
      title: "G",
      participantIds: [],
      activeSpeakerCharacterId: null,
      messages: [],
      responseMode: "single-speaker",
      maxRepliesPerTurn: 1,
      createdAt: "2026-05-24T10:00:00.000Z",
      updatedAt: "2026-05-24T10:00:00.000Z"
    },
    rootDir
  );

  assert.equal((await listStoredChats("u-list-user", rootDir)).length, 1);
  assert.equal((await listStoredGroupChats("u-list-user", rootDir)).length, 1);

  await deleteStoredChat("u-list-user", "chat-a", rootDir);
  assert.equal((await listStoredChats("u-list-user", rootDir)).length, 0);
});

test("listStoredChats skips malformed transcript files", async () => {
  const rootDir = await mkdtemp(join(tmpdir(), "local-ai-chat-chat-store-"));
  const workspace = await ensureUserWorkspace("u-bad-chat", rootDir);
  await mkdir(join(workspace.userDir, "chats"), { recursive: true });
  await writeFile(join(workspace.userDir, "chats", "chat-bad.json"), "{", "utf8");

  const chats = await listStoredChats("u-bad-chat", rootDir);
  assert.deepEqual(chats, []);
});

test("legacy transcript migration is deterministic and idempotent", async () => {
  const rootDir = await mkdtemp(join(tmpdir(), "local-ai-chat-chat-store-"));
  const workspace = await ensureUserWorkspace("u-legacy-chat", rootDir);
  const chatsDir = join(workspace.userDir, "chats");
  await mkdir(chatsDir, { recursive: true });
  await writeFile(
    join(chatsDir, "chat-legacy.json"),
    JSON.stringify({
      id: "legacy",
      title: "Legacy",
      characterId: null,
      messages: [{ role: "user", content: "old", createdAt: "2026-01-01T00:00:00.000Z" }],
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z"
    }),
    "utf8"
  );

  const first = await readStoredChat("u-legacy-chat", "legacy", rootDir);
  const second = await readStoredChat("u-legacy-chat", "legacy", rootDir);
  assert.match(first?.messages[0]?.id || "", /^legacy_/);
  assert.equal(first?.messages[0]?.id, second?.messages[0]?.id);
  assert.equal(first?.schemaVersion, 2);
  assert.equal(first?.activeLeafId, first?.messages[0]?.id);
});

test("branch graph preserves siblings and exposes only the active path", () => {
  const chat = {
    schemaVersion: 2 as const,
    id: "branch-chat",
    title: "Branch",
    characterId: null,
    messages: [
      { id: "u1", role: "user" as const, content: "question", createdAt: "1", parentId: null },
      { id: "a1", role: "assistant" as const, content: "old", createdAt: "2", parentId: "u1" },
      { id: "a2", role: "assistant" as const, content: "new", createdAt: "3", parentId: "u1" }
    ],
    activeLeafId: "a2",
    revision: 2,
    createdAt: "1",
    updatedAt: "3"
  };

  assert.deepEqual(activeChatMessages(chat).map((message) => message.id), ["u1", "a2"]);
  assert.deepEqual(clientChatTranscript(chat).branches.u1, ["a1", "a2"]);
});
