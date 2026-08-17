import { createHash } from "node:crypto";
import {
  buildDraftDecision,
  buildPlayerPoolIndex,
  chooseAuctionNomination,
  openStarterSlots,
} from "../app/lib/draft-engine.ts";
import { mergeConsensus } from "../app/lib/consensus.ts";
import { replayConsensusSnapshot, sourceSnapshotDigest } from "./source-snapshot.mjs";

const POSITIONS = ["QB", "RB", "WR", "TE", "K", "DST"];
const SKILL_POSITIONS = new Set(["QB", "RB", "WR", "TE"]);
const SPECIALISTS = new Set(["K", "DST"]);
const STRATEGIES = ["BALANCED", "HERO_RB", "ZERO_RB", "ELITE_QB"];
const SOURCE_IDS = ["espn", "ffc", "mfl", "tradyr", "gng"];
const METRIC_KEYS = [
  "startingLineupProjection",
  "totalProjection",
  "vorp",
  "positionalScarcity",
  "rosterFragility",
  "marketSurplus",
  "sleeperAcquisitionValue",
  "sleeperTiming",
  "remainingBudgetEfficiency",
  "sourceConfidenceDownside",
  "seasonWinProbability",
  "decisionRegret",
  "highRegretDecisions",
  "objective",
];

export const OPPONENT_ARCHETYPES = {
  snake: [
    "ADP_FOLLOWER",
    "PROJECTION_VORP",
    "NEED_BASED",
    "POSITION_RUN_CHASER",
    "SLEEPER_HUNTER",
    "NOISY_HUMAN",
  ],
  "salary-cap": [
    "STARS_AND_SCRUBS",
    "BALANCED_BIDDER",
    "BARGAIN_HUNTER",
    "SLEEPER_HUNTER",
    "PRICE_ENFORCER",
    "NOISY_HUMAN",
    "ADP_FOLLOWER",
    "PROJECTION_VORP",
    "NEED_BASED",
    "POSITION_RUN_CHASER",
  ],
};

const SLOT_ELIGIBILITY = {
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

const REAL_LEAGUES = {
  snake: {
    id: "1603083723",
    name: "SOMFAB (sanitized authenticated settings)",
    season: 2026,
    size: 10,
    draftType: "SNAKE",
    secondsPerPick: 30,
    rosterSize: 16,
    auctionBudget: 200,
    lineupSlotCounts: { "0": 1, "2": 2, "3": 1, "4": 2, "6": 1, "7": 1, "16": 1, "17": 1, "20": 6 },
    positionLimits: { QB: 4, RB: 8, WR: 8, TE: 3, K: 1, DST: 1 },
    scoringLabel: "Standard",
    scoringRules: 0,
    keeperCount: 0,
  },
  "salary-cap": {
    id: "44050",
    name: "Bienvenido a Miami (sanitized authenticated settings)",
    season: 2026,
    size: 12,
    draftType: "AUCTION",
    secondsPerPick: 60,
    rosterSize: 14,
    auctionBudget: 200,
    lineupSlotCounts: { "0": 1, "2": 1, "4": 1, "7": 1, "16": 1, "17": 1, "23": 2, "20": 6 },
    positionLimits: { QB: 4, RB: 8, WR: 8, TE: 3, K: 1, DST: 1 },
    scoringLabel: "PPR",
    scoringRules: 45,
    keeperCount: 2,
  },
};

class SeededRandom {
  constructor(seed) {
    this.state = Number(seed) >>> 0 || 0x6d2b79f5;
    this.cachedNormal = null;
  }

  next() {
    let value = this.state += 0x6d2b79f5;
    value = Math.imul(value ^ value >>> 15, value | 1);
    value ^= value + Math.imul(value ^ value >>> 7, value | 61);
    return ((value ^ value >>> 14) >>> 0) / 4294967296;
  }

  int(maximum) {
    return Math.floor(this.next() * Math.max(1, maximum));
  }

  pick(values) {
    return values[this.int(values.length)];
  }

  normal() {
    if (this.cachedNormal !== null) {
      const value = this.cachedNormal;
      this.cachedNormal = null;
      return value;
    }
    const left = Math.max(Number.EPSILON, this.next());
    const right = this.next();
    const magnitude = Math.sqrt(-2 * Math.log(left));
    this.cachedNormal = magnitude * Math.sin(2 * Math.PI * right);
    return magnitude * Math.cos(2 * Math.PI * right);
  }
}

function hashSeed(value) {
  let hash = 2166136261;
  for (const character of String(value)) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

export function deriveTrialSeed(baseSeed, format, trialIndex) {
  return hashSeed(`${Number(baseSeed) >>> 0}:${format}:${trialIndex}`);
}

export function splitForTrial(trialIndex, drafts) {
  const discoveryEnd = Math.floor(drafts * .6);
  const validationEnd = Math.floor(drafts * .8);
  if (trialIndex < discoveryEnd) return "discovery";
  if (trialIndex < validationEnd) return "validation";
  return "holdout";
}

function makeTeams(size) {
  return Array.from({ length: size }, (_, index) => ({
    id: index + 1,
    name: `Monte Carlo Team ${index + 1}`,
    abbrev: `MC${index + 1}`,
  }));
}

function adversarialLeague(format, rng) {
  if (format === "snake") {
    const variants = [
      { size: 8, rosterSize: 16, lineupSlotCounts: { "0": 1, "2": 2, "4": 3, "6": 1, "16": 1, "17": 1, "20": 7 }, scoringLabel: "Full PPR" },
      { size: 12, rosterSize: 16, lineupSlotCounts: { "0": 1, "2": 2, "3": 1, "4": 2, "6": 1, "7": 1, "16": 1, "17": 1, "20": 6 }, scoringLabel: "Half PPR Superflex" },
      { size: 14, rosterSize: 15, lineupSlotCounts: { "0": 1, "2": 2, "4": 2, "6": 1, "16": 1, "17": 1, "23": 2, "20": 5 }, scoringLabel: "Deep Standard" },
    ];
    return { ...rng.pick(variants), auctionBudget: 200 };
  }
  const variants = [
    { size: 10, rosterSize: 16, auctionBudget: 200, lineupSlotCounts: { "0": 1, "2": 2, "4": 2, "6": 1, "16": 1, "17": 1, "23": 1, "20": 7 }, scoringLabel: "Full PPR" },
    { size: 12, rosterSize: 14, auctionBudget: 100, lineupSlotCounts: { "0": 1, "2": 1, "4": 1, "6": 1, "16": 1, "17": 1, "23": 2, "20": 6 }, scoringLabel: "Half PPR" },
    { size: 14, rosterSize: 15, auctionBudget: 250, lineupSlotCounts: { "0": 1, "2": 2, "4": 2, "6": 1, "7": 1, "16": 1, "17": 1, "23": 1, "20": 6 }, scoringLabel: "Superflex Points" },
    ];
  return rng.pick(variants);
}

export function makeLeagueScenario(format, trialIndex, trialSeed) {
  const rng = new SeededRandom(hashSeed(`${trialSeed}:league`));
  const realSettings = trialIndex % 5 !== 4;
  const source = realSettings ? REAL_LEAGUES[format] : {
    ...REAL_LEAGUES[format],
    ...adversarialLeague(format, rng),
  };
  const league = {
    ...source,
    id: realSettings ? source.id : `${source.id}-adversarial-${trialIndex}`,
    name: realSettings ? source.name : `${source.name} adversarial variant`,
    teamId: 1,
    pickOrder: [],
    teams: makeTeams(source.size),
    positionLimits: { QB: 4, RB: 9, WR: 9, TE: 4, K: 1, DST: 1, ...source.positionLimits },
  };
  return {
    league,
    scenario: realSettings ? "saved-authenticated-settings" : "adversarial-espn-compatible",
    realSettings,
  };
}

function approximateReplacement(position) {
  return { QB: 245, RB: 145, WR: 140, TE: 105, K: 92, DST: 96 }[position] || 0;
}

function makeRawPlayers(rng) {
  // Keep a full undrafted buffer behind the deepest 14-team adversarial room.
  // A merely roster-sized pool can strand otherwise legal teams at position
  // caps when noisy opponents consume an asymmetric share of one position.
  const counts = { QB: 44, RB: 82, WR: 82, TE: 40, K: 24, DST: 24 };
  const base = { QB: 390, RB: 325, WR: 320, TE: 260, K: 155, DST: 165 };
  const decay = { QB: 4.2, RB: 2.25, WR: 2.2, TE: 3.15, K: 1.65, DST: 1.8 };
  const raw = [];
  let id = 1;
  for (const position of POSITIONS) {
    for (let depth = 0; depth < counts[position]; depth += 1) {
      const sourceProjection = Math.max(35, base[position] - depth * decay[position] + rng.normal() * 3.2);
      const uncertainty = SKILL_POSITIONS.has(position) ? .045 : .07;
      const sleeperCandidate = ["RB", "WR", "TE"].includes(position)
        && depth >= 10
        && depth <= 24
        && depth % 5 === 1;
      raw.push({
        id: id++,
        name: `${position} Monte Carlo ${depth + 1}`,
        team: `NFL${(depth % 32) + 1}`,
        pos: position,
        depthIndex: depth,
        projected: sourceProjection,
        trueProjection: Math.max(20, sourceProjection * (1 + rng.normal() * uncertainty)),
        marketNoise: rng.normal() * 2,
        injured: false,
        sleeperCandidate,
      });
    }
  }
  const marketOrder = [...raw].sort((left, right) => {
    const leftValue = left.projected - approximateReplacement(left.pos) + left.marketNoise - (left.sleeperCandidate ? 45 : 0);
    const rightValue = right.projected - approximateReplacement(right.pos) + right.marketNoise - (right.sleeperCandidate ? 45 : 0);
    return rightValue - leftValue || left.id - right.id;
  });
  const rankById = new Map(marketOrder.map((player, index) => [player.id, index + 1]));
  return raw.map((player) => {
    const rank = rankById.get(player.id);
    return {
      ...player,
      rank,
      adp: Math.max(1, rank + rng.normal() * 3.5),
      auction: Math.max(1, Math.round(64 * Math.exp(-(rank - 1) / 39))),
      sleeperCandidate: player.sleeperCandidate,
    };
  });
}

function rankedSourcePlayers(players, sourceId, rng) {
  const isModel = sourceId === "tradyr" || sourceId === "gng";
  const noiseById = new Map(players.map((player) => [player.id, rng.normal() * (isModel ? 2.2 : 3.2)]));
  const ordered = [...players].sort((left, right) => {
    const leftBoost = isModel && left.sleeperCandidate ? 45 : 0;
    const rightBoost = isModel && right.sleeperCandidate ? 45 : 0;
    const leftScore = -left.rank + leftBoost + noiseById.get(left.id);
    const rightScore = -right.rank + rightBoost + noiseById.get(right.id);
    return rightScore - leftScore || left.id - right.id;
  });
  const sourceRank = new Map(ordered.map((player, index) => [player.id, index + 1]));
  return players.map((player) => {
    const rank = sourceRank.get(player.id);
    return {
      name: player.name,
      team: player.team,
      pos: player.pos,
      rank,
      adp: isModel ? undefined : Math.max(1, rank + rng.normal() * 2),
      auction: sourceId === "mfl" ? Math.max(1, Math.round(player.auction * (1 + rng.normal() * .08))) : undefined,
      projectedPpg: player.projected / 17,
    };
  });
}

export function makeConsensusPlayerSnapshot(trialSeed, league) {
  const rng = new SeededRandom(hashSeed(`${trialSeed}:players`));
  const raw = makeRawPlayers(rng);
  const espnPlayers = raw.map((player) => ({ ...player }));
  const sourceKinds = { ffc: "market", mfl: "market", tradyr: "model", gng: "model" };
  const sourceWeights = { ffc: .15, mfl: .15, tradyr: .20, gng: .20 };
  const sources = Object.keys(sourceKinds).map((sourceId) => ({
    id: sourceId,
    name: sourceId.toUpperCase(),
    kind: sourceKinds[sourceId],
    weight: sourceWeights[sourceId],
    status: "ok",
    updatedAt: null,
    attribution: "Seeded Monte Carlo fixture; not a live ranking feed",
    players: rankedSourcePlayers(raw, sourceId, new SeededRandom(hashSeed(`${trialSeed}:${sourceId}`))),
  }));
  const players = mergeConsensus(espnPlayers, sources, league)
    .sort((left, right) => Number(left.consensusRank || left.rank) - Number(right.consensusRank || right.rank) || left.id - right.id);
  const invalid = players.find((player) => player.sourceCount !== 5
    || player.marketSourceCount !== 3
    || player.modelSourceCount !== 2
    || SOURCE_IDS.some((sourceId) => !(sourceId in player.sourceRanks)));
  if (invalid) throw new Error(`five-source fixture coverage failed for player ${invalid.id}`);
  return players;
}

const snapshotConsensusCache = new Map();

export function makeCapturedPlayerSnapshot(snapshot, trialSeed, league) {
  const digest = sourceSnapshotDigest(snapshot);
  const leagueKey = [league.size, league.rosterSize, league.auctionBudget].join(":");
  const cacheKey = `${digest}:${leagueKey}`;
  let consensus = snapshotConsensusCache.get(cacheKey);
  if (!consensus) {
    consensus = replayConsensusSnapshot(snapshot, league)
      .sort((left, right) => Number(left.consensusRank || left.rank) - Number(right.consensusRank || right.rank) || left.id - right.id);
    snapshotConsensusCache.set(cacheKey, consensus);
  }
  const rng = new SeededRandom(hashSeed(`${trialSeed}:captured-player-truth`));
  return consensus.map((player) => {
    const projection = Math.max(0, Number(player.projected || 0));
    const uncertainty = SKILL_POSITIONS.has(player.pos) ? .055 : .08;
    return {
      ...player,
      trueProjection: Math.max(0, projection * (1 + rng.normal() * uncertainty)),
    };
  });
}

function rosterPlayers(teamId, picks, playerById) {
  return picks.filter((pick) => pick.teamId === teamId).map((pick) => playerById.get(pick.playerId)).filter(Boolean);
}

function positionCounts(roster) {
  return roster.reduce((counts, player) => {
    counts[player.pos] = Number(counts[player.pos] || 0) + 1;
    return counts;
  }, {});
}

function canAddToRoster(player, roster, league, currentOpen = null) {
  if (roster.length >= league.rosterSize) return false;
  const counts = positionCounts(roster);
  if (Number(counts[player.pos] || 0) >= Number(league.positionLimits[player.pos] || league.rosterSize)) return false;
  if (SPECIALISTS.has(player.pos) && Number(counts[player.pos] || 0) >= 1) return false;
  const remainingAfter = league.rosterSize - roster.length - 1;
  const openBefore = currentOpen ?? openStarterSlots(league, roster.map((item) => item.pos));
  if (openBefore <= remainingAfter) return true;
  return openStarterSlots(league, [...roster.map((item) => item.pos), player.pos]) <= remainingAfter;
}

function neededPositions(roster, league) {
  const positions = roster.map((item) => item.pos);
  const openBefore = openStarterSlots(league, positions);
  return new Set(POSITIONS.filter((position) => openStarterSlots(league, [...positions, position]) < openBefore));
}

function recentRunPosition(picks, playerById, leagueSize) {
  const counts = picks.slice(-Math.max(4, leagueSize)).reduce((result, pick) => {
    const position = playerById.get(pick.playerId)?.pos;
    if (position) result[position] = Number(result[position] || 0) + 1;
    return result;
  }, {});
  return Object.entries(counts).sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))[0]?.[0] || null;
}

function opponentSnakeScore(player, archetype, context, noise) {
  const need = context.need ? 1 : 0;
  const run = context.runPosition === player.pos ? 1 : 0;
  const vorp = Math.max(0, player.projected - approximateReplacement(player.pos));
  const adpScore = Math.max(0, 300 - player.adp);
  const sleeper = Math.max(0, Number(player.modelMarketEdge || 0));
  const base = player.projected * .24 + vorp * .9 + adpScore * .3 + need * 22;
  const adjustments = {
    ADP_FOLLOWER: adpScore * .85,
    PROJECTION_VORP: vorp * 1.25,
    NEED_BASED: need * 80,
    POSITION_RUN_CHASER: run * 75,
    SLEEPER_HUNTER: sleeper * 3.2,
    NOISY_HUMAN: noise * 42,
  };
  return base + Number(adjustments[archetype] || 0) + noise * 5;
}

function chooseOpponentSnakePlayer(players, unavailable, roster, picks, league, playerById, archetype, rng) {
  const runPosition = recentRunPosition(picks, playerById, league.size);
  const needs = neededPositions(roster, league);
  const currentOpen = openStarterSlots(league, roster.map((player) => player.pos));
  let best = null;
  let legalCandidates = 0;
  for (const player of players) {
    if (unavailable.has(player.id) || !canAddToRoster(player, roster, league, currentOpen)) continue;
    const score = opponentSnakeScore(player, archetype, {
      need: needs.has(player.pos),
      runPosition,
    }, rng.normal());
    if (!best || score > best.score || (score === best.score && player.id < best.player.id)) best = { player, score };
    legalCandidates += 1;
    if (legalCandidates >= 64) break;
  }
  return best?.player || null;
}

function lineupSlots(league) {
  return Object.entries(league.lineupSlotCounts).flatMap(([slot, count]) => {
    const eligible = SLOT_ELIGIBILITY[slot];
    if (!eligible) return [];
    return Array.from({ length: Math.max(0, Math.floor(Number(count) || 0)) }, () => ({ slot, eligible }));
  });
}

function bestLineup(roster, league, valueKey = "trueProjection") {
  const slots = lineupSlots(league);
  let states = new Map([[0, { value: 0, ids: [] }]]);
  for (const player of roster) {
    const next = new Map(states);
    for (const [mask, state] of states) {
      for (let slotIndex = 0; slotIndex < slots.length; slotIndex += 1) {
        const bit = 1 << slotIndex;
        if ((mask & bit) || !slots[slotIndex].eligible.includes(player.pos)) continue;
        const nextMask = mask | bit;
        const candidate = { value: state.value + Number((player[valueKey] ?? player.projected) || 0), ids: [...state.ids, player.id] };
        if (!next.has(nextMask) || next.get(nextMask).value < candidate.value) next.set(nextMask, candidate);
      }
    }
    states = next;
  }
  return [...states.entries()].sort((left, right) => {
    const leftFilled = bitCount(left[0]);
    const rightFilled = bitCount(right[0]);
    return rightFilled - leftFilled || right[1].value - left[1].value;
  })[0]?.[1] || { value: 0, ids: [] };
}

function bitCount(value) {
  let count = 0;
  let remaining = value;
  while (remaining) {
    remaining &= remaining - 1;
    count += 1;
  }
  return count;
}

function liveBudgets(league, rosters, spendByTeam) {
  return league.teams.map((team) => {
    const spent = Number(spendByTeam.get(team.id) || 0);
    const remaining = league.auctionBudget - spent;
    const openSlots = league.rosterSize - rosters.get(team.id).length;
    return {
      teamName: team.name,
      remaining,
      maxOffer: openSlots > 0 ? Math.max(1, remaining - (openSlots - 1)) : 0,
    };
  });
}

function teamMaxOffer(teamId, league, rosters, spendByTeam) {
  const spent = Number(spendByTeam.get(teamId) || 0);
  const remaining = league.auctionBudget - spent;
  const openSlots = league.rosterSize - rosters.get(teamId).length;
  return openSlots > 0 ? Math.max(1, remaining - (openSlots - 1)) : 0;
}

function chooseOpponentAuctionNomination(players, unavailable, roster, picks, league, playerById, archetype, rng, phase) {
  const currentOpen = openStarterSlots(league, roster.map((player) => player.pos));
  const legal = [];
  for (const player of players) {
    if (!unavailable.has(player.id) && canAddToRoster(player, roster, league, currentOpen)) legal.push(player);
    if (legal.length >= 72) break;
  }
  if (!legal.length) return null;
  const needs = neededPositions(roster, league);
  const runPosition = recentRunPosition(picks, playerById, league.size);
  return legal.map((player) => {
    const value = Number(player.auction || 1);
    const need = needs.has(player.pos) ? 1 : 0;
    const sleeper = Math.max(0, Number(player.modelMarketEdge || 0));
    const adjustments = {
      STARS_AND_SCRUBS: phase < .35 ? value * 1.2 : -value * .2,
      BALANCED_BIDDER: need * 18 + value * .2,
      BARGAIN_HUNTER: -value * .3 + (phase > .5 ? 20 : 0),
      SLEEPER_HUNTER: sleeper * 2.5,
      PRICE_ENFORCER: value * .65,
      NOISY_HUMAN: rng.normal() * 28,
      ADP_FOLLOWER: Math.max(0, 260 - player.adp) * .2,
      PROJECTION_VORP: Math.max(0, player.projected - approximateReplacement(player.pos)) * .55,
      NEED_BASED: need * 65,
      POSITION_RUN_CHASER: runPosition === player.pos ? 58 : 0,
    };
    const drainBias = archetype === "PRICE_ENFORCER" && !need ? value * .4 : 0;
    return { player, score: value + need * 12 + Number(adjustments[archetype] || 0) + drainBias + rng.normal() * 2 };
  }).sort((left, right) => right.score - left.score || left.player.id - right.player.id)[0].player;
}

function opponentAuctionCeiling(player, archetype, context, rng) {
  const phase = context.phase;
  const value = Number(player.auction || 1) * context.roomInflation;
  const needMultiplier = context.need ? 1.12 : .88;
  const sleeper = Math.max(0, Number(player.modelMarketEdge || 0));
  const velocity = context.spendVelocity;
  const archetypeMultiplier = {
    STARS_AND_SCRUBS: value >= 20 ? 1.28 : .62,
    BALANCED_BIDDER: 1,
    BARGAIN_HUNTER: .78 + phase * .3,
    SLEEPER_HUNTER: 1 + Math.min(.28, sleeper / 100),
    PRICE_ENFORCER: .97,
    NOISY_HUMAN: .9 + rng.next() * .35,
    ADP_FOLLOWER: player.adp <= context.totalRosterSpots * .35 ? 1.08 : .9,
    PROJECTION_VORP: .84 + Math.max(0, player.projected - approximateReplacement(player.pos)) / 400,
    NEED_BASED: context.need ? 1.22 : .7,
    POSITION_RUN_CHASER: context.runPosition === player.pos ? 1.2 : .87,
  }[archetype] || 1;
  const leverage = phase > .75 ? 1 + context.lateLeverage * .12 : 1;
  return Math.max(1, Math.round(value * needMultiplier * archetypeMultiplier * velocity * leverage + rng.normal() * 1.5));
}

function maybeRemoveLateNewsPlayer(players, unavailable, eventIndex, eventTotal, rng) {
  if (eventIndex === 0 || eventIndex >= eventTotal - 2 || rng.next() > .006) return null;
  const candidates = players.filter((player) => !unavailable.has(player.id) && SKILL_POSITIONS.has(player.pos) && player.adp <= eventTotal * .85);
  if (!candidates.length) return null;
  const player = candidates[rng.int(Math.min(candidates.length, 40))];
  unavailable.add(player.id);
  return player.id;
}

function legalRecommendations(recommendations, unavailable, teamId, picks, league, playerById) {
  const roster = rosterPlayers(teamId, picks, playerById);
  const currentOpen = openStarterSlots(league, roster.map((player) => player.pos));
  return recommendations.filter((player) => !unavailable.has(player.id) && canAddToRoster(player, roster, league, currentOpen));
}

function immediateDecisionRegret(chosen, alternatives, playerPool, pickNumber) {
  const utility = (player) => {
    const replacement = Number(playerPool.replacements[player.pos] || 0);
    const trueVorp = Math.max(0, Number((player.trueProjection ?? player.projected) || 0) - replacement);
    const timing = Math.max(-15, Math.min(15, pickNumber - Number(player.adp || pickNumber))) * .25;
    return Number((player.trueProjection ?? player.projected) || 0) + trueVorp * .55 + timing;
  };
  const chosenUtility = utility(chosen);
  const bestAlternative = alternatives.map((player) => ({ player, utility: utility(player) }))
    .sort((left, right) => right.utility - left.utility || left.player.id - right.player.id)[0];
  return {
    regret: Math.max(0, Number(bestAlternative?.utility || chosenUtility) - chosenUtility),
    alternativeId: bestAlternative?.player.id || null,
    chosenUtility,
  };
}

function snakeTeamForPick(overall, size, controlledSlot) {
  const round = Math.floor((overall - 1) / size);
  const slot = (overall - 1) % size;
  const orderSlot = round % 2 === 0 ? slot + 1 : size - slot;
  return orderSlot === controlledSlot ? 1 : orderSlot < controlledSlot ? orderSlot + 1 : orderSlot;
}

function validateDraft(players, picks, league, format, controlledCeilings = new Map()) {
  const playerById = new Map(players.map((player) => [player.id, player]));
  const violations = {
    duplicatePlayers: picks.length - new Set(picks.map((pick) => pick.playerId)).size,
    incompleteRosters: 0,
    unnecessarySecondSpecialist: 0,
    positionCap: 0,
    salaryCap: 0,
    reserve: 0,
    maxBid: 0,
    missingMandatoryStarter: 0,
  };
  for (const team of league.teams) {
    const teamPicks = picks.filter((pick) => pick.teamId === team.id);
    const roster = teamPicks.map((pick) => playerById.get(pick.playerId)).filter(Boolean);
    const counts = positionCounts(roster);
    if (roster.length !== league.rosterSize) violations.incompleteRosters += 1;
    if (openStarterSlots(league, roster.map((player) => player.pos)) > 0) violations.missingMandatoryStarter += 1;
    for (const position of POSITIONS) {
      if (Number(counts[position] || 0) > Number(league.positionLimits[position] || league.rosterSize)) violations.positionCap += 1;
    }
    for (const position of SPECIALISTS) {
      if (Number(counts[position] || 0) > 1) violations.unnecessarySecondSpecialist += 1;
    }
    if (format === "salary-cap") {
      let spent = 0;
      for (let index = 0; index < teamPicks.length; index += 1) {
        spent += teamPicks[index].amount;
        const openAfter = league.rosterSize - index - 1;
        if (spent > league.auctionBudget - openAfter) violations.reserve += 1;
      }
      if (spent > league.auctionBudget) violations.salaryCap += 1;
    }
  }
  for (const pick of picks.filter((pick) => pick.teamId === 1 && format === "salary-cap")) {
    const ceiling = controlledCeilings.get(pick.overall);
    if (Number.isFinite(ceiling) && pick.amount > ceiling) violations.maxBid += 1;
  }
  return violations;
}

export function sumAcquiredDecisionRegret(decisionLog) {
  return decisionLog.reduce((sum, decision) =>
    decision.acquired === false ? sum : sum + Number(decision.regret || 0), 0);
}

function evaluateDraft(players, picks, league, format, decisionLog, rng) {
  const playerById = new Map(players.map((player) => [player.id, player]));
  const remainingByPosition = Object.fromEntries(POSITIONS.map((position) => [position, players
    .filter((player) => player.pos === position && !picks.some((pick) => pick.playerId === player.id))
    .sort((left, right) => Number(right.trueProjection) - Number(left.trueProjection))]));
  const teamScores = [];
  let controlled = null;
  for (const team of league.teams) {
    const teamPicks = picks.filter((pick) => pick.teamId === team.id);
    const roster = teamPicks.map((pick) => playerById.get(pick.playerId)).filter(Boolean);
    const lineup = bestLineup(roster, league);
    const starterIds = new Set(lineup.ids);
    const starters = roster.filter((player) => starterIds.has(player.id));
    const totalProjection = roster.reduce((sum, player) => sum + Number((player.trueProjection ?? player.projected) || 0), 0);
    const vorp = roster.reduce((sum, player) => sum + Math.max(0, Number((player.trueProjection ?? player.projected) || 0) - approximateReplacement(player.pos)), 0);
    const sourceConfidenceDownside = starters.reduce((sum, player) => {
      const confidence = Number(player.consensusConfidence || 50) / 100;
      return sum + Number((player.trueProjection ?? player.projected) || 0) * (1 - confidence) * .12 + Number(player.rankSpread || 0) * .08;
    }, 0);
    const counts = positionCounts(roster);
    const rosterFragility = openStarterSlots(league, roster.map((player) => player.pos)) * 50
      + Number(counts.QB === 1) * 4
      + Number(counts.TE === 1) * 3
      + sourceConfidenceDownside * .25;
    const positionalScarcity = roster.reduce((sum, player) => {
      const next = remainingByPosition[player.pos]?.[0];
      return sum + Math.max(0, Number((player.trueProjection ?? player.projected) || 0) - Number((next?.trueProjection ?? next?.projected) || 0));
    }, 0);
    const benchProjection = totalProjection - lineup.value;
    const strength = lineup.value + benchProjection * .14 + vorp * .18 + positionalScarcity * .03 - rosterFragility;
    const result = { teamId: team.id, roster, teamPicks, lineup, totalProjection, vorp, sourceConfidenceDownside, rosterFragility, positionalScarcity, strength };
    teamScores.push(result);
    if (team.id === 1) controlled = result;
  }
  let wins = 0;
  const seasonSamples = 64;
  for (let sample = 0; sample < seasonSamples; sample += 1) {
    const ranked = teamScores.map((team) => ({
      teamId: team.teamId,
      value: team.strength + rng.normal() * (30 + team.rosterFragility * .3),
    })).sort((left, right) => right.value - left.value || left.teamId - right.teamId);
    if (ranked[0].teamId === 1) wins += 1;
  }
  const sleeperDecisions = decisionLog.filter((decision) => decision.acquired !== false && ["SLEEPER", "DEEP_STASH"].includes(decision.sleeperLabel));
  // An auction nomination is not a roster decision unless DraftForge actually
  // wins the player. Keep unsuccessful nominations in the log so the bounded
  // counterfactual runner can compare target and drain continuations, but do
  // not charge their player-utility proxy against acquisition regret.
  const acquiredDecisions = decisionLog.filter((decision) => decision.acquired !== false);
  const regrets = acquiredDecisions.map((decision) => decision.regret);
  const spent = controlled.teamPicks.reduce((sum, pick) => sum + Number(pick.amount || 0), 0);
  const discretionary = Math.max(1, league.auctionBudget - league.rosterSize);
  const remainingBudgetEfficiency = format === "salary-cap"
    ? Math.max(0, Math.min(1, 1 - Math.max(0, league.auctionBudget - spent - 1) / discretionary))
    : 1;
  const marketSurplus = controlled.teamPicks.reduce((sum, pick) => {
    const player = playerById.get(pick.playerId);
    return sum + (format === "salary-cap"
      ? Number(player?.auction || 1) - pick.amount
      : Math.max(-30, Math.min(30, pick.overall - Number(player?.adp || pick.overall))));
  }, 0);
  const sleeperAcquisitionValue = sleeperDecisions.reduce((sum, decision) => sum + Math.max(0, decision.trueVorp) + decision.sleeperScore * .1, 0);
  const sleeperTiming = sleeperDecisions.length
    ? sleeperDecisions.reduce((sum, decision) => sum + decision.timing, 0) / sleeperDecisions.length
    : 0;
  const decisionRegret = sumAcquiredDecisionRegret(decisionLog);
  const highRegretDecisions = regrets.filter((value) => value >= 8).length;
  const objective = controlled.strength + sleeperAcquisitionValue * .15 + marketSurplus * .04
    + remainingBudgetEfficiency * 4 - decisionRegret * .12;
  return {
    startingLineupProjection: controlled.lineup.value,
    totalProjection: controlled.totalProjection,
    vorp: controlled.vorp,
    positionalScarcity: controlled.positionalScarcity,
    rosterFragility: controlled.rosterFragility,
    marketSurplus,
    sleeperAcquisitionValue,
    sleeperTiming,
    remainingBudgetEfficiency,
    sourceConfidenceDownside: controlled.sourceConfidenceDownside,
    seasonWinProbability: wins / seasonSamples,
    decisionRegret,
    highRegretDecisions,
    objective,
  };
}

function decisionRecord(chosen, legal, playerPool, pickNumber, decisionNumber, extra = {}) {
  const alternatives = legal.filter((player) => player.id !== chosen.id).slice(0, 5);
  const regret = immediateDecisionRegret(chosen, alternatives, playerPool, pickNumber);
  return {
    decisionNumber,
    eventIndex: pickNumber,
    chosenId: chosen.id,
    alternativeIds: alternatives.map((player) => player.id),
    regret: regret.regret,
    confidence: Number(chosen.confidence || 0),
    sleeperLabel: chosen.sleeperLabel || "NONE",
    sleeperScore: Number(chosen.sleeperScore || 0),
    trueVorp: Math.max(0, Number((chosen.trueProjection ?? chosen.projected) || 0) - Number(playerPool.replacements[chosen.pos] || 0)),
    timing: pickNumber - Number(chosen.adp || pickNumber),
    acquired: true,
    ...extra,
  };
}

function assignArchetypes(format, league, rng) {
  const archetypes = OPPONENT_ARCHETYPES[format];
  return new Map(league.teams.filter((team) => team.id !== 1).map((team, index) => [
    team.id,
    archetypes[(index + rng.int(archetypes.length)) % archetypes.length],
  ]));
}

function runSnakeDraft(players, league, rng, archetypes, override) {
  const playerPool = buildPlayerPoolIndex(players, league);
  const playerById = playerPool.playerById;
  const picks = [];
  const rosters = new Map(league.teams.map((team) => [team.id, []]));
  const unavailable = new Set();
  const decisionLog = [];
  const controlledSlot = 1 + rng.int(league.size);
  const strategy = rng.pick(STRATEGIES);
  const eventTotal = league.size * league.rosterSize;
  let controlledDecision = 0;
  for (let overall = 1; overall <= eventTotal; overall += 1) {
    maybeRemoveLateNewsPlayer(players, unavailable, overall, eventTotal, rng);
    const teamId = snakeTeamForPick(overall, league.size, controlledSlot);
    let player;
    if (teamId === 1) {
      controlledDecision += 1;
      const decision = buildDraftDecision(players, picks, league, strategy, overall, [], playerPool);
      const legal = legalRecommendations(decision.recommendations, unavailable, 1, picks, league, playerById);
      if (!legal.length) throw new Error(`no legal DraftForge snake recommendation at overall pick ${overall}`);
      player = legal[0];
      if (override?.kind === "snake-player" && override.decisionNumber === controlledDecision) {
        player = legal.find((candidate) => candidate.id === override.playerId) || player;
      }
      decisionLog.push(decisionRecord(player, legal, playerPool, overall, controlledDecision));
    } else {
      player = chooseOpponentSnakePlayer(players, unavailable, rosters.get(teamId), picks, league, playerById, archetypes.get(teamId), rng);
      if (!player) throw new Error(`no legal opponent snake player at overall pick ${overall}`);
    }
    unavailable.add(player.id);
    rosters.get(teamId).push(player);
    picks.push({ playerId: player.id, teamId, overall, round: Math.ceil(overall / league.size), amount: 0 });
  }
  return { picks, decisionLog, controlledSlot, strategy, controlledCeilings: new Map() };
}

function auctionTargetAndDrain(legal, nomination) {
  const target = legal.find((player) => !["K", "DST"].includes(player.pos) && !["SLEEPER", "DEEP_STASH"].includes(player.sleeperLabel))
    || legal.find((player) => !["K", "DST"].includes(player.pos))
    || legal[0];
  const drain = legal.find((player) => player.id !== target?.id
    && !["K", "DST"].includes(player.pos)
    && !["SLEEPER", "DEEP_STASH"].includes(player.sleeperLabel)
    && (player.need === 0 || player.score <= Number(target?.score || 0) - 8))
    || (nomination?.intent === "DRAIN" ? nomination.player : null)
    || legal.find((player) => player.id !== target?.id);
  return { target, drain };
}

function runAuctionDraft(players, league, rng, archetypes, override, roomParameters) {
  const playerPool = buildPlayerPoolIndex(players, league);
  const playerById = playerPool.playerById;
  const picks = [];
  const rosters = new Map(league.teams.map((team) => [team.id, []]));
  const spendByTeam = new Map(league.teams.map((team) => [team.id, 0]));
  const unavailable = new Set();
  const decisionLog = [];
  const controlledCeilings = new Map();
  const strategy = rng.pick(STRATEGIES);
  const eventTotal = league.size * league.rosterSize;
  let nominationCursor = rng.int(league.size);
  let controlledNomination = 0;
  let cachedDecision = null;
  let cacheDirty = true;
  while (picks.length < eventTotal) {
    const overall = picks.length + 1;
    maybeRemoveLateNewsPlayer(players, unavailable, overall, eventTotal, rng);
    const openTeams = league.teams.filter((team) => rosters.get(team.id).length < league.rosterSize);
    let nominator = null;
    for (let offset = 0; offset < league.size; offset += 1) {
      const candidateId = ((nominationCursor + offset) % league.size) + 1;
      if (openTeams.some((team) => team.id === candidateId)) {
        nominator = league.teams.find((team) => team.id === candidateId);
        nominationCursor = candidateId % league.size;
        break;
      }
    }
    if (!nominator) throw new Error(`no legal nominator at sale ${overall}`);
    const budgets = liveBudgets(league, rosters, spendByTeam);
    if (cacheDirty || nominator.id === 1 || !cachedDecision) {
      cachedDecision = buildDraftDecision(players, picks, league, strategy, overall, budgets, playerPool);
      cacheDirty = false;
    }
    const controlledLegal = legalRecommendations(cachedDecision.recommendations, unavailable, 1, picks, league, playerById);
    const phase = picks.length / eventTotal;
    let nominatedPlayer;
    let nominationIntent = "OPPONENT";
    let openingBid = 1;
    let forcedAction = null;
    if (nominator.id === 1) {
      controlledNomination += 1;
      const productionNomination = chooseAuctionNomination(controlledLegal, league, cachedDecision.auctionPlan);
      if (!productionNomination?.player) throw new Error(`no DraftForge auction nomination at sale ${overall}`);
      nominatedPlayer = productionNomination.player;
      nominationIntent = productionNomination.intent;
      openingBid = productionNomination.openingBid;
      const alternatives = auctionTargetAndDrain(controlledLegal, productionNomination);
      if (override?.kind === "auction-action" && override.decisionNumber === controlledNomination) {
        forcedAction = override.action;
        if (["BID", "ALT_CEILING", "TARGET_NOMINATION"].includes(forcedAction) && alternatives.target) {
          nominatedPlayer = alternatives.target;
          nominationIntent = "TARGET";
          openingBid = 1;
        }
        if (["PASS", "DRAIN_NOMINATION"].includes(forcedAction) && alternatives.drain) {
          nominatedPlayer = alternatives.drain;
          nominationIntent = "DRAIN";
          openingBid = 1;
        }
      }
      decisionLog.push(decisionRecord(nominatedPlayer, controlledLegal, playerPool, overall, controlledNomination, {
        nominationIntent,
        targetId: alternatives.target?.id || null,
        drainId: alternatives.drain?.id || null,
        acquired: false,
      }));
    } else {
      nominatedPlayer = chooseOpponentAuctionNomination(players, unavailable, rosters.get(nominator.id), picks, league, playerById, archetypes.get(nominator.id), rng, phase);
      if (!nominatedPlayer) throw new Error(`no opponent auction nomination at sale ${overall}`);
    }
    const runPosition = recentRunPosition(picks, playerById, league.size);
    const bidders = [];
    for (const team of openTeams) {
      const roster = rosters.get(team.id);
      if (!canAddToRoster(nominatedPlayer, roster, league)) continue;
      const maxOffer = teamMaxOffer(team.id, league, rosters, spendByTeam);
      let ceiling;
      if (team.id === 1) {
        const recommendation = controlledLegal.find((player) => player.id === nominatedPlayer.id);
        ceiling = Number(recommendation?.maxBid || 0);
        if (nominator.id === 1 && nominationIntent === "DRAIN") ceiling = Math.min(1, ceiling);
        if (forcedAction === "PASS") ceiling = Math.min(1, ceiling);
        if (forcedAction === "ALT_CEILING") ceiling = Math.max(1, Math.floor(ceiling * .9));
      } else {
        ceiling = opponentAuctionCeiling(nominatedPlayer, archetypes.get(team.id), {
          phase,
          roomInflation: roomParameters.roomInflation,
          spendVelocity: roomParameters.spendVelocity,
          lateLeverage: roomParameters.lateLeverage,
          need: neededPositions(roster, league).has(nominatedPlayer.pos),
          runPosition,
          totalRosterSpots: eventTotal,
        }, rng);
      }
      ceiling = Math.min(maxOffer, Math.max(0, Math.floor(ceiling)));
      if (team.id === nominator.id) ceiling = Math.max(Math.min(maxOffer, openingBid), ceiling);
      if (ceiling >= openingBid) bidders.push({ teamId: team.id, ceiling, tie: rng.next() });
    }
    if (!bidders.length) throw new Error(`no legal bidder at sale ${overall}`);
    bidders.sort((left, right) => right.ceiling - left.ceiling || left.tie - right.tie || left.teamId - right.teamId);
    const winner = bidders[0];
    const runnerUp = bidders[1]?.ceiling || openingBid - 1;
    const price = Math.max(openingBid, Math.min(winner.ceiling, runnerUp + 1));
    if (winner.teamId === 1) {
      controlledCeilings.set(overall, winner.ceiling);
      cacheDirty = true;
      const recommendation = controlledLegal.find((player) => player.id === nominatedPlayer.id);
      const ownNominationDecision = decisionLog.findLast((decision) => decision.eventIndex === overall && decision.chosenId === nominatedPlayer.id);
      if (ownNominationDecision) ownNominationDecision.acquired = true;
      else if (recommendation) {
        decisionLog.push(decisionRecord(recommendation, controlledLegal, playerPool, overall, controlledNomination, {
          nominationIntent: "BID",
          acquired: true,
          counterfactualEligible: false,
        }));
      }
    }
    unavailable.add(nominatedPlayer.id);
    rosters.get(winner.teamId).push(nominatedPlayer);
    spendByTeam.set(winner.teamId, Number(spendByTeam.get(winner.teamId) || 0) + price);
    picks.push({ playerId: nominatedPlayer.id, teamId: winner.teamId, overall, round: 0, amount: price });
  }
  return { picks, decisionLog, controlledSlot: null, strategy, controlledCeilings };
}

function highestRegretCase(decisionLog, metadata) {
  const decision = decisionLog.filter((item) => item.counterfactualEligible !== false)
    .sort((left, right) => right.regret - left.regret || left.decisionNumber - right.decisionNumber)[0];
  if (!decision) return null;
  return { ...metadata, ...decision };
}

export function simulateDraft({ format, baseSeed, trialIndex, drafts, override = null, sourceSnapshot = null }) {
  const trialSeed = deriveTrialSeed(baseSeed, format, trialIndex);
  const rng = new SeededRandom(trialSeed);
  const { league: baseLeague, scenario, realSettings } = makeLeagueScenario(format, trialIndex, trialSeed);
  const league = { ...baseLeague, teamId: 1 };
  const players = sourceSnapshot
    ? makeCapturedPlayerSnapshot(sourceSnapshot, trialSeed, league)
    : makeConsensusPlayerSnapshot(trialSeed, league);
  const archetypes = assignArchetypes(format, league, rng);
  const roomParameters = {
    roomInflation: Math.max(.82, Math.min(1.2, 1 + rng.normal() * .09)),
    spendVelocity: Math.max(.82, Math.min(1.22, 1 + rng.normal() * .1)),
    lateLeverage: Math.max(-1, Math.min(1, rng.normal() * .55)),
  };
  const result = format === "snake"
    ? runSnakeDraft(players, league, rng, archetypes, override)
    : runAuctionDraft(players, league, rng, archetypes, override, roomParameters);
  const violations = validateDraft(players, result.picks, league, format, result.controlledCeilings);
  const metrics = evaluateDraft(players, result.picks, league, format, result.decisionLog, rng);
  const split = splitForTrial(trialIndex, drafts);
  const regretCase = highestRegretCase(result.decisionLog, {
    format,
    trialIndex,
    trialSeed,
    split,
    scenario,
    strategy: result.strategy,
  });
  return {
    format,
    trialIndex,
    trialSeed,
    split,
    scenario,
    realSettings,
    sourceSnapshotDigest: sourceSnapshot?.digest || null,
    leagueSize: league.size,
    rosterSize: league.rosterSize,
    draftSlot: result.controlledSlot,
    strategy: result.strategy,
    archetypes: [...archetypes.values()],
    roomParameters: format === "salary-cap" ? roomParameters : undefined,
    metrics,
    violations,
    regretCase,
    roster: result.picks.filter((pick) => pick.teamId === 1),
    draftDigest: createHash("sha256").update(result.picks.map((pick) => `${pick.teamId}:${pick.playerId}:${pick.amount}`).join("|")).digest("hex"),
  };
}

class Distribution {
  constructor(limit = 4096) {
    this.count = 0;
    this.sum = 0;
    this.sumSquares = 0;
    this.min = Number.POSITIVE_INFINITY;
    this.max = Number.NEGATIVE_INFINITY;
    this.samples = [];
    this.limit = limit;
  }

  add(value) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return;
    this.count += 1;
    this.sum += numeric;
    this.sumSquares += numeric * numeric;
    this.min = Math.min(this.min, numeric);
    this.max = Math.max(this.max, numeric);
    if (this.samples.length < this.limit) this.samples.push(numeric);
    else {
      const index = hashSeed(`${this.count}:${numeric.toFixed(8)}`) % this.count;
      if (index < this.limit) this.samples[index] = numeric;
    }
  }

  summary() {
    const mean = this.count ? this.sum / this.count : 0;
    const variance = this.count > 1 ? Math.max(0, (this.sumSquares - this.sum * this.sum / this.count) / (this.count - 1)) : 0;
    const standardError = this.count ? Math.sqrt(variance / this.count) : 0;
    const sorted = [...this.samples].sort((left, right) => left - right);
    const quantile = (probability) => sorted.length ? sorted[Math.min(sorted.length - 1, Math.max(0, Math.round((sorted.length - 1) * probability)))] : 0;
    return {
      count: this.count,
      mean,
      ci95: [mean - 1.96 * standardError, mean + 1.96 * standardError],
      min: this.count ? this.min : 0,
      p10: quantile(.1),
      p25: quantile(.25),
      median: quantile(.5),
      p75: quantile(.75),
      p90: quantile(.9),
      max: this.count ? this.max : 0,
    };
  }
}

class Aggregate {
  constructor() {
    this.drafts = 0;
    this.metrics = Object.fromEntries(METRIC_KEYS.map((key) => [key, new Distribution()]));
    this.violations = {};
    this.archetypes = {};
    this.errors = [];
  }

  add(record) {
    this.drafts += 1;
    for (const key of METRIC_KEYS) this.metrics[key].add(record.metrics[key]);
    for (const [key, value] of Object.entries(record.violations)) this.violations[key] = Number(this.violations[key] || 0) + Number(value || 0);
    for (const archetype of record.archetypes) this.archetypes[archetype] = Number(this.archetypes[archetype] || 0) + 1;
  }

  addError(error) {
    if (this.errors.length < 100) this.errors.push(error);
  }

  summary() {
    return {
      drafts: this.drafts,
      metrics: Object.fromEntries(Object.entries(this.metrics).map(([key, value]) => [key, value.summary()])),
      violations: this.violations,
      archetypes: this.archetypes,
      errors: this.errors,
    };
  }
}

function addTopRegret(collection, regretCase, limit) {
  if (!regretCase) return;
  collection.push(regretCase);
  collection.sort((left, right) => right.regret - left.regret || left.trialSeed - right.trialSeed);
  if (collection.length > limit) collection.length = limit;
}

function counterfactualActions(regretCase) {
  if (regretCase.format === "snake") return regretCase.alternativeIds.slice(0, 5).map((playerId) => ({
    label: `PLAYER_${playerId}`,
    override: { kind: "snake-player", decisionNumber: regretCase.decisionNumber, playerId },
  }));
  return ["BID", "PASS", "ALT_CEILING", "TARGET_NOMINATION", "DRAIN_NOMINATION"].map((action) => ({
    label: action,
    override: { kind: "auction-action", decisionNumber: regretCase.decisionNumber, action },
  }));
}

export function runCounterfactuals(cases, config) {
  const results = [];
  for (const regretCase of cases) {
    const baseline = simulateDraft({
      format: regretCase.format,
      baseSeed: config.seed,
      trialIndex: regretCase.trialIndex,
      drafts: config.drafts,
      sourceSnapshot: config.sourceSnapshot,
    });
    const branches = [];
    for (const action of counterfactualActions(regretCase)) {
      try {
        const candidate = simulateDraft({
          format: regretCase.format,
          baseSeed: config.seed,
          trialIndex: regretCase.trialIndex,
          drafts: config.drafts,
          sourceSnapshot: config.sourceSnapshot,
          override: action.override,
        });
        branches.push({
          action: action.label,
          objectiveDelta: candidate.metrics.objective - baseline.metrics.objective,
          lineupDelta: candidate.metrics.startingLineupProjection - baseline.metrics.startingLineupProjection,
          winProbabilityDelta: candidate.metrics.seasonWinProbability - baseline.metrics.seasonWinProbability,
          regretDelta: candidate.metrics.decisionRegret - baseline.metrics.decisionRegret,
          violations: candidate.violations,
          draftDigest: candidate.draftDigest,
        });
      } catch (error) {
        branches.push({ action: action.label, error: error instanceof Error ? error.message : String(error) });
      }
    }
    results.push({
      format: regretCase.format,
      trialIndex: regretCase.trialIndex,
      trialSeed: regretCase.trialSeed,
      split: regretCase.split,
      decisionNumber: regretCase.decisionNumber,
      baselineObjective: baseline.metrics.objective,
      branches,
    });
  }
  return results;
}

function summarizeBreakdowns(map) {
  return Object.fromEntries([...map.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([key, aggregate]) => [key, aggregate.summary()]));
}

export async function runMonteCarlo(config, callbacks = {}) {
  const formats = config.formats || ["snake", "salary-cap"];
  const phases = config.phases || ["discovery", "validation", "holdout"];
  const aggregate = new Aggregate();
  const splitAggregates = new Map();
  const scenarioAggregates = new Map();
  const slotAggregates = new Map();
  const topRegret = [];
  const failureSeeds = [];
  const sealedHoldoutDigests = [];
  let completed = 0;
  const selectedTrialCount = Array.from({ length: config.drafts }, (_, trialIndex) => splitForTrial(trialIndex, config.drafts))
    .filter((split) => phases.includes(split)).length;
  const total = selectedTrialCount * formats.length;
  for (const format of formats) {
    for (let trialIndex = 0; trialIndex < config.drafts; trialIndex += 1) {
      const split = splitForTrial(trialIndex, config.drafts);
      if (!phases.includes(split)) continue;
      try {
        const record = simulateDraft({
          format,
          baseSeed: config.seed,
          trialIndex,
          drafts: config.drafts,
          sourceSnapshot: config.sourceSnapshot,
        });
        if (split !== "holdout" || config.exposeHoldout) aggregate.add(record);
        const splitKey = `${format}:${split}`;
        if (!splitAggregates.has(splitKey)) splitAggregates.set(splitKey, new Aggregate());
        splitAggregates.get(splitKey).add(record);
        if (split !== "holdout" || config.exposeHoldout) {
          const scenarioKey = `${format}:${record.scenario}`;
          if (!scenarioAggregates.has(scenarioKey)) scenarioAggregates.set(scenarioKey, new Aggregate());
          scenarioAggregates.get(scenarioKey).add(record);
          const slotKey = format === "snake" ? `${format}:slot-${record.draftSlot}-of-${record.leagueSize}` : `${format}:${record.scenario}`;
          if (!slotAggregates.has(slotKey)) slotAggregates.set(slotKey, new Aggregate());
          slotAggregates.get(slotKey).add(record);
          addTopRegret(topRegret, record.regretCase, Math.max(20, Number(config.counterfactualCases || 10) * 2));
        } else {
          sealedHoldoutDigests.push(`${record.format}:${record.trialIndex}:${record.draftDigest}:${record.metrics.objective.toFixed(8)}`);
        }
        await callbacks.onTrial?.(record);
      } catch (error) {
        const failure = {
          format,
          trialIndex,
          trialSeed: deriveTrialSeed(config.seed, format, trialIndex),
          split,
          error: error instanceof Error ? error.stack || error.message : String(error),
        };
        aggregate.addError(failure);
        failureSeeds.push(failure);
        await callbacks.onFailure?.(failure);
      }
      completed += 1;
      if (callbacks.onProgress && (completed % Math.max(1, Number(config.progressEvery || 250)) === 0 || completed === total)) {
        await callbacks.onProgress({ completed, total });
      }
    }
  }
  const eligibleCases = topRegret
    .filter((item) => item.split !== "holdout")
    .slice(0, Number(config.counterfactualCases || 10));
  const counterfactuals = config.skipCounterfactuals ? [] : runCounterfactuals(eligibleCases, config);
  const splitSummary = summarizeBreakdowns(splitAggregates);
  if (!config.exposeHoldout) {
    for (const key of Object.keys(splitSummary)) {
      if (key.endsWith(":holdout")) splitSummary[key] = {
        drafts: splitSummary[key].drafts,
        sealed: true,
        digest: createHash("sha256").update(sealedHoldoutDigests.filter((item) => item.startsWith(key.split(":")[0])).join("\n")).digest("hex"),
      };
    }
  }
  const summary = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    config: {
      draftsPerFormat: config.drafts,
      seed: config.seed,
      formats,
      phases,
      split: { discovery: .6, validation: .2, holdout: .2 },
      realSettingsShare: .8,
      adversarialSettingsShare: .2,
      exposeHoldout: Boolean(config.exposeHoldout),
      sourceSnapshotDigest: config.sourceSnapshot?.digest || null,
    },
    sourceFixture: config.sourceSnapshot ? {
      kind: "captured-five-source-snapshot",
      livePlayerData: true,
      capturedAt: config.sourceSnapshot.capturedAt,
      digest: config.sourceSnapshot.digest,
      sourceIds: SOURCE_IDS,
      coverageAtLeastFour: config.sourceSnapshot.validation?.coverageAtLeastFour,
      fullFiveSourceCoverage: config.sourceSnapshot.validation?.fullFiveSourceCoverage,
      note: "All decisions replay the immutable ESPN + FFC + MFL + Tradyr + GNG snapshot; outcome truth is perturbed only by the seeded trial model.",
    } : {
      kind: "seeded-five-source-calibrated-fixture",
      livePlayerData: false,
      sourceIds: SOURCE_IDS,
      note: "All five signals pass through production mergeConsensus; this fallback validates mechanics but is not current player-specific evidence.",
    },
    aggregate: aggregate.summary(),
    completedDrafts: completed - failureSeeds.length,
    splits: splitSummary,
    scenarios: summarizeBreakdowns(scenarioAggregates),
    draftSlots: summarizeBreakdowns(slotAggregates),
    topRegretCases: topRegret.slice(0, 10),
    counterfactuals,
    failureSeeds,
  };
  summary.determinismDigest = createHash("sha256").update(JSON.stringify({
    config: summary.config,
    aggregate: summary.aggregate,
    splits: summary.splits,
    scenarios: summary.scenarios,
    draftSlots: summary.draftSlots,
    topRegretCases: summary.topRegretCases,
    counterfactuals: summary.counterfactuals,
    failureSeeds: summary.failureSeeds,
  })).digest("hex");
  return summary;
}

function fixed(value, digits = 2) {
  return Number(value || 0).toFixed(digits);
}

function metricRow(label, metric) {
  if (!metric) return `| ${label} | — | — | — |`;
  return `| ${label} | ${fixed(metric.mean)} | ${fixed(metric.p25)} | ${fixed(metric.ci95?.[0])}–${fixed(metric.ci95?.[1])} |`;
}

export function renderMarkdownReport(summary, comparison = null) {
  const metrics = summary.aggregate.metrics;
  const violationTotal = Object.values(summary.aggregate.violations).reduce((sum, value) => sum + Number(value || 0), 0);
  const lines = [
    "# DraftForge Monte Carlo stress test",
    "",
    `Seed: \`${summary.config.seed}\` · ${summary.config.draftsPerFormat.toLocaleString()} drafts per format · digest \`${summary.determinismDigest}\``,
    "",
    "## Scope and evidence",
    "",
    "The simulation imports DraftForge’s production decision engine. Opponents use seeded non-DraftForge archetypes. Eighty percent of trials use the sanitized authenticated ESPN league settings and twenty percent use ESPN-compatible adversarial variants.",
    "",
    summary.sourceFixture.livePlayerData
      ? `Player inputs replay immutable live source snapshot \`${summary.sourceFixture.digest}\` captured at ${summary.sourceFixture.capturedAt}. Source truth is fixed within every decision; seeded uncertainty affects hidden outcomes, not the recommendation inputs.`
      : "Player inputs are a deterministic five-source-calibrated fixture passed through the production consensus merger. This fallback run validates strategy mechanics and robustness, not current player-specific advice.",
    "",
    "## Aggregate metrics",
    "",
    "| Metric | Mean | P25 | 95% CI of mean |",
    "| --- | ---: | ---: | ---: |",
    metricRow("Starting-lineup projection", metrics.startingLineupProjection),
    metricRow("Total projection", metrics.totalProjection),
    metricRow("VORP", metrics.vorp),
    metricRow("Season win probability", metrics.seasonWinProbability),
    metricRow("Decision regret", metrics.decisionRegret),
    metricRow("Roster fragility", metrics.rosterFragility),
    metricRow("Market surplus", metrics.marketSurplus),
    metricRow("Sleeper acquisition value", metrics.sleeperAcquisitionValue),
    metricRow("Budget efficiency", metrics.remainingBudgetEfficiency),
    "",
    "## Safety gates",
    "",
    `Hard-invariant violations: **${violationTotal}** across ${summary.aggregate.drafts.toLocaleString()} completed drafts. Simulation errors: **${summary.failureSeeds.length}**.`,
    "",
    `Holdout exposure: **${summary.config.exposeHoldout ? "final evaluation enabled" : "sealed; excluded from tuning views"}**.`,
    "",
  ];
  if (comparison) {
    lines.push("## Baseline versus final paired metrics", "", comparison, "");
  }
  lines.push(
    "## Scenario breakdown",
    "",
    "| Scenario | Drafts | Starting lineup | Win probability | Regret | Objective |",
    "| --- | ---: | ---: | ---: | ---: | ---: |",
    ...Object.entries(summary.scenarios).map(([key, value]) => `| ${key} | ${value.drafts} | ${fixed(value.metrics.startingLineupProjection.mean)} | ${fixed(value.metrics.seasonWinProbability.mean, 4)} | ${fixed(value.metrics.decisionRegret.mean)} | ${fixed(value.metrics.objective.mean)} |`),
    "",
    "## Snake draft-slot breakdown",
    "",
    "| Slot | Drafts | Starting lineup | Win probability | Objective |",
    "| --- | ---: | ---: | ---: | ---: |",
    ...Object.entries(summary.draftSlots).filter(([key]) => key.startsWith("snake:slot-"))
      .map(([key, value]) => `| ${key.replace("snake:", "")} | ${value.drafts} | ${fixed(value.metrics.startingLineupProjection.mean)} | ${fixed(value.metrics.seasonWinProbability.mean, 4)} | ${fixed(value.metrics.objective.mean)} |`),
    "",
    "## Code changes tied to evidence",
    "",
    ...(summary.codeChanges?.length
      ? summary.codeChanges.map((change) => `- **${change.affectedDecisionClass}:** ${typeof change.observedEvidence === "string" ? change.observedEvidence : change.expectedImprovement}`)
      : ["- No production strategy change was attached to this run."]),
    "",
  );
  lines.push(
    "## Largest remaining regret cases",
    "",
    "| Format | Trial | Split | Decision | Evaluation | Regret | Replay |",
    "| --- | ---: | --- | ---: | --- | ---: | --- |",
    ...summary.topRegretCases.map((item) => `| ${item.format} | ${item.trialIndex} | ${item.split} | ${item.decisionNumber} | ${item.acquired === false ? "Nomination proxy" : "Acquisition"} | ${fixed(item.regret)} | \`npm run simulate:monte-carlo -- --drafts ${summary.config.draftsPerFormat} --seed ${summary.config.seed} --replay ${item.format}:${item.trialIndex}\` |`),
    "",
    "Nomination proxies prioritize target-versus-drain counterfactuals. They are excluded from aggregate decision regret unless DraftForge actually acquires the nominated player.",
    "",
    "## Reproduction",
    "",
    "```bash",
    `npm run simulate:monte-carlo -- --drafts ${summary.config.draftsPerFormat} --seed ${summary.config.seed}${summary.sourceFixture.livePlayerData ? " --snapshot <snapshot.json>" : ""}`,
    `npm run simulate:monte-carlo -- --drafts ${summary.config.draftsPerFormat} --seed ${summary.config.seed} --expose-holdout${summary.sourceFixture.livePlayerData ? " --snapshot <snapshot.json>" : ""}`,
    "npm run lint",
    "npm test",
    "```",
    "",
    "## Remaining weaknesses and tradeoffs",
    "",
    "- Opponent behavior is deliberately varied but still synthetic; it cannot reproduce every human room dynamic.",
    "- Static-roster win probability excludes waivers, trades, lineup management, and injuries after draft day, which are outside the ESPN-only draft scope.",
    "- Counterfactual branches test complete continuations for bounded high-regret cases; they are evidence for repeated decision classes, not proof of global optimality.",
    "- Quantiles use a bounded deterministic reservoir while means and confidence intervals stream across every completed trial.",
    "",
  );
  return lines.join("\n");
}
