import { t , getLocale } from "../i18n";
import { FormEvent, useEffect, useRef, useState } from "react";
import { exportUserBackup, inspectUserBackup, restoreUserBackup, getServerSettings } from "../api";
import { MAX_BACKUP_BYTES, type BackupPreview } from "../../shared/backup";
import type { AuthSession } from "../types/domain";
import styles from "../App.module.css";

type Props = {
  session: AuthSession;
  busy: boolean;
  onRestored: (session: AuthSession) => void;
};

const downloadJson = (name: string, data: unknown) => {
  const url = URL.createObjectURL(new Blob([JSON.stringify(data)], { type: "application/json" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
};

export function DataManager({ session, busy, onRestored }: Props) {
  const [archive, setArchive] = useState<{ backup: unknown; preview: BackupPreview } | null>(null);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState("");
  const requestRef = useRef(0);
  const currentRef = useRef({ token: session.sessionToken, busy });
  currentRef.current = { token: session.sessionToken, busy };
  useEffect(() => {
    ++requestRef.current;
    setArchive(null);
    setPassword("");
    setUsername("");
    setMessage("");
    setPending(false);
    return () => { ++requestRef.current; };
  }, [session.sessionToken]);

  const run = async (action: (isCurrent: () => boolean) => Promise<void>) => {
    if (pending || busy) return;
    const request = ++requestRef.current;
    const token = session.sessionToken;
    const isCurrent = () => requestRef.current === request && currentRef.current.token === token;
    setPending(true);
    setMessage("");
    try {
      await action(isCurrent);
    } catch (error) {
      if (isCurrent()) setMessage(error instanceof Error ? error.message : t("Не удалось обработать архив. Повторите попытку."));
    } finally {
      if (isCurrent()) setPending(false);
    }
  };

  const exportArchive = () => run(async (isCurrent) => {
    const backup = await exportUserBackup(session.sessionToken);
    if (!isCurrent()) return;
    if (currentRef.current.busy) { setMessage(t("Данные изменились. Дождитесь сохранения и скачайте архив снова.")); return; }
    downloadJson(`local-ai-chat-backup-${new Date().toISOString().slice(0, 10)}.json`, backup);
    setMessage(t("Архив скачан."));
  });

  const inspectArchive = (file: File) => run(async (isCurrent) => {
    setArchive(null);
    if (file.size > MAX_BACKUP_BYTES) throw new Error(t("Архив превышает {p0} МБ.", {p0: MAX_BACKUP_BYTES / 1024 / 1024}));
    const text = await file.text();
    if (!isCurrent()) return;
    let backup: unknown;
    try { backup = JSON.parse(text); } catch { throw new Error(t("Файл не содержит корректный JSON.")); }
    const preview = await inspectUserBackup(backup, session.sessionToken);
    if (isCurrent()) setArchive({ backup, preview });
  });

  const restoreArchive = (event: FormEvent) => {
    event.preventDefault();
    if (!archive || !username.trim() || !password) return;
    void run(async (isCurrent) => {
      const restored = await restoreUserBackup(archive.backup, username.trim(), password, session.sessionToken);
      if (!isCurrent()) return;
      setPassword("");
      if (currentRef.current.busy) {
        setMessage(t("Новый аккаунт создан. Дождитесь сохранения текущих данных и войдите в него через экран входа."));
        setArchive(null);
        return;
      }
      onRestored(restored);
    });
  };

  return <section className={styles.settingsCard} aria-label={t("Резервные копии")}>
    <h3>{t("Резервные копии")}</h3>
    <p>{t("Полный архив аккаунта: персонажи, личные и групповые чаты, ветки и память. Пароли, сессии и общие настройки в него не входят.")}</p>
    <button type="button" className={styles.secondaryButton} disabled={busy || pending} onClick={() => void exportArchive()}>{t("Скачать архив аккаунта")}</button>
    <label>{t("Загрузить архив JSON (до")}{" "}{MAX_BACKUP_BYTES / 1024 / 1024}{" "}{t("МБ)")}{" "}<input type="file" accept="application/json,.json" disabled={busy || pending} onChange={(event) => {
        const file = event.currentTarget.files?.[0];
        event.currentTarget.value = "";
        if (file) void inspectArchive(file);
      }} />
    </label>
    {archive && <form onSubmit={restoreArchive}>
      <p>{t("Архив:")}{" "}{archive.preview.username}{t(". Дата:")}{" "}{new Date(archive.preview.exportedAt).toLocaleString(getLocale())}.</p>
      <p>{t("Персонажей:")}{" "}{archive.preview.characters}{t("; чатов:")}{" "}{archive.preview.chats}{t("; групп:")}{" "}{archive.preview.groups}{t("; записей памяти:")}{" "}{archive.preview.memories}{t("; всего файлов:")}{" "}{archive.preview.files}.</p>
      <p>{t("Восстановление создаст новый аккаунт и переключит вас на него. Существующий аккаунт и его данные сохранятся.")}</p>
      <label>{t("Логин нового аккаунта")}<input autoComplete="off" required value={username} disabled={busy || pending} onChange={(event) => setUsername(event.target.value)} /></label>
      <label>{t("Пароль нового аккаунта")}<input type="password" autoComplete="new-password" required value={password} disabled={busy || pending} onChange={(event) => setPassword(event.target.value)} /></label>
      <button className={styles.primaryButton} disabled={busy || pending || !username.trim() || !password}>{t("Восстановить в новый аккаунт")}</button>
    </form>}
    {session.userId === "u_admin" && <button type="button" className={styles.secondaryButton} disabled={busy || pending} onClick={() => void run(async (isCurrent) => {
      const saved = await getServerSettings();
      if (isCurrent()) downloadJson("local-ai-chat-settings.json", {
        baseUrl: saved.baseUrl, modelId: saved.modelId, streaming: saved.streaming,
        temperature: saved.temperature, maxTokens: saved.maxTokens
      });
    })}>{t("Скачать общие настройки отдельно")}</button>}
    {busy && <p className={styles.helperText}>{t("Архивирование доступно после завершения генерации и успешного сохранения данных.")}</p>}
    <p className={styles.helperText} role="status" aria-live="polite">{pending ? t("Обработка архива…") : message}</p>
  </section>;
}
