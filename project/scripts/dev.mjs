import { spawn } from "node:child_process";
import { once } from "node:events";

const host = process.argv.includes("--lan") ? "0.0.0.0" : process.env.HOST || "127.0.0.1";
const backendPort = process.env.PORT || "8787";
const vitePort = process.env.VITE_PORT || "5173";

const commands = [
  ["server", process.execPath, ["node_modules/tsx/dist/cli.mjs", "watch", "server/index.ts"]],
  ["client", process.execPath, [
    "node_modules/vite/bin/vite.js",
    "--host",
    host,
    "--port",
    vitePort,
    "--strictPort"
  ]]
];

const children = commands.map(([name, command, args]) => {
  const child = spawn(command, args, {
    stdio: "pipe",
    shell: false,
    env: {
      ...process.env,
      HOST: host,
      PORT: backendPort,
      VITE_PORT: vitePort,
      BACKEND_URL: process.env.BACKEND_URL || `http://127.0.0.1:${backendPort}`
    }
  });

  child.stdout.on("data", (chunk) => process.stdout.write(`[${name}] ${chunk}`));
  child.stderr.on("data", (chunk) => process.stderr.write(`[${name}] ${chunk}`));
  child.on("exit", (code) => {
    if (code && code !== 0) {
      process.exitCode = code;
    }
  });
  return child;
});

const stop = () => {
  for (const child of children) child.kill();
};

process.on("SIGINT", stop);
process.on("SIGTERM", stop);

process.stdin.resume();

const exits = await Promise.all(children.map((child) => once(child, "exit")));
const firstNonZero = exits.find(([code]) => Number(code) > 0);
if (firstNonZero) {
  process.exit(Number(firstNonZero[0]) || 1);
}
