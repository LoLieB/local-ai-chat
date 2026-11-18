import { t, localizeMessage } from "../i18n";
import { useEffect, useRef, useState } from "react";
import { MAX_CHAT_IMAGE_BYTES, validChatImage, type ChatImage } from "../../shared/chatImage";
import styles from "../App.module.css";

export function ChatImageView({ image, expanded = false }: { image: ChatImage; expanded?: boolean }) {
  if (!validChatImage(image)) return null;
  return <details open={expanded || undefined}>
    <summary>{t("Изображение:")}{" "}{image.name} · {image.width}×{image.height}</summary>
    <img src={image.dataUrl} alt={image.name} style={{ maxWidth: "100%", maxHeight: 300, objectFit: "contain" }} />
    <a href={image.dataUrl} download={image.name}>{t("Скачать изображение")}</a>
  </details>;
}

export function ChatImagePicker({ image, onChange, disabled }: { image?: ChatImage; onChange: (image?: ChatImage) => void; disabled: boolean }) {
  const picker = useRef<HTMLInputElement>(null);
  const alive = useRef(true);
  const latestDisabled = useRef(disabled); latestDisabled.current = disabled;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  async function select(file?: File) {
    if (!file || busy || disabled) return;
    if (!/^image\/(png|jpeg|webp)$/.test(file.type) || file.size > 5 * 1024 * 1024) { setError(t("Выберите PNG, JPEG или WebP до 5 МБ.")); return; }
    setBusy(true); setError("");
    let bitmap: ImageBitmap | undefined;
    try {
      bitmap = await createImageBitmap(file);
      if (bitmap.width > 8192 || bitmap.height > 8192) throw new Error(t("Изображение должно быть не больше 8192×8192."));
      const canvas = document.createElement("canvas");
      const scale = Math.min(1, 1024 / Math.max(bitmap.width, bitmap.height));
      let width = Math.max(1, Math.round(bitmap.width * scale));
      let height = Math.max(1, Math.round(bitmap.height * scale));
      let dataUrl = "";
      for (;;) {
        canvas.width = width; canvas.height = height;
        const context = canvas.getContext("2d");
        if (!context) throw new Error(t("Не удалось подготовить изображение."));
        context.drawImage(bitmap, 0, 0, width, height);
        dataUrl = canvas.toDataURL("image/png");
        if (dataUrl.length <= Math.floor(MAX_CHAT_IMAGE_BYTES / 3) * 4) break;
        if (Math.max(width, height) <= 64) throw new Error(t("Не удалось уменьшить изображение до допустимого размера."));
        width = Math.max(1, Math.floor(width * .75)); height = Math.max(1, Math.floor(height * .75));
      }
      const next = { name: file.name.replace(/[\/\\\x00-\x1f\x7f]/g, "_").replace(/\.[^.]+$/, "").slice(0, 150) + ".png", dataUrl, width, height };
      if (!validChatImage(next)) throw new Error(t("Не удалось подготовить корректное PNG-изображение."));
      if (alive.current && !latestDisabled.current) onChange(next);
    } catch (reason) { if (alive.current) setError(reason instanceof Error ? reason.message : t("Не удалось прочитать изображение.")); }
    finally { bitmap?.close(); if (alive.current) setBusy(false); }
  }
  return <div style={{ gridColumn: "1 / -1", minWidth: 0 }}>
    <input ref={picker} type="file" accept="image/png,image/jpeg,image/webp" hidden onChange={event => { void select(event.target.files?.[0]); event.target.value = ""; }} />
    <button type="button" className={styles.ghostButton} disabled={disabled || busy} onClick={() => picker.current?.click()}>{image ? t("Заменить изображение") : t("Добавить изображение")}</button>
    <small className={styles.attachmentHint}>{t("PNG, JPEG, WebP · до 5 МБ. Для ответа нужна модель с поддержкой изображений.")}</small>
    {busy && <small role="status">{t("Подготовка изображения…")}</small>}
    {error && <small role="alert">{localizeMessage(error)}</small>}
  </div>;
}
