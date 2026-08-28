import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  linkSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import {
  validateDraftDayReleaseConfig,
  verifyExtensionReleaseArtifacts,
  verifyLocalServedRelease,
} from "./release-integrity-lib.mjs";

export const LIVE_CODE_FREEZE_SCHEMA = "draftforge.live-code-freeze/v3";
export const LIVE_CODE_FREEZE_EMERGENCY_PREFIX = "LIVE_CODE_FREEZE_EMERGENCY_CLEAR";

const FORMATS = new Set(["snake", "salary-cap"]);
const PROTECTED_OPERATIONS = new Set([
  "build",
  "test",
  "dev",
  "extension-package",
  "source-refresh",
]);
const ALLOWED_OPERATIONS = new Set([...PROTECTED_OPERATIONS, "start"]);
const HASH_PATTERN = /^[a-f0-9]{64}$/;
const EXTENSION_VERSION_PATTERN = /^\d+\.\d+\.\d+$/;
const FROZEN_ARTIFACT_FIELDS = Object.freeze([
  "releaseManifestSha256",
  "sourceTreeSha256",
  "sourceTreeFileCount",
  "clientAssetSetSha256",
  "clientAssetCount",
  "clientAssetBytes",
  "serverAssetSetSha256",
  "serverAssetCount",
  "serverAssetBytes",
  "extensionVersion",
  "extensionSourceSha256",
  "extensionSourceFileCount",
  "extensionPackageSha256",
]);
const REQUIRED_LIVE_DOCTOR_CHECKS = Object.freeze([
  "gitClean",
  "headMatchesRemote",
  "exactLeague",
  "exactTeam",
  "exactDraftType",
  "exactTabBound",
  "currentPublisher",
  "settingsConfirmed",
  "extensionConnected",
  "managedWorkspaceCleanup",
  "fiveSources",
  "exactSourceSet",
  "autoDraftOff",
  "espnAutopickOff",
  "actionHealthy",
  "availabilityReady",
  "liveChecklistReady",
  "inDraftRoom",
  "oneProductionServer",
  "runtimeFresh",
  "authenticatedImportFresh",
  "exactTwoChromeTabs",
  "oneDraftForgeTab",
  "oneEspnTab",
  "manifestVersionPinned",
  "installedExtensionVersionPinned",
  "extensionPackageIntegrity",
]);

function git(projectRoot, args) {
  return execFileSync("git", args, {
    cwd: projectRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function validId(value) {
  return /^\d{1,20}$/.test(String(value || ""));
}

function validRevision(value) {
  return /^[a-f0-9]{40}$/.test(String(value || ""));
}

function validateFrozenArtifact(value) {
  if (!value || typeof value !== "object"
    || !HASH_PATTERN.test(String(value.releaseManifestSha256 || ""))
    || !HASH_PATTERN.test(String(value.sourceTreeSha256 || ""))
    || !Number.isSafeInteger(value.sourceTreeFileCount) || value.sourceTreeFileCount <= 0
    || !HASH_PATTERN.test(String(value.clientAssetSetSha256 || ""))
    || !Number.isSafeInteger(value.clientAssetCount) || value.clientAssetCount <= 0
    || !Number.isSafeInteger(value.clientAssetBytes) || value.clientAssetBytes < 0
    || !HASH_PATTERN.test(String(value.serverAssetSetSha256 || ""))
    || !Number.isSafeInteger(value.serverAssetCount) || value.serverAssetCount <= 0
    || !Number.isSafeInteger(value.serverAssetBytes) || value.serverAssetBytes < 0
    || !EXTENSION_VERSION_PATTERN.test(String(value.extensionVersion || ""))
    || !HASH_PATTERN.test(String(value.extensionSourceSha256 || ""))
    || !Number.isSafeInteger(value.extensionSourceFileCount) || value.extensionSourceFileCount <= 0
    || !HASH_PATTERN.test(String(value.extensionPackageSha256 || ""))) {
    throw new Error("LIVE_CODE_FREEZE_ARTIFACT_INVALID");
  }
  return Object.freeze(Object.fromEntries(FROZEN_ARTIFACT_FIELDS.map((field) => [field, value[field]])));
}

function artifactFromFreeze(freeze) {
  return validateFrozenArtifact(Object.fromEntries(FROZEN_ARTIFACT_FIELDS.map((field) => [field, freeze?.[field]])));
}

function sameFrozenArtifact(left, right) {
  return FROZEN_ARTIFACT_FIELDS.every((field) => left[field] === right[field]);
}

function sameFreezeIdentity(left, right) {
  return left.revision === right.revision
    && left.leagueId === right.leagueId
    && left.teamId === right.teamId
    && left.roomId === right.roomId
    && left.format === right.format
    && sameFrozenArtifact(artifactFromFreeze(left), artifactFromFreeze(right));
}

function writeJsonAtomically(targetPath, value) {
  mkdirSync(path.dirname(targetPath), { recursive: true, mode: 0o700 });
  const temporaryPath = `${targetPath}.${process.pid}.${Date.now()}.tmp`;
  try {
    writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    linkSync(temporaryPath, targetPath);
    rmSync(temporaryPath);
  } finally {
    rmSync(temporaryPath, { force: true });
  }
}

export function defaultLiveCodeFreezePath(projectRoot = process.cwd()) {
  return path.join(projectRoot, ".draftforge", "live-code-freeze.json");
}

export function readLiveCodeFreeze(statePath = defaultLiveCodeFreezePath()) {
  let value;
  try {
    value = JSON.parse(readFileSync(statePath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw new Error("LIVE_CODE_FREEZE_INVALID");
  }
  const keys = value && typeof value === "object" && !Array.isArray(value)
    ? Object.keys(value).sort()
    : [];
  const expectedKeys = [
    "armedAt",
    "format",
    "leagueId",
    "revision",
    "roomId",
    "schemaVersion",
    "teamId",
    ...FROZEN_ARTIFACT_FIELDS,
  ].sort();
  if (keys.length !== expectedKeys.length || keys.some((key, index) => key !== expectedKeys[index])
    || value.schemaVersion !== LIVE_CODE_FREEZE_SCHEMA
    || !validId(value.leagueId)
    || !validId(value.roomId)
    || !Number.isInteger(value.teamId) || value.teamId <= 0
    || !FORMATS.has(value.format)
    || !validRevision(value.revision)
    || !Number.isFinite(Date.parse(String(value.armedAt || "")))) {
    throw new Error("LIVE_CODE_FREEZE_INVALID");
  }
  try {
    validateFrozenArtifact(value);
  } catch {
    throw new Error("LIVE_CODE_FREEZE_INVALID");
  }
  return Object.freeze({ ...value });
}

export function evaluateProductionReleaseState(release) {
  if (!validRevision(release?.revision)) {
    return { ok: false, code: "LIVE_CODE_FREEZE_REVISION_CHANGED" };
  }
  if (release.clean !== true) {
    return { ok: false, code: "LIVE_CODE_FREEZE_WORKTREE_DIRTY" };
  }
  if (release.upstreamMatches !== true) {
    return { ok: false, code: "LIVE_CODE_FREEZE_UPSTREAM_MISMATCH" };
  }
  return { ok: true, code: "LIVE_CODE_FREEZE_RELEASE_STATE_VERIFIED" };
}

export function evaluateCodeFreezeCheck({
  freeze,
  operation,
  currentRevision,
  currentRelease,
  currentArtifact,
}) {
  if (!ALLOWED_OPERATIONS.has(operation)) {
    return { ok: false, code: "LIVE_CODE_FREEZE_OPERATION_INVALID" };
  }
  if (operation === "start") {
    const release = currentRelease || { revision: currentRevision };
    const releaseState = evaluateProductionReleaseState(release);
    if (!releaseState.ok) return { ...releaseState, freeze };
    if (currentRevision !== undefined && currentRevision !== release.revision) {
      return { ok: false, code: "LIVE_CODE_FREEZE_REVISION_CHANGED", freeze };
    }
    let actualArtifact;
    try {
      actualArtifact = validateFrozenArtifact(currentArtifact);
    } catch {
      return { ok: false, code: "LIVE_CODE_FREEZE_ARTIFACT_UNVERIFIED", freeze };
    }
    const exactRevision = release.revision;
    if (!freeze) {
      return { ok: true, code: "LIVE_CODE_FREEZE_INACTIVE_START_VERIFIED" };
    }
    if (freeze.revision !== exactRevision) {
      return { ok: false, code: "LIVE_CODE_FREEZE_REVISION_CHANGED", freeze };
    }
    const expectedArtifact = artifactFromFreeze(freeze);
    if (!sameFrozenArtifact(expectedArtifact, actualArtifact)) {
      return { ok: false, code: "LIVE_CODE_FREEZE_ARTIFACT_CHANGED", freeze };
    }
    return { ok: true, code: "LIVE_CODE_FREEZE_FROZEN_START_ALLOWED", freeze };
  }
  if (!freeze) return { ok: true, code: "LIVE_CODE_FREEZE_INACTIVE" };
  if (!validRevision(currentRevision) || freeze.revision !== currentRevision) {
    return { ok: false, code: "LIVE_CODE_FREEZE_REVISION_CHANGED", freeze };
  }
  return { ok: false, code: "LIVE_CODE_FREEZE_ACTIVE", freeze };
}

export function inspectReleaseRevision(projectRoot = process.cwd()) {
  const revision = git(projectRoot, ["rev-parse", "HEAD"]);
  let upstream = "";
  try { upstream = git(projectRoot, ["rev-parse", "@{upstream}"]); } catch { /* fail closed below */ }
  return {
    revision,
    clean: git(projectRoot, ["status", "--porcelain"]) === "",
    upstreamMatches: Boolean(upstream) && upstream === revision,
  };
}

export function inspectLocalFrozenArtifact(projectRoot = process.cwd(), currentRevision) {
  const revision = String(currentRevision || inspectReleaseRevision(projectRoot).revision);
  const served = verifyLocalServedRelease({
    repoRoot: projectRoot,
    clientRoot: path.join(projectRoot, "dist", "client"),
    serverRoot: path.join(projectRoot, "dist", "server"),
    expectedRevision: revision,
  });
  const releaseConfig = validateDraftDayReleaseConfig(
    JSON.parse(readFileSync(path.join(projectRoot, "config", "draft-day-release.json"), "utf8")),
  );
  const extensionArtifacts = verifyExtensionReleaseArtifacts({
    extensionDir: path.join(projectRoot, "extension"),
    zipPath: path.join(projectRoot, "public", "draftforge-espn-companion.zip"),
    releaseConfig,
  });
  const extensionManifest = JSON.parse(
    readFileSync(path.join(projectRoot, "extension", "manifest.json"), "utf8"),
  );
  if (String(extensionManifest.version || "") !== releaseConfig.extensionVersion
    || Object.values(extensionArtifacts.checks).some((check) => check !== true)) {
    throw new Error("LIVE_CODE_FREEZE_ARTIFACT_INVALID");
  }
  return validateFrozenArtifact({
    releaseManifestSha256: served.manifestSha256,
    sourceTreeSha256: served.sourceTree.sha256,
    sourceTreeFileCount: served.sourceTree.fileCount,
    clientAssetSetSha256: served.assetTree.sha256,
    clientAssetCount: served.assetTree.fileCount,
    clientAssetBytes: served.assetTree.totalBytes,
    serverAssetSetSha256: served.serverAssetTree.sha256,
    serverAssetCount: served.serverAssetTree.fileCount,
    serverAssetBytes: served.serverAssetTree.totalBytes,
    extensionVersion: releaseConfig.extensionVersion,
    extensionSourceSha256: extensionArtifacts.directory.sha256,
    extensionSourceFileCount: extensionArtifacts.directory.fileCount,
    extensionPackageSha256: extensionArtifacts.archive.packageSha256,
  });
}

function validateLiveDoctorProof(proof, release, artifact) {
  const checks = proof?.checks;
  const allReportedChecksPass = checks
    && typeof checks === "object"
    && !Array.isArray(checks)
    && Object.keys(checks).length >= REQUIRED_LIVE_DOCTOR_CHECKS.length
    && Object.values(checks).every((value) => value === true);
  const requiredChecksPass = REQUIRED_LIVE_DOCTOR_CHECKS.every((key) => checks?.[key] === true);
  if (proof?.ok !== true
    || proof?.code !== "DRAFT_DAY_DOCTOR_READY"
    || proof?.phase !== "live"
    || !FORMATS.has(proof?.format)
    || !validId(proof?.sourceLeagueId)
    || !validId(proof?.roomId)
    || !Number.isInteger(proof?.teamId) || proof.teamId <= 0
    || !Array.isArray(proof?.blockers) || proof.blockers.length !== 0
    || !allReportedChecksPass
    || !requiredChecksPass
    || !validRevision(proof?.revision)
    || proof.revision !== release.revision
    || proof.integrity?.servedManifestSha256 !== artifact.releaseManifestSha256
    || proof.integrity?.sourceTreeSha256 !== artifact.sourceTreeSha256
    || proof.integrity?.servedAssetSetSha256 !== artifact.clientAssetSetSha256
    || proof.integrity?.servedAssetCount !== artifact.clientAssetCount
    || proof.integrity?.servedServerAssetSetSha256 !== artifact.serverAssetSetSha256
    || proof.integrity?.servedServerAssetCount !== artifact.serverAssetCount
    || proof.integrity?.servedServerAssetBytes !== artifact.serverAssetBytes
    || proof.integrity?.extensionSourceSha256 !== artifact.extensionSourceSha256
    || proof.integrity?.installedExtensionSourceSha256 !== artifact.extensionSourceSha256
    || proof.integrity?.extensionPackageSha256 !== artifact.extensionPackageSha256
    || proof.runtime?.extensionVersion !== artifact.extensionVersion
    || proof.runtime?.extensionSourceSha256 !== artifact.extensionSourceSha256
    || proof.runtime?.extensionSourceFileCount !== artifact.extensionSourceFileCount
    || !release.clean
    || !release.upstreamMatches) {
    throw new Error("LIVE_CODE_FREEZE_ARM_REFUSED");
  }
}

export function armLiveCodeFreezeAfterDoctor({
  projectRoot = process.cwd(),
  statePath = defaultLiveCodeFreezePath(projectRoot),
  doctorProof,
  armedAt = new Date().toISOString(),
  release,
  artifact,
}) {
  const releaseState = release || inspectReleaseRevision(projectRoot);
  const artifactState = validateFrozenArtifact(
    artifact || inspectLocalFrozenArtifact(projectRoot, releaseState.revision),
  );
  validateLiveDoctorProof(doctorProof, releaseState, artifactState);
  if (!Number.isFinite(Date.parse(armedAt))) throw new Error("LIVE_CODE_FREEZE_ARM_REFUSED");

  const next = Object.freeze({
    schemaVersion: LIVE_CODE_FREEZE_SCHEMA,
    armedAt,
    revision: releaseState.revision,
    leagueId: String(doctorProof.sourceLeagueId),
    teamId: doctorProof.teamId,
    roomId: String(doctorProof.roomId),
    format: doctorProof.format,
    ...artifactState,
  });
  const existing = readLiveCodeFreeze(statePath);
  if (existing) {
    if (!sameFreezeIdentity(existing, next)) throw new Error("LIVE_CODE_FREEZE_ALREADY_ACTIVE");
    return existing;
  }

  try {
    writeJsonAtomically(statePath, next);
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    const concurrent = readLiveCodeFreeze(statePath);
    if (!concurrent || !sameFreezeIdentity(concurrent, next)) {
      throw new Error("LIVE_CODE_FREEZE_ALREADY_ACTIVE");
    }
    return concurrent;
  }
  return next;
}

function validateCompletionAuditProof(freeze, auditProof, requestedLeagueId, requestedTeamId, currentRevision) {
  const snapshot = auditProof?.snapshot;
  const evaluation = auditProof?.evaluation;
  const expectedDraftType = freeze.format === "snake" ? "SNAKE" : "AUCTION";
  if (auditProof?.ok !== true
    || auditProof?.code !== "DRAFT_AUDIT_READY"
    || evaluation?.finalReady !== true
    || evaluation?.complete !== true
    || evaluation?.parity !== true
    || !Array.isArray(evaluation?.finalViolations) || evaluation.finalViolations.length !== 0
    || String(requestedLeagueId || "") !== freeze.roomId
    || Number(requestedTeamId) !== freeze.teamId
    || String(snapshot?.league?.id || "") !== freeze.roomId
    || Number(snapshot?.league?.teamId) !== freeze.teamId
    || snapshot?.league?.draftType !== expectedDraftType
    || currentRevision !== freeze.revision) {
    throw new Error("LIVE_CODE_FREEZE_COMPLETION_CLEAR_REFUSED");
  }
}

export function clearLiveCodeFreezeAfterAudit({
  statePath = defaultLiveCodeFreezePath(),
  requestedLeagueId,
  requestedTeamId,
  auditProof,
  currentRevision,
}) {
  const freeze = readLiveCodeFreeze(statePath);
  if (!freeze) return { cleared: false, code: "LIVE_CODE_FREEZE_INACTIVE" };
  validateCompletionAuditProof(freeze, auditProof, requestedLeagueId, requestedTeamId, currentRevision);
  rmSync(statePath);
  return {
    cleared: true,
    code: "LIVE_CODE_FREEZE_COMPLETION_CLEARED",
    revision: freeze.revision,
    roomId: freeze.roomId,
  };
}

export function emergencyConfirmationFor(freeze) {
  return [
    LIVE_CODE_FREEZE_EMERGENCY_PREFIX,
    freeze.leagueId,
    freeze.teamId,
    freeze.roomId,
    freeze.revision,
  ].join(":");
}

export function emergencyClearLiveCodeFreeze({
  statePath = defaultLiveCodeFreezePath(),
  leagueId,
  teamId,
  roomId,
  emergencyReason,
  confirmation,
  clearedAt = new Date().toISOString(),
}) {
  const freeze = readLiveCodeFreeze(statePath);
  if (!freeze) return { cleared: false, code: "LIVE_CODE_FREEZE_INACTIVE" };
  const reason = typeof emergencyReason === "string" ? emergencyReason.trim() : "";
  const exactIdentity = String(leagueId || "") === freeze.leagueId
    && Number(teamId) === freeze.teamId
    && String(roomId || "") === freeze.roomId;
  if (!exactIdentity
    || reason.length < 20
    || reason.length > 500
    || confirmation !== emergencyConfirmationFor(freeze)
    || !Number.isFinite(Date.parse(clearedAt))) {
    throw new Error("LIVE_CODE_FREEZE_EMERGENCY_CLEAR_REFUSED");
  }

  const receipt = Object.freeze({
    schemaVersion: LIVE_CODE_FREEZE_SCHEMA,
    code: "LIVE_CODE_FREEZE_EMERGENCY_CLEARED",
    clearedAt,
    revision: freeze.revision,
    leagueId: freeze.leagueId,
    teamId: freeze.teamId,
    roomId: freeze.roomId,
    format: freeze.format,
    reasonSha256: createHash("sha256").update(reason).digest("hex"),
  });
  const receiptDirectory = path.join(path.dirname(statePath), "emergency-clear-receipts");
  const receiptPath = path.join(receiptDirectory, `${clearedAt.replace(/[^0-9A-Za-z]/g, "-")}-${process.pid}.json`);
  writeJsonAtomically(receiptPath, receipt);
  rmSync(statePath);
  return { cleared: true, code: receipt.code, receipt, receiptPath };
}
