import type { AppState, GroupChat } from "../types/domain";

export type StoragePort = {
  load(): AppState;
  save(state: AppState): void;
  getGroupChats(): GroupChat[];
  saveGroupChats(groupChats: GroupChat[]): void;
  createGroupChat(groupChat: GroupChat): GroupChat[];
  updateGroupChat(groupChat: GroupChat): GroupChat[];
  deleteGroupChat(groupChatId: string): GroupChat[];
};
