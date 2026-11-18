import { getLocale, t } from "./i18n";
import type {
  ApiErrorBody,
  AppSettings,
  AuthSession,
  CharacterCard,
  Chat,
  ChatMessage,
  GroupChat,
  GroupChatMessage,
  GroupResponseMode,
  UserProfile
} from "./types/domain";
import { CHAT_GENERATION_TIMEOUT_MS, DEFAULT_API_TIMEOUT_MS } from "../shared/chatRequestPolicy";
import type { MemoryExport, MemoryRecord, MemoryScope } from "../shared/memory";
import type { UserBackup, BackupPreview } from "../shared/backup";

type SendChatPayload = {
  image?: import("../shared/chatImage").ChatImage;
  chatId?: string;
  chatTitle?: string;
  settings: AppSettings;
  personaSystemPrompt: string;
  personaName?: string;
  personaCharacterId?: string | null;
  history: Array<Pick<ChatMessage, "id" | "role" | "content" | "createdAt">>;
  userMessage: string;
  userMessageId?: string;
  userMessageCreatedAt?: string;
  assistantMessageId?: string;
  action?: "send" | "regenerate" | "continue";
  targetMessageId?: string;
  revision?: number;
  temperature: number;
  maxTokens: number;
};

export type UserStateSyncPayload = {
  revision?: number;
  userProfile: UserProfile;
  characters: CharacterCard[];
  chatSummaries: Array<{
    id: string;
    kind: "chat" | "group-chat";
    title: string;
    updatedAt: string;
    messageCount: number;
    titleMode?: "default" | "auto" | "manual";
    pinnedAt?: string | null;
  }>;
};

export type PublicRouteStatus = {
  activePublicUrl: string;
  temporaryPublicUrl: string;
  preferredPublicUrl: string;
  preferredRecoveredUrl: string;
  preferredRecoveredAt: string;
  redirectAfter: string;
  mode: string;
};

export class ApiHttpError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "ApiHttpError";
    this.status = status;
  }
}

export class ApiRequestError extends Error {
  kind: "timeout" | "network" | "aborted";

  constructor(kind: "timeout" | "network" | "aborted", message: string) {
    super(message);
    this.name = "ApiRequestError";
    this.kind = kind;
  }
}

async function apiFetch(
  input: RequestInfo | URL,
  init?: RequestInit,
  timeoutMs = DEFAULT_API_TIMEOUT_MS,
  signal?: AbortSignal
) {
  try {
    return await fetch(input, {
      ...init,
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs)
    });
  } catch (error) {
    if (signal?.aborted) {
      throw new ApiRequestError("aborted", "Request aborted.");
    }
    if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) {
      throw new ApiRequestError("timeout", "Request timed out.");
    }

    throw new ApiRequestError("network", error instanceof Error ? error.message : String(error));
  }
}

export type GroupChatPayload = {
  revision?: number;
  resumeScene?: boolean;
  skippedParticipantIds?: string[];
  groupChatId?: string;
  groupChatTitle?: string;
  settings: AppSettings;
  messages: Array<Pick<GroupChatMessage, "role" | "content" | "characterId" | "characterName">>;
  participants: Array<Pick<CharacterCard, "id" | "name" | "systemPrompt" | "avatar">>;
  activeSpeakerCharacterId?: string | null;
  responseMode: GroupResponseMode;
  maxRepliesPerTurn: number;
  model: string;
  temperature: number;
  maxTokens: number;
};

export type DirectorSuggestion =
  | { action: "speak"; participantId: string; task: string; reason: string; stopCondition: string }
  | { action: "stop"; reason: string; stopCondition: string };

async function readApiError(response: Response) {
  try {
    const body = (await response.json()) as ApiErrorBody;
    return body.error?.message || `HTTP ${response.status}`;
  } catch {
    return `HTTP ${response.status}`;
  }
}

function userHeaders(userId?: string | null, sessionToken?: string | null) {
  const headers: Record<string, string> = {};
  if (userId) {
    headers["X-Local-User-Id"] = userId;
  }
  if (sessionToken) {
    headers["X-Session-Token"] = sessionToken;
  }
  if (__LOCAL_AI_CHAT_SERVER_TOKEN__) {
    headers["X-Server-Token"] = __LOCAL_AI_CHAT_SERVER_TOKEN__;
  }
  return headers;
}

function sessionHeaders(sessionToken?: string | null) {
  const headers: Record<string, string> = {};
  if (sessionToken) {
    headers["X-Session-Token"] = sessionToken;
  }
  if (__LOCAL_AI_CHAT_SERVER_TOKEN__) {
    headers["X-Server-Token"] = __LOCAL_AI_CHAT_SERVER_TOKEN__;
  }
  return headers;
}

export async function registerAuth(username: string, password: string) {
  const response = await apiFetch("/api/auth/register", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...sessionHeaders() },
    body: JSON.stringify({ username, password })
  });
  if (!response.ok) throw new Error(await readApiError(response));
  return (await response.json()) as AuthSession & { success: true; showStudioWelcome: boolean };
}

export async function loginAuth(username: string, password: string) {
  const response = await apiFetch("/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...sessionHeaders() },
    body: JSON.stringify({ username, password })
  });
  if (!response.ok) throw new Error(await readApiError(response));
  return (await response.json()) as AuthSession & { success: true; showStudioWelcome: boolean };
}

export async function logoutAuth(sessionToken?: string | null) {
  const response = await apiFetch("/api/auth/logout", {
    method: "POST",
    headers: sessionHeaders(sessionToken)
  });
  if (!response.ok) throw new Error(await readApiError(response));
  return response.json();
}

export async function getAuthSession(sessionToken?: string | null) {
  const response = await apiFetch("/api/auth/session", {
    headers: sessionHeaders(sessionToken)
  });
  if (!response.ok) throw new ApiHttpError(response.status, await readApiError(response));
  return (await response.json()) as {
    authenticated: true;
    userId: string;
    username: string;
    expiresAt: string;
  };
}

export async function getUserState(sessionToken?: string | null) {
  const response = await apiFetch("/api/user-state", {
    headers: sessionHeaders(sessionToken)
  });
  if (!response.ok) throw new Error(await readApiError(response));
  return (await response.json()) as UserStateSyncPayload;
}

export async function getChatState(sessionToken?: string | null) {
  const response = await apiFetch("/api/chat-state", {
    headers: sessionHeaders(sessionToken)
  });
  if (!response.ok) throw new Error(await readApiError(response));
  return (await response.json()) as {
    chats: Array<{
      id: string;
      title: string;
      characterId: string | null;
      messages: ChatMessage[];
      allMessages?: ChatMessage[];
      activeLeafId?: string | null;
      revision?: number;
      branches?: Record<string, string[]>;
      pinnedMessageIds?: string[];
      titleMode?: "default" | "auto" | "manual";
      pinnedAt?: string | null;
      createdAt: string;
      updatedAt: string;
    }>;
    groupChats: Array<{
      sceneTimeLimitSeconds?: number;
      sceneDeadlineAt?: number | null;
      roomRules?: string;
      participantRoles?: Record<string, string>;
      pendingSpeakerIds?: string[];
      configRevision?: number;
      revision?: number;
      id: string;
      title: string;
      participantIds: string[];
      activeSpeakerCharacterId: string | null;
      messages: GroupChatMessage[];
      responseMode: GroupResponseMode;
      maxRepliesPerTurn: number;
      createdAt: string;
      updatedAt: string;
    }>;
  };
}

export async function getHealth() {
  const response = await apiFetch("/api/health");
  if (!response.ok) throw new Error(await readApiError(response));
  return response.json();
}

export async function getPublicRouteStatus() {
  const response = await apiFetch("/api/public-route-status");
  if (!response.ok) throw new Error(await readApiError(response));
  return (await response.json()) as PublicRouteStatus;
}

export async function getServerSettings() {
  const response = await apiFetch("/api/settings");
  if (!response.ok) throw new Error(await readApiError(response));
  return (await response.json()) as AppSettings;
}

export async function saveServerSettings(settings: Partial<AppSettings>, sessionToken?: string | null): Promise<AppSettings> {
  const response = await apiFetch("/api/settings", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...sessionHeaders(sessionToken) },
    body: JSON.stringify(settings)
  });
  if (!response.ok) throw new Error(await readApiError(response));
  return response.json();
}

export async function getMemoryRecords(sessionToken?: string | null, filters: { scope?: MemoryScope; query?: string } = {}) {
  const params = new URLSearchParams();
  if (filters.scope) params.set("scope", filters.scope);
  if (filters.query?.trim()) params.set("query", filters.query.trim());
  const response = await apiFetch(`/api/memory${params.size ? `?${params}` : ""}`, {
    headers: sessionHeaders(sessionToken)
  });
  if (!response.ok) throw new Error(await readApiError(response));
  return (await response.json()) as { records: MemoryRecord[] };
}

export async function createMemory(input: Partial<MemoryRecord> & Pick<MemoryRecord, "scope" | "kind" | "text">, sessionToken?: string | null) {
  const response = await apiFetch("/api/memory", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...sessionHeaders(sessionToken) },
    body: JSON.stringify(input)
  });
  if (!response.ok) throw new Error(await readApiError(response));
  return (await response.json()) as { record: MemoryRecord };
}

export async function updateMemory(memoryId: string, patch: Partial<MemoryRecord>, sessionToken?: string | null) {
  const response = await apiFetch(`/api/memory/${encodeURIComponent(memoryId)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", ...sessionHeaders(sessionToken) },
    body: JSON.stringify(patch)
  });
  if (!response.ok) throw new Error(await readApiError(response));
  return (await response.json()) as { record: MemoryRecord };
}

export async function deleteMemory(memoryId: string, sessionToken?: string | null) {
  const response = await apiFetch(`/api/memory/${encodeURIComponent(memoryId)}`, {
    method: "DELETE",
    headers: sessionHeaders(sessionToken)
  });
  if (!response.ok) throw new Error(await readApiError(response));
}

export async function exportMemoryBackup(sessionToken?: string | null) {
  const response = await apiFetch("/api/memory/export", { headers: sessionHeaders(sessionToken) });
  if (!response.ok) throw new Error(await readApiError(response));
  return (await response.json()) as MemoryExport;
}

export async function importMemoryBackup(payload: unknown, sessionToken?: string | null) {
  const response = await apiFetch("/api/memory/import", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...sessionHeaders(sessionToken) },
    body: JSON.stringify(payload)
  });
  if (!response.ok) throw new Error(await readApiError(response));
  return (await response.json()) as { records: MemoryRecord[] };
}

export async function loadModels(baseUrl: string, sessionToken?: string | null) {
  const response = await apiFetch(`/api/models?baseUrl=${encodeURIComponent(baseUrl)}`, { headers: sessionHeaders(sessionToken) });
  if (!response.ok) throw new Error(await readApiError(response));
  const data = await response.json();
  return (data.data || []) as Array<{ id: string; object?: string }>;
}

export async function sendChat(
  payload: SendChatPayload,
  userId?: string | null,
  sessionToken?: string | null,
  signal?: AbortSignal
) {
  const response = await apiFetch("/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...userHeaders(userId, sessionToken) },
    body: JSON.stringify(payload)
  }, CHAT_GENERATION_TIMEOUT_MS, signal);
  if (!response.ok) throw new Error(await readApiError(response));
  return (await response.json()) as { content: string; outputTokens?: number };
}

export async function streamChat(
  payload: SendChatPayload,
  onDelta: (delta: string) => void,
  userId?: string | null,
  sessionToken?: string | null,
  signal?: AbortSignal,
  onTokens?: (count: number) => void
) {
  const response = await apiFetch("/api/chat/stream", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...userHeaders(userId, sessionToken) },
    body: JSON.stringify(payload)
  }, CHAT_GENERATION_TIMEOUT_MS, signal);
  if (!response.ok || !response.body) throw new Error(await readApiError(response));

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const frames = buffer.split("\n\n");
    buffer = frames.pop() || "";

    for (const frame of frames) {
      const lines = frame.split(/\r?\n/);
      const event = lines.find((line) => line.startsWith("event:"))?.slice(6).trim();
      if (event === "done") return;
      const dataLine = lines.find((line) => line.startsWith("data:"));
      if (!dataLine) continue;
      const payloadText = dataLine.slice(5).trim();
      if (!payloadText) continue;
      const parsed = JSON.parse(payloadText) as { delta?: string; outputTokens?: number };
      if (event === "error") throw new Error((parsed as { message?: string }).message || "Chat stream interrupted.");
      if (event === "usage" && typeof parsed.outputTokens === "number") onTokens?.(parsed.outputTokens);
      if (parsed.delta) onDelta(parsed.delta);
    }
  }
  throw new Error("Chat stream ended before done event.");
}

export async function mutateChatMessage(
  payload: { chatId?: string; action: "edit" | "delete" | "branch" | "switch" | "pin" | "unpin" | "import" | "rename" | "pin-chat" | "unpin-chat" | "generate-title" | "set-profile" | "organize"; archived?: boolean; tags?: string[]; modelProfileId?: string | null; messageId?: string; content?: string; title?: string; characterId?: string | null; automatic?: boolean; revision?: number; importedChat?: unknown },
  sessionToken?: string | null
) {
  const response = await apiFetch("/api/chat/mutate", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...sessionHeaders(sessionToken) },
    body: JSON.stringify(payload)
  });
  if (!response.ok) throw new Error(await readApiError(response));
  return (await response.json()) as { chat: Chat };
}

export async function saveGroupChatConfig(groupChat: GroupChat, sessionToken?: string | null) {
  const response = await apiFetch(`/api/group-chats/${encodeURIComponent(groupChat.id)}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", ...sessionHeaders(sessionToken) },
    body: JSON.stringify({
      configRevision: groupChat.configRevision ?? 0,
      title: groupChat.title,
      participantIds: groupChat.participantIds,
      sceneTimeLimitSeconds: groupChat.sceneTimeLimitSeconds || 0,
      roomRules: groupChat.roomRules || "",
      participantRoles: groupChat.participantRoles || {},
      activeSpeakerCharacterId: groupChat.activeSpeakerCharacterId,
      responseMode: groupChat.responseMode,
      maxRepliesPerTurn: groupChat.maxRepliesPerTurn,
      modelProfileId: groupChat.modelProfileId || null,
      createdAt: groupChat.createdAt,
      updatedAt: groupChat.updatedAt
    })
  });
  if (!response.ok) throw new ApiHttpError(response.status, await readApiError(response));
  return (await response.json()) as { groupChat: GroupChat };
}

export async function deleteServerChat(id: string, sessionToken?: string | null, kind: "chat" | "group-chat" = "chat") {
  const response = await apiFetch(`/api/${kind === "chat" ? "chats" : "group-chats"}/${encodeURIComponent(id)}`, {
    method: "DELETE", headers: sessionHeaders(sessionToken)
  });
  if (!response.ok) throw new ApiHttpError(response.status, await readApiError(response));
}

export async function sendGroupChat(
  payload: GroupChatPayload,
  userId?: string | null,
  sessionToken?: string | null,
  signal?: AbortSignal
) {
  const response = await apiFetch("/api/group-chat", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...userHeaders(userId, sessionToken) },
    body: JSON.stringify(payload)
  }, CHAT_GENERATION_TIMEOUT_MS, signal);
  if (!response.ok) throw new ApiHttpError(response.status, await readApiError(response));
  return (await response.json()) as {
    replies: Array<{ characterId: string; characterName: string; content: string; outputTokens?: number }>;
  };
}

export async function requestGroupDirectorSuggestion(
  payload: { groupChatId: string; revision: number; draft?: string },
  sessionToken?: string | null,
  signal?: AbortSignal
) {
  const response = await apiFetch("/api/group-chat/director", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...sessionHeaders(sessionToken) },
    body: JSON.stringify(payload)
  }, CHAT_GENERATION_TIMEOUT_MS, signal);
  if (!response.ok) throw new ApiHttpError(response.status, await readApiError(response));
  return (await response.json()) as { suggestion: DirectorSuggestion };
}

export async function streamGroupChat(
  payload: GroupChatPayload,
  handlers: {
    onTokens?: (usage: { characterId: string; outputTokens: number }) => void;
    onSpeaker: (speaker: { characterId: string; characterName: string }) => void;
    onDelta: (chunk: { characterId: string; characterName: string; delta: string }) => void;
    onSpeakerDone?: (speaker: { characterId: string; characterName: string; content?: string }) => void;
  },
  userId?: string | null,
  sessionToken?: string | null,
  signal?: AbortSignal
) {
  const response = await apiFetch("/api/group-chat/stream", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...userHeaders(userId, sessionToken) },
    body: JSON.stringify(payload)
  }, CHAT_GENERATION_TIMEOUT_MS, signal);
  if (!response.ok || !response.body) throw new ApiHttpError(response.status, await readApiError(response));

  console.info("[group-stream] response opened", { participantCount: payload.participants.length });
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  const processFrame = (frame: string) => {
    const lines = frame.split(/\r?\n/);
    const event = lines.find((line) => line.startsWith("event:"))?.slice(6).trim();
    const dataLine = lines.find((line) => line.startsWith("data:"));
    const payloadText = dataLine?.slice(5).trim() || "{}";
    const parsed = JSON.parse(payloadText);
    if (event === "usage") { handlers.onTokens?.(parsed); return false; }
    if (event === "done") {
      console.info("[group-stream] done received");
      return true;
    }
    if (event === "error") {
      console.warn("[group-stream] error received", { message: parsed.message || "unknown" });
      throw new Error(parsed.message || "Group stream interrupted.");
    }
    if (event === "speaker") {
      handlers.onSpeaker(parsed);
      return false;
    }
    if (event === "speakerDone") {
      handlers.onSpeakerDone?.(parsed);
      return false;
    }
    if (parsed.delta) handlers.onDelta(parsed);
    return false;
  };

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const frames = buffer.split("\n\n");
    buffer = frames.pop() || "";

    for (const frame of frames) {
      if (processFrame(frame)) return;
    }
  }

  buffer += decoder.decode();
  if (buffer.trim() && processFrame(buffer)) return;
  throw new Error("Group stream ended before done event.");
}

export async function syncUserState(payload: UserStateSyncPayload, sessionToken?: string | null, signal?: AbortSignal) {
  const response = await apiFetch("/api/user-state", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...userHeaders(payload.userProfile.id, sessionToken)
    },
    body: JSON.stringify(payload)
  }, DEFAULT_API_TIMEOUT_MS, signal);
  if (!response.ok) throw new ApiHttpError(response.status, await readApiError(response));
  return (await response.json()) as { ok: true; userId: string; revision: number };
}

export async function exportUserBackup(sessionToken: string): Promise<UserBackup> {
  const response = await apiFetch("/api/backup", { headers: sessionHeaders(sessionToken) });
  if (!response.ok) throw new ApiHttpError(response.status, await readApiError(response));
  return response.json();
}

export async function inspectUserBackup(backup: unknown, sessionToken: string): Promise<BackupPreview> {
  const response = await apiFetch("/api/backup/inspect", { method: "POST", headers: { "Content-Type": "application/json", ...sessionHeaders(sessionToken) }, body: JSON.stringify({ backup }) });
  if (!response.ok) throw new ApiHttpError(response.status, await readApiError(response));
  return response.json();
}

export async function restoreUserBackup(backup: unknown, username: string, password: string, sessionToken: string): Promise<AuthSession> {
  const response = await apiFetch("/api/backup/restore", { method: "POST", headers: { "Content-Type": "application/json", ...sessionHeaders(sessionToken) }, body: JSON.stringify({ backup, username, password }) });
  if (!response.ok) throw new ApiHttpError(response.status, await readApiError(response));
  return response.json();
}

export async function getMemoryPolicy(kind: "chat" | "group", id: string, sessionToken: string): Promise<import("../shared/context").MemoryPolicy> {
  const response = await apiFetch(`/api/memory-policy/${kind}/${encodeURIComponent(id)}`, { headers: sessionHeaders(sessionToken) });
  if (!response.ok) throw new ApiHttpError(response.status, await readApiError(response));
  return response.json();
}
export async function setMemoryPolicy(kind: "chat" | "group", id: string, patch: { disabled?: boolean; messageId?: string; excluded?: boolean; contextTokens?: number }, sessionToken: string): Promise<import("../shared/context").MemoryPolicy> {
  const response = await apiFetch(`/api/memory-policy/${kind}/${encodeURIComponent(id)}`, { method: "PATCH", headers: { "Content-Type": "application/json", ...sessionHeaders(sessionToken) }, body: JSON.stringify(patch) });
  if (!response.ok) throw new ApiHttpError(response.status, await readApiError(response));
  return response.json();
}

export async function previewCharacter(card: import("../shared/characterCard").CharacterCardData, userMessage: string, settings: AppSettings, sessionToken: string) {
  const response = await apiFetch("/api/characters/test", { method: "POST", headers: { "Content-Type": "application/json", ...sessionHeaders(sessionToken) }, body: JSON.stringify({ card, userMessage, settings, locale: getLocale() }) }, CHAT_GENERATION_TIMEOUT_MS);
  if (!response.ok) throw new ApiHttpError(response.status, await readApiError(response));
  return response.json() as Promise<{ content: string }>;
}
export async function startCharacterChat(card: import("../shared/characterCard").CharacterCardData, sessionToken: string): Promise<Chat> {
  const response = await apiFetch("/api/characters/start-chat", { method: "POST", headers: { "Content-Type": "application/json", ...sessionHeaders(sessionToken) }, body: JSON.stringify({ card, title: t("Новый чат"), locale: getLocale() }) });
  if (!response.ok) throw new ApiHttpError(response.status, await readApiError(response));
  return (await response.json()).chat;
}

export async function getCharacterVersions(id: string, sessionToken: string): Promise<CharacterCard[]> {
  const response = await apiFetch(`/api/characters/${encodeURIComponent(id)}/versions`, { headers: sessionHeaders(sessionToken) });
  if (!response.ok) throw new ApiHttpError(response.status, await readApiError(response));
  return (await response.json()).versions;
}

export async function listTextFiles(sessionToken: string) {
  const response = await apiFetch("/api/text-files", { headers: sessionHeaders(sessionToken) });
  if (!response.ok) throw new Error(await readApiError(response));
  return (await response.json()) as { files: Omit<import("../shared/textFile").SavedTextFile, "text">[] };
}
export async function saveTextFile(name: string, text: string, sessionToken: string) {
  const response = await apiFetch("/api/text-files", { method: "POST", headers: { "Content-Type": "application/json", ...sessionHeaders(sessionToken) }, body: JSON.stringify({ name, text }) });
  if (!response.ok) throw new Error(await readApiError(response));
  return (await response.json()) as { file: import("../shared/textFile").SavedTextFile };
}
export async function getTextFile(id: string, sessionToken: string) {
  const response = await apiFetch(`/api/text-files/${encodeURIComponent(id)}`, { headers: sessionHeaders(sessionToken) });
  if (!response.ok) throw new Error(await readApiError(response));
  return (await response.json()) as { file: import("../shared/textFile").SavedTextFile };
}
export async function deleteTextFile(id: string, sessionToken: string) {
  const response = await apiFetch(`/api/text-files/${encodeURIComponent(id)}`, { method: "DELETE", headers: sessionHeaders(sessionToken) });
  if (!response.ok) throw new Error(await readApiError(response));
}
