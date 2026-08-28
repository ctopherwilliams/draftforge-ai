import {
  evaluateDraftAuditSnapshot,
  isDraftAuditSnapshot,
  type DraftAuditRosterEntry,
  type DraftAuditSnapshot,
} from "./draft-audit.ts";
import { draftAuditPublisherBindingKey } from "./draft-audit-publisher.ts";

export const LIVE_CONTROL_RECOVERY_MAX_AGE_MS = 30_000;
const LIVE_CONTROL_RECOVERY_FUTURE_SKEW_MS = 2_000;

export type LiveControlRecoveryIdentity = {
  leagueId: string;
  teamId: number;
  season: number;
  draftType?: "SNAKE" | "AUCTION";
};

export type LiveControlRecoveryCandidate = {
  snapshot: DraftAuditSnapshot;
  commandCenterSessionId: string;
  commandCenterStartedAt: string;
  irreversibleHistory: boolean;
  expiresAtMs: number;
};

export type LiveControlRecoveryRules = Pick<
  DraftAuditSnapshot["league"],
  | "size"
  | "rosterSize"
  | "auctionBudget"
  | "secondsPerPick"
  | "scoringLabel"
  | "scoringRules"
  | "keeperCount"
  | "lineupSlotCounts"
  | "positionLimits"
>;

export type LiveControlRecoveryResult =
  | { ok: true; code: "LIVE_CONTROL_RECOVERY_ADOPTABLE"; candidate: LiveControlRecoveryCandidate }
  | { ok: false; code: string };

export type LiveControlRecoveryImport = LiveControlRecoveryIdentity & {
  draftType: "SNAKE" | "AUCTION";
  tabId: number;
  inDraftRoom: boolean;
  autopickActive: boolean | undefined;
  roster: Array<Pick<DraftAuditRosterEntry, "playerId" | "amount">>;
  rules: LiveControlRecoveryRules;
};

export function hasIrreversibleLiveControlHistory(control: DraftAuditSnapshot["liveControl"]) {
  if (!control) return false;
  return control.pendingActionCount > 0
    || control.decision !== null
    || control.rosterAttributions.length > 0
    || control.unattributedRosterCount > 0
    || control.historicalAutopickDetected
    || control.uncontrolledRosterAdditionDetected
    || control.events.some((event) => event.kind === "ACTION_LIFECYCLE" || event.kind === "ROSTER_ATTRIBUTION");
}

function exactRecoveryTarget(identity: LiveControlRecoveryIdentity) {
  return Boolean(
    /^\d+$/.test(String(identity.leagueId || ""))
    && Number.isSafeInteger(identity.teamId)
    && identity.teamId > 0
    && Number.isSafeInteger(identity.season)
    && identity.season >= 2026
    && (identity.draftType === undefined || ["SNAKE", "AUCTION"].includes(identity.draftType)),
  );
}

function exactRoster(
  left: Array<Pick<DraftAuditRosterEntry, "playerId" | "amount">>,
  right: Array<Pick<DraftAuditRosterEntry, "playerId" | "amount">>,
) {
  const rosterKey = (entry: Pick<DraftAuditRosterEntry, "playerId" | "amount">) => `${entry.playerId}:${entry.amount}`;
  const valid = (entry: Pick<DraftAuditRosterEntry, "playerId" | "amount">) => (
    Number.isSafeInteger(entry.playerId)
    && entry.playerId !== 0
    && Number.isSafeInteger(entry.amount)
    && entry.amount >= 0
  );
  if (!left.every(valid) || !right.every(valid)) return false;
  const leftIds = left.map((entry) => entry.playerId);
  const rightIds = right.map((entry) => entry.playerId);
  if (new Set(leftIds).size !== leftIds.length || new Set(rightIds).size !== rightIds.length) return false;
  const normalizedLeft = left.map(rosterKey).sort();
  const normalizedRight = right.map(rosterKey).sort();
  return normalizedLeft.length === normalizedRight.length
    && normalizedLeft.every((entry, index) => entry === normalizedRight[index]);
}

function exactNumberRecord(left: Record<string, number>, right: Record<string, number>) {
  if (!left || !right || typeof left !== "object" || typeof right !== "object") return false;
  const leftEntries = Object.entries(left).sort(([leftKey], [rightKey]) => leftKey.localeCompare(rightKey));
  const rightEntries = Object.entries(right).sort(([leftKey], [rightKey]) => leftKey.localeCompare(rightKey));
  return leftEntries.length === rightEntries.length
    && leftEntries.every(([key, value], index) => (
      key === rightEntries[index]?.[0]
      && Number.isFinite(value)
      && value === rightEntries[index]?.[1]
    ));
}

function exactRules(left: LiveControlRecoveryRules, right: LiveControlRecoveryRules) {
  return Number.isSafeInteger(right?.size)
    && right.size === left.size
    && Number.isSafeInteger(right.rosterSize)
    && right.rosterSize === left.rosterSize
    && Number.isSafeInteger(right.auctionBudget)
    && right.auctionBudget === left.auctionBudget
    && Number.isSafeInteger(right.secondsPerPick)
    && right.secondsPerPick === left.secondsPerPick
    && right.scoringLabel === left.scoringLabel
    && Number.isSafeInteger(right.scoringRules)
    && right.scoringRules === left.scoringRules
    && Number.isSafeInteger(right.keeperCount)
    && right.keeperCount === left.keeperCount
    && exactNumberRecord(left.lineupSlotCounts, right.lineupSlotCounts)
    && exactNumberRecord(left.positionLimits, right.positionLimits);
}

function exactAttributedRoster(snapshot: DraftAuditSnapshot) {
  const control = snapshot.liveControl;
  if (!control || control.unattributedRosterCount !== 0) return false;
  const rosterIds = snapshot.draft.appRoster.map((entry) => entry.playerId).sort((left, right) => left - right);
  const attributedIds = control.rosterAttributions.map((entry) => entry.player.playerId).sort((left, right) => left - right);
  return rosterIds.length === attributedIds.length
    && rosterIds.every((playerId, index) => playerId === attributedIds[index]);
}

/**
 * Validate the exact append-only audit that a reloaded command center proposes
 * to adopt. This function deliberately accepts no browser state; the caller
 * must perform a second authenticated-import validation before restoring it.
 */
export function validateLiveControlRecoveryCandidate(input: {
  snapshot: unknown;
  reportedParity: unknown;
  expected: LiveControlRecoveryIdentity;
  nowMs?: number;
  maxAgeMs?: number;
}): LiveControlRecoveryResult {
  if (!exactRecoveryTarget(input.expected)) return { ok: false, code: "LIVE_CONTROL_RECOVERY_TARGET_INVALID" };
  if (!isDraftAuditSnapshot(input.snapshot)) return { ok: false, code: "LIVE_CONTROL_RECOVERY_AUDIT_INVALID" };
  const snapshot = input.snapshot;
  if (snapshot.league.id !== input.expected.leagueId
    || snapshot.league.teamId !== input.expected.teamId
    || snapshot.league.season !== input.expected.season
    || (input.expected.draftType !== undefined && snapshot.league.draftType !== input.expected.draftType)) {
    return { ok: false, code: "LIVE_CONTROL_RECOVERY_IDENTITY_MISMATCH" };
  }
  if (input.reportedParity !== true || evaluateDraftAuditSnapshot(snapshot).parity !== true) {
    return { ok: false, code: "LIVE_CONTROL_RECOVERY_ROSTER_PARITY_REQUIRED" };
  }
  const nowMs = input.nowMs ?? Date.now();
  const maxAgeMs = input.maxAgeMs ?? LIVE_CONTROL_RECOVERY_MAX_AGE_MS;
  const capturedAtMs = Date.parse(snapshot.capturedAt);
  if (!Number.isFinite(nowMs) || !Number.isFinite(maxAgeMs) || maxAgeMs <= 0
    || capturedAtMs > nowMs + LIVE_CONTROL_RECOVERY_FUTURE_SKEW_MS
    || nowMs - capturedAtMs > maxAgeMs) {
    return { ok: false, code: "LIVE_CONTROL_RECOVERY_AUDIT_STALE" };
  }
  const control = snapshot.liveControl;
  const commandCenterSessionId = String(snapshot.binding.commandCenterSessionId || "");
  const commandCenterStartedAt = String(snapshot.binding.commandCenterStartedAt || "");
  if (!control || !commandCenterSessionId || !Number.isFinite(Date.parse(commandCenterStartedAt))
    || !draftAuditPublisherBindingKey({
      commandCenterSessionId,
      liveControlSessionId: control.sessionId,
      leagueId: snapshot.league.id,
      teamId: snapshot.league.teamId,
      tabId: snapshot.binding.tabId,
    })) {
    return { ok: false, code: "LIVE_CONTROL_RECOVERY_PUBLISHER_INVALID" };
  }
  if (snapshot.safety.inDraftRoom !== true || snapshot.safety.autopickActive !== false) {
    return { ok: false, code: "LIVE_CONTROL_RECOVERY_SAFETY_STATE_INVALID" };
  }
  if (control.pendingActionCount !== 0 || control.decision !== null) {
    return { ok: false, code: "LIVE_CONTROL_RECOVERY_ACTION_PENDING" };
  }
  if (control.historicalAutopickDetected
    || control.uncontrolledRosterAdditionDetected
    || control.rosterAttributions.some((entry) => ["ESPN_AUTOPICK", "UNKNOWN_EXTERNAL"].includes(entry.attribution))) {
    return { ok: false, code: "LIVE_CONTROL_RECOVERY_INCIDENT_PRESENT" };
  }
  if (!exactAttributedRoster(snapshot)) {
    return { ok: false, code: "LIVE_CONTROL_RECOVERY_ATTRIBUTION_MISMATCH" };
  }
  return {
    ok: true,
    code: "LIVE_CONTROL_RECOVERY_ADOPTABLE",
    candidate: {
      snapshot,
      commandCenterSessionId,
      commandCenterStartedAt,
      irreversibleHistory: hasIrreversibleLiveControlHistory(control),
      expiresAtMs: capturedAtMs + maxAgeMs,
    },
  };
}

/**
 * Bind a validated audit to the fresh authenticated ESPN import. No partial
 * match is recoverable: a changed tab, ruleset, roster, salary, or Autopick
 * state leaves the old publisher untouched and the dashboard fail closed.
 */
export function validateLiveControlRecoveryImport(
  candidate: LiveControlRecoveryCandidate,
  observed: LiveControlRecoveryImport,
  nowMs = Date.now(),
): { ok: true; code: "LIVE_CONTROL_RECOVERY_IMPORT_VERIFIED" } | { ok: false; code: string } {
  const snapshot = candidate.snapshot;
  if (!Number.isFinite(nowMs) || nowMs > candidate.expiresAtMs) {
    return { ok: false, code: "LIVE_CONTROL_RECOVERY_AUDIT_STALE" };
  }
  if (!exactRecoveryTarget(observed)
    || snapshot.league.id !== observed.leagueId
    || snapshot.league.teamId !== observed.teamId
    || snapshot.league.season !== observed.season
    || snapshot.league.draftType !== observed.draftType
    || snapshot.binding.tabId !== observed.tabId
    || observed.inDraftRoom !== true) {
    return { ok: false, code: "LIVE_CONTROL_RECOVERY_IMPORT_IDENTITY_MISMATCH" };
  }
  if (observed.autopickActive !== false) {
    return { ok: false, code: "LIVE_CONTROL_RECOVERY_AUTOPICK_NOT_OFF" };
  }
  if (!exactRules(snapshot.league, observed.rules)) {
    return { ok: false, code: "LIVE_CONTROL_RECOVERY_RULES_CHANGED" };
  }
  if (!exactRoster(snapshot.draft.appRoster, observed.roster)) {
    return { ok: false, code: "LIVE_CONTROL_RECOVERY_ROSTER_CHANGED" };
  }
  return { ok: true, code: "LIVE_CONTROL_RECOVERY_IMPORT_VERIFIED" };
}
