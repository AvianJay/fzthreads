import {createHash} from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { ThreadsAPI } from "threads-api";

let tokenStore = {
  token: "",
  timestamp: 0,
  username: "",
};
let failedCredentials = new Map<string, number>();
let runningLogin = false;
let hasReadTokenFile = false;

const TOKEN_PATH = path.join(process.cwd(), "generated", "token.json");
const RUNTIME_DEBUG_FILE = "./runtime-debug.log";
const ROOT_USERS_PATH = path.join(process.cwd(), "config", "users.json");
const LIB_USERS_PATH = path.join(process.cwd(), "lib", "config", "users.json");
const FAILED_CREDENTIAL_RETRY_MS = 5 * 60 * 1000;
const PLACEHOLDER_USERNAMES = new Set(["USERNAME", "YOUR_USERNAME"]);
const PLACEHOLDER_PASSWORDS = new Set(["PASSWORD", "YOUR_PASSWORD"]);
const PLACEHOLDER_DEVICE_IDS = new Set(["DEVICE_ID", "YOUR_DEVICE_ID"]);
const PLACEHOLDER_TOKENS = new Set([
  "TOKEN",
  "YOUR_TOKEN",
  "BEARER_TOKEN",
  "YOUR_BEARER_TOKEN",
]);

type IgUser = {
  username?: string;
  password?: string;
  deviceId?: string;
  token?: string;
  bearerToken?: string;
  cookies?: Record<string, string>;
};

type PasswordCredential = {
  kind: "password";
  username: string;
  password: string;
  deviceId?: string;
  identifier: string;
};

type TokenCredential = {
  kind: "token";
  token: string;
  username?: string;
  identifier: string;
};

type CookieCredential = {
  kind: "cookie";
  cookies: Record<string, string>;
  username?: string;
  identifier: string;
};

type ResolvedCredential = PasswordCredential | TokenCredential | CookieCredential;

function getTokenKind(token: string): "cookie" | "bearer" | "unknown" {
  if (token.startsWith("COOKIE:")) return "cookie";
  if (token.startsWith("Bearer ")) return "bearer";
  return "unknown";
}

function buildStoredToken(credential: TokenCredential | CookieCredential): string {
  if (credential.kind === "token") {
    return credential.token;
  }

  return `COOKIE:${JSON.stringify(credential.cookies)}`;
}

function applyStaticCredential(
  credential: TokenCredential | CookieCredential,
  step: string
) {
  const nextToken = buildStoredToken(credential);
  const nextUsername = credential.username || "";
  const didChange =
    tokenStore.token !== nextToken || tokenStore.username !== nextUsername;

  tokenStore = {
    token: nextToken,
    timestamp: Date.now(),
    username: nextUsername,
  };

  if (didChange) {
    writeTokenFile();
  }

  writeLoginDebug(step, {
    username: nextUsername,
    credentialKind: credential.kind,
    didChange,
  });

  return tokenStore;
}

function writeLoginDebug(
  step: string,
  details?: Record<string, string | number | boolean | undefined | null>
) {
  try {
    fs.appendFileSync(
      RUNTIME_DEBUG_FILE,
      `${JSON.stringify({
        time: new Date().toISOString(),
        step,
        ...details,
      })}\n`
    );
  } catch {}
}

function hashIdentifier(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function resolveUsersPath(): string {
  if (fs.existsSync(ROOT_USERS_PATH)) return ROOT_USERS_PATH;
  if (fs.existsSync(LIB_USERS_PATH)) return LIB_USERS_PATH;
  return ROOT_USERS_PATH;
}

function readUsersFile(): {users: IgUser[]; usersPath: string} {
  const usersPath = resolveUsersPath();

  try {
    if (!fs.existsSync(usersPath)) {
      writeLoginDebug("igLogin:usersFileMissing", {usersPath});
      return {
        users: [],
        usersPath,
      };
    }

    const userFile = fs.readFileSync(usersPath, "utf-8");
    const parsedUsers = JSON.parse(userFile);

    return {
      users: Array.isArray(parsedUsers) ? parsedUsers : [],
      usersPath,
    };
  } catch (e) {
    console.error("Failed to read users file:", e);
    writeLoginDebug("igLogin:usersFileReadError", {
      usersPath,
      message: e instanceof Error ? e.message : String(e),
    });
    return {
      users: [],
      usersPath,
    };
  }
}

function normalizeManualToken(rawToken: string): string | undefined {
  const trimmedToken = rawToken.trim();
  if (!trimmedToken) return;
  if (PLACEHOLDER_TOKENS.has(trimmedToken.toUpperCase())) return;

  if (trimmedToken.startsWith("Bearer IGT:2:")) return trimmedToken;
  if (trimmedToken.startsWith("IGT:2:")) return `Bearer ${trimmedToken}`;
  if (trimmedToken.startsWith("Bearer ")) return trimmedToken;

  return `Bearer IGT:2:${trimmedToken}`;
}

function getUsableCredential(user: IgUser): ResolvedCredential | undefined {
  const username = typeof user.username === "string" ? user.username.trim() : "";
  const password = typeof user.password === "string" ? user.password.trim() : "";
  const deviceId = typeof user.deviceId === "string" ? user.deviceId.trim() : "";
  const tokenValue =
    typeof user.token === "string"
      ? user.token
      : typeof user.bearerToken === "string"
        ? user.bearerToken
        : "";
  const normalizedToken = tokenValue ? normalizeManualToken(tokenValue) : undefined;

  // 優先检查 cookie-based login
  if (user.cookies && typeof user.cookies === "object" && user.cookies.sessionid) {
    return {
      kind: "cookie",
      cookies: user.cookies,
      ...(username ? {username} : {}),
      identifier: `cookie:${hashIdentifier(user.cookies.sessionid)}`,
    };
  }

  if (normalizedToken) {
    return {
      kind: "token",
      token: normalizedToken,
      ...(username ? {username} : {}),
      identifier: `token:${hashIdentifier(normalizedToken)}`,
    };
  }

  if (!username || !password) return;
  if (PLACEHOLDER_USERNAMES.has(username.toUpperCase())) return;
  if (PLACEHOLDER_PASSWORDS.has(password.toUpperCase())) return;
  if (deviceId && PLACEHOLDER_DEVICE_IDS.has(deviceId.toUpperCase())) {
    return;
  }

  return {
    kind: "password",
    username,
    password,
    ...(deviceId ? {deviceId} : {}),
    identifier: `password:${hashIdentifier(`${username}:${password}:${deviceId}`)}`,
  };
}

function isResolvedCredential(
  credential: ResolvedCredential | undefined
): credential is ResolvedCredential {
  return Boolean(credential);
}

function shouldSkipCredential(identifier: string): boolean {
  const retryAt = failedCredentials.get(identifier);
  if (!retryAt) return false;

  if (retryAt <= Date.now()) {
    failedCredentials.delete(identifier);
    return false;
  }

  return true;
}

function markCredentialFailure(identifier: string) {
  failedCredentials.set(identifier, Date.now() + FAILED_CREDENTIAL_RETRY_MS);
}

function clearCredentialFailure(identifier: string) {
  failedCredentials.delete(identifier);
}

function readTokenFile() {
  if (!fs.existsSync(TOKEN_PATH)) return;
  try {
    const tokenFile = fs.readFileSync(TOKEN_PATH, "utf-8");
    tokenStore = JSON.parse(tokenFile);
    writeLoginDebug("igLogin:tokenFileLoaded", {
      hasToken: Boolean(tokenStore.token),
      username: tokenStore.username || "",
    });
  } catch (e) {
    console.error("Failed to read token file:", e);
    writeLoginDebug("igLogin:tokenFileReadError", {
      message: e instanceof Error ? e.message : String(e),
    });
  }
}

function writeTokenFile() {
  try {
    const dir = path.dirname(TOKEN_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(TOKEN_PATH, JSON.stringify(tokenStore, null, 2));
  } catch (e) {
    console.error("Failed to write token file:", e);
    writeLoginDebug("igLogin:tokenFileWriteError", {
      message: e instanceof Error ? e.message : String(e),
    });
  }
}

async function runIgLogin() {
  if (runningLogin) return false;

  const {users, usersPath} = readUsersFile();
  const resolvedCredentials = users
    .map(user => getUsableCredential(user))
    .filter(isResolvedCredential);
  const availableCredentials = resolvedCredentials.filter(
    credential => !shouldSkipCredential(credential.identifier)
  );

  writeLoginDebug("igLogin:credentialsLoaded", {
    usersPath,
    userCount: users.length,
    usableCredentials: resolvedCredentials.length,
    availableCredentials: availableCredentials.length,
  });

  if (availableCredentials.length === 0) return false;

  runningLogin = true;

  try {
    for (const credential of availableCredentials) {
      if (credential.kind === "token") {
        tokenStore = {
          token: credential.token,
          timestamp: Date.now(),
          username: credential.username || "",
        };
        clearCredentialFailure(credential.identifier);
        writeTokenFile();
        writeLoginDebug("igLogin:manualTokenAccepted", {
          username: credential.username || "",
        });
        return tokenStore;
      }

      // Cookie-based login - use cookies directly for requests
      if (credential.kind === "cookie") {
        // Store cookies in tokenStore for later use
        tokenStore = {
          token: `COOKIE:${JSON.stringify(credential.cookies)}`,
          timestamp: Date.now(),
          username: credential.username || "",
        };
        clearCredentialFailure(credential.identifier);
        writeTokenFile();
        writeLoginDebug("igLogin:cookieLoginAccepted", {
          username: credential.username || "",
          hasSessionId: Boolean(credential.cookies.sessionid),
        });
        return tokenStore;
      }

      try {
        writeLoginDebug("igLogin:attempt", {
          username: credential.username,
          hasDeviceId: Boolean(credential.deviceId),
          usersPath,
        });

        const threads = new ThreadsAPI({
          username: credential.username,
          password: credential.password,
          deviceID: credential.deviceId || undefined,
        });

        await threads.login();

        if (!threads.token) {
          markCredentialFailure(credential.identifier);
          writeLoginDebug("igLogin:attemptNoToken", {
            username: credential.username,
          });
          continue;
        }

        tokenStore = {
          token: `Bearer IGT:2:${threads.token}`,
          timestamp: Date.now(),
          username: credential.username,
        };
        clearCredentialFailure(credential.identifier);
        writeTokenFile();
        writeLoginDebug("igLogin:success", {
          username: credential.username,
        });
        return tokenStore;
      } catch (e) {
        const errorMessage = e instanceof Error ? e.message : String(e);
        const errorStack = e instanceof Error ? e.stack : undefined;
        console.error(`Login failed for ${credential.username}:`, errorMessage);
        console.error(`Error details:`, errorStack || "No stack trace");
        markCredentialFailure(credential.identifier);
        writeLoginDebug("igLogin:error", {
          username: credential.username,
          usersPath,
          hasDeviceId: Boolean(credential.deviceId),
          message: errorMessage,
        });
      }
    }

    return false;
  } finally {
    runningLogin = false;
  }
}

async function login(retrieveOnly: boolean = false) {
  const {users, usersPath} = readUsersFile();
  const usableCredentials = users
    .map(user => getUsableCredential(user))
    .filter(isResolvedCredential);

  if (!hasReadTokenFile) {
    readTokenFile();
    hasReadTokenFile = true;
  }

  const preferredStaticCredential = usableCredentials.find(
    (
      credential
    ): credential is TokenCredential | CookieCredential =>
      credential.kind === "token" || credential.kind === "cookie"
  );

  if (preferredStaticCredential) {
    return applyStaticCredential(
      preferredStaticCredential,
      "igLogin:usingConfiguredCredential"
    );
  }

  if (retrieveOnly) {
    if (!tokenStore.token) return false;
    return tokenStore;
  }

  if (tokenStore.token) {
    writeLoginDebug("igLogin:usingCachedToken", {
      username: tokenStore.username || "",
      tokenKind: getTokenKind(tokenStore.token),
    });
    return tokenStore;
  }

  if (usableCredentials.length === 0) {
    writeLoginDebug("igLogin:noUsableCredentials", {
      usersPath,
      userCount: users.length,
    });
    return false;
  }

  return await runIgLogin();
}

async function refreshToken() {
  tokenStore = {
    token: "",
    timestamp: 0,
    username: "",
  };
  writeTokenFile();
  writeLoginDebug("igLogin:refreshRequested");

  return await login();
}

export { login, refreshToken };
