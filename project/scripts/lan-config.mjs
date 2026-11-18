import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

function loadEnvFile(cwd) {
  const envPath = resolve(cwd, ".env");
  if (!existsSync(envPath)) {
    return {};
  }

  const content = readFileSync(envPath, "utf8");
  const values = {};

  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const separatorIndex = line.indexOf("=");
    if (separatorIndex <= 0) continue;
    const key = line.slice(0, separatorIndex).trim();
    const value = line.slice(separatorIndex + 1).trim().replace(/^['"]|['"]$/g, "");
    values[key] = value;
  }

  return values;
}

export function getLanConfig(cwd = process.cwd()) {
  const scriptDir = dirname(fileURLToPath(import.meta.url));
  const projectRoot = resolve(scriptDir, "..");
  const projectEnv = loadEnvFile(projectRoot);
  const cwdEnv = cwd === projectRoot ? {} : loadEnvFile(cwd);
  const env = { ...projectEnv, ...cwdEnv, ...process.env };

  return {
    appLanHost: env.APP_LAN_HOST || "localhost",
    port: env.PORT || "8787",
    lmStudioBaseUrl: env.LM_STUDIO_BASE_URL || "http://localhost:1234/v1",
    lmStudioModelId: env.LM_STUDIO_MODEL_ID || "",
    zrokEnableToken: env.ZROK_ENABLE_TOKEN || "",
    zrokApiEndpoint: env.ZROK_API_ENDPOINT || "",
    localTunnelSubdomainBase: env.LOCALTUNNEL_SUBDOMAIN_BASE || "velvet-chimera",
    localTunnelSubdomainTries: Math.max(1, Number.parseInt(env.LOCALTUNNEL_SUBDOMAIN_TRIES || "3", 10) || 3)
  };
}
