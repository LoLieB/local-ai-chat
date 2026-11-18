import { useEffect, useSyncExternalStore } from "react";
import { en } from "./en";

export type Locale = "ru-RU" | "en-US";
type TranslationKey = keyof typeof en;
const storageKey = "local-ai-chat:locale";
const listeners = new Set<() => void>();

function initialLocale(): Locale {
  try {
    const saved = localStorage.getItem(storageKey);
    if (saved === "ru-RU" || saved === "en-US") return saved;
  } catch { /* Storage can be unavailable in private browsing. */ }
  return typeof navigator !== "undefined" && (navigator.languages?.[0] || navigator.language)?.toLowerCase().startsWith("ru") ? "ru-RU" : "en-US";
}
let locale: Locale = initialLocale();
export function getLocale(): Locale { return locale; }
export function setLocale(value: Locale) {
  if (locale === value) return;
  locale = value;
  try { localStorage.setItem(storageKey, value); } catch { /* The current session still works. */ }
  listeners.forEach((listener) => listener());
}
function subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; }
export function useLocale(): Locale {
  const current = useSyncExternalStore(subscribe, getLocale, (): Locale => "en-US");
  useEffect(() => { document.documentElement.lang = current; }, [current]);
  return current;
}
export function t(key: TranslationKey, values?: Record<string, string | number>): string {
  const message: string = locale === "ru-RU" ? key : (en[key] ?? key);
  return values ? message.replace(/\{(\w+)\}/g, (match, name: string) => String(values[name] ?? match)) : message;
}
export function plural(count: number, forms: Partial<Record<Intl.LDMLPluralRule, string>> & { other: string }): string {
  return (forms[new Intl.PluralRules(locale).select(count)] ?? forms.other).replace("{count}", new Intl.NumberFormat(locale).format(count));
}


const countForms = {
  "ru-RU": { messages: { one: "{count} сообщение", few: "{count} сообщения", many: "{count} сообщений", other: "{count} сообщения" }, participants: { one: "{count} участник", few: "{count} участника", many: "{count} участников", other: "{count} участника" }, records: { one: "{count} запись", few: "{count} записи", many: "{count} записей", other: "{count} записи" }, models: { one: "{count} модель загружена", few: "{count} модели загружены", many: "{count} моделей загружено", other: "{count} модели загружено" } },
  "en-US": { messages: { one: "{count} message", other: "{count} messages" }, participants: { one: "{count} participant", other: "{count} participants" }, records: { one: "{count} record", other: "{count} records" }, models: { one: "{count} model loaded", other: "{count} models loaded" } }
} as const;
export function pluralCount(key: keyof typeof countForms["en-US"], count: number): string {
  return plural(count, countForms[locale][key]);
}

// Only use this for known interface notifications and errors, never message content.
export function localizeMessage(message: string): string {
  const entries = Object.entries(en);
  const exact = entries.find(([ru, english]) => message === ru || message === english);
  if (exact) return locale === "ru-RU" ? exact[0] : exact[1];
  for (const [ru, english] of entries) {
    if (!ru.includes("{p")) continue;
    for (const source of [ru, english]) {
      const names: string[] = [];
      const pattern = source.split(/(\{p\d+\})/g).map((part) => {
        if (/^\{p\d+\}$/.test(part)) { names.push(part.slice(1, -1)); return "([\\s\\S]*?)"; }
        return part.replace(/[.*+?^\x24{}()|[\]\\]/g, "\\\x24&");
      }).join("");
      const match = new RegExp("^" + pattern + "$").exec(message);
      if (match) {
        const values = Object.fromEntries(names.map((name, i) => [name, match[i + 1]]));
        return (locale === "ru-RU" ? ru : english).replace(/\{(p\d+)\}/g, (part, name: string) => values[name] ?? part);
      }
    }
  }
  return message;
}
