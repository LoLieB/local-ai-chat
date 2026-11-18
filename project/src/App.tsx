import { MessageBody } from "./components/MessageBody";
import { factoryCards, thumbnail } from "../shared/studioCatalog";
import { StudioGallery, StudioPortrait, StudioAvatar, PortraitPicker } from "./components/StudioGallery";
import { t, useLocale, localizeMessage, getLocale, pluralCount } from "./i18n";
import { LanguageSelector } from "./i18n/LanguageSelector";
import { ChatImageView } from "./components/ChatImagePicker";
import { validChatImage, type ChatImage } from "../shared/chatImage";
import { TextFileComposer } from "./components/TextFileComposer";
import { MessageTools } from "./components/MessageTools";
import { DEFAULT_CHAT_FILTERS, filterChats } from "../shared/chatOrganization";
import { ChatListFilters, ChatOrganizationControls } from "./components/ChatOrganization";
import { generationTiming } from "./generationTiming";
import { resolveProfile } from "../shared/modelProfile";
import { ChatProfile } from "./components/ChatProfile";
import { CharacterTools } from "./components/CharacterTools";
import { CharacterVersions } from "./components/CharacterVersions";
import { ModelProfiles } from "./components/ModelProfiles";
import { buildCharacterPrompt, CHARACTER_DETAIL_FIELDS, importCharacterCard, MAX_CHARACTER_BYTES, validateCharacterCard } from "../shared/characterCard";
import { ContextDetails } from "./components/ContextDetails";
import { MemoryControls } from "./components/MemoryControls";
﻿import { CSSProperties, FormEvent, useEffect, useMemo, useRef, useState } from "react";
import {
  ApiHttpError,
  startCharacterChat,
  getAuthSession,
  deleteServerChat,
  getChatState,
  getHealth,
  getPublicRouteStatus,
  getServerSettings,
  getUserState,
  loginAuth,
  loadModels,
  logoutAuth,
  mutateChatMessage,
  registerAuth,
  saveServerSettings,
  sendChat,
  streamChat,
  syncUserState,
  type PublicRouteStatus
} from "./api";
import { CHAT_EXPORT_FORMAT, CHAT_EXPORT_VERSION, MAX_CHAT_IMPORT_BYTES, validateImportedChat } from "../shared/chatTransfer";
import styles from "./App.module.css";
import { createWorkspaceSyncQueue, type WorkspaceSaveStatus } from "./workspaceSync";
import { createPortal } from "react-dom";
import {
  getBackgroundArtworks,
  loadBackgroundDisplayCollapsed,
  pickSessionBackground,
  saveBackgroundDisplayCollapsed,
  saveBackgroundSelection
} from "./backgrounds";
import { BackgroundDisplay } from "./components/BackgroundDisplay";
import { GroupChatTab } from "./components/GroupChatTab";
import { MemoryCenter } from "./components/MemoryCenter";
import { DataManager } from "./components/DataManager";
import { createId, makeDefaultState, nowIso } from "./storage/defaultState";
import { LocalStorageAdapter } from "./storage/localStorageAdapter";
import type { AppSettings, AppState, AuthSession, CharacterCard, Chat, ChatMessage } from "./types/domain";
import { formatChatRequestError } from "../shared/chatRequestPolicy";
import { mergeAssistantContinuation } from "../shared/chatTranscriptActions";
import { resolveMessageAuthorName } from "../shared/chatMetadata";
import { isNearScrollEnd, shouldShowNewMessages, sortPinnedByUpdated } from "../shared/stressHelpers";

type Tab = "chats" | "group" | "memory" | "settings" | "characters";
type ThemeMode = "cinematic" | "brutal" | "studio";

const storage = new LocalStorageAdapter();
const themeStorageKey = "local-ai-chat:theme";
const backgroundArtworks = getBackgroundArtworks();

const normalizeThemeMode = (value: string | null | undefined): ThemeMode =>
  value === "brutal" || value === "studio" ? value : "cinematic";

const loadThemeMode = (): ThemeMode => {
  if (typeof window === "undefined") {
    return "cinematic";
  }

  try {
    return normalizeThemeMode(window.localStorage.getItem(themeStorageKey) || "studio");
  } catch {
    return "cinematic";
  }
};

const compactModelId = (modelId: string) => {
  const value = modelId.trim();
  if (!value) {
    return t("Модель не выбрана");
  }

  if (value.length <= 28) {
    return value;
  }

  return `${value.slice(0, 16)}…${value.slice(-8)}`;
};

const emptyCharacterDraft = (): CharacterCard => ({
  id: createId(),
  name: t("Новый персонаж"),
  description: "",
  systemPrompt: "",
  avatar: "✧",
  posterUrl: "",
  temperature: 0.7,
  maxTokens: 1024,
  tags: [],
  createdAt: nowIso(),
  updatedAt: nowIso()
});

const characterDraftSignature = (character: CharacterCard) =>
  JSON.stringify({
    id: character.id,
    name: character.name,
    description: character.description,
    systemPrompt: character.systemPrompt,
    avatar: character.avatar,
    posterUrl: character.posterUrl || "",
    temperature: character.temperature,
    maxTokens: character.maxTokens,
    tags: character.tags,
    modelProfileId: character.modelProfileId || "",
    favorite: Boolean(character.favorite),
    ...Object.fromEntries(CHARACTER_DETAIL_FIELDS.map(key => [key, character[key] || ""]))
  });

const compactMessages = (messages: ChatMessage[]) =>
  messages.map(({ id, role, content, createdAt }) => ({ id, role, content, createdAt }));

const safeDownloadName = (title: string, extension: string) => `${(title || "chat").replace(/[^a-z0-9а-яё_-]+/gi, "-").replace(/^-|-$/g, "").slice(0, 60) || "chat"}-${new Date().toISOString().slice(0, 10)}.${extension}`;
const downloadText = (name: string, content: string, type: string) => {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const link = document.createElement("a"); link.href = url; link.download = name; link.click(); URL.revokeObjectURL(url);
};

const chatDraftKey = (userId: string, chatId: string, branchId?: string | null) =>
  `local-ai-chat:chat-draft:${userId}:${chatId}${branchId ? `:${branchId}` : ""}`;

const readChatDraft = (userId: string | undefined, chatId: string | undefined, branchId?: string | null) => {
  if (!userId || !chatId || typeof window === "undefined") return "";
  try {
    return window.localStorage.getItem(chatDraftKey(userId, chatId, branchId))
      || window.localStorage.getItem(chatDraftKey(userId, chatId))
      || "";
  } catch {
    return "";
  }
};

const saveChatDraft = (userId: string | undefined, chatId: string | undefined, branchId: string | null | undefined, value: string) => {
  if (!userId || !chatId || typeof window === "undefined") return;
  try {
    const key = chatDraftKey(userId, chatId, branchId);
    if (value) window.localStorage.setItem(key, value);
    else window.localStorage.removeItem(key);
    if (branchId) window.localStorage.removeItem(chatDraftKey(userId, chatId));
  } catch {
    // Drafts are local convenience only.
  }
};

const buildUserStateSyncPayload = (state: AppState) => ({
  userProfile: state.userProfile,
  characters: state.characters,
  chatSummaries: [
    ...state.chats.map((chat) => ({
      id: chat.id,
      kind: "chat" as const,
      title: chat.title,
      updatedAt: chat.updatedAt,
      messageCount: chat.messages.length,
      titleMode: chat.titleMode,
      pinnedAt: chat.pinnedAt || null
    })),
    ...state.groupChats.map((groupChat) => ({
      id: groupChat.id,
      kind: "group-chat" as const,
      title: groupChat.title,
      updatedAt: groupChat.updatedAt,
      messageCount: groupChat.messages.length
    }))
  ]
});

function emitBootStage(stage: string) {
  window.dispatchEvent(new CustomEvent("local-ai-chat:boot-stage", { detail: stage }));
}

export default function App() {
  const locale=useLocale();
  const ru=locale==="ru-RU";
  const [state, setState] = useState<AppState>(() => storage.load());
  const [gallery,setGallery]=useState(false);
  const factory=useMemo(()=>factoryCards(locale),[locale]);
  const cards=useMemo(()=>[...state.characters,...factory],[state.characters,factory]);
  const [mobilePanel,setMobilePanel]=useState<"list"|"portrait"|null>(null);
  const [tab, setTab] = useState<Tab>("chats");
  const [navigationOpen, setNavigationOpen] = useState(false);
  function openSection(section: Tab) {
    setGallery(false);
    setNavigationOpen(false);
    setMobilePanel(null);
    setTab(section);
  }
  const [input, setInput] = useState("");
  const [imageDrafts, setImageDrafts] = useState<Record<string, ChatImage | null>>({});
  const [chatFilters, setChatFilters] = useState({ ...DEFAULT_CHAT_FILTERS });
  useEffect(() => setChatFilters({ ...DEFAULT_CHAT_FILTERS }), [state.authSession?.sessionToken]);
  const [status, setStatus] = useState(t("Готово"));
  const [generationStats, setGenerationStats] = useState<Record<string, string>>({});
  useEffect(() => setGenerationStats({}), [state.authSession?.sessionToken]);
  const [sendingChatIds, setSendingChatIds] = useState<Set<string>>(() => new Set());
  const [editingMessageId, setEditingMessageId] = useState<string | null>(null);
  const [editingMessageText, setEditingMessageText] = useState("");
  const [confirmDeleteMessageId, setConfirmDeleteMessageId] = useState<string | null>(null);
  const [copiedMessageId, setCopiedMessageId] = useState<string | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchIndex, setSearchIndex] = useState(0);
  const [pinsOpen, setPinsOpen] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const [openChatMenuId, setOpenChatMenuId] = useState<string | null>(null);
  const [chatMenuPosition, setChatMenuPosition] = useState<CSSProperties | null>(null);
  const [renameChatId, setRenameChatId] = useState<string | null>(null);
  const [renameTitle, setRenameTitle] = useState("");
  const [titleGenerationChatId, setTitleGenerationChatId] = useState<string | null>(null);
  const chatToolsRef = useRef<HTMLDivElement | null>(null);
  const chatPopoverRef = useRef<HTMLDivElement | null>(null);
  const chatMenuRef = useRef<HTMLDivElement | null>(null);
  const chatPopoverTriggerRef = useRef<HTMLElement | null>(null);
  const chatMenuTriggerRef = useRef<HTMLButtonElement | null>(null);
  const searchTriggerRef = useRef<HTMLButtonElement | null>(null);
  const backgroundDisplayTriggerRef = useRef<HTMLButtonElement | null>(null);
  const [chatPopoverPosition, setChatPopoverPosition] = useState<CSSProperties | null>(null);
  const messageRefs = useRef<Record<string, HTMLElement | null>>({});
  const messagesRef = useRef<HTMLDivElement | null>(null);
  const followMessagesRef = useRef(true);
  const scrollFrameRef = useRef<number | null>(null);
  const [showNewMessages, setShowNewMessages] = useState(false);
  const [registry, setRegistry] = useState<{url: string; models: Array<{id: string}>}>({url:"", models:[]});
  const models = registry.url === state.settings.baseUrl ? registry.models : [];
  const isModelListed = (model: {baseUrl:string; modelId:string} | null) =>
    Boolean(model && registry.url === model.baseUrl && registry.models.some(item => item.id === model.modelId));
  const [publicRouteStatus, setPublicRouteStatus] = useState<PublicRouteStatus | null>(null);
  const [redirectCountdownSec, setRedirectCountdownSec] = useState<number | null>(null);
  const [characterDraft, setCharacterDraft] = useState<CharacterCard>(() => emptyCharacterDraft());
  const [editingCharacterId, setEditingCharacterId] = useState<string | null>(null);
  const [isCreatingCharacter, setIsCreatingCharacter] = useState(false);
  const [characterDraftBaseline, setCharacterDraftBaseline] = useState("");
  const [characterSearch, setCharacterSearch] = useState("");
  const [characterTag, setCharacterTag] = useState("");
  const [favoritesOnly, setFavoritesOnly] = useState(false);
  const [characterSort, setCharacterSort] = useState("original");
  const characterItemRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const [authMode, setAuthMode] = useState<"login" | "register">("login");
  const [authUsername, setAuthUsername] = useState("");
  const [authPassword, setAuthPassword] = useState("");
  const [isAuthWorking, setIsAuthWorking] = useState(false);
  const [isAuthChecked, setIsAuthChecked] = useState(false);
  const [sessionBackground, setSessionBackground] = useState(() => pickSessionBackground());
  const [isBackgroundDisplayOpen, setIsBackgroundDisplayOpen] = useState(
    () => !loadBackgroundDisplayCollapsed()
  );
  const [themeMode, setThemeMode] = useState<ThemeMode>(() => loadThemeMode());
  const restoreFocus = (element: HTMLElement | null) => {
    window.requestAnimationFrame(() => element?.focus());
  };
  const closeChatPopovers = (restoreTrigger = false) => {
    setSearchOpen(false);
    setPinsOpen(false);
    setExportOpen(false);
    if (restoreTrigger) restoreFocus(chatPopoverTriggerRef.current);
  };
  const [hydratedToken, setHydratedToken] = useState<string | null>(null);
  const [hydrationAttempt, setHydrationAttempt] = useState(0);
  const [workspaceSaveStatus, setWorkspaceSaveStatus] = useState<WorkspaceSaveStatus>("idle");
  const syncPayloadSignatureRef = useRef<string | null>(null);
  const syncQueueRef = useRef<ReturnType<typeof createWorkspaceSyncQueue<ReturnType<typeof buildUserStateSyncPayload>>> | null>(null);
  const sessionEpochRef = useRef(0);
  const generationRef = useRef(new Map<string, {
    id: string;
    chatId: string;
    controller: AbortController;
    action: "send" | "regenerate" | "continue";
    pendingMessageId?: string;
    targetMessageId?: string;
  }>());
  const titleGenerationRef = useRef(new Set<string>());
  const activeChatIdRef = useRef(state.activeChatId);
  const composerRef = useRef<HTMLTextAreaElement | null>(null);

  const hasCharacterEditorOpen = Boolean(editingCharacterId || isCreatingCharacter);
  const isCharacterDraftDirty = hasCharacterEditorOpen
    && characterDraftSignature(characterDraft) !== characterDraftBaseline;
  const filteredCharacters = useMemo(() => {
    const query = characterSearch.trim().toLocaleLowerCase("ru");
    const cards = state.characters.filter((character) =>
      (!favoritesOnly || character.favorite) && (!characterTag || character.tags.includes(characterTag)) &&
      (!query || [character.name, ...character.tags].some((value) => value.toLocaleLowerCase("ru").includes(query)))
    );
    if (characterSort === "name") cards.sort((a, b) => a.name.localeCompare(b.name, "ru"));
    if (characterSort === "updated") cards.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    if (characterSort === "created") cards.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return cards;
  }, [characterSearch, characterTag, favoritesOnly, characterSort, state.characters]);

  useEffect(() => {
    if (!editingCharacterId) return;
    characterItemRefs.current[editingCharacterId]?.scrollIntoView({ block: "nearest" });
  }, [editingCharacterId, filteredCharacters]);

  const scheduleMessagesScroll = () => {
    if (!followMessagesRef.current) {
      setShowNewMessages(true);
      return;
    }

    if (scrollFrameRef.current != null) {
      return;
    }

    scrollFrameRef.current = window.requestAnimationFrame(() => {
      scrollFrameRef.current = null;
      const element = messagesRef.current;
      if (!element || !followMessagesRef.current) return;
      element.scrollTo({ top: element.scrollHeight, behavior: "auto" });
      setShowNewMessages(false);
    });
  };

  const jumpToLatestMessages = () => {
    followMessagesRef.current = true;
    setShowNewMessages(false);
    const element = messagesRef.current;
    if (element) {
      element.scrollTo({ top: element.scrollHeight, behavior: "smooth" });
    }
  };

  useEffect(() => {
    emitBootStage("app-mounted");
  }, []);

  useEffect(() => {
    if (!isAuthChecked) {
      return;
    }

    emitBootStage("boot-ready");
    window.dispatchEvent(new Event("local-ai-chat:boot-ready"));
  }, [isAuthChecked]);

  useEffect(() => {
    storage.save(state);
  }, [state]);

  useEffect(() => {
    try {
      window.localStorage.setItem(themeStorageKey, themeMode);
    } catch {
      // Theme selection is cosmetic; ignore storage failures.
    }
  }, [themeMode]);

  useEffect(() => {
    if (hydratedToken && hydratedToken === state.authSession?.sessionToken) {
      const payload = buildUserStateSyncPayload(state);
      const signature = JSON.stringify(payload);
      if (signature !== syncPayloadSignatureRef.current) {
        syncPayloadSignatureRef.current = signature;
        syncQueueRef.current?.enqueue(payload);
      }
    }
  }, [hydratedToken, state.authSession?.sessionToken, state.userProfile, state.characters, state.chats, state.groupChats]);

  useEffect(() => {
    const sessionToken = state.authSession?.sessionToken;
    const epoch = ++sessionEpochRef.current;
    let cancelled = false;
    syncQueueRef.current?.dispose();
    syncQueueRef.current = null;
    syncPayloadSignatureRef.current = null;
    setHydratedToken(null);
    setWorkspaceSaveStatus("idle");
    if (!sessionToken) {
      setIsAuthChecked(true);
      return;
    }
    setIsAuthChecked(false);
    emitBootStage("auth-session:checking");
    getAuthSession(sessionToken)
      .then(async (session) => {
        const [serverState, chatState] = await Promise.all([
          getUserState(sessionToken),
          getChatState(sessionToken)
        ]);
        if (cancelled || epoch !== sessionEpochRef.current) return;
        hydrateSessionState({ ...session, sessionToken }, serverState, chatState);
        syncQueueRef.current = createWorkspaceSyncQueue({
          revision: serverState.revision ?? 0,
          debounceMs: 1500,
          send: (payload, revision, signal) => syncUserState({ ...payload, revision }, sessionToken, signal),
          onRevision: (revision) => setState((current) => current.authSession?.sessionToken === sessionToken
            ? { ...current, workspaceRevision: revision } : current),
          onStatus: setWorkspaceSaveStatus,
          isConflict: (error) => error instanceof ApiHttpError && error.status === 409
        });
        setHydratedToken(sessionToken);
        setStatus(t("Сессия восстановлена"));
      })
      .catch((error) => {
        if (cancelled || epoch !== sessionEpochRef.current) return;
        if (error instanceof ApiHttpError && error.status === 401) {
          applyAuthSession(null);
          setStatus(t("Войдите в систему"));
        } else {
          setStatus(t("Не удалось загрузить все данные. Сохранение приостановлено; локальные данные сохранены."));
        }
      })
      .finally(() => { if (!cancelled && epoch === sessionEpochRef.current) setIsAuthChecked(true); });
    return () => {
      cancelled = true;
      syncQueueRef.current?.dispose();
      syncQueueRef.current = null;
      for (const generation of generationRef.current.values()) generation.controller.abort();
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.authSession?.sessionToken, hydrationAttempt]);

  useEffect(() => {
    getHealth()
      .then(() => setStatus(t("Локальный сервер подключен")))
      .catch(() => setStatus(t("Локальный сервер не отвечает")));
  }, []);

  useEffect(() => {
    let cancelled = false;

    const pollRouteStatus = async () => {
      try {
        const nextStatus = await getPublicRouteStatus();
        if (!cancelled) {
          setPublicRouteStatus(nextStatus);
        }
      } catch {
        if (!cancelled) {
          setPublicRouteStatus(null);
        }
      }
    };

    void pollRouteStatus();
    const intervalId = window.setInterval(() => {
      void pollRouteStatus();
    }, 10000);

    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
    };
  }, []);

  useEffect(() => {
    if (!publicRouteStatus?.preferredRecoveredUrl || !publicRouteStatus.redirectAfter) {
      setRedirectCountdownSec(null);
      return;
    }

    const tick = () => {
      const msLeft = Date.parse(publicRouteStatus.redirectAfter) - Date.now();
      const secLeft = Math.max(0, Math.ceil(msLeft / 1000));
      setRedirectCountdownSec(secLeft);
    };

    tick();
    const intervalId = window.setInterval(tick, 1000);
    return () => window.clearInterval(intervalId);
  }, [publicRouteStatus?.preferredRecoveredUrl, publicRouteStatus?.redirectAfter]);

  useEffect(() => {
    getServerSettings()
      .then((serverSettings) => {
        setState((current) => ({
          ...current,
          settings: { ...current.settings, ...serverSettings }
        }));

        if (!serverSettings.baseUrl.trim()) {
          return undefined;
        }

        return state.authSession?.sessionToken ? loadModels(serverSettings.baseUrl, state.authSession.sessionToken)
          .then(loadedModels => setRegistry({url:serverSettings.baseUrl, models:loadedModels}))
          .catch(() => setRegistry({url:"", models:[]})) : undefined;
      })
      .catch(() => undefined);
  }, [state.authSession?.sessionToken]);

  const activeChat = useMemo(
    () => state.chats.find((chat) => chat.id === state.activeChatId) || state.chats[0],
    [state.activeChatId, state.chats]
  );

  const imageDraftKey = `local-ai-chat:image-draft:${state.userProfile.id}:${activeChat?.id || ""}:${activeChat?.activeLeafId || ""}`;
  const draftImage = useMemo(() => {
    if (imageDraftKey in imageDrafts) return imageDrafts[imageDraftKey] || undefined;
    try { const saved: unknown = JSON.parse(sessionStorage.getItem(imageDraftKey) || "null"); return validChatImage(saved) ? saved : undefined; } catch { return undefined; }
  }, [imageDraftKey, imageDrafts]);
  const updateImageDraft = (key: string, image?: ChatImage) => {
    setImageDrafts(current => ({ ...current, [key]: image || null }));
    try { if (image) sessionStorage.setItem(key, JSON.stringify(image)); else sessionStorage.removeItem(key); }
    catch { setStatus(t("Изображение пока только в памяти вкладки: браузер не сохранил черновик.")); }
  };

  const selectedCharacter = useMemo(
    () => cards.find((character) => character.id === activeChat?.characterId) || null,
    [activeChat?.characterId, cards]
  );

  const activeModel = useMemo(() => {
    try {return resolveProfile(state.settings, selectedCharacter, activeChat?.modelProfileId);}
    catch {return null;}
  }, [state.settings, selectedCharacter, activeChat?.modelProfileId]);

  const sortedChats = useMemo(() => sortPinnedByUpdated(filterChats(state.chats, chatFilters)), [state.chats, chatFilters]);
  const lastAssistantMessage = useMemo(
    () => [...(activeChat?.messages || [])].reverse().find((message) => message.role === "assistant") || null,
    [activeChat?.messages]
  );
  const lastUserMessage = useMemo(
    () => [...(activeChat?.messages || [])].reverse().find((message) => message.role === "user") || null,
    [activeChat?.messages]
  );
  const isSending = activeChat ? sendingChatIds.has(activeChat.id) : false;
  const searchMatches = useMemo(() => {
    const query = searchQuery.trim().toLocaleLowerCase();
    return query ? (activeChat?.messages || []).filter((message) => message.content.toLocaleLowerCase().includes(query)) : [];
  }, [activeChat?.messages, searchQuery]);
  const visiblePins = useMemo(() => {
    const ids = new Set(activeChat?.pinnedMessageIds || []);
    return (activeChat?.messages || []).filter((message) => ids.has(message.id));
  }, [activeChat?.messages, activeChat?.pinnedMessageIds]);

  useEffect(() => setSearchIndex(0), [activeChat?.id, activeChat?.activeLeafId, searchQuery]);
  useEffect(() => {
    if (!searchMatches.length) return;
    const message = searchMatches[searchIndex % searchMatches.length];
    if (message) messageRefs.current[message.id]?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [searchIndex, searchMatches]);
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (tab !== "chats") return;
      if (event.key === "Escape" && (searchOpen || pinsOpen || exportOpen || openChatMenuId || renameChatId)) {
        closeChatPopovers(searchOpen || pinsOpen || exportOpen);
        if (openChatMenuId || renameChatId) restoreFocus(chatMenuTriggerRef.current);
        setOpenChatMenuId(null);
        setRenameChatId(null);
        return;
      }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "f") {
        event.preventDefault();
        chatPopoverTriggerRef.current = searchTriggerRef.current;
        setSearchOpen(true); setPinsOpen(false); setExportOpen(false);
      }
    };
    window.addEventListener("keydown", onKeyDown); return () => window.removeEventListener("keydown", onKeyDown);
  }, [tab, searchOpen, pinsOpen, exportOpen, openChatMenuId, renameChatId]);

  useEffect(() => {
    setSearchOpen(false);
    setPinsOpen(false);
    setExportOpen(false);
    setOpenChatMenuId(null);
  }, [activeChat?.id, tab]);

  useEffect(() => {
    if (!searchOpen && !pinsOpen && !exportOpen && !openChatMenuId) return;
    const onPointerDown = (event: PointerEvent) => {
      if (
        event.target instanceof Node &&
        !chatToolsRef.current?.contains(event.target) &&
        !chatPopoverRef.current?.contains(event.target) &&
        !chatMenuRef.current?.contains(event.target)
      ) {
        setSearchOpen(false);
        setPinsOpen(false);
        setExportOpen(false);
        setOpenChatMenuId(null);
      }
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [searchOpen, pinsOpen, exportOpen, openChatMenuId]);

  useEffect(() => {
    if (!searchOpen && !pinsOpen && !exportOpen && !openChatMenuId) return;
    const closePopover = () => {
      setSearchOpen(false);
      setPinsOpen(false);
      setExportOpen(false);
      setOpenChatMenuId(null);
    };
    window.addEventListener("resize", closePopover);
    window.addEventListener("scroll", closePopover, true);
    return () => {
      window.removeEventListener("resize", closePopover);
      window.removeEventListener("scroll", closePopover, true);
    };
  }, [searchOpen, pinsOpen, exportOpen, openChatMenuId]);

  useEffect(() => {
    activeChatIdRef.current = activeChat?.id || null;
    followMessagesRef.current = true;
    setShowNewMessages(false);
    window.requestAnimationFrame(scheduleMessagesScroll);
  }, [activeChat?.id]);

  useEffect(() => () => {
    if (scrollFrameRef.current != null) {
      window.cancelAnimationFrame(scrollFrameRef.current);
    }
  }, []);

  useEffect(() => {
    setInput(readChatDraft(state.userProfile.id, activeChat?.id, activeChat?.activeLeafId));
    setEditingMessageId(null);
    setConfirmDeleteMessageId(null);
  }, [activeChat?.id, activeChat?.activeLeafId, state.userProfile.id]);

  useEffect(() => () => generationRef.current.forEach((generation) => generation.controller.abort()), []);
  const shellStyle = useMemo(
    () =>
      ({
        "--app-background-image": sessionBackground ? `url("${sessionBackground}")` : "none",
        "--app-background-opacity": sessionBackground ? "0.24" : "0"
      }) as CSSProperties,
    [sessionBackground]
  );

  const recoveredPreferredUrl = publicRouteStatus?.preferredRecoveredUrl || "";
  const temporaryPublicUrl = publicRouteStatus?.temporaryPublicUrl || "";
  const hasBaseUrl = Boolean(state.settings.baseUrl.trim());
  const hasModelId = Boolean(state.settings.modelId.trim());
  const hasLoadedModels = models.length > 0;
  const themeClassName =
    themeMode === "brutal" ? styles.themeBrutal : themeMode === "studio" ? styles.themeStudio : "";
  const updateBackgroundDisplayOpen = (isOpen: boolean) => {
    saveBackgroundDisplayCollapsed(!isOpen);
    setIsBackgroundDisplayOpen(isOpen);
    if (!isOpen) restoreFocus(backgroundDisplayTriggerRef.current);
  };
  const applyBackground = (background: string) => {
    saveBackgroundSelection(background);
    setSessionBackground(background);
    setStatus(t("Фон обновлён"));
  };
  const isOnTemporaryMirror = (() => {
    if (!recoveredPreferredUrl || !temporaryPublicUrl) {
      return false;
    }

    try {
      return window.location.origin === new URL(temporaryPublicUrl).origin;
    } catch {
      return false;
    }
  })();

  useEffect(() => {
    if (!isOnTemporaryMirror || !recoveredPreferredUrl || redirectCountdownSec == null || redirectCountdownSec > 0) {
      return;
    }

    window.location.href = recoveredPreferredUrl;
  }, [isOnTemporaryMirror, recoveredPreferredUrl, redirectCountdownSec]);

  const updateState = (updater: (current: AppState) => AppState) => {
    setState((current) => updater(current));
  };

  const updateSettings = (patch: Partial<AppSettings>) => {
    updateState((current) => ({ ...current, settings: { ...current.settings, ...patch } }));
  };

  const applyAuthSession = (session: AuthSession | null) => {
    ++sessionEpochRef.current;
    syncQueueRef.current?.dispose();
    syncQueueRef.current = null;
    setHydratedToken(null);
    for (const generation of generationRef.current.values()) generation.controller.abort();
    updateState((current) => ({
      ...current,
      authSession: session,
      userProfile: session
        ? {
            ...current.userProfile,
            id: session.userId,
            label: session.username,
            updatedAt: nowIso()
          }
        : {
            ...current.userProfile,
            label: "Guest",
            updatedAt: nowIso()
          }
    }));
  };

  const hydrateSessionState = (
    session: AuthSession,
    serverState: {
      revision?: number;
      userProfile: AppState["userProfile"];
      characters: AppState["characters"];
      chatSummaries: Array<{ id: string; kind: "chat" | "group-chat"; title: string; updatedAt: string; messageCount: number; titleMode?: "default" | "auto" | "manual"; pinnedAt?: string | null }>;
    },
    chatState: Pick<AppState, "chats" | "groupChats">
  ) => {
    updateState((current) => {
      const fallbackState = makeDefaultState();
      const summaryChats = serverState.chatSummaries
        .filter((summary) => summary.kind === "chat")
        .map((summary) => ({
          id: summary.id,
          title: summary.title,
          characterId: null,
          messages: [],
          titleMode: summary.titleMode,
          pinnedAt: summary.pinnedAt || null,
          createdAt: summary.updatedAt,
          updatedAt: summary.updatedAt
        }));

      const summaryGroupChats = serverState.chatSummaries
        .filter((summary) => summary.kind === "group-chat")
        .map((summary) => ({
          id: summary.id,
          title: summary.title,
          participantIds: [],
          activeSpeakerCharacterId: null,
          messages: [],
          responseMode: "single-speaker" as const,
          maxRepliesPerTurn: 1,
          createdAt: summary.updatedAt,
          updatedAt: summary.updatedAt
        }));

      const restoredChats = [...chatState.chats, ...summaryChats.filter((summary) => !chatState.chats.some((chat) => chat.id === summary.id))];
      const restoredGroups = [...chatState.groupChats, ...summaryGroupChats.filter((summary) => !chatState.groupChats.some((chat) => chat.id === summary.id))];
      const chats = restoredChats.length ? restoredChats : fallbackState.chats;
      const groupChats = restoredGroups.length ? restoredGroups : fallbackState.groupChats;

      const hydrated: AppState = {
        ...current,
        authSession: session,
        workspaceRevision: serverState.revision ?? 0,
        userProfile: {
          ...serverState.userProfile,
          id: session.userId,
          label: session.username,
          autoNameNewChats: serverState.userProfile.autoNameNewChats !== false,
          updatedAt: nowIso()
        },
        characters: serverState.characters,
        chats,
        groupChats,
        activeChatId: chats.find((chat) => chat.id === current.activeChatId)?.id || chats[0]?.id || current.activeChatId,
        activeGroupChatId:
          groupChats.find((groupChat) => groupChat.id === current.activeGroupChatId)?.id ||
          groupChats[0]?.id ||
          current.activeGroupChatId
      };
      syncPayloadSignatureRef.current = JSON.stringify(buildUserStateSyncPayload(hydrated));
      return hydrated;
    });
  };

  const handleAuthSubmit = async (event: FormEvent) => {
    event.preventDefault();

    const username = authUsername.trim();
    const password = authPassword.trim();

    if (!username || !password) {
      setStatus(t("Введите имя пользователя и пароль"));
      return;
    }

    setIsAuthWorking(true);
    try {
      const sessionResult =
        authMode === "register"
          ? await registerAuth(username, password)
          : await loginAuth(username, password);
      const session = {
        username: sessionResult.username,
        userId: sessionResult.userId,
        sessionToken: sessionResult.sessionToken,
        expiresAt: sessionResult.expiresAt
      };
      applyAuthSession(session);
      setGallery(sessionResult.showStudioWelcome);
      setAuthPassword("");
      setIsAuthChecked(true);
      setStatus(authMode === "register" ? t("Аккаунт создан") : t("Вход выполнен"));
    } catch (error) {
      console.warn("Auth failed", error);
      setStatus(formatChatRequestError(error, t("Ошибка входа")));
    } finally {
      setIsAuthWorking(false);
    }
  };

  const handleLogout = async () => {
    const sessionToken = state.authSession?.sessionToken;
    applyAuthSession(null);
    setGallery(false);

    try {
      if (sessionToken) {
        await logoutAuth(sessionToken);
      }
    } catch {
      // Ignore logout transport failures; local sign-out still matters.
    } finally {
      setAuthPassword("");
      setStatus(t("Выход выполнен"));
      setTab("chats");
    }
  };

  const handlePreferredRedirect = () => {
    if (!recoveredPreferredUrl) {
      return;
    }

    window.location.href = recoveredPreferredUrl;
  };

  const createChat = async (card:CharacterCard | null = selectedCharacter) => {
    const token = state.authSession?.sessionToken;
    if (!token) return;
    saveChatDraft(state.userProfile.id, activeChat?.id, activeChat?.activeLeafId, input);
    const epoch = sessionEpochRef.current;
    try {
      const now = nowIso();
      const chat:Chat = card ? await startCharacterChat(card, token) : {id:createId(),title:t("Новый чат"),characterId:null,messages:[],createdAt:now,updatedAt:now};
      if (sessionEpochRef.current !== epoch) return;
      updateState(current => ({ ...current, activeChatId: chat.id, chats: [chat, ...current.chats] }));
      setTab("chats");
    } catch (error) { if (sessionEpochRef.current === epoch) setStatus(error instanceof Error ? error.message : t("Не удалось создать чат")); }
  };

  const deleteChat = async (chatId: string) => {
    const chat = state.chats.find((item) => item.id === chatId);
    if (!window.confirm(t("Удалить чат «{p0}»?", {p0: chat?.title || t("Без названия")}))) return;
    const sessionToken = state.authSession?.sessionToken;
    if (!sessionToken || hydratedToken !== sessionToken) return;
    const epoch = sessionEpochRef.current;
    for (const generation of generationRef.current.values()) {
      if (generation.chatId === chatId) generation.controller.abort();
    }
    try {
      await deleteServerChat(chatId, sessionToken);
    } catch (error) {
      if (epoch === sessionEpochRef.current) setStatus(formatChatRequestError(error, t("Не удалось удалить чат. Повторите удаление.")));
      return;
    }
    if (epoch !== sessionEpochRef.current) return;
    setEditingMessageId(null);
    setConfirmDeleteMessageId(null);
    updateState((current) => {
      const chats = current.chats.filter((chat) => chat.id !== chatId);
      if (chats.length) {
        return {
          ...current,
          chats,
          activeChatId: current.activeChatId === chatId ? chats[0].id : current.activeChatId
        };
      }
      const createdAt = nowIso();
      const fallback: Chat = {
        id: createId(),
        title: t("Новый чат"),
        characterId: current.characters[0]?.id || null,
        messages: [],
        titleMode: "default",
        pinnedAt: null,
        createdAt,
        updatedAt: createdAt
      };
      return { ...current, chats: [fallback], activeChatId: fallback.id };
    });
  };

  const setChatCharacter = (characterId: string) => {
    if (!activeChat) return;
    updateState((current) => ({
      ...current,
      chats: current.chats.map((chat) =>
        chat.id === activeChat.id ? { ...chat, characterId, updatedAt: nowIso() } : chat
      )
    }));
  };

  const updateAssistantMessage = (chatId: string, messageId: string, content: string) => {
    updateState((current) => ({
      ...current,
      chats: current.chats.map((chat) =>
        chat.id === chatId
          ? {
              ...chat,
              messages: chat.messages.map((message) =>
                message.id === messageId ? { ...message, content } : message
              ),
              updatedAt: nowIso()
            }
          : chat
      )
    }));
  };

  const replaceChat = (chatId: string, nextChat: Chat) => {
    updateState((current) => ({
      ...current,
      chats: current.chats.map((chat) => (chat.id === chatId ? nextChat : chat))
    }));
  };

  const refreshChatFromServer = async (chatId: string, afterRevision?: number) => {
    const epoch = sessionEpochRef.current;
    // An aborted HTTP stream finishes its server-side save after the browser disconnects.
    for (const delay of [0, 80, 160, 320, 640, 1000]) {
      if (delay) await new Promise(resolve => setTimeout(resolve, delay));
      if (epoch !== sessionEpochRef.current) return;
      const chatState = await getChatState(state.authSession?.sessionToken);
      if (epoch !== sessionEpochRef.current) return;
      const chat = chatState.chats.find(item => item.id === chatId);
      if (afterRevision !== undefined && (chat?.revision ?? 0) <= afterRevision) continue;
      if (chat) replaceChat(chatId, chat);
      return chat;
    }
  };

  const requestAutoTitle = async (chat: Chat | undefined) => {
    if (!chat || state.userProfile.autoNameNewChats === false || !["Новый чат", "New chat"].includes(chat.title) || chat.titleMode !== "default" || titleGenerationRef.current.has(chat.id)) return;
    if (!chat.messages.some((message) => message.role === "user" && message.content.trim()) || !chat.messages.some((message) => message.role === "assistant" && message.content.trim())) return;
    titleGenerationRef.current.add(chat.id);
    setTitleGenerationChatId(chat.id);
    try {
      const response = await mutateChatMessage({ chatId: chat.id, action: "generate-title", automatic: true, revision: chat.revision }, state.authSession?.sessionToken);
      replaceChat(chat.id, response.chat);
    } catch (error) {
      console.warn("Automatic chat title failed", error);
    } finally {
      titleGenerationRef.current.delete(chat.id);
      setTitleGenerationChatId((current) => current === chat.id ? null : current);
    }
  };

  const removeMessage = (chatId: string, messageId: string) => {
    updateState((current) => ({
      ...current,
      chats: current.chats.map((chat) =>
        chat.id === chatId
          ? { ...chat, messages: chat.messages.filter((message) => message.id !== messageId), updatedAt: nowIso() }
          : chat
      )
    }));
  };

  const runChatGeneration = async ({
    action,
    targetMessageId,
    chatSnapshot = activeChat
  }: {
    action: "send" | "regenerate" | "continue";
    targetMessageId?: string;
    chatSnapshot?: Chat;
  }) => {
    if (!chatSnapshot || sendingChatIds.has(chatSnapshot.id) || generationRef.current.has(chatSnapshot.id)) return;

    const character = cards.find(item => item.id === chatSnapshot.characterId) || null;
    if (chatSnapshot.characterId && !character) {setStatus(t("Выберите персонажа"));return;}

    let effective;
    try { effective = resolveProfile(state.settings, character, chatSnapshot.modelProfileId); }
    catch (error) { setStatus(error instanceof Error ? error.message : t("Профиль недоступен")); return; }
    if (!effective.modelId.trim()) { setStatus(t("Выберите модель в настройках")); return; }

    const chatId = chatSnapshot.id;
    const requestId = createId();
    const controller = new AbortController();
    const createdAt = nowIso();
    const target = targetMessageId ? chatSnapshot.messages.find((message) => message.id === targetMessageId) : null;
    const userMessageText = action === "send" ? input.trim() || (draftImage ? "Опиши изображение." : "") : "";
    const userMessage = action === "send"
      ? { id: createId(), role: "user" as const, content: userMessageText, image: draftImage, createdAt }
      : null;
    const pendingMessage = action === "continue"
      ? null
      : { id: createId(), role: "assistant" as const, content: "", createdAt, authorCharacterId: character?.id || undefined, authorNameSnapshot: character?.name ?? "AI" };

    if (action === "send" && !userMessageText) {
      setStatus(t("Нельзя отправить пустое сообщение"));
      return;
    }

    if (action === "send" && userMessage && pendingMessage) {
      setInput("");
      scheduleMessagesScroll();
      updateState((current) => ({
        ...current,
        chats: current.chats.map((chat) =>
          chat.id === chatId
            ? {
                ...chat,
                title: chat.title,
                messages: [...chat.messages, userMessage, pendingMessage],
                updatedAt: nowIso()
              }
            : chat
        )
      }));
    } else if (action === "regenerate" && pendingMessage) {
      updateState((current) => ({
        ...current,
        chats: current.chats.map((chat) =>
          chat.id === chatId ? { ...chat, messages: [...chat.messages, pendingMessage], updatedAt: nowIso() } : chat
        )
      }));
      scheduleMessagesScroll();
    }

    generationRef.current.set(chatId, { id: requestId, chatId, controller, action, pendingMessageId: pendingMessage?.id, targetMessageId });
    setSendingChatIds((current) => new Set(current).add(chatId));
    setStatus(action === "continue" ? t("Продолжаю ответ...") : action === "regenerate" ? t("Повторяю ответ...") : t("Ожидаю очередь или ответ локальной модели…"));

    const payload = {
      chatId,
      chatTitle: chatSnapshot.title,
      settings: effective,
      personaSystemPrompt: character ? buildCharacterPrompt(character) : "",
      personaName: character?.name ?? "AI",
      personaCharacterId: character?.id ?? null,
      history: compactMessages(chatSnapshot.messages),
      userMessage: userMessageText,
      image: action === "send" ? draftImage : undefined,
      userMessageId: userMessage?.id,
      userMessageCreatedAt: userMessage?.createdAt,
      assistantMessageId: pendingMessage?.id,
      action,
      targetMessageId,
      revision: chatSnapshot.revision,
      temperature: effective.temperature,
      maxTokens: effective.maxTokens
    };

    const timing = generationTiming();
    let streamedContent = "";
    const applyContent = (content: string) => {
      if (generationRef.current.get(chatId)?.id !== requestId || controller.signal.aborted) return;
      if (action === "continue" && target) {
        updateAssistantMessage(chatId, target.id, mergeAssistantContinuation(target.content, content));
        scheduleMessagesScroll();
        return;
      }
      if (pendingMessage) {
        updateAssistantMessage(chatId, pendingMessage.id, content);
        scheduleMessagesScroll();
      }
    };

    try {
      if (effective.streaming) {
        await streamChat(payload, (delta) => {
          timing.text(delta);
          streamedContent += delta;
          applyContent(streamedContent);
        }, state.userProfile.id, state.authSession?.sessionToken, controller.signal, count => timing.tokens(count));
      } else {
        const response = await sendChat(payload, state.userProfile.id, state.authSession?.sessionToken, controller.signal);
        timing.tokens(response.outputTokens);
        streamedContent = response.content;
        applyContent(streamedContent);
      }

      const timingSummary = timing.finish(effective.streaming);
      if (!controller.signal.aborted) setGenerationStats(current => ({ ...current, [chatId]: timingSummary }));
      if (action === "regenerate" && target && pendingMessage) {
        updateState((current) => ({
          ...current,
          chats: current.chats.map((chat) =>
            chat.id !== chatId
              ? chat
              : {
                  ...chat,
                  messages: target.role === "assistant"
                    ? chat.messages.filter((message) => message.id !== pendingMessage.id).map((message) =>
                        message.id === target.id ? { ...message, content: streamedContent } : message
                      )
                    : chat.messages,
                  updatedAt: nowIso()
                }
          )
        }));
      }
      if (action === "send") saveChatDraft(state.userProfile.id, chatId, chatSnapshot.activeLeafId, "");
      if (action === "send") updateImageDraft(imageDraftKey);
      const refreshedChat = await refreshChatFromServer(chatId);
      if (action === "send") void requestAutoTitle(refreshedChat);
      setStatus(t("Ответ получен. {p0}", {p0: timingSummary}));
    } catch (error) {
      console.warn("Chat generation failed", error);
      const stopped = controller.signal.aborted;
      const hasPartial = effective.streaming && streamedContent.trim().length > 0;
      if (action === "regenerate" && pendingMessage && !hasPartial) removeMessage(chatId, pendingMessage.id);
      if (action === "send" && pendingMessage && !hasPartial) removeMessage(chatId, pendingMessage.id);
      if (stopped) {
        if (!effective.streaming && action === "send" && userMessage) {
          removeMessage(chatId, userMessage.id);
          if (activeChatIdRef.current === chatId) setInput(userMessageText);
          saveChatDraft(state.userProfile.id, chatId, chatSnapshot.activeLeafId, userMessageText);
          await refreshChatFromServer(chatId).catch(() => undefined);
          setStatus(t("Генерация остановлена. Сообщение возвращено в черновик."));
          return;
        }
        if (action === "send") saveChatDraft(state.userProfile.id, chatId, chatSnapshot.activeLeafId, "");
        const saved = await refreshChatFromServer(chatId, chatSnapshot.revision ?? 0).catch(() => undefined);
        const responseId = pendingMessage?.id ?? target?.id;
        const savedPart = hasPartial && saved?.messages.some(message => message.id === responseId && message.content.includes(streamedContent.trim()));
        if (!saved && !hasPartial && userMessage) {
          removeMessage(chatId, userMessage.id);
          if (activeChatIdRef.current === chatId) setInput(userMessageText);
          saveChatDraft(state.userProfile.id, chatId, chatSnapshot.activeLeafId, userMessageText);
        }
        setStatus(savedPart ? t("Ответ остановлен. Часть текста сохранена.") : hasPartial ? t("Ответ был прерван из-за обрыва потока. Часть текста могла сохраниться.") : t("Генерация остановлена"));
      } else if (hasPartial) {
        if (action === "send") saveChatDraft(state.userProfile.id, chatId, chatSnapshot.activeLeafId, "");
        await refreshChatFromServer(chatId).catch(() => undefined);
        setStatus(t("Ответ был прерван. Часть текста сохранена."));
      } else {
        if (action === "send" && userMessage) removeMessage(chatId, userMessage.id);
        if (action === "send" && activeChatIdRef.current === chatId) setInput(userMessageText);
        setStatus(formatChatRequestError(error, "chat"));
      }
    } finally {
      if (generationRef.current.get(chatId)?.id === requestId) generationRef.current.delete(chatId);
      setSendingChatIds((current) => {
        const next = new Set(current);
        next.delete(chatId);
        return next;
      });
    }
  };

  const handleSend = (event: FormEvent) => {
    event.preventDefault();
    void runChatGeneration({ action: "send" });
  };

  const stopGeneration = () => activeChat && generationRef.current.get(activeChat.id)?.controller.abort();

  const selectBranchVariant = async (messageId: string) => {
    if (!activeChat || isSending) return;
    try {
      saveChatDraft(state.userProfile.id, activeChat.id, activeChat.activeLeafId, input);
      const response = await mutateChatMessage(
        { chatId: activeChat.id, action: "switch", messageId, revision: activeChat.revision },
        state.authSession?.sessionToken
      );
      replaceChat(activeChat.id, response.chat);
      setInput(readChatDraft(state.userProfile.id, activeChat.id, response.chat.activeLeafId));
      setStatus(t("Вариант переключён"));
    } catch (error) {
      console.warn("Switch branch failed", error);
      setStatus(t("Не удалось переключить вариант"));
    }
  };

  const branchFromMessage = async (message: ChatMessage) => {
    if (!activeChat || isSending || (message.role === "assistant" && message.id === activeChat.activeLeafId)) return;
    try {
      saveChatDraft(state.userProfile.id, activeChat.id, activeChat.activeLeafId, input);
      const response = await mutateChatMessage(
        { chatId: activeChat.id, action: "branch", messageId: message.id, revision: activeChat.revision },
        state.authSession?.sessionToken
      );
      replaceChat(activeChat.id, response.chat);
      setInput(readChatDraft(state.userProfile.id, activeChat.id, response.chat.activeLeafId));
      if (message.role === "user") {
        await runChatGeneration({ action: "regenerate", targetMessageId: message.id, chatSnapshot: response.chat });
      } else {
        window.setTimeout(() => composerRef.current?.focus(), 0);
        setStatus(t("Новая ветка готова"));
      }
    } catch (error) {
      console.warn("Create branch failed", error);
      setStatus(t("Не удалось создать ветку"));
    }
  };

  const copyMessage = async (message: ChatMessage) => {
    try {
      await navigator.clipboard.writeText(message.content);
      setCopiedMessageId(message.id);
      window.setTimeout(() => setCopiedMessageId((current) => (current === message.id ? null : current)), 1500);
    } catch (error) {
      console.warn("Copy message failed", error);
      setStatus(t("Не удалось скопировать сообщение"));
    }
  };

  const togglePin = async (message: ChatMessage) => {
    if (!activeChat || isSending) return;
    const pinned = activeChat.pinnedMessageIds?.includes(message.id);
    try {
      const response = await mutateChatMessage({ chatId: activeChat.id, action: pinned ? "unpin" : "pin", messageId: message.id, revision: activeChat.revision }, state.authSession?.sessionToken);
      replaceChat(activeChat.id, response.chat);
    } catch (error) { console.warn("Pin mutation failed", error); setStatus(t("Не удалось изменить закрепление")); }
  };

  const exportMarkdown = () => {
    if (!activeChat) return;
    const body = [`# ${activeChat.title}`, ``, `${t("Экспорт:")} ${new Date().toLocaleString(getLocale())}`, ``, ...activeChat.messages.map((message) => `## ${(message.role === "user" ? t("Вы") : resolveMessageAuthorName(message, cards, selectedCharacter, t("Ассистент")))}\n\n${message.content}`)].join("\n\n");
    downloadText(safeDownloadName(activeChat.title, "md"), body, "text/markdown;charset=utf-8"); closeChatPopovers(true);
  };
  const exportJson = () => {
    if (!activeChat) return;
    const backup = { format: CHAT_EXPORT_FORMAT, version: CHAT_EXPORT_VERSION, exportedAt: new Date().toISOString(), chat: { id: activeChat.id, archivedAt: activeChat.archivedAt || null, tags: activeChat.tags || [], title: activeChat.title, titleMode: activeChat.titleMode || "default", pinnedAt: activeChat.pinnedAt || null, characterId: activeChat.characterId, messages: activeChat.allMessages || activeChat.messages, activeLeafId: activeChat.activeLeafId || null, schemaVersion: 2, pinnedMessageIds: activeChat.pinnedMessageIds || [], createdAt: activeChat.createdAt, updatedAt: activeChat.updatedAt } };
    downloadText(safeDownloadName(activeChat.title, "json"), JSON.stringify(backup, null, 2), "application/json;charset=utf-8"); closeChatPopovers(true);
  };
  const importChat = async (file: File) => {
    if (file.size > MAX_CHAT_IMPORT_BYTES) { setStatus(t("Резервная копия чата должна быть не больше 50 МБ")); return; }
    try {
      const parsed = JSON.parse(await file.text());
      validateImportedChat(parsed);
      const response = await mutateChatMessage({ action: "import", importedChat: parsed }, state.authSession?.sessionToken);
      updateState((current) => ({ ...current, chats: [...current.chats, response.chat], activeChatId: response.chat.id }));
      setTab("chats"); setStatus(t("Чат импортирован"));
    } catch (error) { console.warn("Chat import failed", error); setStatus(error instanceof Error ? error.message : t("Не удалось импортировать чат")); }
  };

  const toggleChatPopover = (popover: "search" | "pins" | "export", anchor: HTMLElement) => {
    const isOpen = popover === "search" ? searchOpen : popover === "pins" ? pinsOpen : exportOpen;
    if (!isOpen) {
      chatPopoverTriggerRef.current = anchor;
      const rect = anchor.getBoundingClientRect();
      const gap = 8;
      const popoverWidth = Math.min(360, window.innerWidth - 24);
      const left = Math.max(12, Math.min(rect.left, window.innerWidth - popoverWidth - 12));
      const shouldOpenAbove = window.innerHeight - rect.bottom < 220 && rect.top > window.innerHeight - rect.bottom;
      setChatPopoverPosition(
        shouldOpenAbove
          ? { bottom: Math.max(12, window.innerHeight - rect.top + gap), left }
          : { top: Math.max(12, rect.bottom + gap), left }
      );
    }
    if (popover === "search") {
      setSearchOpen(!isOpen);
      setPinsOpen(false);
      setExportOpen(false);
    } else if (popover === "pins") {
      setSearchOpen(false);
      setPinsOpen(!isOpen);
      setExportOpen(false);
    } else {
      setSearchOpen(false);
      setPinsOpen(false);
      setExportOpen(!isOpen);
    }
  };

  const toggleChatMenu = (chatId: string, anchor: HTMLElement) => {
    if (openChatMenuId === chatId) {
      setOpenChatMenuId(null);
      return;
    }
    const rect = anchor.getBoundingClientRect();
    chatMenuTriggerRef.current = anchor as HTMLButtonElement;
    const width = Math.min(240, window.innerWidth - 24);
    setChatMenuPosition({
      top: Math.max(12, Math.min(rect.bottom + 6, window.innerHeight - 240)),
      left: Math.max(12, Math.min(rect.right - width, window.innerWidth - width - 12))
    });
    setOpenChatMenuId(chatId);
    setSearchOpen(false);
    setPinsOpen(false);
    setExportOpen(false);
  };

  const renameChat = async () => {
    const chat = state.chats.find((item) => item.id === renameChatId);
    const title = renameTitle.replace(/[\u0000-\u001f\u007f]/g, "").replace(/\s+/g, " ").trim().slice(0, 80);
    if (!chat || !title) {
      setStatus(t("Название не может быть пустым"));
      return;
    }
    try {
      const response = await mutateChatMessage({ chatId: chat.id, action: "rename", title, characterId: chat.characterId, revision: chat.revision }, state.authSession?.sessionToken);
      replaceChat(chat.id, response.chat);
      setRenameChatId(null);
      setStatus(t("Название сохранено"));
    } catch (error) {
      console.warn("Chat rename failed", error);
      setStatus(t("Не удалось переименовать чат"));
    }
  };

  const organizeChat = async (chat: Chat, patch: { archived?: boolean; tags?: string[] }) => {
    const epoch = sessionEpochRef.current;
    const response = await mutateChatMessage({ chatId: chat.id, characterId: chat.characterId, action: "organize", revision: chat.revision, ...patch }, state.authSession?.sessionToken);
    if (sessionEpochRef.current !== epoch) return;
    replaceChat(chat.id, response.chat);
    setOpenChatMenuId(null);
    setStatus(patch.archived === true ? t("Чат помещён в архив") : patch.archived === false ? t("Чат восстановлен из архива") : t("Теги сохранены"));
  };

  const toggleChatPin = async (chat: Chat) => {
    try {
      const response = await mutateChatMessage({ chatId: chat.id, action: chat.pinnedAt ? "unpin-chat" : "pin-chat", revision: chat.revision }, state.authSession?.sessionToken);
      replaceChat(chat.id, response.chat);
      setOpenChatMenuId(null);
    } catch (error) {
      console.warn("Chat pin mutation failed", error);
      setStatus(t("Не удалось изменить закрепление чата"));
    }
  };

  const generateChatTitle = async (chat: Chat) => {
    if (titleGenerationRef.current.has(chat.id)) return;
    setTitleGenerationChatId(chat.id);
    titleGenerationRef.current.add(chat.id);
    try {
      const response = await mutateChatMessage({ chatId: chat.id, action: "generate-title", revision: chat.revision }, state.authSession?.sessionToken);
      replaceChat(chat.id, response.chat);
      setStatus(t("Название обновлено"));
      setOpenChatMenuId(null);
    } catch (error) {
      console.warn("Chat title generation failed", error);
      setStatus(error instanceof Error ? error.message : t("Не удалось создать название"));
    } finally {
      titleGenerationRef.current.delete(chat.id);
      setTitleGenerationChatId((current) => current === chat.id ? null : current);
    }
  };

  const deleteMessage = async (messageId: string) => {
    if (!activeChat || isSending) return;
    try {
      const response = await mutateChatMessage({ chatId: activeChat.id, action: "delete", messageId, revision: activeChat.revision }, state.authSession?.sessionToken);
      replaceChat(activeChat.id, response.chat);
      setConfirmDeleteMessageId(null);
      setStatus(t("Сообщение удалено"));
    } catch (error) {
      console.warn("Delete message failed", error);
      setStatus(t("Не удалось удалить сообщение"));
    }
  };

  const saveMessageEdit = async () => {
    if (!activeChat || !editingMessageId || isSending) return;
    try {
      const response = await mutateChatMessage(
        { chatId: activeChat.id, action: "edit", messageId: editingMessageId, content: editingMessageText, revision: activeChat.revision },
        state.authSession?.sessionToken
      );
      const editedMessageId = response.chat.activeLeafId || editingMessageId;
      replaceChat(activeChat.id, response.chat);
      setEditingMessageId(null);
      await runChatGeneration({ action: "regenerate", targetMessageId: editedMessageId, chatSnapshot: response.chat });
    } catch (error) {
      console.warn("Edit message failed", error);
      setStatus(t("Не удалось сохранить сообщение"));
    }
  };

  const handleComposerChange = (value: string) => {
    setInput(value);
    saveChatDraft(state.userProfile.id, activeChat?.id, activeChat?.activeLeafId, value);
  };

  const handleCheckConnection = async () => {
    try {
      if (state.authSession?.userId === "u_admin") await saveServerSettings(state.settings, state.authSession.sessionToken);
      const loadedModels = await loadModels(state.settings.baseUrl, state.authSession?.sessionToken);
      setRegistry({url:state.settings.baseUrl, models:loadedModels});
      setStatus(t("Соединение работает, моделей: {p0}", {p0: loadedModels.length}));
    } catch (error) {
      setRegistry({url:"", models:[]});
      console.warn("Connection check failed", error);
      setStatus(formatChatRequestError(error, t("Не удалось подключиться")));
    }
  };

  const handleLoadModels = async () => {
    try {
      const loadedModels = await loadModels(state.settings.baseUrl, state.authSession?.sessionToken);
      setRegistry({url:state.settings.baseUrl, models:loadedModels});
      setStatus(t("Загружено моделей: {p0}", {p0: loadedModels.length}));
    } catch (error) {
      setRegistry({url:"", models:[]});
      console.warn("Model load failed", error);
      setStatus(formatChatRequestError(error, t("Не удалось загрузить модели")));
    }
  };

  const canLeaveCharacterDraft = () =>
    !isCharacterDraftDirty || window.confirm(t("Отменить несохранённые изменения карточки?"));

  const startEditCharacter = (character: CharacterCard) => {
    if (editingCharacterId === character.id && !isCreatingCharacter) return;
    if (!canLeaveCharacterDraft()) return;
    setEditingCharacterId(character.id);
    setIsCreatingCharacter(false);
    const draft = { ...character, tags: [...character.tags] };
    setCharacterDraft(draft);
    setCharacterDraftBaseline(characterDraftSignature(draft));
  };

  const startCreateCharacter = () => {
    if (!canLeaveCharacterDraft()) return;
    const draft = emptyCharacterDraft();
    setEditingCharacterId(null);
    setIsCreatingCharacter(true);
    setCharacterDraft(draft);
    setCharacterDraftBaseline(characterDraftSignature(draft));
  };

  const importCharacterFile = async (file: File) => {
    if (!canLeaveCharacterDraft()) return;
    const epoch = sessionEpochRef.current;
    try {
      if (file.size > MAX_CHARACTER_BYTES) throw new Error(t("Карточка превышает 256 КБ."));
      const imported = importCharacterCard(JSON.parse(await file.text()));
      if (sessionEpochRef.current !== epoch) return;
      const draft = { ...imported, id: createId(), createdAt: nowIso(), updatedAt: nowIso() };
      setCharacterDraft(draft); setEditingCharacterId(null); setIsCreatingCharacter(true); setCharacterDraftBaseline("");
      setStatus(t("Карточка загружена в черновик. Проверьте её и нажмите Сохранить."));
    } catch (error) { if (sessionEpochRef.current === epoch) setStatus(error instanceof Error ? error.message : t("Не удалось импортировать карточку")); }
  };

  const closeCharacterEditor = () => {
    if (!canLeaveCharacterDraft()) return;
    setEditingCharacterId(null);
    setIsCreatingCharacter(false);
    setCharacterDraft(emptyCharacterDraft());
    setCharacterDraftBaseline("");
  };

  const saveCharacter = () => {
    const cleanDraft = {
      ...characterDraft,
      name: characterDraft.name.trim() || t("Без имени"),
      posterUrl: characterDraft.posterUrl?.trim() || undefined,
      tags: characterDraft.tags.map((tag) => tag.trim()).filter(Boolean),
      updatedAt: nowIso()
    };

    try { validateCharacterCard(cleanDraft); } catch (error) { setStatus(error instanceof Error ? error.message : t("Некорректная карточка")); return; }
    updateState((current) => {
      const exists = current.characters.some((character) => character.id === editingCharacterId);
      const characters = exists
        ? current.characters.map((character) => (character.id === editingCharacterId ? cleanDraft : character))
        : [cleanDraft, ...current.characters];
      return { ...current, characters };
    });
    setEditingCharacterId(null);
    setIsCreatingCharacter(false);
    setCharacterDraft(emptyCharacterDraft());
    setCharacterDraftBaseline("");
    setStatus(t("Карточка сохранена"));
  };

  const deleteCharacter = (characterId: string) => {
    if (editingCharacterId === characterId && !canLeaveCharacterDraft()) return;
    const character = state.characters.find((item) => item.id === characterId);
    if (!window.confirm(t("Удалить персонажа «{p0}»?", {p0: character?.name || t("Без имени")}))) return;
    updateState((current) => ({
      ...current,
      characters: current.characters.filter((character) => character.id !== characterId),
      chats: current.chats.map((chat) => ({
        ...chat,
        characterId: chat.characterId === characterId ? null : chat.characterId
      })),
      groupChats: current.groupChats.map((groupChat) => ({
        ...groupChat,
        participantIds: groupChat.participantIds.filter((participantId) => participantId !== characterId),
        activeSpeakerCharacterId:
          groupChat.activeSpeakerCharacterId === characterId ? null : groupChat.activeSpeakerCharacterId
      }))
    }));
    if (editingCharacterId === characterId) {
      setEditingCharacterId(null);
      setIsCreatingCharacter(false);
      setCharacterDraft(emptyCharacterDraft());
      setCharacterDraftBaseline("");
    }
  };

  const duplicateCharacter = (character: CharacterCard) => {
    const createdAt = nowIso();
    const copy: CharacterCard = {
      ...character,
      tags: [...character.tags],
      id: createId(),
      name: t("{p0} копия", {p0: character.name}),
      createdAt,
      updatedAt: createdAt
    };
    updateState((current) => ({ ...current, characters: [copy, ...current.characters] }));
    startEditCharacter(copy);
  };

  if (!isAuthChecked) {
    return (
      <main className={`${styles.authShell} ${themeClassName}`} style={shellStyle}>
        <section className={styles.authCard}>
          <h1 className="studio-brand"><img src="/studio/mark.svg" alt=""/>Local AI Chat</h1>
          <p>{t("Проверяю сохранённую сессию...")}</p>
        </section>
      </main>
    );
  }

  if (!state.authSession) {
    return (
      <main className={`${styles.authShell} ${themeClassName}`} style={shellStyle}>
        <section className={styles.authCard}>
          <div className={styles.authMeta}>
            <LanguageSelector />
            <h1 className="studio-brand"><img src="/studio/mark.svg" alt=""/>Local AI Chat</h1>
            <p>{t("Войдите, чтобы продолжить с тем же пользователем на всех устройствах.")}</p>
          </div>

          <div className={styles.authToggle} role="tablist" aria-label={t("Режим авторизации")}>
            <button
              ref={backgroundDisplayTriggerRef}
              type="button"
              className={authMode === "login" ? styles.activeTab : ""}
              onClick={() => setAuthMode("login")}
            >{t("Войти")}{" "}</button>
            <button
              type="button"
              className={authMode === "register" ? styles.activeTab : ""}
              onClick={() => setAuthMode("register")}
            >{t("Регистрация")}{" "}</button>
          </div>

          <form className={styles.formPanel} onSubmit={handleAuthSubmit}>
            <label>{t("Имя пользователя")}{" "}<input
                value={authUsername}
                onChange={(event) => setAuthUsername(event.target.value)}
                autoComplete="username"
                placeholder={t("имя-пользователя")}
              />
            </label>
            <label>{t("Пароль")}{" "}<input
                type="password"
                value={authPassword}
                onChange={(event) => setAuthPassword(event.target.value)}
                autoComplete={authMode === "login" ? "current-password" : "new-password"}
                placeholder={t("пароль")}
              />
            </label>
            <button className={styles.primaryButton} disabled={isAuthWorking}>
              {isAuthWorking ? t("Подождите...") : authMode === "login" ? t("Войти") : t("Создать аккаунт")}
            </button>
          </form>

          <p className={styles.status}>{localizeMessage(status)}</p>
        </section>
      </main>
    );
  }

  if (hydratedToken !== state.authSession.sessionToken) {
    return (
      <main className={`${styles.authShell} ${themeClassName}`} style={shellStyle}>
        <section className={styles.authCard}>
          <h1>{t("Данные пока не загружены")}</h1>
          <p role="status">{localizeMessage(status)}</p>
          <button className={styles.primaryButton} onClick={() => setHydrationAttempt((value) => value + 1)}>{t("Повторить загрузку")}</button>
          <button className={styles.secondaryButton} onClick={handleLogout}>{t("Выйти")}</button>
        </section>
      </main>
    );
  }

  const reloadWorkspace = () => {
    if (!window.confirm(t("Загрузить серверную версию? Текущие локальные данные будут скачаны отдельным файлом для восстановления."))) return;
    // Exclude authentication and server credentials from the recovery download.
    downloadText(safeDownloadName("local-workspace-draft", "json"), JSON.stringify({
      userProfile: state.userProfile, characters: state.characters, chats: state.chats,
      groupChats: state.groupChats, characterDraft, input, editingMessageText,
      workspaceRevision: state.workspaceRevision
    }, null, 2), "application/json");
    setHydrationAttempt((value) => value + 1);
  };

  return (
    <main className={`${styles.shell} ${themeClassName}`} style={shellStyle} data-tab={tab} data-panel={mobilePanel} data-gallery={gallery}>
      {isOnTemporaryMirror && recoveredPreferredUrl && (
        <section className={styles.routeBanner}>
          <div className={styles.routeBannerCopy}>
            <strong>{t("Основной адрес снова работает")}</strong>
            <span>{recoveredPreferredUrl}</span>
            <small>
              {redirectCountdownSec == null
                ? t("Можно перейти уже сейчас.")
                : t("Автопереход через {p0} сек.", {p0: redirectCountdownSec})}
            </small>
          </div>
          <button type="button" className={styles.routeBannerButton} onClick={handlePreferredRedirect}>{t("Перейти сейчас")}{" "}</button>
        </section>
      )}
            <header className={styles.topbar}>
        <div className={styles.topbarPrimary}>
          <div className={styles.controlBridgeMeta}>
            <h1 className="studio-brand"><img src="/studio/mark.svg" alt=""/>Local AI Chat</h1>
            <p>{t("ID пользователя:")}{" "}<code>{state.userProfile.id}</code></p>
            <p>{t("Локальный мост для приватной сессии")}</p>
          </div>
          <div className={styles.topbarSystem}>
            <div className={styles.statusChipRow}>
              <span className={styles.statusChip}>{t("локальный")}</span>
              <span className={styles.statusChip}>{t("серверное хранение")}</span>
              <span className={`${styles.statusChip} ${styles.statusChipViolet}`}>LM Studio bridge</span>
              {hasModelId && (
                <span className={`${styles.statusChip} ${styles.statusChipMuted}`} title={state.settings.modelId}>
                  {compactModelId(state.settings.modelId)}
                </span>
              )}
            </div>
          </div>
          <div className={styles.topbarActions}>
            <button
              type="button"
              className={`${styles.secondaryButton} ${styles.backgroundDisplayTrigger}`}
              onClick={() => updateBackgroundDisplayOpen(!isBackgroundDisplayOpen)}
              disabled={!backgroundArtworks.length}
              aria-pressed={isBackgroundDisplayOpen}
              aria-expanded={isBackgroundDisplayOpen}
              aria-controls="background-display"
              title={isBackgroundDisplayOpen ? t("Закрыть арт-окно") : t("Открыть арт-окно")}
            >
              <span aria-hidden="true">🖼</span>{t("Фон")}{" "}</button>
            <div className={styles.topbarStatusChip} title={localizeMessage(status)}>
              {localizeMessage(status)}
            </div>
            <button type="button" className={styles.secondaryButton} onClick={handleLogout}>{t("Выйти")}{" "}</button>
          </div>
        </div>
        <button className="studio-nav-toggle" type="button" aria-expanded={navigationOpen} aria-controls="workspace-sections" onClick={() => setNavigationOpen(!navigationOpen)}>{t("Разделы")} {navigationOpen ? "−" : "+"}</button>
        <nav id="workspace-sections" data-open={navigationOpen} className={styles.tabs} aria-label={t("Разделы")}>
          <button className={tab === "chats" ? styles.activeTab : ""} onClick={() => openSection("chats")}>
            {t("Чаты")}
          </button>
          <button className={tab === "group" ? styles.activeTab : ""} onClick={() => openSection("group")}>{t("Групповой чат")}{" "}</button>
          <button className={tab === "memory" ? styles.activeTab : ""} onClick={() => openSection("memory")}>{t("Память")}{" "}</button>
          <button className={tab === "settings" ? styles.activeTab : ""} onClick={() => openSection("settings")}>
            {t("Настройки")}
          </button>
          <button className={tab === "characters" ? styles.activeTab : ""} onClick={() => openSection("characters")}>
            {t("Карточки персонажей")}
          </button>
        </nav>
        <div className={styles.statusChipRow}>
            <span role="status" aria-live="polite">
              {workspaceSaveStatus === "conflict" ? t("Конфликт: данные изменены в другой вкладке. Автосохранение остановлено.")
                : workspaceSaveStatus === "error" ? t("Не сохранено. Повторите сохранение.")
                : workspaceSaveStatus === "saving" ? t("Сохранение…") : t("Сохранено")}
            </span>
            {workspaceSaveStatus === "error" && <button className={styles.secondaryButton} onClick={() => syncQueueRef.current?.retry()}>{t("Повторить сохранение")}</button>}
            {workspaceSaveStatus === "conflict" && <button className={styles.secondaryButton} onClick={reloadWorkspace}>{t("Загрузить серверную версию")}</button>}
        </div>
      </header>

      {gallery && <StudioGallery ready={!!state.settings.modelId} start={card=>{setGallery(false);void createChat(card);}} close={()=>{setGallery(false);void createChat(null);}} settings={()=>{setGallery(false);setTab("settings");}} copy={card=>{duplicateCharacter(card);setGallery(false);setTab("characters");}}/>}
      <div key={tab} hidden={gallery} className={styles.tabTransition}>
        {tab === "chats" && (
        <section className={styles.pageStack}>
          <div className={`${styles.visualPanel} ${styles.pageHero}`}>
            <h2>{t("Одиночная сцена")}</h2>
            <p>{t("Выберите персонажа и начните локальный диалог в едином тёмном интерфейсе.")}</p>
            <div className={styles.statusChipRow}>
              <span className={styles.statusChip}>{t("сессии")}</span>
              <span className={styles.statusChip}>{t("одиночный чат")}</span>
              <span className={styles.statusChip}>{t("персонаж")}</span>
            </div>
          </div>

        <div className="studio-mobile-tabs"><button aria-expanded={mobilePanel==="list"} onClick={()=>setMobilePanel(mobilePanel==="list"?null:"list")}>{ru?"Список чатов":"Chat list"}</button><button aria-expanded={mobilePanel==="portrait"} onClick={()=>setMobilePanel(mobilePanel==="portrait"?null:"portrait")}>{ru?"Портрет":"Portrait"}</button></div>
        <section className={styles.chatGrid}>
          <aside className={`${styles.sidebar} ${styles.sidebarLeft}`}>
            <div className={styles.sidebarIntro}>
              <h3>{t("Чаты")}</h3>
              <p>{t("Сессии и быстрый доступ.")}</p>
            </div>
            <button className={`${styles.primaryButton} ${styles.newChatAction}`} onClick={()=>{setMobilePanel(null);void createChat(null);}}>{t("+ Новый чат")}{" "}</button>
            <ChatListFilters value={chatFilters} onChange={setChatFilters} characters={cards} chats={state.chats} count={sortedChats.length} />
            <div className={styles.list} role="region" aria-label={t("Список чатов")} tabIndex={0}>
              {!sortedChats.length && <p>{t("Нет чатов по выбранным фильтрам.")}</p>}
              {sortedChats.map((chat) => (
                <div
                  key={chat.id}
                  className={`${styles.chatRow} ${chat.id === activeChat?.id ? styles.selectedRow : ""}`}
                >
                  <button
                    type="button"
                    className={styles.chatRowMain}
                    onClick={() => {
                      saveChatDraft(state.userProfile.id, activeChat?.id, activeChat?.activeLeafId, input);
                      setMobilePanel(null);updateState((current) => ({ ...current, activeChatId: chat.id }));
                    }}
                  >
                    <StudioAvatar card={cards.find(card=>card.id===chat.characterId)} neutral={!!chat.characterId}/><span>{chat.archivedAt ? "▣ " : ""}{chat.pinnedAt ? "📌 " : ""}{chat.title}</span>
                  </button>
                  <small>{pluralCount("messages", chat.messages.length)}</small>
                  <button type="button" className={styles.chatRowMenuButton} aria-label={t("Действия чата {p0}", {p0: chat.title})} onClick={(event) => toggleChatMenu(chat.id, event.currentTarget)}>…</button>
                </div>
              ))}
            </div>
            {openChatMenuId && chatMenuPosition && createPortal(
              <div ref={chatMenuRef} className={`${styles.chatPopover} ${styles.popoverTheme} ${themeClassName} ${styles.chatActionMenu}`} style={chatMenuPosition} role="menu">
                {(() => {
                  const chat = state.chats.find((item) => item.id === openChatMenuId);
                  if (!chat) return null;
                  const hasTitleSource = chat.messages.some((message) => message.role === "user" && message.content.trim()) && chat.messages.some((message) => message.role === "assistant" && message.content.trim());
                  return <>
                    <button type="button" className={styles.popoverAction} onClick={() => { setRenameChatId(chat.id); setRenameTitle(chat.title); setOpenChatMenuId(null); }}><strong>{t("Переименовать")}</strong></button>
                    <button type="button" className={styles.popoverAction} onClick={() => void toggleChatPin(chat)}><strong>{chat.pinnedAt ? t("Открепить чат") : t("Закрепить чат")}</strong></button>
                    <button type="button" className={styles.popoverAction} disabled={titleGenerationChatId === chat.id || !hasTitleSource} onClick={() => void generateChatTitle(chat)}><strong>{titleGenerationChatId === chat.id ? t("Создаю название…") : t("Создать название")}</strong><span>{hasTitleSource ? t("По первым сообщениям") : t("Нужен полный ответ модели")}</span></button>
                    <button type="button" className={styles.popoverAction} disabled={sendingChatIds.has(chat.id)} onClick={() => void organizeChat(chat, { archived: !chat.archivedAt }).catch(error => setStatus(error instanceof Error ? error.message : t("Не удалось изменить архив")))}><strong>{chat.archivedAt ? t("Вернуть из архива") : t("В архив")}</strong></button>
                    <button type="button" className={styles.popoverAction} onClick={() => { setOpenChatMenuId(null); deleteChat(chat.id); }}><strong>{t("Удалить чат")}</strong></button>
                  </>;
                })()}
              </div>, document.body
            )}
            {renameChatId && createPortal(
              <form className={`${styles.chatRenameDialog} ${styles.popoverTheme} ${themeClassName}`} onSubmit={(event) => { event.preventDefault(); void renameChat(); }}>
                <strong>{t("Название чата")}</strong>
                <input autoFocus value={renameTitle} maxLength={80} onChange={(event) => setRenameTitle(event.target.value)} aria-label={t("Название чата")} />
                <div className={styles.actions}>
                  <button type="submit" className={styles.primaryButton}>{t("Сохранить")}</button>
                  <button type="button" className={styles.secondaryButton} onClick={() => setRenameChatId(null)}>{t("Отмена")}</button>
                </div>
              </form>, document.body
            )}
          </aside>

          <section className={styles.chatPanel}>
            <div className={styles.chatHeader}>
              <div>
                <h2>{selectedCharacter?.name || activeChat?.title || t("Чат")}</h2>
                <p>{selectedCharacter ? activeChat?.title : (ru?"Разговор с AI":"AI conversation")} · {isModelListed(activeModel)?(ru?"Модель доступна":"Model available"):(ru?"Связь не подтверждена":"Connection unverified")}</p>
              </div>
              <div className={styles.chatTools} ref={chatToolsRef}>
                <div className={styles.chatHeaderActions}>
                  <button ref={searchTriggerRef} type="button" className={styles.secondaryButton} aria-expanded={searchOpen} onClick={(event) => toggleChatPopover("search", event.currentTarget)}>{t("Поиск")}</button>
                  <button type="button" className={styles.secondaryButton} aria-expanded={pinsOpen} onClick={(event) => toggleChatPopover("pins", event.currentTarget)}>{t("Закрепления (")}{visiblePins.length})</button>
                  <button type="button" className={styles.secondaryButton} aria-expanded={exportOpen} onClick={(event) => toggleChatPopover("export", event.currentTarget)}>{t("Экспорт")}</button>
                    <label
                      className={styles.secondaryButton}
                      htmlFor="chat-import-input"
                      onClick={() => {
                        setSearchOpen(false);
                        setPinsOpen(false);
                        setExportOpen(false);
                      }}
                    >{t("Импорт")}{" "}</label>
                  <input id="chat-import-input" type="file" accept="application/json,.json" hidden onChange={(event) => { const file = event.target.files?.[0]; if (file) void importChat(file); event.currentTarget.value = ""; }} />
                  <div className={styles.modelPill}>{activeModel ? compactModelId(activeModel.modelId) : t("Профиль недоступен")}</div>
                </div>
                {searchOpen && chatPopoverPosition && createPortal(<div ref={chatPopoverRef} className={`${styles.chatPopover} ${styles.popoverTheme} ${themeClassName} ${styles.searchPopover}`} style={chatPopoverPosition}>
                  <input autoFocus value={searchQuery} placeholder={t("Поиск по активной ветке")} aria-label={t("Поиск по сообщениям")} onChange={(event) => setSearchQuery(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); setSearchIndex((value) => searchMatches.length ? (value + (event.shiftKey ? -1 : 1) + searchMatches.length) % searchMatches.length : 0); } }} />
                  <button type="button" onClick={() => setSearchIndex((value) => searchMatches.length ? (value - 1 + searchMatches.length) % searchMatches.length : 0)} aria-label={t("Предыдущее совпадение")}>↑</button>
                  <span>{searchMatches.length ? `${(searchIndex % searchMatches.length) + 1} / ${searchMatches.length}` : "0 / 0"}</span>
                  <button type="button" onClick={() => setSearchIndex((value) => searchMatches.length ? (value + 1) % searchMatches.length : 0)} aria-label={t("Следующее совпадение")}>↓</button>
                </div>, document.body)}
                {exportOpen && chatPopoverPosition && createPortal(<div ref={chatPopoverRef} className={`${styles.chatPopover} ${styles.popoverTheme} ${themeClassName} ${styles.exportPopover}`} style={chatPopoverPosition} role="menu">
                  <button type="button" className={styles.popoverAction} onClick={exportMarkdown}>
                    <strong>{t("Экспорт Markdown")}</strong>
                    <span>{t("Только активная ветка")}</span>
                  </button>
                  <button type="button" className={styles.popoverAction} onClick={exportJson}>
                    <strong>{t("Резервная копия JSON")}</strong>
                    <span>{t("Полный граф и закрепления")}</span>
                  </button>
                </div>, document.body)}
                {pinsOpen && chatPopoverPosition && createPortal(<div ref={chatPopoverRef} className={`${styles.chatPopover} ${styles.popoverTheme} ${themeClassName} ${styles.pinnedList}`} style={chatPopoverPosition}>
                  {visiblePins.length ? visiblePins.map((message) => <div key={message.id} className={styles.pinRow}>
                    <button type="button" className={styles.pinJump} onClick={() => { messageRefs.current[message.id]?.scrollIntoView({ block: "center", behavior: "smooth" }); closeChatPopovers(true); }}>
                      <strong className={styles.messageSpeaker}>{message.role === "assistant" && <StudioAvatar card={message.authorCharacterId ? cards.find(card=>card.id===message.authorCharacterId) : selectedCharacter} neutral={!!message.authorCharacterId}/>} {message.role === "user" ? t("Вы") : resolveMessageAuthorName(message, cards, selectedCharacter, t("Ассистент"))}</strong>
                      <span>{message.content.slice(0, 140)}</span>
                    </button>
                    <button type="button" className={styles.pinUnpin} onClick={() => void togglePin(message)}>{t("Открепить")}</button>
                  </div>) : <span className={styles.popoverEmpty}>{t("В текущей ветке нет закреплений.")}</span>}
                </div>, document.body)}
              </div>
            </div>

            <div
              className={styles.messages}
              ref={messagesRef}
              role="region"
              aria-label={t("История сообщений")}
              tabIndex={0}
              onScroll={(event) => {
                const nearBottom = isNearScrollEnd(event.currentTarget);
                followMessagesRef.current = nearBottom;
                setShowNewMessages((current) => shouldShowNewMessages(current, nearBottom, Boolean(isSending)));
              }}
            >
              {activeChat && generationStats[activeChat.id] && <details><summary>{t("Показатели последнего запроса")}</summary><p>{generationStats[activeChat.id]}</p></details>}
              {activeChat && <ChatOrganizationControls key={`organization:${state.authSession!.sessionToken}:${activeChat.id}`} chat={activeChat} disabled={isSending} onChange={patch => organizeChat(activeChat, patch)} />}
              {activeChat && <MemoryControls key={activeChat.id} kind="chat" id={activeChat.id} sessionToken={state.authSession!.sessionToken} disabled={isSending} />}
              {activeChat && <ChatProfile key={`${state.authSession!.sessionToken}:${activeChat.id}`} chat={activeChat} character={selectedCharacter || null} settings={state.settings} disabled={isSending} onChange={async modelProfileId => {
                const epoch = sessionEpochRef.current;
                const result = await mutateChatMessage({ chatId: activeChat.id, action: "set-profile", modelProfileId, characterId: activeChat.characterId, revision: activeChat.revision }, state.authSession!.sessionToken);
                if (sessionEpochRef.current === epoch) replaceChat(activeChat.id, result.chat);
              }} />}
              {activeChat?.messages.length ? (
                activeChat.messages.map((message) => {
                  const isLastUser = message.id === lastUserMessage?.id;
                  const isLastAssistant = message.id === lastAssistantMessage?.id;
                  const isEditing = editingMessageId === message.id;
                  const isDeleteConfirming = confirmDeleteMessageId === message.id;
                  const siblingIds = activeChat.branches?.[message.parentId || "root"] || [];
                  const siblingIndex = siblingIds.indexOf(message.id);
                  return (
                    <article id={`message-${message.id}`} ref={(element) => { messageRefs.current[message.id] = element; }} key={message.id} className={`${styles.message} ${styles[message.role]} ${searchMatches.includes(message) ? styles.searchMatch : ""} ${searchMatches[searchIndex % (searchMatches.length || 1)]?.id === message.id ? styles.searchMatchActive : ""}`}>
                      <strong className={styles.messageSpeaker}>{message.role === "assistant" && <StudioAvatar card={message.authorCharacterId ? cards.find(card=>card.id===message.authorCharacterId) : selectedCharacter} neutral={!!message.authorCharacterId}/>} {message.role === "user" ? t("Вы") : resolveMessageAuthorName(message, cards, selectedCharacter, t("Ассистент"))}</strong>
                      {isEditing ? (
                        <div className={styles.messageEditor}>
                          <textarea
                            value={editingMessageText}
                            onChange={(event) => setEditingMessageText(event.target.value)}
                            aria-label={t("Редактировать сообщение")}
                            rows={3}
                            autoFocus
                          />
                          <div className={styles.messageEditorActions}>
                            <button type="button" className={styles.primaryButton} onClick={() => void saveMessageEdit()}>{t("Сохранить и повторить ответ")}{" "}</button>
                            <button type="button" className={styles.secondaryButton} onClick={() => setEditingMessageId(null)}>{t("Отмена")}{" "}</button>
                          </div>
                        </div>
                      ) : (
                        <MessageBody text={message.content || "…"}/>
                      )}
                      {message.image && <ChatImageView image={message.image} />}
                      {siblingIds.length > 1 && siblingIndex >= 0 && (
                        <div className={styles.branchNavigator} aria-label={t("Варианты продолжения")}>
                          <button
                            type="button"
                            aria-label={t("Предыдущий вариант")}
                            disabled={isSending || siblingIndex === 0}
                            onClick={() => void selectBranchVariant(siblingIds[siblingIndex - 1]!)}
                          >
                            ‹
                          </button>
                          <span>{siblingIndex + 1} / {siblingIds.length}</span>
                          <button
                            type="button"
                            aria-label={t("Следующий вариант")}
                            disabled={isSending || siblingIndex === siblingIds.length - 1}
                            onClick={() => void selectBranchVariant(siblingIds[siblingIndex + 1]!)}
                          >
                            ›
                          </button>
                        </div>
                      )}
                      <MessageTools compact={themeMode === "studio"}>
                      {message.contextReport && <ContextDetails report={message.contextReport} sessionToken={state.authSession!.sessionToken} />}
                      <MemoryControls kind="chat" id={activeChat.id} sessionToken={state.authSession!.sessionToken} messageId={message.id} messageText={message.content} disabled={isSending} />
                      {!isEditing && (
                        <div className={styles.messageActions} aria-label={t("Действия с сообщением")}>
                          <button type="button" className={styles.messageActionButton} onClick={() => void copyMessage(message)}>
                            {copiedMessageId === message.id ? t("Скопировано") : t("Копировать")}
                          </button>
                          <button type="button" className={styles.messageActionButton} onClick={() => void togglePin(message)}>{activeChat.pinnedMessageIds?.includes(message.id) ? t("Открепить") : t("Закрепить")}</button>
                          {!isSending && !(message.role === "assistant" && message.id === activeChat.activeLeafId) && (
                            <button type="button" className={styles.messageActionButton} onClick={() => void branchFromMessage(message)}>{t("Ветка отсюда")}{" "}</button>
                          )}
                          {message.role === "user" && isLastUser && !isSending && (
                            <button
                              type="button"
                              className={styles.messageActionButton}
                              onClick={() => {
                                setEditingMessageId(message.id);
                                setEditingMessageText(message.content);
                              }}
                            >{t("Редактировать")}{" "}</button>
                          )}
                          {!isSending && message.id === activeChat.activeLeafId && !(activeChat.branches?.[message.id]?.length) && (isDeleteConfirming ? (
                            <>
                              <button type="button" className={styles.messageDeleteConfirm} onClick={() => void deleteMessage(message.id)}>{t("Удалить?")}{" "}</button>
                              <button type="button" className={styles.messageActionButton} onClick={() => setConfirmDeleteMessageId(null)}>{t("Отмена")}{" "}</button>
                            </>
                          ) : (
                            <button type="button" className={styles.messageDeleteButton} onClick={() => setConfirmDeleteMessageId(message.id)}>{t("Удалить")}{" "}</button>
                          ))}
                        </div>
                      )}
                      </MessageTools>
                      <div className="studio-reply-actions">{message.role === "assistant" && isLastAssistant && !isSending && (
                            <>
                              <button
                                type="button"
                                className={styles.messageActionButton}
                                onClick={() => void runChatGeneration({ action: "regenerate", targetMessageId: message.id })}
                              >{t("Повторить ответ")}{" "}</button>
                              <button
                                type="button"
                                className={styles.messageActionButton}
                                onClick={() => void runChatGeneration({ action: "continue", targetMessageId: message.id })}
                              >{t("Продолжить")}{" "}</button>
                            </>
                          )}</div>
                    </article>
                  );
                })
              ) : (
                <div className={styles.emptyState}>
                  {!hasModelId && <button onClick={()=>setTab("settings")}>{ru?"Настроить подключение":"Configure connection"}</button>}
                  <img className="studio-empty-mark" src="/studio/mark.svg" alt=""/>
                  <strong>{selectedCharacter ? t("Начните диалог с {p0}", {p0: selectedCharacter.name}) : (ru?"О чём поговорим?":"What’s on your mind?")}</strong>
                  <p>
                    {selectedCharacter
                      ? t("Напишите первое сообщение — локальная модель продолжит разговор в выбранном образе.")
                      : (ru?"Начните разговор или выберите персонажа в галерее.":"Start a conversation or choose a character from the gallery.")}
                  </p>
                </div>
              )}
              {showNewMessages && (
                <button type="button" className={styles.newMessagesButton} onClick={jumpToLatestMessages}>{t("↓ К новым сообщениям")}{" "}</button>
              )}
            </div>

            <form className={`${styles.composer} ${styles.compactComposer}`} onSubmit={handleSend}>
              <TextFileComposer image={draftImage} onImageChange={image => updateImageDraft(imageDraftKey, image)} sessionToken={state.authSession!.sessionToken} key={`${state.authSession?.sessionToken}:${activeChat?.id}:${activeChat?.activeLeafId}`} textareaRef={composerRef} value={input} onChange={handleComposerChange} disabled={isSending} />
              {isSending ? (
                <button key="stop" type="button" className={styles.secondaryButton} onClick={event => { event.preventDefault(); stopGeneration(); }}>{t("Остановить")}{" "}</button>
              ) : (
                <button key="send" type="submit" className={styles.primaryButton} disabled={isSending || (!input.trim() && !draftImage)}>
                  {isSending ? t("Жду...") : t("Отправить")}
                </button>
              )}
            </form>
          </section>

          <aside className={`${styles.sidebar} ${styles.sidebarRight}`}>
            <StudioPortrait card={selectedCharacter}/>
            <details className="studio-roster"><summary>{ru?"Сменить собеседника":"Switch character"}</summary>
            <h3>{t("Персонажи")}</h3>
            <button type="button" onClick={()=>{setGallery(true);setMobilePanel(null);}}>{ru?"Открыть галерею":"Open gallery"} ↗</button>
            <div className={styles.characterStack} role="region" aria-label={t("Список персонажей чата")} tabIndex={0}>
              {cards.map((character) => (
                <button
                  key={character.id}
                  className={`${styles.characterChoice} ${
                    activeChat?.characterId === character.id ? styles.selectedCharacter : ""
                  }`}
                  onClick={() => {setChatCharacter(character.id);setMobilePanel(null);}}
                >
                  <span className={styles.avatar}>{character.posterUrl?<img loading="lazy" src={thumbnail(character.posterUrl)} alt=""/>:character.avatar}</span>
                  <span>
                    <strong>{character.name}</strong>
                    <small>{character.tags.join(", ") || t("без тегов")}</small>
                  </span>
                </button>
              ))}
            </div>
            </details>
          </aside>
        </section>
        </section>
        )}

        {tab === "group" && (
          <GroupChatTab
            state={{...state,characters:cards}}
            isModelListed={isModelListed}
            updateState={updateState}
            setStatus={setStatus}
            sessionToken={state.authSession?.sessionToken}
            themeClassName={themeClassName}
          />
        )}

        {tab === "memory" && (
          <MemoryCenter
            sessionToken={state.authSession?.sessionToken}
            characters={cards}
            chats={state.chats}
            groupChats={state.groupChats}
            setStatus={setStatus}
          />
        )}

        {tab === "settings" && (
        <section className={styles.pageStack}>
          <div className={`${styles.visualPanel} ${styles.pageHero}`}>
            <h2>{t("Мост и управление системой")}</h2>
            <p>{t("Параметры LM Studio, соединение и базовые настройки генерации собраны в одном плотном экране панели управления.")}</p>
            <div className={styles.statusChipRow}>
              <span className={styles.statusChip}>{t("локальный мост")}</span>
              <span className={`${styles.statusChip} ${hasBaseUrl ? "" : styles.statusChipMuted}`}>{hasBaseUrl ? t("базовый URL задан") : t("базовый URL не задан")}</span>
              <span className={`${styles.statusChip} ${hasModelId ? styles.statusChipViolet : styles.statusChipMuted}`}>{hasModelId ? t("модель выбрана") : t("модель не выбрана")}</span>
              <span className={`${styles.statusChip} ${hasLoadedModels ? "" : styles.statusChipMuted}`}>{hasLoadedModels ? pluralCount("models", models.length) : t("модели не загружены")}</span>
            </div>
          </div>

          <section className={styles.settingsGrid}>
            <div className={styles.settingsMain}>
            <div className={styles.settingsCard}><LanguageSelector /></div>
            {state.authSession && <ModelProfiles key={state.authSession.sessionToken} settings={state.settings} session={state.authSession} onChange={updateSettings} />}
            {state.authSession && <DataManager
              key={state.authSession.sessionToken}
              session={state.authSession}
              busy={hydratedToken !== state.authSession.sessionToken
                || workspaceSaveStatus === "saving" || workspaceSaveStatus === "error" || workspaceSaveStatus === "conflict"
                || sendingChatIds.size > 0 || titleGenerationChatId !== null}
              onRestored={applyAuthSession}
            />}
            <div className={styles.settingsCard}>
                <h3>{t("Мост подключения")}</h3>
                  <p>{t("Основные параметры транспорта для локального моста, совместимого с OpenAI API.")}</p>
                <label>{t("ID пользователя")}{" "}<input value={state.userProfile.id} readOnly />
                </label>
                <label>{t("Базовый URL")}{" "}<input
                    value={state.settings.baseUrl}
                    onChange={(event) => updateSettings({ baseUrl: event.target.value })}
                      placeholder="http://localhost:1234/v1"
                  />
                </label>
                <label>{t("ID модели")}{" "}<input
                    value={state.settings.modelId}
                    onChange={(event) => updateSettings({ modelId: event.target.value })}
                    placeholder={t("id-модели")}
                    list="models"
                  />
                  <datalist id="models">
                    {models.map((model) => (
                      <option key={model.id} value={model.id} />
                    ))}
                  </datalist>
                </label>
                <div className={styles.actions}>
                  <button className={styles.primaryButton} onClick={handleCheckConnection}>
                    {state.authSession?.userId === "u_admin" ? t("Сохранить и проверить соединение") : t("Проверить соединение")}
                  </button>
                  <button className={styles.secondaryButton} onClick={handleLoadModels}>{t("Загрузить модели")}{" "}</button>
                </div>
              </div>

              <div className={styles.controlCardGrid}>
                <div className={styles.settingsCard}>
                  <h3>{t("Тема интерфейса")}</h3>
                  <p>{t("Выберите визуальный стиль локальной панели.")}</p>
                  <label>{t("Стиль")}{" "}<select
                      value={themeMode}
                      onChange={(event) => setThemeMode(normalizeThemeMode(event.target.value))}
                    >
                      <option value="cinematic">Cinematic</option>
                      <option value="brutal">Brutal</option>
                      <option value="studio">Studio</option>
                    </select>
                  </label>
                  <p className={styles.helperText}>{t("Cinematic — атмосферный тёмный стиль. Brutal — контрастная arcade/poster тема. Studio — спокойная рабочая оболочка с боковой навигацией.")}{" "}</p>
                </div>

              <div className={styles.settingsCard}>
                  <h3>{t("Параметры генерации")}</h3>
                  <p>{t("Спокойные глобальные настройки для локальной лаборатории до переопределений по персонажам.")}</p>
                  <div className={styles.settingsInline}>
                    <label>{t("Температура")}{" "}<input
                        type="number"
                        min="0"
                        max="2"
                        step="0.1"
                        value={state.settings.temperature}
                        onChange={(event) => updateSettings({ temperature: Number(event.target.value) })}
                      />
                    </label>
                    <label>{t("Макс. токенов")}{" "}<input
                        type="number"
                        min="1"
                        step="1"
                        value={state.settings.maxTokens}
                        onChange={(event) => updateSettings({ maxTokens: Number(event.target.value) })}
                      />
                    </label>
                  </div>
                  <label className={styles.toggle}>
                    <input
                      type="checkbox"
                      checked={state.settings.streaming}
                      onChange={(event) => updateSettings({ streaming: event.target.checked })}
                    />{t("Потоковые ответы")}{" "}</label>
                  <label className={styles.toggle}>
                    <input
                      type="checkbox"
                      checked={state.userProfile.autoNameNewChats !== false}
                      onChange={(event) => updateState((current) => ({ ...current, userProfile: { ...current.userProfile, autoNameNewChats: event.target.checked, updatedAt: nowIso() } }))}
                    />{t("Автоматически называть новые чаты")}{" "}</label>
                  <p className={styles.helperText}>{t("Название создаётся после первого полного ответа и не меняет переписку.")}</p>
                </div>

              <div className={styles.settingsCard}>
                  <h3>{t("Статус моста")}</h3>
                  <p>{t("Быстрое визуальное состояние текущей локальной сборки.")}</p>
                  <div className={styles.statusChipRow}>
                    <span className={styles.statusChip}>{t("вход по сессии")}</span>
                    <span className={`${styles.statusChip} ${hasBaseUrl ? "" : styles.statusChipMuted}`}>{hasBaseUrl ? t("эндпоинт готов") : t("эндпоинт ожидает")}</span>
                    <span className={`${styles.statusChip} ${state.settings.streaming ? styles.statusChipViolet : styles.statusChipMuted}`}>{state.settings.streaming ? t("поток включён") : t("поток выключен")}</span>
                  </div>
                  <p className={styles.helperText}>{localizeMessage(status)}</p>
                </div>
              </div>
            </div>

            <aside className={styles.settingsColumn}>
              <div className={`${styles.chamberPanel} ${styles.workspaceCard}`}>
                <div className={styles.workspaceHeader}>
                  <div>
                    <h3>{t("Реестр моделей")}</h3>
                    <p>{t("Выберите загруженную модель, не покидая визуальную оболочку.")}</p>
                  </div>
                </div>
                <div className={styles.modelList} role="region" aria-label={t("Список моделей")} tabIndex={0}>
                  {models.length ? (
                    models.map((model) => (
                      <button key={model.id} onClick={() => updateSettings({ modelId: model.id })}>
                        {model.id}
                      </button>
                    ))
                  ) : (
                    <p className={styles.helperText}>{t("Нажмите \"Загрузить модели\", когда LM Studio запущен на втором ПК.")}</p>
                  )}
                </div>
              </div>
            </aside>
          </section>
        </section>
        )}

        {tab === "characters" && (
          <section className={styles.pageStack}>
          <div className={`${styles.visualPanel} ${styles.pageHero}`}>
            <h2>{t("Мастерская персонажей")}</h2>
            <p>{t("Создавайте персонажей, настраивайте их образ и храните портреты в одном месте.")}</p>
            <div className={styles.statusChipRow}>
              <span className={styles.statusChip}>{t("хранилище персонажей")}</span>
              <span className={styles.statusChip}>{t("мастерская промптов")}</span>
              <span className={`${styles.statusChip} ${styles.statusChipViolet}`}>{t("портрет персонажа")}</span>
            </div>
          </div>

          <button className="studio-cta studio-gallery-link" onClick={()=>setGallery(true)}>{ru?"Галерея студии":"Studio gallery"} ↗</button>
          <section
            className={`${styles.charactersGrid} ${
              hasCharacterEditorOpen ? styles.characterEditorOpen : styles.characterLibraryOpen
            }`}
          >
            <aside className={`${styles.sidebar} ${styles.relaySidebar}`}>
              <div className={styles.sidebarIntro}>
                <span className={styles.sidebarBadge}>{t("Библиотека")}</span>
                <h3>{t("Хранилище персонажей")}</h3>
                <p>{t("Переиспользуемые образы, быстрые копии и место для портретов персонажей.")}</p>
              </div>
              <button
                className={styles.primaryButton}
                onClick={startCreateCharacter}
              >{t("Создать персонажа")}{" "}</button>
              <button type="button" className={styles.secondaryButton} onClick={() => document.getElementById("character-import-input")?.click()}>{t("Импорт карточки JSON")}</button><input id="character-import-input" aria-label={t("Импорт карточки JSON")} hidden type="file" accept=".json,application/json" onChange={event => { const file = event.currentTarget.files?.[0]; event.currentTarget.value = ""; if (file) void importCharacterFile(file); }} />
              <div className={styles.vaultSearch}>
                <label htmlFor="character-vault-search">{t("Поиск")}</label>
                <div className={styles.vaultSearchControl}>
                  <input
                    id="character-vault-search"
                    type="search"
                    value={characterSearch}
                    onChange={(event) => setCharacterSearch(event.target.value)}
                    placeholder={t("Имя или тег")}
                  />
                  {characterSearch && (
                    <button type="button" className={styles.ghostButton} onClick={() => setCharacterSearch("")}>{t("Очистить")}{" "}</button>
                  )}
                </div>
                <small>{filteredCharacters.length}{" "}{t("из")}{" "}{state.characters.length}</small>
                <details className={styles.vaultFilters}><summary>{t("Фильтры и сортировка")}</summary>
                <label>{t("Тег")}<select aria-label={t("Фильтр по тегу")} value={characterTag} onChange={event => setCharacterTag(event.target.value)}><option value="">{t("Все теги")}</option>{[...new Set(state.characters.flatMap(card => card.tags))].sort((a, b) => a.localeCompare(b, "ru")).map(tag => <option key={tag} value={tag}>{tag}</option>)}</select></label>
                <label>{t("Порядок")}<select aria-label={t("Сортировка карточек")} value={characterSort} onChange={event => setCharacterSort(event.target.value)}><option value="original">{t("Исходный")}</option><option value="name">{t("По имени")}</option><option value="updated">{t("Недавно изменённые")}</option><option value="created">{t("Сначала новые")}</option></select></label>
                <button type="button" className={styles.secondaryButton} aria-pressed={favoritesOnly} onClick={() => setFavoritesOnly(value => !value)}>{t("Только избранные")}</button>
                {(characterSearch || characterTag || favoritesOnly) && <button type="button" className={styles.ghostButton} onClick={() => { setCharacterSearch(""); setCharacterTag(""); setFavoritesOnly(false); }}>{t("Сбросить фильтры")}</button>}
                </details>
              </div>
              <div
                className={styles.vaultList}
                role="region"
                aria-label={t("Список карточек персонажей")}
                tabIndex={0}
              >
                {filteredCharacters.map((character) => {
                  const isEditing = editingCharacterId === character.id;
                  return (
                    <div
                      key={character.id}
                      ref={(element) => { characterItemRefs.current[character.id] = element; }}
                      className={`${styles.vaultCard} ${isEditing ? styles.selectedCard : ""}`}
                    >
                      <button
                        className={styles.cardRow}
                        onClick={() => startEditCharacter(character)}
                        title={character.name}
                      >
                        <span className={styles.vaultAvatar}>{character.avatar}</span>
                        <span className={styles.vaultCardCopy}>
                          <strong>{character.favorite ? "★ " : ""}{character.name}</strong>
                          <small>{character.tags.join(", ") || t("без тегов")}</small>
                        </span>
                        {isEditing && <span className={styles.vaultSelectedBadge}>{t("Выбрана")}</span>}
                      </button>
                      <div className={styles.rowActions}>
                        <button onClick={() => duplicateCharacter(character)}>{t("Дублировать")}</button>
                        <button onClick={() => deleteCharacter(character.id)}>{t("Удалить")}</button>
                      </div>
                    </div>
                  );
                })}
                {!filteredCharacters.length && (
                  <div className={styles.vaultListEmpty}>
                    <strong>{t("Ничего не найдено")}</strong>
                    <span>{t("Измените запрос или сбросьте фильтры.")}</span>
                  </div>
                )}
              </div>
            </aside>

            <section className={styles.vaultMain}>
              {!hasCharacterEditorOpen ? (
                <div className={`${styles.chamberPanel} ${styles.workspaceCard}`}>
                  <div className={styles.workspaceHeader}>
                    <div>
                      <h3>{t("Выберите карточку")}</h3>
                      <p>{t("Выберите персонажа из списка, чтобы посмотреть или изменить его настройки.")}</p>
                    </div>
                  </div>
                  <div className={styles.vaultPoster}>
                    <span className={styles.portraitPosterLabel}>
                      <strong>{t("Карточка не выбрана")}</strong>
                      <small>{t("Можно открыть существующего персонажа или создать нового.")}</small>
                      <button
                        type="button"
                        className={styles.primaryButton}
                        onClick={startCreateCharacter}
                      >{t("Создать персонажа")}{" "}</button>
                    </span>
                  </div>
                </div>
              ) : (
              <>
              <div className={styles.characterEditorToolbar}>
                <button type="button" className={styles.characterMobileBack} onClick={closeCharacterEditor}>{t("Назад к персонажам")}{" "}</button>
                <div>
                  <strong>{characterDraft.name || t("Новый персонаж")}</strong>
                  <span>{isCharacterDraftDirty ? t("Есть несохранённые изменения") : t("Изменения сохранены")}</span>
                </div>
                <div className={styles.characterEditorActions}>
                  {editingCharacterId && (
                    <button
                      type="button"
                      className={styles.secondaryButton}
                      onClick={() => deleteCharacter(editingCharacterId)}
                    >{t("Удалить")}{" "}</button>
                  )}
                  <button type="button" className={styles.secondaryButton} onClick={closeCharacterEditor}>{t("Отменить")}{" "}</button>
                  <button type="button" className={styles.primaryButton} onClick={saveCharacter}>{t("Сохранить")}{" "}</button>
                </div>
              </div>
              <div className={`${styles.chamberPanel} ${styles.workspaceCard}`}>
                <div className={styles.workspaceHeader}>
                  <div>
                    <h3>{editingCharacterId ? t("Редактирование карточки") : t("Новая карточка")}</h3>
                    <p>{t("Настройте образ, описание и поведение персонажа.")}</p>
                  </div>
                </div>
                <div className={styles.vaultPoster}>
                  {characterDraft.posterUrl?.trim() ? (
                    <img
                      className={styles.vaultPosterImage}
                      src={characterDraft.posterUrl.trim()}
                      alt={t("Портрет персонажа {p0}", {p0: characterDraft.name || t("без имени")})}
                    />
                  ) : (
                    <span className={styles.portraitPosterLabel}>
                      <strong>{t("Портрет пока не задан")}</strong>
                      <small>{t("Добавьте ссылку на изображение в поле «Портрет / постер».")}</small>
                    </span>
                  )}
                </div>
                <div className={styles.contextHero}>
                  <div className={styles.contextHeroAvatar}>{characterDraft.avatar || "?"}</div>
                  <div className={styles.contextHeroMeta}>
                    <strong>{characterDraft.name || t("Новый персонаж")}</strong>
                    <p>{characterDraft.description || t("Описание появится здесь, когда у карточки появится характер.")}</p>
                  </div>
                </div>
                <div className={styles.tagList}>
                  {(characterDraft.tags.length ? characterDraft.tags : [t("творчество"), t("спутник"), t("лаборатория")]).map((tag) => (
                    <span key={tag} className={styles.tagChip}>{tag.trim() || t("тег")}</span>
                  ))}
                </div>
              </div>

              <div className={styles.workshopGrid}>
                <div className={styles.vaultEditorCard}>
                  <h3>{t("Идентичность")}</h3>
                  <label>{t("Имя")}{" "}<input
                      value={characterDraft.name}
                      onChange={(event) => setCharacterDraft({ ...characterDraft, name: event.target.value })}
                    />
                  </label>
                  <label>{t("Описание")}{" "}<textarea
                      value={characterDraft.description}
                      onChange={(event) => setCharacterDraft({ ...characterDraft, description: event.target.value })}
                      rows={4}
                    />
                  </label>
                  <label>{t("Теги")}{" "}<input
                      value={characterDraft.tags.join(", ")}
                      onChange={(event) =>
                        setCharacterDraft({
                          ...characterDraft,
                          tags: event.target.value.split(",")
                        })
                      }
                      placeholder={t("творчество, роль, код")}
                    />
                  </label>
                  <PortraitPicker value={characterDraft.posterUrl} change={posterUrl=>setCharacterDraft(c=>({...c,posterUrl}))}/><label>{t("Портрет / постер")}{" "}<input
                      value={characterDraft.posterUrl || ""}
                      onChange={(event) => setCharacterDraft({ ...characterDraft, posterUrl: event.target.value })}
                      placeholder={t("https://... или путь к изображению")}
                    />
                    <span className={styles.helperText}>{t("Можно вставить ссылку на изображение. Если поле пустое, будет показана заглушка.")}{" "}</span>
                  </label>
                </div>

                <div className={styles.vaultEditorCard}>
                  <h3>{t("Тюнинг")}</h3>
                  <div className={styles.inlineFields}>
                    <label>{t("Аватар / эмодзи")}{" "}<input
                        value={characterDraft.avatar}
                        onChange={(event) => setCharacterDraft({ ...characterDraft, avatar: event.target.value })}
                      />
                    </label>
                    <label>{t("Температура")}{" "}<input
                        type="number"
                        min="0"
                        max="2"
                        step="0.1"
                        value={characterDraft.temperature}
                        onChange={(event) => setCharacterDraft({ ...characterDraft, temperature: Number(event.target.value) })}
                      />
                    </label>
                    <label>{t("Макс. токенов")}{" "}<input
                        type="number"
                        min="1"
                        step="1"
                        value={characterDraft.maxTokens}
                        onChange={(event) => setCharacterDraft({ ...characterDraft, maxTokens: Number(event.target.value) })}
                      />
                    </label>
                  </div>
                  <p className={styles.helperText}>{t("Эти значения остаются локальными для карточки и переопределяют настройки моста только когда персонаж активен.")}</p>
                </div>
              </div>

              {state.authSession && <CharacterTools card={characterDraft} onChange={setCharacterDraft} settings={state.settings} sessionToken={state.authSession.sessionToken} />}
              {state.authSession && editingCharacterId && <CharacterVersions key={editingCharacterId} card={characterDraft} sessionToken={state.authSession.sessionToken} onRestore={setCharacterDraft} />}
              <div className={styles.vaultEditorCard}>
                <h3>{t("Системный промпт")}</h3>
                <label>{t("Системный промпт")}{" "}<textarea
                    value={characterDraft.systemPrompt}
                    onChange={(event) => setCharacterDraft({ ...characterDraft, systemPrompt: event.target.value })}
                    rows={9}
                  />
                </label>
              </div>
              </>
              )}
            </section>
          </section>
          </section>
        )}
      </div>
      <BackgroundDisplay
        activeBackground={sessionBackground}
        artworks={backgroundArtworks}
        isOpen={isBackgroundDisplayOpen}
        onApply={applyBackground}
        onClose={() => updateBackgroundDisplayOpen(false)}
      />
    </main>
  );
}




