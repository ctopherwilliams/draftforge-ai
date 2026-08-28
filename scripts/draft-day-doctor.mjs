#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  evaluateDraftDayDoctor,
  isDraftDaySourceSnapshotFresh,
  isDraftDaySourceSnapshotId,
  resolveDraftDayDoctorLeague,
} from "../app/lib/draft-day-doctor.ts";
import { intelligenceQuarterbackMode } from "../app/lib/consensus.ts";
import { parseDraftDayDoctorArguments } from "./draft-day-cli-lib.mjs";
import { armLiveCodeFreezeAfterDoctor } from "./live-code-freeze-lib.mjs";
import { productionListenerPids } from "./build-production.mjs";
import {
  boundedProductionStartupLog,
  startProductionSupervisor,
  terminateProductionSupervisor,
  waitForProductionSupervisorReady,
} from "./production-supervisor-lib.mjs";
import {
  defaultProductionSupervisionPath,
  inspectProductionSupervision,
} from "./production-supervision-lib.mjs";
import {
  computeTrackedSourceIntegrity,
  dashboardRuntimeAssetPaths,
  fetchAndVerifyServedRelease,
  validateDraftDayReleaseConfig,
  verifyExtensionReleaseArtifacts,
  verifyLocalServedRelease,
} from "./release-integrity-lib.mjs";

let cli;
try {
  cli = parseDraftDayDoctorArguments(process.argv.slice(2));
} catch (error) {
  console.error(JSON.stringify({
    ok: false,
    code: "USAGE",
    message: error instanceof Error ? error.message : String(error),
  }));
  process.exit(2);
}
const { format, phase, origin, startServer } = cli;
const startedAt = Date.now();

if (!new Set(["snake", "salary-cap"]).has(format) || !new Set(["pre-room", "live", "complete"]).has(phase)) {
  console.error(JSON.stringify({ ok: false, code: "USAGE", usage: "npm run draft-day:doctor -- --format snake|salary-cap [--phase pre-room|live|complete] [--league PRACTICE_ROOM_ID --team TEAM_ID --timer SECONDS] [--no-start-server]" }));
  process.exit(2);
}

const leagueConfig = JSON.parse(readFileSync(resolve("config/authenticated-espn-leagues.json"), "utf8"));
let releaseConfig;
try {
  releaseConfig = validateDraftDayReleaseConfig(
    JSON.parse(readFileSync(resolve("config/draft-day-release.json"), "utf8")),
  );
} catch (error) {
  console.error(JSON.stringify({
    ok: false,
    code: "DRAFT_DAY_DOCTOR_LOCKED",
    blockers: ["releaseConfigIntegrity"],
    message: error instanceof Error ? error.message : String(error),
  }, null, 2));
  process.exit(1);
}
const profile = leagueConfig?.profiles?.[format];
if (!profile) {
  console.error(JSON.stringify({ ok: false, code: "PROFILE_NOT_FOUND", format }));
  process.exit(2);
}
let expected;
try {
  const roomTeam = cli.team;
  const roomTimer = cli.timer;
  expected = resolveDraftDayDoctorLeague(
    profile,
    cli.league || undefined,
    roomTeam ? Number(roomTeam) : undefined,
    roomTimer ? Number(roomTimer) : undefined,
  );
} catch (error) {
  console.error(JSON.stringify({ ok: false, code: error instanceof Error ? error.message : "DRAFT_DAY_ROOM_IDENTITY_INVALID" }));
  process.exit(2);
}

function command(commandName, commandArgs = []) {
  return execFileSync(commandName, commandArgs, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

async function waitForDashboard() {
  const deadline = Date.now() + 10_000;
  let lastError = "dashboard did not respond";
  do {
    try {
      const response = await fetch(`${origin}/`, { headers: { Accept: "text/html" }, signal: AbortSignal.timeout(2_000) });
      if (response.ok) return response.text();
      lastError = `dashboard returned HTTP ${response.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 200));
  } while (Date.now() < deadline);
  throw new Error(lastError);
}

let initialListenerPids;
try {
  initialListenerPids = productionListenerPids();
} catch (error) {
  console.error(JSON.stringify({
    ok: false,
    code: "DRAFT_DAY_DOCTOR_LOCKED",
    blockers: ["serverListenerProbeFailed"],
    message: error instanceof Error ? error.message : String(error),
  }, null, 2));
  process.exit(1);
}

let productionSupervisor = null;
if (!initialListenerPids.length && startServer) {
  try {
    productionSupervisor = startProductionSupervisor({ projectRoot: process.cwd() });
  } catch (error) {
    console.error(JSON.stringify({
      ok: false,
      code: "DRAFT_DAY_DOCTOR_LOCKED",
      blockers: ["serverStartFailed"],
      message: error instanceof Error ? error.message : String(error),
    }, null, 2));
    process.exit(1);
  }
}

let dashboardHtml;
let serverReadyMs;
try {
  if (productionSupervisor) await waitForProductionSupervisorReady(productionSupervisor);
  dashboardHtml = await waitForDashboard();
  serverReadyMs = Date.now() - startedAt;
} catch (error) {
  const startupLog = productionSupervisor
    ? boundedProductionStartupLog(productionSupervisor.logPath, 8 * 1024)
    : "";
  const reaped = productionSupervisor
    ? await terminateProductionSupervisor(productionSupervisor)
    : true;
  console.error(JSON.stringify({
    ok: false,
    code: "DRAFT_DAY_DOCTOR_LOCKED",
    blockers: ["serverUnavailable", ...(!reaped ? ["serverCleanupFailed"] : [])],
    message: error instanceof Error ? error.message : String(error),
    ...(startupLog ? { startupLog } : {}),
  }, null, 2));
  process.exit(1);
}
productionSupervisor?.child.unref();

const initialRuntimeAssetPaths = dashboardRuntimeAssetPaths(dashboardHtml, origin);
if (!initialRuntimeAssetPaths.some((path) => path.includes("/_next/static/chunks/"))) {
  console.error(JSON.stringify({ ok: false, code: "DRAFT_DAY_DOCTOR_LOCKED", blockers: ["productionClientBundleMissing"] }, null, 2));
  process.exit(1);
}

const auditTimeoutMs = phase === "live" ? 1_500 : 10_000;
async function fetchActiveAudit() {
  const response = await fetch(`${origin}/api/draft-day?leagueId=${encodeURIComponent(expected.id)}&teamId=${expected.teamId}`, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(auditTimeoutMs),
  });
  const audit = await response.json();
  if (!response.ok || audit?.ok !== true) throw new Error(audit?.code || `HTTP_${response.status}`);
  return audit;
}

// Bind source verification to the exact snapshot already published by the
// dashboard. The route serves this expectation from its bounded lease and
// never substitutes a newer provider fetch across a cache rollover.
let audit;
try {
  audit = await fetchActiveAudit();
} catch (error) {
  console.error(JSON.stringify({ ok: false, code: "DRAFT_DAY_DOCTOR_LOCKED", blockers: ["auditUnavailable"], message: error instanceof Error ? error.message : String(error) }, null, 2));
  process.exit(1);
}
const expectedSourceSnapshotId = audit?.snapshot?.safety?.sourceSnapshotId;
const expectedSourceGeneratedAt = audit?.snapshot?.safety?.sourceSnapshotGeneratedAt;
if (!isDraftDaySourceSnapshotId(expectedSourceSnapshotId)
  || !isDraftDaySourceSnapshotFresh(expectedSourceGeneratedAt)) {
  console.error(JSON.stringify({
    ok: false,
    code: "DRAFT_DAY_DOCTOR_LOCKED",
    blockers: ["activeSourceSnapshotIdentity", "activeSourceSnapshotFresh"],
    message: "Active audit does not carry a fresh canonical source snapshot lease.",
  }, null, 2));
  process.exit(1);
}

const warmStartedAt = Date.now();
let warm;
const qbs = intelligenceQuarterbackMode(expected.lineupSlotCounts);
try {
  const response = await fetch(`${origin}/api/draft-day`, {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify({
      operation: "WARM",
      profile: { scoring: expected.scoringLabel, teams: expected.size, season: expected.season, qbs },
      expectedSourceSnapshotId,
      expectedSourceGeneratedAt,
    }),
    signal: AbortSignal.timeout(phase === "live" ? 1_500 : 45_000),
  });
  warm = await response.json();
  if (!response.ok || warm?.code !== "FIVE_SOURCE_READY") throw new Error(warm?.code || `HTTP_${response.status}`);
} catch (error) {
  console.error(JSON.stringify({ ok: false, code: "DRAFT_DAY_DOCTOR_LOCKED", blockers: ["sourceWarmFailed"], message: error instanceof Error ? error.message : String(error) }, null, 2));
  process.exit(1);
}
const sourceWarmMs = Date.now() - warmStartedAt;
const sourceWarmSnapshotId = typeof warm?.sourceSnapshotId === "string" ? warm.sourceSnapshotId : "";
const sourceWarmSnapshotGeneratedAt = typeof warm?.sourceGeneratedAt === "string"
  ? warm.sourceGeneratedAt
  : "";

// Re-read after the exact WARM. If the dashboard advanced to a new source
// identity during this check, the normal equality gate below locks this run.
try {
  audit = await fetchActiveAudit();
} catch (error) {
  console.error(JSON.stringify({ ok: false, code: "DRAFT_DAY_DOCTOR_LOCKED", blockers: ["auditUnavailable"], message: error instanceof Error ? error.message : String(error) }, null, 2));
  process.exit(1);
}

let gitClean = false;
let headMatchesRemote = false;
let head = "";
let sourceTree = { sha256: "", fileCount: 0 };
try {
  head = command("git", ["rev-parse", "HEAD"]);
  gitClean = command("git", ["status", "--porcelain"]) === "";
  headMatchesRemote = head === command("git", ["rev-parse", "@{upstream}"]);
  sourceTree = computeTrackedSourceIntegrity(process.cwd());
} catch { /* fail closed below */ }

let servedRelease = null;
let servedReleaseError = "";
try {
  const currentDashboardHtml = await waitForDashboard();
  const requiredRuntimeAssetPaths = dashboardRuntimeAssetPaths(currentDashboardHtml, origin);
  if (!requiredRuntimeAssetPaths.some((path) => path.includes("/_next/static/chunks/"))) {
    throw new Error("RELEASE_INTEGRITY_RUNTIME_ASSET_MISSING");
  }
  servedRelease = await fetchAndVerifyServedRelease({
    origin,
    expectedRevision: head,
    expectedSourceTree: sourceTree,
    requiredRuntimeAssetPaths,
  });
} catch (error) {
  servedReleaseError = error instanceof Error ? error.message : String(error);
}

let localRelease = null;
let localReleaseError = "";
try {
  localRelease = verifyLocalServedRelease({
    repoRoot: process.cwd(),
    clientRoot: resolve("dist/client"),
    serverRoot: resolve("dist/server"),
    expectedRevision: head,
    expectedSourceTree: sourceTree,
  });
} catch (error) {
  localReleaseError = error instanceof Error ? error.message : String(error);
}

let extensionArtifacts = null;
let extensionIntegrityError = "";
try {
  extensionArtifacts = verifyExtensionReleaseArtifacts({
    extensionDir: resolve("extension"),
    zipPath: resolve("public/draftforge-espn-companion.zip"),
    releaseConfig,
  });
} catch (error) {
  extensionIntegrityError = error instanceof Error ? error.message : String(error);
}

const manifest = JSON.parse(readFileSync(resolve("extension/manifest.json"), "utf8"));
const extensionDirectory = extensionArtifacts?.directory || { sha256: "", fileCount: 0 };
const extensionArchive = extensionArtifacts?.archive || { sha256: "", fileCount: 0, packageSha256: "" };

let currentListenerPids;
try {
  currentListenerPids = productionListenerPids();
} catch (error) {
  console.error(JSON.stringify({
    ok: false,
    code: "DRAFT_DAY_DOCTOR_LOCKED",
    blockers: ["serverListenerProbeFailed"],
    message: error instanceof Error ? error.message : String(error),
  }, null, 2));
  process.exit(1);
}

const productionSupervision = inspectProductionSupervision({
  statePath: defaultProductionSupervisionPath(process.cwd()),
  listenerPids: currentListenerPids,
});
if (!productionSupervision.ok) {
  console.error(JSON.stringify({
    ok: false,
    code: "DRAFT_DAY_DOCTOR_LOCKED",
    blockers: ["productionSupervisorUnavailable"],
    message: productionSupervision.code,
  }, null, 2));
  process.exit(1);
}

const result = evaluateDraftDayDoctor({
  snapshot: audit.snapshot,
  expected,
  phase,
  system: {
    gitClean,
    headMatchesRemote,
    serverListenerCount: currentListenerPids.length,
    serverReadyMs,
    sourceWarmMs,
    sourceWarmSnapshotId,
    sourceWarmSnapshotGeneratedAt,
    totalCheckMs: Date.now() - startedAt,
    manifestVersion: String(manifest.version || ""),
    expectedExtensionVersion: String(releaseConfig.extensionVersion || ""),
    extensionPackageSha256: extensionArchive.packageSha256,
    expectedExtensionPackageSha256: String(releaseConfig.extensionPackageSha256 || ""),
    extensionDirectorySourceSha256: extensionDirectory.sha256,
    extensionArchiveSourceSha256: extensionArchive.sha256,
    expectedExtensionSourceSha256: String(releaseConfig.extensionSourceSha256 || ""),
    extensionSourceFileCount: extensionDirectory.fileCount,
    extensionArchiveFileCount: extensionArchive.fileCount,
    expectedExtensionSourceFileCount: Number(releaseConfig.extensionSourceFileCount || 0),
    currentRevision: head,
    servedReleaseRevision: String(servedRelease?.manifest?.revision || ""),
    currentSourceTreeSha256: sourceTree.sha256,
    servedSourceTreeSha256: String(servedRelease?.manifest?.sourceTree?.sha256 || ""),
    servedReleaseManifestIntegrity: Boolean(
      servedRelease
      && localRelease
      && servedRelease.manifestSha256 === localRelease.manifestSha256
    ),
    servedRuntimeAssetsIntegrity: Boolean(
      servedRelease
      && localRelease
      && servedRelease.manifest.clientAssets.sha256 === localRelease.assetTree.sha256
      && servedRelease.serverAssetSetSha256 === localRelease.serverAssetTree.sha256
    ),
  },
});

const doctorOutput = {
  ok: result.ready,
  code: result.ready ? "DRAFT_DAY_DOCTOR_READY" : "DRAFT_DAY_DOCTOR_LOCKED",
  format,
  phase,
  sourceLeagueId: String(profile.id),
  leagueId: expected.id,
  roomId: expected.id,
  teamId: expected.teamId,
  revision: head,
  sourceCoverage: warm.sourceCoverage,
  sourceSnapshotId: result.checks.sourceSnapshotIdentityMatch ? sourceWarmSnapshotId : null,
  sourceSnapshotAgesMs: {
    warm: Number.isFinite(result.sourceWarmSnapshotAgeMs) ? result.sourceWarmSnapshotAgeMs : null,
    active: Number.isFinite(result.activeSourceSnapshotAgeMs) ? result.activeSourceSnapshotAgeMs : null,
  },
  qbs,
  timing: { serverReadyMs, sourceWarmMs, totalCheckMs: Date.now() - startedAt },
  integrity: {
    sourceTreeSha256: sourceTree.sha256,
    servedManifestSha256: servedRelease?.manifestSha256 || "",
    servedAssetSetSha256: servedRelease?.manifest?.clientAssets?.sha256 || "",
    servedAssetCount: servedRelease?.assetCount || 0,
    servedServerAssetSetSha256: servedRelease?.serverAssetSetSha256 || "",
    servedServerAssetCount: servedRelease?.serverAssetCount || 0,
    servedServerAssetBytes: servedRelease?.totalServerAssetBytes || 0,
    extensionSourceSha256: extensionDirectory.sha256,
    extensionPackageSha256: extensionArchive.packageSha256,
    installedExtensionSourceSha256: audit.snapshot.runtime.extensionSourceSha256,
    servedReleaseError,
    localReleaseError,
    extensionIntegrityError,
  },
  runtime: audit.snapshot.runtime,
  blockers: result.blockers,
  checks: result.checks,
};

let liveCodeFreeze = null;
if (result.ready && phase === "live") {
  try {
    const freeze = armLiveCodeFreezeAfterDoctor({ doctorProof: doctorOutput });
    liveCodeFreeze = { ok: true, code: "LIVE_CODE_FREEZE_ARMED", freeze };
  } catch (error) {
    console.log(JSON.stringify({
      ...doctorOutput,
      ok: false,
      code: "DRAFT_DAY_DOCTOR_LOCKED",
      blockers: [...new Set([...doctorOutput.blockers, "liveCodeFreezeArmFailed"])],
      liveCodeFreeze: {
        ok: false,
        code: error instanceof Error ? error.message : "LIVE_CODE_FREEZE_ARM_FAILED",
      },
    }, null, 2));
    process.exit(1);
  }
}

console.log(JSON.stringify({ ...doctorOutput, liveCodeFreeze }, null, 2));
process.exit(result.ready ? 0 : 1);
