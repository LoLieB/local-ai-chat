import { t, localizeMessage, getLocale, pluralCount } from "../i18n";
import { useEffect, useMemo, useState } from "react";
import {
  createMemory,
  deleteMemory,
  exportMemoryBackup,
  getMemoryRecords,
  importMemoryBackup,
  updateMemory
} from "../api";
import type { Chat, CharacterCard, GroupChat } from "../types/domain";
import type { MemoryKind, MemoryRecord, MemoryScope } from "../../shared/memory";
import styles from "../App.module.css";

const scopes: Array<{ value: Exclude<MemoryScope, "daily">; label: string }> = [
  { value: "user", label: "Общая" },
  { value: "character", label: "Персонажи" },
  { value: "chat", label: "Чаты" },
  { value: "group", label: "Группы" }
];

const kinds: Array<{ value: MemoryKind; label: string }> = [
  { value: "context", label: "Контекст" },
  { value: "preference", label: "Предпочтение" },
  { value: "profile", label: "Профиль" },
  { value: "goal", label: "Цель" },
  { value: "decision", label: "Решение" },
  { value: "event", label: "Событие" },
  { value: "relationship", label: "Отношения" },
  { value: "summary", label: "Сводка" }
];

type Props = {
  sessionToken?: string | null;
  characters: CharacterCard[];
  chats: Chat[];
  groupChats: GroupChat[];
  setStatus: (status: string) => void;
};

function formatDate(value: string | null) {
  if (!value) return t("ещё не использовалась");
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString(getLocale(), { dateStyle: "medium", timeStyle: "short" });
}

export function MemoryCenter({ sessionToken, characters, chats, groupChats, setStatus }: Props) {
  const [scope, setScope] = useState<Exclude<MemoryScope, "daily">>("user");
  const [records, setRecords] = useState<MemoryRecord[]>([]);
  const [query, setQuery] = useState("");
  const [kindFilter, setKindFilter] = useState<MemoryKind | "all">("all");
  const [recordTargetId, setRecordTargetId] = useState("");
  const [showDisabled, setShowDisabled] = useState(false);
  const [loading, setLoading] = useState(false);
  const [draftText, setDraftText] = useState("");
  const [draftKind, setDraftKind] = useState<MemoryKind>("context");
  const [draftTargetId, setDraftTargetId] = useState("");
  const [targetQuery, setTargetQuery] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingText, setEditingText] = useState("");

  const targets = useMemo(() => {
    if (scope === "character") return characters.map((item) => ({ id: item.id, label: `${item.avatar} ${item.name}` }));
    if (scope === "chat") return chats.map((item) => ({ id: item.id, label: item.title }));
    if (scope === "group") return groupChats.map((item) => ({ id: item.id, label: item.title }));
    return [];
  }, [characters, chats, groupChats, scope]);

  const targetNames = useMemo(() => new Map([
    ...characters.map((item) => [item.id, item.name] as const),
    ...chats.map((item) => [item.id, item.title] as const),
    ...groupChats.map((item) => [item.id, item.title] as const)
  ]), [characters, chats, groupChats]);

  const targetLabel = scope === "character" ? t("персонажа") : scope === "chat" ? t("чат") : t("группу");
  const targetMetaLabel = scope === "character" ? t("Персонаж") : scope === "chat" ? t("Чат") : t("Группа");
  const targetPluralLabel = scope === "character" ? t("персонажи") : scope === "chat" ? t("чаты") : t("группы");
  const filteredTargets = useMemo(() => {
    const normalizedQuery = targetQuery.trim().toLocaleLowerCase("ru-RU");
    if (!normalizedQuery) return targets;
    return targets.filter((target) => target.label.toLocaleLowerCase("ru-RU").includes(normalizedQuery));
  }, [targetQuery, targets]);

  const load = async (nextScope = scope, nextQuery = query) => {
    if (!sessionToken) return;
    setLoading(true);
    try {
      const result = await getMemoryRecords(sessionToken, { scope: nextScope, query: nextQuery });
      setRecords(result.records);
    } catch (error) {
      console.warn("Failed to load memory", error);
      setStatus(t("Не удалось загрузить память."));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    setDraftTargetId("");
    setRecordTargetId("");
    setTargetQuery("");
    const timer = window.setTimeout(() => void load(scope, query), 180);
    return () => window.clearTimeout(timer);
  }, [scope, query, sessionToken]);

  const mutate = async (operation: () => Promise<unknown>, success: string) => {
    try {
      await operation();
      setStatus(success);
      await load();
    } catch (error) {
      console.warn("Memory action failed", error);
      setStatus(error instanceof Error ? error.message : t("Операция с памятью не выполнена."));
    }
  };

  const addRecord = async () => {
    const text = draftText.trim();
    if (!text) return;
    if (scope !== "user" && !draftTargetId) {
      setStatus(t("Выберите {p0}.", {p0: targetLabel}));
      return;
    }
    await mutate(() => createMemory({
      scope,
      kind: draftKind,
      text,
      ...(scope === "character" ? { characterId: draftTargetId } : {}),
      ...(scope === "chat" ? { chatId: draftTargetId } : {}),
      ...(scope === "group" ? { groupChatId: draftTargetId } : {})
    }, sessionToken), t("Факт сохранён."));
    setDraftText("");
  };

  const saveEdit = async (record: MemoryRecord) => {
    const text = editingText.trim();
    if (!text) return;
    await mutate(() => updateMemory(record.id, { text }, sessionToken), t("Факт обновлён."));
    setEditingId(null);
  };

  const exportBackup = async () => {
    try {
      const backup = await exportMemoryBackup(sessionToken);
      const blob = new Blob([JSON.stringify(backup, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `local-ai-chat-memory-${new Date().toISOString().slice(0, 10)}.json`;
      anchor.click();
      URL.revokeObjectURL(url);
      setStatus(t("Резервная копия памяти создана."));
    } catch (error) {
      console.warn("Memory export failed", error);
      setStatus(t("Не удалось экспортировать память."));
    }
  };

  const importBackup = async (file: File) => {
    if (file.size > 2 * 1024 * 1024) {
      setStatus(t("Файл памяти слишком большой."));
      return;
    }
    try {
      const payload = JSON.parse(await file.text()) as unknown;
      await importMemoryBackup(payload, sessionToken);
      setStatus(t("Память импортирована без дубликатов."));
      await load();
    } catch (error) {
      console.warn("Memory import failed", error);
      setStatus(error instanceof Error ? error.message : t("Файл памяти повреждён."));
    }
  };

  const visibleRecords = records
    .filter((record) => showDisabled || record.enabled)
    .filter((record) => kindFilter === "all" || record.kind === kindFilter)
    .filter((record) => !recordTargetId || record.characterId === recordTargetId || record.chatId === recordTargetId || record.groupChatId === recordTargetId);

  return (
    <section className={styles.pageStack}>
      <div className={`${styles.visualPanel} ${styles.pageHero}`}>
        <h2>{t("Центр памяти")}</h2>
        <p>{t("Проверяйте, исправляйте и переносите факты, которые доступны локальной модели.")}</p>
        <div className={styles.statusChipRow}>
          <span className={styles.statusChip}>{t("серверное хранение")}</span>
          <span className={styles.statusChip}>{t("по областям")}</span>
          <span className={styles.statusChip}>{t("без векторной базы")}</span>
        </div>
      </div>

      <section className={`${styles.visualPanel} ${styles.memoryCenter}`}>
        <header className={styles.memoryToolbar}>
          <div className={styles.memoryTabs} role="tablist" aria-label={t("Область памяти")}>
            {scopes.map((item) => (
              <button key={item.value} type="button" role="tab" aria-selected={scope === item.value} className={scope === item.value ? styles.activeTab : ""} onClick={() => setScope(item.value)}>
                {localizeMessage(item.label)}
              </button>
            ))}
          </div>
          <div className={styles.memoryTransferActions}>
            <button type="button" className={styles.secondaryButton} onClick={() => void exportBackup()}>{t("Экспорт")}</button>
            <label className={styles.secondaryButton} htmlFor="memory-import">{t("Импорт")}</label>
            <input id="memory-import" type="file" accept="application/json,.json" hidden onChange={(event) => { const file = event.target.files?.[0]; if (file) void importBackup(file); event.currentTarget.value = ""; }} />
          </div>
        </header>

        <div className={styles.memorySearchRow}>
          <input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t("Найти в памяти")} aria-label={t("Поиск по памяти")} />
          <select value={kindFilter} onChange={(event) => setKindFilter(event.target.value as MemoryKind | "all")} aria-label={t("Фильтр по типу памяти")}>
            <option value="all">{t("Все типы")}</option>
            {kinds.map((item) => <option key={item.value} value={item.value}>{localizeMessage(item.label)}</option>)}
          </select>
          {scope !== "user" && <select value={recordTargetId} onChange={(event) => setRecordTargetId(event.target.value)} aria-label={t("Фильтр: {p0}", {p0: targetMetaLabel.toLocaleLowerCase("ru-RU")})}>
            <option value="">{t("Все")}{" "}{targetPluralLabel}</option>
            {targets.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
          </select>}
          <label className={styles.memoryCheck}><input type="checkbox" checked={showDisabled} onChange={(event) => setShowDisabled(event.target.checked)} />{" "}{t("Показывать отключённые")}</label>
          <span className={styles.mutedText}>{loading ? t("Загрузка…") : pluralCount("records", visibleRecords.length)}</span>
        </div>

        <div className={styles.memoryCreate}>
          <textarea value={draftText} maxLength={1000} onChange={(event) => setDraftText(event.target.value)} placeholder={t("Новый факт")} aria-label={t("Новый факт памяти")} rows={2} />
          <select value={draftKind} onChange={(event) => setDraftKind(event.target.value as MemoryKind)} aria-label={t("Тип памяти")}>
            {kinds.map((item) => <option key={item.value} value={item.value}>{localizeMessage(item.label)}</option>)}
          </select>
          {scope !== "user" && (
            <div className={styles.memoryTargetPicker}>
              <input type="search" value={targetQuery} onChange={(event) => setTargetQuery(event.target.value)} placeholder={t("Найти {p0}", {p0: targetLabel})} aria-label={t("Поиск: {p0}", {p0: targetLabel})} />
              <select value={draftTargetId} onChange={(event) => setDraftTargetId(event.target.value)} aria-label={t("Выберите {p0}", {p0: targetLabel})}>
                <option value="">{t("Выберите")}{" "}{targetLabel}</option>
                {filteredTargets.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
              </select>
            </div>
          )}
          <button type="button" className={styles.primaryButton} onClick={() => void addRecord()} disabled={!draftText.trim() || (scope !== "user" && !draftTargetId)}>{t("Добавить")}</button>
        </div>

        <div className={styles.memoryList} role="region" aria-label={t("Записи памяти")} tabIndex={0}>
          {visibleRecords.map((record) => {
            const targetId = record.characterId || record.chatId || record.groupChatId;
            return (
              <article key={record.id} className={`${styles.memoryRecord} ${record.pinned ? styles.memoryRecordPinned : ""} ${record.enabled ? "" : styles.memoryRecordDisabled}`}>
                {editingId === record.id ? (
                  <textarea value={editingText} maxLength={1000} onChange={(event) => setEditingText(event.target.value)} aria-label={t("Редактировать факт")} rows={3} autoFocus />
                ) : <p>{record.text}</p>}
                <div className={styles.memoryMeta}>
                  <span>{localizeMessage(kinds.find((item) => item.value === record.kind)?.label || record.kind)}</span>
                  <span>{record.source}</span>
                  <span>{t("Создано:")}{" "}{formatDate(record.createdAt)}</span>
                  <span>{t("Доступ:")}{" "}{formatDate(record.lastAccessedAt)}</span>
                  <span>{t("Автор:")}{" "}{record.createdBy}</span>
                  {targetId && <span>{targetMetaLabel}: {targetNames.get(targetId) || t("удалённый объект")}</span>}
                </div>
                <div className={styles.rowActions}>
                  {editingId === record.id ? <>
                    <button type="button" onClick={() => void saveEdit(record)}>{t("Сохранить")}</button>
                    <button type="button" onClick={() => setEditingId(null)}>{t("Отмена")}</button>
                  </> : <button type="button" onClick={() => { setEditingId(record.id); setEditingText(record.text); }}>{t("Изменить")}</button>}
                  <button type="button" onClick={() => void mutate(() => updateMemory(record.id, { pinned: !record.pinned }, sessionToken), record.pinned ? t("Факт откреплён.") : t("Факт закреплён."))}>{record.pinned ? t("Открепить") : t("Закрепить")}</button>
                  <button type="button" onClick={() => void mutate(() => updateMemory(record.id, { enabled: !record.enabled }, sessionToken), record.enabled ? t("Факт отключён.") : t("Факт включён."))}>{record.enabled ? t("Отключить") : t("Включить")}</button>
                  <button type="button" onClick={() => { if (window.confirm(t("Забыть этот факт? Повторное автоматическое сохранение такого же текста в этой области будет запрещено."))) void mutate(() => deleteMemory(record.id, sessionToken), t("Факт забыт. Автоматическое повторное сохранение запрещено.")); }}>{t("Забыть")}</button>
                </div>
              </article>
            );
          })}
          {!loading && !visibleRecords.length && <div className={styles.emptyState}><strong>{t("Здесь пока пусто")}</strong><span>{t("Добавьте факт вручную или используйте команду «Запомни: …» в чате.")}</span></div>}
        </div>
      </section>
    </section>
  );
}
