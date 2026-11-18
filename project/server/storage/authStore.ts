import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { writeJsonAtomic } from "./jsonFile.js";
import {
  ensureUserWorkspace,
  normalizeUserId,
  syncUserWorkspace
} from "./userDataStore.js";

const authRootDir = join(process.cwd(), "server-data", "common-base");
const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 30;
const ADMIN_USERNAME = "admin";
const ADMIN_USER_ID = "u_admin";

type CredentialsRecord = {
  users: Record<string, StoredCredential>;
};

type SessionsRecord = {
  sessions: Record<string, StoredSession>;
};

export type StoredCredential = {
  studioWelcomePending?: true;
  username: string;
  passwordHash: string;
  userId: string;
  createdAt: string;
  updatedAt: string;
};

export type StoredSession = {
  userId: string;
  username: string;
  createdAt: string;
  expiresAt: string;
};

export type AuthSession = {
  sessionToken: string;
  userId: string;
  username: string;
  createdAt: string;
  expiresAt: string;
};

const defaultCredentials: CredentialsRecord = { users: {} };
const defaultSessions: SessionsRecord = { sessions: {} };

let authWriteQueue = Promise.resolve();

function nowIso() {
  return new Date().toISOString();
}

function makeUserId() {
  return `u_${randomBytes(6).toString("hex")}`;
}

function makeSessionToken() {
  return `st_${randomBytes(24).toString("hex")}`;
}

function getCredentialsPath(rootDir: string) {
  return join(rootDir, "credentials.json");
}

function getSessionsPath(rootDir: string) {
  return join(rootDir, "sessions.json");
}

function getUserWorkspaceRootDir(rootDir: string) {
  return join(rootDir, "users");
}

async function ensureAuthFiles(rootDir = authRootDir) {
  await mkdir(rootDir, { recursive: true });
  await mkdir(getUserWorkspaceRootDir(rootDir), { recursive: true });

  for (const [path, initial] of [[getCredentialsPath(rootDir), defaultCredentials], [getSessionsPath(rootDir), defaultSessions]] as const) {
    try {
      await writeFile(path, JSON.stringify(initial), { flag: "wx", mode: 0o600 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }

}

async function readJsonFile<T>(filePath: string, fallback: T): Promise<T> {
  const raw = await readFile(filePath, "utf8");
  try {
    const parsed = JSON.parse(raw);
    const key = Object.keys(fallback as object)[0]!;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || !parsed[key] || typeof parsed[key] !== "object" || Array.isArray(parsed[key])) throw new Error();
    return parsed as T;
  } catch {
    // Never log parser errors: they can include fragments of stored credentials.
    throw new Error("Invalid authentication store. Restore it from a trusted backup.");
  }
}

export async function initializeAdmin(password?: string, rootDir = authRootDir) {
  return serializeAuthWrite(async () => {
    await ensureAuthFiles(rootDir);
    const credentials = await readJsonFile(getCredentialsPath(rootDir), defaultCredentials);
    if (credentials.users[ADMIN_USERNAME]) return true;
    if (!password) return false;
    if (password.trim().length < 12 || password.length > 256) {
      throw new Error("INITIAL_ADMIN_PASSWORD must contain 12-256 characters (excluding surrounding whitespace from the minimum).");
    }
    const timestamp = nowIso();
    credentials.users[ADMIN_USERNAME] = { username: ADMIN_USERNAME, userId: ADMIN_USER_ID, studioWelcomePending: true,
      passwordHash: hashPassword(password), createdAt: timestamp, updatedAt: timestamp };
    await writeJsonFile(getCredentialsPath(rootDir), credentials);
    await ensureUserWorkspace(ADMIN_USER_ID, getUserWorkspaceRootDir(rootDir));
    return true;
  });
}

async function writeJsonFile(filePath: string, value: unknown) {
  await writeJsonAtomic(filePath, value);
}

async function serializeAuthWrite<T>(operation: () => Promise<T>) {
  const run = authWriteQueue.catch(() => undefined).then(operation);
  authWriteQueue = run.then(() => undefined, () => undefined);
  return run;
}

export function normalizeUsername(username: string | null | undefined) {
  const trimmed = (username || "").trim();
  if (!trimmed) {
    return null;
  }

  if (!/^[A-Za-z0-9_-]{3,32}$/.test(trimmed)) {
    return null;
  }

  return trimmed.toLowerCase();
}

export function hashPassword(password: string) {
  const salt = randomBytes(16);
  const derived = scryptSync(password, salt, 64);
  return `scrypt$${salt.toString("hex")}$${derived.toString("hex")}`;
}

export function verifyPassword(password: string, passwordHash: string) {
  const [algorithm, saltHex, hashHex] = passwordHash.split("$");
  if (algorithm !== "scrypt" || !saltHex || !hashHex) {
    return false;
  }

  const derived = scryptSync(password, Buffer.from(saltHex, "hex"), Buffer.from(hashHex, "hex").length);
  const stored = Buffer.from(hashHex, "hex");

  if (derived.length !== stored.length) {
    return false;
  }

  return timingSafeEqual(derived, stored);
}

export async function readCredentials(rootDir = authRootDir) {
  await ensureAuthFiles(rootDir);
  return readJsonFile(getCredentialsPath(rootDir), defaultCredentials);
}

export async function readSessions(rootDir = authRootDir) {
  await ensureAuthFiles(rootDir);
  return readJsonFile(getSessionsPath(rootDir), defaultSessions);
}

export async function registerUser(username: string, password: string, rootDir = authRootDir, initialize?: (userId: string, usersRoot: string) => Promise<void>) {
  const normalizedUsername = normalizeUsername(username);
  if (!normalizedUsername) {
    throw new Error("Username must be 3-32 characters and use letters, numbers, underscore or dash.");
  }
  if (normalizedUsername === ADMIN_USERNAME) throw new Error("Username is reserved for the administrator.");

  if ((password || "").length < 6) {
    throw new Error("Password must be at least 6 characters long.");
  }

  return serializeAuthWrite(async () => {
    await ensureAuthFiles(rootDir);
    const credentials = await readJsonFile(getCredentialsPath(rootDir), defaultCredentials);

    if (credentials.users[normalizedUsername]) {
      throw new Error("Username is already taken.");
    }

    let userId = makeUserId();
    while (!normalizeUserId(userId)) {
      userId = makeUserId();
    }

    const timestamp = nowIso();
    credentials.users[normalizedUsername] = {
      username: username.trim(),
      passwordHash: hashPassword(password),
      userId,
      createdAt: timestamp,
      updatedAt: timestamp
    };

    try {
      if (initialize) {
        await initialize(userId, getUserWorkspaceRootDir(rootDir));
      } else {
      await ensureUserWorkspace(userId, getUserWorkspaceRootDir(rootDir));
      await syncUserWorkspace(
        {
          userProfile: {
            id: userId,
            label: username.trim(),
            createdAt: timestamp,
            updatedAt: timestamp
          },
          characters: [],
          chatSummaries: []
        },
        getUserWorkspaceRootDir(rootDir)
      );

      }
      await writeJsonFile(getCredentialsPath(rootDir), credentials);
    } catch (error) {
      await rm(join(getUserWorkspaceRootDir(rootDir), userId), { recursive: true, force: true });
      throw error;
    }
    return credentials.users[normalizedUsername];
  });
}

export async function findCredentialByUsername(username: string, rootDir = authRootDir) {
  const normalizedUsername = normalizeUsername(username);
  if (!normalizedUsername) {
    return null;
  }

  const credentials = await readCredentials(rootDir);
  return credentials.users[normalizedUsername] || null;
}

export async function claimStudioWelcome(credential: StoredCredential, rootDir = authRootDir) {
  if (!credential.studioWelcomePending) return false;
  return serializeAuthWrite(async () => {
    const path = getCredentialsPath(rootDir);
    const credentials = await readJsonFile(path, defaultCredentials);
    const stored = credentials.users[credential.username.toLowerCase()];
    if (!stored?.studioWelcomePending || stored.userId !== credential.userId) return false;
    delete stored.studioWelcomePending;
    await writeJsonFile(path, credentials);
    return true;
  });
}

export async function createSessionForUser(userId: string, username: string, rootDir = authRootDir): Promise<AuthSession> {
  const normalizedUserId = normalizeUserId(userId);
  if (!normalizedUserId) {
    throw new Error("Invalid user ID.");
  }

  return serializeAuthWrite(async () => {
    await ensureAuthFiles(rootDir);
    const sessions = await readJsonFile(getSessionsPath(rootDir), defaultSessions);
    const createdAt = nowIso();
    const expiresAt = new Date(Date.now() + SESSION_TTL_MS).toISOString();
    const sessionToken = makeSessionToken();

    sessions.sessions[sessionToken] = {
      userId: normalizedUserId,
      username,
      createdAt,
      expiresAt
    };

    await writeJsonFile(getSessionsPath(rootDir), sessions);

    return {
      sessionToken,
      userId: normalizedUserId,
      username,
      createdAt,
      expiresAt
    };
  });
}

export async function validateSession(sessionToken: string | null | undefined, rootDir = authRootDir): Promise<AuthSession | null> {
  const token = (sessionToken || "").trim();
  if (!token) {
    return null;
  }

  const sessions = await readSessions(rootDir);
  const session = sessions.sessions[token];
  if (!session) {
    return null;
  }

  if (new Date(session.expiresAt).getTime() <= Date.now()) {
    await revokeSession(token, rootDir);
    return null;
  }

  return {
    sessionToken: token,
    ...session
  };
}

export async function revokeSession(sessionToken: string, rootDir = authRootDir) {
  const token = (sessionToken || "").trim();
  if (!token) {
    return false;
  }

  return serializeAuthWrite(async () => {
    await ensureAuthFiles(rootDir);
    const sessions = await readJsonFile(getSessionsPath(rootDir), defaultSessions);
    if (!sessions.sessions[token]) {
      return false;
    }

    delete sessions.sessions[token];
    await writeJsonFile(getSessionsPath(rootDir), sessions);
    return true;
  });
}
