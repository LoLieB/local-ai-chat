import { t } from "../i18n";
import type { AppState, CharacterCard, GroupChat, UserProfile } from "../types/domain";

export const nowIso = () => new Date().toISOString();

const fallbackId = () =>
  `id-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

export const createId = () => {
  if (typeof crypto !== "undefined") {
    if (typeof crypto.randomUUID === "function") {
      return crypto.randomUUID();
    }

    if (typeof crypto.getRandomValues === "function") {
      const bytes = new Uint8Array(16);
      crypto.getRandomValues(bytes);
      return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
    }
  }

  return fallbackId();
};

export const createUserId = () => `u-${createId().replace(/[^a-zA-Z0-9]/g, "").slice(0, 8).toLowerCase()}`;

export const createUserProfile = (): UserProfile => {
  const timestamp = nowIso();
  const id = createUserId();
  return {
    id,
    label: id,
    createdAt: timestamp,
    updatedAt: timestamp,
    autoNameNewChats: true
  };
};

export const defaultCharacters: CharacterCard[] = [
  {
    id: createId(),
    name: "Спокойный помощник",
    description: "Держит структуру, задаёт уточнения и отвечает без лишнего шума.",
    systemPrompt: "Ты внимательный локальный AI-помощник. Отвечай ясно, структурно и бережно к контексту пользователя.",
    avatar: "◇",
    temperature: 0.6,
    maxTokens: 1200,
    tags: ["work", "clean"],
    createdAt: nowIso(),
    updatedAt: nowIso()
  },
  {
    id: createId(),
    name: "Искра идей",
    description: "Помогает искать нестандартные варианты и превращать сырые мысли в планы.",
    systemPrompt: "Ты креативный собеседник для мозгового штурма. Предлагай смелые, но применимые идеи и кратко объясняй компромиссы.",
    avatar: "✦",
    temperature: 0.9,
    maxTokens: 1600,
    tags: ["creative", "future"],
    createdAt: nowIso(),
    updatedAt: nowIso()
  }
];

export const makeDefaultState = (): AppState => {
  const characterId = defaultCharacters[0]?.id || null;
  const chatId = createId();
  const groupChatId = createId();
  const createdAt = nowIso();
  const defaultGroupChat: GroupChat = {
    id: groupChatId,
    title: t("Групповая сессия"),
    participantIds: characterId ? [characterId] : [],
    activeSpeakerCharacterId: characterId,
    messages: [],
    responseMode: "single-speaker",
    maxRepliesPerTurn: 1,
    createdAt,
    updatedAt: createdAt
  };

  return {
    userProfile: createUserProfile(),
    settings: {
      baseUrl: "http://localhost:1234/v1",
      modelId: "",
      streaming: true,
      temperature: 0.7,
      maxTokens: 1024
    },
    characters: defaultCharacters,
    activeChatId: chatId,
    activeGroupChatId: groupChatId,
    chats: [
      {
        id: chatId,
        title: t("Новый чат"),
        characterId,
        messages: [],
        titleMode: "default",
        pinnedAt: null,
        createdAt,
        updatedAt: createdAt
      }
    ],
    groupChats: [defaultGroupChat]
  };
};
