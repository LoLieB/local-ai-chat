import { t, localizeMessage , getLocale } from "../i18n";
import { useEffect, useRef, useState } from "react";
import { getCharacterVersions } from "../api";
import type { CharacterCard } from "../types/domain";
import styles from "../App.module.css";

export function CharacterVersions({ card, sessionToken, onRestore }: { card: CharacterCard; sessionToken: string; onRestore: (card: CharacterCard) => void }) {
  const [versions, setVersions] = useState<CharacterCard[]>([]);
  const [message, setMessage] = useState("");
  const [pending, setPending] = useState(false);
  const epoch = useRef(0);
  useEffect(() => { ++epoch.current; setVersions([]); setMessage(""); setPending(false); return () => { ++epoch.current; }; }, [card.id, sessionToken]);
  async function load() {
    const request = ++epoch.current;
    setPending(true); setMessage("");
    try {
      const result = await getCharacterVersions(card.id, sessionToken);
      if (request !== epoch.current) return;
      setVersions(result);
      if (!result.length) setMessage(t("Предыдущих версий пока нет."));
    } catch (error) {
      if (request === epoch.current) setMessage(error instanceof Error ? error.message : t("Не удалось загрузить версии."));
    } finally { if (request === epoch.current) setPending(false); }
  }
  return <details className={styles.vaultEditorCard} onToggle={event => { if (event.currentTarget.open) void load(); }}>
    <summary>{t("История версий")}</summary>
    <p>{t("Последние 20 сохранённых редакций. Восстановление заменяет текущий черновик. Проверьте его и нажмите «Сохранить».")}</p>
    <button type="button" className={styles.secondaryButton} disabled={pending} onClick={() => void load()}>{pending ? t("Загрузка…") : t("Обновить версии")}</button>
    {versions.map((version, index) => <div key={index} className={styles.rowActions}>
      <span>{version.name} · {new Date(version.updatedAt).toLocaleString(getLocale())}</span>
      <button type="button" className={styles.secondaryButton} onClick={() => {
        if (!window.confirm(t("Заменить текущий черновик этой версией?"))) return;
        onRestore({ ...version, id: card.id, createdAt: card.createdAt, favorite: card.favorite });
        setMessage(t("Версия открыта в черновике. Нажмите «Сохранить», чтобы применить."));
      }}>{t("Восстановить в черновик")}</button>
    </div>)}
    {message && <p role="status">{localizeMessage(message)}</p>}
  </details>;
}
