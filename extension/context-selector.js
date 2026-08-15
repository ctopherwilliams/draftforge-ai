export function selectUniqueEspnContext(contexts, expectedLeagueId) {
  const eligible = (contexts || []).filter((context) => context?.leagueId && Number.isInteger(Number(context?.tabId)));
  if (!expectedLeagueId) {
    return [...eligible]
      .sort((left, right) => Number(right.inDraftRoom) - Number(left.inDraftRoom)
        || Number(right.lastAccessed || 0) - Number(left.lastAccessed || 0))[0] || null;
  }

  const exactLeague = eligible.filter((context) => String(context.leagueId) === String(expectedLeagueId));
  const liveRooms = exactLeague.filter((context) => context.inDraftRoom === true);
  const candidates = liveRooms.length ? liveRooms : exactLeague;
  return candidates.length === 1 ? candidates[0] : null;
}
