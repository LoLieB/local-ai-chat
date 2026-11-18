import { t, localizeMessage } from "../i18n";
import { useEffect, useRef, useState } from "react";
import { createMemory, getMemoryPolicy, setMemoryPolicy } from "../api";
import type { MemoryPolicy } from "../../shared/context";
import styles from "../App.module.css";

type Props = { kind: "chat" | "group"; id: string; sessionToken: string; messageId?: string; messageText?: string; disabled?: boolean };

export function MemoryControls(props: Props) {
  return <LazyPolicyControls key={`${props.sessionToken}:${props.kind}:${props.id}:${props.messageId ?? ""}`} {...props} />;
}

function LazyPolicyControls(props: Props) {
  const [opened, setOpened] = useState(false);
  return <details onToggle={(event) => { if (event.currentTarget.open) setOpened(true); }}>
    <summary>{props.messageId ? t("Память сообщения") : t("Настройки памяти диалога")}</summary>
    {opened && <PolicyControls {...props} />}
  </details>;
}

function PolicyControls({ kind, id, sessionToken, messageId, messageText, disabled }: Props) {
  const [policy, setPolicy] = useState<MemoryPolicy | null>(null);
  const [tokens, setTokens] = useState("");
  const [pending, setPending] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [retry, setRetry] = useState(0);
  const alive = useRef(false);
  useEffect(() => {
    alive.current = true;
    let current = true;
    setPending(true);
    setError("");
    void getMemoryPolicy(kind, id, sessionToken).then((value) => {
      if (current) { setPolicy(value); setTokens(String(value.contextTokens)); }
    }).catch((reason: unknown) => {
      if (current) setError(reason instanceof Error ? reason.message : t("Не удалось загрузить настройки памяти"));
    }).finally(() => { if (current) setPending(false); });
    return () => { current = false; alive.current = false; };
  }, [kind, id, sessionToken, retry]);

  async function save(patch: Parameters<typeof setMemoryPolicy>[2]) {
    setPending(true); setError(""); setNotice("");
    try {
      const value = await setMemoryPolicy(kind, id, patch, sessionToken);
      if (alive.current) { setPolicy(value); setTokens(String(value.contextTokens)); setNotice(t("Сохранено")); }
    } catch (reason) {
      if (alive.current) setError(reason instanceof Error ? reason.message : t("Не удалось сохранить настройки"));
    } finally { if (alive.current) setPending(false); }
  }

  async function remember() {
    const text = window.prompt(t("Что запомнить из сообщения?"), messageText ?? "");
    if (!text?.trim()) return;
    setPending(true); setError(""); setNotice("");
    try {
      await createMemory({ scope: kind, kind: "context", text: text.trim(), source: `message:${messageId}`, createdBy: "user", ...(kind === "chat" ? { chatId: id } : { groupChatId: id }) }, sessionToken);
      if (alive.current) setNotice(t("Запись добавлена в память"));
    } catch (reason) {
      if (alive.current) setError(reason instanceof Error ? reason.message : t("Не удалось запомнить сообщение"));
    } finally { if (alive.current) setPending(false); }
  }

  const tokenValue = Number(tokens);
  return <div>
    {policy && <fieldset disabled={disabled || pending} style={{ border: 0, padding: 0, margin: 0, minWidth: 0, display: "grid", gap: 8 }}>
      {messageId ? <>
        <label className={styles.memoryCheck}><input type="checkbox" checked={policy.excludedMessageIds.includes(messageId)} onChange={(event) => void save({ messageId, excluded: event.target.checked })} />{" "}{t("Исключить из памяти")}</label>
        <p className={styles.mutedText} style={{ display: "block", margin: "4px 0", fontSize: "0.85em" }}>{t("Запрещает будущую автоматическую память и сводку по этому сообщению. Сообщение остаётся в недавней истории контекста.")}</p>
        <button type="button" className={styles.secondaryButton} onClick={() => void remember()}>{t("Запомнить")}</button>
      </> : <>
        <label className={styles.memoryCheck}><input type="checkbox" checked={!policy.disabled} onChange={(event) => void save({ disabled: !event.target.checked })} />{" "}{t("Автоматическая память диалога")}</label>
        <p className={styles.mutedText} style={{ display: "block", margin: "4px 0", fontSize: "0.85em" }}>{t("Отключение запрещает дальнейшее автоматическое извлечение памяти; уже сохранённые записи остаются.")}</p>
        <label>{t("Окно контекста, токенов")}{" "}<input type="number" min={2048} max={131072} step={1} value={tokens} onChange={(event) => setTokens(event.target.value)} /></label>
        <p className={styles.mutedText} style={{ display: "block", margin: "4px 0", fontSize: "0.85em" }}>{t("Укажите размер окна загруженной модели. Расчёт приблизительный и консервативный; приложение не меняет окно самой модели.")}</p>
        <button type="button" className={styles.secondaryButton} disabled={!Number.isInteger(tokenValue) || tokenValue < 2048 || tokenValue > 131072} onClick={() => void save({ contextTokens: tokenValue })}>{t("Сохранить окно")}</button>
      </>}
    </fieldset>}
    {pending && <small role="status">{t("Сохранение / загрузка…")}</small>}
    {error && <div role="alert">{localizeMessage(error)} {!policy && <button type="button" disabled={pending || disabled} onClick={() => setRetry((value) => value + 1)}>{t("Повторить")}</button>}</div>}
    {notice && <small role="status">{localizeMessage(notice)}</small>}
  </div>;
}
