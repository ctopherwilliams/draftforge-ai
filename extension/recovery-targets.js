const ESPN_ORIGIN = "https://fantasy.espn.com";

function parsedTab(tab) {
  try {
    return { tab, url: new URL(tab?.url || "") };
  } catch {
    return null;
  }
}

/**
 * Resolve the one exact live room and only the stale tabs DraftForge owns.
 * Unrelated ESPN pages, arbitrary browser tabs, and ambiguous rooms are never
 * returned as cleanup targets.
 */
export function selectRecoveryWorkspace(tabs, {
  appTabId,
  draftLeagueId,
  sourceLeagueId,
  teamId,
  season,
  appOrigins,
}) {
  const expectedAppTabId = Number(appTabId);
  const expectedDraftLeagueId = String(draftLeagueId || "");
  const expectedSourceLeagueId = String(sourceLeagueId || "");
  const expectedTeamId = String(teamId || "");
  const expectedSeason = String(season || "");
  if (!Number.isInteger(expectedAppTabId)
    || !/^\d+$/.test(expectedDraftLeagueId)
    || !/^\d+$/.test(expectedSourceLeagueId)
    || !/^\d+$/.test(expectedTeamId)
    || !/^\d{4}$/.test(expectedSeason)) {
    return { ok: false, code: "RECOVERY_TARGET_INVALID" };
  }

  const parsed = (tabs || []).map(parsedTab).filter(Boolean);
  const liveRooms = parsed.filter(({ url }) => (
    url.origin === ESPN_ORIGIN
    && url.pathname === "/football/draft"
    && url.searchParams.get("leagueId") === expectedDraftLeagueId
    && url.searchParams.get("teamId") === expectedTeamId
    && url.searchParams.get("seasonId") === expectedSeason
  ));
  if (liveRooms.length !== 1 || !Number.isInteger(Number(liveRooms[0].tab?.id))) {
    return { ok: false, code: liveRooms.length ? "RECOVERY_ROOM_AMBIGUOUS" : "RECOVERY_ROOM_NOT_FOUND" };
  }

  const staleAppTabIds = parsed
    .filter(({ tab, url }) => Number(tab?.id) !== expectedAppTabId && appOrigins.includes(url.origin))
    .map(({ tab }) => Number(tab.id));
  const sourceLeagueTabIds = parsed
    .filter(({ tab, url }) => (
      Number(tab?.id) !== Number(liveRooms[0].tab.id)
      && url.origin === ESPN_ORIGIN
      && url.pathname !== "/football/draft"
      && url.searchParams.get("leagueId") === expectedSourceLeagueId
      && url.searchParams.get("teamId") === expectedTeamId
      && url.searchParams.get("seasonId") === expectedSeason
    ))
    .map(({ tab }) => Number(tab.id));

  return {
    ok: true,
    roomTabId: Number(liveRooms[0].tab.id),
    staleAppTabIds,
    sourceLeagueTabIds,
  };
}
