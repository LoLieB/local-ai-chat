import { normalizeChatTags } from "../../shared/chatOrganization.js";
import { isContextReport } from "../../shared/context.js";
import type { ContextReport } from "../../shared/context.js";
import { mkdir, readdir, rm, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import { ensureUserWorkspace, normalizeUserId, type ChatSummaryRecord } from "./userDataStore.js";
import { readJsonOrFallback, readTextOrEmpty, writeJsonAtomic } from "./jsonFile.js";
import { normalizeChatTitle, normalizeChatTitleMode, type ChatTitleMode } from "../../shared/chatMetadata.js";

const usersRootDir = join(process.cwd(), "server-data", "common-base", "users");
const chatWriteQueues = new Map<string, Promise<void>>();

export class InvalidTranscriptIdError extends Error {
  readonly status = 400;
  constructor() { super("Invalid transcript identifier."); this.name = "InvalidTranscriptIdError"; }
}
export class TranscriptDeletedError extends Error {
  readonly status = 409;
  constructor() { super("This conversation was deleted. Create a new conversation."); this.name = "TranscriptDeletedError"; }
}
export class TranscriptConflictError extends Error {
  readonly status = 409;
  constructor(public readonly revision: number) { super("Conversation history changed. Reload before retrying."); this.name = "TranscriptConflictError"; }
}
export class GroupConfigConflictError extends Error {
  readonly status = 409;
  constructor(public readonly configRevision: number) { super("Group settings changed. Reload before retrying."); this.name = "GroupConfigConflictError"; }
}
function transcriptId(value: string) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(value)) throw new InvalidTranscriptIdError();
  return value;
}
async function isDeleted(filePath: string) {
  return stat(`${filePath}.deleted`).then(() => true).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return false;
    throw error;
  });
}
async function assertNotDeleted(filePath: string) {
  if (await isDeleted(filePath)) throw new TranscriptDeletedError();
}

export type StoredChatMessage = {
  image?: import("../../shared/chatImage.js").ChatImage;
  contextReport?: ContextReport;
  id: string;
  role: "user" | "assistant";
  content: string;
  createdAt: string;
  parentId?: string | null;
  authorCharacterId?: string | null;
  authorNameSnapshot?: string | null;
};

export type StoredChatTranscript = {
  archivedAt?: string | null;
  tags?: string[];
  modelProfileId?: string | null;
  schemaVersion?: 2;
  id: string;
  title: string;
  characterId: string | null;
  messages: StoredChatMessage[];
  activeLeafId?: string | null;
  revision?: number;
  createdAt: string;
  updatedAt: string;
  pinnedMessageIds?: string[];
  titleMode?: ChatTitleMode;
  pinnedAt?: string | null;
};

export type StoredGroupChatMessage = {
  contextReport?: ContextReport;
  id: string;
  role: "user" | "assistant";
  content: string;
  createdAt: string;
  characterId?: string;
  characterName?: string;
};

export type StoredGroupChatTranscript = {
  sceneTimeLimitSeconds?: number;
  sceneDeadlineAt?: number | null;
  roomRules?: string;
  participantRoles?: Record<string, string>;
  pendingSpeakerIds?: string[];
  modelProfileId?: string | null;
  configRevision?: number;
  revision?: number;
  id: string;
  title: string;
  participantIds: string[];
  activeSpeakerCharacterId: string | null;
  messages: StoredGroupChatMessage[];
  responseMode: "single-speaker" | "round-robin";
  maxRepliesPerTurn: number;
  createdAt: string;
  updatedAt: string;
};

function safeTrim(value: string | null | undefined) {
  return (value || "").trim();
}

function queueKey(userId: string, bucket: string, itemId: string, rootDir: string) {
  return `${resolve(rootDir).toLowerCase()}::${userId.toLowerCase()}::${bucket}::${itemId.toLowerCase()}`;
}

async function enqueueWrite<T>(key: string, operation: () => Promise<T>) {
  const previous = chatWriteQueues.get(key) || Promise.resolve();
  const run = previous.catch(() => undefined).then(operation);
  const tail = run.then(() => undefined, () => undefined);
  chatWriteQueues.set(key, tail);

  try {
    return await run;
  } finally {
    if (chatWriteQueues.get(key) === tail) {
      chatWriteQueues.delete(key);
    }
  }
}

async function ensureChatDirs(userId: string, rootDir = usersRootDir) {
  const workspace = await ensureUserWorkspace(userId, rootDir);
  const chatsDir = join(workspace.userDir, "chats");
  const groupChatsDir = join(workspace.userDir, "group-chats");
  await mkdir(chatsDir, { recursive: true });
  await mkdir(groupChatsDir, { recursive: true });
  return { chatsDir, groupChatsDir };
}

function chatPath(chatsDir: string, chatId: string) {
  return join(chatsDir, `chat-${chatId}.json`);
}

function groupChatPath(groupChatsDir: string, groupChatId: string) {
  return join(groupChatsDir, `group-${groupChatId}.json`);
}

async function readJsonFile<T>(filePath: string): Promise<T | null> {
  const raw = await readTextOrEmpty(filePath);
  if (!raw.trim()) {
    return null;
  }

  return await readJsonOrFallback<T | null>(filePath, null, filePath);
}

async function writeJsonFile(filePath: string, value: unknown) {
  await writeJsonAtomic(filePath, value);
}

function legacyMessageId(message: Partial<StoredChatMessage>, index: number) {
  const source = `${index}\u0000${message.role || "user"}\u0000${message.createdAt || ""}\u0000${message.content || ""}`;
  return `legacy_${createHash("sha256").update(source).digest("hex").slice(0, 16)}`;
}

function normalizeChatMessage(message: Partial<StoredChatMessage>, index: number, previousId: string | null): StoredChatMessage {
  return {
    id: safeTrim(message.id) || legacyMessageId(message, index),
    role: message.role === "assistant" ? "assistant" : "user",
    content: safeTrim(message.content),
    image: message.image,
    contextReport: isContextReport(message.contextReport) ? message.contextReport : undefined,
    createdAt: safeTrim(message.createdAt),
    parentId: message.parentId === null ? null : safeTrim(message.parentId) || previousId,
    authorCharacterId: safeTrim(message.authorCharacterId) || undefined,
    authorNameSnapshot: safeTrim(message.authorNameSnapshot) || undefined
  };
}

function normalizeGroupChatMessage(message: Partial<StoredGroupChatMessage>, index: number): StoredGroupChatMessage {
  return {
    id: safeTrim(message.id) || legacyMessageId(message, index),
    role: message.role === "assistant" ? "assistant" : "user",
    content: safeTrim(message.content),
    contextReport: isContextReport(message.contextReport) ? message.contextReport : undefined,
    createdAt: safeTrim(message.createdAt),
    characterId: safeTrim(message.characterId) || undefined,
    characterName: safeTrim(message.characterName) || undefined
  };
}

export function normalizeChatTranscript(chat: Partial<StoredChatTranscript>): StoredChatTranscript {
  let previousId: string | null = null;
  const messages = Array.isArray(chat.messages)
    ? chat.messages.map((message, index) => {
        const normalized = normalizeChatMessage(message, index, previousId);
        previousId = normalized.id;
        return normalized;
      })
    : [];
  const validParents = new Set<string>();
  for (const message of messages) {
    if (message.parentId && !validParents.has(message.parentId)) message.parentId = null;
    validParents.add(message.id);
  }
  const messageIds = new Set(messages.map((message) => message.id));
  return {
    schemaVersion: 2,
    modelProfileId: safeTrim(chat.modelProfileId) || null,
    archivedAt: safeTrim(chat.archivedAt) || null,
    tags: chat.tags === undefined ? [] : normalizeChatTags(chat.tags),
    id: safeTrim(chat.id),
    title: normalizeChatTitle(chat.title, "Новый чат"),
    characterId: safeTrim(chat.characterId) || null,
    messages,
    activeLeafId: messageIds.has(safeTrim(chat.activeLeafId)) ? safeTrim(chat.activeLeafId) : messages.at(-1)?.id || null,
    revision: Math.max(0, Number(chat.revision) || 0),
    createdAt: safeTrim(chat.createdAt),
    updatedAt: safeTrim(chat.updatedAt),
    pinnedMessageIds: Array.isArray(chat.pinnedMessageIds)
      ? [...new Set(chat.pinnedMessageIds.map((id) => safeTrim(id)).filter((id) => messageIds.has(id)))]
      : [],
    titleMode: normalizeChatTitleMode(chat.titleMode, normalizeChatTitle(chat.title, "Новый чат")),
    pinnedAt: chat.pinnedAt === null ? null : safeTrim(chat.pinnedAt) || null
  };
}

export function activeChatMessages(chat: StoredChatTranscript) {
  const byId = new Map(chat.messages.map((message) => [message.id, message]));
  const path: StoredChatMessage[] = [];
  const seen = new Set<string>();
  let current = chat.activeLeafId ? byId.get(chat.activeLeafId) : undefined;
  while (current && !seen.has(current.id)) {
    seen.add(current.id);
    path.push(current);
    current = current.parentId ? byId.get(current.parentId) : undefined;
  }
  return path.reverse();
}

export function clientChatTranscript(chat: StoredChatTranscript) {
  const messages = activeChatMessages(chat);
  const branches: Record<string, string[]> = {};
  for (const message of chat.messages) {
    const key = message.parentId || "root";
    (branches[key] ||= []).push(message.id);
  }
  return { ...chat, messages, allMessages: chat.messages, branches };
}

function normalizeGroupChatTranscript(groupChat: StoredGroupChatTranscript): StoredGroupChatTranscript {
  return {
    sceneTimeLimitSeconds: groupChat.sceneTimeLimitSeconds || 0,
    sceneDeadlineAt: groupChat.sceneDeadlineAt ?? null,
    roomRules: groupChat.roomRules || "",
    participantRoles: Object.fromEntries(Object.entries(groupChat.participantRoles || {}).filter(([id]) => groupChat.participantIds.includes(id))),
    pendingSpeakerIds: Array.isArray(groupChat.pendingSpeakerIds) ? [...new Set(groupChat.pendingSpeakerIds.filter(id => typeof id === "string" && groupChat.participantIds.includes(id)))] : [],
    modelProfileId: safeTrim(groupChat.modelProfileId) || null,
    configRevision: groupChat.configRevision ?? 0,
    revision: groupChat.revision ?? 0,
    id: safeTrim(groupChat.id),
    title: safeTrim(groupChat.title) || "Group chat",
    participantIds: Array.isArray(groupChat.participantIds)
      ? groupChat.participantIds.map((participantId) => safeTrim(participantId)).filter(Boolean)
      : [],
    activeSpeakerCharacterId: safeTrim(groupChat.activeSpeakerCharacterId) || null,
    messages: Array.isArray(groupChat.messages) ? groupChat.messages.map(normalizeGroupChatMessage) : [],
    responseMode: groupChat.responseMode === "round-robin" ? "round-robin" : "single-speaker",
    maxRepliesPerTurn: Math.max(1, Number(groupChat.maxRepliesPerTurn) || 1),
    createdAt: safeTrim(groupChat.createdAt),
    updatedAt: safeTrim(groupChat.updatedAt)
  };
}

export async function saveChatTranscript(
  userId: string,
  chat: StoredChatTranscript,
  rootDir = usersRootDir
) {
  const normalizedUserId = normalizeUserId(userId);
  const normalizedChatId = transcriptId(chat.id);
  if (!normalizedUserId || !normalizedChatId) {
    throw new Error("Invalid chat transcript.");
  }

  const key = queueKey(normalizedUserId, "chat", normalizedChatId, rootDir);
  return enqueueWrite(key, async () => {
    const { chatsDir } = await ensureChatDirs(normalizedUserId, rootDir);
    await assertNotDeleted(chatPath(chatsDir, normalizedChatId));
    const payload = normalizeChatTranscript({
      ...chat,
      schemaVersion: 2,
      id: normalizedChatId,
      title: safeTrim(chat.title) || "Untitled chat",
      characterId: safeTrim(chat.characterId) || null,
      messages: chat.messages,
      activeLeafId: chat.activeLeafId,
      revision: chat.revision,
      createdAt: safeTrim(chat.createdAt),
      updatedAt: safeTrim(chat.updatedAt)
    });
    await writeJsonFile(chatPath(chatsDir, normalizedChatId), payload);
    return payload;
  });
}

export async function saveGroupChatTranscript(
  userId: string,
  groupChat: StoredGroupChatTranscript,
  rootDir = usersRootDir,
  expectedRevision?: number
) {
  const normalizedUserId = normalizeUserId(userId);
  const id = transcriptId(groupChat.id);
  if (!normalizedUserId) throw new InvalidTranscriptIdError();
  return enqueueWrite(queueKey(normalizedUserId, "group-chat", id, rootDir), async () => {
    const { groupChatsDir } = await ensureChatDirs(normalizedUserId, rootDir);
    const filePath = groupChatPath(groupChatsDir, id);
    await assertNotDeleted(filePath);
    const current = await readJsonFile<StoredGroupChatTranscript>(filePath);
    const revision = current?.revision ?? 0;
    if (expectedRevision !== undefined && expectedRevision !== revision) throw new TranscriptConflictError(revision);
    const payload = normalizeGroupChatTranscript({
      ...groupChat,
      ...(current || {}),
      messages: groupChat.messages,
      pendingSpeakerIds: groupChat.pendingSpeakerIds || [],
      sceneDeadlineAt: groupChat.sceneDeadlineAt ?? null,
      updatedAt: groupChat.updatedAt,
      revision: revision + 1
    });
    await writeJsonFile(filePath, payload);
    return payload;
  });
}

export async function saveGroupChatConfig(userId: string, groupChat: StoredGroupChatTranscript, rootDir = usersRootDir) {
  const normalizedUserId = normalizeUserId(userId);
  const id = transcriptId(groupChat.id);
  if (!normalizedUserId) throw new InvalidTranscriptIdError();
  return enqueueWrite(queueKey(normalizedUserId, "group-chat", id, rootDir), async () => {
    const { groupChatsDir } = await ensureChatDirs(normalizedUserId, rootDir);
    const filePath = groupChatPath(groupChatsDir, id);
    await assertNotDeleted(filePath);
    const current = await readJsonFile<StoredGroupChatTranscript>(filePath);
    const configRevision = current?.configRevision ?? 0;
    if ((groupChat.configRevision ?? 0) !== configRevision) throw new GroupConfigConflictError(configRevision);
    const payload = normalizeGroupChatTranscript({
      ...groupChat,
      messages: current?.messages || [],
      pendingSpeakerIds: current?.pendingSpeakerIds || [],
      sceneDeadlineAt: current?.sceneDeadlineAt ?? null,
      createdAt: current?.createdAt || groupChat.createdAt,
      revision: current?.revision ?? 0,
      configRevision: configRevision + 1
    });
    await writeJsonFile(filePath, payload);
    return payload;
  });
}

export async function readStoredChat(userId: string, chatId: string, rootDir = usersRootDir) {
  const normalizedUserId = normalizeUserId(userId);
  const normalizedChatId = transcriptId(chatId);
  if (!normalizedUserId || !normalizedChatId) {
    return null;
  }

  const { chatsDir } = await ensureChatDirs(normalizedUserId, rootDir);
  const filePath = chatPath(chatsDir, normalizedChatId);
  if (await isDeleted(filePath)) return null;
  const chat = await readJsonFile<StoredChatTranscript>(filePath);
  if (!chat) return null;
  const normalized = normalizeChatTranscript(chat);
  return normalized;
}

export async function readStoredGroupChat(userId: string, groupChatId: string, rootDir = usersRootDir) {
  const normalizedUserId = normalizeUserId(userId);
  const normalizedGroupChatId = transcriptId(groupChatId);
  if (!normalizedUserId || !normalizedGroupChatId) {
    return null;
  }

  const { groupChatsDir } = await ensureChatDirs(normalizedUserId, rootDir);
  if (await isDeleted(groupChatPath(groupChatsDir, normalizedGroupChatId))) return null;
  const groupChat = await readJsonFile<StoredGroupChatTranscript>(groupChatPath(groupChatsDir, normalizedGroupChatId));
  return groupChat ? normalizeGroupChatTranscript(groupChat) : null;
}

export async function listStoredChats(userId: string, rootDir = usersRootDir) {
  const normalizedUserId = normalizeUserId(userId);
  if (!normalizedUserId) {
    return [];
  }

  const { chatsDir } = await ensureChatDirs(normalizedUserId, rootDir);
  const entries = await readdir(chatsDir, { withFileTypes: true });
  const chats = await Promise.all(
    entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .map(async (entry) => {
        const filePath = join(chatsDir, entry.name);
        if (await isDeleted(filePath)) return null;
        const chat = await readJsonFile<StoredChatTranscript>(filePath);
        if (!chat) return null;
        const normalized = normalizeChatTranscript(chat);
        return normalized;
      })
  );
  return chats.filter((chat): chat is StoredChatTranscript => Boolean(chat));
}

export async function listStoredGroupChats(userId: string, rootDir = usersRootDir) {
  const normalizedUserId = normalizeUserId(userId);
  if (!normalizedUserId) {
    return [];
  }

  const { groupChatsDir } = await ensureChatDirs(normalizedUserId, rootDir);
  const entries = await readdir(groupChatsDir, { withFileTypes: true });
  const chats = await Promise.all(
    entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .map(async (entry) => await isDeleted(join(groupChatsDir, entry.name)) ? null : readJsonFile<StoredGroupChatTranscript>(join(groupChatsDir, entry.name)))
  );
  return chats.filter((chat): chat is StoredGroupChatTranscript => Boolean(chat)).map(normalizeGroupChatTranscript);
}

export async function updateStoredChat(
  userId: string,
  chatId: string,
  updater: (chat: StoredChatTranscript) => StoredChatTranscript,
  rootDir = usersRootDir,
  initial?: StoredChatTranscript
) {
  const normalizedUserId = normalizeUserId(userId);
  const normalizedChatId = transcriptId(chatId);
  if (!normalizedUserId || !normalizedChatId) {
    return null;
  }

  const key = queueKey(normalizedUserId, "chat", normalizedChatId, rootDir);
  return enqueueWrite(key, async () => {
    const { chatsDir } = await ensureChatDirs(normalizedUserId, rootDir);
    const filePath = chatPath(chatsDir, normalizedChatId);
    await assertNotDeleted(filePath);
    const stored = await readJsonFile<StoredChatTranscript>(filePath) || initial;
    if (!stored) {
      return null;
    }

    const next = normalizeChatTranscript({ ...updater(normalizeChatTranscript(stored)), id: normalizedChatId });
    await writeJsonFile(filePath, next);
    return next;
  });
}

export async function isStoredTranscriptDeleted(userId: string, id: string, kind: "chat" | "group-chat", rootDir = usersRootDir) {
  const normalizedUserId = normalizeUserId(userId);
  transcriptId(id);
  if (!normalizedUserId) throw new InvalidTranscriptIdError();
  const { chatsDir, groupChatsDir } = await ensureChatDirs(normalizedUserId, rootDir);
  return isDeleted(kind === "chat" ? chatPath(chatsDir, id) : groupChatPath(groupChatsDir, id));
}

async function deleteTranscript(userId: string, id: string, bucket: "chat" | "group-chat", rootDir: string) {
  const normalizedUserId = normalizeUserId(userId);
  transcriptId(id);
  if (!normalizedUserId) throw new InvalidTranscriptIdError();
  return enqueueWrite(queueKey(normalizedUserId, bucket, id, rootDir), async () => {
    const { chatsDir, groupChatsDir } = await ensureChatDirs(normalizedUserId, rootDir);
    const filePath = bucket === "chat" ? chatPath(chatsDir, id) : groupChatPath(groupChatsDir, id);
    // Persist first so a crash before unlink still hides the transcript.
    await writeJsonFile(`${filePath}.deleted`, { deletedAt: new Date().toISOString() });
    await rm(filePath, { force: true });
  });
}

export async function deleteStoredChat(userId: string, chatId: string, rootDir = usersRootDir) {
  return deleteTranscript(userId, chatId, "chat", rootDir);
}

export async function deleteStoredGroupChat(userId: string, groupChatId: string, rootDir = usersRootDir) {
  return deleteTranscript(userId, groupChatId, "group-chat", rootDir);
}

export async function reconcileStoredTranscripts(
  _userId: string,
  _chatSummaries: ChatSummaryRecord[],
  _rootDir = usersRootDir
) {
  // Summary snapshots are not deletion requests. Retained for legacy callers.
}
