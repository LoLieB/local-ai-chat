import { existsSync } from "node:fs";
import { resolve } from "node:path";

export function resolveLocalTunnelCommand(cwd = process.cwd()) {
  const localJs = resolve(cwd, "node_modules", "localtunnel", "bin", "client");
  if (existsSync(localJs)) {
    return { command: process.execPath, args: [localJs] };
  }

  const localCmd = resolve(cwd, "node_modules", ".bin", "lt.cmd");
  if (existsSync(localCmd)) {
    return { command: localCmd, args: [] };
  }

  const appData = process.env.APPDATA;
  if (appData) {
    const globalCmd = resolve(appData, "npm", "lt.cmd");
    if (existsSync(globalCmd)) {
      return { command: globalCmd, args: [] };
    }
  }

  const userProfile = process.env.USERPROFILE;
  if (userProfile) {
    const fallbackGlobalCmd = resolve(userProfile, "AppData", "Roaming", "npm", "lt.cmd");
    if (existsSync(fallbackGlobalCmd)) {
      return { command: fallbackGlobalCmd, args: [] };
    }
  }

  return { command: "lt", args: [] };
}
