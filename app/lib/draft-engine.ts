export type Position = "QB" | "RB" | "WR" | "TE" | "K" | "DST" | "FLEX";
export type DraftType = "SNAKE" | "AUCTION";
export type StrategyId = "BALANCED" | "HERO_RB" | "ZERO_RB" | "ELITE_QB" | "CUSTOM";
export type SleeperLabel = "NONE" | "VALUE" | "SLEEPER" | "DEEP_STASH";

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
  marketScore?: number;
  modelScore?: number;
  modelMarketEdge?: number;
  marketSourceCount?: number;
  modelSourceCount?: number;
  modelSpread?: number;
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
  sleeperScore: number;
  sleeperLabel: SleeperLabel;
  sleeperBonus: number;
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

export type PlayerPoolIndex = {
  playerById: Map<number, DraftPlayer>;
  playersByPosition: Partial<Record<Position, DraftPlayer[]>>;
  replacements: Partial<Record<Position, number>>;
  projectionValues: Map<number, number>;
  rosterableMarket: DraftPlayer[];
  marketExtraByPosition: Record<string, number>;
};

export type DraftDecision = {
  recommendations: Recommendation[];
  auctionPlan: AuctionPlan;
};

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

const STARTER_SLOT_ELIGIBILITY: Record<string, Position[]> = {
  "0": ["QB"],
  "1": ["QB"],
  "2": ["RB"],
  "3": ["RB", "WR"],
  "4": ["WR"],
  "5": ["WR", "TE"],
  "6": ["TE"],
  "7": ["QB", "RB", "WR", "TE"],
  "16": ["DST"],
  "17": ["K"],
  "23": ["RB", "WR", "TE"],
};

const SKILL_POSITIONS = new Set<Position>(["QB", "RB", "WR", "TE"]);
const POSITION_LIMIT_KEYS: Record<Position, string[]> = {
  QB: ["QB", "1"],
  RB: ["RB", "2"],
  WR: ["WR", "3"],
  TE: ["TE", "4"],
  K: ["K", "5", "17"],
  DST: ["DST", "D/ST", "16"],
  FLEX: ["FLEX", "23"],
};

type StarterSlot = {
  eligible: Position[];
  slot: string;
};

export function positionLimitFor(league: LeagueSettings, position: Position) {
  const configured = POSITION_LIMIT_KEYS[position]
    .map((key) => Number(league.positionLimits?.[key]))
    .find((value) => Number.isInteger(value) && value >= 0);
  return configured === undefined ? Number.POSITIVE_INFINITY : configured;
}

function starterSlotsForLeague(league: LeagueSettings): StarterSlot[] {
  return Object.entries(league.lineupSlotCounts || {})
    .flatMap(([slot, count]) => {
      const eligible = STARTER_SLOT_ELIGIBILITY[slot];
      if (!eligible) return [];
      return Array.from({ length: Math.max(0, Math.floor(Number(count) || 0)) }, () => ({ eligible, slot }));
    })
    .sort((left, right) => left.eligible.length - right.eligible.length || Number(left.slot) - Number(right.slot));
}

function analyzeStarterSlots(league: LeagueSettings, rosterPositions: Position[]) {
  const slots = starterSlotsForLeague(league);
  const matchedPlayerBySlot = Array.from({ length: slots.length }, () => -1);

  function assign(playerIndex: number, visitedSlots: Set<number>): boolean {
    const position = rosterPositions[playerIndex];
    for (let slotIndex = 0; slotIndex < slots.length; slotIndex += 1) {
      if (visitedSlots.has(slotIndex) || !slots[slotIndex].eligible.includes(position)) continue;
      visitedSlots.add(slotIndex);
      const currentPlayer = matchedPlayerBySlot[slotIndex];
      if (currentPlayer === -1 || assign(currentPlayer, visitedSlots)) {
        matchedPlayerBySlot[slotIndex] = playerIndex;
        return true;
      }
    }
    return false;
  }

  rosterPositions.forEach((_, playerIndex) => assign(playerIndex, new Set()));
  const openSlots = slots.filter((_, slotIndex) => matchedPlayerBySlot[slotIndex] === -1);
  return { openSlots, total: slots.length };
}

export function openStarterSlots(league: LeagueSettings, rosterPositions: Position[]) {
  return analyzeStarterSlots(league, rosterPositions).openSlots.length;
}

function starterNeedAtPosition(league: LeagueSettings, rosterPositions: Position[], position: Position) {
  let currentPositions = [...rosterPositions];
  let currentOpen = openStarterSlots(league, currentPositions);
  let need = 0;
  while (currentOpen > 0 && currentPositions.length < league.rosterSize) {
    const nextPositions = [...currentPositions, position];
    const nextOpen = openStarterSlots(league, nextPositions);
    if (nextOpen >= currentOpen) break;
    need += 1;
    currentPositions = nextPositions;
    currentOpen = nextOpen;
  }
  return need;
}

function starterReserve(league: LeagueSettings, rosterPositions: Position[]) {
  return analyzeStarterSlots(league, rosterPositions).openSlots.reduce((reserve, slot) => {
    if (slot.eligible.length === 1 && ["K", "DST"].includes(slot.eligible[0])) return reserve + 1;
    if (slot.eligible.length === 1 && ["QB", "TE"].includes(slot.eligible[0])) return reserve + 3;
    return reserve + 4;
  }, 0);
}

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

function getReplacementPoints(playersByPosition: Partial<Record<Position, DraftPlayer[]>>, league: LeagueSettings) {
  const needs = starterNeeds(league);
  const result: Partial<Record<Position, number>> = {};
  for (const position of ["QB", "RB", "WR", "TE", "K", "DST"] as Position[]) {
    const pool = playersByPosition[position] || [];
    const flexShare = ["RB", "WR", "TE"].includes(position) ? Number(needs.FLEX || 0) / 3 : 0;
    const index = Math.max(0, Math.round(league.size * (Number(needs[position] || 0) + flexShare)) - 1);
    result[position] = pool[Math.min(index, pool.length - 1)]?.projected || 0;
  }
  return result;
}

function projectionAuctionValues(players: DraftPlayer[], league: LeagueSettings, replacements: Partial<Record<Position, number>>) {
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

export function buildPlayerPoolIndex(players: DraftPlayer[], league: LeagueSettings): PlayerPoolIndex {
  const playerById = new Map(players.map((player) => [player.id, player]));
  const playersByPosition = players.reduce<Partial<Record<Position, DraftPlayer[]>>>((pools, player) => {
    (pools[player.pos] ||= []).push(player);
    return pools;
  }, {});
  for (const pool of Object.values(playersByPosition)) {
    pool?.sort((left, right) => Number(right.projected || 0) - Number(left.projected || 0));
  }
  const replacements = getReplacementPoints(playersByPosition, league);
  const projectionValues = projectionAuctionValues(players, league, replacements);
  const rosterableMarket = [...players]
    .sort((left, right) => Number(right.auction || 0) - Number(left.auction || 0))
    .slice(0, Math.max(1, league.size * league.rosterSize));
  const marketExtraByPosition = rosterableMarket.reduce<Record<string, number>>((totals, player) => {
    totals[player.pos] = Number(totals[player.pos] || 0) + Math.max(0, Number(player.auction || 1) - 1);
    return totals;
  }, {});
  return { playerById, playersByPosition, replacements, projectionValues, rosterableMarket, marketExtraByPosition };
}

function normalizedTeamName(value: string) {
  return String(value || "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

function openSlotsFromLiveBudget(budget: LiveAuctionBudget, rosterSize: number) {
  // ESPN reports a $0 max offer both when a roster is full and when a practice
  // bot has exhausted its budget before filling every slot. Remaining dollars
  // disambiguate the full-roster sentinel; $0/$0 must fall back to actual picks.
  if (Number(budget.maxOffer) <= 0) return Number(budget.remaining) > 0 ? 0 : null;
  return Math.max(0, Math.min(rosterSize, Number(budget.remaining) - Number(budget.maxOffer) + 1));
}

export function buildAuctionPlan(
  players: DraftPlayer[],
  picks: DraftPick[],
  league: LeagueSettings,
  strategy: StrategyId,
  liveBudgets: LiveAuctionBudget[] = [],
  playerPool = buildPlayerPoolIndex(players, league),
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
  const { marketExtraByPosition, playerById, rosterableMarket } = playerPool;
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

  const picksByTeam = picks.reduce<Map<number, DraftPick[]>>((grouped, pick) => {
    const teamPicks = grouped.get(pick.teamId) || [];
    teamPicks.push(pick);
    grouped.set(pick.teamId, teamPicks);
    return grouped;
  }, new Map());
  const spentByPosition: Record<string, number> = { QB: 0, RB: 0, WR: 0, TE: 0, FLEX: 0, K: 0, DST: 0, BN: 0 };
  for (const pick of picksByTeam.get(Number(league.teamId)) || []) {
    const position = playerById.get(pick.playerId)?.pos;
    if (position) spentByPosition[position] = Number(spentByPosition[position] || 0) + Math.max(0, pick.amount);
  }

  const totalLeagueBudget = Math.max(1, league.size * league.auctionBudget);
  const rosterableMarketTotal = rosterableMarket.reduce((sum, player) => sum + Math.max(1, Number(player.auction || 1)), 0) || 1;
  const marketScale = totalLeagueBudget / rosterableMarketTotal;
  const expectedMarketValue = new Map(rosterableMarket.map((player) => [player.id, Math.max(1, Number(player.auction || 1)) * marketScale]));
  const marketPicks = picks.flatMap((pick) => {
    const player = playerById.get(pick.playerId);
    const expected = expectedMarketValue.get(pick.playerId);
    return player && expected ? [{ actual: Math.max(0, pick.amount), expected, position: player.pos }] : [];
  });
  const pricedMarketPicks = marketPicks.filter((pick) => pick.actual > 0);
  const normalizedLiveBudgets = new Map(liveBudgets.map((budget) => [normalizedTeamName(budget.teamName), budget]));
  const opponents = league.teams.filter((team) => team.id !== league.teamId).map((team) => {
    const teamPicks = picksByTeam.get(team.id) || [];
    const pricedTeamPicks = teamPicks.filter((pick) => pick.amount > 0);
    const liveBudget = normalizedLiveBudgets.get(normalizedTeamName(team.name || team.abbrev || ""));
    const spent = liveBudget ? Math.max(0, league.auctionBudget - liveBudget.remaining) : pricedTeamPicks.reduce((sum, pick) => sum + pick.amount, 0);
    const liveOpenSlots = liveBudget ? openSlotsFromLiveBudget(liveBudget, league.rosterSize) : null;
    const playersRostered = liveOpenSlots === null ? teamPicks.length : Math.max(0, league.rosterSize - liveOpenSlots);
    const openSlots = Math.max(0, league.rosterSize - playersRostered);
    const positions = teamPicks.reduce<Record<string, number>>((counts, pick) => {
      const position = playerById.get(pick.playerId)?.pos;
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
        if (openSlots !== null) return sum + Math.max(0, league.rosterSize - openSlots);
        const team = league.teams.find((candidate) => normalizedTeamName(candidate.name || candidate.abbrev || "") === normalizedTeamName(budget.teamName));
        return sum + (team ? (picksByTeam.get(team.id) || []).length : 0);
      }, 0)
    : 0;
  const roomPlayers = Math.max(picks.length, liveRoomPlayers);
  const knownSaleCoverage = roomPlayers > 0 ? Math.min(1, pricedMarketPicks.length / roomPlayers) : 1;
  const marketCoverage = roomPlayers > 0 ? Math.min(1, marketPicks.length / roomPlayers) : 1;
  const hasCompleteLiveBudgets = liveBudgets.length >= league.size;
  const actualSpend = hasCompleteLiveBudgets
    ? liveBudgets.reduce((sum, budget) => sum + Math.max(0, league.auctionBudget - Number(budget.remaining)), 0)
    : pricedMarketPicks.reduce((sum, pick) => sum + pick.actual, 0);
  const expectedSpend = marketPicks.reduce((sum, pick) => sum + pick.expected, 0);
  const inflationReady = marketPicks.length > 0
    && marketCoverage >= .8
    && (hasCompleteLiveBudgets || knownSaleCoverage >= .8);
  // Correct sequential-auction inflation compares dollars remaining with the
  // source-backed value remaining. Early overpayment therefore lowers later
  // prices; it must never raise our walk-away ceiling.
  const roomInflation = inflationReady && totalLeagueBudget > expectedSpend
    ? Math.max(.75, Math.min(1.25, (totalLeagueBudget - actualSpend) / (totalLeagueBudget - expectedSpend)))
    : 1;
  const observedByPosition = pricedMarketPicks.reduce<Record<string, typeof pricedMarketPicks>>((grouped, pick) => {
    (grouped[pick.position] ||= []).push(pick);
    return grouped;
  }, {});
  const positionMarketTotals = rosterableMarket.reduce<Record<string, number>>((totals, player) => {
    totals[player.pos] = Number(totals[player.pos] || 0) + Number(expectedMarketValue.get(player.id) || 0);
    return totals;
  }, {});
  const positionInflation = Object.fromEntries(["QB", "RB", "WR", "TE", "K", "DST"].map((position) => {
    const positionPicks = observedByPosition[position] || [];
    const actual = positionPicks.reduce((sum, pick) => sum + pick.actual, 0);
    const expected = positionPicks.reduce((sum, pick) => sum + pick.expected, 0);
    const positionMarketTotal = Number(positionMarketTotals[position] || 0);
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

export function auctionBudgetUsage(plan: AuctionPlan) {
  const usage = Object.fromEntries(Object.entries(plan.positionBudgets).map(([position, budget]) => [
    position,
    Math.min(Number(budget || 0), Number(plan.spentByPosition[position] || 0)),
  ]));
  const skillOverflow = (["RB", "WR", "TE"] as Position[]).reduce((sum, position) =>
    sum + Math.max(0, Number(plan.spentByPosition[position] || 0) - Number(plan.positionBudgets[position] || 0)), 0);
  usage.FLEX = Math.min(Number(plan.positionBudgets.FLEX || 0), Number(usage.FLEX || 0) + skillOverflow);
  const totalSpend = Object.values(plan.spentByPosition).reduce((sum, amount) => sum + Number(amount || 0), 0);
  const allocatedSpend = Object.values(usage).reduce((sum, amount) => sum + Number(amount || 0), 0);
  return { reallocated: Math.max(0, totalSpend - allocatedSpend), usage };
}

function calculateMaxBid(
  league: LeagueSettings,
  mySpend: number,
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

type SleeperEvidence = {
  score: number;
  label: SleeperLabel;
};

function classifySleeper(
  player: DraftPlayer,
  league: LeagueSettings,
  vorp: number,
  maxVorp: number,
  scarcity: number,
  maxAvailableProjection: number,
): SleeperEvidence {
  const sourceCount = Number(player.sourceCount || 0);
  const modelSourceCount = Number(player.modelSourceCount || 0);
  const marketSourceCount = Number(player.marketSourceCount || 0);
  const modelSpread = Number(player.modelSpread ?? Number.POSITIVE_INFINITY);
  const modelMarketEdge = Number(player.modelMarketEdge || 0);
  const marketAdp = Number(player.adp);
  const skillPosition = ["QB", "RB", "WR", "TE"].includes(player.pos);
  const corroborated = skillPosition
    && !player.injured
    && sourceCount >= 4
    && modelSourceCount === 2
    && marketSourceCount >= 2
    && modelSpread <= 12
    && Number.isFinite(marketAdp)
    && marketAdp < 900
    && vorp > 0;

  if (!corroborated || modelMarketEdge <= 0) return { score: 0, label: "NONE" };

  const edgeComponent = percentile(modelMarketEdge, 0, 30) * 45;
  const vorpComponent = percentile(vorp, 0, maxVorp) * 25;
  const scarcityComponent = percentile(scarcity, 0, maxAvailableProjection * .2) * 10;
  const coverageComponent = percentile(sourceCount, 3, 5) * 10;
  const agreementComponent = percentile(12 - modelSpread, 0, 12) * 10;
  const score = Math.round(Math.max(0, Math.min(100,
    edgeComponent + vorpComponent + scarcityComponent + coverageComponent + agreementComponent,
  )));

  if (modelMarketEdge < 8 || score < 50) return { score, label: "NONE" };
  const marketRound = marketAdp / Math.max(1, league.size);
  if (marketRound >= 10 && score >= 55) return { score, label: "DEEP_STASH" };
  if (marketRound >= 6) return { score, label: "SLEEPER" };
  return { score, label: "VALUE" };
}

function sleeperDecisionBonus(
  sleeper: SleeperEvidence,
  player: DraftPlayer,
  league: LeagueSettings,
  currentPick: number,
  auctionPlan: AuctionPlan,
) {
  if (sleeper.label === "NONE") return 0;
  if (sleeper.label === "VALUE") return Math.min(3, sleeper.score * .04);

  if (league.draftType === "SNAKE") {
    // Surface sleepers throughout the draft, but do not spend draft capital
    // more than one league round before the blended market expects them to go.
    if (Number(player.adp) > currentPick + league.size) return 0;
    return Math.min(sleeper.label === "DEEP_STASH" ? 8 : 7, sleeper.score * .09);
  }

  const roomPhase = auctionPlan.roomPlayers / Math.max(1, league.size * league.rosterSize);
  // Keep high-upside names private while opponents still have broad leverage;
  // the existing fair-value and reserve ceilings remain unchanged at all times.
  if (sleeper.label === "DEEP_STASH" && roomPhase < .72) return 0;
  if (sleeper.label === "SLEEPER" && roomPhase < .55) return 0;
  return Math.min(sleeper.label === "DEEP_STASH" ? 8 : 7, sleeper.score * .09);
}

export function recommendPlayers(
  players: DraftPlayer[],
  picks: DraftPick[],
  league: LeagueSettings,
  strategy: StrategyId,
  overallPick = picks.length + 1,
  liveBudgets: LiveAuctionBudget[] = [],
  playerPool = buildPlayerPoolIndex(players, league),
  auctionPlanOverride?: AuctionPlan,
): Recommendation[] {
  const draftedIds = new Set(picks.map((pick) => pick.playerId));
  const available = players.filter((player) => !draftedIds.has(player.id));
  const myPicks = picks.filter((pick) => pick.teamId === league.teamId);
  const mySpend = myPicks.reduce((sum, pick) => sum + pick.amount, 0);
  const myRoster = myPicks.map((pick) => playerPool.playerById.get(pick.playerId)).filter(Boolean) as DraftPlayer[];
  const needs = starterNeeds(league);
  const rosterCounts = myRoster.reduce<Partial<Record<Position, number>>>((counts, rosterPlayer) => {
    counts[rosterPlayer.pos] = Number(counts[rosterPlayer.pos] || 0) + 1;
    return counts;
  }, {});
  // Kicker and defense are single-roster strategy positions. A large score
  // penalty is not a sufficient safety boundary in a depleted final-round
  // player pool, so snake drafts remove duplicate specialists entirely.
  // Salary-cap keeps them visible at a zero-dollar ceiling so the nomination
  // model can use them as drains without ever acquiring a second specialist.
  const withinEspnPositionCaps = available.filter((player) => (
    Number(rosterCounts[player.pos] || 0) < positionLimitFor(league, player.pos)
  ));
  const strategicallyAvailable = league.draftType === "SNAKE"
    ? withinEspnPositionCaps.filter((player) => !(["K", "DST"].includes(player.pos) && Number(rosterCounts[player.pos] || 0) >= 1))
    : withinEspnPositionCaps;
  const rosterPositions = myRoster.map((player) => player.pos);
  const starterPositions = ["QB", "RB", "WR", "TE", "K", "DST"] as Position[];
  const starterNeedsByPosition = Object.fromEntries(starterPositions.map((position) => [
    position,
    starterNeedAtPosition(league, rosterPositions, position),
  ])) as Record<Position, number>;
  const starterReserveByPosition = Object.fromEntries(starterPositions.map((position) => [
    position,
    starterReserve(league, [...rosterPositions, position]),
  ])) as Record<Position, number>;
  const coreSkillOpen = (["QB", "RB", "WR", "TE"] as Position[]).some((position) => starterNeedsByPosition[position] > 0);
  const mandatoryOpenStarters = openStarterSlots(league, rosterPositions);
  const remainingRosterSlots = Math.max(0, league.rosterSize - myRoster.length);
  const endgameLineupLock = mandatoryOpenStarters > 0 && remainingRosterSlots <= mandatoryOpenStarters + 1;
  const { replacements, projectionValues } = playerPool;
  const projectedValues = strategicallyAvailable.map((player) => player.projected || Math.max(1, 350 - player.rank * 2));
  const minProjection = Math.min(...projectedValues, 0);
  const maxProjection = Math.max(...projectedValues, 1);
  const provisionalVorp = strategicallyAvailable.map((player) => Math.max(0, (player.projected || 0) - Number(replacements[player.pos] || 0)));
  const maxVorp = Math.max(...provisionalVorp, 1);
  const maxAvailableProjection = Math.max(...strategicallyAvailable.map((candidate) => candidate.projected || 0), 1);
  const currentPick = Math.max(picks.length + 1, Number(overallPick) || 1);
  const recentPositionDemand = picks.slice(-Math.max(4, league.size)).reduce<Partial<Record<Position, number>>>((counts, pick) => {
    const position = playerPool.playerById.get(pick.playerId)?.pos;
    if (position) counts[position] = Number(counts[position] || 0) + 1;
    return counts;
  }, {});
  const auctionPlan = auctionPlanOverride || (league.draftType === "AUCTION"
    ? buildAuctionPlan(players, picks, league, strategy, liveBudgets, playerPool)
    : emptyAuctionPlan(league));
  const eligibleOverspend = (["RB", "WR", "TE"] as Position[]).reduce((sum, position) =>
    sum + Math.max(0, Number(auctionPlan.spentByPosition[position] || 0) - Number(auctionPlan.positionBudgets[position] || 0)), 0);
  const availableFlexBudget = Math.max(0, Number(auctionPlan.positionBudgets.FLEX || 0) - eligibleOverspend);

  const availableByPosition = Object.fromEntries(Object.entries(playerPool.playersByPosition).map(([position, positionPlayers]) => [
    position,
    (positionPlayers || []).filter((player) => !draftedIds.has(player.id)),
  ])) as Partial<Record<Position, DraftPlayer[]>>;
  const positionIndexByPlayer = new Map<number, number>();
  for (const positionPool of Object.values(availableByPosition)) {
    positionPool?.forEach((player, index) => positionIndexByPlayer.set(player.id, index));
  }

  return strategicallyAvailable.map((player) => {
    const positionPool = availableByPosition[player.pos] || [];
    const positionIndex = positionIndexByPlayer.get(player.id) || 0;
    const nextAtPosition = positionPool[Math.min(positionPool.length - 1, positionIndex + Math.max(1, Math.floor(league.size / 2)))];
    const vorp = Math.max(0, (player.projected || 0) - Number(replacements[player.pos] || 0));
    const scarcity = Math.max(0, (player.projected || 0) - (nextAtPosition?.projected || 0));
    const rosteredAtPosition = Number(rosterCounts[player.pos] || 0);
    const requiredAtPosition = Number(needs[player.pos] || 0);
    const need = requiredAtPosition > rosteredAtPosition ? 1 : 0;
    const singleStarterPosition = requiredAtPosition > 0 && requiredAtPosition <= 1;
    // OP contributes a fractional need to every eligible position so VORP can
    // compare them fairly, but that fraction must not disable roster caps. A
    // team can start at most its dedicated QBs plus its OP slots; after that,
    // another QB is pure bench depth. Preserve one backup in ordinary 1-QB
    // leagues while preventing a QB+OP league from accumulating a third QB.
    const quarterbackStarterCapacity = Number(league.lineupSlotCounts?.["0"] || 0)
      + Number(league.lineupSlotCounts?.["7"] || 0);
    const quarterbackDepthCap = Math.max(2, quarterbackStarterCapacity);
    const hardSaturation = (player.pos === "QB" && rosteredAtPosition >= quarterbackDepthCap)
      || (player.pos === "TE" && singleStarterPosition && rosteredAtPosition >= 2)
      || (["K", "DST"].includes(player.pos) && rosteredAtPosition >= 1);
    const saturationPenalty = hardSaturation
      ? 1_000
      : player.pos === "QB" && singleStarterPosition && rosteredAtPosition >= 1
        ? coreSkillOpen ? 70 : 38
        : player.pos === "TE" && singleStarterPosition && rosteredAtPosition >= 1
          ? coreSkillOpen ? 48 : 24
          : 0;
    const fillsMandatoryStarter = Number(starterNeedsByPosition[player.pos] || 0) > 0;
    const endgameLineupBonus = endgameLineupLock && fillsMandatoryStarter ? 140 : 0;
    const endgameLineupPenalty = endgameLineupLock && !fillsMandatoryStarter ? 1_000 : 0;
    // K/DST projections in custom ESPN scoring can look comparable to skill
    // positions even though replacement supply remains deep. Keep both picks
    // and bids locked until the final three roster spots, except when the
    // mandatory-completion boundary requires the specialist immediately.
    const specialistTooEarly = ["K", "DST"].includes(player.pos)
      && myRoster.length < Math.max(league.rosterSize - 3, 6)
      && !endgameLineupLock;
    const configuredStrategyMultiplier = STRATEGY_WEIGHTS[strategy][player.pos] || 1;
    // Presets shape roster construction, but a late preset discount must not
    // keep suppressing a still-empty mandatory skill slot. This deliberately
    // leaves the first 55% of the draft untouched and never changes K/DST
    // timing or any salary-cap walk-away boundary.
    const lateMandatorySkillSlot = SKILL_POSITIONS.has(player.pos)
      && fillsMandatoryStarter
      && myRoster.length / Math.max(1, league.rosterSize) >= .55;
    const strategyMultiplier = lateMandatorySkillSlot
      ? Math.max(.9, configuredStrategyMultiplier)
      : configuredStrategyMultiplier;
    // Keep bidding economics on the configured preset. The late score clamp
    // changes only recommendation order; it cannot increase a max bid.
    const needMultiplier = Math.max(.72, 1 + need * .16) * configuredStrategyMultiplier;
    const adpValue = Number.isFinite(player.adp) && player.adp < 900 ? Math.max(-20, Math.min(20, currentPick - player.adp)) : 0;
    const projectionScore = percentile(player.projected || Math.max(1, 350 - player.rank * 2), minProjection, maxProjection) * 30;
    const vorpScore = percentile(vorp, 0, maxVorp) * 25;
    const scarcityScore = percentile(scarcity, 0, maxAvailableProjection * .2) * 13;
    const consensusScore = Number(player.consensusScore ?? Math.max(0, 100 - player.rank)) * .18;
    const adpScore = percentile(adpValue, -20, 20) * 8;
    const needScore = need * 10;
    const positionRunBonus = fillsMandatoryStarter ? Math.min(12, Number(recentPositionDemand[player.pos] || 0) * 3) : 0;
    const injuryPenalty = player.injured ? 12 : 0;
    const latePositionPenalty = specialistTooEarly ? 1_000 : 0;
    const sleeper = classifySleeper(player, league, vorp, maxVorp, scarcity, maxAvailableProjection);
    const sleeperBonus = sleeperDecisionBonus(sleeper, player, league, currentPick, auctionPlan);
    const score = (projectionScore + vorpScore + scarcityScore + consensusScore + adpScore + needScore + positionRunBonus) * strategyMultiplier
      + sleeperBonus + endgameLineupBonus - injuryPenalty - latePositionPenalty - saturationPenalty - endgameLineupPenalty;
    const projectionValue = Number(projectionValues.get(player.id) || 1);
    const fairValue = Math.max(1, Number(player.auction || 1) * .65 + projectionValue * .35);
    const benchReserve = Math.max(0, remainingRosterSlots - mandatoryOpenStarters - 1);
    const strategicRosterReserve = Number(starterReserveByPosition[player.pos] || 0) + benchReserve;
    const primaryBudgetRemaining = Math.max(
      0,
      Number(auctionPlan.positionBudgets[player.pos] || 0) - Number(auctionPlan.spentByPosition[player.pos] || 0),
    );
    const positionPortfolioWalkAway = Math.max(
      1,
      Math.floor(primaryBudgetRemaining + (["RB", "WR", "TE"].includes(player.pos) ? availableFlexBudget : 0)),
    );
    const globalValueWalkAway = Math.max(1, league.auctionBudget - mySpend - Math.max(0, remainingRosterSlots - 1));
    const canReallocateToDepth = !coreSkillOpen && ["RB", "WR", "TE"].includes(player.pos);
    const depthCap = !fillsMandatoryStarter && ["QB", "TE"].includes(player.pos) && rosteredAtPosition >= 1 ? 3 : Number.POSITIVE_INFINITY;
    const portfolioWalkAway = Math.min(
      canReallocateToDepth ? globalValueWalkAway : positionPortfolioWalkAway,
      depthCap,
    );
    const mustPreserveFinalStarterSlots = league.draftType === "AUCTION" && endgameLineupLock && !fillsMandatoryStarter;
    const marketInflation = Number(auctionPlan.positionInflation[player.pos] || 1) * .7 + auctionPlan.roomInflation * .3;
    const calculatedMaxBid = hardSaturation || specialistTooEarly || mustPreserveFinalStarterSlots
      ? 0
      : calculateMaxBid(
        league,
        mySpend,
        myRoster.length,
        fairValue,
        needMultiplier * (saturationPenalty ? .35 : 1),
        strategicRosterReserve,
        marketInflation,
        scarcity,
        Number(recentPositionDemand[player.pos] || 0),
        auctionPlan.endgameReserve,
      );
    // Need and scarcity decide *which* player to pursue, but they cannot turn a
    // source-backed price into an emotional bidding war. Preserve a small 10%
    // strategic premium after the observed room/position market adjustment.
    const sourceValueCeiling = Math.max(1, Math.ceil(fairValue * Math.max(.8, Math.min(1.2, marketInflation)) * 1.1));
    const maxBid = hardSaturation || specialistTooEarly || mustPreserveFinalStarterSlots
      ? 0
      : Math.min(calculatedMaxBid, portfolioWalkAway, sourceValueCeiling);
    const targetBid = maxBid > 0 ? Math.max(1, Math.min(maxBid, Math.round(fairValue * .92))) : 0;
    const portfolioPenalty = league.draftType === "AUCTION" && portfolioWalkAway <= 1 && !fillsMandatoryStarter ? 120 : 0;
    const reasons = [
      ...(sleeper.label !== "NONE"
        ? [`${sleeper.label === "DEEP_STASH" ? "Deep-stash" : sleeper.label === "SLEEPER" ? "Sleeper" : "Value"} signal ${sleeper.score}/100: both model feeds agree on a ${Number(player.modelMarketEdge || 0).toFixed(1)}-point edge over the ESPN/FFC/MFL market`]
        : []),
      vorp > 0 ? `${vorp.toFixed(1)} points above positional replacement` : "Depth-based value at this stage",
      scarcity > 8 ? `A ${scarcity.toFixed(1)}-point tier drop is approaching` : "No severe tier cliff immediately behind him",
      fillsMandatoryStarter ? `Fills an open ${player.pos} starter slot` : saturationPenalty ? `${player.pos} depth is already saturated` : `Adds value without forcing roster need`,
      adpValue > 3 ? `${adpValue.toFixed(1)} picks past ESPN market value` : adpValue < -3 ? `${Math.abs(adpValue).toFixed(1)} picks ahead of ESPN market` : `Priced close to ESPN market`,
      positionRunBonus ? `${recentPositionDemand[player.pos]} ${player.pos}s left the board in the last ${Math.max(4, league.size)} picks` : "No urgent opponent run at this position",
      player.sourceCount ? `${player.sourceCount}/5 public sources matched; ${player.rankSpread && player.rankSpread > 12 ? "market disagreement is elevated" : "source agreement is stable"}` : "ESPN-only until public sources refresh",
      `Fair value blends the five-source market ($${Math.round(player.auction || 1)}) with scoring-adjusted VORP ($${Math.round(projectionValue)})`,
    ];
    return {
      ...player,
      score: score - portfolioPenalty,
      confidence: 0,
      vorp,
      scarcity,
      need,
      adpValue,
      projectionValue,
      fairValue,
      targetBid,
      maxBid,
      fillsMandatoryStarter,
      sleeperScore: sleeper.score,
      sleeperLabel: sleeper.label,
      sleeperBonus,
      reasons,
    };
  }).sort((a, b) => b.score - a.score).map((player, index, ranked) => ({
    ...player,
    confidence: Math.round(Math.max(55, Math.min(97, 58 + (player.score - (ranked[1]?.score || player.score - 8)) * 1.4 + Number(player.consensusConfidence || 60) * .2 - index * .4))),
  }));
}

function emptyAuctionPlan(league: LeagueSettings): AuctionPlan {
  return {
    positionBudgets: {},
    spentByPosition: {},
    roomInflation: 1,
    opponentSpend: 0,
    opponentPlayers: 0,
    minimumRosterReserve: Math.max(0, league.rosterSize),
    endgameReserve: 0,
    roomPlayers: 0,
    knownSaleCoverage: 1,
    positionInflation: {},
    opponents: [],
  };
}

export function buildDraftDecision(
  players: DraftPlayer[],
  picks: DraftPick[],
  league: LeagueSettings,
  strategy: StrategyId,
  overallPick = picks.length + 1,
  liveBudgets: LiveAuctionBudget[] = [],
  playerPool = buildPlayerPoolIndex(players, league),
): DraftDecision {
  const auctionPlan = league.draftType === "AUCTION"
    ? buildAuctionPlan(players, picks, league, strategy, liveBudgets, playerPool)
    : emptyAuctionPlan(league);
  return {
    auctionPlan,
    recommendations: recommendPlayers(players, picks, league, strategy, overallPick, liveBudgets, playerPool, auctionPlan),
  };
}

export function chooseAuctionNomination(
  recommendations: Recommendation[],
  league: LeagueSettings,
  plan: AuctionPlan,
): AuctionNomination | null {
  if (league.draftType !== "AUCTION") return null;
  const totalRosterSpots = Math.max(1, league.size * league.rosterSize);
  const roomPhase = Math.max(0, Math.min(1, plan.roomPlayers / totalRosterSpots));
  const legalTargets = recommendations.filter((player) => player.maxBid >= 1 && !["K", "DST"].includes(player.pos));
  const target = (roomPhase < .72
    ? legalTargets.find((player) => !["SLEEPER", "DEEP_STASH"].includes(player.sleeperLabel))
    : legalTargets[0])
    || legalTargets[0]
    || recommendations.find((player) => player.maxBid >= 1);
  if (!target) return null;
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
      && !["SLEEPER", "DEEP_STASH"].includes(player.sleeperLabel)
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
