export function createRestartLimiter({ maxRestarts, windowMs }) {
  const attempts = [];

  return {
    record(now = Date.now()) {
      attempts.push(now);
      while (attempts.length && now - attempts[0] > windowMs) {
        attempts.shift();
      }
      return attempts.length <= maxRestarts;
    },
    count(now = Date.now()) {
      while (attempts.length && now - attempts[0] > windowMs) {
        attempts.shift();
      }
      return attempts.length;
    }
  };
}

export function calculateBackoffMs(restartCount, baseMs = 1000, maxMs = 10000) {
  return Math.min(maxMs, baseMs * Math.max(1, restartCount));
}

export function safeKill(child, signal = "SIGTERM") {
  if (!child || child.killed) {
    return;
  }

  try {
    child.kill(signal);
  } catch {
    // Ignore cleanup errors.
  }
}
