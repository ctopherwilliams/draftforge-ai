import authenticatedEspnLeagues from "../../config/authenticated-espn-leagues.json" with { type: "json" };

type SelectedKeeper = { espnPlayerId: number; position: string; amount: number };
type KeeperRosterEntry = { playerId: number; position: string; amount: number };

/** Shared by the operator checklist and the external draft-day readiness gate. */
export function exactSelectedKeepersReady(
  selectedKeepers: readonly SelectedKeeper[],
  keeperCount: number,
  roster: readonly KeeperRosterEntry[],
) {
  return selectedKeepers.length <= keeperCount
    && new Set(selectedKeepers.map((keeper) => keeper.espnPlayerId)).size === selectedKeepers.length
    && selectedKeepers.every((keeper) => Number.isSafeInteger(keeper.espnPlayerId)
      && keeper.espnPlayerId > 0 && Number.isSafeInteger(keeper.amount) && keeper.amount >= 0
      && roster.filter((entry) => entry.playerId === keeper.espnPlayerId).length === 1
      && roster.some((entry) => entry.playerId === keeper.espnPlayerId
        && entry.position === keeper.position && entry.amount === keeper.amount));
}

export function pinnedKeeperPicksReady(
  league: { id: string; teamId: number | null; season: number; draftType: string; keeperCount: number },
  picks: readonly { playerId: number; teamId: number; amount: number }[],
  players: readonly { id: number; pos: string }[],
) {
  // Scope the event by identity, not mutable imported rules. A wrong keeper
  // count/type for this exact team must block, not silently disable its gate.
  const profile = Object.values(authenticatedEspnLeagues.profiles).find((candidate) => (
    candidate.id === league.id && candidate.teamId === league.teamId && candidate.season === league.season
  ));
  if (!profile || !("event" in profile)) return true;
  return league.draftType === profile.draftType && league.keeperCount === profile.keeperCount
    && exactSelectedKeepersReady(profile.event.selectedKeepers, league.keeperCount,
      picks.filter((pick) => pick.teamId === league.teamId).map((pick) => ({
        playerId: pick.playerId,
        amount: pick.amount,
        position: players.find((player) => player.id === pick.playerId)?.pos || "",
      })));
}
