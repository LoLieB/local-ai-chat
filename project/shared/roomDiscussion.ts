export type RoomDiscussion = { sceneTimeLimitSeconds?: number; sceneDeadlineAt?: number | null; roomRules?: string; participantRoles?: Record<string, string> };

export function validRoomDiscussion(value: RoomDiscussion, participantIds: string[]): boolean {
  if (value.sceneTimeLimitSeconds !== undefined && (!Number.isSafeInteger(value.sceneTimeLimitSeconds) || value.sceneTimeLimitSeconds < 0 || value.sceneTimeLimitSeconds > 3600)) return false;
  if (value.sceneDeadlineAt != null && (!Number.isSafeInteger(value.sceneDeadlineAt) || value.sceneDeadlineAt < 0)) return false;
  if (value.roomRules !== undefined && (typeof value.roomRules !== "string" || value.roomRules.length > 4000)) return false;
  const roles = value.participantRoles;
  return roles === undefined || Boolean(roles && typeof roles === "object" && !Array.isArray(roles) && Object.entries(roles).every(([id, role]) => participantIds.includes(id) && typeof role === "string" && role.length <= 500));
}

export function roomDiscussionPrompt(room: RoomDiscussion | null, participantId: string): string {
  const rules = room?.roomRules?.trim();
  const role = room?.participantRoles?.[participantId]?.trim();
  return [rules ? `Room discussion rules:\n${rules}` : "", role ? `Your role in this discussion (keep your character identity):\n${role}` : ""].filter(Boolean).join("\n\n");
}

export const DISCUSSION_PRESETS = [
  { id: "brainstorm", name: "Мозговой штурм", rules: "Предлагайте конкретные идеи по теме. Развивайте предложения других участников, избегайте повторов. В каждом ответе — одна новая идея и её польза.", roles: ["Генератор идей: предложи необычный подход.", "Практик: предложи способ воплощения идеи.", "Исследователь: предложи альтернативу."] },
  { id: "review", name: "Разбор решения", rules: "Обсуждайте предложенное решение по существу. Разделяйте факты и предположения. Замечания сопровождайте конкретным улучшением.", roles: ["Автор: объясни решение и его преимущества.", "Рецензент: найди риски и предложи исправления.", "Практик: оцени сложность реализации."] },
  { id: "debate", name: "Дебаты", rules: "Обсуждайте аргументы, а не личности. Не повторяйте уже сказанное. Подкрепляйте позицию примерами и указывайте ограничения.", roles: ["Сторонник: приведи аргументы в пользу идеи.", "Оппонент: приведи контраргументы.", "Модератор: сравни аргументы и обозначь открытые вопросы."] }
] as const;
