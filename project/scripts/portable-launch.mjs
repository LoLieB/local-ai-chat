import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createLogSession } from "./log-session.mjs";
import {
  REQUIRED_DEPENDENCY_FILES,
  REQUIRED_PROJECT_FILES,
  SUPPORTED_NODE_RANGE,
  assertSupportedPortablePlatform,
  checkPortAvailable,
  createLanUrls,
  createDependencyFingerprint,
  findMissingFiles,
  getPrivateLanIpv4Addresses,
  isSupportedNodeVersion,
  parsePort
} from "./portable-core.mjs";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(scriptDir, "..");
const args = new Set(process.argv.slice(2));
const mode = args.has("--dev") ? "dev" : "app";
const checkOnly = args.has("--check");
const lanMode = args.has("--lan");
const host = lanMode ? "0.0.0.0" : "127.0.0.1";
const appPort = parsePort(process.env.PORT, 8787, "PORT");
const vitePort = parsePort(process.env.VITE_PORT, 5173, "VITE_PORT");
const displayHost = "localhost";
const appUrl = mode === "dev"
  ? `http://${displayHost}:${vitePort}/`
  : `http://${displayHost}:${appPort}/`;

process.chdir(projectRoot);

const logSession = createLogSession("portable-launch", "portable");
let activeChild = null;
let shuttingDown = false;

function lanUrls() {
  return lanMode ? createLanUrls(getPrivateLanIpv4Addresses(), appPort) : [];
}

function logAccessUrls() {
  logSession.log(`Local URL: ${appUrl}`);

  if (!lanMode) {
    logSession.log("Network access is disabled. Use --lan to share only on a trusted local network.");
    return;
  }

  const urls = lanUrls();
  if (urls.length) {
    for (const entry of urls) {
      logSession.log(`LAN URL (${entry.name}): ${entry.url}`);
    }
  } else {
    logSession.log("LAN URL: no private IPv4 address was found on an active adapter.");
  }

  logSession.log("LAN security warning: change the preconfigured administrator password before sharing this service.");
  logSession.log("If another device cannot connect, allow port 8787 in Windows Firewall for a Private network. No firewall rule was added automatically.");
}

function formatError(error) {
  return error instanceof Error ? error.stack || error.message : String(error);
}

function portableEnv(overrides = {}) {
  const runtimeDir = dirname(process.execPath);
  return {
    ...process.env,
    PATH: `${runtimeDir};${process.env.PATH || ""}`,
    npm_config_cache: resolve(projectRoot, "runtime", "npm-cache"),
    npm_config_audit: "false",
    npm_config_fund: "false",
    ...overrides
  };
}

function run(command, commandArgs, { label, env = portableEnv(), inheritStdin = false } = {}) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, commandArgs, {
      cwd: projectRoot,
      env,
      shell: false,
      windowsHide: true,
      stdio: [inheritStdin ? "inherit" : "ignore", "pipe", "pipe"]
    });

    logSession.attachChild(child, label || "RUN");
    child.once("error", rejectRun);
    child.once("exit", (code) => {
      if (code === 0) {
        resolveRun(code);
        return;
      }
      rejectRun(new Error(`${label || command} exited with code ${code ?? "unknown"}.`));
    });
  });
}

function findNpmCli() {
  const candidates = [
    process.env.LOCAL_AI_CHAT_NPM_CLI,
    join(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js")
  ].filter(Boolean);

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return resolve(candidate);
    }
  }

  const systemRoot = process.env.SystemRoot || "C:\\Windows";
  const whereExe = join(systemRoot, "System32", "where.exe");
  if (existsSync(whereExe)) {
    const result = spawnSync(whereExe, ["npm.cmd"], {
      encoding: "utf8",
      windowsHide: true
    });
    if (result.status === 0) {
      for (const line of result.stdout.split(/\r?\n/).filter(Boolean)) {
        const candidate = join(dirname(line.trim()), "node_modules", "npm", "bin", "npm-cli.js");
        if (existsSync(candidate)) {
          return resolve(candidate);
        }
      }
    }
  }

  return null;
}

function dependencyFingerprint() {
  const manifest = readFileSync(resolve(projectRoot, "package.json"));
  const lockfile = readFileSync(resolve(projectRoot, "package-lock.json"));
  return createDependencyFingerprint(manifest, lockfile);
}

function dependencyStatePath() {
  return resolve(projectRoot, "runtime", "state", "dependencies.sha256");
}

function portableSessionPath() {
  return resolve(projectRoot, "runtime", "state", "portable-session.json");
}

function writePortableSession() {
  const sessionPath = portableSessionPath();
  mkdirSync(dirname(sessionPath), { recursive: true });
  writeFileSync(sessionPath, `${JSON.stringify({
    launcherPid: process.pid,
    mode,
    lanMode,
    bindHost: host,
    port: mode === "dev" ? vitePort : appPort,
    backendPort: appPort,
    localUrl: appUrl,
    startedAt: new Date().toISOString()
  }, null, 2)}\n`, "utf8");
}

function clearPortableSession() {
  const sessionPath = portableSessionPath();
  try {
    const session = JSON.parse(readFileSync(sessionPath, "utf8"));
    if (session.launcherPid === process.pid) {
      rmSync(sessionPath, { force: true });
    }
  } catch {
    // Missing or stale session state is handled by the stop helper.
  }
}

function readDependencyState() {
  try {
    return readFileSync(dependencyStatePath(), "utf8").trim();
  } catch {
    return "";
  }
}

function writeDependencyState(fingerprint) {
  const statePath = dependencyStatePath();
  mkdirSync(dirname(statePath), { recursive: true });
  writeFileSync(statePath, `${fingerprint}\n`, "utf8");
}

async function validateProjectFiles() {
  const missing = await findMissingFiles(projectRoot, REQUIRED_PROJECT_FILES);
  if (missing.length) {
    throw new Error(`Required project files are missing:\n- ${missing.join("\n- ")}`);
  }
}

async function installDependencies(npmCli, reason) {
  logSession.log(`Restoring npm dependencies: ${reason}`);
  logSession.log("This may require an internet connection if the portable npm cache is empty.");
  await run(process.execPath, [
    npmCli,
    "ci",
    "--include=dev",
    "--prefer-offline",
    "--no-audit",
    "--no-fund"
  ], {
    label: "NPM"
  });
}

async function verifyDependencies() {
  const npmCli = findNpmCli();
  if (!npmCli) {
    throw new Error(
      "npm was not found next to the selected Node.js runtime. " +
      "Use the complete portable Node ZIP or install Node.js with npm."
    );
  }

  logSession.log(`npm CLI: ${npmCli}`);
  const fingerprint = dependencyFingerprint();
  const savedFingerprint = readDependencyState();
  let missing = await findMissingFiles(projectRoot, REQUIRED_DEPENDENCY_FILES);

  if (missing.length) {
    await installDependencies(npmCli, `missing files: ${missing.join(", ")}`);
  } else if (savedFingerprint && savedFingerprint !== fingerprint) {
    await installDependencies(npmCli, "package.json or package-lock.json changed");
  } else if (!savedFingerprint) {
    logSession.log("No dependency state marker found; validating the copied node_modules tree...");
    try {
      await run(process.execPath, [npmCli, "ls", "--depth=0", "--silent"], { label: "NPM-CHECK" });
    } catch {
      await installDependencies(npmCli, "npm dependency validation failed");
    }
  }

  missing = await findMissingFiles(projectRoot, REQUIRED_DEPENDENCY_FILES);
  if (missing.length) {
    throw new Error(`npm dependencies are still incomplete after repair:\n- ${missing.join("\n- ")}`);
  }

  await run(process.execPath, [resolve(projectRoot, "node_modules", "vite", "bin", "vite.js"), "--version"], {
    label: "VITE-CHECK"
  });
  writeDependencyState(fingerprint);
  logSession.log("npm dependencies are ready.");
}

async function validatePorts() {
  const ports = mode === "dev"
    ? [
        { label: "backend", port: appPort },
        { label: "Vite frontend", port: vitePort }
      ]
    : [{ label: "application", port: appPort }];

  for (const item of ports) {
    const result = await checkPortAvailable({ host, port: item.port });
    if (!result.available) {
      const code = result.error && "code" in result.error ? result.error.code : "unknown";
      throw new Error(`${item.label} port ${item.port} is unavailable on ${host} (${code}).`);
    }
    logSession.log(`Port ready: ${host}:${item.port} (${item.label})`);
  }
}

function shutdown(signal = "SIGTERM") {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  if (activeChild && !activeChild.killed) {
    activeChild.kill(signal);
  }
}

function launchApplication() {
  const childArgs = mode === "dev"
    ? [resolve(projectRoot, "scripts", "dev.mjs"), ...(lanMode ? ["--lan"] : [])]
    : [resolve(projectRoot, "scripts", "run-lan.mjs")];
  const childEnv = portableEnv({
    HOST: host,
    SERVER_HOST: host,
    APP_LAN_HOST: displayHost,
    LOCAL_AI_CHAT_LAN_MODE: lanMode ? "1" : "0",
    LOCAL_AI_CHAT_BROWSER_URL: appUrl,
    PORT: String(appPort),
    VITE_PORT: String(vitePort),
    BACKEND_URL: `http://127.0.0.1:${appPort}`
  });

  logSession.log(`Starting ${mode === "dev" ? "development" : "local application"} mode.`);
  logAccessUrls();
  logSession.log("Keep this window open. Press Ctrl+C to stop.");

  activeChild = spawn(process.execPath, childArgs, {
    cwd: projectRoot,
    env: childEnv,
    shell: false,
    windowsHide: true,
    stdio: ["inherit", "pipe", "pipe"]
  });
  writePortableSession();
  logSession.attachChild(activeChild, mode === "dev" ? "DEV" : "APP");

  activeChild.once("error", (error) => {
    logSession.error(formatError(error));
    clearPortableSession();
  });

  activeChild.once("exit", (code) => {
    clearPortableSession();
    logSession.log(`Application process exited with code ${code ?? "unknown"}.`);
    logSession.close();
    process.exit(code ?? 1);
  });
}

async function main() {
  logSession.log(`Portable launcher log: ${logSession.logPath}`);
  logSession.log(`Project root: ${projectRoot}`);
  logSession.log(`Node source: ${process.env.LOCAL_AI_CHAT_NODE_SOURCE || "unknown"}`);
  logSession.log(`Node executable: ${process.execPath}`);
  logSession.log(`Node version: ${process.version}`);

  if (!isSupportedNodeVersion(process.version)) {
    throw new Error(`Unsupported Node.js ${process.version}. Required: ${SUPPORTED_NODE_RANGE}.`);
  }

  assertSupportedPortablePlatform(process.platform, process.arch);

  await validateProjectFiles();
  await verifyDependencies();
  await validatePorts();

  if (checkOnly) {
    logSession.log("Portable preflight completed successfully.");
    logSession.log(`Stable URL: ${appUrl}`);
    logSession.close();
    return;
  }

  launchApplication();
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("exit", clearPortableSession);

main().catch((error) => {
  clearPortableSession();
  logSession.error("Portable launcher failed.");
  logSession.error(formatError(error));
  logSession.error(`See log: ${logSession.logPath}`);
  logSession.close();
  process.exitCode = 1;
});
