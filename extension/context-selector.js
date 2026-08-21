export function selectUniqueEspnContext(contexts, expectedLeagueId) {
  const eligible = (contexts || []).filter((context) => context?.leagueId && Number.isInteger(Number(context?.tabId)));
  if (!expectedLeagueId) {
    return [...eligible]
      .sort((left, right) => Number(right.inDraftRoom) - Number(left.inDraftRoom)
        || Number(right.lastAccessed || 0) - Number(left.lastAccessed || 0))[0] || null;
  }

  const exactLeague = eligible.filter((context) => String(context.leagueId) === String(expectedLeagueId));
  const liveRooms = exactLeague.filter((context) => context.inDraftRoom === true);
  // Two live rooms are actionably ambiguous and must fail closed. Duplicate
  // ordinary league pages are read-only sources, so choose the newest one and
  // bind its exact tab id for every later watch/action check.
  if (liveRooms.length) return liveRooms.length === 1 ? liveRooms[0] : null;
  return [...exactLeague]
    .sort((left, right) => Number(right.lastAccessed || 0) - Number(left.lastAccessed || 0))[0] || null;
}
