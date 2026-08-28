import type { DraftPick, DraftPlayer, LeagueSettings, Recommendation } from "./draft-engine";
import type { EspnContext } from "./espn-context-state";

const OPPONENT_TEAM_ID = 2_000_000_000;

function normalizeName(value: string | null | undefined) {
  return String(value || "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

function defenseNickname(value: string | null | undefined) {
  return String(value || "")
    .replace(/d\/?st|defense/gi, "")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .at(-1)
    ?.toLowerCase().replace(/[^a-z0-9]/g, "") || "";
}

function resolveUniqueEspnTeam(
  value: string | null | undefined,
  teams: LeagueSettings["teams"],
) {
  const identity = normalizeName(value);
  if (!identity) return null;
  const matches = teams.filter((candidate) => (
    normalizeName(candidate.name) === identity
    || normalizeName(candidate.abbrev) === identity
  ));
  // ESPN's rendered history can expose a display name or abbreviation, but
  // neither is a stable team id. A duplicate name or a name/abbreviation
  // collision is untrusted even when one candidate happens to be our team.
  return matches.length === 1 ? matches[0] : null;
}

export function espnNameMatchesPlayer(value: string | null | undefined, player: DraftPlayer) {
  if (normalizeName(value) === normalizeName(player.name)) return true;
  if (player.pos !== "DST") return false;
  const nickname = defenseNickname(value);
  return Boolean(nickname && (normalizeName(player.name).includes(nickname) || normalizeName(player.team) === nickname));
}

export function liveEspnRecommendations(
  recommendations: Recommendation[],
  roomContext: EspnContext | undefined,
  rejectedPlayerIds: number[] = [],
  remainingRosterSlots = Number.POSITIVE_INFINITY,
) {
  const rejected = new Set(rejectedPlayerIds);
  const eligible = recommendations.filter((player) => !rejected.has(player.id));
  if (!roomContext?.inDraftRoom) return eligible;
  // A populated live pool proves that the exact ESPN room is readable. The
  // final mandatory slots are the exception to row-level visibility: ESPN's
  // virtualized grid can omit the last available kicker or defense until an
  // exact search is performed by the content script.
  if (!roomContext.availablePlayerIds?.length) return [];
  const availableIds = new Set(roomContext.availablePlayerIds);
  const availableNames = roomContext.availablePlayerNames || [];
  const exactAvailableNames = new Set(availableNames.map(normalizeName));
  const visible = eligible.filter((player) => (
    availableIds.has(player.id)
    || exactAvailableNames.has(normalizeName(player.name))
    || (player.pos === "DST" && availableNames.some((name) => espnNameMatchesPlayer(name, player)))
  ));
  if (remainingRosterSlots > 2) return visible;
  const hasMandatoryRequirement = recommendations.some((player) => player.fillsMandatoryStarter);
  const mandatory = eligible.filter((player) => player.fillsMandatoryStarter);
  // With at most two roster spots left, an open starter is a hard eligibility
  // constraint. A rendered mandatory control is actionable immediately and is
  // safer than spending a consecutive-pick clock searching ESPN's virtualized
  // grid for a marginally higher-ranked option. Keep the model order within
  // each group, then retain hidden mandatory players as fail-closed exact-search
  // fallbacks when ESPN renders none of them.
  if (!hasMandatoryRequirement) return visible;
  const visibleMandatoryIds = new Set(visible.filter((player) => player.fillsMandatoryStarter).map((player) => player.id));
  return [
    ...mandatory.filter((player) => visibleMandatoryIds.has(player.id)),
    ...mandatory.filter((player) => !visibleMandatoryIds.has(player.id)),
  ];
}

export function resolveOwnRoster(roomContext: EspnContext | undefined, players: DraftPlayer[]) {
  return (roomContext?.ownRoster || []).flatMap((entry, index) => {
    // Prefer ESPN's exact draft-pool identity whenever it resolves. Defense
    // rows can expose a team/logo id instead, so use the visible name only when
    // the supplied id is absent from the authenticated player pool.
    const exactPlayer = players.find((player) => player.id === Number(entry.playerId));
    const playerId = exactPlayer?.id
      ?? players.find((player) => espnNameMatchesPlayer(entry.name, player))?.id
      ?? 0;
    return playerId !== 0 && playerId !== -1
      ? [{ playerId, amount: Math.max(0, Number(entry.amount || 0)), index }]
      : [];
  });
}

export function resolveAuctionSales(roomContext: EspnContext | undefined, league: LeagueSettings, players: DraftPlayer[]) {
  if (!roomContext?.inDraftRoom) return [];
  return (roomContext?.auctionSales || []).flatMap((sale, index) => {
    const player = players.find((candidate) => candidate.id === Number(sale.playerId))
      || players.find((candidate) => normalizeName(candidate.name) === normalizeName(sale.playerName));
    const team = resolveUniqueEspnTeam(sale.teamName, league.teams);
    const amount = Number(sale.amount || 0);
    if (!player || !team || amount < 1) return [];
    const overall = Math.max(1, Number(sale.sequence || index + 1));
    return [{ playerId: player.id, teamId: team.id, overall, round: 0, amount }];
  });
}

export function resolveSnakeDraftPicks(roomContext: EspnContext | undefined, league: LeagueSettings, players: DraftPlayer[]) {
  if (league.draftType !== "SNAKE" || !roomContext?.inDraftRoom || !Array.isArray(roomContext.snakePicks)) return [];
  return roomContext.snakePicks.flatMap((pick) => {
    const player = players.find((candidate) => espnNameMatchesPlayer(pick.playerName, candidate));
    const team = resolveUniqueEspnTeam(pick.teamName, league.teams);
    const round = Number(pick.round);
    const roundPick = Number(pick.roundPick);
    if (!player || !Number.isInteger(round) || round < 1 || !Number.isInteger(roundPick) || roundPick < 1 || roundPick > league.size) return [];
    return [{
      playerId: player.id,
      teamId: Number(team?.id || OPPONENT_TEAM_ID),
      overall: (round - 1) * league.size + roundPick,
      round,
      amount: 0,
    }];
  });
}

export function reconcileEspnPicks(
  picks: DraftPick[],
  roomContext: EspnContext | undefined,
  teamId: number | null,
  players: DraftPlayer[],
  league?: LeagueSettings,
) {
  if (!roomContext?.inDraftRoom) return picks;
  if (!Array.isArray(roomContext?.ownRoster)) return picks;
  const snakePicks = league ? resolveSnakeDraftPicks(roomContext, league, players) : [];
  const ownRoster = resolveOwnRoster(roomContext, players);
  const ownIds = new Set(ownRoster.map((entry) => entry.playerId));
  const byPlayer = new Map(
    [...picks, ...snakePicks].map((pick) => [pick.playerId, {
      ...pick,
      // A live roster panel is a positive, append-only ownership signal. ESPN
      // virtualizes and transiently tears down rows, so absence from one frame
      // can never revoke an already confirmed team attribution. Authoritative
      // pick/sale feeds may still correct ownership before entering this merge.
      teamId: ownIds.has(pick.playerId) && Number(teamId) > 0
        ? Number(teamId)
        : pick.teamId,
    }]),
  );
  const maxOverall = Math.max(0, ...[...byPlayer.values()].map((pick) => Number(pick.overall || 0)));
  for (const entry of ownRoster) {
    const existing = byPlayer.get(entry.playerId);
    byPlayer.set(entry.playerId, {
      playerId: entry.playerId,
      teamId: Number(teamId),
      overall: existing?.overall || maxOverall + entry.index + 1,
      round: existing?.round || 0,
      amount: entry.amount || existing?.amount || 0,
    });
  }
  return [...byPlayer.values()].sort((a, b) => a.overall - b.overall);
}
