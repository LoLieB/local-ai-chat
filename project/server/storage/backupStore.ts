import { isFactoryId } from "../../shared/studioCatalog.js";
import { validChatImage } from "../../shared/chatImage.js";
import { validSavedTextFile, MAX_SAVED_TEXT_FILES } from "./textFileStore.js";
import { validRoomDiscussion } from "../../shared/roomDiscussion.js";
import { validChatOrganization } from "../../shared/chatOrganization.js";
import { validCharacterDetails } from "../../shared/characterCard.js";
import { isContextReport, isMemoryPolicy } from "../../shared/context.js";
import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { BACKUP_FORMAT, BACKUP_VERSION, MAX_BACKUP_BYTES, type BackupPreview, type UserBackup } from "../../shared/backup.js";
import { isMemoryKind, isMemoryScope } from "../../shared/memory.js";
import { registerUser } from "./authStore.js";
import { normalizeUserId, withUserWorkspaceBarrier, validateCharacterVersions } from "./userDataStore.js";

const defaultRoot = join(process.cwd(), "server-data", "common-base");
const MAX_FILES = 10000;
const idPattern = /^[A-Za-z0-9_-]{1,128}$/;
const allowedPath = /^(?:text-files\/[a-f0-9]{64}\.json|profile\.json|manifest\.json|characters\/[A-Za-z0-9_-]{1,128}\/(?:card|versions)\.json|chats\/chat-[A-Za-z0-9_-]{1,128}\.json(?:\.deleted)?|group-chats\/group-[A-Za-z0-9_-]{1,128}\.json(?:\.deleted)?|memory\/(?:global\.md|pinned\.md|summary\.md|exclusions\.json|policy\.json|facts\.jsonl|character-[A-Za-z0-9_-]{1,128}\.md)|daily-logs\/(?:\d{4}-\d{2}-\d{2}|\d{2}-\d{2}-\d{4})\.md)$/;
export class BackupValidationError extends Error { readonly status = 400; constructor() { super("Invalid user backup."); this.name = "BackupValidationError"; } }
export class BackupConflictError extends Error { readonly status = 409; constructor() { super("Workspace changed during backup. Retry export."); this.name = "BackupConflictError"; } }
function invalid(): never { throw new BackupValidationError(); }
function object(value: unknown): Record<string, any> {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
  return value as Record<string, any>;
}
function digest(content: string) { return createHash("sha256").update(content).digest("hex"); }
function revision(value: unknown) { if (value !== undefined && (!Number.isSafeInteger(value) || (value as number) < 0)) invalid(); }
function strings(...values: unknown[]) { if (!values.every(value => typeof value === "string")) invalid(); }
function identifier(value: unknown) { if (typeof value !== "string" || !idPattern.test(value)) invalid(); }
function parse(content: string) { try { return object(JSON.parse(content)); } catch { return invalid(); } }

function validate(input: unknown): { backup: UserBackup; preview: BackupPreview } {
  const value = object(input);
  if (value.format !== BACKUP_FORMAT || value.version !== BACKUP_VERSION || !Array.isArray(value.files) ||
      value.files.length > MAX_FILES || typeof value.username !== "string" || !value.username.trim() ||
      typeof value.exportedAt !== "string" || !Number.isFinite(Date.parse(value.exportedAt))) invalid();
  const files: UserBackup["files"] = [];
  const paths = new Set<string>();
  const json = new Map<string, Record<string, any>>();
  const preview: BackupPreview = { username: value.username, exportedAt: value.exportedAt, files: value.files.length, bytes: 0, characters: 0, chats: 0, groups: 0, memories: 0 };
  for (const entry of value.files) {
    const file = object(entry);
    if (typeof file.path !== "string" || !allowedPath.test(file.path) || paths.has(file.path.toLowerCase()) ||
        typeof file.content !== "string" || typeof file.sha256 !== "string" || file.sha256 !== digest(file.content)) invalid();
    paths.add(file.path.toLowerCase());
    preview.bytes += Buffer.byteLength(file.content);
    if (preview.bytes > MAX_BACKUP_BYTES) invalid();
    files.push({ path: file.path, content: file.content, sha256: file.sha256 });
    if (file.path.endsWith(".json") || file.path.endsWith(".deleted")) json.set(file.path, parse(file.content));
    if (file.path === "memory/policy.json") {
      if (Buffer.byteLength(file.content) > 2 * 1024 * 1024) invalid();
      const policies = parse(file.content);
      if (Object.keys(policies).length > 2000 || Object.entries(policies).some(([key, value]) => !/^(chat|group):[A-Za-z0-9_-]{1,128}$/.test(key) || !isMemoryPolicy(value))) invalid();
    }
    if (file.path === "memory/exclusions.json") {
      const exclusions = parse(file.content);
      if (!Array.isArray(exclusions.hashes) || exclusions.hashes.length > 2000 ||
          !exclusions.hashes.every((key: unknown) => typeof key === "string" && /^[a-f0-9]{64}$/.test(key))) invalid();
    }
    if (file.path === "memory/facts.jsonl") {
      const ids = new Set<string>();
      for (const line of file.content.split(/\r?\n/).filter((line: string) => line.trim())) {
        const record = parse(line);
        if (record.id !== undefined) {
          identifier(record.id);
          if (record.sourceMessageId !== undefined) identifier(record.sourceMessageId);
          if (ids.has(record.id) || !isMemoryScope(record.scope) || !isMemoryKind(record.kind) ||
              typeof record.text !== "string" || typeof record.enabled !== "boolean" || typeof record.pinned !== "boolean" ||
              !["user", "system", "character"].includes(record.createdBy) || !Number.isFinite(record.confidence) ||
              !Number.isFinite(record.importance) || (record.lastAccessedAt !== null && typeof record.lastAccessedAt !== "string")) invalid();
          strings(record.source, record.createdAt, record.updatedAt);
          for (const key of ["characterId", "chatId", "groupChatId"]) if (record[key] !== undefined) identifier(record[key]);
          ids.add(record.id);
        } else strings(record.fact, record.date);
        preview.memories++;
      }
    }
  }
  const profile = json.get("profile.json");
  const manifest = json.get("manifest.json");
  if (!profile || !manifest) invalid();
  identifier(profile.id); strings(profile.label, profile.createdAt, profile.updatedAt);
  if (object(manifest.userProfile).id !== profile.id || !Array.isArray(manifest.characters) || !Array.isArray(manifest.chats)) invalid();
  revision(manifest.revision);
  if ([...json.keys()].filter(path => path.startsWith("text-files/")).length > MAX_SAVED_TEXT_FILES) invalid();
  const cardIds = new Set<string>();
  for (const [path, data] of json) {
    if (path.startsWith("text-files/")) { if (!validSavedTextFile(data) || path !== `text-files/${data.id}.json`) invalid(); continue; }
    revision(data.revision); revision(data.configRevision);
    if (path.endsWith(".deleted")) { strings(data.deletedAt); continue; }
    if (path.startsWith("characters/") && path.endsWith("/versions.json")) {
      const id = path.split("/")[1];
      if (!json.has(`characters/${id}/card.json`)) invalid();
      try { validateCharacterVersions(data, id); } catch { invalid(); }
      continue;
    }
    if (path.startsWith("characters/")) {
      if (isFactoryId(data.id) || path !== `characters/${data.id}/card.json`) invalid();
      if (!validCharacterDetails(data)) invalid();
      identifier(data.id); strings(data.name, data.description, data.systemPrompt, data.avatar, data.createdAt, data.updatedAt);
      if (!Number.isFinite(data.temperature) || !Number.isFinite(data.maxTokens) || !Array.isArray(data.tags) || !data.tags.every((tag: unknown) => typeof tag === "string")) invalid();
      cardIds.add(data.id); preview.characters++;
    }
    if (!path.startsWith("chats/") && !path.startsWith("group-chats/")) continue;
    const group = path.startsWith("group-chats/");
    identifier(data.id);
    if (!validChatOrganization(data)) invalid();
    if (data.modelProfileId != null && data.modelProfileId !== "") identifier(data.modelProfileId);
    if (path !== (group ? `group-chats/group-${data.id}.json` : `chats/chat-${data.id}.json`)) invalid();
    strings(data.title, data.createdAt, data.updatedAt);
    if (!Array.isArray(data.messages)) invalid();
    const seen = new Set<string>();
    for (const item of data.messages) {
      const message = object(item);
      strings(message.content, message.createdAt);
      if (message.image !== undefined && (group || message.role !== "user" || !validChatImage(message.image))) invalid();
      if (message.contextReport !== undefined && !isContextReport(message.contextReport)) invalid();
      if (message.role !== "user" && message.role !== "assistant") invalid();
      if (message.id !== undefined) {
        identifier(message.id);
        if (seen.has(message.id) || (message.parentId != null && !seen.has(message.parentId))) invalid();
        seen.add(message.id);
      } else if (data.schemaVersion === 2) invalid();
    }
    if (data.activeLeafId != null && !seen.has(data.activeLeafId)) invalid();
    if (data.pinnedMessageIds !== undefined && (!Array.isArray(data.pinnedMessageIds) || !data.pinnedMessageIds.every((id: string) => seen.has(id)))) invalid();
    if (group) {
      if (!Array.isArray(data.participantIds) || new Set(data.participantIds).size !== data.participantIds.length ||
          !["single-speaker", "round-robin"].includes(data.responseMode) || !Number.isSafeInteger(data.maxRepliesPerTurn) || data.maxRepliesPerTurn < 1) invalid();
      data.participantIds.forEach(identifier);
      if (!validRoomDiscussion(data, data.participantIds)) invalid();
      if (data.pendingSpeakerIds !== undefined && (!Array.isArray(data.pendingSpeakerIds) || new Set(data.pendingSpeakerIds).size !== data.pendingSpeakerIds.length || !data.pendingSpeakerIds.every((id: unknown) => typeof id === "string" && data.participantIds.includes(id)))) invalid();
      if (data.activeSpeakerCharacterId != null && !data.participantIds.includes(data.activeSpeakerCharacterId)) invalid();
      preview.groups++;
    } else { if (data.characterId != null) identifier(data.characterId); preview.chats++; }
  }
  const listed = new Set<string>();
  for (const item of manifest.characters) {
    const card = object(item);
    if (!cardIds.has(card.id) || listed.has(card.id)) invalid();
    listed.add(card.id);
  }
  if (listed.size !== cardIds.size) invalid();
  for (const item of manifest.chats) {
    const chat = object(item); identifier(chat.id); strings(chat.title, chat.updatedAt);
    if (!["chat", "group-chat"].includes(chat.kind) || !Number.isSafeInteger(chat.messageCount) || chat.messageCount < 0) invalid();
  }
  const backup: UserBackup = { format: BACKUP_FORMAT, version: BACKUP_VERSION, username: value.username, exportedAt: value.exportedAt, files };
  if (Buffer.byteLength(JSON.stringify(backup)) > MAX_BACKUP_BYTES) invalid();
  return { backup, preview };
}

export function inspectUserBackup(input: unknown): BackupPreview { return validate(input).preview; }

async function inventory(root: string, relative = ""): Promise<string[]> {
  const path = join(root, relative);
  const info = await lstat(path);
  if (info.isSymbolicLink()) invalid();
  if (info.isFile()) {
    if (!allowedPath.test(relative) || info.size > MAX_BACKUP_BYTES) invalid();
    return [`${relative}\0${info.size}\0${info.mtimeMs}\0${info.ctimeMs}\0${info.ino}`];
  }
  if (!info.isDirectory()) invalid();
  const result: string[] = [];
  for (const entry of (await readdir(path)).sort()) {
    result.push(...await inventory(root, relative ? `${relative}/${entry}` : entry));
    if (result.length > MAX_FILES) invalid();
  }
  return result;
}

export async function exportUserBackup(userId: string, authRootDir = defaultRoot): Promise<UserBackup> {
  if (!normalizeUserId(userId) || normalizeUserId(userId) !== userId) invalid();
  const usersRoot = join(authRootDir, "users");
  const root = join(usersRoot, userId);
  try {
    return await withUserWorkspaceBarrier(userId, usersRoot, async () => {
      if ((await lstat(usersRoot)).isSymbolicLink()) invalid();
      const first = await inventory(root);
      const files: UserBackup["files"] = [];
      let bytes = 0;
      for (const item of first) {
        const path = item.split("\0")[0];
        const content = await readFile(join(root, path), "utf8");
        bytes += Buffer.byteLength(content);
        if (bytes > MAX_BACKUP_BYTES) invalid();
        files.push({ path, content, sha256: digest(content) });
      }
      const last = await inventory(root);
      if (JSON.stringify(first) !== JSON.stringify(last)) throw new BackupConflictError();
      return validate({ format: BACKUP_FORMAT, version: BACKUP_VERSION, exportedAt: new Date().toISOString(), username: parse(files.find(file => file.path === "profile.json")?.content || "").label, files }).backup;
    });
  } catch (error) {
    if (error instanceof BackupConflictError) throw error;
    throw new Error("Unable to export user backup safely.");
  }
}

export async function restoreUserBackup(input: unknown, username: string, password: string, authRootDir = defaultRoot) {
  const { backup } = validate(input);
  return registerUser(username, password, authRootDir, async (userId, usersRoot) => {
    const stage = await mkdtemp(join(usersRoot, ".restore-"));
    try {
      for (const file of backup.files) {
        let content = file.content;
        if (file.path === "profile.json" || file.path === "manifest.json") {
          const value = parse(content);
          const profile = file.path === "profile.json" ? value : value.userProfile;
          profile.id = userId; profile.label = username.trim();
          content = JSON.stringify(value, null, 2);
        }
        const path = join(stage, file.path);
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, content, { flag: "wx" });
      }
      await rename(stage, join(usersRoot, userId));
    } finally { await rm(stage, { recursive: true, force: true }); }
  });
}
