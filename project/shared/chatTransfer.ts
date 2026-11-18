import { validChatImage, type ChatImage } from "./chatImage.js";
import { validChatOrganization, type ChatOrganization } from "./chatOrganization.js";
export const CHAT_EXPORT_FORMAT = "local-ai-chat.ordinary-chat";
export const CHAT_EXPORT_VERSION = 1;
export const MAX_IMPORT_MESSAGES = 10000;
export { MAX_BACKUP_BYTES as MAX_CHAT_IMPORT_BYTES } from "./backup.js";
type TransferMessage = { image?: ChatImage; id: string; role: "user" | "assistant"; content: string; createdAt: string; parentId?: string | null; authorCharacterId?: string | null; authorNameSnapshot?: string | null };
type ImportedChat = ChatOrganization & { title: string; titleMode?: "default" | "auto" | "manual"; pinnedAt?: string | null; characterId?: string | null; messages: TransferMessage[]; activeLeafId?: string | null; pinnedMessageIds: string[] };
function isObject(value: unknown): value is Record<string, unknown> { return Boolean(value) && typeof value === "object" && !Array.isArray(value); }
export function validateImportedChat(input: unknown): ImportedChat {
  const root = isObject(input) && isObject(input.chat) ? input.chat : input;
  if (!isObject(input) || ("format" in input && input.format !== CHAT_EXPORT_FORMAT) || ("version" in input && input.version !== CHAT_EXPORT_VERSION)) throw new Error("Неподдерживаемый формат резервной копии.");
  if (!isObject(root) || typeof root.title !== "string" || !Array.isArray(root.messages) || root.messages.length > MAX_IMPORT_MESSAGES) throw new Error("Резервная копия имеет неверную структуру.");
  const messages: TransferMessage[] = []; const ids = new Set<string>();
  for (const raw of root.messages) {
    if (!isObject(raw) || typeof raw.id !== "string" || !raw.id.trim() || ids.has(raw.id) || (raw.role !== "user" && raw.role !== "assistant") || typeof raw.content !== "string" || typeof raw.createdAt !== "string" || (raw.parentId !== null && raw.parentId !== undefined && typeof raw.parentId !== "string")) throw new Error("В резервной копии найдено некорректное сообщение.");
    if (raw.authorCharacterId !== undefined && raw.authorCharacterId !== null && typeof raw.authorCharacterId !== "string") throw new Error("Некорректный автор сообщения.");
    if (raw.authorNameSnapshot !== undefined && raw.authorNameSnapshot !== null && typeof raw.authorNameSnapshot !== "string") throw new Error("Некорректное имя автора сообщения.");
    if (raw.image !== undefined && (raw.role !== "user" || !validChatImage(raw.image))) throw new Error("Некорректное изображение сообщения.");
    if (typeof raw.parentId === "string" && !ids.has(raw.parentId)) throw new Error("В резервной копии родительское сообщение должно идти перед ответом.");
    ids.add(raw.id); messages.push({ image: raw.image as ChatImage | undefined, id: raw.id, role: raw.role, content: raw.content, createdAt: raw.createdAt, parentId: raw.parentId === undefined ? null : raw.parentId, authorCharacterId: raw.authorCharacterId === undefined ? null : raw.authorCharacterId, authorNameSnapshot: raw.authorNameSnapshot === undefined ? null : raw.authorNameSnapshot });
  }
  for (const message of messages) if (message.parentId && !ids.has(message.parentId)) throw new Error("В резервной копии есть повреждённая связь сообщений.");
  const visiting = new Set<string>(); const visited = new Set<string>();
  const visit = (id: string) => { if (visiting.has(id)) throw new Error("В резервной копии обнаружен цикл сообщений."); if (visited.has(id)) return; visiting.add(id); const parent = messages.find((message) => message.id === id)?.parentId; if (parent) visit(parent); visiting.delete(id); visited.add(id); };
  messages.forEach((message) => visit(message.id));
  if (root.activeLeafId !== null && root.activeLeafId !== undefined && (typeof root.activeLeafId !== "string" || !ids.has(root.activeLeafId))) throw new Error("Активная ветка резервной копии не существует.");
  const pins = root.pinnedMessageIds === undefined ? [] : root.pinnedMessageIds;
  if (!Array.isArray(pins) || pins.some((id) => typeof id !== "string" || !ids.has(id)) || new Set(pins).size !== pins.length) throw new Error("Закрепления резервной копии некорректны.");
  if (root.titleMode !== undefined && root.titleMode !== "default" && root.titleMode !== "auto" && root.titleMode !== "manual") throw new Error("Некорректный режим названия чата.");
  if (root.pinnedAt !== undefined && root.pinnedAt !== null && typeof root.pinnedAt !== "string") throw new Error("Некорректная дата закрепления чата.");
  if (!validChatOrganization(root)) throw new Error("Некорректный архив или теги чата.");
  return { archivedAt: root.archivedAt as string | null | undefined, tags: root.tags as string[] | undefined, title: root.title, titleMode: root.titleMode, pinnedAt: root.pinnedAt === undefined ? null : root.pinnedAt, characterId: typeof root.characterId === "string" ? root.characterId : null, messages, activeLeafId: typeof root.activeLeafId === "string" ? root.activeLeafId : null, pinnedMessageIds: pins };
}
