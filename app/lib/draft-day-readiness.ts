import { evaluateDraftAuditSnapshot, MAX_DRAFT_ACTION_TELEMETRY_EVENTS, type DraftAuditSnapshot } from "./draft-audit.ts";

export type DraftDayReadinessPhase = "pre-room" | "live" | "complete";

export type DraftDayExpectedLeague = DraftAuditSnapshot["league"];

export type DraftDayReadinessResult = {
  ready: boolean;
  phase: DraftDayReadinessPhase;
  ageMs: number;
  blockers: string[];
  checks: Record<string, boolean>;
};

function canonicalRecord(value: Record<string, number>, positiveOnly = false) {
  return JSON.stringify(Object.fromEntries(
    Object.entries(value || {})
      .filter(([, count]) => !positiveOnly || Number(count) > 0)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, count]) => [key, Number(count)]),
  ));
}

export function evaluateDraftDayReadiness(input: {
  snapshot: DraftAuditSnapshot;
  expected: DraftDayExpectedLeague;
  phase?: DraftDayReadinessPhase;
  now?: number;
  maxAgeMs?: number;
}): DraftDayReadinessResult {
  const phase = input.phase || "pre-room";
  const now = input.now ?? Date.now();
  const maxAgeMs = input.maxAgeMs ?? 15_000;
  const snapshot = input.snapshot;
  const expected = input.expected;
  const ageMs = now - Date.parse(snapshot.capturedAt);
  const exactLeague = snapshot.league;
  const checks: Record<string, boolean> = {
    snapshotFresh: Number.isFinite(ageMs) && ageMs >= -5_000 && ageMs <= maxAgeMs,
    exactLeague: String(exactLeague.id) === String(expected.id),
    exactTeam: Number(exactLeague.teamId) === Number(expected.teamId),
    exactSeason: Number(exactLeague.season) === Number(expected.season),
    exactDraftType: exactLeague.draftType === expected.draftType,
    exactLeagueSize: Number(exactLeague.size) === Number(expected.size),
    exactRosterSize: Number(exactLeague.rosterSize) === Number(expected.rosterSize),
    exactAuctionBudget: Number(exactLeague.auctionBudget) === Number(expected.auctionBudget),
    exactTimer: Number(exactLeague.secondsPerPick) === Number(expected.secondsPerPick),
    exactScoring: exactLeague.scoringLabel === expected.scoringLabel && Number(exactLeague.scoringRules) === Number(expected.scoringRules),
    exactKeepers: Number(exactLeague.keeperCount) === Number(expected.keeperCount),
    exactLineupSlots: canonicalRecord(exactLeague.lineupSlotCounts, true) === canonicalRecord(expected.lineupSlotCounts, true),
    exactPositionLimits: canonicalRecord(exactLeague.positionLimits) === canonicalRecord(expected.positionLimits),
    exactTabBound: Number.isInteger(snapshot.binding.tabId) && snapshot.binding.tabId > 0,
    currentPublisher: Boolean(snapshot.binding.commandCenterSessionId && Number.isFinite(Date.parse(String(snapshot.binding.commandCenterStartedAt || "")))),
    settingsConfirmed: snapshot.safety.settingsConfirmed === true,
    extensionConnected: snapshot.safety.extensionConnected === true,
    managedWorkspaceCleanup: snapshot.runtime.managedCleanupReady === true,
    fiveSources: snapshot.safety.sourceCoverage === 5,
    exactSourceSet: JSON.stringify([...new Set(snapshot.safety.sourceIds)].sort()) === JSON.stringify(["espn", "ffc", "gng", "mfl", "tradyr"]),
    autoDraftOff: snapshot.safety.autoDraft === false,
    espnAutopickOff: snapshot.safety.autopickActive === false,
    actionHealthy: !/stopped|excluded|autopick|fatal/i.test(snapshot.safety.actionState),
    telemetryValid: snapshot.telemetry.actions.length <= MAX_DRAFT_ACTION_TELEMETRY_EVENTS,
    sleeperEvidenceValid: snapshot.sleeperEvidence.candidateCount === snapshot.sleeperEvidence.candidates.length,
  };
  if (phase === "live" || phase === "complete") {
    checks.liveChecklistReady = snapshot.safety.liveChecklistReady === true;
    checks.inDraftRoom = snapshot.safety.inDraftRoom === true;
    checks.soundMuted = snapshot.safety.soundMuted === true;
  }
  if (phase === "complete") {
    checks.completeAudit = evaluateDraftAuditSnapshot(snapshot).finalReady === true;
  }
  const blockers = Object.entries(checks).filter(([, ok]) => !ok).map(([name]) => name);
  return { ready: blockers.length === 0, phase, ageMs, blockers, checks };
}
