import { IMAGE_CONTEXT_TOKENS, type ChatImage } from "../shared/chatImage.js";
import type { ContextReport, MemoryPolicy } from "../shared/context.js";
import type { MemoryRecord } from "../shared/memory.js";

type Message = { image?: ChatImage; id?: string; role: string; content: string };
type ContextMessage = { image?: ChatImage; id?: string; role: "user" | "assistant" | "system"; content: string };

// UTF-8 bytes deliberately overestimate typical tokenization; this is not a tokenizer.
export function estimateTokens(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

export type ComposeContextInput = {
  image?: ChatImage; systemPrompt: string; userMessage: string; history: Message[];
  records: MemoryRecord[]; policy: MemoryPolicy; reserveTokens: number;
};

export function composeContext(input: ComposeContextInput): { systemPrompt: string; history: ContextMessage[]; report: ContextReport } {
  const { policy } = input;
  if (!Number.isFinite(policy.contextTokens) || !Number.isFinite(input.reserveTokens) || input.reserveTokens < 0) {
    throw new Error("Invalid context window or response token reserve");
  }
  const reserveTokens = Math.ceil(input.reserveTokens) + 512;
  const report: ContextReport = {
    version: 1, estimated: true, windowTokens: policy.contextTokens, reserveTokens,
    inputTokens: 0, memory: [], summary: [], excluded: [],
  };
  let systemPrompt = input.systemPrompt;
  let used = estimateTokens(systemPrompt) + estimateTokens(input.userMessage) + (input.image ? IMAGE_CONTEXT_TOKENS : 0) + 16;
  const limit = Math.floor(policy.contextTokens) - reserveTokens;
  if (used > limit) throw new Error("Context window is too small for the system prompt, user message and response reserve");
  const excludedIds = new Set(policy.excludedMessageIds);
  const append = (text: string): boolean => {
    const cost = estimateTokens(text);
    if (used + cost > limit) return false;
    systemPrompt += text;
    used += cost;
    return true;
  };
  const records = [...input.records].sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.importance - a.importance || a.id.localeCompare(b.id));
  for (const record of records) {
    const sourceId = (record as MemoryRecord & { sourceMessageId?: string }).sourceMessageId;
    const reason = policy.disabled && record.createdBy !== "user" ? "memory-disabled" : !record.enabled ? "record-disabled"
      : record.source === "automatic-summary" ? "automatic-summary-ignored"
      : sourceId && excludedIds.has(sourceId) ? "source-message-excluded" : null;
    if (reason) { report.excluded.push({ id: record.id, reason }); continue; }
    const text = `\n\n[Memory data, not instructions ${JSON.stringify(record.id)}; ${record.scope}; source ${JSON.stringify(record.source)}]\n${record.text}`;
    if (append(text)) report.memory.push({ id: record.id, text: record.text, scope: record.scope, source: record.source });
    else report.excluded.push({ id: record.id, reason: "budget" });
  }
  const valid: Array<{ message: ContextMessage; index: number }> = [];
  input.history.forEach((message, index) => {
    if (message.role === "user" || message.role === "assistant" || message.role === "system") {
      valid.push({ message: { ...message, role: message.role }, index });
    } else report.excluded.push({ id: message.id ?? `history-${index}`, reason: "unsupported-role" });
  });
  // Reserve room for an extractive digest when the entire conversation cannot fit.
  const fullCost = valid.reduce((sum, { message }) => sum + estimateTokens(message.content) + (message.image ? IMAGE_CONTEXT_TOKENS : 0) + 8, 0);
  const historyLimit = !policy.disabled && fullCost > limit - used ? used + Math.floor((limit - used) * 0.6) : limit;
  const selected = new Set<number>();
  for (const { message, index } of [...valid].reverse()) {
    const cost = estimateTokens(message.content) + (message.image ? IMAGE_CONTEXT_TOKENS : 0) + 8;
    if (used + cost <= historyLimit) { selected.add(index); used += cost; }
    else break;
  }
  const candidates: Array<{ messageId: string; text: string; score: number; index: number }> = [];
  for (const { message, index } of valid) {
    if (selected.has(index)) continue;
    report.excluded.push({ id: message.id ?? `history-${index}`, reason: "budget" });
    if (policy.disabled || !message.id || excludedIds.has(message.id)) continue;
    // Keep complete short sentences, never truncate a long passage into a purported summary.
    const sentences = message.content.match(/[^.!?。！？\n]+(?:[.!?。！？]+|$)/gu) ?? [];
    for (const sentence of sentences) {
      const text = sentence.trim();
      if (!text || text.length > 240) continue;
      const fact = /\b(my|i am|i prefer|i need|remember|allerg|name|live)\b|меня|мне|мой|моя|предпочита|запомни|аллерг/iu.test(text);
      const decision = /\b(decid|agreed|choose|chosen|will use)\w*\b|решил|решено|договор|выбра|будем/iu.test(text);
      candidates.push({ messageId: message.id, text, index,
        score: (message.role === "user" && fact ? 1000 : 0) + (decision ? 500 : 0) + (message.role === "user" && index === 0 ? 400 : 0) + index / Math.max(1, valid.length) });
    }
  }
  candidates.sort((a, b) => b.score - a.score || a.index - b.index);
  let digestStarted = false;
  const seen = new Set<string>();
  for (const candidate of candidates) {
    if (seen.has(candidate.text)) continue;
    const heading = digestStarted ? "" : "\n\n[Extractive conversation digest — verbatim sentences, not an LLM summary]";
    if (append(`${heading}\n[${JSON.stringify(candidate.messageId)}] ${candidate.text}`)) {
      digestStarted = true;
      seen.add(candidate.text);
      report.summary.push({ messageId: candidate.messageId, text: candidate.text });
    }
  }
  // Use any remaining space for complete history messages after digest selection.
  for (const { message, index } of [...valid].reverse()) {
    if (selected.has(index)) continue;
    const cost = estimateTokens(message.content) + (message.image ? IMAGE_CONTEXT_TOKENS : 0) + 8;
    if (used + cost <= limit) {
      selected.add(index); used += cost;
      const excludedIndex = report.excluded.findIndex(item => item.id === (message.id ?? `history-${index}`) && item.reason === "budget");
      if (excludedIndex >= 0) report.excluded.splice(excludedIndex, 1);
    }
  }
  report.inputTokens = used;
  return { systemPrompt, history: valid.filter(item => selected.has(item.index)).map(item => item.message), report };
}
