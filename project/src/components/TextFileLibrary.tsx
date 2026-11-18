import { t, localizeMessage } from "../i18n";
import { useEffect, useRef, useState } from "react";
import { deleteTextFile, getTextFile, listTextFiles } from "../api";
import type { SavedTextFile } from "../../shared/textFile";
import styles from "../App.module.css";

export function TextFileLibrary({ sessionToken, revision, disabled, onInsert }: { sessionToken: string; revision: number; disabled?: boolean; onInsert: (name: string, text: string) => void }) {
  const [opened, setOpened] = useState(false);
  const [files, setFiles] = useState<Omit<SavedTextFile, "text">[]>([]);
  const [selected, setSelected] = useState<SavedTextFile | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  async function load() {
    const result = await listTextFiles(sessionToken);
    if (alive.current) { setFiles(result.files); setSelected(current => result.files.some(file => file.id === current?.id) ? current : null); }
  }
  async function run(action: () => Promise<unknown>) {
    setBusy(true); setError("");
    try { await action(); }
    catch (reason) { if (alive.current) setError(reason instanceof Error ? reason.message : t("Не удалось загрузить файлы.")); }
    finally { if (alive.current) setBusy(false); }
  }
  useEffect(() => { if (opened) void run(load); }, [opened, revision]);
  function download() {
    if (!selected) return;
    const url = URL.createObjectURL(new Blob([selected.text], { type: "text/plain;charset=utf-8" }));
    const link = document.createElement("a"); link.href = url; link.download = selected.name; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  return <details onToggle={event => setOpened(event.currentTarget.open)}>
    <summary>{t("Сохранённые текстовые файлы")}</summary>
    <div style={{ overflowWrap: "anywhere" }}>
      <p className={styles.attachmentHint}>{t("Доступны во всех ваших чатах. Удаление файла не меняет отправленные сообщения.")}</p>
      <fieldset disabled={disabled || busy} style={{ border: 0, padding: 0, minWidth: 0 }}>
        <button type="button" className={styles.ghostButton} onClick={() => void run(load)}>{t("Обновить список файлов")}</button>
        {files.length === 0 && !busy && <p>{t("Сохранённых файлов пока нет.")}</p>}
        {files.map(file => <div key={file.id}>
          <button type="button" className={styles.ghostButton} onClick={() => void run(async () => { const result = await getTextFile(file.id, sessionToken); if (alive.current) setSelected(result.file); })}>{file.name} · {file.size}{" "}{t("Б")}</button>
        </div>)}
        {selected && <section aria-label={t("Просмотр сохранённого файла")}>
          <strong>{selected.name}</strong>
          <pre style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere", maxHeight: 150, overflow: "auto" }}>{selected.text}</pre>
          <button type="button" className={styles.ghostButton} onClick={() => onInsert(selected.name, selected.text)}>{t("Вставить в черновик")}</button>
          <button type="button" className={styles.ghostButton} onClick={download}>{t("Скачать файл")}</button>
          <button type="button" className={styles.ghostButton} onClick={() => void run(async () => { await deleteTextFile(selected.id, sessionToken); if (alive.current) setSelected(null); await load(); })}>{t("Удалить из библиотеки")}</button>
        </section>}
      </fieldset>
      {busy && <small role="status">{t("Загрузка…")}</small>}
      {error && <p role="alert">{localizeMessage(error)}</p>}
    </div>
  </details>;
}
