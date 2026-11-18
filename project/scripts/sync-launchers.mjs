import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { getLanConfig } from "./lan-config.mjs";

const cwd = process.cwd();
const config = getLanConfig(cwd);

const launcherUrl = `http://${config.appLanHost}:${config.port}`;

const openCmd = `@echo off
start "" "${launcherUrl}"
`;

const openHtml = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta http-equiv="refresh" content="0; url=${launcherUrl}" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Open Local AI Chat</title>
  </head>
  <body>
    <p>Opening <a href="${launcherUrl}">Local AI Chat</a>...</p>
  </body>
</html>
`;

writeFileSync(resolve(cwd, "open-local-ai-chat.cmd"), openCmd, "utf8");
writeFileSync(resolve(cwd, "open-local-ai-chat.html"), openHtml, "utf8");

console.log(`Launchers synced to ${launcherUrl}`);
