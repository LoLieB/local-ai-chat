import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, rmdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { defaultSettings, readSettings, validateSettingsPatch, writeSettings } from "../../server/storage/settingsStore.ts";

test("model profiles validate complete supported options and persist without replacing defaults", async () => {
  const directory = await mkdtemp(join(tmpdir(), "model-profiles-"));
  const path = join(directory, "settings.json");
  const profile = { ...defaultSettings, id: "local", name: "Local", modelId: "profile-model", temperature: 0.2 };
  try {
    const next = validateSettingsPatch(defaultSettings, { modelProfiles: [profile] });
    assert.equal(next.modelId, defaultSettings.modelId);
    assert.equal(next.temperature, defaultSettings.temperature);
    await writeSettings(next, path);
    assert.deepEqual((await readSettings(path)).modelProfiles, [profile]);
    const before = await readFile(path, "utf8");
    for (const modelProfiles of [null, {}, [profile, profile], [{ ...profile, modelProfiles: [] }], [{ ...profile, name: " " }], [{ ...profile, maxTokens: 0 }], [{ ...profile, baseUrl: "file:///model" }], [{ ...profile, top_k: 5 }], [{ id: "missing", name: "Missing" }]]) {
      await assert.rejects(writeSettings({ ...next, modelProfiles } as never, path));
      assert.equal(await readFile(path, "utf8"), before);
    }
    assert.deepEqual(validateSettingsPatch(next, { modelProfiles: [] }).modelProfiles, []);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("settings patches preserve omitted values and accept supported boundaries", () => {
  const current = { ...defaultSettings, modelId: "existing-model" };
  const next = validateSettingsPatch(current, { temperature: 0, maxTokens: 1, streaming: false });
  assert.deepEqual(next, { ...current, temperature: 0, maxTokens: 1, streaming: false });
  assert.equal(current.temperature, defaultSettings.temperature);
  assert.deepEqual(validateSettingsPatch(current, {}), current);
  assert.equal(validateSettingsPatch(current, { temperature: 2, maxTokens: 131072 }).maxTokens, 131072);
  for (const baseUrl of ["http://localhost:1234/v1", "https://example.test/v1", "http://192.0.2.10:1234/v1"]) {
    assert.equal(validateSettingsPatch(current, { baseUrl, modelId: "" }).baseUrl, baseUrl);
  }
});

test("settings validation rejects malformed payloads and unknown fields", () => {
  for (const payload of [null, [], true, 1, "settings", { extra: true }, JSON.parse('{"__proto__":{}}')]) {
    assert.throws(() => validateSettingsPatch(defaultSettings, payload));
  }
});

test("settings validation rejects unsafe URLs and incorrect field types or ranges", () => {
  const invalid = {
    baseUrl: [null, 123, "", "not a URL", "/v1", "file:///tmp/model", "ftp://example.test", "http://user:secret@example.test/v1"],
    modelId: [null, 123, {}],
    streaming: [null, "false", 0],
    temperature: [null, "0.7", NaN, Infinity, -Infinity, -0.1, 2.1],
    maxTokens: [null, "1024", NaN, Infinity, -1, 0, 1.5, 131073]
  };
  for (const [key, values] of Object.entries(invalid)) {
    for (const value of values) {
      assert.throws(() => validateSettingsPatch(defaultSettings, { [key]: value }), undefined, key);
    }
  }
});

test("isolated settings persistence supports legacy partial files and rejects writes before modification", async () => {
  const directory = await mkdtemp(join(tmpdir(), "local-ai-chat-settings-"));
  const filePath = join(directory, "settings.json");
  try {
    assert.deepEqual(await readSettings(filePath), defaultSettings);
    await writeFile(filePath, JSON.stringify({ modelId: "legacy-model" }), "utf8");
    assert.deepEqual(await readSettings(filePath), { ...defaultSettings, modelId: "legacy-model" });
    const settings = validateSettingsPatch(defaultSettings, { modelId: "saved-model", streaming: false });
    assert.deepEqual(await writeSettings(settings, filePath), settings);
    assert.deepEqual(await readSettings(filePath), settings);
    const before = await readFile(filePath, "utf8");
    await assert.rejects(writeSettings({ ...settings, maxTokens: Infinity }, filePath));
    assert.equal(await readFile(filePath, "utf8"), before);
  } finally {
    await rm(filePath, { force: true });
    await rmdir(directory);
  }
});
