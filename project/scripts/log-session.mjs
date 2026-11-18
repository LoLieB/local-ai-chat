import { mkdirSync, createWriteStream } from "node:fs";
import { resolve } from "node:path";

const ANSI_ESCAPE_PATTERN = /\u001b\[[0-?]*[ -/]*[@-~]/g;

function timestampForFile(date = new Date()) {
  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const dd = String(date.getDate()).padStart(2, "0");
  const hh = String(date.getHours()).padStart(2, "0");
  const mi = String(date.getMinutes()).padStart(2, "0");
  const ss = String(date.getSeconds()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}_${hh}-${mi}-${ss}`;
}

function timestampForLine(date = new Date()) {
  return date.toISOString();
}

function createWritableLog(prefix, subdirectory = "") {
  const logsDir = resolve(process.cwd(), "runtime", "logs", subdirectory);
  mkdirSync(logsDir, { recursive: true });
  const logPath = resolve(logsDir, `${prefix}-${timestampForFile()}.log`);
  const stream = createWriteStream(logPath, { flags: "a", encoding: "utf8" });
  stream.write("\uFEFF");
  return { logPath, stream };
}

export function createLogSession(prefix, subdirectory = "", options = {}) {
  const { logPath, stream } = createWritableLog(prefix, subdirectory);
  const echoConsole = options.echoConsole !== false;

  function writeLine(level, message) {
    const cleanMessage = String(message).replace(ANSI_ESCAPE_PATTERN, "");
    stream.write(`[${timestampForLine()}] [${level}] ${cleanMessage}\n`);
  }

  function stringify(message) {
    if (typeof message === "string") {
      return message;
    }
    if (message instanceof Error) {
      return message.stack || message.message;
    }
    return String(message);
  }

  function log(...parts) {
    const message = parts.map(stringify).join(" ");
    if (echoConsole) {
      console.log(...parts);
    }
    writeLine("INFO", message);
  }

  function error(...parts) {
    const message = parts.map(stringify).join(" ");
    if (echoConsole) {
      console.error(...parts);
    }
    writeLine("ERROR", message);
  }

  function attachChild(child, label, hooks = {}) {
    child.stdout?.on("data", (chunk) => {
      const text = chunk.toString();
      if (echoConsole) {
        process.stdout.write(text);
      }
      for (const line of text.split(/\r?\n/).filter(Boolean)) {
        writeLine(label, line);
        hooks.onStdoutLine?.(line);
      }
    });

    child.stderr?.on("data", (chunk) => {
      const text = chunk.toString();
      if (echoConsole) {
        process.stderr.write(text);
      }
      for (const line of text.split(/\r?\n/).filter(Boolean)) {
        writeLine(`${label}:ERR`, line);
        hooks.onStderrLine?.(line);
      }
    });
  }

  function close() {
    stream.end();
  }

  writeLine("INFO", `Log file created at ${logPath}`);

  return {
    logPath,
    log,
    error,
    attachChild,
    close
  };
}
