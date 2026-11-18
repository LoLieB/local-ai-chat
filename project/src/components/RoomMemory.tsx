import { t, localizeMessage } from "../i18n";
import { useEffect, useRef, useState } from "react";
import { createMemory, getMemoryRecords, updateMemory } from "../api";
import type { MemoryRecord } from "../../shared/memory";
import styles from "../App.module.css";

const kinds = { event: "Событие", goal: "Цель", relationship: "Отношения" } as const;

export function RoomMemory({ roomId, sessionToken, disabled }: { roomId: string; sessionToken: string; disabled: boolean }) {
  const [records, setRecords] = useState<MemoryRecord[]>([]);
  const [kind, setKind] = useState<keyof typeof kinds>("event");
  const [text, setText] = useState("");
  const [editing, setEditing] = useState<string | null>(null);
  const [opened, setOpened] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  async function load() {
    const result = await getMemoryRecords(sessionToken, { scope: "group" });
    if (alive.current) setRecords(result.records.filter(record => record.groupChatId === roomId && Object.hasOwn(kinds, record.kind)));
  }
  async function run(action: () => Promise<unknown>) {
    setBusy(true); setError("");
    try { await action(); }
    catch (reason) { if (alive.current) setError(reason instanceof Error ? reason.message : t("Не удалось сохранить память комнаты")); }
    finally { if (alive.current) setBusy(false); }
  }
  async function save() {
    if (!text.trim()) return;
    if (editing) await updateMemory(editing, { text: text.trim(), kind }, sessionToken);
    else await createMemory({ scope: "group", groupChatId: roomId, kind, text: text.trim(), createdBy: "user" }, sessionToken);
    if (alive.current) { setText(""); setEditing(null); }
    await load();
  }
  return <details onToggle={event => {
    if (event.currentTarget.open && !opened) { setOpened(true); void run(load); }
  }}>
    <summary>{t("События, цели и отношения комнаты")}</summary>
    <p className={styles.mutedText}>{t("Записи этой комнаты входят в память участников и совет режиссёра. Завершённую цель или устаревший факт можно отключить. Удаление и резервная копия доступны в разделе «Память».")}</p>
    <fieldset disabled={busy || disabled} style={{ border: 0, padding: 0, minWidth: 0, display: "grid", gap: 8 }}>
      <label>{t("Тип записи")}<select aria-label={t("Тип записи комнаты")} value={kind} onChange={event => setKind(event.target.value as keyof typeof kinds)}>{Object.entries(kinds).map(([value, label]) => <option key={value} value={value}>{localizeMessage(label)}</option>)}</select></label>
      <label>{t("Текст записи")}<textarea aria-label={t("Текст записи комнаты")} maxLength={1000} rows={3} value={text} onChange={event => setText(event.target.value)} /></label>
      <button type="button" className={styles.secondaryButton} disabled={!text.trim()} onClick={() => void run(save)}>{editing ? t("Сохранить запись комнаты") : t("Добавить запись комнаты")}</button>
      {editing && <button type="button" onClick={() => { setEditing(null); setText(""); }}>{t("Отменить редактирование")}</button>}
      <button type="button" className={styles.ghostButton} onClick={() => void run(load)}>{t("Обновить память комнаты")}</button>
      {records.map(record => <div key={record.id} style={{ overflowWrap: "anywhere" }}>
        <strong>{localizeMessage(kinds[record.kind as keyof typeof kinds])}</strong>
        <p>{record.text}</p>
        <label className={styles.memoryCheck}><input type="checkbox" checked={record.enabled} onChange={event => { const enabled = event.target.checked; void run(async () => { await updateMemory(record.id, { enabled }, sessionToken); await load(); }); }} />{t("Учитывать запись")}</label>
        <button type="button" className={styles.ghostButton} onClick={() => { setEditing(record.id); setText(record.text); setKind(record.kind as keyof typeof kinds); }}>{t("Изменить запись")}</button>
      </div>)}
    </fieldset>
    {busy && <small role="status">{t("Сохранение / загрузка…")}</small>}
    {error && <p role="alert">{localizeMessage(error)}</p>}
  </details>;
}
