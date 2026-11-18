import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import { formatTextFile, type SavedTextFile } from "../../shared/textFile.js";
import { ensureUserWorkspace, normalizeUserId, withUserWorkspaceBarrier } from "./userDataStore.js";
import { writeJsonAtomic } from "./jsonFile.js";

const defaultRoot = join(process.cwd(), "server-data", "common-base", "users");
export const MAX_SAVED_TEXT_FILES = 200;
export class TextFileError extends Error { constructor(message: string, public readonly status = 400) { super(message); } }
function fileId(name: string, text: string) { return createHash("sha256").update(JSON.stringify([name, text])).digest("hex"); }
function validateText(name: unknown, text: unknown): asserts name is string {
  if (typeof name !== "string" || !name || name.length > 160 || /[\/\\\x00-\x1f\x7f]/.test(name) || typeof text !== "string") throw new TextFileError("Некорректное имя или содержимое файла.");
  try { formatTextFile(name, new TextEncoder().encode(text).buffer); }
  catch (error) { throw new TextFileError(error instanceof Error ? error.message : "Некорректный текстовый файл."); }
}
export function validSavedTextFile(value: unknown): value is SavedTextFile {
  if (!value || typeof value !== "object") return false;
  const file = value as SavedTextFile;
  try { validateText(file.name, file.text); } catch { return false; }
  return file.id === fileId(file.name, file.text) && file.size === Buffer.byteLength(file.text) && typeof file.createdAt === "string" && Number.isFinite(Date.parse(file.createdAt));
}
function directory(userId: string, root: string) {
  const normalized = normalizeUserId(userId);
  if (!normalized) throw new TextFileError("Некорректная учётная запись.");
  return join(root, normalized, "text-files");
}
function pathFor(userId: string, id: string, root: string) {
  if (!/^[a-f0-9]{64}$/.test(id)) throw new TextFileError("Некорректный идентификатор файла.");
  return join(directory(userId, root), `${id}.json`);
}
export async function readSavedTextFile(userId: string, id: string, root = defaultRoot): Promise<SavedTextFile> {
  const path = pathFor(userId, id, root);
  let raw: string;
  try { raw = await readFile(path, "utf8"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new TextFileError("Файл не найден.", 404); throw error; }
  const file: unknown = JSON.parse(raw);
  if (!validSavedTextFile(file) || file.id !== id) throw new TextFileError("Сохранённый файл повреждён.", 500);
  return file;
}
export async function listSavedTextFiles(userId: string, root = defaultRoot) {
  let names: string[];
  try { names = await readdir(directory(userId, root)); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
  const files = await Promise.all(names.filter(name => /^[a-f0-9]{64}\.json$/.test(name)).map(name => readSavedTextFile(userId, name.slice(0, -5), root)));
  return files.sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map(({ text: _text, ...metadata }) => metadata);
}
export async function saveTextFile(userId: string, name: unknown, text: unknown, root = defaultRoot) {
  validateText(name, text);
  const content = text as string;
  return withUserWorkspaceBarrier(userId, root, async () => {
    await ensureUserWorkspace(userId, root);
    const id = fileId(name, content);
    const existing = await listSavedTextFiles(userId, root);
    if (existing.some(file => file.id === id)) return readSavedTextFile(userId, id, root);
    if (existing.length >= MAX_SAVED_TEXT_FILES) throw new TextFileError("В библиотеке уже 200 файлов. Удалите ненужные.", 409);
    const file: SavedTextFile = { id, name, text: content, size: Buffer.byteLength(content), createdAt: new Date().toISOString() };
    await mkdir(directory(userId, root), { recursive: true });
    await writeJsonAtomic(pathFor(userId, id, root), file);
    return file;
  });
}
export async function deleteSavedTextFile(userId: string, id: string, root = defaultRoot) {
  const path = pathFor(userId, id, root);
  return withUserWorkspaceBarrier(userId, root, async () => {
    try { await unlink(path); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  });
}
