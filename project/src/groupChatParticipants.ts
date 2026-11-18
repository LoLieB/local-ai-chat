import type { CharacterCard, GroupChat } from "./types/domain";

export function getRoomParticipants(
  room: Pick<GroupChat, "participantIds">,
  characters: CharacterCard[]
) {
  const charactersById = new Map(characters.map((character) => [character.id, character]));
  const seenIds = new Set<string>();

  return room.participantIds.flatMap((participantId) => {
    if (seenIds.has(participantId)) {
      return [];
    }

    seenIds.add(participantId);
    const character = charactersById.get(participantId);
    return character ? [character] : [];
  });
}
