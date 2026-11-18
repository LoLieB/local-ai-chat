import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { createHash } from "node:crypto";
import { createServer } from "node:net";
import { networkInterfaces } from "node:os";
import { resolve } from "node:path";

export const SUPPORTED_NODE_RANGE = "Node.js 20.19+ or 22.12+";

export const REQUIRED_PROJECT_FILES = [
  "package.json",
  "package-lock.json",
  "index.html",
  "vite.config.ts",
  "server/index.ts",
  "scripts/dev.mjs",
  "scripts/run-lan.mjs",
  "scripts/portable-stop.mjs",
  "stop-local-ai-chat.cmd",
  "start-local-ai-chat-lan.cmd"
];

export const REQUIRED_DEPENDENCY_FILES = [
  "node_modules/.package-lock.json",
  "node_modules/express/package.json",
  "node_modules/react/package.json",
  "node_modules/tsx/dist/cli.mjs",
  "node_modules/typescript/bin/tsc",
  "node_modules/vite/bin/vite.js",
  "node_modules/@esbuild/win32-x64/esbuild.exe",
  "node_modules/@rollup/rollup-win32-x64-msvc/rollup.win32-x64-msvc.node"
];

const DEPENDENCY_MANIFEST_FIELDS = [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies",
  "peerDependenciesMeta",
  "overrides",
  "bundleDependencies",
  "bundledDependencies",
  "packageManager",
  "engines",
  "allowScripts"
];

export function createDependencyFingerprint(manifestSource, lockfileSource) {
  const manifest = JSON.parse(String(manifestSource));
  const dependencyManifest = {};

  for (const field of DEPENDENCY_MANIFEST_FIELDS) {
    if (manifest[field] !== undefined) {
      dependencyManifest[field] = manifest[field];
    }
  }

  return createHash("sha256")
    .update(JSON.stringify(dependencyManifest))
    .update("\0")
    .update(lockfileSource)
    .digest("hex");
}

export function parseNodeVersion(version) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(String(version).trim());
  if (!match) {
    return null;
  }

  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3])
  };
}

export function isSupportedNodeVersion(version) {
  const parsed = parseNodeVersion(version);
  if (!parsed) {
    return false;
  }

  if (parsed.major === 20) {
    return parsed.minor >= 19;
  }

  return (parsed.major === 22 && parsed.minor >= 12) || parsed.major > 22;
}

export function assertSupportedPortablePlatform(platform, arch) {
  if (platform !== "win32") {
    throw new Error(`This portable launcher currently supports Windows only (received ${platform}).`);
  }

  if (arch !== "x64") {
    throw new Error(
      `This portable package contains Windows x64 native dependencies (received ${arch}).`
    );
  }
}

export function parsePort(value, fallback, label) {
  const candidate = value == null || value === "" ? fallback : Number(value);
  if (!Number.isInteger(candidate) || candidate < 1 || candidate > 65535) {
    throw new Error(`${label} must be an integer between 1 and 65535.`);
  }

  return candidate;
}

export function isPrivateIpv4Address(address) {
  const octets = String(address).split(".").map((part) => Number(part));
  if (octets.length !== 4 || octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return false;
  }

  return octets[0] === 10 ||
    (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) ||
    (octets[0] === 192 && octets[1] === 168);
}

export function getPrivateLanIpv4Addresses(interfaces = networkInterfaces()) {
  const addresses = [];
  const seen = new Set();

  for (const [name, entries] of Object.entries(interfaces)) {
    for (const entry of entries || []) {
      const isIpv4 = entry.family === "IPv4" || entry.family === 4;
      if (!isIpv4 || entry.internal || !isPrivateIpv4Address(entry.address) || seen.has(entry.address)) {
        continue;
      }

      seen.add(entry.address);
      addresses.push({ name, address: entry.address });
    }
  }

  return addresses;
}

export function createLanUrls(addresses, port) {
  return addresses.map(({ name, address }) => ({
    name,
    address,
    url: `http://${address}:${port}/`
  }));
}

export async function findMissingFiles(root, relativePaths) {
  const missing = [];
  for (const relativePath of relativePaths) {
    try {
      await access(resolve(root, relativePath), constants.R_OK);
    } catch {
      missing.push(relativePath);
    }
  }
  return missing;
}

export function checkPortAvailable({ host, port }) {
  return new Promise((resolveCheck) => {
    const server = createServer();

    server.once("error", (error) => {
      resolveCheck({ available: false, error });
    });

    server.once("listening", () => {
      server.close(() => resolveCheck({ available: true, error: null }));
    });

    server.listen({ host, port, exclusive: true });
  });
}
