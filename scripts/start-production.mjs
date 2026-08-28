#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { productionListenerPids } from "./build-production.mjs";
import {
  defaultLiveCodeFreezePath,
  evaluateCodeFreezeCheck,
  evaluateProductionReleaseState,
  inspectLocalFrozenArtifact,
  inspectReleaseRevision,
  readLiveCodeFreeze,
} from "./live-code-freeze-lib.mjs";
import {
  acquireReleaseArtifactLease,
  attachReleaseArtifactLeaseChild,
  defaultReleaseArtifactLeasePath,
  releaseReleaseArtifactLease,
} from "./release-artifact-lease-lib.mjs";
import {
  dashboardRuntimeAssetPaths,
  fetchAndVerifyServedRelease,
} from "./release-integrity-lib.mjs";
import {
  PRODUCTION_SUPERVISION_HEARTBEAT_MS,
  createBoundedProductionRuntimeLog,
  defaultProductionSupervisionPath,
  removeProductionSupervisionState,
  writeProductionSupervisionState,
} from "./production-supervision-lib.mjs";

const PRODUCTION_ORIGIN = "http://127.0.0.1:3000";
const PRODUCTION_START_TIMEOUT_MS = 15_000;
const PRODUCTION_TERMINATION_GRACE_MS = 2_000;
export const PRODUCTION_TRADYR_KEYCHAIN_SERVICE = "DraftForge Tradyr";
export const PRODUCTION_TRADYR_KEYCHAIN_ACCOUNT = "draftforge";
export const PRODUCTION_KEYCHAIN_READ_TIMEOUT_MS = 5_000;
export const PRODUCTION_RESTART_BACKOFF_MS = Object.freeze([250, 1_000]);

export function resolveProductionEnvironment({
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
      "-s", PRODUCTION_TRADYR_KEYCHAIN_SERVICE,
      "-a", PRODUCTION_TRADYR_KEYCHAIN_ACCOUNT,
      "-w",
    ], {
      encoding: "utf8",
      timeout: PRODUCTION_KEYCHAIN_READ_TIMEOUT_MS,
      killSignal: "SIGKILL",
      maxBuffer: 8_192,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const credential = result?.status === 0 ? String(result.stdout || "").trim() : "";
    if (/^[\x21-\x7e]{8,4096}$/.test(credential)) resolved.TRADYR_API_KEY = credential;
  } catch {
    // Missing, denied, locked, or timed-out Keychain access leaves the server
    // safely source-blocked. No credential bytes or Keychain diagnostics are
    // emitted, persisted, or forwarded to the browser.
  }
  return Object.freeze(resolved);
}

export function nextProductionServerInstanceStartedAt(nowImpl = Date.now, previousEpochMs = -1) {
  const observedEpochMs = Number(nowImpl());
  if (!Number.isFinite(observedEpochMs) || observedEpochMs < 0) {
    throw new Error("PRODUCTION_SERVER_INSTANCE_CLOCK_INVALID");
  }
  const epochMs = Math.max(Math.trunc(observedEpochMs), Number(previousEpochMs) + 1);
  return Object.freeze({ epochMs, timestamp: new Date(epochMs).toISOString() });
}

const PRODUCTION_IDENTITY_FIELDS = Object.freeze([
  ["release", "revision"],
  ["artifact", "releaseManifestSha256"],
  ["artifact", "sourceTreeSha256"],
  ["artifact", "sourceTreeFileCount"],
  ["artifact", "clientAssetSetSha256"],
  ["artifact", "clientAssetCount"],
  ["artifact", "clientAssetBytes"],
  ["artifact", "serverAssetSetSha256"],
  ["artifact", "serverAssetCount"],
  ["artifact", "serverAssetBytes"],
  ["artifact", "extensionVersion"],
  ["artifact", "extensionSourceSha256"],
  ["artifact", "extensionSourceFileCount"],
  ["artifact", "extensionPackageSha256"],
]);

function productionValidationIdentity(validation) {
  return PRODUCTION_IDENTITY_FIELDS.map(([group, field]) => validation?.[group]?.[field]);
}

function sameProductionValidationIdentity(left, right) {
  const leftIdentity = productionValidationIdentity(left);
  const rightIdentity = productionValidationIdentity(right);
  return leftIdentity.length === rightIdentity.length
    && leftIdentity.every((value, index) => value === rightIdentity[index]);
}

function safeSignal(signal) {
  return /^SIG[A-Z0-9]+$/.test(String(signal || "")) ? String(signal) : null;
}

function unexpectedExitFields(outcome) {
  return {
    exitCode: Number.isInteger(outcome?.code) ? outcome.code : null,
    signal: safeSignal(outcome?.signal),
  };
}

function productionError(code, exitCode = 1) {
  const error = new Error(code);
  error.exitCode = exitCode;
  return error;
}

function emitProductionEvent(writeOutput, nowImpl, event) {
  let occurredAt = null;
  try {
    occurredAt = new Date(nowImpl()).toISOString();
  } catch { /* the event code and bounded fields remain authoritative */ }
  writeOutput(`${JSON.stringify({ ...event, ...(occurredAt ? { occurredAt } : {}) })}\n`);
}

function defaultSleep(milliseconds) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, milliseconds));
}

export function validateProductionStart(projectRoot = process.cwd()) {
  const release = inspectReleaseRevision(projectRoot);
  const releaseState = evaluateProductionReleaseState(release);
  if (!releaseState.ok) {
    const error = new Error(releaseState.code);
    error.result = releaseState;
    throw error;
  }
  const artifact = inspectLocalFrozenArtifact(projectRoot, release.revision);
  const freeze = readLiveCodeFreeze(defaultLiveCodeFreezePath(projectRoot));
  const result = evaluateCodeFreezeCheck({
    freeze,
    operation: "start",
    currentRevision: release.revision,
    currentRelease: release,
    currentArtifact: artifact,
  });
  if (!result.ok) {
    const error = new Error(result.code);
    error.result = result;
    throw error;
  }
  return { release, artifact, freeze, result };
}

export function validateProductionStartArguments(args) {
  if (!Array.isArray(args) || args.length !== 0) {
    throw new Error("PRODUCTION_START_ARGUMENTS_FORBIDDEN");
  }
  return Object.freeze([]);
}

export function productionServerArguments(projectRoot = process.cwd()) {
  return Object.freeze([
    "--import",
    resolve(projectRoot, "scripts/production-child-guard.mjs"),
    resolve(projectRoot, "node_modules/vinext/dist/cli.js"),
    "start",
    "--hostname",
    "127.0.0.1",
    "--port",
    "3000",
  ]);
}

function childOutcomePromise(child) {
  if (child.exitCode !== null && child.exitCode !== undefined) {
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode || null, error: null });
  }
  if (child.signalCode) return Promise.resolve({ code: null, signal: child.signalCode, error: null });
  return new Promise((resolveOutcome) => {
    child.once("error", (error) => resolveOutcome({ code: null, signal: null, error }));
    child.once("exit", (code, signal) => resolveOutcome({ code, signal, error: null }));
  });
}

async function waitForOutcome(outcomePromise, timeoutMs) {
  let timer;
  try {
    return await Promise.race([
      outcomePromise,
      new Promise((resolveTimeout) => {
        timer = setTimeout(() => resolveTimeout(null), timeoutMs);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function terminateProductionChild(
  child,
  outcomePromise,
  signal = "SIGTERM",
  graceMs = PRODUCTION_TERMINATION_GRACE_MS,
) {
  const alreadyExited = await waitForOutcome(outcomePromise, 0);
  if (alreadyExited) return true;
  try { child.kill(signal); } catch { /* escalation below remains authoritative */ }
  if (await waitForOutcome(outcomePromise, graceMs)) return true;
  try { child.kill("SIGKILL"); } catch { /* final bounded reap below */ }
  return Boolean(await waitForOutcome(outcomePromise, graceMs));
}

export async function waitForProductionServerReady({
  validation,
  childOutcome,
  origin = PRODUCTION_ORIGIN,
  fetchImpl = fetch,
  timeoutMs = PRODUCTION_START_TIMEOUT_MS,
} = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastError = "PRODUCTION_SERVER_NOT_READY";
  while (Date.now() < deadline) {
    const exited = await waitForOutcome(childOutcome, 0);
    if (exited) throw new Error(exited.error ? "PRODUCTION_SERVER_SPAWN_FAILED" : "PRODUCTION_SERVER_EXITED_BEFORE_READY");
    try {
      const response = await fetchImpl(`${origin}/`, {
        headers: { Accept: "text/html", "Cache-Control": "no-cache" },
        cache: "no-store",
        redirect: "error",
        signal: AbortSignal.timeout(2_000),
      });
      if (!response.ok) throw new Error(`PRODUCTION_SERVER_HEALTH_HTTP_${response.status}`);
      const html = await response.text();
      const requiredRuntimeAssetPaths = dashboardRuntimeAssetPaths(html, origin);
      if (!requiredRuntimeAssetPaths.some((assetPath) => assetPath.includes("/_next/static/chunks/"))) {
        throw new Error("PRODUCTION_SERVER_RUNTIME_ASSET_MISSING");
      }
      const served = await fetchAndVerifyServedRelease({
        origin,
        expectedRevision: validation.release.revision,
        expectedSourceTree: {
          sha256: validation.artifact.sourceTreeSha256,
          fileCount: validation.artifact.sourceTreeFileCount,
        },
        requiredRuntimeAssetPaths,
        fetchImpl,
      });
      if (served.manifestSha256 !== validation.artifact.releaseManifestSha256
        || served.manifest.clientAssets.sha256 !== validation.artifact.clientAssetSetSha256
        || served.serverAssetSetSha256 !== validation.artifact.serverAssetSetSha256) {
        throw new Error("PRODUCTION_SERVER_ARTIFACT_MISMATCH");
      }
      const checkpointResponse = await fetchImpl(`${origin}/api/draft-day?view=hydrate`, {
        headers: { Accept: "application/json", "Cache-Control": "no-cache" },
        cache: "no-store",
        redirect: "error",
        signal: AbortSignal.timeout(2_000),
      });
      const checkpoint = await checkpointResponse.json().catch(() => null);
      if (!checkpointResponse.ok || checkpoint?.ok !== true || typeof checkpoint?.code !== "string") {
        throw new Error(`PRODUCTION_DRAFT_AUDIT_CHECKPOINT_NOT_READY:${checkpoint?.code || checkpointResponse.status}`);
      }
      return Object.freeze({
        origin,
        manifestSha256: served.manifestSha256,
        clientAssetSetSha256: served.manifest.clientAssets.sha256,
        serverAssetSetSha256: served.serverAssetSetSha256,
      });
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    const exitedAfterAttempt = await waitForOutcome(childOutcome, 150);
    if (exitedAfterAttempt) throw new Error(exitedAfterAttempt.error ? "PRODUCTION_SERVER_SPAWN_FAILED" : "PRODUCTION_SERVER_EXITED_BEFORE_READY");
  }
  throw new Error(`PRODUCTION_SERVER_READY_TIMEOUT:${lastError}`);
}

export async function startProduction({
  projectRoot = process.cwd(),
  args = process.argv.slice(2),
  spawnImpl = spawn,
  validateImpl = validateProductionStart,
  readyImpl = waitForProductionServerReady,
  writeOutput = (value) => process.stdout.write(value),
  sleepImpl = defaultSleep,
  nowImpl = Date.now,
  portProbeImpl = productionListenerPids,
  signalSource = process,
  environment = process.env,
} = {}) {
  const exactProjectRoot = resolve(projectRoot);
  validateProductionStartArguments(args);
  let lease = acquireReleaseArtifactLease({
    projectRoot: exactProjectRoot,
    leasePath: defaultReleaseArtifactLeasePath(exactProjectRoot),
    operation: "start",
  });
  let child = null;
  let outcomePromise = null;
  let terminationPromise = null;
  let leaseCanRelease = true;
  let outcome = null;
  let operationError = null;
  let shutdownSignal = null;
  let previousServerInstanceStartedAtMs = -1;
  let supervisionHeartbeat = null;
  let supervisionToken = null;
  const supervisionPath = defaultProductionSupervisionPath(exactProjectRoot);
  const runtimeLog = createBoundedProductionRuntimeLog({
    logPath: resolve(exactProjectRoot, ".draftforge", "production-runtime.log"),
  });
  runtimeLog.append(`\n${JSON.stringify({ code: "PRODUCTION_RUNTIME_SESSION_STARTED", occurredAt: new Date().toISOString() })}\n`);
  const forwardedSignals = ["SIGINT", "SIGTERM", "SIGHUP"];
  const signalHandlers = new Map(forwardedSignals.map((signal) => [
    signal,
    () => {
      shutdownSignal ||= signal;
      if (!child || !outcomePromise) return;
      if (!terminationPromise) {
        terminationPromise = terminateProductionChild(child, outcomePromise, signal);
      } else {
        try { child.kill("SIGKILL"); } catch { /* existing bounded reap owns cleanup */ }
      }
    },
  ]));

  try {
    const initialValidation = validateImpl(exactProjectRoot);
    let validation = initialValidation;
    let restartAttempt = 0;
    let pendingUnexpectedExit = null;
    for (const [signal, handler] of signalHandlers) signalSource.on(signal, handler);

    while (true) {
      if (pendingUnexpectedExit) {
        const delayMs = PRODUCTION_RESTART_BACKOFF_MS[restartAttempt - 1];
        emitProductionEvent(writeOutput, nowImpl, {
          ok: true,
          code: "PRODUCTION_SERVER_RESTART_SCHEDULED",
          restartAttempt,
          delayMs,
          ...unexpectedExitFields(pendingUnexpectedExit),
        });
        await sleepImpl(delayMs);
        if (shutdownSignal) {
          throw productionError(`PRODUCTION_SERVER_OPERATOR_SHUTDOWN_${shutdownSignal}`);
        }

        validation = validateImpl(exactProjectRoot);
        if (!sameProductionValidationIdentity(initialValidation, validation)) {
          throw productionError("PRODUCTION_SERVER_RESTART_ARTIFACT_CHANGED");
        }
        let listenerPids;
        try {
          listenerPids = portProbeImpl();
        } catch {
          throw productionError("PRODUCTION_SERVER_RESTART_PORT_PROBE_FAILED");
        }
        if (!Array.isArray(listenerPids)) {
          throw productionError("PRODUCTION_SERVER_RESTART_PORT_PROBE_FAILED");
        }
        if (listenerPids.length > 0) {
          throw productionError("PRODUCTION_SERVER_RESTART_PORT_OCCUPIED");
        }
        if (shutdownSignal) {
          throw productionError(`PRODUCTION_SERVER_OPERATOR_SHUTDOWN_${shutdownSignal}`);
        }
      }

      const serverInstance = nextProductionServerInstanceStartedAt(
        nowImpl,
        previousServerInstanceStartedAtMs,
      );
      previousServerInstanceStartedAtMs = serverInstance.epochMs;
      supervisionToken = randomBytes(16).toString("hex");
      child = spawnImpl(
        process.execPath,
        productionServerArguments(exactProjectRoot),
        {
          cwd: exactProjectRoot,
          env: {
            ...environment,
            DRAFTFORGE_PERSIST_AVAILABILITY_STAGE: "1",
            DRAFTFORGE_PERSIST_DRAFT_AUDIT_CHECKPOINT: "1",
            DRAFTFORGE_RELEASE_REVISION: validation.release.revision,
            DRAFTFORGE_SERVER_INSTANCE_STARTED_AT: serverInstance.timestamp,
            DRAFTFORGE_PRODUCTION_SUPERVISION_PATH: supervisionPath,
            DRAFTFORGE_PRODUCTION_SUPERVISION_TOKEN: supervisionToken,
            DRAFTFORGE_PRODUCTION_SUPERVISOR_PID: String(process.pid),
            // Wrangler diagnostics join the same bounded stderr stream instead
            // of growing a second unmonitored runtime file.
            WRANGLER_LOG_PATH: process.platform === "win32" ? "NUL" : "/dev/stderr",
          },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      child.stdout?.on?.("data", (chunk) => runtimeLog.append(chunk));
      child.stderr?.on?.("data", (chunk) => runtimeLog.append(chunk));
      outcomePromise = childOutcomePromise(child);
      terminationPromise = null;
      if (!Number.isInteger(child.pid) || child.pid <= 0) {
        await waitForOutcome(outcomePromise, 250);
        throw productionError("PRODUCTION_SERVER_CHILD_PID_UNAVAILABLE");
      }
      const publishSupervisionHeartbeat = () => writeProductionSupervisionState(supervisionPath, {
        schemaVersion: 1,
        token: supervisionToken,
        supervisorPid: process.pid,
        childPid: child.pid,
        releaseRevision: validation.release.revision,
        serverInstanceStartedAt: serverInstance.timestamp,
        updatedAt: new Date().toISOString(),
      });
      publishSupervisionHeartbeat();
      supervisionHeartbeat = setInterval(publishSupervisionHeartbeat, PRODUCTION_SUPERVISION_HEARTBEAT_MS);
      supervisionHeartbeat.unref?.();
      try {
        lease = attachReleaseArtifactLeaseChild(lease, child.pid);
      } catch (error) {
        child.kill("SIGTERM");
        throw error;
      }

      // Auto-Draft lives only in the browser writer state. A new server child
      // receives no restoration input and must always be re-armed explicitly.
      await readyImpl({ validation, childOutcome: outcomePromise });
      emitProductionEvent(writeOutput, nowImpl, {
        ok: true,
        code: "PRODUCTION_SERVER_READY",
        validationCode: validation.result.code,
        revision: validation.release.revision,
        clientAssetSetSha256: validation.artifact.clientAssetSetSha256,
        serverAssetSetSha256: validation.artifact.serverAssetSetSha256,
        extensionSourceSha256: validation.artifact.extensionSourceSha256,
        origin: PRODUCTION_ORIGIN,
        restartAttempt,
        autoDraftRestored: false,
        tradyrCredentialAvailable: Boolean(environment.TRADYR_API_KEY),
        serverInstanceStartedAt: serverInstance.timestamp,
      });

      outcome = await outcomePromise;
      if (supervisionHeartbeat) clearInterval(supervisionHeartbeat);
      supervisionHeartbeat = null;
      removeProductionSupervisionState(supervisionPath, supervisionToken);
      const stopped = terminationPromise
        ? await terminationPromise
        : await terminateProductionChild(child, outcomePromise);
      if (!stopped) {
        leaseCanRelease = false;
        throw productionError("PRODUCTION_SERVER_REAP_TIMEOUT_LEASE_RETAINED");
      }
      child = null;
      outcomePromise = null;
      terminationPromise = null;

      if (shutdownSignal) {
        throw productionError(`PRODUCTION_SERVER_OPERATOR_SHUTDOWN_${shutdownSignal}`);
      }
      if (outcome.error) throw productionError("PRODUCTION_SERVER_SPAWN_FAILED");
      const unexpectedExit = Number.isInteger(outcome.code)
        || Boolean(safeSignal(outcome.signal));
      if (!unexpectedExit) throw productionError("PRODUCTION_SERVER_EXIT_OUTCOME_INVALID");
      if (restartAttempt >= PRODUCTION_RESTART_BACKOFF_MS.length) {
        emitProductionEvent(writeOutput, nowImpl, {
          ok: false,
          code: "PRODUCTION_SERVER_RESTARTS_EXHAUSTED",
          restartAttempts: restartAttempt,
          ...unexpectedExitFields(outcome),
        });
        throw productionError(
          "PRODUCTION_SERVER_RESTARTS_EXHAUSTED",
          Number.isInteger(outcome.code) && outcome.code !== 0 ? outcome.code : 1,
        );
      }
      pendingUnexpectedExit = outcome;
      restartAttempt += 1;
    }
  } catch (error) {
    operationError = error;
  } finally {
    for (const [signal, handler] of signalHandlers) signalSource.off(signal, handler);
    if (child && outcomePromise) {
      const stopped = terminationPromise
        ? await terminationPromise
        : await terminateProductionChild(child, outcomePromise);
      if (!stopped) leaseCanRelease = false;
    }
    if (supervisionHeartbeat) clearInterval(supervisionHeartbeat);
    if (supervisionToken) removeProductionSupervisionState(supervisionPath, supervisionToken);
    if (leaseCanRelease) releaseReleaseArtifactLease(lease);
  }
  if (!leaseCanRelease) throw new Error("PRODUCTION_SERVER_REAP_TIMEOUT_LEASE_RETAINED");
  if (operationError) throw operationError;
  return outcome;
}

async function main() {
  try {
    const environment = resolveProductionEnvironment();
    await startProduction({ environment });
  } catch (error) {
    process.stderr.write(`${JSON.stringify({
      ok: false,
      code: error instanceof Error ? error.message : "PRODUCTION_START_FAILED",
    })}\n`);
    process.exitCode = Number(error?.exitCode) || 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) await main();
