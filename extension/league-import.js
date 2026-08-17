import { draftableRosterSizeFor, draftTypeFor, keeperCountFor } from "./league-normalizers.js";

/**
 * Convert ESPN's authenticated league payload into the single settings shape
 * consumed by both the dashboard and the chat-native draft-day bridge.
 * Keeping this outside the extension service worker prevents the two control
 * planes from drifting on roster size, salary cap, keepers, or scoring.
 */
export function normalizeSettings(raw, context) {
  const settings = raw.settings || {};
  const draft = settings.draftSettings || {};
  const roster = settings.rosterSettings || {};
  const scoring = settings.scoringSettings || {};
  const picks = raw.draftDetail?.picks || [];
  const draftType = draftTypeFor(draft.type);
  const scoringItems = scoring.scoringItems || [];
  const receptionRule = scoringItems.find((item) => Number(item.statId) === 53);
  const receptionPoints = Number(receptionRule?.points || 0);
  const scoringLabel = receptionPoints === 1
    ? "PPR"
    : receptionPoints === 0.5
      ? "Half PPR"
      : receptionPoints === 0
        ? "Standard"
        : "Custom";
  const keeperCount = keeperCountFor(draft, raw.teams || []);

  return {
    id: String(raw.id || context.leagueId),
    name: settings.name || raw.name || "ESPN League",
    season: Number(raw.seasonId || context.season || 2026),
    size: Number(settings.size || raw.teams?.length || 12),
    isPublic: Boolean(raw.isPublic),
    teamId: Number(context.teamId || 0) || null,
    draftType,
    draftDate: draft.date || null,
    secondsPerPick: Number(draft.timePerSelection || 90),
    rosterSize: draftableRosterSizeFor(draft, roster),
    auctionBudget: Number(draft.auctionBudget || draft.budget || 200),
    pickOrder: draft.pickOrder || [],
    lineupSlotCounts: roster.lineupSlotCounts || {},
    positionLimits: roster.positionLimits || {},
    scoringLabel,
    scoringRules: scoringItems.length,
    keeperCount,
    draftStatus: {
      inProgress: Boolean(raw.draftDetail?.inProgress),
      complete: Boolean(raw.draftDetail?.drafted),
      picks: picks.length,
    },
    teams: (raw.teams || []).map((team) => ({
      id: Number(team.id),
      name: team.name || `${team.location || ""} ${team.nickname || ""}`.trim(),
      abbrev: team.abbrev || "",
    })),
    rawSettings: settings,
  };
}
