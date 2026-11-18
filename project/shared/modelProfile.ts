export type ModelProfile = {
  id: string;
  name: string;
  baseUrl: string;
  modelId: string;
  streaming: boolean;
  temperature: number;
  maxTokens: number;
};

export function profileSettings(profile: ModelProfile) {
  const { baseUrl, modelId, streaming, temperature, maxTokens } = profile;
  return { baseUrl, modelId, streaming, temperature, maxTokens };
}

export function resolveProfile(settings: { baseUrl: string; modelId: string; streaming: boolean; temperature: number; maxTokens: number; modelProfiles?: ModelProfile[] }, character: { modelProfileId?: string; temperature: number; maxTokens: number } | null, chatProfileId?: string | null) {
  const id = chatProfileId || character?.modelProfileId;
  const profile = settings.modelProfiles?.find(value => value.id === id);
  if (id && !profile) throw new Error("Выбранный профиль удалён или недоступен. Выберите другой профиль.");
  return profile ? { ...profileSettings(profile), source: chatProfileId ? "Профиль чата" : "Профиль персонажа", name: profile.name } : { ...profileSettings({ ...settings, id: "", name: "" }), temperature: character?.temperature ?? settings.temperature, maxTokens: character?.maxTokens ?? settings.maxTokens, source: "Текущие настройки", name: "" };
}
