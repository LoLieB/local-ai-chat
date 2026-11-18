import { t, localizeMessage } from "../i18n";
import { useEffect, useRef, useState } from "react";
import { deleteMemory, updateMemory } from "../api";
import type { ContextReport } from "../../shared/context";
import styles from "../App.module.css";

type Props = { report: ContextReport; sessionToken: string; onMemoryChanged?: () => void };

export function ContextDetails({ report, sessionToken, onMemoryChanged }: Props) {
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [status, setStatus] = useState("");
  const request = useRef(0);
  useEffect(() => {
    request.current += 1;
    setPending(false); setStatus("");
    return () => { request.current += 1; };
  }, [report, sessionToken]);

  async function change(id: string, previousText: string, forget: boolean) {
    const text = forget ? null : window.prompt(t("Исправить запись памяти"), previousText);
    if (forget ? !window.confirm(t("Удалить эту запись из памяти? Контекст уже полученного ответа останется в отчёте.")) : !text?.trim()) return;
    const current = ++request.current;
    setPending(true); setStatus("");
    try {
      if (forget) await deleteMemory(id, sessionToken);
      else await updateMemory(id, { text: text!.trim() }, sessionToken);
      if (request.current === current) {
        setStatus(t("Память обновлена для будущих ответов. Ниже сохранён контекст исходного ответа."));
        onMemoryChanged?.();
      }
    } catch (reason) {
      if (request.current === current) setStatus(reason instanceof Error ? reason.message : t("Не удалось изменить память"));
    } finally { if (request.current === current) setPending(false); }
  }

  const scopes: Record<string, string> = { user: t("пользователь"), character: t("персонаж"), chat: t("диалог"), group: t("группа") };
  const sources: Record<string, string> = { "memory-center": t("Центр памяти"), "explicit-command": t("команда пользователя"), "auto-extract": t("сообщение пользователя") };
  const reasons: Record<string, string> = { budget: t("не поместилось в бюджет"), "memory-disabled": t("автоматическая память отключена"), "record-disabled": t("запись отключена"), "automatic-summary-ignored": t("устаревшая сводка"), "source-message-excluded": t("автопамять источника запрещена"), "unsupported-role": t("неподдерживаемый автор") };
  return <details onToggle={event => setOpen(event.currentTarget.open)}>
    <summary>{t("Контекст ответа")}</summary>
    {open && <>
    <p className={styles.mutedText}>{t("Приблизительно: вход")}{" "}{report.inputTokens}{" "}{t("· резерв ответа и служебного оформления")}{" "}{report.reserveTokens}{" "}{t("· окно")}{" "}{report.windowTokens}{" "}{t("токенов.")}</p>
    <p className={styles.mutedText}>{t("Эти записи памяти переданы модели. Это не доказывает, что она использовала их или что они повлияли на ответ.")}</p>
    <strong>{t("Переданная память (")}{report.memory.length})</strong>
    <ul>{report.memory.map((item) => <li key={item.id}>
      <div style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{item.text}</div>
      <small>{t("Источник:")}{" "}{sources[item.source] || item.source || t("не указан")}{" "}{t("· область:")}{" "}{scopes[item.scope] || item.scope} · ID: {item.id}</small>
      <div><button type="button" className={styles.secondaryButton} disabled={pending} onClick={() => void change(item.id, item.text, false)}>{t("Исправить")}</button> <button type="button" className={styles.secondaryButton} disabled={pending} onClick={() => void change(item.id, item.text, true)}>{t("Забыть")}</button></div>
    </li>)}</ul>
    <strong>{t("Сводка истории (")}{report.summary.length})</strong>
    <p>{t("Выбранные целые предложения из активной ветки, без пересказа моделью. После изменения исходных реплик следующий ответ получит новую сводку.")}</p>
    <ul>{report.summary.map((item, index) => <li key={`${item.messageId}:${index}`} style={{ overflowWrap: "anywhere" }}>{item.text} <small><a href={`#message-${item.messageId}`}>{t("К исходному сообщению")}</a> ({item.messageId})</small></li>)}</ul>
    <strong>{t("Исключено (")}{report.excluded.length})</strong>
    <ul>{report.excluded.map((item, index) => <li key={`${item.id}:${index}`} style={{ overflowWrap: "anywhere" }}>{item.id}: {reasons[item.reason] || item.reason}</li>)}</ul>
    {status && <p role="status">{localizeMessage(status)}</p>}
    </>}
  </details>;
}
