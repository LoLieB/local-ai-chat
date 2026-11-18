import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  appendCharacterMemoryNote,
  appendDailyLogEntries,
  appendMemoryFacts,
  dailyLogFileName,
  defaultMemoryFiles,
  ensureUserWorkspace,
  extractMemoryFactsFromText,
  normalizeUserId,
  readUserWorkspaceState,
  readUserMemoryContext,
  syncUserWorkspace
} from "../../server/storage/userDataStore.ts";

test("normalizeUserId trims and rejects unsafe values", () => {
  assert.equal(normalizeUserId("  u-1234_ab  "), "u-1234_ab");
  assert.equal(normalizeUserId("bad/path"), null);
  assert.equal(normalizeUserId(""), null);
});

test("dailyLogFileName uses day-month-year format", () => {
  assert.equal(dailyLogFileName(new Date("2026-05-23T15:40:10Z")), "23-05-2026.md");
});

test("ensureUserWorkspace creates user folders and default memory files", async () => {
  const rootDir = await mkdtemp(join(tmpdir(), "local-ai-chat-user-store-"));
  const workspace = await ensureUserWorkspace("u-test-user", rootDir);

  assert.match(workspace.userDir, /u-test-user$/);
  for (const fileName of defaultMemoryFiles) {
    const memoryFile = await readFile(join(workspace.memoryDir, fileName), "utf8");
    assert.ok(memoryFile.length >= 0);
  }
});

test("syncUserWorkspace writes profile, manifest and character cards", async () => {
  const rootDir = await mkdtemp(join(tmpdir(), "local-ai-chat-user-store-"));

  await syncUserWorkspace(
    {
      userProfile: {
        id: "u-sync-user",
        label: "u-sync-user",
        createdAt: "2026-05-23T10:00:00.000Z",
        updatedAt: "2026-05-23T10:00:00.000Z"
      },
      characters: [
        {
          id: "char-1",
          name: "Helga",
          description: "Ops lead",
          systemPrompt: "Stay strict.",
          avatar: "H",
          temperature: 0.7,
          maxTokens: 1024,
          tags: ["ops"],
          createdAt: "2026-05-23T10:00:00.000Z",
          updatedAt: "2026-05-23T10:00:00.000Z"
        }
      ],
      chatSummaries: [
        {
          id: "chat-1",
          kind: "chat",
          title: "First chat",
          updatedAt: "2026-05-23T10:05:00.000Z",
          messageCount: 2
        }
      ]
    },
    rootDir
  );

  const profile = JSON.parse(
    await readFile(join(rootDir, "u-sync-user", "profile.json"), "utf8")
  ) as { id: string };
  const manifest = JSON.parse(
    await readFile(join(rootDir, "u-sync-user", "manifest.json"), "utf8")
  ) as { characters: Array<{ id: string }>; chats: Array<{ id: string }> };
  const card = JSON.parse(
    await readFile(join(rootDir, "u-sync-user", "characters", "char-1", "card.json"), "utf8")
  ) as { name: string };

  assert.equal(profile.id, "u-sync-user");
  assert.equal(manifest.characters[0]?.id, "char-1");
  assert.equal(manifest.chats[0]?.id, "chat-1");
  assert.equal(card.name, "Helga");
});

test("readUserWorkspaceState falls back when profile or manifest JSON is malformed", async () => {
  const rootDir = await mkdtemp(join(tmpdir(), "local-ai-chat-user-store-"));
  const workspace = await ensureUserWorkspace("u-broken-json", rootDir);

  await writeFile(join(workspace.userDir, "profile.json"), "", "utf8");
  await writeFile(join(workspace.userDir, "manifest.json"), "{", "utf8");

  const state = await readUserWorkspaceState("u-broken-json", rootDir);

  assert.equal(state.userProfile.id, "u-broken-json");
  assert.equal(Array.isArray(state.characters), true);
  assert.deepEqual(state.chatSummaries, []);
});

test("syncUserWorkspace and readUserWorkspaceState tolerate rapid overlapping reads", async () => {
  const rootDir = await mkdtemp(join(tmpdir(), "local-ai-chat-user-store-"));
  const payload = {
    userProfile: {
      id: "u-race-json",
      label: "Race User",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    },
    characters: Array.from({ length: 5 }, (_, index) => ({
      id: `char-${index}`,
      name: `Character ${index}`,
      description: "",
      systemPrompt: "",
      avatar: "*",
      temperature: 0.7,
      maxTokens: 1024,
      tags: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    })),
    chatSummaries: []
  };

  await Promise.all([
    syncUserWorkspace(payload, rootDir),
    readUserWorkspaceState("u-race-json", rootDir),
    readUserWorkspaceState("u-race-json", rootDir)
  ]);

  const state = await readUserWorkspaceState("u-race-json", rootDir);
  assert.equal(state.characters.length, 5);
});

test("appendDailyLogEntries appends readable transcript entries", async () => {
  const rootDir = await mkdtemp(join(tmpdir(), "local-ai-chat-user-store-"));

  await appendDailyLogEntries(
    "u-log-user",
    [
      { speaker: "You", content: "Hello there", createdAt: "2026-05-23T08:00:00.000Z" },
      { speaker: "Helga", content: "Stay focused.", createdAt: "2026-05-23T08:00:05.000Z" }
    ],
    rootDir
  );

  const log = await readFile(join(rootDir, "u-log-user", "daily-logs", "23-05-2026.md"), "utf8");

  assert.match(log, /# 23-05-2026/);
  assert.match(log, /You:/);
  assert.match(log, /Helga:/);
  assert.match(log, /Stay focused\./);
});

test("appendDailyLogEntries serializes concurrent writes for one user", async () => {
  const rootDir = await mkdtemp(join(tmpdir(), "local-ai-chat-user-store-"));

  await Promise.all([
    appendDailyLogEntries(
      "u-queue-user",
      [{ speaker: "You", content: "First message", createdAt: "2026-05-23T08:01:00.000Z" }],
      rootDir
    ),
    appendDailyLogEntries(
      "u-queue-user",
      [{ speaker: "Rin", content: "Second message", createdAt: "2026-05-23T08:01:01.000Z" }],
      rootDir
    )
  ]);

  const log = await readFile(join(rootDir, "u-queue-user", "daily-logs", "23-05-2026.md"), "utf8");

  assert.equal((log.match(/# 23-05-2026/g) || []).length, 1);
  assert.match(log, /First message/);
  assert.match(log, /Second message/);
});

test("readUserMemoryContext includes cached facts after appendMemoryFacts", async () => {
  const rootDir = await mkdtemp(join(tmpdir(), "local-ai-chat-user-store-"));

  await appendMemoryFacts(
    "u-facts-user",
    [
      { date: "2026-05-23", fact: "Height 187, weight 80", source: "profile", kind: "profile" },
      { date: "2026-05-23", fact: "Likes trash-punk", source: "chat", kind: "preference" }
    ],
    rootDir
  );

  const context = await readUserMemoryContext("u-facts-user", null, rootDir);
  const factsFile = await readFile(join(rootDir, "u-facts-user", "memory", "facts.jsonl"), "utf8");

  assert.match(context, /Известные факты/);
  assert.match(context, /Height 187, weight 80/);
  assert.match(context, /Likes trash-punk/);
  assert.equal(factsFile.trim().split("\n").length, 2);
});

test("extractMemoryFactsFromText keeps durable facts and skips temporary chatter", () => {
  const facts = extractMemoryFactsFromText(
    "My name is Alex. My height is 187. I love trash-punk. Today I am angry."
  );

  const factTexts = facts.map((fact) => fact.fact);
  assert.ok(factTexts.some((fact) => /Имя пользователя: Alex/.test(fact)));
  assert.ok(factTexts.some((fact) => /Рост пользователя: 187/.test(fact)));
  assert.ok(factTexts.some((fact) => /Пользователю нравится: trash-punk/.test(fact)));
  assert.equal(factTexts.some((fact) => /Today I am angry/i.test(fact)), false);
});

test("extractMemoryFactsFromText recognizes explicit remember requests", () => {
  const facts = extractMemoryFactsFromText("Запомни: мой тестовый код памяти — ALPHA-7429");
  assert.equal(facts.length, 1);
  assert.match(facts[0].fact, /ALPHA-7429/);
});

test("appendMemoryFacts deduplicates semantically identical facts", async () => {
  const rootDir = await mkdtemp(join(tmpdir(), "local-ai-chat-user-store-"));

  await appendMemoryFacts(
    "u-dedupe-user",
    [
      { date: "2026-05-23", fact: "My name is Alex", source: "chat", kind: "profile", confidence: 0.95 },
      { date: "2026-05-24", fact: "my name is alex", source: "chat", kind: "profile", confidence: 0.91 }
    ],
    rootDir
  );

  const factsFile = await readFile(join(rootDir, "u-dedupe-user", "memory", "facts.jsonl"), "utf8");
  assert.equal(factsFile.trim().split("\n").length, 1);
});

test("appendMemoryFacts ignores oversized and control-heavy facts", async () => {
  const rootDir = await mkdtemp(join(tmpdir(), "local-ai-chat-user-store-"));

  await appendMemoryFacts(
    "u-memory-safety",
    [
      { date: "2026-05-23", fact: `${"x".repeat(1001)}`, source: "test" },
      { date: "2026-05-23", fact: "safe\u0000 fact", source: "test" }
    ],
    rootDir
  );

  const factsFile = await readFile(join(rootDir, "u-memory-safety", "memory", "facts.jsonl"), "utf8");
  assert.equal(factsFile.trim().split("\n").length, 1);
  assert.doesNotMatch(factsFile, /\u0000/);
});

test("readUserMemoryContext keeps character-specific notes isolated", async () => {
  const rootDir = await mkdtemp(join(tmpdir(), "local-ai-chat-user-store-"));

  await appendCharacterMemoryNote("u-char-memory", "char-soft", "User was gentle and trusting here.", rootDir);
  await appendCharacterMemoryNote("u-char-memory", "char-harsh", "User was rude and hostile here.", rootDir);

  const softContext = await readUserMemoryContext("u-char-memory", "char-soft", rootDir);
  const harshContext = await readUserMemoryContext("u-char-memory", "char-harsh", rootDir);
  const freshContext = await readUserMemoryContext("u-char-memory", "char-new", rootDir);

  assert.match(softContext, /gentle and trusting/i);
  assert.doesNotMatch(softContext, /rude and hostile/i);
  assert.match(harshContext, /rude and hostile/i);
  assert.doesNotMatch(harshContext, /gentle and trusting/i);
  assert.doesNotMatch(freshContext, /gentle and trusting|rude and hostile/i);
});

test("character memory rejects unsafe ids and deduplicates repeated notes", async () => {
  const rootDir = await mkdtemp(join(tmpdir(), "local-ai-chat-user-store-"));

  await appendCharacterMemoryNote("u-char-safe", "char-safe", "Same episode.", rootDir);
  await appendCharacterMemoryNote("u-char-safe", "char-safe", "Same episode.", rootDir);
  await appendCharacterMemoryNote("u-char-safe", "../escape", "Should not be written.", rootDir);

  const memoryFile = await readFile(join(rootDir, "u-char-safe", "memory", "character-char-safe.md"), "utf8");
  assert.equal((memoryFile.match(/Same episode\./g) || []).length, 1);
  assert.doesNotMatch(memoryFile, /Should not be written/);
});

test("workspace revisions reject concurrent stale replacement before any data mutation", async () => {
  const rootDir = await mkdtemp(join(tmpdir(), "local-ai-chat-workspace-revision-"));
  const initial = await readUserWorkspaceState("u-revision", rootDir);
  assert.equal(initial.revision, 0);
  const first = { ...initial, userProfile: { ...initial.userProfile, label: "First" } };
  const stale = { ...initial, userProfile: { ...initial.userProfile, label: "Stale" } };
  const results = await Promise.allSettled([
    syncUserWorkspace(first, rootDir), syncUserWorkspace(stale, rootDir)
  ]);
  assert.equal(results[0].status, "fulfilled");
  assert.equal(results[1].status, "rejected");
  if (results[1].status === "rejected") {
    assert.equal(results[1].reason.name, "WorkspaceConflictError");
    assert.equal(results[1].reason.revision, 1);
  }
  const saved = await readUserWorkspaceState("u-revision", rootDir);
  assert.equal(saved.revision, 1);
  assert.equal(saved.userProfile.label, "First");
  const next = await syncUserWorkspace(saved, rootDir);
  assert.equal(next.revision, 2);
  assert.equal((await readUserWorkspaceState("u-revision", rootDir)).revision, 2);
});

test("invalid workspace payload cannot delete existing characters or change profile", async () => {
  const rootDir = await mkdtemp(join(tmpdir(), "local-ai-chat-workspace-validation-"));
  const state = await readUserWorkspaceState("u-validation", rootDir);
  state.characters = [{ id: "keep", name: "Keep", description: "", systemPrompt: "", avatar: "K",
    temperature: 0.7, maxTokens: 1024, tags: [], createdAt: "now", updatedAt: "now" }];
  await syncUserWorkspace(state, rootDir);
  const saved = await readUserWorkspaceState("u-validation", rootDir);
  for (const revision of [-1, 1.5, NaN, Infinity, "1", null, Number.MAX_SAFE_INTEGER + 1]) {
    await assert.rejects(syncUserWorkspace({ ...saved, revision } as any, rootDir), /Invalid workspace revision/);
  }
  for (const characters of [null, {}, [null], [{ ...saved.characters[0], id: "../escape" }],
    [saved.characters[0], saved.characters[0]]]) {
    await assert.rejects(syncUserWorkspace({ ...saved, characters } as any, rootDir), /Invalid workspace/);
  }
  await assert.rejects(syncUserWorkspace({ ...saved, chatSummaries: [null] } as any, rootDir), /Invalid workspace/);
  await assert.rejects(syncUserWorkspace({ ...saved, revision: 0, characters: [] }, rootDir), /Workspace changed/);
  assert.deepEqual(await readUserWorkspaceState("u-validation", rootDir), saved);
});

test("legacy manifest migrates from revision zero and corrupt manifest fails closed on save", async () => {
  const rootDir = await mkdtemp(join(tmpdir(), "local-ai-chat-workspace-legacy-"));
  const workspace = await ensureUserWorkspace("u-legacy", rootDir);
  await writeFile(join(workspace.userDir, "manifest.json"), JSON.stringify({ chats: [] }));
  const state = await readUserWorkspaceState("u-legacy", rootDir);
  assert.equal(state.revision, 0);
  await syncUserWorkspace(state, rootDir);
  const savedProfile = await readFile(join(workspace.userDir, "profile.json"), "utf8");
  for (const contents of ["{", "null", "[]", '{"revision":-1}', '{"revision":"1"}']) {
    await writeFile(join(workspace.userDir, "manifest.json"), contents);
    await assert.rejects(syncUserWorkspace({ ...state, revision: 0 }, rootDir));
    assert.equal(await readFile(join(workspace.userDir, "profile.json"), "utf8"), savedProfile);
    assert.equal(await readFile(join(workspace.userDir, "manifest.json"), "utf8"), contents);
  }
});
