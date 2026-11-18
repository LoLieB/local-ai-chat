import { t, localizeMessage } from "../i18n";
import { useEffect, useRef, useState } from "react";
import { loadModels, previewCharacter, saveServerSettings } from "../api";
import { profileSettings, type ModelProfile } from "../../shared/modelProfile";
import type { AppSettings, AuthSession } from "../types/domain";
import styles from "../App.module.css";

export function ModelProfiles({ settings, session, onChange }: { settings: AppSettings; session: AuthSession; onChange: (patch: Partial<AppSettings>) => void }) {
  const [name, setName] = useState("");
  const [selected, setSelected] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const epoch = useRef(0);
  const admin = session.userId === "u_admin";
  const profiles = settings.modelProfiles || [];
  const profile = profiles.find(value => value.id === selected);
  useEffect(() => { ++epoch.current; return () => { ++epoch.current; }; }, [session.sessionToken]);
  async function perform(action: () => Promise<void>) {
    setBusy(true); setMessage(""); setError("");
    try { await action(); } catch (reason) { setError(reason instanceof Error ? reason.message : t("Операция не удалась.")); }
    finally { setBusy(false); }
  }
  async function persist(next: ModelProfile[]) {
    const current = epoch.current;
    const result = await saveServerSettings({ modelProfiles: next }, session.sessionToken);
    if (current !== epoch.current) return;
    onChange({ modelProfiles: result.modelProfiles });
    setMessage(t("Список профилей сохранён на сервере."));
  }
  const capture = (id: string): ModelProfile => ({ id, name: name.trim(), baseUrl: settings.baseUrl, modelId: settings.modelId, streaming: settings.streaming, temperature: settings.temperature, maxTokens: settings.maxTokens });
  return <section className={styles.settingsCard} aria-label={t("Профили моделей")}>
    <h3>{t("Профили моделей")}</h3>
    <p>{t("Сохранённые подключения и параметры. Выбор применяется к настройкам этого сеанса. В обычном чате приоритет: профиль чата, затем профиль персонажа, затем текущие настройки и параметры карточки.")}</p>
    <label>{t("Профиль")}<select aria-label={t("Профиль модели")} disabled={busy} value={selected} onChange={event => { setSelected(event.target.value); setName(profiles.find(value => value.id === event.target.value)?.name || ""); setMessage(""); setError(""); }}>
      <option value="">{t("Новый профиль")}</option>{profiles.map(value => <option key={value.id} value={value.id}>{value.name}</option>)}
    </select></label>
    {profile && <>
      <p style={{ overflowWrap: "anywhere" }}>{profile.modelId || t("Модель не выбрана")} · {profile.baseUrl}<br />{t("Температура")}{" "}{profile.temperature}{t("; максимум ответа")}{" "}{profile.maxTokens}{t("; поток")}{" "}{profile.streaming ? t("включён") : t("выключен")}.</p>
      <button type="button" className={styles.secondaryButton} disabled={busy} onClick={() => { onChange(profileSettings(profile)); setMessage(t("Профиль применён к настройкам сеанса.")); }}>{t("Применить профиль")}</button>
    </>}
    {admin ? <>
      <label>{t("Название профиля")}<input aria-label={t("Название профиля")} maxLength={100} disabled={busy} value={name} onChange={event => setName(event.target.value)} /></label>
      <p>{t("Сохранение берёт значения из полей подключения и генерации ниже. Общие настройки по умолчанию не меняются.")}</p>
      <div className={styles.rowActions}>
        <button type="button" className={styles.secondaryButton} disabled={busy || !name.trim() || profiles.length >= 50} onClick={() => void perform(async () => { const card = capture(crypto.randomUUID()); await persist([...profiles, card]); setSelected(card.id); })}>{t("Сохранить как новый профиль")}</button>
        {profile && <><button type="button" className={styles.secondaryButton} disabled={busy || !name.trim()} onClick={() => { if (window.confirm(t("Заменить выбранный профиль текущими настройками?"))) void perform(() => persist(profiles.map(value => value.id === profile.id ? capture(profile.id) : value))); }}>{t("Обновить профиль")}</button>
        <button type="button" className={styles.secondaryButton} disabled={busy} onClick={() => { if (window.confirm(t("Удалить сохранённый профиль?"))) void perform(async () => { await persist(profiles.filter(value => value.id !== profile.id)); setSelected(""); setName(""); }); }}>{t("Удалить профиль")}</button></>}
      </div>
    </> : <p>{t("Сохранение и удаление общих профилей доступны администратору.")}</p>}
    {profile && <div className={styles.rowActions}>
      <button type="button" className={styles.secondaryButton} disabled={busy} onClick={() => void perform(async () => { const models = await loadModels(profile.baseUrl, session.sessionToken); setMessage(t("Соединение работает. {p0}", {p0: models.some(model => model.id === profile.modelId) ? t("Модель найдена.") : t("Выбранная модель отсутствует в списке сервера.")})); })}>{t("Проверить профиль")}</button>
      <button type="button" className={styles.secondaryButton} disabled={busy || !profile.modelId.trim()} onClick={() => void perform(async () => {
        const start = performance.now();
        const result = await previewCharacter({ id: "profile-test", name: "Проверка профиля", description: "", systemPrompt: "Ответь кратко.", avatar: "", tags: [], createdAt: "", updatedAt: "", temperature: profile.temperature, maxTokens: profile.maxTokens }, "Напиши короткое приветствие.", profileSettings(profile), session.sessionToken);
        setMessage(t("Ответ за {p0} с: {p1}", {p0: ((performance.now() - start) / 1000).toFixed(1), p1: result.content}));
      })}>{t("Пробный ответ профиля")}</button>
    </div>}
    <p>{t("Поддерживаются temperature, max_tokens и потоковая выдача. Дополнительные параметры зависят от сервера и здесь не задаются. Пробный ответ не записывает историю или память.")}</p>
    {busy && <p role="status">{t("Выполняется…")}</p>}
    {message && <p role="status" style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{localizeMessage(message)}</p>}
    {error && <p role="alert">{localizeMessage(error)}</p>}
  </section>;
}
