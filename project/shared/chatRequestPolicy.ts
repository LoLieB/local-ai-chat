export const DEFAULT_API_TIMEOUT_MS = 10_000;
export const CHAT_GENERATION_TIMEOUT_MS = 10 * 60 * 1000;
export const EMPTY_MODEL_REPLY_HINT = "Модель завершила запрос без текста ответа. Если в LM Studio включены рассуждения, уменьшите их лимит токенов и повторите запрос.";

export type ChatRequestErrorKind = "timeout" | "stream-abort" | "technical" | "unknown";

const technicalErrorPattern =
  /\b(?:HTTP \d{3}|TypeError|ReferenceError|SyntaxError|AbortError|TimeoutError|Failed to fetch|NetworkError|ECONNREFUSED|ECONNRESET|stack| at |<!doctype|<html|JSON|Unexpected token)\b/i;

const timeoutPattern = /request timed out|timeout|timed out/i;
const streamAbortPattern = /BodyStreamBuffer was aborted|stream.*abort|aborted.*stream|stream interrupted/i;

export function classifyChatRequestError(error: unknown): ChatRequestErrorKind {
  const message = error instanceof Error ? error.message : String(error || "");

  if (timeoutPattern.test(message)) {
    return "timeout";
  }
  if (streamAbortPattern.test(message)) {
    return "stream-abort";
  }
  if (!message || message.length > 160 || message.includes("\n") || technicalErrorPattern.test(message)) {
    return "technical";
  }

  return "unknown";
}

export function formatChatRequestError(
  error: unknown,
  fallback: "generic" | "chat" | "group" | string = "generic"
) {
  const kind = classifyChatRequestError(error);
  const usesChatFallback = fallback === "generic" || fallback === "chat" || fallback === "group";
  if (kind === "timeout") {
    return usesChatFallback
      ? "Локальная модель не успела ответить. Первый запуск может занять больше времени. Попробуйте повторить запрос."
      : fallback;
  }
  if (kind === "stream-abort") {
    return usesChatFallback
      ? "Ответ был прерван из-за обрыва потока. Часть текста могла сохраниться."
      : fallback;
  }
  if (kind === "unknown" && error instanceof Error) {
    return error.message.trim();
  }
  if (fallback === "group") {
    return "Не удалось отправить сообщение группы.";
  }
  if (fallback === "chat" || fallback === "generic") {
    return "Не удалось получить ответ модели.";
  }

  return fallback;
}

export function shouldPreservePartialResponse(partialContent: string, _error: unknown) {
  return partialContent.trim().length > 0;
}
