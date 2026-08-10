type FeedPlayer = { name: string; team: string; pos: string; rank?: number; adp?: number; auction?: number; projectedPpg?: number; sourceScore?: number };
type SourceResult = {
  id: "ffc" | "mfl" | "tradyr" | "gng";
  name: string;
  kind: "market" | "model" | "composite";
  weight: number;
  status: "ok" | "error";
  updatedAt: string | null;
  attribution: string;
  url: string;
  players: FeedPlayer[];
  sampleSize?: number;
  error?: string;
};

const SOURCE_INFO = {
  ffc: { name: "Fantasy Football Calculator", kind: "market" as const, weight: .15, attribution: "Fantasy Football Calculator", url: "https://fantasyfootballcalculator.com" },
  mfl: { name: "MyFantasyLeague", kind: "market" as const, weight: .15, attribution: "MyFantasyLeague", url: "https://www.myfantasyleague.com" },
  tradyr: { name: "Tradyr", kind: "composite" as const, weight: .20, attribution: "Powered by Tradyr", url: "https://tradyr.app" },
  gng: { name: "The GNG Pigskin Rankings", kind: "model" as const, weight: .20, attribution: "The GNG rankings", url: "https://www.thegng.us/ranks" },
};

async function fetchJson(url: string, init?: RequestInit) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal, headers: { Accept: "application/json", "User-Agent": "DraftForge/0.1", ...(init?.headers || {}) } });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.json();
  } finally { clearTimeout(timeout); }
}

function failed(id: keyof typeof SOURCE_INFO, error: unknown): SourceResult {
  const info = SOURCE_INFO[id];
  return { id, ...info, status: "error", updatedAt: null, players: [], error: error instanceof Error ? error.message : String(error) };
}

async function fetchFfc(scoring: string, teams: number, season: number): Promise<SourceResult> {
  try {
    const format = scoring === "PPR" ? "ppr" : scoring === "Half PPR" ? "half-ppr" : "standard";
    const data = await fetchJson(`https://fantasyfootballcalculator.com/api/v1/adp/${format}?teams=${teams}&year=${season}`);
    return { id: "ffc", ...SOURCE_INFO.ffc, status: "ok", updatedAt: data.meta?.end_date || null, sampleSize: Number(data.meta?.total_drafts || 0), players: (data.players || []).map((player: Record<string, unknown>) => ({ name: String(player.name || ""), team: String(player.team || ""), pos: String(player.position || ""), rank: Number(player.adp || 999), adp: Number(player.adp || 999) })) };
  } catch (error) { return failed("ffc", error); }
}

async function fetchTradyr(): Promise<SourceResult> {
  try {
    const payload = await fetchJson("https://api.tradyr.app/v1/rankings/redraft-ppr");
    return { id: "tradyr", ...SOURCE_INFO.tradyr, status: "ok", updatedAt: payload.meta?.generatedAt || null, players: (payload.data || []).map((player: Record<string, unknown>) => ({ name: String(player.name || ""), team: String(player.team || ""), pos: String(player.position || ""), rank: Number(player.rank || 999), sourceScore: Number(player.composite || 0) })) };
  } catch (error) { return failed("tradyr", error); }
}

async function fetchGng(scoring: string): Promise<SourceResult> {
  try {
    const profile = scoring === "PPR" ? "ppr" : scoring === "Half PPR" ? "half_ppr" : "standard";
    const payload = await fetchJson(`https://www.thegng.us/api/rankings.json?profile=${profile}`);
    return { id: "gng", ...SOURCE_INFO.gng, status: "ok", updatedAt: payload.generated_at || null, players: (payload.players || []).map((player: Record<string, unknown>) => ({ name: String(player.player || ""), team: String(player.team || ""), pos: String(player.position || ""), rank: Number(player.rank || 999), projectedPpg: Number(player.projected_ppg || 0), sourceScore: Number(player.score || 0) })) };
  } catch (error) { return failed("gng", error); }
}

function mflName(value: string, position: string) {
  if (position === "Def" && value.includes(",")) return `${value.split(",")[0]} D/ST`;
  const [last, first] = value.split(",").map((part) => part.trim());
  return first ? `${first} ${last}` : value;
}

async function fetchMfl(teams: number, scoring: string, season: number): Promise<SourceResult> {
  try {
    const base = `https://api.myfantasyleague.com/${season}/export?JSON=1`;
    const ppr = scoring === "PPR" || scoring === "Half PPR" ? 1 : 0;
    const [playersPayload, adpPayload, aavPayload] = await Promise.all([
      fetchJson(`${base}&TYPE=players&DETAILS=1`),
      fetchJson(`${base}&TYPE=adp&FRANCHISES=${teams}&IS_PPR=${ppr}&IS_MOCK=0&IS_KEEPER=0&DAYS=30`),
      fetchJson(`${base}&TYPE=aav&FRANCHISES=${teams}`),
    ]);
    const details = new Map((playersPayload.players?.player || []).map((player: Record<string, unknown>) => [String(player.id), player]));
    const auctions = new Map((aavPayload.aav?.player || []).map((player: Record<string, unknown>) => [String(player.id), Number(player.averageValue || 0)]));
    const players = (adpPayload.adp?.player || []).map((market: Record<string, unknown>) => {
      const detail = details.get(String(market.id)) as Record<string, unknown> | undefined;
      const rawPos = String(detail?.position || "");
      return { name: mflName(String(detail?.name || ""), rawPos), team: String(detail?.team || ""), pos: rawPos === "Def" ? "DST" : rawPos, rank: Number(market.rank || 999), adp: Number(market.averagePick || 999), auction: Number(auctions.get(String(market.id)) || 0) };
    }).filter((player: FeedPlayer) => player.name && ["QB", "RB", "WR", "TE", "PK", "DST"].includes(player.pos)).map((player: FeedPlayer) => ({ ...player, pos: player.pos === "PK" ? "K" : player.pos }));
    return { id: "mfl", ...SOURCE_INFO.mfl, status: "ok", updatedAt: new Date().toISOString(), players };
  } catch (error) { return failed("mfl", error); }
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const scoring = ["PPR", "Half PPR", "Standard"].includes(url.searchParams.get("scoring") || "") ? String(url.searchParams.get("scoring")) : "PPR";
  const teams = Math.max(8, Math.min(16, Number(url.searchParams.get("teams") || 12)));
  const season = Math.max(2026, Math.min(2027, Number(url.searchParams.get("season") || 2026)));
  const sources = await Promise.all([fetchFfc(scoring, teams, season), fetchMfl(teams, scoring, season), fetchTradyr(), fetchGng(scoring)]);
  return Response.json({
    generatedAt: new Date().toISOString(),
    scoring,
    teams,
    sources,
    methodology: { weights: { espn: .30, gng: .20, tradyr: .20, ffc: .15, mfl: .15 }, method: "freshness-gated weighted percentile consensus" },
  }, { headers: { "Cache-Control": "public, max-age=900, s-maxage=21600, stale-while-revalidate=86400" } });
}
