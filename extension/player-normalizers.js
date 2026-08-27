export const POSITION_MAP = { 1: "QB", 2: "RB", 3: "WR", 4: "TE", 5: "K", 16: "DST" };
export const TEAM_MAP = {
  1:"ATL",2:"BUF",3:"CHI",4:"CIN",5:"CLE",6:"DAL",7:"DEN",8:"DET",9:"GB",10:"TEN",11:"IND",12:"KC",13:"LV",14:"LAR",15:"MIA",16:"MIN",17:"NE",18:"NO",19:"NYG",20:"NYJ",21:"PHI",22:"ARI",23:"PIT",24:"LAC",25:"SF",26:"SEA",27:"TB",28:"WAS",29:"CAR",30:"JAX",33:"BAL",34:"HOU"
};

function positiveNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

const UNAVAILABLE_STATUSES = new Set([
  "OUT",
  "IR",
  "INJURY_RESERVE",
  "INJURED_RESERVE",
  "PUP",
  "PHYSICALLY_UNABLE_TO_PERFORM",
  "NFI",
  "NON_FOOTBALL_INJURY",
  "SUSPENDED",
  "SUSPENSION",
  "COMMISSIONER_EXEMPT",
  "EXEMPT",
  "INACTIVE",
]);

function normalizedAvailabilityStatus(value) {
  return String(value || "ACTIVE").trim().toUpperCase().replace(/[\s-]+/g, "_");
}

export function normalizePlayers(raw) {
  return (raw.players || []).map((entry) => {
    const player = entry.player || entry;
    const ownership = player.ownership || {};
    const availabilityStatus = normalizedAvailabilityStatus(player.injuryStatus);
    const adp = positiveNumber(ownership.averageDraftPosition, 999);
    const projection = (player.stats || []).find((stat) => Number(stat.statSourceId) === 1 && Number(stat.scoringPeriodId) === 0)
      || (player.stats || []).find((stat) => Number(stat.statSourceId) === 1);
    return {
      id: Number(player.id || entry.id),
      name: player.fullName || player.name || "Unknown player",
      team: TEAM_MAP[player.proTeamId] || "FA",
      pos: POSITION_MAP[player.defaultPositionId] || "FLEX",
      // ESPN's preseason draftRanksByRankType.rank is position-relative for
      // some player classes (DST1, K1, and so on), not a comparable overall
      // rank. Average draft position is the only uniform ESPN market ordering.
      rank: adp,
      adp,
      auction: positiveNumber(ownership.auctionValueAverage, 1),
      projected: Math.max(0, Number(projection?.appliedTotal || 0)),
      availabilityStatus,
      injured: availabilityStatus !== "ACTIVE",
      unavailable: UNAVAILABLE_STATUSES.has(availabilityStatus),
    };
  }).filter((player) => player.id && ["QB", "RB", "WR", "TE", "K", "DST"].includes(player.pos));
}
