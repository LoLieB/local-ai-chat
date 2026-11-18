import { setLocale, t, useLocale } from "./index";

export function LanguageSelector() {
  const locale = useLocale();
  return <label>🌐 <select aria-label={t("Язык интерфейса")} value={locale} onChange={(event) => setLocale(event.target.value as "ru-RU" | "en-US")}>
    <option value="ru-RU">Русский</option>
    <option value="en-US">English</option>
  </select></label>;
}
