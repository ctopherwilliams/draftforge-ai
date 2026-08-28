import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { EventEmitter } from "node:events";
import { spawn, spawnSync } from "node:child_process";
import test from "node:test";
import { Worker } from "node:worker_threads";
import { buildProduction } from "../scripts/build-production.mjs";
import {
  armLiveCodeFreezeAfterDoctor,
  clearLiveCodeFreezeAfterAudit,
  emergencyClearLiveCodeFreeze,
  emergencyConfirmationFor,
  evaluateCodeFreezeCheck,
  inspectReleaseRevision,
  readLiveCodeFreeze,
} from "../scripts/live-code-freeze-lib.mjs";
import {
  acquireReleaseArtifactLease,
  attachReleaseArtifactLeaseChild,
  defaultReleaseArtifactLeasePath,
  RELEASE_ARTIFACT_LEASE_INITIALIZATION_GRACE_MS,
  releaseReleaseArtifactLease,
} from "../scripts/release-artifact-lease-lib.mjs";
import {
  nextProductionServerInstanceStartedAt,
  PRODUCTION_KEYCHAIN_READ_TIMEOUT_MS,
  PRODUCTION_TRADYR_KEYCHAIN_ACCOUNT,
  PRODUCTION_TRADYR_KEYCHAIN_SERVICE,
  productionServerArguments,
  resolveProductionEnvironment,
  startProduction,
  terminateProductionChild,
  validateProductionStartArguments,
} from "../scripts/start-production.mjs";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));
const revision = "a".repeat(40);
const release = { revision, clean: true, upstreamMatches: true };
const artifact = Object.freeze({
  releaseManifestSha256: "1".repeat(64),
  sourceTreeSha256: "2".repeat(64),
  sourceTreeFileCount: 123,
  clientAssetSetSha256: "3".repeat(64),
  clientAssetCount: 17,
  clientAssetBytes: 456_789,
  serverAssetSetSha256: "6".repeat(64),
  serverAssetCount: 29,
  serverAssetBytes: 987_654,
  extensionVersion: "1.2.3",
  extensionSourceSha256: "4".repeat(64),
  extensionSourceFileCount: 18,
  extensionPackageSha256: "5".repeat(64),
});
const identity = { sourceLeagueId: "44050", teamId: 7, roomId: "123456789", format: "salary-cap" };
const requiredChecks = Object.freeze({
  gitClean: true,
  headMatchesRemote: true,
  exactLeague: true,
  exactTeam: true,
  exactDraftType: true,
  exactTabBound: true,
  currentPublisher: true,
  settingsConfirmed: true,
  extensionConnected: true,
  managedWorkspaceCleanup: true,
  fiveSources: true,
  exactSourceSet: true,
  autoDraftOff: true,
  espnAutopickOff: true,
  actionHealthy: true,
  availabilityReady: true,
  liveChecklistReady: true,
  inDraftRoom: true,
  oneProductionServer: true,
  runtimeFresh: true,
  authenticatedImportFresh: true,
  exactTwoChromeTabs: true,
  oneDraftForgeTab: true,
  oneEspnTab: true,
  manifestVersionPinned: true,
  installedExtensionVersionPinned: true,
  extensionPackageIntegrity: true,
});

function doctorProof(overrides = {}) {
  return {
    ok: true,
    code: "DRAFT_DAY_DOCTOR_READY",
    phase: "live",
    ...identity,
    revision,
    blockers: [],
    checks: { ...requiredChecks },
    integrity: {
      sourceTreeSha256: artifact.sourceTreeSha256,
      servedManifestSha256: artifact.releaseManifestSha256,
      servedAssetSetSha256: artifact.clientAssetSetSha256,
      servedAssetCount: artifact.clientAssetCount,
      servedServerAssetSetSha256: artifact.serverAssetSetSha256,
      servedServerAssetCount: artifact.serverAssetCount,
      servedServerAssetBytes: artifact.serverAssetBytes,
      extensionSourceSha256: artifact.extensionSourceSha256,
      extensionPackageSha256: artifact.extensionPackageSha256,
      installedExtensionSourceSha256: artifact.extensionSourceSha256,
    },
    runtime: {
      extensionVersion: artifact.extensionVersion,
      extensionSourceSha256: artifact.extensionSourceSha256,
      extensionSourceFileCount: artifact.extensionSourceFileCount,
    },
    ...overrides,
  };
}

function completionAudit(overrides = {}) {
  return {
    ok: true,
    code: "DRAFT_AUDIT_READY",
    snapshot: { league: { id: identity.roomId, teamId: identity.teamId, draftType: "AUCTION" } },
    evaluation: { complete: true, finalReady: true, parity: true, finalViolations: [] },
    ...overrides,
  };
}

function temporaryState() {
  const root = mkdtempSync(path.join(tmpdir(), "draftforge-freeze-"));
  return { root, statePath: path.join(root, ".draftforge", "live-code-freeze.json") };
}

function runGit(cwd, args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr || `git ${args.join(" ")} failed`);
  return result.stdout.trim();
}

function arm(statePath, proof = doctorProof(), releaseState = release) {
  return armLiveCodeFreezeAfterDoctor({
    projectRoot,
    statePath,
    doctorProof: proof,
    armedAt: "2026-08-28T01:00:00.000Z",
    release: releaseState,
    artifact,
  });
}

function fakeProductionChild({ pid = 887766, ignoreTerm = false } = {}) {
  const child = new EventEmitter();
  child.pid = pid;
  child.exitCode = null;
  child.signalCode = null;
  child.killed = false;
  child.signals = [];
  child.kill = (signal = "SIGTERM") => {
    child.killed = true;
    child.signals.push(signal);
    if (!ignoreTerm || signal === "SIGKILL") {
      child.signalCode = signal;
      queueMicrotask(() => child.emit("exit", null, signal));
    }
    return true;
  };
  return child;
}

function exitProductionChild(child, code, signal = null) {
  child.exitCode = code;
  child.signalCode = signal;
  child.emit("exit", code, signal);
}

async function waitUntil(predicate, message, timeoutMs = 1_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 1));
  }
  assert.fail(message);
}

function outputEvents(output) {
  return output.flatMap((chunk) => String(chunk).split(/\r?\n/).filter(Boolean).map(JSON.parse));
}

const leaseReclaimerWorkerSource = `
  const { parentPort, workerData } = require("node:worker_threads");
  (async () => {
    const { acquireReleaseArtifactLease } = await import(workerData.moduleUrl);
    const barrier = new Int32Array(workerData.barrier);
    let synchronized = false;
    try {
      const lease = acquireReleaseArtifactLease({
        leasePath: workerData.leasePath,
        operation: workerData.operation,
        pid: workerData.pid,
        processAliveImpl: (candidatePid) => {
          if (!synchronized && candidatePid === workerData.staleOwnerPid) {
            synchronized = true;
            const arrived = Atomics.add(barrier, 0, 1) + 1;
            if (arrived >= 2) Atomics.notify(barrier, 0);
            while (Atomics.load(barrier, 0) < 2) Atomics.wait(barrier, 0, 1, 1_000);
            if (workerData.delayMs) Atomics.wait(barrier, 1, 0, workerData.delayMs);
          }
          return workerData.livePids.includes(candidatePid);
        },
      });
      parentPort.postMessage({ ok: true, lease });
    } catch (error) {
      parentPort.postMessage({ ok: false, code: error?.code || error?.message });
    }
  })();
`;

function runLeaseReclaimer({
  barrier,
  delayMs,
  leasePath,
  livePids,
  operation,
  pid,
  staleOwnerPid,
}) {
  const moduleUrl = new URL("../scripts/release-artifact-lease-lib.mjs", import.meta.url).href;
  return new Promise((resolveWorker, rejectWorker) => {
    const worker = new Worker(leaseReclaimerWorkerSource, {
      eval: true,
      workerData: {
        barrier,
        delayMs,
        leasePath,
        livePids,
        moduleUrl,
        operation,
        pid,
        staleOwnerPid,
      },
    });
    worker.once("message", resolveWorker);
    worker.once("error", rejectWorker);
    worker.once("exit", (code) => {
      if (code !== 0) rejectWorker(new Error(`reclaimer worker exited ${code}`));
    });
  });
}

function leaveCrashedReclaimClaim({ leasePath, staleOwnerPid, crashedClaimPid }) {
  const staleAcquiredAt = new Date(
    Date.now() - RELEASE_ARTIFACT_LEASE_INITIALIZATION_GRACE_MS - 5_000,
  ).toISOString();
  acquireReleaseArtifactLease({
    leasePath,
    operation: "build",
    acquiredAt: staleAcquiredAt,
    pid: staleOwnerPid,
    processAliveImpl: () => false,
  });
  assert.throws(() => acquireReleaseArtifactLease({
    leasePath,
    operation: "start",
    pid: crashedClaimPid,
    processAliveImpl: () => false,
    afterReclaimClaimCreatedImpl: () => {
      throw new Error("SIMULATED_RECLAIMER_CRASH");
    },
  }), /SIMULATED_RECLAIMER_CRASH/);
}

test("only an exact successful live doctor proof can create a freeze", () => {
  const { root, statePath } = temporaryState();
  try {
    for (const proof of [
      doctorProof({ ok: false, code: "DRAFT_DAY_DOCTOR_LOCKED" }),
      doctorProof({ phase: "pre-room" }),
      doctorProof({ revision: "b".repeat(40) }),
      doctorProof({
        integrity: { ...doctorProof().integrity, servedServerAssetSetSha256: "b".repeat(64) },
      }),
    ]) {
      assert.throws(() => arm(statePath, proof), /ARM_REFUSED/);
      assert.equal(existsSync(statePath), false, "a refused proof must not generate a lock");
    }
    assert.throws(() => arm(statePath, doctorProof(), { ...release, clean: false }), /ARM_REFUSED/);
    assert.throws(() => arm(statePath, doctorProof(), { ...release, upstreamMatches: false }), /ARM_REFUSED/);
    assert.equal(existsSync(statePath), false);

    const freeze = arm(statePath);
    assert.deepEqual(readLiveCodeFreeze(statePath), freeze);
    assert.equal(freeze.leagueId, identity.sourceLeagueId);
    assert.equal(freeze.roomId, identity.roomId);
    assert.deepEqual(arm(statePath), freeze, "repeating the same exact doctor result is idempotent");
    assert.throws(() => arm(statePath, doctorProof({ roomId: "987654321" })), /ALREADY_ACTIVE/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an active freeze blocks every mutating or resource-heavy release operation", () => {
  const { root, statePath } = temporaryState();
  try {
    assert.equal(evaluateCodeFreezeCheck({ freeze: null, operation: "build", currentRevision: revision }).ok, true);
    const freeze = arm(statePath);
    for (const operation of ["build", "test", "dev", "extension-package", "source-refresh"]) {
      assert.deepEqual(
        evaluateCodeFreezeCheck({ freeze, operation, currentRevision: revision }).code,
        "LIVE_CODE_FREEZE_ACTIVE",
      );
    }
    assert.equal(
      evaluateCodeFreezeCheck({ freeze, operation: "build", currentRevision: "b".repeat(40) }).code,
      "LIVE_CODE_FREEZE_REVISION_CHANGED",
    );
    assert.equal(
      evaluateCodeFreezeCheck({
        freeze,
        operation: "start",
        currentRevision: revision,
        currentRelease: release,
        currentArtifact: artifact,
      }).code,
      "LIVE_CODE_FREEZE_FROZEN_START_ALLOWED",
      "start is deliberately not a protected operation because the frozen artifact must remain runnable",
    );
    assert.equal(
      evaluateCodeFreezeCheck({
        freeze,
        operation: "start",
        currentRevision: revision,
        currentRelease: release,
      }).code,
      "LIVE_CODE_FREEZE_ARTIFACT_UNVERIFIED",
    );
    assert.equal(
      evaluateCodeFreezeCheck({
        freeze,
        operation: "start",
        currentRevision: revision,
        currentRelease: release,
        currentArtifact: { ...artifact, clientAssetSetSha256: "6".repeat(64) },
      }).code,
      "LIVE_CODE_FREEZE_ARTIFACT_CHANGED",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an inactive freeze still requires a completely verified production artifact before start", () => {
  assert.equal(
    evaluateCodeFreezeCheck({
      freeze: null,
      operation: "start",
      currentRevision: revision,
      currentRelease: release,
    }).code,
    "LIVE_CODE_FREEZE_ARTIFACT_UNVERIFIED",
  );
  assert.equal(
    evaluateCodeFreezeCheck({
      freeze: null,
      operation: "start",
      currentRevision: revision,
      currentRelease: release,
      currentArtifact: artifact,
    }).code,
    "LIVE_CODE_FREEZE_INACTIVE_START_VERIFIED",
  );
});

test("production start rejects dirty tracked, untracked, and upstream-diverged releases", () => {
  const root = mkdtempSync(path.join(tmpdir(), "draftforge-start-release-"));
  const repo = path.join(root, "repo");
  const remote = path.join(root, "remote.git");
  const trackedPath = path.join(repo, "tracked.txt");
  try {
    mkdirSync(repo);
    runGit(root, ["init", "--bare", remote]);
    runGit(repo, ["init", "--initial-branch=main"]);
    runGit(repo, ["config", "user.name", "DraftForge Test"]);
    runGit(repo, ["config", "user.email", "draftforge-test@example.invalid"]);
    writeFileSync(trackedPath, "certified\n", "utf8");
    runGit(repo, ["add", "tracked.txt"]);
    runGit(repo, ["commit", "-m", "certified release"]);
    runGit(repo, ["remote", "add", "origin", remote]);
    runGit(repo, ["push", "--set-upstream", "origin", "main"]);

    const evaluateStart = () => evaluateCodeFreezeCheck({
      freeze: null,
      operation: "start",
      currentRelease: inspectReleaseRevision(repo),
      currentArtifact: artifact,
    });
    assert.equal(evaluateStart().code, "LIVE_CODE_FREEZE_INACTIVE_START_VERIFIED");

    writeFileSync(trackedPath, "dirty tracked bytes\n", "utf8");
    assert.equal(evaluateStart().code, "LIVE_CODE_FREEZE_WORKTREE_DIRTY");
    writeFileSync(trackedPath, "certified\n", "utf8");

    const untrackedPath = path.join(repo, "untracked.txt");
    writeFileSync(untrackedPath, "untracked release bytes\n", "utf8");
    assert.equal(evaluateStart().code, "LIVE_CODE_FREEZE_WORKTREE_DIRTY");
    rmSync(untrackedPath);

    writeFileSync(trackedPath, "unpublished revision\n", "utf8");
    runGit(repo, ["add", "tracked.txt"]);
    runGit(repo, ["commit", "-m", "unpublished release"]);
    assert.equal(evaluateStart().code, "LIVE_CODE_FREEZE_UPSTREAM_MISMATCH");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("production start rejects every caller-controlled server argument before leasing", async () => {
  assert.deepEqual(validateProductionStartArguments([]), []);
  const root = mkdtempSync(path.join(tmpdir(), "draftforge-start-arguments-"));
  try {
    assert.deepEqual(productionServerArguments(root), [
      "--import",
      path.join(root, "scripts/production-child-guard.mjs"),
      path.join(root, "node_modules/vinext/dist/cli.js"),
      "start",
      "--hostname",
      "127.0.0.1",
      "--port",
      "3000",
    ]);
    for (const args of [
      ["--unknown"],
      ["--hostname", "0.0.0.0"],
      ["--port", "4000"],
      ["--hostname", "127.0.0.1", "--hostname", "0.0.0.0"],
    ]) {
      assert.throws(() => validateProductionStartArguments(args), /PRODUCTION_START_ARGUMENTS_FORBIDDEN/);
      await assert.rejects(
        startProduction({
          projectRoot: root,
          args,
          spawnImpl: () => assert.fail("server must not spawn for forbidden arguments"),
        }),
        /PRODUCTION_START_ARGUMENTS_FORBIDDEN/,
      );
      assert.equal(existsSync(defaultReleaseArtifactLeasePath(root)), false);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("production child instance timestamps are canonical and advance across same-millisecond restarts", () => {
  const first = nextProductionServerInstanceStartedAt(
    () => Date.parse("2026-08-28T03:00:00.000Z"),
  );
  const second = nextProductionServerInstanceStartedAt(() => first.epochMs, first.epochMs);
  assert.deepEqual(first, {
    epochMs: Date.parse("2026-08-28T03:00:00.000Z"),
    timestamp: "2026-08-28T03:00:00.000Z",
  });
  assert.equal(second.epochMs, first.epochMs + 1);
  assert.equal(second.timestamp, "2026-08-28T03:00:00.001Z");
  assert.throws(() => nextProductionServerInstanceStartedAt(() => Number.NaN), /INSTANCE_CLOCK_INVALID/);
});

test("production resolves the server-only Tradyr credential from Keychain without exposing it", () => {
  const calls = [];
  const credential = "private-keychain-token";
  const resolved = resolveProductionEnvironment({
    environment: { PATH: "/usr/bin" },
    platform: "darwin",
    keychainReadImpl: (...args) => {
      calls.push(args);
      return { status: 0, stdout: `  ${credential}\n`, stderr: "never emitted" };
    },
  });
  assert.equal(resolved.TRADYR_API_KEY, credential);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0][0], "/usr/bin/security");
  assert.deepEqual(calls[0][1], [
    "find-generic-password",
    "-s", PRODUCTION_TRADYR_KEYCHAIN_SERVICE,
    "-a", PRODUCTION_TRADYR_KEYCHAIN_ACCOUNT,
    "-w",
  ]);
  assert.equal(calls[0][2].timeout, PRODUCTION_KEYCHAIN_READ_TIMEOUT_MS);
  assert.equal(calls[0][2].killSignal, "SIGKILL");
  assert.deepEqual(calls[0][2].stdio, ["ignore", "pipe", "pipe"]);

  let reads = 0;
  const inherited = resolveProductionEnvironment({
    environment: { TRADYR_API_KEY: ` ${credential} ` },
    platform: "darwin",
    keychainReadImpl: () => { reads += 1; },
  });
  assert.equal(inherited.TRADYR_API_KEY, credential);
  assert.equal(reads, 0, "an explicit server environment must win without touching Keychain");

  for (const result of [
    { status: 1, stdout: credential },
    { status: null, stdout: credential, error: Object.assign(new Error("timed out"), { code: "ETIMEDOUT" }) },
    { status: 0, stdout: "short" },
    { status: 0, stdout: `${credential}\nsecond-line` },
  ]) {
    const blocked = resolveProductionEnvironment({
      environment: {},
      platform: "darwin",
      keychainReadImpl: () => result,
    });
    assert.equal(blocked.TRADYR_API_KEY, undefined);
  }
  const denied = resolveProductionEnvironment({
    environment: {},
    platform: "darwin",
    keychainReadImpl: () => { throw new Error("interaction denied"); },
  });
  assert.equal(denied.TRADYR_API_KEY, undefined);
  const unsupported = resolveProductionEnvironment({
    environment: {},
    platform: "linux",
    keychainReadImpl: () => assert.fail("non-macOS startup must not invoke Keychain"),
  });
  assert.equal(unsupported.TRADYR_API_KEY, undefined);
});

test("production start publishes ready only after exact health and reaps a failed startup", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "draftforge-start-readiness-"));
  const validation = { release, artifact, result: { code: "LIVE_CODE_FREEZE_INACTIVE_START_VERIFIED" } };
  let releaseReadiness;
  const readiness = new Promise((resolveReady) => { releaseReadiness = resolveReady; });
  const output = [];
  const healthyChild = fakeProductionChild();
  const signalSource = new EventEmitter();
  try {
    const running = startProduction({
      projectRoot: root,
      args: [],
      validateImpl: () => validation,
      spawnImpl: () => healthyChild,
      readyImpl: async () => {
        await readiness;
        return { origin: "http://127.0.0.1:3000" };
      },
      writeOutput: (value) => output.push(value),
      signalSource,
      environment: {},
    });
    await new Promise((resolveWait) => setTimeout(resolveWait, 20));
    assert.equal(output.length, 0, "validation alone must never look like a listening server");
    releaseReadiness();
    await new Promise((resolveWait) => setTimeout(resolveWait, 20));
    assert.equal(JSON.parse(output.join("")).code, "PRODUCTION_SERVER_READY");
    assert.equal(JSON.parse(output.join("")).tradyrCredentialAvailable, false);
    const stopped = assert.rejects(running, /PRODUCTION_SERVER_OPERATOR_SHUTDOWN_SIGTERM/);
    signalSource.emit("SIGTERM");
    await stopped;
    assert.equal(existsSync(defaultReleaseArtifactLeasePath(root)), false);

    const failedChild = fakeProductionChild({ pid: 887767 });
    await assert.rejects(() => startProduction({
      projectRoot: root,
      args: [],
      validateImpl: () => validation,
      spawnImpl: () => failedChild,
      readyImpl: async () => { throw new Error("PRODUCTION_SERVER_READY_TIMEOUT:fixture"); },
      writeOutput: () => assert.fail("a failed startup cannot publish ready"),
    }), /PRODUCTION_SERVER_READY_TIMEOUT/);
    assert.deepEqual(failedChild.signals, ["SIGTERM"]);
    assert.equal(existsSync(defaultReleaseArtifactLeasePath(root)), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("production start recovers an unsolicited exit zero with the same lease and no overlapping child", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "draftforge-start-recovery-"));
  const validation = { release, artifact, result: { code: "LIVE_CODE_FREEZE_INACTIVE_START_VERIFIED" } };
  const children = [fakeProductionChild({ pid: 887770 }), fakeProductionChild({ pid: 887771 })];
  const output = [];
  const sleeps = [];
  const leaseOwners = [];
  const childEnvironments = [];
  let activeChildren = 0;
  let maximumActiveChildren = 0;
  let spawnCount = 0;
  let readyCount = 0;
  let validationCount = 0;
  const signalSource = new EventEmitter();
  try {
    const running = startProduction({
      projectRoot: root,
      args: [],
      validateImpl: () => {
        validationCount += 1;
        return validation;
      },
      spawnImpl: (_executable, _args, options) => {
        const child = children[spawnCount];
        childEnvironments.push(options.env);
        spawnCount += 1;
        activeChildren += 1;
        maximumActiveChildren = Math.max(maximumActiveChildren, activeChildren);
        child.once("exit", () => { activeChildren -= 1; });
        return child;
      },
      readyImpl: async () => {
        readyCount += 1;
        leaseOwners.push(JSON.parse(readFileSync(
          path.join(defaultReleaseArtifactLeasePath(root), "owner.json"),
          "utf8",
        )));
        return { origin: "http://127.0.0.1:3000" };
      },
      sleepImpl: async (milliseconds) => { sleeps.push(milliseconds); },
      portProbeImpl: () => [],
      nowImpl: () => Date.parse("2026-08-28T03:00:00.000Z"),
      signalSource,
      writeOutput: (value) => output.push(value),
      environment: { PATH: "/usr/bin", TRADYR_API_KEY: "private-restart-fixture" },
    });

    await waitUntil(() => readyCount === 1, "initial child did not become ready");
    exitProductionChild(children[0], 0);
    await waitUntil(() => readyCount === 2, "replacement child did not become ready");
    const stopped = assert.rejects(running, /PRODUCTION_SERVER_OPERATOR_SHUTDOWN_SIGTERM/);
    signalSource.emit("SIGTERM");
    await stopped;

    assert.equal(validationCount, 2);
    assert.equal(spawnCount, 2);
    assert.equal(maximumActiveChildren, 1, "a replacement must not overlap the exited child");
    assert.deepEqual(sleeps, [250]);
    assert.equal(leaseOwners[0].token, leaseOwners[1].token, "one lease must span every child");
    assert.deepEqual(leaseOwners.map((owner) => owner.childPid), [887770, 887771]);
    assert.deepEqual(childEnvironments.map((environment) => environment.DRAFTFORGE_SERVER_INSTANCE_STARTED_AT), [
      "2026-08-28T03:00:00.000Z",
      "2026-08-28T03:00:00.001Z",
    ]);
    assert.ok(childEnvironments.every((environment) => /^[a-f0-9]{32}$/.test(environment.DRAFTFORGE_PRODUCTION_SUPERVISION_TOKEN)));
    assert.ok(childEnvironments.every((environment) => environment.DRAFTFORGE_PRODUCTION_SUPERVISOR_PID === String(process.pid)));
    assert.ok(childEnvironments.every((environment) => environment.TRADYR_API_KEY === "private-restart-fixture"));
    assert.deepEqual(outputEvents(output).map((event) => event.code), [
      "PRODUCTION_SERVER_READY",
      "PRODUCTION_SERVER_RESTART_SCHEDULED",
      "PRODUCTION_SERVER_READY",
    ]);
    assert.equal(outputEvents(output)[1].exitCode, 0);
    assert.equal(outputEvents(output)[2].autoDraftRestored, false);
    assert.equal(outputEvents(output)[0].tradyrCredentialAvailable, true);
    assert.equal(outputEvents(output)[2].tradyrCredentialAvailable, true);
    assert.equal(outputEvents(output)[2].restartAttempt, 1);
    assert.equal(outputEvents(output)[0].serverInstanceStartedAt, "2026-08-28T03:00:00.000Z");
    assert.equal(outputEvents(output)[2].serverInstanceStartedAt, "2026-08-28T03:00:00.001Z");
    assert.equal(outputEvents(output)[2].occurredAt, "2026-08-28T03:00:00.000Z");
    assert.equal(existsSync(defaultReleaseArtifactLeasePath(root)), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("production restart fails closed when the certified artifact changes", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "draftforge-start-artifact-change-"));
  const child = fakeProductionChild({ pid: 887772 });
  const initialValidation = { release, artifact, result: { code: "LIVE_CODE_FREEZE_INACTIVE_START_VERIFIED" } };
  const changedValidation = {
    ...initialValidation,
    artifact: { ...artifact, extensionPackageSha256: "9".repeat(64) },
  };
  let validationCount = 0;
  let spawnCount = 0;
  let readyCount = 0;
  let portProbeCount = 0;
  try {
    const running = startProduction({
      projectRoot: root,
      args: [],
      validateImpl: () => (++validationCount === 1 ? initialValidation : changedValidation),
      spawnImpl: () => {
        spawnCount += 1;
        return child;
      },
      readyImpl: async () => {
        readyCount += 1;
        return { origin: "http://127.0.0.1:3000" };
      },
      sleepImpl: async () => {},
      portProbeImpl: () => {
        portProbeCount += 1;
        return [];
      },
      signalSource: new EventEmitter(),
      writeOutput: () => {},
    });
    const rejected = assert.rejects(running, /PRODUCTION_SERVER_RESTART_ARTIFACT_CHANGED/);
    await waitUntil(() => readyCount === 1, "initial child did not become ready");
    exitProductionChild(child, 1);
    await rejected;
    assert.equal(validationCount, 2);
    assert.equal(spawnCount, 1);
    assert.equal(portProbeCount, 0, "changed bytes must fail before the port probe or respawn");
    assert.equal(existsSync(defaultReleaseArtifactLeasePath(root)), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("production restart refuses an occupied port without killing or spawning", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "draftforge-start-port-occupied-"));
  const child = fakeProductionChild({ pid: 887773 });
  const validation = { release, artifact, result: { code: "LIVE_CODE_FREEZE_INACTIVE_START_VERIFIED" } };
  let spawnCount = 0;
  let readyCount = 0;
  try {
    const running = startProduction({
      projectRoot: root,
      args: [],
      validateImpl: () => validation,
      spawnImpl: () => {
        spawnCount += 1;
        return child;
      },
      readyImpl: async () => {
        readyCount += 1;
        return { origin: "http://127.0.0.1:3000" };
      },
      sleepImpl: async () => {},
      portProbeImpl: () => [991122],
      signalSource: new EventEmitter(),
      writeOutput: () => {},
    });
    const rejected = assert.rejects(running, /PRODUCTION_SERVER_RESTART_PORT_OCCUPIED/);
    await waitUntil(() => readyCount === 1, "initial child did not become ready");
    exitProductionChild(child, 1);
    await rejected;
    assert.equal(spawnCount, 1);
    assert.deepEqual(child.signals, [], "the port owner and exited server must never be killed");
    assert.equal(existsSync(defaultReleaseArtifactLeasePath(root)), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("production restart stops after two deterministic retries and emits bounded exhaustion", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "draftforge-start-exhaustion-"));
  const children = [
    fakeProductionChild({ pid: 887774 }),
    fakeProductionChild({ pid: 887775 }),
    fakeProductionChild({ pid: 887776 }),
  ];
  const validation = { release, artifact, result: { code: "LIVE_CODE_FREEZE_INACTIVE_START_VERIFIED" } };
  const output = [];
  const sleeps = [];
  let activeChildren = 0;
  let maximumActiveChildren = 0;
  let spawnCount = 0;
  let readyCount = 0;
  let validationCount = 0;
  let portProbeCount = 0;
  try {
    const running = startProduction({
      projectRoot: root,
      args: [],
      validateImpl: () => {
        validationCount += 1;
        return validation;
      },
      spawnImpl: () => {
        const child = children[spawnCount];
        spawnCount += 1;
        activeChildren += 1;
        maximumActiveChildren = Math.max(maximumActiveChildren, activeChildren);
        child.once("exit", () => { activeChildren -= 1; });
        return child;
      },
      readyImpl: async () => {
        readyCount += 1;
        return { origin: "http://127.0.0.1:3000" };
      },
      sleepImpl: async (milliseconds) => { sleeps.push(milliseconds); },
      portProbeImpl: () => {
        portProbeCount += 1;
        return [];
      },
      signalSource: new EventEmitter(),
      writeOutput: (value) => output.push(value),
    });
    const rejected = assert.rejects(running, /PRODUCTION_SERVER_RESTARTS_EXHAUSTED/);
    await waitUntil(() => readyCount === 1, "initial child did not become ready");
    exitProductionChild(children[0], 1);
    await waitUntil(() => readyCount === 2, "first replacement did not become ready");
    exitProductionChild(children[1], null, "SIGABRT");
    await waitUntil(() => readyCount === 3, "second replacement did not become ready");
    exitProductionChild(children[2], 2);
    await rejected;

    assert.deepEqual(sleeps, [250, 1_000]);
    assert.equal(validationCount, 3);
    assert.equal(portProbeCount, 2);
    assert.equal(spawnCount, 3);
    assert.equal(maximumActiveChildren, 1);
    const events = outputEvents(output);
    assert.deepEqual(events.map((event) => event.code), [
      "PRODUCTION_SERVER_READY",
      "PRODUCTION_SERVER_RESTART_SCHEDULED",
      "PRODUCTION_SERVER_READY",
      "PRODUCTION_SERVER_RESTART_SCHEDULED",
      "PRODUCTION_SERVER_READY",
      "PRODUCTION_SERVER_RESTARTS_EXHAUSTED",
    ]);
    assert.deepEqual(events.at(-1), {
      ok: false,
      code: "PRODUCTION_SERVER_RESTARTS_EXHAUSTED",
      restartAttempts: 2,
      exitCode: 2,
      signal: null,
      occurredAt: events.at(-1).occurredAt,
    });
    assert.equal(existsSync(defaultReleaseArtifactLeasePath(root)), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("operator signal shuts down the ready child without any restart", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "draftforge-start-operator-signal-"));
  const child = fakeProductionChild({ pid: 887777 });
  const validation = { release, artifact, result: { code: "LIVE_CODE_FREEZE_INACTIVE_START_VERIFIED" } };
  const signalSource = new EventEmitter();
  let readyCount = 0;
  let spawnCount = 0;
  let sleepCount = 0;
  let portProbeCount = 0;
  try {
    const running = startProduction({
      projectRoot: root,
      args: [],
      validateImpl: () => validation,
      spawnImpl: () => {
        spawnCount += 1;
        return child;
      },
      readyImpl: async () => {
        readyCount += 1;
        return { origin: "http://127.0.0.1:3000" };
      },
      sleepImpl: async () => { sleepCount += 1; },
      portProbeImpl: () => {
        portProbeCount += 1;
        return [];
      },
      signalSource,
      writeOutput: () => {},
    });
    const rejected = assert.rejects(running, /PRODUCTION_SERVER_OPERATOR_SHUTDOWN_SIGTERM/);
    await waitUntil(() => readyCount === 1, "initial child did not become ready");
    signalSource.emit("SIGTERM");
    await rejected;
    assert.equal(spawnCount, 1);
    assert.equal(sleepCount, 0);
    assert.equal(portProbeCount, 0);
    assert.deepEqual(child.signals, ["SIGTERM"]);
    assert.equal(signalSource.listenerCount("SIGTERM"), 0);
    assert.equal(existsSync(defaultReleaseArtifactLeasePath(root)), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("production child termination escalates to SIGKILL instead of waiting forever", async () => {
  const child = fakeProductionChild({ pid: 887768, ignoreTerm: true });
  const outcome = new Promise((resolveOutcome) => {
    child.once("exit", (code, signal) => resolveOutcome({ code, signal, error: null }));
  });
  assert.equal(await terminateProductionChild(child, outcome, "SIGTERM", 10), true);
  assert.deepEqual(child.signals, ["SIGTERM", "SIGKILL"]);
});

test("normal completion clear requires the exact final-ready audit and frozen revision", () => {
  const { root, statePath } = temporaryState();
  try {
    arm(statePath);
    const clear = (overrides = {}) => clearLiveCodeFreezeAfterAudit({
      statePath,
      requestedLeagueId: identity.roomId,
      requestedTeamId: identity.teamId,
      auditProof: completionAudit(),
      currentRevision: revision,
      ...overrides,
    });
    assert.throws(() => clear({ requestedLeagueId: "987" }), /COMPLETION_CLEAR_REFUSED/);
    assert.throws(() => clear({ requestedTeamId: 8 }), /COMPLETION_CLEAR_REFUSED/);
    assert.throws(() => clear({ currentRevision: "b".repeat(40) }), /COMPLETION_CLEAR_REFUSED/);
    assert.throws(() => clear({ auditProof: completionAudit({ evaluation: { complete: true, finalReady: false, parity: true, finalViolations: [] } }) }), /COMPLETION_CLEAR_REFUSED/);
    assert.throws(() => clear({ auditProof: completionAudit({ snapshot: { league: { id: identity.roomId, teamId: identity.teamId, draftType: "SNAKE" } } }) }), /COMPLETION_CLEAR_REFUSED/);
    assert.equal(readLiveCodeFreeze(statePath)?.roomId, identity.roomId);
    assert.equal(clear().code, "LIVE_CODE_FREEZE_COMPLETION_CLEARED");
    assert.equal(readLiveCodeFreeze(statePath), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("emergency clear is identity-bound, confirmation-bound, and leaves a hashed receipt", () => {
  const { root, statePath } = temporaryState();
  try {
    const freeze = arm(statePath);
    const confirmation = emergencyConfirmationFor(freeze);
    const clear = (overrides = {}) => emergencyClearLiveCodeFreeze({
      statePath,
      leagueId: freeze.leagueId,
      teamId: freeze.teamId,
      roomId: freeze.roomId,
      emergencyReason: "Production artifact cannot safely continue the live room",
      confirmation,
      clearedAt: "2026-08-28T02:00:00.000Z",
      ...overrides,
    });
    assert.throws(() => clear({ roomId: "987" }), /EMERGENCY_CLEAR_REFUSED/);
    assert.throws(() => clear({ emergencyReason: "too short" }), /EMERGENCY_CLEAR_REFUSED/);
    assert.throws(() => clear({ confirmation: "LIVE_CODE_FREEZE_EMERGENCY_CLEAR" }), /EMERGENCY_CLEAR_REFUSED/);
    assert.equal(readLiveCodeFreeze(statePath)?.roomId, freeze.roomId);
    const result = clear();
    assert.equal(result.code, "LIVE_CODE_FREEZE_EMERGENCY_CLEARED");
    assert.equal(readLiveCodeFreeze(statePath), null);
    assert.equal(existsSync(result.receiptPath), true);
    const receipt = JSON.parse(readFileSync(result.receiptPath, "utf8"));
    assert.match(receipt.reasonSha256, /^[a-f0-9]{64}$/);
    assert.equal(Object.hasOwn(receipt, "reason"), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("malformed freeze state fails closed", () => {
  const { root, statePath } = temporaryState();
  try {
    mkdirSync(path.dirname(statePath), { recursive: true });
    writeFileSync(statePath, "{}\n", "utf8");
    assert.throws(() => readLiveCodeFreeze(statePath), /LIVE_CODE_FREEZE_INVALID/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("npm lifecycle blocks release work and routes every start through the lease-holding verifier", () => {
  const packageJson = JSON.parse(readFileSync(path.join(projectRoot, "package.json"), "utf8"));
  const requiredHooks = [
    "predev",
    "prebuild",
    "prestart",
    "pretest",
    "pretest:visual",
    "pretest:live-control",
    "pretest:load",
    "pretest:chaos",
    "pretest:soak",
    "preextension:package",
  ];
  for (const hook of requiredHooks) assert.match(packageJson.scripts[hook], /live-code-freeze\.mjs check/);
  assert.match(packageJson.scripts.prestart, /--operation start/);
  assert.match(packageJson.scripts.start, /start-production\.mjs/);
  assert.doesNotMatch(packageJson.scripts.start, /live-code-freeze/);
  assert.doesNotMatch(packageJson.scripts.start, /vinext start/);
});

test("a start lease or live production listener blocks build before the served manifest is removed", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "draftforge-release-lease-"));
  const manifestPath = path.join(root, "dist", "client", "draftforge-release-integrity.json");
  const leasePath = defaultReleaseArtifactLeasePath(root);
  const freezePath = path.join(root, ".draftforge", "live-code-freeze.json");
  try {
    mkdirSync(path.dirname(manifestPath), { recursive: true });
    writeFileSync(manifestPath, "certified\n", "utf8");
    const startLease = acquireReleaseArtifactLease({ projectRoot: root, leasePath, operation: "start" });
    try {
      await assert.rejects(() => buildProduction({
        repoRoot: root,
        leasePath,
        listenerPidsImpl: () => [],
        spawnImpl: () => assert.fail("builder must not start while the server owns the artifact"),
      }), /RELEASE_ARTIFACT_IN_USE/);
      assert.equal(readFileSync(manifestPath, "utf8"), "certified\n");
    } finally {
      releaseReleaseArtifactLease(startLease);
    }

    arm(freezePath);
    await assert.rejects(() => buildProduction({
      repoRoot: root,
      leasePath,
      freezePath,
      listenerPidsImpl: () => assert.fail("listener check must not bypass an active freeze"),
      spawnImpl: () => assert.fail("builder must not start during an active freeze"),
    }), /LIVE_CODE_FREEZE_ACTIVE/);
    assert.equal(readFileSync(manifestPath, "utf8"), "certified\n");
    rmSync(freezePath);

    await assert.rejects(() => buildProduction({
      repoRoot: root,
      leasePath,
      listenerPidsImpl: () => [4321],
      spawnImpl: () => assert.fail("builder must not start while port 3000 is served"),
    }), /PRODUCTION_BUILD_SERVER_ACTIVE/);
    assert.equal(readFileSync(manifestPath, "utf8"), "certified\n");
    assert.equal(existsSync(leasePath), false, "a refused build releases its lease");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a surviving vinext child keeps the artifact lease live after its wrapper owner disappears", () => {
  const root = mkdtempSync(path.join(tmpdir(), "draftforge-release-child-lease-"));
  const leasePath = defaultReleaseArtifactLeasePath(root);
  try {
    let lease = acquireReleaseArtifactLease({
      projectRoot: root,
      leasePath,
      operation: "start",
      pid: 1111,
      processAliveImpl: () => false,
    });
    lease = attachReleaseArtifactLeaseChild(lease, 2222);
    assert.throws(() => acquireReleaseArtifactLease({
      projectRoot: root,
      leasePath,
      operation: "build",
      pid: 3333,
      processAliveImpl: (pid) => pid === 2222,
    }), /RELEASE_ARTIFACT_IN_USE/);
    releaseReleaseArtifactLease(lease);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a fresh dead wrapper lease is protected during child attachment but an old dead lease is recoverable", () => {
  const root = mkdtempSync(path.join(tmpdir(), "draftforge-release-initializing-"));
  const leasePath = defaultReleaseArtifactLeasePath(root);
  try {
    const fresh = acquireReleaseArtifactLease({
      projectRoot: root,
      leasePath,
      operation: "build",
      pid: 1111,
      processAliveImpl: () => false,
    });
    assert.throws(() => acquireReleaseArtifactLease({
      projectRoot: root,
      leasePath,
      operation: "start",
      pid: 2222,
      processAliveImpl: () => false,
    }), /RELEASE_ARTIFACT_LEASE_INITIALIZING/);
    releaseReleaseArtifactLease(fresh);

    acquireReleaseArtifactLease({
      projectRoot: root,
      leasePath,
      operation: "build",
      acquiredAt: new Date(Date.now() - RELEASE_ARTIFACT_LEASE_INITIALIZATION_GRACE_MS - 1_000).toISOString(),
      pid: 3333,
      processAliveImpl: () => false,
    });
    const recovered = acquireReleaseArtifactLease({
      projectRoot: root,
      leasePath,
      operation: "start",
      pid: 4444,
      processAliveImpl: () => false,
    });
    assert.equal(recovered.owner.operation, "start");
    releaseReleaseArtifactLease(recovered);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("concurrent stale-lease reclaimers cannot both acquire or delete the replacement owner", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "draftforge-release-reclaim-race-"));
  const leasePath = defaultReleaseArtifactLeasePath(root);
  try {
    acquireReleaseArtifactLease({
      projectRoot: root,
      leasePath,
      operation: "build",
      acquiredAt: new Date(
        Date.now() - RELEASE_ARTIFACT_LEASE_INITIALIZATION_GRACE_MS - 5_000,
      ).toISOString(),
      pid: 991111,
      processAliveImpl: () => false,
    });

    const barrier = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * 2);
    const livePids = [992222, 993333];
    const results = await Promise.all([
      runLeaseReclaimer({
        barrier,
        delayMs: 0,
        leasePath,
        livePids,
        operation: "build",
        pid: 992222,
        staleOwnerPid: 991111,
      }),
      runLeaseReclaimer({
        barrier,
        delayMs: 75,
        leasePath,
        livePids,
        operation: "start",
        pid: 993333,
        staleOwnerPid: 991111,
      }),
    ]);
    const winners = results.filter((result) => result.ok);
    const losers = results.filter((result) => !result.ok);
    assert.equal(winners.length, 1, JSON.stringify(results));
    assert.equal(losers.length, 1, JSON.stringify(results));
    assert.match(
      String(losers[0].code),
      /RELEASE_ARTIFACT_(?:IN_USE|LEASE_CONTENTION|LEASE_INITIALIZING)/,
    );
    const finalOwner = JSON.parse(readFileSync(path.join(leasePath, "owner.json"), "utf8"));
    assert.equal(finalOwner.token, winners[0].lease.owner.token);
    assert.equal(finalOwner.operation, winners[0].lease.owner.operation);
    releaseReleaseArtifactLease(winners[0].lease);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a reclaimer crash after its durable claim self-heals within the bounded grace", () => {
  const root = mkdtempSync(path.join(tmpdir(), "draftforge-release-claim-crash-"));
  const leasePath = defaultReleaseArtifactLeasePath(root);
  try {
    leaveCrashedReclaimClaim({
      leasePath,
      staleOwnerPid: 994111,
      crashedClaimPid: 994222,
    });
    const recovered = acquireReleaseArtifactLease({
      leasePath,
      operation: "start",
      pid: process.pid,
      processAliveImpl: (candidatePid) => candidatePid === process.pid,
    });
    assert.equal(recovered.owner.operation, "start");
    assert.deepEqual(readdirSync(leasePath).sort(), ["owner.json"]);
    releaseReleaseArtifactLease(recovered);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a legacy token-only crashed reclaim claim is recoverable after its bounded grace", () => {
  const root = mkdtempSync(path.join(tmpdir(), "draftforge-release-legacy-claim-crash-"));
  const leasePath = defaultReleaseArtifactLeasePath(root);
  try {
    const staleAcquiredAt = new Date(
      Date.now() - RELEASE_ARTIFACT_LEASE_INITIALIZATION_GRACE_MS - 5_000,
    ).toISOString();
    const stale = acquireReleaseArtifactLease({
      leasePath,
      operation: "build",
      acquiredAt: staleAcquiredAt,
      pid: 994333,
      processAliveImpl: () => false,
    });
    const claimPath = path.join(
      leasePath,
      `.reclaim-owner-${stale.owner.token}.json`,
    );
    writeFileSync(claimPath, `${JSON.stringify({
      token: "00000000-0000-4000-8000-000000000001",
    })}\n`, "utf8");
    const oldClaimTime = new Date(Date.now() - 5_000);
    utimesSync(claimPath, oldClaimTime, oldClaimTime);

    const recovered = acquireReleaseArtifactLease({
      leasePath,
      operation: "start",
      pid: process.pid,
      processAliveImpl: (candidatePid) => candidatePid === process.pid,
    });
    assert.equal(recovered.owner.operation, "start");
    assert.deepEqual(readdirSync(leasePath).sort(), ["owner.json"]);
    releaseReleaseArtifactLease(recovered);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("concurrent recovery of a crashed reclaim claim elects exactly one owner", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "draftforge-release-claim-election-"));
  const leasePath = defaultReleaseArtifactLeasePath(root);
  try {
    leaveCrashedReclaimClaim({
      leasePath,
      staleOwnerPid: 995111,
      crashedClaimPid: 995222,
    });
    const barrier = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * 2);
    const livePids = [995333, 995444];
    const results = await Promise.all([
      runLeaseReclaimer({
        barrier,
        delayMs: 0,
        leasePath,
        livePids,
        operation: "build",
        pid: 995333,
        staleOwnerPid: 995111,
      }),
      runLeaseReclaimer({
        barrier,
        delayMs: 0,
        leasePath,
        livePids,
        operation: "start",
        pid: 995444,
        staleOwnerPid: 995111,
      }),
    ]);
    const winners = results.filter((result) => result.ok);
    const losers = results.filter((result) => !result.ok);
    assert.equal(winners.length, 1, JSON.stringify(results));
    assert.equal(losers.length, 1, JSON.stringify(results));
    assert.match(
      String(losers[0].code),
      /RELEASE_ARTIFACT_(?:IN_USE|LEASE_CONTENTION|LEASE_INITIALIZING)/,
    );
    const finalOwner = JSON.parse(readFileSync(path.join(leasePath, "owner.json"), "utf8"));
    assert.equal(finalOwner.token, winners[0].lease.owner.token);
    assert.deepEqual(readdirSync(leasePath).sort(), ["owner.json"]);
    releaseReleaseArtifactLease(winners[0].lease);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a build that begins with untracked input cannot publish a release manifest", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "draftforge-build-provenance-"));
  const repo = path.join(root, "repo");
  const remote = path.join(root, "remote.git");
  const clientRoot = path.join(repo, "dist", "client");
  const serverRoot = path.join(repo, "dist", "server");
  const manifestPath = path.join(clientRoot, "draftforge-release-integrity.json");
  try {
    mkdirSync(repo);
    runGit(root, ["init", "--bare", remote]);
    runGit(repo, ["init"]);
    runGit(repo, ["config", "user.email", "test@example.com"]);
    runGit(repo, ["config", "user.name", "DraftForge Test"]);
    writeFileSync(path.join(repo, ".gitignore"), "dist/\n.draftforge/\n", "utf8");
    writeFileSync(path.join(repo, "tracked.js"), "export const tracked = true;\n", "utf8");
    runGit(repo, ["add", "."]);
    runGit(repo, ["commit", "-m", "certified release"]);
    runGit(repo, ["remote", "add", "origin", remote]);
    runGit(repo, ["push", "-u", "origin", "HEAD"]);

    mkdirSync(clientRoot, { recursive: true });
    mkdirSync(serverRoot, { recursive: true });
    writeFileSync(path.join(clientRoot, "app.js"), "console.log('client');\n", "utf8");
    writeFileSync(path.join(serverRoot, "index.js"), "export const server = true;\n", "utf8");
    writeFileSync(manifestPath, "previous certification\n", "utf8");
    const untracked = path.join(repo, "untracked-build-input.js");
    writeFileSync(untracked, "UNTRACKED_BUILD_PAYLOAD\n", "utf8");

    const spawnImpl = () => {
      const child = fakeProductionChild({ pid: 994444 });
      const payload = readFileSync(untracked, "utf8");
      writeFileSync(path.join(serverRoot, "index.js"), payload, "utf8");
      rmSync(untracked);
      queueMicrotask(() => child.emit("exit", 0, null));
      return child;
    };
    const rejected = await buildProduction({
      repoRoot: repo,
      listenerPidsImpl: () => [],
      spawnImpl,
    });
    assert.equal(rejected.ok, true);
    assert.equal(rejected.certified, false);
    assert.equal(rejected.code, "PRODUCTION_BUILD_UNCERTIFIED_SOURCE_STATE");
    assert.equal(rejected.inputReleaseCode, "LIVE_CODE_FREEZE_WORKTREE_DIRTY");
    assert.equal(rejected.outputReleaseCode, "LIVE_CODE_FREEZE_RELEASE_STATE_VERIFIED");
    assert.equal(existsSync(manifestPath), false);
    assert.equal(readFileSync(path.join(serverRoot, "index.js"), "utf8"), "UNTRACKED_BUILD_PAYLOAD\n");

    const cleanChild = fakeProductionChild({ pid: 995555 });
    const certified = await buildProduction({
      repoRoot: repo,
      listenerPidsImpl: () => [],
      spawnImpl: () => {
        queueMicrotask(() => cleanChild.emit("exit", 0, null));
        return cleanChild;
      },
    });
    assert.equal(certified.certified, true);
    assert.equal(certified.code, "PRODUCTION_BUILD_INTEGRITY_WRITTEN");
    assert.equal(existsSync(manifestPath), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("SIGKILL of the production build wrapper leaves its running child protected by the lease", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "draftforge-build-orphan-"));
  const leasePath = defaultReleaseArtifactLeasePath(root);
  let wrapper = null;
  let childPid = null;
  try {
    const fakeVinext = path.join(root, "node_modules", "vinext", "dist", "cli.js");
    mkdirSync(path.dirname(fakeVinext), { recursive: true });
    writeFileSync(fakeVinext, "setInterval(() => {}, 1000);\n", "utf8");
    mkdirSync(path.join(root, "dist", "client"), { recursive: true });

    wrapper = spawn(process.execPath, [path.join(projectRoot, "scripts", "build-production.mjs")], {
      cwd: root,
      stdio: "ignore",
    });
    const ownerPath = path.join(leasePath, "owner.json");
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      try {
        const owner = JSON.parse(readFileSync(ownerPath, "utf8"));
        if (Number.isInteger(owner.childPid) && owner.childPid > 0) {
          childPid = owner.childPid;
          break;
        }
      } catch {
        childPid = null;
      }
      await new Promise((resolveWait) => setTimeout(resolveWait, 20));
    }
    assert.ok(childPid, "build wrapper must persist its child PID before waiting for vinext");

    wrapper.kill("SIGKILL");
    await new Promise((resolveExit) => wrapper.once("exit", resolveExit));
    assert.doesNotThrow(() => process.kill(childPid, 0));
    assert.throws(() => acquireReleaseArtifactLease({
      projectRoot: root,
      leasePath,
      operation: "start",
    }), /RELEASE_ARTIFACT_IN_USE/);
  } finally {
    if (wrapper?.pid) {
      try { wrapper.kill("SIGKILL"); } catch { wrapper = null; }
    }
    if (childPid) {
      try { process.kill(childPid, "SIGKILL"); } catch { childPid = null; }
    }
    rmSync(root, { recursive: true, force: true });
  }
});

test("terminal integration has no manual arm path and binds automatic transitions to doctor and audit", () => {
  const cliPath = path.join(projectRoot, "scripts/live-code-freeze.mjs");
  const manualArm = spawnSync(process.execPath, [cliPath, "arm"], { cwd: projectRoot, encoding: "utf8" });
  assert.equal(manualArm.status, 2);
  assert.match(manualArm.stderr, /USAGE/);

  const doctorSource = readFileSync(path.join(projectRoot, "scripts/draft-day-doctor.mjs"), "utf8");
  const auditSource = readFileSync(path.join(projectRoot, "scripts/draft-day-audit.mjs"), "utf8");
  assert.match(doctorSource, /result\.ready && phase === "live"/);
  assert.match(doctorSource, /armLiveCodeFreezeAfterDoctor\(\{ doctorProof: doctorOutput \}\)/);
  assert.match(auditSource, /if \(requireComplete\)/);
  assert.match(auditSource, /clearLiveCodeFreezeAfterAudit/);
});
