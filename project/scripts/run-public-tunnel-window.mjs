import { spawn } from "node:child_process";
import { createLogSession } from "./log-session.mjs";
import {
  extractLocalTunnelSubdomain,
  writeTunnelWindowStatus
} from "./localtunnel-state.mjs";
import { resolveLocalTunnelCommand } from "./localtunnel-command.mjs";
import { safeKill } from "./process-supervisor.mjs";

function readArg(name, fallback = "") {
  const index = process.argv.indexOf(name);
  if (index === -1) {
    return fallback;
  }

  return process.argv[index + 1] ?? fallback;
}

const attemptId = readArg("--attempt-id");
const preferredUrl = readArg("--preferred-url");
const mode = readArg("--mode", "random");
const port = readArg("--port", "8787");
const expectedSubdomain = extractLocalTunnelSubdomain(preferredUrl);
const localTunnelCommand = resolveLocalTunnelCommand();
const logSession = createLogSession("localtunnel-window", "tunnel-temp");

let tunnelChild = null;
let settled = false;

function usesCmdLauncher(command) {
  return typeof command === "string" && command.toLowerCase().endsWith(".cmd");
}

function writeStatus(patch) {
  writeTunnelWindowStatus({
    attemptId,
    mode,
    preferredUrl,
    expectedSubdomain,
    actualSubdomain: "",
    publishedUrl: "",
    state: "starting",
    pid: process.pid,
    logPath: logSession.logPath,
    error: "",
    exitCode: null,
    startedAt: new Date().toISOString(),
    ...patch
  });
}

function finalize(state, patch = {}) {
  if (settled) {
    return;
  }

  settled = true;
  writeStatus({
    state,
    exitedAt: new Date().toISOString(),
    ...patch
  });
  setTimeout(() => {
    logSession.close();
    process.exit(typeof patch.exitCode === "number" ? patch.exitCode : 0);
  }, 50);
}

const args = [...localTunnelCommand.args, "--port", String(port)];
if (expectedSubdomain) {
  args.push("--subdomain", expectedSubdomain);
}

logSession.log(`Tunnel window attempt=${attemptId || "-"} mode=${mode} preferred=${preferredUrl || "-"}`);
writeStatus({});

try {
  tunnelChild = spawn(localTunnelCommand.command, args, {
    stdio: ["inherit", "pipe", "pipe"],
    shell: usesCmdLauncher(localTunnelCommand.command)
  });
} catch (error) {
  finalize("error", {
    exitCode: 1,
    error: error instanceof Error ? error.message : String(error)
  });
}

if (!tunnelChild) {
  finalize("error", {
    exitCode: 1,
    error: "Tunnel child process was not created."
  });
} else {
  logSession.attachChild(tunnelChild, "TUNNEL", {
    onStdoutLine(line) {
      const match = line.match(/your url is:\s*(https?:\/\/\S+)/i);
      if (!match) {
        return;
      }

      const publishedUrl = match[1];
      const actualSubdomain = extractLocalTunnelSubdomain(publishedUrl);
      writeStatus({
        actualSubdomain,
        publishedUrl,
        publishedAt: new Date().toISOString(),
        state: "published"
      });
    }
  });

  tunnelChild.on("exit", (code) => {
    finalize("exited", { exitCode: code ?? 0 });
  });

  tunnelChild.on("error", (error) => {
    finalize("error", {
      exitCode: 1,
      error: error instanceof Error ? error.message : String(error)
    });
  });
}

process.on("SIGINT", () => {
  safeKill(tunnelChild);
  finalize("terminated", { exitCode: 0 });
});

process.on("SIGTERM", () => {
  safeKill(tunnelChild);
  finalize("terminated", { exitCode: 0 });
});
