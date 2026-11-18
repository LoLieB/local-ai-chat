function normalizeContent(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }

  if (Array.isArray(value)) {
    return value
      .map((part) => {
        if (typeof part === "string") return part;
        if (!part || typeof part !== "object") return "";
        const record = part as { text?: unknown; content?: unknown };
        return typeof record.text === "string"
          ? record.text
          : typeof record.content === "string"
            ? record.content
            : "";
      })
      .join("");
  }

  return "";
}

export function extractLmStudioStreamDelta(line: string) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith(":") || /^(?:event|id|retry):/i.test(trimmed)) {
    return "";
  }

  const hasDataPrefix = trimmed.startsWith("data:");
  const payload = hasDataPrefix ? trimmed.slice(5).trim() : trimmed;
  if (!payload || payload === "[DONE]") {
    return "";
  }

  try {
    const parsed = JSON.parse(payload) as {
      choices?: Array<{
        delta?: { content?: unknown };
        message?: { content?: unknown };
        text?: unknown;
      }>;
    };
    const choice = parsed.choices?.[0];
    return normalizeContent(choice?.delta?.content ?? choice?.message?.content ?? choice?.text);
  } catch {
    return hasDataPrefix ? payload : "";
  }
}

export function splitLmStudioStreamLines(buffer: string, chunk: string, flush = false) {
  const combined = buffer + chunk;
  const lines = combined.split(/\r?\n/);

  if (flush) {
    return { lines: lines.filter((line) => line.length > 0), buffer: "" };
  }

  return { lines: lines.slice(0, -1), buffer: lines.at(-1) || "" };
}

export function createStreamCompletionGuard() {
  let completed = false;
  return {
    inspect(line: string) {
      const trimmed = line.trim();
      if (/^event:\s*error\s*$/i.test(trimmed)) throw new Error("Upstream stream reported an error.");
      if (!trimmed.startsWith("data:")) return;
      const payload = trimmed.slice(5).trim();
      if (payload === "[DONE]") { completed = true; return; }
      let parsed: any;
      try { parsed = JSON.parse(payload); } catch { return; }
      if (parsed?.error) throw new Error("Upstream stream reported an error.");
    },
    finish() {
      if (!completed) throw new Error("Upstream stream interrupted before completion.");
    }
  };
}
