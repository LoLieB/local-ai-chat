import { spawn } from "node:child_process";
import { getLanConfig } from "./lan-config.mjs";
import { resolveZrokCommand } from "./zrok-command.mjs";
import { createLogSession } from "./log-session.mjs";

const config = getLanConfig();
const target = config.port;
const zrokCommand = resolveZrokCommand();
const logSession = createLogSession("local-ai-chat-zrok-share");

function getZrokEnv() {
  return config.zrokApiEndpoint
    ? { ...process.env, ZROK_API_ENDPOINT: config.zrokApiEndpoint }
    : process.env;
}

logSession.log(`Log file: ${logSession.logPath}`);
logSession.log("Starting zrok public share for Local AI Chat...");
logSession.log(`Target: ${target}`);
logSession.log(`Using zrok: ${zrokCommand}`);
logSession.log("Keep this window open while you use the remote link.");
logSession.log("");

const child = spawn(zrokCommand, ["share", "public", target], {
  stdio: ["inherit", "pipe", "pipe"],
  shell: false,
  env: getZrokEnv()
});
logSession.attachChild(child, "TUNNEL");

child.on("exit", (code) => {
  if (code && code !== 0) {
    logSession.error(`zrok share exited with code ${code}.`);
    logSession.error(`Saved log: ${logSession.logPath}`);
  }
  logSession.close();
  process.exit(code ?? 1);
});

child.on("error", (error) => {
  logSession.error("Failed to start zrok.");
  logSession.error(error instanceof Error ? error.message : String(error));
  logSession.error(`Saved log: ${logSession.logPath}`);
  logSession.close();
  process.exit(1);
});
