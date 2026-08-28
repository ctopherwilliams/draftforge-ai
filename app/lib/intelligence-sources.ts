import type { IntelligencePlayer, IntelligenceSource } from "./consensus";

export type IntelligenceRequest = {
  scoring: string;
  teams: number;
  season: number;
  qbs: 1 | 2;
};

export type IntelligenceResponse = IntelligenceRequest & {
  generatedAt: string;
  sources: IntelligenceSource[];
  methodology: {
    weights: Record<"espn" | "gng" | "tradyr" | "ffc" | "mfl", number>;
    method: string;
  };
};

const SOURCE_INFO = {
  ffc: { name: "Fantasy Football Calculator", kind: "market" as const, weight: .15, attribution: "Fantasy Football Calculator", url: "https://fantasyfootballcalculator.com" },
  mfl: { name: "MyFantasyLeague", kind: "market" as const, weight: .15, attribution: "MyFantasyLeague", url: "https://www.myfantasyleague.com" },
  tradyr: { name: "Tradyr", kind: "composite" as const, weight: .20, attribution: "Powered by Tradyr", url: "https://tradyr.app" },
  gng: { name: "The GNG Pigskin Rankings", kind: "model" as const, weight: .20, attribution: "The GNG rankings", url: "https://www.thegng.us/ranks" },
};

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
) {
  let tail: Promise<unknown> = Promise.resolve();
  let lastStartedAt = 0;
  return (url: string) => {
    const run = async () => {
      const waitMs = Math.max(0, minIntervalMs - (Date.now() - lastStartedAt));
      if (waitMs > 0) await new Promise((resolve) => setTimeout(resolve, waitMs));
      lastStartedAt = Date.now();
      try {
        return await request(url);
      } catch (error) {
        if (!(error instanceof Error) || !error.message.startsWith("HTTP 429")) throw error;
        await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
        lastStartedAt = Date.now();
        return request(url);
      }
    };
    const scheduled = tail.then(run, run);
    tail = scheduled.then(() => undefined, () => undefined);
    return scheduled;
  };
}

const fetchMflJson = createRateLimitedSourceFetcher((url: string) => fetchJson(url), 10000, 12000);

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
    return {
      id: "ffc",
      ...SOURCE_INFO.ffc,
      status: "ok",
      updatedAt: data.meta?.end_date || null,
      retrievedAt,
      sampleSize: Number(data.meta?.total_drafts || 0),
      players: (data.players || []).map((player: Record<string, unknown>) => ({
        name: String(player.name || ""), team: String(player.team || ""), pos: String(player.position || ""),
        rank: Number(player.adp || 999), adp: Number(player.adp || 999),
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
    total?: number;
    offset?: number;
    access?: {
      limited?: boolean;
      offsetIgnored?: boolean;
    };
  };
};

const TRADYR_PAGE_SIZE = 50;
const TRADYR_MAX_PLAYERS = 1000;

export async function fetchTradyrRedraftPages(
  request: (url: string, init?: RequestInit) => Promise<TradyrPayload> = (url, init) => fetchJson(url, init, 15000),
  retryDelayMs = 250,
  numQbs: 1 | 2 = 1,
  apiKey = process.env.TRADYR_API_KEY,
) {
  const credential = String(apiKey || "").trim();
  if (!credential) throw new Error("TRADYR_API_KEY_REQUIRED");
  const players: Record<string, unknown>[] = [];
  const identities = new Set<string>();
  let generatedAt: string | null = null;
  let expectedTotal = TRADYR_PAGE_SIZE;
  let declaredTotal: number | null = null;
  const init = { headers: { Authorization: `Bearer ${credential}` } };

  for (let offset = 0; offset < Math.min(expectedTotal, TRADYR_MAX_PLAYERS); offset += TRADYR_PAGE_SIZE) {
    const url = `https://api.tradyr.app/v1/players?format=redraft&numQbs=${numQbs}&limit=${TRADYR_PAGE_SIZE}&offset=${offset}`;
    let payload: TradyrPayload;
    try {
      payload = await request(url, init);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!/(abort|timeout|timed out|fetch failed|ECONNRESET|ETIMEDOUT)/i.test(message)) throw error;
      if (retryDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
      payload = await request(url, init);
    }
    const page = Array.isArray(payload.data) ? payload.data : [];
    if (payload.meta?.access?.limited === true) throw new Error("TRADYR_ACCESS_LIMITED");
    if (payload.meta?.access?.offsetIgnored === true) throw new Error("TRADYR_OFFSET_IGNORED");
    if (payload.meta?.offset !== undefined && Number(payload.meta.offset) !== offset) {
      throw new Error("TRADYR_OFFSET_MISMATCH");
    }
    if (!generatedAt && payload.meta?.generatedAt) generatedAt = payload.meta.generatedAt;
    const total = Number(payload.meta?.total);
    if (!Number.isSafeInteger(total) || total < 0 || total > TRADYR_MAX_PLAYERS) {
      throw new Error("TRADYR_TOTAL_INVALID");
    }
    if (declaredTotal !== null && total !== declaredTotal) throw new Error("TRADYR_TOTAL_CHANGED");
    declaredTotal = total;
    expectedTotal = total;
    for (const player of page) {
      const identity = `${String(player.slug || player.name || "").trim().toLowerCase()}|${String(player.position || "")}`;
      if (identity === "|") throw new Error("TRADYR_PLAYER_IDENTITY_INVALID");
      if (identities.has(identity)) throw new Error("TRADYR_DUPLICATE_PAGE");
      identities.add(identity);
      players.push(player);
    }
    if (page.length < TRADYR_PAGE_SIZE) break;
  }

  if (players.length !== expectedTotal) throw new Error("TRADYR_INCOMPLETE_PAGINATION");
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
        rank: Number(player.rank || 999), sourceScore: Number(player.composite || 0),
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
    return {
      id: "gng",
      ...SOURCE_INFO.gng,
      status: "ok",
      updatedAt: payload.generated_at || null,
      retrievedAt,
      players: (payload.players || []).map((player: Record<string, unknown>) => ({
        name: String(player.player || ""), team: String(player.team || ""), pos: String(player.position || ""),
        rank: Number(player.rank || 999), projectedPpg: Number(player.projected_ppg || 0), sourceScore: Number(player.score || 0),
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

async function fetchMfl(teams: number, scoring: string, season: number): Promise<IntelligenceSource> {
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
      () => fetchMflEndpoint("players", `${base}&TYPE=players&DETAILS=0`),
      () => fetchMflEndpoint("adp", `${base}&TYPE=adp&FRANCHISES=${teams}&IS_PPR=${ppr}&IS_MOCK=0&IS_KEEPER=0&DAYS=30`),
      () => fetchMflEndpoint("aav", `${base}&TYPE=aav&FRANCHISES=${teams}`),
    ]);
    const details = new Map((playersPayload.players?.player || []).map((player: Record<string, unknown>) => [String(player.id), player]));
    const auctions = new Map((aavPayload.aav?.player || []).map((player: Record<string, unknown>) => [String(player.id), Number(player.averageValue || 0)]));
    const players = (adpPayload.adp?.player || []).map((market: Record<string, unknown>) => {
      const detail = details.get(String(market.id)) as Record<string, unknown> | undefined;
      const rawPos = String(detail?.position || "");
      return {
        name: mflName(String(detail?.name || ""), rawPos), team: String(detail?.team || ""),
        pos: rawPos === "Def" ? "DST" : rawPos, rank: Number(market.rank || 999),
        adp: Number(market.averagePick || 999), auction: Number(auctions.get(String(market.id)) || 0),
      };
    }).filter((player: IntelligencePlayer) => player.name && ["QB", "RB", "WR", "TE", "PK", "DST"].includes(player.pos))
      .map((player: IntelligencePlayer) => ({ ...player, pos: player.pos === "PK" ? "K" : player.pos }));
    return { id: "mfl", ...SOURCE_INFO.mfl, status: "ok", updatedAt: retrievedAt, retrievedAt, players };
  } catch (error) {
    return failed("mfl", error, retrievedAt);
  }
}

export function normalizeIntelligenceRequest(input: Partial<IntelligenceRequest>): IntelligenceRequest {
  const scoring = ["PPR", "Half PPR", "Standard"].includes(String(input.scoring || "")) ? String(input.scoring) : "PPR";
  return {
    scoring,
    teams: Math.max(8, Math.min(16, Number(input.teams || 12))),
    season: Math.max(2026, Math.min(2027, Number(input.season || 2026))),
    qbs: Number(input.qbs) >= 2 ? 2 : 1,
  };
}

const SUCCESSFUL_SNAPSHOT_CACHE_MS = 4 * 60 * 1000;
const FAILED_SNAPSHOT_CACHE_MS = 15 * 1000;
const intelligenceSnapshotCache = new Map<string, { expiresAt: number; promise: Promise<IntelligenceResponse> }>();

export function clearIntelligenceSnapshotCache() {
  intelligenceSnapshotCache.clear();
}

export async function fetchIntelligenceSnapshot(input: Partial<IntelligenceRequest> = {}): Promise<IntelligenceResponse> {
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
    const sources = fetchedSources.map((source) => ({
      ...source,
      coverage: {
        players: source.players.length,
        corePositions: [...new Set(source.players.map((player) => String(player.pos || "").toUpperCase()))]
          .filter((position) => ["QB", "RB", "WR", "TE"].includes(position))
          .sort(),
      },
    }));
    entry.expiresAt = Date.now() + (sources.every((source) => source.status === "ok")
      ? SUCCESSFUL_SNAPSHOT_CACHE_MS
      : FAILED_SNAPSHOT_CACHE_MS);
    return {
      generatedAt: new Date().toISOString(),
      ...request,
      sources,
      methodology: {
        weights: { espn: .30, gng: .20, tradyr: .20, ffc: .15, mfl: .15 },
        method: "freshness-gated weighted percentile consensus",
      },
    };
  })();
  intelligenceSnapshotCache.set(cacheKey, entry);
  entry.promise.catch(() => {
    if (intelligenceSnapshotCache.get(cacheKey) === entry) intelligenceSnapshotCache.delete(cacheKey);
  });
  return entry.promise;
}
