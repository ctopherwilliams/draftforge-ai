type EspnLeague = {
  settings?: { name?: string; size?: number };
  teams?: unknown[];
  draftDetail?: { drafted?: boolean; inProgress?: boolean };
};

export async function GET(request: Request) {
  const url = new URL(request.url);
  const leagueId = url.searchParams.get("leagueId")?.trim() ?? "";
  const season = Number(url.searchParams.get("season") ?? new Date().getFullYear());

  if (!/^\d{4,12}$/.test(leagueId) || season < 2025 || season > 2027) {
    return Response.json({ error: "Enter a valid ESPN league ID." }, { status: 400 });
  }

  const endpoint = new URL(`https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/${season}/segments/0/leagues/${leagueId}`);
  endpoint.searchParams.append("view", "mSettings");
  endpoint.searchParams.append("view", "mTeam");
  endpoint.searchParams.append("view", "mDraftDetail");

  try {
    const response = await fetch(endpoint, {
      headers: { Accept: "application/json", "User-Agent": "DraftForge/0.1" },
    });
    if (response.status === 401 || response.status === 403) {
      return Response.json({ error: "This ESPN league is private." }, { status: response.status });
    }
    if (!response.ok) {
      return Response.json({ error: "ESPN could not find that league." }, { status: response.status === 404 ? 404 : 502 });
    }

    const league = await response.json() as EspnLeague;
    return Response.json({
      id: leagueId,
      name: league.settings?.name ?? "My ESPN League",
      teams: league.settings?.size ?? league.teams?.length ?? 12,
      draft: league.draftDetail ?? null,
      season,
    });
  } catch {
    return Response.json({ error: "ESPN is temporarily unavailable." }, { status: 502 });
  }
}
