import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("Group Chat hero chips are wired to active room state", async () => {
  const source = await readFile(
    new URL("../../src/components/GroupChatTab.tsx", import.meta.url),
    "utf8"
  );
  const heroMeta = source.match(/<div className=\{styles\.groupHeroMeta\}>([\s\S]*?)<\/div>/)?.[1] || "";

  assert.match(heroMeta, /\{participantCountLabel\}/);
  assert.match(heroMeta, /\{responseModeLabel\}/);
  assert.doesNotMatch(heroMeta, />0 участников</);
  assert.doesNotMatch(heroMeta, />один спикер</);
});
