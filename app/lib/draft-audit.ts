import {
  openStarterSlots,
  type DraftPick,
  type DraftPlayer,
  type LeagueSettings,
  type Position,
  type Recommendation,
} from "./draft-engine.ts";
import { isLiveControlState, type LiveControlState } from "./live-control.ts";

export const MAX_DRAFT_ACTION_TELEMETRY_EVENTS = 256;
export const MAX_DRAFT_OPERATOR_ALTERNATIVES = 5;
export const MAX_DRAFT_OPERATOR_NEEDS = 8;
export const MAX_DRAFT_LEAGUE_BOARD_RECENT_PICKS = 24;
export const MAX_DRAFT_LEAGUE_BOARD_TEAMS = 20;
export const MAX_DRAFT_LEAGUE_BOARD_REASONS = 5;
export const MAX_DRAFT_LEAGUE_BOARD_REASON_LENGTH = 160;
export const MAX_DRAFT_LEAGUE_BOARD_BYTES = 32 * 1024;
export const MAX_DRAFT_AUDIT_LEAGUE_SIZE = 20;
export const MAX_DRAFT_AUDIT_ROSTER_SIZE = 40;
export const MAX_DRAFT_AUDIT_AUCTION_BUDGET = 1_000;
export const MAX_DRAFT_AUDIT_AVAILABILITY_VETOES = 500;
export const MAX_DRAFT_AUDIT_MAP_ENTRIES = 32;
export const MAX_DRAFT_AUDIT_SOURCE_IDS = 5;
export const MAX_DRAFT_AUDIT_SOURCE_SNAPSHOT_AGE_MS = 10 * 60 * 1000;
export const AUTHENTICATED_ESPN_PLAYER_POOL_REQUIRED_COUNT = 500;

export type DraftOperatorPosition = "QB" | "RB" | "WR" | "TE" | "FLEX" | "OP" | "DST" | "K" | "DEPTH";

export type DraftOperatorPlayer = {
  playerId: number;
  playerName: string;
  position?: Exclude<DraftOperatorPosition, "FLEX" | "OP" | "DEPTH">;
  team?: string;
};

export type DraftOperatorRecommendation = {
  state: "ACTIVE" | "PREVIEW";
  action: "SELECT" | "BID" | "NOMINATE" | "HOLD" | "PASS";
  player: DraftOperatorPlayer;
  offer: number | null;
  maxLegalBid: number | null;
};

export type DraftOperatorLastDecision = {
  operation: "SELECT" | "BID" | "NOMINATE";
  phase: "ROSTER_CONFIRMED" | "ACTION_COMPLETED" | "FAILED" | "CANCELLED";
  player: DraftOperatorPlayer;
  offer: number | null;
  occurredAt: string;
  code?: string;
};

export type DraftLeagueBoardPick = {
  overall: number;
  round: number | null;
  teamSlot: number;
  ours: boolean;
  player: DraftOperatorPlayer;
  amount: number | null;
};

export type DraftLeagueBoardTeamSummary = {
  teamSlot: number;
  ours: boolean;
  rank: number;
  playerCount: number;
  projectedPoints: number;
  averageProjectedPoints: number;
  spent: number | null;
  remainingBudget: number | null;
  positionCounts: Partial<Record<Exclude<DraftOperatorPosition, "FLEX" | "OP" | "DEPTH">, number>>;
};

export type DraftLeagueBoardRecommendation = {
  player: DraftOperatorPlayer & { position: Exclude<DraftOperatorPosition, "FLEX" | "OP" | "DEPTH"> };
  confidence: number;
  reasons: string[];
  sourceCount: number;
  sourceSnapshotId: string;
};

/**
 * Public-draft facts and DraftForge analysis only. Opponent team/member names,
 * raw ESPN ids, browser state and command capabilities are intentionally absent.
 */
export type DraftLeagueBoardSnapshot = {
  draftType: "SNAKE" | "AUCTION";
  auctionBudget: number | null;
  rankingBasis: "AVERAGE_PROJECTION";
  recentPicks: DraftLeagueBoardPick[];
  ourRoster: DraftLeagueBoardPick[];
  teams: DraftLeagueBoardTeamSummary[];
  recommendation: DraftLeagueBoardRecommendation | null;
};

/**
 * Small, read-only command-center projection intended for local operator/chat
 * reads. It deliberately excludes ESPN member identity, cookies, raw DOM/API
 * payloads, opponent identities, and extension command capabilities.
 */
export type DraftOperatorSnapshot = {
  room: {
    round: number | null;
    pick: number | null;
    onClock: boolean;
    secondsRemaining: number | null;
    nominee: DraftOperatorPlayer | null;
    currentBid: number | null;
    leader: "US" | "OPPONENT" | "UNKNOWN" | null;
    maxLegalBid: number | null;
  };
  team: {
    remainingBudget: number | null;
    openRosterSlots: number;
    primaryNeeds: Array<{ position: DraftOperatorPosition; count: number }>;
  };
  recommendation: DraftOperatorRecommendation | null;
  alternatives: Array<{
    player: DraftOperatorPlayer;
    maxLegalBid: number | null;
  }>;
  lastDecision: DraftOperatorLastDecision | null;
};

export type DraftAuditRosterEntry = {
  playerId: number;
  playerName: string;
  position: string;
  amount: number;
};

export type DraftActionTelemetryEvent = {
  occurredAt: string;
  operation: "SELECT" | "BID" | "NOMINATE";
  ok: boolean;
  code: string;
  submitMs: number | null;
  roundTripMs: number;
  clockSeconds: number | null;
  automatic: boolean;
  playerId?: number;
  amount?: number;
  maxApprovedBid?: number;
  nominationIntent?: "TARGET" | "DRAIN" | null;
};

export type DraftAuditSalaryCapEvidenceSale = {
  sequence: number;
  playerId: number;
  position: string;
  closingPrice: number;
  sourceAuction: number;
  fairValue: number;
  targetBid: number;
  maxApprovedBid: number;
  highestObservedBid: number;
  nominationIntent: "TARGET" | "DRAIN" | null;
  outcome: "WON" | "BID_LOST" | "PASSED" | "DRAINED";
  submittedBidCount: number;
  highestSubmittedBid: number;
};

export type DraftAuditSleeperCandidate = {
  playerId: number;
  playerName: string;
  position: string;
  adp: number;
  label: "VALUE" | "SLEEPER" | "DEEP_STASH";
  score: number;
  modelMarketEdge: number;
  modelSpread: number;
  sourceCount: number;
  firstSeenPick?: number;
  lastSeenPick?: number;
  acquired?: boolean;
  acquisitionPick?: number | null;
  acquisitionAmount?: number;
};

export type DraftRuntimeDiagnostics = {
  capturedAt: string;
  extensionVersion: string;
  extensionSourceSha256: string;
  extensionSourceFileCount: number;
  browserTabCount: number;
  draftForgeTabCount: number;
  espnTabCount: number;
  managedCleanupReady: boolean;
};

export function draftRuntimeWorkspaceReady(runtime: DraftRuntimeDiagnostics | null | undefined) {
  return Boolean(runtime
    && runtime.browserTabCount === 2
    && runtime.draftForgeTabCount === 1
    && runtime.espnTabCount === 1
    && runtime.managedCleanupReady === true);
}

export type DraftAuditSnapshot = {
  schemaVersion: 1;
  capturedAt: string;
  league: {
    id: string;
    teamId: number;
    season: number;
    draftType: "SNAKE" | "AUCTION";
    size: number;
    rosterSize: number;
    auctionBudget: number;
    secondsPerPick: number;
    scoringLabel: string;
    scoringRules: number;
    keeperCount: number;
    lineupSlotCounts: Record<string, number>;
    positionLimits: Record<string, number>;
  };
  binding: {
    tabId: number;
    dashboardLoadedAt?: string;
    commandCenterSessionId?: string;
    commandCenterStartedAt?: string;
    authenticatedImportAt: string;
    authenticatedPlayerPool?: {
      schemaVersion: 1;
      requestedCount: 500;
      playerCount: 500;
      uniquePlayerCount: 500;
      fetchedAt: string;
      leagueId: string;
      teamId: number;
      season: number;
    };
  };
  runtime: DraftRuntimeDiagnostics;
  safety: {
    settingsConfirmed: boolean;
    liveChecklistReady: boolean;
    extensionConnected: boolean;
    inDraftRoom: boolean;
    soundMuted: boolean;
    autopickActive: boolean;
    autoDraft: boolean;
    sourceCoverage: number;
    sourceIds: string[];
    sourceSnapshotId: string;
    sourceSnapshotGeneratedAt: string;
    actionState: string;
  };
  draft: {
    totalPicks: number;
    appRoster: DraftAuditRosterEntry[];
    espnRoster: DraftAuditRosterEntry[];
  };
  telemetry: {
    actions: DraftActionTelemetryEvent[];
  };
  salaryCapEvidence?: {
    sales: DraftAuditSalaryCapEvidenceSale[];
  };
  sleeperEvidence: {
    candidateCount: number;
    candidates: DraftAuditSleeperCandidate[];
  };
  availability?: {
    status: "READY" | "BLOCKED";
    digest: string;
    evaluatedAt: string;
    freshUntil: string | null;
    blockingReasons: string[];
    vetoedPlayerIds: number[];
  };
  /** Sanitized, bounded and observational state for local operator/chat reads. */
  operator?: DraftOperatorSnapshot;
  /** Bounded public league board for GET-only local operator/chat reads. */
  leagueBoard?: DraftLeagueBoardSnapshot;
  /** Optional while legacy schema-v1 publishers migrate to typed live control. */
  liveControl?: LiveControlState;
};

export type DraftAuditEvaluation = {
  complete: boolean;
  finalReady: boolean;
  parity: boolean;
  openSlots: number;
  spent: number;
  remainingBudget: number;
  hardViolations: string[];
  finalViolations: string[];
};

export function draftAuditChecklistBindingKey(leagueId: string, teamId: number, tabId: number) {
  const normalizedLeagueId = String(leagueId || "").trim();
  if (!normalizedLeagueId || !Number.isInteger(teamId) || teamId <= 0 || !Number.isInteger(tabId) || tabId <= 0) return "";
  return `${normalizedLeagueId}:${teamId}:${tabId}`;
}

export function resolveDraftAuditChecklistReady(input: {
  currentReady: boolean;
  rosterComplete: boolean;
  currentBindingKey: string;
  lastValidatedBindingKey: string;
}) {
  return input.currentReady || (
    input.rosterComplete
    && Boolean(input.currentBindingKey)
    && input.currentBindingKey === input.lastValidatedBindingKey
  );
}

const POSITIONS = new Set(["QB", "RB", "WR", "TE", "K", "DST"]);
const OPERATOR_POSITIONS = new Set<DraftOperatorPosition>(["QB", "RB", "WR", "TE", "FLEX", "OP", "DST", "K", "DEPTH"]);
const OPERATOR_PLAYER_POSITIONS = new Set(["QB", "RB", "WR", "TE", "DST", "K"]);
const OPERATOR_ACTIONS = new Set(["SELECT", "BID", "NOMINATE", "HOLD", "PASS"]);
const OPERATOR_TERMINAL_PHASES = new Set(["ROSTER_CONFIRMED", "ACTION_COMPLETED", "FAILED", "CANCELLED"]);
const OPERATOR_SAFE_CODE = /^[A-Z0-9_]{1,64}$/;
const OPERATOR_TEAM = /^[A-Za-z0-9.]{1,8}$/;
const MAX_OPERATOR_NUMBER = 1_000_000;
const MAX_DRAFT_AUDIT_TAB_ID = 2_147_483_647;
const MAX_DRAFT_AUDIT_LATENCY_MS = 3_600_000;
const MAX_DRAFT_AUDIT_SALES = MAX_DRAFT_AUDIT_LEAGUE_SIZE * MAX_DRAFT_AUDIT_ROSTER_SIZE;
const DRAFT_AUDIT_SAFE_ID = /^[A-Za-z0-9._:-]{1,64}$/;
const DRAFT_AUDIT_SAFE_SOURCE_ID = /^[a-z0-9_-]{1,32}$/;
const DRAFT_AUDIT_SAFE_MAP_KEY = /^[A-Za-z0-9/]{1,16}$/;
const DRAFT_AUDIT_SOURCE_SNAPSHOT_ID = /^sha256:[a-f0-9]{64}$/;
const DRAFT_AUDIT_CANONICAL_UTC_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const DRAFT_AUDIT_REQUIRED_SOURCE_IDS = ["espn", "ffc", "gng", "mfl", "tradyr"] as const;
const MAX_DRAFT_AUDIT_SOURCE_FUTURE_SKEW_MS = 5_000;
const POSITION_LIMIT_KEYS: Record<string, string[]> = {
  QB: ["QB", "1"],
  RB: ["RB", "2"],
  WR: ["WR", "3"],
  TE: ["TE", "4"],
  K: ["K", "5", "17"],
  DST: ["DST", "D/ST", "16"],
};

function unique(values: string[]) {
  return [...new Set(values)];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]) {
  const allowed = new Set(keys);
  return Object.keys(value).every((key) => allowed.has(key));
}

function isBoundedInteger(value: unknown, minimum: number, maximum = MAX_OPERATOR_NUMBER) {
  return Number.isSafeInteger(value) && Number(value) >= minimum && Number(value) <= maximum;
}

function isBoundedFiniteNumber(value: unknown, minimum: number, maximum: number) {
  return typeof value === "number" && Number.isFinite(value) && value >= minimum && value <= maximum;
}

function isSafeBoundedString(value: unknown, maximum: number, minimum = 1) {
  if (typeof value !== "string" || value.trim().length < minimum || value.length > maximum) return false;
  return ![...value].some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 31 || codePoint === 127;
  });
}

function isBoundedDate(value: unknown) {
  return typeof value === "string" && value.length <= 64 && Number.isFinite(Date.parse(value));
}

export function isDraftAuditSourceSnapshotId(value: unknown): value is string {
  return typeof value === "string" && DRAFT_AUDIT_SOURCE_SNAPSHOT_ID.test(value);
}

export function isCanonicalDraftAuditUtcTimestamp(value: unknown): value is string {
  if (typeof value !== "string" || !DRAFT_AUDIT_CANONICAL_UTC_TIMESTAMP.test(value)) return false;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value;
}

function isBoundedSettingsMap(value: unknown, maximumValue: number) {
  if (!isRecord(value)) return false;
  const entries = Object.entries(value);
  return entries.length <= MAX_DRAFT_AUDIT_MAP_ENTRIES && entries.every(([key, count]) => (
    DRAFT_AUDIT_SAFE_MAP_KEY.test(key)
    && isBoundedInteger(count, 0, maximumValue)
  ));
}

function isNullableBoundedInteger(value: unknown, minimum: number, maximum = MAX_OPERATOR_NUMBER) {
  return value === null || isBoundedInteger(value, minimum, maximum);
}

function isSafeOperatorName(value: unknown) {
  return typeof value === "string"
    && value.trim().length > 0
    && value.length <= 120
    && ![...value].some((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint <= 31 || codePoint === 127;
    });
}

function isDraftOperatorPlayer(value: unknown): value is DraftOperatorPlayer {
  if (!isRecord(value) || !hasOnlyKeys(value, ["playerId", "playerName", "position", "team"])) return false;
  return Number.isSafeInteger(value.playerId)
    && Number(value.playerId) !== 0
    && isSafeOperatorName(value.playerName)
    && (value.position === undefined || OPERATOR_PLAYER_POSITIONS.has(String(value.position)))
    && (value.team === undefined || (typeof value.team === "string" && OPERATOR_TEAM.test(value.team)));
}

function isDraftOperatorRecommendation(value: unknown): value is DraftOperatorRecommendation {
  if (!isRecord(value) || !hasOnlyKeys(value, ["state", "action", "player", "offer", "maxLegalBid"])) return false;
  return ["ACTIVE", "PREVIEW"].includes(String(value.state))
    && OPERATOR_ACTIONS.has(String(value.action))
    && isDraftOperatorPlayer(value.player)
    && isNullableBoundedInteger(value.offer, 0)
    && isNullableBoundedInteger(value.maxLegalBid, 0)
    && (value.offer === null || value.maxLegalBid === null || Number(value.offer) <= Number(value.maxLegalBid));
}

function isDraftOperatorLastDecision(value: unknown): value is DraftOperatorLastDecision {
  if (!isRecord(value) || !hasOnlyKeys(value, ["operation", "phase", "player", "offer", "occurredAt", "code"])) return false;
  return ["SELECT", "BID", "NOMINATE"].includes(String(value.operation))
    && OPERATOR_TERMINAL_PHASES.has(String(value.phase))
    && isDraftOperatorPlayer(value.player)
    && isNullableBoundedInteger(value.offer, 0)
    && Number.isFinite(Date.parse(String(value.occurredAt || "")))
    && (value.code === undefined || (typeof value.code === "string" && OPERATOR_SAFE_CODE.test(value.code)));
}

/** Validate the exact public shape and return a detached known-fields-only copy. */
export function sanitizeDraftOperatorSnapshot(value: unknown): DraftOperatorSnapshot | null {
  if (!isRecord(value)
    || !hasOnlyKeys(value, ["room", "team", "recommendation", "alternatives", "lastDecision"])
    || !isRecord(value.room)
    || !hasOnlyKeys(value.room, ["round", "pick", "onClock", "secondsRemaining", "nominee", "currentBid", "leader", "maxLegalBid"])
    || !isRecord(value.team)
    || !hasOnlyKeys(value.team, ["remainingBudget", "openRosterSlots", "primaryNeeds"])
    || !isNullableBoundedInteger(value.room.round, 1, 100)
    || !isNullableBoundedInteger(value.room.pick, 1, 10_000)
    || typeof value.room.onClock !== "boolean"
    || !isNullableBoundedInteger(value.room.secondsRemaining, 0, 3_600)
    || (value.room.nominee !== null && !isDraftOperatorPlayer(value.room.nominee))
    || !isNullableBoundedInteger(value.room.currentBid, 0)
    || ![null, "US", "OPPONENT", "UNKNOWN"].includes(value.room.leader as null | string)
    || !isNullableBoundedInteger(value.room.maxLegalBid, 0)
    || !isNullableBoundedInteger(value.team.remainingBudget, 0)
    || !isBoundedInteger(value.team.openRosterSlots, 0, 64)
    || !Array.isArray(value.team.primaryNeeds)
    || value.team.primaryNeeds.length > MAX_DRAFT_OPERATOR_NEEDS
    || !value.team.primaryNeeds.every((need) => (
      isRecord(need)
      && hasOnlyKeys(need, ["position", "count"])
      && OPERATOR_POSITIONS.has(need.position as DraftOperatorPosition)
      && isBoundedInteger(need.count, 1, 64)
    ))
    || new Set(value.team.primaryNeeds.map((need) => String((need as Record<string, unknown>).position))).size !== value.team.primaryNeeds.length
    || (value.recommendation !== null && !isDraftOperatorRecommendation(value.recommendation))
    || !Array.isArray(value.alternatives)
    || value.alternatives.length > MAX_DRAFT_OPERATOR_ALTERNATIVES
    || !value.alternatives.every((alternative) => (
      isRecord(alternative)
      && hasOnlyKeys(alternative, ["player", "maxLegalBid"])
      && isDraftOperatorPlayer(alternative.player)
      && isNullableBoundedInteger(alternative.maxLegalBid, 0)
    ))
    || (value.lastDecision !== null && !isDraftOperatorLastDecision(value.lastDecision))) return null;

  const primaryNeeds = value.team.primaryNeeds as DraftOperatorSnapshot["team"]["primaryNeeds"];
  const alternatives = value.alternatives as DraftOperatorSnapshot["alternatives"];
  const recommendation = value.recommendation as DraftOperatorRecommendation | null;
  const lastDecision = value.lastDecision as DraftOperatorLastDecision | null;
  const nominee = value.room.nominee as DraftOperatorPlayer | null;
  const playerIds = [
    ...(recommendation ? [recommendation.player.playerId] : []),
    ...alternatives.map((alternative) => alternative.player.playerId),
  ];
  if (new Set(playerIds).size !== playerIds.length) return null;

  const copyPlayer = (player: DraftOperatorPlayer): DraftOperatorPlayer => ({
    playerId: player.playerId,
    playerName: player.playerName,
    ...(player.position ? { position: player.position } : {}),
    ...(player.team ? { team: player.team } : {}),
  });
  return {
    room: {
      round: value.room.round as number | null,
      pick: value.room.pick as number | null,
      onClock: value.room.onClock,
      secondsRemaining: value.room.secondsRemaining as number | null,
      nominee: nominee ? copyPlayer(nominee) : null,
      currentBid: value.room.currentBid as number | null,
      leader: value.room.leader as DraftOperatorSnapshot["room"]["leader"],
      maxLegalBid: value.room.maxLegalBid as number | null,
    },
    team: {
      remainingBudget: value.team.remainingBudget as number | null,
      openRosterSlots: value.team.openRosterSlots as number,
      primaryNeeds: primaryNeeds.map((need) => ({ position: need.position, count: need.count })),
    },
    recommendation: recommendation ? {
      state: recommendation.state,
      action: recommendation.action,
      player: copyPlayer(recommendation.player),
      offer: recommendation.offer,
      maxLegalBid: recommendation.maxLegalBid,
    } : null,
    alternatives: alternatives.map((alternative) => ({
      player: copyPlayer(alternative.player),
      maxLegalBid: alternative.maxLegalBid,
    })),
    lastDecision: lastDecision ? {
      operation: lastDecision.operation,
      phase: lastDecision.phase,
      player: copyPlayer(lastDecision.player),
      offer: lastDecision.offer,
      occurredAt: lastDecision.occurredAt,
      ...(lastDecision.code ? { code: lastDecision.code } : {}),
    } : null,
  };
}

function isDraftLeagueBoardPick(value: unknown): value is DraftLeagueBoardPick {
  return isRecord(value)
    && hasOnlyKeys(value, ["overall", "round", "teamSlot", "ours", "player", "amount"])
    && isBoundedInteger(value.overall, 1, MAX_DRAFT_AUDIT_LEAGUE_SIZE * MAX_DRAFT_AUDIT_ROSTER_SIZE)
    && isNullableBoundedInteger(value.round, 1, MAX_DRAFT_AUDIT_ROSTER_SIZE)
    && isBoundedInteger(value.teamSlot, 1, MAX_DRAFT_LEAGUE_BOARD_TEAMS)
    && typeof value.ours === "boolean"
    && isDraftOperatorPlayer(value.player)
    && Boolean(value.player.position)
    && isNullableBoundedInteger(value.amount, 0, MAX_DRAFT_AUDIT_AUCTION_BUDGET);
}

function isDraftLeagueBoardTeamSummary(value: unknown): value is DraftLeagueBoardTeamSummary {
  if (!isRecord(value)
    || !hasOnlyKeys(value, [
      "teamSlot",
      "ours",
      "rank",
      "playerCount",
      "projectedPoints",
      "averageProjectedPoints",
      "spent",
      "remainingBudget",
      "positionCounts",
    ])
    || !isBoundedInteger(value.teamSlot, 1, MAX_DRAFT_LEAGUE_BOARD_TEAMS)
    || typeof value.ours !== "boolean"
    || !isBoundedInteger(value.rank, 1, MAX_DRAFT_LEAGUE_BOARD_TEAMS)
    || !isBoundedInteger(value.playerCount, 0, MAX_DRAFT_AUDIT_ROSTER_SIZE)
    || !isBoundedFiniteNumber(value.projectedPoints, 0, MAX_OPERATOR_NUMBER)
    || !isBoundedFiniteNumber(value.averageProjectedPoints, 0, MAX_OPERATOR_NUMBER)
    || !isNullableBoundedInteger(value.spent, 0, MAX_DRAFT_AUDIT_AUCTION_BUDGET)
    || !isNullableBoundedInteger(value.remainingBudget, 0, MAX_DRAFT_AUDIT_AUCTION_BUDGET)
    || !isRecord(value.positionCounts)) return false;
  const counts = Object.entries(value.positionCounts);
  return counts.length <= POSITIONS.size
    && counts.every(([position, count]) => POSITIONS.has(position) && isBoundedInteger(count, 0, MAX_DRAFT_AUDIT_ROSTER_SIZE));
}

function draftLeagueBoardBytes(value: unknown) {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

/** Validate the public board shape and return a detached known-fields-only copy. */
export function sanitizeDraftLeagueBoardSnapshot(value: unknown): DraftLeagueBoardSnapshot | null {
  if (!isRecord(value)
    || !hasOnlyKeys(value, ["draftType", "auctionBudget", "rankingBasis", "recentPicks", "ourRoster", "teams", "recommendation"])
    || !["SNAKE", "AUCTION"].includes(String(value.draftType))
    || value.rankingBasis !== "AVERAGE_PROJECTION"
    || !isNullableBoundedInteger(value.auctionBudget, 1, MAX_DRAFT_AUDIT_AUCTION_BUDGET)
    || (value.draftType === "SNAKE" ? value.auctionBudget !== null : value.auctionBudget === null)
    || !Array.isArray(value.recentPicks)
    || value.recentPicks.length > MAX_DRAFT_LEAGUE_BOARD_RECENT_PICKS
    || !value.recentPicks.every(isDraftLeagueBoardPick)
    || !Array.isArray(value.ourRoster)
    || value.ourRoster.length > MAX_DRAFT_AUDIT_ROSTER_SIZE
    || !value.ourRoster.every(isDraftLeagueBoardPick)
    || !Array.isArray(value.teams)
    || value.teams.length > MAX_DRAFT_LEAGUE_BOARD_TEAMS
    || !value.teams.every(isDraftLeagueBoardTeamSummary)) return null;

  const recentPicks = value.recentPicks as DraftLeagueBoardPick[];
  const ourRoster = value.ourRoster as DraftLeagueBoardPick[];
  const teams = value.teams as DraftLeagueBoardTeamSummary[];
  const recommendation = value.recommendation;
  if (recommendation !== null && (
    !isRecord(recommendation)
    || !hasOnlyKeys(recommendation, ["player", "confidence", "reasons", "sourceCount", "sourceSnapshotId"])
    || !isDraftOperatorPlayer(recommendation.player)
    || !recommendation.player.position
    || !isBoundedInteger(recommendation.confidence, 0, 100)
    || !Array.isArray(recommendation.reasons)
    || recommendation.reasons.length > MAX_DRAFT_LEAGUE_BOARD_REASONS
    || recommendation.reasons.some((reason) => !isSafeBoundedString(reason, MAX_DRAFT_LEAGUE_BOARD_REASON_LENGTH))
    || new Set(recommendation.reasons).size !== recommendation.reasons.length
    || !isBoundedInteger(recommendation.sourceCount, 0, MAX_DRAFT_AUDIT_SOURCE_IDS)
    || !isDraftAuditSourceSnapshotId(recommendation.sourceSnapshotId)
  )) return null;
  const typedRecommendation = recommendation as DraftLeagueBoardRecommendation | null;

  const teamSlots = new Set(teams.map((team) => team.teamSlot));
  const teamBySlot = new Map(teams.map((team) => [team.teamSlot, team]));
  const sortedRanks = teams.map((team) => team.rank).sort((left, right) => left - right);
  const picksSorted = (picks: DraftLeagueBoardPick[]) => picks.every((pick, index) => index === 0 || picks[index - 1].overall < pick.overall);
  const auction = value.draftType === "AUCTION";
  const budget = Number(value.auctionBudget || 0);
  const ownTeam = teams.find((team) => team.ours);
  if (teamSlots.size !== teams.length
    || new Set(teams.map((team) => team.rank)).size !== teams.length
    || sortedRanks.some((rank, index) => rank !== index + 1)
    || teams.filter((team) => team.ours).length !== 1
    || teams.some((team) => Object.values(team.positionCounts).reduce((sum, count) => sum + Number(count), 0) !== team.playerCount)
    || teams.some((team) => auction
      ? team.spent === null || team.remainingBudget === null || team.spent + team.remainingBudget !== budget
      : team.spent !== null || team.remainingBudget !== null)
    || recentPicks.some((pick) => !teamSlots.has(pick.teamSlot))
    || [...recentPicks, ...ourRoster].some((pick) => teamBySlot.get(pick.teamSlot)?.ours !== pick.ours)
    || [...recentPicks, ...ourRoster].some((pick) => auction
      ? pick.amount === null || pick.amount < 1 || pick.round !== null
      : pick.amount !== null || pick.round === null)
    || ourRoster.some((pick) => !pick.ours || !teamSlots.has(pick.teamSlot) || pick.teamSlot !== ownTeam?.teamSlot)
    || ownTeam?.playerCount !== ourRoster.length
    || (auction && ownTeam?.spent !== ourRoster.reduce((sum, pick) => sum + Number(pick.amount), 0))
    || !picksSorted(recentPicks)
    || !picksSorted(ourRoster)
    || new Set(recentPicks.map((pick) => pick.player.playerId)).size !== recentPicks.length
    || new Set(recentPicks.map((pick) => pick.overall)).size !== recentPicks.length
    || new Set(ourRoster.map((pick) => pick.player.playerId)).size !== ourRoster.length
    || new Set(ourRoster.map((pick) => pick.overall)).size !== ourRoster.length) return null;

  const copyPlayer = (player: DraftOperatorPlayer): DraftOperatorPlayer => ({
    playerId: player.playerId,
    playerName: player.playerName,
    ...(player.position ? { position: player.position } : {}),
    ...(player.team ? { team: player.team } : {}),
  });
  const copyPick = (pick: DraftLeagueBoardPick): DraftLeagueBoardPick => ({
    overall: pick.overall,
    round: pick.round,
    teamSlot: pick.teamSlot,
    ours: pick.ours,
    player: copyPlayer(pick.player),
    amount: pick.amount,
  });
  const sanitized: DraftLeagueBoardSnapshot = {
    draftType: value.draftType as DraftLeagueBoardSnapshot["draftType"],
    auctionBudget: value.auctionBudget as number | null,
    rankingBasis: "AVERAGE_PROJECTION",
    recentPicks: recentPicks.map(copyPick),
    ourRoster: ourRoster.map(copyPick),
    teams: teams.map((team) => ({
      teamSlot: team.teamSlot,
      ours: team.ours,
      rank: team.rank,
      playerCount: team.playerCount,
      projectedPoints: team.projectedPoints,
      averageProjectedPoints: team.averageProjectedPoints,
      spent: team.spent,
      remainingBudget: team.remainingBudget,
      positionCounts: Object.fromEntries(Object.entries(team.positionCounts)),
    })),
    recommendation: typedRecommendation === null ? null : {
      player: copyPlayer(typedRecommendation.player) as DraftLeagueBoardRecommendation["player"],
      confidence: typedRecommendation.confidence,
      reasons: [...typedRecommendation.reasons],
      sourceCount: typedRecommendation.sourceCount,
      sourceSnapshotId: typedRecommendation.sourceSnapshotId,
    },
  };
  return draftLeagueBoardBytes(sanitized) <= MAX_DRAFT_LEAGUE_BOARD_BYTES ? sanitized : null;
}

function boundedBoardString(value: unknown, maximum: number, fallback: string) {
  const characters = [...String(value || "")]
    .filter((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint > 31 && codePoint !== 127;
    })
    .join("")
    .trim();
  let sanitized = "";
  for (const character of characters) {
    if (sanitized.length + character.length > maximum) break;
    sanitized += character;
  }
  return sanitized || fallback;
}

/** Build presentation-only league state without opponent identity or browser authority. */
export function buildDraftLeagueBoardSnapshot(input: {
  league: LeagueSettings;
  picks: DraftPick[];
  playerById: Map<number, DraftPlayer>;
  recommendation?: Recommendation;
  sourceSnapshotId: string;
}): DraftLeagueBoardSnapshot | null {
  const teamIds = [...new Set([
    ...input.league.teams.map((team) => Number(team.id)),
    ...input.picks.map((pick) => Number(pick.teamId)),
    Number(input.league.teamId),
  ].filter((teamId) => Number.isSafeInteger(teamId) && teamId > 0))]
    .sort((left, right) => left - right)
    .slice(0, MAX_DRAFT_LEAGUE_BOARD_TEAMS);
  const teamSlotById = new Map(teamIds.map((teamId, index) => [teamId, index + 1]));
  const orderedPicks = [...input.picks]
    .filter((pick) => Number.isSafeInteger(pick.playerId) && pick.playerId !== 0 && teamSlotById.has(Number(pick.teamId)))
    .sort((left, right) => left.overall - right.overall);
  const publicPlayer = (playerId: number): DraftOperatorPlayer => {
    const player = input.playerById.get(playerId);
    const position = player && POSITIONS.has(player.pos) ? player.pos as DraftOperatorPlayer["position"] : undefined;
    const team = boundedBoardString(player?.team, 8, "");
    return {
      playerId,
      playerName: boundedBoardString(player?.name, 120, `Player ${playerId}`),
      ...(position ? { position } : {}),
      ...(/^[A-Za-z0-9.]{1,8}$/.test(team) ? { team } : {}),
    };
  };
  const publicPick = (pick: DraftPick): DraftLeagueBoardPick => ({
    overall: Math.min(MAX_DRAFT_AUDIT_LEAGUE_SIZE * MAX_DRAFT_AUDIT_ROSTER_SIZE, Math.max(1, Math.trunc(pick.overall))),
    round: input.league.draftType === "SNAKE"
      ? Math.min(MAX_DRAFT_AUDIT_ROSTER_SIZE, Math.max(1, Math.trunc(pick.round)))
      : null,
    teamSlot: teamSlotById.get(Number(pick.teamId)) as number,
    ours: Number(pick.teamId) === Number(input.league.teamId),
    player: publicPlayer(pick.playerId),
    amount: input.league.draftType === "AUCTION"
      ? Math.min(MAX_DRAFT_AUDIT_AUCTION_BUDGET, Math.max(1, Math.trunc(Number(pick.amount || 0))))
      : null,
  });
  const teamRows = teamIds.map((teamId) => {
    const teamPicks = orderedPicks.filter((pick) => Number(pick.teamId) === teamId);
    const projections = teamPicks.map((pick) => {
      const projection = Number(input.playerById.get(pick.playerId)?.projected || 0);
      return Number.isFinite(projection) ? Math.min(MAX_OPERATOR_NUMBER, Math.max(0, projection)) : 0;
    });
    const projectedPoints = Math.round(projections.reduce((sum, projection) => sum + projection, 0) * 10) / 10;
    const positionCounts = teamPicks.reduce<Record<string, number>>((counts, pick) => {
      const position = input.playerById.get(pick.playerId)?.pos;
      if (position && POSITIONS.has(position)) counts[position] = Number(counts[position] || 0) + 1;
      return counts;
    }, {});
    const spent = input.league.draftType === "AUCTION"
      ? teamPicks.reduce((sum, pick) => sum + Math.max(1, Math.trunc(Number(pick.amount || 0))), 0)
      : null;
    return {
      teamSlot: teamSlotById.get(teamId) as number,
      ours: teamId === Number(input.league.teamId),
      playerCount: teamPicks.length,
      projectedPoints,
      averageProjectedPoints: teamPicks.length ? Math.round(projectedPoints / teamPicks.length * 10) / 10 : 0,
      spent,
      remainingBudget: spent === null ? null : Math.max(0, input.league.auctionBudget - spent),
      positionCounts,
    };
  });
  const rankedTeamSlots = [...teamRows]
    .sort((left, right) => right.averageProjectedPoints - left.averageProjectedPoints
      || right.projectedPoints - left.projectedPoints
      || left.teamSlot - right.teamSlot)
    .map((team) => team.teamSlot);
  if (input.recommendation && !isDraftAuditSourceSnapshotId(input.sourceSnapshotId)) return null;
  const recommendation = input.recommendation && POSITIONS.has(input.recommendation.pos)
    ? {
      player: {
        ...publicPlayer(input.recommendation.id),
        position: input.recommendation.pos,
      } as DraftLeagueBoardRecommendation["player"],
      confidence: Math.min(100, Math.max(0, Math.trunc(Number(input.recommendation.confidence || 0)))),
      reasons: [...new Set(input.recommendation.reasons
        .map((reason) => boundedBoardString(reason, MAX_DRAFT_LEAGUE_BOARD_REASON_LENGTH, ""))
        .filter(Boolean))]
        .slice(0, MAX_DRAFT_LEAGUE_BOARD_REASONS),
      sourceCount: Math.min(MAX_DRAFT_AUDIT_SOURCE_IDS, Math.max(0, Math.trunc(Number(input.recommendation.sourceCount || 0)))),
      sourceSnapshotId: input.sourceSnapshotId,
    }
    : null;
  const candidate: DraftLeagueBoardSnapshot = {
    draftType: input.league.draftType,
    auctionBudget: input.league.draftType === "AUCTION" ? input.league.auctionBudget : null,
    rankingBasis: "AVERAGE_PROJECTION",
    recentPicks: orderedPicks.slice(-MAX_DRAFT_LEAGUE_BOARD_RECENT_PICKS).map(publicPick),
    ourRoster: orderedPicks
      .filter((pick) => Number(pick.teamId) === Number(input.league.teamId))
      .slice(-MAX_DRAFT_AUDIT_ROSTER_SIZE)
      .map(publicPick),
    teams: teamRows.map((team) => ({
      ...team,
      rank: rankedTeamSlots.indexOf(team.teamSlot) + 1,
    })),
    recommendation,
  };
  return sanitizeDraftLeagueBoardSnapshot(candidate);
}

function rosterKey(entry: DraftAuditRosterEntry, includeAmount: boolean) {
  return `${entry.playerId}:${includeAmount ? entry.amount : 0}`;
}

function duplicatePlayerIds(roster: DraftAuditRosterEntry[]) {
  const ids = roster.map((entry) => entry.playerId);
  return ids.some((id, index) => ids.indexOf(id) !== index);
}

function positionLimit(snapshot: DraftAuditSnapshot, position: string) {
  const configured = (POSITION_LIMIT_KEYS[position] || [])
    .map((key) => Number(snapshot.league.positionLimits?.[key]))
    .find((value) => Number.isInteger(value) && value >= 0);
  return configured === undefined ? Number.POSITIVE_INFINITY : configured;
}

function rosterParity(snapshot: DraftAuditSnapshot) {
  const includeAmount = snapshot.league.draftType === "AUCTION";
  const app = snapshot.draft.appRoster.map((entry) => rosterKey(entry, includeAmount)).sort();
  const espn = snapshot.draft.espnRoster.map((entry) => rosterKey(entry, includeAmount)).sort();
  return app.length === espn.length && app.every((entry, index) => entry === espn[index]);
}

export function isDraftAuditSnapshot(value: unknown): value is DraftAuditSnapshot {
  if (!value || typeof value !== "object") return false;
  const snapshot = value as Partial<DraftAuditSnapshot>;
  const league = snapshot.league;
  const binding = snapshot.binding;
  const runtime = snapshot.runtime;
  const safety = snapshot.safety;
  const draft = snapshot.draft;
  if (snapshot.schemaVersion !== 1 || !isBoundedDate(snapshot.capturedAt)) return false;
  if (!league
    || !DRAFT_AUDIT_SAFE_ID.test(String(league.id || ""))
    || !isBoundedInteger(league.teamId, 1, 10_000)) return false;
  if (!["SNAKE", "AUCTION"].includes(String(league.draftType))) return false;
  if (!isBoundedInteger(league.season, 2026, 2100)) return false;
  if (!isBoundedInteger(league.size, 2, MAX_DRAFT_AUDIT_LEAGUE_SIZE)
    || !isBoundedInteger(league.rosterSize, 1, MAX_DRAFT_AUDIT_ROSTER_SIZE)) return false;
  if (!isBoundedInteger(league.auctionBudget, 0, MAX_DRAFT_AUDIT_AUCTION_BUDGET)) return false;
  if (!isBoundedInteger(league.secondsPerPick, 1, 3_600)) return false;
  if (!isSafeBoundedString(league.scoringLabel, 64)
    || !isBoundedInteger(league.scoringRules, 1, 512)) return false;
  if (!isBoundedInteger(league.keeperCount, 0, league.rosterSize)) return false;
  if (!isBoundedSettingsMap(league.lineupSlotCounts, league.rosterSize)
    || !isBoundedSettingsMap(league.positionLimits, league.rosterSize)
    || !binding
    || !isBoundedInteger(binding.tabId, 1, MAX_DRAFT_AUDIT_TAB_ID)) return false;
  if (!isBoundedDate(binding.authenticatedImportAt)) return false;
  if (binding.authenticatedPlayerPool !== undefined) {
    const playerPool = binding.authenticatedPlayerPool;
    if (!isRecord(playerPool)
      || !hasOnlyKeys(playerPool, ["schemaVersion", "requestedCount", "playerCount", "uniquePlayerCount", "fetchedAt", "leagueId", "teamId", "season"])
      || playerPool.schemaVersion !== 1
      || playerPool.requestedCount !== AUTHENTICATED_ESPN_PLAYER_POOL_REQUIRED_COUNT
      || playerPool.playerCount !== AUTHENTICATED_ESPN_PLAYER_POOL_REQUIRED_COUNT
      || playerPool.uniquePlayerCount !== AUTHENTICATED_ESPN_PLAYER_POOL_REQUIRED_COUNT
      || playerPool.fetchedAt !== binding.authenticatedImportAt
      || String(playerPool.leagueId || "") !== String(league.id)
      || Number(playerPool.teamId) !== Number(league.teamId)
      || Number(playerPool.season) !== Number(league.season)) return false;
  }
  if (binding.dashboardLoadedAt !== undefined
    && !isCanonicalDraftAuditUtcTimestamp(binding.dashboardLoadedAt)) return false;
  const hasPublisherId = isSafeBoundedString(binding.commandCenterSessionId, 128, 8);
  const hasPublisherStartedAt = isBoundedDate(binding.commandCenterStartedAt);
  if (binding.commandCenterSessionId !== undefined || binding.commandCenterStartedAt !== undefined) {
    if (!hasPublisherId || !hasPublisherStartedAt) return false;
  }
  if (!runtime
    || !isBoundedDate(runtime.capturedAt)
    || !isSafeBoundedString(runtime.extensionVersion, 64)
    || !/^[a-f0-9]{64}$/.test(String(runtime.extensionSourceSha256 || ""))
    || !isBoundedInteger(runtime.extensionSourceFileCount, 1, 512)) return false;
  if (![runtime.browserTabCount, runtime.draftForgeTabCount, runtime.espnTabCount]
    .every((count) => isBoundedInteger(count, 0, 10_000))) return false;
  if (runtime.managedCleanupReady !== true) return false;
  if (!safety || !draft || !isBoundedInteger(draft.totalPicks, 0, league.size * league.rosterSize)) return false;
  if ([
    safety.settingsConfirmed,
    safety.liveChecklistReady,
    safety.extensionConnected,
    safety.inDraftRoom,
    safety.soundMuted,
    safety.autopickActive,
    safety.autoDraft,
  ].some((value) => typeof value !== "boolean")) return false;
  if (safety.sourceCoverage !== MAX_DRAFT_AUDIT_SOURCE_IDS
    || !isDraftAuditSourceSnapshotId(safety.sourceSnapshotId)
    || !isCanonicalDraftAuditUtcTimestamp(safety.sourceSnapshotGeneratedAt)
    || !isSafeBoundedString(safety.actionState, 512)) return false;
  const sourceSnapshotAgeMs = Date.parse(snapshot.capturedAt as string) - Date.parse(safety.sourceSnapshotGeneratedAt);
  if (!Number.isFinite(sourceSnapshotAgeMs)
    || sourceSnapshotAgeMs < -MAX_DRAFT_AUDIT_SOURCE_FUTURE_SKEW_MS
    || sourceSnapshotAgeMs > MAX_DRAFT_AUDIT_SOURCE_SNAPSHOT_AGE_MS) return false;
  if (!Array.isArray(safety.sourceIds)
    || safety.sourceIds.length !== MAX_DRAFT_AUDIT_SOURCE_IDS
    || safety.sourceIds.some((id) => typeof id !== "string" || !DRAFT_AUDIT_SAFE_SOURCE_ID.test(id))
    || new Set(safety.sourceIds).size !== safety.sourceIds.length
    || DRAFT_AUDIT_REQUIRED_SOURCE_IDS.some((id) => !safety.sourceIds.includes(id))) return false;
  if (!Array.isArray(draft.appRoster) || !Array.isArray(draft.espnRoster)) return false;
  if (draft.appRoster.length > league.rosterSize || draft.espnRoster.length > league.rosterSize) return false;
  if (!snapshot.telemetry) return false;
  if (!Array.isArray(snapshot.telemetry.actions) || snapshot.telemetry.actions.length > MAX_DRAFT_ACTION_TELEMETRY_EVENTS) return false;
  if (!snapshot.telemetry.actions.every((event) => (
    isBoundedDate(event?.occurredAt)
    && ["SELECT", "BID", "NOMINATE"].includes(String(event?.operation))
    && typeof event?.ok === "boolean"
    && OPERATOR_SAFE_CODE.test(String(event?.code || ""))
    && (event.submitMs === null || isBoundedInteger(event?.submitMs, 0, MAX_DRAFT_AUDIT_LATENCY_MS))
    && isBoundedInteger(event?.roundTripMs, 0, MAX_DRAFT_AUDIT_LATENCY_MS)
    && (event.clockSeconds === null || isBoundedFiniteNumber(event.clockSeconds, 0, 3_600))
    && typeof event?.automatic === "boolean"
    && (event.playerId === undefined || (Number.isSafeInteger(event.playerId) && Number(event.playerId) !== 0))
    && (event.amount === undefined || isBoundedInteger(event.amount, 0, MAX_DRAFT_AUDIT_AUCTION_BUDGET))
    && (event.maxApprovedBid === undefined || isBoundedInteger(event.maxApprovedBid, 0, MAX_DRAFT_AUDIT_AUCTION_BUDGET))
    && (event.nominationIntent === undefined || event.nominationIntent === null || ["TARGET", "DRAIN"].includes(event.nominationIntent))
  ))) return false;
  if (snapshot.salaryCapEvidence) {
    if (league.draftType !== "AUCTION"
      || !Array.isArray(snapshot.salaryCapEvidence.sales)
      || snapshot.salaryCapEvidence.sales.length > MAX_DRAFT_AUDIT_SALES) return false;
    if (!snapshot.salaryCapEvidence.sales.every((sale) => (
      isBoundedInteger(sale?.sequence, 1, league.size * league.rosterSize)
      && Number.isSafeInteger(sale?.playerId)
      && sale.playerId !== 0
      && POSITIONS.has(String(sale.position))
      && isBoundedInteger(sale.closingPrice, 1, league.auctionBudget)
      && isBoundedFiniteNumber(sale.sourceAuction, 1, MAX_DRAFT_AUDIT_AUCTION_BUDGET)
      && isBoundedFiniteNumber(sale.fairValue, 0, MAX_DRAFT_AUDIT_AUCTION_BUDGET)
      && [sale.targetBid, sale.maxApprovedBid, sale.highestObservedBid, sale.submittedBidCount, sale.highestSubmittedBid]
        .every((item) => isBoundedInteger(item, 0, MAX_DRAFT_AUDIT_AUCTION_BUDGET))
      && sale.highestObservedBid >= sale.closingPrice
      && (sale.submittedBidCount === 0 ? sale.highestSubmittedBid === 0 : sale.highestSubmittedBid > 0)
      && (sale.highestSubmittedBid === 0 || sale.highestSubmittedBid <= sale.maxApprovedBid)
      && (sale.outcome !== "WON" || (sale.maxApprovedBid >= sale.closingPrice && sale.maxApprovedBid > 0))
      && (sale.nominationIntent === null || ["TARGET", "DRAIN"].includes(sale.nominationIntent))
      && ["WON", "BID_LOST", "PASSED", "DRAINED"].includes(sale.outcome)
    ))) return false;
    if (new Set(snapshot.salaryCapEvidence.sales.map((sale) => sale.playerId)).size !== snapshot.salaryCapEvidence.sales.length) return false;
  }
  if (!snapshot.sleeperEvidence || !Number.isInteger(snapshot.sleeperEvidence.candidateCount) || snapshot.sleeperEvidence.candidateCount < 0) return false;
  if (!Array.isArray(snapshot.sleeperEvidence.candidates) || snapshot.sleeperEvidence.candidates.length > 64) return false;
  if (snapshot.sleeperEvidence.candidateCount !== snapshot.sleeperEvidence.candidates.length) return false;
  if (!snapshot.sleeperEvidence.candidates.every((candidate) => (
    Number.isSafeInteger(candidate?.playerId)
    && candidate.playerId !== 0
    && isSafeBoundedString(candidate.playerName, 120)
    && POSITIONS.has(String(candidate.position))
    && isBoundedFiniteNumber(candidate.adp, 0, 10_000)
    && ["VALUE", "SLEEPER", "DEEP_STASH"].includes(String(candidate.label))
    && isBoundedInteger(candidate.score, 50, 10_000)
    && isBoundedFiniteNumber(candidate.modelMarketEdge, 8, 10_000)
    && isBoundedFiniteNumber(candidate.modelSpread, 0, 12)
    && isBoundedInteger(candidate.sourceCount, 4, MAX_DRAFT_AUDIT_SOURCE_IDS)
    && (candidate.firstSeenPick === undefined || isBoundedInteger(candidate.firstSeenPick, 1, league.size * league.rosterSize))
    && (candidate.lastSeenPick === undefined || (
      isBoundedInteger(candidate.lastSeenPick, Number(candidate.firstSeenPick || 1), league.size * league.rosterSize)
    ))
    && (candidate.acquired === undefined || typeof candidate.acquired === "boolean")
    && (candidate.acquisitionPick === undefined || candidate.acquisitionPick === null
      || isBoundedInteger(candidate.acquisitionPick, 1, league.size * league.rosterSize))
    && (candidate.acquisitionAmount === undefined
      || isBoundedInteger(candidate.acquisitionAmount, 0, league.auctionBudget))
  ))) return false;
  if (snapshot.availability) {
    const availability = snapshot.availability;
    if (!["READY", "BLOCKED"].includes(availability.status)
      || !/^sha256:[a-f0-9]{64}$/.test(String(availability.digest || ""))
      || !isBoundedDate(availability.evaluatedAt)
      || (availability.freshUntil !== null && !isBoundedDate(availability.freshUntil))
      || !Array.isArray(availability.blockingReasons)
      || availability.blockingReasons.length > 64
      || availability.blockingReasons.some((reason) => !/^[A-Z0-9_]{1,64}$/.test(String(reason)))
      || new Set(availability.blockingReasons).size !== availability.blockingReasons.length
      || !Array.isArray(availability.vetoedPlayerIds)
      || availability.vetoedPlayerIds.length > MAX_DRAFT_AUDIT_AVAILABILITY_VETOES
      || availability.vetoedPlayerIds.some((id) => !Number.isSafeInteger(id) || id === 0)
      || new Set(availability.vetoedPlayerIds).size !== availability.vetoedPlayerIds.length) return false;
  }
  if (snapshot.operator !== undefined && !sanitizeDraftOperatorSnapshot(snapshot.operator)) return false;
  if (snapshot.leagueBoard !== undefined) {
    const leagueBoard = sanitizeDraftLeagueBoardSnapshot(snapshot.leagueBoard);
    if (!leagueBoard
      || leagueBoard.draftType !== league.draftType
      || leagueBoard.auctionBudget !== (league.draftType === "AUCTION" ? league.auctionBudget : null)) return false;
    const rosterSignature = (playerId: number, position: string, amount: number | null) => (
      `${playerId}:${position}:${league.draftType === "AUCTION" ? Number(amount) : 0}`
    );
    const appRosterSignatures = draft.appRoster
      .map((entry) => rosterSignature(entry.playerId, entry.position, entry.amount))
      .sort();
    const boardRosterSignatures = leagueBoard.ourRoster
      .map((entry) => rosterSignature(entry.player.playerId, String(entry.player.position), entry.amount))
      .sort();
    if (appRosterSignatures.length !== boardRosterSignatures.length
      || appRosterSignatures.some((entry, index) => entry !== boardRosterSignatures[index])) return false;
    if (leagueBoard.recommendation?.sourceSnapshotId !== undefined
      && leagueBoard.recommendation.sourceSnapshotId !== safety.sourceSnapshotId) return false;
  }
  if (snapshot.liveControl !== undefined) {
    if (!isLiveControlState(snapshot.liveControl)
      || snapshot.liveControl.freshness.sourceSnapshotAt !== safety.sourceSnapshotGeneratedAt
      || (snapshot.liveControl.decision !== null
        && snapshot.liveControl.decision.sourceSnapshotId !== safety.sourceSnapshotId)) return false;
  }
  return [...draft.appRoster, ...draft.espnRoster].every((entry) => (
    Number.isSafeInteger(entry?.playerId)
    && Number(entry.playerId) !== 0
    && (Number(entry.playerId) > 0 || String(entry.position) === "DST")
    && isSafeBoundedString(entry.playerName, 120)
    && POSITIONS.has(String(entry.position))
    && isBoundedInteger(entry.amount, 0, MAX_DRAFT_AUDIT_AUCTION_BUDGET)
  ));
}

export function evaluateDraftAuditSnapshot(snapshot: DraftAuditSnapshot): DraftAuditEvaluation {
  const roster = snapshot.draft.appRoster;
  const openSlots = Math.max(0, snapshot.league.rosterSize - roster.length);
  const spent = roster.reduce((sum, entry) => sum + Number(entry.amount || 0), 0);
  const remainingBudget = snapshot.league.draftType === "AUCTION"
    ? snapshot.league.auctionBudget - spent
    : 0;
  const counts = roster.reduce<Record<string, number>>((result, entry) => {
    result[entry.position] = Number(result[entry.position] || 0) + 1;
    return result;
  }, {});
  const hardViolations: string[] = [];
  if (duplicatePlayerIds(roster) || duplicatePlayerIds(snapshot.draft.espnRoster)) hardViolations.push("DUPLICATE_PLAYER");
  if (Number(counts.K || 0) > 1) hardViolations.push("UNNECESSARY_SECOND_K");
  if (Number(counts.DST || 0) > 1) hardViolations.push("UNNECESSARY_SECOND_DST");
  for (const [position, count] of Object.entries(counts)) {
    if (count > positionLimit(snapshot, position)) hardViolations.push(`POSITION_CAP_${position}`);
  }
  if (snapshot.league.draftType === "AUCTION") {
    if (roster.some((entry) => entry.amount < 1)) hardViolations.push("INVALID_SALARY");
    if (spent > snapshot.league.auctionBudget) hardViolations.push("SALARY_CAP_EXCEEDED");
    if (remainingBudget < openSlots) hardViolations.push("ONE_DOLLAR_RESERVE_VIOLATION");
  }
  if (snapshot.availability?.vetoedPlayerIds.some((playerId) => roster.some((entry) => entry.playerId === playerId))) {
    hardViolations.push("AVAILABILITY_VETOED_ROSTER_PLAYER");
  }
  if (snapshot.safety.autopickActive === true) hardViolations.push("ESPN_AUTOPICK_ACTIVE");
  if (snapshot.safety.extensionConnected !== true) hardViolations.push("EXTENSION_NOT_CONNECTED");
  if (snapshot.safety.inDraftRoom !== true) hardViolations.push("NOT_IN_DRAFT_ROOM");
  if (!Number.isInteger(snapshot.binding.tabId) || snapshot.binding.tabId <= 0) hardViolations.push("EXACT_TAB_MISSING");

  const complete = roster.length === snapshot.league.rosterSize;
  const parity = rosterParity(snapshot);
  const finalViolations = [...hardViolations];
  if (!complete) finalViolations.push("ROSTER_INCOMPLETE");
  if (complete && openStarterSlots(
    snapshot.league as LeagueSettings,
    roster.map((entry) => entry.position as Position),
  ) > 0) finalViolations.push("MANDATORY_STARTER_MISSING");
  if (complete && !parity) finalViolations.push("ESPN_APP_ROSTER_MISMATCH");
  if (complete && Number(counts.K || 0) !== 1) finalViolations.push("MANDATORY_K_MISSING");
  if (complete && Number(counts.DST || 0) !== 1) finalViolations.push("MANDATORY_DST_MISSING");
  if (complete && snapshot.safety.autoDraft === true) finalViolations.push("AUTO_DRAFT_NOT_SHUT_DOWN");
  if (snapshot.safety.settingsConfirmed !== true) finalViolations.push("LEAGUE_RULES_NOT_CONFIRMED");
  if (snapshot.safety.liveChecklistReady !== true) finalViolations.push("LIVE_CHECKLIST_NOT_READY");
  if (snapshot.safety.sourceCoverage !== 5) finalViolations.push("FIVE_SOURCE_COVERAGE_INCOMPLETE");
  if (snapshot.league.draftType === "AUCTION") {
    const sales = snapshot.salaryCapEvidence?.sales;
    if (!sales) {
      finalViolations.push("SALARY_CAP_EVIDENCE_MISSING");
    } else {
      const wonByPlayer = new Map(sales.filter((sale) => sale.outcome === "WON").map((sale) => [sale.playerId, sale]));
      if (wonByPlayer.size !== roster.length) finalViolations.push("OWN_SALARY_CAP_EVIDENCE_INCOMPLETE");
      if (roster.some((entry) => {
        const sale = wonByPlayer.get(entry.playerId);
        return !sale || sale.position !== entry.position || sale.closingPrice !== entry.amount;
      })) finalViolations.push("OWN_SALARY_CAP_PRICE_MISMATCH");
      if (sales.some((sale) => sale.highestSubmittedBid > sale.maxApprovedBid
        || (sale.outcome === "WON" && sale.closingPrice > sale.maxApprovedBid))) {
        finalViolations.push("BID_CEILING_VIOLATION");
      }
    }
    if (snapshot.telemetry.actions.some((event) => event.operation === "BID" && event.ok && (
      !Number.isSafeInteger(event.playerId)
      || !Number.isSafeInteger(event.amount) || Number(event.amount) < 1
      || !Number.isSafeInteger(event.maxApprovedBid)
      || Number(event.amount) > Number(event.maxApprovedBid)
    ))) finalViolations.push("BID_CEILING_TELEMETRY_INCOMPLETE");
  }
  if (!snapshot.liveControl) finalViolations.push("LIVE_CONTROL_MISSING");
  if (!snapshot.availability) finalViolations.push("AVAILABILITY_GATE_MISSING");
  if (snapshot.availability?.status !== undefined && snapshot.availability.status !== "READY") {
    finalViolations.push("AVAILABILITY_GATE_BLOCKED");
  }
  if (snapshot.availability) {
    const capturedAt = Date.parse(snapshot.capturedAt);
    const freshUntil = Date.parse(snapshot.availability.freshUntil || "");
    if (!Number.isFinite(freshUntil) || freshUntil <= capturedAt) {
      finalViolations.push("AVAILABILITY_GATE_STALE");
    }
  }
  if (/stopped|excluded|autopick/i.test(snapshot.safety.actionState)) finalViolations.push("FATAL_ACTION_STATE");
  if (snapshot.liveControl) {
    const liveControl = snapshot.liveControl;
    if (liveControl.pendingActionCount !== 0) finalViolations.push("LIVE_ACTIONS_PENDING");
    if (liveControl.historicalAutopickDetected) finalViolations.push("HISTORICAL_ESPN_AUTOPICK");
    if (liveControl.uncontrolledRosterAdditionDetected) finalViolations.push("UNCONTROLLED_ROSTER_ADDITION");

    const rosterIds = new Set(roster.map((entry) => entry.playerId));
    const attributions = new Map(liveControl.rosterAttributions.map((entry) => [entry.player.playerId, entry]));
    const missingAttributions = roster.filter((entry) => !attributions.has(entry.playerId));
    const orphanAttributions = liveControl.rosterAttributions.filter((entry) => !rosterIds.has(entry.player.playerId));
    if (liveControl.unattributedRosterCount !== missingAttributions.length) finalViolations.push("ROSTER_ATTRIBUTION_COUNT_MISMATCH");
    if (liveControl.unattributedRosterCount > 0 || missingAttributions.length > 0) finalViolations.push("ROSTER_ATTRIBUTION_INCOMPLETE");
    if (orphanAttributions.length > 0) finalViolations.push("ROSTER_ATTRIBUTION_ORPHANED");
    if (liveControl.rosterAttributions.some((entry) => entry.attribution === "ESPN_AUTOPICK")) {
      finalViolations.push("HISTORICAL_ESPN_AUTOPICK");
    }
    if (liveControl.rosterAttributions.some((entry) => entry.attribution === "UNKNOWN_EXTERNAL")) {
      finalViolations.push("UNCONTROLLED_ROSTER_ADDITION");
    }
  }

  return {
    complete,
    finalReady: complete && unique(finalViolations).length === 0,
    parity,
    openSlots,
    spent,
    remainingBudget,
    hardViolations: unique(hardViolations),
    finalViolations: unique(finalViolations),
  };
}
