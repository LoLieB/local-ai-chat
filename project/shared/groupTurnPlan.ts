export type GroupPlanRequest<T> = {
  remainingParticipantIds?: string[];
  skippedParticipantIds?: string[];
  participants: T[];
  messages: Array<{ role: string; content: string; characterId?: string }>;
  responseMode?: string;
  activeSpeakerCharacterId?: string | null;
  maxRepliesPerTurn?: number;
};

export type MentionedCharacterTurn = {
  characterId: string;
  characterName: string;
  task?: string;
};

export const SPEAKER_DELIMITER_PATTERN = "[,:\\uFF0C\\uFF1A\\-\\u2013\\u2014]";

export function escapeRegex(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function uniqueValues(values: string[]) {
  return [...new Set(values.filter(Boolean))];
}

export function speakerLabelVariants(name: string) {
  const trimmed = name.trim();
  if (!trimmed) return [];

  const variants = [trimmed];
  const withoutParenthetical = trimmed.replace(/\s*\([^)]*\)\s*/g, " ").replace(/\s+/g, " ").trim();
  if (withoutParenthetical && withoutParenthetical !== trimmed) {
    variants.push(withoutParenthetical);
  }

  for (const match of trimmed.matchAll(/\(([^)]+)\)/g)) {
    const alias = match[1]?.trim();
    if (alias) {
      variants.push(alias);
    }
  }

  return uniqueValues(variants);
}

function trimTaskSegment(value: string) {
  return value.replace(/^[\s"'([{]+|[\s"'.,!?;:)\]}]+$/g, "").trim();
}

export function extractMentionedCharacterTurns(
  userText: string,
  participants: Array<{ id: string; name: string }>
): MentionedCharacterTurn[] {
  const text = userText.trim();
  const codeBlocks = Array.from(text.matchAll(/^(`{3,}|~{3,})[^\n]*\n[\s\S]*?^\1[ \t]*$/gm), match => ({ start: match.index!, end: match.index! + match[0].length }));
  if (!text) {
    return [];
  }

  const matches: Array<{
    characterId: string;
    characterName: string;
    start: number;
    contentStart: number;
  }> = [];

  for (const participant of participants) {
    for (const variant of speakerLabelVariants(participant.name)) {
      const pattern = new RegExp(
        `(^|[\\r\\n]+|(?:[.!?]|\\u2026)\\s+)\\s*@?(${escapeRegex(variant)})\\s*${SPEAKER_DELIMITER_PATTERN}\\s*`,
        "gim"
      );

      for (const match of text.matchAll(pattern)) {
        const boundary = match[1] || "";
        const start = (match.index ?? 0) + boundary.length;
        if (codeBlocks.some(block => start >= block.start && start < block.end)) continue;
        matches.push({
          characterId: participant.id,
          characterName: participant.name,
          start,
          contentStart: (match.index ?? 0) + match[0].length
        });
      }
    }
  }

  if (!matches.length) {
    return [];
  }

  matches.sort((left, right) => left.start - right.start);

  const turns: MentionedCharacterTurn[] = [];
  const seenCharacterIds = new Set<string>();

  for (let index = 0; index < matches.length; index += 1) {
    const current = matches[index];
    if (seenCharacterIds.has(current.characterId)) {
      continue;
    }

    const nextBoundary = matches
      .slice(index + 1)
      .find((candidate) => !seenCharacterIds.has(candidate.characterId));
    const rawTask = text.slice(current.contentStart, nextBoundary?.start ?? text.length);
    const task = trimTaskSegment(rawTask);

    turns.push({
      characterId: current.characterId,
      characterName: current.characterName,
      task: task || undefined
    });
    seenCharacterIds.add(current.characterId);
  }

  return turns;
}

function explicitTurnAssignments<T extends { id: string; name: string }>(request: GroupPlanRequest<T>, participants: T[]) {
  const latest = [...request.messages].reverse().find(message => message.role === "user");
  if (!latest) {
    return [];
  }

  const mentionedTurns = extractMentionedCharacterTurns(latest.content, participants);
  if (!mentionedTurns.length) {
    return [];
  }

  const maxReplies = Math.max(1, Math.min(Number(request.maxRepliesPerTurn || 1), participants.length));
  const assignments: { participant: T; task?: string }[] = [];
  for (const turn of mentionedTurns.slice(0, maxReplies)) {
    const participant = participants.find((candidate) => candidate.id === turn.characterId);
    if (!participant) {
      continue;
    }

    assignments.push({
      participant,
      task: turn.task
    });
  }

  return assignments;
}

function roundRobinTurnAssignments<T extends { id: string; name: string }>(request: GroupPlanRequest<T>, participants: T[]) {
  const maxReplies = Math.max(1, Math.min(Number(request.maxRepliesPerTurn || 1), participants.length));
  if (request.responseMode === "round-robin") {
    const lastAssistantSpeakerId = [...(request.messages || [])]
      .reverse()
      .find((message) => message.role === "assistant" && message.characterId)?.characterId;
    const lastIndex = lastAssistantSpeakerId
      ? participants.findIndex((participant) => participant.id === lastAssistantSpeakerId)
      : -1;
    const startIndex = lastIndex >= 0 ? (lastIndex + 1) % participants.length : 0;
    return Array.from({ length: maxReplies }, (_, offset): { participant: T; task?: string } => ({
      participant: participants[(startIndex + offset) % participants.length]
    }));
  }

  const activeSpeaker = request.activeSpeakerCharacterId
    ? participants.find((participant) => participant.id === request.activeSpeakerCharacterId)
    : undefined;
  if (activeSpeaker) {
    return [{ participant: activeSpeaker }];
  }

  const lastAssistantSpeakerId = [...(request.messages || [])]
    .reverse()
    .find((message) => message.role === "assistant" && message.characterId)?.characterId;
  if (lastAssistantSpeakerId) {
    const lastAssistantSpeaker = participants.find((participant) => participant.id === lastAssistantSpeakerId);
    if (lastAssistantSpeaker) {
      return [{ participant: lastAssistantSpeaker }];
    }
  }

  return [{ participant: participants[0] }];
}

export function planGroupTurn<T extends { id: string; name: string }>(request: GroupPlanRequest<T>): Array<{ participant: T; task?: string }> {
  const participants = request.participants.filter(participant => participant.id && participant.name);
  if (!participants.length) return [];
  const fullRequest = { ...request, maxRepliesPerTurn: participants.length };
  const explicit = explicitTurnAssignments(fullRequest, participants);
  if (request.remainingParticipantIds) return request.remainingParticipantIds.flatMap(id => {
    const participant = participants.find(candidate => candidate.id === id);
    return participant ? [{ participant, task: explicit.find(turn => turn.participant.id === id)?.task }] : [];
  });
  const assignments = explicit.length ? explicit : roundRobinTurnAssignments(fullRequest, participants);
  const skipped = new Set(request.skippedParticipantIds || []);
  const limit = Math.max(1, Math.min(Number(request.maxRepliesPerTurn || 1), participants.length));
  return assignments.filter(turn => !skipped.has(turn.participant.id)).slice(0, limit);
}
