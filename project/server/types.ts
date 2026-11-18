import type { ContextReport, MemoryPolicy } from "../shared/context.js";
import type { MemoryRecord } from "../shared/memory.js";
export type ChatRole = "system" | "user" | "assistant";
export type GroupResponseMode = "single-speaker" | "round-robin";

export type ChatMessage = {
  image?: import("../shared/chatImage.js").ChatImage;
  role: ChatRole;
  content: string;
};

export type AppSettings = {
  modelProfiles?: import("../shared/modelProfile.js").ModelProfile[];
  baseUrl: string;
  modelId: string;
  streaming: boolean;
  temperature: number;
  maxTokens: number;
};

export type AuthCredentialsPayload = {
  username: string;
  password: string;
};

export type ChatRequest = {
  image?: import("../shared/chatImage.js").ChatImage;
  chatId?: string;
  chatTitle?: string;
  settings?: Partial<AppSettings>;
  model?: string;
  personaSystemPrompt?: string;
  personaName?: string;
  personaCharacterId?: string | null;
  history: Array<ChatMessage & { id?: string; createdAt?: string }>;
  userMessage: string;
  userMessageId?: string;
  userMessageCreatedAt?: string;
  assistantMessageId?: string;
  action?: "send" | "regenerate" | "continue";
  targetMessageId?: string;
  revision?: number;
  temperature?: number;
  maxTokens?: number;
};

export type ChatMutationRequest = {
  archived?: boolean;
  tags?: string[];
  modelProfileId?: string | null;
  chatId?: string;
  action: "edit" | "delete" | "branch" | "switch" | "pin" | "unpin" | "import" | "rename" | "pin-chat" | "unpin-chat" | "generate-title" | "set-profile" | "organize";
  messageId?: string;
  content?: string;
  title?: string;
  characterId?: string | null;
  automatic?: boolean;
  revision?: number;
  importedChat?: unknown;
};

export type GroupParticipant = {
  resolvedSettings?: AppSettings;
  contextReport?: ContextReport;
  memoryPolicy?: MemoryPolicy;
  memoryRecords?: MemoryRecord[];
  responseReserve?: number;
  id: string;
  name: string;
  systemPrompt: string;
  avatar?: string;
};

export type GroupChatMessage = {
  id?: string;
  createdAt?: string;
  contextReport?: ContextReport;
  role: "user" | "assistant";
  content: string;
  characterId?: string;
  characterName?: string;
};

export type GroupChatRequest = {
  sceneDeadlineAt?: number | null;
  revision?: number;
  remainingParticipantIds?: string[];
  resumeScene?: boolean;
  skippedParticipantIds?: string[];
  groupChatId?: string;
  groupChatTitle?: string;
  settings?: Partial<AppSettings>;
  messages: GroupChatMessage[];
  participants: GroupParticipant[];
  activeSpeakerCharacterId?: string | null;
  responseMode: GroupResponseMode;
  maxRepliesPerTurn: number;
  model?: string;
  temperature?: number;
  maxTokens?: number;
};

export type DirectorSuggestion =
  | { action: "speak"; participantId: string; task: string; reason: string; stopCondition: string }
  | { action: "stop"; reason: string; stopCondition: string };

export type ApiErrorCode =
  | "LM_STUDIO_UNAVAILABLE"
  | "INVALID_BASE_URL"
  | "MODEL_REQUIRED"
  | "EMPTY_MESSAGE"
  | "NO_PARTICIPANTS"
  | "PARTICIPANT_NOT_FOUND"
  | "DIRECTOR_RESPONSE_INVALID"
  | "AUTH_REQUIRED"
  | "AUTH_INVALID"
  | "USERNAME_TAKEN"
  | "BAD_REQUEST";

export class ApiError extends Error {
  status: number;
  code: ApiErrorCode;

  constructor(status: number, code: ApiErrorCode, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}
