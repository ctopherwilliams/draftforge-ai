import { normalizePlayerName, type IntelligencePlayer, type IntelligenceSource } from "./consensus.ts";

export type IntelligenceRequest = {
  scoring: string;
  teams: number;
  season: number;
  qbs: 1 | 2;
};

export type IntelligenceResponse = IntelligenceRequest & {
  generatedAt: string;
  sourceSnapshotId: string;
  sources: IntelligenceSource[];
  methodology: {
    weights: Record<"espn" | "gng" | "tradyr" | "ffc" | "mfl", number>;
    method: string;
  };
};

export const INTELLIGENCE_SNAPSHOT_ID_SCHEMA = "draftforge.intelligence-snapshot-id/v1" as const;

type IntelligenceSnapshotIdentityInput = IntelligenceRequest & {
  generatedAt: string;
  sources: IntelligenceSource[];
  methodology: IntelligenceResponse["methodology"];
};

function canonicalSnapshotValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalSnapshotValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .filter(([, child]) => child !== undefined)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, child]) => [key, canonicalSnapshotValue(child)]));
}

function canonicalSourceForSnapshot(source: IntelligenceSource) {
  const players = source.players
    .map((player) => canonicalSnapshotValue(player))
    .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
  return canonicalSnapshotValue({
    id: source.id,
    name: source.name,
    kind: source.kind,
    weight: source.weight,
    status: source.status,
    updatedAt: source.updatedAt,
    retrievedAt: source.retrievedAt ?? null,
    attribution: source.attribution,
    url: source.url ?? null,
    sampleSize: source.sampleSize ?? null,
    coverage: source.coverage ?? null,
    error: source.error ?? null,
    players,
  });
}

/**
 * Content-address the exact server snapshot consumed by the dashboard. The
 * digest is an authorization identity only; it never changes source weights
 * or contributes to player scoring.
 */
export async function intelligenceSourceSnapshotId(input: IntelligenceSnapshotIdentityInput) {
  const canonical = canonicalSnapshotValue({
    schemaVersion: INTELLIGENCE_SNAPSHOT_ID_SCHEMA,
    profile: {
      scoring: input.scoring,
      teams: input.teams,
      season: input.season,
      qbs: input.qbs,
    },
    generatedAt: input.generatedAt,
    methodology: input.methodology,
    sources: [...input.sources]
      .sort((left, right) => left.id.localeCompare(right.id))
      .map(canonicalSourceForSnapshot),
  });
  const bytes = new TextEncoder().encode(JSON.stringify(canonical));
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return `sha256:${[...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

const SOURCE_INFO = {
  ffc: { name: "Fantasy Football Calculator", kind: "market" as const, weight: .15, attribution: "Fantasy Football Calculator", url: "https://fantasyfootballcalculator.com" },
  mfl: { name: "MyFantasyLeague", kind: "market" as const, weight: .15, attribution: "MyFantasyLeague", url: "https://www.myfantasyleague.com" },
  tradyr: { name: "Tradyr", kind: "composite" as const, weight: .20, attribution: "Powered by Tradyr", url: "https://tradyr.app" },
  gng: { name: "The GNG Pigskin Rankings", kind: "model" as const, weight: .20, attribution: "The GNG rankings", url: "https://www.thegng.us/ranks" },
};

const PROVIDER_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;
const PROVIDER_MAX_FUTURE_SKEW_MS = 5 * 60 * 1000;
const MIN_CANONICAL_PROVIDER_ROWS = 25;
const CORE_PROVIDER_POSITIONS = ["QB", "RB", "WR", "TE"] as const;
const VALID_PROVIDER_POSITIONS = new Set(["QB", "RB", "WR", "TE", "K", "DST", "FLEX"]);

function canonicalProviderPosition(value: unknown) {
  const position = String(value || "").trim().toUpperCase().replace(/[.\s]/g, "");
  if (position === "PK") return "K";
  if (["D/ST", "DEF", "DEFENSE"].includes(position)) return "DST";
  return VALID_PROVIDER_POSITIONS.has(position) ? position : "";
}

function positiveProviderNumber(value: unknown) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 && number <= 10_000 ? number : null;
}

function finiteProviderNumber(value: unknown, minimum = 0) {
  const number = Number(value);
  return Number.isFinite(number) && number >= minimum ? number : null;
}

function canonicalProviderPlayer(player: IntelligencePlayer): IntelligencePlayer | null {
  const name = String(player?.name || "").trim().replace(/\s+/g, " ");
  const normalizedName = normalizePlayerName(name);
  const pos = canonicalProviderPosition(player?.pos);
  const rank = positiveProviderNumber(player?.rank);
  const adp = positiveProviderNumber(player?.adp);
  if (!name || !normalizedName || !pos || (rank === null && adp === null)) return null;
  const auction = finiteProviderNumber(player.auction);
  const projectedPpg = finiteProviderNumber(player.projectedPpg);
  const sourceScore = finiteProviderNumber(player.sourceScore);
  return {
    name,
    team: String(player.team || "").trim().toUpperCase(),
    pos,
    ...(rank === null ? {} : { rank }),
    ...(adp === null ? {} : { adp }),
    ...(auction === null ? {} : { auction }),
    ...(projectedPpg === null ? {} : { projectedPpg }),
    ...(sourceScore === null ? {} : { sourceScore }),
  };
}

function providerSourceError(source: IntelligenceSource, code: string): IntelligenceSource {
  return {
    ...source,
    status: "error",
    players: [],
    coverage: { players: 0, corePositions: [] },
    error: code,
  };
}

/**
 * Canonicalize untrusted provider rows before they can participate in source
 * coverage or consensus. Duplicate normalized name+position identities reject
 * the whole source because the live matcher uses that same identity boundary.
 */
export function canonicalizeIntelligenceSource(source: IntelligenceSource): IntelligenceSource {
  if (source.status !== "ok") return providerSourceError(source, source.error || `${source.id.toUpperCase()}_SOURCE_ERROR`);
  const canonicalPlayers: IntelligencePlayer[] = [];
  const identities = new Set<string>();
  for (const rawPlayer of Array.isArray(source.players) ? source.players : []) {
    const player = canonicalProviderPlayer(rawPlayer);
    if (!player) continue;
    const identity = `${normalizePlayerName(player.name)}|${player.pos}`;
    if (identities.has(identity)) {
      return providerSourceError(source, `${source.id.toUpperCase()}_DUPLICATE_PLAYER_IDENTITY`);
    }
    identities.add(identity);
    canonicalPlayers.push(player);
  }
  canonicalPlayers.sort((left, right) => (
    Number(left.rank ?? left.adp) - Number(right.rank ?? right.adp)
    || left.pos.localeCompare(right.pos)
    || normalizePlayerName(left.name).localeCompare(normalizePlayerName(right.name))
    || left.team.localeCompare(right.team)
  ));
  const corePositions = [...new Set(canonicalPlayers.map((player) => player.pos))]
    .filter((position) => CORE_PROVIDER_POSITIONS.includes(position as (typeof CORE_PROVIDER_POSITIONS)[number]))
    .sort();
  const coverage = { players: canonicalPlayers.length, corePositions };
  if (source.coverage !== undefined) {
    const declaredPositions = [...new Set((source.coverage.corePositions || []).map((position) => String(position).toUpperCase()))]
      .sort();
    if (Number(source.coverage.players) !== coverage.players
      || declaredPositions.length !== coverage.corePositions.length
      || declaredPositions.some((position, index) => position !== coverage.corePositions[index])) {
      return providerSourceError(source, `${source.id.toUpperCase()}_COVERAGE_METADATA_MISMATCH`);
    }
  }
  if (coverage.players < MIN_CANONICAL_PROVIDER_ROWS) {
    return providerSourceError(source, `${source.id.toUpperCase()}_CANONICAL_COVERAGE_TOO_SMALL`);
  }
  if (!CORE_PROVIDER_POSITIONS.every((position) => coverage.corePositions.includes(position))) {
    return providerSourceError(source, `${source.id.toUpperCase()}_CORE_POSITION_COVERAGE_INCOMPLETE`);
  }
  return { ...source, players: canonicalPlayers, coverage, error: undefined };
}

export function validateProviderTimestamp(
  value: unknown,
  referenceAt: string | number = Date.now(),
  source = "SOURCE",
) {
  const label = String(source || "SOURCE").trim().toUpperCase().replace(/[^A-Z0-9]+/g, "_");
  const timestamp = typeof value === "string" ? value.trim() : "";
  if (!timestamp) throw new Error(`${label}_PROVIDER_TIMESTAMP_REQUIRED`);
  const timestampMs = Date.parse(timestamp);
  const referenceMs = typeof referenceAt === "number" ? referenceAt : Date.parse(referenceAt);
  if (!Number.isFinite(timestampMs) || !Number.isFinite(referenceMs)) {
    throw new Error(`${label}_PROVIDER_TIMESTAMP_INVALID`);
  }
  if (timestampMs > referenceMs + PROVIDER_MAX_FUTURE_SKEW_MS) {
    throw new Error(`${label}_PROVIDER_TIMESTAMP_FUTURE`);
  }
  if (referenceMs - timestampMs > PROVIDER_MAX_AGE_MS) {
    throw new Error(`${label}_PROVIDER_TIMESTAMP_STALE`);
  }
  return new Date(timestampMs).toISOString();
}

async function fetchJson(url: string, init?: RequestInit, timeoutMs = 8000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      ...init,
      signal: controller.signal,
      headers: { Accept: "application/json", "User-Agent": "DraftForge/0.1", ...(init?.headers || {}) },
    });
    if (!response.ok) {
      const retryAfter = response.headers.get("retry-after");
      const detail = (await response.text()).replace(/\s+/g, " ").trim().slice(0, 160);
      throw new Error(`HTTP ${response.status}${retryAfter ? ` retry-after=${retryAfter}` : ""}${detail ? `: ${detail}` : ""}`);
    }
    return await response.json();
  } finally {
    clearTimeout(timeout);
  }
}

export async function fetchSourcePayloadsSequentially<T>(requests: Array<() => Promise<T>>, delayMs = 0) {
  const payloads: T[] = [];
  for (let index = 0; index < requests.length; index += 1) {
    if (index > 0 && delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
    payloads.push(await requests[index]());
  }
  return payloads;
}

export function createRateLimitedSourceFetcher<T>(
  request: (url: string) => Promise<T>,
  minIntervalMs = 1000,
  retryDelayMs = 2000,
  { maxPending = 16, queueName = "SOURCE" }: { maxPending?: number; queueName?: string } = {},
) {
  if (!Number.isSafeInteger(maxPending) || maxPending < 1 || maxPending > 1_000) {
    throw new Error("SOURCE_QUEUE_BOUND_INVALID");
  }
  let tail: Promise<unknown> = Promise.resolve();
  let lastStartedAt = 0;
  let pending = 0;
  let active = 0;
  const normalizedQueueName = String(queueName || "SOURCE").trim().toUpperCase().replace(/[^A-Z0-9]+/g, "_") || "SOURCE";
  const fetchQueued = (url: string) => {
    if (pending >= maxPending) {
      return Promise.reject(new Error(`${normalizedQueueName}_SOURCE_QUEUE_FULL`));
    }
    pending += 1;
    const run = async () => {
      const waitMs = Math.max(0, minIntervalMs - (Date.now() - lastStartedAt));
      if (waitMs > 0) await new Promise((resolve) => setTimeout(resolve, waitMs));
      lastStartedAt = Date.now();
      active += 1;
      try {
        try {
          return await request(url);
        } catch (error) {
          if (!(error instanceof Error) || !error.message.startsWith("HTTP 429")) throw error;
          await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
          lastStartedAt = Date.now();
          return await request(url);
        }
      } finally {
        active -= 1;
      }
    };
    const scheduled = tail.then(run, run);
    const result = scheduled.finally(() => {
      pending -= 1;
    });
    tail = result.then(() => undefined, () => undefined);
    return result;
  };
  fetchQueued.stats = () => ({ pending, active, maxPending });
  return fetchQueued;
}

const fetchMflJson = createRateLimitedSourceFetcher(
  (url: string) => fetchJson(url),
  10000,
  12000,
  { maxPending: 12, queueName: "MFL" },
);

async function fetchMflEndpoint(label: string, url: string) {
  try {
    return await fetchMflJson(url);
  } catch (error) {
    throw new Error(`${label}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function failed(id: keyof typeof SOURCE_INFO, error: unknown, retrievedAt: string): IntelligenceSource {
  const info = SOURCE_INFO[id];
  return {
    id,
    ...info,
    status: "error",
    updatedAt: null,
    retrievedAt,
    players: [],
    error: error instanceof Error ? error.message : String(error),
  };
}

async function fetchFfc(scoring: string, teams: number, season: number): Promise<IntelligenceSource> {
  const retrievedAt = new Date().toISOString();
  try {
    const format = scoring === "PPR" ? "ppr" : scoring === "Half PPR" ? "half-ppr" : "standard";
    const data = await fetchJson(`https://fantasyfootballcalculator.com/api/v1/adp/${format}?teams=${teams}&year=${season}`);
    const updatedAt = validateProviderTimestamp(data.meta?.end_date, retrievedAt, "FFC");
    return {
      id: "ffc",
      ...SOURCE_INFO.ffc,
      status: "ok",
      updatedAt,
      retrievedAt,
      sampleSize: Number(data.meta?.total_drafts || 0),
      players: (data.players || []).map((player: Record<string, unknown>) => ({
        name: String(player.name || ""), team: String(player.team || ""), pos: String(player.position || ""),
        rank: Number(player.adp), adp: Number(player.adp),
      })),
    };
  } catch (error) {
    return failed("ffc", error, retrievedAt);
  }
}

type TradyrPayload = {
  data?: Record<string, unknown>[];
  meta?: {
    generatedAt?: string;
    format?: string;
    total?: number;
    limit?: number;
    offset?: number;
    numQbs?: number;
    access?: {
      limited?: boolean;
      offsetIgnored?: boolean;
      returned?: number;
      total?: number;
    };
  };
};

const TRADYR_UNKEYED_ROW_CAP = 50;
const TRADYR_BULK_ROW_LIMIT = 1000;

export async function fetchTradyrRedraftPages(
  request: (url: string, init?: RequestInit) => Promise<TradyrPayload> = (url, init) => fetchJson(url, init, 15000),
  retryDelayMs = 250,
  numQbs: 1 | 2 = 1,
  apiKey = process.env.TRADYR_API_KEY,
) {
  const credential = String(apiKey || "").trim();
  if (!credential) throw new Error("TRADYR_API_KEY_REQUIRED");
  if (numQbs !== 1 && numQbs !== 2) throw new Error("TRADYR_QB_PROFILE_INVALID");
  const init = { headers: { Authorization: `Bearer ${credential}` } };

  // A keyed request can return the entire current redraft board in one
  // response. Do not paginate across independently generated snapshots: the
  // single bounded bulk response is the atomic source truth we authorize.
  const url = `https://api.tradyr.app/v1/players?format=redraft&numQbs=${numQbs}&limit=${TRADYR_BULK_ROW_LIMIT}&offset=0`;
  let payload: TradyrPayload;
  try {
    payload = await request(url, init);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!/(abort|timeout|timed out|fetch failed|ECONNRESET|ETIMEDOUT)/i.test(message)) throw error;
    if (retryDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
    payload = await request(url, init);
  }

  const meta = payload?.meta;
  if (!meta || typeof meta !== "object" || Array.isArray(meta)) throw new Error("TRADYR_META_INVALID");
  const access = meta.access;
  if (access !== undefined && (!access || typeof access !== "object" || Array.isArray(access))) {
    throw new Error("TRADYR_ACCESS_INVALID");
  }
  if (access?.limited !== undefined && access.limited !== false) {
    throw new Error("TRADYR_ACCESS_LIMITED");
  }
  if (access?.offsetIgnored !== undefined && access.offsetIgnored !== false) {
    throw new Error("TRADYR_OFFSET_IGNORED");
  }
  if (meta.format !== "redraft") throw new Error("TRADYR_FORMAT_MISMATCH");
  if (meta.numQbs !== numQbs) throw new Error("TRADYR_QB_PROFILE_MISMATCH");
  if (meta.limit !== TRADYR_BULK_ROW_LIMIT) throw new Error("TRADYR_LIMIT_MISMATCH");
  if (meta.offset !== 0) throw new Error("TRADYR_OFFSET_MISMATCH");
  const expectedTotal = meta.total;
  if (typeof expectedTotal !== "number"
    || !Number.isSafeInteger(expectedTotal)
    || expectedTotal < 0
    || expectedTotal > TRADYR_BULK_ROW_LIMIT) {
    throw new Error("TRADYR_TOTAL_INVALID");
  }
  // A credential in the request is not proof that the provider honored it.
  // Tradyr documents 50 rows as the unkeyed response cap, so only a larger
  // declared board proves that this response came from the keyed contract.
  if (expectedTotal <= TRADYR_UNKEYED_ROW_CAP) throw new Error("TRADYR_FULL_ACCESS_UNPROVEN");
  const generatedAt = validateProviderTimestamp(meta.generatedAt, Date.now(), "TRADYR");
  const players = Array.isArray(payload.data) ? payload.data : [];
  if (players.length !== expectedTotal) throw new Error("TRADYR_BULK_COUNT_MISMATCH");
  if (access?.returned !== undefined && access.returned !== players.length) {
    throw new Error("TRADYR_ACCESS_RETURNED_MISMATCH");
  }
  if (access?.total !== undefined && access.total !== expectedTotal) {
    throw new Error("TRADYR_ACCESS_TOTAL_MISMATCH");
  }

  const slugs = new Set<string>();
  const identities = new Set<string>();
  for (const player of players) {
    const slug = String(player?.slug || "").trim().toLowerCase();
    const normalizedName = normalizePlayerName(String(player?.name || "").trim());
    const position = canonicalProviderPosition(player?.position);
    if (!slug || !normalizedName || !position) throw new Error("TRADYR_PLAYER_IDENTITY_INVALID");
    const identity = `${normalizedName}|${position}`;
    if (slugs.has(slug) || identities.has(identity)) throw new Error("TRADYR_DUPLICATE_PLAYER_IDENTITY");
    slugs.add(slug);
    identities.add(identity);
  }

  return { players, generatedAt, expectedTotal };
}

async function fetchTradyr(numQbs: 1 | 2): Promise<IntelligenceSource> {
  const retrievedAt = new Date().toISOString();
  try {
    const payload = await fetchTradyrRedraftPages(undefined, 250, numQbs);
    return {
      id: "tradyr",
      ...SOURCE_INFO.tradyr,
      status: "ok",
      updatedAt: payload.generatedAt,
      retrievedAt,
      players: payload.players.map((player: Record<string, unknown>) => ({
        name: String(player.name || ""), team: String(player.team || ""), pos: String(player.position || ""),
        rank: Number(player.rank), sourceScore: Number(player.composite),
      })),
    };
  } catch (error) {
    return failed("tradyr", error, retrievedAt);
  }
}

async function fetchGng(scoring: string): Promise<IntelligenceSource> {
  const retrievedAt = new Date().toISOString();
  try {
    const profile = scoring === "PPR" ? "ppr" : scoring === "Half PPR" ? "half_ppr" : "standard";
    const payload = await fetchJson(`https://www.thegng.us/api/rankings.json?profile=${profile}`);
    const updatedAt = validateProviderTimestamp(payload.generated_at, retrievedAt, "GNG");
    return {
      id: "gng",
      ...SOURCE_INFO.gng,
      status: "ok",
      updatedAt,
      retrievedAt,
      players: (payload.players || []).map((player: Record<string, unknown>) => ({
        name: String(player.player || ""), team: String(player.team || ""), pos: String(player.position || ""),
        rank: Number(player.rank), projectedPpg: Number(player.projected_ppg), sourceScore: Number(player.score),
      })),
    };
  } catch (error) {
    return failed("gng", error, retrievedAt);
  }
}

function mflName(value: string, position: string) {
  if (position === "Def" && value.includes(",")) return `${value.split(",")[0]} D/ST`;
  const [last, first] = value.split(",").map((part) => part.trim());
  return first ? `${first} ${last}` : value;
}

export async function fetchMfl(
  teams: number,
  scoring: string,
  season: number,
  request: typeof fetchMflEndpoint = fetchMflEndpoint,
): Promise<IntelligenceSource> {
  const retrievedAt = new Date().toISOString();
  try {
    const base = `https://api.myfantasyleague.com/${season}/export?JSON=1`;
    const ppr = scoring === "PPR" || scoring === "Half PPR" ? 1 : 0;
    // MFL rate-limits simultaneous export requests from one client. These
    // three payloads refresh off-clock, so fetch them sequentially rather than
    // turning a healthy fifth source into an avoidable HTTP 429.
    const [playersPayload, adpPayload, aavPayload] = await fetchSourcePayloadsSequentially([
      // Name, team, and position are all available in the lighter public
      // player directory. Avoid the much larger DETAILS=1 payload, which MFL
      // throttles aggressively in edge-compatible runtimes.
      () => request("players", `${base}&TYPE=players&DETAILS=0`),
      () => request("adp", `${base}&TYPE=adp&FRANCHISES=${teams}&IS_PPR=${ppr}&IS_MOCK=0&IS_KEEPER=0&DAYS=30`),
      () => request("aav", `${base}&TYPE=aav&FRANCHISES=${teams}`),
    ]);
    const details = new Map((playersPayload.players?.player || []).map((player: Record<string, unknown>) => [String(player.id), player]));
    const auctions = new Map((aavPayload.aav?.player || []).map((player: Record<string, unknown>) => [String(player.id), Number(player.averageValue || 0)]));
    const players = (adpPayload.adp?.player || []).map((market: Record<string, unknown>) => {
      const detail = details.get(String(market.id)) as Record<string, unknown> | undefined;
      const rawPos = String(detail?.position || "");
      return {
        name: mflName(String(detail?.name || ""), rawPos), team: String(detail?.team || ""),
        pos: rawPos === "Def" ? "DST" : rawPos, rank: Number(market.rank),
        adp: Number(market.averagePick), auction: Number(auctions.get(String(market.id)) || 0),
      };
    }).filter((player: IntelligencePlayer) => player.name && ["QB", "RB", "WR", "TE", "PK", "DST"].includes(player.pos))
      .map((player: IntelligencePlayer) => ({ ...player, pos: player.pos === "PK" ? "K" : player.pos }));
    // MFL's rolling ADP/AAV exports do not publish a provider-authored update
    // timestamp. Preserve the successful query receipt separately instead of
    // claiming the provider updated its underlying data at retrieval time.
    return { id: "mfl", ...SOURCE_INFO.mfl, status: "ok", updatedAt: null, retrievedAt, players };
  } catch (error) {
    return failed("mfl", error, retrievedAt);
  }
}

type IntelligenceRequestInput = Partial<Record<keyof IntelligenceRequest, unknown>>;

function canonicalProfileInteger(value: unknown, fallback: number, minimum: number, maximum: number, field: string) {
  const candidate = value === undefined || value === null || value === ""
    ? fallback
    : typeof value === "string" && /^(0|[1-9]\d*)$/.test(value)
      ? Number(value)
      : value;
  if (!Number.isSafeInteger(candidate) || Number(candidate) < minimum || Number(candidate) > maximum) {
    throw new Error(`INTELLIGENCE_PROFILE_${field}_INVALID`);
  }
  return Number(candidate);
}

export function normalizeIntelligenceRequest(input: IntelligenceRequestInput = {}): IntelligenceRequest {
  const scoring = input.scoring === undefined || input.scoring === null || input.scoring === ""
    ? "PPR"
    : String(input.scoring);
  if (!["PPR", "Half PPR", "Standard"].includes(scoring)) {
    throw new Error("INTELLIGENCE_PROFILE_SCORING_INVALID");
  }
  const qbs = canonicalProfileInteger(input.qbs, 1, 1, 2, "QBS");
  return {
    scoring,
    teams: canonicalProfileInteger(input.teams, 12, 8, 16, "TEAMS"),
    season: canonicalProfileInteger(input.season, 2026, 2026, 2027, "SEASON"),
    qbs: qbs as 1 | 2,
  };
}

const SUCCESSFUL_SNAPSHOT_CACHE_MS = 4 * 60 * 1000;
const FAILED_SNAPSHOT_CACHE_MS = 15 * 1000;
export const MAX_INTELLIGENCE_SNAPSHOT_CACHE_ENTRIES = 32;

type IntelligenceSnapshotCacheEntry<T> = { expiresAt: number; promise: Promise<T> };

export function createBoundedIntelligenceSnapshotCache<T>({
  maxEntries = MAX_INTELLIGENCE_SNAPSHOT_CACHE_ENTRIES,
  now = Date.now,
}: { maxEntries?: number; now?: () => number } = {}) {
  if (!Number.isSafeInteger(maxEntries) || maxEntries < 1 || maxEntries > 1_000) {
    throw new Error("INTELLIGENCE_CACHE_BOUND_INVALID");
  }
  const entries = new Map<string, IntelligenceSnapshotCacheEntry<T>>();
  const pruneExpired = () => {
    const current = now();
    for (const [key, entry] of entries) {
      if (entry.expiresAt <= current) entries.delete(key);
    }
  };
  return {
    get(key: string) {
      pruneExpired();
      const entry = entries.get(key);
      if (!entry) return undefined;
      entries.delete(key);
      entries.set(key, entry);
      return entry;
    },
    set(key: string, entry: IntelligenceSnapshotCacheEntry<T>) {
      pruneExpired();
      entries.delete(key);
      while (entries.size >= maxEntries) {
        const oldest = entries.keys().next().value as string | undefined;
        if (oldest === undefined) break;
        entries.delete(oldest);
      }
      entries.set(key, entry);
    },
    deleteIfSame(key: string, entry: IntelligenceSnapshotCacheEntry<T>) {
      if (entries.get(key) === entry) entries.delete(key);
    },
    clear() {
      entries.clear();
    },
    stats() {
      pruneExpired();
      return { entries: entries.size, maxEntries };
    },
  };
}

const intelligenceSnapshotCache = createBoundedIntelligenceSnapshotCache<IntelligenceResponse>();

export function clearIntelligenceSnapshotCache() {
  intelligenceSnapshotCache.clear();
}

export function intelligenceResourceUsage() {
  return {
    cache: intelligenceSnapshotCache.stats(),
    mflQueue: fetchMflJson.stats(),
  };
}

export async function fetchIntelligenceSnapshot(input: IntelligenceRequestInput = {}): Promise<IntelligenceResponse> {
  const request = normalizeIntelligenceRequest(input);
  const cacheKey = `${request.season}:${request.teams}:${request.scoring}:${request.qbs}qb`;
  const cached = intelligenceSnapshotCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.promise;

  const entry = {
    expiresAt: Date.now() + FAILED_SNAPSHOT_CACHE_MS,
    promise: Promise.resolve(null as unknown as IntelligenceResponse),
  };
  entry.promise = (async () => {
    const fetchedSources = await Promise.all([
      fetchFfc(request.scoring, request.teams, request.season),
      fetchMfl(request.teams, request.scoring, request.season),
      fetchTradyr(request.qbs),
      fetchGng(request.scoring),
    ]);
    const sources = fetchedSources.map(canonicalizeIntelligenceSource);
    entry.expiresAt = Date.now() + (sources.every((source) => source.status === "ok")
      ? SUCCESSFUL_SNAPSHOT_CACHE_MS
      : FAILED_SNAPSHOT_CACHE_MS);
    const snapshot = {
      generatedAt: new Date().toISOString(),
      ...request,
      sources,
      methodology: {
        weights: { espn: .30, gng: .20, tradyr: .20, ffc: .15, mfl: .15 },
        method: "freshness-gated weighted percentile consensus",
      },
    };
    return {
      ...snapshot,
      sourceSnapshotId: await intelligenceSourceSnapshotId(snapshot),
    };
  })();
  intelligenceSnapshotCache.set(cacheKey, entry);
  entry.promise.catch(() => {
    intelligenceSnapshotCache.deleteIfSame(cacheKey, entry);
  });
  return entry.promise;
}
