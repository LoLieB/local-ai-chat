export const TEXT_FILE_ACCEPT = ".txt,.md,.csv,.json,.log";
export const MAX_TEXT_FILE_BYTES = 32 * 1024;

export function formatTextFile(name: string, bytes: ArrayBuffer): string {
  if (!/\.(txt|md|csv|json|log)$/i.test(name)) throw new Error("Поддерживаются TXT, MD, CSV, JSON и LOG.");
  if (bytes.byteLength > MAX_TEXT_FILE_BYTES) throw new Error("Файл должен быть не больше 32 КБ.");
  let text: string;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch { throw new Error("Сохраните файл в кодировке UTF-8 и добавьте снова."); }
  if (!text.trim()) throw new Error("Файл пуст.");
  if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(text)) throw new Error("Файл содержит нетекстовые данные.");
  if (text.length > 16000) throw new Error("В файле больше 16 000 символов. Разделите его на части.");
  const safeName = name.replace(/[\r\n\x00-\x1f\x7f]/g, " ").slice(0, 160);
  const fence = "`".repeat(Math.max(3, ...Array.from(text.matchAll(/`+/g), match => match[0].length + 1)));
  return `Файл: ${safeName}\n${fence}text\n${text}\n${fence}`;
}

export type SavedTextFile = { id: string; name: string; text: string; size: number; createdAt: string };
