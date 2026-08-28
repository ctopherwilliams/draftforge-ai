"use client";

import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import {
  auctionBudgetUsage,
  describeRecommendation,
  buildDraftDecision,
  buildPlayerPoolIndex,
  chooseAuctionNomination,
  type DraftPick,
  type DraftPlayer,
  type LeagueSettings,
  type Recommendation,
  type StrategyId,
} from "./lib/draft-engine";
import {
  isCompleteFreshIntelligenceSnapshot,
  isIntelligenceSourceFresh,
  intelligenceQuarterbackMode,
  intelligenceSnapshotCacheKey,
  mergeConsensus,
  type IntelligenceSource,
} from "./lib/consensus";
import {
  authenticatedEspnCaptureDigest,
  buildAuthenticatedEspnCaptureAttestation,
  buildAuthenticatedEspnCaptureProfile,
  sanitizeAuthenticatedEspnLeague,
  sanitizeAuthenticatedEspnPlayers,
} from "./lib/authenticated-espn-capture";
import { contextCanRebindDraftTab, contextMatchesActiveDraftTab } from "./lib/espn-context";
import { resolveEspnNominatedPlayer, resolveLiveBoardDisplayRank, resolveOwnNominationIntent, stabilizeEspnContext, type EspnContext } from "./lib/espn-context-state";
import { canArmAutoDraft } from "./lib/auto-draft-safety";
import { liveEspnRecommendations, reconcileEspnPicks, resolveAuctionSales, resolveOwnRoster } from "./lib/espn-reconciliation";
import { draftUiReducer, INITIAL_DRAFT_UI_STATE } from "./lib/draft-ui-state";
import { buildDraftPresentation, resolveActionSurfaceStatus, resolveLiveOperatorStatus } from "./lib/draft-presentation";
import {
  buildDraftLeagueBoardSnapshot,
  draftAuditChecklistBindingKey,
  isCanonicalDraftAuditUtcTimestamp,
  isDraftAuditSourceSnapshotId,
  MAX_DRAFT_ACTION_TELEMETRY_EVENTS,
  MAX_DRAFT_AUDIT_SOURCE_SNAPSHOT_AGE_MS,
  resolveDraftAuditChecklistReady,
  type DraftActionTelemetryEvent,
  type DraftAuditRosterEntry,
  type DraftAuditSnapshot,
  type DraftOperatorPlayer,
  type DraftOperatorPosition,
  type DraftOperatorSnapshot,
  type DraftRuntimeDiagnostics,
} from "./lib/draft-audit";
import {
  createDraftAuditPublisher,
  draftAuditPublicationDigest,
  type DraftAuditPublishResult,
  type DraftAuditPublisher,
  type DraftAuditPublisherBinding,
  type DraftAuditRecordedPublication,
} from "./lib/draft-audit-publisher";
import { compactDraftProfiles, persistDraftProfiles, upsertDraftProfile, type DraftProfile } from "./lib/profiles";
import {
  buildSalaryCapEvidence,
  observeSalaryCapDecision,
  type SalaryCapDecisionObservation,
} from "./lib/salary-cap-evidence";
import { mergeAuthenticatedSleeperEvidence } from "./lib/sleeper-evidence";
import {
  canRetryPracticeRoomCleanup,
  MAX_AUTOMATIC_PRACTICE_CLEANUP_ATTEMPTS,
  resolvePracticeRoomCleanupRequest,
} from "./lib/practice-room-cleanup";
import {
  appendLiveControlEvent,
  createLiveControlState,
  deterministicSnakeSubmitSecondsRemaining,
  preserveLiveControlForVerifiedRebound,
  validateLiveControlTransition,
  type LiveActionLifecyclePhase,
  type LiveControlEvent,
  type LiveControlFreshness,
  type LiveControlOperation,
  type LiveControlPosition,
  type LiveControlState,
  type LiveDecisionEnvelope,
  type LivePlayerIdentity,
  type LiveRosterAttributionKind,
} from "./lib/live-control";
import {
  validateLiveControlRecoveryCandidate,
  validateLiveControlRecoveryImport,
  type LiveControlRecoveryCandidate,
} from "./lib/live-control-recovery";
import {
  availabilityBoundedActionDeadline,
  createAvailabilityDecisionSnapshot,
  evaluateAvailabilityGate,
  excludeAvailabilityVetoes,
  revalidateAvailabilityDecision,
  type AvailabilityDecisionSnapshot,
  type AvailabilityGateEvaluation,
} from "./lib/availability-veto";
import {
  enforceAvailabilityRosterFeasibility,
  evaluateRosterCompletionFeasibility,
} from "./lib/roster-completion-feasibility";
import {
  authoritativePickFeedHealth,
  buildSnakePlanTiming,
  inferAuctionSaleCountFromBudgets,
  nextPickFeedRuntimeHealth,
  shouldReevaluateSupersededBid,
  snakePlanKey,
  snakePlanReadyToSubmit,
  type AuthoritativePickFeedCursor,
  type PickFeedRuntimeHealth,
} from "./lib/live-draft-orchestration";

const DASHBOARD_LOADED_AT = new Date().toISOString();

const DEMO_PLAYERS: DraftPlayer[] = [
  { id: 1, name: "Ja'Marr Chase", team: "CIN", pos: "WR", rank: 1, adp: 1.4, auction: 61, projected: 312 },
  { id: 2, name: "Bijan Robinson", team: "ATL", pos: "RB", rank: 2, adp: 2.1, auction: 59, projected: 298 },
  { id: 3, name: "Jahmyr Gibbs", team: "DET", pos: "RB", rank: 3, adp: 3.2, auction: 57, projected: 291 },
  { id: 4, name: "Justin Jefferson", team: "MIN", pos: "WR", rank: 4, adp: 4.6, auction: 56, projected: 300 },
  { id: 5, name: "CeeDee Lamb", team: "DAL", pos: "WR", rank: 5, adp: 5.1, auction: 54, projected: 294 },
  { id: 6, name: "Puka Nacua", team: "LAR", pos: "WR", rank: 6, adp: 6.8, auction: 51, projected: 286 },
  { id: 7, name: "Saquon Barkley", team: "PHI", pos: "RB", rank: 7, adp: 7.5, auction: 49, projected: 276 },
  { id: 8, name: "Malik Nabers", team: "NYG", pos: "WR", rank: 8, adp: 9.7, auction: 47, projected: 278 },
  { id: 9, name: "Amon-Ra St. Brown", team: "DET", pos: "WR", rank: 9, adp: 8.4, auction: 46, projected: 281 },
  { id: 10, name: "De'Von Achane", team: "MIA", pos: "RB", rank: 10, adp: 11.8, auction: 44, projected: 265 },
  { id: 11, name: "Brock Bowers", team: "LV", pos: "TE", rank: 11, adp: 13.5, auction: 39, projected: 244 },
  { id: 12, name: "Nico Collins", team: "HOU", pos: "WR", rank: 12, adp: 14.9, auction: 38, projected: 260 },
  { id: 13, name: "Josh Allen", team: "BUF", pos: "QB", rank: 13, adp: 20.3, auction: 36, projected: 388 },
  { id: 14, name: "Brian Thomas Jr.", team: "JAX", pos: "WR", rank: 14, adp: 17.1, auction: 35, projected: 252 },
  { id: 15, name: "Jonathan Taylor", team: "IND", pos: "RB", rank: 15, adp: 15.8, auction: 34, projected: 251 },
  { id: 16, name: "Lamar Jackson", team: "BAL", pos: "QB", rank: 16, adp: 23.8, auction: 31, projected: 374 },
  { id: 17, name: "Trey McBride", team: "ARI", pos: "TE", rank: 17, adp: 22.4, auction: 29, projected: 221 },
  { id: 18, name: "Drake London", team: "ATL", pos: "WR", rank: 18, adp: 19.2, auction: 29, projected: 247 },
  { id: 19, name: "Bucky Irving", team: "TB", pos: "RB", rank: 19, adp: 24.7, auction: 27, projected: 238 },
  { id: 20, name: "Jayden Daniels", team: "WAS", pos: "QB", rank: 20, adp: 27.3, auction: 25, projected: 356 },
];

const DEMO_AUCTION_VALUES = new Map(DEMO_PLAYERS.map((player) => [player.id, Number(player.auction || 1)]));

function displayAuctionValue(playerId: number, leagueId: string, calculated: number) {
  // The preview intentionally ships a short 20-player board, not a complete
  // 12-team auction pool. Show its explicit ESPN-style dollar examples rather
  // than the production curve that allocates a full room budget across the
  // complete imported player universe.
  return Math.round(leagueId === "demo" ? DEMO_AUCTION_VALUES.get(playerId) || calculated : calculated);
}

const DEMO_LEAGUE: LeagueSettings = {
  id: "demo", name: "ESPN League Preview", season: 2026, size: 12, teamId: 4, draftType: "SNAKE",
  secondsPerPick: 90, rosterSize: 16, auctionBudget: 200, lineupSlotCounts: { "0": 1, "2": 2, "4": 2, "6": 1, "23": 1, "16": 1, "17": 1, "20": 7 },
  positionLimits: {}, scoringLabel: "PPR", scoringRules: 19, keeperCount: 0, pickOrder: [], teams: [],
};

const DEMO_SALARY_LEAGUE: LeagueSettings = {
  ...DEMO_LEAGUE,
  name: "ESPN Salary-Cap Preview",
  draftType: "AUCTION",
};

const FILTERS = ["ALL", "QB", "RB", "WR", "TE", "DST", "K"] as const;
const STRATEGIES: { id: StrategyId; label: string; description: string }[] = [
  { id: "BALANCED", label: "Balanced value", description: "Take the strongest value while filling starters naturally." },
  { id: "HERO_RB", label: "Hero RB", description: "Secure one premium RB, then lean into receivers and value." },
  { id: "ZERO_RB", label: "Zero RB", description: "Prioritize elite receivers and onesie positions early." },
  { id: "ELITE_QB", label: "Elite QB", description: "Raise the value of top dual-threat quarterbacks." },
];

type ExtensionStatus = "checking" | "missing" | "ready" | "connecting" | "connected" | "error";
type WorkspaceRole = "unknown" | "writer" | "observer";

function sendToExtension(type: string, payload: Record<string, unknown> = {}) {
  window.postMessage({ source: "draftforge-web", type, payload }, window.location.origin);
}

function requestExtensionCommand(
  type: string,
  payload: Record<string, unknown>,
  timeoutMs = 1_250,
): Promise<Record<string, unknown>> {
  const transitionRequestId = String(payload.transitionRequestId || globalThis.crypto?.randomUUID?.()
    || `${Date.now()}-${Math.random().toString(36).slice(2)}`);
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result: Record<string, unknown>) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timeout);
      window.removeEventListener("message", onMessage);
      resolve(result);
    };
    const onMessage = (event: MessageEvent) => {
      if (event.source !== window
        || event.origin !== window.location.origin
        || event.data?.source !== "draftforge-extension"
        || event.data?.type !== "COMMAND_RESULT"
        || event.data?.payload?.commandType !== type
        || String(event.data?.payload?.transitionRequestId || "") !== transitionRequestId) return;
      finish(event.data.payload as Record<string, unknown>);
    };
    const timeout = window.setTimeout(() => finish({
      ok: false,
      code: "ACTION_BINDING_REVOCATION_ACK_TIMEOUT",
      transitionRequestId,
    }), timeoutMs);
    window.addEventListener("message", onMessage);
    sendToExtension(type, { ...payload, transitionRequestId });
  });
}

function rosterSlots(league: LeagueSettings) {
  const labels: Record<string, string> = { "0": "QB", "2": "RB", "3": "RB/WR", "4": "WR", "5": "WR/TE", "6": "TE", "7": "OP", "16": "DST", "17": "K", "20": "BN", "21": "IR", "23": "FLEX" };
  const slots = Object.entries(league.lineupSlotCounts || {}).flatMap(([slot, count]) => slot === "21"
    ? []
    : Array.from({ length: Number(count) }, () => labels[slot] || `S${slot}`));
  // ESPN does not guarantee lineup-slot key order and often returns bench
  // before FLEX. Assign every starter before bench so the displayed lineup
  // agrees with the engine's starter/flex deficit calculation.
  return [...slots.filter((slot) => slot !== "BN"), ...slots.filter((slot) => slot === "BN")];
}

function actualPicks(picks: DraftPick[] | undefined) {
  return (picks || []).filter((pick) => ![0, -1].includes(Number(pick.playerId)) && Number(pick.teamId) > 0);
}

function mergeDraftPicks(current: DraftPick[], incoming: DraftPick[]) {
  const merged = new Map(current.map((pick) => [pick.playerId, pick]));
  for (const pick of incoming) merged.set(pick.playerId, { ...merged.get(pick.playerId), ...pick });
  return [...merged.values()].sort((a, b) => a.overall - b.overall);
}

function normalizeName(value: string | null | undefined) {
  return String(value || "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

const ESPN_ROSTER_CONFIRMATION_GRACE_MS = 6000;
// Refresh shortly after the producer cache turns over. Correctness does not
// depend on this cadence: accepted dashboard snapshots are leased by exact
// cryptographic identity for audit-first doctor rechecks.
const INTELLIGENCE_REFRESH_MS = 4 * 60 * 1000 + 15 * 1000;
const INTELLIGENCE_REFRESH_TIMEOUT_MS = 45 * 1000;
const INTELLIGENCE_SOURCE_FUTURE_SKEW_MS = 5_000;
const AVAILABILITY_REFRESH_MS = 5 * 60 * 1000;
const AVAILABILITY_STAGE_PATH = "/api/availability";
const ACTION_CANDIDATE_LIMIT = 64;
const EXACT_TAB_WATCHDOG_MS = 5000;
const MIN_SNAKE_SELECTION_WINDOW_SECONDS = 10;
const MIN_OTHER_ACTION_WINDOW_SECONDS = 5;
const SNAKE_ACTION_RESPONSE_BUDGET_MS = 6_000;
// One keyed ESPN poll may legally consume the 1.8s cadence, 1.2s coordinator
// budget, and scheduling jitter. Actions still fail closed while unhealthy,
// but normal poll timing must not permanently cancel operator intent.
const PICK_FEED_HEALTH_WINDOW_MS = 4_000;
const COMMAND_CENTER_PUBLISHER = {
  sessionId: globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`,
  startedAt: new Date().toISOString(),
};
// Keep action request ids unique across a dashboard-only reload while the ESPN
// content script (and its idempotency cache) remains alive.
const COMMAND_CENTER_ACTION_ID_BASE = Date.now() * 1_000;
const RETRIABLE_SELECT_CODES = new Set(["PLAYER_NOT_FOUND"]);
const RETRIABLE_TURN_CODES = new Set(["ACTION_NOT_FOUND", "PLAYER_CONTROL_DRIFT", "PLAYER_POOL_STALE", "PICK_CHANGED", "NOT_ON_CLOCK", "CLOCK_TOO_SHORT", "BID_CHANGED", "BID_OUT_OF_SEQUENCE"]);
const RETRIABLE_BID_CODES = new Set([
  ...RETRIABLE_TURN_CODES,
  "ACTION_TIMEOUT",
  "NOMINEE_MISMATCH",
  "NOMINEE_UNKNOWN",
  "AUCTION_TRANSACTION_UNKNOWN",
  "AUCTION_TRANSACTION_AMBIGUOUS",
  "AUCTION_SETTLEMENT_PENDING",
]);
const RETRIABLE_NOMINATION_CODES = new Set(["NOT_ON_CLOCK", "CLOCK_TOO_SHORT", "NOMINATION_ACTIVE"]);

type AcceptedIntelligenceSnapshot = Readonly<{
  profileKey: string;
  sources: IntelligenceSource[];
  sourceSnapshotId: string;
  sourceSnapshotGeneratedAt: string;
}>;

const EMPTY_INTELLIGENCE_SOURCES: IntelligenceSource[] = [];
const EXPECTED_INTELLIGENCE_WEIGHTS = Object.freeze({
  espn: .30,
  gng: .20,
  tradyr: .20,
  ffc: .15,
  mfl: .15,
});

function acceptedIntelligenceSnapshotFresh(
  snapshot: AcceptedIntelligenceSnapshot | null,
  evaluatedAt = Date.now(),
  expectedProfileKey?: string,
) {
  if (!snapshot
    || (expectedProfileKey !== undefined && snapshot.profileKey !== expectedProfileKey)
    || !isDraftAuditSourceSnapshotId(snapshot.sourceSnapshotId)
    || !isCanonicalDraftAuditUtcTimestamp(snapshot.sourceSnapshotGeneratedAt)) return false;
  const ageMs = new Date(evaluatedAt).getTime() - Date.parse(snapshot.sourceSnapshotGeneratedAt);
  return Number.isFinite(ageMs)
    && ageMs >= -INTELLIGENCE_SOURCE_FUTURE_SKEW_MS
    && ageMs <= MAX_DRAFT_AUDIT_SOURCE_SNAPSHOT_AGE_MS
    && isCompleteFreshIntelligenceSnapshot(snapshot.sources, evaluatedAt);
}

function acceptIntelligenceResponse(
  value: unknown,
  expected: { scoring: string; teams: number; season: number; qbs: 1 | 2 },
  evaluatedAt = Date.now(),
): AcceptedIntelligenceSnapshot | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const response = value as Record<string, unknown>;
  const methodology = response.methodology as { weights?: Record<string, unknown>; method?: unknown } | undefined;
  const sources = Array.isArray(response.sources) ? response.sources as IntelligenceSource[] : [];
  if (response.scoring !== expected.scoring
    || response.teams !== expected.teams
    || response.season !== expected.season
    || response.qbs !== expected.qbs
    || !isDraftAuditSourceSnapshotId(response.sourceSnapshotId)
    || !isCanonicalDraftAuditUtcTimestamp(response.generatedAt)
    || !methodology?.weights
    || methodology.method !== "freshness-gated weighted percentile consensus"
    || Object.keys(methodology.weights).length !== Object.keys(EXPECTED_INTELLIGENCE_WEIGHTS).length
    || Object.entries(EXPECTED_INTELLIGENCE_WEIGHTS).some(([id, weight]) => methodology.weights?.[id] !== weight)
    || !sources.every((source) => Boolean(source)
      && typeof source === "object"
      && Array.isArray(source.players)
      && EXPECTED_INTELLIGENCE_WEIGHTS[source.id] === source.weight)) return null;
  const candidate: AcceptedIntelligenceSnapshot = {
    profileKey: intelligenceSnapshotCacheKey(expected.scoring, expected.teams, expected.season, expected.qbs),
    sources,
    sourceSnapshotId: response.sourceSnapshotId,
    sourceSnapshotGeneratedAt: response.generatedAt,
  };
  return acceptedIntelligenceSnapshotFresh(candidate, evaluatedAt) ? candidate : null;
}

function acceptDraftDayWarmResponse(
  value: unknown,
  expected: { scoring: string; teams: number; season: number; qbs: 1 | 2 },
  evaluatedAt = Date.now(),
) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const response = value as Record<string, unknown>;
  const sourceIds = Array.isArray(response.sourceIds) ? response.sourceIds : [];
  const profile = response.profile as Record<string, unknown> | undefined;
  const sourceSnapshot = response.sourceSnapshot as Record<string, unknown> | undefined;
  if (response.ok !== true
    || response.code !== "FIVE_SOURCE_READY"
    || response.sourceCoverage !== 5
    || sourceIds.length !== 5
    || new Set(sourceIds).size !== 5
    || !["espn", "ffc", "mfl", "tradyr", "gng"].every((id) => sourceIds.includes(id))
    || profile?.scoring !== expected.scoring
    || profile?.teams !== expected.teams
    || profile?.season !== expected.season
    || profile?.qbs !== expected.qbs
    || !sourceSnapshot
    || response.sourceSnapshotId !== sourceSnapshot.sourceSnapshotId
    || response.sourceGeneratedAt !== sourceSnapshot.generatedAt) return null;
  return acceptIntelligenceResponse(sourceSnapshot, expected, evaluatedAt);
}

function newestAcceptedIntelligenceSnapshot(
  current: AcceptedIntelligenceSnapshot | null,
  incoming: AcceptedIntelligenceSnapshot,
  evaluatedAt = Date.now(),
): AcceptedIntelligenceSnapshot {
  if (!current || !acceptedIntelligenceSnapshotFresh(current, evaluatedAt)) return incoming;
  if (current.profileKey !== incoming.profileKey) return incoming;
  const currentGeneratedAt = Date.parse(current.sourceSnapshotGeneratedAt);
  const incomingGeneratedAt = Date.parse(incoming.sourceSnapshotGeneratedAt);
  if (incomingGeneratedAt < currentGeneratedAt) return current;
  if (incomingGeneratedAt === currentGeneratedAt && incoming.sourceSnapshotId !== current.sourceSnapshotId) return current;
  return incoming.sourceSnapshotId === current.sourceSnapshotId ? current : incoming;
}

type PendingLiveAction = {
  actionId: string;
  decisionId: string;
  operation: LiveControlOperation;
  intendedPlayer: LivePlayerIdentity;
  resolvedPlayer?: LivePlayerIdentity;
  intendedOffer?: number;
  resolvedOffer?: number;
  phase: LiveActionLifecyclePhase;
};

type StagedSnakeDecision = {
  key: string;
  actionRequestId: number;
  action: PendingLiveAction;
  decision: LiveDecisionEnvelope & {
    expectedPick: number;
    submitNotBeforeAt: string;
    submitTargetSeconds: number;
    notAfter: number;
  };
  availabilityDecision: AvailabilityDecisionSnapshot;
};

type LiveControlTransitionOptions = {
  decision?: LiveDecisionEnvelope;
  freshness?: Partial<LiveControlFreshness>;
  unattributedRosterCount?: number;
};

function draftAuditPublisherBinding(
  control: LiveControlState | null,
  leagueId: string,
  teamId: number,
  tabId: number | null,
): DraftAuditPublisherBinding | null {
  if (!control
    || !leagueId
    || !Number.isSafeInteger(teamId)
    || teamId <= 0
    || !Number.isSafeInteger(tabId)
    || Number(tabId) <= 0) return null;
  return {
    commandCenterSessionId: COMMAND_CENTER_PUBLISHER.sessionId,
    liveControlSessionId: control.sessionId,
    leagueId,
    teamId,
    tabId: Number(tabId),
  };
}

function mergeLiveControlFreshness(
  current: LiveControlFreshness,
  patch: Partial<LiveControlFreshness>,
  allowEqualTimestamp: boolean,
) {
  const next = { ...current };
  let changed = false;
  if (typeof patch.pickFeedLagging === "boolean" && patch.pickFeedLagging !== current.pickFeedLagging) {
    next.pickFeedLagging = patch.pickFeedLagging;
    changed = true;
  }
  const timestampKeys: Array<Exclude<keyof LiveControlFreshness, "pickFeedLagging">> = [
    "espnContextAt",
    "pickFeedAt",
    "pickFeedObservedAt",
    "sourceSnapshotAt",
    "lastActionAt",
  ];
  for (const key of timestampKeys) {
    const value = patch[key];
    if (!value) continue;
    const existing = current[key];
    if (!existing || (allowEqualTimestamp ? Date.parse(value) >= Date.parse(existing) : Date.parse(value) > Date.parse(existing))) {
      next[key] = value;
      changed ||= value !== existing;
    }
  }
  return { freshness: next, changed };
}

type UnsequencedLiveControlEvent = LiveControlEvent extends infer Event
  ? Event extends LiveControlEvent ? Omit<Event, "sequence"> : never
  : never;

function livePlayerIdentity(player: Pick<DraftPlayer, "id" | "name" | "pos">): LivePlayerIdentity {
  const position = ["QB", "RB", "WR", "TE", "DST", "K"].includes(player.pos)
    ? player.pos as LiveControlPosition
    : undefined;
  return {
    playerId: player.id,
    playerName: player.name,
    ...(position ? { position } : {}),
  };
}

function draftOperatorPlayerIdentity(
  player: Pick<DraftPlayer, "id" | "name" | "pos" | "team">,
): DraftOperatorPlayer {
  const position = ["QB", "RB", "WR", "TE", "DST", "K"].includes(player.pos)
    ? player.pos as DraftOperatorPlayer["position"]
    : undefined;
  const team = String(player.team || "").trim().slice(0, 8);
  return {
    playerId: player.id,
    playerName: player.name,
    ...(position ? { position } : {}),
    ...(/^[A-Za-z0-9.]{1,8}$/.test(team) ? { team } : {}),
  };
}

function buildDraftOperatorSnapshot(input: {
  control: LiveControlState | null;
  playerById: Map<number, DraftPlayer>;
  draftType: LeagueSettings["draftType"];
  rosterComplete: boolean;
  currentRound: number | null;
  currentPick: number;
  onClock: boolean;
  remainingSeconds: number;
  nominee?: Recommendation;
  currentBid?: number;
  contextMaxLegalBid?: number;
  leadingBid?: boolean;
  focusPlayer?: Recommendation;
  nominatedAvailabilityVetoed: boolean;
  ownNominationIntent: "TARGET" | "DRAIN" | null;
  nextBid: number;
  nominationOpeningBid?: number;
  remainingBudget: number;
  openRosterSlots: string[];
  recommendations: Recommendation[];
}): DraftOperatorSnapshot {
  const boundedMoney = (value: unknown) => Math.min(1_000_000, Math.max(0, Math.trunc(Number(value || 0))));
  const exactMaxLegalBid = (strategyCeiling: unknown): number | null => {
    const ceiling = boundedMoney(strategyCeiling);
    const roomLimit = input.contextMaxLegalBid;
    return Number.isSafeInteger(roomLimit) && Number(roomLimit) >= 0
      ? Math.min(ceiling, boundedMoney(roomLimit))
      : null;
  };
  const terminalEvent = [...(input.control?.events || [])].reverse().find((event) => (
    event.kind === "ACTION_LIFECYCLE"
    && ["ROSTER_CONFIRMED", "ACTION_COMPLETED", "FAILED", "CANCELLED"].includes(event.phase)
    && Boolean(event.resolvedPlayer || event.intendedPlayer)
  ));
  const activeDecision = input.control?.pendingActionCount && input.control.decision
    ? input.control.decision
    : null;
  const toOperatorPlayer = (identity: LivePlayerIdentity): DraftOperatorPlayer => {
    const hydrated = input.playerById.get(identity.playerId);
    if (hydrated) return draftOperatorPlayerIdentity(hydrated);
    return {
      playerId: identity.playerId,
      playerName: identity.playerName,
      ...(identity.position ? { position: identity.position } : {}),
    };
  };
  const currentPlayer = activeDecision
    ? toOperatorPlayer(activeDecision.resolvedPlayer || activeDecision.intendedPlayer)
    : input.focusPlayer ? draftOperatorPlayerIdentity(input.focusPlayer) : null;
  const previewBidCeiling = input.draftType === "AUCTION" && input.nominee
    ? exactMaxLegalBid(input.focusPlayer?.maxBid || 0)
    : null;
  const recommendationAction: "SELECT" | "BID" | "NOMINATE" | "HOLD" | "PASS" = activeDecision
    ? activeDecision.operation
    : input.draftType === "SNAKE"
      ? "SELECT"
      : input.nominee
        ? input.nominatedAvailabilityVetoed
          || input.ownNominationIntent === "DRAIN"
          || previewBidCeiling === null
          || input.nextBid > previewBidCeiling
          ? "PASS"
          : input.leadingBid === true || input.leadingBid === undefined
            ? "HOLD"
            : "BID"
        : "NOMINATE";
  const recommendationOffer = activeDecision?.intendedOffer !== undefined
    ? boundedMoney(activeDecision.intendedOffer)
    : recommendationAction === "BID"
      ? boundedMoney(input.nextBid)
      : recommendationAction === "NOMINATE"
        ? boundedMoney(input.nominationOpeningBid || 1)
        : null;
  const recommendationCeiling = input.draftType === "AUCTION" && currentPlayer
    ? activeDecision?.maxApprovedBid !== undefined
      ? boundedMoney(activeDecision.maxApprovedBid)
      : input.nominee
        ? previewBidCeiling
        : boundedMoney(input.focusPlayer?.maxBid || 0)
    : null;
  const needCounts = new Map<DraftOperatorPosition, number>();
  for (const slot of input.openRosterSlots) {
    const position: DraftOperatorPosition = slot === "BN"
      ? "DEPTH"
      : slot === "RB/WR" || slot === "WR/TE" || slot === "FLEX"
      ? "FLEX"
      : slot === "OP"
        ? "OP"
        : ["QB", "RB", "WR", "TE", "DST", "K"].includes(slot)
          ? slot as DraftOperatorPosition
          : "DEPTH";
    needCounts.set(position, Number(needCounts.get(position) || 0) + 1);
  }
  const alternatives = input.rosterComplete || !currentPlayer
    ? []
    : input.recommendations
      .filter((player) => player.id !== currentPlayer.playerId)
      .slice(0, 5)
      .map((player) => ({
        player: draftOperatorPlayerIdentity(player),
        maxLegalBid: input.draftType === "AUCTION"
          ? input.nominee ? exactMaxLegalBid(player.maxBid) : boundedMoney(player.maxBid)
          : null,
      }));
  const lastDecision = terminalEvent?.kind === "ACTION_LIFECYCLE"
    ? (() => {
        const player = terminalEvent.resolvedPlayer || terminalEvent.intendedPlayer;
        if (!player) return null;
        return {
          operation: terminalEvent.operation,
          phase: terminalEvent.phase as "ROSTER_CONFIRMED" | "ACTION_COMPLETED" | "FAILED" | "CANCELLED",
          player: toOperatorPlayer(player),
          offer: terminalEvent.resolvedOffer === undefined && terminalEvent.intendedOffer === undefined
            ? null
            : boundedMoney(terminalEvent.resolvedOffer ?? terminalEvent.intendedOffer),
          occurredAt: terminalEvent.occurredAt,
          ...(terminalEvent.code ? { code: terminalEvent.code } : {}),
        };
      })()
    : null;
  return {
    room: {
      round: input.currentRound,
      pick: Number.isInteger(input.currentPick) && input.currentPick > 0 ? Math.min(10_000, input.currentPick) : null,
      onClock: input.onClock,
      secondsRemaining: Number.isFinite(input.remainingSeconds)
        ? Math.min(3_600, Math.max(0, Math.trunc(input.remainingSeconds)))
        : null,
      nominee: input.nominee ? draftOperatorPlayerIdentity(input.nominee) : null,
      currentBid: input.nominee || Number(input.currentBid || 0) > 0 ? boundedMoney(input.currentBid) : null,
      leader: input.nominee
        ? input.leadingBid === true ? "US" : input.leadingBid === false ? "OPPONENT" : "UNKNOWN"
        : null,
      maxLegalBid: input.nominee && input.focusPlayer ? previewBidCeiling : null,
    },
    team: {
      remainingBudget: input.draftType === "AUCTION" ? boundedMoney(input.remainingBudget) : null,
      openRosterSlots: Math.min(64, input.openRosterSlots.length),
      primaryNeeds: [...needCounts.entries()].slice(0, 8).map(([position, count]) => ({ position, count })),
    },
    recommendation: input.rosterComplete || !currentPlayer ? null : {
      state: activeDecision ? "ACTIVE" : "PREVIEW",
      action: recommendationAction,
      player: currentPlayer,
      offer: recommendationOffer,
      maxLegalBid: recommendationCeiling,
    },
    alternatives,
    lastDecision,
  };
}

function safeLiveControlCode(value: unknown, fallback: string) {
  const code = String(value || fallback).trim().toUpperCase().replace(/[^A-Z0-9_]/g, "_").slice(0, 64);
  return code || fallback;
}

function liveControlOccurredAt(state: LiveControlState, candidate = Date.now()) {
  const previous = state.events.at(-1)?.occurredAt;
  return new Date(Math.max(candidate, previous ? Date.parse(previous) : 0)).toISOString();
}

async function fetchAvailabilityGate(
  players: DraftPlayer[],
  actionablePlayerIds: number[],
) {
  const controller = new AbortController();
  // This loopback artifact is prefetched off-clock. Keep the mandatory
  // immediate recheck inside the live-action latency budget; a slow local
  // response is a veto, never a reason to spend the ESPN clock waiting.
  const timeout = window.setTimeout(() => controller.abort(), 300);
  let artifact: unknown = null;
  let policy: unknown = null;
  try {
    const response = await fetch(AVAILABILITY_STAGE_PATH, {
      cache: "no-store",
      signal: controller.signal,
    });
    const staged = await response.json().catch(() => null) as { artifact?: unknown; policy?: unknown } | null;
    if ((response.ok || response.status === 409) && staged?.artifact && staged?.policy) {
      artifact = staged.artifact;
      policy = staged.policy;
    }
  } catch {
    // A missing, slow, malformed, or unreachable local stage is a blocked gate.
  } finally {
    window.clearTimeout(timeout);
  }
  return evaluateAvailabilityGate({
    artifact,
    policy,
    players,
    actionablePlayerIds,
    evaluatedAt: new Date().toISOString(),
  });
}

function normalizeImportedLeague(league: LeagueSettings) {
  const rawSettings = league.rawSettings as { draftSettings?: { type?: unknown; keeperCount?: unknown } } | undefined;
  const draft = rawSettings?.draftSettings;
  const draftType = String(draft?.type || "").trim().toUpperCase() === "AUCTION" || Number(draft?.type) === 2 ? "AUCTION" : league.draftType;
  const keeperCount = Number(draft?.keeperCount);
  return {
    ...league,
    draftType,
    keeperCount: Number.isInteger(keeperCount) && keeperCount >= 0 ? keeperCount : league.keeperCount,
  };
}

export default function Home() {
  const [extension, setExtension] = useState<ExtensionStatus>("checking");
  const [workspaceRole, setWorkspaceRole] = useState<WorkspaceRole>("unknown");
  const [context, setContext] = useState<EspnContext>({});
  const [league, setLeague] = useState<LeagueSettings>(DEMO_LEAGUE);
  const [espnPlayers, setEspnPlayers] = useState<DraftPlayer[]>(DEMO_PLAYERS);
  const [intelligenceSnapshot, setIntelligenceSnapshot] = useState<AcceptedIntelligenceSnapshot | null>(null);
  const [sourceFreshnessEvaluatedAt, setSourceFreshnessEvaluatedAt] = useState(() => Date.now());
  const sources = intelligenceSnapshot?.sources ?? EMPTY_INTELLIGENCE_SOURCES;
  const intelligenceSnapshotsRef = useRef(new Map<string, AcceptedIntelligenceSnapshot>());
  const decisionSourceFreezeRef = useRef(false);
  const deferredIntelligenceSnapshotRef = useRef<AcceptedIntelligenceSnapshot | null>(null);
  const [ui, dispatchUi] = useReducer(draftUiReducer, INITIAL_DRAFT_UI_STATE);
  const { sourcesOpen, intelligenceLoading, settingsOpen, rawSettingsOpen, strategyOpen, autoWarning } = ui;
  const [picks, setPicks] = useState<DraftPick[]>([]);
  const [settingsConfirmed, setSettingsConfirmed] = useState(false);
  const [leagueId, setLeagueId] = useState("");
  const [strategy, setStrategy] = useState<StrategyId>("BALANCED");
  const [autoDraft, setAutoDraftState] = useState(false);
  const [autoArmVerification, setAutoArmVerification] = useState<{ requestId: number; context: EspnContext } | null>(null);
  const [filter, setFilter] = useState<(typeof FILTERS)[number]>("ALL");
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState(1);
  const [actionState, setActionState] = useState("Waiting for ESPN connection.");
  const [profiles, setProfiles] = useState<Record<string, DraftProfile>>({});
  const [rejectedSnakePlayerIds, setRejectedSnakePlayerIds] = useState<number[]>([]);
  const [actionRetryNonce, setActionRetryNonce] = useState(0);
  const [activeEspnTabId, setActiveEspnTabId] = useState<number | null>(null);
  const [authenticatedImportAt, setAuthenticatedImportAt] = useState("");
  const [runtimeDiagnostics, setRuntimeDiagnostics] = useState<DraftRuntimeDiagnostics | null>(null);
  const [auditHeartbeat, setAuditHeartbeat] = useState(0);
  const [auditPublisherVersion, setAuditPublisherVersion] = useState(0);
  const [auditPublisherAuthorized, setAuditPublisherAuthorized] = useState(false);
  const [telemetryVersion, setTelemetryVersion] = useState(0);
  const [liveControlVersion, setLiveControlVersion] = useState(0);
  const [pickFeedHealth, setPickFeedHealthState] = useState<PickFeedRuntimeHealth>({
    observedAt: null,
    lagging: false,
    fresh: false,
  });
  const [actionInFlight, setActionInFlight] = useState(false);
  const [availabilityGate, setAvailabilityGate] = useState<AvailabilityGateEvaluation>(() => evaluateAvailabilityGate({
    artifact: null,
    policy: null,
    players: [],
    evaluatedAt: new Date().toISOString(),
  }));
  const [availabilityStage, setAvailabilityStage] = useState<{
    artifact: unknown;
    policy: unknown;
    stagedAt: string;
  } | null>(null);
  const [availabilityTransportDegraded, setAvailabilityTransportDegraded] = useState(false);
  const [pendingAuctionNomination, setPendingAuctionNomination] = useState<{
    playerId: number;
    playerName: string;
    intent: "TARGET" | "DRAIN";
  } | null>(null);
  const lastAutoAction = useRef("");
  const profilesRef = useRef<Record<string, DraftProfile>>({});
  const espnPlayersRef = useRef<DraftPlayer[]>(DEMO_PLAYERS);
  const activeLeagueSettingsRef = useRef<LeagueSettings>(DEMO_LEAGUE);
  const activeLeagueRef = useRef("demo");
  const activeSourceLeagueRef = useRef("demo");
  const activeEspnTabRef = useRef<number | null>(null);
  const activeEspnTeamRef = useRef<number | null>(null);
  const actionRequestSequenceRef = useRef(COMMAND_CENTER_ACTION_ID_BASE);
  const autoArmRequestSequenceRef = useRef(0);
  const pendingAutoArmRequestRef = useRef<number | null>(null);
  const pendingLiveRoomAutoArmRef = useRef(false);
  const latestActionRequestRef = useRef(0);
  const inFlightActionRef = useRef<{
    actionRequestId: number;
    operation: "SELECT" | "BID" | "NOMINATE";
  } | null>(null);
  const pendingSnakeActionRef = useRef<{
    playerId: number;
    playerName: string;
    expectedPick: number;
    sentAt: number;
    beforeRosterPlayerIds: number[];
    failed?: boolean;
  } | null>(null);
  const pendingAuctionNominationRef = useRef<{
    playerId: number;
    playerName: string;
    intent: "TARGET" | "DRAIN";
  } | null>(null);
  const pendingAuctionBidRef = useRef<{
    actionRequestId: number;
    playerId: number;
    playerName: string;
    beforeRosterPlayerIds: number[];
  } | null>(null);
  const draftAuditPublisherRef = useRef<DraftAuditPublisher<DraftAuditSnapshot> | null>(null);
  const draftAuditPublishingBlockedRef = useRef(false);
  const captureReceiptIssueTokenRef = useRef("");
  const liveControlRef = useRef<LiveControlState | null>(null);
  const liveControlBindingRef = useRef("");
  const liveControlBlockedRef = useRef(false);
  const liveControlSessionSequenceRef = useRef(0);
  const liveControlActionsRef = useRef(new Map<number, PendingLiveAction>());
  const liveControlObservedRosterRef = useRef(new Set<number>());
  const liveControlBaselineRosterRef = useRef(new Set<number>());
  const liveControlSafetyRef = useRef(new Map<string, boolean>());
  const espnContextObservedAtRef = useRef<string | null>(null);
  const pickFeedCursorRef = useRef<AuthoritativePickFeedCursor | null>(null);
  const pickFeedStaleTimerRef = useRef<number | null>(null);
  const pickFeedPausedRef = useRef(false);
  const pickFeedHealthRef = useRef<PickFeedRuntimeHealth>({ observedAt: null, lagging: false, fresh: false });
  const autoDraftRef = useRef(false);
  const actionAuthorizationEpochRef = useRef(0);
  const bindingTransitionOwnerRef = useRef<string | null>(null);
  const processedActionResultsRef = useRef(new Set<string>());
  const espnProducerStatesRef = useRef(new Map<string, {
    producerSessionId: string;
    producerRevision: number;
    capturedAtMs: number;
  }>());
  const latestEspnContextRef = useRef<EspnContext>({});
  const sourceSnapshotObservedAtRef = useRef<string | null>(null);
  const sourceSnapshotIdRef = useRef("sources-unavailable");
  const availabilityGateRef = useRef(availabilityGate);
  const availabilityDecisionFreezeRef = useRef(false);
  const deferredAvailabilityGateRef = useRef<AvailabilityGateEvaluation | null>(null);
  const availabilityDecisionsRef = useRef(new Map<number, AvailabilityDecisionSnapshot>());
  const stagedSnakeDecisionRef = useRef<StagedSnakeDecision | null>(null);
  const actionWatchdogsRef = useRef(new Map<number, number>());
  const finalizedPracticeRoomRef = useRef("");
  const practiceRoomCleanupAttemptRef = useRef({ key: "", attempts: 0 });
  const workspaceRoleRef = useRef<WorkspaceRole>("unknown");
  const actionTelemetryRef = useRef<DraftActionTelemetryEvent[]>([]);
  const pendingActionTelemetryRef = useRef(new Map<number, {
    sentAt: number;
    submittedAt: number | null;
    operation: "SELECT" | "BID" | "NOMINATE";
    clockSeconds: number | null;
    automatic: boolean;
    playerId: number;
    amount: number;
    maxApprovedBid: number;
    nominationIntent: "TARGET" | "DRAIN" | null;
  }>());
  const salaryCapDecisionObservationsRef = useRef(new Map<number, SalaryCapDecisionObservation>());
  const sleeperEvidenceLedgerRef = useRef<{ leagueId: string; candidates: DraftAuditSnapshot["sleeperEvidence"]["candidates"] }>({
    leagueId: "",
    candidates: [],
  });
  const pendingLiveWorkspaceRecoveryRef = useRef<{
    candidate: LiveControlRecoveryCandidate;
    requested: { draftLeagueId: string; sourceLeagueId: string; teamId: number; season: number };
  } | null>(null);
  const completedLiveWorkspaceRecoveryRef = useRef("");
  const lastRosterStatusKeyRef = useRef("");
  const lastValidatedLiveChecklistBindingRef = useRef("");
  const setAutoDraft = useCallback((next: boolean) => {
    // This synchronous epoch is the cancellation authority for async
    // availability/audit work. React state alone can commit after an awaited
    // continuation has resumed, which is too late for a draft-room actuator.
    actionAuthorizationEpochRef.current += 1;
    autoDraftRef.current = next;
    setAutoDraftState(next);
    if (!next && typeof window !== "undefined" && Number.isInteger(activeEspnTabRef.current)) {
      sendToExtension("CANCEL_PENDING_ACTIONS", {
        commandCenterSessionId: COMMAND_CENTER_PUBLISHER.sessionId,
        expectedLeagueId: activeLeagueRef.current,
        expectedTeamId: activeEspnTeamRef.current,
        expectedTabId: activeEspnTabRef.current,
        minimumAuthorizationEpoch: actionAuthorizationEpochRef.current,
      });
    }
  }, []);
  const revokeActiveBindingForTransition = useCallback(async (label: string) => {
    if (bindingTransitionOwnerRef.current) {
      setActionState("League transition is waiting for the exact ESPN actuator to revoke. No draft action can be sent.");
      return null;
    }
    const ownerToken = globalThis.crypto?.randomUUID?.()
      || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    bindingTransitionOwnerRef.current = ownerToken;
    // Revoke the page-local epoch synchronously while the old exact identity
    // is still intact. Clearing any of these refs first would make the cancel
    // target ambiguous and could leave an already-handed-off click alive.
    setAutoDraft(false);
    const expectedTabId = activeEspnTabRef.current;
    const expectedLeagueId = activeLeagueRef.current;
    const expectedTeamId = activeEspnTeamRef.current;
    if (!Number.isInteger(expectedTabId) || !expectedLeagueId || !Number.isInteger(expectedTeamId)) return ownerToken;
    setActionState(`${label}: revoking the exact prior ESPN action binding before changing workspace state.`);
    const result = await requestExtensionCommand("REVOKE_ACTION_BINDING", {
      commandCenterSessionId: COMMAND_CENTER_PUBLISHER.sessionId,
      expectedLeagueId,
      expectedTeamId,
      expectedTabId,
      minimumAuthorizationEpoch: actionAuthorizationEpochRef.current,
    });
    const exactAck = result.ok === true
      && result.code === "ACTION_BINDING_REVOKED"
      && Number(result.revokedTabId) === Number(expectedTabId)
      && String(result.revokedLeagueId || "") === String(expectedLeagueId)
      && Number(result.revokedTeamId) === Number(expectedTeamId)
      && Number(result.minimumAuthorizationEpoch) > actionAuthorizationEpochRef.current;
    if (exactAck) return ownerToken;
    setExtension("error");
    setActionState(`Transition blocked: ${String(result.code || "ACTION_BINDING_REVOCATION_FAILED")}. The existing ESPN identity remains fail closed.`);
    if (bindingTransitionOwnerRef.current === ownerToken) bindingTransitionOwnerRef.current = null;
    return null;
  }, [setAutoDraft]);
  const finishBindingTransition = useCallback((ownerToken: string) => {
    if (bindingTransitionOwnerRef.current === ownerToken) bindingTransitionOwnerRef.current = null;
  }, []);
  const setPickFeedHealth = useCallback((update: PickFeedRuntimeHealth | ((current: PickFeedRuntimeHealth) => PickFeedRuntimeHealth)) => {
    const previous = pickFeedHealthRef.current;
    const next = typeof update === "function" ? update(previous) : update;
    pickFeedHealthRef.current = next;
    if (previous.fresh && !previous.lagging && (!next.fresh || next.lagging)) {
      // Invalidate any action that entered an asynchronous pre-click phase
      // while the authenticated pick/sale feed was healthy.
      actionAuthorizationEpochRef.current += 1;
      if (typeof window !== "undefined" && Number.isInteger(activeEspnTabRef.current)) {
        sendToExtension("CANCEL_PENDING_ACTIONS", {
          commandCenterSessionId: COMMAND_CENTER_PUBLISHER.sessionId,
          expectedLeagueId: activeLeagueRef.current,
          expectedTeamId: activeEspnTeamRef.current,
          expectedTabId: activeEspnTabRef.current,
          minimumAuthorizationEpoch: actionAuthorizationEpochRef.current,
        });
      }
    }
    setPickFeedHealthState(next);
  }, []);
  const acceptLiveProducerContext = useCallback((roomContext: EspnContext | undefined) => {
    if (!roomContext || roomContext.inDraftRoom !== true) return true;
    const producerSessionId = String(roomContext.producerSessionId || "");
    const producerRevision = Number(roomContext.producerRevision);
    const capturedAtMs = Date.parse(String(roomContext.contextCapturedAt || ""));
    if (!producerSessionId || producerSessionId.length > 128
      || !Number.isSafeInteger(producerRevision) || producerRevision <= 0
      || !Number.isFinite(capturedAtMs)) return false;
    const namespace = [roomContext.tabId, roomContext.leagueId, roomContext.teamId, roomContext.season].join(":");
    const previous = espnProducerStatesRef.current.get(namespace);
    if (previous) {
      if (previous.producerSessionId === producerSessionId) {
        if (producerRevision <= previous.producerRevision) return false;
      } else if (capturedAtMs <= previous.capturedAtMs) {
        return false;
      }
    }
    espnProducerStatesRef.current.set(namespace, { producerSessionId, producerRevision, capturedAtMs });
    while (espnProducerStatesRef.current.size > 32) {
      const oldest = espnProducerStatesRef.current.keys().next().value;
      if (oldest === undefined) break;
      espnProducerStatesRef.current.delete(oldest);
    }
    return true;
  }, []);
  const failClosedLiveControl = useCallback((code: string) => {
    liveControlBlockedRef.current = true;
    setAutoDraft(false);
    setActionState(`Action stopped: typed live-control safety rejected ${code}. No further ESPN action will be sent.`);
  }, [setAutoDraft]);
  useEffect(() => {
    const publisher = createDraftAuditPublisher<DraftAuditSnapshot>({
      post: async (publication, signal): Promise<DraftAuditPublishResult> => {
        const response = await fetch("/api/draft-day", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ operation: "AUDIT", audit: publication.snapshot }),
          cache: "no-store",
          signal,
        });
        const payload = await response.json().catch(() => null) as {
          code?: string;
          controlCode?: string;
          recordedPublication?: DraftAuditRecordedPublication | null;
          evaluation?: { finalReady?: boolean; parity?: boolean };
        } | null;
        return {
          ok: response.ok,
          status: response.status,
          code: String(payload?.code || `HTTP_${response.status}`),
          ...(payload?.controlCode ? { controlCode: String(payload.controlCode) } : {}),
          recordedPublication: payload?.recordedPublication ?? null,
          payload,
        };
      },
      onRecorded: (publication, result) => {
        draftAuditPublishingBlockedRef.current = false;
        setAuditPublisherAuthorized(true);
        setAuditPublisherVersion((version) => version + 1);
        const payload = result.payload as {
          captureIssueToken?: string;
          evaluation?: { finalReady?: boolean; parity?: boolean };
        } | null;
        captureReceiptIssueTokenRef.current = /^[a-f0-9]{32}$/.test(String(payload?.captureIssueToken || ""))
          ? String(payload?.captureIssueToken)
          : "";
        const cleanup = resolvePracticeRoomCleanupRequest({
          sourceLeagueId: activeSourceLeagueRef.current,
          snapshot: publication.snapshot,
          evaluation: payload?.evaluation,
          finalizedKey: finalizedPracticeRoomRef.current,
        });
        if (!cleanup) return;
        finalizedPracticeRoomRef.current = cleanup.key;
        const previousAttempt = practiceRoomCleanupAttemptRef.current;
        practiceRoomCleanupAttemptRef.current = {
          key: cleanup.key,
          attempts: previousAttempt.key === cleanup.key ? previousAttempt.attempts + 1 : 1,
        };
        sendToExtension("CLOSE_PRACTICE_ROOM", cleanup.payload);
      },
      onAuthorizationLost: (failure) => {
        captureReceiptIssueTokenRef.current = "";
        setAuditPublisherAuthorized(false);
        setAuditPublisherVersion((version) => version + 1);
        setAutoDraft(false);
        const publisherConflict = [
          "DRAFT_AUDIT_CONTROL_REGRESSION",
          "DRAFT_AUDIT_CONTROL_SESSION_REPLACEMENT",
          "DRAFT_AUDIT_STALE_PUBLISHER",
        ].includes(failure.code);
        if (failure.permanent || publisherConflict) {
          draftAuditPublishingBlockedRef.current = true;
          failClosedLiveControl(failure.controlCode || failure.code);
        }
        setActionState(`Action stopped: the command-center audit publisher lost authorization (${failure.code}). No ESPN action was sent.`);
      },
    });
    draftAuditPublisherRef.current = publisher;
    return () => {
      publisher.clear("COMMAND_CENTER_UNMOUNTED");
      if (draftAuditPublisherRef.current === publisher) draftAuditPublisherRef.current = null;
    };
  }, [failClosedLiveControl, setAutoDraft]);
  const transitionLiveControl = useCallback((
    event: UnsequencedLiveControlEvent,
    options: LiveControlTransitionOptions = {},
  ) => {
    const previous = liveControlRef.current;
    if (!previous || liveControlBlockedRef.current) return false;
    try {
      const { freshness } = mergeLiveControlFreshness(previous.freshness, options.freshness || {}, true);
      const base: LiveControlState = {
        ...previous,
        ...(options.decision ? { decision: options.decision } : {}),
        freshness,
        ...(options.unattributedRosterCount === undefined
          ? {}
          : { unattributedRosterCount: options.unattributedRosterCount }),
      };
      const next = appendLiveControlEvent(base, {
        ...event,
        occurredAt: liveControlOccurredAt(base, Date.parse(event.occurredAt)),
      } as UnsequencedLiveControlEvent);
      const validation = validateLiveControlTransition(previous, next);
      if (!validation.ok) {
        failClosedLiveControl(validation.code);
        return false;
      }
      liveControlRef.current = next;
      setLiveControlVersion((version) => version + 1);
      return true;
    } catch (error) {
      failClosedLiveControl(error instanceof Error ? safeLiveControlCode(error.message, "LIVE_CONTROL_REJECTED") : "LIVE_CONTROL_REJECTED");
      return false;
    }
  }, [failClosedLiveControl]);
  const updateLiveControlFreshness = useCallback((freshnessPatch: Partial<LiveControlFreshness>) => {
    const previous = liveControlRef.current;
    if (!previous || liveControlBlockedRef.current) return false;
    const { freshness, changed } = mergeLiveControlFreshness(previous.freshness, freshnessPatch, false);
    if (!changed) return true;
    const next = { ...previous, freshness };
    const validation = validateLiveControlTransition(previous, next);
    if (!validation.ok) {
      failClosedLiveControl(validation.code);
      return false;
    }
    liveControlRef.current = next;
    setLiveControlVersion((version) => version + 1);
    return true;
  }, [failClosedLiveControl]);
  const clearPublishedLiveDecision = useCallback((decisionId: string) => {
    const previous = liveControlRef.current;
    if (!previous || previous.decision?.decisionId !== decisionId || liveControlBlockedRef.current) return true;
    const next = { ...previous, decision: null };
    const validation = validateLiveControlTransition(previous, next);
    if (!validation.ok) {
      failClosedLiveControl(validation.code);
      return false;
    }
    liveControlRef.current = next;
    setLiveControlVersion((version) => version + 1);
    return true;
  }, [failClosedLiveControl]);
  const cancelStagedSnakeDecision = useCallback((code: string) => {
    const staged = stagedSnakeDecisionRef.current;
    if (!staged) return true;
    const occurredAt = new Date().toISOString();
    const accepted = transitionLiveControl({
      kind: "ACTION_LIFECYCLE",
      occurredAt,
      actionId: staged.action.actionId,
      decisionId: staged.action.decisionId,
      operation: "SELECT",
      phase: "CANCELLED",
      intendedPlayer: staged.action.intendedPlayer,
      code: safeLiveControlCode(code, "SNAKE_PLAN_CANCELLED"),
    }, { freshness: { lastActionAt: occurredAt } });
    if (!accepted) return false;
    staged.action.phase = "CANCELLED";
    stagedSnakeDecisionRef.current = null;
    availabilityDecisionsRef.current.delete(staged.actionRequestId);
    return clearPublishedLiveDecision(staged.decision.decisionId);
  }, [clearPublishedLiveDecision, transitionLiveControl]);
  const initializeLiveControl = useCallback((
    importedLeague: LeagueSettings,
    roomContext: EspnContext,
    importedPlayers: DraftPlayer[],
  ) => {
    const tabId = Number(roomContext.tabId);
    const teamId = Number(roomContext.teamId || importedLeague.teamId);
    const binding = draftAuditChecklistBindingKey(importedLeague.id, teamId, tabId);
    if (roomContext.inDraftRoom !== true || !binding) return false;
    if (liveControlRef.current) {
      if (liveControlBindingRef.current !== binding) {
        failClosedLiveControl("EXACT_BINDING_CHANGED");
        return false;
      }
      const publisherBinding = draftAuditPublisherBinding(liveControlRef.current, importedLeague.id, teamId, tabId);
      if (!publisherBinding) {
        failClosedLiveControl("INVALID_DRAFT_AUDIT_PUBLISHER_BINDING");
        return false;
      }
      if (draftAuditPublisherRef.current?.bind(publisherBinding)) setAuditPublisherAuthorized(false);
      return true;
    }
    const observedAt = new Date().toISOString();
    const baselineRoster = new Set(resolveOwnRoster(roomContext, importedPlayers).map((entry) => entry.playerId));
    const sessionId = `${importedLeague.id}.${teamId}.${tabId}.${COMMAND_CENTER_PUBLISHER.sessionId}.${++liveControlSessionSequenceRef.current}`;
    const initial = createLiveControlState(sessionId.slice(0, 128), {
      espnContextAt: observedAt,
      pickFeedAt: null,
      pickFeedObservedAt: null,
      pickFeedLagging: false,
      sourceSnapshotAt: sourceSnapshotObservedAtRef.current,
    });
    const nextControl = { ...initial, unattributedRosterCount: baselineRoster.size };
    liveControlRef.current = nextControl;
    liveControlBindingRef.current = binding;
    liveControlBlockedRef.current = false;
    liveControlActionsRef.current.clear();
    processedActionResultsRef.current.clear();
    liveControlObservedRosterRef.current = new Set(baselineRoster);
    liveControlBaselineRosterRef.current = baselineRoster;
    liveControlSafetyRef.current.clear();
    draftAuditPublishingBlockedRef.current = false;
    const publisherBinding = draftAuditPublisherBinding(nextControl, importedLeague.id, teamId, tabId);
    if (!publisherBinding) {
      failClosedLiveControl("INVALID_DRAFT_AUDIT_PUBLISHER_BINDING");
      return false;
    }
    if (draftAuditPublisherRef.current?.bind(publisherBinding)) setAuditPublisherAuthorized(false);
    espnContextObservedAtRef.current = observedAt;
    pickFeedCursorRef.current = null;
    if (pickFeedStaleTimerRef.current !== null) window.clearTimeout(pickFeedStaleTimerRef.current);
    pickFeedStaleTimerRef.current = null;
    setPickFeedHealth({ observedAt: null, lagging: false, fresh: false });
    setLiveControlVersion((version) => version + 1);
    return true;
  }, [failClosedLiveControl, setPickFeedHealth]);
  const attributeLiveRosterPlayer = useCallback((
    player: LivePlayerIdentity,
    attribution: LiveRosterAttributionKind,
    action?: PendingLiveAction,
  ) => {
    const control = liveControlRef.current;
    if (!control || control.rosterAttributions.some((entry) => entry.player.playerId === player.playerId)) return true;
    const attributedIds = new Set([...control.rosterAttributions.map((entry) => entry.player.playerId), player.playerId]);
    const rosterIds = new Set([...liveControlObservedRosterRef.current, player.playerId]);
    const unattributedRosterCount = [...rosterIds].filter((playerId) => !attributedIds.has(playerId)).length;
    const accepted = transitionLiveControl({
      kind: "ROSTER_ATTRIBUTION",
      occurredAt: new Date().toISOString(),
      player,
      attribution,
      ...(action ? { actionId: action.actionId, decisionId: action.decisionId } : {}),
    }, { unattributedRosterCount });
    if (accepted) liveControlObservedRosterRef.current.add(player.playerId);
    return accepted;
  }, [transitionLiveControl]);
  const clearLiveControl = useCallback(() => {
    draftAuditPublisherRef.current?.clear("LIVE_CONTROL_CLEARED");
    setAuditPublisherAuthorized(false);
    liveControlRef.current = null;
    liveControlBindingRef.current = "";
    liveControlBlockedRef.current = false;
    liveControlActionsRef.current.clear();
    processedActionResultsRef.current.clear();
    espnProducerStatesRef.current.clear();
    liveControlObservedRosterRef.current.clear();
    liveControlBaselineRosterRef.current.clear();
    liveControlSafetyRef.current.clear();
    draftAuditPublishingBlockedRef.current = false;
    espnContextObservedAtRef.current = null;
    pickFeedCursorRef.current = null;
    if (pickFeedStaleTimerRef.current !== null) window.clearTimeout(pickFeedStaleTimerRef.current);
    pickFeedStaleTimerRef.current = null;
    setPickFeedHealth({ observedAt: null, lagging: false, fresh: false });
    latestEspnContextRef.current = {};
    setActionInFlight(false);
    stagedSnakeDecisionRef.current = null;
    availabilityDecisionsRef.current.clear();
    for (const timeout of actionWatchdogsRef.current.values()) window.clearTimeout(timeout);
    actionWatchdogsRef.current.clear();
    const blockedAvailability = evaluateAvailabilityGate({
      artifact: null,
      policy: null,
      players: [],
      evaluatedAt: new Date().toISOString(),
    });
    availabilityGateRef.current = blockedAvailability;
    availabilityDecisionFreezeRef.current = false;
    decisionSourceFreezeRef.current = false;
    deferredIntelligenceSnapshotRef.current = null;
    deferredAvailabilityGateRef.current = null;
    setAvailabilityGate(blockedAvailability);
    setAvailabilityStage(null);
    setAvailabilityTransportDegraded(false);
    setLiveControlVersion((version) => version + 1);
  }, [setPickFeedHealth]);
  const authoritativeRosterContext = useMemo(() => ({
    inDraftRoom: context.inDraftRoom,
    ownRoster: context.ownRoster,
    snakePicks: context.snakePicks,
  }), [context.inDraftRoom, context.ownRoster, context.snakePicks]);
  // ESPN's visible roster can advance several $1 auctions between API polls.
  // Reconcile it synchronously for every decision instead of waiting for the
  // state-sync effect below to commit on a later render.
  const authoritativePicks = useMemo(
    () => reconcileEspnPicks(picks, authoritativeRosterContext, league.teamId, espnPlayers, league),
    [picks, authoritativeRosterContext, league, espnPlayers],
  );

  async function activateProfile(profile: DraftProfile, roomContext?: EspnContext) {
    const transitionOwner = await revokeActiveBindingForTransition("Switching saved league");
    if (!transitionOwner) return;
    try {
    clearLiveControl();
    activeLeagueRef.current = profile.league.id;
    activeSourceLeagueRef.current = profile.league.id;
    finalizedPracticeRoomRef.current = "";
    practiceRoomCleanupAttemptRef.current = { key: "", attempts: 0 };
    activeLeagueSettingsRef.current = profile.league;
    // A saved profile does not prove which currently-open ESPN tab supplied
    // it. Require a fresh explicit import before it can become actionable.
    activeEspnTabRef.current = null;
    setActiveEspnTabId(null);
    setAuthenticatedImportAt("");
    setRuntimeDiagnostics(null);
    activeEspnTeamRef.current = null;
    latestActionRequestRef.current = ++actionRequestSequenceRef.current;
    inFlightActionRef.current = null;
    pendingSnakeActionRef.current = null;
    pendingAuctionNominationRef.current = null;
    pendingAuctionBidRef.current = null;
    setPendingAuctionNomination(null);
    setRejectedSnakePlayerIds([]);
    pendingActionTelemetryRef.current.clear();
    actionTelemetryRef.current = [];
    salaryCapDecisionObservationsRef.current.clear();
    sleeperEvidenceLedgerRef.current = { leagueId: profile.league.id, candidates: [] };
    setTelemetryVersion((version) => version + 1);
    setLeague(profile.league);
    setEspnPlayers(profile.espnPlayers);
    setPicks(profile.picks);
    setSettingsConfirmed(profile.settingsConfirmed);
    setStrategy(profile.strategy);
    setLeagueId(profile.league.id);
    pendingLiveRoomAutoArmRef.current = false;
    pendingAutoArmRequestRef.current = null;
    setAutoArmVerification(null);
    dispatchUi({ type: "set", key: "autoWarning", value: false });
    // Never carry an on-clock state from a different ESPN tab into this league.
    setContext(roomContext && contextMatchesActiveDraftTab(roomContext, profile.league.id, activeEspnTabRef.current) ? roomContext : {});
    setExtension("connected");
    dispatchUi({ type: "set", key: "settingsOpen", value: !profile.settingsConfirmed });
    setActionState(`${profile.league.name} loaded. Auto-Draft is off.`);
    } finally {
      finishBindingTransition(transitionOwner);
    }
  }

  async function startAnotherLeague() {
    const transitionOwner = await revokeActiveBindingForTransition("Importing another league");
    if (!transitionOwner) return;
    try {
    clearLiveControl();
    activeLeagueRef.current = "demo";
    activeSourceLeagueRef.current = "demo";
    finalizedPracticeRoomRef.current = "";
    practiceRoomCleanupAttemptRef.current = { key: "", attempts: 0 };
    activeLeagueSettingsRef.current = DEMO_LEAGUE;
    activeEspnTabRef.current = null;
    setActiveEspnTabId(null);
    setAuthenticatedImportAt("");
    setRuntimeDiagnostics(null);
    activeEspnTeamRef.current = null;
    latestActionRequestRef.current = ++actionRequestSequenceRef.current;
    inFlightActionRef.current = null;
    pendingSnakeActionRef.current = null;
    pendingAuctionNominationRef.current = null;
    pendingAuctionBidRef.current = null;
    setPendingAuctionNomination(null);
    setRejectedSnakePlayerIds([]);
    pendingActionTelemetryRef.current.clear();
    actionTelemetryRef.current = [];
    salaryCapDecisionObservationsRef.current.clear();
    sleeperEvidenceLedgerRef.current = { leagueId: "demo", candidates: [] };
    setTelemetryVersion((version) => version + 1);
    setLeague(DEMO_LEAGUE);
    setEspnPlayers(DEMO_PLAYERS);
    setPicks([]);
    setLeagueId("");
    setSettingsConfirmed(false);
    pendingLiveRoomAutoArmRef.current = false;
    pendingAutoArmRequestRef.current = null;
    setAutoArmVerification(null);
    dispatchUi({ type: "set", key: "autoWarning", value: false });
    setContext({});
    setExtension("ready");
    dispatchUi({ type: "set", key: "settingsOpen", value: true });
    setActionState("Open the other ESPN league, then import it.");
    } finally {
      finishBindingTransition(transitionOwner);
    }
  }

  async function previewDraftFormat(draftType: "SNAKE" | "AUCTION") {
    const transitionOwner = await revokeActiveBindingForTransition("Opening draft preview");
    if (!transitionOwner) return;
    try {
    clearLiveControl();
    const previewLeague = draftType === "AUCTION" ? DEMO_SALARY_LEAGUE : DEMO_LEAGUE;
    activeLeagueRef.current = previewLeague.id;
    activeSourceLeagueRef.current = previewLeague.id;
    finalizedPracticeRoomRef.current = "";
    practiceRoomCleanupAttemptRef.current = { key: "", attempts: 0 };
    activeLeagueSettingsRef.current = previewLeague;
    activeEspnTabRef.current = null;
    setActiveEspnTabId(null);
    setAuthenticatedImportAt("");
    setRuntimeDiagnostics(null);
    activeEspnTeamRef.current = null;
    latestActionRequestRef.current = ++actionRequestSequenceRef.current;
    pendingSnakeActionRef.current = null;
    pendingAuctionNominationRef.current = null;
    pendingAuctionBidRef.current = null;
    pendingAutoArmRequestRef.current = null;
    setPendingAuctionNomination(null);
    setRejectedSnakePlayerIds([]);
    pendingActionTelemetryRef.current.clear();
    actionTelemetryRef.current = [];
    salaryCapDecisionObservationsRef.current.clear();
    sleeperEvidenceLedgerRef.current = { leagueId: previewLeague.id, candidates: [] };
    setTelemetryVersion((version) => version + 1);
    setAutoArmVerification(null);
    dispatchUi({ type: "set", key: "autoWarning", value: false });
    setLeague(previewLeague);
    setEspnPlayers(DEMO_PLAYERS);
    setPicks([]);
    setSettingsConfirmed(false);
    pendingLiveRoomAutoArmRef.current = false;
    setContext({});
    setExtension("ready");
    dispatchUi({ type: "set", key: "settingsOpen", value: false });
    setActionState(`${draftType === "AUCTION" ? "Salary-cap" : "Snake"} preview only. Import ESPN before any draft action.`);
    } finally {
      finishBindingTransition(transitionOwner);
    }
  }

  useEffect(() => {
    const currentUrl = new URL(window.location.href);
    const reloadCompanion = currentUrl.searchParams.get("reloadCompanion") === "1";
    const recoverLive = currentUrl.searchParams.get("recoverLive") === "1";
    const closePractice = currentUrl.searchParams.get("closePractice") === "1";
    const cleanWorkspace = currentUrl.searchParams.get("cleanWorkspace") === "1";
    const ownedBlankTabIds = (currentUrl.searchParams.get("ownedBlankTabIds") || "")
      .split(",")
      .map(Number)
      .filter(Number.isInteger);
    const recoveryPayload = recoverLive && ["localhost", "127.0.0.1"].includes(currentUrl.hostname)
      ? {
          draftLeagueId: currentUrl.searchParams.get("draftLeagueId") || "",
          sourceLeagueId: currentUrl.searchParams.get("sourceLeagueId") || "",
          teamId: Number(currentUrl.searchParams.get("teamId") || 0),
          season: Number(currentUrl.searchParams.get("season") || 0),
        }
      : null;
    const closePracticePayload = closePractice && ["localhost", "127.0.0.1"].includes(currentUrl.hostname)
      ? {
          draftLeagueId: currentUrl.searchParams.get("draftLeagueId") || "",
          sourceLeagueId: currentUrl.searchParams.get("sourceLeagueId") || "",
          teamId: Number(currentUrl.searchParams.get("teamId") || 0),
          season: Number(currentUrl.searchParams.get("season") || 0),
        }
      : null;
    if (reloadCompanion) {
      currentUrl.searchParams.delete("reloadCompanion");
      window.history.replaceState(null, "", `${currentUrl.pathname}${currentUrl.search}${currentUrl.hash}`);
      sendToExtension("RELOAD_EXTENSION");
    }
    if (recoverLive || closePractice || cleanWorkspace) {
      ["recoverLive", "closePractice", "cleanWorkspace", "ownedBlankTabIds", "draftLeagueId", "sourceLeagueId", "teamId", "season"].forEach((key) => currentUrl.searchParams.delete(key));
      window.history.replaceState(null, "", `${currentUrl.pathname}${currentUrl.search}${currentUrl.hash}`);
    }
    try {
      const saved = compactDraftProfiles(JSON.parse(window.localStorage.getItem("draftforge-leagues-v1") || "{}"));
      profilesRef.current = saved;
      // Local storage is an external system; hydrate the interactive league switcher once it is available.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setProfiles(saved);
    } catch { /* ignore an invalid local draft cache */ }
    const timeout = window.setTimeout(() => setExtension((status) => status === "checking" ? "missing" : status), 1200);
    function observeLiveContext(roomContext: EspnContext | undefined, pickFeedPicks?: DraftPick[]) {
      if (!roomContext || !contextMatchesActiveDraftTab(roomContext, activeLeagueRef.current, activeEspnTabRef.current)) return;
      if (!liveControlRef.current && roomContext.inDraftRoom === true) {
        initializeLiveControl(activeLeagueSettingsRef.current, roomContext, espnPlayersRef.current);
      }
      const observedAt = new Date().toISOString();
      latestEspnContextRef.current = roomContext;
      espnContextObservedAtRef.current = observedAt;
      let feedFreshness: Partial<LiveControlFreshness> = {};
      if (pickFeedPicks) {
        const liveLeague = activeLeagueSettingsRef.current;
        const budgetInferredSaleCount = liveLeague.draftType === "AUCTION"
          ? inferAuctionSaleCountFromBudgets(roomContext.auctionBudgets, liveLeague)
          : undefined;
        const feedObservation = authoritativePickFeedHealth(
            pickFeedCursorRef.current,
            pickFeedPicks,
            liveLeague.draftType === "AUCTION"
              ? { ...roomContext, budgetInferredSaleCount }
              : roomContext,
            liveLeague.draftType,
          );
        if (feedObservation.accepted) {
          if (feedObservation.advanced) pickFeedCursorRef.current = feedObservation.cursor;
          if (pickFeedStaleTimerRef.current !== null) window.clearTimeout(pickFeedStaleTimerRef.current);
          setPickFeedHealth((current) => nextPickFeedRuntimeHealth(current, observedAt, feedObservation));
          pickFeedStaleTimerRef.current = window.setTimeout(() => {
            setPickFeedHealth((current) => current.observedAt === observedAt
              ? { ...current, fresh: false }
              : current);
          }, PICK_FEED_HEALTH_WINDOW_MS);
          feedFreshness = {
            pickFeedObservedAt: observedAt,
            pickFeedLagging: feedObservation.lagging,
            ...(feedObservation.advanced ? { pickFeedAt: observedAt } : {}),
          };
        } else {
          if (pickFeedStaleTimerRef.current !== null) window.clearTimeout(pickFeedStaleTimerRef.current);
          pickFeedStaleTimerRef.current = null;
          setPickFeedHealth((current) => nextPickFeedRuntimeHealth(current, observedAt, feedObservation));
          feedFreshness = { pickFeedLagging: true };
        }
      }
      updateLiveControlFreshness({
        espnContextAt: observedAt,
        ...feedFreshness,
      });
    }
    function resolvedLivePlayer(action: PendingLiveAction, payload: Record<string, unknown>) {
      const playerId = Number(payload.playerId);
      const player = espnPlayersRef.current.find((candidate) => candidate.id === playerId);
      if (player) return livePlayerIdentity(player);
      const playerName = String(payload.playerName || "").trim();
      return Number.isInteger(playerId) && playerId !== 0 && playerName
        ? { ...action.intendedPlayer, playerId, playerName }
        : action.intendedPlayer;
    }
    function appendActionPhase(
      action: PendingLiveAction,
      phase: LiveActionLifecyclePhase,
      payload: Record<string, unknown> = {},
      code?: string,
    ) {
      if (action.phase === phase) return true;
      if (["ROSTER_CONFIRMED", "ACTION_COMPLETED", "FAILED", "CANCELLED"].includes(action.phase)) return false;
      const resolvedPlayer = phase === "RESOLVED" ? resolvedLivePlayer(action, payload) : action.resolvedPlayer;
      const payloadAmount = Number(payload.amount);
      const resolvedOffer = phase === "RESOLVED" && Number.isInteger(payloadAmount) && payloadAmount >= 0
        ? payloadAmount
        : action.resolvedOffer;
      const currentControl = liveControlRef.current;
      const decision = phase === "RESOLVED" && currentControl?.decision?.decisionId === action.decisionId
        ? {
            ...currentControl.decision,
            resolvedPlayer,
            ...(resolvedOffer === undefined ? {} : { resolvedOffer }),
          }
        : undefined;
      const occurredAt = new Date().toISOString();
      const accepted = transitionLiveControl({
        kind: "ACTION_LIFECYCLE",
        occurredAt,
        actionId: action.actionId,
        decisionId: action.decisionId,
        operation: action.operation,
        phase,
        intendedPlayer: action.intendedPlayer,
        ...(resolvedPlayer ? { resolvedPlayer } : {}),
        ...(action.intendedOffer === undefined ? {} : { intendedOffer: action.intendedOffer }),
        ...(resolvedOffer === undefined ? {} : { resolvedOffer }),
        ...(code ? { code: safeLiveControlCode(code, "ACTION_STATE_CHANGED") } : {}),
      }, {
        ...(decision ? { decision } : {}),
        ...(phase === "CLICK_SENT" || phase === "ESPN_ACKNOWLEDGED" || ["ROSTER_CONFIRMED", "ACTION_COMPLETED", "FAILED", "CANCELLED"].includes(phase)
          ? { freshness: { lastActionAt: occurredAt } }
          : {}),
      });
      if (!accepted) return false;
      action.resolvedPlayer = resolvedPlayer;
      action.resolvedOffer = resolvedOffer;
      action.phase = phase;
      if (["ROSTER_CONFIRMED", "ACTION_COMPLETED", "FAILED", "CANCELLED"].includes(phase)) {
        return clearPublishedLiveDecision(action.decisionId);
      }
      return true;
    }
    function onMessage(event: MessageEvent) {
      if (event.source !== window || event.origin !== window.location.origin || event.data?.source !== "draftforge-extension") return;
      const { type, payload } = event.data;
      if ((type === "EXTENSION_READY" || type === "COMMAND_RESULT") && payload?.runtime) {
        setRuntimeDiagnostics(payload.runtime as DraftRuntimeDiagnostics);
      }
      if (type === "EXTENSION_READY" || (type === "COMMAND_RESULT" && payload?.ready)) {
        const reportedWorkspaceRole = String(payload?.workspace?.role || "");
        if (reportedWorkspaceRole === "writer" || reportedWorkspaceRole === "observer") {
          workspaceRoleRef.current = reportedWorkspaceRole;
          setWorkspaceRole(reportedWorkspaceRole);
          if (reportedWorkspaceRole === "observer") {
            setAutoDraft(false);
            setActionState("Read-only observer: live updates remain visible, while ESPN control and audit publishing stay bound to the original command center.");
          }
        }
        setExtension((current) => current === "connected" ? current : "ready");
        const roomContext = payload?.context as EspnContext | undefined;
        // A browser can have several active ESPN mocks. Never let an arbitrary
        // tab select a league or make this dashboard look actionable.
        if (contextMatchesActiveDraftTab(roomContext, activeLeagueRef.current, activeEspnTabRef.current)
          && acceptLiveProducerContext(roomContext)) {
          observeLiveContext(roomContext);
          setContext((current) => stabilizeEspnContext(current, roomContext || {}));
          setExtension("connected");
        }
      }
      if (type === "DF_ESPN_CONTEXT") {
        const roomContext = payload as EspnContext | undefined;
        if (contextMatchesActiveDraftTab(roomContext, activeLeagueRef.current, activeEspnTabRef.current)
          && acceptLiveProducerContext(roomContext)) {
          observeLiveContext(roomContext);
          setContext((current) => stabilizeEspnContext(current, roomContext || {}));
          setExtension("connected");
        }
      }
      if (type === "COMMAND_RESULT" && payload?.context) {
        const roomContext = payload.context as EspnContext;
        if (contextMatchesActiveDraftTab(roomContext, activeLeagueRef.current, activeEspnTabRef.current)
          && acceptLiveProducerContext(roomContext)) {
          observeLiveContext(roomContext);
          setContext((current) => stabilizeEspnContext(current, roomContext));
          setExtension("connected");
        } else if (payload.rebound === true
          && contextCanRebindDraftTab(roomContext, activeLeagueRef.current, activeEspnTeamRef.current)
          && acceptLiveProducerContext(roomContext)) {
          // A verified replacement tab is a new control surface, but it is
          // still the same draft. Preserve the append-only action, attribution,
          // and incident ledger so a rebound cannot erase history. Rebinding is
          // allowed only between actions; an in-flight replacement is
          // irreconcilable and stays permanently fail closed.
          const reboundTabId = Number(roomContext.tabId);
          const reboundBinding = draftAuditChecklistBindingKey(
            activeLeagueRef.current,
            Number(activeEspnTeamRef.current),
            reboundTabId,
          );
          const activeControl = liveControlRef.current;
          let preservedControl: LiveControlState | null | undefined = activeControl;
          try {
            if (activeControl) preservedControl = preserveLiveControlForVerifiedRebound(activeControl, Boolean(inFlightActionRef.current));
          } catch {
            preservedControl = undefined;
          }
          if (!reboundBinding || (activeControl && preservedControl !== activeControl) || (!activeControl && Boolean(inFlightActionRef.current))) {
            setAutoDraft(false);
            failClosedLiveControl("EXACT_BINDING_REBOUND_DURING_ACTION");
            setActionState("Action stopped: the ESPN room tab changed while an action was unresolved. No retry will be sent.");
            return;
          }
          setAutoDraft(false);
          pendingLiveRoomAutoArmRef.current = false;
          pendingAutoArmRequestRef.current = null;
          setAutoArmVerification(null);
          activeEspnTabRef.current = reboundTabId;
          setActiveEspnTabId(reboundTabId);
          if (activeControl) {
            liveControlBindingRef.current = reboundBinding;
            liveControlSafetyRef.current.delete("EXACT_BINDING");
            const publisherBinding = draftAuditPublisherBinding(
              activeControl,
              activeLeagueRef.current,
              Number(activeEspnTeamRef.current),
              reboundTabId,
            );
            if (!publisherBinding) {
              failClosedLiveControl("INVALID_DRAFT_AUDIT_REBOUND_BINDING");
              return;
            }
            if (draftAuditPublisherRef.current?.bind(publisherBinding)) setAuditPublisherAuthorized(false);
          }
          observeLiveContext(roomContext);
          setContext((current) => stabilizeEspnContext(current, roomContext));
          setExtension("connected");
          setActionState("Exact ESPN room rebound verified. Prior action history is preserved; Auto-Draft remains off until the fresh no-click checklist passes.");
        }
        const autoArmRequestId = Number(payload.autoArmRequestId);
        if (Number.isInteger(autoArmRequestId) && autoArmRequestId === pendingAutoArmRequestRef.current) {
          setAutoArmVerification({ requestId: autoArmRequestId, context: roomContext });
        }
      }
      if (type === "DF_IMPORT_SUCCESS" || (type === "COMMAND_RESULT" && payload?.data?.league)) {
        // An authenticated import can replace league/team/tab identity even if
        // ESPN reuses the same visible room. Drop the publisher ack first.
        draftAuditPublisherRef.current?.clear("AUTHENTICATED_IMPORT_STARTED");
        setAuditPublisherAuthorized(false);
        const data = type === "DF_IMPORT_SUCCESS" ? payload : payload.data;
        const importedLeague = normalizeImportedLeague(data.league);
        const importedPlayers = data.players?.length ? data.players : DEMO_PLAYERS;
        const importedContext = data.context as EspnContext | undefined;
        const importedPicks = reconcileEspnPicks(
          mergeDraftPicks(actualPicks(data.picks), resolveAuctionSales(importedContext, importedLeague, importedPlayers)),
          importedContext,
          importedLeague.teamId,
          importedPlayers,
          importedLeague,
        );
        const importedTabId = Number(importedContext?.tabId);
        const isWorkspaceRecovery = data.workspaceRecovery?.recovered === true;
        const recoveryReceipt = isWorkspaceRecovery
          ? [
              data.workspaceRecovery?.sourceLeagueId,
              data.workspaceRecovery?.roomLeagueId,
              data.workspaceRecovery?.roomTabId,
            ].join(":")
          : "";
        // Background recovery intentionally delivers writer-first and also
        // returns the same authenticated import to the bridge. Either delivery
        // may arrive first; consume the proof once and ignore only an exact
        // duplicate. Observer tabs never participate in authority recovery.
        if (isWorkspaceRecovery && (workspaceRoleRef.current === "observer"
          || completedLiveWorkspaceRecoveryRef.current === recoveryReceipt)) return;
        const pendingRecovery = pendingLiveWorkspaceRecoveryRef.current;
        let recoveredCandidate: LiveControlRecoveryCandidate | null = null;
        if (isWorkspaceRecovery) {
          if (!pendingRecovery) {
            clearLiveControl();
            failClosedLiveControl("LIVE_CONTROL_RECOVERY_AUDIT_MISSING");
            setExtension("error");
            return;
          }
          if (String(data.workspaceRecovery?.roomLeagueId || "") !== pendingRecovery.requested.draftLeagueId
            || String(data.workspaceRecovery?.sourceLeagueId || "") !== pendingRecovery.requested.sourceLeagueId
            || Number(data.workspaceRecovery?.roomTabId) !== importedTabId) {
            pendingLiveWorkspaceRecoveryRef.current = null;
            clearLiveControl();
            failClosedLiveControl("LIVE_CONTROL_RECOVERY_RESPONSE_MISMATCH");
            setExtension("error");
            return;
          }
          const recoveryImport = validateLiveControlRecoveryImport(pendingRecovery.candidate, {
            leagueId: importedLeague.id,
            teamId: Number(importedContext?.teamId || importedLeague.teamId),
            season: Number(importedContext?.season || importedLeague.season),
            draftType: importedLeague.draftType,
            tabId: importedTabId,
            inDraftRoom: importedContext?.inDraftRoom === true,
            autopickActive: importedContext?.autopickActive,
            roster: resolveOwnRoster(importedContext, importedPlayers),
            rules: {
              size: importedLeague.size,
              rosterSize: importedLeague.rosterSize,
              auctionBudget: importedLeague.auctionBudget,
              secondsPerPick: importedLeague.secondsPerPick,
              scoringLabel: importedLeague.scoringLabel,
              scoringRules: importedLeague.scoringRules,
              keeperCount: importedLeague.keeperCount,
              lineupSlotCounts: importedLeague.lineupSlotCounts,
              positionLimits: importedLeague.positionLimits,
            },
          });
          if (!recoveryImport.ok) {
            pendingLiveWorkspaceRecoveryRef.current = null;
            clearLiveControl();
            failClosedLiveControl(recoveryImport.code);
            setExtension("error");
            return;
          }
          recoveredCandidate = pendingRecovery.candidate;
        }
        if (activeLeagueRef.current !== importedLeague.id) clearLiveControl();
        if (importedContext?.inDraftRoom === true && !acceptLiveProducerContext(importedContext)) {
          if (isWorkspaceRecovery) {
            pendingLiveWorkspaceRecoveryRef.current = null;
            clearLiveControl();
            failClosedLiveControl("LIVE_CONTROL_RECOVERY_PRODUCER_INVALID");
            setExtension("error");
          }
          return;
        }
        activeLeagueRef.current = importedLeague.id;
        activeSourceLeagueRef.current = String(
          data.roomWatch?.sourceLeagueId
          || data.workspaceRecovery?.sourceLeagueId
          || importedLeague.id,
        );
        finalizedPracticeRoomRef.current = "";
        practiceRoomCleanupAttemptRef.current = { key: "", attempts: 0 };
        activeLeagueSettingsRef.current = importedLeague;
        activeEspnTabRef.current = Number.isInteger(importedTabId) ? importedTabId : null;
        setActiveEspnTabId(Number.isInteger(importedTabId) ? importedTabId : null);
        const importedPlayerPoolAt = String(data.authenticatedImportAt || "");
        setAuthenticatedImportAt(isCanonicalDraftAuditUtcTimestamp(importedPlayerPoolAt)
          ? importedPlayerPoolAt
          : new Date().toISOString());
        if (data.runtime) setRuntimeDiagnostics(data.runtime as DraftRuntimeDiagnostics);
        activeEspnTeamRef.current = Number(importedContext?.teamId || importedLeague.teamId || 0) || null;
        latestActionRequestRef.current = ++actionRequestSequenceRef.current;
        inFlightActionRef.current = null;
        setActionInFlight(false);
        pendingSnakeActionRef.current = null;
        pendingAuctionNominationRef.current = null;
        pendingAuctionBidRef.current = null;
        availabilityDecisionsRef.current.clear();
        setPendingAuctionNomination(null);
        setRejectedSnakePlayerIds([]);
        setAutoDraft(false);
        lastAutoAction.current = "";
        setActionRetryNonce(0);
        pendingActionTelemetryRef.current.clear();
        actionTelemetryRef.current = [];
        salaryCapDecisionObservationsRef.current.clear();
        sleeperEvidenceLedgerRef.current = { leagueId: importedLeague.id, candidates: [] };
        setTelemetryVersion((version) => version + 1);
        pendingAutoArmRequestRef.current = null;
        setAutoArmVerification(null);
        dispatchUi({ type: "set", key: "autoWarning", value: false });
        const watchedAutoArm = !recoveredCandidate
          && data.roomWatch?.recovered === true
          && data.roomWatch?.autoArmRequested === true;
        pendingLiveRoomAutoArmRef.current = watchedAutoArm;
        if (recoveredCandidate) {
          const restoredControl = recoveredCandidate.snapshot.liveControl as LiveControlState;
          actionTelemetryRef.current = recoveredCandidate.snapshot.telemetry.actions.map((event) => ({ ...event }));
          sleeperEvidenceLedgerRef.current = {
            leagueId: importedLeague.id,
            candidates: recoveredCandidate.snapshot.sleeperEvidence.candidates.map((candidate) => ({ ...candidate })),
          };
          COMMAND_CENTER_PUBLISHER.sessionId = recoveredCandidate.commandCenterSessionId;
          COMMAND_CENTER_PUBLISHER.startedAt = recoveredCandidate.commandCenterStartedAt;
          liveControlRef.current = restoredControl;
          liveControlBindingRef.current = draftAuditChecklistBindingKey(
            importedLeague.id,
            Number(importedContext?.teamId || importedLeague.teamId),
            importedTabId,
          );
          liveControlBlockedRef.current = false;
          liveControlActionsRef.current.clear();
          processedActionResultsRef.current.clear();
          const restoredRosterIds = new Set(resolveOwnRoster(importedContext, importedPlayers).map((entry) => entry.playerId));
          liveControlObservedRosterRef.current = restoredRosterIds;
          liveControlBaselineRosterRef.current = new Set(restoredRosterIds);
          liveControlSafetyRef.current.clear();
          draftAuditPublishingBlockedRef.current = false;
          lastValidatedLiveChecklistBindingRef.current = "";
          completedLiveWorkspaceRecoveryRef.current = recoveryReceipt;
          pendingLiveWorkspaceRecoveryRef.current = null;
          setLiveControlVersion((version) => version + 1);
        }
        setLeague(importedLeague);
        espnPlayersRef.current = importedPlayers;
        if (importedContext) {
          initializeLiveControl(importedLeague, importedContext, importedPlayers);
          observeLiveContext(importedContext, importedPicks);
        }
        setEspnPlayers(importedPlayers);
        setPicks(importedPicks);
        setContext(contextMatchesActiveDraftTab(importedContext, importedLeague.id, activeEspnTabRef.current) ? importedContext || {} : {});
        setLeagueId(String(importedLeague.id));
        setExtension("connected");
        dispatchUi({ type: "set", key: "settingsOpen", value: recoveredCandidate ? true : !watchedAutoArm });
        setSettingsConfirmed(recoveredCandidate ? false : watchedAutoArm);
        setActionState(recoveredCandidate
          ? "Exact prior command-center history and authenticated ESPN roster recovered. Auto-Draft is off; rerun the full live-room checklist before arming."
          : data.roomWatch?.recovered === true
          ? watchedAutoArm
            ? "Exact ESPN live room auto-bound without a reload. Revalidating the room and arming Auto-Draft before the opening pick."
            : "Exact ESPN live room auto-bound without a reload. Confirm the live-room checklist, then enable Auto-Draft."
          : "ESPN settings imported. Confirm them before drafting.");
        const profile: DraftProfile = { league: importedLeague, espnPlayers: importedPlayers, picks: importedPicks, settingsConfirmed: recoveredCandidate ? false : watchedAutoArm, strategy: "BALANCED", savedAt: new Date().toISOString() };
        profilesRef.current = upsertDraftProfile(profilesRef.current, profile);
        setProfiles(profilesRef.current);
      }
      if (type === "DF_DRAFT_UPDATE") {
        const pollIdentity = payload?.identity;
        const latestRoomContext = latestEspnContextRef.current;
        if (!contextMatchesActiveDraftTab(pollIdentity, activeLeagueRef.current, activeEspnTabRef.current)
          || Number(pollIdentity?.teamId) !== Number(activeEspnTeamRef.current)
          || Number(pollIdentity?.season) !== Number(activeLeagueSettingsRef.current.season)
          || !contextMatchesActiveDraftTab(latestRoomContext, activeLeagueRef.current, activeEspnTabRef.current)) return;
        const liveLeague = activeLeagueSettingsRef.current;
        const reconciled = reconcileEspnPicks(
          mergeDraftPicks(actualPicks(payload.picks), resolveAuctionSales(latestRoomContext, liveLeague, espnPlayersRef.current)),
          latestRoomContext,
          activeEspnTeamRef.current,
          espnPlayersRef.current,
          liveLeague,
        );
        observeLiveContext(latestRoomContext, reconciled);
        setPicks((current) => reconcileEspnPicks(
          mergeDraftPicks(current, reconciled),
          latestRoomContext,
          activeEspnTeamRef.current,
          espnPlayersRef.current,
          liveLeague,
        ));
      }
      if (type === "DF_ACTION_RESOLVED") {
        if (String(payload.commandCenterSessionId || "") !== COMMAND_CENTER_PUBLISHER.sessionId) return;
        const actionRequestId = Number(payload.actionRequestId);
        const liveAction = liveControlActionsRef.current.get(actionRequestId);
        if (liveAction && Number(payload.tabId) === activeEspnTabRef.current) {
          appendActionPhase(liveAction, "RESOLVED", payload);
        }
        const pending = pendingSnakeActionRef.current;
        if (pending
          && Number.isInteger(actionRequestId)
          && actionRequestId === latestActionRequestRef.current
          && payload.operation === "SELECT"
          && Number(payload.tabId) === activeEspnTabRef.current) {
          pending.playerId = Number(payload.playerId);
          pending.playerName = String(payload.playerName || pending.playerName);
          setActionState(`ESPN resolved the live action to ${pending.playerName}. Verifying the exact control before submission.`);
        }
        const pendingTelemetry = pendingActionTelemetryRef.current.get(actionRequestId);
        if (pendingTelemetry
          && Number.isInteger(actionRequestId)
          && actionRequestId === latestActionRequestRef.current
          && (payload.operation === "SELECT" || payload.operation === "NOMINATE")
          && Number(payload.tabId) === activeEspnTabRef.current
          && Number.isInteger(Number(payload.playerId))
          && Number(payload.playerId) !== 0) {
          // Candidate fallback is resolved against ESPN's current visible pool.
          // Attribute the action to the player actually submitted, not the
          // recommendation that initiated the request.
          pendingTelemetry.playerId = Number(payload.playerId);
        }
      }
      if (type === "DF_ACTION_SUBMITTED") {
        if (String(payload.commandCenterSessionId || "") !== COMMAND_CENTER_PUBLISHER.sessionId) return;
        const actionRequestId = Number(payload.actionRequestId);
        const liveAction = liveControlActionsRef.current.get(actionRequestId);
        if (liveAction && Number(payload.tabId) === activeEspnTabRef.current) {
          if (liveAction.phase === "PLANNED") appendActionPhase(liveAction, "RESOLVED", payload);
          appendActionPhase(liveAction, "CLICK_SENT", payload);
        }
        const pendingTelemetry = pendingActionTelemetryRef.current.get(actionRequestId);
        const submittedAt = Number(payload.submittedAt);
        if (pendingTelemetry
          && Number.isInteger(actionRequestId)
          && actionRequestId === latestActionRequestRef.current
          && Number(payload.tabId) === activeEspnTabRef.current
          && Number.isFinite(submittedAt)
          && submittedAt >= pendingTelemetry.sentAt
          && pendingTelemetry.submittedAt === null) {
          pendingTelemetry.submittedAt = submittedAt;
          const submittedPlayerId = Number(payload.playerId);
          const submittedAmount = Number(payload.amount);
          if (Number.isInteger(submittedPlayerId) && submittedPlayerId !== 0) pendingTelemetry.playerId = submittedPlayerId;
          if (Number.isInteger(submittedAmount) && submittedAmount >= 0) pendingTelemetry.amount = submittedAmount;
        }
      }
      if (type === "DF_ACTION_RESULT" || (type === "COMMAND_RESULT" && payload?.commandType === "SUBMIT_ACTION")) {
        if (String(payload.action?.commandCenterSessionId || "") !== COMMAND_CENTER_PUBLISHER.sessionId) return;
        const actionRequestId = Number(payload.action?.actionRequestId);
        if (!Number.isSafeInteger(actionRequestId) || actionRequestId <= 0) return;
        const actionResultKey = `${COMMAND_CENTER_PUBLISHER.sessionId}:${actionRequestId}`;
        if (processedActionResultsRef.current.has(actionResultKey)) return;
        processedActionResultsRef.current.add(actionResultKey);
        while (processedActionResultsRef.current.size > MAX_DRAFT_ACTION_TELEMETRY_EVENTS) {
          const oldestKey = processedActionResultsRef.current.values().next().value;
          if (oldestKey === undefined) break;
          processedActionResultsRef.current.delete(oldestKey);
        }
        const actionWatchdog = actionWatchdogsRef.current.get(actionRequestId);
        if (actionWatchdog !== undefined) window.clearTimeout(actionWatchdog);
        actionWatchdogsRef.current.delete(actionRequestId);
        const liveAction = liveControlActionsRef.current.get(actionRequestId);
        if (liveAction) {
          const resultAction = (payload.action || {}) as Record<string, unknown>;
          const noClickTerminal = payload.ok === true
            && ["WALK_AWAY", "HOLD_LEADING_BID"].includes(String(payload.code || ""));
          if (noClickTerminal) {
            appendActionPhase(liveAction, "CANCELLED", resultAction, String(payload.code));
          } else if (payload.ok === true) {
            if (liveAction.phase === "PLANNED") appendActionPhase(liveAction, "RESOLVED", resultAction);
            if (liveAction.phase === "RESOLVED") appendActionPhase(liveAction, "CLICK_SENT", resultAction);
            if (liveAction.phase === "CLICK_SENT") appendActionPhase(liveAction, "ESPN_ACKNOWLEDGED", resultAction, String(payload.code || "ESPN_ACKNOWLEDGED"));
            if (liveAction.phase === "ESPN_ACKNOWLEDGED") {
              if (liveAction.operation === "SELECT" && payload.code === "ROSTER_CONFIRMED") {
                appendActionPhase(liveAction, "ROSTER_CONFIRMED", resultAction, "ROSTER_CONFIRMED");
                if (liveAction.resolvedPlayer) attributeLiveRosterPlayer(liveAction.resolvedPlayer, "DRAFTFORGE_CONFIRMED", liveAction);
              } else if (liveAction.operation !== "SELECT") {
                appendActionPhase(liveAction, "ACTION_COMPLETED", resultAction, String(payload.code || "ACTION_COMPLETED"));
              }
            }
          } else {
            appendActionPhase(liveAction, "FAILED", resultAction, String(payload.code || "ACTION_FAILED"));
          }
        }
        availabilityDecisionsRef.current.delete(actionRequestId);
        if (inFlightActionRef.current?.actionRequestId === actionRequestId) {
          inFlightActionRef.current = null;
          setActionInFlight(false);
        }
        if (Number.isInteger(actionRequestId) && actionRequestId !== latestActionRequestRef.current) return;
        const pendingTelemetry = pendingActionTelemetryRef.current.get(actionRequestId);
        if (pendingTelemetry) {
          pendingActionTelemetryRef.current.delete(actionRequestId);
          const resolvedPlayerId = Number(payload.action?.playerId);
          if (pendingTelemetry.operation === "SELECT"
            && Number.isInteger(resolvedPlayerId)
            && resolvedPlayerId !== 0) {
            pendingTelemetry.playerId = resolvedPlayerId;
          }
          const resultSubmittedAt = Number(payload.action?.submittedAt);
          const submittedAt = pendingTelemetry.submittedAt ?? (
            Number.isFinite(resultSubmittedAt) && resultSubmittedAt >= pendingTelemetry.sentAt
              ? resultSubmittedAt
              : null
          );
          actionTelemetryRef.current = [...actionTelemetryRef.current, {
            occurredAt: new Date().toISOString(),
            operation: pendingTelemetry.operation,
            ok: payload.ok === true,
            code: String(payload.code || (payload.ok ? "ACTION_OK" : "ACTION_FAILED")),
            submitMs: submittedAt === null
              ? null
              : Math.max(0, Math.round(submittedAt - pendingTelemetry.sentAt)),
            roundTripMs: Math.max(0, Math.round(Date.now() - pendingTelemetry.sentAt)),
            clockSeconds: pendingTelemetry.clockSeconds,
            automatic: pendingTelemetry.automatic,
            playerId: pendingTelemetry.playerId,
            amount: pendingTelemetry.amount,
            maxApprovedBid: pendingTelemetry.maxApprovedBid,
            nominationIntent: pendingTelemetry.nominationIntent,
          }].slice(-MAX_DRAFT_ACTION_TELEMETRY_EVENTS);
          setTelemetryVersion((version) => version + 1);
        }
        if (!payload.ok && payload.action?.operation === "NOMINATE") {
          const nominationMayHaveClicked = payload.clicked === true || String(payload.code || "") === "NOMINATION_ACK_UNCERTAIN";
          if (!nominationMayHaveClicked) {
            pendingAuctionNominationRef.current = null;
            setPendingAuctionNomination(null);
          }
          if (RETRIABLE_NOMINATION_CODES.has(String(payload.code || ""))) {
            lastAutoAction.current = "";
            setExtension("connected");
            setActionRetryNonce((nonce) => nonce + 1);
            setActionState(`ESPN nomination turn changed (${payload.code}). Waiting for the next live turn.`);
            return;
          }
        }
        if (payload.ok && payload.action?.operation === "SELECT" && pendingSnakeActionRef.current) {
          const selectedPlayerId = Number(payload.action.playerId);
          const selectedPlayerName = String(payload.action.playerName || "");
          if (Number.isInteger(selectedPlayerId) && selectedPlayerId !== 0 && selectedPlayerName) {
            pendingSnakeActionRef.current.playerId = selectedPlayerId;
            pendingSnakeActionRef.current.playerName = selectedPlayerName;
          }
          if (payload.code === "ROSTER_CONFIRMED") {
            pendingSnakeActionRef.current = null;
            setExtension("connected");
          }
        }
        if (shouldReevaluateSupersededBid(payload)) {
          // ESPN accepted the old click but another manager advanced the offer
          // before acknowledgement. Terminalize that exact action above, then
          // schedule one new engine pass from the latest nominee, price, leader,
          // clock, availability, reserve, and source-backed ceiling. This is not
          // a blind transport retry: the normal bid effect and pre-click gates
          // must authorize a brand-new exact +$1 action.
          pendingAuctionBidRef.current = null;
          lastAutoAction.current = "";
          setExtension("connected");
          setActionRetryNonce((nonce) => nonce + 1);
          setActionState("ESPN advanced the offer during acknowledgement. Re-evaluating the latest exact bid now.");
          return;
        }
        if (!payload.ok && payload.action?.operation === "BID" && RETRIABLE_BID_CODES.has(String(payload.code || ""))) {
          pendingAuctionBidRef.current = null;
          lastAutoAction.current = "";
          setExtension("connected");
          setActionRetryNonce((nonce) => nonce + 1);
          setActionState(`ESPN offer changed (${payload.code}). Re-evaluating the live bid immediately.`);
          return;
        }
        if (!payload.ok && pendingSnakeActionRef.current) {
          const pending = pendingSnakeActionRef.current;
          if (payload.clicked !== true && RETRIABLE_SELECT_CODES.has(String(payload.code || ""))) {
            // An exact ESPN control that has disappeared cannot become
            // draftable again later in the same room. Keep it rejected across
            // snake-turn boundaries, including consecutive picks at the turn.
            setRejectedSnakePlayerIds((current) => [...new Set([...current, pending.playerId])]);
            pendingSnakeActionRef.current = null;
            lastAutoAction.current = "";
            setExtension("connected");
            setActionState(`${pending.playerName} left ESPN's live pool (${payload.code}). Retrying this pick immediately.`);
            return;
          }
          if (RETRIABLE_TURN_CODES.has(String(payload.code || ""))) {
            pendingSnakeActionRef.current = null;
            lastAutoAction.current = "";
            setExtension("connected");
            setActionRetryNonce((nonce) => nonce + 1);
            setActionState(`ESPN control changed (${payload.code}). Re-evaluating the live turn immediately.`);
            return;
          }
          pending.failed = true;
          setAutoDraft(false);
        }
        if (!payload.ok) setAutoDraft(false);
        setActionState(payload.ok ? payload.message : `Action stopped: ${payload.message}`);
      }
      if (type === "DF_EXTENSION_ERROR" || type === "EXTENSION_ERROR") {
        if (pendingLiveWorkspaceRecoveryRef.current) {
          pendingLiveWorkspaceRecoveryRef.current = null;
          completedLiveWorkspaceRecoveryRef.current = "";
          clearLiveControl();
          failClosedLiveControl("LIVE_CONTROL_RECOVERY_TRANSPORT_FAILED");
          setExtension("error");
          return;
        }
        const pendingLiveAction = inFlightActionRef.current
          ? liveControlActionsRef.current.get(inFlightActionRef.current.actionRequestId)
          : undefined;
        if (pendingLiveAction) appendActionPhase(pendingLiveAction, "FAILED", {}, "EXTENSION_ERROR");
        if (inFlightActionRef.current) {
          const watchdog = actionWatchdogsRef.current.get(inFlightActionRef.current.actionRequestId);
          if (watchdog !== undefined) window.clearTimeout(watchdog);
          actionWatchdogsRef.current.delete(inFlightActionRef.current.actionRequestId);
          availabilityDecisionsRef.current.delete(inFlightActionRef.current.actionRequestId);
        }
        inFlightActionRef.current = null;
        setActionInFlight(false);
        pendingAutoArmRequestRef.current = null;
        setAutoArmVerification(null);
        dispatchUi({ type: "set", key: "autoWarning", value: false });
        setAutoDraft(false);
        setExtension("error");
        setActionState(payload.message || "The ESPN companion reported an error.");
      }
      if (type === "COMMAND_RESULT" && payload?.code === "LIVE_ROOM_WATCH_ARMED") {
        if (payload.runtime) setRuntimeDiagnostics(payload.runtime as DraftRuntimeDiagnostics);
        setExtension("connected");
        setActionState("Exact ESPN live-room handoff armed. Open the league-specific draft; DraftForge will bind and foreground the command center automatically.");
      }
      if (type === "COMMAND_RESULT" && payload?.commandType === "CLOSE_PRACTICE_ROOM") {
        if (payload?.ok === true) {
          if (payload.runtime) setRuntimeDiagnostics(payload.runtime as DraftRuntimeDiagnostics);
          setExtension("connected");
          setActionState("Final audit passed. DraftForge closed the verified practice room and its exact stale workspace tabs.");
        } else {
          const attempts = practiceRoomCleanupAttemptRef.current.attempts;
          if (canRetryPracticeRoomCleanup(attempts)) {
            finalizedPracticeRoomRef.current = "";
            setActionState(`Draft complete. Practice-room cleanup stayed fail closed; exact retry ${attempts + 1}/${MAX_AUTOMATIC_PRACTICE_CLEANUP_ATTEMPTS} is queued.`);
          } else {
            setActionState(`Draft complete. Practice-room cleanup stopped after ${MAX_AUTOMATIC_PRACTICE_CLEANUP_ATTEMPTS} exact attempts; no unrelated tab was touched.`);
          }
        }
        return;
      }
      if (type === "COMMAND_RESULT" && payload?.commandType === "CANCEL_PENDING_ACTIONS") return;
      if (type === "COMMAND_RESULT" && payload?.ok === false) {
        if (payload?.commandType === "RECOVER_LIVE_WORKSPACE") {
          pendingLiveWorkspaceRecoveryRef.current = null;
          completedLiveWorkspaceRecoveryRef.current = "";
          clearLiveControl();
          failClosedLiveControl("LIVE_CONTROL_RECOVERY_COMMAND_FAILED");
          setExtension("error");
          return;
        }
        // SUBMIT_ACTION is broadcast as DF_ACTION_RESULT first so its retry or
        // fail-closed policy is handled exactly once.
        if (payload.action) return;
        const failedInFlight = inFlightActionRef.current;
        if (failedInFlight) {
          const watchdog = actionWatchdogsRef.current.get(failedInFlight.actionRequestId);
          if (watchdog !== undefined) window.clearTimeout(watchdog);
          actionWatchdogsRef.current.delete(failedInFlight.actionRequestId);
          const liveAction = liveControlActionsRef.current.get(failedInFlight.actionRequestId);
          if (liveAction) appendActionPhase(liveAction, "FAILED", {}, String(payload.code || "COMMAND_FAILED"));
          inFlightActionRef.current = null;
          availabilityDecisionsRef.current.delete(failedInFlight.actionRequestId);
          setActionInFlight(false);
          if (pendingActionTelemetryRef.current.delete(failedInFlight.actionRequestId)) {
            setTelemetryVersion((version) => version + 1);
          }
        }
        const autoArmRequestId = Number(payload.autoArmRequestId);
        if (Number.isInteger(autoArmRequestId) && autoArmRequestId === pendingAutoArmRequestRef.current) {
          pendingAutoArmRequestRef.current = null;
          setAutoArmVerification(null);
          dispatchUi({ type: "set", key: "autoWarning", value: false });
          dispatchUi({ type: "set", key: "settingsOpen", value: true });
          setAutoDraft(false);
          setExtension("error");
          setActionState("Auto-Draft locked: the exact ESPN draft tab changed or could not be verified. Reconnect and rerun the live-room checklist.");
          return;
        }
        if (pendingSnakeActionRef.current) {
          pendingSnakeActionRef.current.failed = true;
          setAutoDraft(false);
        }
        setExtension((current) => current === "connected" && payload.code === "NO_LEAGUE"
          ? current
          : payload.code === "NO_LEAGUE" ? "ready" : "error");
        setActionState(payload.message || "Could not connect to ESPN.");
      }
    }
    window.addEventListener("message", onMessage);
    // The content script can initialize before React attaches this listener; request a second handshake.
    if (!reloadCompanion) {
      sendToExtension("APP_HELLO", { commandCenterSessionId: COMMAND_CENTER_PUBLISHER.sessionId });
      if (recoveryPayload) window.setTimeout(async () => {
        const controller = new AbortController();
        const deadline = window.setTimeout(() => controller.abort(), 1_000);
        try {
          const response = await fetch(`/api/draft-day?leagueId=${encodeURIComponent(recoveryPayload.draftLeagueId)}&teamId=${recoveryPayload.teamId}`, {
            cache: "no-store",
            signal: controller.signal,
          });
          const result = await response.json().catch(() => null);
          const validated = validateLiveControlRecoveryCandidate({
            snapshot: result?.snapshot,
            reportedParity: result?.evaluation?.parity,
            expected: {
              leagueId: recoveryPayload.draftLeagueId,
              teamId: recoveryPayload.teamId,
              season: recoveryPayload.season,
            },
          });
          if (!response.ok || !validated.ok) {
            pendingLiveWorkspaceRecoveryRef.current = null;
            failClosedLiveControl(validated.ok ? "LIVE_CONTROL_RECOVERY_AUDIT_UNAVAILABLE" : validated.code);
            setExtension("error");
            return;
          }
          completedLiveWorkspaceRecoveryRef.current = "";
          pendingLiveWorkspaceRecoveryRef.current = { candidate: validated.candidate, requested: recoveryPayload };
          setAutoDraft(false);
          setActionState("Exact prior audit verified. Re-importing the authenticated ESPN room before restoring command-center history.");
          sendToExtension("RECOVER_LIVE_WORKSPACE", {
            ...recoveryPayload,
            commandCenterSessionId: validated.candidate.commandCenterSessionId,
          });
        } catch {
          pendingLiveWorkspaceRecoveryRef.current = null;
          failClosedLiveControl("LIVE_CONTROL_RECOVERY_AUDIT_UNAVAILABLE");
          setExtension("error");
        } finally {
          window.clearTimeout(deadline);
        }
      }, 0);
      if (closePracticePayload) window.setTimeout(async () => {
        let completedAuditProof = null;
        try {
          const response = await fetch(`/api/draft-day?leagueId=${encodeURIComponent(closePracticePayload.draftLeagueId)}&teamId=${closePracticePayload.teamId}`, { cache: "no-store" });
          const result = await response.json();
          if (response.ok
            && result?.evaluation?.finalReady === true
            && result?.evaluation?.parity === true
            && result?.snapshot?.safety?.autoDraft === false
            && String(result?.snapshot?.league?.id) === closePracticePayload.draftLeagueId
            && Number.isInteger(result?.snapshot?.binding?.tabId)) {
            completedAuditProof = {
              leagueId: closePracticePayload.draftLeagueId,
              teamId: closePracticePayload.teamId,
              tabId: result.snapshot.binding.tabId,
              finalReady: true,
              parity: true,
              autoDraftOff: true,
            };
          }
        } catch { /* expired-room cleanup remains fail closed without an exact completed audit */ }
        sendToExtension("CLOSE_PRACTICE_ROOM", { ...closePracticePayload, completedAuditProof });
      }, 0);
      if (cleanWorkspace) window.setTimeout(() => sendToExtension("CLEAN_LOCAL_WORKSPACE", { ownedBlankTabIds }), 0);
    }
    const writerHeartbeat = window.setInterval(() => {
      if (!Number.isInteger(activeEspnTabRef.current)
        || !Number.isInteger(activeEspnTeamRef.current)
        || !activeLeagueRef.current) return;
      sendToExtension("WRITER_HEARTBEAT", {
        commandCenterSessionId: COMMAND_CENTER_PUBLISHER.sessionId,
        expectedLeagueId: activeLeagueRef.current,
        expectedTeamId: activeEspnTeamRef.current,
        expectedTabId: activeEspnTabRef.current,
      });
    }, 500);
    const revokeWriterOnPageHide = () => {
      if (!Number.isInteger(activeEspnTabRef.current)
        || !Number.isInteger(activeEspnTeamRef.current)
        || !activeLeagueRef.current) return;
      actionAuthorizationEpochRef.current += 1;
      autoDraftRef.current = false;
      sendToExtension("REVOKE_WRITER_ON_PAGEHIDE", {
        commandCenterSessionId: COMMAND_CENTER_PUBLISHER.sessionId,
        expectedLeagueId: activeLeagueRef.current,
        expectedTeamId: activeEspnTeamRef.current,
        expectedTabId: activeEspnTabRef.current,
        minimumAuthorizationEpoch: actionAuthorizationEpochRef.current,
      });
    };
    window.addEventListener("pagehide", revokeWriterOnPageHide);
    window.addEventListener("beforeunload", revokeWriterOnPageHide);
    return () => {
      window.clearTimeout(timeout);
      window.clearInterval(writerHeartbeat);
      window.removeEventListener("pagehide", revokeWriterOnPageHide);
      window.removeEventListener("beforeunload", revokeWriterOnPageHide);
      if (pickFeedStaleTimerRef.current !== null) window.clearTimeout(pickFeedStaleTimerRef.current);
      pickFeedStaleTimerRef.current = null;
      window.removeEventListener("message", onMessage);
    };
  }, [acceptLiveProducerContext, attributeLiveRosterPlayer, clearLiveControl, clearPublishedLiveDecision, failClosedLiveControl, initializeLiveControl, setAutoDraft, setPickFeedHealth, transitionLiveControl, updateLiveControlFreshness]);

  useEffect(() => {
    profilesRef.current = profiles;
    persistDraftProfiles(window.localStorage, "draftforge-leagues-v1", profiles);
  }, [profiles]);

  useEffect(() => {
    const captureRequested = new URL(window.location.href).searchParams.get("capture") === "sanitized";
    if (!captureRequested
      || !["localhost", "127.0.0.1"].includes(window.location.hostname)
      || extension !== "connected"
      || !auditPublisherAuthorized
      || !/^[a-f0-9]{32}$/.test(captureReceiptIssueTokenRef.current)
      || league.id === "demo"
      || !Number.isInteger(activeEspnTabId)
      || !isCanonicalDraftAuditUtcTimestamp(authenticatedImportAt)) return;
    const controller = new AbortController();
    let capture: HTMLScriptElement | null = null;
    const sanitizedLeague = sanitizeAuthenticatedEspnLeague(league);
    const sanitizedEspnPlayers = sanitizeAuthenticatedEspnPlayers(espnPlayers);
    const request = {
      scoring: league.scoringLabel,
      teams: league.size,
      season: league.season,
      qbs: intelligenceQuarterbackMode(league.lineupSlotCounts),
    };
    const publishCapture = async () => {
      const digest = await authenticatedEspnCaptureDigest({
        capturedAt: authenticatedImportAt,
        league: sanitizedLeague,
        espnPlayers: sanitizedEspnPlayers,
      });
      const profile = buildAuthenticatedEspnCaptureProfile({ league: sanitizedLeague, espnPlayers: sanitizedEspnPlayers, request });
      const receiptResponse = await fetch("/api/draft-day", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        cache: "no-store",
        signal: controller.signal,
        body: JSON.stringify({
          operation: "ISSUE_ESPN_CAPTURE_RECEIPT",
          captureIssueToken: captureReceiptIssueTokenRef.current,
          capture: {
            digest,
            capturedAt: authenticatedImportAt,
            profile,
            tabId: Number(activeEspnTabId),
            dashboardLoadedAt: DASHBOARD_LOADED_AT,
            commandCenterSessionId: COMMAND_CENTER_PUBLISHER.sessionId,
          },
        }),
      });
      if (!receiptResponse.ok) return;
      const receiptBody = await receiptResponse.json();
      if (controller.signal.aborted || receiptBody?.ok !== true || typeof receiptBody?.receipt !== "string") return;
      capture = document.createElement("script");
      capture.id = "draftforge-sanitized-capture";
      capture.type = "application/json";
      capture.textContent = JSON.stringify({
        capturedAt: authenticatedImportAt,
        authenticatedEspnCapture: buildAuthenticatedEspnCaptureAttestation({
          capturedAt: authenticatedImportAt,
          league: sanitizedLeague,
          espnPlayers: sanitizedEspnPlayers,
          request,
          digest,
          receipt: receiptBody.receipt,
        }),
        league: sanitizedLeague,
        espnPlayers: sanitizedEspnPlayers,
        picks: authoritativePicks,
      }).replaceAll("<", "\\u003c");
      document.body.appendChild(capture);
    };
    void publishCapture().catch(() => {});
    return () => {
      controller.abort();
      capture?.remove();
    };
  }, [activeEspnTabId, auditPublisherAuthorized, auditPublisherVersion, authenticatedImportAt, authoritativePicks, espnPlayers, extension, league]);

  useEffect(() => {
    espnPlayersRef.current = espnPlayers;
  }, [espnPlayers]);

  useEffect(() => {
    if (workspaceRole !== "writer" || league.id === "demo" || extension !== "connected") return;
    activeLeagueRef.current = league.id;
    activeLeagueSettingsRef.current = league;
    // Persist a snapshot whenever ESPN sends new draft state so league switches stay isolated.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setProfiles((current) => upsertDraftProfile(current, { league, espnPlayers, picks: authoritativePicks, settingsConfirmed, strategy, savedAt: new Date().toISOString() }));
  }, [league, espnPlayers, authoritativePicks, settingsConfirmed, strategy, extension, workspaceRole]);

  useEffect(() => {
    if (workspaceRole !== "writer" || league.id === "demo" || extension !== "connected") return;
    const refreshExactDraftTab = () => {
      const expectedTabId = activeEspnTabRef.current;
      if (!Number.isInteger(expectedTabId)) return;
      sendToExtension("REFRESH_ESPN_CONTEXT", {
        commandCenterSessionId: COMMAND_CENTER_PUBLISHER.sessionId,
        expectedLeagueId: league.id,
        expectedTeamId: activeEspnTeamRef.current,
        expectedTabId,
      });
    };
    refreshExactDraftTab();
    const refreshTimer = window.setInterval(refreshExactDraftTab, EXACT_TAB_WATCHDOG_MS);
    return () => window.clearInterval(refreshTimer);
  }, [extension, league.id, workspaceRole]);

  useEffect(() => {
    if (!league.teamId || !Array.isArray(context.ownRoster)) return;
    // ESPN's visible roster is an external source of truth for submitted picks.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setPicks((current) => {
      const reconciled = reconcileEspnPicks(current, context, league.teamId, espnPlayers, league);
      const unchanged = reconciled.length === current.length && reconciled.every((pick, index) => (
        pick.playerId === current[index]?.playerId && pick.teamId === current[index]?.teamId && pick.amount === current[index]?.amount
      ));
      return unchanged ? current : reconciled;
    });
    const ownRoster = resolveOwnRoster(context, espnPlayers);
    const pendingAuctionBid = pendingAuctionBidRef.current;
    if (pendingAuctionBid) {
      const wonPlayer = ownRoster.some((entry) => entry.playerId === pendingAuctionBid.playerId);
      if (wonPlayer) {
        // The live ESPN roster is authoritative, but the corresponding action
        // result still owns its telemetry lifecycle. Do not invalidate or drop
        // the slower acknowledgement when roster reconciliation wins the race.
        pendingAuctionBidRef.current = null;
        pendingAuctionNominationRef.current = null;
        setPendingAuctionNomination(null);
        setActionState(`ESPN confirmed ${pendingAuctionBid.playerName} on your roster.`);
      } else {
        const nomineeChanged = Boolean(context.nominatedPlayer)
          && normalizeName(context.nominatedPlayer) !== normalizeName(pendingAuctionBid.playerName);
        const wasAlreadyOwned = pendingAuctionBid.beforeRosterPlayerIds.includes(pendingAuctionBid.playerId);
        if (nomineeChanged || wasAlreadyOwned) pendingAuctionBidRef.current = null;
      }
    }
    const pending = pendingSnakeActionRef.current;
    if (!pending) return;
    const confirmed = ownRoster.some((entry) => entry.playerId === pending.playerId);
    const pickAdvanced = Number(context.currentPick || 0) > pending.expectedPick;
    const previousRoster = new Set(pending.beforeRosterPlayerIds);
    const newOwnRoster = ownRoster.filter((entry) => !previousRoster.has(entry.playerId));
    if (!confirmed && pickAdvanced && Date.now() - pending.sentAt >= ESPN_ROSTER_CONFIRMATION_GRACE_MS) {
      pending.failed = true;
      setPicks((current) => current.filter((pick) => pick.playerId !== pending.playerId));
      setAutoDraft(false);
      const unexpected = newOwnRoster.length === 1
        ? espnPlayers.find((player) => player.id === newOwnRoster[0].playerId)?.name || "another player"
        : null;
      setActionState(unexpected
        ? `Action stopped: ESPN added ${unexpected} instead of DraftForge's intended ${pending.playerName} selection (possible Autopick).`
        : `Action stopped: ESPN did not confirm ${pending.playerName} on your roster.`);
    }
  }, [context, espnPlayers, league, setAutoDraft]);

  useEffect(() => {
    const pending = pendingSnakeActionRef.current;
    if (!pending || pending.failed || !league.teamId) return;
    const confirmedInContext = resolveOwnRoster(context, espnPlayers).some((entry) => entry.playerId === pending.playerId);
    const confirmedInPicks = picks.some((pick) => pick.playerId === pending.playerId && pick.teamId === league.teamId);
    if (confirmedInContext && confirmedInPicks) pendingSnakeActionRef.current = null;
  }, [context, espnPlayers, league.teamId, picks]);

  useEffect(() => {
    if (!autoDraft && pendingSnakeActionRef.current?.failed) pendingSnakeActionRef.current = null;
  }, [autoDraft]);

  useEffect(() => {
    if (workspaceRole !== "writer" || !autoDraft || context.inDraftRoom !== true || context.autopickActive === false) return;
    // ESPN Autopick is authoritative external state. Mirror its emergency
    // shutdown synchronously so no later action effect can remain armed.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setAutoDraft(false);
    setActionState(context.autopickActive === true
      ? "Action stopped: ESPN Autopick became active. This draft is excluded from verification."
      : "Action stopped: ESPN Autopick state became unknown. DraftForge will not submit until ESPN proves it is off.");
    const expectedTabId = activeEspnTabRef.current;
    if (context.autopickActive === true && Number.isInteger(expectedTabId)) {
      sendToExtension("DISABLE_ESPN_AUTOPICK", {
        commandCenterSessionId: COMMAND_CENTER_PUBLISHER.sessionId,
        expectedLeagueId: league.id,
        expectedTabId,
      });
    }
  }, [autoDraft, context.autopickActive, context.inDraftRoom, league.id, setAutoDraft, workspaceRole]);

  const sourceQuarterbackMode = intelligenceQuarterbackMode(league.lineupSlotCounts);
  const activeIntelligenceSnapshotKey = intelligenceSnapshotCacheKey(
    league.scoringLabel,
    league.size,
    league.season,
    sourceQuarterbackMode,
  );
  useEffect(() => {
    if (league.id === "demo") {
      const previewTimer = window.setTimeout(() => {
        setIntelligenceSnapshot(null);
        dispatchUi({ type: "set", key: "intelligenceLoading", value: false });
      }, 0);
      return () => window.clearTimeout(previewTimer);
    }
    let cancelled = false;
    let refreshInFlight = false;
    const qbs = sourceQuarterbackMode;
    const intelligenceKey = activeIntelligenceSnapshotKey;
    const expectedProfile = { scoring: league.scoringLabel, teams: league.size, season: league.season, qbs };
    const cachedSnapshot = intelligenceSnapshotsRef.current.get(intelligenceKey) ?? null;
    if (acceptedIntelligenceSnapshotFresh(cachedSnapshot, Date.now(), intelligenceKey)) {
      setIntelligenceSnapshot(cachedSnapshot);
    } else {
      intelligenceSnapshotsRef.current.delete(intelligenceKey);
      setIntelligenceSnapshot(null);
    }
    const refreshIntelligence = async () => {
      if (refreshInFlight) return;
      refreshInFlight = true;
      const controller = new AbortController();
      const deadline = window.setTimeout(() => controller.abort(), INTELLIGENCE_REFRESH_TIMEOUT_MS);
      try {
        const response = await fetch("/api/draft-day", {
          method: "POST",
          headers: { Accept: "application/json", "Content-Type": "application/json" },
          body: JSON.stringify({
            operation: "WARM",
            profile: expectedProfile,
            includeSourceSnapshot: true,
          }),
          cache: "no-store",
          signal: controller.signal,
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const accepted = acceptDraftDayWarmResponse(await response.json(), expectedProfile);
        if (cancelled || !accepted) return;
        const cached = intelligenceSnapshotsRef.current.get(intelligenceKey) ?? null;
        const newest = newestAcceptedIntelligenceSnapshot(cached, accepted);
        intelligenceSnapshotsRef.current.set(intelligenceKey, newest);
        setSourceFreshnessEvaluatedAt(Date.now());
        if (decisionSourceFreezeRef.current) {
          deferredIntelligenceSnapshotRef.current = newestAcceptedIntelligenceSnapshot(
            deferredIntelligenceSnapshotRef.current,
            newest,
          );
          return;
        }
        setIntelligenceSnapshot((current) => newestAcceptedIntelligenceSnapshot(current, newest));
      } catch {
        // Preserve only a still-fresh, atomically validated source envelope.
      } finally {
        window.clearTimeout(deadline);
        refreshInFlight = false;
        if (!cancelled) dispatchUi({ type: "set", key: "intelligenceLoading", value: false });
      }
    };
    // Every imported draft gets a fresh, non-blocking source snapshot. Long
    // drafts refresh in the background without putting a network call on the clock.
    dispatchUi({ type: "set", key: "intelligenceLoading", value: true });
    void refreshIntelligence();
    const refreshTimer = window.setInterval(refreshIntelligence, INTELLIGENCE_REFRESH_MS);
    return () => {
      cancelled = true;
      window.clearInterval(refreshTimer);
    };
  }, [activeIntelligenceSnapshotKey, league.id, league.scoringLabel, league.size, league.season, sourceQuarterbackMode]);

  useEffect(() => {
    if (!intelligenceSnapshot) return;
    const expiresAt = Date.parse(intelligenceSnapshot.sourceSnapshotGeneratedAt)
      + MAX_DRAFT_AUDIT_SOURCE_SNAPSHOT_AGE_MS;
    const delayMs = Math.min(
      MAX_DRAFT_AUDIT_SOURCE_SNAPSHOT_AGE_MS + INTELLIGENCE_SOURCE_FUTURE_SKEW_MS,
      Math.max(0, expiresAt - Date.now() + 1),
    );
    const expirationTimer = window.setTimeout(() => setSourceFreshnessEvaluatedAt(Date.now()), delayMs);
    return () => window.clearTimeout(expirationTimer);
  }, [intelligenceSnapshot]);

  useEffect(() => {
    if (league.id === "demo") return;
    let cancelled = false;
    const refreshAvailability = async () => {
      try {
        const response = await fetch(AVAILABILITY_STAGE_PATH, { cache: "no-store" });
        const staged = await response.json().catch(() => null) as {
          artifact?: unknown;
          policy?: unknown;
          stagedAt?: string;
        } | null;
        if ((!response.ok && response.status !== 409) || !staged?.artifact || !staged?.policy) {
          throw new Error("AVAILABILITY_STAGE_MISSING");
        }
        if (!cancelled) {
          setAvailabilityTransportDegraded(false);
          setAvailabilityStage({
            artifact: staged.artifact,
            policy: staged.policy,
            stagedAt: String(staged.stagedAt || new Date().toISOString()),
          });
        }
      } catch {
        // Keep a still-fresh, previously validated artifact visible through a
        // transient loopback read failure. The action-time fetch below remains
        // mandatory and fail closed, so this cannot authorize a click from
        // cached evidence after its exact freshUntil deadline.
        if (!cancelled) setAvailabilityTransportDegraded(true);
      }
    };
    void refreshAvailability();
    const refreshTimer = window.setInterval(() => void refreshAvailability(), AVAILABILITY_REFRESH_MS);
    return () => {
      cancelled = true;
      window.clearInterval(refreshTimer);
    };
  }, [league.id]);

  const players = useMemo(() => mergeConsensus(espnPlayers, sources, league), [espnPlayers, sources, league]);
  const playerPool = useMemo(() => buildPlayerPoolIndex(players, league), [players, league]);

  const recommendationPick = league.draftType === "SNAKE" && Number(context.currentPick) > 0 ? Number(context.currentPick) : authoritativePicks.length + 1;
  const decision = useMemo(
    () => buildDraftDecision(players, authoritativePicks, league, strategy, recommendationPick, context.auctionBudgets, playerPool),
    [players, authoritativePicks, league, strategy, recommendationPick, context.auctionBudgets, playerPool],
  );
  const recommendations = decision.recommendations;
  const currentSleeperEvidence = useMemo(() => recommendations
    .filter((player) => player.sleeperLabel !== "NONE")
    .slice(0, 20)
    .map((player) => ({
      playerId: player.id,
      playerName: player.name,
      position: player.pos,
      adp: Number(player.adp),
      label: player.sleeperLabel as "VALUE" | "SLEEPER" | "DEEP_STASH",
      score: Number(player.sleeperScore),
      modelMarketEdge: Number(player.modelMarketEdge || 0),
      modelSpread: Number(player.modelSpread || 0),
      sourceCount: Number(player.sourceCount || 0),
    })), [recommendations]);
  const remainingRosterSlots = Math.max(0, league.rosterSize - authoritativePicks.filter((pick) => pick.teamId === league.teamId).length);
  const baseLiveRecommendations = useMemo(
    () => liveEspnRecommendations(recommendations, context, rejectedSnakePlayerIds, remainingRosterSlots),
    [context, recommendations, rejectedSnakePlayerIds, remainingRosterSlots],
  );
  const nominated = context.nominatedPlayer ? resolveEspnNominatedPlayer(recommendations, context) : undefined;
  const availabilityActionablePlayerIds = useMemo(
    () => [...new Set([
      ...baseLiveRecommendations.slice(0, ACTION_CANDIDATE_LIMIT).map((player) => player.id),
      ...(nominated ? [nominated.id] : []),
    ])],
    [baseLiveRecommendations, nominated],
  );
  const ownedPicksForAvailability = useMemo(
    () => authoritativePicks.filter((pick) => pick.teamId === league.teamId),
    [authoritativePicks, league.teamId],
  );
  const rosterPositionsForAvailability = useMemo(
    () => ownedPicksForAvailability.flatMap((pick) => {
      const player = playerPool.playerById.get(pick.playerId);
      return player ? [player.pos] : [];
    }),
    [ownedPicksForAvailability, playerPool.playerById],
  );
  useEffect(() => {
    const artifactEvaluation = evaluateAvailabilityGate({
      artifact: availabilityStage?.artifact ?? null,
      policy: availabilityStage?.policy ?? null,
      players: espnPlayers,
      actionablePlayerIds: availabilityActionablePlayerIds,
      evaluatedAt: new Date().toISOString(),
    });
    const evaluated = enforceAvailabilityRosterFeasibility(
      artifactEvaluation,
      evaluateRosterCompletionFeasibility({
        league,
        currentRosterCount: ownedPicksForAvailability.length,
        rosterPositions: rosterPositionsForAvailability,
        availablePlayers: recommendations,
        vetoedPlayerIds: artifactEvaluation.vetoedPlayerIds,
      }),
    );
    if (availabilityDecisionFreezeRef.current) {
      deferredAvailabilityGateRef.current = evaluated;
      return;
    }
    const evaluationTimer = window.setTimeout(() => {
      availabilityGateRef.current = evaluated;
      setAvailabilityGate(evaluated);
    }, 0);
    return () => window.clearTimeout(evaluationTimer);
  }, [availabilityActionablePlayerIds, availabilityStage, espnPlayers, league, ownedPicksForAvailability.length, recommendations, rosterPositionsForAvailability]);
  const liveRecommendations = useMemo(
    () => excludeAvailabilityVetoes(baseLiveRecommendations, availabilityGate),
    [availabilityGate, baseLiveRecommendations],
  );
  const auctionPlan = decision.auctionPlan;
  const auctionUsage = auctionBudgetUsage(auctionPlan);
  const auctionNomination = useMemo(
    () => chooseAuctionNomination(liveRecommendations, league, auctionPlan),
    [liveRecommendations, league, auctionPlan],
  );
  const selected = liveRecommendations.find((player) => player.id === selectedId) || liveRecommendations[0];
  const nominatedAvailabilityVetoed = Boolean(
    nominated && availabilityGate.vetoedPlayerIds.includes(nominated.id),
  );
  const ownNominationIntent = resolveOwnNominationIntent(context, nominated, pendingAuctionNomination);
  useEffect(() => {
    if (league.draftType !== "AUCTION") return;
    const contextIntent = ["TARGET", "DRAIN"].includes(String(context.ownNominationIntent || ""))
      ? context.ownNominationIntent as "TARGET" | "DRAIN"
      : null;
    const contextPlayerId = Number(context.ownNominationPlayerId);
    if (contextIntent && nominated && contextPlayerId === nominated.id) {
      const hydrated = { playerId: nominated.id, playerName: nominated.name, intent: contextIntent };
      const current = pendingAuctionNominationRef.current;
      if (!current || current.playerId !== hydrated.playerId || current.intent !== hydrated.intent) {
        pendingAuctionNominationRef.current = hydrated;
        setPendingAuctionNomination(hydrated);
      }
      return;
    }
    const pending = pendingAuctionNominationRef.current;
    if (!pending) return;
    const nomineeChanged = Boolean(nominated
      && nominated.id !== pending.playerId
      && normalizeName(nominated.name) !== normalizeName(pending.playerName));
    const saleRecorded = authoritativePicks.some((pick) => pick.playerId === pending.playerId);
    if (nomineeChanged || saleRecorded) {
      pendingAuctionNominationRef.current = null;
      setPendingAuctionNomination(null);
    }
  }, [authoritativePicks, context.ownNominationIntent, context.ownNominationPlayerId, league.draftType, nominated]);
  useEffect(() => {
    if (league.draftType !== "AUCTION" || !nominated) return;
    salaryCapDecisionObservationsRef.current.set(nominated.id, observeSalaryCapDecision(
      salaryCapDecisionObservationsRef.current.get(nominated.id),
      nominated,
      Number(context.currentBid || 0),
      ownNominationIntent,
    ));
  }, [context.currentBid, league.draftType, nominated, ownNominationIntent]);
  const focusPlayer = league.draftType === "AUCTION" && nominated
    ? nominated
    : league.draftType === "AUCTION" && auctionNomination
      ? auctionNomination.player
      : selected;
  const nextBid = focusPlayer ? Math.max(1, Number(context.currentBid || 0) + 1) : 1;
  const liveEspnBidCeiling = Number(context.maxLegalBid);
  const exactLiveBidCeiling = league.draftType === "AUCTION" && nominated && focusPlayer
    ? Number.isSafeInteger(liveEspnBidCeiling) && liveEspnBidCeiling >= 0
      ? Math.min(Math.max(0, Math.trunc(Number(focusPlayer.maxBid || 0))), liveEspnBidCeiling)
      : 0
    : focusPlayer?.maxBid || 0;
  const draftedIds = useMemo(() => new Set(authoritativePicks.map((pick) => pick.playerId)), [authoritativePicks]);
  const normalizedQuery = query.toLowerCase();
  const visible = liveRecommendations.filter((player) =>
    (filter === "ALL" || player.pos === filter) && `${player.name} ${player.team}`.toLowerCase().includes(normalizedQuery)
  );
  const myPicks = useMemo(
    () => authoritativePicks.filter((pick) => pick.teamId === league.teamId),
    [authoritativePicks, league.teamId],
  );
  const myPickCount = myPicks.length;
  useEffect(() => {
    const rosterStatusKey = `${league.id}:${activeEspnTabId ?? "none"}:${myPickCount}`;
    if (lastRosterStatusKeyRef.current === rosterStatusKey) return;
    lastRosterStatusKeyRef.current = rosterStatusKey;
    if (context.inDraftRoom !== true || myPickCount <= 0 || myPickCount >= league.rosterSize) return;
    // Roster reconciliation is authoritative even when a rapid ESPN action
    // result arrives out of order. Keep the command status aligned with the
    // visible roster instead of leaving an older player confirmation behind.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setActionState(`ESPN confirmed roster ${myPickCount}/${league.rosterSize}. Recommendations and roster needs updated.`);
  }, [activeEspnTabId, context.inDraftRoom, league.id, league.rosterSize, myPickCount]);
  const myRoster = useMemo(
    () => myPicks
      .map((pick) => ({ pick, player: playerPool.playerById.get(pick.playerId) }))
      .filter((item) => item.player) as { pick: DraftPick; player: DraftPlayer }[],
    [myPicks, playerPool.playerById],
  );
  useEffect(() => {
    if (!liveControlRef.current || liveControlBlockedRef.current || context.inDraftRoom !== true) return;
    const binding = draftAuditChecklistBindingKey(league.id, Number(league.teamId), Number(activeEspnTabId));
    if (!binding || liveControlBindingRef.current !== binding) return;
    const actions = [...liveControlActionsRef.current.values()];
    for (const { pick, player } of myRoster) {
      if (liveControlObservedRosterRef.current.has(player.id)) continue;
      const action = actions.findLast((candidate) => (
        candidate.resolvedPlayer?.playerId === player.id || candidate.intendedPlayer.playerId === player.id
      ) && (
        (candidate.operation === "SELECT" && candidate.phase === "ROSTER_CONFIRMED")
        || (league.draftType === "AUCTION"
          && ["BID", "NOMINATE"].includes(candidate.operation)
          && candidate.phase === "ACTION_COMPLETED"
          && Number(candidate.resolvedOffer ?? candidate.intendedOffer) === Number(pick.amount))
      ));
      // Never infer a user-manual pick merely because DraftForge is disarmed.
      // Without an explicit DraftForge action envelope the addition is
      // uncontrolled; preserve the stronger ESPN Autopick attribution when
      // that condition was observed at any point in this control session.
      const attribution: LiveRosterAttributionKind = action
        ? "DRAFTFORGE_CONFIRMED"
        : context.autopickActive === true || liveControlRef.current.historicalAutopickDetected
          ? "ESPN_AUTOPICK"
          : "UNKNOWN_EXTERNAL";
      attributeLiveRosterPlayer(livePlayerIdentity(player), attribution, action);
    }
  }, [actionInFlight, activeEspnTabId, attributeLiveRosterPlayer, autoDraft, context.autopickActive, context.inDraftRoom, league.draftType, league.id, league.teamId, myRoster]);
  const currentPick = recommendationPick;
  const currentRound = league.draftType === "SNAKE" ? Math.floor((Math.max(1, currentPick) - 1) / league.size) + 1 : null;
  const remainingSeconds = typeof context.remainingSeconds === "number" ? context.remainingSeconds : Number.NaN;
  const minimumActionWindow = league.draftType === "SNAKE" ? MIN_SNAKE_SELECTION_WINDOW_SECONDS : MIN_OTHER_ACTION_WINDOW_SECONDS;
  const healthySources = useMemo(() => sources.filter(isIntelligenceSourceFresh), [sources]);
  const sourceCoverageReady = acceptedIntelligenceSnapshotFresh(
    intelligenceSnapshot,
    sourceFreshnessEvaluatedAt,
    activeIntelligenceSnapshotKey,
  );
  useEffect(() => {
    if (!sourceCoverageReady || !intelligenceSnapshot) {
      if (sourceSnapshotIdRef.current === "sources-unavailable" && sourceSnapshotObservedAtRef.current === null) return;
      sourceSnapshotIdRef.current = "sources-unavailable";
      sourceSnapshotObservedAtRef.current = null;
      updateLiveControlFreshness({ sourceSnapshotAt: null });
      return;
    }
    if (sourceSnapshotIdRef.current === intelligenceSnapshot.sourceSnapshotId
      && sourceSnapshotObservedAtRef.current === intelligenceSnapshot.sourceSnapshotGeneratedAt) return;
    sourceSnapshotIdRef.current = intelligenceSnapshot.sourceSnapshotId;
    sourceSnapshotObservedAtRef.current = intelligenceSnapshot.sourceSnapshotGeneratedAt;
    updateLiveControlFreshness({ sourceSnapshotAt: intelligenceSnapshot.sourceSnapshotGeneratedAt });
  }, [intelligenceSnapshot, sourceCoverageReady, updateLiveControlFreshness]);
  const pickFeedHealthy = pickFeedHealth.fresh && !pickFeedHealth.lagging;
  const actionWindowOpen = workspaceRole === "writer" && sourceCoverageReady && pickFeedHealthy && availabilityGate.armingAllowed && context.actionSurfaceReady === true && context.autopickActive === false && Boolean(context.onClock) && Number.isFinite(remainingSeconds) && remainingSeconds >= minimumActionWindow;
  const bidWindowOpen = workspaceRole === "writer"
    && sourceCoverageReady
    && pickFeedHealthy
    && availabilityGate.armingAllowed
    && context.auctionOfferReady === true
    && context.auctionTransactionMode === "OFFER"
    && context.auctionTransactionReady === true
    && context.auctionSettlementPending !== true
    && context.autopickActive === false
    && context.leadingBid === false
    && Number.isFinite(remainingSeconds)
    && remainingSeconds >= MIN_OTHER_ACTION_WINDOW_SECONDS;
  const decisionSourceFrozen = Boolean(
    actionInFlight
    || (league.draftType === "SNAKE" && context.onClock === true)
    || (league.draftType === "AUCTION" && (context.onClock === true || context.nominatedPlayer || Number(context.currentBid || 0) > 0)),
  );
  useEffect(() => {
    decisionSourceFreezeRef.current = decisionSourceFrozen;
    availabilityDecisionFreezeRef.current = actionInFlight;
    if (!decisionSourceFrozen && deferredIntelligenceSnapshotRef.current) {
      const deferred = deferredIntelligenceSnapshotRef.current;
      deferredIntelligenceSnapshotRef.current = null;
      const key = activeIntelligenceSnapshotKey;
      setIntelligenceSnapshot((current) => {
        const next = newestAcceptedIntelligenceSnapshot(current, deferred);
        intelligenceSnapshotsRef.current.set(key, next);
        return next;
      });
    }
    if (!actionInFlight && deferredAvailabilityGateRef.current) {
      const deferredAvailability = deferredAvailabilityGateRef.current;
      deferredAvailabilityGateRef.current = null;
      availabilityGateRef.current = deferredAvailability;
      setAvailabilityGate(deferredAvailability);
    }
  }, [actionInFlight, activeIntelligenceSnapshotKey, decisionSourceFrozen]);
  const spent = myPicks.reduce((sum, pick) => sum + pick.amount, 0);
  const strategyInfo = STRATEGIES.find((item) => item.id === strategy) || STRATEGIES[0];
  const preflightChecks = [
    { label: "This dashboard holds the single browser-control writer lease", ok: workspaceRole === "writer" },
    { label: `Exact ESPN league ${league.id} and team ${league.teamId || "—"}`, ok: league.id !== "demo" && Number(league.teamId) > 0 },
    { label: `${league.draftType === "AUCTION" ? `$${league.auctionBudget} salary cap` : "Snake order"}, ${league.size} teams, ${league.rosterSize} draftable slots`, ok: league.size > 1 && league.rosterSize > 0 && rosterSlots(league).length === league.rosterSize },
    { label: `${league.scoringLabel} scoring and ${league.scoringRules} ESPN scoring rules`, ok: Boolean(league.scoringLabel) && league.scoringRules > 0 },
    { label: `${espnPlayers.length} ESPN players with projections/market values`, ok: espnPlayers.length >= league.size * league.rosterSize },
    { label: `${healthySources.length + 1}/5 fresh deterministic sources`, ok: healthySources.length === 4 },
    { label: `Availability veto ${availabilityGate.status.toLowerCase()}${availabilityTransportDegraded ? " · cached (live read degraded)" : ""} · ${availabilityGate.digest.slice(0, 15)}…`, ok: availabilityGate.armingAllowed },
    { label: "Companion-managed one-dashboard workspace cleanup", ok: runtimeDiagnostics?.managedCleanupReady === true },
    { label: `${strategyInfo.label} strategy and ${league.draftType === "AUCTION" ? "$" + Object.values(auctionPlan.positionBudgets).reduce((sum, amount) => sum + amount, 0) + " planned" : "position priorities"}`, ok: league.draftType !== "AUCTION" || Object.values(auctionPlan.positionBudgets).reduce((sum, amount) => sum + amount, 0) === league.auctionBudget },
  ];
  const preflightReady = preflightChecks.every((check) => check.ok);
  const liveChecks = [
    { label: "Single DraftForge writer is bound; observer tabs are read-only", ok: workspaceRole === "writer" },
    { label: "Exact imported league and team are bound to one ESPN draft tab", ok: context.inDraftRoom === true && String(context.leagueId) === String(league.id) && Number(context.teamId) === Number(league.teamId) },
    { label: "Live player pool, roster, timer, and action controls resolved", ok: Boolean(context.actionSurfaceReady && context.availablePlayerIds?.length && Array.isArray(context.ownRoster) && Number.isFinite(context.remainingSeconds)) },
    { label: "Authenticated ESPN pick/sale feed is current and reconciled", ok: pickFeedHealthy },
    {
      label: context.soundMuted === true
        ? "ESPN audio is muted · operator preference only"
        : context.soundMuted === false
          ? "ESPN audio is on · operator preference only"
          : "ESPN audio state is not reported · operator preference only",
      ok: true,
    },
    { label: "ESPN Autopick is off", ok: context.inDraftRoom === true && context.autopickActive === false },
    { label: "No-click dry run resolves the top legal recommendation", ok: context.inDraftRoom === true && Boolean(context.availablePlayerIds?.length) && Boolean(liveRecommendations[0]) },
    { label: "Command-center audit publisher holds a current server acknowledgment", ok: auditPublisherAuthorized },
  ];
  const liveChecklistReady = settingsConfirmed && preflightReady && liveChecks.every((check) => check.ok);
  useEffect(() => {
    if (!liveControlRef.current || liveControlBlockedRef.current) return;
    const exactBinding = draftAuditChecklistBindingKey(league.id, Number(league.teamId), Number(activeEspnTabId));
    const statuses: Array<{
      condition: "ESPN_AUTOPICK" | "SOURCE_COVERAGE" | "EXACT_BINDING" | "CLOCK" | "ACTION_SURFACE" | "CODE_FREEZE";
      active: boolean;
      code: string;
    }> = [
      {
        condition: "SOURCE_COVERAGE",
        active: !sourceCoverageReady,
        code: sourceCoverageReady ? "FIVE_SOURCE_COVERAGE_READY" : "FIVE_SOURCE_COVERAGE_BLOCKED",
      },
      {
        condition: "EXACT_BINDING",
        active: !exactBinding || liveControlBindingRef.current !== exactBinding,
        code: exactBinding && liveControlBindingRef.current === exactBinding ? "EXACT_BINDING_READY" : "EXACT_BINDING_BLOCKED",
      },
      {
        condition: "CLOCK",
        active: context.onClock === true && (!Number.isFinite(remainingSeconds) || remainingSeconds < minimumActionWindow),
        code: context.onClock !== true
          ? "CLOCK_NOT_ACTIONABLE"
          : Number.isFinite(remainingSeconds) && remainingSeconds >= minimumActionWindow
            ? "CLOCK_SAFE"
            : "CLOCK_UNSAFE",
      },
      {
        condition: "ACTION_SURFACE",
        active: context.inDraftRoom === true && context.actionSurfaceReady !== true,
        code: context.actionSurfaceReady === true ? "ACTION_SURFACE_READY" : "ACTION_SURFACE_BLOCKED",
      },
      { condition: "CODE_FREEZE", active: false, code: "CODE_FREEZE_ENFORCED" },
    ];
    if (context.autopickActive !== undefined) {
      statuses.unshift({
        condition: "ESPN_AUTOPICK",
        active: context.autopickActive === true,
        code: context.autopickActive === true ? "ESPN_AUTOPICK_ACTIVE" : "ESPN_AUTOPICK_OFF",
      });
    }
    for (const status of statuses) {
      const key = status.condition;
      if (liveControlSafetyRef.current.get(key) === status.active) continue;
      const accepted = transitionLiveControl({
        kind: "SAFETY",
        occurredAt: new Date().toISOString(),
        condition: status.condition,
        active: status.active,
        code: status.code,
      });
      if (accepted) liveControlSafetyRef.current.set(key, status.active);
      else break;
    }
  }, [activeEspnTabId, context.actionSurfaceReady, context.autopickActive, context.inDraftRoom, context.onClock, league.id, league.teamId, minimumActionWindow, remainingSeconds, sourceCoverageReady, transitionLiveControl]);
  useEffect(() => {
    if (workspaceRole !== "writer" || !pendingLiveRoomAutoArmRef.current || !liveChecklistReady || extension !== "connected") return;
    const expectedTabId = activeEspnTabRef.current;
    // Consume the one-shot handoff intent before the asynchronous exact-tab
    // verification so no render or response can arm it twice.
    pendingLiveRoomAutoArmRef.current = false;
    if (!Number.isInteger(expectedTabId)) {
      setAutoDraft(false);
      dispatchUi({ type: "set", key: "settingsOpen", value: true });
      setActionState("Auto-Draft locked: the verified live-room tab disappeared during handoff.");
      return;
    }
    const requestId = ++autoArmRequestSequenceRef.current;
    pendingAutoArmRequestRef.current = requestId;
    setAutoDraft(false);
    setActionState("Revalidating the exact ESPN draft tab before the opening pick…");
    sendToExtension("REFRESH_ESPN_CONTEXT", {
      commandCenterSessionId: COMMAND_CENTER_PUBLISHER.sessionId,
      expectedLeagueId: league.id,
      expectedTeamId: activeEspnTeamRef.current,
      expectedTabId,
      autoArmRequestId: requestId,
    });
  }, [liveChecklistReady, extension, league.id, setAutoDraft, workspaceRole]);
  useEffect(() => {
    if (!autoArmVerification) return;
    const availabilityFreshUntil = Date.parse(availabilityGateRef.current.freshUntil || "");
    const availabilityReadyAtArm = availabilityGateRef.current.armingAllowed
      && Number.isFinite(availabilityFreshUntil)
      && availabilityFreshUntil > Date.now();
    const requestIsCurrent = autoArmVerification.requestId === pendingAutoArmRequestRef.current;
    const publisherBinding = draftAuditPublisherBinding(
      liveControlRef.current,
      league.id,
      Number(league.teamId),
      activeEspnTabRef.current,
    );
    const publisherReady = Boolean(publisherBinding)
      && draftAuditPublisherRef.current?.isAuthorized(publisherBinding as DraftAuditPublisherBinding) === true;
    const armReady = requestIsCurrent && availabilityReadyAtArm && publisherReady && canArmAutoDraft({
      checklistReady: liveChecklistReady,
      extensionConnected: extension === "connected",
      context: autoArmVerification.context,
      leagueId: league.id,
      teamId: league.teamId,
      tabId: activeEspnTabRef.current,
    });
    pendingAutoArmRequestRef.current = null;
    // The exact-tab response is an external verification result; consume it once.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setAutoArmVerification(null);
    if (!armReady) {
      setAutoDraft(false);
      dispatchUi({ type: "set", key: "settingsOpen", value: true });
      setActionState("Auto-Draft locked: ESPN room state changed during verification. Rerun the exact live-room checklist.");
      return;
    }
    setAutoDraft(true);
    setActionState("Auto-Draft armed after the exact ESPN tab and live-room checks were revalidated.");
  }, [autoArmVerification, extension, league.id, league.teamId, liveChecklistReady, setAutoDraft]);

  useEffect(() => {
    if (!autoDraft || sourceCoverageReady || myPickCount >= league.rosterSize) return;
    // Source coverage is an action-time invariant, not only a pre-draft
    // checklist. Disarm immediately if the last validated snapshot expires.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setAutoDraft(false);
    setActionState("Action stopped: five-source intelligence is no longer fresh and complete. Refresh sources, re-check the room, and re-enable Auto-Draft.");
  }, [autoDraft, league.rosterSize, myPickCount, setAutoDraft, sourceCoverageReady]);

  useEffect(() => {
    if (!autoDraft || myPickCount >= league.rosterSize) {
      pickFeedPausedRef.current = false;
      return;
    }
    if (!pickFeedHealthy) {
      if (!pickFeedPausedRef.current) {
        pickFeedPausedRef.current = true;
        setActionState("Auto-Draft paused: the authenticated ESPN pick/sale feed is stale or behind the visible room. It will resume only after the exact feed catches up; no action can be sent while paused.");
      }
      return;
    }
    if (pickFeedPausedRef.current) {
      pickFeedPausedRef.current = false;
      setActionRetryNonce((nonce) => nonce + 1);
      setActionState("Authenticated ESPN pick/sale feed caught up. Re-evaluating the exact live room now.");
    }
  }, [autoDraft, league.rosterSize, myPickCount, pickFeedHealthy]);

  useEffect(() => {
    if (!autoDraft) return;
    const freshUntil = Date.parse(availabilityGate.freshUntil || "");
    const now = Date.now();
    const delay = availabilityGate.armingAllowed && Number.isFinite(freshUntil)
      ? Math.max(0, freshUntil - now)
      : 0;
    const disarmTimer = window.setTimeout(() => {
      setAutoDraft(false);
      setActionState("Action stopped: the availability veto artifact is missing, invalid, or stale. No ESPN action will be sent.");
    }, delay);
    return () => window.clearTimeout(disarmTimer);
  }, [autoDraft, availabilityGate, setAutoDraft]);

  function connect() {
    if (workspaceRoleRef.current !== "writer") {
      setAutoDraft(false);
      setActionState("Read-only observer: only the original command center can connect or control ESPN.");
      return;
    }
    setExtension("connecting");
    setActionState("Reading your signed-in ESPN league…");
    sendToExtension("CONNECT_ESPN", {
      commandCenterSessionId: COMMAND_CENTER_PUBLISHER.sessionId,
      ...(leagueId.trim() ? { leagueId: leagueId.trim() } : {}),
      season: league.season || new Date().getFullYear(),
    });
  }

  function confirmPreDraftChecklist() {
    if (workspaceRoleRef.current !== "writer") {
      setAutoDraft(false);
      setActionState("Read-only observer: the original command center owns live-room arming.");
      return;
    }
    setSettingsConfirmed(true);
    dispatchUi({ type: "set", key: "settingsOpen", value: false });
    if (context.inDraftRoom !== true) {
      sendToExtension("ARM_LIVE_ROOM_WATCH", {
        commandCenterSessionId: COMMAND_CENTER_PUBLISHER.sessionId,
        sourceLeagueId: league.id,
        sourceTabId: context.tabId,
        teamId: league.teamId,
        season: league.season,
        draftType: league.draftType,
        autoArmRequested: true,
      });
      setActionState("Pre-draft rules, sources, roster, and strategy confirmed. Auto-Draft will arm only after the exact live room passes every safety check.");
      return;
    }
    setActionState("Exact live-room rules, audio preference, player pool, roster, clock, and no-click dry run confirmed.");
  }

  const stageAutomaticSnakeDecision = useCallback((player: Recommendation, submitTargetSeconds: number) => {
    const expectedTabId = activeEspnTabRef.current;
    const latestContext = latestEspnContextRef.current;
    const latestClock = Number(latestContext.remainingSeconds);
    const contextCapturedAt = espnContextObservedAtRef.current;
    const sourceSnapshotId = sourceSnapshotIdRef.current;
    const exactBinding = draftAuditChecklistBindingKey(league.id, Number(league.teamId), Number(expectedTabId));
    if (workspaceRoleRef.current !== "writer"
      || league.draftType !== "SNAKE"
      || !sourceCoverageReady
      || !availabilityGateRef.current.armingAllowed
      || !Number.isInteger(expectedTabId)
      || !contextCapturedAt
      || !isDraftAuditSourceSnapshotId(sourceSnapshotId)
      || !liveControlRef.current
      || liveControlBlockedRef.current
      || liveControlBindingRef.current !== exactBinding
      || !contextMatchesActiveDraftTab(latestContext, league.id, Number(expectedTabId))
      || Number(latestContext.teamId) !== Number(league.teamId)
      || latestContext.inDraftRoom !== true
      || latestContext.autopickActive !== false
      || latestContext.actionSurfaceReady !== true
      || latestContext.onClock !== true
      || Number(latestContext.currentPick) !== currentPick
      || !Number.isFinite(latestClock)
      || latestClock < MIN_SNAKE_SELECTION_WINDOW_SECONDS) return null;

    const key = snakePlanKey({
      leagueId: league.id,
      teamId: Number(league.teamId),
      tabId: Number(expectedTabId),
      expectedPick: currentPick,
      playerId: player.id,
      sourceSnapshotId,
      availabilityDigest: availabilityGateRef.current.digest,
      submitTargetSeconds,
    });
    const existing = stagedSnakeDecisionRef.current;
    if (existing?.key === key) return existing;
    if (existing && !cancelStagedSnakeDecision("SNAKE_RECOMMENDATION_CHANGED")) return null;

    const actionRequestId = ++actionRequestSequenceRef.current;
    const actionId = `action-${actionRequestId}`;
    const decisionId = `decision-${actionRequestId}`;
    let availabilityDecision: AvailabilityDecisionSnapshot;
    try {
      availabilityDecision = createAvailabilityDecisionSnapshot({
        decisionKey: decisionId,
        evaluation: availabilityGateRef.current,
        player,
      });
    } catch {
      setAutoDraft(false);
      setActionState("Action stopped: the availability decision identity was invalid before snake planning.");
      return null;
    }
    if (!availabilityDecision.canAct) {
      setAutoDraft(false);
      setActionState(`Action stopped: ${player.name} is blocked by the current availability veto artifact.`);
      return null;
    }

    const timing = buildSnakePlanTiming(Date.now(), latestClock, submitTargetSeconds);
    const stagedNotAfter = availabilityBoundedActionDeadline(
      availabilityGateRef.current,
      SNAKE_ACTION_RESPONSE_BUDGET_MS,
      Date.parse(timing.submitNotBeforeAt),
    );
    if (stagedNotAfter === null) {
      setAutoDraft(false);
      setActionState("Action stopped: availability evidence does not cover the announced snake submission window.");
      return null;
    }
    const intendedPlayer = livePlayerIdentity(player);
    const decisionEnvelope: StagedSnakeDecision["decision"] = {
      decisionId,
      decidedAt: timing.decidedAt,
      contextCapturedAt,
      leagueId: league.id,
      teamId: Number(league.teamId),
      tabId: Number(expectedTabId),
      operation: "SELECT",
      sourceSnapshotId,
      availabilityDigest: availabilityDecision.availabilityDigest,
      availabilityDecisionDigest: availabilityDecision.decisionDigest,
      expectedPick: currentPick,
      submitNotBeforeAt: timing.submitNotBeforeAt,
      submitTargetSeconds: timing.submitTargetSeconds,
      notAfter: stagedNotAfter,
      intendedPlayer,
      alternatives: liveRecommendations
        .filter((candidate) => candidate.id !== player.id)
        .slice(0, 5)
        .map(livePlayerIdentity),
    };
    const action: PendingLiveAction = {
      actionId,
      decisionId,
      operation: "SELECT",
      intendedPlayer,
      phase: "PLANNED",
    };
    const planned = transitionLiveControl({
      kind: "ACTION_LIFECYCLE",
      occurredAt: timing.decidedAt,
      actionId,
      decisionId,
      operation: "SELECT",
      phase: "PLANNED",
      intendedPlayer,
      code: "AUTO_ACTION_PLANNED",
    }, { decision: decisionEnvelope });
    if (!planned) return null;

    const staged = { key, actionRequestId, action, decision: decisionEnvelope, availabilityDecision };
    stagedSnakeDecisionRef.current = staged;
    liveControlActionsRef.current.set(actionRequestId, action);
    while (liveControlActionsRef.current.size > MAX_DRAFT_ACTION_TELEMETRY_EVENTS) {
      const terminalEntry = [...liveControlActionsRef.current.entries()].find(([, candidate]) => (
        ["ROSTER_CONFIRMED", "ACTION_COMPLETED", "FAILED", "CANCELLED"].includes(candidate.phase)
      ));
      if (!terminalEntry) break;
      liveControlActionsRef.current.delete(terminalEntry[0]);
    }
    availabilityDecisionsRef.current.set(actionRequestId, availabilityDecision);
    setActionState(`Planned pick: ${player.name}. Auto-Draft will submit near ${submitTargetSeconds}s if the recommendation and safety checks remain valid.`);
    return staged;
  }, [cancelStagedSnakeDecision, currentPick, league.draftType, league.id, league.teamId, liveRecommendations, setAutoDraft, sourceCoverageReady, transitionLiveControl]);

  const submit = useCallback(async (player: Recommendation | undefined, automatic = false, operation?: "SELECT" | "NOMINATE" | "BID", amount?: number, nominationIntent: "TARGET" | "DRAIN" = "TARGET") => {
    if (workspaceRoleRef.current !== "writer") {
      setAutoDraft(false);
      setActionState("Read-only observer: this tab cannot submit picks, nominations, or bids.");
      return;
    }
    if (!player || !settingsConfirmed || extension !== "connected") {
      setActionState("Connect ESPN and confirm the imported rules first.");
      return;
    }
    if (!acceptedIntelligenceSnapshotFresh(intelligenceSnapshot, Date.now(), activeIntelligenceSnapshotKey)) {
      setAutoDraft(false);
      setActionState("Action stopped: five-source intelligence is no longer fresh and complete. No ESPN action was sent.");
      return;
    }
    if (!availabilityGateRef.current.armingAllowed) {
      setAutoDraft(false);
      setActionState(`Action stopped: availability veto gate is blocked (${availabilityGateRef.current.blockingReasons.join(", ") || "invalid or missing artifact"}).`);
      return;
    }
    if (myPickCount >= league.rosterSize) {
      setAutoDraft(false);
      setActionState("Draft complete: ESPN confirmed every roster spot. No further action was sent.");
      return;
    }
    const resolvedOperation = operation || (league.draftType === "AUCTION" ? "NOMINATE" : "SELECT");
    const requestedBidAmount = resolvedOperation === "BID"
      ? Math.max(1, Math.trunc(Number(amount ?? (Number(context.currentBid || 0) + 1))))
      : null;
    const sourceBidCeiling = resolvedOperation === "BID"
      ? Math.max(0, Math.trunc(Number(player.maxBid || 0)))
      : null;
    const initialEspnBidCeiling = Number(context.maxLegalBid);
    let exactApprovedBidCeiling = resolvedOperation === "BID"
      && Number.isSafeInteger(initialEspnBidCeiling)
      && initialEspnBidCeiling >= 0
      ? Math.min(Number(sourceBidCeiling), initialEspnBidCeiling)
      : null;
    if (resolvedOperation === "BID" && exactApprovedBidCeiling === null) {
      setActionState("Waiting for ESPN to expose the exact one-dollar-reserve maximum before bidding.");
      return;
    }
    if (resolvedOperation === "BID" && Number(requestedBidAmount) > Number(exactApprovedBidCeiling)) {
      setActionState(`Walk away from ${player.name}: the next $${requestedBidAmount} offer exceeds the exact $${exactApprovedBidCeiling} ceiling.`);
      return;
    }
    const authorizationEpoch = actionAuthorizationEpochRef.current;
    const currentAuthorizationStatus = () => {
      if (actionAuthorizationEpochRef.current !== authorizationEpoch) return "ACTION_AUTHORIZATION_SUPERSEDED";
      if (automatic && !autoDraftRef.current) return "AUTO_DRAFT_DISARMED";
      if (workspaceRoleRef.current !== "writer") return "COMMAND_CENTER_WRITER_LOST";
      if (!acceptedIntelligenceSnapshotFresh(intelligenceSnapshot, Date.now(), activeIntelligenceSnapshotKey)) return "FIVE_SOURCE_COVERAGE_BLOCKED";
      const feed = pickFeedHealthRef.current;
      if (!feed.fresh || feed.lagging) return "PICK_FEED_UNHEALTHY";
      const currentAvailability = availabilityGateRef.current;
      const availabilityFreshUntil = Date.parse(currentAvailability.freshUntil || "");
      if (!currentAvailability.armingAllowed
        || !Number.isFinite(availabilityFreshUntil)
        || availabilityFreshUntil <= Date.now()) return "AVAILABILITY_GATE_BLOCKED";
      if (liveControlBlockedRef.current || liveControlBindingRef.current !== exactBinding) return "LIVE_CONTROL_AUTHORITY_CHANGED";
      return "ACTION_AUTHORIZED";
    };
    if (inFlightActionRef.current) {
      setActionState(`Waiting for ESPN to finish the pending ${inFlightActionRef.current.operation.toLowerCase()} acknowledgement.`);
      return;
    }
    const expectedTabId = activeEspnTabRef.current;
    if (!Number.isInteger(expectedTabId)) {
      setActionState("Reconnect the exact ESPN draft tab before submitting.");
      return;
    }
    const exactBinding = draftAuditChecklistBindingKey(league.id, Number(league.teamId), Number(expectedTabId));
    const publisherBinding = draftAuditPublisherBinding(
      liveControlRef.current,
      league.id,
      Number(league.teamId),
      expectedTabId,
    );
    if (!liveControlRef.current
      || liveControlBlockedRef.current
      || liveControlBindingRef.current !== exactBinding
      || !espnContextObservedAtRef.current
      || !isCanonicalDraftAuditUtcTimestamp(sourceSnapshotObservedAtRef.current)
      || !isDraftAuditSourceSnapshotId(sourceSnapshotIdRef.current)) {
      setAutoDraft(false);
      setActionState("Action stopped: the typed live-control session, exact binding, or source/context freshness is not ready.");
      return;
    }
    if (!publisherBinding || !draftAuditPublisherRef.current) {
      setAutoDraft(false);
      lastAutoAction.current = "";
      setActionState("Action stopped: the exact command-center audit publisher is not bound. No ESPN action was sent.");
      return;
    }
    if ((resolvedOperation === "BID" ? !bidWindowOpen : !actionWindowOpen)) {
      setActionState(`Waiting for a safe ESPN action window (need at least ${resolvedOperation === "SELECT" ? MIN_SNAKE_SELECTION_WINDOW_SECONDS : MIN_OTHER_ACTION_WINDOW_SECONDS} seconds; ESPN shows ${Number.isFinite(remainingSeconds) ? `${remainingSeconds}s` : "no timer"}).`);
      return;
    }
    if (resolvedOperation === "SELECT" && pendingSnakeActionRef.current && !pendingSnakeActionRef.current.failed) {
      setActionState(`Waiting for ESPN to confirm ${pendingSnakeActionRef.current.playerName}.`);
      return;
    }
    if (!automatic && resolvedOperation === "SELECT" && stagedSnakeDecisionRef.current) {
      if (!cancelStagedSnakeDecision("USER_MANUAL_OVERRIDE")) return;
    }
    const stagedSnake = automatic && resolvedOperation === "SELECT"
      ? stagedSnakeDecisionRef.current
      : null;
    if (automatic && resolvedOperation === "SELECT") {
      const stagedDecision = stagedSnake?.decision;
      const latestClock = Number(latestEspnContextRef.current.remainingSeconds);
      let expectedKey = "";
      try {
        expectedKey = snakePlanKey({
          leagueId: league.id,
          teamId: Number(league.teamId),
          tabId: Number(expectedTabId),
          expectedPick: currentPick,
          playerId: player.id,
          sourceSnapshotId: sourceSnapshotIdRef.current,
          availabilityDigest: availabilityGateRef.current.digest,
          submitTargetSeconds: deterministicSnakeSubmitSecondsRemaining(league.id, currentPick),
        });
      } catch { /* handled by the fail-closed branch below */ }
      if (!stagedSnake
        || stagedSnake.key !== expectedKey
        || !stagedDecision
        || !snakePlanReadyToSubmit(stagedDecision, Date.now(), latestClock)) {
        lastAutoAction.current = "";
        setActionState(stagedSnake
          ? `Planned pick: ${player.name}. Waiting for the announced click window while final safety checks remain valid.`
          : "Action stopped: no pre-published snake decision matched the exact turn. No ESPN action was sent.");
        if (!stagedSnake) setAutoDraft(false);
        return;
      }
      if (draftAuditPublisherRef.current?.isAuthorized(publisherBinding, stagedDecision.decisionId) !== true) {
        lastAutoAction.current = "";
        setActionState(`Planned pick: ${player.name}. Waiting for the exact decision audit acknowledgment before any ESPN click.`);
        return;
      }
    }
    const actionRequestId = stagedSnake?.actionRequestId ?? ++actionRequestSequenceRef.current;
    const actionId = stagedSnake?.action.actionId ?? `action-${actionRequestId}`;
    const decisionId = stagedSnake?.decision.decisionId ?? `decision-${actionRequestId}`;
    const intendedPlayer = livePlayerIdentity(player);
    const intendedOffer = resolvedOperation === "SELECT"
      ? undefined
      : Math.max(0, Math.trunc(Number(resolvedOperation === "BID" ? requestedBidAmount : amount ?? 1)));
    const alternativePlayers = stagedSnake?.decision.alternatives ?? liveRecommendations
      .filter((candidate) => candidate.id !== player.id)
      .slice(0, 5)
      .map(livePlayerIdentity);
    const decidedAt = stagedSnake?.decision.decidedAt ?? new Date().toISOString();
    let availabilityDecision: AvailabilityDecisionSnapshot;
    if (stagedSnake) availabilityDecision = stagedSnake.availabilityDecision;
    else try {
        availabilityDecision = createAvailabilityDecisionSnapshot({
          decisionKey: decisionId,
          evaluation: availabilityGateRef.current,
          player,
        });
      } catch {
        setAutoDraft(false);
        setActionState("Action stopped: the availability decision identity was invalid.");
        return;
      }
    if (!availabilityDecision.canAct) {
      setAutoDraft(false);
      setActionState(`Action stopped: ${player.name} is blocked by the current availability veto artifact.`);
      return;
    }
    // The staged artifact is a loopback-only local read. Re-fetch and resolve
    // it against the current actionable ESPN window immediately before any
    // action is planned or sent. A timeout is a veto, never a reason to proceed.
    decisionSourceFreezeRef.current = true;
    availabilityDecisionFreezeRef.current = true;
    inFlightActionRef.current = { actionRequestId, operation: resolvedOperation };
    setActionInFlight(true);
    setActionState(`Revalidating ${player.name} against the latest staged availability artifact…`);
    const preClickAvailability = await fetchAvailabilityGate(
      espnPlayers,
      [...new Set([player.id, ...availabilityActionablePlayerIds])],
    );
    deferredAvailabilityGateRef.current = preClickAvailability;
    const preClickAuthorization = currentAuthorizationStatus();
    const availabilityRevalidation = revalidateAvailabilityDecision(
      availabilityDecision,
      preClickAvailability,
      player,
    );
    const latestContext = latestEspnContextRef.current;
    const latestClock = Number(latestContext.remainingSeconds);
    const bidNomineeMatches = (candidateContext: EspnContext) => {
      if (candidateContext.nominatedPlayerId !== null && candidateContext.nominatedPlayerId !== undefined) {
        const nomineeId = Number(candidateContext.nominatedPlayerId);
        return Number.isInteger(nomineeId)
          && ![0, -1].includes(nomineeId)
          && nomineeId === player.id;
      }
      return normalizeName(candidateContext.nominatedPlayer) === normalizeName(player.name);
    };
    const latestActionSurfaceReady = resolvedOperation === "BID"
      ? latestContext.auctionOfferReady === true
      : latestContext.actionSurfaceReady === true;
    const exactIdentityStillSafe = contextMatchesActiveDraftTab(latestContext, league.id, Number(expectedTabId))
      && Number(latestContext.teamId) === Number(league.teamId)
      && latestContext.inDraftRoom === true
      && latestContext.autopickActive === false
      && latestActionSurfaceReady;
    const latestEspnBidCeiling = Number(latestContext.maxLegalBid);
    const latestExactBidCeiling = resolvedOperation === "BID"
      && Number.isSafeInteger(latestEspnBidCeiling)
      && latestEspnBidCeiling >= 0
      ? Math.min(Number(sourceBidCeiling), latestEspnBidCeiling)
      : null;
    const latestBidOfferCurrent = resolvedOperation === "BID"
      && latestContext.leadingBid === false
      && Number(latestContext.currentBid || 0) === Number(context.currentBid || 0)
      && bidNomineeMatches(latestContext);
    const latestBidWalkAway = latestBidOfferCurrent
      && latestExactBidCeiling !== null
      && Number(requestedBidAmount) > latestExactBidCeiling;
    const exactDecisionStillCurrent = exactIdentityStillSafe
      && Number.isFinite(latestClock)
      && latestClock >= (resolvedOperation === "SELECT" ? MIN_SNAKE_SELECTION_WINDOW_SECONDS : MIN_OTHER_ACTION_WINDOW_SECONDS)
      && (resolvedOperation === "BID" || latestContext.onClock === true)
      && (resolvedOperation !== "SELECT" || Number(latestContext.currentPick) === currentPick)
      && (resolvedOperation !== "BID" || (
        latestBidOfferCurrent
        && latestExactBidCeiling !== null
        && Number(requestedBidAmount) <= latestExactBidCeiling
      ));
    if (preClickAuthorization === "ACTION_AUTHORIZED"
      && availabilityRevalidation.valid
      && exactIdentityStillSafe
      && latestBidWalkAway) {
      if (inFlightActionRef.current?.actionRequestId === actionRequestId) inFlightActionRef.current = null;
      setActionInFlight(false);
      setActionState(`Walk away from ${player.name}: ESPN's exact reserve ceiling fell to $${latestExactBidCeiling} before the bid was audited.`);
      return;
    }
    if (preClickAuthorization !== "ACTION_AUTHORIZED" || !availabilityRevalidation.valid || !exactDecisionStillCurrent) {
      if (stagedSnake) cancelStagedSnakeDecision(preClickAuthorization !== "ACTION_AUTHORIZED"
        ? preClickAuthorization
        : !availabilityRevalidation.valid
          ? "SNAKE_AVAILABILITY_REVALIDATION_FAILED"
          : "SNAKE_CONTEXT_REVALIDATION_FAILED");
      if (inFlightActionRef.current?.actionRequestId === actionRequestId) inFlightActionRef.current = null;
      setActionInFlight(false);
      lastAutoAction.current = "";
      if (preClickAuthorization !== "ACTION_AUTHORIZED") {
        if (automatic && autoDraftRef.current && actionAuthorizationEpochRef.current === authorizationEpoch) {
          setAutoDraft(false);
        } else if (automatic && autoDraftRef.current) {
          setActionRetryNonce((nonce) => nonce + 1);
        }
        setActionState(`Action cancelled before audit: authorization changed (${preClickAuthorization}). No ESPN action was sent.`);
      } else if (!availabilityRevalidation.valid || !exactIdentityStillSafe) {
        setAutoDraft(false);
        setActionState(!availabilityRevalidation.valid
          ? `Action stopped: availability changed during pre-click revalidation (${availabilityRevalidation.reason}).`
          : "Action stopped: ESPN identity or safety state changed during pre-click revalidation. No action was sent.");
      } else if (resolvedOperation === "BID") {
        setActionRetryNonce((nonce) => nonce + 1);
        setActionState("ESPN offer changed during the availability check. Re-evaluating the new exact bid now.");
      } else {
        setAutoDraft(false);
        setActionState("Action stopped: ESPN turn or clock changed during pre-click revalidation. No action was sent.");
      }
      return;
    }
    if (resolvedOperation === "BID") exactApprovedBidCeiling = latestExactBidCeiling;
    const responseBudgetMs = resolvedOperation === "BID" ? 2_500 : resolvedOperation === "NOMINATE" ? 5_500 : 6_000;
    const freshlyBoundedNotAfter = availabilityBoundedActionDeadline(preClickAvailability, responseBudgetMs);
    const notAfter = stagedSnake && freshlyBoundedNotAfter !== null
      ? Math.min(stagedSnake.decision.notAfter, freshlyBoundedNotAfter)
      : freshlyBoundedNotAfter;
    const availabilityNotAfter = Date.parse(preClickAvailability.freshUntil || "");
    if (notAfter === null
      || !Number.isSafeInteger(notAfter)
      || notAfter <= Date.now()
      || !Number.isSafeInteger(availabilityNotAfter)
      || availabilityNotAfter <= Date.now()) {
      if (inFlightActionRef.current?.actionRequestId === actionRequestId) inFlightActionRef.current = null;
      setActionInFlight(false);
      setAutoDraft(false);
      setActionState("Action stopped: the availability lease expires before ESPN can safely complete this action. No action was sent.");
      return;
    }
    const decisionEnvelope: LiveDecisionEnvelope = stagedSnake?.decision ?? {
      decisionId,
      decidedAt,
      contextCapturedAt: espnContextObservedAtRef.current,
      leagueId: league.id,
      teamId: Number(league.teamId),
      tabId: Number(expectedTabId),
      operation: resolvedOperation,
      sourceSnapshotId: sourceSnapshotIdRef.current,
      availabilityDigest: availabilityDecision.availabilityDigest,
      availabilityDecisionDigest: availabilityDecision.decisionDigest,
      ...(resolvedOperation === "SELECT" ? {
        expectedPick: currentPick,
        submitNotBeforeAt: decidedAt,
        submitTargetSeconds: deterministicSnakeSubmitSecondsRemaining(league.id, currentPick),
      } : {}),
      intendedPlayer,
      ...(resolvedOperation === "BID" ? { expectedCurrentBid: Math.max(0, Math.trunc(Number(context.currentBid || 0))) } : {}),
      ...(intendedOffer === undefined ? {} : { intendedOffer }),
      ...(resolvedOperation === "BID" ? { maxApprovedBid: Number(exactApprovedBidCeiling) } : {}),
      ...(resolvedOperation === "NOMINATE" ? { nominationIntent } : {}),
      notAfter,
      alternatives: alternativePlayers,
    };
    const actionRecord: PendingLiveAction = stagedSnake?.action ?? {
      actionId,
      decisionId,
      operation: resolvedOperation,
      intendedPlayer,
      ...(intendedOffer === undefined ? {} : { intendedOffer }),
      phase: "PLANNED",
    };
    const planned = stagedSnake ? true : transitionLiveControl({
        kind: "ACTION_LIFECYCLE",
        occurredAt: decidedAt,
        actionId,
        decisionId,
        operation: resolvedOperation,
        phase: "PLANNED",
        intendedPlayer,
        ...(intendedOffer === undefined ? {} : { intendedOffer }),
        code: automatic ? "AUTO_ACTION_PLANNED" : "MANUAL_ACTION_PLANNED",
      }, { decision: decisionEnvelope });
    if (!planned) {
      if (inFlightActionRef.current?.actionRequestId === actionRequestId) inFlightActionRef.current = null;
      setActionInFlight(false);
      return;
    }
    liveControlActionsRef.current.set(actionRequestId, actionRecord);
    setActionState(`Publishing the exact ${resolvedOperation.toLowerCase()} decision before ESPN interaction…`);
    const auditWaitReserveMs = resolvedOperation === "BID" ? 1_350 : 2_500;
    const maximumAuditWaitMs = resolvedOperation === "SELECT" ? 2_500 : 1_200;
    const auditWaitMs = Math.min(maximumAuditWaitMs, Math.max(0, notAfter - Date.now() - auditWaitReserveMs));
    const exactDecisionRecorded = auditWaitMs >= 50
      && await draftAuditPublisherRef.current.waitUntilAuthorized(
        publisherBinding,
        decisionEnvelope.decisionId,
        auditWaitMs,
      );
    const postAuditAuthorization = currentAuthorizationStatus();
    const postAuditContext = latestEspnContextRef.current;
    const postAuditClock = Number(postAuditContext.remainingSeconds);
    const postAuditRoomIdentitySafe = contextMatchesActiveDraftTab(postAuditContext, league.id, Number(expectedTabId))
      && Number(postAuditContext.teamId) === Number(league.teamId)
      && postAuditContext.inDraftRoom === true
      && postAuditContext.autopickActive === false;
    const postAuditActionSurfaceReady = resolvedOperation === "BID"
      ? postAuditContext.auctionOfferReady === true
      : postAuditContext.actionSurfaceReady === true;
    const postAuditIdentitySafe = postAuditRoomIdentitySafe
      && postAuditActionSurfaceReady;
    const postAuditEspnBidCeiling = Number(postAuditContext.maxLegalBid);
    const postAuditExactBidCeiling = resolvedOperation === "BID"
      && Number.isSafeInteger(postAuditEspnBidCeiling)
      && postAuditEspnBidCeiling >= 0
      ? Math.min(Number(sourceBidCeiling), postAuditEspnBidCeiling)
      : null;
    const postAuditBidOfferCurrent = resolvedOperation === "BID"
      && postAuditContext.leadingBid === false
      && Number(postAuditContext.currentBid || 0) === Number(context.currentBid || 0)
      && bidNomineeMatches(postAuditContext);
    const postAuditBidWalkAway = postAuditBidOfferCurrent
      && postAuditExactBidCeiling !== null
      && Number(requestedBidAmount) > postAuditExactBidCeiling;
    const postAuditDecisionCurrent = postAuditIdentitySafe
      && Number.isFinite(postAuditClock)
      && postAuditClock >= (resolvedOperation === "SELECT" ? MIN_SNAKE_SELECTION_WINDOW_SECONDS : MIN_OTHER_ACTION_WINDOW_SECONDS)
      && (resolvedOperation === "BID" || postAuditContext.onClock === true)
      && (resolvedOperation !== "SELECT" || Number(postAuditContext.currentPick) === currentPick)
      && (resolvedOperation !== "BID" || (
        postAuditBidOfferCurrent
        && postAuditExactBidCeiling === exactApprovedBidCeiling
        && Number(requestedBidAmount) <= Number(postAuditExactBidCeiling)
      ))
      && draftAuditPublisherRef.current?.isAuthorized(publisherBinding, decisionEnvelope.decisionId) === true;
    // The original absolute action deadline is end-to-end: availability read,
    // audit publication, renderer dispatch, click, and acknowledgement all
    // consume the same budget. Never renew it after the audit wait.
    const postAuditNotAfter = Date.now() < notAfter ? notAfter : null;
    const postAuditAvailabilityValid = postAuditNotAfter !== null
      && Date.now() < availabilityNotAfter
      && Date.now() < postAuditNotAfter
      && revalidateAvailabilityDecision(availabilityDecision, preClickAvailability, player).valid;
    const retryablePostAuditBidChurn = resolvedOperation === "BID"
      && exactDecisionRecorded
      && postAuditAvailabilityValid
      && postAuditRoomIdentitySafe
      && !postAuditBidWalkAway
      && !postAuditDecisionCurrent;
    if (postAuditAuthorization !== "ACTION_AUTHORIZED" || !exactDecisionRecorded || !postAuditDecisionCurrent || !postAuditAvailabilityValid) {
      if (stagedSnake) {
        cancelStagedSnakeDecision(postAuditAuthorization !== "ACTION_AUTHORIZED"
          ? postAuditAuthorization
          : !exactDecisionRecorded
          ? "DRAFT_AUDIT_DECISION_ACK_MISSING"
          : !postAuditDecisionCurrent ? "POST_AUDIT_CONTEXT_CHANGED" : "POST_AUDIT_AVAILABILITY_CHANGED");
      } else {
        const cancelledAt = new Date().toISOString();
        transitionLiveControl({
          kind: "ACTION_LIFECYCLE",
          occurredAt: cancelledAt,
          actionId,
          decisionId,
          operation: resolvedOperation,
          phase: "CANCELLED",
          intendedPlayer,
          ...(intendedOffer === undefined ? {} : { intendedOffer }),
          code: postAuditAuthorization !== "ACTION_AUTHORIZED"
            ? postAuditAuthorization
            : !exactDecisionRecorded
            ? "DRAFT_AUDIT_DECISION_ACK_MISSING"
            : !postAuditDecisionCurrent ? "POST_AUDIT_CONTEXT_CHANGED" : "POST_AUDIT_AVAILABILITY_CHANGED",
        }, { freshness: { lastActionAt: cancelledAt } });
        liveControlActionsRef.current.set(actionRequestId, { ...actionRecord, phase: "CANCELLED" });
        clearPublishedLiveDecision(decisionId);
      }
      if (inFlightActionRef.current?.actionRequestId === actionRequestId) inFlightActionRef.current = null;
      setActionInFlight(false);
      lastAutoAction.current = "";
      if (postAuditAuthorization !== "ACTION_AUTHORIZED") {
        if (automatic && autoDraftRef.current && actionAuthorizationEpochRef.current === authorizationEpoch) {
          setAutoDraft(false);
        } else if (automatic && autoDraftRef.current) {
          setActionRetryNonce((nonce) => nonce + 1);
        }
        setActionState(`Action cancelled after audit: authorization changed (${postAuditAuthorization}). No ESPN action was sent.`);
        return;
      }
      if (postAuditBidWalkAway) {
        setActionState(`Walk away from ${player.name}: ESPN's exact reserve ceiling fell to $${postAuditExactBidCeiling} before dispatch.`);
        return;
      }
      if (retryablePostAuditBidChurn) {
        pendingAuctionBidRef.current = null;
        setActionRetryNonce((nonce) => nonce + 1);
        setActionState("ESPN advanced or rebuilt the offer while the exact bid was being audited. Re-evaluating the latest transaction without reusing the old decision.");
        return;
      }
      setAutoDraft(false);
      setActionState(!exactDecisionRecorded
        ? "Action stopped: the exact decision was not recorded by the audit server before its deadline. No ESPN action was sent."
        : !postAuditDecisionCurrent
          ? "Action stopped: ESPN context changed while publishing the exact decision. No action was sent."
          : "Action stopped: availability freshness changed while publishing the exact decision. No action was sent.");
      return;
    }
    if (stagedSnake) stagedSnakeDecisionRef.current = null;
    while (liveControlActionsRef.current.size > MAX_DRAFT_ACTION_TELEMETRY_EVENTS) {
      const terminalEntry = [...liveControlActionsRef.current.entries()].find(([, candidate]) => (
        ["ROSTER_CONFIRMED", "ACTION_COMPLETED", "FAILED", "CANCELLED"].includes(candidate.phase)
      ));
      if (!terminalEntry) break;
      liveControlActionsRef.current.delete(terminalEntry[0]);
    }
    availabilityDecisionsRef.current.set(actionRequestId, availabilityDecision);
    if (resolvedOperation === "SELECT") {
      pendingSnakeActionRef.current = {
        playerId: player.id,
        playerName: player.name,
        expectedPick: currentPick,
        sentAt: Date.now(),
        beforeRosterPlayerIds: resolveOwnRoster(context, espnPlayers).map((entry) => entry.playerId),
      };
    }
    if (resolvedOperation === "NOMINATE") {
      const nomination = {
        playerId: player.id,
        playerName: player.name,
        intent: nominationIntent,
      };
      pendingAuctionNominationRef.current = nomination;
      setPendingAuctionNomination(nomination);
    }
    latestActionRequestRef.current = actionRequestId;
    inFlightActionRef.current = { actionRequestId, operation: resolvedOperation };
    setActionInFlight(true);
    pendingActionTelemetryRef.current.set(actionRequestId, {
      sentAt: Date.now(),
      submittedAt: null,
      operation: resolvedOperation,
      clockSeconds: Number.isFinite(remainingSeconds) ? remainingSeconds : null,
      automatic,
      playerId: player.id,
      amount: Math.max(0, Math.trunc(Number(resolvedOperation === "BID" ? requestedBidAmount : amount ?? (resolvedOperation === "NOMINATE" ? 1 : 0)))),
      maxApprovedBid: resolvedOperation === "BID" ? Number(exactApprovedBidCeiling) : 0,
      nominationIntent: resolvedOperation === "NOMINATE" ? nominationIntent : null,
    });
    while (pendingActionTelemetryRef.current.size > MAX_DRAFT_ACTION_TELEMETRY_EVENTS) {
      const oldestRequestId = pendingActionTelemetryRef.current.keys().next().value;
      if (oldestRequestId === undefined) break;
      pendingActionTelemetryRef.current.delete(oldestRequestId);
    }
    if (resolvedOperation === "BID") {
      pendingAuctionBidRef.current = {
        actionRequestId,
        playerId: player.id,
        playerName: player.name,
        beforeRosterPlayerIds: resolveOwnRoster(context, espnPlayers).map((entry) => entry.playerId),
      };
    }
    setActionState(`${automatic ? "Auto-Draft is submitting" : "Submitting"} ${player.name} in ESPN…`);
    const actionWatchdogMs = Math.max(1, Number(postAuditNotAfter) - Date.now());
    sendToExtension("SUBMIT_ACTION", {
      actionRequestId,
      authorizationEpoch,
      commandCenterSessionId: COMMAND_CENTER_PUBLISHER.sessionId,
      dashboardLoadedAt: DASHBOARD_LOADED_AT,
      actionId,
      decisionId: decisionEnvelope.decisionId,
      sourceSnapshotId: decisionEnvelope.sourceSnapshotId,
      operation: resolvedOperation,
      playerId: player.id,
      playerName: player.name,
      position: player.pos,
      fillsMandatoryStarter: player.fillsMandatoryStarter,
      // Only the exact server-acknowledged player may reach the actuator. If
      // ESPN cannot resolve it, the engine publishes a new exact decision for
      // the next recommendation instead of clicking a pre-listed fallback.
      candidates: resolvedOperation === "BID" ? undefined : [{
        playerId: player.id,
        playerName: player.name,
        position: player.pos,
        fillsMandatoryStarter: player.fillsMandatoryStarter,
      }],
      amount: resolvedOperation === "BID" ? requestedBidAmount : resolvedOperation === "NOMINATE" ? amount ?? 1 : undefined,
      maxApprovedBid: resolvedOperation === "BID" ? exactApprovedBidCeiling : undefined,
      nominationIntent: resolvedOperation === "NOMINATE" ? nominationIntent : undefined,
      expectedCurrentBid: resolvedOperation === "BID" ? Number(context.currentBid || 0) : undefined,
      requireOnClock: resolvedOperation !== "BID",
      expectedLeagueId: league.id,
      expectedTeamId: league.teamId,
      expectedSeason: league.season,
      expectedTabId,
      expectedPick: currentPick,
      availabilityDigest: availabilityDecision.availabilityDigest,
      availabilityDecisionDigest: availabilityDecision.decisionDigest,
      availabilityNotAfter,
      notAfter: postAuditNotAfter,
    });
    const watchdog = window.setTimeout(() => {
      actionWatchdogsRef.current.delete(actionRequestId);
      if (inFlightActionRef.current?.actionRequestId !== actionRequestId) return;
      const activeAction = liveControlActionsRef.current.get(actionRequestId);
      if (activeAction && !["ROSTER_CONFIRMED", "ACTION_COMPLETED", "FAILED", "CANCELLED"].includes(activeAction.phase)) {
        const occurredAt = new Date().toISOString();
        const accepted = transitionLiveControl({
          kind: "ACTION_LIFECYCLE",
          occurredAt,
          actionId: activeAction.actionId,
          decisionId: activeAction.decisionId,
          operation: activeAction.operation,
          phase: "FAILED",
          intendedPlayer: activeAction.intendedPlayer,
          ...(activeAction.resolvedPlayer ? { resolvedPlayer: activeAction.resolvedPlayer } : {}),
          ...(activeAction.intendedOffer === undefined ? {} : { intendedOffer: activeAction.intendedOffer }),
          ...(activeAction.resolvedOffer === undefined ? {} : { resolvedOffer: activeAction.resolvedOffer }),
          code: "ACTION_RESULT_TIMEOUT",
        }, { freshness: { lastActionAt: occurredAt } });
        if (accepted) activeAction.phase = "FAILED";
      }
      inFlightActionRef.current = null;
      availabilityDecisionsRef.current.delete(actionRequestId);
      pendingActionTelemetryRef.current.delete(actionRequestId);
      if (pendingSnakeActionRef.current) pendingSnakeActionRef.current.failed = true;
      if (pendingAuctionBidRef.current?.actionRequestId === actionRequestId) pendingAuctionBidRef.current = null;
      if (resolvedOperation === "NOMINATE") {
        // A missing result cannot prove ESPN rejected the nomination. Preserve
        // exact TARGET/DRAIN identity until content reports a different nominee
        // or ESPN records the sale, so recovery can never price-enforce DRAIN.
      }
      setActionInFlight(false);
      setAutoDraft(false);
      setActionState(`Action stopped: the companion did not return the ${resolvedOperation.toLowerCase()} result inside the bounded live-action deadline. No retry will be sent.`);
    }, actionWatchdogMs);
    actionWatchdogsRef.current.set(actionRequestId, watchdog);
  }, [actionWindowOpen, activeIntelligenceSnapshotKey, availabilityActionablePlayerIds, bidWindowOpen, cancelStagedSnakeDecision, clearPublishedLiveDecision, context, currentPick, espnPlayers, extension, intelligenceSnapshot, league.draftType, league.id, league.rosterSize, league.season, league.teamId, liveRecommendations, myPickCount, remainingSeconds, setAutoDraft, settingsConfirmed, transitionLiveControl]);

  useEffect(() => {
    const stagedSnake = stagedSnakeDecisionRef.current;
    const baseReady = autoDraft
      && settingsConfirmed
      && extension === "connected"
      && actionWindowOpen
      && Boolean(liveRecommendations[0])
      && myPickCount < league.rosterSize;
    if (!baseReady) {
      if (stagedSnake && !inFlightActionRef.current) {
        const cancelTimer = window.setTimeout(() => cancelStagedSnakeDecision("SNAKE_PLAN_NO_LONGER_ACTIONABLE"), 0);
        return () => window.clearTimeout(cancelTimer);
      }
      return;
    }
    if (inFlightActionRef.current) return;
    if (league.draftType === "SNAKE" && pendingSnakeActionRef.current) {
      if (stagedSnake) {
        const cancelTimer = window.setTimeout(() => cancelStagedSnakeDecision("SNAKE_ACTION_ALREADY_PENDING"), 0);
        return () => window.clearTimeout(cancelTimer);
      }
      return;
    }
    if (league.draftType === "AUCTION" && (nominated || context.nominatedPlayer || Number(context.currentBid || 0) > 0)) return;
    const automaticPlayer = league.draftType === "AUCTION" ? auctionNomination?.player : liveRecommendations[0];
    if (!automaticPlayer) return;
    if (league.draftType === "SNAKE") {
      const submitAt = deterministicSnakeSubmitSecondsRemaining(league.id, currentPick);
      let expectedPlanKey = "";
      try {
        expectedPlanKey = snakePlanKey({
          leagueId: league.id,
          teamId: Number(league.teamId),
          tabId: Number(activeEspnTabRef.current),
          expectedPick: currentPick,
          playerId: automaticPlayer.id,
          sourceSnapshotId: sourceSnapshotIdRef.current,
          availabilityDigest: availabilityGateRef.current.digest,
          submitTargetSeconds: submitAt,
        });
      } catch { /* the staged callback retains the authoritative fail-closed checks */ }
      const staged = stagedSnakeDecisionRef.current;
      if (!staged || staged.key !== expectedPlanKey) {
        const stageTimer = window.setTimeout(() => stageAutomaticSnakeDecision(automaticPlayer, submitAt), 0);
        return () => window.clearTimeout(stageTimer);
      }
      if (!snakePlanReadyToSubmit(staged.decision, Date.now(), remainingSeconds)) return;
    }
    const key = `${league.id}:${currentPick}:${automaticPlayer.id}:${league.draftType}:${auctionNomination?.intent || "PICK"}:${actionRetryNonce}`;
    if (lastAutoAction.current === key) return;
    lastAutoAction.current = key;
    submit(
      automaticPlayer,
      true,
      league.draftType === "AUCTION" ? "NOMINATE" : "SELECT",
      league.draftType === "AUCTION" ? auctionNomination?.openingBid : undefined,
      auctionNomination?.intent || "TARGET",
    );
  }, [actionRetryNonce, actionInFlight, actionWindowOpen, auctionNomination, auditPublisherVersion, autoDraft, cancelStagedSnakeDecision, context.currentBid, context.nominatedPlayer, currentPick, extension, league.draftType, league.id, league.rosterSize, league.teamId, liveRecommendations, myPickCount, nominated, remainingSeconds, settingsConfirmed, stageAutomaticSnakeDecision, submit]);

  useEffect(() => {
    if (!autoDraft || !settingsConfirmed || extension !== "connected" || league.draftType !== "AUCTION" || !bidWindowOpen || !nominated || nominatedAvailabilityVetoed || context.leadingBid !== false || ownNominationIntent === "DRAIN" || myPickCount >= league.rosterSize) return;
    if (inFlightActionRef.current) return;
    const bid = Math.max(1, Number(context.currentBid || 0) + 1);
    if (bid > exactLiveBidCeiling) return;
    const key = `${league.id}:bid:${nominated.id}:${bid}:${exactLiveBidCeiling}`;
    if (lastAutoAction.current === key) return;
    lastAutoAction.current = key;
    submit(nominated, true, "BID", bid);
  }, [actionRetryNonce, actionInFlight, autoDraft, settingsConfirmed, extension, league.draftType, league.id, league.rosterSize, myPickCount, nominated, nominatedAvailabilityVetoed, ownNominationIntent, context.currentBid, context.leadingBid, bidWindowOpen, exactLiveBidCeiling, submit]);

  useEffect(() => {
    if (!autoDraft || myPickCount < league.rosterSize || context.autopickActive === true || inFlightActionRef.current || pendingActionTelemetryRef.current.size > 0) return;
    const completionTimer = window.setTimeout(() => {
      setAutoDraft(false);
      setActionState("Draft complete: ESPN confirmed every roster spot. No further action was sent.");
    }, 0);
    return () => window.clearTimeout(completionTimer);
  }, [autoDraft, context.autopickActive, league.rosterSize, myPickCount, setAutoDraft, telemetryVersion]);

  function enableAutoDraft() {
    if (workspaceRoleRef.current !== "writer") {
      setAutoDraft(false);
      setActionState("Read-only observer: Auto-Draft authority remains with the original command center.");
      return;
    }
    if (autoDraft) { setAutoDraft(false); return; }
    if (!liveChecklistReady) {
      dispatchUi({ type: "set", key: "settingsOpen", value: true });
      setActionState("Auto-Draft locked: complete the pre-draft and live-room checklists first.");
      return;
    }
    dispatchUi({ type: "set", key: "autoWarning", value: true });
  }

  function confirmEnableAutoDraft() {
    const expectedTabId = activeEspnTabRef.current;
    const availabilityFreshUntil = Date.parse(availabilityGateRef.current.freshUntil || "");
    const availabilityReadyAtArm = availabilityGateRef.current.armingAllowed
      && Number.isFinite(availabilityFreshUntil)
      && availabilityFreshUntil > Date.now();
    const publisherBinding = draftAuditPublisherBinding(
      liveControlRef.current,
      league.id,
      Number(league.teamId),
      expectedTabId,
    );
    const publisherReady = Boolean(publisherBinding)
      && draftAuditPublisherRef.current?.isAuthorized(publisherBinding as DraftAuditPublisherBinding) === true;
    if (workspaceRoleRef.current !== "writer" || !liveChecklistReady || !availabilityReadyAtArm || !publisherReady || extension !== "connected" || !Number.isInteger(expectedTabId)) {
      dispatchUi({ type: "set", key: "autoWarning", value: false });
      dispatchUi({ type: "set", key: "settingsOpen", value: true });
      setAutoDraft(false);
      setActionState("Auto-Draft locked: ESPN room state changed. Rerun the exact live-room checklist.");
      return;
    }
    const requestId = ++autoArmRequestSequenceRef.current;
    pendingAutoArmRequestRef.current = requestId;
    setAutoDraft(false);
    dispatchUi({ type: "set", key: "autoWarning", value: false });
    setActionState("Revalidating the exact ESPN draft tab before arming Auto-Draft…");
    sendToExtension("REFRESH_ESPN_CONTEXT", {
      commandCenterSessionId: COMMAND_CENTER_PUBLISHER.sessionId,
      expectedLeagueId: league.id,
      expectedTeamId: activeEspnTeamRef.current,
      expectedTabId,
      autoArmRequestId: requestId,
    });
  }

  const slots = useMemo(() => rosterSlots(league), [league]);
  const rosterRows = useMemo(() => {
    const assigned = new Set<number>();
    return slots.map((slot) => {
      const item = myRoster.find(({ player }) => !assigned.has(player.id) && (
        slot === "FLEX" ? ["RB", "WR", "TE"].includes(player.pos)
          : slot === "RB/WR" ? ["RB", "WR"].includes(player.pos)
            : slot === "WR/TE" ? ["WR", "TE"].includes(player.pos)
              : slot === "OP" ? ["QB", "RB", "WR", "TE"].includes(player.pos)
                : slot === "BN" || player.pos === slot
      ));
      if (item) assigned.add(item.player.id);
      return { slot, item };
    });
  }, [myRoster, slots]);

  // Presentation-only state for the command center. These values describe the
  // already-computed recommendation and never alter engine ordering or action
  // authorization.
  const openRosterRows = useMemo(() => rosterRows.filter(({ item }) => !item), [rosterRows]);
  const currentReserve = league.draftType === "AUCTION" ? openRosterRows.length : 0;
  const postWinReserve = Math.max(0, currentReserve - 1);
  const remainingBudget = league.auctionBudget - spent;
  const spendableBudget = Math.max(0, remainingBudget - currentReserve);
  const auctionCanBid = league.draftType === "AUCTION"
    && Boolean(nominated)
    && !nominatedAvailabilityVetoed
    && context.leadingBid === false
    && ownNominationIntent !== "DRAIN"
    && nextBid <= exactLiveBidCeiling
    && bidWindowOpen;
  const presentation = buildDraftPresentation({
    draftType: league.draftType,
    focusPlayer: focusPlayer ? { name: focusPlayer.name, maxBid: exactLiveBidCeiling } : undefined,
    auctionNominationPlayerName: auctionNomination?.player.name,
    ownNominationIntent,
    nominated: Boolean(nominated),
    leadingBid: context.leadingBid === true,
    nextBid,
    auctionCanBid,
    actionWindowOpen,
    bidWindowOpen,
    sourceCoverageReady,
    settingsConfirmed,
    extensionConnected: extension === "connected",
    autopickActive: context.autopickActive === true,
    inDraftRoom: context.inDraftRoom === true,
    rosterComplete: myPickCount >= league.rosterSize,
  });

  useEffect(() => {
    if (league.id === "demo" || !Number.isInteger(activeEspnTabId)) return;
    const timer = window.setInterval(() => {
      setAuditHeartbeat((heartbeat) => heartbeat + 1);
      sendToExtension("GET_RUNTIME_DIAGNOSTICS");
    }, 5_000);
    return () => window.clearInterval(timer);
  }, [activeEspnTabId, league.id]);

  useEffect(() => {
    const exactTabId = activeEspnTabId;
    if (workspaceRole !== "writer") return;
    if (draftAuditPublishingBlockedRef.current) return;
    if (league.id === "demo" || !Number.isInteger(exactTabId) || Number(exactTabId) <= 0 || !runtimeDiagnostics || !authenticatedImportAt) return;
    if (!sourceCoverageReady || !intelligenceSnapshot
      || sourceSnapshotIdRef.current !== intelligenceSnapshot.sourceSnapshotId
      || sourceSnapshotObservedAtRef.current !== intelligenceSnapshot.sourceSnapshotGeneratedAt) return;
    const sourceSnapshotId = intelligenceSnapshot.sourceSnapshotId;
    const sourceSnapshotGeneratedAt = intelligenceSnapshot.sourceSnapshotGeneratedAt;
    const currentLiveChecklistBindingKey = draftAuditChecklistBindingKey(
      league.id,
      Number(league.teamId),
      Number(exactTabId),
    );
    const liveControl = liveControlRef.current;
    const publisherBinding = draftAuditPublisherBinding(
      liveControl,
      league.id,
      Number(league.teamId),
      Number(exactTabId),
    );
    if (!publisherBinding) return;
    if (liveControl?.freshness.sourceSnapshotAt !== sourceSnapshotGeneratedAt) return;
    if (draftAuditPublisherRef.current?.bind(publisherBinding)) setAuditPublisherAuthorized(false);
    if (liveChecklistReady && currentLiveChecklistBindingKey) {
      lastValidatedLiveChecklistBindingRef.current = currentLiveChecklistBindingKey;
    }
    const auditLiveChecklistReady = resolveDraftAuditChecklistReady({
      currentReady: liveChecklistReady,
      rosterComplete: myPickCount >= league.rosterSize,
      currentBindingKey: currentLiveChecklistBindingKey,
      lastValidatedBindingKey: lastValidatedLiveChecklistBindingRef.current,
    });
    const toAuditEntry = (playerId: number, amount: number): DraftAuditRosterEntry | null => {
      const player = playerPool.playerById.get(playerId);
      return player ? {
        playerId,
        playerName: player.name,
        position: player.pos,
        amount: Math.max(0, Math.trunc(Number(amount || 0))),
      } : null;
    };
    const appRoster = myPicks
      .map((pick) => toAuditEntry(pick.playerId, pick.amount))
      .filter((entry): entry is DraftAuditRosterEntry => Boolean(entry));
    const espnRoster = (context.inDraftRoom === true ? resolveOwnRoster(context, espnPlayers) : [])
      .map((entry) => toAuditEntry(entry.playerId, entry.amount))
      .filter((entry): entry is DraftAuditRosterEntry => Boolean(entry));
    if (sleeperEvidenceLedgerRef.current.leagueId !== league.id) {
      sleeperEvidenceLedgerRef.current = { leagueId: league.id, candidates: [] };
    }
    const sleeperEvidence = mergeAuthenticatedSleeperEvidence({
      current: sleeperEvidenceLedgerRef.current.candidates,
      observed: currentSleeperEvidence,
      ownPicks: myPicks,
      currentPick: recommendationPick,
    });
    sleeperEvidenceLedgerRef.current = { leagueId: league.id, candidates: sleeperEvidence };
    const salaryCapEvidence = league.draftType === "AUCTION"
      ? buildSalaryCapEvidence({
        sales: context.auctionSales || [],
        playerById: playerPool.playerById,
        ownPlayerIds: new Set(myPicks.map((pick) => pick.playerId)),
        actions: actionTelemetryRef.current,
        observations: salaryCapDecisionObservationsRef.current,
      })
      : [];
    const operatorSnapshot = buildDraftOperatorSnapshot({
      control: liveControl,
      playerById: playerPool.playerById,
      draftType: league.draftType,
      rosterComplete: myPickCount >= league.rosterSize,
      currentRound,
      currentPick,
      onClock: context.onClock === true,
      remainingSeconds,
      nominee: nominated,
      currentBid: context.currentBid,
      contextMaxLegalBid: context.maxLegalBid,
      leadingBid: context.leadingBid,
      focusPlayer,
      nominatedAvailabilityVetoed,
      ownNominationIntent,
      nextBid,
      nominationOpeningBid: auctionNomination?.openingBid,
      remainingBudget,
      openRosterSlots: openRosterRows.map(({ slot }) => slot),
      recommendations: liveRecommendations,
    });
    const leagueBoard = buildDraftLeagueBoardSnapshot({
      league,
      picks: authoritativePicks,
      playerById: playerPool.playerById,
      recommendation: focusPlayer,
      sourceSnapshotId,
    });
    const snapshot: DraftAuditSnapshot = {
      schemaVersion: 1,
      capturedAt: new Date().toISOString(),
      league: {
        id: league.id,
        teamId: Number(league.teamId),
        season: Number(league.season),
        draftType: league.draftType,
        size: league.size,
        rosterSize: league.rosterSize,
        auctionBudget: league.auctionBudget,
        secondsPerPick: league.secondsPerPick,
        scoringLabel: league.scoringLabel,
        scoringRules: league.scoringRules,
        keeperCount: league.keeperCount,
        lineupSlotCounts: league.lineupSlotCounts,
        positionLimits: league.positionLimits,
      },
      binding: {
        tabId: Number(exactTabId),
        dashboardLoadedAt: DASHBOARD_LOADED_AT,
        commandCenterSessionId: COMMAND_CENTER_PUBLISHER.sessionId,
        commandCenterStartedAt: COMMAND_CENTER_PUBLISHER.startedAt,
        authenticatedImportAt,
      },
      runtime: runtimeDiagnostics,
      safety: {
        settingsConfirmed,
        liveChecklistReady: auditLiveChecklistReady,
        extensionConnected: extension === "connected",
        inDraftRoom: context.inDraftRoom === true,
        soundMuted: context.soundMuted === true,
        autopickActive: context.autopickActive !== false,
        autoDraft,
        sourceCoverage: 1 + healthySources.length,
        sourceIds: ["espn", ...healthySources.map((source) => source.id)].sort(),
        sourceSnapshotId,
        sourceSnapshotGeneratedAt,
        actionState,
      },
      draft: {
        totalPicks: authoritativePicks.length,
        appRoster,
        espnRoster,
      },
      telemetry: {
        actions: [...actionTelemetryRef.current],
      },
      ...(league.draftType === "AUCTION" ? { salaryCapEvidence: { sales: salaryCapEvidence } } : {}),
      sleeperEvidence: {
        candidateCount: sleeperEvidence.length,
        candidates: sleeperEvidence,
      },
      availability: {
        status: availabilityGate.status,
        digest: availabilityGate.digest,
        evaluatedAt: availabilityGate.evaluatedAt,
        freshUntil: availabilityGate.freshUntil,
        blockingReasons: [...availabilityGate.blockingReasons],
        vetoedPlayerIds: [...availabilityGate.vetoedPlayerIds],
      },
      operator: operatorSnapshot,
      ...(leagueBoard ? { leagueBoard } : {}),
      ...(liveControl ? { liveControl } : {}),
    };
    const queued = draftAuditPublisherRef.current?.enqueue({
      digest: draftAuditPublicationDigest(snapshot),
      capturedAt: snapshot.capturedAt,
      snapshot,
      binding: publisherBinding,
      decisionId: liveControl?.decision?.decisionId ?? null,
      authorizationKey: liveControl?.decision ? draftAuditPublicationDigest({
        schemaVersion: 1,
        binding: publisherBinding,
        decision: liveControl.decision,
        control: {
          sequence: liveControl.sequence,
          pendingActionCount: liveControl.pendingActionCount,
          historicalAutopickDetected: liveControl.historicalAutopickDetected,
          uncontrolledRosterAdditionDetected: liveControl.uncontrolledRosterAdditionDetected,
          unattributedRosterCount: liveControl.unattributedRosterCount,
          pickFeedLagging: liveControl.freshness.pickFeedLagging,
          sourceSnapshotAt: liveControl.freshness.sourceSnapshotAt,
        },
        safety: {
          settingsConfirmed: snapshot.safety.settingsConfirmed,
          extensionConnected: snapshot.safety.extensionConnected,
          inDraftRoom: snapshot.safety.inDraftRoom,
          autopickActive: snapshot.safety.autopickActive,
          autoDraft: snapshot.safety.autoDraft,
          sourceCoverage: snapshot.safety.sourceCoverage,
          sourceIds: snapshot.safety.sourceIds,
          sourceSnapshotId: snapshot.safety.sourceSnapshotId,
          sourceSnapshotGeneratedAt: snapshot.safety.sourceSnapshotGeneratedAt,
        },
        availability: {
          status: availabilityGate.status,
          digest: availabilityGate.digest,
          freshUntil: availabilityGate.freshUntil,
          blockingReasons: availabilityGate.blockingReasons,
        },
      }) : null,
    });
    if (queued === false) failClosedLiveControl("DRAFT_AUDIT_PUBLISHER_NOT_BOUND");
  }, [actionState, activeEspnTabId, auctionNomination?.openingBid, auditHeartbeat, authenticatedImportAt, autoDraft, authoritativePicks, availabilityGate, context, currentPick, currentRound, currentSleeperEvidence, espnPlayers, extension, failClosedLiveControl, focusPlayer, healthySources, intelligenceSnapshot, league, liveChecklistReady, liveControlVersion, liveRecommendations, myPickCount, myPicks, nextBid, nominated, nominatedAvailabilityVetoed, openRosterRows, ownNominationIntent, playerPool.playerById, recommendationPick, remainingBudget, remainingSeconds, runtimeDiagnostics, settingsConfirmed, sourceCoverageReady, telemetryVersion, workspaceRole]);

  const { commandLabel, safetyLabel } = presentation;
  const displayCommandLabel = presentation.stateTone === "blocked" && context.autopickActive !== true && focusPlayer
    ? `${league.draftType === "SNAKE" ? "PREPARE" : "TRACK"} ${focusPlayer.name}`
    : commandLabel;
  const displayLiveBoardRank = resolveLiveBoardDisplayRank(focusPlayer, liveRecommendations);
  const actionSurfaceStatus = resolveActionSurfaceStatus({
    actionWindowOpen,
    onClock: context.onClock === true,
    inDraftRoom: context.inDraftRoom === true,
    remainingSeconds,
    minimumActionWindow,
  });
  const displayActionState = resolveLiveOperatorStatus({
    actionState,
    draftType: league.draftType,
    commandLabel: displayCommandLabel,
    nominatedPlayerName: nominated?.name,
    currentBid: context.currentBid,
  });
  const alternatives = liveRecommendations.filter((player) => player.id !== focusPlayer?.id).slice(0, 3);

  return <main className="app-shell">
    <header className="topbar">
      <div className="brand"><span className="brand-mark">DF</span><span>DraftForge <b>AI</b></span></div>
      <div className={`draft-status ${actionWindowOpen ? "on-clock" : ""}`}><span className="live-dot" />{extension === "connected" ? actionSurfaceStatus.header : "DRAFT CONTROL ROOM"}<strong>{league.draftType === "SNAKE" ? `Round ${currentRound} · Pick ${currentPick}${Number.isFinite(remainingSeconds) ? ` · ${remainingSeconds}s` : ""}` : `$${league.auctionBudget - spent} remaining`}</strong></div>
      <div className="header-actions">
        <button className={`auto-toggle ${autoDraft ? "enabled" : ""}`} onClick={enableAutoDraft} disabled={autoDraft ? false : !liveChecklistReady} aria-label={`Auto-Draft ${autoDraft ? "ON" : "OFF"}`}><i /><span className="desktop-label">Auto-Draft {autoDraft ? "ON" : "OFF"}</span><span className="mobile-label">Auto {autoDraft ? "ON" : "OFF"}</span></button>
        <button className="settings-button" onClick={() => dispatchUi({ type: "set", key: "settingsOpen", value: true })}><span className="desktop-label">League rules</span><span className="mobile-label">Rules</span></button>
      </div>
    </header>

    <section className="operations-bar" aria-label="Live draft operations">
      <div className="ops-league"><span className="platform-chip">E</span><div><select className="league-switcher" aria-label="Active ESPN league" value={league.id} onChange={(event) => { if (event.target.value === "__new") startAnotherLeague(); else { const profile = profiles[event.target.value]; if (profile) activateProfile(profile); } }}><option value="demo">{league.id === "demo" ? league.name : "Choose draft"}</option>{Object.values(profiles).sort((a, b) => a.league.name.localeCompare(b.league.name)).map((profile) => <option key={profile.league.id} value={profile.league.id}>{profile.league.name}</option>)}<option value="__new">＋ Import another ESPN league</option></select><small>{league.size}-team · {league.scoringLabel} · {league.draftType === "AUCTION" ? `$${league.auctionBudget} salary cap` : "Snake"}</small></div></div>
      <div className="ops-progress"><div><span>Draft progress</span><b>{authoritativePicks.length} / {league.size * league.rosterSize}</b></div><div className="progress" role="progressbar" aria-label="Draft progress" aria-valuemin={0} aria-valuemax={league.size * league.rosterSize} aria-valuenow={authoritativePicks.length}><i style={{ width: `${Math.min(100, authoritativePicks.length / Math.max(1, league.size * league.rosterSize) * 100)}%` }} /></div><small>{league.draftType === "SNAKE" ? `Round ${currentRound} · Pick ${currentPick}` : `$${remainingBudget} remaining · ${openRosterRows.length} spots open`}</small></div>
      <div className="ops-controls">
        <button className="ops-control" onClick={() => dispatchUi({ type: "toggle", key: "strategyOpen" })} aria-expanded={strategyOpen}><span>Strategy</span><b>{strategyInfo.label}</b><small>{strategyInfo.description}</small></button>
        <button className={`ops-control intelligence-control ${sourceCoverageReady ? "healthy" : "blocked"}`} onClick={() => dispatchUi({ type: "toggle", key: "sourcesOpen" })} aria-expanded={sourcesOpen}><span>Decision data</span><b>{intelligenceLoading ? "Refreshing…" : `${1 + healthySources.length}/5 sources live`}</b><small>Deterministic weighted consensus</small></button>
      </div>
      <div className={`ops-status ${displayActionState.includes("stopped") || presentation.stateTone === "blocked" ? "blocked" : ""}`} role="status" aria-live="polite"><span>{extension === "connected" ? "LIVE STATUS" : "CONNECTION"}</span><b>{displayActionState}</b><small><i aria-hidden="true">●</i>{extension === "connected" ? `Exact ESPN league ${league.id}` : extension === "missing" ? "Companion not detected" : extension === "connecting" ? "Connecting to ESPN…" : "ESPN companion ready"}</small></div>
      {strategyOpen && <div className="strategy-menu">{STRATEGIES.map((item) => <button key={item.id} className={strategy === item.id ? "active" : ""} onClick={() => { setStrategy(item.id); dispatchUi({ type: "set", key: "strategyOpen", value: false }); }}><b>{item.label}</b><small>{item.description}</small></button>)}</div>}
      {sourcesOpen && <div className="sources-menu"><div><b>Decision intelligence</b><button onClick={() => dispatchUi({ type: "set", key: "sourcesOpen", value: false })} aria-label="Close source details">×</button></div><p>ESPN anchors league projections and salary values at 30%. Every healthy ranking feed is converted into a league-normalized theoretical dollar curve; MFL AAV and ESPN dollars remain live market anchors.</p><ul><li><span className="source-ok">●</span><b>ESPN Fantasy</b><small>30% · projection, ADP, salary value</small></li>{sources.map((source) => { const fresh = isIntelligenceSourceFresh(source); return <li key={source.id}><span className={fresh ? "source-ok" : "source-error"}>●</span><b>{source.name}</b><small>{Math.round(source.weight * 100)}% · {source.kind}{source.sampleSize ? ` · ${source.sampleSize.toLocaleString()} drafts` : ""}{source.updatedAt ? ` · ${new Date(source.updatedAt).toLocaleString()}` : ""} · <a href={source.url} target="_blank" rel="noreferrer">source</a></small></li>; })}</ul><small>All five fixed-weight sources must be fresh and complete before DraftForge can act. Missing or stale data keeps every ESPN action locked.</small></div>}
    </section>

    {(settingsOpen || (extension !== "connected" && league.id !== "demo")) && <section className="setup-drawer">
      {extension !== "connected" ? <div className="connect-card">
        <div><p className="eyebrow">PREFLIGHT 1 OF 2 · CONNECT ESPN</p><h1>Import your real draft.</h1><p>Open your ESPN league in another Chrome tab. The companion reads your authenticated settings without exposing your password or cookies.</p></div>
        <label>League ID <input value={leagueId} onChange={(event) => setLeagueId(event.target.value.replace(/\D/g, ""))} placeholder="Auto-detect or enter ID" inputMode="numeric" /></label>
        <button className="primary-button" onClick={connect} disabled={extension === "missing" || extension === "connecting"}>{extension === "connecting" ? "Importing…" : "Import from ESPN"}</button>
        {extension === "missing" && <p className="connect-error">Download and unzip the Chrome companion, load that folder at chrome://extensions, then refresh this page.</p>}
        <a className="extension-download" href="/draftforge-espn-companion.zip" download>Download Chrome companion ↓</a>
        <div className="preview-formats" aria-label="Preview a draft command center">
          <span>Preview the command center</span>
          <button className={league.id === "demo" && league.draftType === "SNAKE" ? "active" : ""} onClick={() => previewDraftFormat("SNAKE")}>Snake</button>
          <button className={league.id === "demo" && league.draftType === "AUCTION" ? "active" : ""} onClick={() => previewDraftFormat("AUCTION")}>Salary cap</button>
        </div>
      </div> : <div className="rules-card">
        <div className="rules-heading"><div><p className="eyebrow">PREFLIGHT 2 OF 2 · VERIFY LEAGUE</p><h2>Confirm ESPN league rules</h2><p>Draft actions stay locked until these imported settings match your ESPN league.</p></div><button onClick={() => dispatchUi({ type: "set", key: "settingsOpen", value: false })} aria-label="Close settings">×</button></div>
        <div className="rule-grid">
          <div><span>Draft</span><b>{league.draftType === "AUCTION" ? "Salary cap" : "Snake"}</b><small>{league.secondsPerPick}s timer{league.keeperCount ? ` · ${league.keeperCount} keepers` : " · no keepers"}</small></div>
          <div><span>League</span><b>{league.size} teams</b><small>{league.rosterSize} roster spots</small></div>
          <div><span>Scoring</span><b>{league.scoringLabel}</b><small>{league.scoringRules} imported scoring rules</small></div>
          <div><span>{league.draftType === "AUCTION" ? "Budget" : "Draft order"}</span><b>{league.draftType === "AUCTION" ? `$${league.auctionBudget}` : league.pickOrder.length ? `${league.pickOrder.length} slots imported` : "Set by ESPN"}</b><small>{league.draftType === "AUCTION" ? "$1 minimum per open slot" : "Live order follows ESPN"}</small></div>
        </div>
        <div className="slot-summary"><span>Roster:</span>{Object.entries(league.lineupSlotCounts).filter(([, count]) => Number(count) > 0).map(([slot, count]) => <b key={slot}>{rosterSlots({ ...league, lineupSlotCounts: { [slot]: count } })[0] || `Slot ${slot}`} × {count}</b>)}</div>
        <div className="checklist-grid">
          <div><b>Pre-draft import check</b>{preflightChecks.map((check) => <span className={check.ok ? "pass" : "fail"} key={check.label}>{check.ok ? "✓" : "○"} {check.label}</span>)}</div>
          <div><b>Live-room dry run</b>{liveChecks.map((check) => <span className={check.ok ? "pass" : "fail"} key={check.label}>{check.ok ? "✓" : "○"} {check.label}</span>)}</div>
        </div>
        {league.draftType === "AUCTION" && <div className="auction-plan"><b>Predefined budget plan</b>{Object.entries(auctionPlan.positionBudgets).map(([position, amount]) => <span key={position}>{position} <strong>${amount}</strong></span>)}<small>${auctionPlan.endgameReserve} late leverage protected. Walk-away prices adapt to remaining-dollar inflation and tier supply without crossing these portfolio envelopes.</small></div>}
        <button className="raw-toggle" onClick={() => dispatchUi({ type: "toggle", key: "rawSettingsOpen" })}>{rawSettingsOpen ? "Hide" : "Inspect"} all imported ESPN fields</button>
        {rawSettingsOpen && <pre className="raw-settings">{JSON.stringify(league.rawSettings || league, null, 2)}</pre>}
        <div className="rule-actions"><button className="secondary-button" onClick={connect}>Re-import</button><button className="primary-button" disabled={!preflightReady} onClick={confirmPreDraftChecklist}>{context.inDraftRoom === true ? "Confirm live-room checklist" : "Confirm + arm live draft"}</button></div>
      </div>}
    </section>}

    <section className="workspace">
      <aside className="coach-column">
        {(focusPlayer || myPickCount >= league.rosterSize) && <section className="recommendation panel" aria-labelledby="decision-title">
          <div className="decision-head">
            <div><p className="eyebrow">DO THIS NOW · {league.draftType === "AUCTION" ? "SALARY CAP" : "SNAKE"}</p><h1 id="decision-title">{displayCommandLabel}</h1></div>
            <span className={`decision-state ${presentation.stateTone}`}>{presentation.stateLabel}</span>
          </div>
          {myPickCount >= league.rosterSize ? <>
            <div className="decision-hero completion-hero">
              <div className="rec-player"><div className="avatar">✓</div><div><h2>ESPN roster confirmed</h2><p>{myPickCount} of {league.rosterSize} slots complete · exact room {league.id}</p></div></div>
              <div className="command-number"><span>FINAL ROSTER</span><strong>{myPickCount}/{league.rosterSize}</strong><small>{league.draftType === "AUCTION" ? `$${remainingBudget} remaining` : "Every pick reconciled"}</small></div>
            </div>
            <div className="decision-safety" role="status" aria-live="polite"><span aria-hidden="true">✓</span><b>{safetyLabel}</b></div>
          </> : focusPlayer ? <>
          {nominated && <p className="auction-live">LIVE NOMINATION · {context.currentBid ? `$${context.currentBid}` : "Opening bid"}{ownNominationIntent ? ` · ${ownNominationIntent}` : ""}</p>}
          {!nominated && league.draftType === "AUCTION" && auctionNomination && <p className="auction-live">{auctionNomination.intent} NOMINATION · OPEN ${auctionNomination.openingBid}</p>}
          <div className="decision-hero">
            <div className="rec-player"><div className={`avatar ${focusPlayer.pos.toLowerCase()}`}>{focusPlayer.name.split(" ").map((part) => part[0]).join("").slice(0, 2)}</div><div><h2>{focusPlayer.name}</h2><p>{focusPlayer.pos} · {focusPlayer.team} <span>Live board #{displayLiveBoardRank || "—"}</span>{focusPlayer.sleeperLabel !== "NONE" && <span className="sleeper-chip">{focusPlayer.sleeperLabel.replace("_", " ")} {focusPlayer.sleeperScore}/100</span>}</p></div></div>
            <div className="command-number"><span>{league.draftType === "AUCTION" ? nominated ? "NEXT LEGAL BID" : "OPENING BID" : "ESPN CLOCK"}</span><strong>{league.draftType === "AUCTION" ? `$${nominated ? nextBid : auctionNomination?.openingBid || 1}` : Number.isFinite(remainingSeconds) ? `${remainingSeconds}s` : "—"}</strong><small>{league.draftType === "AUCTION" ? `Walk at $${exactLiveBidCeiling}` : `Round ${currentRound} · Pick ${currentPick}`}</small></div>
          </div>
          <div className={`decision-safety ${presentation.stateTone === "blocked" ? "blocked" : ""}`} role="status" aria-live="polite"><span aria-hidden="true">{presentation.stateTone === "blocked" ? "!" : "✓"}</span><b>{safetyLabel}</b></div>
          <div className="decision-metrics">
            {league.draftType === "AUCTION" ? <>
              <div><span>Current offer</span><b>{context.currentBid ? `$${context.currentBid}` : "—"}</b></div>
              <div><span>Fair value</span><b>${displayAuctionValue(focusPlayer.id, league.id, focusPlayer.fairValue)}</b></div>
              <div className="metric-emphasis"><span>Hard ceiling</span><b>${exactLiveBidCeiling}</b></div>
              <div><span>{nominated ? "After next bid" : "Reserve floor"}</span><b>{nominated ? `$${Math.max(0, remainingBudget - nextBid)} left` : `$${currentReserve}`}</b><small>{nominated ? `$${postWinReserve} reserve required` : "$1 per open slot"}</small></div>
            </> : <>
              <div><span>ADP edge</span><b>{`${focusPlayer.adpValue >= 0 ? "+" : ""}${focusPlayer.adpValue.toFixed(1)}`}</b></div>
              <div><span>VORP</span><b>+{focusPlayer.vorp.toFixed(1)}</b></div>
              <div><span>Tier drop</span><b>{focusPlayer.scarcity.toFixed(1)}</b></div>
              <div><span>Source confidence</span><b>{focusPlayer.confidence}%</b></div>
            </>}
          </div>
          {league.draftType === "SNAKE" ? <button className="draft-button full" onClick={() => submit(focusPlayer, false, "SELECT")} disabled={!settingsConfirmed || extension !== "connected" || !actionWindowOpen}>Draft {focusPlayer.name} in ESPN<small>{Number.isFinite(remainingSeconds) ? `${remainingSeconds}s remaining` : "Waiting for verified clock"}</small></button> : <div className="pick-actions"><button className="draft-button" onClick={() => auctionNomination && submit(auctionNomination.player, false, "NOMINATE", auctionNomination.openingBid, auctionNomination.intent)} disabled={!settingsConfirmed || extension !== "connected" || !actionWindowOpen || Boolean(nominated || context.nominatedPlayer || Number(context.currentBid || 0) > 0) || !auctionNomination}>Nominate {auctionNomination?.intent === "DRAIN" ? "budget drain" : "target"}<small>Open ${auctionNomination?.openingBid || 1}</small></button><button className="bid-button" onClick={() => submit(focusPlayer, false, "BID", nextBid)} disabled={!settingsConfirmed || extension !== "connected" || !nominated || nominatedAvailabilityVetoed || context.leadingBid !== false || ownNominationIntent === "DRAIN" || nextBid > exactLiveBidCeiling || !bidWindowOpen}>{nominatedAvailabilityVetoed ? "Pass — player unavailable" : ownNominationIntent === "DRAIN" ? "Pass — no price enforcing" : context.leadingBid === true ? "Hold — already leading" : context.leadingBid !== false ? "Pass — lead state unknown" : nextBid > exactLiveBidCeiling ? "Pass — ceiling reached" : `Bid $${nextBid}`}<small>{nominatedAvailabilityVetoed ? "Availability veto active" : ownNominationIntent === "DRAIN" ? "Decoy nomination" : context.leadingBid !== false ? "Waiting for authoritative bidder state" : `Hard stop $${exactLiveBidCeiling}`}</small></button></div>}
          {!settingsConfirmed && <small className="locked-note">Confirm imported league rules to unlock ESPN actions.</small>}
          <details className="decision-details"><summary>Decision intelligence <span>{focusPlayer.confidence}% confidence</span></summary><div className="confidence"><div><span>Source agreement · {focusPlayer.sourceCount || 1}/5 sources</span><b>{focusPlayer.confidence}%</b></div><div className="confidence-track"><i style={{ width: `${focusPlayer.confidence}%` }} /></div></div><p className="reason">{describeRecommendation(focusPlayer, league, strategy)}</p>{league.draftType === "AUCTION" && focusPlayer.sourceAuctions && <div className="source-values">{Object.entries(focusPlayer.sourceAuctions).map(([source, amount]) => <span key={source}>{source.toUpperCase()} <b>${Math.round(amount)}</b></span>)}</div>}<ul className="reason-list">{focusPlayer.reasons.slice(0, 4).map((reason) => <li key={reason}>{reason}</li>)}</ul></details>
          </> : null}
        </section>}
        <section className="on-clock-card panel"><span className={actionWindowOpen ? "pulse" : ""} aria-hidden="true">●</span><div><b>{actionSurfaceStatus.detail}</b><small>{autoDraft ? "Auto-Draft is armed only for this verified league and tab." : "Guided mode: you approve every pick, nomination, and bid."}</small></div></section>
      </aside>

      <aside className="roster-panel panel">
        <div className="roster-head"><div><p className="eyebrow">ROSTER CONTROL</p><h2>Team build</h2></div><span>{myRoster.length} / {league.rosterSize}</span></div>
        <div className="needs-block"><div><span>Open roster spots</span><b>{openRosterRows.length}</b></div><div className="needs-chips">{openRosterRows.slice(0, 8).map(({ slot }, index) => <span key={`${slot}-${index}`}>{slot}</span>)}{openRosterRows.length > 8 && <span>+{openRosterRows.length - 8}</span>}</div></div>
        {league.draftType === "AUCTION" && <>
          <div className="budget-card"><div><span>Remaining</span><b>${remainingBudget}</b></div><div><span>Protected reserve</span><b>${currentReserve}</b><small>$1 per open slot</small></div><div><span>Room market</span><b>{auctionPlan.roomInflation.toFixed(2)}×</b><small>{Math.round(auctionPlan.knownSaleCoverage * 100)}% exact sales</small></div></div>
          <div className="budget-runway"><div><span>Spendable runway</span><b>${spendableBudget}</b><small>${currentReserve} untouchable reserve</small></div><div className="budget-runway-track" role="progressbar" aria-label="Spendable salary-cap runway" aria-valuemin={0} aria-valuemax={Math.max(1, remainingBudget)} aria-valuenow={spendableBudget}><i style={{ width: `${Math.min(100, spendableBudget / Math.max(1, remainingBudget) * 100)}%` }} /></div><p>Every offer must leave $1 for each open roster spot. The hard ceiling can only move down as the room changes.</p></div>
          <div className="budget-plan-mini">{Object.entries(auctionPlan.positionBudgets).map(([position, budget]) => <span key={position}>{position} <b>${auctionUsage.usage[position] || 0} / ${budget}</b></span>)}{auctionUsage.reallocated > 0 && <span>VALUE <b>${auctionUsage.reallocated} reallocated</b></span>}</div>
          <details className="secondary-details"><summary>Opponent leverage <span>${auctionPlan.opponentSpend} spent</span></summary><div className="opponent-budgets">{[...auctionPlan.opponents].sort((left, right) => right.maxOffer - left.maxOffer).map((opponent) => <span key={opponent.teamId}><em>{opponent.name}</em><small>{opponent.players} players · ${opponent.spent} spent · max ${opponent.maxOffer} · needs {Object.entries(opponent.openStarters).filter(([, count]) => count > 0).map(([position, count]) => `${position}${count > 1 ? count : ""}`).join("/") || "depth"}</small></span>)}</div></details>
        </>}
        <div className="roster-list">{rosterRows.map(({ slot, item }, index) => <div className={`roster-row ${item ? "filled" : ""}`} key={`${slot}-${index}`}><span>{slot}</span>{item ? <><div><b>{item.player.name}</b><small>{item.player.team}{item.pick.amount ? ` · $${item.pick.amount}` : ""}</small></div><i className={`pos ${item.player.pos.toLowerCase()}`}>{item.player.pos}</i></> : <em>Open</em>}</div>)}</div>
        <details className="secondary-details activity-details"><summary>Recent ESPN activity <span>{authoritativePicks.length} picks</span></summary><div className="draft-log">{authoritativePicks.slice(-5).reverse().map((pick) => { const player = players.find((item) => item.id === pick.playerId); return <div key={`${pick.overall}-${pick.playerId}`}><span>{pick.overall}</span><b>{player?.name || `Player ${pick.playerId}`}</b><small>{pick.amount ? `$${pick.amount}` : `Team ${pick.teamId}`}</small></div>; })}{!authoritativePicks.length && <small>No picks imported yet.</small>}</div></details>
      </aside>

      <section className="players-panel panel">
        <div className="panel-head"><div><p className="eyebrow">NEXT BEST OPTIONS</p><h2>Live player board</h2></div><label className="search-box"><span aria-hidden="true">⌕</span><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search player or team" aria-label="Search player or team" /></label></div>
        {alternatives.length > 0 && <div className="alternatives" aria-label="Top alternatives">{alternatives.map((player, index) => <button key={player.id} onClick={() => setSelectedId(player.id)}><span>#{index + 2} alternative</span><b>{player.name}</b><small>{player.pos} · {league.draftType === "AUCTION" ? `$${displayAuctionValue(player.id, league.id, player.fairValue)} fair` : `ADP ${player.adp < 900 ? player.adp.toFixed(1) : "—"}`}</small></button>)}</div>}
        <div className="filters" aria-label="Filter player board">{FILTERS.map((item) => <button key={item} className={filter === item ? "active" : ""} onClick={() => setFilter(item)} aria-pressed={filter === item}>{item}</button>)}</div>
        <div className="table-head" aria-hidden="true"><span>#</span><span>PLAYER</span><span>POS</span><span>{league.draftType === "AUCTION" ? "FAIR $" : "ADP"}</span><span>PROJ</span><span>MODEL</span></div>
        <div className="player-list">{visible.slice(0, 150).map((player, index) => <button key={player.id} className={`player-row ${selected?.id === player.id ? "selected" : ""}`} onClick={() => setSelectedId(player.id)} aria-pressed={selected?.id === player.id}>
          <span className="rank">{index + 1}</span><span className="player-name"><span><b>{player.name}</b><small>{player.team}{player.injured ? " · Injury flag" : ""}{player.sleeperLabel !== "NONE" ? ` · ${player.sleeperLabel.replace("_", " ")} ${player.sleeperScore}` : ""}</small></span></span><i className={`pos ${player.pos.toLowerCase()}`}>{player.pos}</i><span>{league.draftType === "AUCTION" ? `$${displayAuctionValue(player.id, league.id, player.fairValue)}` : player.adp < 900 ? player.adp.toFixed(1) : "—"}</span><span>{player.projected ? player.projected.toFixed(1) : "—"}</span><span className="model-score">{Math.round(player.score)}</span>
          {index === 0 && <em className="best-badge">BEST FIT</em>}
        </button>)}</div>
      </section>
    </section>

    {autoWarning && <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label="Enable Auto-Draft"><div className="warning-modal"><span className="warning-icon">!</span><h2>Live-room checklist passed</h2><p>The extension is bound to the exact imported ESPN draft tab and the local control room completed a no-click recommendation dry run.</p><ul>{liveChecks.map((check) => <li key={check.label}>✓ {check.label}</li>)}<li>{league.draftType === "AUCTION" ? "Offers rise by exactly $1 and stop at the lower of fair value, portfolio walk-away, pacing guardrail, and ESPN's legal maximum; DraftForge never rebids on its own DRAIN nomination." : "Each pick is re-ranked against the live remaining pool and positional tier cliffs."}</li><li>Turn Auto-Draft off at any time.</li></ul><div><button className="secondary-button" onClick={() => dispatchUi({ type: "set", key: "autoWarning", value: false })}>Cancel</button><button className="danger-button" onClick={confirmEnableAutoDraft}>Enable Auto-Draft</button></div></div></div>}
    <footer><span>DraftForge AI · draft-only ESPN control room</span><span>{draftedIds.size} drafted · five-source deterministic consensus</span></footer>
  </main>;
}
