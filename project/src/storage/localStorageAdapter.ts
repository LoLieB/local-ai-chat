import type { AppState, GroupChat } from "../types/domain";
import { makeDefaultState } from "./defaultState";
import type { StoragePort } from "./storagePort";

const STORAGE_KEY = "local-ai-chat:v1";
const GROUP_CHATS_KEY = "local-ai-chat:group-chats";

export class LocalStorageAdapter implements StoragePort {
  private setItem(key: string, value: string): void {
    try {
      localStorage.setItem(key, value);
    } catch {
      // Authenticated state is persisted by the server; storage quota must not crash the UI.
    }
  }

  load(): AppState {
    const fallback = makeDefaultState();
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return fallback;
      const parsed = JSON.parse(raw) as Partial<AppState>;
      return {
        ...fallback,
        ...parsed,
        userProfile: parsed.userProfile
          ? { ...fallback.userProfile, ...parsed.userProfile }
          : fallback.userProfile,
        settings: { ...fallback.settings, ...parsed.settings },
        chats: parsed.chats?.length ? parsed.chats : fallback.chats,
        groupChats: this.getGroupChats(parsed.groupChats?.length ? parsed.groupChats : fallback.groupChats),
        characters: parsed.characters?.length ? parsed.characters : fallback.characters,
        activeChatId: parsed.activeChatId || parsed.chats?.[0]?.id || fallback.activeChatId,
        activeGroupChatId:
          parsed.activeGroupChatId ||
          this.getGroupChats(parsed.groupChats).at(0)?.id ||
          fallback.activeGroupChatId
      };
    } catch {
      return { ...fallback, groupChats: this.getGroupChats(fallback.groupChats) };
    }
  }

  save(state: AppState): void {
    this.saveGroupChats(state.groupChats);
    const { groupChats: _groupChats, ...stateWithoutGroupChats } = state;
    this.setItem(STORAGE_KEY, JSON.stringify(stateWithoutGroupChats));
  }

  getGroupChats(fallback: GroupChat[] = []): GroupChat[] {
    try {
      const raw = localStorage.getItem(GROUP_CHATS_KEY);
      if (!raw) return fallback;
      const parsed = JSON.parse(raw) as GroupChat[];
      return parsed.length ? parsed : fallback;
    } catch {
      return fallback;
    }
  }

  saveGroupChats(groupChats: GroupChat[]): void {
    this.setItem(GROUP_CHATS_KEY, JSON.stringify(groupChats));
  }

  createGroupChat(groupChat: GroupChat): GroupChat[] {
    const groupChats = [groupChat, ...this.getGroupChats()];
    this.saveGroupChats(groupChats);
    return groupChats;
  }

  updateGroupChat(groupChat: GroupChat): GroupChat[] {
    const groupChats = this.getGroupChats().map((current) =>
      current.id === groupChat.id ? groupChat : current
    );
    this.saveGroupChats(groupChats);
    return groupChats;
  }

  deleteGroupChat(groupChatId: string): GroupChat[] {
    const groupChats = this.getGroupChats().filter((groupChat) => groupChat.id !== groupChatId);
    this.saveGroupChats(groupChats);
    return groupChats;
  }
}
