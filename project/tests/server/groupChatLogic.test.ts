import test from "node:test";
import assert from "node:assert/strict";

import {
  extractMentionedCharacterTurns,
  requestGroupCharacterStream,
  resolveGroupParticipantsForTurn
} from "../../server/lmStudio.ts";
import type { AppSettings, GroupChatRequest, GroupParticipant } from "../../server/types.ts";

const settings: AppSettings = {
  baseUrl: "http://localhost:1234/v1",
  modelId: "local-model",
  streaming: true,
  temperature: 0.7,
  maxTokens: 1024
};

const participants: GroupParticipant[] = [
  { id: "a", name: "A", systemPrompt: "System prompt A" },
  { id: "b", name: "B", systemPrompt: "System prompt B" },
  { id: "c", name: "C", systemPrompt: "System prompt C" }
];

function groupRequest(patch: Partial<GroupChatRequest> = {}): GroupChatRequest {
  return {
    messages: [{ role: "user", content: "Начинаем сцену" }],
    participants,
    activeSpeakerCharacterId: null,
    responseMode: "single-speaker",
    maxRepliesPerTurn: 1,
    model: "local-model",
    temperature: 0.7,
    maxTokens: 1024,
    ...patch
  };
}

test("single-speaker uses active speaker, then last assistant, then first participant", () => {
  assert.deepEqual(
    resolveGroupParticipantsForTurn(groupRequest({ activeSpeakerCharacterId: "b" })).map((participant) => participant.id),
    ["b"]
  );

  assert.deepEqual(
    resolveGroupParticipantsForTurn(groupRequest({
      activeSpeakerCharacterId: "missing",
      messages: [
        { role: "user", content: "Привет" },
        { role: "assistant", characterId: "c", characterName: "C", content: "Ответ C" },
        { role: "user", content: "Продолжай" }
      ]
    })).map((participant) => participant.id),
    ["c"]
  );

  assert.deepEqual(
    resolveGroupParticipantsForTurn(groupRequest({ activeSpeakerCharacterId: "missing" })).map((participant) => participant.id),
    ["a"]
  );
});

test("round-robin starts after the last assistant and wraps around", () => {
  const lastSpeaker = (characterId: string) =>
    groupRequest({
      responseMode: "round-robin",
      messages: [
        { role: "user", content: "Первое" },
        { role: "assistant", characterId, characterName: characterId.toUpperCase(), content: "Ответ" },
        { role: "user", content: "Следующий ход" }
      ]
    });

  assert.deepEqual(resolveGroupParticipantsForTurn(groupRequest({ responseMode: "round-robin" })).map((p) => p.id), ["a"]);
  assert.deepEqual(resolveGroupParticipantsForTurn(lastSpeaker("a")).map((p) => p.id), ["b"]);
  assert.deepEqual(resolveGroupParticipantsForTurn(lastSpeaker("b")).map((p) => p.id), ["c"]);
  assert.deepEqual(resolveGroupParticipantsForTurn(lastSpeaker("c")).map((p) => p.id), ["a"]);
});

test("round-robin can select several next participants", () => {
  const request = groupRequest({
    responseMode: "round-robin",
    maxRepliesPerTurn: 2,
    messages: [
      { role: "user", content: "Первое" },
      { role: "assistant", characterId: "b", characterName: "B", content: "Ответ B" },
      { role: "user", content: "Следующий ход" }
    ]
  });

  assert.deepEqual(resolveGroupParticipantsForTurn(request).map((participant) => participant.id), ["c", "a"]);
});

test("explicit name mentions override room order for the current turn", () => {
  const scrambledParticipants: GroupParticipant[] = [
    { id: "i", name: "Мария", systemPrompt: "System prompt Марии" },
    { id: "m", name: "Алина", systemPrompt: "System prompt Алины" },
    { id: "r", name: "Света", systemPrompt: "System prompt Светы" }
  ];

  const request = groupRequest({
    participants: scrambledParticipants,
    responseMode: "round-robin",
    maxRepliesPerTurn: 3,
    messages: [
      {
        role: "user",
        content:
          "Алина, предложи идею для локального AI-сайта. Света, найди в ней слабое место. Мария, предложи практичный план реализации."
      }
    ]
  });

  assert.deepEqual(resolveGroupParticipantsForTurn(request).map((participant) => participant.name), [
    "Алина",
    "Света",
    "Мария"
  ]);
});

test("explicit name mentions still respect maxRepliesPerTurn", () => {
  const scrambledParticipants: GroupParticipant[] = [
    { id: "i", name: "Мария", systemPrompt: "System prompt Марии" },
    { id: "m", name: "Алина", systemPrompt: "System prompt Алины" },
    { id: "r", name: "Света", systemPrompt: "System prompt Светы" }
  ];

  const request = groupRequest({
    participants: scrambledParticipants,
    responseMode: "round-robin",
    maxRepliesPerTurn: 2,
    messages: [
      {
        role: "user",
        content:
          "Алина, предложи идею для локального AI-сайта. Света, найди в ней слабое место. Мария, предложи практичный план реализации."
      }
    ]
  });

  assert.deepEqual(resolveGroupParticipantsForTurn(request).map((participant) => participant.name), [
    "Алина",
    "Света"
  ]);
});

test("extractMentionedCharacterTurns returns mentioned order and per-character tasks", () => {
  const turns = extractMentionedCharacterTurns(
    "Алина, предложи идею для локального AI-сайта.\nСвета, найди в ней слабое место.\nМария, предложи практичный план реализации.",
    [
      { id: "m", name: "Алина", systemPrompt: "System prompt Алины" },
      { id: "r", name: "Света", systemPrompt: "System prompt Светы" },
      { id: "i", name: "Мария", systemPrompt: "System prompt Марии" }
    ]
  );

  assert.deepEqual(turns, [
    { characterId: "m", characterName: "Алина", task: "предложи идею для локального AI-сайта" },
    { characterId: "r", characterName: "Света", task: "найди в ней слабое место" },
    { characterId: "i", characterName: "Мария", task: "предложи практичный план реализации" }
  ]);
});

test("group character prompt includes full room roster, task discipline, and current identity lock", async () => {
  let capturedBody: unknown;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    capturedBody = JSON.parse(String(init?.body || "{}"));
    return new Response(new ReadableStream(), { status: 200 });
  };

  try {
    const stream = await requestGroupCharacterStream(
      groupRequest({
        participants: [
          { id: "m", name: "Алина", systemPrompt: "System prompt Алины" },
          { id: "r", name: "Света", systemPrompt: "System prompt Светы" },
          { id: "i", name: "Мария", systemPrompt: "System prompt Марии" }
        ],
        responseMode: "round-robin",
        maxRepliesPerTurn: 3,
        messages: [
          {
            role: "user",
            content:
              "Алина, предложи идею для локального AI-сайта. Света, найди в ней слабое место. Мария, предложи практичный план реализации."
          }
        ]
      }),
      { id: "r", name: "Света", systemPrompt: "System prompt Светы" },
      settings
    );
    await stream.cancel();
  } finally {
    globalThis.fetch = originalFetch;
  }

  const body = capturedBody as { messages: Array<{ role: string; content: string }> };
  const systemPrompt = body.messages[0]?.content || "";
  const userPrompt = body.messages[1]?.content || "";

  assert.match(systemPrompt, /System prompt Светы/);
  assert.match(systemPrompt, /Алина/);
  assert.match(systemPrompt, /Мария/);
  assert.match(systemPrompt, /Reply only as Света/);
  assert.match(systemPrompt, /Do not ask other participants to answer/);
  assert.match(systemPrompt, /If the latest user message assigns you a task by name, complete that task directly/);
  assert.match(systemPrompt, /Do not mirror the previous speaker's tone/);
  assert.match(systemPrompt, /Avoid generic hype or praise openings unless they are necessary/);
  assert.match(systemPrompt, /Your concrete task in this turn: найди в ней слабое место/);
  assert.match(userPrompt, /complete only Света's task in this reply/);
});

test("same-turn prompt includes previous replies from earlier participants", async () => {
  let capturedBody: unknown;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    capturedBody = JSON.parse(String(init?.body || "{}"));
    return new Response(new ReadableStream(), { status: 200 });
  };

  try {
    const stream = await requestGroupCharacterStream(
      groupRequest({
        activeSpeakerCharacterId: "b",
        messages: [
          { role: "user", content: "Что думаете?" },
          { role: "assistant", characterId: "a", characterName: "A", content: "Я начну первой." }
        ]
      }),
      participants[1],
      settings
    );
    await stream.cancel();
  } finally {
    globalThis.fetch = originalFetch;
  }

  const body = capturedBody as { messages: Array<{ role: string; content: string }> };
  const userPrompt = body.messages[1]?.content || "";
  assert.match(userPrompt, /User: Что думаете\?/);
  assert.match(userPrompt, /A: Я начну первой\./);
});
