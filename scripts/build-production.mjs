#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import { rmSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  acquireReleaseArtifactLease,
  attachReleaseArtifactLeaseChild,
  defaultReleaseArtifactLeasePath,
  releaseReleaseArtifactLease,
} from "./release-artifact-lease-lib.mjs";
import {
  defaultLiveCodeFreezePath,
  evaluateCodeFreezeCheck,
  evaluateProductionReleaseState,
  inspectReleaseRevision,
  readLiveCodeFreeze,
} from "./live-code-freeze-lib.mjs";
import {
  RELEASE_MANIFEST_FILENAME,
  writeServedReleaseManifest,
} from "./release-integrity-lib.mjs";

export const TRUSTED_PRODUCTION_LSOF_PATHS = Object.freeze(
  process.platform === "darwin"
    ? ["/usr/sbin/lsof", "/usr/bin/lsof", "/bin/lsof"]
    : ["/usr/bin/lsof", "/usr/sbin/lsof", "/bin/lsof"],
);
export const PRODUCTION_LISTENER_PROBE_TIMEOUT_MS = 2_000;
export const PRODUCTION_LISTENER_PROBE_MAX_BUFFER_BYTES = 8_192;

function productionListenerCheckFailed() {
  return new Error("PRODUCTION_BUILD_LISTENER_CHECK_FAILED");
}

function parseProductionListenerPids(output) {
  const trimmed = String(output || "").trim();
  if (!trimmed) return [];
  const tokens = trimmed.split(/\s+/);
  if (!tokens.every((token) => /^[1-9]\d*$/.test(token))) {
    throw productionListenerCheckFailed();
  }
  const pids = tokens.map(Number);
  if (!pids.every(Number.isSafeInteger)) throw productionListenerCheckFailed();
  return [...new Set(pids)];
}

export function productionListenerPids(
  spawnSyncImpl = spawnSync,
  trustedLsofPaths = TRUSTED_PRODUCTION_LSOF_PATHS,
) {
  const candidates = [...new Set(trustedLsofPaths.map(String).filter((path) => path.startsWith("/")))];
  if (!candidates.length) throw productionListenerCheckFailed();
  for (const lsofPath of candidates) {
    const result = spawnSyncImpl(
      lsofPath,
      ["-nP", "-iTCP:3000", "-sTCP:LISTEN", "-t"],
      {
        encoding: "utf8",
        timeout: PRODUCTION_LISTENER_PROBE_TIMEOUT_MS,
        killSignal: "SIGKILL",
        maxBuffer: PRODUCTION_LISTENER_PROBE_MAX_BUFFER_BYTES,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    if (result?.error?.code === "ENOENT") continue;
    const stdout = String(result?.stdout || "");
    const stderr = String(result?.stderr || "");
    if (result?.error || result?.signal || stderr.trim()) throw productionListenerCheckFailed();
    // lsof exits 1 with no output when the selector has no matches. A zero
    // status must prove at least one strict PID; every other result is unsafe.
    if (result?.status === 1 && !stdout.trim()) return [];
    if (result?.status !== 0 || !stdout.trim()) throw productionListenerCheckFailed();
    return parseProductionListenerPids(stdout);
  }
  throw productionListenerCheckFailed();
}

export async function buildProduction({
  repoRoot = process.cwd(),
  leasePath = defaultReleaseArtifactLeasePath(repoRoot),
  freezePath = defaultLiveCodeFreezePath(repoRoot),
  spawnImpl = spawn,
  listenerProbeImpl = spawnSync,
  listenerPidsImpl = () => productionListenerPids(listenerProbeImpl),
  inspectReleaseImpl = inspectReleaseRevision,
} = {}) {
  const exactRepoRoot = resolve(repoRoot);
  const clientRoot = resolve(exactRepoRoot, "dist/client");
  const serverRoot = resolve(exactRepoRoot, "dist/server");
  const servedManifest = resolve(clientRoot, RELEASE_MANIFEST_FILENAME);
  let lease = acquireReleaseArtifactLease({
    projectRoot: exactRepoRoot,
    leasePath,
    operation: "build",
  });

  let child = null;
  const forwardedSignals = ["SIGINT", "SIGTERM", "SIGHUP"];
  const signalHandlers = new Map(forwardedSignals.map((signal) => [
    signal,
    () => {
      if (child?.pid && !child.killed) child.kill(signal);
    },
  ]));

  try {
    const freeze = readLiveCodeFreeze(freezePath);
    const freezeCheck = evaluateCodeFreezeCheck({
      freeze,
      operation: "build",
      currentRevision: freeze?.revision,
    });
    if (!freezeCheck.ok) throw new Error(freezeCheck.code);

    const listeners = listenerPidsImpl();
    if (listeners.length) {
      const error = new Error("PRODUCTION_BUILD_SERVER_ACTIVE");
      error.listenerPids = listeners;
      throw error;
    }

    let inputRelease = null;
    let inputReleaseCheck;
    try {
      inputRelease = inspectReleaseImpl(exactRepoRoot);
      inputReleaseCheck = evaluateProductionReleaseState(inputRelease);
    } catch {
      inputReleaseCheck = {
        ok: false,
        code: "PRODUCTION_BUILD_SOURCE_STATE_UNAVAILABLE",
      };
    }

    // A failed build must never leave a prior manifest that appears to certify
    // it. The lease and listener check happen first, so a live server never sees
    // this mutation.
    rmSync(servedManifest, { force: true });

    child = spawnImpl(
      process.execPath,
      [resolve(exactRepoRoot, "node_modules/vinext/dist/cli.js"), "build"],
      {
        cwd: exactRepoRoot,
        env: { ...process.env, WRANGLER_LOG_PATH: process.env.WRANGLER_LOG_PATH || ".wrangler/wrangler.log" },
        stdio: "inherit",
      },
    );
    if (!Number.isInteger(child.pid) || child.pid <= 0) {
      child.kill?.("SIGTERM");
      throw new Error("PRODUCTION_BUILD_CHILD_PID_UNAVAILABLE");
    }
    try {
      lease = attachReleaseArtifactLeaseChild(lease, child.pid);
    } catch (error) {
      child.kill("SIGTERM");
      throw error;
    }
    for (const [signal, handler] of signalHandlers) process.on(signal, handler);
    const outcome = await new Promise((resolveOutcome, rejectOutcome) => {
      child.once("error", rejectOutcome);
      child.once("exit", (code, signal) => resolveOutcome({ code, signal }));
    });
    if (outcome.code !== 0) {
      const error = new Error("PRODUCTION_BUILD_FAILED");
      error.exitCode = Number.isInteger(outcome.code) ? outcome.code : 1;
      error.signal = outcome.signal || undefined;
      throw error;
    }

    let outputRelease = null;
    let outputReleaseCheck;
    try {
      outputRelease = inspectReleaseImpl(exactRepoRoot);
      outputReleaseCheck = evaluateProductionReleaseState(outputRelease);
    } catch {
      outputReleaseCheck = {
        ok: false,
        code: "PRODUCTION_BUILD_SOURCE_STATE_UNAVAILABLE",
      };
    }

    const sameRevision = Boolean(
      inputRelease?.revision
      && inputRelease.revision === outputRelease?.revision,
    );
    if (!inputReleaseCheck.ok || !outputReleaseCheck.ok || !sameRevision) {
      // Development/test builds remain usable in a dirty checkout, but they
      // cannot inherit or emit a production certification. In particular, a
      // build that consumed an untracked input and removed it before exit is
      // still rejected because its input state was captured before spawning.
      rmSync(servedManifest, { force: true });
      return {
        ok: true,
        certified: false,
        code: "PRODUCTION_BUILD_UNCERTIFIED_SOURCE_STATE",
        inputReleaseCode: inputReleaseCheck.code,
        outputReleaseCode: outputReleaseCheck.code,
        revisionStable: sameRevision,
      };
    }

    try {
      const written = writeServedReleaseManifest({
        repoRoot: exactRepoRoot,
        clientRoot,
        serverRoot,
        revision: outputRelease.revision,
      });
      return {
        ok: true,
        certified: true,
        code: "PRODUCTION_BUILD_INTEGRITY_WRITTEN",
        revision: written.manifest.revision,
        sourceTreeSha256: written.manifest.sourceTree.sha256,
        clientAssetSetSha256: written.manifest.clientAssets.sha256,
        clientAssetCount: written.manifest.clientAssets.fileCount,
        serverAssetSetSha256: written.manifest.serverAssets.sha256,
        serverAssetCount: written.manifest.serverAssets.fileCount,
        output: written.output,
      };
    } catch (error) {
      rmSync(servedManifest, { force: true });
      throw error;
    }
  } finally {
    for (const [signal, handler] of signalHandlers) process.off(signal, handler);
    releaseReleaseArtifactLease(lease);
  }
}

async function main() {
  try {
    process.stdout.write(`${JSON.stringify(await buildProduction())}\n`);
  } catch (error) {
    process.stderr.write(`${JSON.stringify({
      ok: false,
      code: error instanceof Error ? error.message : "PRODUCTION_BUILD_FAILED",
      listenerPids: Array.isArray(error?.listenerPids) ? error.listenerPids : undefined,
    })}\n`);
    process.exitCode = Number(error?.exitCode) || 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) await main();
