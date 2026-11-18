import { spawn } from "node:child_process";
import { getLanConfig } from "./lan-config.mjs";
import { resolveZrokCommand } from "./zrok-command.mjs";
import { createLogSession } from "./log-session.mjs";

const config = getLanConfig();
const nodeCommand = process.execPath;
const localhostUrl = `http://127.0.0.1:${config.port}`;
const publicHealthUrl = `${localhostUrl}/api/health`;
const zrokTarget = config.port;
const zrokCommand = resolveZrokCommand();
const logSession = createLogSession("local-ai-chat-zrok");

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
  const startTime = Date.now();

  while (Date.now() - startTime < timeoutMs) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(2500) });
      if (response.ok) {
        return true;
      }
    } catch {
      // Server is still booting.
    }

    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  throw new Error(`Server did not become healthy within ${timeoutMs}ms.`);
}

function safeKill(child) {
  if (!child || child.killed) {
    return;
  }

  try {
    child.kill();
  } catch {
    // Ignore cleanup errors.
  }
}

function getZrokEnv() {
  return config.zrokApiEndpoint
    ? { ...process.env, ZROK_API_ENDPOINT: config.zrokApiEndpoint }
    : process.env;
}

logSession.log(`Log file: ${logSession.logPath}`);
logSession.log("Building Local AI Chat for zrok public tunnel...");
await run(nodeCommand, ["node_modules/vite/bin/vite.js", "build"]);

logSession.log("");
logSession.log("Starting Local AI Chat server for zrok public access...");
logSession.log(`  Local host target: ${localhostUrl}`);
logSession.log("");

const serverProcess = spawn(nodeCommand, ["node_modules/tsx/dist/cli.mjs", "server/index.ts"], {
  stdio: ["inherit", "pipe", "pipe"],
  shell: false,
  env: {
    ...process.env,
    HOST: "0.0.0.0",
    PORT: config.port
  }
});
logSession.attachChild(serverProcess, "SERVER");

let tunnelProcess = null;
let shuttingDown = false;

function shutdown(code = 0) {
  if (shuttingDown) {
    return;
  }

  shuttingDown = true;
  safeKill(tunnelProcess);
  safeKill(serverProcess);
  setTimeout(() => {
    logSession.close();
    process.exit(code);
  }, 200);
}

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));

serverProcess.on("exit", (code) => {
  if (shuttingDown) {
    return;
  }

  logSession.error("");
  logSession.error(`Local AI Chat server exited with code ${code ?? "unknown"}.`);
  logSession.error(`Saved log: ${logSession.logPath}`);
  shutdown(code ?? 1);
});

serverProcess.on("error", (error) => {
  if (shuttingDown) {
    return;
  }

  logSession.error("");
  logSession.error("Failed to start Local AI Chat server.");
  logSession.error(error instanceof Error ? error.message : String(error));
  logSession.error(`Saved log: ${logSession.logPath}`);
  shutdown(1);
});

try {
  await waitForHealth(publicHealthUrl);
} catch (error) {
  logSession.error("");
  logSession.error(error instanceof Error ? error.message : String(error));
  logSession.error(`Saved log: ${logSession.logPath}`);
  shutdown(1);
}

logSession.log("Server is healthy. Starting zrok public share...");
logSession.log(`Using zrok: ${zrokCommand}`);
logSession.log(`zrok target: ${zrokTarget}`);
logSession.log("");

tunnelProcess = spawn(
  zrokCommand,
  ["share", "public", zrokTarget],
  {
    stdio: ["inherit", "pipe", "pipe"],
    shell: false,
    env: getZrokEnv()
  }
);
logSession.attachChild(tunnelProcess, "TUNNEL");

tunnelProcess.on("exit", (code) => {
  if (shuttingDown) {
    return;
  }

  logSession.error("");
  logSession.error(`zrok public share exited with code ${code ?? "unknown"}.`);
  logSession.error(`Saved log: ${logSession.logPath}`);
  shutdown(code ?? 1);
});

tunnelProcess.on("error", (error) => {
  if (shuttingDown) {
    return;
  }

  logSession.error("");
  logSession.error("Failed to start zrok.");
  logSession.error("Put zrok.exe in runtime\\zrok\\zrok.exe or install zrok in PATH.");
  logSession.error(error instanceof Error ? error.message : String(error));
  logSession.error(`Saved log: ${logSession.logPath}`);
  shutdown(1);
});

logSession.log("zrok public mode is running.");
logSession.log("Keep this window open while the remote link is in use.");
logSession.log("Press Ctrl+C to stop both the local server and the tunnel.");
logSession.log("");
