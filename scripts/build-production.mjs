#!/usr/bin/env node

import { execFileSync, spawn } from "node:child_process";
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

export function productionListenerPids(execFileSyncImpl = execFileSync) {
  try {
    return [...new Set(String(execFileSyncImpl(
      "/usr/sbin/lsof",
      ["-nP", "-iTCP:3000", "-sTCP:LISTEN", "-t"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    ) || "").trim().split(/\s+/).filter(Boolean).map(Number).filter(Number.isInteger))];
  } catch (error) {
    // lsof exits 1 when the selector has no matches. Any other failure means we
    // cannot prove that mutating dist is safe.
    if (error?.status === 1) return [];
    throw new Error("PRODUCTION_BUILD_LISTENER_CHECK_FAILED");
  }
}

export async function buildProduction({
  repoRoot = process.cwd(),
  leasePath = defaultReleaseArtifactLeasePath(repoRoot),
  freezePath = defaultLiveCodeFreezePath(repoRoot),
  spawnImpl = spawn,
  execFileSyncImpl = execFileSync,
  listenerPidsImpl = () => productionListenerPids(execFileSyncImpl),
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
