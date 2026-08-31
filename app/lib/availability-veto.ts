import { normalizePlayerName } from "./consensus.ts";

export const AVAILABILITY_ARTIFACT_SCHEMA = "draftforge.availability/v1" as const;
export const AVAILABILITY_POLICY_SCHEMA = "draftforge.availability-policy/v1" as const;
export const AVAILABILITY_DECISION_SCHEMA = "draftforge.availability-decision/v1" as const;
export const DEFAULT_AVAILABILITY_MAX_AGE_MINUTES = 30;
export const MIN_AVAILABILITY_MAX_AGE_MINUTES = 5;
export const MAX_AVAILABILITY_MAX_AGE_MINUTES = 120;

export const HARD_VETO_CLASSIFICATIONS = [
  "season_ending_injury",
  "injured_reserve_unavailable",
  "pup_unavailable",
  "nfi_unavailable",
  "retirement",
  "release_without_team",
  "suspension_covering_fantasy_season",
  "death",
  "league_ineligibility",
] as const;

export const ADVISORY_CLASSIFICATIONS = [
  "questionable",
  "doubtful",
  "day_to_day",
  "limited_practice",
  "legal_allegation",
  "rumor",
  "opinion",
] as const;

export const EVIDENCE_KINDS = [
  "official_nfl",
  "official_team",
  "official_league",
  "reputable_report",
] as const;

export type HardVetoClassification = typeof HARD_VETO_CLASSIFICATIONS[number];
export type AdvisoryClassification = typeof ADVISORY_CLASSIFICATIONS[number];
export type AvailabilityClassification = HardVetoClassification | AdvisoryClassification;
export type AvailabilityEvidenceKind = typeof EVIDENCE_KINDS[number];
export type AvailabilityPosition = "QB" | "RB" | "WR" | "TE" | "DST" | "K";

export type AvailabilityPolicy = Readonly<{
  schemaVersion: typeof AVAILABILITY_POLICY_SCHEMA;
  maxAgeMinutes: number;
  officialDomains: readonly string[];
  reputableDomains: readonly string[];
}>;

export type AvailabilityIdentity = Readonly<{
  espnPlayerId?: number;
  normalizedName: string;
  team: string;
  position: AvailabilityPosition;
}>;

export type AvailabilityEvidence = Readonly<{
  kind: AvailabilityEvidenceKind;
  url: string;
  domain: string;
  publishedAt: string;
  supportsClassification: AvailabilityClassification;
}>;

export type AvailabilityRecord = Readonly<{
  identity: AvailabilityIdentity;
  classification: AvailabilityClassification;
  reasonCode: AvailabilityClassification;
  eventAt: string;
  retrievedAt: string;
  evidence: readonly AvailabilityEvidence[];
}>;

export type AvailabilityScanFeed = Readonly<{
  id: "authenticated_espn_player_news" | "official_nfl_news";
  url: string;
  retrievedAt: string;
  status: "ok" | "failed";
}>;

export type AvailabilityScanReceipt = Readonly<{
  completedAt: string;
  feeds: readonly AvailabilityScanFeed[];
}>;

export type AvailabilityArtifact = Readonly<{
  schemaVersion: typeof AVAILABILITY_ARTIFACT_SCHEMA;
  generatedAt: string;
  scanReceipt: AvailabilityScanReceipt;
  records: readonly AvailabilityRecord[];
}>;

export type AvailabilityPoolPlayer = Readonly<{
  id: number;
  name: string;
  team: string;
  pos: string;
}>;

export type AvailabilityValidationError = Readonly<{
  path: string;
  code: string;
}>;

export type AvailabilityValidationResult<T> = Readonly<
  | { ok: true; value: T; errors: readonly [] }
  | { ok: false; value: null; errors: readonly AvailabilityValidationError[] }
>;

export type AvailabilityProvenance = Readonly<{
  classification: AvailabilityClassification;
  reasonCode: AvailabilityClassification;
  eventAt: string;
  retrievedAt: string;
  evidence: readonly AvailabilityEvidence[];
}>;

export type AvailabilityResolvedRecord = Readonly<{
  playerId: number;
  identity: AvailabilityIdentity;
  classification: AvailabilityClassification;
  disposition: "HARD_VETO" | "ADVISORY";
  provenance: AvailabilityProvenance;
}>;

export type AvailabilityUnresolvedRecord = Readonly<{
  identity: AvailabilityIdentity;
  classification: AvailabilityClassification;
  reason: "UNMATCHED_IDENTITY" | "AMBIGUOUS_IDENTITY" | "IDENTITY_MISMATCH" | "INSUFFICIENT_HARD_VETO_EVIDENCE";
  claimsActionablePlayer: boolean;
  provenance: AvailabilityProvenance;
}>;

export type AvailabilityGateEvaluation = Readonly<{
  schemaVersion: typeof AVAILABILITY_ARTIFACT_SCHEMA;
  evaluatedAt: string;
  artifactGeneratedAt: string | null;
  freshUntil: string | null;
  digest: string;
  armingAllowed: boolean;
  status: "READY" | "BLOCKED";
  blockingReasons: readonly string[];
  validationErrors: readonly AvailabilityValidationError[];
  vetoedPlayerIds: readonly number[];
  advisoryPlayerIds: readonly number[];
  vetoes: readonly AvailabilityResolvedRecord[];
  advisories: readonly AvailabilityResolvedRecord[];
  unresolved: readonly AvailabilityUnresolvedRecord[];
}>;

export type AvailabilityDecisionSnapshot = Readonly<{
  schemaVersion: typeof AVAILABILITY_DECISION_SCHEMA;
  decisionKey: string;
  evaluatedAt: string;
  availabilityDigest: string;
  decisionDigest: string;
  player: Readonly<{
    id: number;
    normalizedName: string;
    team: string;
    position: AvailabilityPosition;
  }>;
  status: "CLEAR" | "ADVISORY" | "VETO" | "UNRESOLVED";
  canAct: boolean;
  reasons: readonly AvailabilityProvenance[];
}>;

export function availabilityBoundedActionDeadline(
  evaluation: AvailabilityGateEvaluation,
  responseBudgetMs: number,
  now = Date.now(),
) {
  const freshUntilMs = Date.parse(evaluation.freshUntil || "");
  if (!evaluation.armingAllowed
    || !Number.isSafeInteger(responseBudgetMs) || responseBudgetMs < 1
    || !Number.isFinite(now)
    || !Number.isFinite(freshUntilMs)) return null;
  const deadline = Math.min(now + responseBudgetMs, freshUntilMs);
  return Number.isSafeInteger(deadline) && deadline > now ? deadline : null;
}

const HARD_VETO_SET = new Set<string>(HARD_VETO_CLASSIFICATIONS);
const ADVISORY_SET = new Set<string>(ADVISORY_CLASSIFICATIONS);
const CLASSIFICATION_SET = new Set<string>([...HARD_VETO_CLASSIFICATIONS, ...ADVISORY_CLASSIFICATIONS]);
const EVIDENCE_KIND_SET = new Set<string>(EVIDENCE_KINDS);
const POSITION_SET = new Set<string>(["QB", "RB", "WR", "TE", "DST", "K"]);
const OFFICIAL_EVIDENCE_KIND_SET = new Set<string>(["official_nfl", "official_team", "official_league"]);
const FUTURE_CLOCK_SKEW_MS = 2 * 60 * 1000;
const MAX_RECORDS = 512;
const MAX_EVIDENCE_PER_RECORD = 8;
const MAX_URL_LENGTH = 2_048;
const MAX_DECISION_KEY_LENGTH = 128;
const REQUIRED_SCAN_FEEDS = ["authenticated_espn_player_news", "official_nfl_news"] as const;
const SCAN_FEED_URL_RULES: Record<typeof REQUIRED_SCAN_FEEDS[number], {
  hostname: string;
  pathname: (pathname: string) => boolean;
}> = {
  authenticated_espn_player_news: {
    hostname: "fantasy.espn.com",
    pathname: (pathname) => pathname === "/football/playernews" || pathname === "/football/playernews/",
  },
  official_nfl_news: {
    hostname: "www.nfl.com",
    pathname: (pathname) => pathname === "/news" || pathname === "/news/" || pathname.startsWith("/news/"),
  },
};

function scanFeedUrlMatchesId(id: typeof REQUIRED_SCAN_FEEDS[number], url: URL) {
  const rule = SCAN_FEED_URL_RULES[id];
  return url.protocol === "https:"
    && url.hostname.toLowerCase() === rule.hostname
    && (url.port === "" || url.port === "443")
    && !url.username
    && !url.password
    && !url.search
    && !url.hash
    && rule.pathname(url.pathname);
}

function deepFreeze<T>(value: T): Readonly<T> {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value as Readonly<T>;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[], path: string, errors: AvailabilityValidationError[]) {
  const expectedSet = new Set(expected);
  for (const key of Object.keys(value)) {
    if (!expectedSet.has(key)) errors.push({ path: `${path}.${key}`, code: "UNKNOWN_FIELD" });
  }
  for (const key of expected) {
    if (!Object.hasOwn(value, key)) errors.push({ path: `${path}.${key}`, code: "REQUIRED_FIELD" });
  }
}

function optionalExactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[],
  path: string,
  errors: AvailabilityValidationError[],
) {
  const allowed = new Set([...required, ...optional]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) errors.push({ path: `${path}.${key}`, code: "UNKNOWN_FIELD" });
  }
  for (const key of required) {
    if (!Object.hasOwn(value, key)) errors.push({ path: `${path}.${key}`, code: "REQUIRED_FIELD" });
  }
}

function isStrictIsoTimestamp(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return false;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value;
}

function normalizeDomain(value: unknown) {
  const domain = String(value || "").trim().toLowerCase().replace(/\.$/, "");
  return /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(domain) ? domain : null;
}

function parseDomainArray(value: unknown, path: string, errors: AvailabilityValidationError[]) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 128) {
    errors.push({ path, code: "INVALID_DOMAIN_LIST" });
    return [];
  }
  const domains: string[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const domain = normalizeDomain(value[index]);
    if (!domain || domain !== value[index]) errors.push({ path: `${path}[${index}]`, code: "INVALID_CANONICAL_DOMAIN" });
    else domains.push(domain);
  }
  if (new Set(domains).size !== domains.length) errors.push({ path, code: "DUPLICATE_DOMAIN" });
  if (domains.some((domain, index) => domains.some((other, otherIndex) => index !== otherIndex && domain.endsWith(`.${other}`)))) {
    errors.push({ path, code: "OVERLAPPING_DOMAIN" });
  }
  return [...domains].sort();
}

function validPosition(value: unknown): value is AvailabilityPosition {
  return typeof value === "string" && POSITION_SET.has(value);
}

function parseIdentity(value: unknown, path: string, errors: AvailabilityValidationError[]): AvailabilityIdentity | null {
  if (!isPlainObject(value)) {
    errors.push({ path, code: "INVALID_OBJECT" });
    return null;
  }
  optionalExactKeys(value, ["normalizedName", "team", "position"], ["espnPlayerId"], path, errors);
  const normalizedName = typeof value.normalizedName === "string" ? value.normalizedName : "";
  if (!/^[a-z0-9]{2,80}$/.test(normalizedName) || normalizePlayerName(normalizedName) !== normalizedName) {
    errors.push({ path: `${path}.normalizedName`, code: "INVALID_NORMALIZED_NAME" });
  }
  const team = typeof value.team === "string" ? value.team : "";
  if (!/^(?:[A-Z]{2,4}|FA)$/.test(team)) errors.push({ path: `${path}.team`, code: "INVALID_TEAM" });
  if (!validPosition(value.position)) errors.push({ path: `${path}.position`, code: "INVALID_POSITION" });
  if (Object.hasOwn(value, "espnPlayerId") && (!Number.isSafeInteger(value.espnPlayerId) || Number(value.espnPlayerId) === 0)) {
    errors.push({ path: `${path}.espnPlayerId`, code: "INVALID_ESPN_PLAYER_ID" });
  }
  if (!normalizedName || !team || !validPosition(value.position)) return null;
  return {
    ...(Object.hasOwn(value, "espnPlayerId") ? { espnPlayerId: Number(value.espnPlayerId) } : {}),
    normalizedName,
    team,
    position: value.position,
  };
}

function parseEvidence(
  value: unknown,
  classification: AvailabilityClassification,
  path: string,
  errors: AvailabilityValidationError[],
): AvailabilityEvidence | null {
  if (!isPlainObject(value)) {
    errors.push({ path, code: "INVALID_OBJECT" });
    return null;
  }
  exactKeys(value, ["kind", "url", "domain", "publishedAt", "supportsClassification"], path, errors);
  if (typeof value.kind !== "string" || !EVIDENCE_KIND_SET.has(value.kind)) {
    errors.push({ path: `${path}.kind`, code: "INVALID_EVIDENCE_KIND" });
  }
  const domain = normalizeDomain(value.domain);
  if (!domain || domain !== value.domain) errors.push({ path: `${path}.domain`, code: "INVALID_CANONICAL_DOMAIN" });
  let url: URL | null = null;
  if (typeof value.url !== "string" || value.url.length > MAX_URL_LENGTH) {
    errors.push({ path: `${path}.url`, code: "INVALID_URL" });
  } else {
    try {
      url = new URL(value.url);
    } catch {
      errors.push({ path: `${path}.url`, code: "INVALID_URL" });
    }
  }
  if (url && (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || url.hostname.toLowerCase() !== domain)) {
    errors.push({ path: `${path}.url`, code: "UNSAFE_OR_MISMATCHED_URL" });
  }
  if (!isStrictIsoTimestamp(value.publishedAt)) errors.push({ path: `${path}.publishedAt`, code: "INVALID_TIMESTAMP" });
  if (value.supportsClassification !== classification) {
    errors.push({ path: `${path}.supportsClassification`, code: "EVIDENCE_CLASSIFICATION_MISMATCH" });
  }
  if (typeof value.kind !== "string" || !EVIDENCE_KIND_SET.has(value.kind) || !domain || !url
    || !isStrictIsoTimestamp(value.publishedAt) || value.supportsClassification !== classification) return null;
  return {
    kind: value.kind as AvailabilityEvidenceKind,
    url: url.toString(),
    domain,
    publishedAt: value.publishedAt,
    supportsClassification: classification,
  };
}

function parseRecord(value: unknown, index: number, errors: AvailabilityValidationError[]): AvailabilityRecord | null {
  const path = `$.records[${index}]`;
  if (!isPlainObject(value)) {
    errors.push({ path, code: "INVALID_OBJECT" });
    return null;
  }
  exactKeys(value, ["identity", "classification", "reasonCode", "eventAt", "retrievedAt", "evidence"], path, errors);
  const identity = parseIdentity(value.identity, `${path}.identity`, errors);
  const classification = typeof value.classification === "string" && CLASSIFICATION_SET.has(value.classification)
    ? value.classification as AvailabilityClassification
    : null;
  if (!classification) errors.push({ path: `${path}.classification`, code: "INVALID_CLASSIFICATION" });
  if (!classification || value.reasonCode !== classification) {
    errors.push({ path: `${path}.reasonCode`, code: "INVALID_REASON_CODE" });
  }
  if (!isStrictIsoTimestamp(value.eventAt)) errors.push({ path: `${path}.eventAt`, code: "INVALID_TIMESTAMP" });
  if (!isStrictIsoTimestamp(value.retrievedAt)) errors.push({ path: `${path}.retrievedAt`, code: "INVALID_TIMESTAMP" });
  if (!Array.isArray(value.evidence) || value.evidence.length < 1 || value.evidence.length > MAX_EVIDENCE_PER_RECORD) {
    errors.push({ path: `${path}.evidence`, code: "INVALID_EVIDENCE_COUNT" });
  }
  const evidence = classification && Array.isArray(value.evidence)
    ? value.evidence.slice(0, MAX_EVIDENCE_PER_RECORD + 1)
      .map((item, evidenceIndex) => parseEvidence(item, classification, `${path}.evidence[${evidenceIndex}]`, errors))
      .filter((item): item is AvailabilityEvidence => Boolean(item))
      .sort((left, right) => left.domain.localeCompare(right.domain) || left.url.localeCompare(right.url))
    : [];
  if (!identity || !classification || !isStrictIsoTimestamp(value.eventAt) || !isStrictIsoTimestamp(value.retrievedAt)) return null;
  return {
    identity,
    classification,
    reasonCode: classification,
    eventAt: value.eventAt,
    retrievedAt: value.retrievedAt,
    evidence,
  };
}

function parseScanReceipt(value: unknown, errors: AvailabilityValidationError[]): AvailabilityScanReceipt | null {
  const path = "$.scanReceipt";
  if (!isPlainObject(value)) {
    errors.push({ path, code: "INVALID_OBJECT" });
    return null;
  }
  exactKeys(value, ["completedAt", "feeds"], path, errors);
  if (!isStrictIsoTimestamp(value.completedAt)) errors.push({ path: `${path}.completedAt`, code: "INVALID_TIMESTAMP" });
  if (!Array.isArray(value.feeds) || value.feeds.length !== REQUIRED_SCAN_FEEDS.length) {
    errors.push({ path: `${path}.feeds`, code: "INVALID_SCAN_FEED_COUNT" });
  }
  const feeds: AvailabilityScanFeed[] = [];
  const rawFeeds: unknown[] = Array.isArray(value.feeds) ? value.feeds : [];
  for (let index = 0; index < rawFeeds.length; index += 1) {
    const feed = rawFeeds[index];
    const feedPath = `${path}.feeds[${index}]`;
    if (!isPlainObject(feed)) {
      errors.push({ path: feedPath, code: "INVALID_OBJECT" });
      continue;
    }
    exactKeys(feed, ["id", "url", "retrievedAt", "status"], feedPath, errors);
    if (!REQUIRED_SCAN_FEEDS.includes(feed.id as typeof REQUIRED_SCAN_FEEDS[number])) {
      errors.push({ path: `${feedPath}.id`, code: "INVALID_SCAN_FEED_ID" });
    }
    let url: URL | null = null;
    try { url = new URL(String(feed.url || "")); } catch { /* validation below */ }
    const feedId = REQUIRED_SCAN_FEEDS.includes(feed.id as typeof REQUIRED_SCAN_FEEDS[number])
      ? feed.id as typeof REQUIRED_SCAN_FEEDS[number]
      : null;
    if (!url || !feedId || !scanFeedUrlMatchesId(feedId, url) || String(feed.url).length > MAX_URL_LENGTH) {
      errors.push({ path: `${feedPath}.url`, code: "INVALID_SCAN_FEED_URL" });
    }
    if (!isStrictIsoTimestamp(feed.retrievedAt)) errors.push({ path: `${feedPath}.retrievedAt`, code: "INVALID_TIMESTAMP" });
    if (!new Set(["ok", "failed"]).has(String(feed.status || ""))) {
      errors.push({ path: `${feedPath}.status`, code: "INVALID_SCAN_FEED_STATUS" });
    }
    if (feedId && url && scanFeedUrlMatchesId(feedId, url)
      && isStrictIsoTimestamp(feed.retrievedAt) && ["ok", "failed"].includes(String(feed.status))) {
      feeds.push({
        id: feed.id as AvailabilityScanFeed["id"],
        url: url.toString(),
        retrievedAt: feed.retrievedAt,
        status: feed.status as AvailabilityScanFeed["status"],
      });
    }
  }
  const ids = feeds.map((feed) => feed.id);
  if (new Set(ids).size !== ids.length || !REQUIRED_SCAN_FEEDS.every((id) => ids.includes(id))) {
    errors.push({ path: `${path}.feeds`, code: "REQUIRED_SCAN_FEEDS_MISSING" });
  }
  if (!isStrictIsoTimestamp(value.completedAt)) return null;
  return {
    completedAt: value.completedAt,
    feeds: feeds.sort((left, right) => left.id.localeCompare(right.id)),
  };
}

export function parseAvailabilityPolicy(input: unknown): AvailabilityValidationResult<AvailabilityPolicy> {
  const errors: AvailabilityValidationError[] = [];
  if (!isPlainObject(input)) {
    return deepFreeze({ ok: false, value: null, errors: [{ path: "$", code: "INVALID_OBJECT" }] });
  }
  exactKeys(input, ["schemaVersion", "maxAgeMinutes", "officialDomains", "reputableDomains"], "$", errors);
  if (input.schemaVersion !== AVAILABILITY_POLICY_SCHEMA) errors.push({ path: "$.schemaVersion", code: "UNSUPPORTED_SCHEMA" });
  if (!Number.isInteger(input.maxAgeMinutes)
    || Number(input.maxAgeMinutes) < MIN_AVAILABILITY_MAX_AGE_MINUTES
    || Number(input.maxAgeMinutes) > MAX_AVAILABILITY_MAX_AGE_MINUTES) {
    errors.push({ path: "$.maxAgeMinutes", code: "MAX_AGE_OUT_OF_BOUNDS" });
  }
  const officialDomains = parseDomainArray(input.officialDomains, "$.officialDomains", errors);
  const reputableDomains = parseDomainArray(input.reputableDomains, "$.reputableDomains", errors);
  if (errors.length) return deepFreeze({ ok: false, value: null, errors });
  return deepFreeze({
    ok: true,
    value: {
      schemaVersion: AVAILABILITY_POLICY_SCHEMA,
      maxAgeMinutes: Number(input.maxAgeMinutes),
      officialDomains,
      reputableDomains,
    },
    errors: [] as const,
  });
}

export function parseAvailabilityArtifact(input: unknown): AvailabilityValidationResult<AvailabilityArtifact> {
  const errors: AvailabilityValidationError[] = [];
  if (!isPlainObject(input)) {
    return deepFreeze({ ok: false, value: null, errors: [{ path: "$", code: "INVALID_OBJECT" }] });
  }
  exactKeys(input, ["schemaVersion", "generatedAt", "scanReceipt", "records"], "$", errors);
  if (input.schemaVersion !== AVAILABILITY_ARTIFACT_SCHEMA) errors.push({ path: "$.schemaVersion", code: "UNSUPPORTED_SCHEMA" });
  if (!isStrictIsoTimestamp(input.generatedAt)) errors.push({ path: "$.generatedAt", code: "INVALID_TIMESTAMP" });
  if (!Array.isArray(input.records) || input.records.length > MAX_RECORDS) {
    errors.push({ path: "$.records", code: "INVALID_RECORD_COUNT" });
  }
  const scanReceipt = parseScanReceipt(input.scanReceipt, errors);
  const records = Array.isArray(input.records)
    ? input.records.slice(0, MAX_RECORDS + 1)
      .map((record, index) => parseRecord(record, index, errors))
      .filter((record): record is AvailabilityRecord => Boolean(record))
      .sort((left, right) => identityKey(left.identity).localeCompare(identityKey(right.identity))
        || left.classification.localeCompare(right.classification)
        || left.eventAt.localeCompare(right.eventAt))
    : [];
  if (errors.length || !isStrictIsoTimestamp(input.generatedAt) || !scanReceipt) return deepFreeze({ ok: false, value: null, errors });
  return deepFreeze({
    ok: true,
    value: { schemaVersion: AVAILABILITY_ARTIFACT_SCHEMA, generatedAt: input.generatedAt, scanReceipt, records },
    errors: [] as const,
  });
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
}

// Portable SHA-256 keeps availability digests identical in Node, browser, and
// edge runtimes without importing Node crypto into the client bundle.
function sha256Hex(value: string) {
  const bytes = new TextEncoder().encode(value);
  const bitLength = bytes.length * 8;
  const paddedLength = Math.ceil((bytes.length + 9) / 64) * 64;
  const padded = new Uint8Array(paddedLength);
  padded.set(bytes);
  padded[bytes.length] = 0x80;
  const view = new DataView(padded.buffer);
  const high = Math.floor(bitLength / 0x100000000);
  const low = bitLength >>> 0;
  view.setUint32(paddedLength - 8, high, false);
  view.setUint32(paddedLength - 4, low, false);
  const constants = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
  ];
  const state = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
  const words = new Uint32Array(64);
  const rotateRight = (word: number, shift: number) => (word >>> shift) | (word << (32 - shift));
  for (let offset = 0; offset < padded.length; offset += 64) {
    for (let index = 0; index < 16; index += 1) words[index] = view.getUint32(offset + index * 4, false);
    for (let index = 16; index < 64; index += 1) {
      const s0 = rotateRight(words[index - 15], 7) ^ rotateRight(words[index - 15], 18) ^ (words[index - 15] >>> 3);
      const s1 = rotateRight(words[index - 2], 17) ^ rotateRight(words[index - 2], 19) ^ (words[index - 2] >>> 10);
      words[index] = (words[index - 16] + s0 + words[index - 7] + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, h] = state;
    for (let index = 0; index < 64; index += 1) {
      const s1 = rotateRight(e, 6) ^ rotateRight(e, 11) ^ rotateRight(e, 25);
      const choice = (e & f) ^ (~e & g);
      const temp1 = (h + s1 + choice + constants[index] + words[index]) >>> 0;
      const s0 = rotateRight(a, 2) ^ rotateRight(a, 13) ^ rotateRight(a, 22);
      const majority = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (s0 + majority) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }
    state[0] = (state[0] + a) >>> 0;
    state[1] = (state[1] + b) >>> 0;
    state[2] = (state[2] + c) >>> 0;
    state[3] = (state[3] + d) >>> 0;
    state[4] = (state[4] + e) >>> 0;
    state[5] = (state[5] + f) >>> 0;
    state[6] = (state[6] + g) >>> 0;
    state[7] = (state[7] + h) >>> 0;
  }
  return state.map((word) => word.toString(16).padStart(8, "0")).join("");
}

function digest(value: unknown) {
  return `sha256:${sha256Hex(canonicalJson(value))}`;
}

function identityKey(identity: AvailabilityIdentity) {
  return `${identity.normalizedName}|${identity.team}|${identity.position}`;
}

function normalizePoolPlayer(player: AvailabilityPoolPlayer) {
  const id = Number(player.id);
  const normalizedName = normalizePlayerName(String(player.name || ""));
  const team = String(player.team || "").trim().toUpperCase();
  const position = String(player.pos || "").trim().toUpperCase();
  if (!Number.isSafeInteger(id) || id === 0 || !/^[a-z0-9]{2,80}$/.test(normalizedName)
    || !/^(?:[A-Z]{2,4}|FA)$/.test(team) || !validPosition(position)) return null;
  return { id, normalizedName, team, position };
}

function configuredDomainFor(domain: string, configured: readonly string[]) {
  return configured
    .filter((candidate) => domain === candidate || domain.endsWith(`.${candidate}`))
    .sort((left, right) => right.length - left.length)[0] || null;
}

function hardVetoEvidenceIsSufficient(record: AvailabilityRecord, policy: AvailabilityPolicy) {
  const official = record.evidence.some((item) => OFFICIAL_EVIDENCE_KIND_SET.has(item.kind)
    && Boolean(configuredDomainFor(item.domain, policy.officialDomains)));
  if (official) return true;
  const independentReports = new Set(record.evidence
    .filter((item) => item.kind === "reputable_report")
    .map((item) => configuredDomainFor(item.domain, policy.reputableDomains))
    .filter((item): item is string => Boolean(item)));
  return independentReports.size >= 2;
}

function provenance(record: AvailabilityRecord): AvailabilityProvenance {
  return {
    classification: record.classification,
    reasonCode: record.reasonCode,
    eventAt: record.eventAt,
    retrievedAt: record.retrievedAt,
    evidence: record.evidence,
  };
}

function emptyBlockedEvaluation(evaluatedAt: string, errors: readonly AvailabilityValidationError[]): AvailabilityGateEvaluation {
  return deepFreeze({
    schemaVersion: AVAILABILITY_ARTIFACT_SCHEMA,
    evaluatedAt,
    artifactGeneratedAt: null,
    freshUntil: null,
    digest: digest({ schemaVersion: AVAILABILITY_ARTIFACT_SCHEMA, errors }),
    armingAllowed: false,
    status: "BLOCKED",
    blockingReasons: ["INVALID_AVAILABILITY_INPUT"],
    validationErrors: errors,
    vetoedPlayerIds: [],
    advisoryPlayerIds: [],
    vetoes: [],
    advisories: [],
    unresolved: [],
  });
}

function claimsActionablePlayer(identity: AvailabilityIdentity, players: readonly ReturnType<typeof normalizePoolPlayer>[]) {
  return players.some((candidate) => candidate && (
    (identity.espnPlayerId !== undefined && candidate.id === identity.espnPlayerId)
    || (candidate.normalizedName === identity.normalizedName && candidate.position === identity.position)
  ));
}

function findIdentity(
  identity: AvailabilityIdentity,
  players: readonly NonNullable<ReturnType<typeof normalizePoolPlayer>>[],
): { player: NonNullable<ReturnType<typeof normalizePoolPlayer>> | null; reason: AvailabilityUnresolvedRecord["reason"] | null } {
  if (identity.espnPlayerId !== undefined) {
    const byId = players.filter((player) => player.id === identity.espnPlayerId);
    if (byId.length > 1) return { player: null, reason: "AMBIGUOUS_IDENTITY" };
    if (!byId.length) return { player: null, reason: "UNMATCHED_IDENTITY" };
    const [player] = byId;
    return player.normalizedName === identity.normalizedName && player.team === identity.team && player.position === identity.position
      ? { player, reason: null }
      : { player: null, reason: "IDENTITY_MISMATCH" };
  }
  const exact = players.filter((player) => player.normalizedName === identity.normalizedName
    && player.team === identity.team && player.position === identity.position);
  if (exact.length === 1) return { player: exact[0], reason: null };
  return { player: null, reason: exact.length > 1 ? "AMBIGUOUS_IDENTITY" : "UNMATCHED_IDENTITY" };
}

export function evaluateAvailabilityGate(input: {
  artifact: unknown;
  policy: unknown;
  players: readonly AvailabilityPoolPlayer[];
  actionablePlayerIds?: readonly number[];
  evaluatedAt: string;
}): AvailabilityGateEvaluation {
  const artifactResult = parseAvailabilityArtifact(input.artifact);
  const policyResult = parseAvailabilityPolicy(input.policy);
  if (!isStrictIsoTimestamp(input.evaluatedAt)) {
    return emptyBlockedEvaluation("1970-01-01T00:00:00.000Z", [{ path: "$.evaluatedAt", code: "INVALID_TIMESTAMP" }]);
  }
  if (!artifactResult.ok || !policyResult.ok) {
    return emptyBlockedEvaluation(input.evaluatedAt, [...artifactResult.errors, ...policyResult.errors]);
  }
  const artifact = artifactResult.value;
  const policy = policyResult.value;
  const availabilityDigest = digest({ artifact, policy });
  const evaluatedMs = Date.parse(input.evaluatedAt);
  const generatedMs = Date.parse(artifact.generatedAt);
  const maxAgeMs = policy.maxAgeMinutes * 60 * 1000;
  const blockingReasons = new Set<string>();
  const validationErrors: AvailabilityValidationError[] = [];
  if (generatedMs > evaluatedMs + FUTURE_CLOCK_SKEW_MS) blockingReasons.add("FUTURE_AVAILABILITY_ARTIFACT");
  if (evaluatedMs - generatedMs >= maxAgeMs) blockingReasons.add("STALE_AVAILABILITY_ARTIFACT");
  const scanCompletedMs = Date.parse(artifact.scanReceipt.completedAt);
  const freshnessAnchors = [generatedMs, scanCompletedMs];
  if (scanCompletedMs > generatedMs + FUTURE_CLOCK_SKEW_MS || scanCompletedMs > evaluatedMs + FUTURE_CLOCK_SKEW_MS) {
    blockingReasons.add("FUTURE_NEWS_SCAN_RECEIPT");
  }
  if (evaluatedMs - scanCompletedMs >= maxAgeMs) blockingReasons.add("STALE_NEWS_SCAN_RECEIPT");
  if (artifact.scanReceipt.feeds.some((feed) => feed.status !== "ok")) blockingReasons.add("NEWS_SCAN_FAILED");
  for (const feed of artifact.scanReceipt.feeds) {
    const retrievedMs = Date.parse(feed.retrievedAt);
    freshnessAnchors.push(retrievedMs);
    if (retrievedMs > scanCompletedMs + FUTURE_CLOCK_SKEW_MS || retrievedMs > evaluatedMs + FUTURE_CLOCK_SKEW_MS) {
      blockingReasons.add("FUTURE_NEWS_SCAN_FEED");
    }
    if (evaluatedMs - retrievedMs >= maxAgeMs) blockingReasons.add("STALE_NEWS_SCAN_FEED");
  }

  const normalizedPlayers = input.players.map(normalizePoolPlayer);
  if (normalizedPlayers.some((player) => !player)) blockingReasons.add("INVALID_PLAYER_POOL_IDENTITY");
  const players = normalizedPlayers.filter((player): player is NonNullable<typeof player> => Boolean(player));
  const actionableIds = input.actionablePlayerIds === undefined
    ? new Set(players.map((player) => player.id))
    : new Set(input.actionablePlayerIds.filter((id) => Number.isSafeInteger(id) && id !== 0));
  const actionablePlayers = players.filter((player) => actionableIds.has(player.id));

  const identitiesByPlayerId = new Map<number, Set<string>>();
  const playerIdsByIdentity = new Map<string, Set<number>>();
  for (const record of artifact.records) {
    if (record.identity.espnPlayerId !== undefined) {
      const key = identityKey(record.identity);
      const identities = identitiesByPlayerId.get(record.identity.espnPlayerId) || new Set<string>();
      identities.add(key);
      identitiesByPlayerId.set(record.identity.espnPlayerId, identities);
      const ids = playerIdsByIdentity.get(key) || new Set<number>();
      ids.add(record.identity.espnPlayerId);
      playerIdsByIdentity.set(key, ids);
    }
  }
  if ([...identitiesByPlayerId.values()].some((identities) => identities.size > 1)
    || [...playerIdsByIdentity.values()].some((ids) => ids.size > 1)) {
    blockingReasons.add("CONFLICTING_IDENTITY_CLAIMS");
  }

  const vetoes: AvailabilityResolvedRecord[] = [];
  const advisories: AvailabilityResolvedRecord[] = [];
  const unresolved: AvailabilityUnresolvedRecord[] = [];
  for (const record of artifact.records) {
    const recordRetrievedMs = Date.parse(record.retrievedAt);
    freshnessAnchors.push(recordRetrievedMs);
    const eventMs = Date.parse(record.eventAt);
    if (recordRetrievedMs > generatedMs + FUTURE_CLOCK_SKEW_MS || recordRetrievedMs > evaluatedMs + FUTURE_CLOCK_SKEW_MS) {
      blockingReasons.add("FUTURE_AVAILABILITY_RECORD");
    }
    if (evaluatedMs - recordRetrievedMs >= maxAgeMs) blockingReasons.add("STALE_AVAILABILITY_RECORD");
    if (eventMs > recordRetrievedMs + FUTURE_CLOCK_SKEW_MS) blockingReasons.add("EVENT_AFTER_RETRIEVAL");
    if (record.evidence.some((item) => Date.parse(item.publishedAt) > recordRetrievedMs + FUTURE_CLOCK_SKEW_MS)) {
      blockingReasons.add("EVIDENCE_AFTER_RETRIEVAL");
    }

    const match = findIdentity(record.identity, players);
    const hardVeto = HARD_VETO_SET.has(record.classification);
    const claimsActionable = claimsActionablePlayer(record.identity, actionablePlayers);
    if (!match.player) {
      unresolved.push({
        identity: record.identity,
        classification: record.classification,
        reason: match.reason || "UNMATCHED_IDENTITY",
        claimsActionablePlayer: claimsActionable,
        provenance: provenance(record),
      });
      if (hardVeto && claimsActionable) blockingReasons.add("UNRESOLVED_ACTIONABLE_HARD_VETO");
      continue;
    }
    if (hardVeto && !hardVetoEvidenceIsSufficient(record, policy)) {
      unresolved.push({
        identity: record.identity,
        classification: record.classification,
        reason: "INSUFFICIENT_HARD_VETO_EVIDENCE",
        claimsActionablePlayer: actionableIds.has(match.player.id),
        provenance: provenance(record),
      });
      if (actionableIds.has(match.player.id)) blockingReasons.add("UNRESOLVED_ACTIONABLE_HARD_VETO");
      continue;
    }
    const resolved: AvailabilityResolvedRecord = {
      playerId: match.player.id,
      identity: record.identity,
      classification: record.classification,
      disposition: hardVeto ? "HARD_VETO" : "ADVISORY",
      provenance: provenance(record),
    };
    if (hardVeto) vetoes.push(resolved);
    else advisories.push(resolved);
  }

  vetoes.sort((left, right) => left.playerId - right.playerId || left.classification.localeCompare(right.classification));
  advisories.sort((left, right) => left.playerId - right.playerId || left.classification.localeCompare(right.classification));
  unresolved.sort((left, right) => identityKey(left.identity).localeCompare(identityKey(right.identity))
    || left.classification.localeCompare(right.classification) || left.reason.localeCompare(right.reason));
  const sortedBlockingReasons = [...blockingReasons].sort();
  const effectiveFreshUntilMs = Math.min(...freshnessAnchors) + maxAgeMs;
  return deepFreeze({
    schemaVersion: AVAILABILITY_ARTIFACT_SCHEMA,
    evaluatedAt: input.evaluatedAt,
    artifactGeneratedAt: artifact.generatedAt,
    freshUntil: new Date(effectiveFreshUntilMs).toISOString(),
    digest: availabilityDigest,
    armingAllowed: sortedBlockingReasons.length === 0,
    status: sortedBlockingReasons.length === 0 ? "READY" : "BLOCKED",
    blockingReasons: sortedBlockingReasons,
    validationErrors,
    vetoedPlayerIds: [...new Set(vetoes.map((record) => record.playerId))].sort((left, right) => left - right),
    advisoryPlayerIds: [...new Set(advisories.map((record) => record.playerId))].sort((left, right) => left - right),
    vetoes,
    advisories,
    unresolved,
  });
}

function normalizedDecisionPlayer(player: AvailabilityPoolPlayer) {
  const normalized = normalizePoolPlayer(player);
  if (!normalized) throw new Error("INVALID_DECISION_PLAYER_IDENTITY");
  return normalized;
}

export function createAvailabilityDecisionSnapshot(input: {
  decisionKey: string;
  evaluation: AvailabilityGateEvaluation;
  player: AvailabilityPoolPlayer;
}): AvailabilityDecisionSnapshot {
  if (!/^[a-zA-Z0-9._:-]{1,128}$/.test(input.decisionKey) || input.decisionKey.length > MAX_DECISION_KEY_LENGTH) {
    throw new Error("INVALID_AVAILABILITY_DECISION_KEY");
  }
  const player = normalizedDecisionPlayer(input.player);
  const reasons = [
    ...input.evaluation.vetoes.filter((record) => record.playerId === player.id).map((record) => record.provenance),
    ...input.evaluation.advisories.filter((record) => record.playerId === player.id).map((record) => record.provenance),
    ...input.evaluation.unresolved
      .filter((record) => record.claimsActionablePlayer && (
        record.identity.espnPlayerId === player.id
        || (record.identity.normalizedName === player.normalizedName && record.identity.position === player.position)
      ))
      .map((record) => record.provenance),
  ].sort((left, right) => left.classification.localeCompare(right.classification) || left.eventAt.localeCompare(right.eventAt));
  const status = !input.evaluation.armingAllowed
    ? "UNRESOLVED" as const
    : input.evaluation.vetoedPlayerIds.includes(player.id)
      ? "VETO" as const
      : input.evaluation.advisoryPlayerIds.includes(player.id)
        ? "ADVISORY" as const
        : "CLEAR" as const;
  const body = {
    schemaVersion: AVAILABILITY_DECISION_SCHEMA,
    decisionKey: input.decisionKey,
    evaluatedAt: input.evaluation.evaluatedAt,
    availabilityDigest: input.evaluation.digest,
    player,
    status,
    canAct: input.evaluation.armingAllowed && status !== "VETO",
    reasons,
  };
  return deepFreeze({ ...body, decisionDigest: digest(body) });
}

export function revalidateAvailabilityDecision(
  snapshot: AvailabilityDecisionSnapshot,
  evaluation: AvailabilityGateEvaluation,
  player: AvailabilityPoolPlayer,
) {
  let current: AvailabilityDecisionSnapshot;
  try {
    current = createAvailabilityDecisionSnapshot({ decisionKey: snapshot.decisionKey, evaluation, player });
  } catch {
    return deepFreeze({ valid: false, reason: "INVALID_PLAYER_IDENTITY" as const, current: null });
  }
  if (snapshot.player.id !== current.player.id
    || snapshot.player.normalizedName !== current.player.normalizedName
    || snapshot.player.team !== current.player.team
    || snapshot.player.position !== current.player.position) {
    return deepFreeze({ valid: false, reason: "PLAYER_IDENTITY_CHANGED" as const, current });
  }
  if (snapshot.availabilityDigest !== current.availabilityDigest) {
    return deepFreeze({ valid: false, reason: "AVAILABILITY_DIGEST_CHANGED" as const, current });
  }
  if (!current.canAct) return deepFreeze({ valid: false, reason: current.status === "VETO" ? "PLAYER_VETOED" as const : "GATE_BLOCKED" as const, current });
  return deepFreeze({ valid: true, reason: "UNCHANGED_AND_AVAILABLE" as const, current });
}

export function isAvailabilityHardVeto(classification: AvailabilityClassification): classification is HardVetoClassification {
  return HARD_VETO_SET.has(classification);
}

export function isAvailabilityAdvisory(classification: AvailabilityClassification): classification is AdvisoryClassification {
  return ADVISORY_SET.has(classification);
}

export function excludeAvailabilityVetoes<T extends { id: number }>(
  players: readonly T[],
  evaluation: AvailabilityGateEvaluation,
) {
  const vetoed = new Set(evaluation.vetoedPlayerIds);
  return players.filter((player) => !vetoed.has(player.id));
}
