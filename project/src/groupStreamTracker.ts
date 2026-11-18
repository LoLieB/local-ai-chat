export const GROUP_STREAM_EMPTY_REPLY = "Не удалось получить ответ этого персонажа.";

type TrackedMessage = {
  messageId: string;
  content: string;
};

type FinishedMessage = TrackedMessage & {
  unresolved: boolean;
};

export function createGroupStreamTracker() {
  const messagesByCharacter = new Map<string, TrackedMessage>();

  return {
    start(characterId: string, messageId: string) {
      messagesByCharacter.set(characterId, { messageId, content: "" });
    },

    append(characterId: string, delta: string) {
      const tracked = messagesByCharacter.get(characterId);
      if (!tracked) return null;

      tracked.content += delta;
      return { messageId: tracked.messageId, content: tracked.content };
    },

    finish(characterId: string): FinishedMessage | null {
      const tracked = messagesByCharacter.get(characterId);
      if (!tracked) return null;

      messagesByCharacter.delete(characterId);
      const unresolved = !tracked.content.trim();
      return {
        messageId: tracked.messageId,
        content: unresolved ? GROUP_STREAM_EMPTY_REPLY : tracked.content,
        unresolved
      };
    },

    drainUnresolved() {
      const unresolved = Array.from(messagesByCharacter, ([characterId, tracked]) => ({
        characterId,
        messageId: tracked.messageId,
        content: tracked.content.trim() ? tracked.content : GROUP_STREAM_EMPTY_REPLY,
        unresolved: !tracked.content.trim()
      }));
      messagesByCharacter.clear();
      return unresolved;
    }
  };
}
