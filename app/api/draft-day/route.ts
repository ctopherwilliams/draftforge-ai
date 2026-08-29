import {
  buildDraftDayBridgeResult,
  prepareDraftDayBridge,
  type DraftDayPreparedState,
} from "../../lib/draft-day-bridge.ts";
import { fetchIntelligenceSnapshot } from "../../lib/intelligence-sources.ts";
import {
  intelligenceQuarterbackMode,
  intelligenceSnapshotCacheKey,
  isCompleteFreshIntelligenceSnapshot,
} from "../../lib/consensus.ts";
import { reconcileEspnPicks, resolveAuctionSales } from "../../lib/espn-reconciliation.ts";
import type { DraftPick, DraftPlayer, LeagueSettings, StrategyId } from "../../lib/draft-engine.ts";
import type { EspnContext } from "../../lib/espn-context-state.ts";
import {
  evaluateDraftAuditSnapshot,
  isCanonicalDraftAuditUtcTimestamp,
  isDraftAuditSnapshot,
  isDraftAuditSourceSnapshotId,
  MAX_DRAFT_AUDIT_SOURCE_SNAPSHOT_AGE_MS,
  MAX_DRAFT_LEAGUE_BOARD_BYTES,
  sanitizeDraftLeagueBoardSnapshot,
  sanitizeDraftOperatorSnapshot,
  type DraftAuditSnapshot,
} from "../../lib/draft-audit.ts";
import {
  draftAuditPublicationDigest,
  materializeDraftAuditPublication,
  type DraftAuditRecordedPublication,
} from "../../lib/draft-audit-publisher.ts";
import { buildLiveControlCompactView, validateLiveControlTransition } from "../../lib/live-control.ts";
import { hasIrreversibleLiveControlHistory } from "../../lib/live-control-recovery.ts";
import { normalizeImportPicks, normalizePicks } from "../../../extension/draft-normalizers.js";
import { normalizeSettings } from "../../../extension/league-import.js";
import { normalizePlayers } from "../../../extension/player-normalizers.js";
import {
  authenticatedEspnCaptureReceiptBindingMatchesAudit,
  createAuthenticatedEspnCaptureReceiptStore,
  isAuthenticatedEspnCaptureProof,
  type AuthenticatedEspnCaptureProof,
  type AuthenticatedEspnCaptureReceiptBinding,
} from "../../lib/authenticated-espn-capture.ts";
import {
  currentDraftAuditCheckpointReleaseRevision,
  defaultDraftAuditCheckpointPath,
  draftAuditCheckpointCriticalDigest,
  draftAuditCheckpointPersistenceRequired,
  loadPersistedDraftAuditCheckpoint,
  MAX_DRAFT_AUDIT_CHECKPOINTS,
  persistDraftAuditCheckpoint,
  quarantinePersistedDraftAuditCheckpoint,
} from "../../lib/draft-audit-checkpoint-store.ts";

const ESPN_ORIGIN = "https://fantasy.espn.com";
const LOCAL_ORIGINS = new Set(["http://127.0.0.1:3000", "http://localhost:3000"]);
const ALLOWED_STRATEGIES = new Set<StrategyId>(["BALANCED", "HERO_RB", "ZERO_RB", "ELITE_QB", "CUSTOM"]);
export const MAX_DRAFT_AUDIT_POST_BYTES = 512 * 1024;
export const MAX_DRAFT_BOARD_GET_BYTES = MAX_DRAFT_LEAGUE_BOARD_BYTES + 4 * 1024;
export const MAX_DRAFT_STATUS_GET_BYTES = 48 * 1024;
export const DRAFT_DAY_STATUS_AUDIT_MAX_AGE_MS = 15_000;
export const DRAFT_DAY_STATUS_FUTURE_SKEW_MS = 2_000;
export const DRAFT_DAY_STATUS_CONTEXT_MAX_AGE_MS = 4_000;
export const DRAFT_DAY_STATUS_PICK_FEED_MAX_AGE_MS = 4_000;
const MAX_DRAFT_DAY_POST_BYTES = 8 * 1024 * 1024;
export const MAX_DRAFT_DAY_SOURCE_RESPONSE_BYTES = MAX_DRAFT_DAY_POST_BYTES;
export const MAX_RETAINED_DRAFT_DAY_SOURCE_SNAPSHOTS = 8;
const SOURCE_SNAPSHOT_FUTURE_SKEW_MS = 5_000;
export const DRAFT_AUDIT_DASHBOARD_INSTANCE_STALE = "DRAFT_AUDIT_DASHBOARD_INSTANCE_STALE";
export const DRAFT_ACTION_SERVER_LEASE_STALE = "DRAFT_ACTION_SERVER_LEASE_STALE";

type DraftDayRequest = {
  operation?: "WARM" | "PREPARE" | "DECIDE" | "AUDIT" | "ISSUE_ESPN_CAPTURE_RECEIPT" | "CONSUME_ESPN_CAPTURE_RECEIPT";
  profile?: { scoring?: string; teams?: number; season?: number; qbs?: number };
  includeSourceSnapshot?: boolean;
  expectedSourceSnapshotId?: string;
  expectedSourceGeneratedAt?: string;
  sessionId?: string;
  leaguePayload?: Record<string, unknown>;
  playerPayload?: Record<string, unknown>;
  room?: EspnContext;
  strategy?: StrategyId;
  audit?: DraftAuditSnapshot;
  capture?: AuthenticatedEspnCaptureReceiptBinding;
  captureIssueToken?: string;
  authenticatedEspnCapture?: AuthenticatedEspnCaptureProof;
};

type IntelligenceSnapshot = Awaited<ReturnType<typeof fetchIntelligenceSnapshot>>;
type IntelligenceProfile = Pick<IntelligenceSnapshot, "scoring" | "teams" | "season" | "qbs">;

type RetainedSourceSnapshot = {
  expiresAt: number;
  snapshot: IntelligenceSnapshot;
};

function exactSourceSnapshotKey(
  profile: IntelligenceProfile,
  sourceSnapshotId: string,
  sourceGeneratedAt: string,
) {
  return `${intelligenceSnapshotCacheKey(profile.scoring, profile.teams, profile.season, profile.qbs)}\u0000${sourceSnapshotId}\u0000${sourceGeneratedAt}`;
}

function sourceSnapshotAccepted(
  snapshot: IntelligenceSnapshot,
  profile: IntelligenceProfile,
  evaluatedAt: number,
) {
  const generatedAtMs = Date.parse(snapshot.generatedAt);
  const expectedWeights = { espn: .30, gng: .20, tradyr: .20, ffc: .15, mfl: .15 } as const;
  let snapshotBytes = Number.POSITIVE_INFINITY;
  try {
    snapshotBytes = new TextEncoder().encode(JSON.stringify(snapshot)).byteLength;
  } catch { /* a producer snapshot must be finite JSON */ }
  return snapshotBytes <= MAX_DRAFT_DAY_SOURCE_RESPONSE_BYTES
    && snapshot.scoring === profile.scoring
    && snapshot.teams === profile.teams
    && snapshot.season === profile.season
    && snapshot.qbs === profile.qbs
    && isDraftAuditSourceSnapshotId(snapshot.sourceSnapshotId)
    && isCanonicalDraftAuditUtcTimestamp(snapshot.generatedAt)
    && Number.isFinite(generatedAtMs)
    && evaluatedAt - generatedAtMs >= -SOURCE_SNAPSHOT_FUTURE_SKEW_MS
    && evaluatedAt - generatedAtMs <= MAX_DRAFT_AUDIT_SOURCE_SNAPSHOT_AGE_MS
    && snapshot.methodology?.method === "freshness-gated weighted percentile consensus"
    && Object.keys(snapshot.methodology?.weights || {}).length === Object.keys(expectedWeights).length
    && Object.entries(expectedWeights).every(([id, weight]) => snapshot.methodology?.weights?.[id as keyof typeof expectedWeights] === weight)
    && isCompleteFreshIntelligenceSnapshot(snapshot.sources, evaluatedAt);
}

/**
 * Keep a small, process-local lease of exact source snapshots accepted by the
 * dashboard. An exact expectation never triggers a new provider fetch: it is
 * either served byte-for-byte from this lease or rejected immediately. That
 * makes audit-first doctor checks deterministic across the producer cache
 * rollover boundary instead of relying on polling cadence.
 */
export function createDraftDaySourceSnapshotCoordinator({
  maxEntries = MAX_RETAINED_DRAFT_DAY_SOURCE_SNAPSHOTS,
  now = Date.now,
}: { maxEntries?: number; now?: () => number } = {}) {
  if (!Number.isSafeInteger(maxEntries) || maxEntries < 1 || maxEntries > 64) {
    throw new Error("DRAFT_DAY_SOURCE_RETENTION_BOUND_INVALID");
  }
  const entries = new Map<string, RetainedSourceSnapshot>();
  const prune = () => {
    const evaluatedAt = now();
    for (const [key, entry] of entries) {
      if (entry.expiresAt < evaluatedAt
        || !sourceSnapshotAccepted(entry.snapshot, {
          scoring: entry.snapshot.scoring,
          teams: entry.snapshot.teams,
          season: entry.snapshot.season,
          qbs: entry.snapshot.qbs,
        }, evaluatedAt)) entries.delete(key);
    }
  };
  return {
    retain(profile: IntelligenceProfile, snapshot: IntelligenceSnapshot) {
      prune();
      const evaluatedAt = now();
      if (!sourceSnapshotAccepted(snapshot, profile, evaluatedAt)) return false;
      const key = exactSourceSnapshotKey(profile, snapshot.sourceSnapshotId, snapshot.generatedAt);
      entries.delete(key);
      while (entries.size >= maxEntries) {
        const oldest = entries.keys().next().value as string | undefined;
        if (oldest === undefined) break;
        entries.delete(oldest);
      }
      entries.set(key, {
        expiresAt: Date.parse(snapshot.generatedAt) + MAX_DRAFT_AUDIT_SOURCE_SNAPSHOT_AGE_MS,
        snapshot,
      });
      return true;
    },
    exact(profile: IntelligenceProfile, sourceSnapshotId: string, sourceGeneratedAt: string) {
      prune();
      if (!isDraftAuditSourceSnapshotId(sourceSnapshotId)
        || !isCanonicalDraftAuditUtcTimestamp(sourceGeneratedAt)) return null;
      const key = exactSourceSnapshotKey(profile, sourceSnapshotId, sourceGeneratedAt);
      const entry = entries.get(key);
      if (!entry) return null;
      entries.delete(key);
      entries.set(key, entry);
      return entry.snapshot;
    },
    stats() {
      prune();
      return { entries: entries.size, maxEntries };
    },
  };
}

const sourceSnapshotCoordinator = createDraftDaySourceSnapshotCoordinator();
const authenticatedEspnCaptureReceipts = createAuthenticatedEspnCaptureReceiptStore();

type DraftDaySession = {
  createdAt: number;
  league: LeagueSettings;
  espnPlayers: DraftPlayer[];
  sources: Awaited<ReturnType<typeof fetchIntelligenceSnapshot>>["sources"];
  sourceSnapshotId: string;
  sourceGeneratedAt: string;
  prepared: DraftDayPreparedState;
  strategy: StrategyId;
};

const SESSION_TTL_MS = 6 * 60 * 60 * 1000;
const MAX_SESSIONS = 4;
const draftDaySessions = new Map<string, DraftDaySession>();
const draftAuditSnapshots = new Map<string, DraftAuditSnapshot>();
const draftAuditCaptureIssueTokens = new Map<string, { token: string; auditDigest: string; issuedAt: number }>();
const draftAuditRecoveryEvidenceKeys = new Set<string>();
const draftAuditDurability = new Map<string, { criticalDigest: string; persistedAt: number }>();
const DRAFT_AUDIT_CHECKPOINT_HEARTBEAT_MS = 5_000;
const MAX_DRAFT_AUDIT_RUNTIME_SNAPSHOTS = 8;
let draftAuditCheckpointHydration: Promise<void> | null = null;
let draftAuditCheckpointHydrationCode = "DRAFT_AUDIT_CHECKPOINT_DISABLED";
let draftAuditCheckpointFatal = false;
let draftAuditMutationQueue: Promise<void> = Promise.resolve();

function auditKey(leagueId: string, teamId: number) {
  return `${leagueId}:${teamId}`;
}

export function draftAuditRuntimeLedgerStats() {
  return Object.freeze({
    snapshots: draftAuditSnapshots.size,
    captureIssueTokens: draftAuditCaptureIssueTokens.size,
    recoveryEvidence: draftAuditRecoveryEvidenceKeys.size,
    durability: draftAuditDurability.size,
  });
}

function draftAuditCheckpointEnabled() {
  return process.env.DRAFTFORGE_PERSIST_DRAFT_AUDIT_CHECKPOINT === "1";
}

function configuredDraftAuditCheckpointPath() {
  const configured = String(process.env.DRAFTFORGE_DRAFT_AUDIT_CHECKPOINT_PATH || "").trim();
  return configured || defaultDraftAuditCheckpointPath();
}

async function ensureDraftAuditCheckpointHydrated() {
  if (!draftAuditCheckpointEnabled()) return;
  if (!draftAuditCheckpointHydration) {
    draftAuditCheckpointHydration = (async () => {
      const checkpointPath = configuredDraftAuditCheckpointPath();
      const loaded = await loadPersistedDraftAuditCheckpoint(
        checkpointPath,
        currentDraftAuditCheckpointReleaseRevision(),
      );
      if (loaded.ok) {
        for (const { snapshot } of loaded.value.snapshots) {
          const key = auditKey(snapshot.league.id, snapshot.league.teamId);
          draftAuditSnapshots.set(key, snapshot);
          draftAuditRecoveryEvidenceKeys.add(key);
          draftAuditDurability.set(key, {
            criticalDigest: draftAuditCheckpointCriticalDigest(snapshot),
            persistedAt: Date.parse(loaded.value.writtenAt),
          });
        }
        draftAuditCheckpointHydrationCode = loaded.code;
        pruneAudits();
        return;
      }
      draftAuditCheckpointHydrationCode = loaded.code;
      if (loaded.code === "DRAFT_AUDIT_CHECKPOINT_NOT_FOUND") return;
      try {
        const quarantined = await quarantinePersistedDraftAuditCheckpoint(checkpointPath);
        draftAuditCheckpointHydrationCode = quarantined
          ? `${loaded.code}_QUARANTINED`
          : loaded.code;
      } catch {
        draftAuditCheckpointFatal = true;
        draftAuditCheckpointHydrationCode = `${loaded.code}_QUARANTINE_FAILED`;
      }
    })();
  }
  await draftAuditCheckpointHydration;
}

function serializeDraftAuditMutation<T>(operation: () => Promise<T>) {
  const result = draftAuditMutationQueue.then(operation, operation);
  draftAuditMutationQueue = result.then(() => undefined, () => undefined);
  return result;
}

class DraftAuditCheckpointCapacityError extends Error {
  constructor() {
    super("DRAFT_AUDIT_CHECKPOINT_CAPACITY_BLOCKED");
  }
}

function requiresExplicitDraftAuditRetirement(snapshot: DraftAuditSnapshot) {
  return hasIrreversibleLiveControlHistory(snapshot.liveControl)
    && !evaluateDraftAuditSnapshot(snapshot).complete;
}

function assertDraftAuditCheckpointCapacity(key: string) {
  if (draftAuditSnapshots.has(key)) return;
  const protectedCount = [...draftAuditSnapshots.values()]
    .filter(requiresExplicitDraftAuditRetirement).length;
  if ((draftAuditCheckpointEnabled() && protectedCount >= MAX_DRAFT_AUDIT_CHECKPOINTS)
    || (draftAuditSnapshots.size >= MAX_DRAFT_AUDIT_RUNTIME_SNAPSHOTS
      && protectedCount === draftAuditSnapshots.size)) {
    throw new DraftAuditCheckpointCapacityError();
  }
}

async function installDurableDraftAuditSnapshot(key: string, snapshot: DraftAuditSnapshot) {
  if (draftAuditCheckpointFatal) throw new Error(draftAuditCheckpointHydrationCode);
  assertDraftAuditCheckpointCapacity(key);
  const now = Date.now();
  const priorDurability = draftAuditDurability.get(key);
  const persistence = draftAuditCheckpointPersistenceRequired(
    priorDurability,
    snapshot,
    now,
    DRAFT_AUDIT_CHECKPOINT_HEARTBEAT_MS,
  );
  if (draftAuditCheckpointEnabled()) {
    if (persistence.required) {
      const candidates = new Map(draftAuditSnapshots);
      candidates.set(key, snapshot);
      let persisted;
      try {
        persisted = await persistDraftAuditCheckpoint(
          candidates.values(),
          configuredDraftAuditCheckpointPath(),
          new Date(now).toISOString(),
          currentDraftAuditCheckpointReleaseRevision(),
        );
      } catch (error) {
        if (error instanceof Error && error.message === "DRAFT_AUDIT_CHECKPOINT_ACTIVE_CAPACITY_EXCEEDED") {
          throw new DraftAuditCheckpointCapacityError();
        }
        throw error;
      }
      const persistedCandidate = persisted.snapshots.find(({ snapshot: candidate }) => (
        auditKey(candidate.league.id, candidate.league.teamId) === key
      ));
      if (!persistedCandidate || persistedCandidate.snapshot !== snapshot) {
        throw new DraftAuditCheckpointCapacityError();
      }
      const persistedKeys = new Set<string>();
      for (const entry of persisted.snapshots) {
        const persistedKey = auditKey(entry.snapshot.league.id, entry.snapshot.league.teamId);
        persistedKeys.add(persistedKey);
        const priorSnapshot = draftAuditSnapshots.get(persistedKey);
        const priorState = draftAuditDurability.get(persistedKey);
        const criticalDigest = persistedKey === key
          ? persistence.criticalDigest
          : priorSnapshot === entry.snapshot && priorState
            ? priorState.criticalDigest
            : draftAuditCheckpointCriticalDigest(entry.snapshot);
        draftAuditDurability.set(persistedKey, {
          criticalDigest,
          persistedAt: now,
        });
      }
      for (const persistedKey of draftAuditDurability.keys()) {
        if (!persistedKeys.has(persistedKey)) draftAuditDurability.delete(persistedKey);
      }
    }
  }
  draftAuditSnapshots.set(key, snapshot);
  draftAuditRecoveryEvidenceKeys.delete(key);
}

export function dashboardMatchesServerInstance(
  dashboardLoadedAt: unknown,
  serverInstanceStartedAt = process.env.DRAFTFORGE_SERVER_INSTANCE_STARTED_AT,
) {
  if (serverInstanceStartedAt === undefined || serverInstanceStartedAt === "") return true;
  if (!isCanonicalDraftAuditUtcTimestamp(serverInstanceStartedAt)
    || !isCanonicalDraftAuditUtcTimestamp(dashboardLoadedAt)) return false;
  return Date.parse(dashboardLoadedAt) >= Date.parse(serverInstanceStartedAt);
}

function exactDispatchString(value: unknown) {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function exactDispatchInteger(value: unknown, minimum: number) {
  if (typeof value === "number") return Number.isSafeInteger(value) && value >= minimum ? value : null;
  if (typeof value !== "string" || !/^(?:0|[1-9]\d*)$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= minimum ? parsed : null;
}

function exactDispatchPlayerId(value: unknown) {
  if (typeof value === "number") return Number.isSafeInteger(value) && value !== 0 ? value : null;
  if (typeof value !== "string" || !/^-?(?:0|[1-9]\d*)$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed !== 0 ? parsed : null;
}

function dispatchValueAbsent(value: unknown) {
  return value === undefined || value === null;
}

export function dispatchLeaseMatchesAudit(
  snapshot: DraftAuditSnapshot | undefined,
  expectation: {
    leagueId?: unknown;
    teamId?: unknown;
    tabId?: unknown;
    commandCenterSessionId?: unknown;
    dashboardLoadedAt?: unknown;
    actionId?: unknown;
    decisionId?: unknown;
    sourceSnapshotId?: unknown;
    availabilityDigest?: unknown;
    availabilityDecisionDigest?: unknown;
    operation?: unknown;
    playerId?: unknown;
    notAfter?: unknown;
    expectedPick?: unknown;
    expectedCurrentBid?: unknown;
    amount?: unknown;
    maxApprovedBid?: unknown;
    nominationIntent?: unknown;
  },
  serverInstanceStartedAt = process.env.DRAFTFORGE_SERVER_INSTANCE_STARTED_AT,
) {
  const decision = snapshot?.liveControl?.decision;
  if (!snapshot || !decision) return false;
  const leagueId = exactDispatchString(expectation.leagueId);
  const teamId = exactDispatchInteger(expectation.teamId, 1);
  const tabId = exactDispatchInteger(expectation.tabId, 1);
  const commandCenterSessionId = exactDispatchString(expectation.commandCenterSessionId);
  const dashboardLoadedAt = exactDispatchString(expectation.dashboardLoadedAt);
  const actionId = exactDispatchString(expectation.actionId);
  const decisionId = exactDispatchString(expectation.decisionId);
  const sourceSnapshotId = exactDispatchString(expectation.sourceSnapshotId);
  const availabilityDigest = exactDispatchString(expectation.availabilityDigest);
  const availabilityDecisionDigest = exactDispatchString(expectation.availabilityDecisionDigest);
  const operation = exactDispatchString(expectation.operation);
  const playerId = exactDispatchPlayerId(expectation.playerId);
  const notAfter = exactDispatchInteger(expectation.notAfter, 1);
  const observedActionIds = new Set((snapshot.liveControl?.events || []).flatMap((event) => (
    event.kind === "ACTION_LIFECYCLE" && event.decisionId === decision.decisionId ? [event.actionId] : []
  )));
  if (!leagueId
    || teamId === null
    || tabId === null
    || !commandCenterSessionId
    || !dashboardLoadedAt
    || !actionId
    || !decisionId
    || !sourceSnapshotId
    || !availabilityDigest
    || !availabilityDecisionDigest
    || !operation
    || playerId === null
    || notAfter === null
    || observedActionIds.size !== 1
    || !observedActionIds.has(actionId)
    || !/^sha256:[a-f0-9]{64}$/.test(availabilityDigest)
    || !/^sha256:[a-f0-9]{64}$/.test(availabilityDecisionDigest)
    || !dashboardMatchesServerInstance(dashboardLoadedAt, serverInstanceStartedAt)
    || !dashboardMatchesServerInstance(snapshot.binding.dashboardLoadedAt, serverInstanceStartedAt)
    || leagueId !== snapshot.league.id
    || teamId !== snapshot.league.teamId
    || tabId !== snapshot.binding.tabId
    || commandCenterSessionId !== snapshot.binding.commandCenterSessionId
    || dashboardLoadedAt !== snapshot.binding.dashboardLoadedAt
    || decisionId !== decision.decisionId
    || sourceSnapshotId !== decision.sourceSnapshotId
    || availabilityDigest !== decision.availabilityDigest
    || availabilityDecisionDigest !== decision.availabilityDecisionDigest
    || operation !== decision.operation
    || playerId !== decision.intendedPlayer.playerId
    || notAfter !== decision.notAfter) return false;

  if (operation === "SELECT") {
    const expectedPick = exactDispatchInteger(expectation.expectedPick, 1);
    return expectedPick !== null
      && expectedPick === decision.expectedPick
      && dispatchValueAbsent(expectation.expectedCurrentBid)
      && dispatchValueAbsent(expectation.amount)
      && dispatchValueAbsent(expectation.maxApprovedBid)
      && dispatchValueAbsent(expectation.nominationIntent);
  }
  if (operation === "BID") {
    const expectedCurrentBid = exactDispatchInteger(expectation.expectedCurrentBid, 0);
    const amount = exactDispatchInteger(expectation.amount, 1);
    const maxApprovedBid = exactDispatchInteger(expectation.maxApprovedBid, 0);
    return expectedCurrentBid !== null
      && amount !== null
      && maxApprovedBid !== null
      && expectedCurrentBid === decision.expectedCurrentBid
      && amount === decision.intendedOffer
      && maxApprovedBid === decision.maxApprovedBid
      && dispatchValueAbsent(expectation.expectedPick)
      && dispatchValueAbsent(expectation.nominationIntent);
  }
  if (operation === "NOMINATE") {
    const amount = exactDispatchInteger(expectation.amount, 1);
    const nominationIntent = exactDispatchString(expectation.nominationIntent);
    return amount !== null
      && ["TARGET", "DRAIN"].includes(nominationIntent || "")
      && amount === decision.intendedOffer
      && nominationIntent === decision.nominationIntent
      && dispatchValueAbsent(expectation.expectedPick)
      && dispatchValueAbsent(expectation.expectedCurrentBid)
      && dispatchValueAbsent(expectation.maxApprovedBid);
  }
  return false;
}

function recordedAuditPublication(
  snapshot: DraftAuditSnapshot,
  digest = draftAuditPublicationDigest(snapshot),
): DraftAuditRecordedPublication | null {
  const commandCenterSessionId = snapshot.binding.commandCenterSessionId;
  const liveControlSessionId = snapshot.liveControl?.sessionId;
  if (!commandCenterSessionId || !liveControlSessionId) return null;
  return {
    digest,
    capturedAt: snapshot.capturedAt,
    binding: {
      commandCenterSessionId,
      liveControlSessionId,
      leagueId: snapshot.league.id,
      teamId: snapshot.league.teamId,
      tabId: snapshot.binding.tabId,
    },
    decisionId: snapshot.liveControl?.decision?.decisionId ?? null,
  };
}

function pruneAudits(now = Date.now(), preserveKey = "") {
  const ttl = 24 * 60 * 60 * 1000;
  for (const [key, snapshot] of draftAuditSnapshots) {
    if (key !== preserveKey
      && !requiresExplicitDraftAuditRetirement(snapshot)
      && now - Date.parse(snapshot.capturedAt) > ttl) {
      draftAuditSnapshots.delete(key);
      draftAuditCaptureIssueTokens.delete(key);
      draftAuditRecoveryEvidenceKeys.delete(key);
      draftAuditDurability.delete(key);
    }
  }
  while (draftAuditSnapshots.size > MAX_DRAFT_AUDIT_RUNTIME_SNAPSHOTS) {
    const oldest = [...draftAuditSnapshots.entries()]
      .filter(([key, snapshot]) => key !== preserveKey && !requiresExplicitDraftAuditRetirement(snapshot))
      .sort((left, right) => Date.parse(left[1].capturedAt) - Date.parse(right[1].capturedAt))[0];
    if (!oldest) break;
    draftAuditSnapshots.delete(oldest[0]);
    draftAuditCaptureIssueTokens.delete(oldest[0]);
    draftAuditRecoveryEvidenceKeys.delete(oldest[0]);
    draftAuditDurability.delete(oldest[0]);
  }
  for (const key of draftAuditCaptureIssueTokens.keys()) {
    if (!draftAuditSnapshots.has(key)) draftAuditCaptureIssueTokens.delete(key);
  }
  for (const key of draftAuditRecoveryEvidenceKeys) {
    if (!draftAuditSnapshots.has(key)) draftAuditRecoveryEvidenceKeys.delete(key);
  }
  for (const key of draftAuditDurability.keys()) {
    if (!draftAuditSnapshots.has(key)) draftAuditDurability.delete(key);
  }
}

function pruneSessions(now = Date.now()) {
  for (const [id, session] of draftDaySessions) {
    if (now - session.createdAt > SESSION_TTL_MS) draftDaySessions.delete(id);
  }
  while (draftDaySessions.size >= MAX_SESSIONS) {
    const oldest = [...draftDaySessions.entries()].sort((left, right) => left[1].createdAt - right[1].createdAt)[0];
    if (!oldest) break;
    draftDaySessions.delete(oldest[0]);
  }
}

function corsHeaders(origin: string | null) {
  const allowedOrigin = origin === ESPN_ORIGIN
    || (origin && LOCAL_ORIGINS.has(origin))
    || (origin && /^chrome-extension:\/\/[a-p]{32}$/.test(origin))
    ? origin
    : "";
  return {
    ...(allowedOrigin ? { "Access-Control-Allow-Origin": allowedOrigin } : {}),
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Private-Network": "true",
    "Cache-Control": "no-store",
    Vary: "Origin",
  };
}

function response(origin: string | null, body: unknown, status = 200) {
  return Response.json(body, { status, headers: corsHeaders(origin) });
}

function boundedSourceResponse(origin: string | null, body: unknown, status = 200) {
  const serialized = JSON.stringify(body);
  if (new TextEncoder().encode(serialized).byteLength > MAX_DRAFT_DAY_SOURCE_RESPONSE_BYTES) {
    return response(origin, { ok: false, code: "DRAFT_DAY_SOURCE_RESPONSE_TOO_LARGE" }, 503);
  }
  return new Response(serialized, {
    status,
    headers: {
      ...corsHeaders(origin),
      "Content-Type": "application/json",
    },
  });
}

function boundedBoardResponse(origin: string | null, body: unknown) {
  const serialized = JSON.stringify(body);
  if (new TextEncoder().encode(serialized).byteLength > MAX_DRAFT_BOARD_GET_BYTES) {
    return response(origin, { ok: false, code: "DRAFT_LEAGUE_BOARD_RESPONSE_TOO_LARGE" }, 503);
  }
  return new Response(serialized, {
    status: 200,
    headers: {
      ...corsHeaders(origin),
      "Content-Type": "application/json",
    },
  });
}

function boundedStatusResponse(origin: string | null, body: unknown) {
  const serialized = JSON.stringify(body);
  if (new TextEncoder().encode(serialized).byteLength > MAX_DRAFT_STATUS_GET_BYTES) {
    return response(origin, { ok: false, code: "DRAFT_DAY_STATUS_RESPONSE_TOO_LARGE" }, 503);
  }
  return new Response(serialized, {
    status: 200,
    headers: {
      ...corsHeaders(origin),
      "Content-Type": "application/json",
    },
  });
}

function observerAgeMs(timestamp: string | null | undefined, now: number) {
  const timestampMs = Date.parse(String(timestamp || ""));
  return Number.isFinite(timestampMs) ? Math.trunc(now - timestampMs) : null;
}

export function buildDraftDayObserverHealth(snapshot: DraftAuditSnapshot, now = Date.now()) {
  const control = snapshot.liveControl;
  const auditAgeMs = observerAgeMs(snapshot.capturedAt, now);
  const espnContextAgeMs = observerAgeMs(control?.freshness.espnContextAt, now);
  const pickFeedObservedAgeMs = observerAgeMs(control?.freshness.pickFeedObservedAt, now);
  const sourceSnapshotAgeMs = observerAgeMs(snapshot.safety.sourceSnapshotGeneratedAt, now);
  const availabilityRemainingMs = snapshot.availability?.freshUntil
    ? Math.trunc(Date.parse(snapshot.availability.freshUntil) - now)
    : null;
  const exactSources = JSON.stringify([...new Set(snapshot.safety.sourceIds)].sort())
    === JSON.stringify(["espn", "ffc", "gng", "mfl", "tradyr"]);
  const blockers: string[] = [];
  if (auditAgeMs === null || auditAgeMs < -DRAFT_DAY_STATUS_FUTURE_SKEW_MS) blockers.push("AUDIT_CLOCK_SKEW");
  else if (auditAgeMs > DRAFT_DAY_STATUS_AUDIT_MAX_AGE_MS) blockers.push("AUDIT_STALE");
  if (snapshot.safety.extensionConnected !== true) blockers.push("EXTENSION_DISCONNECTED");
  if (snapshot.safety.inDraftRoom !== true) blockers.push("NOT_IN_DRAFT_ROOM");
  if (snapshot.safety.autopickActive !== false) blockers.push("ESPN_AUTOPICK_ACTIVE");
  if (snapshot.safety.liveChecklistReady !== true) blockers.push("LIVE_CHECKLIST_NOT_READY");
  if (snapshot.safety.sourceCoverage !== 5 || !exactSources) blockers.push("SOURCE_COVERAGE_INCOMPLETE");
  if (sourceSnapshotAgeMs === null
    || sourceSnapshotAgeMs < -DRAFT_DAY_STATUS_FUTURE_SKEW_MS
    || sourceSnapshotAgeMs > MAX_DRAFT_AUDIT_SOURCE_SNAPSHOT_AGE_MS) blockers.push("SOURCE_SNAPSHOT_STALE");
  if (!snapshot.availability || snapshot.availability.status !== "READY") blockers.push("AVAILABILITY_NOT_READY");
  else if (availabilityRemainingMs === null || availabilityRemainingMs <= 0) blockers.push("AVAILABILITY_STALE");
  if (espnContextAgeMs === null
    || espnContextAgeMs < -DRAFT_DAY_STATUS_FUTURE_SKEW_MS
    || espnContextAgeMs > DRAFT_DAY_STATUS_CONTEXT_MAX_AGE_MS) blockers.push("ESPN_CONTEXT_STALE");
  if (pickFeedObservedAgeMs === null
    || pickFeedObservedAgeMs < -DRAFT_DAY_STATUS_FUTURE_SKEW_MS
    || pickFeedObservedAgeMs > DRAFT_DAY_STATUS_PICK_FEED_MAX_AGE_MS) blockers.push("PICK_FEED_STALE");
  if (control?.freshness.pickFeedLagging !== false) blockers.push("PICK_FEED_LAGGING");
  if (control?.historicalAutopickDetected) blockers.push("AUTOPICK_HISTORY_DETECTED");
  if (control?.uncontrolledRosterAdditionDetected || Number(control?.unattributedRosterCount || 0) > 0) {
    blockers.push("ROSTER_ATTRIBUTION_UNRESOLVED");
  }
  if (/stopped|excluded|fatal/i.test(snapshot.safety.actionState)) blockers.push("ACTION_CONTROL_BLOCKED");
  return Object.freeze({
    liveReady: blockers.length === 0,
    blockers,
    auditAgeMs,
    espnContextAgeMs,
    pickFeedObservedAgeMs,
    sourceSnapshotAgeMs,
    availabilityRemainingMs,
    extensionConnected: snapshot.safety.extensionConnected,
    inDraftRoom: snapshot.safety.inDraftRoom,
    autopickActive: snapshot.safety.autopickActive,
    autoDraft: snapshot.safety.autoDraft,
    liveChecklistReady: snapshot.safety.liveChecklistReady,
    sourceCoverage: snapshot.safety.sourceCoverage,
    pickFeedLagging: control?.freshness.pickFeedLagging ?? true,
  });
}

function requestOriginAllowed(origin: string | null) {
  return origin === null || origin === ESPN_ORIGIN || LOCAL_ORIGINS.has(origin);
}

async function readBoundedJsonRequest(request: Request) {
  const declared = request.headers.get("content-length");
  if (declared !== null && /^\d+$/.test(declared) && Number(declared) > MAX_DRAFT_DAY_POST_BYTES) {
    return { ok: false as const, tooLarge: true as const };
  }
  if (!request.body) return { ok: false as const, tooLarge: false as const };
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_DRAFT_DAY_POST_BYTES) {
        await reader.cancel().catch(() => {});
        return { ok: false as const, tooLarge: true as const };
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const payload = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) {
    payload.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    const decoded = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(payload));
    if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) {
      return { ok: false as const, tooLarge: false as const };
    }
    return {
      ok: true as const,
      bytes,
      body: decoded as DraftDayRequest,
    };
  } catch {
    return { ok: false as const, tooLarge: false as const };
  }
}

function isLoopbackRequest(request: Request) {
  try {
    const hostname = new URL(request.url).hostname.toLowerCase();
    return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1" || hostname === "[::1]";
  } catch {
    return false;
  }
}

function mergePicks(primary: DraftPick[], fallback: DraftPick[]) {
  const byPlayer = new Map<number, DraftPick>();
  for (const pick of [...fallback, ...primary]) byPlayer.set(pick.playerId, pick);
  return [...byPlayer.values()].sort((left, right) => left.overall - right.overall);
}

export async function OPTIONS(request: Request) {
  const origin = request.headers.get("origin");
  if (!isLoopbackRequest(request) || !requestOriginAllowed(origin)) {
    return response(origin, { ok: false, code: "ORIGIN_FORBIDDEN" }, 403);
  }
  return new Response(null, { status: 204, headers: corsHeaders(origin) });
}

export async function GET(request: Request) {
  const origin = request.headers.get("origin");
  const url = new URL(request.url);
  const view = String(url.searchParams.get("view") || "");
  const extensionDispatchLeaseRead = view === "dispatch-lease"
    && Boolean(origin && /^chrome-extension:\/\/[a-p]{32}$/.test(origin));
  if (!isLoopbackRequest(request)
    || (origin !== null && !LOCAL_ORIGINS.has(origin) && !extensionDispatchLeaseRead)) {
    return response(origin, { ok: false, code: "ORIGIN_FORBIDDEN" }, 403);
  }
  await ensureDraftAuditCheckpointHydrated();
  const leagueId = String(url.searchParams.get("leagueId") || "").trim();
  const teamId = Number(url.searchParams.get("teamId"));
  if (!["", "control", "board", "status", "hydrate", "dispatch-lease"].includes(view)) {
    return response(origin, { ok: false, code: "DRAFT_DAY_VIEW_INVALID" }, 400);
  }
  if (["control", "board", "status", "dispatch-lease"].includes(view) && (!leagueId || !Number.isInteger(teamId) || teamId <= 0)) {
    return response(origin, {
      ok: false,
      code: view === "board"
        ? "DRAFT_LEAGUE_BOARD_IDENTITY_REQUIRED"
        : view === "status" ? "DRAFT_DAY_STATUS_IDENTITY_REQUIRED" : "LIVE_CONTROL_IDENTITY_REQUIRED",
    }, 400);
  }
  if (view === "hydrate") {
    return response(origin, {
      ok: !draftAuditCheckpointFatal,
      code: draftAuditCheckpointHydrationCode,
      recoveryEvidenceCount: draftAuditRecoveryEvidenceKeys.size,
      recoveryBlocked: draftAuditCheckpointFatal,
    }, draftAuditCheckpointFatal ? 503 : 200);
  }
  const snapshot = leagueId && Number.isInteger(teamId) && teamId > 0
    ? draftAuditSnapshots.get(auditKey(leagueId, teamId))
    : [...draftAuditSnapshots.values()].sort((left, right) => Date.parse(right.capturedAt) - Date.parse(left.capturedAt))[0];
  if (!snapshot) return response(origin, { ok: false, code: "DRAFT_AUDIT_NOT_FOUND" }, 404);
  const recoveryEvidence = draftAuditRecoveryEvidenceKeys.has(auditKey(snapshot.league.id, snapshot.league.teamId));
  if (recoveryEvidence && ["control", "board", "status", "dispatch-lease"].includes(view)) {
    return response(origin, {
      ok: false,
      code: "DRAFT_DAY_RECOVERY_REQUIRED",
      capturedAt: snapshot.capturedAt,
      league: { id: snapshot.league.id, teamId: snapshot.league.teamId, draftType: snapshot.league.draftType },
    }, 409);
  }
  if (view === "dispatch-lease") {
    const expectation = {
      leagueId,
      teamId: url.searchParams.get("teamId"),
      tabId: url.searchParams.get("tabId"),
      commandCenterSessionId: url.searchParams.get("commandCenterSessionId"),
      dashboardLoadedAt: url.searchParams.get("dashboardLoadedAt"),
      actionId: url.searchParams.get("actionId"),
      decisionId: url.searchParams.get("decisionId"),
      sourceSnapshotId: url.searchParams.get("sourceSnapshotId"),
      availabilityDigest: url.searchParams.get("availabilityDigest"),
      availabilityDecisionDigest: url.searchParams.get("availabilityDecisionDigest"),
      operation: url.searchParams.get("operation"),
      playerId: url.searchParams.get("playerId"),
      notAfter: url.searchParams.get("notAfter"),
      expectedPick: url.searchParams.get("expectedPick"),
      expectedCurrentBid: url.searchParams.get("expectedCurrentBid"),
      amount: url.searchParams.get("amount"),
      maxApprovedBid: url.searchParams.get("maxApprovedBid"),
      nominationIntent: url.searchParams.get("nominationIntent"),
    };
    if (!dispatchLeaseMatchesAudit(snapshot, expectation)) {
      return response(origin, { ok: false, code: DRAFT_ACTION_SERVER_LEASE_STALE }, 409);
    }
    return response(origin, {
      ok: true,
      code: "DRAFT_ACTION_SERVER_LEASE_CURRENT",
      serverInstanceStartedAt: process.env.DRAFTFORGE_SERVER_INSTANCE_STARTED_AT || null,
      capturedAt: snapshot.capturedAt,
      decisionId: snapshot.liveControl?.decision?.decisionId,
    });
  }
  if (view === "control") {
    const rawSince = url.searchParams.get("since");
    if (rawSince !== null && !/^\d+$/.test(rawSince)) {
      return response(origin, { ok: false, code: "LIVE_CONTROL_SEQUENCE_INVALID" }, 400);
    }
    const since = Number(rawSince || 0);
    if (!Number.isSafeInteger(since) || since < 0) {
      return response(origin, { ok: false, code: "LIVE_CONTROL_SEQUENCE_INVALID" }, 400);
    }
    if (!snapshot.liveControl) {
      return response(origin, {
        ok: false,
        code: "DRAFT_LIVE_CONTROL_NOT_PUBLISHED",
        capturedAt: snapshot.capturedAt,
        league: { id: snapshot.league.id, teamId: snapshot.league.teamId, draftType: snapshot.league.draftType },
      }, 404);
    }
    const evaluation = evaluateDraftAuditSnapshot(snapshot);
    const operator = snapshot.operator ? sanitizeDraftOperatorSnapshot(snapshot.operator) : null;
    return response(origin, {
      ok: true,
      code: "DRAFT_LIVE_CONTROL_READY",
      capturedAt: snapshot.capturedAt,
      league: { id: snapshot.league.id, teamId: snapshot.league.teamId, draftType: snapshot.league.draftType },
      control: buildLiveControlCompactView(snapshot.liveControl, since),
      operator,
      evaluation: {
        complete: evaluation.complete,
        finalReady: evaluation.finalReady,
        parity: evaluation.parity,
        finalViolations: evaluation.finalViolations,
      },
    });
  }
  if (view === "board") {
    const leagueBoard = snapshot.leagueBoard ? sanitizeDraftLeagueBoardSnapshot(snapshot.leagueBoard) : null;
    if (!leagueBoard) {
      return response(origin, {
        ok: false,
        code: "DRAFT_LEAGUE_BOARD_NOT_PUBLISHED",
        capturedAt: snapshot.capturedAt,
        league: { id: snapshot.league.id, teamId: snapshot.league.teamId, draftType: snapshot.league.draftType },
      }, 404);
    }
    return boundedBoardResponse(origin, {
      ok: true,
      code: "DRAFT_LEAGUE_BOARD_READY",
      capturedAt: snapshot.capturedAt,
      league: { id: snapshot.league.id, teamId: snapshot.league.teamId, draftType: snapshot.league.draftType },
      leagueBoard,
    });
  }
  if (view === "status") {
    const operator = snapshot.operator ? sanitizeDraftOperatorSnapshot(snapshot.operator) : null;
    const leagueBoard = snapshot.leagueBoard ? sanitizeDraftLeagueBoardSnapshot(snapshot.leagueBoard) : null;
    if (!snapshot.liveControl || !operator || !leagueBoard) {
      return response(origin, {
        ok: false,
        code: "DRAFT_DAY_STATUS_NOT_PUBLISHED",
        capturedAt: snapshot.capturedAt,
        league: { id: snapshot.league.id, teamId: snapshot.league.teamId, draftType: snapshot.league.draftType },
      }, 404);
    }
    const control = snapshot.liveControl;
    return boundedStatusResponse(origin, {
      ok: true,
      code: "DRAFT_DAY_STATUS_SNAPSHOT_READY",
      capturedAt: snapshot.capturedAt,
      league: { id: snapshot.league.id, teamId: snapshot.league.teamId, draftType: snapshot.league.draftType },
      control: {
        schemaVersion: control.schemaVersion,
        sequence: control.sequence,
        pendingActionCount: control.pendingActionCount,
        decisionActive: control.decision !== null,
        historicalAutopickDetected: control.historicalAutopickDetected,
        uncontrolledRosterAdditionDetected: control.uncontrolledRosterAdditionDetected,
        unattributedRosterCount: control.unattributedRosterCount,
      },
      health: buildDraftDayObserverHealth(snapshot),
      operator,
      leagueBoard,
    });
  }
  return response(origin, {
    ok: true,
    code: "DRAFT_AUDIT_READY",
    snapshot,
    evaluation: evaluateDraftAuditSnapshot(snapshot),
    recoveryEvidence,
  });
}

export async function POST(request: Request) {
  const origin = request.headers.get("origin");
  if (!isLoopbackRequest(request) || !requestOriginAllowed(origin)) {
    return response(origin, { ok: false, code: "ORIGIN_FORBIDDEN" }, 403);
  }
  const readOnlyView = new URL(request.url).searchParams.get("view");
  if (["board", "status"].includes(String(readOnlyView || ""))) {
    return response(origin, {
      ok: false,
      code: readOnlyView === "status" ? "DRAFT_DAY_STATUS_READ_ONLY" : "DRAFT_LEAGUE_BOARD_READ_ONLY",
    }, 405);
  }

  const parsed = await readBoundedJsonRequest(request);
  if (!parsed.ok) {
    return parsed.tooLarge
      ? response(origin, { ok: false, code: "DRAFT_DAY_PAYLOAD_TOO_LARGE" }, 413)
      : response(origin, { ok: false, code: "INVALID_JSON" }, 400);
  }
  const { body } = parsed;
  if (body.operation === "AUDIT") {
    if (parsed.bytes > MAX_DRAFT_AUDIT_POST_BYTES) {
      return response(origin, { ok: false, code: "DRAFT_AUDIT_PAYLOAD_TOO_LARGE" }, 413);
    }
    if (!isLoopbackRequest(request) || !origin || !LOCAL_ORIGINS.has(origin)) {
      return response(origin, { ok: false, code: "ORIGIN_FORBIDDEN" }, 403);
    }
    if (!isDraftAuditSnapshot(body.audit)) return response(origin, { ok: false, code: "DRAFT_AUDIT_INVALID" }, 400);
    const audit = body.audit;
    return serializeDraftAuditMutation(async () => {
    await ensureDraftAuditCheckpointHydrated();
    if (draftAuditCheckpointFatal) {
      return response(origin, {
        ok: false,
        code: "DRAFT_AUDIT_CHECKPOINT_RECOVERY_BLOCKED",
        checkpointCode: draftAuditCheckpointHydrationCode,
      }, 503);
    }
    if (!dashboardMatchesServerInstance(audit.binding.dashboardLoadedAt)) {
      return response(origin, {
        ok: false,
        code: DRAFT_AUDIT_DASHBOARD_INSTANCE_STALE,
      }, 409);
    }
    const key = auditKey(audit.league.id, audit.league.teamId);
    pruneAudits(Date.now(), key);
    const previous = draftAuditSnapshots.get(key);
    const previousPublisher = previous?.binding.commandCenterSessionId;
    const nextPublisher = audit.binding.commandCenterSessionId;
    const previousPublisherStartedAt = Date.parse(String(previous?.binding.commandCenterStartedAt || ""));
    const nextPublisherStartedAt = Date.parse(String(audit.binding.commandCenterStartedAt || ""));
    const samePublisher = Boolean(previousPublisher && nextPublisher && previousPublisher === nextPublisher);
    const newerPublisher = Boolean(
      nextPublisher
      && Number.isFinite(nextPublisherStartedAt)
      && (!previousPublisher || !Number.isFinite(previousPublisherStartedAt) || nextPublisherStartedAt > previousPublisherStartedAt)
    );
    const stalePublisher = Boolean(previousPublisher && !samePublisher && !newerPublisher);
    if (stalePublisher && previous) {
      return response(origin, {
        ok: false,
        code: "DRAFT_AUDIT_STALE_PUBLISHER",
        evaluation: evaluateDraftAuditSnapshot(previous),
      }, 409);
    }
    if (newerPublisher && previous && hasIrreversibleLiveControlHistory(previous.liveControl)) {
      return response(origin, {
        ok: false,
        code: "DRAFT_AUDIT_CONTROL_SESSION_REPLACEMENT",
        evaluation: evaluateDraftAuditSnapshot(previous),
      }, 409);
    }
    const previousCapturedAt = previous ? Date.parse(previous.capturedAt) : Number.NEGATIVE_INFINITY;
    const candidateCapturedAt = Date.parse(audit.capturedAt);
    if (previous && draftAuditRecoveryEvidenceKeys.has(key)) {
      const previousDashboardAt = Date.parse(String(previous.binding.dashboardLoadedAt || ""));
      const nextDashboardAt = Date.parse(String(audit.binding.dashboardLoadedAt || ""));
      const previousImportAt = Date.parse(previous.binding.authenticatedImportAt);
      const nextImportAt = Date.parse(audit.binding.authenticatedImportAt);
      if (!Number.isFinite(previousDashboardAt)
        || !Number.isFinite(nextDashboardAt)
        || nextDashboardAt <= previousDashboardAt
        || !Number.isFinite(previousImportAt)
        || !Number.isFinite(nextImportAt)
        || nextImportAt <= previousImportAt
        || audit.binding.tabId !== previous.binding.tabId
        || audit.safety.autoDraft !== false) {
        return response(origin, {
          ok: false,
          code: "DRAFT_AUDIT_RECOVERY_REIMPORT_REQUIRED",
          evaluation: evaluateDraftAuditSnapshot(previous),
        }, 409);
      }
    }
    const installsCandidate = !previous
      || newerPublisher
      || (samePublisher && candidateCapturedAt >= previousCapturedAt)
      || (!previousPublisher && !nextPublisher && candidateCapturedAt >= previousCapturedAt);
    if (!installsCandidate) {
      return response(origin, {
        ok: false,
        code: "DRAFT_AUDIT_STALE_SNAPSHOT",
        ...(previous ? {
          recordedPublication: recordedAuditPublication(previous),
          evaluation: evaluateDraftAuditSnapshot(previous),
        } : {}),
      }, 409);
    }
    // Exact byte-equivalent replays are already validated, installed state.
    // Detect them with collision-safe string equality before re-walking the
    // bounded 256-event control history. Reordered or otherwise non-exact JSON
    // still takes the full transition validator below.
    const candidatePublication = materializeDraftAuditPublication(audit);
    const previousPublication = previous ? materializeDraftAuditPublication(previous) : null;
    const isExactReplay = previousPublication?.serialized === candidatePublication.serialized;
    const candidateDigest = candidatePublication.digest;
    if (isExactReplay && draftAuditRecoveryEvidenceKeys.has(key)) {
      return response(origin, {
        ok: false,
        code: "DRAFT_AUDIT_RECOVERY_REIMPORT_REQUIRED",
        evaluation: previous ? evaluateDraftAuditSnapshot(previous) : undefined,
      }, 409);
    }
    if (!isExactReplay) {
      // A genuinely newer command-center publisher starts a new bounded
      // control session only while the prior publisher is still pre-action and
      // clean. Once any action, attribution, or sticky incident exists,
      // publisher replacement is rejected above so a restart cannot erase
      // history.
      const controlTransition = validateLiveControlTransition(
        newerPublisher ? undefined : previous?.liveControl,
        audit.liveControl,
      );
      if (!controlTransition.ok) {
        return response(origin, {
          ok: false,
          code: "DRAFT_AUDIT_CONTROL_REGRESSION",
          controlCode: controlTransition.code,
          ...(previous ? { evaluation: evaluateDraftAuditSnapshot(previous) } : {}),
        }, 409);
      }
      try {
        await installDurableDraftAuditSnapshot(key, audit);
      } catch (error) {
        return response(origin, {
          ok: false,
          code: error instanceof DraftAuditCheckpointCapacityError
            ? "DRAFT_AUDIT_CHECKPOINT_CAPACITY_BLOCKED"
            : "DRAFT_AUDIT_CHECKPOINT_PERSIST_FAILED",
        }, 503);
      }
    }
    pruneAudits(Date.now(), key);
    const snapshot = draftAuditSnapshots.get(key) as DraftAuditSnapshot;
    const auditDigest = snapshot === audit ? candidateDigest : draftAuditPublicationDigest(snapshot);
    const captureIssueToken = globalThis.crypto.randomUUID().replaceAll("-", "");
    draftAuditCaptureIssueTokens.set(key, { token: captureIssueToken, auditDigest, issuedAt: Date.now() });
    return response(origin, {
      ok: true,
      code: "DRAFT_AUDIT_RECORDED",
      recordedPublication: recordedAuditPublication(snapshot, auditDigest),
      captureIssueToken,
      evaluation: evaluateDraftAuditSnapshot(snapshot),
    });
    });
  }
  if (body.operation === "ISSUE_ESPN_CAPTURE_RECEIPT") {
    return serializeDraftAuditMutation(async () => {
    await ensureDraftAuditCheckpointHydrated();
    if (!origin || !LOCAL_ORIGINS.has(origin) || !body.capture) {
      return response(origin, { ok: false, code: "ESPN_CAPTURE_RECEIPT_ISSUE_FORBIDDEN" }, 403);
    }
    pruneAudits();
    const profile = body.capture.profile;
    const key = auditKey(String(profile?.leagueId || ""), Number(profile?.teamId));
    const snapshot = draftAuditSnapshots.get(key);
    const issueToken = draftAuditCaptureIssueTokens.get(key);
    if (!snapshot
      || !issueToken
      || !/^[a-f0-9]{32}$/.test(String(body.captureIssueToken || ""))
      || issueToken.token !== body.captureIssueToken
      || issueToken.auditDigest !== draftAuditPublicationDigest(snapshot)
      || Date.now() - issueToken.issuedAt > 15_000
      || !dashboardMatchesServerInstance(body.capture.dashboardLoadedAt)
      || !authenticatedEspnCaptureReceiptBindingMatchesAudit(body.capture, snapshot)) {
      return response(origin, { ok: false, code: "ESPN_CAPTURE_RECEIPT_AUDIT_MISMATCH" }, 409);
    }
    draftAuditCaptureIssueTokens.delete(key);
    const issued = authenticatedEspnCaptureReceipts.issue(body.capture);
    return response(origin, {
      ok: true,
      code: "ESPN_CAPTURE_RECEIPT_ISSUED",
      receipt: issued.receipt,
      expiresAt: issued.expiresAt,
    });
    });
  }
  if (body.operation === "CONSUME_ESPN_CAPTURE_RECEIPT") {
    if (!isAuthenticatedEspnCaptureProof(body.authenticatedEspnCapture)
      || !authenticatedEspnCaptureReceipts.consume(body.authenticatedEspnCapture)) {
      return response(origin, { ok: false, code: "ESPN_CAPTURE_RECEIPT_INVALID" }, 409);
    }
    return response(origin, { ok: true, code: "ESPN_CAPTURE_RECEIPT_CONSUMED" });
  }
  if (body.operation === "WARM" && body.profile && !body.leaguePayload) {
    if (body.includeSourceSnapshot !== undefined && typeof body.includeSourceSnapshot !== "boolean") {
      return response(origin, { ok: false, code: "DRAFT_DAY_SOURCE_RESPONSE_MODE_INVALID" }, 400);
    }
    const hasExpectedId = body.expectedSourceSnapshotId !== undefined;
    const hasExpectedGeneratedAt = body.expectedSourceGeneratedAt !== undefined;
    if (hasExpectedId !== hasExpectedGeneratedAt
      || (hasExpectedId && (
        !isDraftAuditSourceSnapshotId(body.expectedSourceSnapshotId)
        || !isCanonicalDraftAuditUtcTimestamp(body.expectedSourceGeneratedAt)
      ))) {
      return response(origin, { ok: false, code: "DRAFT_DAY_SOURCE_EXPECTATION_INVALID" }, 400);
    }
    const scoring = String(body.profile.scoring || "").trim();
    const teams = Number(body.profile.teams);
    const season = Number(body.profile.season);
    if (!["PPR", "Half PPR", "Standard"].includes(scoring)
      || !Number.isInteger(teams) || teams < 8 || teams > 16
      || !Number.isInteger(season) || season < 2026) {
      return response(origin, { ok: false, code: "DRAFT_DAY_PROFILE_INVALID" }, 400);
    }
    const qbs = Number(body.profile.qbs) >= 2 ? 2 : 1;
    const profile: IntelligenceProfile = { scoring, teams, season, qbs };
    const expectedSnapshot = hasExpectedId
      ? sourceSnapshotCoordinator.exact(
        profile,
        body.expectedSourceSnapshotId as string,
        body.expectedSourceGeneratedAt as string,
      )
      : null;
    if (hasExpectedId && !expectedSnapshot) {
      return response(origin, { ok: false, code: "DRAFT_DAY_SOURCE_EXPECTATION_NOT_RETAINED" }, 409);
    }
    // Exact expectations are lookup-only. A miss may not fetch and silently
    // substitute a newly generated provider identity.
    const intelligence = expectedSnapshot || await fetchIntelligenceSnapshot(profile);
    const ready = sourceSnapshotAccepted(intelligence, profile, Date.now());
    if (ready) sourceSnapshotCoordinator.retain(profile, intelligence);
    const warmBody = {
      ok: ready,
      code: ready ? "FIVE_SOURCE_READY" : "FIVE_SOURCE_SNAPSHOT_NOT_READY",
      sourceCoverage: ready ? 5 : 1,
      sourceIds: ["espn", ...intelligence.sources.map((source) => source.id)],
      sourceSnapshotId: intelligence.sourceSnapshotId,
      sourceGeneratedAt: intelligence.generatedAt,
      profile: { scoring, teams, season, qbs },
      sources: intelligence.sources.map((source) => ({
        id: source.id,
        status: source.status,
        players: source.players.length,
        updatedAt: source.updatedAt || null,
        retrievedAt: source.retrievedAt || null,
        error: source.error || null,
      })),
      ...(body.includeSourceSnapshot === true ? { sourceSnapshot: intelligence } : {}),
    };
    return boundedSourceResponse(origin, warmBody, ready ? 200 : 503);
  }
  if (body.operation === "DECIDE" && body.sessionId) {
    pruneSessions();
    const session = draftDaySessions.get(body.sessionId);
    if (!session) return response(origin, { ok: false, code: "DRAFT_DAY_SESSION_EXPIRED" }, 409);
    if (!body.leaguePayload || !body.room) return response(origin, { ok: false, code: "DRAFT_DAY_PAYLOAD_INCOMPLETE" }, 400);
    const room = body.room;
    const liveLeague = normalizeSettings(body.leaguePayload, {
      leagueId: room.leagueId,
      teamId: room.teamId,
      season: session.league.season,
    }) as LeagueSettings;
    if (liveLeague.id !== session.league.id
      || Number(liveLeague.teamId) !== Number(session.league.teamId)
      || liveLeague.draftType !== session.league.draftType) {
      return response(origin, { ok: false, code: "DRAFT_DAY_SESSION_MISMATCH" }, 409);
    }
    const apiPicks = normalizePicks(body.leaguePayload);
    const reconciled = reconcileEspnPicks(apiPicks, room, session.league.teamId, session.espnPlayers, session.league);
    const auctionSales = resolveAuctionSales(room, session.league, session.espnPlayers);
    const picks = mergePicks(reconciled, auctionSales);
    const result = buildDraftDayBridgeResult({
      league: session.league,
      espnPlayers: session.espnPlayers,
      picks,
      room,
      sources: session.sources,
      strategy: session.strategy,
      evaluatedAt: Date.now(),
      prepared: session.prepared,
    });
    return response(origin, {
      ...result,
      sessionId: body.sessionId,
      generatedAt: new Date().toISOString(),
      sourceSnapshotId: session.sourceSnapshotId,
      sourceGeneratedAt: session.sourceGeneratedAt,
      league: {
        id: session.league.id,
        name: session.league.name,
        season: session.league.season,
        teamId: session.league.teamId,
        draftType: session.league.draftType,
        size: session.league.size,
        rosterSize: session.league.rosterSize,
        auctionBudget: session.league.auctionBudget,
        scoringLabel: session.league.scoringLabel,
        scoringRules: session.league.scoringRules,
        keeperCount: session.league.keeperCount,
      },
      observed: {
        picks: picks.length,
        players: session.espnPlayers.length,
        remainingSeconds: room.remainingSeconds ?? null,
        currentPick: room.currentPick ?? null,
        currentBid: room.currentBid ?? 0,
      },
    });
  }

  if (!body.leaguePayload) {
    return response(origin, { ok: false, code: "DRAFT_DAY_PAYLOAD_INCOMPLETE" }, 400);
  }

  const room = body.room || {};
  const context = {
    leagueId: room.leagueId,
    teamId: room.teamId,
    season: Number(body.leaguePayload.seasonId || new Date().getFullYear()),
  };
  const league = normalizeSettings(body.leaguePayload, context) as LeagueSettings;
  if (body.operation === "WARM") {
    const profile: IntelligenceProfile = {
      scoring: league.scoringLabel,
      teams: league.size,
      season: league.season,
      qbs: intelligenceQuarterbackMode(league.lineupSlotCounts),
    };
    const intelligence = await fetchIntelligenceSnapshot(profile);
    const ready = sourceSnapshotAccepted(intelligence, profile, Date.now());
    if (ready) sourceSnapshotCoordinator.retain(profile, intelligence);
    return response(origin, {
      ok: ready,
      code: ready ? "FIVE_SOURCE_READY" : "FIVE_SOURCE_SNAPSHOT_NOT_READY",
      sourceCoverage: ready ? 5 : 1,
      sourceIds: ["espn", ...intelligence.sources.map((source) => source.id)],
      sourceSnapshotId: intelligence.sourceSnapshotId,
      sourceGeneratedAt: intelligence.generatedAt,
      league: {
        id: league.id,
        name: league.name,
        season: league.season,
        teamId: league.teamId,
        draftType: league.draftType,
        size: league.size,
        rosterSize: league.rosterSize,
        auctionBudget: league.auctionBudget,
        scoringLabel: league.scoringLabel,
        scoringRules: league.scoringRules,
        keeperCount: league.keeperCount,
      },
      sources: intelligence.sources.map((source) => ({
        id: source.id,
        status: source.status,
        players: source.players.length,
        updatedAt: source.updatedAt || null,
        retrievedAt: source.retrievedAt || null,
        error: source.error || null,
      })),
    }, ready ? 200 : 503);
  }
  if (!body.playerPayload || !body.room) {
    return response(origin, { ok: false, code: "DRAFT_DAY_PAYLOAD_INCOMPLETE" }, 400);
  }
  const espnPlayers = normalizePlayers(body.playerPayload) as DraftPlayer[];
  const apiPicks = body.leaguePayload.draftDetail
    ? normalizePicks(body.leaguePayload)
    : normalizeImportPicks(body.leaguePayload);
  const reconciled = reconcileEspnPicks(apiPicks, room, league.teamId, espnPlayers, league);
  const auctionSales = resolveAuctionSales(room, league, espnPlayers);
  const picks = mergePicks(reconciled, auctionSales);
  const strategy = ALLOWED_STRATEGIES.has(body.strategy || "BALANCED") ? body.strategy || "BALANCED" : "BALANCED";
  const intelligenceProfile: IntelligenceProfile = {
    scoring: league.scoringLabel,
    teams: league.size,
    season: league.season,
    qbs: intelligenceQuarterbackMode(league.lineupSlotCounts),
  };
  const intelligence = await fetchIntelligenceSnapshot(intelligenceProfile);
  if (sourceSnapshotAccepted(intelligence, intelligenceProfile, Date.now())) {
    sourceSnapshotCoordinator.retain(intelligenceProfile, intelligence);
  }
  const prepared = prepareDraftDayBridge(league, espnPlayers, intelligence.sources, intelligence.generatedAt);
  const result = buildDraftDayBridgeResult({
    league,
    espnPlayers,
    picks,
    room,
    sources: intelligence.sources,
    strategy,
    evaluatedAt: intelligence.generatedAt,
    prepared,
  });

  let sessionId: string | undefined;
  if (body.operation === "PREPARE") {
    pruneSessions();
    sessionId = crypto.randomUUID();
    draftDaySessions.set(sessionId, {
      createdAt: Date.now(),
      league,
      espnPlayers,
      sources: intelligence.sources,
      sourceSnapshotId: intelligence.sourceSnapshotId,
      sourceGeneratedAt: intelligence.generatedAt,
      prepared,
      strategy,
    });
  }

  return response(origin, {
    ...result,
    ...(sessionId ? { sessionId } : {}),
    generatedAt: new Date().toISOString(),
    sourceSnapshotId: intelligence.sourceSnapshotId,
    sourceGeneratedAt: intelligence.generatedAt,
    league: {
      id: league.id,
      name: league.name,
      season: league.season,
      teamId: league.teamId,
      draftType: league.draftType,
      size: league.size,
      rosterSize: league.rosterSize,
      auctionBudget: league.auctionBudget,
      scoringLabel: league.scoringLabel,
      scoringRules: league.scoringRules,
      keeperCount: league.keeperCount,
    },
    observed: {
      picks: picks.length,
      players: espnPlayers.length,
      remainingSeconds: room.remainingSeconds ?? null,
      currentPick: room.currentPick ?? null,
      currentBid: room.currentBid ?? 0,
    },
  });
}
