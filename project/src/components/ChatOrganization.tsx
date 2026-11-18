import { t, localizeMessage } from "../i18n";
import { useEffect, useState } from "react";
import type { Chat, CharacterCard } from "../types/domain";
import { DEFAULT_CHAT_FILTERS, normalizeChatTags, type ChatFilters } from "../../shared/chatOrganization";
import styles from "../App.module.css";

export function ChatListFilters({ value, onChange, characters, chats, count }: { value: ChatFilters; onChange: (value: ChatFilters) => void; characters: CharacterCard[]; chats: Chat[]; count: number }) {
  const patch = (next: Partial<ChatFilters>) => onChange({ ...value, ...next });
  return <details className={styles.chatListFilters}>
    <summary>{t("Фильтры чатов ·")}{" "}{count}{" "}{t("из")}{" "}{chats.length}</summary>
    <label>{t("Название")}<input aria-label={t("Поиск чатов по названию")} type="search" value={value.query} onChange={event => patch({ query: event.target.value })} /></label>
    <label>{t("Состояние")}<select aria-label={t("Состояние чатов")} value={value.archive} onChange={event => patch({ archive: event.target.value as ChatFilters["archive"] })}><option value="active">{t("Активные")}</option><option value="archived">{t("Архив")}</option><option value="all">{t("Все")}</option></select></label>
    <label>{t("Персонаж")}<select aria-label={t("Фильтр чатов по персонажу")} value={value.characterId} onChange={event => patch({ characterId: event.target.value })}><option value="">{t("Все персонажи")}</option>{characters.map(character => <option key={character.id} value={character.id}>{character.name}</option>)}</select></label>
    <label>{t("Тег")}<select aria-label={t("Фильтр чатов по тегу")} value={value.tag} onChange={event => patch({ tag: event.target.value })}><option value="">{t("Все теги")}</option>{[...new Set(chats.flatMap(chat => chat.tags || []))].sort((a, b) => a.localeCompare(b, "ru")).map(tag => <option key={tag} value={tag}>{tag}</option>)}</select></label>
    <label>{t("Изменён с")}<input aria-label={t("Чаты изменены с")} type="date" value={value.from} onChange={event => patch({ from: event.target.value })} /></label>
    <label>{t("Изменён по")}<input aria-label={t("Чаты изменены по")} type="date" value={value.to} onChange={event => patch({ to: event.target.value })} /></label>
    {value.from && value.to && value.from > value.to && <p role="alert">{t("Дата начала позже даты окончания.")}</p>}
    <button type="button" className={styles.secondaryButton} aria-pressed={value.pinned} onClick={() => patch({ pinned: !value.pinned })}>{t("Только закреплённые")}</button>
    <button type="button" className={styles.ghostButton} onClick={() => onChange({ ...DEFAULT_CHAT_FILTERS })}>{t("Сбросить фильтры чатов")}</button>
  </details>;
}

export function ChatOrganizationControls({ chat, disabled, onChange }: { chat: Chat; disabled: boolean; onChange: (patch: { archived?: boolean; tags?: string[] }) => Promise<void> }) {
  const saved = (chat.tags || []).join(", ");
  const [draft, setDraft] = useState(saved);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => { setDraft(saved); setError(""); }, [chat.id, saved]);
  async function save(patch: { archived?: boolean; tags?: string[] }) {
    setPending(true); setError("");
    try { await onChange(patch); } catch (reason) { setError(reason instanceof Error ? reason.message : t("Не удалось сохранить изменения.")); } finally { setPending(false); }
  }
  return <details>
    <summary>{chat.archivedAt ? t("Чат в архиве · теги и восстановление") : t("Теги и архив")}</summary>
    <label>{t("Теги через запятую")}<input aria-label={t("Теги чата")} value={draft} disabled={disabled || pending} onChange={event => setDraft(event.target.value)} maxLength={820} /></label>
    <div className={styles.rowActions}>
      <button type="button" className={styles.secondaryButton} disabled={disabled || pending || draft === saved} onClick={() => { try { void save({ tags: normalizeChatTags(draft.split(",").map(value => value.trim()).filter(Boolean)) }); } catch (reason) { setError(reason instanceof Error ? reason.message : t("Некорректные теги.")); } }}>{t("Сохранить теги")}</button>
      <button type="button" className={styles.secondaryButton} disabled={disabled || pending} onClick={() => void save({ archived: !chat.archivedAt })}>{chat.archivedAt ? t("Вернуть из архива") : t("В архив")}</button>
    </div>
    <p>{t("Архив скрывает чат из активного списка. История, ветки и закрепления сохраняются.")}</p>
    {error && <p role="alert">{localizeMessage(error)}</p>}
  </details>;
}
