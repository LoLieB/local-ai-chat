import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validChatImage, IMAGE_CONTEXT_TOKENS } from "../../shared/chatImage.ts";
import { validateImportedChat } from "../../shared/chatTransfer.ts";
import { composeContext } from "../../server/context.ts";
import { buildMessages } from "../../server/lmStudio.ts";
import { saveChatTranscript, readStoredChat, activeChatMessages } from "../../server/storage/chatStore.ts";
import { registerUser } from "../../server/storage/authStore.ts";
import { exportUserBackup, restoreUserBackup } from "../../server/storage/backupStore.ts";

const image = { name: "pixel.png", width: 1, height: 1, dataUrl: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jVxkAAAAASUVORK5CYII=" };
const message = { id: "user-image", role: "user" as const, content: "Describe", image, createdAt: "2026-09-24", parentId: null };

test("images survive chat import, branched transcript storage and workspace restore", async t => {
  assert(validChatImage(image));
  const root = await mkdtemp(join(tmpdir(), "image-persistence-")); t.after(() => rm(root, { recursive: true, force: true }));
  const user = await registerUser("source", "password", root);
  const imported = validateImportedChat({ title: "Image", messages: [message, { id: "reply", role: "assistant", content: "Pixel", createdAt: "2026-09-24", parentId: message.id }], activeLeafId: "reply" });
  await saveChatTranscript(user.userId, { ...imported, id: "image-chat", createdAt: "2026-09-24", updatedAt: "2026-09-24" }, join(root, "users"));
  const backup = await exportUserBackup(user.userId, root);
  const restored = await restoreUserBackup(backup, "restored", "password", root);
  const chat = await readStoredChat(restored.userId, "image-chat", join(root, "users"));
  assert.deepEqual(activeChatMessages(chat!)[0].image, image);
  assert.throws(() => validateImportedChat({ title: "bad", messages: [{ ...message, image: { ...image, dataUrl: "https://example.invalid/tracker.png" } }] }));
  assert.throws(() => validateImportedChat({ title: "out-of-order", messages: [{ id: "child", role: "assistant", content: "reply", createdAt: "now", parentId: message.id }, message] }), /родительское сообщение/);
});

test("image cost is counted in context selection and wire payload retains images", () => {
  const base = { systemPrompt: "Be helpful", userMessage: "Continue", records: [], history: [message], policy: { disabled: false, excludedMessageIds: [], contextTokens: 8192 }, reserveTokens: 200 };
  const result = composeContext(base);
  assert.deepEqual(result.history[0].image, image);
  assert(result.report.inputTokens >= IMAGE_CONTEXT_TOKENS);
  const wire = buildMessages(result.systemPrompt, result.history, base.userMessage, image);
  assert.deepEqual(wire[1].content, [{ type: "text", text: "Describe" }, { type: "image_url", image_url: { url: image.dataUrl } }]);
  assert(Array.isArray(wire.at(-1)?.content));
  const short = composeContext({ ...base, policy: { ...base.policy, contextTokens: 2600 } });
  assert.equal(short.history.length, 0);
  assert(short.report.excluded.some(item => item.id === message.id));
  assert.throws(() => composeContext({ ...base, image, history: [], policy: { ...base.policy, contextTokens: 2600 } }));
});
