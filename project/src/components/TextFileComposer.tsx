import { t, localizeMessage } from "../i18n";
import { useEffect, useId, useRef, useState, type RefObject } from "react";
import { formatTextFile, MAX_TEXT_FILE_BYTES, TEXT_FILE_ACCEPT } from "../textFile";
import styles from "../App.module.css";
import { saveTextFile } from "../api";
import { TextFileLibrary } from "./TextFileLibrary";
import { ChatImagePicker, ChatImageView } from "./ChatImagePicker";
import type { ChatImage } from "../../shared/chatImage";

type Props = { sessionToken: string; value: string; onChange: (value: string) => void; disabled?: boolean; textareaRef?: RefObject<HTMLTextAreaElement | null>; image?: ChatImage; onImageChange?: (image?: ChatImage) => void };

// The parent keys this component by account, conversation and branch.
export function TextFileComposer({ sessionToken, value, onChange, disabled, textareaRef, image, onImageChange }: Props) {
  const fileInput = useRef<HTMLInputElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const preview = useRef<HTMLDialogElement>(null);
  const dialogTitle = useId();
  const alive = useRef(true);
  const latest = useRef({ value, disabled });
  latest.current = { value, disabled };
  const [reading, setReading] = useState(false);
  const [notice, setNotice] = useState("");
  const [libraryRevision, setLibraryRevision] = useState(0);
  function returnToMessage() { dialog.current?.close(); (textareaRef || inputRef).current?.focus(); }
  function insert(name: string, text: string) {
    try {
      const block = formatTextFile(name, new TextEncoder().encode(text).buffer);
      const next = value + (value ? "\n\n" : "") + block;
      if (next.length > 32000) throw new Error(t("С файлами в черновике допустимо до 32 000 символов."));
      onChange(next); setNotice(t("Добавлен файл: {p0}", {p0: name})); returnToMessage();
    } catch (error) { setNotice(error instanceof Error ? error.message : t("Не удалось вставить файл.")); }
  }
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  async function add(files: FileList | null) {
    if (!files?.length || disabled || reading) return;
    if (files.length !== 1) { setNotice(t("Добавляйте по одному текстовому файлу.")); return; }
    const file = files[0];
    if (file.size > MAX_TEXT_FILE_BYTES) { setNotice(t("Файл должен быть не больше 32 КБ.")); return; }
    const original = value;
    setReading(true); setNotice("");
    try {
      const bytes = await file.arrayBuffer();
      const block = formatTextFile(file.name, bytes);
      if (!alive.current) return;
      if (latest.current.value !== original || latest.current.disabled) { setNotice(t("Черновик изменился. Добавьте файл ещё раз.")); return; }
      const next = original + (original ? "\n\n" : "") + block;
      if (next.length > 32000) throw new Error(t("С файлами в черновике допустимо до 32 000 символов."));
      await saveTextFile(file.name, new TextDecoder("utf-8", { fatal: true }).decode(bytes), sessionToken);
      if (!alive.current) return;
      setLibraryRevision(current => current + 1);
      if (latest.current.value !== original || latest.current.disabled) { setNotice(t("Файл сохранён в библиотеке. Черновик изменился; вставьте файл из библиотеки.")); return; }
      onChange(next);
      setNotice(t("Добавлен файл: {p0}", {p0: file.name})); returnToMessage();
    } catch (error) { if (alive.current) setNotice(error instanceof Error ? error.message : t("Не удалось прочитать файл.")); }
    finally { if (alive.current) setReading(false); }
  }
  return <>
    {image && <div className={styles.composerAttachment}>
      <button type="button" className={styles.composerImagePreview} aria-label={t("Просмотреть {p0}", {p0: image.name})} onClick={() => preview.current?.showModal()}>
        <img src={image.dataUrl} alt="" /><span>{image.name}<small>{t("Изображение")}</small></span>
      </button>
      <button type="button" className={styles.ghostButton} disabled={disabled} onClick={() => onImageChange?.()} aria-label={t("Убрать изображение")}>{t("Убрать")}</button>
    </div>}
    <div className={styles.composerTools}>
      <button type="button" className={styles.ghostButton} aria-haspopup="dialog" disabled={disabled || reading} onClick={() => dialog.current?.showModal()}>{t("Вложения")}</button>
    </div>
    <dialog ref={dialog} className={styles.attachmentDialog} aria-labelledby={dialogTitle} onClick={event => { if (event.target === event.currentTarget) dialog.current?.close(); }}>
      <header className={styles.attachmentDialogHeader}><h3 id={dialogTitle}>{t("Вложения")}</h3><button type="button" className={styles.ghostButton} onClick={() => dialog.current?.close()} aria-label={t("Закрыть вложения")}>{t("Закрыть")}</button></header>
      <p className={styles.attachmentHint}>{t("Добавьте файл к сообщению или выберите сохранённый.")}</p>
      {onImageChange && <ChatImagePicker image={image} onChange={next => { onImageChange(next); returnToMessage(); }} disabled={Boolean(disabled)} />}
      <input ref={fileInput} type="file" accept={TEXT_FILE_ACCEPT} hidden onChange={event => { void add(event.target.files); event.target.value = ""; }} />
      <button type="button" className={styles.ghostButton} disabled={disabled || reading} onClick={() => fileInput.current?.click()}>{t("Добавить текстовый файл")}</button>
      <TextFileLibrary sessionToken={sessionToken} revision={libraryRevision} disabled={disabled || reading} onInsert={insert} />
      {notice && <small role="status">{localizeMessage(notice)}</small>}
    </dialog>
    <dialog ref={preview} className={styles.attachmentDialog} aria-label={t("Просмотр изображения")} onClick={event => { if (event.target === event.currentTarget) preview.current?.close(); }}>
      <header className={styles.attachmentDialogHeader}><h3>{t("Изображение")}</h3><button type="button" className={styles.ghostButton} onClick={() => preview.current?.close()}>{t("Закрыть просмотр")}</button></header>
      {image && <ChatImageView image={image} expanded />}
    </dialog>
    {notice && <small role="status" className={styles.composerNotice}>{localizeMessage(notice)}</small>}
    <textarea className={styles.composerInput} aria-label={t("Сообщение")} ref={textareaRef || inputRef} value={value} disabled={disabled} onChange={event => { onChange(event.target.value); setNotice(""); }} onKeyDown={event=>{if(event.key==="Enter" && !event.shiftKey && !event.nativeEvent.isComposing && event.nativeEvent.keyCode!==229){event.preventDefault();if(!disabled&&!event.repeat)event.currentTarget.form?.requestSubmit();}}} placeholder={t("Напишите сообщение...")} rows={2}
      onDragOver={event => { if (event.dataTransfer.types.includes("Files")) event.preventDefault(); }}
      onDrop={event => { if (event.dataTransfer.files.length) { event.preventDefault(); void add(event.dataTransfer.files); } }}
      onPaste={event => { if (event.clipboardData.files.length) { event.preventDefault(); void add(event.clipboardData.files); } }}
    />
  </>;
}
