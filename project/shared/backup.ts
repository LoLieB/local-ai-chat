export const BACKUP_FORMAT = "local-ai-chat-user-backup";
export const BACKUP_VERSION = 1;
export const MAX_BACKUP_BYTES = 50 * 1024 * 1024;

export type UserBackup = {
  format: typeof BACKUP_FORMAT;
  version: typeof BACKUP_VERSION;
  exportedAt: string;
  username: string;
  files: Array<{ path: string; content: string; sha256: string }>;
};

export type BackupPreview = {
  username: string;
  exportedAt: string;
  files: number;
  bytes: number;
  characters: number;
  chats: number;
  groups: number;
  memories: number;
};
