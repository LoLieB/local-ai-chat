import { existsSync } from "node:fs";
import { resolve } from "node:path";

export function resolveZrokCommand(cwd = process.cwd()) {
  const bundledPath = resolve(cwd, "runtime", "zrok", "zrok.exe");
  if (existsSync(bundledPath)) {
    return bundledPath;
  }

  return "zrok";
}
