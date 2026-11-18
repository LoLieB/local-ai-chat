export type TranscriptMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
  createdAt: string;
};

export function editLatestUserMessage(messages: TranscriptMessage[], messageId: string, content: string) {
  const index = messages.findIndex((message) => message.id === messageId);
  const lastUserIndex = messages.map((message) => message.role).lastIndexOf("user");
  if (index < 0 || index !== lastUserIndex || !content.trim()) return null;
  return messages.slice(0, index + 1).map((message) => (message.id === messageId ? { ...message, content } : message));
}

export function deleteMessageById(messages: TranscriptMessage[], messageId: string) {
  return messages.some((message) => message.id === messageId)
    ? messages.filter((message) => message.id !== messageId)
    : null;
}

export function replaceLatestAssistantMessage(messages: TranscriptMessage[], messageId: string, content: string) {
  const index = messages.findIndex((message) => message.id === messageId);
  if (index < 0 || index !== messages.length - 1 || messages[index]?.role !== "assistant" || !content.trim()) return null;
  return messages.map((message) => (message.id === messageId ? { ...message, content } : message));
}

const sentenceUnits = (content: string) =>
  content.match(/[^.!?…]+[.!?…]+(?:["'»”)]*)|[^.!?…]+$/gu)?.map((part) => part.trim()).filter(Boolean) || [];

const normalizedUnit = (content: string) => content.replace(/\s+/g, " ").trim().toLocaleLowerCase();

export function mergeAssistantContinuation(existing: string, addition: string) {
  const trimmedAddition = addition.trim();
  if (!trimmedAddition) return existing;

  const normalizedExisting = normalizedUnit(existing);
  const normalizedAddition = normalizedUnit(trimmedAddition);
  if (normalizedAddition.length >= 32 && normalizedExisting.includes(normalizedAddition)) return existing;

  const existingUnits = new Set(
    sentenceUnits(existing)
      .map(normalizedUnit)
      .filter((unit) => unit.length >= 32)
  );
  const addedUnits = new Set<string>();
  const uniqueAddition = sentenceUnits(trimmedAddition).filter((unit) => {
    const normalized = normalizedUnit(unit);
    if (normalized.length < 32) return true;
    if (existingUnits.has(normalized) || addedUnits.has(normalized)) return false;
    addedUnits.add(normalized);
    return true;
  }).join(" ");

  if (!uniqueAddition) return existing;
  return !existing || /\s$/.test(existing) || /^\s/.test(uniqueAddition)
    ? `${existing}${uniqueAddition}`
    : `${existing} ${uniqueAddition}`;
}

export function appendToLatestAssistantMessage(messages: TranscriptMessage[], messageId: string, content: string) {
  const index = messages.findIndex((message) => message.id === messageId);
  if (index < 0 || index !== messages.length - 1 || messages[index]?.role !== "assistant" || !content.trim()) return null;
  const previous = messages[index].content;
  const nextContent = mergeAssistantContinuation(previous, content);
  return messages.map((message) => (message.id === messageId ? { ...message, content: nextContent } : message));
}
