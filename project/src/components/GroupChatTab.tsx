import { MessageBody } from "./MessageBody";
import { StudioAvatar, StudioPortrait } from "./StudioGallery";
import { t, getLocale, localizeMessage, pluralCount } from "../i18n";
import { TextFileComposer } from "./TextFileComposer";
import { MessageTools } from "./MessageTools";
import { DISCUSSION_PRESETS } from "../../shared/roomDiscussion";
import { planGroupTurn } from "../../shared/groupTurnPlan";
import { generationTiming } from "../generationTiming";
import { buildCharacterPrompt } from "../../shared/characterCard";
import { ContextDetails } from "./ContextDetails";
import { MemoryControls } from "./MemoryControls";
import { RoomMemory } from "./RoomMemory";
import { CSSProperties, FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ApiHttpError, type DirectorSuggestion, deleteServerChat, getChatState, requestGroupDirectorSuggestion, saveGroupChatConfig, sendGroupChat, streamGroupChat } from "../api";
import styles from "../App.module.css";
import { getRoomParticipants } from "../groupChatParticipants";
import { createGroupStreamTracker, GROUP_STREAM_EMPTY_REPLY } from "../groupStreamTracker";
import { createId, nowIso } from "../storage/defaultState";
import type { AppState, CharacterCard, GroupChat, GroupChatMessage } from "../types/domain";
import { formatChatRequestError, shouldPreservePartialResponse } from "../../shared/chatRequestPolicy";
import { isNearScrollEnd, normalizeGroupReplyLimit, participantSummary, shouldShowNewMessages } from "../../shared/stressHelpers";

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

type GroupChatTabProps = {
  isModelListed: (model: {baseUrl: string; modelId: string}) => boolean;
  state: AppState;
  updateState: (updater: (current: AppState) => AppState) => void;
  setStatus: (status: string) => void;
  sessionToken?: string | null;
  themeClassName?: string;
};

const makeGroupChat = (characters: CharacterCard[]): GroupChat => {
  const createdAt = nowIso();
  const firstCharacterId = characters[0]?.id;
  return {
    id: createId(),
    title: t("Групповая сессия"),
    participantIds: firstCharacterId ? [firstCharacterId] : [],
    activeSpeakerCharacterId: firstCharacterId || null,
    messages: [],
    responseMode: "single-speaker",
    maxRepliesPerTurn: 1,
    createdAt,
    updatedAt: createdAt
  };
};

const apiMessages = (messages: GroupChatMessage[]) =>
  messages.map(({ id, createdAt, role, content, characterId, characterName }) => ({
    id, createdAt,
    role,
    content,
    characterId,
    characterName
  }));

const resolveNextActiveSpeaker = (
  groupChat: Pick<GroupChat, "participantIds" | "activeSpeakerCharacterId" | "messages">
) => {
  if (groupChat.activeSpeakerCharacterId && groupChat.participantIds.includes(groupChat.activeSpeakerCharacterId)) {
    return groupChat.activeSpeakerCharacterId;
  }

  for (let index = groupChat.messages.length - 1; index >= 0; index -= 1) {
    const message = groupChat.messages[index];
    if (message.role === "assistant" && message.characterId && groupChat.participantIds.includes(message.characterId)) {
      return message.characterId;
    }
  }

  return groupChat.participantIds[0] || null;
};

type ConfigSave = {
  pending?: GroupChat;
  revision?: number;
  running?: Promise<boolean>;
  error?: string;
  conflict?: boolean;
  deleting?: boolean;
  deletion?: Promise<void>;
  refreshing?: boolean;
  deleted?: boolean;
};

// Keep unsaved room settings when the tab is temporarily unmounted.
let retainedSaves: { token?: string | null; saves: Map<string, ConfigSave> } = { saves: new Map() };

export function GroupChatTab({ state, isModelListed, updateState: applyState, setStatus: applyStatus, sessionToken, themeClassName = "" }: GroupChatTabProps) {
  if (retainedSaves.token !== sessionToken) retainedSaves = { token: sessionToken, saves: new Map() };
  const sessionRef = useRef({ token: sessionToken, active: true, saves: retainedSaves.saves });
  if (sessionRef.current.token !== sessionToken) {
    sessionRef.current.active = false;
    sessionRef.current = { token: sessionToken, active: true, saves: retainedSaves.saves };
  }
  const session = sessionRef.current;
  const isCurrent = () => session.active && sessionRef.current === session;
  const updateState: GroupChatTabProps["updateState"] = (updater) => {
    if (isCurrent()) applyState((current) => isCurrent() ? updater(current) : current);
  };
  const setStatus = (message: string) => { if (isCurrent()) applyStatus(message); };
  const [, refreshSaveStatus] = useState(0);
  const notifySave = () => { if (isCurrent()) refreshSaveStatus((value) => value + 1); };
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [skipsByRoom, setSkipsByRoom] = useState<Record<string, string[]>>({});
  const [directorByRoom, setDirectorByRoom] = useState<Record<string, { suggestion: DirectorSuggestion; draftAtRequest: string; revision: number }>>({});
  const [isRequestingDirector, setIsRequestingDirector] = useState(false);
  const directorControllerRef = useRef<AbortController | null>(null);
  useEffect(() => { setSkipsByRoom({}); }, [sessionToken]);
  useEffect(() => { setDirectorByRoom({}); directorControllerRef.current?.abort(); }, [sessionToken]);
  const [isSending, setIsSending] = useState(false);
  const messagesRef = useRef<HTMLDivElement | null>(null);
  const followMessagesRef = useRef(true);
  const scrollFrameRef = useRef<number | null>(null);
  const generationControllerRef = useRef<AbortController | null>(null);
  const participantAnchorRef = useRef<HTMLButtonElement | null>(null);
  const participantPopoverRef = useRef<HTMLDivElement | null>(null);
  const mobileRoomsTriggerRef = useRef<HTMLButtonElement | null>(null);
  const mobileRosterTriggerRef = useRef<HTMLButtonElement | null>(null);
  const [showNewMessages, setShowNewMessages] = useState(false);
  const [generationStats, setGenerationStats] = useState<Record<string, string>>({});
  const [participantsPopoverOpen, setParticipantsPopoverOpen] = useState(false);
  const [participantsPopoverPosition, setParticipantsPopoverPosition] = useState<CSSProperties | null>(null);
  const [mobileRoomsOpen, setMobileRoomsOpen] = useState(false);
  const [mobileRosterOpen, setMobileRosterOpen] = useState(false);

  const activeGroupChat =
    useMemo(
      () => state.groupChats.find((groupChat) => groupChat.id === state.activeGroupChatId) || state.groupChats[0],
      [state.activeGroupChatId, state.groupChats]
    ) || null;
  const activeGroupChatIdRef = useRef(activeGroupChat?.id || null);
  activeGroupChatIdRef.current = activeGroupChat?.id || null;
  useEffect(() => () => { directorControllerRef.current?.abort(); }, [activeGroupChat?.id, sessionToken]);

  const draftKey = `local-ai-chat:group-draft:${state.userProfile.id}:${activeGroupChat?.id || ""}`;
  const readDraft = (key: string) => {
    try { return sessionStorage.getItem(key) || ""; } catch { return ""; }
  };
  const input = drafts[draftKey] ?? readDraft(draftKey);
  const setInput = (next: string | ((current: string) => string)) => {
    if (!isCurrent()) return;
    setDrafts(current => {
      const value = typeof next === "function" ? next(current[draftKey] ?? readDraft(draftKey)) : next;
      try { if (value) sessionStorage.setItem(draftKey, value); else sessionStorage.removeItem(draftKey); } catch { /* The in-memory draft remains usable when browser storage is unavailable. */ }
      return { ...current, [draftKey]: value };
    });
  };

  const requestDirector = async () => {
    if (!activeGroupChat || isSending || isRequestingDirector || !sessionToken) return;
    if (!activeParticipants.length) { setStatus(t("Добавьте хотя бы одного персонажа в группу")); return; }
    if (activeGroupChat.modelProfileId && !groupProfile) { setStatus(t("Профиль группы недоступен. Выберите другой.")); return; }
    if (!groupSettings.modelId.trim()) { setStatus(t("Выберите модель в настройках")); return; }
    const roomId = activeGroupChat.id;
    const draftAtRequest = input;
    const controller = new AbortController();
    directorControllerRef.current = controller;
    setIsRequestingDirector(true);
    setDirectorByRoom(current => { const { [roomId]: _previous, ...rest } = current; return rest; });
    setStatus(t("Режиссёр изучает текущую сцену…"));
    try {
      if (!await flushGroupChat(roomId)) { setStatus(t("Сначала сохраните настройки комнаты.")); return; }
      if (controller.signal.aborted) return;
      const { suggestion } = await requestGroupDirectorSuggestion({ groupChatId: roomId, revision: activeGroupChat.revision || 0, draft: draftAtRequest }, sessionToken, controller.signal);
      if (!isCurrent() || controller.signal.aborted || activeGroupChatIdRef.current !== roomId) return;
      setDirectorByRoom(current => ({ ...current, [roomId]: { suggestion, draftAtRequest, revision: activeGroupChat.revision || 0 } }));
      setStatus(t("Совет режиссёра готов. Примените его вручную, если подходит."));
    } catch (error) {
      if (!controller.signal.aborted) setStatus(formatChatRequestError(error, "group"));
    } finally {
      if (directorControllerRef.current === controller) directorControllerRef.current = null;
      if (isCurrent()) setIsRequestingDirector(false);
    }
  };

  const applyDirectorSuggestion = () => {
    if (!activeGroupChat || isSending || isRequestingDirector) return;
    const entry = directorByRoom[activeGroupChat.id];
    if (!entry || entry.suggestion.action !== "speak") return;
    const suggestion = entry.suggestion;
    if (input !== "") { setStatus(t("Черновик не пуст. Освободите поле перед применением совета.")); return; }
    if (entry.revision !== (activeGroupChat.revision || 0) || !activeParticipants.some(character => character.id === suggestion.participantId)) { setStatus(t("Сцена изменилась. Запросите новый совет.")); return; }
    const participant = activeParticipants.find(character => character.id === suggestion.participantId)!;
    updateActiveGroupChat({ activeSpeakerCharacterId: participant.id, responseMode: "single-speaker", maxRepliesPerTurn: 1 });
    setSkipsByRoom(current => ({ ...current, [activeGroupChat.id]: [] }));
    setInput(`@${participant.name}: ${entry.suggestion.task.replace(/\s+/g, " ")}`);
    setDirectorByRoom(current => { const { [activeGroupChat.id]: _applied, ...rest } = current; return rest; });
    setStatus(t("Совет добавлен в черновик. Отправьте его, когда будете готовы."));
  };

  const activeParticipants = useMemo(
    () => (activeGroupChat ? getRoomParticipants(activeGroupChat, state.characters) : []),
    [activeGroupChat, state.characters]
  );

  const portraitSpeaker = [...(activeGroupChat?.messages || [])].reverse().find(message => message.role === "assistant" && (isSending || message.content.trim()));
  const activeSpeaker = useMemo(
    () =>
      activeGroupChat?.activeSpeakerCharacterId
        ? activeParticipants.find((character) => character.id === activeGroupChat.activeSpeakerCharacterId) || null
        : null,
    [activeGroupChat?.activeSpeakerCharacterId, activeParticipants]
  );

  const flushGroupChat = (id: string): Promise<boolean> => {
    const save = session.saves.get(id);
    if (!isCurrent() || !sessionToken) return Promise.resolve(false);
    if (!save) return Promise.resolve(true);
    if (save.running) return save.running;
    if (save.error) return Promise.resolve(false);
    save.running = (async () => {
      while (save.pending && isCurrent()) {
        const pending = save.pending;
        save.pending = undefined;
        try {
          const { groupChat } = await saveGroupChatConfig({ ...pending, configRevision: save.revision ?? pending.configRevision }, sessionToken);
          save.revision = groupChat.configRevision;
          updateState((current) => ({
            ...current,
            groupChats: current.groupChats.map((room) => room.id === id
              ? { ...room, configRevision: groupChat.configRevision, revision: Math.max(room.revision ?? 0, groupChat.revision ?? 0) }
              : room)
          }));
        } catch (error) {
          save.pending ??= pending;
          save.conflict = error instanceof ApiHttpError && error.status === 409;
          save.error = save.conflict
            ? t("Комната изменена в другой вкладке. Загрузите сохранённую версию перед новыми изменениями.")
            : t("Настройки группы не сохранены. Проверьте соединение и повторите.");
          setStatus(save.error);
          return false;
        }
      }
      return isCurrent();
    })().finally(() => { save.running = undefined; notifySave(); });
    notifySave();
    return save.running;
  };

  const persistGroupChat = (groupChat: GroupChat) => {
    if (!isCurrent() || !sessionToken) return;
    const save = session.saves.get(groupChat.id) ?? {};
    if (save.deleting || save.refreshing) return;
    session.saves.set(groupChat.id, save);
    save.pending = groupChat;
    void flushGroupChat(groupChat.id);
  };

  const refreshGroupChat = async (id: string) => {
    const save = session.saves.get(id) ?? {};
    if (save.running || save.refreshing || isSending) return;
    if (!window.confirm(t("Загрузить комнату с сервера? Несохранённые изменения настроек и истории этой комнаты будут отменены. Текст в поле ввода останется."))) return;
    session.saves.set(id, save);
    save.refreshing = true;
    notifySave();
    try {
      const snapshot = await getChatState(sessionToken);
      if (!isCurrent()) return;
      const room = snapshot.groupChats.find((item) => item.id === id);
      session.saves.delete(id);
      updateState((current) => ({ ...current,
        groupChats: room ? current.groupChats.map((item) => item.id === id ? room : item) : current.groupChats.filter((item) => item.id !== id),
        activeGroupChatId: !room && current.activeGroupChatId === id ? current.groupChats.find((item) => item.id !== id)?.id ?? null : current.activeGroupChatId
      }));
      notifySave();
      setStatus(room ? t("Комната загружена с сервера") : t("Комната удалена в другой вкладке"));
    } catch {
      setStatus(t("Не удалось загрузить комнату. Проверьте соединение и повторите."));
    } finally {
      save.refreshing = false;
      notifySave();
    }
  };

  useEffect(() => {
    session.active = true;
    setIsSending(false);
    for (const [id, save] of session.saves) {
      void (save.deletion ?? save.running ?? Promise.resolve()).catch(() => undefined).then(() => {
        if (!isCurrent()) return;
        if (save.deleted) {
          updateState((current) => {
            const groupChats = current.groupChats.filter((room) => room.id !== id);
            return { ...current, groupChats, activeGroupChatId: current.activeGroupChatId === id ? groupChats[0]?.id ?? null : current.activeGroupChatId };
          });
          return;
        }
        if (save.revision != null) {
          updateState((current) => ({ ...current, groupChats: current.groupChats.map((room) =>
            room.id === id ? { ...room, configRevision: save.revision } : room) }));
        }
        notifySave();
        if (save.pending && !save.error) void flushGroupChat(id);
      });
    }
    return () => { session.active = false; generationControllerRef.current?.abort(); };
  }, [session]);

  const scheduleMessagesScroll = () => {
    if (!followMessagesRef.current) {
      setShowNewMessages(true);
      return;
    }

    if (scrollFrameRef.current != null) return;
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
    messagesRef.current?.scrollTo({ top: messagesRef.current.scrollHeight, behavior: "auto" });
  };

  const closeMobileRoster = () => {
    setMobileRosterOpen(false);
    window.requestAnimationFrame(() => mobileRosterTriggerRef.current?.focus());
  };

  const closeMobileRooms = () => {
    setMobileRoomsOpen(false);
    window.requestAnimationFrame(() => mobileRoomsTriggerRef.current?.focus());
  };

  const selectGroupChat = (groupChatId: string) => {
    updateState((current) => ({ ...current, activeGroupChatId: groupChatId }));
    setMobileRoomsOpen(false);
    window.requestAnimationFrame(() => mobileRoomsTriggerRef.current?.focus());
  };

  useEffect(() => {
    followMessagesRef.current = true;
    setShowNewMessages(false);
    setParticipantsPopoverOpen(false);
    window.requestAnimationFrame(scheduleMessagesScroll);
  }, [activeGroupChat?.id]);

  useEffect(() => () => {
    if (scrollFrameRef.current != null) window.cancelAnimationFrame(scrollFrameRef.current);
    generationControllerRef.current?.abort();
  }, []);

  useEffect(() => {
    if (!mobileRoomsOpen && !mobileRosterOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (mobileRoomsOpen) closeMobileRooms();
      if (mobileRosterOpen) closeMobileRoster();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [mobileRoomsOpen, mobileRosterOpen]);

  useEffect(() => {
    if (!mobileRoomsOpen && !mobileRosterOpen) return;
    const body = document.body;
    const scrollY = window.scrollY;
    const previous = {
      overflow: body.style.overflow,
      position: body.style.position,
      top: body.style.top,
      width: body.style.width
    };
    body.style.overflow = "hidden";
    body.style.position = "fixed";
    body.style.top = `-${scrollY}px`;
    body.style.width = "100%";
    return () => {
      body.style.overflow = previous.overflow;
      body.style.position = previous.position;
      body.style.top = previous.top;
      body.style.width = previous.width;
      window.scrollTo(0, scrollY);
    };
  }, [mobileRoomsOpen, mobileRosterOpen]);

  useEffect(() => {
    if (!participantsPopoverOpen) return;
    const close = (restoreFocus = false) => {
      setParticipantsPopoverOpen(false);
      if (restoreFocus) window.requestAnimationFrame(() => participantAnchorRef.current?.focus());
    };
    const closeWithoutFocus = () => close(false);
    const onPointerDown = (event: PointerEvent) => {
      if (!(event.target instanceof Node)) return;
      if (!participantAnchorRef.current?.contains(event.target) && !participantPopoverRef.current?.contains(event.target)) {
        closeWithoutFocus();
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") close(true);
    };
    document.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("resize", closeWithoutFocus);
    window.addEventListener("scroll", closeWithoutFocus, true);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("resize", closeWithoutFocus);
      window.removeEventListener("scroll", closeWithoutFocus, true);
    };
  }, [participantsPopoverOpen]);

  const createGroupChat = () => {
    const groupChat = makeGroupChat(state.characters);
    updateState((current) => ({
      ...current,
      activeGroupChatId: groupChat.id,
      groupChats: [groupChat, ...current.groupChats]
    }));
    persistGroupChat(groupChat);
    setMobileRoomsOpen(false);
    window.requestAnimationFrame(() => mobileRoomsTriggerRef.current?.focus());
    setStatus(t("Групповая сессия создана"));
  };

  const deleteGroupChat = async (groupChatId: string) => {
    if (isSending || !sessionToken) return;
    const groupChat = state.groupChats.find((item) => item.id === groupChatId);
    const save = session.saves.get(groupChatId) ?? {};
    if (save.deleting || save.refreshing) return;
    if (!window.confirm(t("Удалить групповую сессию «{p0}»?", {p0: groupChat?.title || t("Без названия")}))) return;
    session.saves.set(groupChatId, save);
    save.deleting = true;
    notifySave();
    if (!await flushGroupChat(groupChatId)) {
      save.deleting = false;
      notifySave();
      setStatus(t("Сначала сохраните настройки комнаты или загрузите её с сервера, затем повторите удаление."));
      return;
    }
    try {
      if (!isCurrent()) return;
      save.deletion = deleteServerChat(groupChatId, sessionToken, "group-chat").then(() => { save.deleted = true; });
      await save.deletion;
      if (!isCurrent()) return;
    updateState((current) => {
      const groupChats = current.groupChats.filter((groupChat) => groupChat.id !== groupChatId);
        return {
          ...current,
          groupChats,
          activeGroupChatId:
            current.activeGroupChatId === groupChatId ? groupChats[0]?.id ?? null : current.activeGroupChatId
        };
    });
    setStatus(t("Групповая сессия удалена"));
    } catch {
      setStatus(t("Не удалось удалить комнату. Она сохранена в списке; повторите удаление после восстановления соединения."));
    } finally {
      save.deleting = false;
      save.deletion = undefined;
      notifySave();
    }
  };

  const updateActiveGroupChat = (patch: Partial<GroupChat>) => {
    if (!activeGroupChat || isSending || session.saves.get(activeGroupChat.id)?.deleting || session.saves.get(activeGroupChat.id)?.refreshing) return;
    const nextGroupChat = { ...activeGroupChat, ...patch };
    const participantIds = getRoomParticipants(nextGroupChat, state.characters).map((character) => character.id);
    const savedGroupChat: GroupChat = {
      ...nextGroupChat,
      participantIds,
      participantRoles: Object.fromEntries(Object.entries(nextGroupChat.participantRoles || {}).filter(([id]) => participantIds.includes(id))),
      activeSpeakerCharacterId:
        nextGroupChat.responseMode === "single-speaker"
          ? resolveNextActiveSpeaker({ ...nextGroupChat, participantIds })
          : participantIds.includes(nextGroupChat.activeSpeakerCharacterId || "")
            ? nextGroupChat.activeSpeakerCharacterId
            : null,
      updatedAt: nowIso()
    };
    updateState((current) => ({
      ...current,
      groupChats: current.groupChats.map((groupChat) =>
        groupChat.id === activeGroupChat.id
          ? { ...savedGroupChat, messages: groupChat.messages, configRevision: groupChat.configRevision, revision: groupChat.revision }
          : groupChat
      )
    }));
    persistGroupChat(savedGroupChat);
  };

  const toggleParticipant = (characterId: string) => {
    if (!activeGroupChat) return;
    const nextParticipantIds = activeGroupChat.participantIds.includes(characterId)
      ? activeGroupChat.participantIds.filter((participantId) => participantId !== characterId)
      : [...activeGroupChat.participantIds, characterId];
    updateActiveGroupChat({
      participantIds: nextParticipantIds,
      activeSpeakerCharacterId:
        activeGroupChat.activeSpeakerCharacterId === characterId && !nextParticipantIds.includes(characterId)
          ? null
          : activeGroupChat.activeSpeakerCharacterId || characterId
    });
  };

  const setActiveSpeaker = (characterId: string) => {
    if (!activeGroupChat || !activeGroupChat.participantIds.includes(characterId)) return;
    updateActiveGroupChat({ activeSpeakerCharacterId: characterId, responseMode: "single-speaker" });
    const characterName = state.characters.find((character) => character.id === characterId)?.name || t("Участник");
    setStatus(t("Активный спикер: {p0}", {p0: characterName}));
  };

  const appendMessages = (groupChatId: string, messages: GroupChatMessage[]) => {
    updateState((current) => ({
      ...current,
      groupChats: current.groupChats.map((groupChat) =>
        groupChat.id === groupChatId
          ? {
              ...groupChat,
              title: groupChat.messages.length ? groupChat.title : messages[0]?.content.slice(0, 42) || groupChat.title,
              messages: [...groupChat.messages, ...messages],
              updatedAt: nowIso()
            }
          : groupChat
      )
    }));
    scheduleMessagesScroll();
  };

  const updateAssistantMessage = (groupChatId: string, messageId: string, content: string) => {
    updateState((current) => ({
      ...current,
      groupChats: current.groupChats.map((groupChat) =>
        groupChat.id === groupChatId
          ? {
              ...groupChat,
              messages: groupChat.messages.map((message) =>
                message.id === messageId ? { ...message, content } : message
              ),
              updatedAt: nowIso()
            }
          : groupChat
      )
    }));
    scheduleMessagesScroll();
  };

  const skippedParticipantIds = (skipsByRoom[activeGroupChat?.id || ""] || []).filter(id => activeParticipants.some(participant => participant.id === id));
  const turnPlan = useMemo(() => activeGroupChat ? planGroupTurn({
    participants: activeParticipants,
    skippedParticipantIds,
    messages: [...activeGroupChat.messages, { role: "user", content: input }],
    responseMode: activeGroupChat.responseMode,
    activeSpeakerCharacterId: activeGroupChat.activeSpeakerCharacterId,
    maxRepliesPerTurn: activeGroupChat.maxRepliesPerTurn
  }) : [], [activeGroupChat, activeParticipants, input, skipsByRoom]);

  const groupProfile = state.settings.modelProfiles?.find(profile => profile.id === activeGroupChat?.modelProfileId);
  const groupSettings = groupProfile || state.settings;

  const handleSend = async (event?: FormEvent, resumeScene = false) => {
    event?.preventDefault();
    const useStreaming = resumeScene || groupSettings.streaming || Boolean(activeGroupChat?.sceneTimeLimitSeconds);
    if (isSending || isRequestingDirector) return;

    if (!activeGroupChat) {
      setStatus(t("Сначала откройте или создайте групповую сессию"));
      return;
    }

    const userMessageText = input.trim();
    if (!resumeScene && !userMessageText) {
      setStatus(t("Сообщение группы не может быть пустым"));
      return;
    }
    if (activeGroupChat.modelProfileId && !groupProfile) { setStatus(t("Профиль группы недоступен. Выберите другой.")); return; }
    if (!groupSettings.modelId.trim() && activeParticipants.some(character => !character.modelProfileId)) {
      setStatus(t("Выберите модель в настройках"));
      return;
    }
    if (!activeGroupChat.participantIds.length) {
      setStatus(t("Добавьте хотя бы одного персонажа в группу"));
      return;
    }
    if (!activeParticipants.length) {
      setStatus(t("Среди карточек персонажей нет выбранных участников"));
      return;
    }

    if (!resumeScene && !turnPlan.length) { setStatus(t("Верните хотя бы одного спикера в очередь этого хода.")); return; }
    const groupChatId = activeGroupChat.id;
    if (session.saves.get(groupChatId)?.deleting || session.saves.get(groupChatId)?.refreshing) return;
    setIsSending(true);
    if (!await flushGroupChat(groupChatId)) {
      if (isCurrent()) setIsSending(false);
      setStatus(t("Перед отправкой сохраните настройки группы или загрузите комнату с сервера."));
      return;
    }
    if (!isCurrent()) return;
    const createdAt = nowIso();
    const userMessage: GroupChatMessage = {
      id: createId(),
      role: "user",
      content: userMessageText,
      createdAt
    };
    const messagesForRequest = resumeScene ? activeGroupChat.messages : [...activeGroupChat.messages, userMessage];
    const payload = {
      groupChatId,
      groupChatTitle: activeGroupChat.title,
      skippedParticipantIds: resumeScene ? undefined : skippedParticipantIds,
      resumeScene,
      revision: activeGroupChat.revision || 0,
      settings: groupSettings,
      messages: apiMessages(messagesForRequest),
      participants: activeParticipants.map(character => ({ ...character, systemPrompt: buildCharacterPrompt(character) })),
      activeSpeakerCharacterId:
        activeGroupChat.responseMode === "single-speaker" ? activeGroupChat.activeSpeakerCharacterId : null,
      responseMode: activeGroupChat.responseMode,
      maxRepliesPerTurn: normalizeGroupReplyLimit(activeGroupChat.maxRepliesPerTurn, activeParticipants.length) || 1,
      model: groupSettings.modelId,
      temperature: groupSettings.temperature,
      maxTokens: groupSettings.maxTokens
    };

    if (!resumeScene) setInput("");
    setIsSending(true);
    setStatus(t("Ожидаю очередь или ответ локальной модели…"));
    if (!resumeScene) appendMessages(groupChatId, [userMessage]);

    const timing = generationTiming();
    const tokenKeys = new Map<string, string>();
    let tokenSequence = 0;
    let streamedContent = "";
    let sceneInterrupted = false;
    const answeredSpeakerIds = new Set<string>();
    const generationController = new AbortController();
    generationControllerRef.current = generationController;
    let streamTracker: ReturnType<typeof createGroupStreamTracker> | null = null;
    let hasUnresolvedReplies = false;
    const resolveRemainingPending = (warn = true) => {
      if (!streamTracker) return;

      const remaining = streamTracker.drainUnresolved();
      remaining.forEach((pending) => {
        if (pending.unresolved) {
          updateAssistantMessage(groupChatId, pending.messageId, pending.content);
          hasUnresolvedReplies = true;
        }
      });
      if (warn && remaining.length) {
        console.warn("[group-stream] unresolved pending messages", {
          characterIds: remaining.map((pending) => pending.characterId)
        });
      }
    };

    try {
      if (useStreaming) {
        const tracker = createGroupStreamTracker();
        streamTracker = tracker;
        console.info("[group-stream] frontend started", {
          groupChatId,
          participantCount: activeParticipants.length,
          responseMode: activeGroupChat.responseMode,
          maxRepliesPerTurn: activeGroupChat.maxRepliesPerTurn
        });

        await streamGroupChat(
          payload,
          {
            onTokens: usage => timing.tokens(usage.outputTokens, tokenKeys.get(usage.characterId) || usage.characterId),
            onSpeaker: (speaker) => {
              const tokenKey = `${speaker.characterId}:${tokenSequence++}`;
              tokenKeys.set(speaker.characterId, tokenKey);
              timing.tokens(undefined, tokenKey);
              console.info("[group-stream] frontend speaker", { characterId: speaker.characterId });
              updateState((current) => ({
                ...current,
                groupChats: current.groupChats.map((groupChat) =>
                  groupChat.id === groupChatId
                    ? { ...groupChat, activeSpeakerCharacterId: speaker.characterId, updatedAt: nowIso() }
                    : groupChat
                )
              }));
              const assistantMessage: GroupChatMessage = {
                id: createId(),
                role: "assistant",
                characterId: speaker.characterId,
                characterName: speaker.characterName,
                content: "",
                createdAt: nowIso()
              };
              tracker.start(speaker.characterId, assistantMessage.id);
              appendMessages(groupChatId, [assistantMessage]);
            },
            onDelta: ({ characterId, delta }) => {
              const tracked = tracker.append(characterId, delta);
              if (!tracked) {
                console.warn("[group-stream] chunk received without pending message", { characterId });
                return;
              }
              timing.text(delta);
              streamedContent += delta;
              if (tracked.content.trim()) answeredSpeakerIds.add(characterId);
              updateAssistantMessage(groupChatId, tracked.messageId, tracked.content);
            },
            onSpeakerDone: (speaker) => {
              if (speaker.content?.trim()) answeredSpeakerIds.add(speaker.characterId);
              const finished = tracker.finish(speaker.characterId);
              const hasExplicitContent = typeof speaker.content === "string";
              const explicitContent = hasExplicitContent ? speaker.content ?? "" : "";
              const finalContent = hasExplicitContent
                ? explicitContent.trim()
                  ? explicitContent
                  : GROUP_STREAM_EMPTY_REPLY
                : finished?.content;
              const unresolved = hasExplicitContent ? !explicitContent.trim() : (finished?.unresolved ?? true);
              console.info("[group-stream] frontend speakerDone", {
                characterId: speaker.characterId,
                unresolved
              });
              if (finished && finalContent && finalContent !== finished.content) {
                updateAssistantMessage(groupChatId, finished.messageId, finalContent);
              }
              if (unresolved && finished) {
                hasUnresolvedReplies = true;
                updateAssistantMessage(groupChatId, finished.messageId, finalContent || finished.content);
              }
            }
          },
          state.userProfile.id,
          sessionToken,
          generationController.signal
        );
        resolveRemainingPending();
        if (hasUnresolvedReplies) {
          setStatus(t("Не удалось получить ответ групповой сцены. Проверьте LM Studio и повторите."));
          return;
        }
      } else {
        const response = await sendGroupChat(payload, state.userProfile.id, sessionToken, generationController.signal);
        response.replies.forEach((reply, index) => timing.tokens(reply.outputTokens, String(index)));
        const assistantMessages: GroupChatMessage[] = response.replies.map((reply) => ({
          id: createId(),
          role: "assistant",
          characterId: reply.characterId,
          characterName: reply.characterName,
          content: reply.content,
          createdAt: nowIso()
        }));
        const lastReply = response.replies.at(-1);
        if (lastReply?.characterId) {
          updateState((current) => ({ ...current, groupChats: current.groupChats.map((room) =>
            room.id === groupChatId ? { ...room, activeSpeakerCharacterId: lastReply.characterId } : room) }));
        }
        appendMessages(groupChatId, assistantMessages);
      }
      const savedState = await getChatState(sessionToken);
      const savedRoom = savedState.groupChats.find(room => room.id === groupChatId);
      if (savedRoom && !generationController.signal.aborted) updateState(current => ({ ...current, groupChats: current.groupChats.map(room => room.id === groupChatId ? savedRoom : room) }));
      if (!generationController.signal.aborted) setSkipsByRoom(current => ({ ...current, [groupChatId]: [] }));
      const timingSummary = timing.finish(useStreaming);
      if (!generationController.signal.aborted) setGenerationStats(current => ({ ...current, [groupChatId]: timingSummary }));
      setStatus(t("Ответы группы получены. {p0}", {p0: timingSummary}));
    } catch (error) {
      sceneInterrupted = true;
      if (generationController.signal.aborted) {
        resolveRemainingPending(false);
        if (!useStreaming) {
          updateState(current => ({ ...current, groupChats: current.groupChats.map(room => room.id === groupChatId ? { ...room, messages: room.messages.filter(message => message.id !== userMessage.id) } : room) }));
          if (!resumeScene && isCurrent()) setInput(current => current === "" ? userMessageText : current);
          setStatus(t("Генерация остановлена. Черновик сохранён."));
          return;
        }
        setStatus(streamedContent ? t("Генерация остановлена. Часть ответа сохранена.") : t("Генерация остановлена"));
        return;
      }
      console.warn("Group chat send failed", error);
      if (error instanceof ApiHttpError && error.status === 409) {
        const save = session.saves.get(groupChatId) ?? {};
        save.conflict = true;
        save.error = t("История комнаты изменилась в другой вкладке. Загрузите комнату с сервера перед отправкой.");
        session.saves.set(groupChatId, save);
        if (!resumeScene && isCurrent()) setInput(current => current === "" ? userMessageText : current);
        notifySave();
        setStatus(save.error);
        return;
      }
      if (useStreaming) {
        resolveRemainingPending();
        if (shouldPreservePartialResponse(streamedContent, error)) {
          setStatus(t("Ответ был прерван. Часть текста сохранена."));
          return;
        }
        setStatus(t("Не удалось получить ответ групповой сцены. Проверьте LM Studio и повторите."));
        return;
      }
      setStatus(formatChatRequestError(error, "group"));
    } finally {
      if (useStreaming && sceneInterrupted && isCurrent()) {
        const expectedAnswers = activeGroupChat.messages.filter(message => message.role === "assistant" && message.content.trim()).length + answeredSpeakerIds.size;
        for (let attempt = 0; attempt < 20 && isCurrent(); attempt++) {
          try {
            const snapshot = await getChatState(sessionToken);
            const room = snapshot.groupChats.find(candidate => candidate.id === groupChatId);
            if (room && (room.revision || 0) > (activeGroupChat.revision || 0) && room.messages.filter(message => message.role === "assistant" && message.content.trim()).length >= expectedAnswers) {
              updateState(current => ({ ...current, groupChats: current.groupChats.map(candidate => candidate.id === groupChatId ? room : candidate) }));
              setStatus(room.sceneDeadlineAt && Date.now() >= room.sceneDeadlineAt ? t("Время сцены истекло. Ответы сохранены; начните новый ход.") : room.pendingSpeakerIds?.length ? t("Сцена на паузе. Оставшуюся очередь можно продолжить.") : t("Генерация остановлена. Очередь завершена."));
              break;
            }
          } catch { /* A later refresh can recover the server checkpoint. */ }
          await new Promise(resolve => setTimeout(resolve, 100));
        }
      }
      if (generationControllerRef.current === generationController) generationControllerRef.current = null;
      if (isCurrent()) setIsSending(false);
    }
  };



  const participantCount = activeParticipants.length;
  const participantCountLabel = pluralCount("participants", participantCount);
  const groupReplyLimit = normalizeGroupReplyLimit(activeGroupChat?.maxRepliesPerTurn, activeParticipants.length) || 1;
  const responseModeLabel = activeGroupChat?.responseMode === "round-robin" ? t("по кругу") : t("один спикер");
  const responseModeDescription =
    activeGroupChat?.responseMode === "round-robin"
      ? t("Режим по кругу · макс. {p0} ответ(а)", {p0: groupReplyLimit})
      : t("Один спикер");
  const activeModelLabel = groupProfile ? compactModelId(groupProfile.modelId) : activeParticipants.some(character => character.modelProfileId) ? t("Модели участников") : compactModelId(state.settings.modelId);
  const participantPreview = participantSummary(activeParticipants, 3);
  const activeSave = activeGroupChat ? session.saves.get(activeGroupChat.id) : undefined;

  const renderProfileControls = () => <details><summary>{t("Модели и параметры группы")}</summary>
      <label>{t("Профиль группы")}<select aria-label={t("Профиль группы")} disabled={isSending || activeSave?.deleting} value={activeGroupChat?.modelProfileId || ""} onChange={event => updateActiveGroupChat({ modelProfileId: event.target.value || null })}>
        <option value="">{t("Профили участников / текущие настройки")}</option>
        {activeGroupChat?.modelProfileId && !groupProfile && <option value={activeGroupChat.modelProfileId}>{t("Недоступный профиль")}</option>}
        {state.settings.modelProfiles?.map(profile => <option key={profile.id} value={profile.id}>{profile.name}</option>)}
      </select></label>
      <details><summary>{t("Модели участников")}</summary>{activeParticipants.map(character => {
        const profile = groupProfile || state.settings.modelProfiles?.find(value => value.id === character.modelProfileId);
        const missing = (activeGroupChat?.modelProfileId || character.modelProfileId) && !profile;
        return <p key={character.id} style={{ overflowWrap: "anywhere" }}>{character.name}: {missing ? t("Профиль недоступен") : t("{p0} · температура {p1} · максимум {p2}", {p0: profile?.modelId || state.settings.modelId || t("Модель не выбрана"), p1: profile?.temperature ?? state.settings.temperature, p2: profile?.maxTokens ?? state.settings.maxTokens})}</p>;
      })}<p>{t("Профиль группы имеет приоритет. Без него используются профили персонажей; у остальных — текущие настройки группы. Потоковая выдача управляется профилем группы или общими настройками.")}</p></details>
  </details>;

  const renderResponseControls = (className?: string) => (
    <div className={`${styles.groupControls}${className ? ` ${className}` : ""}`}>
      <label>{t("Режим ответа")}{" "}<select
          disabled={isSending || activeSave?.deleting}
          value={activeGroupChat?.responseMode || "single-speaker"}
          onChange={(event) =>
            updateActiveGroupChat({
              responseMode: event.target.value as GroupChat["responseMode"]
            })
          }
        >
          <option value="single-speaker">{t("один спикер")}</option>
          <option value="round-robin">{t("по кругу")}</option>
        </select>
      </label>
      {activeGroupChat?.responseMode === "round-robin" && (
        <label>{t("Макс. ответов на сообщение")}{" "}<input
            disabled={isSending || activeSave?.deleting}
            type="number"
            min="1"
            max={Math.max(1, activeParticipants.length)}
            step="1"
            value={groupReplyLimit}
            onChange={(event) => {
              const nextValue = normalizeGroupReplyLimit(event.target.value, activeParticipants.length);
              if (nextValue != null) {
                updateActiveGroupChat({ maxRepliesPerTurn: nextValue });
              }
            }}
          />
        </label>
      )}
    </div>
  );

  const toggleParticipantsPopover = (anchor: HTMLButtonElement) => {
    if (participantsPopoverOpen) {
      setParticipantsPopoverOpen(false);
      return;
    }

    const rect = anchor.getBoundingClientRect();
    const width = Math.min(340, window.innerWidth - 24);
    const left = Math.max(12, Math.min(rect.left, window.innerWidth - width - 12));
    const shouldOpenAbove = rect.bottom + 300 > window.innerHeight;
    setParticipantsPopoverPosition(
      shouldOpenAbove
        ? { bottom: Math.max(12, window.innerHeight - rect.top + 8), left, width }
        : { top: Math.max(12, rect.bottom + 8), left, width }
    );
    setParticipantsPopoverOpen(true);
  };

  return (
    <section className={`${styles.pageStack} ${styles.groupChatShell}`}>
      <div className={`${styles.visualPanel} ${styles.pageHero} ${styles.groupHero}`}>
        <div className={styles.groupHeroHeading}>
          <div>
            <span className={styles.sidebarBadge}>{t("// группа")}</span>
            <h2>{t("Групповая сцена")}</h2>
          </div>
          <div className={styles.groupHeroMeta}>
            <span className={styles.statusChip}>{t("локальная сцена")}</span>
            <span className={styles.statusChip}>{participantCountLabel}</span>
            <span className={styles.statusChip}>{responseModeLabel}</span>
          </div>
        </div>
        <p>{t("Добавьте нескольких персонажей, выберите режим ответа и запустите общий диалог в одной локальной комнате.")}</p>
      </div>

      <section className={styles.chatGrid}>
        <aside
          id="group-mobile-rooms"
          className={`${styles.sidebar} ${styles.relaySidebar} ${styles.groupRail} ${
            mobileRoomsOpen ? styles.mobileRoomsOpen : ""
          }`}
        >
          <div className={styles.mobileDrawerHeader}>
            <strong>{t("Комнаты (")}{state.groupChats.length})</strong>
            <button type="button" className={styles.mobileDrawerClose} onClick={closeMobileRooms}>{t("Закрыть")}{" "}</button>
          </div>
          <div className={styles.sidebarIntro}>
            <span className={styles.sidebarBadge}>{t("// группа")}</span>
            <h3>{t("Комнаты группы")}</h3>
            <p>{t("Сессии для общих локальных сцен.")}</p>
          </div>
          <button className={styles.primaryButton} onClick={createGroupChat}>{t("Новая групповая сессия")}{" "}</button>
          <div className={styles.sessionList} role="region" aria-label={t("Список групповых комнат")} tabIndex={0}>
            {state.groupChats.map((groupChat) => {
              const roomParticipants = getRoomParticipants(groupChat, state.characters);
              return (
              <div
                key={groupChat.id}
                className={`${styles.sessionCard} ${
                  groupChat.id === activeGroupChat?.id ? styles.selectedRow : ""
                }`}
              >
                <button
                  type="button"
                  className={styles.sessionCardMain}
                  onClick={() => selectGroupChat(groupChat.id)}
                >
                  <span className={styles.sessionCardCopy}>
                  <strong>{groupChat.title}</strong>
                  <small>
                    {pluralCount("participants", roomParticipants.length)}
                  </small>
                  {groupChat.id === activeGroupChat?.id && (
                  <span className={styles.statusChip}>{t("активная комната")}</span>
                  )}
                  </span>
                </button>
                <button
                  type="button"
                  className={styles.rowDelete}
                  disabled={isSending || session.saves.get(groupChat.id)?.deleting}
                  onClick={(event) => {
                    event.stopPropagation();
                    deleteGroupChat(groupChat.id);
                  }}
                >{t("Удалить")}{" "}</button>
              </div>
              );
            })}
          </div>
        </aside>

        <section className={styles.stagePanel}>
          <div className={styles.chatHeader}>
            <div className={styles.groupHeaderMeta}>
              <h2>{activeGroupChat?.title || t("Групповая сессия")}</h2>
              <p>{responseModeDescription}</p>
            </div>
            <div className={styles.groupHeaderPills}>
              <div className={styles.modelPill} title={activeModelLabel}>
                {activeModelLabel}
              </div>
              <span className={`${styles.statusChip} ${styles.statusChipMuted}`}>{isModelListed(groupSettings) && (groupProfile || !activeParticipants.some(card=>card.modelProfileId)) ? (getLocale()==="ru-RU" ? "Модель доступна" : "Model available") : (getLocale()==="ru-RU" ? "Связь не подтверждена" : "Connection unverified")}</span>
            </div>
            <div className={styles.mobileGroupDrawerToggles}>
              <button
                type="button"
                ref={mobileRoomsTriggerRef}
                className={styles.mobileGroupDrawerToggle}
                onClick={() => {
                  setMobileRosterOpen(false);
                  setMobileRoomsOpen((current) => !current);
                }}
                aria-expanded={mobileRoomsOpen}
                aria-controls="group-mobile-rooms"
              >{t("Комнаты (")}{state.groupChats.length})
              </button>
              <button
                type="button"
                ref={mobileRosterTriggerRef}
                className={styles.mobileGroupDrawerToggle}
                onClick={() => {
                  setMobileRoomsOpen(false);
                  setMobileRosterOpen((current) => !current);
                }}
                aria-expanded={mobileRosterOpen}
                aria-controls="group-mobile-roster"
              >{t("Состав (")}{activeParticipants.length})
              </button>
            </div>
            {themeClassName === styles.themeStudio ? (
              <details key={activeGroupChat?.id} className={`${styles.mobileGroupControls} ${styles.studioSceneControls}`}>
                <summary>{t("Режим ответа:")}{" "}{responseModeLabel}</summary>
                {renderResponseControls()}
              </details>
            ) : renderResponseControls(styles.mobileGroupControls)}
          </div>

          <div className={styles.subHeader}>

            {activeGroupChat && (
              <button type="button" className={styles.secondaryButton}
                disabled={isSending || Boolean(activeSave?.running || activeSave?.deleting || activeSave?.refreshing)}
                onClick={() => void refreshGroupChat(activeGroupChat.id)}>{t("Обновить комнату")}{" "}</button>
            )}
            {activeSave && (
              <div role="status" aria-live="polite">
                <span>{activeSave.refreshing ? t("Загрузка комнаты…") : activeSave.deleting ? t("Удаление комнаты…") : activeSave.running ? t("Сохранение настроек…") : activeSave.error || t("Настройки сохранены")}</span>
                {activeSave.error && !activeSave.running && !activeSave.deleting && !activeSave.refreshing && (
                  <button type="button" className={styles.secondaryButton} disabled={isSending} onClick={() => {
                    if (!activeGroupChat) return;
                    if (activeSave.conflict) { void refreshGroupChat(activeGroupChat.id); return; }
                    activeSave.error = undefined;
                    void flushGroupChat(activeGroupChat.id);
                  }}>
                    {activeSave.conflict ? t("Загрузить комнату с сервера") : t("Повторить сохранение")}
                  </button>
                )}
              </div>
            )}
            <div className={styles.participantList}>
              {activeParticipants.length ? (
                participantPreview.visible.map((character) => (
                  <button
                    key={character.id}
                    type="button"
                    className={`${styles.participantChip} ${
                      activeSpeaker?.id === character.id ? styles.activeParticipantChip : ""
                    }`}
                    onClick={() => setActiveSpeaker(character.id)}
                    title={activeSpeaker?.id === character.id ? t("Активный спикер") : t("Сделать активным спикером")}
                  >
                    <span>{character.avatar}</span>
                    {character.name}
                  </button>
                ))
              ) : (
                <span className={styles.statusChip}>{t("Нет активных участников")}</span>
              )}
              {participantPreview.remaining > 0 && (
                <button
                  ref={participantAnchorRef}
                  type="button"
                  className={styles.participantOverflowButton}
                  onClick={(event) => toggleParticipantsPopover(event.currentTarget)}
                  aria-expanded={participantsPopoverOpen}
                  title={t("Показать всех участников")}
                >
                  +{participantPreview.remaining}
                </button>
              )}
            </div>
          </div>

          {participantsPopoverOpen && participantsPopoverPosition && createPortal(
            <div
              ref={participantPopoverRef}
              className={`${styles.participantPopover} ${styles.popoverTheme} ${themeClassName}`}
              style={participantsPopoverPosition}
              role="dialog"
              aria-label={t("Все участники")}
            >
              <strong>{t("Участники комнаты")}</strong>
              <div className={styles.participantPopoverList}>
                {activeParticipants.map((character) => (
                  <button
                    key={character.id}
                    type="button"
                    className={styles.participantPopoverItem}
                    onClick={() => {
                      setActiveSpeaker(character.id);
                      setParticipantsPopoverOpen(false);
                      window.requestAnimationFrame(() => participantAnchorRef.current?.focus());
                    }}
                    title={character.name}
                  >
                    <span>{character.avatar}</span>
                    <span>{character.name}</span>
                  </button>
                ))}
              </div>
            </div>,
            document.body
          )}

          <div className={styles.groupStageFrame}>
            <div
              className={styles.messages}
              ref={messagesRef}
              role="region"
              aria-label={t("История группового чата")}
              tabIndex={0}
              onScroll={(event) => {
                const nearBottom = isNearScrollEnd(event.currentTarget);
                followMessagesRef.current = nearBottom;
                setShowNewMessages((current) => shouldShowNewMessages(current, nearBottom, isSending));
              }}
            >
              {activeGroupChat && generationStats[activeGroupChat.id] && <details><summary>{t("Показатели последнего запроса")}</summary><p>{generationStats[activeGroupChat.id]}</p></details>}
              {activeGroupChat && <details>
                <summary>{t("Очередь следующего хода ·")}{" "}{turnPlan.length}</summary>
                {!!activeGroupChat.pendingSpeakerIds?.length && !isSending && <div>
                  {activeGroupChat.sceneDeadlineAt && <p>{t("Срок сцены:")}{" "}{new Date(activeGroupChat.sceneDeadlineAt).toLocaleString(getLocale())}{t(". После истечения начните новый ход.")}</p>}
                  <p>{t("Сохранённая очередь:")}{" "}{activeGroupChat.pendingSpeakerIds.map(id => state.characters.find(character => character.id === id)?.name || id).join(" → ")}</p>
                  <button type="button" className={styles.secondaryButton} disabled={Boolean(activeGroupChat.sceneDeadlineAt && Date.now() >= activeGroupChat.sceneDeadlineAt)} onClick={() => void handleSend(undefined, true)}>{t("Продолжить сцену")}</button>
                  <p>{t("Продолжатся только оставшиеся участники. Частичный ответ считается завершённой репликой. Новый текст в поле ввода начнёт отдельный ход.")}</p>
                </div>}
                <p>{t("Адресные задания имеют приоритет над режимом комнаты. После указанного числа ответов ход завершится.")}</p>
                <ol aria-label={t("Очередь ответов")}>{turnPlan.map((turn, index) => <li key={`${turn.participant.id}:${index}`}>{turn.participant.name}{turn.task ? ` — ${turn.task}` : ""}</li>)}</ol>
                <fieldset disabled={isSending}>
                  <legend>{t("Пропустить на этот ход")}</legend>
                  {activeParticipants.map(character => <label key={character.id} style={{ display: "flex", alignItems: "center", gap: 8 }}><input style={{ width: "auto" }} type="checkbox" aria-label={t("Пропустить {p0}", {p0: character.name})} checked={skippedParticipantIds.includes(character.id)} onChange={event => { const checked = event.target.checked; setSkipsByRoom(current => ({ ...current, [activeGroupChat.id]: checked ? [...skippedParticipantIds, character.id] : skippedParticipantIds.filter(id => id !== character.id) })); }} />{character.name}</label>)}
                </fieldset>
                {!turnPlan.length && <p role="alert">{t("Очередь пуста. Верните хотя бы одного спикера.")}</p>}
                <p>{t("Пропуски сбросятся после успешного хода. При ошибке сохранятся для повтора; перезагрузка страницы сбрасывает этот выбор.")}</p>
                <label>{t("Следующий участник")}<select aria-label={t("Следующий участник")} disabled={isSending} value="" onChange={event => { if (event.target.value) setActiveSpeaker(event.target.value); }}>
                  <option value="">{t("Выбрать одного спикера…")}</option>{activeParticipants.map(character => <option key={character.id} value={character.id}>{character.name}</option>)}
                </select></label>
                <label>{t("Адресное задание")}<select aria-label={t("Добавить упоминание участника")} disabled={isSending} value="" onChange={event => { const character = activeParticipants.find(candidate => candidate.id === event.target.value); if (character) setInput(current => `${current}${current && !current.endsWith("\n") ? "\n" : ""}@${character.name}: `); }}>
                  <option value="">{t("Добавить @имя в сообщение…")}</option>{activeParticipants.map(character => <option key={character.id} value={character.id}>{character.name}</option>)}
                </select></label>
                <p>{t("После @имя: напишите задание. Для нескольких участников добавьте отдельные строки и увеличьте предел ответов.")}</p>
              </details>}
              {activeGroupChat && <details>
                <summary>{t("Правила и роли комнаты")}</summary>
                <p>{t("Пресет заменит правила и роли этой комнаты. Карточки персонажей сохранятся.")}</p>
                <label>{t("Пресет обсуждения")}<select aria-label={t("Пресет обсуждения")} value="" disabled={isSending} onChange={event => {
                  const preset = DISCUSSION_PRESETS.find(item => item.id === event.target.value);
                  if (preset) updateActiveGroupChat({ roomRules: preset.rules, participantRoles: Object.fromEntries(activeParticipants.map((character, index) => [character.id, preset.roles[index % preset.roles.length]])) });
                }}><option value="">{t("Выбрать пресет…")}</option>{DISCUSSION_PRESETS.map(preset => <option key={preset.id} value={preset.id}>{localizeMessage(preset.name)}</option>)}</select></label>
                <label>{t("Время сцены, секунд")}<input aria-label={t("Время сцены, секунд")} type="number" min={0} max={3600} step={1} disabled={isSending} value={activeGroupChat.sceneTimeLimitSeconds || 0} onChange={event => { const value = Number(event.target.value); if (Number.isSafeInteger(value) && value >= 0 && value <= 3600) updateActiveGroupChat({ sceneTimeLimitSeconds: value }); }} /></label>
                <p>{t("0 — без ограничения времени сцены. Лимит действует от отправки до завершения хода, включая ожидание модели и паузы. С лимитом используется потоковая генерация. Изменение действует со следующего нового хода.")}</p>
                <label>{t("Правила комнаты")}<textarea aria-label={t("Правила комнаты")} maxLength={4000} rows={4} disabled={isSending} value={activeGroupChat.roomRules || ""} onChange={event => updateActiveGroupChat({ roomRules: event.target.value })} /></label>
                {activeParticipants.map(character => <label key={character.id}>{t("Роль:")}{" "}{character.name}<input aria-label={t("Роль участника {p0}", {p0: character.name})} maxLength={500} disabled={isSending} value={activeGroupChat.participantRoles?.[character.id] || ""} onChange={event => updateActiveGroupChat({ participantRoles: { ...activeGroupChat.participantRoles, [character.id]: event.target.value } })} /></label>)}
                <p>{t("Правила и роль добавляются в контекст каждого ответа, включая продолжение сцены. Пустое поле не добавляет инструкций.")}</p>
              </details>}
              {activeGroupChat && <details>
                <summary>{t("Совет режиссёра")}</summary>
                <p>{t("Модель предложит следующего участника и задание либо остановку. В историю совет не записывается, реплики автоматически не отправляются.")}</p>
                <button type="button" className={styles.secondaryButton} disabled={isSending || isRequestingDirector} onClick={() => void requestDirector()}>{t("Получить совет")}</button>
                {isRequestingDirector && <button type="button" className={styles.ghostButton} onClick={() => directorControllerRef.current?.abort()}>{t("Отменить совет")}</button>}
                {directorByRoom[activeGroupChat.id] && (() => {
                  const suggestion = directorByRoom[activeGroupChat.id].suggestion;
                  return <div style={{ overflowWrap: "anywhere" }}>
                    <p>{suggestion.action === "stop" ? t("Рекомендация: остановить сцену") : t("Участник: {p0}", {p0: activeParticipants.find(character => character.id === suggestion.participantId)?.name || t("Недоступен")})}</p>
                    {suggestion.action === "speak" && <p>{t("Задание:")}{" "}{suggestion.task}</p>}
                    <p>{t("Причина:")}{" "}{suggestion.reason}</p><p>{t("Условие остановки:")}{" "}{suggestion.stopCondition}</p>
                    {suggestion.action === "speak" && <button type="button" className={styles.secondaryButton} disabled={isSending || isRequestingDirector || input !== ""} onClick={applyDirectorSuggestion}>{t("Применить к пустому черновику")}</button>}
                    {input !== "" && <p>{t("Текущий черновик сохранён. Для применения освободите поле ввода.")}</p>}
                  </div>;
                })()}
              </details>}
              {activeGroupChat && renderProfileControls()}
              {activeGroupChat && sessionToken && <RoomMemory key={`${sessionToken}:${activeGroupChat.id}`} roomId={activeGroupChat.id} sessionToken={sessionToken} disabled={isSending || isRequestingDirector} />}
              {activeGroupChat && sessionToken && <MemoryControls key={activeGroupChat.id} kind="group" id={activeGroupChat.id} sessionToken={sessionToken} disabled={isSending} />}
              {activeGroupChat?.messages.length ? (
                activeGroupChat.messages.map((message) => (
                  <article id={`message-${message.id}`} key={message.id} className={`${styles.message} ${styles[message.role]}`}>
                    <strong className={styles.messageSpeaker}>
                      {message.role === "user" ? (
                        t("Вы")
                      ) : (
                        <>
                          <StudioAvatar card={state.characters.find(card=>card.id===message.characterId)} neutral/>
                          {message.characterName || t("Удалённый персонаж")}
                        </>
                      )}
                    </strong>
                    <MessageBody text={message.content || "…"}/>
                    <MessageTools compact={themeClassName === styles.themeStudio}>
                    {sessionToken && message.contextReport && <ContextDetails report={message.contextReport} sessionToken={sessionToken} />}
                    {sessionToken && activeGroupChat && <MemoryControls kind="group" id={activeGroupChat.id} sessionToken={sessionToken} messageId={message.id} messageText={message.content} disabled={isSending} />}
                    </MessageTools>
                  </article>
                ))
              ) : (
                <div className={`${styles.heroEmpty} ${styles.groupEmpty}`}>
                  <span className={styles.emptyGlyph}>&gt;_</span>
                  <strong>{t("Ожидание локального сигнала")}</strong>
                  <p>{t("Добавьте участников, отправьте первое сообщение и дайте составу ответить со сцены.")}</p>
                  <span className={styles.emptySignal}>{t("сцена готова")}</span>
                </div>
              )}
              {showNewMessages && (
                <button type="button" className={styles.newMessagesButton} onClick={jumpToLatestMessages}>{t("↓ К новым сообщениям")}{" "}</button>
              )}
            </div>

            <form className={`${styles.composer} ${styles.compactComposer}`} onSubmit={handleSend}>
              <TextFileComposer sessionToken={sessionToken!} key={`${sessionToken}:${activeGroupChat?.id}`} value={input} onChange={setInput} />
              {isSending ? (
                <button key="stop" type="button" className={styles.secondaryButton} onClick={event => { event.preventDefault(); generationControllerRef.current?.abort(); }}>
                  {t("Остановить")}
                </button>
              ) : (
                <button key="send" type="submit" className={styles.primaryButton} disabled={isSending || isRequestingDirector || activeSave?.deleting}>
                  {isSending ? t("Жду...") : t("Отправить")}
                </button>
              )}
            </form>
          </div>
        </section>

        <aside
          id="group-mobile-roster"
          className={`${styles.sidebar} ${styles.chamberPanel} ${styles.groupCastRail} ${
            mobileRosterOpen ? styles.mobileRosterOpen : ""
          }`}
        >
          <div className={styles.mobileDrawerHeader}>
            <strong>{t("Состав (")}{activeParticipants.length})</strong>
            <button type="button" className={styles.mobileDrawerClose} onClick={closeMobileRoster}>{t("Закрыть")}{" "}</button>
          </div>
          <details className="studio-roster"><summary>{t("Участники комнаты")} · {activeParticipants.length}</summary>
          <div className={styles.contextHero}>
            <div className={styles.contextHeroAvatar}>{activeSpeaker?.avatar || "◇"}</div>
            <div className={styles.contextHeroMeta}>
              <strong>{activeSpeaker?.name || t("Камера состава пуста")}</strong>
              <p>
                {activeGroupChat?.responseMode === "single-speaker"
                  ? t("Активный спикер: {p0}", {p0: activeSpeaker?.name || t("автовыбор на следующем ответе")})
                  : t("Режим по кругу переключает активных участников.")}
              </p>
            </div>
          </div>

          {renderResponseControls()}

          <div className={styles.sidebarIntro}>
            <span className={styles.sidebarBadge}>{t("// состав")}</span>
            <h3>{t("Камера состава")}</h3>
            <p>{t("Переключайте карточки в комнату и закрепляйте фокусного спикера при необходимости.")}</p>
          </div>

          <div className={styles.characterStack} role="region" aria-label={t("Доступные персонажи")} tabIndex={0}>
            {state.characters.map((character) => {
              const isActive = Boolean(activeGroupChat?.participantIds.includes(character.id));
              return (
                <button
                  key={character.id}
                  type="button"
                  className={`${styles.characterChoice} ${isActive ? styles.selectedCharacter : ""}`}
                  onClick={() => toggleParticipant(character.id)}
                  title={isActive ? t("Убрать из группы") : t("Добавить в группу")}
                >
                  <StudioAvatar card={character}/>
                  <span>
                    <strong title={character.name}>{character.name}</strong>
                    <small>{isActive ? t("Убрать из группы") : t("Добавить в группу")}</small>
                  </span>
                </button>
              );
            })}
          </div>
          </details>
          <StudioPortrait card={state.characters.find(card => card.id === portraitSpeaker?.characterId)} emptyName={portraitSpeaker?.characterName || t("Групповая сцена")}/>
        </aside>
        {(mobileRoomsOpen || mobileRosterOpen) && (
          <button
            type="button"
            className={styles.mobileDrawerBackdrop}
            aria-label={t("Закрыть мобильную панель")}
            onClick={mobileRoomsOpen ? closeMobileRooms : closeMobileRoster}
          />
        )}
      </section>
    </section>
  );
}

