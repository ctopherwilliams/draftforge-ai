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
  sourceAuctions?: Record<string, number>;
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
  projectionValue: number;
  fairValue: number;
  targetBid: number;
  maxBid: number;
  fillsMandatoryStarter: boolean;
  reasons: string[];
};

export type AuctionPlan = {
  positionBudgets: Record<string, number>;
  spentByPosition: Record<string, number>;
  roomInflation: number;
  opponentSpend: number;
  opponentPlayers: number;
  minimumRosterReserve: number;
  endgameReserve: number;
  roomPlayers: number;
  knownSaleCoverage: number;
  positionInflation: Record<string, number>;
  opponents: {
    teamId: number;
    name: string;
    spent: number;
    players: number;
    maxOffer: number;
    positions: Record<string, number>;
    openStarters: Record<string, number>;
  }[];
};

export type LiveAuctionBudget = { teamName: string; remaining: number; maxOffer: number };

export type AuctionNomination = {
  player: Recommendation;
  intent: "TARGET" | "DRAIN";
  openingBid: number;
  reason: string;
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

const AUCTION_POSITION_WEIGHTS: Record<string, number> = {
  QB: .08, RB: .155, WR: .17, TE: .075, FLEX: .14, K: 0, DST: 0, BN: .008,
};

export function starterNeeds(league: LeagueSettings) {
  const needs: Partial<Record<Position, number>> = {};
  for (const [slot, count] of Object.entries(league.lineupSlotCounts || {})) {
    const slots = Number(count);
    if (!Number.isFinite(slots) || slots <= 0) continue;
    // ESPN's multi-position starter slots need to contribute to every eligible
    // position. Treating RB/WR as RB, or ignoring OP, skews VORP and max bids.
    if (slot === "3") {
      needs.RB = (needs.RB || 0) + slots / 2;
      needs.WR = (needs.WR || 0) + slots / 2;
      continue;
    }
    if (slot === "5") {
      needs.WR = (needs.WR || 0) + slots / 2;
      needs.TE = (needs.TE || 0) + slots / 2;
      continue;
    }
    if (slot === "7") {
      for (const position of ["QB", "RB", "WR", "TE"] as Position[]) needs[position] = (needs[position] || 0) + slots / 4;
      continue;
    }
    const position = SLOT_TO_POSITION[slot];
    if (!position || position === "BENCH" || position === "IR") continue;
    needs[position] = (needs[position] || 0) + slots;
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

function projectionAuctionValues(players: DraftPlayer[], league: LeagueSettings) {
  const replacements = getReplacementPoints(players, league);
  const rosterableCount = Math.max(1, league.size * league.rosterSize);
  const rosterable = [...players]
    .map((player) => ({
      player,
      vorp: Math.max(0, Number(player.projected || 0) - Number(replacements[player.pos] || 0)),
    }))
    .sort((left, right) => right.vorp - left.vorp || left.player.rank - right.player.rank)
    .slice(0, rosterableCount);
  const rosterableIds = new Set(rosterable.map(({ player }) => player.id));
  const totalVorp = rosterable.reduce((sum, item) => sum + item.vorp, 0) || 1;
  const discretionaryDollars = Math.max(0, league.size * (league.auctionBudget - league.rosterSize));
  return new Map(players.map((player) => {
    if (!rosterableIds.has(player.id)) return [player.id, 1];
    const vorp = Math.max(0, Number(player.projected || 0) - Number(replacements[player.pos] || 0));
    return [player.id, Math.max(1, 1 + discretionaryDollars * vorp / totalVorp)];
  }));
}

function normalizedTeamName(value: string) {
  return String(value || "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

function openSlotsFromLiveBudget(budget: LiveAuctionBudget, rosterSize: number) {
  // ESPN reports a $0 max offer once a roster is full. Applying the usual
  // remaining-minus-max formula to that sentinel would invert the room state
  // and make a full roster look almost empty.
  if (Number(budget.maxOffer) <= 0) return 0;
  return Math.max(0, Math.min(rosterSize, Number(budget.remaining) - Number(budget.maxOffer) + 1));
}

export function buildAuctionPlan(
  players: DraftPlayer[],
  picks: DraftPick[],
  league: LeagueSettings,
  strategy: StrategyId,
  liveBudgets: LiveAuctionBudget[] = [],
): AuctionPlan {
  const needs = starterNeeds(league);
  const dedicatedCounts: Record<string, number> = {
    QB: Math.ceil(Number(needs.QB || 0)),
    RB: Math.ceil(Number(needs.RB || 0)),
    WR: Math.ceil(Number(needs.WR || 0)),
    TE: Math.ceil(Number(needs.TE || 0)),
    FLEX: Math.ceil(Number(needs.FLEX || 0)),
    K: Math.ceil(Number(needs.K || 0)),
    DST: Math.ceil(Number(needs.DST || 0)),
  };
  const starterSlots = Object.values(dedicatedCounts).reduce((sum, count) => sum + count, 0);
  dedicatedCounts.BN = Math.max(0, league.rosterSize - starterSlots);
  const minimumRosterReserve = Math.max(0, league.rosterSize);
  const discretionary = Math.max(0, league.auctionBudget - minimumRosterReserve);
  const rosterableMarket = [...players].sort((left, right) => Number(right.auction || 0) - Number(left.auction || 0))
    .slice(0, Math.max(1, league.size * league.rosterSize));
  const marketExtraByPosition = rosterableMarket.reduce<Record<string, number>>((totals, player) => {
    totals[player.pos] = Number(totals[player.pos] || 0) + Math.max(0, Number(player.auction || 1) - 1);
    return totals;
  }, {});
  const totalMarketExtra = Object.values(marketExtraByPosition).reduce((sum, value) => sum + value, 0) || 1;
  const initialWeights = Object.fromEntries(Object.entries(dedicatedCounts).map(([position, count]) => {
    const strategyMultiplier = position in STRATEGY_WEIGHTS[strategy]
      ? STRATEGY_WEIGHTS[strategy][position as Position]
      : 1;
    return [position, count * Number(AUCTION_POSITION_WEIGHTS[position] || 0) * strategyMultiplier];
  }));
  const initialTotal = Object.values(initialWeights).reduce((sum, value) => sum + Number(value), 0) || 1;
  const rawWeights = Object.fromEntries(Object.entries(initialWeights).map(([position, weight]) => {
    const marketPositions = position === "FLEX" || position === "BN" ? ["RB", "WR", "TE"] : [position];
    const marketShare = marketPositions.reduce((sum, marketPosition) => sum + Number(marketExtraByPosition[marketPosition] || 0), 0) / totalMarketExtra;
    const plannedShare = Number(weight) / initialTotal;
    const marketAdjustment = plannedShare > 0 ? Math.max(.75, Math.min(1.25, marketShare / plannedShare)) : 1;
    // The preset strategy remains recognizable, while 25% source-driven
    // movement adapts the position plan to this league's projections/market.
    return [position, Number(weight) * (.75 + .25 * marketAdjustment)];
  }));
  const totalWeight = Object.values(rawWeights).reduce((sum, value) => sum + Number(value), 0) || 1;
  const unrounded = Object.fromEntries(Object.entries(dedicatedCounts).map(([position, count]) => [
    position,
    count + discretionary * Number(rawWeights[position] || 0) / totalWeight,
  ]));
  const positionBudgets = Object.fromEntries(Object.entries(unrounded).map(([position, amount]) => [position, Math.floor(amount)]));
  let remainder = league.auctionBudget - Object.values(positionBudgets).reduce((sum, value) => sum + Number(value), 0);
  for (const position of Object.keys(unrounded).sort((left, right) =>
    (unrounded[right] - Math.floor(unrounded[right])) - (unrounded[left] - Math.floor(unrounded[left]))
  )) {
    if (remainder <= 0) break;
    positionBudgets[position] += 1;
    remainder -= 1;
  }

  const spentByPosition: Record<string, number> = { QB: 0, RB: 0, WR: 0, TE: 0, FLEX: 0, K: 0, DST: 0, BN: 0 };
  for (const pick of picks.filter((candidate) => candidate.teamId === league.teamId)) {
    const position = players.find((player) => player.id === pick.playerId)?.pos;
    if (position) spentByPosition[position] = Number(spentByPosition[position] || 0) + Math.max(0, pick.amount);
  }

  const totalLeagueBudget = Math.max(1, league.size * league.auctionBudget);
  const rosterableMarketTotal = rosterableMarket.reduce((sum, player) => sum + Math.max(1, Number(player.auction || 1)), 0) || 1;
  const marketScale = totalLeagueBudget / rosterableMarketTotal;
  const expectedMarketValue = new Map(rosterableMarket.map((player) => [player.id, Math.max(1, Number(player.auction || 1)) * marketScale]));
  const observed = picks.flatMap((pick) => {
    if (pick.amount <= 0) return [];
    const player = players.find((candidate) => candidate.id === pick.playerId);
    const expected = expectedMarketValue.get(pick.playerId);
    return player && expected ? [{ actual: pick.amount, expected, position: player.pos }] : [];
  });
  const actualSpend = observed.reduce((sum, pick) => sum + pick.actual, 0);
  const expectedSpend = observed.reduce((sum, pick) => sum + pick.expected, 0);
  const normalizedLiveBudgets = new Map(liveBudgets.map((budget) => [normalizedTeamName(budget.teamName), budget]));
  const opponents = league.teams.filter((team) => team.id !== league.teamId).map((team) => {
    const teamPicks = picks.filter((pick) => pick.teamId === team.id && pick.amount > 0);
    const liveBudget = normalizedLiveBudgets.get(normalizedTeamName(team.name || team.abbrev || ""));
    const spent = liveBudget ? Math.max(0, league.auctionBudget - liveBudget.remaining) : teamPicks.reduce((sum, pick) => sum + pick.amount, 0);
    const liveOpenSlots = liveBudget ? openSlotsFromLiveBudget(liveBudget, league.rosterSize) : null;
    const playersRostered = liveOpenSlots === null ? teamPicks.length : Math.max(0, league.rosterSize - liveOpenSlots);
    const openSlots = Math.max(0, league.rosterSize - playersRostered);
    const positions = teamPicks.reduce<Record<string, number>>((counts, pick) => {
      const position = players.find((player) => player.id === pick.playerId)?.pos;
      if (position) counts[position] = Number(counts[position] || 0) + 1;
      return counts;
    }, {});
    const openStarters = Object.fromEntries(["QB", "RB", "WR", "TE", "K", "DST"].map((position) => [
      position,
      openSlots === 0 ? 0 : Math.max(0, Math.ceil(Number(needs[position as Position] || 0)) - Number(positions[position] || 0)),
    ]));
    return {
      teamId: team.id,
      name: team.name || team.abbrev || `Team ${team.id}`,
      spent,
      players: playersRostered,
      maxOffer: liveBudget?.maxOffer ?? Math.max(0, league.auctionBudget - spent - Math.max(0, openSlots - 1)),
      positions,
      openStarters,
    };
  });

  const liveRoomPlayers = liveBudgets.length >= league.size
    ? liveBudgets.reduce((sum, budget) => {
        const openSlots = openSlotsFromLiveBudget(budget, league.rosterSize);
        return sum + Math.max(0, league.rosterSize - openSlots);
      }, 0)
    : 0;
  const roomPlayers = Math.max(observed.length, liveRoomPlayers);
  const knownSaleCoverage = roomPlayers > 0 ? Math.min(1, observed.length / roomPlayers) : 1;
  const inflationReady = observed.length > 0 && knownSaleCoverage >= .8;
  // Correct sequential-auction inflation compares dollars remaining with the
  // source-backed value remaining. Early overpayment therefore lowers later
  // prices; it must never raise our walk-away ceiling.
  const roomInflation = inflationReady && totalLeagueBudget > expectedSpend
    ? Math.max(.75, Math.min(1.25, (totalLeagueBudget - actualSpend) / (totalLeagueBudget - expectedSpend)))
    : 1;
  const positionInflation = Object.fromEntries(["QB", "RB", "WR", "TE", "K", "DST"].map((position) => {
    const positionPicks = observed.filter((pick) => pick.position === position);
    const actual = positionPicks.reduce((sum, pick) => sum + pick.actual, 0);
    const expected = positionPicks.reduce((sum, pick) => sum + pick.expected, 0);
    const positionMarketTotal = rosterableMarket
      .filter((player) => player.pos === position)
      .reduce((sum, player) => sum + Number(expectedMarketValue.get(player.id) || 0), 0);
    const multiplier = inflationReady && expected > 0 && positionMarketTotal > expected
      ? (positionMarketTotal - actual) / (positionMarketTotal - expected)
      : 1;
    return [position, Math.max(.75, Math.min(1.25, multiplier))];
  }));
  const endgameReserve = Math.min(league.auctionBudget, Math.max(6, Math.round(league.auctionBudget * .075)));

  return {
    positionBudgets,
    spentByPosition,
    roomInflation,
    opponentSpend: opponents.reduce((sum, opponent) => sum + opponent.spent, 0),
    opponentPlayers: opponents.reduce((sum, opponent) => sum + opponent.players, 0),
    minimumRosterReserve,
    endgameReserve,
    roomPlayers,
    knownSaleCoverage,
    positionInflation,
    opponents,
  };
}

function calculateMaxBid(
  league: LeagueSettings,
  picks: DraftPick[],
  myTeamId: number | null,
  rosterCount: number,
  fairValue: number,
  needMultiplier: number,
  mandatoryStarterReserve: number,
  marketInflation: number,
  scarcity: number,
  positionRun: number,
  endgameReserve: number,
) {
  if (league.draftType !== "AUCTION") return 0;
  const mySpend = picks.filter((pick) => pick.teamId === myTeamId).reduce((sum, pick) => sum + pick.amount, 0);
  const remainingSlots = Math.max(1, league.rosterSize - rosterCount);
  const legalReserve = remainingSlots - 1;
  const preserveLateLeverage = remainingSlots > 6 ? endgameReserve : legalReserve;
  const strategicReserve = Math.max(legalReserve, mandatoryStarterReserve, preserveLateLeverage);
  const spendable = Math.max(1, league.auctionBudget - mySpend - strategicReserve);
  const inflation = Math.max(.8, Math.min(1.2, marketInflation));
  const rosterAdjustment = Math.max(.9, Math.min(1.08, needMultiplier));
  const tierPremium = 1 + Math.min(.08, (scarcity >= 8 ? .04 : 0) + Math.min(.04, positionRun * .01));
  const modelValue = Math.max(1, Math.round(fairValue * inflation * rosterAdjustment * tierPremium));
  // A source-backed bargain can justify early aggression, but a single result
  // must not turn into an accidental all-in. These cumulative guardrails match
  // the researched hybrid range: at most 35%, 55%, and 75% after the first
  // three wins, then the portfolio and endgame reserves take over.
  const cumulativePacing = rosterCount === 0 ? .35 : rosterCount === 1 ? .55 : rosterCount === 2 ? .75 : rosterCount === 3 ? .85 : 1;
  const pacingSpendable = Math.max(1, Math.floor(league.auctionBudget * cumulativePacing) - mySpend);
  return Math.max(1, Math.min(spendable, pacingSpendable, modelValue));
}

export function recommendPlayers(
  players: DraftPlayer[],
  picks: DraftPick[],
  league: LeagueSettings,
  strategy: StrategyId,
  overallPick = picks.length + 1,
  liveBudgets: LiveAuctionBudget[] = [],
): Recommendation[] {
  const draftedIds = new Set(picks.map((pick) => pick.playerId));
  const available = players.filter((player) => !draftedIds.has(player.id));
  const myRoster = picks.filter((pick) => pick.teamId === league.teamId).map((pick) => players.find((player) => player.id === pick.playerId)).filter(Boolean) as DraftPlayer[];
  const needs = starterNeeds(league);
  const rosterCounts = myRoster.reduce<Partial<Record<Position, number>>>((counts, rosterPlayer) => {
    counts[rosterPlayer.pos] = Number(counts[rosterPlayer.pos] || 0) + 1;
    return counts;
  }, {});
  const coreSkillOpen = (["RB", "WR"] as Position[]).some((position) =>
    Number(rosterCounts[position] || 0) < Number(needs[position] || 0)
  );
  const dedicatedDeficits = (["QB", "RB", "WR", "TE", "K", "DST"] as Position[]).reduce<Partial<Record<Position, number>>>((deficits, position) => {
    deficits[position] = Math.max(0, Math.ceil(Number(needs[position] || 0) - Number(rosterCounts[position] || 0)));
    return deficits;
  }, {});
  const flexEligibleRoster = (["RB", "WR", "TE"] as Position[]).reduce((sum, position) => sum + Number(rosterCounts[position] || 0), 0);
  const dedicatedFlexEligibleNeeds = (["RB", "WR", "TE"] as Position[]).reduce((sum, position) => sum + Math.ceil(Number(needs[position] || 0)), 0);
  const flexDeficit = Math.max(0, Math.ceil(Number(needs.FLEX || 0)) - Math.max(0, flexEligibleRoster - dedicatedFlexEligibleNeeds));
  const mandatoryOpenStarters = Object.values(dedicatedDeficits).reduce((sum, count) => sum + Number(count || 0), 0) + flexDeficit;
  const remainingRosterSlots = Math.max(0, league.rosterSize - myRoster.length);
  const endgameLineupLock = mandatoryOpenStarters > 0 && remainingRosterSlots <= mandatoryOpenStarters + 1;
  const replacements = getReplacementPoints(players, league);
  const projectionValues = projectionAuctionValues(players, league);
  const projectedValues = available.map((player) => player.projected || Math.max(1, 350 - player.rank * 2));
  const minProjection = Math.min(...projectedValues, 0);
  const maxProjection = Math.max(...projectedValues, 1);
  const provisionalVorp = available.map((player) => Math.max(0, (player.projected || 0) - Number(replacements[player.pos] || 0)));
  const currentPick = Math.max(picks.length + 1, Number(overallPick) || 1);
  const recentPositionDemand = picks.slice(-Math.max(4, league.size)).reduce<Partial<Record<Position, number>>>((counts, pick) => {
    const position = players.find((player) => player.id === pick.playerId)?.pos;
    if (position) counts[position] = Number(counts[position] || 0) + 1;
    return counts;
  }, {});
  const auctionPlan = buildAuctionPlan(players, picks, league, strategy, liveBudgets);
  const eligibleOverspend = (["RB", "WR", "TE"] as Position[]).reduce((sum, position) =>
    sum + Math.max(0, Number(auctionPlan.spentByPosition[position] || 0) - Number(auctionPlan.positionBudgets[position] || 0)), 0);
  const availableFlexBudget = Math.max(0, Number(auctionPlan.positionBudgets.FLEX || 0) - eligibleOverspend);

  return available.map((player) => {
    const positionPool = available.filter((candidate) => candidate.pos === player.pos).sort((a, b) => (b.projected || 0) - (a.projected || 0));
    const positionIndex = Math.max(0, positionPool.findIndex((candidate) => candidate.id === player.id));
    const nextAtPosition = positionPool[Math.min(positionPool.length - 1, positionIndex + Math.max(1, Math.floor(league.size / 2)))];
    const vorp = Math.max(0, (player.projected || 0) - Number(replacements[player.pos] || 0));
    const scarcity = Math.max(0, (player.projected || 0) - (nextAtPosition?.projected || 0));
    const rosteredAtPosition = Number(rosterCounts[player.pos] || 0);
    const requiredAtPosition = Number(needs[player.pos] || 0);
    const need = requiredAtPosition > rosteredAtPosition ? 1 : 0;
    const singleStarterPosition = requiredAtPosition > 0 && requiredAtPosition <= 1;
    const hardSaturation = singleStarterPosition && (
      (player.pos === "QB" && rosteredAtPosition >= 2)
      || (player.pos === "TE" && rosteredAtPosition >= 2)
    );
    const saturationPenalty = hardSaturation
      ? 1_000
      : player.pos === "QB" && singleStarterPosition && rosteredAtPosition >= 1
        ? coreSkillOpen ? 70 : 38
        : player.pos === "TE" && singleStarterPosition && rosteredAtPosition >= 1
          ? coreSkillOpen ? 48 : 24
          : 0;
    const fillsMandatoryStarter = Number(dedicatedDeficits[player.pos] || 0) > 0
      || (flexDeficit > 0 && ["RB", "WR", "TE"].includes(player.pos));
    const endgameLineupBonus = endgameLineupLock && fillsMandatoryStarter ? 140 : 0;
    const endgameLineupPenalty = endgameLineupLock && !fillsMandatoryStarter ? 1_000 : 0;
    const strategyMultiplier = STRATEGY_WEIGHTS[strategy][player.pos] || 1;
    const needMultiplier = Math.max(.72, 1 + need * .16) * strategyMultiplier;
    const adpValue = Number.isFinite(player.adp) && player.adp < 900 ? Math.max(-20, Math.min(20, currentPick - player.adp)) : 0;
    const projectionScore = percentile(player.projected || Math.max(1, 350 - player.rank * 2), minProjection, maxProjection) * 30;
    const vorpScore = percentile(vorp, 0, Math.max(...provisionalVorp, 1)) * 25;
    const scarcityScore = percentile(scarcity, 0, Math.max(...available.map((candidate) => candidate.projected || 0), 1) * .2) * 13;
    const consensusScore = Number(player.consensusScore ?? Math.max(0, 100 - player.rank)) * .18;
    const adpScore = percentile(adpValue, -20, 20) * 8;
    const needScore = need * 10;
    const positionRunBonus = fillsMandatoryStarter ? Math.min(12, Number(recentPositionDemand[player.pos] || 0) * 3) : 0;
    const injuryPenalty = player.injured ? 12 : 0;
    const latePositionPenalty = ["K", "DST"].includes(player.pos) && myRoster.length < Math.max(league.rosterSize - 3, 6) ? 30 : 0;
    const score = (projectionScore + vorpScore + scarcityScore + consensusScore + adpScore + needScore + positionRunBonus) * strategyMultiplier
      + endgameLineupBonus - injuryPenalty - latePositionPenalty - saturationPenalty - endgameLineupPenalty;
    const projectionValue = Number(projectionValues.get(player.id) || 1);
    const fairValue = Math.max(1, Number(player.auction || 1) * .65 + projectionValue * .35);
    const dedicatedStarterReserve = (["QB", "RB", "WR", "TE", "K", "DST"] as Position[]).reduce((sum, position) => {
      const open = Number(dedicatedDeficits[position] || 0);
      const reservePerSlot = position === "RB" || position === "WR" ? 4 : position === "QB" || position === "TE" ? 3 : 1;
      const thisPlayerFillsOne = player.pos === position && open > 0 ? 1 : 0;
      return sum + Math.max(0, open - thisPlayerFillsOne) * reservePerSlot;
    }, 0);
    const flexStarterReserve = Math.max(
      0,
      flexDeficit - (["RB", "WR", "TE"].includes(player.pos) && flexDeficit > 0 ? 1 : 0),
    ) * 4;
    const benchReserve = Math.max(0, remainingRosterSlots - mandatoryOpenStarters - 1);
    const strategicRosterReserve = dedicatedStarterReserve + flexStarterReserve + benchReserve;
    const primaryBudgetRemaining = Math.max(
      0,
      Number(auctionPlan.positionBudgets[player.pos] || 0) - Number(auctionPlan.spentByPosition[player.pos] || 0),
    );
    const portfolioWalkAway = Math.max(
      1,
      Math.floor(primaryBudgetRemaining + (["RB", "WR", "TE"].includes(player.pos) ? availableFlexBudget : 0)),
    );
    const mustPreserveFinalStarterSlots = league.draftType === "AUCTION" && endgameLineupLock && !fillsMandatoryStarter;
    const calculatedMaxBid = hardSaturation || mustPreserveFinalStarterSlots
      ? 0
      : calculateMaxBid(
        league,
        picks,
        league.teamId,
        myRoster.length,
        fairValue,
        needMultiplier * (saturationPenalty ? .35 : 1),
        strategicRosterReserve,
        Number(auctionPlan.positionInflation[player.pos] || 1) * .7 + auctionPlan.roomInflation * .3,
        scarcity,
        Number(recentPositionDemand[player.pos] || 0),
        auctionPlan.endgameReserve,
      );
    const maxBid = hardSaturation || mustPreserveFinalStarterSlots ? 0 : Math.min(calculatedMaxBid, portfolioWalkAway);
    const targetBid = maxBid > 0 ? Math.max(1, Math.min(maxBid, Math.round(fairValue * .92))) : 0;
    const portfolioPenalty = league.draftType === "AUCTION" && portfolioWalkAway <= 1 && !fillsMandatoryStarter ? 120 : 0;
    const reasons = [
      vorp > 0 ? `${vorp.toFixed(1)} points above positional replacement` : "Depth-based value at this stage",
      scarcity > 8 ? `A ${scarcity.toFixed(1)}-point tier drop is approaching` : "No severe tier cliff immediately behind him",
      fillsMandatoryStarter ? `Fills an open ${player.pos} starter slot` : saturationPenalty ? `${player.pos} depth is already saturated` : `Adds value without forcing roster need`,
      adpValue > 3 ? `${adpValue.toFixed(1)} picks past ESPN market value` : adpValue < -3 ? `${Math.abs(adpValue).toFixed(1)} picks ahead of ESPN market` : `Priced close to ESPN market`,
      positionRunBonus ? `${recentPositionDemand[player.pos]} ${player.pos}s left the board in the last ${Math.max(4, league.size)} picks` : "No urgent opponent run at this position",
      player.sourceCount ? `${player.sourceCount}/5 public sources matched; ${player.rankSpread && player.rankSpread > 12 ? "market disagreement is elevated" : "source agreement is stable"}` : "ESPN-only until public sources refresh",
      `Fair value blends the five-source market ($${Math.round(player.auction || 1)}) with scoring-adjusted VORP ($${Math.round(projectionValue)})`,
    ];
    return { ...player, score: score - portfolioPenalty, confidence: 0, vorp, scarcity, need, adpValue, projectionValue, fairValue, targetBid, maxBid, fillsMandatoryStarter, reasons };
  }).sort((a, b) => b.score - a.score).map((player, index, ranked) => ({
    ...player,
    confidence: Math.round(Math.max(55, Math.min(97, 58 + (player.score - (ranked[1]?.score || player.score - 8)) * 1.4 + Number(player.consensusConfidence || 60) * .2 - index * .4))),
  }));
}

export function chooseAuctionNomination(
  recommendations: Recommendation[],
  league: LeagueSettings,
  plan: AuctionPlan,
): AuctionNomination | null {
  if (league.draftType !== "AUCTION") return null;
  const target = recommendations.find((player) => player.maxBid >= 1 && !["K", "DST"].includes(player.pos))
    || recommendations.find((player) => player.maxBid >= 1);
  if (!target) return null;
  const totalRosterSpots = Math.max(1, league.size * league.rosterSize);
  const roomPhase = Math.max(0, Math.min(1, plan.roomPlayers / totalRosterSpots));
  const maxOpponentOffer = Math.max(0, ...plan.opponents.map((opponent) => opponent.maxOffer));
  const targetOpeningBid = roomPhase >= .8
    && maxOpponentOffer > 1
    && maxOpponentOffer <= 3
    && target.maxBid >= maxOpponentOffer
      ? maxOpponentOffer
      : 1;
  const targetNomination = (reason: string): AuctionNomination => ({
    player: target,
    intent: "TARGET",
    openingBid: targetOpeningBid,
    reason,
  });

  if (plan.roomPlayers === 0) {
    return targetNomination("Use the room's first-price uncertainty on a player we actively want.");
  }
  if (roomPhase >= .72) {
    return targetNomination("The endgame is for securing our highest-upside remaining roster target.");
  }
  if (target.need > 0 && target.scarcity >= 8) {
    return targetNomination("Act before the final player in a needed tier attracts a scarcity premium.");
  }

  const drain = recommendations
    .filter((player) => player.id !== target.id
      && player.maxBid >= 1
      && player.fairValue >= Math.max(8, league.auctionBudget * .04)
      && !["K", "DST"].includes(player.pos)
      && (player.need === 0 || player.score <= target.score - 10))
    .map((player) => {
      const opponentDemand = plan.opponents.reduce((sum, opponent) =>
        sum + (Number(opponent.openStarters[player.pos] || 0) > 0 ? opponent.maxOffer : 0), 0);
      return { player, drainScore: player.fairValue + opponentDemand / Math.max(1, plan.opponents.length) - player.score * .05 };
    })
    .sort((left, right) => right.drainScore - left.drainScore || right.player.fairValue - left.player.fairValue)[0]?.player;

  if (!drain) return targetNomination("No safe opponent-budget drain is available, so nominate a wanted player at the minimum.");
  return {
    player: drain,
    intent: "DRAIN",
    openingBid: 1,
    reason: "Drain opponent budget at the $1 minimum; do not price-enforce or bid after nomination.",
  };
}

export function describeRecommendation(recommendation: Recommendation, league: LeagueSettings, strategy: StrategyId) {
  const action = league.draftType === "AUCTION"
    ? `Target ${recommendation.name} up to $${recommendation.maxBid}.`
    : `Draft ${recommendation.name}.`;
  const strategyName = strategy === "HERO_RB" ? "Hero RB" : strategy === "ZERO_RB" ? "Zero RB" : strategy === "ELITE_QB" ? "Elite QB" : "Balanced";
  return `${action} The ${strategyName} model favors the ${recommendation.pos} value because ${recommendation.reasons[0].toLowerCase()} and ${recommendation.reasons[1].toLowerCase()}.`;
}
