import { spawnSync } from "node:child_process";

export const SERVER_TRADYR_KEYCHAIN_SERVICE = "DraftForge Tradyr";
export const SERVER_TRADYR_KEYCHAIN_ACCOUNT = "draftforge";
export const SERVER_TRADYR_KEYCHAIN_READ_TIMEOUT_MS = 5_000;
export const SERVER_TRADYR_KEYCHAIN_READ_MAX_BUFFER_BYTES = 8_192;

const PRINTABLE_TRADYR_CREDENTIAL = /^[\x21-\x7e]{8,4096}$/;

/**
 * Resolve the server-only Tradyr environment once without emitting Keychain
 * diagnostics or credential bytes. Explicit process configuration always wins;
 * unsupported platforms and every Keychain failure remain safely unconfigured.
 */
export function resolveServerOnlyTradyrEnvironment({
  environment = process.env,
  platform = process.platform,
  keychainReadImpl = spawnSync,
} = {}) {
  const resolved = { ...environment };
  const existing = String(resolved.TRADYR_API_KEY || "").trim();
  if (existing) {
    resolved.TRADYR_API_KEY = existing;
    return Object.freeze(resolved);
  }
  delete resolved.TRADYR_API_KEY;
  if (platform !== "darwin") return Object.freeze(resolved);
  try {
    const result = keychainReadImpl("/usr/bin/security", [
      "find-generic-password",
      "-s", SERVER_TRADYR_KEYCHAIN_SERVICE,
      "-a", SERVER_TRADYR_KEYCHAIN_ACCOUNT,
      "-w",
    ], {
      encoding: "utf8",
      timeout: SERVER_TRADYR_KEYCHAIN_READ_TIMEOUT_MS,
      killSignal: "SIGKILL",
      maxBuffer: SERVER_TRADYR_KEYCHAIN_READ_MAX_BUFFER_BYTES,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const credential = result?.status === 0 ? String(result.stdout || "").trim() : "";
    if (PRINTABLE_TRADYR_CREDENTIAL.test(credential)) resolved.TRADYR_API_KEY = credential;
  } catch {
    // Missing, denied, locked, or timed-out Keychain access remains fail closed.
    // Never emit, persist, or forward credential bytes or Keychain diagnostics.
  }
  return Object.freeze(resolved);
}

/**
 * Make the resolved credential available only for one awaited server operation,
 * then restore the caller's environment exactly even if the operation fails.
 */
export async function withServerOnlyTradyrEnvironment(
  operation,
  {
    environment = process.env,
    platform = process.platform,
    keychainReadImpl = spawnSync,
  } = {},
) {
  if (typeof operation !== "function") throw new TypeError("TRADYR_SERVER_OPERATION_REQUIRED");
  const hadCredential = Object.hasOwn(environment, "TRADYR_API_KEY");
  const previousCredential = environment.TRADYR_API_KEY;
  const resolved = resolveServerOnlyTradyrEnvironment({ environment, platform, keychainReadImpl });
  try {
    if (resolved.TRADYR_API_KEY) environment.TRADYR_API_KEY = resolved.TRADYR_API_KEY;
    else delete environment.TRADYR_API_KEY;
    return await operation();
  } finally {
    if (hadCredential) environment.TRADYR_API_KEY = previousCredential;
    else delete environment.TRADYR_API_KEY;
  }
}
