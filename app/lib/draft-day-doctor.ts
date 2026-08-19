import {
  evaluateDraftDayReadiness,
  type DraftDayExpectedLeague,
  type DraftDayReadinessPhase,
} from "./draft-day-readiness.ts";
import type { DraftAuditSnapshot } from "./draft-audit.ts";

export const DRAFT_DAY_DOCTOR_SLOS = Object.freeze({
  serverReadyMs: 10_000,
  sourceWarmMs: 45_000,
  liveRecheckMs: 5_000,
  runtimeFreshMs: 15_000,
  authenticatedImportFreshMs: 5 * 60_000,
});

export type DraftDayDoctorSystem = {
  gitClean: boolean;
  headMatchesRemote: boolean;
  serverListenerCount: number;
  serverReadyMs: number;
  sourceWarmMs: number;
  totalCheckMs: number;
  manifestVersion: string;
  expectedExtensionVersion: string;
  extensionPackageSha256: string;
  expectedExtensionPackageSha256: string;
};

export type DraftDayDoctorResult = {
  ready: boolean;
  phase: DraftDayReadinessPhase;
  blockers: string[];
  checks: Record<string, boolean>;
  readinessBlockers: string[];
  runtimeAgeMs: number;
  authenticatedImportAgeMs: number;
};

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
  const checks: Record<string, boolean> = {
    ...readiness.checks,
    gitClean: system.gitClean,
    headMatchesRemote: system.headMatchesRemote,
    oneProductionServer: system.serverListenerCount === 1,
    serverReadyWithinSlo: Number.isFinite(system.serverReadyMs) && system.serverReadyMs <= DRAFT_DAY_DOCTOR_SLOS.serverReadyMs,
    sourceWarmWithinSlo: Number.isFinite(system.sourceWarmMs) && system.sourceWarmMs <= DRAFT_DAY_DOCTOR_SLOS.sourceWarmMs,
    liveRecheckWithinSlo: phase !== "live" || (Number.isFinite(system.totalCheckMs) && system.totalCheckMs <= DRAFT_DAY_DOCTOR_SLOS.liveRecheckMs),
    runtimeFresh: Number.isFinite(runtimeAgeMs) && runtimeAgeMs >= -5_000 && runtimeAgeMs <= DRAFT_DAY_DOCTOR_SLOS.runtimeFreshMs,
    authenticatedImportFresh: Number.isFinite(authenticatedImportAgeMs) && authenticatedImportAgeMs >= -5_000 && authenticatedImportAgeMs <= DRAFT_DAY_DOCTOR_SLOS.authenticatedImportFreshMs,
    exactTwoChromeTabs: runtime.browserTabCount === 2,
    oneDraftForgeTab: runtime.draftForgeTabCount === 1,
    oneEspnTab: runtime.espnTabCount === 1,
    manifestVersionPinned: system.manifestVersion === system.expectedExtensionVersion,
    installedExtensionVersionPinned: runtime.extensionVersion === system.expectedExtensionVersion,
    extensionPackageIntegrity: Boolean(system.extensionPackageSha256)
      && system.extensionPackageSha256 === system.expectedExtensionPackageSha256,
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
  };
}
