import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const stateDir = resolve(process.cwd(), "runtime", "logs", "tunnel-temp");
const stateFilePath = resolve(stateDir, "localtunnel-last-url.txt");
const currentUrlFilePath = resolve(process.cwd(), "current-public-url.txt");
const publicRouteStatusFilePath = resolve(stateDir, "public-route-status.json");
const tunnelWindowStatusFilePath = resolve(stateDir, "public-tunnel-window-status.json");

function ensureStateDir() {
  mkdirSync(stateDir, { recursive: true });
}

export function getLocalTunnelStateFilePath() {
  ensureStateDir();
  return stateFilePath;
}

export function getCurrentPublicUrlFilePath() {
  ensureStateDir();
  return currentUrlFilePath;
}

export function getPublicRouteStatusFilePath() {
  ensureStateDir();
  return publicRouteStatusFilePath;
}

export function getTunnelWindowStatusFilePath() {
  ensureStateDir();
  return tunnelWindowStatusFilePath;
}

export function readLastLocalTunnelUrl() {
  ensureStateDir();
  try {
    return readFileSync(stateFilePath, "utf8").trim();
  } catch {
    return "";
  }
}

export function writeLastLocalTunnelUrl(url) {
  const normalized = (url || "").trim();
  if (!normalized) {
    return;
  }

  ensureStateDir();
  writeFileSync(stateFilePath, `${normalized}\n`, "utf8");
  writeFileSync(currentUrlFilePath, `${normalized}\n`, "utf8");
}

export function readPublicRouteStatus() {
  ensureStateDir();
  try {
    return JSON.parse(readFileSync(publicRouteStatusFilePath, "utf8"));
  } catch {
    return {
      activePublicUrl: "",
      temporaryPublicUrl: "",
      preferredPublicUrl: "",
      preferredRecoveredUrl: "",
      preferredRecoveredAt: "",
      redirectAfter: "",
      mode: "idle"
    };
  }
}

export function writePublicRouteStatus(status) {
  ensureStateDir();
  writeFileSync(publicRouteStatusFilePath, `${JSON.stringify(status, null, 2)}\n`, "utf8");
}

export function updatePublicRouteStatus(patch) {
  const current = readPublicRouteStatus();
  writePublicRouteStatus({ ...current, ...patch });
}

export function readTunnelWindowStatus() {
  ensureStateDir();
  try {
    return JSON.parse(readFileSync(tunnelWindowStatusFilePath, "utf8"));
  } catch {
    return {
      attemptId: "",
      mode: "idle",
      preferredUrl: "",
      expectedSubdomain: "",
      actualSubdomain: "",
      publishedUrl: "",
      state: "idle",
      pid: 0,
      logPath: "",
      error: "",
      exitCode: null
    };
  }
}

export function writeTunnelWindowStatus(status) {
  ensureStateDir();
  writeFileSync(tunnelWindowStatusFilePath, `${JSON.stringify(status, null, 2)}\n`, "utf8");
}

export function extractLocalTunnelSubdomain(url) {
  const normalized = (url || "").trim();
  if (!normalized) {
    return "";
  }

  try {
    const parsed = new URL(normalized);
    const hostname = parsed.hostname.toLowerCase();
    if (!hostname.endsWith(".loca.lt")) {
      return "";
    }

    return hostname.slice(0, hostname.length - ".loca.lt".length);
  } catch {
    return "";
  }
}
