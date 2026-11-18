import { spawn } from "node:child_process";
import { getLanConfig } from "./lan-config.mjs";
import { resolveLocalTunnelCommand } from "./localtunnel-command.mjs";
import { createLogSession } from "./log-session.mjs";
import {
  extractLocalTunnelSubdomain,
  getCurrentPublicUrlFilePath,
  getLocalTunnelStateFilePath,
  getPublicRouteStatusFilePath,
  getTunnelWindowStatusFilePath,
  readLastLocalTunnelUrl,
  readTunnelWindowStatus,
  updatePublicRouteStatus,
  writeLastLocalTunnelUrl
} from "./localtunnel-state.mjs";
import { calculateBackoffMs, createRestartLimiter, safeKill } from "./process-supervisor.mjs";
import { formatProbeResult, probePublicApp, probeUrl, resolveDistAssetProbePath } from "./tunnel-probes.mjs";

const config = getLanConfig();
const nodeCommand = process.execPath;
const localhostUrl = `http://127.0.0.1:${config.port}`;
const localHealthUrl = `${localhostUrl}/api/health`;
const localReadyUrl = `${localhostUrl}/api/ready`;
const localTunnelTarget = config.port;
const localTunnelCommand = resolveLocalTunnelCommand();
const logSession = createLogSession("local-ai-chat-public");
const tunnelTempSession = createLogSession("localtunnel-heartbeat", "tunnel-temp", { echoConsole: false });
const stateFilePath = getLocalTunnelStateFilePath();
const currentPublicUrlFilePath = getCurrentPublicUrlFilePath();
const publicRouteStatusFilePath = getPublicRouteStatusFilePath();
const tunnelWindowStatusFilePath = getTunnelWindowStatusFilePath();

const TUNNEL_HEARTBEAT_MS = 1000;
const RESTART_DELAY_MS = 1500;
const TUNNEL_URL_TIMEOUT_MS = 8000;
const PUBLIC_API_FAILURE_THRESHOLD = 3;
const PUBLIC_PAGE_FAILURE_THRESHOLD = 2;
const LOCAL_FAILURE_THRESHOLD = 3;
const SLOW_RESPONSE_MS = 1500;
const SLOW_RESPONSE_LIMIT = 4;
const RANDOM_FALLBACK_AFTER_PREFERRED_ROUNDS = 1;
const PREFERRED_RECOVERY_CHECK_MS = 30000;
const PREFERRED_REDIRECT_GRACE_MS = 120000;
const PREFERRED_RECOVERY_PUBLISH_TIMEOUT_MS = 15000;

let publicTunnelUrl = "";
let heartbeatInterval = null;
let tunnelRestartTimeout = null;
let backendRestartTimeout = null;
let publishTimeout = null;
let tunnelProcess = null;
let fallbackTunnelProcess = null;
let recoveryTunnelProcess = null;
let serverProcess = null;
let shuttingDown = false;
let currentTunnelMode = "random";
let tunnelPublishedUrl = false;
let expectedPreferredSubdomain = "";
let restartCandidateQueue = [];
let suppressNextTunnelExitRestart = false;
let suppressNextBackendExitRestart = false;
let publicApiFailureCount = 0;
let publicHtmlFailureCount = 0;
let publicAssetFailureCount = 0;
let localFailureCount = 0;
let slowProbeCount = 0;
let heartbeatInFlight = false;
let assetProbePath = "";
let preferredPoolRoundsWithoutSuccess = 0;
let preferredRecoveryInterval = null;
let preferredRecoveryInFlight = false;
let recoveryPublishTimeout = null;
let preferredRecoveredUrl = "";
let redirectAfterIso = "";
let fallbackPublicUrl = "";
let currentTunnelAttemptId = "";
let tunnelMonitorProcess = null;

const backendRestartLimiter = createRestartLimiter({ maxRestarts: 5, windowMs: 120000 });

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

function formatHeartbeatTime() {
  return new Date().toLocaleTimeString("ru-RU", { hour12: false });
}

function clearTunnelRestartTimeout() {
  if (tunnelRestartTimeout) {
    clearTimeout(tunnelRestartTimeout);
    tunnelRestartTimeout = null;
  }
}

function clearBackendRestartTimeout() {
  if (backendRestartTimeout) {
    clearTimeout(backendRestartTimeout);
    backendRestartTimeout = null;
  }
}

function clearPublishTimeout() {
  if (publishTimeout) {
    clearTimeout(publishTimeout);
    publishTimeout = null;
  }
}

function clearRecoveryPublishTimeout() {
  if (recoveryPublishTimeout) {
    clearTimeout(recoveryPublishTimeout);
    recoveryPublishTimeout = null;
  }
}

function clearPreferredRecoveryInterval() {
  if (preferredRecoveryInterval) {
    clearInterval(preferredRecoveryInterval);
    preferredRecoveryInterval = null;
  }
}

function resetTunnelHealthCounters() {
  publicApiFailureCount = 0;
  publicHtmlFailureCount = 0;
  publicAssetFailureCount = 0;
  slowProbeCount = 0;
}

function usesCmdLauncher(command) {
  return typeof command === "string" && command.toLowerCase().endsWith(".cmd");
}

function psQuote(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function stopManagedProcess(processLike) {
  if (!processLike) {
    return;
  }

  if (typeof processLike.kill === "function") {
    safeKill(processLike);
    return;
  }

  const pid = Number(processLike.pid || 0);
  if (!pid) {
    return;
  }

  try {
    const killer = spawn("taskkill", ["/PID", String(pid), "/T", "/F"], {
      stdio: "ignore",
      shell: false
    });
    killer.unref();
  } catch {
    // Ignore cleanup failures during restart/shutdown.
  }
}

function createTunnelAttemptId() {
  return `attempt_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function launchTunnelMonitorWindow() {
  return new Promise((resolve, reject) => {
    const cmdScript = [
      "title LocalTunnel Monitor",
      `"${nodeCommand}" "scripts\\run-tunnel-monitor-window.mjs" "--log-path" "${tunnelTempSession.logPath}" "--status-path" "${tunnelWindowStatusFilePath}" "--title" "LocalTunnel Monitor"`
    ].join(" & ");
    const command = [
      "$process = Start-Process -FilePath",
      psQuote("cmd.exe"),
      "-ArgumentList @(",
      [psQuote("/k"), psQuote(cmdScript)].join(", "),
      ") -WorkingDirectory",
      psQuote(process.cwd()),
      "-WindowStyle Normal -PassThru;",
      "Write-Output $process.Id"
    ].join(" ");

    const launcher = spawn("powershell.exe", ["-NoProfile", "-Command", command], {
      stdio: ["ignore", "pipe", "pipe"],
      shell: false
    });

    let stdout = "";
    let stderr = "";

    launcher.stdout?.on("data", (chunk) => {
      stdout += chunk.toString();
    });

    launcher.stderr?.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    launcher.on("exit", (code) => {
      const pid = Number.parseInt(stdout.trim(), 10);
      if (code === 0 && Number.isFinite(pid) && pid > 0) {
        resolve({ pid });
        return;
      }

      reject(new Error(stderr.trim() || stdout.trim() || `Tunnel monitor launcher failed with code ${code ?? "unknown"}`));
    });

    launcher.on("error", (error) => {
      reject(error);
    });
  });
}

function launchTunnelWindow(preferredUrl = "") {
  return new Promise((resolve, reject) => {
    const attemptId = createTunnelAttemptId();
    const windowTitle = expectedPreferredSubdomain
      ? `LocalTunnel ${expectedPreferredSubdomain}`
      : "LocalTunnel random";
    const cmdScript = [
      `title ${windowTitle}`,
      `"${nodeCommand}" "scripts\\run-public-tunnel-window.mjs" "--attempt-id" "${attemptId}" "--mode" "${currentTunnelMode}" "--port" "${String(localTunnelTarget)}" "--preferred-url" "${preferredUrl || ""}"`
    ].join(" & ");
    const command = [
      "$process = Start-Process -FilePath",
      psQuote("cmd.exe"),
      "-ArgumentList @(",
      [
        psQuote("/k"),
        psQuote(cmdScript)
      ].join(", "),
      ") -WorkingDirectory",
      psQuote(process.cwd()),
      "-WindowStyle Normal -PassThru;",
      "Write-Output $process.Id"
    ].join(" ");

    const launcher = spawn("powershell.exe", ["-NoProfile", "-Command", command], {
      stdio: ["ignore", "pipe", "pipe"],
      shell: false
    });

    let stdout = "";
    let stderr = "";

    launcher.stdout?.on("data", (chunk) => {
      stdout += chunk.toString();
    });

    launcher.stderr?.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    launcher.on("exit", (code) => {
      const pid = Number.parseInt(stdout.trim(), 10);
      if (code === 0 && Number.isFinite(pid) && pid > 0) {
        resolve({ pid, attemptId });
        return;
      }

      reject(new Error(stderr.trim() || stdout.trim() || `Tunnel window launcher failed with code ${code ?? "unknown"}`));
    });

    launcher.on("error", (error) => {
      reject(error);
    });
  });
}

function syncTunnelProcessState() {
  if (!tunnelProcess || !currentTunnelAttemptId) {
    return;
  }

  const status = readTunnelWindowStatus();
  if (status.attemptId !== currentTunnelAttemptId) {
    return;
  }

  if (!tunnelPublishedUrl && status.state === "published" && status.publishedUrl) {
    const actualUrl = status.publishedUrl;
    const actualSubdomain = status.actualSubdomain || extractLocalTunnelSubdomain(actualUrl);
    if (expectedPreferredSubdomain && actualSubdomain !== expectedPreferredSubdomain) {
      logSession.error(
        `Requested LocalTunnel subdomain '${expectedPreferredSubdomain}', but service returned '${actualSubdomain || actualUrl}'.`
      );
      tunnelTempSession.error(
        `preferred-mismatch expected=${expectedPreferredSubdomain} actual=${actualSubdomain || actualUrl}`
      );
      scheduleTunnelRestart("preferred subdomain mismatch");
      return;
    }

    publicTunnelUrl = actualUrl;
    tunnelPublishedUrl = true;
    preferredPoolRoundsWithoutSuccess = 0;
    clearPublishTimeout();
    writeLastLocalTunnelUrl(publicTunnelUrl);
    if (currentTunnelMode === "random") {
      writeRouteStatus({
        activePublicUrl: actualUrl,
        temporaryPublicUrl: "",
        preferredPublicUrl: "",
        preferredRecoveredUrl: "",
        preferredRecoveredAt: "",
        redirectAfter: "",
        mode: "random-fallback"
      });
      startPreferredRecoveryLoop();
    } else {
      fallbackPublicUrl = "";
      resetRecoveryAnnouncement();
      writeRouteStatus({
        activePublicUrl: actualUrl,
        temporaryPublicUrl: "",
        preferredPublicUrl: actualUrl,
        preferredRecoveredUrl: "",
        preferredRecoveredAt: "",
        redirectAfter: "",
        mode: "preferred"
      });
      stopPreferredRecoveryLoop();
    }
    tunnelTempSession.log(`public-url ${publicTunnelUrl}`);
    tunnelTempSession.log(`state-file ${stateFilePath}`);
  }

  if (status.state === "error" || status.state === "exited" || status.state === "terminated") {
    if (tunnelProcess && status.attemptId === currentTunnelAttemptId) {
      tunnelProcess = null;
      publicTunnelUrl = "";
      tunnelPublishedUrl = false;
      currentTunnelAttemptId = "";
      expectedPreferredSubdomain = "";
      if (!shuttingDown) {
        logSession.error("");
        logSession.error(`LocalTunnel window ended with state=${status.state} code=${status.exitCode ?? "unknown"}.`);
        if (status.error) {
          logSession.error(status.error);
        }
        logSession.error("The Local AI Chat server is still running on the local port.");
        logSession.error(`Saved log: ${logSession.logPath}`);
        scheduleTunnelRestart(`tunnel window ${status.state}`);
      }
    }
  }
}

function isStrongFailureStatus(status) {
  return status === "408" || status === "502" || status === "504";
}

function isHtmlLikeContentType(contentType) {
  return (contentType || "").toLowerCase().includes("text/html");
}

function refreshAssetProbePath() {
  assetProbePath = resolveDistAssetProbePath();
  return assetProbePath;
}

function isoAfter(delayMs) {
  return new Date(Date.now() + delayMs).toISOString();
}

function resetRecoveryAnnouncement() {
  preferredRecoveredUrl = "";
  redirectAfterIso = "";
}

function writeRouteStatus(patch) {
  updatePublicRouteStatus({
    activePublicUrl: "",
    temporaryPublicUrl: "",
    preferredPublicUrl: "",
    preferredRecoveredUrl: "",
    preferredRecoveredAt: "",
    redirectAfter: "",
    mode: "idle",
    ...patch
  });
}

function buildLocalTunnelArgs(preferredUrl = "") {
  const args = [...localTunnelCommand.args, "--port", String(localTunnelTarget)];
  const preferredSubdomain = extractLocalTunnelSubdomain(preferredUrl);
  if (preferredSubdomain) {
    args.push("--subdomain", preferredSubdomain);
    currentTunnelMode = `preferred:${preferredSubdomain}`;
    expectedPreferredSubdomain = preferredSubdomain;
  } else {
    currentTunnelMode = "random";
    expectedPreferredSubdomain = "";
  }
  return args;
}

function buildPreferredUrlCandidates() {
  const candidates = [];
  const seen = new Set();

  function push(url) {
    const normalized = (url || "").trim();
    if (!normalized || seen.has(normalized)) {
      return;
    }
    seen.add(normalized);
    candidates.push(normalized);
  }

  push(readLastLocalTunnelUrl());

  const base = (config.localTunnelSubdomainBase || "").trim();
  const tries = Number(config.localTunnelSubdomainTries) || 3;
  if (base) {
    for (let index = 0; index < tries; index += 1) {
      const suffix = index === 0 ? "" : `-${index}`;
      push(`https://${base}${suffix}.loca.lt`);
    }
  }

  return candidates;
}

function getNextPreferredUrl(rebuild = false) {
  if (rebuild) {
    preferredPoolRoundsWithoutSuccess = 0;
    restartCandidateQueue = buildPreferredUrlCandidates();
    tunnelTempSession.log(
      `candidate-pool ${restartCandidateQueue.length > 0 ? restartCandidateQueue.join(", ") : "random-only"}`
    );
  } else if (restartCandidateQueue.length === 0) {
    preferredPoolRoundsWithoutSuccess += 1;
    if (preferredPoolRoundsWithoutSuccess >= RANDOM_FALLBACK_AFTER_PREFERRED_ROUNDS) {
      tunnelTempSession.error("preferred-pool exhausted, falling back to random tunnel url");
      return "";
    }

    restartCandidateQueue = buildPreferredUrlCandidates();
    tunnelTempSession.log(
      `candidate-pool ${restartCandidateQueue.length > 0 ? restartCandidateQueue.join(", ") : "random-only"}`
    );
  }

  return restartCandidateQueue.shift() || "";
}

function buildRecoveryCandidates() {
  return buildPreferredUrlCandidates().filter(Boolean);
}

function startPreferredRecoveryLoop() {
  if (preferredRecoveryInterval || shuttingDown) {
    return;
  }

  preferredRecoveryInterval = setInterval(() => {
    void attemptPreferredRecovery();
  }, PREFERRED_RECOVERY_CHECK_MS);
}

function stopPreferredRecoveryLoop() {
  clearPreferredRecoveryInterval();
  preferredRecoveryInFlight = false;
}

async function attemptPreferredRecovery() {
  if (
    shuttingDown ||
    preferredRecoveryInFlight ||
    currentTunnelMode !== "random" ||
    !publicTunnelUrl ||
    recoveryTunnelProcess ||
    preferredRecoveredUrl
  ) {
    return;
  }

  const candidates = buildRecoveryCandidates();
  if (candidates.length === 0) {
    return;
  }

  preferredRecoveryInFlight = true;

  try {
    for (const preferredUrl of candidates) {
      if (shuttingDown || currentTunnelMode !== "random" || recoveryTunnelProcess || preferredRecoveredUrl) {
        return;
      }

      const matched = await probePreferredRecovery(preferredUrl);
      if (matched) {
        return;
      }
    }
  } finally {
    preferredRecoveryInFlight = false;
  }
}

function probePreferredRecovery(preferredUrl) {
  return new Promise((resolve) => {
    const preferredSubdomain = extractLocalTunnelSubdomain(preferredUrl);
    if (!preferredSubdomain) {
      resolve(false);
      return;
    }

    const child = spawn(localTunnelCommand.command, [...localTunnelCommand.args, "--port", String(localTunnelTarget), "--subdomain", preferredSubdomain], {
      stdio: ["inherit", "pipe", "pipe"],
      shell: usesCmdLauncher(localTunnelCommand.command)
    });
    logSession.attachChild(child, "RECOVERY");

    let settled = false;

    const finalize = (matched) => {
      if (settled) {
        return;
      }
      settled = true;
      clearRecoveryPublishTimeout();
      resolve(matched);
    };

    recoveryPublishTimeout = setTimeout(() => {
      recoveryPublishTimeout = null;
      if (settled) {
        return;
      }
      safeKill(child);
      finalize(false);
    }, PREFERRED_RECOVERY_PUBLISH_TIMEOUT_MS);

    child.stdout?.on("data", (chunk) => {
      const text = chunk.toString();
      for (const line of text.split(/\r?\n/).filter(Boolean)) {
        const match = line.match(/your url is:\s*(https?:\/\/\S+)/i);
        if (!match) {
          continue;
        }

        const actualUrl = match[1];
        const actualSubdomain = extractLocalTunnelSubdomain(actualUrl);
        if (actualSubdomain !== preferredSubdomain) {
          safeKill(child);
          finalize(false);
          return;
        }

        stopFallbackTunnelProcess();
        fallbackTunnelProcess = tunnelProcess;
        fallbackPublicUrl = publicTunnelUrl;
        recoveryTunnelProcess = child;
        preferredRecoveredUrl = actualUrl;
        redirectAfterIso = isoAfter(PREFERRED_REDIRECT_GRACE_MS);
        currentTunnelMode = "preferred-handoff";
        publicTunnelUrl = actualUrl;
        tunnelProcess = child;
        tunnelPublishedUrl = true;
        writeLastLocalTunnelUrl(actualUrl);
        writeRouteStatus({
          activePublicUrl: actualUrl,
          temporaryPublicUrl: fallbackPublicUrl,
          preferredPublicUrl: actualUrl,
          preferredRecoveredUrl: actualUrl,
          preferredRecoveredAt: new Date().toISOString(),
          redirectAfter: redirectAfterIso,
          mode: "preferred-handoff"
        });
        finalize(true);
        return;
      }
    });

    child.on("exit", () => {
      if (recoveryTunnelProcess === child && preferredRecoveredUrl) {
        recoveryTunnelProcess = null;
        if (currentTunnelMode === "preferred-handoff") {
          tunnelProcess = fallbackTunnelProcess;
          publicTunnelUrl = fallbackPublicUrl;
          tunnelPublishedUrl = !!fallbackPublicUrl;
          currentTunnelMode = "random";
        }
        resetRecoveryAnnouncement();
        writeRouteStatus({
          activePublicUrl: fallbackPublicUrl,
          temporaryPublicUrl: "",
          preferredPublicUrl: "",
          preferredRecoveredUrl: "",
          preferredRecoveredAt: "",
          redirectAfter: "",
          mode: "random-fallback"
        });
        startPreferredRecoveryLoop();
      }

      finalize(false);
    });

    child.on("error", () => {
      finalize(false);
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

  throw new Error(`Server did not become healthy within ${timeoutMs}ms.`);
}

function stopTunnelProcess() {
  if (!tunnelProcess) {
    clearPublishTimeout();
    publicTunnelUrl = "";
    tunnelPublishedUrl = false;
    expectedPreferredSubdomain = "";
    currentTunnelAttemptId = "";
    return;
  }

  suppressNextTunnelExitRestart = true;
  clearPublishTimeout();
  stopManagedProcess(tunnelProcess);
  tunnelProcess = null;
  publicTunnelUrl = "";
  tunnelPublishedUrl = false;
  expectedPreferredSubdomain = "";
  currentTunnelAttemptId = "";
}

function stopFallbackTunnelProcess() {
  if (!fallbackTunnelProcess) {
    return;
  }

  stopManagedProcess(fallbackTunnelProcess);
  fallbackTunnelProcess = null;
  fallbackPublicUrl = "";
}

function stopRecoveryTunnelProcess() {
  clearRecoveryPublishTimeout();
  if (!recoveryTunnelProcess) {
    return;
  }

  stopManagedProcess(recoveryTunnelProcess);
  recoveryTunnelProcess = null;
}

function stopTunnelMonitorProcess() {
  if (!tunnelMonitorProcess) {
    return;
  }

  stopManagedProcess(tunnelMonitorProcess);
  tunnelMonitorProcess = null;
}

function stopBackendProcess() {
  if (!serverProcess) {
    return;
  }

  suppressNextBackendExitRestart = true;
  safeKill(serverProcess);
  serverProcess = null;
}

function scheduleTunnelRestart(reason, rebuildCandidates = false) {
  if (shuttingDown) {
    return;
  }

  const hadPublishedUrl = tunnelPublishedUrl;
  const preferredUrl = hadPublishedUrl ? getNextPreferredUrl(true) : getNextPreferredUrl(rebuildCandidates);
  stopFallbackTunnelProcess();
  stopTunnelProcess();
  clearTunnelRestartTimeout();
  resetTunnelHealthCounters();

  tunnelRestartTimeout = setTimeout(() => {
    tunnelRestartTimeout = null;
    if (shuttingDown) {
      return;
    }

    logSession.log(`Restarting LocalTunnel after: ${reason}`);
    spawnTunnel(preferredUrl);
  }, RESTART_DELAY_MS);
}

function scheduleBackendRestart(reason) {
  if (shuttingDown) {
    return;
  }

  clearBackendRestartTimeout();
  stopFallbackTunnelProcess();
  stopTunnelProcess();
  stopBackendProcess();

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
    if (shuttingDown) {
      return;
    }

    logSession.log(`Restarting backend after: ${reason}`);
    spawnBackend(`restart:${reason}`, true).catch((error) => {
      logSession.error("Backend restart flow failed.");
      logSession.error(error instanceof Error ? error.message : String(error));
      scheduleBackendRestart("restart verification failed");
    });
  }, delayMs);
}

async function recoverBackendAfterSpawn(reason, restartTunnelAfterReady) {
  logSession.log(`Waiting for backend readiness after ${reason}...`);
  await waitForHealth(localReadyUrl, 20000);
  logSession.log("Backend healthy again.");
  localFailureCount = 0;
  startTunnelHeartbeat();
  if (restartTunnelAfterReady) {
    scheduleTunnelRestart("backend recovered", true);
  }
}

async function spawnBackend(reason = "initial", restartTunnelAfterReady = false) {
  serverProcess = spawn(nodeCommand, ["node_modules/tsx/dist/cli.mjs", "server/index.ts"], {
    stdio: ["inherit", "pipe", "pipe"],
    shell: false,
    env: {
      ...process.env,
      HOST: "0.0.0.0",
      PORT: config.port
    }
  });
  logSession.attachChild(serverProcess, "SERVER");

  serverProcess.on("exit", (code) => {
    const shouldRestart = !shuttingDown && !suppressNextBackendExitRestart;
    suppressNextBackendExitRestart = false;
    serverProcess = null;

    if (!shouldRestart) {
      return;
    }

    logSession.error(`Local AI Chat server exited with code ${code ?? "unknown"}.`);
    logSession.error(`Saved log: ${logSession.logPath}`);
    scheduleBackendRestart(`backend exited (${code ?? "unknown"})`);
  });

  serverProcess.on("error", (error) => {
    if (shuttingDown) {
      return;
    }

    logSession.error("Failed to start Local AI Chat server.");
    logSession.error(error instanceof Error ? error.message : String(error));
    logSession.error(`Saved log: ${logSession.logPath}`);
    serverProcess = null;
    scheduleBackendRestart("backend start error");
  });

  await recoverBackendAfterSpawn(reason, restartTunnelAfterReady);
}

function spawnTunnel(preferredUrl = "") {
  clearTunnelRestartTimeout();
  clearPublishTimeout();
  publicTunnelUrl = "";
  tunnelPublishedUrl = false;
  resetTunnelHealthCounters();
  suppressNextTunnelExitRestart = false;
  currentTunnelAttemptId = "";
  buildLocalTunnelArgs(preferredUrl);
  logSession.log(`Starting LocalTunnel mode=${currentTunnelMode}`);
  tunnelTempSession.log(`starting mode=${currentTunnelMode} preferredUrl=${preferredUrl || "-"}`);
  launchTunnelWindow(preferredUrl)
    .then(({ pid, attemptId }) => {
      if (shuttingDown) {
        try {
          stopManagedProcess({ pid });
        } catch {
          // Ignore shutdown race.
        }
        return;
      }

      tunnelProcess = { pid };
      currentTunnelAttemptId = attemptId;
      tunnelTempSession.log(`tunnel-window pid=${pid} attempt=${attemptId} status-file=${tunnelWindowStatusFilePath}`);
    })
    .catch((error) => {
      if (shuttingDown) {
        return;
      }

      tunnelProcess = null;
      currentTunnelAttemptId = "";
      logSession.error("");
      logSession.error("Failed to start LocalTunnel window.");
      logSession.error(error instanceof Error ? error.message : String(error));
      logSession.error("The Local AI Chat server is still running on the local port.");
      logSession.error(`Saved log: ${logSession.logPath}`);
      scheduleTunnelRestart("tunnel window start error");
    });

  publishTimeout = setTimeout(() => {
    publishTimeout = null;
    if (shuttingDown || !tunnelProcess || tunnelPublishedUrl) {
      return;
    }

    const preferredNote = preferredUrl ? `preferredUrl=${preferredUrl}` : "random-url-request";
    logSession.error(`LocalTunnel did not publish a public URL within ${TUNNEL_URL_TIMEOUT_MS}ms (${preferredNote}).`);
    tunnelTempSession.error(`publish-timeout mode=${currentTunnelMode} ${preferredNote}`);
    scheduleTunnelRestart("tunnel url publish timeout");
  }, TUNNEL_URL_TIMEOUT_MS);
}

function startTunnelHeartbeat() {
  if (heartbeatInterval) {
    return;
  }

  tunnelTempSession.log(`Monitoring file: ${tunnelTempSession.logPath}`);
  heartbeatInterval = setInterval(async () => {
    if (heartbeatInFlight) {
      return;
    }

    heartbeatInFlight = true;
    syncTunnelProcessState();
    const localResult = await probeUrl(localHealthUrl, 2500);
    const publicResults = await probePublicApp(publicTunnelUrl, assetProbePath);
    const processStatus = tunnelProcess ? `alive(pid=${tunnelProcess.pid ?? "unknown"})` : "not-running";
    const heartbeatLine =
      `[${formatHeartbeatTime()}] heartbeat ` +
      `local=${formatProbeResult(localResult)} ` +
      `publicApi=${formatProbeResult(publicResults.publicHealth)} ` +
      `publicHtml=${formatProbeResult(publicResults.publicHtml)} ` +
      `publicAsset=${formatProbeResult(publicResults.publicAsset)} ` +
      `tunnel=${processStatus} url=${publicTunnelUrl || "-"}`;
    try {
      tunnelTempSession.log(heartbeatLine);

      if (shuttingDown) {
        return;
      }

      if (localResult.status === "200") {
        localFailureCount = 0;
      } else {
        localFailureCount += 1;
        if (localFailureCount >= LOCAL_FAILURE_THRESHOLD && serverProcess) {
          tunnelTempSession.error(
            `local backend unhealthy for ${localFailureCount} checks, restarting backend supervisor`
          );
          localFailureCount = 0;
          scheduleBackendRestart("local health degraded");
          return;
        }
      }

      if (!tunnelProcess) {
        return;
      }

      if (!publicTunnelUrl) {
        return;
      }

      if (redirectAfterIso && Date.now() >= Date.parse(redirectAfterIso)) {
        stopFallbackTunnelProcess();
        writeRouteStatus({
          activePublicUrl: publicTunnelUrl,
          temporaryPublicUrl: "",
          preferredPublicUrl: publicTunnelUrl,
          preferredRecoveredUrl: "",
          preferredRecoveredAt: "",
          redirectAfter: "",
          mode: currentTunnelMode === "preferred-handoff" ? "preferred" : currentTunnelMode
        });
        resetRecoveryAnnouncement();
      }

      const apiFailed = publicResults.publicHealth.status !== "200";
      const htmlFailed =
        publicResults.publicHtml.status !== "200" ||
        !publicResults.publicHtml.contentType.toLowerCase().includes("text/html");
      const assetFailed =
        (publicResults.publicAsset.status !== "NO_URL" && publicResults.publicAsset.status !== "200") ||
        (publicResults.publicAsset.status !== "NO_ASSET" &&
          publicResults.publicAsset.status !== "NO_URL" &&
          isHtmlLikeContentType(publicResults.publicAsset.contentType));

      publicApiFailureCount = apiFailed
        ? publicApiFailureCount + (isStrongFailureStatus(publicResults.publicHealth.status) ? 2 : 1)
        : 0;
      publicHtmlFailureCount = htmlFailed ? publicHtmlFailureCount + 1 : 0;
      publicAssetFailureCount = assetFailed ? publicAssetFailureCount + 1 : 0;

      const slowProbeDetected =
        publicResults.publicHealth.durationMs >= SLOW_RESPONSE_MS ||
        publicResults.publicHtml.durationMs >= SLOW_RESPONSE_MS ||
        publicResults.publicAsset.durationMs >= SLOW_RESPONSE_MS;
      slowProbeCount = slowProbeDetected ? slowProbeCount + 1 : 0;

      if (slowProbeDetected) {
        tunnelTempSession.error(
          `slow-probe api=${formatProbeResult(publicResults.publicHealth)} html=${formatProbeResult(publicResults.publicHtml)} asset=${formatProbeResult(publicResults.publicAsset)}`
        );
      }

      if (assetFailed) {
        tunnelTempSession.error(
          `asset-check-failed status=${publicResults.publicAsset.status} contentType=${publicResults.publicAsset.contentType || "-"}`
        );
      }

      if (publicApiFailureCount >= PUBLIC_API_FAILURE_THRESHOLD) {
        tunnelTempSession.error(`public api unhealthy for ${publicApiFailureCount} checks, restarting tunnel`);
        scheduleTunnelRestart("public api degraded");
        return;
      }

      if (publicHtmlFailureCount >= PUBLIC_PAGE_FAILURE_THRESHOLD) {
        tunnelTempSession.error(`public html unhealthy for ${publicHtmlFailureCount} checks, restarting tunnel`);
        scheduleTunnelRestart("public html degraded");
        return;
      }

      if (publicAssetFailureCount >= PUBLIC_PAGE_FAILURE_THRESHOLD) {
        tunnelTempSession.error(`public asset unhealthy for ${publicAssetFailureCount} checks, restarting tunnel`);
        scheduleTunnelRestart("public asset degraded");
        return;
      }

      if (slowProbeCount >= SLOW_RESPONSE_LIMIT) {
        tunnelTempSession.error(`public tunnel stayed slow for ${slowProbeCount} checks, restarting tunnel`);
        scheduleTunnelRestart("public tunnel slow");
      }
    } finally {
      heartbeatInFlight = false;
    }
  }, TUNNEL_HEARTBEAT_MS);
}

function stopTunnelHeartbeat() {
  if (heartbeatInterval) {
    clearInterval(heartbeatInterval);
    heartbeatInterval = null;
  }
  tunnelTempSession.close();
}

function shutdown(code = 0) {
  if (shuttingDown) {
    return;
  }

  shuttingDown = true;
  clearTunnelRestartTimeout();
  clearBackendRestartTimeout();
  clearPublishTimeout();
  clearRecoveryPublishTimeout();
  stopPreferredRecoveryLoop();
  stopTunnelProcess();
  stopRecoveryTunnelProcess();
  stopFallbackTunnelProcess();
  stopTunnelMonitorProcess();
  stopBackendProcess();
  writeRouteStatus({
    activePublicUrl: "",
    temporaryPublicUrl: "",
    preferredPublicUrl: "",
    preferredRecoveredUrl: "",
    preferredRecoveredAt: "",
    redirectAfter: "",
    mode: "stopped"
  });
  setTimeout(() => {
    stopTunnelHeartbeat();
    logSession.close();
    process.exit(code);
  }, 200);
}

logSession.log(`Log file: ${logSession.logPath}`);
logSession.log(`LocalTunnel state file: ${stateFilePath}`);
logSession.log(`Current public URL file: ${currentPublicUrlFilePath}`);
logSession.log(`Public route status file: ${publicRouteStatusFilePath}`);
logSession.log(`Tunnel window status file: ${tunnelWindowStatusFilePath}`);
writeRouteStatus({ mode: "starting" });
logSession.log("Building Local AI Chat for LocalTunnel...");
await run(nodeCommand, ["node_modules/vite/bin/vite.js", "build"]);
logSession.log(`Asset probe path: ${refreshAssetProbePath() || "(none found)"}`);

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));

logSession.log("");
logSession.log("Starting Local AI Chat server for LocalTunnel access...");
logSession.log(`  Local host target: ${localhostUrl}`);
logSession.log("");

try {
  await spawnBackend();
  logSession.log("Server is healthy. Starting LocalTunnel...");
  logSession.log(`Using lt target: ${localTunnelTarget}`);
  logSession.log("");
  startTunnelHeartbeat();
  try {
    tunnelMonitorProcess = await launchTunnelMonitorWindow();
    logSession.log(`Tunnel monitor window pid=${tunnelMonitorProcess.pid ?? "unknown"}`);
  } catch (error) {
    logSession.error("Failed to start tunnel monitor window.");
    logSession.error(error instanceof Error ? error.message : String(error));
  }
  spawnTunnel(getNextPreferredUrl(true));

  logSession.log("LocalTunnel public mode is running.");
  logSession.log("Keep this window open while the remote link is in use.");
  logSession.log("Press Ctrl+C to stop both the local server and the tunnel.");
  logSession.log("");
} catch (error) {
  logSession.error("");
  logSession.error("Initial backend start failed.");
  logSession.error(error instanceof Error ? error.message : String(error));
  logSession.error(`Saved log: ${logSession.logPath}`);
  scheduleBackendRestart("initial backend boot failed");
}

await new Promise(() => {});
