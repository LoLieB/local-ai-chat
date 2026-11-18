import { existsSync, readFileSync } from "node:fs";

function readArg(name, fallback = "") {
  const index = process.argv.indexOf(name);
  if (index === -1) {
    return fallback;
  }

  return process.argv[index + 1] ?? fallback;
}

const logPath = readArg("--log-path");
const statusPath = readArg("--status-path");
const windowTitle = readArg("--title", "Tunnel Monitor");

let lastLogLength = 0;
let lastStatusSnapshot = "";

function printBanner() {
  process.stdout.write("\x1Bc");
  console.log(windowTitle);
  console.log(`log: ${logPath || "-"}`);
  console.log(`status: ${statusPath || "-"}`);
  console.log("");
}

function readStatusSummary() {
  if (!statusPath || !existsSync(statusPath)) {
    return "";
  }

  try {
    const parsed = JSON.parse(readFileSync(statusPath, "utf8"));
    const summary = [
      `attempt=${parsed.attemptId || "-"}`,
      `state=${parsed.state || "-"}`,
      `mode=${parsed.mode || "-"}`,
      `preferred=${parsed.preferredUrl || "-"}`,
      `published=${parsed.publishedUrl || "-"}`,
      `pid=${parsed.pid || "-"}`
    ].join(" | ");
    return summary;
  } catch {
    return "status=unreadable";
  }
}

function flushLogTail() {
  if (!logPath || !existsSync(logPath)) {
    return;
  }

  const content = readFileSync(logPath, "utf8");
  if (content.length < lastLogLength) {
    lastLogLength = 0;
  }

  const nextChunk = content.slice(lastLogLength);
  lastLogLength = content.length;

  if (!nextChunk) {
    return;
  }

  process.stdout.write(nextChunk);
}

printBanner();

setInterval(() => {
  const nextStatus = readStatusSummary();
  if (nextStatus && nextStatus !== lastStatusSnapshot) {
    lastStatusSnapshot = nextStatus;
    console.log(`\n[status] ${nextStatus}`);
  }

  flushLogTail();
}, 1000);

