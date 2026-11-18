import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  assertSupportedPortablePlatform,
  checkPortAvailable,
  createLanUrls,
  createDependencyFingerprint,
  findMissingFiles,
  getPrivateLanIpv4Addresses,
  isPrivateIpv4Address,
  isSupportedNodeVersion,
  parseNodeVersion,
  parsePort
} from "../../scripts/portable-core.mjs";

test("dependency fingerprint ignores scripts but tracks dependency changes", () => {
  const lockfile = JSON.stringify({ lockfileVersion: 3, packages: {} });
  const original = createDependencyFingerprint(JSON.stringify({
    scripts: { start: "node old.mjs" },
    dependencies: { react: "19.2.6" },
    allowScripts: { "esbuild@0.28.1": true }
  }), lockfile);
  const scriptOnlyChange = createDependencyFingerprint(JSON.stringify({
    scripts: { start: "node new.mjs" },
    dependencies: { react: "19.2.6" },
    allowScripts: { "esbuild@0.28.1": true }
  }), lockfile);
  const dependencyChange = createDependencyFingerprint(JSON.stringify({
    scripts: { start: "node new.mjs" },
    dependencies: { react: "20.0.0" },
    allowScripts: { "esbuild@0.28.1": true }
  }), lockfile);

  assert.equal(scriptOnlyChange, original);
  assert.notEqual(dependencyChange, original);
});

test("portable platform policy accepts Windows x64 and rejects ARM64", () => {
  assert.doesNotThrow(() => assertSupportedPortablePlatform("win32", "x64"));
  assert.throws(
    () => assertSupportedPortablePlatform("win32", "arm64"),
    /Windows x64 native dependencies \(received arm64\)/
  );
  assert.throws(
    () => assertSupportedPortablePlatform("linux", "x64"),
    /supports Windows only \(received linux\)/
  );
});

test("portable Node version policy matches Vite requirements", () => {
  assert.equal(isSupportedNodeVersion("v20.18.0"), false);
  assert.equal(isSupportedNodeVersion("v20.19.0"), true);
  assert.equal(isSupportedNodeVersion("v21.7.3"), false);
  assert.equal(isSupportedNodeVersion("v22.11.0"), false);
  assert.equal(isSupportedNodeVersion("v22.12.0"), true);
  assert.equal(isSupportedNodeVersion("v24.18.0"), true);
  assert.equal(isSupportedNodeVersion("unknown"), false);
  assert.deepEqual(parseNodeVersion("v24.18.0"), { major: 24, minor: 18, patch: 0 });
});

test("portable port validation rejects invalid values", () => {
  assert.equal(parsePort(undefined, 8787, "PORT"), 8787);
  assert.equal(parsePort("5173", 8787, "PORT"), 5173);
  assert.throws(() => parsePort("0", 8787, "PORT"), /between 1 and 65535/);
  assert.throws(() => parsePort("abc", 8787, "PORT"), /between 1 and 65535/);
});

test("LAN discovery reports only private non-loopback IPv4 addresses", () => {
  const addresses = getPrivateLanIpv4Addresses({
    Ethernet: [
      { family: "IPv4", address: "172.20.0.50", internal: false },
      { family: "IPv4", address: "8.8.8.8", internal: false }
    ],
    WiFi: [
      { family: "IPv4", address: "10.0.0.8", internal: false },
      { family: "IPv4", address: "172.20.0.50", internal: false }
    ],
    Loopback: [{ family: "IPv4", address: "127.0.0.1", internal: true }]
  });

  assert.deepEqual(addresses, [
    { name: "Ethernet", address: "172.20.0.50" },
    { name: "WiFi", address: "10.0.0.8" }
  ]);
  assert.equal(isPrivateIpv4Address("172.16.0.1"), true);
  assert.equal(isPrivateIpv4Address("172.32.0.1"), false);
  assert.deepEqual(createLanUrls(addresses, 8787), [
    { name: "Ethernet", address: "172.20.0.50", url: "http://172.20.0.50:8787/" },
    { name: "WiFi", address: "10.0.0.8", url: "http://10.0.0.8:8787/" }
  ]);
});

test("missing dependency detection reports only absent files", async () => {
  const root = await mkdtemp(join(tmpdir(), "local-ai-chat-portable-"));
  await mkdir(join(root, "node_modules", "vite"), { recursive: true });
  await writeFile(join(root, "node_modules", "vite", "package.json"), "{}", "utf8");

  const missing = await findMissingFiles(root, [
    "node_modules/vite/package.json",
    "node_modules/tsx/package.json"
  ]);

  assert.deepEqual(missing, ["node_modules/tsx/package.json"]);
});

test("occupied ports are rejected before launch", async () => {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");

  try {
    const result = await checkPortAvailable({ host: "127.0.0.1", port: address.port });
    assert.equal(result.available, false);
    assert.equal(result.error?.code, "EADDRINUSE");
  } finally {
    await new Promise((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  }
});
