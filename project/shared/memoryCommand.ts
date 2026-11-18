import type { MemoryScope } from "./memory.js";

export type ExplicitMemoryCommand = {
  text: string;
  scope: MemoryScope;
  characterId?: string;
  chatId?: string;
  groupChatId?: string;
};

export function parseExplicitMemoryCommand(
  input: string,
  context: { characterId?: string | null; chatId?: string | null; groupChatId?: string | null } = {}
): ExplicitMemoryCommand | null {
  const match = input.trim().match(/^(?:запомни|remember)(?:\s+что)?\s*:?\s*(.+)$/iu);
  const text = match?.[1]?.replace(/\s+/g, " ").trim() || "";
  if (!text) return null;

  if (context.groupChatId && /(?:для\s+(?:группы|комнаты)|в\s+(?:этой\s+)?(?:группе|комнате)|group\s+memory)/iu.test(text)) {
    return { text, scope: "group", groupChatId: context.groupChatId };
  }
  if (context.chatId && /(?:для\s+(?:этого\s+)?чата|в\s+(?:этом\s+)?чате|chat\s+memory)/iu.test(text)) {
    return { text, scope: "chat", chatId: context.chatId };
  }
  if (context.characterId && /(?:для\s+персонажа|память\s+персонажа|character\s+memory)/iu.test(text)) {
    return { text, scope: "character", characterId: context.characterId };
  }
  return { text, scope: "user" };
}

export function formatMemoryConfirmation(command: ExplicitMemoryCommand, source: string) {
  const labels: Record<MemoryScope, string> = {
    user: "Общая память",
    character: "Память персонажа",
    chat: "Память чата",
    group: "Память группы",
    daily: "Память дня"
  };
  return `Запомнила:\n${command.text}\nКатегория: ${labels[command.scope]}\nИсточник: ${source}`;
}
