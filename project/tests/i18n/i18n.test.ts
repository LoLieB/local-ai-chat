import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

function run(script: string) {
  const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], { cwd: process.cwd(), encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function localeScript(saved: string | null, language: string, preferred: string) {
  return `Object.defineProperty(globalThis, "navigator", { value: { language: ${JSON.stringify(language)}, languages: [${JSON.stringify(preferred)}] }, configurable: true });
    globalThis.localStorage = { getItem: () => ${JSON.stringify(saved)}, setItem: () => {} };
    const i = await import("./src/i18n/index.ts"); console.log(i.getLocale());`;
}

test("saved choice wins; otherwise use the preferred browser language", () => {
  assert.equal(run(localeScript("en-US", "ru-RU", "ru-RU")), "en-US");
  assert.equal(run(localeScript(null, "en-US", "ru")), "ru-RU");
  assert.equal(run(localeScript(null, "ru-RU", "fr-FR")), "en-US");
  assert.equal(run('delete globalThis.navigator; delete globalThis.localStorage; const i = await import("./src/i18n/index.ts"); console.log(i.getLocale());'), "en-US");
});

test("translation, placeholders, plural forms and existing notifications follow locale", () => {
  assert.equal(run(`globalThis.localStorage = { getItem: () => null, setItem: () => {} };
    const i = await import("./src/i18n/index.ts");
    i.setLocale("ru-RU"); const previous = i.t("Удалить чат «{p0}»?", { p0: "Chat X" });
    if (i.pluralCount("participants", 21) !== "21 участник") throw Error("Russian plural");
    if (i.pluralCount("participants", 22) !== "22 участника") throw Error("Russian plural few");
    i.setLocale("en-US");
    if (i.t("Войти") !== "Sign in") throw Error("translation");
    if (i.pluralCount("participants", 1) !== "1 participant" || i.pluralCount("participants", 2) !== "2 participants") throw Error("English plural");
    if (i.localizeMessage(previous) !== i.t("Удалить чат «{p0}»?", { p0: "Chat X" })) throw Error("notification: " + i.localizeMessage(previous));
    if (i.localizeMessage("arbitrary user content") !== "arbitrary user content") throw Error("fallback");
    console.log("ok");`), "ok");
});
