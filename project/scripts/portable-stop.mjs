import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(scriptDir, "..");
const sessionPath = resolve(projectRoot, "runtime", "state", "portable-session.json");
const systemRoot = process.env.SystemRoot || "C:\\Windows";
const powershell = join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
const taskkill = join(systemRoot, "System32", "taskkill.exe");

function removeSessionFile() {
  rmSync(sessionPath, { force: true });
}

function inspectProcess(pid) {
  const command = [
    `$target = Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}" -ErrorAction SilentlyContinue`,
    "if ($null -eq $target) { exit 3 }",
    "$target | Select-Object ProcessId, ExecutablePath, CommandLine | ConvertTo-Json -Compress"
  ].join("; ");
  const result = spawnSync(powershell, ["-NoProfile", "-Command", command], {
    encoding: "utf8",
    windowsHide: true
  });

  if (result.status === 3) {
    return null;
  }
  if (result.status !== 0) {
    throw new Error(result.stderr.trim() || "Could not inspect the saved launcher process.");
  }

  return JSON.parse(result.stdout.trim());
}

function main() {
  if (!existsSync(sessionPath)) {
    console.log("Local AI Chat is not running through the portable launcher.");
    return;
  }

  let session;
  try {
    session = JSON.parse(readFileSync(sessionPath, "utf8"));
  } catch {
    removeSessionFile();
    throw new Error("Portable session state was corrupt and has been removed.");
  }

  const pid = Number(session.launcherPid);
  if (!Number.isInteger(pid) || pid <= 0) {
    removeSessionFile();
    throw new Error("Portable session did not contain a valid launcher PID.");
  }

  const processInfo = inspectProcess(pid);
  if (!processInfo) {
    removeSessionFile();
    console.log("Local AI Chat was already stopped. Stale session state was removed.");
    return;
  }

  if (!String(processInfo.CommandLine || "").toLowerCase().includes("portable-launch.mjs")) {
    removeSessionFile();
    throw new Error(`Saved PID ${pid} no longer belongs to the Local AI Chat launcher.`);
  }

  const result = spawnSync(taskkill, ["/PID", String(pid), "/T", "/F"], {
    encoding: "utf8",
    windowsHide: true
  });
  if (result.status !== 0) {
    throw new Error(result.stderr.trim() || result.stdout.trim() || "Could not stop Local AI Chat.");
  }

  removeSessionFile();
  console.log("Local AI Chat stopped.");
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
