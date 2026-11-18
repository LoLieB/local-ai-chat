import { t, localizeMessage } from "../i18n";
import { useEffect, useRef, useState } from "react";
import { buildCharacterPrompt, exportCharacterCard, CHARACTER_DETAIL_FIELDS } from "../../shared/characterCard";
import type { CharacterCard, AppSettings } from "../types/domain";
import { previewCharacter } from "../api";
import styles from "../App.module.css";
const labels = { personality: "Характер", speechStyle: "Стиль речи", scenario: "Сценарий", firstMessage: "Первое сообщение", examples: "Примеры диалога", rules: "Правила персонажа" };
export function CharacterTools({ card, onChange, settings, sessionToken }: { card: CharacterCard; onChange: (card: CharacterCard) => void; settings: AppSettings; sessionToken: string }) {
  const [advanced, setAdvanced] = useState(false);
  const [question, setQuestion] = useState("Представься и расскажи, чем можешь помочь.");
  const [answer, setAnswer] = useState(""); const [error, setError] = useState(""); const [pending, setPending] = useState(false);
  const epoch = useRef(0);
  useEffect(() => { ++epoch.current; setAnswer(""); setError(""); setPending(false); return () => { ++epoch.current; }; }, [card, sessionToken, question]);
  const download = () => {
    try {
      const blob = new Blob([JSON.stringify(exportCharacterCard(card))], { type: "application/json" });
      const url = URL.createObjectURL(blob); const link = document.createElement("a"); link.href = url; link.download = "character.json"; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); setError("");
    } catch (reason) { setError(reason instanceof Error ? reason.message : t("Не удалось экспортировать карточку.")); }
  };
  async function test() {
    const current = ++epoch.current; setPending(true); setError(""); setAnswer("");
    try { const result = await previewCharacter(card, question, settings, sessionToken); if (epoch.current === current) setAnswer(result.content); }
    catch (reason) { if (epoch.current === current) setError(reason instanceof Error ? reason.message : t("Тест не удался.")); }
    finally { if (epoch.current === current) setPending(false); }
  }
  return <section className={styles.vaultEditorCard} aria-label={t("Расширенная карточка")}>
    <p>{t("Профиль модели применяется в чатах и тесте персонажа. Профиль самого чата или группы имеет приоритет.")}</p>
    <label>{t("Профиль модели персонажа")}<select aria-label={t("Профиль модели персонажа")} value={card.modelProfileId || ""} onChange={event => onChange({ ...card, modelProfileId: event.target.value })}><option value="">{t("Текущие настройки и параметры карточки")}</option>{card.modelProfileId && !settings.modelProfiles?.some(profile => profile.id === card.modelProfileId) && <option value={card.modelProfileId}>{t("Недоступный профиль")}</option>}{settings.modelProfiles?.map(profile => <option key={profile.id} value={profile.id}>{profile.name}</option>)}</select></label>
    <button type="button" className={styles.secondaryButton} aria-pressed={Boolean(card.favorite)} onClick={() => onChange({ ...card, favorite: !card.favorite })}>{card.favorite ? t("★ В избранном") : t("☆ В избранное")}</button>
    <div className={styles.rowActions}>
      <button type="button" className={styles.secondaryButton} aria-pressed={!advanced} onClick={() => setAdvanced(false)}>{t("Базовый режим")}</button>
      <button type="button" className={styles.secondaryButton} aria-pressed={advanced} onClick={() => setAdvanced(true)}>{t("Расширенный режим")}</button>
      <button type="button" className={styles.secondaryButton} onClick={download}>{t("Скачать карточку JSON")}</button>
    </div>
    {advanced && <div style={{ display: "grid", gap: 12 }}>{CHARACTER_DETAIL_FIELDS.map(key => <label key={key}>{localizeMessage(labels[key])}<textarea aria-label={localizeMessage(labels[key])} rows={3} maxLength={20000} value={card[key] || ""} onChange={event => onChange({ ...card, [key]: event.target.value })} /></label>)}</div>}
    <details><summary>{t("Итоговый промпт")}</summary><pre style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{buildCharacterPrompt(card) || t("Промпт пуст")}</pre></details>
    <details><summary>{t("Проверить персонажа")}</summary>
      <p>{t("Проверка текущего черновика. Рабочая история и память не изменяются.")}</p>
      {card.firstMessage && <p style={{ whiteSpace: "pre-wrap" }}><strong>{t("Первое сообщение:")}{" "}</strong>{card.firstMessage}</p>}
      <label>{t("Тестовое сообщение")}<textarea aria-label={t("Тестовое сообщение")} rows={3} value={question} onChange={event => setQuestion(event.target.value)} maxLength={10000} /></label>
      <button type="button" className={styles.secondaryButton} disabled={pending || !question.trim()} onClick={() => void test()}>{pending ? t("Проверка…") : t("Получить тестовый ответ")}</button>
      {answer && <p style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }} role="status">{answer}</p>}
    </details>
    {error && <p role="alert">{localizeMessage(error)}</p>}
  </section>;
}
