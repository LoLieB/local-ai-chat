import { factoryCards, isFactoryId, resolveStudioCard } from "../shared/studioCatalog.js";
import { EMPTY_MODEL_REPLY_HINT } from "../shared/chatRequestPolicy.js";
import { verifyVisionSupport, resolveChatOptions } from "./lmStudio.js";
import { validChatImage } from "../shared/chatImage.js";
import { TextFileError, listSavedTextFiles, saveTextFile, readSavedTextFile, deleteSavedTextFile } from "./storage/textFileStore.js";
import { validRoomDiscussion, roomDiscussionPrompt } from "../shared/roomDiscussion.js";
import { planGroupTurn } from "../shared/groupTurnPlan.js";
import { normalizeChatTags } from "../shared/chatOrganization.js";
import { resolveProfile } from "../shared/modelProfile.js";
import { buildCharacterPrompt } from "../shared/characterCard.js";
import { composeContext } from "./context.js";
import { readMemoryPolicy, updateMemoryPolicy, markMemoryAccess } from "./storage/memoryStore.js";
import type { ContextReport } from "../shared/context.js";
import cors from "cors";
import { exportUserBackup, inspectUserBackup, restoreUserBackup, BackupValidationError, BackupConflictError } from "./storage/backupStore.js";
import dotenv from "dotenv";
import express, { type ErrorRequestHandler, type Request } from "express";
import { createReadStream, existsSync, readFileSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { normalize, resolve } from "node:path";
import { pipeline } from "node:stream";
import { createGzip } from "node:zlib";
import {
  fetchModels,
  requestChatCompletion,
  requestChatStream,
  requestDirectorSuggestion,
  requestGroupCharacterStream,
  requestGroupChatCompletion,
  resolveGroupParticipantsForTurn,
  sanitizeGroupReplyContent,
  stripCharacterPrefix
} from "./lmStudio.js";
import { createStreamCompletionGuard, extractLmStudioStreamDelta, splitLmStudioStreamLines } from "./groupStream.js";
import {
  appendToLatestAssistantMessage,
  deleteMessageById
} from "../shared/chatTranscriptActions.js";
import { readSettings, writeSettings, validateSettingsPatch } from "./storage/settingsStore.js";
import {
  appendDailyLogEntries,
  extractMemoryFactsFromText,
  readUserWorkspaceState,
  readCharacterVersions,
  syncUserWorkspace,
  WorkspaceConflictError,
  type DailyLogEntry,
  type UserStateSyncPayload
} from "./storage/userDataStore.js";
import {
  createMemoryRecord,
  deleteMemoryRecord,
  exportMemory,
  importMemory,
  listMemoryRecords,
  updateMemoryRecord,
} from "./storage/memoryStore.js";
import { formatMemoryConfirmation, parseExplicitMemoryCommand } from "../shared/memoryCommand.js";
import { isMemoryKind, isMemoryScope, type MemoryRecord, type MemoryScope } from "../shared/memory.js";
import {
  createSessionForUser,
  findCredentialByUsername,
  claimStudioWelcome,
  registerUser,
  initializeAdmin,
  revokeSession,
  validateSession,
  verifyPassword
} from "./storage/authStore.js";
import {
  deleteStoredChat,
  deleteStoredGroupChat,
  isStoredTranscriptDeleted,
  saveGroupChatConfig,
  InvalidTranscriptIdError,
  TranscriptDeletedError,
  TranscriptConflictError,
  GroupConfigConflictError,
  activeChatMessages,
  clientChatTranscript,
  listStoredChats,
  listStoredGroupChats,
  readStoredChat,
  readStoredGroupChat,
  saveChatTranscript,
  saveGroupChatTranscript,
  updateStoredChat,
  type StoredChatTranscript,
  type StoredGroupChatTranscript
} from "./storage/chatStore.js";
import { isValidServerToken, resolveServerToken } from "./security.js";
import { validateImportedChat, MAX_CHAT_IMPORT_BYTES } from "../shared/chatTransfer.js";
import { normalizeChatTitle, normalizeGeneratedChatTitle } from "../shared/chatMetadata.js";
import { normalizeGroupReplyLimit } from "../shared/stressHelpers.js";
import {
  ApiError,
  type AppSettings,
  type AuthCredentialsPayload,
  type ChatMutationRequest,
  type ChatRequest,
  type GroupChatRequest
} from "./types.js";

dotenv.config();

const app = express();
const host = process.env.HOST || "127.0.0.1";
const port = Number(process.env.PORT || 8787);
const AUTO_MEMORY_CONFIDENCE_THRESHOLD = 0.8;
const serverToken = resolveServerToken();
const distPath = resolve(process.cwd(), "dist");
const distAssetsPath = resolve(distPath, "assets");
const publicRouteStatusPath = resolve(process.cwd(), "runtime", "logs", "tunnel-temp", "public-route-status.json");
const serverStartedAt = Date.now();
const groupStreamDebugChunks = /^(1|true|yes)$/i.test(process.env.GROUP_STREAM_DEBUG_CHUNKS || "");

function validateGroupReplyLimit(value: unknown, participantCount: number) {
  const normalized = normalizeGroupReplyLimit(value, participantCount);
  if (normalized == null) {
    throw new ApiError(
      400,
      "BAD_REQUEST",
      "Максимальное число ответов должно быть целым числом от 1 до числа участников."
    );
  }
  return normalized;
}

function acceptsGzip(request: Request) {
  const encoding = request.header("accept-encoding") || "";
  return encoding.toLowerCase().includes("gzip");
}

function staticAssetContentType(pathname: string) {
  if (pathname.endsWith(".js")) return "text/javascript; charset=utf-8";
  if (pathname.endsWith(".css")) return "text/css; charset=utf-8";
  if (pathname.endsWith(".svg")) return "image/svg+xml";
  return null;
}

function isSafeAssetPath(filePath: string) {
  const normalized = normalize(filePath).toLowerCase();
  const base = normalize(distAssetsPath).toLowerCase();
  return normalized.startsWith(base);
}

function sanitizeGroupStreamChunk(
  participantName: string,
  chunk: string,
  pendingPrefix: string,
  prefixResolved: boolean
) {
  if (prefixResolved) {
    return { delta: chunk, pendingPrefix, prefixResolved };
  }

  const combined = pendingPrefix + chunk;
  const trimmedLeading = combined.replace(/^\s+/, "");
  const nameLower = participantName.trim().toLowerCase();
  const trimmedLower = trimmedLeading.toLowerCase();

  if (!nameLower) {
    return { delta: combined, pendingPrefix: "", prefixResolved: true };
  }

  if (trimmedLower.startsWith(`${nameLower}:`) || trimmedLower.startsWith(`${nameLower}：`)) {
    return {
      delta: stripCharacterPrefix(combined, participantName),
      pendingPrefix: "",
      prefixResolved: true
    };
  }

  if (nameLower.startsWith(trimmedLower) || `${nameLower}:`.startsWith(trimmedLower) || `${nameLower}：`.startsWith(trimmedLower)) {
    return { delta: "", pendingPrefix: combined, prefixResolved: false };
  }

  return { delta: combined, pendingPrefix: "", prefixResolved: true };
}

function emitSanitizedGroupDelta(
  rawContent: string,
  emittedContent: string,
  participantName: string,
  participantNames: string[]
) {
  const sanitizedContent = sanitizeGroupReplyContent(rawContent, participantName, participantNames);
  const nextDelta = sanitizedContent.slice(emittedContent.length);
  return {
    sanitizedContent,
    nextDelta
  };
}

async function requireAuthenticatedSession(request: Request) {
  const session = await validateSession(request.header("X-Session-Token"));
  if (!session) {
    throw new ApiError(401, "AUTH_REQUIRED", "Sign in required.");
  }

  return session;
}



function createMessageId() {
  return `msg_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`;
}

function memoryTargetId(scope: MemoryScope, value: Partial<MemoryRecord>) {
  if (scope === "character") return value.characterId;
  if (scope === "chat") return value.chatId;
  if (scope === "group") return value.groupChatId;
  return null;
}

async function assertMemoryTarget(userId: string, scope: MemoryScope, value: Partial<MemoryRecord>) {
  const targetId = memoryTargetId(scope, value);
  if (scope === "user" || scope === "daily") return;
  if (!targetId) throw new ApiError(400, "BAD_REQUEST", "Memory target is required.");
  if (scope === "character") {
    const state = await readUserWorkspaceState(userId);
    if (!isFactoryId(targetId) && !state.characters.some((character) => character.id === targetId)) {
      throw new ApiError(404, "BAD_REQUEST", "Character was not found.");
    }
    return;
  }
  const target = scope === "chat"
    ? await readStoredChat(userId, targetId)
    : await readStoredGroupChat(userId, targetId);
  if (!target) throw new ApiError(404, "BAD_REQUEST", "Chat was not found.");
}

function readPublicRouteStatus() {
  try {
    return JSON.parse(readFileSync(publicRouteStatusPath, "utf8"));
  } catch {
    return {
      activePublicUrl: "",
      temporaryPublicUrl: "",
      preferredPublicUrl: "",
      preferredRecoveredUrl: "",
      preferredRecoveredAt: "",
      redirectAfter: "",
      mode: "idle"
    };
  }
}

async function appendEntriesForUser(userId: string | null, entries: DailyLogEntry[]) {
  if (!userId || !entries.length) {
    return;
  }

  await appendDailyLogEntries(userId, entries);
}

async function autoExtractFactsForUser(userId: string | null, text: string, origin: { chatId?: string; groupChatId?: string; messageId?: string }) {
  if (!userId || !(await autoMemoryAllowed(userId, origin))) return;
  if (!userId || !text.trim()) {
    return;
  }

  if (parseExplicitMemoryCommand(text)) {
    return;
  }

  const facts = extractMemoryFactsFromText(text)
    .filter((fact) => (fact.confidence ?? 0) >= AUTO_MEMORY_CONFIDENCE_THRESHOLD)
    .map((fact) => ({
      ...fact,
      source: fact.source || "auto-extract"
    }));

  if (!facts.length) {
    return;
  }

  await Promise.all(facts.map((fact) => createMemoryRecord(userId, {
    scope: origin.groupChatId ? "group" : "chat",
    chatId: origin.chatId, groupChatId: origin.groupChatId, sourceMessageId: origin.messageId,
    text: fact.fact,
    kind: fact.kind === "profile" || fact.kind === "preference" || fact.kind === "goal" ? fact.kind : "context",
    source: fact.source || "auto-extract",
    createdBy: "system",
    confidence: fact.confidence ?? 0.8,
    importance: 0.65,
    characterId: fact.characterId
  })));
}

async function rememberExplicitly(
  userId: string,
  text: string,
  context: { characterId?: string | null; chatId?: string | null; groupChatId?: string | null }
) {
  const command = parseExplicitMemoryCommand(text, context);
  if (!command) return null;
  const record = await createMemoryRecord(userId, {
    ...command,
    kind: "context",
    source: "explicit-command",
    createdBy: "user",
    pinned: true,
    confidence: 1,
    importance: 1
  });
  return { command, record, confirmation: formatMemoryConfirmation(command, "явная команда пользователя") };
}

type ChatGenerationAction = "send" | "regenerate" | "continue";

type PreparedChatGeneration = {
  userId: string;
  action: ChatGenerationAction;
  request: ChatRequest;
  storedChat: StoredChatTranscript | null;
  contextReport?: ContextReport;
  originalHistory?: ChatRequest["history"];
  targetMessageId?: string;
  targetRole?: "user" | "assistant";
};

const transcriptMessages = (messages: StoredChatTranscript["messages"]) =>
  messages.map((message) => ({
    id: message.id,
    role: message.role,
    content: message.content,
    image: message.image,
    createdAt: message.createdAt
  }));

function deepestBranchLeaf(chat: StoredChatTranscript, messageId: string) {
  let currentId = messageId;
  for (;;) {
    const child = [...chat.messages].reverse().find((message) => message.parentId === currentId);
    if (!child) return currentId;
    currentId = child.id;
  }
}

async function prepareChatGeneration(userId: string, requestBody: ChatRequest): Promise<PreparedChatGeneration> {
  if (requestBody.image !== undefined && !validChatImage(requestBody.image)) throw new ApiError(400, "BAD_REQUEST", "Некорректное изображение. Добавьте его заново.");
  if (requestBody.history?.some(message => message.image !== undefined && (message.role !== "user" || !validChatImage(message.image)))) throw new ApiError(400, "BAD_REQUEST", "Некорректное изображение в истории.");
  const action = requestBody.action || "send";
  const chatId = (requestBody.chatId || "").trim();
  const storedChat = chatId ? await readStoredChat(userId, chatId) : null;
  if (storedChat && requestBody.revision != null && requestBody.revision !== (storedChat.revision || 0)) {
    throw new ApiError(409, "BAD_REQUEST", "Chat changed in another tab. Reload and try again.");
  }

  if (action === "send") {
    return {
      userId,
      action,
      storedChat,
      request: {
        ...requestBody,
        history: storedChat ? transcriptMessages(activeChatMessages(storedChat)) : requestBody.history
      }
    };
  }

  if (!storedChat) {
    throw new ApiError(404, "BAD_REQUEST", "Chat transcript was not found.");
  }

  const activeMessages = activeChatMessages(storedChat);
  const targetMessageId = (requestBody.targetMessageId || "").trim();
  const targetIndex = activeMessages.findIndex((message) => message.id === targetMessageId);
  if (targetIndex < 0 || targetIndex !== activeMessages.length - 1) {
    throw new ApiError(400, "BAD_REQUEST", "Only the latest chat turn can be changed.");
  }

  const target = activeMessages[targetIndex];
  if (!target) {
    throw new ApiError(400, "BAD_REQUEST", "The selected message was not found.");
  }

  if (action === "continue") {
    if (target.role !== "assistant") {
      throw new ApiError(400, "BAD_REQUEST", "Only an assistant reply can be continued.");
    }
    return {
      userId,
      action,
      storedChat,
      targetMessageId,
      targetRole: "assistant",
      request: {
        ...requestBody,
        image: undefined,
        history: transcriptMessages(activeMessages),
        userMessage: "Continue the last assistant reply from exactly where it ended. Output only new material. Do not restate, summarize, paraphrase, or repeat any sentence or passage from the existing reply. Do not add a speaker label. Stop after one concise continuation."
      }
    };
  }

  if (target.role === "user") {
    return {
      userId,
      action,
      storedChat,
      targetMessageId,
      targetRole: "user",
      request: {
        ...requestBody,
        history: transcriptMessages(activeMessages.slice(0, targetIndex)),
        image: target.image,
        userMessage: target.content
      }
    };
  }

  const userIndex = activeMessages
    .slice(0, targetIndex)
    .map((message, index) => ({ message, index }))
    .reverse()
    .find(({ message }) => message.role === "user")?.index;
  if (userIndex == null) {
    throw new ApiError(400, "BAD_REQUEST", "A user message is required before regenerating a reply.");
  }

  return {
    userId,
    action,
      storedChat,
      targetMessageId,
      targetRole: "assistant",
    request: {
      ...requestBody,
      history: transcriptMessages(activeMessages.slice(0, userIndex)),
      image: activeMessages[userIndex].image,
      userMessage: activeMessages[userIndex].content
    }
  };
}

async function persistChatGeneration(
  userId: string,
  prepared: PreparedChatGeneration,
  content: string,
  completed: boolean
) {
  const requestBody = prepared.request;
  const chatId = (requestBody.chatId || "").trim();
  if (!chatId) return null;

  const timestamp = new Date().toISOString();

  if (prepared.action === "send") {
    const apply = (chat: StoredChatTranscript | null) => {
      if (chat && requestBody.revision != null && requestBody.revision !== (chat.revision || 0)) {
        throw new ApiError(409, "BAD_REQUEST", "Chat changed while the reply was being generated.");
      }
      const baseMessages = chat ? chat.messages : (prepared.originalHistory || requestBody.history || []).map((message, index, source) => ({
        id: message.id || createMessageId(),
        role: message.role === "assistant" ? "assistant" as const : "user" as const,
        content: message.content,
        image: message.image,
        createdAt: message.createdAt || timestamp,
        parentId: index ? source[index - 1]?.id || null : null
      }));
      const userMessageId = requestBody.userMessageId || createMessageId();
      const parentId = chat?.activeLeafId || baseMessages.at(-1)?.id || null;
      const messages = baseMessages.some((message) => message.id === userMessageId)
        ? [...baseMessages]
        : [...baseMessages, {
            id: userMessageId,
            role: "user" as const,
            content: requestBody.userMessage || "",
            image: requestBody.image,
            createdAt: requestBody.userMessageCreatedAt || timestamp,
            parentId
          }];
      let activeLeafId = userMessageId;
      if (content.trim()) {
        const assistantMessageId = requestBody.assistantMessageId || createMessageId();
        const existingIndex = messages.findIndex((message) => message.id === assistantMessageId);
        const assistantMessage = { contextReport: prepared.contextReport, id: assistantMessageId, role: "assistant" as const, content, createdAt: timestamp, parentId: userMessageId, authorCharacterId: requestBody.personaCharacterId || null, authorNameSnapshot: requestBody.personaName || null };
        if (existingIndex >= 0) messages[existingIndex] = assistantMessage;
        else messages.push(assistantMessage);
        activeLeafId = assistantMessageId;
      }
      return {
        id: chatId,
        title: chat?.title || normalizeChatTitle(requestBody.chatTitle, "Новый чат"),
        titleMode: chat?.titleMode || "default",
        pinnedAt: chat?.pinnedAt || null,
        modelProfileId: chat?.modelProfileId || null,
        archivedAt: chat?.archivedAt || null,
        tags: chat?.tags || [],
        characterId: requestBody.personaCharacterId || chat?.characterId || null,
        messages,
        activeLeafId,
        revision: (chat?.revision || 0) + 1,
        createdAt: chat?.createdAt || timestamp,
        updatedAt: timestamp
      };
    };
    const updated = await updateStoredChat(userId, chatId, apply);
    if (updated) return updated;
    const next = apply(null);
    await saveChatTranscript(userId, next);
    return next;
  }

  if (!prepared.targetMessageId || !prepared.storedChat) return null;
  const targetMessageId = prepared.targetMessageId;
  if (prepared.action === "regenerate" && !content.trim()) return prepared.storedChat;
  if (prepared.action === "continue" && !content.trim()) return prepared.storedChat;

  return updateStoredChat(userId, chatId, (chat) => {
    if (requestBody.revision != null && requestBody.revision !== (chat.revision || 0)) {
      throw new ApiError(409, "BAD_REQUEST", "Chat changed while the reply was being generated.");
    }
    if (prepared.action === "regenerate" && prepared.targetRole === "user") {
      const latest = activeChatMessages(chat).at(-1);
      if (!latest || latest.id !== targetMessageId || latest.role !== "user") {
        throw new ApiError(409, "BAD_REQUEST", "Chat changed while the reply was being generated.");
      }
      const assistantMessageId = requestBody.assistantMessageId || createMessageId();
      return {
        ...chat,
        messages: [
          ...chat.messages,
          {
            id: assistantMessageId,
            contextReport: prepared.contextReport,
            role: "assistant" as const,
            content,
            createdAt: timestamp,
            parentId: targetMessageId,
            authorCharacterId: requestBody.personaCharacterId || null,
            authorNameSnapshot: requestBody.personaName || null
          }
        ],
        activeLeafId: assistantMessageId,
        revision: (chat.revision || 0) + 1,
        updatedAt: timestamp
      };
    }

    if (prepared.action === "regenerate") {
      const target = chat.messages.find((message) => message.id === targetMessageId);
      if (!target) return chat;
      const assistantMessageId = requestBody.assistantMessageId || createMessageId();
      return {
        ...chat,
        messages: [...chat.messages, { contextReport: prepared.contextReport, id: assistantMessageId, role: "assistant" as const, content, createdAt: timestamp, parentId: target.parentId || null, authorCharacterId: requestBody.personaCharacterId || null, authorNameSnapshot: requestBody.personaName || null }],
        activeLeafId: assistantMessageId,
        revision: (chat.revision || 0) + 1,
        updatedAt: timestamp
      };
    }

    const messages = appendToLatestAssistantMessage(chat.messages, targetMessageId, content)?.map(message => message.id === targetMessageId ? { ...message, contextReport: prepared.contextReport } : message);
    if (!messages) return chat;
    return {
      ...chat,
      messages,
      revision: (chat.revision || 0) + 1,
      updatedAt: timestamp
    };
  });
}

async function saveGroupChatTranscriptForRequest(
  userId: string,
  requestBody: GroupChatRequest,
  replies: Array<{ characterId: string; characterName: string; content: string }>,
  expectedRevision: number,
  pendingSpeakerIds: string[] = []
) {
  const groupChatId = (requestBody.groupChatId || "").trim();
  if (!groupChatId) {
    return;
  }

  const timestamp = new Date().toISOString();
  const historyMessages = (requestBody.messages || []).map((message) => {
    const role: "user" | "assistant" = message.role === "assistant" ? "assistant" : "user";
    return {
      id: message.id || createMessageId(),
      contextReport: message.contextReport,
      role,
      content: message.content,
      createdAt: timestamp,
      characterId: message.characterId,
      characterName: message.characterName
    };
  });

  const saved = await saveGroupChatTranscript(userId, {
    id: groupChatId,
    pendingSpeakerIds,
    sceneDeadlineAt: requestBody.sceneDeadlineAt ?? null,
    title: (requestBody.groupChatTitle || "").trim() || "Group chat",
    participantIds: (requestBody.participants || []).map((participant) => participant.id),
    activeSpeakerCharacterId:
      replies.at(-1)?.characterId ||
      requestBody.activeSpeakerCharacterId ||
      null,
    messages: [
      ...historyMessages,
      ...replies.map((reply) => ({
        id: createMessageId(),
        role: "assistant" as const,
        content: reply.content,
        createdAt: timestamp,
        characterId: reply.characterId,
        characterName: reply.characterName,
        contextReport: requestBody.participants.find(participant => participant.id === reply.characterId)?.contextReport
      }))
    ],
    responseMode: requestBody.responseMode,
    maxRepliesPerTurn: requestBody.maxRepliesPerTurn,
    createdAt: timestamp,
    updatedAt: timestamp
  }, undefined, expectedRevision);
  await markMemoryAccess(userId, (requestBody.participants || []).flatMap(participant => participant.contextReport?.memory.map(record => record.id) || []));
  return saved;
}

async function groupGenerationRevision(userId: string, requestBody: GroupChatRequest) {
  delete requestBody.remainingParticipantIds;
  delete requestBody.sceneDeadlineAt;
  if (requestBody.resumeScene !== undefined && typeof requestBody.resumeScene !== "boolean") throw new ApiError(400, "BAD_REQUEST", "Некорректное продолжение сцены.");
  if (requestBody.skippedParticipantIds !== undefined) {
    const skipped = requestBody.skippedParticipantIds;
    if (!Array.isArray(skipped) || skipped.length > (requestBody.participants?.length || 0) || !skipped.every(id => typeof id === "string" && requestBody.participants?.some(participant => participant.id === id))) throw new ApiError(400, "BAD_REQUEST", "Некорректный список пропуска участников.");
    if (!planGroupTurn(requestBody).length) throw new ApiError(400, "NO_PARTICIPANTS", "На этот ход пропущены все выбранные спикеры. Верните хотя бы одного в очередь.");
  }

  if (!requestBody.groupChatId) return 0;
  if (await isStoredTranscriptDeleted(userId, requestBody.groupChatId, "group-chat")) throw new TranscriptDeletedError();
  const stored = await readStoredGroupChat(userId, requestBody.groupChatId);
  if (!stored) {
    if (requestBody.resumeScene) throw new ApiError(409, "BAD_REQUEST", "Нет сохранённой сцены для продолжения.");
    requestBody.messages = (requestBody.messages || []).map(message => ({ ...message, id: message.id || createMessageId(), contextReport: undefined }));
    return 0;
  }
  requestBody.sceneDeadlineAt = requestBody.resumeScene ? stored.sceneDeadlineAt ?? null : stored.sceneTimeLimitSeconds ? Date.now() + stored.sceneTimeLimitSeconds * 1000 : null;
  if (requestBody.sceneDeadlineAt && Date.now() >= requestBody.sceneDeadlineAt) throw new ApiError(409, "BAD_REQUEST", "Время сцены истекло. Начните новый ход.");
  // A request from an already stale tab must not replace newer server history.
  const history = Array.isArray(requestBody.messages) ? requestBody.messages : [];
  if (stored.messages.some((message, index) => {
    const candidate = history[index];
    return !candidate || candidate.role !== message.role || candidate.content !== message.content ||
      (candidate.characterId || "") !== (message.characterId || "");
  })) throw new TranscriptConflictError(stored.revision ?? 0);
  if (requestBody.resumeScene) {
    if (requestBody.revision !== (stored.revision || 0)) throw new TranscriptConflictError(stored.revision || 0);
    if (!stored.pendingSpeakerIds?.length || history.length !== stored.messages.length) throw new ApiError(409, "BAD_REQUEST", "Сцена изменилась или уже завершена. Обновите комнату.");
    if (stored.pendingSpeakerIds.some(id => !requestBody.participants?.some(participant => participant.id === id))) throw new ApiError(409, "BAD_REQUEST", "Состав участников изменился. Начните новый ход.");
    requestBody.remainingParticipantIds = stored.pendingSpeakerIds;
  }
  requestBody.messages = history.map((message, index) => stored.messages[index] || { ...message, id: message.id || createMessageId(), contextReport: undefined });
  return stored.revision ?? 0;
}

async function autoMemoryAllowed(userId: string, origin: { chatId?: string; groupChatId?: string; messageId?: string }) {
  const id = origin.groupChatId || origin.chatId;
  if (!id || !origin.messageId) return false;
  const policy = await readMemoryPolicy(userId, origin.groupChatId ? "group" : "chat", id);
  return !policy.disabled && !policy.excludedMessageIds.includes(origin.messageId);
}

async function scopedContextRecords(userId: string, kind: "chat" | "group", id: string, characterId: string | null | undefined, history: Array<{ id?: string }>) {
  const ids = new Set(history.map(message => message.id));
  return (await listMemoryRecords(userId)).filter(record => record.source !== "automatic-summary" &&
    (record.scope === "user" || (record.scope === "character" && record.characterId === characterId) ||
     (kind === "chat" && record.scope === "chat" && record.chatId === id) || (kind === "group" && record.scope === "group" && record.groupChatId === id)) &&
    (record.sourceMessageId ? ids.has(record.sourceMessageId) : !["auto-extract", "character-episode", "legacy-character-memory", "legacy-summary-memory"].includes(record.source)));
}

async function enrichChatRequestWithMemory(request: Request) {
  const session = await requireAuthenticatedSession(request);
  request.body.userMessageId ||= createMessageId();
  return { userId: session.userId, chatRequest: { ...request.body, history: Array.isArray(request.body.history) ? request.body.history : [] } };
}

async function composePreparedContext(prepared: PreparedChatGeneration) {
  const request = prepared.request;
  const saved = await readSettings();
  const workspace = await readUserWorkspaceState(prepared.userId);
  const character = workspace.characters.find(card => card.id === request.personaCharacterId) || null;
  if (prepared.storedChat?.modelProfileId || character?.modelProfileId) {
    let effective;
    try { effective = resolveProfile(saved, character, prepared.storedChat?.modelProfileId); }
    catch (error) { throw new ApiError(400, "BAD_REQUEST", error instanceof Error ? error.message : "Профиль недоступен."); }
    request.settings = effective; request.model = effective.modelId;
    request.temperature = effective.temperature; request.maxTokens = effective.maxTokens;
  }
  const policy = await readMemoryPolicy(prepared.userId, "chat", request.chatId || "");
  const records = await scopedContextRecords(prepared.userId, "chat", request.chatId || "", request.personaCharacterId, request.history);
  const settings = await readSettings();
  try {
    const composed = composeContext({ systemPrompt: request.personaSystemPrompt || "", userMessage: request.userMessage || "", image: request.image, history: request.history, records, policy, reserveTokens: Number(request.maxTokens ?? request.settings?.maxTokens ?? settings.maxTokens) });
    prepared.originalHistory = request.history;
    prepared.contextReport = composed.report;
    prepared.request = { ...request, history: composed.history, personaSystemPrompt: composed.systemPrompt };
  } catch (error) { throw new ApiError(400, "BAD_REQUEST", `Контекст не помещается: увеличьте окно или уменьшите резерв ответа. ${error instanceof Error ? error.message : ""}`); }
  if (prepared.request.image || prepared.request.history.some(message => message.image)) {
    const options = resolveChatOptions(prepared.request, saved);
    await verifyVisionSupport(options.baseUrl, options.model);
  }
}

async function enrichGroupParticipantsWithMemory(userId: string, request: GroupChatRequest) {
  const policy = await readMemoryPolicy(userId, "group", request.groupChatId || "");
  const settings = await readSettings();
  const room = request.groupChatId ? await readStoredGroupChat(userId, request.groupChatId) : null;
  const workspace = await readUserWorkspaceState(userId);
  const participants = await Promise.all((request.participants || []).map(async participant => {
    const card = workspace.characters.find(value => value.id === participant.id) || null;
    let resolvedSettings: AppSettings | undefined;
    if (room?.modelProfileId || card?.modelProfileId) {
      try { resolvedSettings = resolveProfile(settings, card, room?.modelProfileId); }
      catch (error) { throw new ApiError(400, "BAD_REQUEST", error instanceof Error ? error.message : "Профиль недоступен."); }
    }
    return { ...participant, systemPrompt: [participant.systemPrompt, roomDiscussionPrompt(room, participant.id)].filter(Boolean).join("\n\n"), resolvedSettings, contextReport: undefined, memoryPolicy: policy,
      responseReserve: Number(resolvedSettings?.maxTokens ?? request.maxTokens ?? request.settings?.maxTokens ?? settings.maxTokens),
      memoryRecords: await scopedContextRecords(userId, "group", request.groupChatId || "", participant.id, request.messages || []) };
  }));
  request.participants = participants;
  return participants;
}

function generationSignal(response: import("express").Response) {
  const controller = new AbortController();
  if (response.destroyed) controller.abort();
  response.once("close", () => { if (!response.writableEnded) controller.abort(); });
  return controller.signal;
}

app.use(cors());
app.use(["/api/backup", "/api/chat/mutate"], async (request, response, next) => {
  response.setHeader("Cache-Control", "no-store");
  try {
    if (!isValidServerToken(serverToken, request.header("X-Server-Token"))) {
      throw new ApiError(401, "BAD_REQUEST", "Missing or invalid server token.");
    }
    await requireAuthenticatedSession(request);
    next();
  } catch (error) { next(error); }
}, express.json({ limit: "51mb" }));
app.use(express.json({ limit: "1mb" }));
app.use((request, response, next) => {
  if (
    request.method !== "GET" ||
    !request.path.startsWith("/assets/") ||
    !acceptsGzip(request)
  ) {
    next();
    return;
  }

  const assetPath = resolve(distPath, `.${request.path}`);
  const contentType = staticAssetContentType(assetPath);

  if (!contentType || !isSafeAssetPath(assetPath) || !existsSync(assetPath) || !statSync(assetPath).isFile()) {
    next();
    return;
  }

  response.setHeader("Content-Type", contentType);
  response.setHeader("Content-Encoding", "gzip");
  response.setHeader("Vary", "Accept-Encoding");

  pipeline(createReadStream(assetPath), createGzip({ level: 6 }), response, (error) => {
    if (error && !response.headersSent) {
      next(error);
    }
  });
});
app.use("/api", (request, response, next) => {
  response.setHeader("Cache-Control", "no-store");
  if (isValidServerToken(serverToken, request.header("X-Server-Token"))) {
    next();
    return;
  }

  response.status(401).json({
    error: {
      code: "BAD_REQUEST",
      message: "Missing or invalid server token."
    }
  });
});

app.get("/api/characters/:id/versions", async (request, response, next) => {
  try {
    const session = await requireAuthenticatedSession(request);
    const id = request.params.id;
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(id)) throw new ApiError(400, "BAD_REQUEST", "Invalid character ID.");
    response.json({ versions: await readCharacterVersions(session.userId, id) });
  } catch (error) { next(error); }
});

app.post("/api/characters/test", async (request, response, next) => {
  try {
    await requireAuthenticatedSession(request);
    let card;
    try { card = resolveStudioCard(request.body?.card, request.body?.locale); }
    catch (error) { throw new ApiError(400, "BAD_REQUEST", error instanceof Error ? error.message : "Invalid card."); }
    const text = request.body?.userMessage;
    if (typeof text !== "string" || !text.trim() || text.length > 10000) throw new ApiError(400, "BAD_REQUEST", "Введите тестовое сообщение до 10000 символов.");
    const saved = await readSettings();
    let effective;
    try { effective = resolveProfile(card.modelProfileId ? saved : { ...saved, ...request.body.settings }, card); }
    catch (error) { throw new ApiError(400, "BAD_REQUEST", error instanceof Error ? error.message : "Профиль недоступен."); }
    const content = await requestChatCompletion({ personaSystemPrompt: buildCharacterPrompt(card), personaName: card.name, history: card.firstMessage?.trim() ? [{ role: "assistant", content: card.firstMessage }] : [], userMessage: text, settings: effective, temperature: effective.temperature, maxTokens: effective.maxTokens }, saved, generationSignal(response));
    response.json({ content });
  } catch (error) { next(error); }
});
app.post("/api/characters/start-chat", async (request, response, next) => {
  try {
    const session = await requireAuthenticatedSession(request);
    let card;
    try { card = resolveStudioCard(request.body?.card, request.body?.locale); }
    catch (error) { throw new ApiError(400, "BAD_REQUEST", error instanceof Error ? error.message : "Invalid card."); }
    const now = new Date().toISOString();
    const greeting = card.firstMessage?.trim();
    const messages: StoredChatTranscript["messages"] = greeting ? [{ id: createMessageId(), role: "assistant", content: greeting, parentId: null, createdAt: now, authorCharacterId: card.id, authorNameSnapshot: card.name }] : [];
    const chat = await saveChatTranscript(session.userId, { id: createMessageId(), title: normalizeChatTitle(request.body?.title, "Новый чат"), titleMode: "default", characterId: card.id, messages, activeLeafId: messages.at(-1)?.id || null, revision: 0, createdAt: now, updatedAt: now });
    response.status(201).json({ chat: clientChatTranscript(chat) });
  } catch (error) { next(error); }
});

app.get("/api/text-files", async (request, response, next) => {
  try { const session = await requireAuthenticatedSession(request); response.json({ files: await listSavedTextFiles(session.userId) }); } catch (error) { next(error); }
});
app.post("/api/text-files", async (request, response, next) => {
  try { const session = await requireAuthenticatedSession(request); response.status(201).json({ file: await saveTextFile(session.userId, request.body?.name, request.body?.text) }); } catch (error) { next(error); }
});
app.get("/api/text-files/:id", async (request, response, next) => {
  try { const session = await requireAuthenticatedSession(request); response.json({ file: await readSavedTextFile(session.userId, request.params.id) }); } catch (error) { next(error); }
});
app.delete("/api/text-files/:id", async (request, response, next) => {
  try { const session = await requireAuthenticatedSession(request); await deleteSavedTextFile(session.userId, request.params.id); response.status(204).end(); } catch (error) { next(error); }
});

app.get("/api/memory-policy/:kind/:id", async (request, response, next) => {
  try {
    const session = await requireAuthenticatedSession(request);
    const { kind, id } = request.params;
    if ((kind !== "chat" && kind !== "group") || !/^[A-Za-z0-9_-]{1,128}$/.test(id)) throw new ApiError(400, "BAD_REQUEST", "Invalid memory policy target.");
    response.json(await readMemoryPolicy(session.userId, kind, id));
  } catch (error) { next(error); }
});
app.patch("/api/memory-policy/:kind/:id", async (request, response, next) => {
  try {
    const session = await requireAuthenticatedSession(request);
    const { kind, id } = request.params;
    if (kind !== "chat" && kind !== "group") throw new ApiError(400, "BAD_REQUEST", "Invalid memory policy target.");
    response.json(await updateMemoryPolicy(session.userId, kind, id, request.body));
  } catch (error) { next(error instanceof ApiError ? error : new ApiError(400, "BAD_REQUEST", error instanceof Error ? error.message : "Invalid memory policy.")); }
});

app.get("/api/backup", async (request, response, next) => {
  try {
    const session = await requireAuthenticatedSession(request);
    response.json(await exportUserBackup(session.userId));
  } catch (error) { next(error); }
});

app.post("/api/backup/inspect", (request, response, next) => {
  try { response.json(inspectUserBackup(request.body?.backup)); }
  catch (error) { next(error); }
});

app.post("/api/backup/restore", async (request, response, next) => {
  try {
    const { backup, username, password } = request.body || {};
    if (typeof username !== "string" || typeof password !== "string") {
      throw new ApiError(400, "BAD_REQUEST", "Username and password are required.");
    }
    const credential = await restoreUserBackup(backup, username, password);
    const session = await createSessionForUser(credential.userId, credential.username);
    response.status(201).json({ success: true, ...session });
  } catch (error) {
    if (error instanceof Error && /already taken/i.test(error.message)) {
      next(new ApiError(409, "USERNAME_TAKEN", error.message));
    } else if (error instanceof Error && /^(Username|Password)/.test(error.message)) {
      next(new ApiError(400, "BAD_REQUEST", error.message));
    } else { next(error); }
  }
});

app.get("/api/health", (_request, response) => {
  response.json({
    ok: true,
    service: "local-ai-chat",
    time: new Date().toISOString(),
    pid: process.pid,
    uptimeSec: Math.floor((Date.now() - serverStartedAt) / 1000)
  });
});

app.get("/api/ready", async (_request, response, next) => {
  try {
    await readSettings();
    response.json({
      ready: true,
      checks: {
        settings: true,
        userDataRoot: true
      },
      time: new Date().toISOString(),
      pid: process.pid
    });
  } catch (error) {
    if (response.headersSent) {
      const message = error instanceof Error ? error.message : "Chat stream interrupted.";
      response.write(`event: error\ndata: ${JSON.stringify({ message })}\n\n`);
      response.end();
      return;
    }
    next(error);
  }
});

app.get("/api/public-route-status", (_request, response) => {
  response.json(readPublicRouteStatus());
});

app.get("/api/settings", async (_request, response, next) => {
  try {
    response.json(await readSettings());
  } catch (error) {
    next(error);
  }
});

app.post("/api/auth/register", async (request, response, next) => {
  try {
    const payload = request.body as Partial<AuthCredentialsPayload>;
    const username = (payload.username || "").trim();
    const password = payload.password || "";

    if (!username || !password) {
      throw new ApiError(400, "BAD_REQUEST", "Username and password are required.");
    }

    const credential = await registerUser(username, password);
    const session = await createSessionForUser(credential.userId, credential.username);

    response.status(201).json({
      success: true,
      showStudioWelcome: true,
      userId: credential.userId,
      username: credential.username,
      sessionToken: session.sessionToken,
      expiresAt: session.expiresAt
    });
  } catch (error) {
    if (error instanceof Error && /already taken/i.test(error.message)) {
      next(new ApiError(409, "USERNAME_TAKEN", error.message));
      return;
    }

    if (error instanceof Error && /(Username|Password)/i.test(error.message)) {
      next(new ApiError(400, "BAD_REQUEST", error.message));
      return;
    }

    next(error);
  }
});

app.post("/api/auth/login", async (request, response, next) => {
  try {
    const payload = request.body as Partial<AuthCredentialsPayload>;
    const username = (payload.username || "").trim();
    const password = payload.password || "";

    if (!username || !password) {
      throw new ApiError(400, "BAD_REQUEST", "Username and password are required.");
    }

    const credential = await findCredentialByUsername(username);
    if (!credential || !verifyPassword(password, credential.passwordHash)) {
      throw new ApiError(401, "AUTH_INVALID", "Invalid username or password.");
    }

    const session = await createSessionForUser(credential.userId, credential.username);
    response.json({
      success: true,
      showStudioWelcome: await claimStudioWelcome(credential),
      userId: credential.userId,
      username: credential.username,
      sessionToken: session.sessionToken,
      expiresAt: session.expiresAt
    });
  } catch (error) {
    next(error);
  }
});

app.post("/api/auth/logout", async (request, response, next) => {
  try {
    const sessionToken = request.header("X-Session-Token") || "";
    await revokeSession(sessionToken);
    response.json({ success: true });
  } catch (error) {
    next(error);
  }
});

app.get("/api/auth/session", async (request, response, next) => {
  try {
    const sessionToken = request.header("X-Session-Token") || "";
    const session = await validateSession(sessionToken);

    if (!session) {
      throw new ApiError(401, "AUTH_REQUIRED", "Session is missing or expired.");
    }

    response.json({
      authenticated: true,
      userId: session.userId,
      username: session.username,
      expiresAt: session.expiresAt
    });
  } catch (error) {
    next(error);
  }
});

app.post("/api/settings", async (request, response, next) => {
  try {
    const session = await requireAuthenticatedSession(request);
    if (session.userId !== "u_admin") throw new ApiError(403, "BAD_REQUEST", "Общие настройки может менять только администратор.");
    const current = await readSettings();
    let nextSettings: AppSettings;
    try { nextSettings = validateSettingsPatch(current, request.body); }
    catch (error) { throw new ApiError(400, "BAD_REQUEST", error instanceof Error ? error.message : "Invalid settings."); }
    response.json(await writeSettings(nextSettings));
  } catch (error) {
    next(error);
  }
});

app.get("/api/models", async (request, response, next) => {
  try {
    await requireAuthenticatedSession(request);
    const settings = await readSettings();
    const baseUrl = typeof request.query.baseUrl === "string" ? request.query.baseUrl : settings.baseUrl;
    response.json(await fetchModels(baseUrl));
  } catch (error) {
    next(error);
  }
});

app.post("/api/user-state", async (request, response, next) => {
  try {
    const session = await requireAuthenticatedSession(request);
    const payload = request.body as UserStateSyncPayload;
    if (!payload || !Number.isSafeInteger(payload.revision) || payload.revision! < 0 ||
        !payload.userProfile || !Array.isArray(payload.characters) || !Array.isArray(payload.chatSummaries)) {
      throw new ApiError(400, "BAD_REQUEST", "Workspace revision and complete state are required.");
    }
    payload.userProfile = {
      ...payload.userProfile,
      id: session.userId,
      label: session.username,
      updatedAt: new Date().toISOString()
    };
    const saved = await syncUserWorkspace(payload);
    response.json({ ok: true, userId: session.userId, revision: saved.revision });
  } catch (error) {
    next(error);
  }
});

app.get("/api/user-state", async (request, response, next) => {
  try {
    const session = await requireAuthenticatedSession(request);
    const state = await readUserWorkspaceState(session.userId);
    const visible = await Promise.all(state.chatSummaries.map(async (summary) =>
      await isStoredTranscriptDeleted(session.userId, summary.id, summary.kind) ? null : summary));
    response.json({ ...state, chatSummaries: visible.filter(Boolean) });
  } catch (error) {
    next(error);
  }
});

app.get("/api/chat-state", async (request, response, next) => {
  try {
    const session = await requireAuthenticatedSession(request);
    response.json({
      chats: (await listStoredChats(session.userId)).map(clientChatTranscript),
      groupChats: await listStoredGroupChats(session.userId)
    });
  } catch (error) {
    next(error);
  }
});

app.delete("/api/chats/:chatId", async (request, response, next) => {
  try {
    const session = await requireAuthenticatedSession(request);
    await deleteStoredChat(session.userId, String(request.params.chatId));
    response.json({ ok: true });
  } catch (error) { next(error); }
});

app.delete("/api/group-chats/:groupChatId", async (request, response, next) => {
  try {
    const session = await requireAuthenticatedSession(request);
    await deleteStoredGroupChat(session.userId, String(request.params.groupChatId));
    response.json({ ok: true });
  } catch (error) { next(error); }
});

app.put("/api/group-chats/:groupChatId", async (request, response, next) => {
  try {
    const session = await requireAuthenticatedSession(request);
    const groupChatId = typeof request.params.groupChatId === "string" ? request.params.groupChatId.trim() : "";
    const payload = request.body as Partial<StoredGroupChatTranscript>;
    if (!payload || !Number.isSafeInteger(payload.configRevision) || payload.configRevision! < 0) {
      throw new ApiError(400, "BAD_REQUEST", "Group configuration revision is required.");
    }
    if (!groupChatId) throw new ApiError(400, "BAD_REQUEST", "Group chat ID is required.");
    if (payload.modelProfileId != null && payload.modelProfileId !== "" && (typeof payload.modelProfileId !== "string" || !(await readSettings()).modelProfiles?.some(profile => profile.id === payload.modelProfileId))) throw new ApiError(400, "BAD_REQUEST", "Профиль группы недоступен.");
    if (payload.responseMode !== "single-speaker" && payload.responseMode !== "round-robin") {
      throw new ApiError(400, "BAD_REQUEST", "Unsupported group response mode.");
    }
    if (!Array.isArray(payload.participantIds) || !payload.participantIds.every((id) => typeof id === "string")) {
      throw new ApiError(400, "BAD_REQUEST", "Group participants are invalid.");
    }

    if (!validRoomDiscussion(payload, payload.participantIds)) throw new ApiError(400, "BAD_REQUEST", "Проверьте настройки комнаты: время 0–3600 секунд, правила до 4000 символов, роль до 500 символов.");
    const existing = await readStoredGroupChat(session.userId, groupChatId);
    const timestamp = new Date().toISOString();
    const groupChat = await saveGroupChatConfig(session.userId, {
      configRevision: payload.configRevision,
      sceneTimeLimitSeconds: payload.sceneTimeLimitSeconds ?? existing?.sceneTimeLimitSeconds ?? 0,
      roomRules: payload.roomRules ?? existing?.roomRules ?? "",
      participantRoles: payload.participantRoles ?? existing?.participantRoles ?? {},
      id: groupChatId,
      title: typeof payload.title === "string" ? payload.title : existing?.title || "Group chat",
      participantIds: payload.participantIds,
      activeSpeakerCharacterId:
        typeof payload.activeSpeakerCharacterId === "string" ? payload.activeSpeakerCharacterId : null,
      messages: existing?.messages || [],
      modelProfileId: payload.modelProfileId === undefined ? existing?.modelProfileId || null : payload.modelProfileId || null,
      responseMode: payload.responseMode,
      maxRepliesPerTurn: payload.participantIds.length ? validateGroupReplyLimit(payload.maxRepliesPerTurn, payload.participantIds.length) : 1,
      createdAt: existing?.createdAt || timestamp,
      updatedAt: timestamp
    });
    response.json({ groupChat });
  } catch (error) {
    next(error);
  }
});

app.get("/api/memory", async (request, response, next) => {
  try {
    const session = await requireAuthenticatedSession(request);
    const scope = typeof request.query.scope === "string" && isMemoryScope(request.query.scope)
      ? request.query.scope
      : null;
    const query = typeof request.query.query === "string" ? request.query.query.trim().toLocaleLowerCase() : "";
    const records = (await listMemoryRecords(session.userId))
      .filter((record) => !scope || record.scope === scope)
      .filter((record) => !query || record.text.toLocaleLowerCase().includes(query) || record.source.toLocaleLowerCase().includes(query))
      .sort((left, right) => Number(right.pinned) - Number(left.pinned) || Date.parse(right.updatedAt) - Date.parse(left.updatedAt));
    response.json({ records });
  } catch (error) {
    next(error);
  }
});

app.post("/api/memory", async (request, response, next) => {
  try {
    const session = await requireAuthenticatedSession(request);
    const payload = request.body as Partial<MemoryRecord>;
    if (!isMemoryScope(payload.scope) || !isMemoryKind(payload.kind) || typeof payload.text !== "string") {
      throw new ApiError(400, "BAD_REQUEST", "Memory record is invalid.");
    }
    await assertMemoryTarget(session.userId, payload.scope, payload);
    const record = await createMemoryRecord(session.userId, {
      scope: payload.scope,
      kind: payload.kind,
      text: payload.text,
      source: "memory-center",
      createdBy: "user",
      pinned: Boolean(payload.pinned),
      enabled: payload.enabled !== false,
      confidence: 1,
      importance: payload.pinned ? 1 : 0.8,
      characterId: payload.characterId,
      chatId: payload.chatId,
      groupChatId: payload.groupChatId
    });
    response.status(201).json({ record });
  } catch (error) {
    next(error);
  }
});

app.patch("/api/memory/:memoryId", async (request, response, next) => {
  try {
    const session = await requireAuthenticatedSession(request);
    const current = (await listMemoryRecords(session.userId)).find((record) => record.id === request.params.memoryId);
    if (!current) throw new ApiError(404, "BAD_REQUEST", "Memory record was not found.");
    const payload = request.body as Partial<MemoryRecord>;
    const scope = payload.scope === undefined ? current.scope : payload.scope;
    const kind = payload.kind === undefined ? current.kind : payload.kind;
    if (!isMemoryScope(scope) || !isMemoryKind(kind)) throw new ApiError(400, "BAD_REQUEST", "Memory update is invalid.");
    const target = { ...current, ...payload, scope, kind };
    if (scope !== current.scope || memoryTargetId(scope, target) !== memoryTargetId(current.scope, current)) {
      await assertMemoryTarget(session.userId, scope, target);
    }
    const record = await updateMemoryRecord(session.userId, current.id, {
      text: typeof payload.text === "string" ? payload.text : current.text,
      scope,
      kind,
      pinned: payload.pinned === undefined ? current.pinned : Boolean(payload.pinned),
      enabled: payload.enabled === undefined ? current.enabled : Boolean(payload.enabled),
      characterId: target.characterId,
      chatId: target.chatId,
      groupChatId: target.groupChatId
    });
    response.json({ record });
  } catch (error) {
    next(error);
  }
});

app.delete("/api/memory/:memoryId", async (request, response, next) => {
  try {
    const session = await requireAuthenticatedSession(request);
    if (!(await deleteMemoryRecord(session.userId, request.params.memoryId))) {
      throw new ApiError(404, "BAD_REQUEST", "Memory record was not found.");
    }
    response.json({ success: true });
  } catch (error) {
    next(error);
  }
});

app.get("/api/memory/export", async (request, response, next) => {
  try {
    const session = await requireAuthenticatedSession(request);
    response.setHeader("Content-Disposition", `attachment; filename="memory-${new Date().toISOString().slice(0, 10)}.json"`);
    response.json(await exportMemory(session.userId));
  } catch (error) {
    next(error);
  }
});

app.post("/api/memory/import", async (request, response, next) => {
  try {
    const session = await requireAuthenticatedSession(request);
    const payload = request.body as { records?: Array<Partial<MemoryRecord>> };
    if (!Array.isArray(payload?.records)) throw new ApiError(400, "BAD_REQUEST", "Memory backup is invalid.");
    for (const record of payload.records) {
      if (!isMemoryScope(record.scope)) throw new ApiError(400, "BAD_REQUEST", "Memory backup contains an invalid scope.");
      await assertMemoryTarget(session.userId, record.scope, record);
    }
    const records = await importMemory(session.userId, payload);
    response.json({ records });
  } catch (error) {
    if (error instanceof ApiError) next(error);
    else next(new ApiError(400, "BAD_REQUEST", error instanceof Error ? error.message : "Memory import failed."));
  }
});

app.post("/api/chat/mutate", async (request, response, next) => {
  try {
    const session = await requireAuthenticatedSession(request);
    const payload = request.body as ChatMutationRequest;
    const chatId = (payload.chatId || "").trim();
    const messageId = (payload.messageId || "").trim();
    if (payload.action === "import") {
      if (Buffer.byteLength(JSON.stringify(payload.importedChat) || "") > MAX_CHAT_IMPORT_BYTES) throw new ApiError(413, "BAD_REQUEST", "Резервная копия чата должна быть не больше 50 МБ.");
      const imported = validateImportedChat(payload.importedChat);
      const now = new Date().toISOString();
      const importedChat: StoredChatTranscript = {
        schemaVersion: 2,
        id: createMessageId(),
        title: `${String(imported.title).trim() || "Импортированный чат"} (импорт)`,
        characterId: typeof imported.characterId === "string" ? imported.characterId : null,
        titleMode: imported.titleMode === "auto" || imported.titleMode === "manual" ? imported.titleMode : "manual",
        pinnedAt: imported.pinnedAt || null,
        messages: imported.messages,
        activeLeafId: imported.activeLeafId ?? imported.messages.at(-1)?.id ?? null,
        revision: 0,
        createdAt: now,
        updatedAt: now,
        archivedAt: imported.archivedAt || null,
        tags: imported.tags || [],
        pinnedMessageIds: imported.pinnedMessageIds
      };
      const saved = await saveChatTranscript(session.userId, importedChat);
      response.json({ chat: clientChatTranscript(saved) });
      return;
    }
    if (payload.action === "rename" || payload.action === "pin-chat" || payload.action === "unpin-chat" || payload.action === "generate-title" || payload.action === "set-profile" || payload.action === "organize") {
      if (!chatId) throw new ApiError(400, "BAD_REQUEST", "A chat is required.");
      if (payload.action === "set-profile" || payload.action === "organize") {
        const id = payload.modelProfileId;
        if (payload.action === "set-profile" && id !== null && (typeof id !== "string" || !(await readSettings()).modelProfiles?.some(profile => profile.id === id))) throw new ApiError(400, "BAD_REQUEST", "Профиль недоступен.");
        let tags: string[] | undefined;
        if (payload.action === "organize") {
          if ((payload.archived === undefined && payload.tags === undefined) || (payload.archived !== undefined && typeof payload.archived !== "boolean")) throw new ApiError(400, "BAD_REQUEST", "Некорректные настройки организации чата.");
          try { if (payload.tags !== undefined) tags = normalizeChatTags(payload.tags); }
          catch (error) { throw new ApiError(400, "BAD_REQUEST", error instanceof Error ? error.message : "Некорректные теги."); }
        }
        const expected = payload.revision ?? 0;
        if (!Number.isSafeInteger(expected) || expected < 0) throw new ApiError(400, "BAD_REQUEST", "Некорректная версия чата.");
        const summary = (await readUserWorkspaceState(session.userId)).chatSummaries.find(chat => chat.id === chatId && chat.kind === "chat" && chat.messageCount === 0);
        const now = new Date().toISOString();
        const initial: StoredChatTranscript | undefined = summary ? { id: chatId, title: summary.title, characterId: typeof payload.characterId === "string" ? payload.characterId : null, messages: [], revision: 0, createdAt: now, updatedAt: now } : undefined;
        const updated = await updateStoredChat(session.userId, chatId, chat => {
          if (expected !== (chat.revision || 0)) throw new ApiError(409, "BAD_REQUEST", "Чат изменился. Обновите страницу.");
          return { ...chat, ...(payload.action === "set-profile" ? { modelProfileId: id } : { archivedAt: payload.archived === undefined ? chat.archivedAt : payload.archived ? chat.archivedAt || now : null, tags: tags ?? chat.tags }), revision: (chat.revision || 0) + 1 };
        }, undefined, initial);
        if (!updated) throw new ApiError(404, "BAD_REQUEST", "Chat transcript was not found.");
        response.json({ chat: clientChatTranscript(updated) });
        return;
      }
      const current = await readStoredChat(session.userId, chatId);
      if (!current && (payload.action === "rename" || payload.action === "pin-chat")) {
        const now = new Date().toISOString();
        const title = payload.action === "rename" ? normalizeChatTitle(payload.title, "") : "Новый чат";
        if (!title) throw new ApiError(400, "BAD_REQUEST", "Название не может быть пустым.");
        const created = await saveChatTranscript(session.userId, {
          schemaVersion: 2,
          id: chatId,
          title,
          titleMode: payload.action === "rename" ? "manual" : "default",
          pinnedAt: payload.action === "pin-chat" ? now : null,
          characterId: payload.characterId || null,
          messages: [],
          activeLeafId: null,
          revision: 1,
          createdAt: now,
          updatedAt: now,
          pinnedMessageIds: []
        });
        response.json({ chat: clientChatTranscript(created) });
        return;
      }
      if (!current) throw new ApiError(404, "BAD_REQUEST", "Chat transcript was not found.");
      if (payload.revision != null && payload.revision !== (current.revision || 0)) {
        throw new ApiError(409, "BAD_REQUEST", "Chat changed in another tab. Reload and try again.");
      }
      if (payload.automatic && (await readUserWorkspaceState(session.userId)).userProfile.autoNameNewChats === false) {
        response.json({ chat: clientChatTranscript(current) });
        return;
      }

      let generatedTitle = "";
      if (payload.action === "generate-title") {
        const activeMessages = activeChatMessages(current);
        const firstUser = activeMessages.find((message) => message.role === "user" && message.content.trim());
        const firstAssistant = activeMessages.find((message) => message.role === "assistant" && message.content.trim());
        if (!firstUser || !firstAssistant) throw new ApiError(400, "BAD_REQUEST", "Сначала нужен хотя бы один полный ответ модели.");
        const rawTitle = await requestChatCompletion({
          personaSystemPrompt: "Ты генератор коротких названий чатов. Верни только название из 3-6 слов, без кавычек, markdown и пояснений.",
          history: [],
          userMessage: `Пользователь: ${firstUser.content.slice(0, 500)}\nАссистент: ${firstAssistant.content.slice(0, 700)}`,
          temperature: 0.2,
          maxTokens: 32
        }, await readSettings());
        generatedTitle = normalizeGeneratedChatTitle(rawTitle);
        if (!generatedTitle) throw new ApiError(502, "BAD_REQUEST", "Модель не вернула корректное название.");
      }

      const updated = await updateStoredChat(session.userId, chatId, (chat) => {
        if (payload.revision != null && payload.revision !== (chat.revision || 0)) {
          throw new ApiError(409, "BAD_REQUEST", "Chat changed in another tab. Reload and try again.");
        }
        if (payload.action === "rename") {
          const title = normalizeChatTitle(payload.title, "");
          if (!title) throw new ApiError(400, "BAD_REQUEST", "Название не может быть пустым.");
          return { ...chat, title, titleMode: "manual", revision: (chat.revision || 0) + 1 };
        }
        if (payload.action === "pin-chat" || payload.action === "unpin-chat") {
          return { ...chat, pinnedAt: payload.action === "pin-chat" ? new Date().toISOString() : null, revision: (chat.revision || 0) + 1 };
        }
        if (payload.automatic && (chat.titleMode !== "default" || !["Новый чат", "New chat"].includes(chat.title))) return chat;
        return { ...chat, title: generatedTitle, titleMode: "auto", revision: (chat.revision || 0) + 1 };
      });
      if (!updated) throw new ApiError(404, "BAD_REQUEST", "Chat transcript was not found.");
      response.json({ chat: clientChatTranscript(updated) });
      return;
    }
    if (!chatId || !messageId || !["edit", "delete", "branch", "switch", "pin", "unpin"].includes(payload.action)) {
      throw new ApiError(400, "BAD_REQUEST", "Invalid chat mutation.");
    }

    const updated = await updateStoredChat(session.userId, chatId, (chat) => {
      if (payload.revision != null && payload.revision !== (chat.revision || 0)) {
        throw new ApiError(409, "BAD_REQUEST", "Chat changed in another tab. Reload and try again.");
      }
      const activeMessages = activeChatMessages(chat);
      const target = chat.messages.find((message) => message.id === messageId);
      if (!target) throw new ApiError(404, "BAD_REQUEST", "Message was not found.");

      if (payload.action === "branch" || payload.action === "switch") {
        return {
          ...chat,
          activeLeafId: payload.action === "branch" ? messageId : deepestBranchLeaf(chat, messageId),
          revision: (chat.revision || 0) + 1,
          updatedAt: new Date().toISOString()
        };
      }

      if (payload.action === "pin" || payload.action === "unpin") {
        const pinned = new Set(chat.pinnedMessageIds || []);
        if (payload.action === "pin") pinned.add(messageId); else pinned.delete(messageId);
        return { ...chat, pinnedMessageIds: [...pinned], revision: (chat.revision || 0) + 1, updatedAt: new Date().toISOString() };
      }

      if (payload.action === "delete") {
        if (activeMessages.at(-1)?.id !== messageId) {
          throw new ApiError(400, "BAD_REQUEST", "Only the last message of the active branch can be deleted safely.");
        }
        if (chat.messages.some((message) => message.parentId === messageId)) {
          throw new ApiError(400, "BAD_REQUEST", "This message has branch continuations and cannot be deleted safely.");
        }
        const messages = deleteMessageById(chat.messages, messageId);
        if (!messages) throw new ApiError(404, "BAD_REQUEST", "Message was not found.");
        return {
          ...chat,
          messages,
          pinnedMessageIds: (chat.pinnedMessageIds || []).filter((id) => id !== messageId),
          activeLeafId: target.parentId || null,
          revision: (chat.revision || 0) + 1,
          updatedAt: new Date().toISOString()
        };
      }

      const content = (payload.content || "").trim();
      const lastActiveUser = [...activeMessages].reverse().find((message) => message.role === "user");
      if (lastActiveUser?.id !== messageId || target.role !== "user" || !content) {
        throw new ApiError(400, "BAD_REQUEST", "Only the latest user message can be edited.");
      }
      const editedMessage = { ...target, id: createMessageId(), content, createdAt: new Date().toISOString() };

      return {
        ...chat,
        messages: [...chat.messages, editedMessage],
        activeLeafId: editedMessage.id,
        revision: (chat.revision || 0) + 1,
        updatedAt: new Date().toISOString()
      };
    });

    if (!updated) {
      throw new ApiError(404, "BAD_REQUEST", "Chat transcript was not found.");
    }
    response.json({ chat: clientChatTranscript(updated) });
  } catch (error) {
    next(error);
  }
});

app.post("/api/chat", async (request, response, next) => {
  try {
    const { userId, chatRequest } = await enrichChatRequestWithMemory(request);
    const requestBody = request.body as ChatRequest;
    const prepared = await prepareChatGeneration(userId, chatRequest);
    await composePreparedContext(prepared);
    const isNewUserTurn = prepared.action === "send";
    if (isNewUserTurn) {
      await appendEntriesForUser(userId, [{ speaker: "You", content: requestBody.userMessage || "", createdAt: new Date().toISOString() }]);
      await autoExtractFactsForUser(userId, requestBody.userMessage || "", { chatId: requestBody.chatId, messageId: requestBody.userMessageId });
    }

    const explicitMemory = isNewUserTurn
      ? await rememberExplicitly(userId, requestBody.userMessage || "", { characterId: requestBody.personaCharacterId, chatId: requestBody.chatId })
      : null;
    if (explicitMemory) prepared.contextReport = undefined;
    let outputTokens: number | undefined;
    const content = explicitMemory?.confirmation || await requestChatCompletion(prepared.request, await readSettings(), generationSignal(response), count => { outputTokens = count; });
    if (!content.trim()) throw new ApiError(502, "LM_STUDIO_UNAVAILABLE", EMPTY_MODEL_REPLY_HINT);
    if (isNewUserTurn && content.trim() && !explicitMemory) {
      await appendEntriesForUser(userId, [{ speaker: request.body.personaName || "AI", content, createdAt: new Date().toISOString() }]);
    }
    const saved = await persistChatGeneration(userId, prepared, content, true);
    if (saved && !explicitMemory && prepared.contextReport) await markMemoryAccess(userId, prepared.contextReport.memory.map(record => record.id));
    response.json({ content, outputTokens });
  } catch (error) {
    next(error);
  }
});

app.post("/api/group-chat/director", async (request, response, next) => {
  try {
    const session = await requireAuthenticatedSession(request);
    const payload = request.body as { groupChatId?: unknown; revision?: unknown; draft?: unknown };
    const groupChatId = typeof payload?.groupChatId === "string" ? payload.groupChatId.trim() : "";
    const draft = typeof payload?.draft === "string" ? payload.draft.trim() : "";
    if (!groupChatId) throw new ApiError(400, "BAD_REQUEST", "Выберите комнату для совета режиссёра.");
    if (payload?.revision !== undefined && (!Number.isSafeInteger(payload.revision) || (payload.revision as number) < 0)) throw new ApiError(400, "BAD_REQUEST", "Некорректная версия комнаты.");
    if (typeof payload?.draft !== "undefined" && (typeof payload.draft !== "string" || draft.length > 4000)) throw new ApiError(400, "BAD_REQUEST", "Черновик режиссёра должен быть не длиннее 4000 символов.");
    if (await isStoredTranscriptDeleted(session.userId, groupChatId, "group-chat")) throw new TranscriptDeletedError();
    const room = await readStoredGroupChat(session.userId, groupChatId);
    if (!room) throw new ApiError(404, "BAD_REQUEST", "Комната не найдена. Обновите список комнат.");
    if (payload.revision !== undefined && payload.revision !== (room.revision || 0)) throw new TranscriptConflictError(room.revision || 0);
    const workspace = await readUserWorkspaceState(session.userId);
    const participants = room.participantIds.map((id) => [...workspace.characters, ...factoryCards()].find(character => character.id === id)).filter((character): character is NonNullable<typeof character> => Boolean(character));
    if (participants.length !== room.participantIds.length) throw new ApiError(409, "BAD_REQUEST", "Состав комнаты изменился. Обновите комнату.");
    const settings = await readSettings();
    const effective = resolveProfile(settings, null, room.modelProfileId);
    const roomMemory = (await scopedContextRecords(session.userId, "group", groupChatId, null, room.messages))
      .filter(record => record.enabled && record.scope === "group")
      .sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.importance - a.importance || Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
      .slice(0, 16).map(record => `[${record.kind}] ${record.text}`).join("\n").slice(0, 6000);
    const suggestion = await requestDirectorSuggestion({
      roomMemory,
      draft,
      roomRules: room.roomRules,
      messages: room.messages,
      participants: participants.map(character => ({ id: character.id, name: character.name, systemPrompt: `${character.description || ""}\n${room.participantRoles?.[character.id] || ""}` }))
    }, effective, generationSignal(response));
    response.json({ suggestion });
  } catch (error) {
    next(error);
  }
});

app.post("/api/group-chat", async (request, response, next) => {
  try {
    const session = await requireAuthenticatedSession(request);
    const userId = session.userId;
    const requestBody = request.body as GroupChatRequest;
    const expectedRevision = await groupGenerationRevision(userId, requestBody);
    if (requestBody.sceneDeadlineAt) throw new ApiError(400, "BAD_REQUEST", "Для сцены с ограничением времени используйте потоковую отправку.");
    const participants = await enrichGroupParticipantsWithMemory(userId, requestBody);
    const maxRepliesPerTurn = participants.length
      ? validateGroupReplyLimit(requestBody.maxRepliesPerTurn, participants.length)
      : 1;
    const nextRequest = {
      ...requestBody,
      messages: Array.isArray(requestBody.messages) ? requestBody.messages : [],
      participants,
      maxRepliesPerTurn
    };
    const latestUserMessage = requestBody.resumeScene ? undefined : [...(requestBody.messages || [])]
      .reverse()
      .find((message: { role?: string; content?: string }) => message.role === "user" && message.content?.trim());

    await appendEntriesForUser(
      userId,
      latestUserMessage
        ? [
            {
              speaker: "You",
              content: latestUserMessage.content,
              createdAt: new Date().toISOString()
            }
          ]
        : []
    );
    await autoExtractFactsForUser(userId, latestUserMessage?.content || "", { groupChatId: requestBody.groupChatId, messageId: latestUserMessage?.id });

    const explicitMemory = latestUserMessage
      ? await rememberExplicitly(userId, latestUserMessage.content, { groupChatId: requestBody.groupChatId })
      : null;
    if (explicitMemory) {
      const speaker = resolveGroupParticipantsForTurn(nextRequest)[0] || participants[0];
      if (!speaker) throw new ApiError(400, "BAD_REQUEST", "Add at least one participant before sending a group message.");
      const replies = [{ characterId: speaker.id, characterName: speaker.name, content: explicitMemory.confirmation }];
      await appendEntriesForUser(userId, [{ speaker: speaker.name, content: explicitMemory.confirmation, createdAt: new Date().toISOString() }]);
      await saveGroupChatTranscriptForRequest(userId, requestBody, replies, expectedRevision);
      response.json({ replies });
      return;
    }

    const replies = await requestGroupChatCompletion(nextRequest, await readSettings(), generationSignal(response));
    await appendEntriesForUser(
      userId,
      replies.map((reply) => ({
        speaker: reply.characterName || "Assistant",
        content: reply.content,
        createdAt: new Date().toISOString()
      }))
    );

    await saveGroupChatTranscriptForRequest(userId, requestBody, replies, expectedRevision);
    response.json({ replies });
  } catch (error) {
    next(error);
  }
});

app.post("/api/chat/stream", async (request, response, next) => {
  const abortController = new AbortController();
  const abortOnClientClose = () => {
    if (!response.writableEnded) abortController.abort();
  };
  response.once("close", abortOnClientClose);
  let prepared: PreparedChatGeneration | null = null;
  let content = "";
  let persisted = false;

  const persist = async (completed: boolean) => {
    if (!prepared || persisted) return;
    const saved = await persistChatGeneration(prepared.userId, prepared, content, completed);
    if (saved && prepared.contextReport) await markMemoryAccess(prepared.userId, prepared.contextReport.memory.map(record => record.id));
    persisted = true;
  };

  try {
    const { userId, chatRequest } = await enrichChatRequestWithMemory(request);
    const requestBody = request.body as ChatRequest;
    prepared = await prepareChatGeneration(userId, chatRequest);
    await composePreparedContext(prepared);
    const isNewUserTurn = prepared.action === "send";
    if (isNewUserTurn) {
      await appendEntriesForUser(userId, [{ speaker: "You", content: requestBody.userMessage || "", createdAt: new Date().toISOString() }]);
      await autoExtractFactsForUser(userId, requestBody.userMessage || "", { chatId: requestBody.chatId, messageId: requestBody.userMessageId });
    }

    const explicitMemory = isNewUserTurn
      ? await rememberExplicitly(userId, requestBody.userMessage || "", { characterId: requestBody.personaCharacterId, chatId: requestBody.chatId })
      : null;

    if (explicitMemory) {
      prepared.contextReport = undefined;
      response.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no"
      });
      content = explicitMemory.confirmation;
      response.write(`data: ${JSON.stringify({ delta: content })}\n\n`);
      await persist(true);
      response.write("event: done\ndata: {}\n\n");
      response.end();
      return;
    }

    const stream = await requestChatStream(prepared.request, await readSettings(), abortController.signal);
    response.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no"
    });

    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    const completion = createStreamCompletionGuard();

    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() || "";

        for (const line of lines) {
          completion.inspect(line);
          if (!line.startsWith("data:")) continue;
          const payload = line.slice(5).trim();
          if (!payload || payload === "[DONE]") continue;
          try {
            const parsed = JSON.parse(payload);
            if (Number.isSafeInteger(parsed.usage?.completion_tokens) && parsed.usage.completion_tokens >= 0) response.write(`event: usage\ndata: ${JSON.stringify({ outputTokens: parsed.usage.completion_tokens })}\n\n`);
            const delta = parsed.choices?.[0]?.delta?.content || "";
            if (delta) {
              content += delta;
              response.write(`data: ${JSON.stringify({ delta })}\n\n`);
            }
          } catch {
            content += payload;
            response.write(`data: ${JSON.stringify({ delta: payload })}\n\n`);
          }
        }
      }

      completion.inspect(buffer + decoder.decode());
      completion.finish();
    } finally {
      await reader.cancel().catch(() => {});
    }
    if (!content.trim()) throw new ApiError(502, "LM_STUDIO_UNAVAILABLE", EMPTY_MODEL_REPLY_HINT);
    if (isNewUserTurn && content.trim()) {
      await appendEntriesForUser(userId, [{ speaker: requestBody.personaName || "AI", content, createdAt: new Date().toISOString() }]);
    }
    await persist(true);
    response.write("event: done\ndata: {}\n\n");
    response.end();
  } catch (error) {
    if (abortController.signal.aborted || content.trim()) {
      try {
        await persist(false);
      } catch (persistError) {
        console.warn("Failed to persist interrupted chat stream", persistError);
      }
    }
    if (abortController.signal.aborted) return;
    if (response.headersSent) {
      const message = error instanceof Error ? error.message : "Chat stream interrupted.";
      response.write(`event: error\ndata: ${JSON.stringify({ message })}\n\n`);
      response.end();
      return;
    }
    next(error);
  } finally {
    response.off("close", abortOnClientClose);
  }
});

app.post("/api/group-chat/stream", async (request, response, next) => {
  const clientSignal = generationSignal(response);
  let signal = clientSignal;
  let sceneDeadlineAt: number | null = null;
  let savePartial: (() => Promise<void>) | undefined;
  let partialReply: { characterId: string; characterName: string; content: string } | undefined;
  try {
    const savedSettings = await readSettings();
    const session = await requireAuthenticatedSession(request);
    const userId = session.userId;
    const requestBody = request.body as GroupChatRequest;
    let expectedRevision = await groupGenerationRevision(userId, requestBody);
    sceneDeadlineAt = requestBody.sceneDeadlineAt ?? null;
    if (sceneDeadlineAt) signal = AbortSignal.any([clientSignal, AbortSignal.timeout(Math.max(0, sceneDeadlineAt - Date.now()))]);
    const participantsWithMemory = await enrichGroupParticipantsWithMemory(
      userId,
      requestBody
    );
    const maxRepliesPerTurn = participantsWithMemory.length
      ? validateGroupReplyLimit(requestBody.maxRepliesPerTurn, participantsWithMemory.length)
      : 1;
    const enrichedRequest = {
      ...requestBody,
      messages: Array.isArray(requestBody.messages) ? requestBody.messages : [],
      participants: participantsWithMemory,
      maxRepliesPerTurn
    };
    const participants = resolveGroupParticipantsForTurn(enrichedRequest);
    const messagesForTurn = [...(enrichedRequest.messages || [])];
    const latestUserMessage = requestBody.resumeScene ? undefined : [...messagesForTurn]
      .reverse()
      .find((message) => message.role === "user" && message.content.trim());

    await appendEntriesForUser(
      userId,
      latestUserMessage
        ? [
            {
              speaker: "You",
              content: latestUserMessage.content,
              createdAt: new Date().toISOString()
            }
          ]
        : []
    );
    await autoExtractFactsForUser(userId, latestUserMessage?.content || "", { groupChatId: requestBody.groupChatId, messageId: latestUserMessage?.id });
    const replyEntries: DailyLogEntry[] = [];
    const characterMemories: Array<{ characterId: string; characterName: string; content: string }> = [];
    savePartial = async () => {
      const replies = partialReply?.content.trim() ? [...characterMemories, partialReply] : characterMemories;
      const completed = new Set(replies.map(reply => reply.characterId));
      const saved = await saveGroupChatTranscriptForRequest(userId, requestBody, replies, expectedRevision, participants.map(participant => participant.id).filter(id => !completed.has(id)));
      if (saved) expectedRevision = saved.revision || expectedRevision;

    };

    await savePartial();

    console.info("[group-stream] request received", {
      groupChatId: requestBody.groupChatId || null,
      roomParticipantCount: participantsWithMemory.length,
      turnParticipantCount: participants.length,
      turnParticipantIds: participants.map((participant) => participant.id)
    });

    response.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no"
    });

    const explicitMemory = latestUserMessage
      ? await rememberExplicitly(userId, latestUserMessage.content, { groupChatId: requestBody.groupChatId })
      : null;
    if (explicitMemory) {
      const speaker = participants[0] || participantsWithMemory[0];
      if (!speaker) throw new ApiError(400, "BAD_REQUEST", "Add at least one participant before sending a group message.");
      response.write(`event: speaker\ndata: ${JSON.stringify({ characterId: speaker.id, characterName: speaker.name })}\n\n`);
      response.write(`data: ${JSON.stringify({ characterId: speaker.id, characterName: speaker.name, delta: explicitMemory.confirmation })}\n\n`);
      response.write(`event: speakerDone\ndata: ${JSON.stringify({ characterId: speaker.id, characterName: speaker.name, content: explicitMemory.confirmation })}\n\n`);
      await appendEntriesForUser(userId, [{ speaker: speaker.name, content: explicitMemory.confirmation, createdAt: new Date().toISOString() }]);
      await saveGroupChatTranscriptForRequest(userId, requestBody, [{ characterId: speaker.id, characterName: speaker.name, content: explicitMemory.confirmation }], expectedRevision);
      response.write("event: done\ndata: {}\n\n");
      response.end();
      return;
    }

    for (const participant of participants) {
      signal.throwIfAborted();
      partialReply = { characterId: participant.id, characterName: participant.name, content: "" };
      const participantNames = participantsWithMemory.map((current) => current.name);
      response.write(`event: speaker\ndata: ${JSON.stringify({
        characterId: participant.id,
        characterName: participant.name
      })}\n\n`);
      console.info("[group-stream] SSE speaker sent", { characterId: participant.id });

      console.info("[group-stream] LM Studio request started", { characterId: participant.id });
      const stream = await requestGroupCharacterStream(
        { ...enrichedRequest, messages: messagesForTurn },
        participant,
        savedSettings,
        signal
      );
      console.info("[group-stream] LM Studio stream opened", { characterId: participant.id });
      const reader = stream.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let content = "";
      let rawContent = "";
      const completion = createStreamCompletionGuard();

      const processLmStudioLine = (line: string) => {
        completion.inspect(line);
        if (line.startsWith("data:")) {
          try {
            const usage = JSON.parse(line.slice(5).trim()).usage;
            if (Number.isSafeInteger(usage?.completion_tokens) && usage.completion_tokens >= 0) response.write(`event: usage\ndata: ${JSON.stringify({ characterId: participant.id, outputTokens: usage.completion_tokens })}\n\n`);
          } catch { /* Non-JSON terminal frames carry no usage. */ }
        }
        const delta = extractLmStudioStreamDelta(line);
        if (!delta) return;

        rawContent += delta;
        const sanitized = emitSanitizedGroupDelta(rawContent, content, participant.name, participantNames);
        if (!sanitized.nextDelta) return;

        content = sanitized.sanitizedContent;
        if (partialReply) partialReply.content = content;
        response.write(`data: ${JSON.stringify({
          characterId: participant.id,
          characterName: participant.name,
          delta: sanitized.nextDelta
        })}\n\n`);
        if (groupStreamDebugChunks) {
          console.debug("[group-stream] SSE data sent", {
            characterId: participant.id,
            chunkLength: sanitized.nextDelta.length
          });
        }
      };

      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          const parsedLines = splitLmStudioStreamLines(buffer, decoder.decode(value, { stream: true }));
          buffer = parsedLines.buffer;
          parsedLines.lines.forEach(processLmStudioLine);
        }

        const finalLines = splitLmStudioStreamLines(buffer, decoder.decode(), true);
        finalLines.lines.forEach(processLmStudioLine);
        completion.finish();
      } finally {
        await reader.cancel().catch(() => {});
      }

      const finalContent = sanitizeGroupReplyContent(rawContent, participant.name, participantNames);
      const finalDelta = finalContent.slice(content.length);
      if (finalDelta) {
        response.write(`data: ${JSON.stringify({
          characterId: participant.id,
          characterName: participant.name,
          delta: finalDelta
        })}\n\n`);
        if (groupStreamDebugChunks) {
          console.debug("[group-stream] SSE final data sent", {
            characterId: participant.id,
            chunkLength: finalDelta.length
          });
        }
      }
      content = finalContent;

      if (!content.trim()) throw new ApiError(502, "LM_STUDIO_UNAVAILABLE", EMPTY_MODEL_REPLY_HINT);

      messagesForTurn.push({
        role: "assistant",
        characterId: participant.id,
        characterName: participant.name,
        content
      });
      if (content.trim()) {
        replyEntries.push({
          speaker: participant.name,
          content,
          createdAt: new Date().toISOString()
        });
        characterMemories.push({
          characterId: participant.id,
          characterName: participant.name,
          content
        });
      }
      partialReply = undefined;
      await savePartial();
      response.write(`event: speakerDone\ndata: ${JSON.stringify({
        characterId: participant.id,
        characterName: participant.name,
        content
      })}\n\n`);
      console.info("[group-stream] SSE speakerDone sent", {
        characterId: participant.id,
        contentLength: content.length
      });
    }

    await appendEntriesForUser(userId, replyEntries);

    await saveGroupChatTranscriptForRequest(userId, requestBody, characterMemories, expectedRevision);
    response.write("event: done\ndata: {}\n\n");
    console.info("[group-stream] SSE done sent", {
      groupChatId: requestBody.groupChatId || null,
      replyCount: characterMemories.length
    });
    response.end();
  } catch (error) {
    try { await savePartial?.(); } catch (saveError) { console.warn("[group-stream] partial save failed", saveError); }
    if (clientSignal.aborted) return;
    if (sceneDeadlineAt && Date.now() >= sceneDeadlineAt) error = new ApiError(408, "BAD_REQUEST", "Время сцены истекло. Полученные ответы сохранены; начните новый ход.");
    console.warn("[group-stream] stream error", error);
    if (response.headersSent) {
      const message = error instanceof Error ? error.message : "Group stream interrupted.";
      response.write(`event: error\ndata: ${JSON.stringify({ message })}\n\n`);
      response.end();
      return;
    }
    next(error);
  }
});

if (existsSync(distPath)) {
  app.use(express.static(distPath, {
    setHeaders(response, filePath) {
      const normalizedPath = normalize(filePath).toLowerCase();
      if (normalizedPath.startsWith(normalize(distAssetsPath).toLowerCase())) {
        response.setHeader("Cache-Control", "public, max-age=31536000, immutable");
      } else if (normalizedPath.endsWith("index.html")) {
        response.setHeader("Cache-Control", "no-cache");
      }
    }
  }));
  app.get(/^(?!\/api(?:\/|$)).*/, (_request, response) => {
    response.setHeader("Cache-Control", "no-cache");
    response.sendFile(resolve(distPath, "index.html"));
  });
}

const errorHandler: ErrorRequestHandler = (error, _request, response, next) => {
  if (response.headersSent) {
    next(error);
    return;
  }

  if (error instanceof TextFileError) { response.status(error.status).json({ error: { code: "BAD_REQUEST", message: error.message } }); return; }
  if (error?.type === "entity.too.large" || error?.type === "entity.parse.failed") {
    response.status(error.type === "entity.too.large" ? 413 : 400).json({ error: { code: "BAD_REQUEST", message: "Invalid or oversized JSON request." } });
    return;
  }
  if (error instanceof BackupValidationError || error instanceof BackupConflictError || error instanceof WorkspaceConflictError || error instanceof TranscriptDeletedError ||
      error instanceof TranscriptConflictError || error instanceof GroupConfigConflictError || error instanceof InvalidTranscriptIdError) {
    response.status(error instanceof WorkspaceConflictError ? 409 : error.status).json({ error: { code: "BAD_REQUEST", message: error.message } });
    return;
  }
  if (error instanceof ApiError) {
    response.status(error.status).json({ error: { code: error.code, message: error.message } });
    return;
  }

  console.error("[ERROR] Express request failed", error);
  response.status(500).json({
    error: {
      code: "BAD_REQUEST",
      message: error instanceof Error ? error.message : "Неизвестная ошибка сервера."
    }
  });
};

app.use(errorHandler);

const httpServer = createServer(app);
let isShuttingDown = false;

function shutdown(signal: string) {
  if (isShuttingDown) {
    return;
  }

  isShuttingDown = true;
  console.log(`[INFO] Received ${signal}, closing HTTP server...`);
  httpServer.close(() => {
    console.log("[INFO] HTTP server closed.");
    process.exit(0);
  });
  setTimeout(() => {
    console.error("[WARN] Graceful shutdown timeout, forcing connection close.");
    httpServer.closeAllConnections?.();
    process.exit(1);
  }, 5000).unref();
}

process.on("uncaughtExceptionMonitor", (error, origin) => {
  console.error(`[FATAL] uncaught exception origin=${origin}`, error);
});

process.on("unhandledRejection", (reason) => {
  console.error("[FATAL] unhandled rejection", reason);
  process.exitCode = 1;
  setTimeout(() => process.exit(1), 20).unref();
});

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

if (!await initializeAdmin(process.env.INITIAL_ADMIN_PASSWORD)) {
  console.warn("[WARN] Administrator is not configured. Set INITIAL_ADMIN_PASSWORD locally and restart the server.");
}

httpServer.listen(port, host, () => {
  console.log(`Local AI Chat backend: http://${host}:${port}`);
});

