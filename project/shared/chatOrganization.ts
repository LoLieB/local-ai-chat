export type ChatOrganization = { archivedAt?: string | null; tags?: string[] };
export type ChatFilters = { query: string; archive: "active" | "archived" | "all"; characterId: string; tag: string; from: string; to: string; pinned: boolean };
export const DEFAULT_CHAT_FILTERS: ChatFilters = { query: "", archive: "active", characterId: "", tag: "", from: "", to: "", pinned: false };

export function normalizeChatTags(input: unknown): string[] {
  if (!Array.isArray(input) || input.length > 20 || !input.every(tag => typeof tag === "string" && tag.trim().length > 0 && tag.length <= 40 && !/[,\u0000-\u001f\u007f]/.test(tag))) throw new Error("Допускается до 20 тегов, каждый от 1 до 40 символов.");
  return [...new Set(input.map(tag => tag.trim()))];
}

export function validChatOrganization(input: unknown): boolean {
  if (!input || typeof input !== "object" || Array.isArray(input)) return false;
  const value = input as ChatOrganization;
  if (value.archivedAt != null && (typeof value.archivedAt !== "string" || !Number.isFinite(Date.parse(value.archivedAt)))) return false;
  try { if (value.tags !== undefined) normalizeChatTags(value.tags); return true; } catch { return false; }
}

export function filterChats<T extends ChatOrganization & { title: string; characterId: string | null; updatedAt: string; pinnedAt?: string | null }>(chats: T[], filters: ChatFilters): T[] {
  const query = filters.query.trim().toLocaleLowerCase("ru");
  return chats.filter(chat => {
    if (filters.archive !== "all" && Boolean(chat.archivedAt) !== (filters.archive === "archived")) return false;
    if (filters.pinned && !chat.pinnedAt) return false;
    if (filters.characterId && chat.characterId !== filters.characterId) return false;
    if (filters.tag && !chat.tags?.includes(filters.tag)) return false;
    if (query && !chat.title.toLocaleLowerCase("ru").includes(query)) return false;
    if (filters.from || filters.to) {
      const date = new Date(chat.updatedAt);
      if (!Number.isFinite(date.getTime())) return false;
      const key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
      if ((filters.from && key < filters.from) || (filters.to && key > filters.to)) return false;
    }
    return true;
  });
}
