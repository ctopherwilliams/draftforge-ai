import {
  evaluateDraftDayReadiness,
  type DraftDayExpectedLeague,
  type DraftDayReadinessPhase,
} from "./draft-day-readiness.ts";
import type { DraftAuditSnapshot } from "./draft-audit.ts";

export const DRAFT_DAY_DOCTOR_SLOS = Object.freeze({
  serverReadyMs: 10_000,
  sourceWarmMs: 45_000,
  sourceSnapshotFreshMs: 10 * 60_000,
  liveRecheckMs: 5_000,
  runtimeFreshMs: 15_000,
  authenticatedImportFreshMs: 5 * 60_000,
});

const SOURCE_SNAPSHOT_ID = /^sha256:[a-f0-9]{64}$/;
const CANONICAL_UTC_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const MAX_FUTURE_CLOCK_SKEW_MS = 5_000;

export function isDraftDaySourceSnapshotId(value: unknown): value is string {
  return typeof value === "string" && SOURCE_SNAPSHOT_ID.test(value);
}

export function draftDaySourceSnapshotAgeMs(value: unknown, now = Date.now()) {
  if (typeof value !== "string" || !CANONICAL_UTC_TIMESTAMP.test(value)) return Number.NaN;
  const capturedAt = Date.parse(value);
  if (!Number.isFinite(capturedAt) || new Date(capturedAt).toISOString() !== value) return Number.NaN;
  return now - capturedAt;
}

export function isDraftDaySourceSnapshotFresh(value: unknown, now = Date.now()) {
  const ageMs = draftDaySourceSnapshotAgeMs(value, now);
  return Number.isFinite(ageMs)
    && ageMs >= -MAX_FUTURE_CLOCK_SKEW_MS
    && ageMs <= DRAFT_DAY_DOCTOR_SLOS.sourceSnapshotFreshMs;
}

export type DraftDayDoctorSystem = {
  gitClean: boolean;
  headMatchesRemote: boolean;
  serverListenerCount: number;
  serverReadyMs: number;
  sourceWarmMs: number;
  sourceWarmSnapshotId: string;
  sourceWarmSnapshotGeneratedAt: string;
  totalCheckMs: number;
  manifestVersion: string;
  expectedExtensionVersion: string;
  extensionPackageSha256: string;
  expectedExtensionPackageSha256: string;
  extensionDirectorySourceSha256: string;
  extensionArchiveSourceSha256: string;
  expectedExtensionSourceSha256: string;
  extensionSourceFileCount: number;
  extensionArchiveFileCount: number;
  expectedExtensionSourceFileCount: number;
  currentRevision: string;
  servedReleaseRevision: string;
  currentSourceTreeSha256: string;
  servedSourceTreeSha256: string;
  servedReleaseManifestIntegrity: boolean;
  servedRuntimeAssetsIntegrity: boolean;
};

export type DraftDayDoctorResult = {
  ready: boolean;
  phase: DraftDayReadinessPhase;
  blockers: string[];
  checks: Record<string, boolean>;
  readinessBlockers: string[];
  runtimeAgeMs: number;
  authenticatedImportAgeMs: number;
  sourceWarmSnapshotAgeMs: number;
  activeSourceSnapshotAgeMs: number;
};

export function resolveDraftDayDoctorLeague(
  profile: DraftDayExpectedLeague,
  roomLeagueId?: string,
  roomTeamId?: number,
  roomSecondsPerPick?: number,
): DraftDayExpectedLeague {
  const id = String(roomLeagueId || profile.id).trim();
  const teamId = roomTeamId ?? profile.teamId;
  const secondsPerPick = roomSecondsPerPick ?? profile.secondsPerPick;
  if (!/^\d+$/.test(id) || !Number.isInteger(teamId) || teamId <= 0 || !Number.isInteger(secondsPerPick) || secondsPerPick <= 0) {
    throw new Error("DRAFT_DAY_ROOM_IDENTITY_INVALID");
  }
  return { ...profile, id, teamId, secondsPerPick };
}

export function evaluateDraftDayDoctor(input: {
  snapshot: DraftAuditSnapshot;
  expected: DraftDayExpectedLeague;
  phase?: DraftDayReadinessPhase;
  system: DraftDayDoctorSystem;
  now?: number;
}): DraftDayDoctorResult {
  const phase = input.phase || "pre-room";
  const now = input.now ?? Date.now();
  const readiness = evaluateDraftDayReadiness({ snapshot: input.snapshot, expected: input.expected, phase, now });
  const runtimeAgeMs = now - Date.parse(input.snapshot.runtime.capturedAt);
  const authenticatedImportAgeMs = now - Date.parse(input.snapshot.binding.authenticatedImportAt);
  const runtime = input.snapshot.runtime;
  const system = input.system;
  const sourceSafety = input.snapshot.safety as DraftAuditSnapshot["safety"] & {
    sourceSnapshotId?: unknown;
    sourceSnapshotGeneratedAt?: unknown;
  };
  const activeSourceSnapshotId = sourceSafety.sourceSnapshotId;
  const activeSourceSnapshotGeneratedAt = sourceSafety.sourceSnapshotGeneratedAt;
  const sourceWarmSnapshotAgeMs = draftDaySourceSnapshotAgeMs(system.sourceWarmSnapshotGeneratedAt, now);
  const activeSourceSnapshotAgeMs = draftDaySourceSnapshotAgeMs(activeSourceSnapshotGeneratedAt, now);
  const sourceWarmSnapshotIdentity = isDraftDaySourceSnapshotId(system.sourceWarmSnapshotId);
  const activeSourceSnapshotIdentity = isDraftDaySourceSnapshotId(activeSourceSnapshotId);
  const checks: Record<string, boolean> = {
    ...readiness.checks,
    gitClean: system.gitClean,
    headMatchesRemote: system.headMatchesRemote,
    oneProductionServer: system.serverListenerCount === 1,
    serverReadyWithinSlo: Number.isFinite(system.serverReadyMs) && system.serverReadyMs <= DRAFT_DAY_DOCTOR_SLOS.serverReadyMs,
    sourceWarmWithinSlo: Number.isFinite(system.sourceWarmMs) && system.sourceWarmMs <= DRAFT_DAY_DOCTOR_SLOS.sourceWarmMs,
    sourceWarmSnapshotIdentity,
    activeSourceSnapshotIdentity,
    sourceSnapshotIdentityMatch: sourceWarmSnapshotIdentity
      && activeSourceSnapshotIdentity
      && system.sourceWarmSnapshotId === activeSourceSnapshotId,
    sourceSnapshotGeneratedAtMatch: typeof activeSourceSnapshotGeneratedAt === "string"
      && system.sourceWarmSnapshotGeneratedAt === activeSourceSnapshotGeneratedAt,
    sourceWarmSnapshotFresh: isDraftDaySourceSnapshotFresh(system.sourceWarmSnapshotGeneratedAt, now),
    activeSourceSnapshotFresh: isDraftDaySourceSnapshotFresh(activeSourceSnapshotGeneratedAt, now),
    liveRecheckWithinSlo: phase !== "live" || (Number.isFinite(system.totalCheckMs) && system.totalCheckMs <= DRAFT_DAY_DOCTOR_SLOS.liveRecheckMs),
    runtimeFresh: Number.isFinite(runtimeAgeMs) && runtimeAgeMs >= -5_000 && runtimeAgeMs <= DRAFT_DAY_DOCTOR_SLOS.runtimeFreshMs,
    authenticatedImportFresh: phase === "complete" || (Number.isFinite(authenticatedImportAgeMs) && authenticatedImportAgeMs >= -5_000 && authenticatedImportAgeMs <= DRAFT_DAY_DOCTOR_SLOS.authenticatedImportFreshMs),
    exactTwoChromeTabs: runtime.browserTabCount === 2,
    oneDraftForgeTab: runtime.draftForgeTabCount === 1,
    oneEspnTab: runtime.espnTabCount === 1,
    managedWorkspaceCleanup: runtime.managedCleanupReady === true,
    manifestVersionPinned: system.manifestVersion === system.expectedExtensionVersion,
    installedExtensionVersionPinned: runtime.extensionVersion === system.expectedExtensionVersion,
    extensionPackageIntegrity: Boolean(system.extensionPackageSha256)
      && system.extensionPackageSha256 === system.expectedExtensionPackageSha256,
    extensionDirectoryPackageParity: Boolean(system.extensionDirectorySourceSha256)
      && system.extensionDirectorySourceSha256 === system.extensionArchiveSourceSha256
      && system.extensionSourceFileCount === system.extensionArchiveFileCount,
    extensionSourceIntegrity: Boolean(system.expectedExtensionSourceSha256)
      && system.extensionDirectorySourceSha256 === system.expectedExtensionSourceSha256
      && system.extensionArchiveSourceSha256 === system.expectedExtensionSourceSha256
      && system.extensionSourceFileCount === system.expectedExtensionSourceFileCount
      && system.extensionArchiveFileCount === system.expectedExtensionSourceFileCount,
    installedExtensionSourceIntegrity: Boolean(system.expectedExtensionSourceSha256)
      && runtime.extensionSourceSha256 === system.expectedExtensionSourceSha256
      && runtime.extensionSourceFileCount === system.expectedExtensionSourceFileCount,
    servedReleaseManifestIntegrity: system.servedReleaseManifestIntegrity === true,
    servedReleaseRevisionPinned: Boolean(system.currentRevision)
      && system.currentRevision === system.servedReleaseRevision,
    servedReleaseSourcePinned: Boolean(system.currentSourceTreeSha256)
      && system.currentSourceTreeSha256 === system.servedSourceTreeSha256,
    servedRuntimeAssetsIntegrity: system.servedRuntimeAssetsIntegrity === true,
  };
  const blockers = Object.entries(checks).filter(([, ok]) => !ok).map(([name]) => name);
  return {
    ready: blockers.length === 0,
    phase,
    blockers,
    checks,
    readinessBlockers: readiness.blockers,
    runtimeAgeMs,
    authenticatedImportAgeMs,
    sourceWarmSnapshotAgeMs,
    activeSourceSnapshotAgeMs,
  };
}
