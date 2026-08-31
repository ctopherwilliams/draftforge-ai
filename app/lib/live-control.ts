export const LIVE_CONTROL_SCHEMA_VERSION = 1 as const;
export const MAX_LIVE_CONTROL_EVENTS = 256;
export const MAX_LIVE_CONTROL_ATTRIBUTIONS = 64;
export const MAX_LIVE_DECISION_ALTERNATIVES = 5;

export type LiveControlOperation = "SELECT" | "BID" | "NOMINATE";
export type LiveControlPosition = "QB" | "RB" | "WR" | "TE" | "DST" | "K";
export type LiveNominationIntent = "TARGET" | "DRAIN";

export type LivePlayerIdentity = {
  playerId: number;
  playerName: string;
  position?: LiveControlPosition;
};

export type LiveDecisionEnvelope = {
  decisionId: string;
  decidedAt: string;
  contextCapturedAt: string;
  leagueId: string;
  teamId: number;
  tabId: number;
  operation: LiveControlOperation;
  sourceSnapshotId: string;
  availabilityDigest?: string;
  availabilityDecisionDigest?: string;
  expectedPick?: number;
  submitNotBeforeAt?: string;
  submitTargetSeconds?: number;
  intendedPlayer: LivePlayerIdentity;
  resolvedPlayer?: LivePlayerIdentity;
  expectedCurrentBid?: number;
  intendedOffer?: number;
  resolvedOffer?: number;
  maxApprovedBid?: number;
  nominationIntent?: LiveNominationIntent;
  notAfter?: number;
  alternatives: LivePlayerIdentity[];
};

export type LiveActionLifecyclePhase =
  | "PLANNED"
  | "RESOLVED"
  | "CLICK_SENT"
  | "ESPN_ACKNOWLEDGED"
  | "ROSTER_CONFIRMED"
  | "ACTION_COMPLETED"
  | "FAILED"
  | "CANCELLED";

export type LiveSafetyCondition =
  | "ESPN_AUTOPICK"
  | "SOURCE_COVERAGE"
  | "EXACT_BINDING"
  | "CLOCK"
  | "ACTION_SURFACE"
  | "CODE_FREEZE";

export type LiveRosterAttributionKind =
  | "DRAFTFORGE_CONFIRMED"
  | "USER_MANUAL"
  | "ESPN_AUTOPICK"
  | "UNKNOWN_EXTERNAL";

type LiveControlEventBase = {
  sequence: number;
  occurredAt: string;
};

export type LiveActionLifecycleEvent = LiveControlEventBase & {
  kind: "ACTION_LIFECYCLE";
  actionId: string;
  decisionId: string;
  operation: LiveControlOperation;
  phase: LiveActionLifecyclePhase;
  intendedPlayer?: LivePlayerIdentity;
  resolvedPlayer?: LivePlayerIdentity;
  intendedOffer?: number;
  resolvedOffer?: number;
  code?: string;
};

export type LiveSafetyEvent = LiveControlEventBase & {
  kind: "SAFETY";
  condition: LiveSafetyCondition;
  active: boolean;
  code: string;
};

export type LiveRosterAttributionEvent = LiveControlEventBase & {
  kind: "ROSTER_ATTRIBUTION";
  player: LivePlayerIdentity;
  attribution: LiveRosterAttributionKind;
  actionId?: string;
  decisionId?: string;
};

export type LiveControlEvent = LiveActionLifecycleEvent | LiveSafetyEvent | LiveRosterAttributionEvent;

export type LiveRosterAttribution = {
  player: LivePlayerIdentity;
  attribution: LiveRosterAttributionKind;
  occurredAt: string;
  actionId?: string;
  decisionId?: string;
};

export type LiveControlFreshness = {
  espnContextAt: string | null;
  /** Last authoritative pick/sale identity advance; diagnostic only. */
  pickFeedAt: string | null;
  /** Last accepted exact-room reconciled feed response, even when unchanged. */
  pickFeedObservedAt: string | null;
  /** True only when visible completed draft progress is ahead of that feed. */
  pickFeedLagging: boolean;
  sourceSnapshotAt: string | null;
  lastActionAt: string | null;
};

export type LiveControlState = {
  schemaVersion: typeof LIVE_CONTROL_SCHEMA_VERSION;
  sessionId: string;
  sequence: number;
  pendingActionCount: number;
  historicalAutopickDetected: boolean;
  uncontrolledRosterAdditionDetected: boolean;
  unattributedRosterCount: number;
  decision: LiveDecisionEnvelope | null;
  freshness: LiveControlFreshness;
  rosterAttributions: LiveRosterAttribution[];
  events: LiveControlEvent[];
};

export type LiveControlCompactView = {
  schemaVersion: typeof LIVE_CONTROL_SCHEMA_VERSION;
  sessionId: string;
  sequence: number;
  /** Oldest event still present in the bounded ledger, or zero before the first event. */
  earliestRetainedSequence: number;
  /** True when the requested delta begins before the bounded ledger. */
  truncated: boolean;
  unchanged: boolean;
  pendingActionCount: number;
  historicalAutopickDetected: boolean;
  uncontrolledRosterAdditionDetected: boolean;
  unattributedRosterCount: number;
  decision: LiveDecisionEnvelope | null;
  freshness: LiveControlFreshness;
  agesMs: {
    espnContext: number | null;
    pickFeed: number | null;
    pickFeedObserved: number | null;
    sourceSnapshot: number | null;
    lastAction: number | null;
    decision: number | null;
    decisionContext: number | null;
  };
  rosterAttributions: LiveRosterAttribution[];
  events: LiveControlEvent[];
};

export type LiveControlTransitionResult = {
  ok: boolean;
  code: string;
};

/**
 * A writer lease exists only for an exact live-room binding. Pre-room ESPN
 * imports deliberately have no live-control state and must never emit lease
 * heartbeats: a background mismatch there is expected, not a connection
 * failure.
 */
export function writerLeaseHeartbeatAllowed(
  liveControlActive: boolean,
  currentBinding: string,
  expectedBinding: string | null,
) {
  return liveControlActive === true
    && Boolean(expectedBinding)
    && currentBinding === expectedBinding;
}

export function writerLeaseHeartbeatSnapshotStillCurrent(
  liveControlActive: boolean,
  currentBinding: string,
  expectedBinding: string | null,
  currentControlSessionId: string,
  requestedBinding: string,
  requestedControlSessionId: string,
) {
  return writerLeaseHeartbeatAllowed(liveControlActive, currentBinding, expectedBinding)
    && requestedBinding === currentBinding
    && requestedControlSessionId === currentControlSessionId;
}

export function writerLeaseHeartbeatAcknowledged(
  ok: boolean,
  expiresAt: number,
  now: number,
) {
  return ok === true && Number.isFinite(expiresAt) && expiresAt > now;
}

export function writerLeaseHelloRecoveryAllowed(
  failureCode: string,
  actionInFlight: boolean,
  currentBinding: string,
  expectedBinding: string | null,
  attemptedBinding: string,
) {
  return failureCode === "WRITER_LEASE_EXPIRED"
    && actionInFlight === false
    && Boolean(expectedBinding)
    && currentBinding === expectedBinding
    && attemptedBinding !== currentBinding;
}

export function authenticatedImportRetiresLiveControl(
  currentLeagueId: string,
  importedLeagueId: string,
  importedInDraftRoom: boolean | undefined,
) {
  return importedInDraftRoom !== true || currentLeagueId !== importedLeagueId;
}

const OPERATIONS = new Set<LiveControlOperation>(["SELECT", "BID", "NOMINATE"]);
const POSITIONS = new Set<LiveControlPosition>(["QB", "RB", "WR", "TE", "DST", "K"]);
const NOMINATION_INTENTS = new Set<LiveNominationIntent>(["TARGET", "DRAIN"]);
const ACTION_PHASES = new Set<LiveActionLifecyclePhase>([
  "PLANNED",
  "RESOLVED",
  "CLICK_SENT",
  "ESPN_ACKNOWLEDGED",
  "ROSTER_CONFIRMED",
  "ACTION_COMPLETED",
  "FAILED",
  "CANCELLED",
]);
const SAFETY_CONDITIONS = new Set<LiveSafetyCondition>([
  "ESPN_AUTOPICK",
  "SOURCE_COVERAGE",
  "EXACT_BINDING",
  "CLOCK",
  "ACTION_SURFACE",
  "CODE_FREEZE",
]);
const ATTRIBUTIONS = new Set<LiveRosterAttributionKind>([
  "DRAFTFORGE_CONFIRMED",
  "USER_MANUAL",
  "ESPN_AUTOPICK",
  "UNKNOWN_EXTERNAL",
]);
const SAFE_IDENTIFIER = /^[A-Za-z0-9._:-]{1,128}$/;
const SAFE_CODE = /^[A-Z0-9_]{1,64}$/;
const TERMINAL_ACTION_PHASES = new Set<LiveActionLifecyclePhase>(["ROSTER_CONFIRMED", "ACTION_COMPLETED", "FAILED", "CANCELLED"]);
const ACTION_PHASE_ORDER: Record<LiveActionLifecyclePhase, number> = {
  PLANNED: 0,
  RESOLVED: 1,
  CLICK_SENT: 2,
  ESPN_ACKNOWLEDGED: 3,
  ROSTER_CONFIRMED: 4,
  ACTION_COMPLETED: 4,
  FAILED: 4,
  CANCELLED: 4,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isTimestamp(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function isNullableTimestamp(value: unknown): value is string | null {
  return value === null || isTimestamp(value);
}

function isNonNegativeInteger(value: unknown) {
  return Number.isInteger(value) && Number(value) >= 0;
}

function isPositiveInteger(value: unknown) {
  return Number.isInteger(value) && Number(value) > 0;
}

function isOptionalNonNegativeInteger(value: unknown) {
  return value === undefined || isNonNegativeInteger(value);
}

function isSafeIdentifier(value: unknown) {
  return typeof value === "string" && SAFE_IDENTIFIER.test(value);
}

function isSafeCode(value: unknown) {
  return typeof value === "string" && SAFE_CODE.test(value);
}

function isSafePlayerName(value: unknown) {
  return typeof value === "string"
    && value.length <= 120
    && value.trim().length > 0
    && ![...value].some((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint <= 31 || codePoint === 127;
    });
}

export function isLivePlayerIdentity(value: unknown): value is LivePlayerIdentity {
  if (!isRecord(value)) return false;
  return Number.isInteger(value.playerId)
    && Number(value.playerId) !== 0
    && isSafePlayerName(value.playerName)
    && (value.position === undefined || POSITIONS.has(value.position as LiveControlPosition));
}

export function isLiveDecisionEnvelope(value: unknown): value is LiveDecisionEnvelope {
  if (!isRecord(value)) return false;
  if (!isSafeIdentifier(value.decisionId)
    || !isTimestamp(value.decidedAt)
    || !isTimestamp(value.contextCapturedAt)
    || !isSafeIdentifier(value.leagueId)
    || !isPositiveInteger(value.teamId)
    || !isPositiveInteger(value.tabId)
    || !OPERATIONS.has(value.operation as LiveControlOperation)
    || !isSafeIdentifier(value.sourceSnapshotId)
    || (value.availabilityDigest !== undefined && !/^sha256:[a-f0-9]{64}$/.test(String(value.availabilityDigest)))
    || (value.availabilityDecisionDigest !== undefined && !/^sha256:[a-f0-9]{64}$/.test(String(value.availabilityDecisionDigest)))
    || ((value.availabilityDigest === undefined) !== (value.availabilityDecisionDigest === undefined))
    || !isLivePlayerIdentity(value.intendedPlayer)
    || (value.resolvedPlayer !== undefined && !isLivePlayerIdentity(value.resolvedPlayer))
    || !isOptionalNonNegativeInteger(value.expectedCurrentBid)
    || !isOptionalNonNegativeInteger(value.intendedOffer)
    || !isOptionalNonNegativeInteger(value.resolvedOffer)
    || !isOptionalNonNegativeInteger(value.maxApprovedBid)
    || (value.nominationIntent !== undefined && !NOMINATION_INTENTS.has(value.nominationIntent as LiveNominationIntent))
    || (value.notAfter !== undefined && (!Number.isSafeInteger(value.notAfter) || Number(value.notAfter) <= 0))
    || (value.expectedPick !== undefined && !isPositiveInteger(value.expectedPick))
    || (value.submitTargetSeconds !== undefined && !isNonNegativeInteger(value.submitTargetSeconds))
    || (value.submitNotBeforeAt !== undefined && !isTimestamp(value.submitNotBeforeAt))
    || !Array.isArray(value.alternatives)
    || value.alternatives.length > MAX_LIVE_DECISION_ALTERNATIVES
    || !value.alternatives.every(isLivePlayerIdentity)) return false;
  const operationFieldsValid = value.operation === "SELECT"
    ? isPositiveInteger(value.expectedPick)
      && value.expectedCurrentBid === undefined
      && value.intendedOffer === undefined
      && value.resolvedOffer === undefined
      && value.maxApprovedBid === undefined
      && value.nominationIntent === undefined
    : value.operation === "BID"
      ? value.expectedPick === undefined
        && isNonNegativeInteger(value.expectedCurrentBid)
        && isPositiveInteger(value.intendedOffer)
        && Number(value.intendedOffer) === Number(value.expectedCurrentBid) + 1
        && isNonNegativeInteger(value.maxApprovedBid)
        && Number(value.intendedOffer) <= Number(value.maxApprovedBid)
        && value.nominationIntent === undefined
      : value.expectedPick === undefined
        && value.expectedCurrentBid === undefined
        && isPositiveInteger(value.intendedOffer)
        && value.maxApprovedBid === undefined
        && NOMINATION_INTENTS.has(value.nominationIntent as LiveNominationIntent);
  if (!operationFieldsValid) return false;
  const ids = [value.intendedPlayer, ...value.alternatives].map((player) => Number(player.playerId));
  return new Set(ids).size === ids.length;
}

function isLiveActionLifecycleEvent(value: Record<string, unknown>): value is LiveActionLifecycleEvent {
  return value.kind === "ACTION_LIFECYCLE"
    && isSafeIdentifier(value.actionId)
    && isSafeIdentifier(value.decisionId)
    && OPERATIONS.has(value.operation as LiveControlOperation)
    && ACTION_PHASES.has(value.phase as LiveActionLifecyclePhase)
    && (value.intendedPlayer === undefined || isLivePlayerIdentity(value.intendedPlayer))
    && (value.resolvedPlayer === undefined || isLivePlayerIdentity(value.resolvedPlayer))
    && isOptionalNonNegativeInteger(value.intendedOffer)
    && isOptionalNonNegativeInteger(value.resolvedOffer)
    && (value.code === undefined || isSafeCode(value.code));
}

function isLiveSafetyEvent(value: Record<string, unknown>): value is LiveSafetyEvent {
  return value.kind === "SAFETY"
    && SAFETY_CONDITIONS.has(value.condition as LiveSafetyCondition)
    && typeof value.active === "boolean"
    && isSafeCode(value.code);
}

function isLiveRosterAttributionEvent(value: Record<string, unknown>): value is LiveRosterAttributionEvent {
  return value.kind === "ROSTER_ATTRIBUTION"
    && isLivePlayerIdentity(value.player)
    && ATTRIBUTIONS.has(value.attribution as LiveRosterAttributionKind)
    && (value.actionId === undefined || isSafeIdentifier(value.actionId))
    && (value.decisionId === undefined || isSafeIdentifier(value.decisionId));
}

export function isLiveControlEvent(value: unknown): value is LiveControlEvent {
  if (!isRecord(value) || !isPositiveInteger(value.sequence) || !isTimestamp(value.occurredAt)) return false;
  return isLiveActionLifecycleEvent(value)
    || isLiveSafetyEvent(value)
    || isLiveRosterAttributionEvent(value);
}

function isLiveRosterAttribution(value: unknown): value is LiveRosterAttribution {
  if (!isRecord(value)) return false;
  return isLivePlayerIdentity(value.player)
    && ATTRIBUTIONS.has(value.attribution as LiveRosterAttributionKind)
    && isTimestamp(value.occurredAt)
    && (value.actionId === undefined || isSafeIdentifier(value.actionId))
    && (value.decisionId === undefined || isSafeIdentifier(value.decisionId));
}

type ObservedActionLifecycle = {
  decisionId: string;
  operation: LiveControlOperation;
  phase: LiveActionLifecyclePhase;
  intendedPlayer?: LivePlayerIdentity;
  resolvedPlayer?: LivePlayerIdentity;
  intendedOffer?: number;
  resolvedOffer?: number;
};

function mergeObservedLifecycle(
  previous: ObservedActionLifecycle | undefined,
  event: LiveActionLifecycleEvent,
): ObservedActionLifecycle | null {
  if (previous) {
    if (previous.decisionId !== event.decisionId || previous.operation !== event.operation) return null;
    if (ACTION_PHASE_ORDER[event.phase] < ACTION_PHASE_ORDER[previous.phase]
      || TERMINAL_ACTION_PHASES.has(previous.phase)) return null;
    if (previous.intendedPlayer && event.intendedPlayer && !sameValue(previous.intendedPlayer, event.intendedPlayer)) return null;
    if (previous.resolvedPlayer && event.resolvedPlayer && !sameValue(previous.resolvedPlayer, event.resolvedPlayer)) return null;
    if (previous.intendedOffer !== undefined && event.intendedOffer !== undefined
      && previous.intendedOffer !== event.intendedOffer) return null;
    if (previous.resolvedOffer !== undefined && event.resolvedOffer !== undefined
      && previous.resolvedOffer !== event.resolvedOffer) return null;
  }
  return {
    decisionId: event.decisionId,
    operation: event.operation,
    phase: event.phase,
    intendedPlayer: event.intendedPlayer ?? previous?.intendedPlayer,
    resolvedPlayer: event.resolvedPlayer ?? previous?.resolvedPlayer,
    intendedOffer: event.intendedOffer ?? previous?.intendedOffer,
    resolvedOffer: event.resolvedOffer ?? previous?.resolvedOffer,
  };
}

function observedActionLifecycles(events: LiveControlEvent[]) {
  const actions = new Map<string, ObservedActionLifecycle>();
  const decisionActionIds = new Map<string, string>();
  for (const event of events) {
    if (event.kind !== "ACTION_LIFECYCLE") continue;
    const actionId = decisionActionIds.get(event.decisionId);
    if (actionId !== undefined && actionId !== event.actionId) return null;
    const observed = mergeObservedLifecycle(actions.get(event.actionId), event);
    if (!observed) return null;
    decisionActionIds.set(event.decisionId, event.actionId);
    actions.set(event.actionId, observed);
  }
  return actions;
}

function decisionMatchesObservedLifecycle(
  decision: LiveDecisionEnvelope,
  actions: Map<string, ObservedActionLifecycle>,
) {
  const matching = [...actions.values()].filter((action) => action.decisionId === decision.decisionId);
  if (!matching.length) return false;
  return matching.every((action) => (
    action.operation === decision.operation
    && (!action.intendedPlayer || sameValue(action.intendedPlayer, decision.intendedPlayer))
    && (!action.resolvedPlayer || !decision.resolvedPlayer || sameValue(action.resolvedPlayer, decision.resolvedPlayer))
    && (action.intendedOffer === undefined || action.intendedOffer === decision.intendedOffer)
    && (action.resolvedOffer === undefined || decision.resolvedOffer === undefined || action.resolvedOffer === decision.resolvedOffer)
  ));
}

export function isLiveControlState(value: unknown): value is LiveControlState {
  if (!isRecord(value)
    || value.schemaVersion !== LIVE_CONTROL_SCHEMA_VERSION
    || !isSafeIdentifier(value.sessionId)
    || !isNonNegativeInteger(value.sequence)
    || !isNonNegativeInteger(value.pendingActionCount)
    || Number(value.pendingActionCount) > MAX_LIVE_CONTROL_ATTRIBUTIONS
    || typeof value.historicalAutopickDetected !== "boolean"
    || typeof value.uncontrolledRosterAdditionDetected !== "boolean"
    || !isNonNegativeInteger(value.unattributedRosterCount)
    || (value.decision !== null && !isLiveDecisionEnvelope(value.decision))
    || !isRecord(value.freshness)
    || !isNullableTimestamp(value.freshness.espnContextAt)
    || !isNullableTimestamp(value.freshness.pickFeedAt)
    || !isNullableTimestamp(value.freshness.pickFeedObservedAt)
    || typeof value.freshness.pickFeedLagging !== "boolean"
    || !isNullableTimestamp(value.freshness.sourceSnapshotAt)
    || !isNullableTimestamp(value.freshness.lastActionAt)
    || !Array.isArray(value.rosterAttributions)
    || value.rosterAttributions.length > MAX_LIVE_CONTROL_ATTRIBUTIONS
    || !value.rosterAttributions.every(isLiveRosterAttribution)
    || !Array.isArray(value.events)
    || value.events.length > MAX_LIVE_CONTROL_EVENTS
    || !value.events.every(isLiveControlEvent)) return false;

  const events = value.events as LiveControlEvent[];
  if (events.some((event, index) => index > 0 && (
    event.sequence !== events[index - 1].sequence + 1
    || Date.parse(event.occurredAt) < Date.parse(events[index - 1].occurredAt)
  ))) return false;
  if (Number(value.sequence) === 0 ? events.length > 0 : !events.length || events.at(-1)?.sequence !== value.sequence) return false;
  const actions = observedActionLifecycles(events);
  if (!actions) return false;
  const attributionIds = (value.rosterAttributions as LiveRosterAttribution[]).map((entry) => entry.player.playerId);
  if (new Set(attributionIds).size !== attributionIds.length) return false;
  if (events.some((event) => event.kind === "SAFETY" && event.condition === "ESPN_AUTOPICK" && event.active)
    && value.historicalAutopickDetected !== true) return false;
  if (events.some((event) => event.kind === "ROSTER_ATTRIBUTION" && ["ESPN_AUTOPICK", "UNKNOWN_EXTERNAL"].includes(event.attribution))
    && value.uncontrolledRosterAdditionDetected !== true) return false;
  return true;
}

export function createLiveControlState(sessionId: string, freshness?: Partial<LiveControlFreshness>): LiveControlState {
  if (!isSafeIdentifier(sessionId)) throw new Error("INVALID_LIVE_CONTROL_SESSION_ID");
  return {
    schemaVersion: LIVE_CONTROL_SCHEMA_VERSION,
    sessionId,
    sequence: 0,
    pendingActionCount: 0,
    historicalAutopickDetected: false,
    uncontrolledRosterAdditionDetected: false,
    unattributedRosterCount: 0,
    decision: null,
    freshness: {
      espnContextAt: freshness?.espnContextAt ?? null,
      pickFeedAt: freshness?.pickFeedAt ?? null,
      pickFeedObservedAt: freshness?.pickFeedObservedAt ?? null,
      pickFeedLagging: freshness?.pickFeedLagging ?? false,
      sourceSnapshotAt: freshness?.sourceSnapshotAt ?? null,
      lastActionAt: freshness?.lastActionAt ?? null,
    },
    rosterAttributions: [],
    events: [],
  };
}

type UnsequencedLiveControlEvent = LiveControlEvent extends infer Event
  ? Event extends LiveControlEvent ? Omit<Event, "sequence"> : never
  : never;

function pendingCountAfterEvent(state: LiveControlState, event: LiveControlEvent) {
  if (event.kind !== "ACTION_LIFECYCLE") return state.pendingActionCount;
  const priorAction = observedActionLifecycles(state.events)?.get(event.actionId);
  if (event.phase === "PLANNED" && !priorAction) return state.pendingActionCount + 1;
  if (TERMINAL_ACTION_PHASES.has(event.phase) && (!priorAction || !TERMINAL_ACTION_PHASES.has(priorAction.phase))) {
    return Math.max(0, state.pendingActionCount - 1);
  }
  return state.pendingActionCount;
}

export function appendLiveControlEvent(state: LiveControlState, event: UnsequencedLiveControlEvent): LiveControlState {
  if (!isLiveControlState(state)) throw new Error("INVALID_LIVE_CONTROL_STATE");
  const sequenced = { ...event, sequence: state.sequence + 1 } as LiveControlEvent;
  if (!isLiveControlEvent(sequenced)) throw new Error("INVALID_LIVE_CONTROL_EVENT");
  const historicalAutopickDetected = state.historicalAutopickDetected
    || (sequenced.kind === "SAFETY" && sequenced.condition === "ESPN_AUTOPICK" && sequenced.active)
    || (sequenced.kind === "ROSTER_ATTRIBUTION" && sequenced.attribution === "ESPN_AUTOPICK");
  const uncontrolledRosterAdditionDetected = state.uncontrolledRosterAdditionDetected
    || (sequenced.kind === "ROSTER_ATTRIBUTION" && ["ESPN_AUTOPICK", "UNKNOWN_EXTERNAL"].includes(sequenced.attribution));
  const rosterAttributions = sequenced.kind !== "ROSTER_ATTRIBUTION"
    ? state.rosterAttributions
    : state.rosterAttributions.some((entry) => entry.player.playerId === sequenced.player.playerId)
      ? state.rosterAttributions
      : [...state.rosterAttributions, {
          player: sequenced.player,
          attribution: sequenced.attribution,
          occurredAt: sequenced.occurredAt,
          ...(sequenced.actionId ? { actionId: sequenced.actionId } : {}),
          ...(sequenced.decisionId ? { decisionId: sequenced.decisionId } : {}),
        }].slice(-MAX_LIVE_CONTROL_ATTRIBUTIONS);
  const next = {
    ...state,
    sequence: sequenced.sequence,
    pendingActionCount: pendingCountAfterEvent(state, sequenced),
    historicalAutopickDetected,
    uncontrolledRosterAdditionDetected,
    rosterAttributions,
    events: [...state.events, sequenced].slice(-MAX_LIVE_CONTROL_EVENTS),
  };
  if (!isLiveControlState(next)) throw new Error("INVALID_LIVE_CONTROL_TRANSITION");
  return next;
}

function decisionCore(decision: LiveDecisionEnvelope) {
  const core = { ...decision };
  delete core.resolvedPlayer;
  delete core.resolvedOffer;
  return core;
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (!isRecord(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalValue(value[key])]));
}

function sameValue(left: unknown, right: unknown) {
  return JSON.stringify(canonicalValue(left)) === JSON.stringify(canonicalValue(right));
}

function decisionTransitionIsValid(previous: LiveDecisionEnvelope | null, next: LiveDecisionEnvelope | null) {
  if (!previous || !next || previous.decisionId !== next.decisionId) return true;
  if (!sameValue(decisionCore(previous), decisionCore(next))) return false;
  if (previous.resolvedPlayer !== undefined && !sameValue(previous.resolvedPlayer, next.resolvedPlayer)) return false;
  if (previous.resolvedOffer !== undefined && previous.resolvedOffer !== next.resolvedOffer) return false;
  return true;
}

function freshnessRegressed(previous: LiveControlFreshness, next: LiveControlFreshness) {
  const timestampKeys: Array<Exclude<keyof LiveControlFreshness, "pickFeedLagging">> = [
    "espnContextAt",
    "pickFeedAt",
    "pickFeedObservedAt",
    "sourceSnapshotAt",
    "lastActionAt",
  ];
  return timestampKeys.some((key) => {
    const previousAt = previous[key];
    const nextAt = next[key];
    return Boolean(previousAt && (!nextAt || Date.parse(nextAt) < Date.parse(previousAt)));
  });
}

function expectedPendingCount(previous: LiveControlState, newEvents: LiveControlEvent[]) {
  const actions = observedActionLifecycles(previous.events) ?? new Map<string, ObservedActionLifecycle>();
  let pending = previous.pendingActionCount;
  for (const event of newEvents) {
    if (event.kind !== "ACTION_LIFECYCLE") continue;
    const priorAction = actions.get(event.actionId);
    if (event.phase === "PLANNED" && !priorAction) pending += 1;
    if (TERMINAL_ACTION_PHASES.has(event.phase) && (!priorAction || !TERMINAL_ACTION_PHASES.has(priorAction.phase))) {
      pending = Math.max(0, pending - 1);
    }
    const observed = mergeObservedLifecycle(priorAction, event);
    if (observed) actions.set(event.actionId, observed);
  }
  return pending;
}

export function validateLiveControlTransition(
  previous: LiveControlState | undefined,
  next: LiveControlState | undefined,
): LiveControlTransitionResult {
  if (next !== undefined && !isLiveControlState(next)) return { ok: false, code: "LIVE_CONTROL_INVALID" };
  if (previous && next && !decisionTransitionIsValid(previous.decision, next.decision)) {
    return { ok: false, code: "LIVE_CONTROL_DECISION_MUTATED" };
  }
  if (next?.decision) {
    const actions = observedActionLifecycles(next.events);
    if (!actions || !decisionMatchesObservedLifecycle(next.decision, actions)) {
      return { ok: false, code: "LIVE_CONTROL_DECISION_EVENT_MISMATCH" };
    }
  }
  if (!previous) return { ok: true, code: "LIVE_CONTROL_ACCEPTED" };
  if (!next) return { ok: false, code: "LIVE_CONTROL_REMOVED" };
  if (previous.sessionId !== next.sessionId) return { ok: false, code: "LIVE_CONTROL_SESSION_CHANGED" };
  if (next.sequence < previous.sequence) return { ok: false, code: "LIVE_CONTROL_SEQUENCE_REGRESSION" };
  if (freshnessRegressed(previous.freshness, next.freshness)) return { ok: false, code: "LIVE_CONTROL_FRESHNESS_REGRESSION" };
  if (previous.historicalAutopickDetected && !next.historicalAutopickDetected) return { ok: false, code: "LIVE_CONTROL_AUTOPICK_HISTORY_REGRESSION" };
  if (previous.uncontrolledRosterAdditionDetected && !next.uncontrolledRosterAdditionDetected) return { ok: false, code: "LIVE_CONTROL_ATTRIBUTION_HISTORY_REGRESSION" };

  const nextEvents = new Map(next.events.map((event) => [event.sequence, event]));
  for (const event of previous.events) {
    const overlap = nextEvents.get(event.sequence);
    if (overlap && !sameValue(event, overlap)) return { ok: false, code: "LIVE_CONTROL_EVENT_MUTATED" };
  }
  const nextAttributions = new Map(next.rosterAttributions.map((entry) => [entry.player.playerId, entry]));
  for (const entry of previous.rosterAttributions) {
    const current = nextAttributions.get(entry.player.playerId);
    if (!current) return { ok: false, code: "LIVE_CONTROL_ATTRIBUTION_REMOVED" };
    if (!sameValue(entry, current)) return { ok: false, code: "LIVE_CONTROL_ATTRIBUTION_MUTATED" };
  }
  if (next.sequence === previous.sequence) {
    const stablePrevious = { ...previous, freshness: next.freshness };
    if (!sameValue(stablePrevious, next)) return { ok: false, code: "LIVE_CONTROL_STATE_CHANGED_WITHOUT_EVENT" };
  } else {
    const newEvents = next.events.filter((event) => event.sequence > previous.sequence);
    if (!newEvents.length) return { ok: false, code: "LIVE_CONTROL_EVENT_GAP" };
    if (newEvents[0].sequence !== previous.sequence + 1) return { ok: false, code: "LIVE_CONTROL_EVENT_GAP" };
    if (next.pendingActionCount !== expectedPendingCount(previous, newEvents)) {
      return { ok: false, code: "LIVE_CONTROL_PENDING_COUNT_MISMATCH" };
    }
    if (next.decision && next.decision.decisionId !== previous.decision?.decisionId
      && !newEvents.some((event) => event.kind === "ACTION_LIFECYCLE" && event.phase === "PLANNED" && event.decisionId === next.decision?.decisionId)) {
      return { ok: false, code: "LIVE_CONTROL_DECISION_EVENT_MISSING" };
    }
    const resolvedPlayerAdded = Boolean(next.decision?.resolvedPlayer && !previous.decision?.resolvedPlayer);
    const resolvedOfferAdded = next.decision?.resolvedOffer !== undefined && previous.decision?.resolvedOffer === undefined;
    if ((resolvedPlayerAdded || resolvedOfferAdded)
      && !newEvents.some((event) => event.kind === "ACTION_LIFECYCLE" && event.phase === "RESOLVED" && event.decisionId === next.decision?.decisionId)) {
      return { ok: false, code: "LIVE_CONTROL_RESOLUTION_EVENT_MISSING" };
    }
  }
  return { ok: true, code: "LIVE_CONTROL_ACCEPTED" };
}

function ageMs(timestamp: string | null, now: number) {
  if (!timestamp) return null;
  const age = now - Date.parse(timestamp);
  return Number.isFinite(age) ? age : null;
}

export function buildLiveControlCompactView(
  state: LiveControlState,
  sinceSequence = 0,
  now = Date.now(),
): LiveControlCompactView {
  if (!isLiveControlState(state)) throw new Error("INVALID_LIVE_CONTROL_STATE");
  if (!isNonNegativeInteger(sinceSequence)) throw new Error("INVALID_LIVE_CONTROL_SEQUENCE");
  const earliestRetainedSequence = state.events[0]?.sequence ?? 0;
  return {
    schemaVersion: LIVE_CONTROL_SCHEMA_VERSION,
    sessionId: state.sessionId,
    sequence: state.sequence,
    earliestRetainedSequence,
    truncated: earliestRetainedSequence > 0 && sinceSequence + 1 < earliestRetainedSequence,
    unchanged: sinceSequence >= state.sequence,
    pendingActionCount: state.pendingActionCount,
    historicalAutopickDetected: state.historicalAutopickDetected,
    uncontrolledRosterAdditionDetected: state.uncontrolledRosterAdditionDetected,
    unattributedRosterCount: state.unattributedRosterCount,
    decision: state.decision,
    freshness: state.freshness,
    agesMs: {
      espnContext: ageMs(state.freshness.espnContextAt, now),
      pickFeed: ageMs(state.freshness.pickFeedAt, now),
      pickFeedObserved: ageMs(state.freshness.pickFeedObservedAt, now),
      sourceSnapshot: ageMs(state.freshness.sourceSnapshotAt, now),
      lastAction: ageMs(state.freshness.lastActionAt, now),
      decision: ageMs(state.decision?.decidedAt ?? null, now),
      decisionContext: ageMs(state.decision?.contextCapturedAt ?? null, now),
    },
    rosterAttributions: state.rosterAttributions,
    events: state.events.filter((event) => event.sequence > sinceSequence),
  };
}

export function deterministicSnakeSubmitSecondsRemaining(leagueId: string, pick: number, minimum = 22, maximum = 30) {
  if (!String(leagueId).trim() || !isPositiveInteger(pick) || !isNonNegativeInteger(minimum) || !isNonNegativeInteger(maximum) || maximum < minimum) {
    throw new Error("INVALID_SNAKE_SUBMIT_TIMING_INPUT");
  }
  const seed = `${leagueId}:${pick}`;
  let hash = 2166136261;
  for (let index = 0; index < seed.length; index += 1) {
    hash ^= seed.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  const spread = maximum - minimum + 1;
  return minimum + ((hash >>> 0) % spread);
}

/**
 * An exact ESPN tab replacement may update transport binding only between
 * actions. Returning the same state object is deliberate: action history,
 * roster attribution, sticky incidents, sequence, and session authority must
 * survive the rebound byte-for-byte.
 */
export function preserveLiveControlForVerifiedRebound(state: LiveControlState, actionInFlight: boolean) {
  if (!isLiveControlState(state)) throw new Error("INVALID_LIVE_CONTROL_STATE");
  if (actionInFlight || state.pendingActionCount !== 0) throw new Error("LIVE_CONTROL_REBOUND_ACTION_PENDING");
  return state;
}

/** @deprecated Prefer the explicit seconds-remaining name to avoid treating the target as elapsed time. */
export const deterministicSnakeSubmitSecond = deterministicSnakeSubmitSecondsRemaining;
