import type { CharacterDetails } from "../../shared/characterCard";
import type { ContextReport } from "../../shared/context";
export type MessageRole = "user" | "assistant";
export type GroupResponseMode = "single-speaker" | "round-robin";

export type UserProfile = {
  id: string;
  label: string;
  createdAt: string;
  updatedAt: string;
  autoNameNewChats?: boolean;
};

export type AuthSession = {
  username: string;
  userId: string;
  sessionToken: string;
  expiresAt?: string;
};

export type ChatMessage = {
  image?: import("../../shared/chatImage").ChatImage;
  contextReport?: ContextReport;
  id: string;
  role: MessageRole;
  content: string;
  createdAt: string;
  parentId?: string | null;
  authorCharacterId?: string | null;
  authorNameSnapshot?: string | null;
};

export type CharacterCard = CharacterDetails & {
  id: string;
  name: string;
  description: string;
  systemPrompt: string;
  avatar: string;
  posterUrl?: string;
  temperature: number;
  maxTokens: number;
  tags: string[];
  createdAt: string;
  updatedAt: string;
};

export type Chat = {
  archivedAt?: string | null;
  tags?: string[];
  modelProfileId?: string | null;
  id: string;
  title: string;
  characterId: string | null;
  messages: ChatMessage[];
  activeLeafId?: string | null;
  revision?: number;
  branches?: Record<string, string[]>;
  allMessages?: ChatMessage[];
  pinnedMessageIds?: string[];
  titleMode?: "default" | "auto" | "manual";
  pinnedAt?: string | null;
  createdAt: string;
  updatedAt: string;
};

export type GroupChatMessage = {
  contextReport?: ContextReport;
  id: string;
  role: MessageRole;
  content: string;
  characterId?: string;
  characterName?: string;
  createdAt: string;
};

export type GroupChat = {
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
  messages: GroupChatMessage[];
  responseMode: GroupResponseMode;
  maxRepliesPerTurn: number;
  createdAt: string;
  updatedAt: string;
};

export type AppSettings = {
  modelProfiles?: import("../../shared/modelProfile").ModelProfile[];
  baseUrl: string;
  modelId: string;
  streaming: boolean;
  temperature: number;
  maxTokens: number;
};

export type AppState = {
  workspaceRevision?: number;
  authSession?: AuthSession | null;
  userProfile: UserProfile;
  settings: AppSettings;
  chats: Chat[];
  groupChats: GroupChat[];
  characters: CharacterCard[];
  activeChatId: string | null;
  activeGroupChatId: string | null;
};

export type ApiErrorBody = {
  error?: {
    code: string;
    message: string;
  };
};
