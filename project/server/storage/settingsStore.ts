import { join } from "node:path";
import type { AppSettings } from "../types.js";
import { readJsonOrFallback, writeJsonAtomic } from "./jsonFile.js";

const settingsPath = join(process.cwd(), "server-data", "settings.json");

export const defaultSettings: AppSettings = {
  baseUrl: process.env.LM_STUDIO_BASE_URL || "http://localhost:1234/v1",
  modelId: process.env.LM_STUDIO_MODEL_ID || "",
  streaming: true,
  temperature: 0.7,
  maxTokens: 1024
};

export function validateSettingsPatch(current: AppSettings, payload: unknown): AppSettings {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("Settings must be an object.");
  }
  const patch = payload as Record<string, unknown>;
  const allowedKeys = ["baseUrl", "modelId", "streaming", "temperature", "maxTokens", "modelProfiles"];
  if (Object.keys(patch).some((key) => !allowedKeys.includes(key))) {
    throw new Error("Unknown settings field.");
  }
  const next = { ...current, ...patch };
  if (next.modelProfiles !== undefined) {
    if (!Array.isArray(next.modelProfiles) || next.modelProfiles.length > 50) throw new Error("Допускается до 50 профилей моделей.");
    const ids = new Set<string>();
    for (const profile of next.modelProfiles) {
      if (!profile || typeof profile !== "object" || Array.isArray(profile)) throw new Error("Некорректный профиль модели.");
      const { id, name, ...options } = profile;
      if (typeof id !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(id) || ids.has(id) || typeof name !== "string" || !name.trim() || name.length > 100 || "modelProfiles" in options) throw new Error("Некорректное имя или ID профиля модели.");
      if (!["baseUrl", "modelId", "streaming", "temperature", "maxTokens"].every(key => Object.hasOwn(options, key))) throw new Error("В профиле отсутствуют параметры подключения или генерации.");
      validateSettingsPatch(defaultSettings, options);
      ids.add(id);
    }
  }
  if (typeof next.baseUrl !== "string") {
    throw new Error("baseUrl must be an HTTP or HTTPS URL without credentials.");
  }
  let url: URL;
  try {
    url = new URL(next.baseUrl);
  } catch {
    throw new Error("baseUrl must be an HTTP or HTTPS URL without credentials.");
  }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) {
    throw new Error("baseUrl must be an HTTP or HTTPS URL without credentials.");
  }
  if (typeof next.modelId !== "string") {
    throw new Error("modelId must be a string.");
  }
  if (typeof next.streaming !== "boolean") {
    throw new Error("streaming must be a boolean.");
  }
  if (typeof next.temperature !== "number" || !Number.isFinite(next.temperature) || next.temperature < 0 || next.temperature > 2) {
    throw new Error("temperature must be between 0 and 2.");
  }
  if (typeof next.maxTokens !== "number" || !Number.isInteger(next.maxTokens) || next.maxTokens < 1 || next.maxTokens > 131072) {
    throw new Error("maxTokens must be an integer between 1 and 131072.");
  }
  return next as AppSettings;
}

export async function readSettings(filePath = settingsPath): Promise<AppSettings> {
  const stored = await readJsonOrFallback<Partial<AppSettings>>(filePath, {}, "settings.json");
  return { ...defaultSettings, ...stored };
}

export async function writeSettings(nextSettings: AppSettings, filePath = settingsPath): Promise<AppSettings> {
  const validated = validateSettingsPatch(defaultSettings, nextSettings);
  await writeJsonAtomic(filePath, validated);
  return validated;
}
