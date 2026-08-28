import { fetchIntelligenceSnapshot, normalizeIntelligenceRequest } from "../../lib/intelligence-sources.ts";

export async function GET(request: Request) {
  const url = new URL(request.url);
  if (["scoring", "teams", "season", "qbs"].some((key) => url.searchParams.getAll(key).length > 1)) {
    return Response.json({ ok: false, code: "INTELLIGENCE_PROFILE_INVALID" }, {
      status: 400,
      headers: { "Cache-Control": "no-store" },
    });
  }
  try {
    const profile = normalizeIntelligenceRequest({
      scoring: url.searchParams.get("scoring") ?? undefined,
      teams: url.searchParams.get("teams") ?? undefined,
      season: url.searchParams.get("season") ?? undefined,
      qbs: url.searchParams.get("qbs") ?? undefined,
    });
    const snapshot = await fetchIntelligenceSnapshot(profile);
    return Response.json(snapshot, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("INTELLIGENCE_PROFILE_")) {
      return Response.json({ ok: false, code: error.message }, {
        status: 400,
        headers: { "Cache-Control": "no-store" },
      });
    }
    throw error;
  }
}
