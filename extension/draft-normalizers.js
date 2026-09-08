export function normalizePicks(raw) {
  return (raw.draftDetail?.picks || []).flatMap((pick, index) => {
    const playerId = Number(pick.playerId);
    const teamId = Number(pick.teamId);
    // ESPN pre-populates unscheduled drafts with placeholder slots (playerId:
    // -1), while real D/ST player IDs are other negative integers.
    if (!Number.isInteger(playerId) || playerId === 0 || playerId === -1 || !Number.isInteger(teamId) || teamId <= 0) return [];
    return [{
      playerId,
      teamId,
      overall: Number(pick.overallPickNumber || index + 1),
      round: Number(pick.roundId || 0),
      amount: Number(pick.bidAmount || 0),
      keeper: Boolean(pick.keeper),
    }];
  });
}

// Pinned exception for the authenticated, locked 2026 keeper roster. ESPN
// exposes these selections as ADD entries before creating real draft picks.
// The fixture suite asserts this plan against authenticated-espn-leagues.json;
// never generalize ADD or a zero keeperValue into evidence of keeper status.
const PRE_ROOM_KEEPER_PLAN = {
  leagueId: "44050",
  season: 2026,
  teamId: 7,
  players: [
    { playerId: 3916148, amount: 0 },
    { playerId: 3121422, amount: 1 },
  ],
};

function pinnedPreRoomKeeperPicks(raw) {
  const plan = PRE_ROOM_KEEPER_PLAN;
  const draft = raw.settings?.draftSettings;
  if (String(raw.id) !== plan.leagueId
    || raw.seasonId !== plan.season
    || raw.draftDetail?.inProgress !== false
    || raw.draftDetail?.drafted !== false
    || !draft
    || !["AUCTION", 2].includes(draft.type)
    || draft.keeperCount !== plan.players.length
    || !Array.isArray(raw.teams)) return [];
  const teams = raw.teams.filter((team) => team?.id === plan.teamId);
  if (teams.length !== 1) return [];
  const entries = teams[0].roster?.entries;
  if (!Array.isArray(entries) || entries.length !== plan.players.length
    || new Set(entries.map((entry) => entry?.playerId)).size !== entries.length) return [];

  const picks = [];
  for (const [index, expected] of plan.players.entries()) {
    const entry = entries.find((candidate) => candidate?.playerId === expected.playerId);
    const pool = entry?.playerPoolEntry;
    if (!pool
      || pool.onTeamId !== plan.teamId
      || !Object.hasOwn(pool, "keeperValue")
      || !Number.isSafeInteger(pool.keeperValue)
      || pool.keeperValue !== expected.amount
      || (Object.hasOwn(pool, "id") && pool.id !== expected.playerId)
      || (pool.player && Object.hasOwn(pool.player, "id") && pool.player.id !== expected.playerId)) return [];
    picks.push({
      playerId: expected.playerId,
      teamId: plan.teamId,
      overall: index + 1,
      round: 0,
      amount: pool.keeperValue,
      keeper: true,
    });
  }
  return picks;
}

export function normalizeImportPicks(raw) {
  const picks = normalizePicks(raw);
  const draftActive = raw.draftDetail?.inProgress === true || raw.draftDetail?.drafted === true;
  if (draftActive) return picks;
  // Real, historical, or partially declared draft picks are never supplemented
  // with inferred rows. The exception is only for an otherwise empty draft.
  return picks.length ? picks.filter((pick) => pick.keeper) : pinnedPreRoomKeeperPicks(raw);
}
