import { spawn } from "node:child_process";
import { getLanConfig } from "./lan-config.mjs";
import { resolveLocalTunnelCommand } from "./localtunnel-command.mjs";
import { createLogSession } from "./log-session.mjs";
import {
  extractLocalTunnelSubdomain,
  getCurrentPublicUrlFilePath,
  getLocalTunnelStateFilePath,
  getTunnelWindowStatusFilePath,
  readLastLocalTunnelUrl,
  readTunnelWindowStatus,
  writeLastLocalTunnelUrl
} from "./localtunnel-state.mjs";
import { safeKill } from "./process-supervisor.mjs";
import { formatProbeResult, probePublicApp, probeUrl, resolveDistAssetProbePath } from "./tunnel-probes.mjs";

const config = getLanConfig();
const localhostUrl = `http://127.0.0.1:${config.port}`;
const localHealthUrl = `${localhostUrl}/api/health`;
const localReadyUrl = `${localhostUrl}/api/ready`;
const localTunnelTarget = config.port;
const localTunnelCommand = resolveLocalTunnelCommand();
const logSession = createLogSession("local-ai-chat-localtunnel-only");
const tunnelTempSession = createLogSession("localtunnel-only-heartbeat", "tunnel-temp", { echoConsole: false });
const TUNNEL_HEARTBEAT_MS = 1000;
const PUBLIC_API_FAILURE_THRESHOLD = 3;
const PUBLIC_PAGE_FAILURE_THRESHOLD = 2;
const RESTART_DELAY_MS = 1500;
const TUNNEL_URL_TIMEOUT_MS = 8000;
const SLOW_RESPONSE_MS = 1500;
const SLOW_RESPONSE_LIMIT = 4;
const RANDOM_FALLBACK_AFTER_PREFERRED_ROUNDS = 1;
const stateFilePath = getLocalTunnelStateFilePath();
const currentPublicUrlFilePath = getCurrentPublicUrlFilePath();
const tunnelWindowStatusFilePath = getTunnelWindowStatusFilePath();

let publicTunnelUrl = "";
let heartbeatInterval = null;
let restartTimeout = null;
let publishTimeout = null;
let publicApiFailureCount = 0;
let publicHtmlFailureCount = 0;
let publicAssetFailureCount = 0;
let slowProbeCount = 0;
let heartbeatInFlight = false;
let assetProbePath = "";
let tunnelPublishedUrl = false;
let preferredPoolRoundsWithoutSuccess = 0;
let currentTunnelMode = "random";
let expectedPreferredSubdomain = "";
let tunnelProcess = null;
let shuttingDown = false;
let restartCandidateQueue = [];
let suppressNextTunnelExitRestart = false;
let currentTunnelAttemptId = "";
let tunnelMonitorProcess = null;

function formatHeartbeatTime() {
  return new Date().toLocaleTimeString("ru-RU", { hour12: false });
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
      `"${process.execPath}" "scripts\\run-tunnel-monitor-window.mjs" "--log-path" "${tunnelTempSession.logPath}" "--status-path" "${tunnelWindowStatusFilePath}" "--title" "LocalTunnel Monitor"`
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
      `"${process.execPath}" "scripts\\run-public-tunnel-window.mjs" "--attempt-id" "${attemptId}" "--mode" "${currentTunnelMode}" "--port" "${String(localTunnelTarget)}" "--preferred-url" "${preferredUrl || ""}"`
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
        logSession.error(`LocalTunnel window ended with state=${status.state} code=${status.exitCode ?? "unknown"}.`);
        if (status.error) {
          logSession.error(status.error);
        }
        logSession.error(`Saved log: ${logSession.logPath}`);
        scheduleTunnelRestart(`tunnel window ${status.state}`);
      }
    }
  }
}

function clearRestartTimeout() {
  if (restartTimeout) {
    clearTimeout(restartTimeout);
    restartTimeout = null;
  }
}

function clearPublishTimeout() {
  if (publishTimeout) {
    clearTimeout(publishTimeout);
    publishTimeout = null;
  }
}

function resetTunnelHealthCounters() {
  publicApiFailureCount = 0;
  publicHtmlFailureCount = 0;
  publicAssetFailureCount = 0;
  slowProbeCount = 0;
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

async function waitForHealth(url, timeoutMs = 10000) {
  const startTime = Date.now();

  while (Date.now() - startTime < timeoutMs) {
    const result = await probeUrl(url, 2500);
    if (result.status === "200") {
      return true;
    }

    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  throw new Error(`Local server is not reachable at ${url}. Start start-local-ai-chat.cmd or start-public.cmd first.`);
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

function stopTunnelMonitorProcess() {
  if (!tunnelMonitorProcess) {
    return;
  }

  stopManagedProcess(tunnelMonitorProcess);
  tunnelMonitorProcess = null;
}

function scheduleTunnelRestart(reason, rebuildCandidates = false) {
  if (shuttingDown) {
    return;
  }

  const hadPublishedUrl = tunnelPublishedUrl;
  const preferredUrl = hadPublishedUrl ? getNextPreferredUrl(true) : getNextPreferredUrl(rebuildCandidates);
  stopTunnelProcess();
  clearRestartTimeout();
  resetTunnelHealthCounters();

  restartTimeout = setTimeout(() => {
    restartTimeout = null;
    if (shuttingDown) {
      return;
    }

    logSession.log(`Restarting LocalTunnel after: ${reason}`);
    spawnTunnel(preferredUrl);
  }, RESTART_DELAY_MS);
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
    try {
      tunnelTempSession.log(
        `[${formatHeartbeatTime()}] heartbeat local=${formatProbeResult(localResult)} publicApi=${formatProbeResult(publicResults.publicHealth)} publicHtml=${formatProbeResult(publicResults.publicHtml)} publicAsset=${formatProbeResult(publicResults.publicAsset)} tunnel=${processStatus} url=${publicTunnelUrl || "-"}`
      );

      if (!tunnelProcess || shuttingDown) {
        return;
      }

      if (!publicTunnelUrl) {
        return;
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

function spawnTunnel(preferredUrl = "") {
  clearRestartTimeout();
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
        stopManagedProcess({ pid });
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
      logSession.error("Failed to start LocalTunnel window.");
      logSession.error(error instanceof Error ? error.message : String(error));
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

logSession.log(`Log file: ${logSession.logPath}`);
logSession.log(`LocalTunnel state file: ${stateFilePath}`);
logSession.log(`Current public URL file: ${currentPublicUrlFilePath}`);
logSession.log(`Tunnel window status file: ${tunnelWindowStatusFilePath}`);
logSession.log("Checking existing Local AI Chat server...");

try {
  await waitForHealth(localReadyUrl);
} catch (error) {
  logSession.error(error instanceof Error ? error.message : String(error));
  logSession.error(`Saved log: ${logSession.logPath}`);
  logSession.close();
  stopTunnelHeartbeat();
  process.exit(1);
}

logSession.log("Local server is healthy. Starting LocalTunnel only...");
logSession.log(`Using lt target: ${localTunnelTarget}`);
logSession.log(`Asset probe path: ${refreshAssetProbePath() || "(none found)"}`);
logSession.log("Keep this window open while the public link is in use.");
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

process.on("SIGINT", () => {
  shuttingDown = true;
  clearRestartTimeout();
  clearPublishTimeout();
  stopTunnelProcess();
  stopTunnelMonitorProcess();
  stopTunnelHeartbeat();
  logSession.close();
  process.exit(0);
});

process.on("SIGTERM", () => {
  shuttingDown = true;
  clearRestartTimeout();
  clearPublishTimeout();
  stopTunnelProcess();
  stopTunnelMonitorProcess();
  stopTunnelHeartbeat();
  logSession.close();
  process.exit(0);
});

await new Promise(() => {});
