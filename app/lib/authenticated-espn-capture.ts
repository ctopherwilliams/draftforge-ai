import { intelligenceQuarterbackMode } from "./consensus.ts";

export const AUTHENTICATED_ESPN_CAPTURE_SCHEMA_VERSION = 2;
export const AUTHENTICATED_ESPN_CAPTURE_TRANSPORT = "draftforge-chrome-companion";
export const AUTHENTICATED_ESPN_CAPTURE_MAX_RECEIPTS = 8;
export const AUTHENTICATED_ESPN_CAPTURE_RECEIPT_TTL_MS = 30 * 60 * 1000;
export const AUTHENTICATED_ESPN_CAPTURE_AUDIT_MAX_AGE_MS = 15_000;
export const AUTHENTICATED_ESPN_CAPTURE_MAX_CANONICAL_BYTES = 6 * 1024 * 1024;

export const AUTHENTICATED_ESPN_CAPTURE_DIGEST_DOMAIN = "draftforge-authenticated-espn-capture-v2";
const CAPTURE_DIGEST = /^sha256:[a-f0-9]{64}$/;
const CAPTURE_RECEIPT = /^[a-f0-9]{32}$/;
const CANONICAL_UTC_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const PROFILE_KEYS = [
  "auctionBudget", "draftType", "leagueId", "playerCount", "qbs",
  "rosterSize", "scoringLabel", "scoringRules", "season", "sourceQbs",
  "sourceScoring", "sourceSeason", "sourceTeams", "teamId", "teams",
] as const;
const CAPTURE_POSITIONS = new Set(["QB", "RB", "WR", "TE", "K", "DST"]);

type AuthenticatedEspnLeagueProfile = {
  id?: unknown;
  teamId?: unknown;
  season?: unknown;
  draftType?: unknown;
  scoringLabel?: unknown;
  scoringRules?: unknown;
  size?: unknown;
  rosterSize?: unknown;
  auctionBudget?: unknown;
  lineupSlotCounts?: Record<string, unknown>;
  positionLimits?: Record<string, unknown>;
  pickOrder?: unknown[];
  keeperCount?: unknown;
  secondsPerPick?: unknown;
  rawSettings?: unknown;
  rulesFingerprint?: unknown;
};

export type AuthenticatedEspnSourceProfile = {
  scoring: string;
  teams: number;
  season: number;
  qbs: number;
};

export type AuthenticatedEspnCaptureProfile = {
  leagueId: string;
  teamId: number | null;
  season: number | null;
  draftType: string;
  scoringLabel: string;
  scoringRules: number | null;
  teams: number | null;
  rosterSize: number | null;
  auctionBudget: number | null;
  qbs: number;
  playerCount: number;
  sourceScoring: string;
  sourceTeams: number;
  sourceSeason: number;
  sourceQbs: number;
};

export type AuthenticatedEspnCaptureProof = {
  schemaVersion: number;
  transport: string;
  capturedAt: string;
  profile: AuthenticatedEspnCaptureProfile;
  digest: string;
  receipt: string;
};

export type AuthenticatedEspnCaptureReceiptBinding = {
  digest: string;
  capturedAt: string;
  profile: AuthenticatedEspnCaptureProfile;
  tabId: number;
  dashboardLoadedAt: string;
  commandCenterSessionId: string;
};

type ReceiptRecord = AuthenticatedEspnCaptureReceiptBinding & {
  receipt: string;
  issuedAt: number;
  expiresAt: number;
};

function finiteNumber(value: unknown) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isCanonicalUtcTimestamp(value: unknown): value is string {
  if (typeof value !== "string" || !CANONICAL_UTC_TIMESTAMP.test(value)) return false;
  const epoch = Date.parse(value);
  return Number.isFinite(epoch) && new Date(epoch).toISOString() === value;
}

function canonicalValue(value: unknown): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("ESPN_ARTIFACT_CANONICAL_VALUE_INVALID");
    return Object.is(value, -0) ? 0 : value;
  }
  if (Array.isArray(value)) return value.map((item) => canonicalValue(item));
  if (!isRecord(value)) throw new Error("ESPN_ARTIFACT_CANONICAL_VALUE_INVALID");
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalValue(value[key])]));
}

export function canonicalAuthenticatedEspnCaptureJson(value: unknown) {
  let jsonValue: unknown;
  try {
    const serialized = JSON.stringify(value);
    if (serialized === undefined) throw new Error("invalid");
    jsonValue = JSON.parse(serialized);
  } catch {
    throw new Error("ESPN_ARTIFACT_CANONICAL_VALUE_INVALID");
  }
  const canonical = JSON.stringify(canonicalValue(jsonValue));
  if (new TextEncoder().encode(canonical).byteLength > AUTHENTICATED_ESPN_CAPTURE_MAX_CANONICAL_BYTES) {
    throw new Error("ESPN_ARTIFACT_CANONICAL_PAYLOAD_TOO_LARGE");
  }
  return canonical;
}

function numericRuleMap(value: unknown) {
  if (!isRecord(value)) return {};
  return Object.fromEntries(Object.entries(value)
    .sort(([left], [right]) => left.localeCompare(right, undefined, { numeric: true }))
    .map(([key, amount]) => [String(key), Number(amount || 0)]));
}

/** Exact draft/roster/scoring values required to reproduce the ESPN ruleset. */
export function buildAuthenticatedEspnRulesFingerprint(league: AuthenticatedEspnLeagueProfile) {
  const rawSettings = isRecord(league?.rawSettings) ? league.rawSettings : null;
  const scoringSettings = rawSettings && isRecord(rawSettings.scoringSettings) ? rawSettings.scoringSettings : null;
  const existing = isRecord(league?.rulesFingerprint) ? league.rulesFingerprint : null;
  const scoringItems = Array.isArray(scoringSettings?.scoringItems)
    ? scoringSettings.scoringItems
    : Array.isArray(existing?.scoringItems)
      ? existing.scoringItems
      : [];
  return JSON.parse(canonicalAuthenticatedEspnCaptureJson({
    secondsPerPick: Number(league?.secondsPerPick || 0),
    keeperCount: Number(league?.keeperCount || 0),
    pickOrder: Array.isArray(league?.pickOrder) ? league.pickOrder.map(Number) : [],
    lineupSlotCounts: numericRuleMap(league?.lineupSlotCounts),
    positionLimits: numericRuleMap(league?.positionLimits),
    scoringItems,
  }));
}

export function sanitizeAuthenticatedEspnLeague(league: AuthenticatedEspnLeagueProfile) {
  const size = Math.max(1, Number(league?.size || 0));
  return {
    id: String(league?.id || "snapshot"),
    name: "Sanitized ESPN snapshot",
    season: Number(league?.season || 0),
    size,
    teamId: Number(league?.teamId || 0) || null,
    draftType: String(league?.draftType || "SNAKE") === "AUCTION" ? "AUCTION" : "SNAKE",
    secondsPerPick: Number(league?.secondsPerPick || 0),
    rosterSize: Number(league?.rosterSize || 0),
    auctionBudget: Number(league?.auctionBudget || 0),
    pickOrder: Array.isArray(league?.pickOrder) ? league.pickOrder.map(Number) : [],
    lineupSlotCounts: numericRuleMap(league?.lineupSlotCounts),
    positionLimits: numericRuleMap(league?.positionLimits),
    scoringLabel: String(league?.scoringLabel || "Custom"),
    scoringRules: Number(league?.scoringRules || 0),
    keeperCount: Number(league?.keeperCount || 0),
    rulesFingerprint: buildAuthenticatedEspnRulesFingerprint(league),
    teams: Array.from({ length: size }, (_, index) => ({
      id: index + 1,
      name: `Snapshot Team ${index + 1}`,
      abbrev: `S${index + 1}`,
    })),
  };
}

export function sanitizeAuthenticatedEspnPlayers(players: unknown[]) {
  return (Array.isArray(players) ? players : []).flatMap((candidate) => {
    if (!isRecord(candidate)) return [];
    const id = Number(candidate.id);
    const pos = String(candidate.pos || "");
    if (!Number.isInteger(id) || id === 0 || id === -1 || !CAPTURE_POSITIONS.has(pos)) return [];
    return [{
      id,
      name: String(candidate.name || "").trim(),
      team: String(candidate.team || "FA").trim() || "FA",
      pos,
      rank: Number(candidate.rank || 999),
      adp: Number(candidate.adp || 999),
      auction: Math.max(1, Number(candidate.auction || 1)),
      projected: Math.max(0, Number(candidate.projected || 0)),
      availabilityStatus: String(candidate.availabilityStatus || "ACTIVE"),
      injured: candidate.injured === true,
      unavailable: candidate.unavailable === true,
    }];
  }).sort((left, right) => left.id - right.id);
}

export async function authenticatedEspnCaptureDigest({
  capturedAt,
  league,
  espnPlayers,
}: {
  capturedAt: string;
  league: AuthenticatedEspnLeagueProfile;
  espnPlayers: unknown[];
}) {
  const canonical = canonicalAuthenticatedEspnCaptureJson({ capturedAt, league, espnPlayers });
  const bytes = new TextEncoder().encode(`${AUTHENTICATED_ESPN_CAPTURE_DIGEST_DOMAIN}\n${canonical}`);
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return `sha256:${[...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

export function buildAuthenticatedEspnCaptureProfile({ league, espnPlayers, request }: {
  league: AuthenticatedEspnLeagueProfile;
  espnPlayers: unknown[];
  request: AuthenticatedEspnSourceProfile;
}): AuthenticatedEspnCaptureProfile {
  return {
    leagueId: String(league?.id || ""),
    teamId: finiteNumber(league?.teamId),
    season: finiteNumber(league?.season),
    draftType: String(league?.draftType || ""),
    scoringLabel: String(league?.scoringLabel || ""),
    scoringRules: finiteNumber(league?.scoringRules),
    teams: finiteNumber(league?.size),
    rosterSize: finiteNumber(league?.rosterSize),
    auctionBudget: finiteNumber(league?.auctionBudget),
    qbs: intelligenceQuarterbackMode(league?.lineupSlotCounts),
    playerCount: espnPlayers.length,
    sourceScoring: request.scoring,
    sourceTeams: request.teams,
    sourceSeason: request.season,
    sourceQbs: request.qbs,
  };
}

export function isAuthenticatedEspnCaptureProfile(value: unknown): value is AuthenticatedEspnCaptureProfile {
  if (!isRecord(value)
    || JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...PROFILE_KEYS].sort())) return false;
  return /^\d+$/.test(String(value.leagueId || ""))
    && Number.isSafeInteger(value.teamId) && Number(value.teamId) > 0
    && Number.isSafeInteger(value.season) && Number(value.season) >= 2026
    && ["SNAKE", "AUCTION"].includes(String(value.draftType))
    && ["PPR", "Half PPR", "Standard"].includes(String(value.scoringLabel))
    && Number.isSafeInteger(value.scoringRules) && Number(value.scoringRules) >= 0
    && Number.isSafeInteger(value.teams) && Number(value.teams) >= 8 && Number(value.teams) <= 16
    && Number.isSafeInteger(value.rosterSize) && Number(value.rosterSize) > 0 && Number(value.rosterSize) <= 40
    && Number.isSafeInteger(value.auctionBudget) && Number(value.auctionBudget) >= 0 && Number(value.auctionBudget) <= 1_000
    && [1, 2].includes(Number(value.qbs))
    && Number.isSafeInteger(value.playerCount) && Number(value.playerCount) > 0 && Number(value.playerCount) <= 1_000
    && value.sourceScoring === value.scoringLabel
    && value.sourceTeams === value.teams
    && value.sourceSeason === value.season
    && value.sourceQbs === value.qbs;
}

export function buildAuthenticatedEspnCaptureAttestation({
  capturedAt, league, espnPlayers, request, digest, receipt,
}: {
  capturedAt: string;
  league: AuthenticatedEspnLeagueProfile;
  espnPlayers: unknown[];
  request: AuthenticatedEspnSourceProfile;
  digest: string;
  receipt: string;
}): AuthenticatedEspnCaptureProof {
  return {
    schemaVersion: AUTHENTICATED_ESPN_CAPTURE_SCHEMA_VERSION,
    transport: AUTHENTICATED_ESPN_CAPTURE_TRANSPORT,
    capturedAt,
    profile: buildAuthenticatedEspnCaptureProfile({ league, espnPlayers, request }),
    digest,
    receipt,
  };
}

export function isAuthenticatedEspnCaptureProof(value: unknown): value is AuthenticatedEspnCaptureProof {
  if (!isRecord(value)
    || JSON.stringify(Object.keys(value).sort()) !== JSON.stringify(["capturedAt", "digest", "profile", "receipt", "schemaVersion", "transport"])) return false;
  return value.schemaVersion === AUTHENTICATED_ESPN_CAPTURE_SCHEMA_VERSION
    && value.transport === AUTHENTICATED_ESPN_CAPTURE_TRANSPORT
    && isCanonicalUtcTimestamp(value.capturedAt)
    && isAuthenticatedEspnCaptureProfile(value.profile)
    && CAPTURE_DIGEST.test(String(value.digest || ""))
    && CAPTURE_RECEIPT.test(String(value.receipt || ""));
}

export function authenticatedEspnCaptureReceiptBindingMatchesAudit(
  binding: AuthenticatedEspnCaptureReceiptBinding,
  audit: unknown,
  { now = Date.now() }: { now?: number } = {},
) {
  if (!CAPTURE_DIGEST.test(binding.digest)
    || !isCanonicalUtcTimestamp(binding.capturedAt)
    || !isAuthenticatedEspnCaptureProfile(binding.profile)
    || !Number.isSafeInteger(binding.tabId) || binding.tabId <= 0
    || !isCanonicalUtcTimestamp(binding.dashboardLoadedAt)
    || typeof binding.commandCenterSessionId !== "string"
    || binding.commandCenterSessionId.length < 8 || binding.commandCenterSessionId.length > 128
    || !isRecord(audit)) return false;
  const league = isRecord(audit.league) ? audit.league : null;
  const auditBinding = isRecord(audit.binding) ? audit.binding : null;
  const safety = isRecord(audit.safety) ? audit.safety : null;
  const capturedAtMs = Date.parse(String(audit.capturedAt || ""));
  const importedAtMs = Date.parse(binding.capturedAt);
  if (!league || !auditBinding || !safety
    || !Number.isFinite(now)
    || !Number.isFinite(capturedAtMs)
    || !Number.isFinite(importedAtMs)
    || importedAtMs > now + 5_000
    || now - importedAtMs > AUTHENTICATED_ESPN_CAPTURE_RECEIPT_TTL_MS
    || capturedAtMs > now + 5_000
    || now - capturedAtMs > AUTHENTICATED_ESPN_CAPTURE_AUDIT_MAX_AGE_MS
    || safety.extensionConnected !== true
    || safety.settingsConfirmed !== true
    || safety.sourceCoverage !== 5
    || Number(auditBinding.tabId) !== binding.tabId
    || auditBinding.dashboardLoadedAt !== binding.dashboardLoadedAt
    || auditBinding.commandCenterSessionId !== binding.commandCenterSessionId
    || auditBinding.authenticatedImportAt !== binding.capturedAt) return false;
  const expected = buildAuthenticatedEspnCaptureProfile({
    league,
    espnPlayers: Array.from({ length: binding.profile.playerCount }),
    request: {
      scoring: binding.profile.sourceScoring,
      teams: binding.profile.sourceTeams,
      season: binding.profile.sourceSeason,
      qbs: binding.profile.sourceQbs,
    },
  });
  return PROFILE_KEYS.every((key) => expected[key] === binding.profile[key]);
}

function sameReceiptBinding(left: AuthenticatedEspnCaptureReceiptBinding, right: AuthenticatedEspnCaptureReceiptBinding) {
  return left.digest === right.digest
    && left.capturedAt === right.capturedAt
    && left.tabId === right.tabId
    && left.dashboardLoadedAt === right.dashboardLoadedAt
    && left.commandCenterSessionId === right.commandCenterSessionId
    && canonicalAuthenticatedEspnCaptureJson(left.profile) === canonicalAuthenticatedEspnCaptureJson(right.profile);
}

export function createAuthenticatedEspnCaptureReceiptStore({
  maxEntries = AUTHENTICATED_ESPN_CAPTURE_MAX_RECEIPTS,
  ttlMs = AUTHENTICATED_ESPN_CAPTURE_RECEIPT_TTL_MS,
  now = Date.now,
  randomReceipt = () => globalThis.crypto.randomUUID().replaceAll("-", ""),
}: {
  maxEntries?: number;
  ttlMs?: number;
  now?: () => number;
  randomReceipt?: () => string;
} = {}) {
  if (!Number.isSafeInteger(maxEntries) || maxEntries < 1 || maxEntries > AUTHENTICATED_ESPN_CAPTURE_MAX_RECEIPTS
    || !Number.isSafeInteger(ttlMs) || ttlMs < 1 || ttlMs > AUTHENTICATED_ESPN_CAPTURE_RECEIPT_TTL_MS) {
    throw new Error("ESPN_CAPTURE_RECEIPT_STORE_BOUNDS_INVALID");
  }
  const entries = new Map<string, ReceiptRecord>();
  const prune = () => {
    const evaluatedAt = now();
    for (const [receipt, entry] of entries) if (entry.expiresAt <= evaluatedAt) entries.delete(receipt);
  };
  return {
    issue(binding: AuthenticatedEspnCaptureReceiptBinding) {
      prune();
      if (!CAPTURE_DIGEST.test(binding.digest)
        || !isCanonicalUtcTimestamp(binding.capturedAt)
        || !isAuthenticatedEspnCaptureProfile(binding.profile)) throw new Error("ESPN_CAPTURE_RECEIPT_BINDING_INVALID");
      let receipt = randomReceipt();
      if (!CAPTURE_RECEIPT.test(receipt) || entries.has(receipt)) receipt = globalThis.crypto.randomUUID().replaceAll("-", "");
      if (!CAPTURE_RECEIPT.test(receipt) || entries.has(receipt)) throw new Error("ESPN_CAPTURE_RECEIPT_RANDOM_INVALID");
      while (entries.size >= maxEntries) {
        const oldest = [...entries.entries()].sort((left, right) => left[1].issuedAt - right[1].issuedAt)[0];
        if (!oldest) break;
        entries.delete(oldest[0]);
      }
      const issuedAt = now();
      const record: ReceiptRecord = { ...binding, receipt, issuedAt, expiresAt: issuedAt + ttlMs };
      entries.set(receipt, record);
      return { receipt, expiresAt: new Date(record.expiresAt).toISOString() };
    },
    consume(proof: AuthenticatedEspnCaptureProof) {
      prune();
      if (!isAuthenticatedEspnCaptureProof(proof)) return false;
      const record = entries.get(proof.receipt);
      if (!record || !sameReceiptBinding(record, {
        digest: proof.digest,
        capturedAt: proof.capturedAt,
        profile: proof.profile,
        tabId: record.tabId,
        dashboardLoadedAt: record.dashboardLoadedAt,
        commandCenterSessionId: record.commandCenterSessionId,
      })) return false;
      entries.delete(proof.receipt);
      return true;
    },
    stats() {
      prune();
      return { entries: entries.size, maxEntries, ttlMs };
    },
  };
}
