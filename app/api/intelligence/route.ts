import { fetchIntelligenceSnapshot } from "../../lib/intelligence-sources";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const snapshot = await fetchIntelligenceSnapshot({
    scoring: url.searchParams.get("scoring") || undefined,
    teams: Number(url.searchParams.get("teams") || 12),
    season: Number(url.searchParams.get("season") || 2026),
    qbs: Number(url.searchParams.get("qbs") || 1) >= 2 ? 2 : 1,
  });
  return Response.json(snapshot, {
    headers: { "Cache-Control": "public, max-age=900, s-maxage=21600, stale-while-revalidate=86400" },
  });
}
