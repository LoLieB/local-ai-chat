import { spawn } from "node:child_process";
import { createLanUrls, getPrivateLanIpv4Addresses } from "./portable-core.mjs";
import { getLanConfig } from "./lan-config.mjs";
import { createLogSession } from "./log-session.mjs";
import { calculateBackoffMs, createRestartLimiter, safeKill } from "./process-supervisor.mjs";
import { probeUrl } from "./tunnel-probes.mjs";

const config = getLanConfig();
const lanMode = process.env.LOCAL_AI_CHAT_LAN_MODE === "1";
const displayHost = "localhost";
const nodeCommand = process.execPath;
const serverHost = process.env.SERVER_HOST || (lanMode ? "0.0.0.0" : "127.0.0.1");
const localhostUrl = `http://127.0.0.1:${config.port}`;
const readyUrl = `${localhostUrl}/api/ready`;
const logSession = createLogSession("local-ai-chat-lan");
const backendRestartLimiter = createRestartLimiter({ maxRestarts: 5, windowMs: 120000 });

let serverProcess = null;
let shuttingDown = false;
let backendRestartTimeout = null;

function logAccessUrls() {
  logSession.log(`Local URL: http://localhost:${config.port}/`);
  if (!lanMode) {
    return;
  }

  const urls = createLanUrls(getPrivateLanIpv4Addresses(), config.port);
  if (urls.length) {
    for (const entry of urls) {
      logSession.log(`LAN URL (${entry.name}): ${entry.url}`);
    }
  } else {
    logSession.log("LAN URL: no private IPv4 address was found on an active adapter.");
  }
}

function openLocalBrowser() {
  if (!lanMode || process.env.LOCAL_AI_CHAT_AUTO_OPEN_BROWSER === "0" || process.platform !== "win32") {
    return;
  }

  const browserUrl = process.env.LOCAL_AI_CHAT_BROWSER_URL || `http://localhost:${config.port}/`;
  const command = process.env.ComSpec || "cmd.exe";
  const child = spawn(command, ["/d", "/c", "start", "", browserUrl], {
    detached: true,
    stdio: "ignore",
    windowsHide: true
  });
  child.unref();
}

function run(command, args, env = process.env) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ["inherit", "pipe", "pipe"],
      shell: false,
      env
    });
    logSession.attachChild(child, "RUN");

    child.on("exit", (code) => {
      if (code === 0) {
        resolve();
        return;
      }

      reject(new Error(`Command failed with exit code ${code ?? "unknown"}`));
    });
  });
}

async function waitForHealth(url, timeoutMs = 20000) {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    const result = await probeUrl(url, 2500);
    if (result.status === "200") {
      return true;
    }

    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  throw new Error(`Server did not become ready within ${timeoutMs}ms.`);
}

function clearBackendRestartTimeout() {
  if (backendRestartTimeout) {
    clearTimeout(backendRestartTimeout);
    backendRestartTimeout = null;
  }
}

function shutdown(code = 0) {
  if (shuttingDown) {
    return;
  }

  shuttingDown = true;
  clearBackendRestartTimeout();
  safeKill(serverProcess);
  setTimeout(() => {
    logSession.close();
    process.exit(code);
  }, 200);
}

async function recoverBackendAfterSpawn(reason) {
  logSession.log(`Waiting for backend readiness after restart: ${reason}`);
  await waitForHealth(readyUrl);
  logSession.log("Backend healthy again.");
}

function scheduleBackendRestart(reason) {
  if (shuttingDown) {
    return;
  }

  clearBackendRestartTimeout();

  const allowed = backendRestartLimiter.record();
  const restartCount = backendRestartLimiter.count();
  if (!allowed) {
    logSession.error(`Backend restart limit exceeded after: ${reason}.`);
    logSession.error(`Saved log: ${logSession.logPath}`);
    shutdown(1);
    return;
  }

  const delayMs = calculateBackoffMs(restartCount, 1000, 10000);
  backendRestartTimeout = setTimeout(() => {
    backendRestartTimeout = null;
    logSession.log(`Restarting backend after: ${reason}`);
    spawnBackend(`restart:${reason}`).catch((error) => {
      logSession.error("Backend restart flow failed.");
      logSession.error(error instanceof Error ? error.message : String(error));
      scheduleBackendRestart("restart verification failed");
    });
  }, delayMs);
}

async function spawnBackend(reason = "initial") {
  serverProcess = spawn(nodeCommand, ["node_modules/tsx/dist/cli.mjs", "server/index.ts"], {
    stdio: ["inherit", "pipe", "pipe"],
    shell: false,
    env: {
      ...process.env,
      HOST: serverHost,
      PORT: config.port
    }
  });
  logSession.attachChild(serverProcess, "SERVER");

  serverProcess.on("exit", (code) => {
    if (shuttingDown) {
      return;
    }

    logSession.error(`Local AI Chat server exited with code ${code ?? "unknown"}.`);
    serverProcess = null;
    scheduleBackendRestart(`backend exited (${code ?? "unknown"})`);
  });

  serverProcess.on("error", (error) => {
    if (shuttingDown) {
      return;
    }

    logSession.error("Failed to start Local AI Chat server.");
    logSession.error(error instanceof Error ? error.message : String(error));
    serverProcess = null;
    scheduleBackendRestart("backend start error");
  });

  await recoverBackendAfterSpawn(reason);
}

logSession.log(`Log file: ${logSession.logPath}`);
logSession.log("Building Local AI Chat production bundle...");
await run(nodeCommand, ["node_modules/vite/bin/vite.js", "build"]);

logSession.log("");
logSession.log("Starting Local AI Chat server on:");
logSession.log(`  http://${displayHost}:${config.port}`);
logAccessUrls();
logSession.log("");
logSession.log("Keep this window open while the site is in use.");
logSession.log("Press Ctrl+C to stop.");
logSession.log("");

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));

try {
  await spawnBackend();
  openLocalBrowser();
} catch (error) {
  logSession.error("Initial LAN backend start failed.");
  logSession.error(error instanceof Error ? error.message : String(error));
  scheduleBackendRestart("initial backend boot failed");
}

await new Promise(() => {});
