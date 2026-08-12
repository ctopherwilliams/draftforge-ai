export function draftTypeFor(value) {
  return String(value || "").trim().toUpperCase() === "AUCTION" || Number(value) === 2 ? "AUCTION" : "SNAKE";
}

export function keeperCountFor(draft, teams = []) {
  const configured = Number(draft?.keeperCount);
  if (Number.isInteger(configured) && configured >= 0) return configured;
  return teams.reduce((sum, team) => sum + (team.roster?.entries || []).filter((entry) => entry.keeperValue || entry.acquisitionType === "KEEPER").length, 0);
}

export function draftableRosterSizeFor(draft, roster) {
  const lineupSlotCounts = roster?.lineupSlotCounts || {};
  const draftableSlots = Object.entries(lineupSlotCounts)
    .filter(([slot]) => slot !== "21")
    .reduce((sum, [, count]) => sum + Number(count || 0), 0);
  return Math.max(1, Number(draftableSlots || draft?.slotCount || 16));
}
