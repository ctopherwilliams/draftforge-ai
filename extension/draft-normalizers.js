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
