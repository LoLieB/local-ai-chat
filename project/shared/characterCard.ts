export type CharacterDetails = {
  modelProfileId?: string;
  favorite?: boolean;
  personality?: string; speechStyle?: string; scenario?: string;
  firstMessage?: string; examples?: string; rules?: string;
};
export type CharacterCardData = CharacterDetails & {
  id: string; name: string; description: string; systemPrompt: string; avatar: string;
  posterUrl?: string; temperature: number; maxTokens: number; tags: string[];
  createdAt: string; updatedAt: string;
};
export const CHARACTER_FORMAT = "local-ai-chat-character";
export const CHARACTER_VERSION = 1;
export const MAX_CHARACTER_BYTES = 256 * 1024;
export const CHARACTER_DETAIL_FIELDS = ["personality", "speechStyle", "scenario", "firstMessage", "examples", "rules"] as const;
export function validCharacterDetails(value: CharacterDetails): boolean {
  return (value.modelProfileId === undefined || (typeof value.modelProfileId === "string" && /^[A-Za-z0-9_-]{0,128}$/.test(value.modelProfileId))) && (value.favorite === undefined || typeof value.favorite === "boolean") && CHARACTER_DETAIL_FIELDS.every(key => value[key] === undefined || (typeof value[key] === "string" && value[key]!.length <= 20000));
}
export function buildCharacterPrompt(card: Pick<CharacterCardData, "systemPrompt"> & CharacterDetails): string {
  const sections = [["Характер", card.personality], ["Стиль речи", card.speechStyle], ["Сценарий", card.scenario], ["Примеры диалога", card.examples], ["Правила персонажа", card.rules]];
  const extra = sections.filter(([, value]) => value?.trim()).map(([label, value]) => `${label}:\n${value!.trim()}`);
  return extra.length ? [card.systemPrompt, ...extra].filter(Boolean).join("\n\n") : card.systemPrompt;
}
export function validateCharacterCard(input: unknown): CharacterCardData {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Карточка должна быть объектом JSON.");
  const card = input as CharacterCardData;
  if (typeof card.id !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(card.id) ||
      ![card.name, card.description, card.systemPrompt, card.avatar, card.createdAt, card.updatedAt].every(s => typeof s === "string") ||
      !card.name.trim() || (card.posterUrl !== undefined && typeof card.posterUrl !== "string") ||
      !Number.isFinite(card.temperature) || card.temperature < 0 || card.temperature > 2 ||
      !Number.isSafeInteger(card.maxTokens) || card.maxTokens < 1 || card.maxTokens > 131072 ||
      !Array.isArray(card.tags) || card.tags.length > 100 || !card.tags.every(s => typeof s === "string" && s.length <= 128) || !validCharacterDetails(card)) {
    throw new Error("Некорректные поля карточки персонажа.");
  }
  if (new TextEncoder().encode(JSON.stringify(card)).length > MAX_CHARACTER_BYTES) throw new Error("Карточка превышает 256 КБ.");
  const result: CharacterCardData = { id: card.id, name: card.name, description: card.description, systemPrompt: card.systemPrompt, avatar: card.avatar,
    temperature: card.temperature, maxTokens: card.maxTokens, tags: [...card.tags], createdAt: card.createdAt, updatedAt: card.updatedAt };
  if (card.posterUrl !== undefined) result.posterUrl = card.posterUrl;
  if (card.favorite !== undefined) result.favorite = card.favorite;
  if (card.modelProfileId !== undefined) result.modelProfileId = card.modelProfileId;
  for (const key of CHARACTER_DETAIL_FIELDS) if (card[key] !== undefined) result[key] = card[key];
  return result;
}
export function exportCharacterCard(card: CharacterCardData) {
  const archive = { format: CHARACTER_FORMAT, version: CHARACTER_VERSION, character: validateCharacterCard(card) };
  if (new TextEncoder().encode(JSON.stringify(archive)).length > MAX_CHARACTER_BYTES) throw new Error("Архив карточки превышает 256 КБ.");
  return archive;
}
export function importCharacterCard(input: unknown): CharacterCardData {
  if (!input || typeof input !== "object") throw new Error("Некорректный файл карточки.");
  const value = input as Record<string, unknown>;
  if ("format" in value) {
    if (value.format !== CHARACTER_FORMAT || value.version !== CHARACTER_VERSION) throw new Error("Неподдерживаемая версия карточки.");
    return validateCharacterCard(value.character);
  }
  return validateCharacterCard(value);
}
