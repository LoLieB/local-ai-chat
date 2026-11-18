export const MEMORY_EXPORT_FORMAT = "local-ai-chat-memory";
export const MEMORY_EXPORT_VERSION = 1;

export type MemoryScope = "user" | "character" | "chat" | "group" | "daily";
export type MemoryKind = "profile" | "preference" | "goal" | "decision" | "event" | "relationship" | "context" | "summary";
export type MemoryCreatedBy = "user" | "system" | "character";

export type MemoryRecord = {
  id: string;
  sourceMessageId?: string;
  scope: MemoryScope;
  text: string;
  kind: MemoryKind;
  source: string;
  createdBy: MemoryCreatedBy;
  createdAt: string;
  updatedAt: string;
  lastAccessedAt: string | null;
  pinned: boolean;
  enabled: boolean;
  confidence: number;
  importance: number;
  characterId?: string;
  chatId?: string;
  groupChatId?: string;
};

export type MemoryExport = {
  format: typeof MEMORY_EXPORT_FORMAT;
  version: typeof MEMORY_EXPORT_VERSION;
  exportedAt: string;
  records: MemoryRecord[];
};

export function isMemoryScope(value: unknown): value is MemoryScope {
  return value === "user" || value === "character" || value === "chat" || value === "group" || value === "daily";
}

export function isMemoryKind(value: unknown): value is MemoryKind {
  return value === "profile" || value === "preference" || value === "goal" || value === "decision" || value === "event" || value === "relationship" || value === "context" || value === "summary";
}
