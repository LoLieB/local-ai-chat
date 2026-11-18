export type ChatTitleMode = "default" | "auto" | "manual";

const CONTROL_CHARS = /[\u0000-\u001f\u007f]/g;

export function normalizeChatTitle(value: unknown, fallback = "Новый чат") {
  const normalized = typeof value === "string"
    ? value.replace(CONTROL_CHARS, " ").replace(/\s+/g, " ").trim().slice(0, 80)
    : "";
  return normalized || fallback;
}

export function normalizeChatTitleMode(value: unknown, title: string): ChatTitleMode {
  if (value === "auto" || value === "manual" || value === "default") return value;
  return ["Новый чат", "New chat"].includes(title) ? "default" : "manual";
}

export function normalizeGeneratedChatTitle(value: unknown) {
  if (typeof value !== "string") return "";
  const normalized = value.replace(/```[\s\S]*?```/g, "").replace(/^\s*(?:title|название)\s*:\s*/i, "").replace(/["'«»]/g, "").replace(CONTROL_CHARS, "").replace(/\s+/g, " ").trim().replace(/[.!?,:;]+$/g, "").slice(0, 80);
  const words = normalized.split(/\s+/).filter(Boolean);
  return words.length >= 1 && words.length <= 10 ? normalized : "";
}

export type MessageAuthorLike = {
  role: "user" | "assistant";
  authorCharacterId?: string | null;
  authorNameSnapshot?: string | null;
};

export function resolveMessageAuthorName(
  message: MessageAuthorLike,
  characters: Array<{ id: string; name: string }>,
  chatCharacter?: { id: string; name: string } | null,
  fallback = "Ассистент"
) {
  if (message.role === "user") return "Вы";
  if (message.authorCharacterId) {
    const current = characters.find((character) => character.id === message.authorCharacterId);
    if (current?.name.trim()) return current.name.trim();
  }
  if (message.authorNameSnapshot?.trim()) return message.authorNameSnapshot.trim();
  if (chatCharacter?.name.trim()) return chatCharacter.name.trim();
  return fallback;
}
