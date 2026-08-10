export type Position = "QB" | "RB" | "WR" | "TE" | "K" | "DST" | "FLEX";
export type DraftType = "SNAKE" | "AUCTION";
export type StrategyId = "BALANCED" | "HERO_RB" | "ZERO_RB" | "ELITE_QB" | "CUSTOM";

export type DraftPlayer = {
  id: number;
  name: string;
  team: string;
  pos: Position;
  rank: number;
  adp: number;
  auction: number;
  projected: number;
  injured?: boolean;
  consensusRank?: number;
  consensusScore?: number;
  consensusConfidence?: number;
  rankSpread?: number;
  sourceCount?: number;
  sourceRanks?: Record<string, number>;
};

export type DraftPick = {
  playerId: number;
  teamId: number;
  overall: number;
  round: number;
  amount: number;
  keeper?: boolean;
};

export type LeagueSettings = {
  id: string;
  name: string;
  season: number;
  size: number;
  teamId: number | null;
  draftType: DraftType;
  secondsPerPick: number;
  rosterSize: number;
  auctionBudget: number;
  lineupSlotCounts: Record<string, number>;
  positionLimits: Record<string, number>;
  scoringLabel: string;
  scoringRules: number;
  keeperCount: number;
  pickOrder: number[];
  teams: { id: number; name: string; abbrev: string }[];
  rawSettings?: unknown;
};

export type Recommendation = DraftPlayer & {
  score: number;
  confidence: number;
  vorp: number;
  scarcity: number;
  need: number;
  adpValue: number;
  maxBid: number;
  reasons: string[];
};

const SLOT_TO_POSITION: Record<string, Position | "BENCH" | "IR"> = {
  "0": "QB", "1": "QB", "2": "RB", "3": "RB", "4": "WR", "5": "WR",
  "6": "TE", "16": "DST", "17": "K", "20": "BENCH", "21": "IR", "23": "FLEX",
};

const STRATEGY_WEIGHTS: Record<StrategyId, Record<Position, number>> = {
  BALANCED: { QB: 1, RB: 1, WR: 1, TE: 1, K: .15, DST: .2, FLEX: 1 },
  HERO_RB: { QB: .95, RB: 1.2, WR: 1.04, TE: 1, K: .15, DST: .2, FLEX: 1 },
  ZERO_RB: { QB: 1, RB: .72, WR: 1.18, TE: 1.1, K: .15, DST: .2, FLEX: 1 },
  ELITE_QB: { QB: 1.2, RB: .98, WR: 1, TE: 1, K: .15, DST: .2, FLEX: 1 },
  CUSTOM: { QB: 1, RB: 1, WR: 1, TE: 1, K: .15, DST: .2, FLEX: 1 },
};

function starterNeeds(league: LeagueSettings) {
  const needs: Partial<Record<Position, number>> = {};
  for (const [slot, count] of Object.entries(league.lineupSlotCounts || {})) {
    const position = SLOT_TO_POSITION[slot];
    if (!position || position === "BENCH" || position === "IR") continue;
    needs[position] = (needs[position] || 0) + Number(count);
  }
  if (!Object.keys(needs).length) return { QB: 1, RB: 2, WR: 2, TE: 1, FLEX: 1 } as Partial<Record<Position, number>>;
  return needs;
}

function percentile(value: number, min: number, max: number) {
  if (!Number.isFinite(value) || max === min) return 0;
  return Math.max(0, Math.min(1, (value - min) / (max - min)));
}

function getReplacementPoints(players: DraftPlayer[], league: LeagueSettings) {
  const needs = starterNeeds(league);
  const result: Partial<Record<Position, number>> = {};
  for (const position of ["QB", "RB", "WR", "TE", "K", "DST"] as Position[]) {
    const pool = players.filter((player) => player.pos === position).sort((a, b) => b.projected - a.projected);
    const flexShare = ["RB", "WR", "TE"].includes(position) ? Number(needs.FLEX || 0) / 3 : 0;
    const index = Math.max(0, Math.round(league.size * (Number(needs[position] || 0) + flexShare)) - 1);
    result[position] = pool[Math.min(index, pool.length - 1)]?.projected || 0;
  }
  return result;
}

function calculateMaxBid(
  player: DraftPlayer,
  league: LeagueSettings,
  picks: DraftPick[],
  myTeamId: number | null,
  rosterCount: number,
  vorpShare: number,
  needMultiplier: number,
) {
  if (league.draftType !== "AUCTION") return 0;
  const mySpend = picks.filter((pick) => pick.teamId === myTeamId).reduce((sum, pick) => sum + pick.amount, 0);
  const remainingSlots = Math.max(1, league.rosterSize - rosterCount);
  const spendable = Math.max(1, league.auctionBudget - mySpend - (remainingSlots - 1));
  const completed = picks.filter((pick) => pick.amount > 0);
  const marketExpected = completed.reduce((sum, pick) => sum + Math.max(1, pick.amount), 0);
  const marketBaseline = completed.length ? completed.length * 12 : 1;
  const inflation = Math.max(.8, Math.min(1.35, marketExpected / marketBaseline));
  const modelValue = Math.max(player.auction || 1, Math.round(spendable * Math.min(.42, vorpShare)));
  return Math.max(1, Math.min(spendable, Math.round(modelValue * inflation * needMultiplier)));
}

export function recommendPlayers(
  players: DraftPlayer[],
  picks: DraftPick[],
  league: LeagueSettings,
  strategy: StrategyId,
): Recommendation[] {
  const draftedIds = new Set(picks.map((pick) => pick.playerId));
  const available = players.filter((player) => !draftedIds.has(player.id));
  const myRoster = picks.filter((pick) => pick.teamId === league.teamId).map((pick) => players.find((player) => player.id === pick.playerId)).filter(Boolean) as DraftPlayer[];
  const needs = starterNeeds(league);
  const replacements = getReplacementPoints(players, league);
  const projectedValues = available.map((player) => player.projected || Math.max(1, 350 - player.rank * 2));
  const minProjection = Math.min(...projectedValues, 0);
  const maxProjection = Math.max(...projectedValues, 1);
  const provisionalVorp = available.map((player) => Math.max(0, (player.projected || 0) - Number(replacements[player.pos] || 0)));
  const totalPositiveVorp = provisionalVorp.sort((a, b) => b - a).slice(0, Math.max(league.rosterSize * league.size, 1)).reduce((sum, value) => sum + value, 0) || 1;
  const currentPick = picks.length + 1;

  return available.map((player) => {
    const positionPool = available.filter((candidate) => candidate.pos === player.pos).sort((a, b) => (b.projected || 0) - (a.projected || 0));
    const positionIndex = Math.max(0, positionPool.findIndex((candidate) => candidate.id === player.id));
    const nextAtPosition = positionPool[Math.min(positionPool.length - 1, positionIndex + Math.max(1, Math.floor(league.size / 2)))];
    const vorp = Math.max(0, (player.projected || 0) - Number(replacements[player.pos] || 0));
    const scarcity = Math.max(0, (player.projected || 0) - (nextAtPosition?.projected || 0));
    const rosteredAtPosition = myRoster.filter((rosterPlayer) => rosterPlayer.pos === player.pos).length;
    const requiredAtPosition = Number(needs[player.pos] || 0);
    const need = requiredAtPosition > rosteredAtPosition ? 1 : requiredAtPosition ? .25 : 0;
    const strategyMultiplier = STRATEGY_WEIGHTS[strategy][player.pos] || 1;
    const needMultiplier = Math.max(.72, 1 + need * .16) * strategyMultiplier;
    const adpValue = Number.isFinite(player.adp) && player.adp < 900 ? Math.max(-20, Math.min(20, player.adp - currentPick)) : 0;
    const projectionScore = percentile(player.projected || Math.max(1, 350 - player.rank * 2), minProjection, maxProjection) * 30;
    const vorpScore = percentile(vorp, 0, Math.max(...provisionalVorp, 1)) * 25;
    const scarcityScore = percentile(scarcity, 0, Math.max(...available.map((candidate) => candidate.projected || 0), 1) * .2) * 13;
    const consensusScore = Number(player.consensusScore ?? Math.max(0, 100 - player.rank)) * .18;
    const adpScore = percentile(adpValue, -20, 20) * 8;
    const needScore = need * 10;
    const injuryPenalty = player.injured ? 12 : 0;
    const latePositionPenalty = ["K", "DST"].includes(player.pos) && myRoster.length < Math.max(league.rosterSize - 3, 6) ? 30 : 0;
    const score = (projectionScore + vorpScore + scarcityScore + consensusScore + adpScore + needScore) * strategyMultiplier - injuryPenalty - latePositionPenalty;
    const vorpShare = vorp / totalPositiveVorp;
    const maxBid = calculateMaxBid(player, league, picks, league.teamId, myRoster.length, vorpShare, needMultiplier);
    const reasons = [
      vorp > 0 ? `${vorp.toFixed(1)} points above positional replacement` : "Depth-based value at this stage",
      scarcity > 8 ? `A ${scarcity.toFixed(1)}-point tier drop is approaching` : "No severe tier cliff immediately behind him",
      need ? `Fills an open ${player.pos} starter slot` : `Adds value without forcing roster need`,
      adpValue > 3 ? `${adpValue.toFixed(1)} picks past ESPN market value` : `Priced close to ESPN market`,
      player.sourceCount ? `${player.sourceCount}/5 public sources matched; ${player.rankSpread && player.rankSpread > 12 ? "market disagreement is elevated" : "source agreement is stable"}` : "ESPN-only until public sources refresh",
    ];
    return { ...player, score, confidence: 0, vorp, scarcity, need, adpValue, maxBid, reasons };
  }).sort((a, b) => b.score - a.score).map((player, index, ranked) => ({
    ...player,
    confidence: Math.round(Math.max(55, Math.min(97, 58 + (player.score - (ranked[1]?.score || player.score - 8)) * 1.4 + Number(player.consensusConfidence || 60) * .2 - index * .4))),
  }));
}

export function describeRecommendation(recommendation: Recommendation, league: LeagueSettings, strategy: StrategyId) {
  const action = league.draftType === "AUCTION"
    ? `Target ${recommendation.name} up to $${recommendation.maxBid}.`
    : `Draft ${recommendation.name}.`;
  const strategyName = strategy === "HERO_RB" ? "Hero RB" : strategy === "ZERO_RB" ? "Zero RB" : strategy === "ELITE_QB" ? "Elite QB" : "Balanced";
  return `${action} The ${strategyName} model favors the ${recommendation.pos} value because ${recommendation.reasons[0].toLowerCase()} and ${recommendation.reasons[1].toLowerCase()}.`;
}
