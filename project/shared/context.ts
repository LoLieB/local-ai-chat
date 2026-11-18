export type MemoryPolicy = { disabled: boolean; excludedMessageIds: string[]; contextTokens: number };
export const DEFAULT_MEMORY_POLICY: MemoryPolicy = { disabled: false, excludedMessageIds: [], contextTokens: 8192 };
export type ContextReport = {
  version: 1; estimated: true; windowTokens: number; reserveTokens: number; inputTokens: number;
  memory: Array<{ id: string; text: string; source: string; scope: string }>;
  summary: Array<{ messageId: string; text: string }>;
  excluded: Array<{ id: string; reason: string }>;
};

export function isMemoryPolicy(value: unknown): value is MemoryPolicy {
  if (!value || typeof value !== "object") return false;
  const p = value as MemoryPolicy;
  return typeof p.disabled === "boolean" && Number.isSafeInteger(p.contextTokens) && p.contextTokens >= 2048 && p.contextTokens <= 131072 && Array.isArray(p.excludedMessageIds) && p.excludedMessageIds.length <= 10000 && p.excludedMessageIds.every(id => typeof id === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(id));
}
export function isContextReport(value: unknown): value is ContextReport {
  if (!value || typeof value !== "object") return false;
  const p = value as ContextReport;
  return p.version === 1 && p.estimated === true && [p.windowTokens, p.reserveTokens, p.inputTokens].every(n => Number.isFinite(n) && n >= 0) &&
    Array.isArray(p.memory) && p.memory.every(m => m && [m.id,m.text,m.source,m.scope].every(s => typeof s === "string")) &&
    Array.isArray(p.summary) && p.summary.every(m => m && typeof m.messageId === "string" && typeof m.text === "string") &&
    Array.isArray(p.excluded) && p.excluded.every(m => m && typeof m.id === "string" && typeof m.reason === "string");
}
