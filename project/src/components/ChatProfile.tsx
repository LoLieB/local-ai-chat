import { t, localizeMessage } from "../i18n";
import { useState } from "react";
import { resolveProfile } from "../../shared/modelProfile";
import type { AppSettings, CharacterCard, Chat } from "../types/domain";

export function ChatProfile({ chat, character, settings, disabled, onChange }: { chat: Chat; character: CharacterCard | null; settings: AppSettings; disabled: boolean; onChange: (id: string | null) => Promise<void> }) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  let description;
  try { const value = resolveProfile(settings, character, chat.modelProfileId); description = t("{p0}{p1} · {p2} · температура {p3} · максимум {p4} · поток {p5}", {p0: localizeMessage(value.source), p1: value.name ? `: ${value.name}` : "", p2: value.modelId || t("Модель не выбрана"), p3: value.temperature, p4: value.maxTokens, p5: value.streaming ? t("включён") : t("выключен")}); }
  catch (reason) { description = reason instanceof Error ? reason.message : t("Профиль недоступен"); }
  return <details>
    <summary>{t("Модель и параметры чата")}</summary>
    <p style={{ overflowWrap: "anywhere" }}>{description}</p>
    <label>{t("Профиль чата")}<select aria-label={t("Профиль чата")} disabled={disabled || pending} value={chat.modelProfileId || ""} onChange={async event => {
      const id = event.target.value || null; setPending(true); setError("");
      try { await onChange(id); } catch (reason) { setError(reason instanceof Error ? reason.message : t("Не удалось сохранить профиль")); } finally { setPending(false); }
    }}><option value="">{t("Наследовать от персонажа / настроек")}</option>{chat.modelProfileId && !settings.modelProfiles?.some(profile => profile.id === chat.modelProfileId) && <option value={chat.modelProfileId}>{t("Недоступный профиль")}</option>}{settings.modelProfiles?.map(profile => <option key={profile.id} value={profile.id}>{profile.name}</option>)}</select></label>
    {error && <p role="alert">{localizeMessage(error)}</p>}
  </details>;
}
