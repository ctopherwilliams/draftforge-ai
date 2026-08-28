import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  buildDraftDecision,
  buildPlayerPoolIndex,
  chooseAuctionNomination,
  openStarterSlots,
  positionLimitFor,
} from "../app/lib/draft-engine.ts";
import { intelligenceQuarterbackMode, mergeConsensus } from "../app/lib/consensus.ts";
import {
  CURRENT_SOURCE_SNAPSHOT_MAX_AGE_MS,
  SOURCE_SNAPSHOT_SCHEMA_VERSION,
  evaluateCurrentSourceSnapshot,
  replayConsensusSnapshot,
  sourceSnapshotDigest,
  sourceSnapshotFormat,
} from "./source-snapshot.mjs";

const POSITIONS = ["QB", "RB", "WR", "TE", "K", "DST"];
const SKILL_POSITIONS = new Set(["QB", "RB", "WR", "TE"]);
const SPECIALISTS = new Set(["K", "DST"]);
const STRATEGIES = ["BALANCED", "HERO_RB", "ZERO_RB", "ELITE_QB"];
const SOURCE_IDS = ["espn", "ffc", "mfl", "tradyr", "gng"];
const MONTE_CARLO_SCHEMA_VERSION = 3;
const MONTE_CARLO_EVIDENCE_SCHEMA_VERSION = 2;
const COUNTERFACTUAL_TRACE_SCHEMA_VERSION = 2;
export const COUNTERFACTUAL_CLASSES = Object.freeze([
  "snake-pick",
  "auction-acquired",
  "auction-underbid",
  "auction-target-nomination",
  "auction-drain-nomination",
]);
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
  "seasonStrengthPercentile",
  "tailStrengthMargin",
  "decisionRegret",
  "highRegretDecisions",
  "auctionBidOpportunities",
  "auctionBidWins",
  "auctionBidLosses",
  "auctionBidPasses",
  "auctionDrainNonActions",
  "missedBidOpportunityRegret",
  "decisionRegretPenalty",
  "objectiveBeforeDecisionRegret",
  "objective",
];

// The synthetic pool must survive the deepest ESPN-compatible room even when
// every opponent reaches a position cap and seeded late news removes players.
// This is harness inventory only; production ranking and roster logic are
// imported unchanged below.
export const SYNTHETIC_POSITION_COUNTS = Object.freeze({
  QB: 64,
  RB: 136,
  WR: 136,
  TE: 64,
  K: 24,
  DST: 24,
});

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
    secondsPerPick: 60,
    rosterSize: 16,
    auctionBudget: 200,
    lineupSlotCounts: { "0": 1, "2": 2, "3": 1, "4": 2, "6": 1, "7": 1, "16": 1, "17": 1, "20": 6 },
    positionLimits: { "0": 0, "1": 4, "2": 8, "3": 8, "4": 3, "5": 3, "6": -1, "7": -1, "8": -1, "9": -1, "10": -1, "11": -1, "12": -1, "13": -1, "14": -1, "15": -1, "16": 3, "17": -1 },
    scoringLabel: "PPR",
    scoringRules: 29,
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
    lineupSlotCounts: { "0": 1, "2": 1, "4": 1, "7": 1, "16": 1, "17": 1, "20": 6, "21": 1, "23": 2 },
    positionLimits: { "0": 0, "1": 6, "2": 6, "3": 6, "4": 6, "5": 6, "6": 0, "7": 0, "8": 0, "9": 0, "10": 0, "11": 0, "12": 0, "13": 0, "14": 0, "15": -1, "16": 6, "17": 0 },
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

function deterministicReservoirUnit(seed, index) {
  // Mix the fixed stream seed with only the observation index. The avalanche
  // steps avoid the sequential-key correlations of using FNV output directly.
  let value = (Number(seed) + Math.imul(Number(index), 0x9e3779b9)) >>> 0;
  value = Math.imul(value ^ value >>> 16, 0x21f0aaad);
  value = Math.imul(value ^ value >>> 15, 0x735a2d97);
  return ((value ^ value >>> 15) >>> 0) / 0x1_0000_0000;
}

function auctionEventId(overall) {
  return `auction-sale:${overall}`;
}

function auctionEventRandom(trialSeed, eventId, domain) {
  return new SeededRandom(hashSeed(`${trialSeed}:${eventId}:${domain}`));
}

function sha256(value) {
  return createHash("sha256").update(String(value)).digest("hex");
}

function canonicalizeEvidence(value) {
  if (Array.isArray(value)) return value.map(canonicalizeEvidence);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalizeEvidence(value[key])]));
}

function stableEvidenceJson(value) {
  return JSON.stringify(canonicalizeEvidence(value));
}

function completedRuntimeSourceProof(start, completion) {
  if (!start || !completion) return null;
  const current = start.current === true && completion.current === true;
  return {
    schemaVersion: MONTE_CARLO_SCHEMA_VERSION,
    snapshotDigest: start.snapshotDigest,
    capturedAt: start.capturedAt,
    startedAt: start.evaluatedAt,
    completedAt: completion.evaluatedAt,
    ageAtStartMs: start.ageMs,
    ageAtCompletionMs: completion.ageMs,
    maxAgeMs: start.maxAgeMs,
    providerFreshAtStart: start.providerFreshAtEvaluation,
    providerFreshAtCompletion: completion.providerFreshAtEvaluation,
    currentAtStart: start.current,
    currentAtCompletion: completion.current,
    current,
    blocker: start.blocker || completion.blocker || null,
  };
}

const EVIDENCE_CODE_FILES = Object.freeze([
  ["app/lib/draft-engine.ts", new URL("../app/lib/draft-engine.ts", import.meta.url)],
  ["app/lib/consensus.ts", new URL("../app/lib/consensus.ts", import.meta.url)],
  ["simulation/source-snapshot.mjs", new URL("./source-snapshot.mjs", import.meta.url)],
  ["simulation/monte-carlo.mjs", new URL("./monte-carlo.mjs", import.meta.url)],
]);

export function monteCarloEvidenceIdentity({ sourceSnapshot = null, formats = ["snake", "salary-cap"] } = {}) {
  const normalizedFormats = [...formats].sort();
  const codeFiles = EVIDENCE_CODE_FILES.map(([path, url]) => ({
    path,
    digest: sha256(readFileSync(url, "utf8")),
  }));
  const productionCodeDigest = sha256(stableEvidenceJson({
    node: process.version,
    codeFiles,
  }));
  let source;
  if (sourceSnapshot) {
    const format = sourceSnapshotFormat(sourceSnapshot);
    source = {
      kind: "captured-five-source-snapshot",
      schemaVersion: sourceSnapshot.schemaVersion,
      format,
      digest: sourceSnapshotDigest(sourceSnapshot),
      capturedAt: sourceSnapshot.capturedAt,
      exactFormat: sourceSnapshot.schemaVersion === SOURCE_SNAPSHOT_SCHEMA_VERSION
        && formats.length === 1
        && formats[0] === format,
    };
  } else {
    source = {
      kind: "seeded-five-source-calibrated-fixture",
      schemaVersion: 1,
      formats: normalizedFormats,
      digest: sha256(stableEvidenceJson({ fixture: "synthetic-five-source-v1", formats: normalizedFormats })),
      exactFormat: false,
    };
  }
  const identity = {
    schemaVersion: MONTE_CARLO_EVIDENCE_SCHEMA_VERSION,
    productionCodeDigest,
    codeFiles,
    source,
  };
  return { ...identity, digest: sha256(stableEvidenceJson(identity)) };
}

function orderedTrialOutcome(record) {
  return {
    format: record.format,
    trialIndex: record.trialIndex,
    trialSeed: record.trialSeed,
    split: record.split,
    scenario: record.scenario,
    realSettings: record.realSettings,
    sourceSnapshotDigest: record.sourceSnapshotDigest,
    leagueSize: record.leagueSize,
    rosterSize: record.rosterSize,
    draftSlot: record.draftSlot,
    strategy: record.strategy,
    archetypes: record.archetypes,
    roomParameters: record.roomParameters,
    metrics: record.metrics,
    violations: record.violations,
    regretCase: record.regretCase,
    regretCases: record.regretCases,
    underbidCase: record.underbidCase,
    auctionOutcomes: record.auctionOutcomes,
    roster: record.roster,
    keeperState: record.keeperState,
    productionDecisionBuilds: record.productionDecisionBuilds,
    draftDigest: record.draftDigest,
  };
}

function auctionStateDigest(picks, unavailable) {
  const pickState = picks.map((pick) => `${pick.overall}:${pick.teamId}:${pick.playerId}:${pick.amount}`).join("|");
  const unavailableState = [...unavailable].sort((left, right) => left - right).join(",");
  return sha256(`${pickState}#${unavailableState}`);
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

function makeCapturedLeagueScenario(snapshot, format, trialIndex, trialSeed) {
  const realSettings = trialIndex % 5 !== 4;
  if (realSettings) {
    return {
      league: snapshot.league,
      scenario: "captured-authenticated-settings",
      realSettings: true,
    };
  }
  const rng = new SeededRandom(hashSeed(`${trialSeed}:captured-league-variant`));
  const variant = adversarialLeague(format, rng);
  const source = snapshot.league;
  return {
    league: {
      ...source,
      ...variant,
      id: `${source.id}-captured-source-adversarial-${trialIndex}`,
      name: `${source.name} captured-source adversarial variant`,
      teamId: 1,
      pickOrder: [],
      teams: makeTeams(variant.size),
      positionLimits: {
        QB: 4,
        RB: 9,
        WR: 9,
        TE: 4,
        K: 1,
        DST: 1,
        ...source.positionLimits,
      },
    },
    scenario: "captured-source-adversarial-espn-compatible",
    realSettings: false,
  };
}

function approximateReplacement(position) {
  return { QB: 245, RB: 145, WR: 140, TE: 105, K: 92, DST: 96 }[position] || 0;
}

function makeRawPlayers(rng) {
  // Keep a full undrafted buffer behind the deepest 14-team adversarial room.
  // A merely roster-sized pool can strand otherwise legal teams at position
  // caps when noisy opponents consume an asymmetric share of one position or
  // late-news removals deplete a mandatory position.
  const counts = SYNTHETIC_POSITION_COUNTS;
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

export function makeCapturedPlayerSnapshot(snapshot, trialSeed, league, {
  allowEspnCompatibleVariant = false,
} = {}) {
  const digest = sourceSnapshotDigest(snapshot);
  // The source snapshot is always replayed against its authenticated request
  // profile. Adversarial trials reuse that immutable player truth, then apply
  // production roster/value logic to an ESPN-compatible league variant. This
  // deliberately does not pretend the public feeds were fetched for the
  // variant profile.
  const sourceLeague = snapshot.league;
  if (!allowEspnCompatibleVariant) {
    // Validate on every call, including cache hits. Otherwise one valid call
    // could populate the cache and let a later mismatched profile reuse those
    // bytes without passing the snapshot's exact-profile gate.
    replayConsensusSnapshot(snapshot, league);
  }
  const leagueKey = [
    String(sourceLeague.draftType || "").trim().toUpperCase(),
    sourceLeague.size,
    sourceLeague.rosterSize,
    sourceLeague.auctionBudget,
    sourceLeague.season,
    String(sourceLeague.scoringLabel || "").trim().toUpperCase(),
    intelligenceQuarterbackMode(sourceLeague.lineupSlotCounts),
  ].join(":");
  const cacheKey = `${digest}:${leagueKey}`;
  let consensus = snapshotConsensusCache.get(cacheKey);
  if (!consensus) {
    consensus = replayConsensusSnapshot(snapshot, sourceLeague)
      .sort((left, right) => Number(left.consensusRank || left.rank) - Number(right.consensusRank || right.rank) || left.id - right.id);
    snapshotConsensusCache.set(cacheKey, consensus);
  }
  const rng = new SeededRandom(hashSeed(`${trialSeed}:captured-player-truth`));
  const priceScale = Math.max(.25, Math.min(
    4,
    Number(league.auctionBudget || 200) / Math.max(1, Number(sourceLeague.auctionBudget || 200)),
  ));
  return consensus.map((player) => {
    const projection = Math.max(0, Number(player.projected || 0));
    const uncertainty = SKILL_POSITIONS.has(player.pos) ? .055 : .08;
    return {
      ...player,
      auction: Math.max(1, Number(player.auction || 1) * priceScale),
      sourceAuctions: Object.fromEntries(Object.entries(player.sourceAuctions || {}).map(([sourceId, value]) => [
        sourceId,
        Math.max(1, Number(value || 1) * priceScale),
      ])),
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
  if (Number(counts[player.pos] || 0) >= positionLimitFor(league, player.pos)) return false;
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
  return recentRunContext(picks, playerById, leagueSize).position;
}

function recentRunContext(picks, playerById, leagueSize) {
  const window = picks.slice(-Math.max(4, leagueSize));
  const counts = window.reduce((result, pick) => {
    const position = playerById.get(pick.playerId)?.pos;
    if (position) result[position] = Number(result[position] || 0) + 1;
    return result;
  }, {});
  const [position, count] = Object.entries(counts)
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))[0] || [null, 0];
  return {
    position,
    count: Number(count || 0),
    sampleSize: window.length,
    intensity: window.length ? Number(count || 0) / window.length : 0,
  };
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

function retrospectiveAuctionBidEvidence(recommendation, productionCeiling, maxOffer, league, playerPool) {
  const legalMaximum = Math.max(0, Math.floor(Number(maxOffer || 0)));
  const approved = Math.min(legalMaximum, Math.max(0, Math.floor(Number(productionCeiling || 0))));
  const unavailable = {
    evidenceOnlyCeiling: Math.min(approved, legalMaximum),
    retrospectiveDollarValue: approved,
    hiddenProjectionRatio: 1,
    hiddenVorpGain: 0,
    hiddenRosterImpact: 0,
    upliftLimit: 0,
  };
  // A zero production ceiling represents a production safety/roster lock, not
  // an economic estimate. Monte Carlo must never use hidden truth to challenge
  // those locks, specialists, or an already-illegal offer.
  if (!recommendation
    || approved < 1
    || legalMaximum < 1
    || !SKILL_POSITIONS.has(recommendation.pos)) return unavailable;

  const projected = Math.max(1, Number(recommendation.projected || 0));
  const trueProjection = Math.max(0, Number((recommendation.trueProjection ?? recommendation.projected) || 0));
  const hiddenProjectionRatio = Math.max(.8, Math.min(1.2, trueProjection / projected));
  const replacement = Number(playerPool.replacements[recommendation.pos] || 0);
  const projectedVorp = Math.max(0, projected - replacement);
  const trueVorp = Math.max(0, trueProjection - replacement);
  const hiddenVorpGain = Math.max(0, trueVorp - projectedVorp);
  const rosterFit = recommendation.fillsMandatoryStarter ? 1 : Number(recommendation.need || 0) > 0 ? .65 : .25;
  const hiddenRosterImpact = hiddenVorpGain * rosterFit;
  const hiddenRosterDollars = Math.min(4, hiddenRosterImpact / 12);
  const retrospectiveDollarValue = Number(recommendation.fairValue || approved)
    * hiddenProjectionRatio + hiddenRosterDollars;
  // This is a bounded evidence probe, never a production bid. At a standard
  // $200 cap it can inspect at most ten dollars above the exact production
  // walk-away while still preserving the one-dollar reserve through maxOffer.
  const upliftLimit = Math.max(2, Math.floor(Number(league.auctionBudget || 0) * .05));
  const evidenceOnlyCeiling = Math.max(approved, Math.min(
    legalMaximum,
    approved + upliftLimit,
    Math.floor(retrospectiveDollarValue),
  ));
  return {
    evidenceOnlyCeiling,
    retrospectiveDollarValue,
    hiddenProjectionRatio,
    hiddenVorpGain,
    hiddenRosterImpact,
    upliftLimit,
  };
}

function retrospectiveUnderbidRegret(evidence, priceToWin) {
  const price = Math.max(1, Number(priceToWin || 0));
  if (Number(evidence?.evidenceOnlyCeiling || 0) < price) return 0;
  const hiddenValueSurplus = Math.max(0, Number(evidence.retrospectiveDollarValue || 0) - price);
  const rosterImpact = Math.min(6, Number(evidence.hiddenRosterImpact || 0) / 8);
  return Number(Math.max(.01, hiddenValueSurplus + rosterImpact).toFixed(4));
}

function retrospectiveAcquisitionRegret(evidence, price) {
  const paid = Math.max(1, Number(price || 0));
  const value = Math.max(1, Number(evidence?.retrospectiveDollarValue || 0));
  // Auction regret is a price decision, not a comparison to unrelated player
  // ranks. Only a source/hidden-outcome overpay enters this bounded proxy; the
  // full BID/PASS/alternate-ceiling continuations decide whether the roster
  // consequence is actually harmful.
  return Number(Math.max(0, paid - value).toFixed(4));
}

function boundedAlternateCeiling({ acquired, price, productionCeiling, evidenceOnlyCeiling }) {
  const production = Math.max(0, Math.floor(Number(productionCeiling || 0)));
  const evidence = Math.max(production, Math.floor(Number(evidenceOnlyCeiling || 0)));
  if (acquired) return Math.max(0, Math.min(production, Math.floor(Number(price || 0)) - 1));
  return evidence;
}

function auctionPriceTier(value) {
  const price = Math.max(0, Number(value || 0));
  if (price <= 1) return "$1";
  if (price < 10) return "$2-9";
  if (price < 25) return "$10-24";
  if (price < 50) return "$25-49";
  return "$50+";
}

function auctionConfidenceTier(value) {
  const confidence = Number(value || 0);
  if (confidence < 65) return "low-<65";
  if (confidence < 80) return "medium-65-79";
  return "high-80+";
}

function auctionSourceCountTier(value) {
  const count = Math.max(0, Math.floor(Number(value || 0)));
  if (count >= 5) return "5-of-5";
  if (count === 4) return "4-of-5";
  return "under-4";
}

function auctionPriceCoverageTier(value) {
  const count = Math.max(0, Math.floor(Number(value || 0)));
  if (count >= 4) return "4+-inputs";
  if (count >= 2) return "2-3-inputs";
  return "0-1-input";
}

function positionalRunIntensityTier(value) {
  const intensity = Math.max(0, Math.min(1, Number(value || 0)));
  if (intensity >= .5) return "high-50%+";
  if (intensity >= .34) return "medium-34-49%";
  return "low-<34%";
}

function chooseOpponentAuctionNomination(players, unavailable, roster, picks, league, playerById, archetype, randomForPlayer, phase) {
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
    // Bind opponent noise to the exact auction event and candidate identity.
    // A counterfactual that removes some other candidate must not shift every
    // subsequent player's random draw or the exogenous path of later sales.
    const rng = randomForPlayer(player.id);
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
    unavailableSelections: picks.filter((pick) => playerById.get(pick.playerId)?.unavailable === true).length,
    invalidKeeperCount: 0,
    invalidKeeperPrice: picks.filter((pick) => pick.keeper === true && (
      format === "salary-cap"
        ? !Number.isInteger(pick.amount) || pick.amount < 1
        : pick.amount !== 0
    )).length,
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
    const keeperPicks = teamPicks.filter((pick) => pick.keeper === true);
    const roster = teamPicks.map((pick) => playerById.get(pick.playerId)).filter(Boolean);
    const counts = positionCounts(roster);
    if (keeperPicks.length !== Number(league.keeperCount || 0)) violations.invalidKeeperCount += 1;
    if (roster.length !== league.rosterSize) violations.incompleteRosters += 1;
    if (openStarterSlots(league, roster.map((player) => player.pos)) > 0) violations.missingMandatoryStarter += 1;
    for (const position of POSITIONS) {
      if (Number(counts[position] || 0) > positionLimitFor(league, position)) violations.positionCap += 1;
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
  return decisionLog.reduce((sum, decision) => {
    const countsTowardRegret = decision.countsTowardRegret === undefined
      ? decision.acquired !== false
      : decision.countsTowardRegret === true;
    return countsTowardRegret ? sum + Number(decision.regret || 0) : sum;
  }, 0);
}

function evaluateDraft(players, picks, league, format, decisionLog) {
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
  // A 64-draw Bernoulli championship estimate made P25 collapse to zero and
  // added sampling noise to paired counterfactuals. Use a smooth deterministic
  // Bradley-Terry/softmax estimate instead. It is still only a static-roster
  // model, but identical paired seeds now produce a continuous tail signal.
  const strengthTemperature = 35;
  const maximumStrength = Math.max(...teamScores.map((team) => team.strength));
  const titleWeights = teamScores.map((team) => ({
    teamId: team.teamId,
    value: Math.exp(Math.max(-40, Math.min(0, (team.strength - maximumStrength) / strengthTemperature))),
  }));
  const titleWeightTotal = titleWeights.reduce((sum, item) => sum + item.value, 0);
  const seasonWinProbability = Number(titleWeights.find((item) => item.teamId === 1)?.value || 0)
    / Math.max(Number.EPSILON, titleWeightTotal);
  const opponents = teamScores.filter((team) => team.teamId !== 1);
  const seasonStrengthPercentile = opponents.length
    ? opponents.reduce((sum, team) => (
        sum + 1 / (1 + Math.exp(-(controlled.strength - team.strength) / strengthTemperature))
      ), 0) / opponents.length
    : 1;
  const orderedOpponentStrength = opponents.map((team) => team.strength).sort((left, right) => left - right);
  const upperQuartileOpponent = orderedOpponentStrength.length
    ? orderedOpponentStrength[Math.round((orderedOpponentStrength.length - 1) * .75)]
    : controlled.strength;
  const tailStrengthMargin = controlled.strength - upperQuartileOpponent;
  const sleeperDecisions = decisionLog.filter((decision) => decision.acquired !== false && ["SLEEPER", "DEEP_STASH"].includes(decision.sleeperLabel));
  // Nomination proxies and intentional drain non-actions are not roster-value
  // decisions. Acquisitions and actionable missed bid opportunities are scored;
  // correct hard-ceiling walks remain explicit zero-regret observations.
  const scoredDecisions = decisionLog.filter((decision) => (
    decision.countsTowardRegret === undefined
      ? decision.acquired !== false
      : decision.countsTowardRegret === true
  ));
  const regrets = scoredDecisions.map((decision) => decision.regret);
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
  const auctionBidDecisions = decisionLog.filter((decision) => decision.decisionKind === "BID");
  const auctionDrainNonActions = auctionBidDecisions.filter((decision) => decision.bidOutcome === "DRAIN_NON_ACTION").length;
  const missedBidOpportunityRegret = auctionBidDecisions
    .filter((decision) => decision.economicallyViableMissedOpportunity === true)
    .reduce((sum, decision) => sum + Number(decision.regret || 0), 0);
  const objectiveBeforeDecisionRegret = controlled.strength + sleeperAcquisitionValue * .15
    + marketSurplus * .04 + remainingBudgetEfficiency * 4;
  const decisionRegretPenalty = decisionRegret * .12;
  const objective = objectiveBeforeDecisionRegret - decisionRegretPenalty;
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
    seasonWinProbability,
    seasonStrengthPercentile,
    tailStrengthMargin,
    decisionRegret,
    highRegretDecisions,
    auctionBidOpportunities: auctionBidDecisions.length,
    auctionBidWins: auctionBidDecisions.filter((decision) => ["WON", "WON_DRAIN"].includes(decision.bidOutcome)).length,
    auctionBidLosses: auctionBidDecisions.filter((decision) => decision.bidOutcome === "LOST").length,
    auctionBidPasses: auctionBidDecisions.filter((decision) => decision.bidOutcome === "PASS").length,
    auctionDrainNonActions,
    missedBidOpportunityRegret,
    decisionRegretPenalty,
    objectiveBeforeDecisionRegret,
    objective,
  };
}

function decisionRecord(chosen, legal, playerPool, pickNumber, decisionNumber, extra = {}) {
  const priceDecision = extra.decisionKind === "BID";
  const alternatives = priceDecision ? [] : legal.filter((player) => player.id !== chosen.id).slice(0, 5);
  const regret = Number.isFinite(Number(extra.regret))
    ? { regret: Number(extra.regret) }
    : immediateDecisionRegret(chosen, alternatives, playerPool, pickNumber);
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

function keeperCandidateScore(player, roster, trialSeed, teamId, keeperRound) {
  const rosteredAtPosition = roster.filter((candidate) => candidate.pos === player.pos).length;
  const noise = auctionEventRandom(
    trialSeed,
    `keeper:${keeperRound}:team:${teamId}`,
    `player:${player.id}`,
  ).normal();
  return Number(player.auction || 1) * 2
    + Number((player.trueProjection ?? player.projected) || 0) * .04
    - rosteredAtPosition * 35
    - (SPECIALISTS.has(player.pos) ? 200 : 0)
    + noise * 2;
}

export function seedKeeperState(players, league, format, trialSeed) {
  const configuredKeepers = Number(league.keeperCount || 0);
  if (!Number.isInteger(configuredKeepers) || configuredKeepers < 0 || configuredKeepers > league.rosterSize) {
    throw new Error(`invalid keeper count ${league.keeperCount} for roster size ${league.rosterSize}`);
  }
  const rosters = new Map(league.teams.map((team) => [team.id, []]));
  const spendByTeam = new Map(league.teams.map((team) => [team.id, 0]));
  const unavailable = new Set(players.filter((player) => player.unavailable === true).map((player) => player.id));
  const picks = [];
  for (let keeperRound = 1; keeperRound <= configuredKeepers; keeperRound += 1) {
    for (const team of league.teams) {
      const roster = rosters.get(team.id);
      const legal = players.filter((player) => (
        !unavailable.has(player.id) && canAddToRoster(player, roster, league)
      ));
      if (!legal.length) {
        throw new Error(`no legal keeper for team ${team.id} in keeper round ${keeperRound}`);
      }
      // Salary keepers normally preserve valuable skill players. Keep K/DST as
      // a last-resort legal fallback so the seeded hidden state cannot consume
      // scarce specialists merely because their custom projection is large.
      const skillLegal = legal.filter((player) => !SPECIALISTS.has(player.pos));
      const player = [...(skillLegal.length ? skillLegal : legal)].sort((left, right) => (
        keeperCandidateScore(right, roster, trialSeed, team.id, keeperRound)
          - keeperCandidateScore(left, roster, trialSeed, team.id, keeperRound)
        || left.id - right.id
      ))[0];
      let amount = 0;
      if (format === "salary-cap") {
        const spent = Number(spendByTeam.get(team.id) || 0);
        const openAfter = league.rosterSize - roster.length - 1;
        const maximumLegalPrice = league.auctionBudget - spent - openAfter;
        if (maximumLegalPrice < 1) {
          throw new Error(`keeper price cannot preserve the one-dollar reserve for team ${team.id}`);
        }
        const priceRng = auctionEventRandom(
          trialSeed,
          `keeper:${keeperRound}:team:${team.id}`,
          `price:${player.id}`,
        );
        const sourceBackedPrice = Math.max(1, Math.round(Number(player.auction || 1) * (.6 + priceRng.next() * .2)));
        amount = Math.min(maximumLegalPrice, sourceBackedPrice);
        spendByTeam.set(team.id, spent + amount);
      }
      const pick = {
        playerId: player.id,
        teamId: team.id,
        overall: picks.length + 1,
        round: keeperRound,
        amount,
        keeper: true,
      };
      picks.push(pick);
      roster.push(player);
      unavailable.add(player.id);
    }
  }

  for (const team of league.teams) {
    const roster = rosters.get(team.id);
    if (roster.length !== configuredKeepers) {
      throw new Error(`team ${team.id} received ${roster.length}/${configuredKeepers} keepers`);
    }
    const counts = positionCounts(roster);
    for (const position of POSITIONS) {
      if (Number(counts[position] || 0) > positionLimitFor(league, position)) {
        throw new Error(`team ${team.id} keeper state exceeds the ${position} cap`);
      }
    }
    if (format === "salary-cap") {
      const remainingSlots = league.rosterSize - roster.length;
      if (Number(spendByTeam.get(team.id) || 0) > league.auctionBudget - remainingSlots) {
        throw new Error(`team ${team.id} keeper state violates the one-dollar reserve`);
      }
    }
  }
  const controlledPicks = picks.filter((pick) => pick.teamId === 1);
  return {
    picks,
    rosters,
    spendByTeam,
    unavailable,
    summary: {
      configuredPerTeam: configuredKeepers,
      totalPicks: picks.length,
      controlledPicks: controlledPicks.length,
      controlledSpend: controlledPicks.reduce((sum, pick) => sum + pick.amount, 0),
      totalSpend: picks.reduce((sum, pick) => sum + pick.amount, 0),
      model: configuredKeepers > 0 ? "deterministic-source-backed-hidden-state" : "none",
      digest: sha256(picks.map((pick) => `${pick.teamId}:${pick.playerId}:${pick.amount}`).join("|")),
    },
  };
}

function runSnakeDraft(players, league, rng, archetypes, override, trialSeed) {
  const playerPool = buildPlayerPoolIndex(players, league);
  const playerById = playerPool.playerById;
  const keeperState = seedKeeperState(players, league, "snake", trialSeed);
  const picks = [...keeperState.picks];
  const rosters = keeperState.rosters;
  const unavailable = keeperState.unavailable;
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
      decisionLog.push(decisionRecord(player, legal, playerPool, overall, controlledDecision, {
        counterfactualClass: "snake-pick",
      }));
    } else {
      player = chooseOpponentSnakePlayer(players, unavailable, rosters.get(teamId), picks, league, playerById, archetypes.get(teamId), rng);
      if (!player) throw new Error(`no legal opponent snake player at overall pick ${overall}`);
    }
    unavailable.add(player.id);
    rosters.get(teamId).push(player);
    picks.push({ playerId: player.id, teamId, overall, round: Math.ceil(overall / league.size), amount: 0 });
  }
  return {
    picks,
    decisionLog,
    controlledSlot,
    strategy,
    controlledCeilings: new Map(),
    keeperState: keeperState.summary,
  };
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

function auctionEventOutcomeDigest(event) {
  return sha256(JSON.stringify({
    eventId: event.eventId,
    decisionRoomPlayers: event.decisionRoomPlayers,
    nominatorTeamId: event.nominatorTeamId,
    nominatedPlayerId: event.nominatedPlayerId,
    nominationIntent: event.nominationIntent,
    openingBid: event.openingBid,
    controlledCeiling: event.controlledCeiling,
    controlledProductionCeiling: event.controlledProductionCeiling,
    evidenceOnlyCeiling: event.evidenceOnlyCeiling,
    evidenceOnlyOverride: event.evidenceOnlyOverride,
    bidders: event.bidders,
    winnerTeamId: event.winnerTeamId,
    price: event.price,
  }));
}

function runAuctionDraft(players, league, rng, archetypes, override, roomParameters, trialSeed, captureTrace = false) {
  const playerPool = buildPlayerPoolIndex(players, league);
  const playerById = playerPool.playerById;
  const keeperState = seedKeeperState(players, league, "salary-cap", trialSeed);
  const picks = [...keeperState.picks];
  const rosters = keeperState.rosters;
  const spendByTeam = keeperState.spendByTeam;
  const unavailable = keeperState.unavailable;
  const decisionLog = [];
  const controlledCeilings = new Map();
  const strategy = rng.pick(STRATEGIES);
  const eventTotal = league.size * league.rosterSize;
  let nominationCursor = rng.int(league.size);
  let controlledDecision = 0;
  let decisionBuildCount = 0;
  let overrideApplications = 0;
  const auctionTrace = [];
  while (picks.length < eventTotal) {
    const overall = picks.length + 1;
    const eventId = auctionEventId(overall);
    maybeRemoveLateNewsPlayer(
      players,
      unavailable,
      overall,
      eventTotal,
      auctionEventRandom(trialSeed, eventId, "late-news"),
    );
    const preStateDigest = captureTrace ? auctionStateDigest(picks, unavailable) : null;
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
    // Production recomputes after every authoritative sale because picks,
    // remaining budgets, room inflation, position runs, and opponent leverage
    // all changed. A cache that survives an opponent win is not production
    // evidence, even when our own roster did not change.
    const decision = buildDraftDecision(players, picks, league, strategy, overall, budgets, playerPool);
    decisionBuildCount += 1;
    const controlledLegal = legalRecommendations(decision.recommendations, unavailable, 1, picks, league, playerById);
    const phase = picks.length / eventTotal;
    const eventOverride = override
      && ["auction-nomination", "auction-bid"].includes(override.kind)
      && String(override.eventId || "") === eventId
        ? override
        : null;
    let nominatedPlayer;
    let nominationIntent = "OPPONENT";
    let openingBid = 1;
    let nominationAlternatives = null;
    let overrideApplied = null;
    if (nominator.id === 1) {
      const productionNomination = chooseAuctionNomination(controlledLegal, league, decision.auctionPlan);
      if (!productionNomination?.player) throw new Error(`no DraftForge auction nomination at sale ${overall}`);
      nominatedPlayer = productionNomination.player;
      nominationIntent = productionNomination.intent;
      openingBid = productionNomination.openingBid;
      nominationAlternatives = auctionTargetAndDrain(controlledLegal, productionNomination);
      if (eventOverride?.kind === "auction-nomination") {
        if (!["TARGET_NOMINATION", "DRAIN_NOMINATION"].includes(eventOverride.action)) {
          throw new Error(`invalid nomination counterfactual at ${eventId}: ${eventOverride.action}`);
        }
        const alternative = eventOverride.action === "TARGET_NOMINATION"
          ? nominationAlternatives.target
          : nominationAlternatives.drain;
        if (!alternative) throw new Error(`no ${eventOverride.action} alternative at ${eventId}`);
        nominatedPlayer = alternative;
        nominationIntent = eventOverride.action === "TARGET_NOMINATION" ? "TARGET" : "DRAIN";
        openingBid = 1;
        overrideApplications += 1;
        overrideApplied = `${eventOverride.kind}:${eventOverride.action}`;
      }
      controlledDecision += 1;
      decisionLog.push(decisionRecord(nominatedPlayer, controlledLegal, playerPool, overall, controlledDecision, {
        eventId,
        decisionKind: "NOMINATION",
        nominationIntent,
        counterfactualClass: nominationIntent === "DRAIN"
          ? "auction-drain-nomination"
          : "auction-target-nomination",
        targetId: nominationAlternatives.target?.id || null,
        drainId: nominationAlternatives.drain?.id || null,
        acquired: false,
        countsTowardRegret: false,
        counterfactualEligible: true,
      }));
    } else {
      if (eventOverride?.kind === "auction-nomination") {
        throw new Error(`nomination counterfactual ${eventId} does not target a DraftForge nomination`);
      }
      nominatedPlayer = chooseOpponentAuctionNomination(
        players,
        unavailable,
        rosters.get(nominator.id),
        picks,
        league,
        playerById,
        archetypes.get(nominator.id),
        (playerId) => auctionEventRandom(trialSeed, eventId, `opponent-nomination:${nominator.id}:player:${playerId}`),
        phase,
      );
      if (!nominatedPlayer) {
        const remainingByPosition = positionCounts(players.filter((player) => !unavailable.has(player.id)));
        const rosterByPosition = positionCounts(rosters.get(nominator.id));
        throw new Error(`no opponent auction nomination at sale ${overall}; team=${nominator.id}; roster=${JSON.stringify(rosterByPosition)}; remaining=${JSON.stringify(remainingByPosition)}`);
      }
    }
    let bidOverrideAction = null;
    if (eventOverride?.kind === "auction-bid") {
      if (!["BID", "PASS", "ALTERNATE_CEILING", "EVIDENCE_UPSIDE_CEILING"].includes(eventOverride.action)) {
        throw new Error(`invalid bid counterfactual at ${eventId}: ${eventOverride.action}`);
      }
      if (eventOverride.action === "ALTERNATE_CEILING"
        && (!Number.isInteger(eventOverride.ceiling) || eventOverride.ceiling < 0)) {
        throw new Error(`invalid alternate ceiling at ${eventId}: ${eventOverride.ceiling}`);
      }
      if (!openTeams.some((team) => team.id === 1)) {
        throw new Error(`bid counterfactual ${eventId} targets a full DraftForge roster`);
      }
      bidOverrideAction = eventOverride.action;
      overrideApplications += 1;
      overrideApplied = `${eventOverride.kind}:${eventOverride.action}`;
    }
    const runContext = recentRunContext(picks, playerById, league.size);
    const runPosition = runContext.position;
    const bidders = [];
    let controlledCeiling = null;
    let controlledProductionCeiling = null;
    let controlledRecommendation = null;
    let controlledBidEvidence = null;
    for (const team of openTeams) {
      const roster = rosters.get(team.id);
      if (!canAddToRoster(nominatedPlayer, roster, league)) continue;
      const maxOffer = teamMaxOffer(team.id, league, rosters, spendByTeam);
      let ceiling;
      if (team.id === 1) {
        const recommendation = controlledLegal.find((player) => player.id === nominatedPlayer.id);
        controlledRecommendation = recommendation || null;
        if (bidOverrideAction && !recommendation) {
          throw new Error(`bid counterfactual ${eventId} has no production recommendation for player ${nominatedPlayer.id}`);
        }
        const productionCeiling = Number(recommendation?.maxBid || 0);
        controlledBidEvidence = retrospectiveAuctionBidEvidence(
          recommendation,
          productionCeiling,
          maxOffer,
          league,
          playerPool,
        );
        ceiling = productionCeiling;
        if (nominator.id === 1 && nominationIntent === "DRAIN") ceiling = Math.min(1, ceiling);
        if (bidOverrideAction === "BID") ceiling = productionCeiling;
        if (bidOverrideAction === "PASS") ceiling = 0;
        if (bidOverrideAction === "EVIDENCE_UPSIDE_CEILING") {
          ceiling = controlledBidEvidence.evidenceOnlyCeiling;
        }
        if (bidOverrideAction === "ALTERNATE_CEILING") {
          if (Number(eventOverride.ceiling) > Number(controlledBidEvidence.evidenceOnlyCeiling || 0)) {
            throw new Error(`alternate ceiling exceeds bounded evidence at ${eventId}`);
          }
          ceiling = Number(eventOverride.ceiling);
        }
      } else {
        ceiling = opponentAuctionCeiling(nominatedPlayer, archetypes.get(team.id), {
          phase,
          roomInflation: roomParameters.roomInflation,
          spendVelocity: roomParameters.spendVelocity,
          lateLeverage: roomParameters.lateLeverage,
          need: neededPositions(roster, league).has(nominatedPlayer.pos),
          runPosition,
          totalRosterSpots: eventTotal,
        }, auctionEventRandom(trialSeed, eventId, `ceiling:${team.id}`));
      }
      ceiling = Math.min(maxOffer, Math.max(0, Math.floor(ceiling)));
      if (team.id === nominator.id) ceiling = Math.max(Math.min(maxOffer, openingBid), ceiling);
      if (team.id === 1) {
        controlledCeiling = ceiling;
        controlledProductionCeiling = Math.min(
          maxOffer,
          Math.max(0, Math.floor(Number(controlledRecommendation?.maxBid || 0))),
        );
        if (bidOverrideAction === "EVIDENCE_UPSIDE_CEILING"
          && controlledCeiling > Number(controlledBidEvidence?.evidenceOnlyCeiling || 0)) {
          throw new Error(`evidence-only ceiling escaped its bounded offer at ${eventId}`);
        }
      }
      if (ceiling >= openingBid) bidders.push({
        teamId: team.id,
        ceiling,
        tie: auctionEventRandom(trialSeed, eventId, `tie:${team.id}`).next(),
      });
    }
    if (!bidders.length) throw new Error(`no legal bidder at sale ${overall}`);
    bidders.sort((left, right) => right.ceiling - left.ceiling || left.tie - right.tie || left.teamId - right.teamId);
    const winner = bidders[0];
    const runnerUp = bidders[1]?.ceiling || openingBid - 1;
    const price = Math.max(openingBid, Math.min(winner.ceiling, runnerUp + 1));
    const controlledAcquired = winner.teamId === 1;
    if (winner.teamId === 1) {
      controlledCeilings.set(overall, winner.ceiling);
    }
    if (controlledRecommendation) {
      const highestOpponentCeiling = bidders
        .filter((bidder) => bidder.teamId !== 1)
        .reduce((maximum, bidder) => Math.max(maximum, bidder.ceiling), openingBid - 1);
      const priceToWin = controlledAcquired
        ? price
        : Math.max(openingBid, highestOpponentCeiling + 1);
      const actionableAtProductionCeiling = !controlledAcquired
        && Number(controlledProductionCeiling || 0) >= priceToWin;
      const intentionalDrainNonAction = !controlledAcquired
        && nominator.id === 1
        && nominationIntent === "DRAIN"
        && (bidOverrideAction === null || bidOverrideAction === "PASS");
      const participated = Number(controlledCeiling || 0) >= openingBid;
      const bidOutcome = controlledAcquired
        ? (nominationIntent === "DRAIN" ? "WON_DRAIN" : "WON")
        : intentionalDrainNonAction
          ? "DRAIN_NON_ACTION"
          : participated ? "LOST" : "PASS";
      const underbidOpportunity = !controlledAcquired
        && !intentionalDrainNonAction
        && !actionableAtProductionCeiling
        && Number(controlledBidEvidence?.evidenceOnlyCeiling || 0) >= priceToWin;
      const missedOpportunityRegret = intentionalDrainNonAction
        ? 0
        : actionableAtProductionCeiling
          ? Math.max(1, Number(controlledProductionCeiling || 0) - priceToWin + 1)
          : underbidOpportunity
            ? retrospectiveUnderbidRegret(controlledBidEvidence, priceToWin)
            : 0;
      const missedOpportunityClass = actionableAtProductionCeiling
        ? "PRODUCTION_BID_SUPPRESSED"
        : underbidOpportunity ? "RETROSPECTIVE_UNDERBID" : null;
      const economicallyViableMissedOpportunity = !controlledAcquired
        && !intentionalDrainNonAction
        && missedOpportunityClass !== null
        && missedOpportunityRegret > 0;
      const acquisitionRegret = controlledAcquired
        ? retrospectiveAcquisitionRegret(controlledBidEvidence, price)
        : 0;
      const alternateCeiling = boundedAlternateCeiling({
        acquired: controlledAcquired,
        price,
        productionCeiling: controlledProductionCeiling,
        evidenceOnlyCeiling: controlledBidEvidence?.evidenceOnlyCeiling,
      });
      controlledDecision += 1;
      const bidDecision = decisionRecord(
        controlledRecommendation,
        controlledLegal,
        playerPool,
        overall,
        controlledDecision,
        {
          eventId,
          decisionKind: "BID",
          nominationIntent: "BID",
          auctionNominationIntent: nominationIntent,
          counterfactualClass: controlledAcquired
            ? "auction-acquired"
            : economicallyViableMissedOpportunity ? "auction-underbid" : null,
          bidOutcome,
          approvedCeiling: controlledProductionCeiling,
          appliedCeiling: controlledCeiling,
          price,
          priceToWin,
          alternateCeiling,
          acquired: controlledAcquired,
          // One bid contributes either acquisition regret or one proven
          // missed-opportunity regret. Proper walks and drain non-actions are
          // observations, never placeholders in the scored regret set.
          countsTowardRegret: controlledAcquired || economicallyViableMissedOpportunity,
          counterfactualEligible: controlledAcquired || economicallyViableMissedOpportunity,
          underbidOpportunity,
          economicallyViableMissedOpportunity,
          missedOpportunityClass,
          evidenceOnlyCeiling: Number(controlledBidEvidence?.evidenceOnlyCeiling || 0),
          retrospectiveDollarValue: Number(controlledBidEvidence?.retrospectiveDollarValue || 0),
          hiddenProjectionRatio: Number(controlledBidEvidence?.hiddenProjectionRatio || 1),
          hiddenVorpGain: Number(controlledBidEvidence?.hiddenVorpGain || 0),
          hiddenRosterImpact: Number(controlledBidEvidence?.hiddenRosterImpact || 0),
          evidenceOnlyAction: Number(controlledCeiling || 0) > Number(controlledProductionCeiling || 0),
          productionCeilingExceededByEvidence: Math.max(
            0,
            Number(controlledCeiling || 0) - Number(controlledProductionCeiling || 0),
          ),
          sourceCount: Number(controlledRecommendation.sourceCount || 0),
          priceInputCount: Object.keys(controlledRecommendation.sourceAuctions || {}).length,
          consensusConfidence: Number(controlledRecommendation.consensusConfidence || 0),
          fairValue: Number(controlledRecommendation.fairValue || controlledRecommendation.auction || 1),
          acquisitionValue: Number(controlledBidEvidence?.retrospectiveDollarValue || 0),
          acquisitionSurplus: Number(controlledBidEvidence?.retrospectiveDollarValue || 0) - price,
          regretBasis: controlledAcquired
            ? "price-acquirability-bounded-continuation"
            : economicallyViableMissedOpportunity
              ? "bounded-missed-opportunity-continuation"
              : "none",
          positionalRunIntensity: runContext.intensity,
          positionalRunPosition: runContext.position,
          regret: controlledAcquired ? acquisitionRegret : missedOpportunityRegret,
          counterfactualPriority: controlledAcquired
            ? acquisitionRegret + Math.min(5, price / Math.max(1, Number(league.auctionBudget || 200)))
            : missedOpportunityRegret + (underbidOpportunity ? 25 : 0),
        },
      );
      decisionLog.push(bidDecision);
    }
    unavailable.add(nominatedPlayer.id);
    rosters.get(winner.teamId).push(nominatedPlayer);
    spendByTeam.set(winner.teamId, Number(spendByTeam.get(winner.teamId) || 0) + price);
    picks.push({ playerId: nominatedPlayer.id, teamId: winner.teamId, overall, round: 0, amount: price });
    if (captureTrace) {
      const traceEvent = {
        eventId,
        eventIndex: overall,
        preStateDigest,
        exogenousDigest: sha256(`${trialSeed}:${eventId}:auction-exogenous-v1`),
        decisionBuildNumber: decisionBuildCount,
        decisionRoomPlayers: decision.auctionPlan.roomPlayers,
        nominatorTeamId: nominator.id,
        nominatedPlayerId: nominatedPlayer.id,
        nominationIntent,
        openingBid,
        controlledCeiling,
        controlledProductionCeiling,
        evidenceOnlyCeiling: Number(controlledBidEvidence?.evidenceOnlyCeiling || 0),
        evidenceOnlyOverride: Number(controlledCeiling || 0) > Number(controlledProductionCeiling || 0),
        bidders: bidders.map((bidder) => ({
          teamId: bidder.teamId,
          ceiling: bidder.ceiling,
          tie: Number(bidder.tie.toFixed(12)),
        })),
        winnerTeamId: winner.teamId,
        price,
        overrideApplied,
      };
      auctionTrace.push({ ...traceEvent, outcomeDigest: auctionEventOutcomeDigest(traceEvent) });
    }
  }
  if (["auction-nomination", "auction-bid"].includes(override?.kind) && overrideApplications !== 1) {
    throw new Error(`auction counterfactual applied ${overrideApplications} times; expected exactly once at ${override?.eventId || "unknown-event"}`);
  }
  return {
    picks,
    decisionLog,
    controlledSlot: null,
    strategy,
    controlledCeilings,
    decisionBuildCount,
    auctionTrace,
    keeperState: keeperState.summary,
  };
}

function highestRegretCase(decisionLog, metadata) {
  const decision = decisionLog.filter((item) => item.counterfactualEligible !== false)
    .sort((left, right) => Number(right.counterfactualPriority ?? right.regret)
      - Number(left.counterfactualPriority ?? left.regret)
      || right.regret - left.regret
      || left.decisionNumber - right.decisionNumber)[0];
  if (!decision) return null;
  return { ...metadata, ...decision };
}

function highestUnderbidCase(decisionLog, metadata) {
  const decision = decisionLog.filter((item) => (
    item.decisionKind === "BID"
      && item.underbidOpportunity === true
      && item.counterfactualEligible !== false
  )).sort((left, right) => Number(right.counterfactualPriority ?? right.regret)
    - Number(left.counterfactualPriority ?? left.regret)
    || right.regret - left.regret
    || left.decisionNumber - right.decisionNumber)[0];
  if (!decision) return null;
  return { ...metadata, ...decision };
}

function highestCounterfactualCase(decisionLog, counterfactualClass, metadata) {
  const decision = decisionLog.filter((item) => (
    item.counterfactualClass === counterfactualClass
      && item.counterfactualEligible !== false
  )).sort((left, right) => Number(right.counterfactualPriority ?? right.regret)
    - Number(left.counterfactualPriority ?? left.regret)
    || right.regret - left.regret
    || left.decisionNumber - right.decisionNumber)[0];
  return decision ? { ...metadata, ...decision } : null;
}

function auctionOutcomeEvidence(decisionLog) {
  return decisionLog.filter((decision) => decision.decisionKind === "BID").map((decision) => ({
    eventId: decision.eventId,
    bidOutcome: decision.bidOutcome,
    acquired: decision.acquired === true,
    price: Number(decision.price || 0),
    priceToWin: Number(decision.priceToWin || 0),
    fairValue: Number(decision.fairValue || 0),
    regret: Number(decision.regret || 0),
    sourceCount: Number(decision.sourceCount || 0),
    sourceCountTier: auctionSourceCountTier(decision.sourceCount),
    priceInputCount: Number(decision.priceInputCount || 0),
    priceInputCoverageTier: auctionPriceCoverageTier(decision.priceInputCount),
    confidence: Number(decision.consensusConfidence || 0),
    confidenceTier: auctionConfidenceTier(decision.consensusConfidence),
    priceTier: auctionPriceTier(decision.fairValue || decision.priceToWin || decision.price),
    positionalRunIntensity: Number(decision.positionalRunIntensity || 0),
    positionalRunIntensityTier: positionalRunIntensityTier(decision.positionalRunIntensity),
  }));
}

export function simulateDraft({
  format,
  baseSeed,
  trialIndex,
  drafts,
  override = null,
  sourceSnapshot = null,
  captureTrace = false,
}) {
  const trialSeed = deriveTrialSeed(baseSeed, format, trialIndex);
  const rng = new SeededRandom(trialSeed);
  let baseLeague;
  let scenario;
  let realSettings;
  if (sourceSnapshot) {
    const capturedFormat = sourceSnapshotFormat(sourceSnapshot);
    if (format !== capturedFormat) {
      throw new Error(`source snapshot draft format mismatch: expected ${capturedFormat}, received ${format}`);
    }
    ({ league: baseLeague, scenario, realSettings } = makeCapturedLeagueScenario(
      sourceSnapshot,
      format,
      trialIndex,
      trialSeed,
    ));
  } else {
    ({ league: baseLeague, scenario, realSettings } = makeLeagueScenario(format, trialIndex, trialSeed));
  }
  const league = { ...baseLeague, teamId: 1 };
  const players = sourceSnapshot
    ? makeCapturedPlayerSnapshot(sourceSnapshot, trialSeed, league, {
        allowEspnCompatibleVariant: !realSettings,
      })
    : makeConsensusPlayerSnapshot(trialSeed, league);
  const archetypes = assignArchetypes(format, league, rng);
  const roomParameters = {
    roomInflation: Math.max(.82, Math.min(1.2, 1 + rng.normal() * .09)),
    spendVelocity: Math.max(.82, Math.min(1.22, 1 + rng.normal() * .1)),
    lateLeverage: Math.max(-1, Math.min(1, rng.normal() * .55)),
  };
  const result = format === "snake"
    ? runSnakeDraft(players, league, rng, archetypes, override, trialSeed)
    : runAuctionDraft(players, league, rng, archetypes, override, roomParameters, trialSeed, captureTrace);
  const violations = validateDraft(players, result.picks, league, format, result.controlledCeilings);
  const metrics = evaluateDraft(players, result.picks, league, format, result.decisionLog);
  const split = splitForTrial(trialIndex, drafts);
  const regretCase = highestRegretCase(result.decisionLog, {
    format,
    trialIndex,
    trialSeed,
    split,
    scenario,
    strategy: result.strategy,
  });
  const underbidCase = format === "salary-cap" ? highestUnderbidCase(result.decisionLog, {
    format,
    trialIndex,
    trialSeed,
    split,
    scenario,
    strategy: result.strategy,
  }) : null;
  const caseMetadata = { format, trialIndex, trialSeed, split, scenario, strategy: result.strategy };
  const regretCases = Object.fromEntries(COUNTERFACTUAL_CLASSES.map((counterfactualClass) => [
    counterfactualClass,
    highestCounterfactualCase(result.decisionLog, counterfactualClass, caseMetadata),
  ]));
  const defaultRegretCase = format === "snake"
    ? regretCases["snake-pick"]
    : [
        regretCases["auction-underbid"],
        regretCases["auction-acquired"],
        regretCases["auction-target-nomination"],
      ].filter(Boolean).sort((left, right) => Number(right.counterfactualPriority ?? right.regret)
        - Number(left.counterfactualPriority ?? left.regret))[0] || null;
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
    regretCase: defaultRegretCase || regretCase,
    regretCases,
    underbidCase,
    auctionOutcomes: format === "salary-cap" ? auctionOutcomeEvidence(result.decisionLog) : [],
    roster: result.picks.filter((pick) => pick.teamId === 1),
    keeperState: result.keeperState,
    ...(format === "salary-cap" ? { productionDecisionBuilds: result.decisionBuildCount } : {}),
    ...(captureTrace && format === "salary-cap" ? {
      counterfactualTrace: {
        schemaVersion: COUNTERFACTUAL_TRACE_SCHEMA_VERSION,
        events: result.auctionTrace,
        decisions: result.decisionLog,
      },
    } : {}),
    draftDigest: createHash("sha256").update(result.picks.map((pick) => `${pick.teamId}:${pick.playerId}:${pick.amount}`).join("|")).digest("hex"),
  };
}

export class Distribution {
  constructor(limit = 4096, seed = "default") {
    this.count = 0;
    this.sum = 0;
    this.sumSquares = 0;
    this.min = Number.POSITIVE_INFINITY;
    this.max = Number.NEGATIVE_INFINITY;
    this.samples = [];
    this.limit = limit;
    this.seed = hashSeed(seed);
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
      // Reservoir membership must depend only on the deterministic stream
      // position and seed. Including the observed metric value makes inclusion
      // probability value-dependent and biases the reported tail quantiles.
      const unit = deterministicReservoirUnit(this.seed, this.count);
      const index = Math.floor(unit * this.count);
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
    this.metrics = Object.fromEntries(METRIC_KEYS.map((key) => [key, new Distribution(4096, `metric:${key}`)]));
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

class AuctionOutcomeAggregate {
  constructor() {
    this.opportunities = 0;
    this.wins = 0;
    this.losses = 0;
    this.passes = 0;
    this.drainNonActions = 0;
    this.spend = new Distribution(2048, "auction-outcome:spend");
    this.regret = new Distribution(2048, "auction-outcome:regret");
    this.surplus = new Distribution(2048, "auction-outcome:surplus");
  }

  add(outcome) {
    this.opportunities += 1;
    if (["WON", "WON_DRAIN"].includes(outcome.bidOutcome)) this.wins += 1;
    else if (outcome.bidOutcome === "LOST") this.losses += 1;
    else if (outcome.bidOutcome === "PASS") this.passes += 1;
    else if (outcome.bidOutcome === "DRAIN_NON_ACTION") this.drainNonActions += 1;
    if (outcome.acquired) {
      this.spend.add(outcome.price);
      this.surplus.add(Number(outcome.fairValue || 0) - Number(outcome.price || 0));
    }
    this.regret.add(outcome.regret);
  }

  summary() {
    return {
      opportunities: this.opportunities,
      wins: this.wins,
      losses: this.losses,
      passes: this.passes,
      drainNonActions: this.drainNonActions,
      winRate: this.opportunities ? this.wins / this.opportunities : 0,
      spend: this.spend.summary(),
      regret: this.regret.summary(),
      surplus: this.surplus.summary(),
    };
  }
}

function addAuctionOutcomeStrata(strata, outcome) {
  const dimensions = {
    sourceCount: outcome.sourceCountTier,
    priceInputCoverage: outcome.priceInputCoverageTier,
    confidence: outcome.confidenceTier,
    priceTier: outcome.priceTier,
    positionalRunIntensity: outcome.positionalRunIntensityTier,
  };
  for (const [dimension, bucket] of Object.entries(dimensions)) {
    if (!strata.has(dimension)) strata.set(dimension, new Map());
    const dimensionMap = strata.get(dimension);
    if (!dimensionMap.has(bucket)) dimensionMap.set(bucket, new AuctionOutcomeAggregate());
    dimensionMap.get(bucket).add(outcome);
  }
}

function summarizeAuctionOutcomeStrata(strata) {
  return Object.fromEntries([...strata.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([dimension, buckets]) => [
    dimension,
    Object.fromEntries([...buckets.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([bucket, aggregate]) => [
      bucket,
      aggregate.summary(),
    ])),
  ]));
}

function addTopRegret(collection, regretCase, limit) {
  if (!regretCase) return;
  collection.push(regretCase);
  collection.sort((left, right) => Number(right.counterfactualPriority ?? right.regret)
    - Number(left.counterfactualPriority ?? left.regret)
    || right.regret - left.regret
    || left.trialSeed - right.trialSeed);
  if (collection.length > limit) collection.length = limit;
}

export function selectCounterfactualCases(queues, limit) {
  const maximum = Math.max(0, Math.floor(Number(limit || 0)));
  if (!maximum) return [];
  const selected = [];
  const seen = new Set();
  for (let depth = 0; selected.length < maximum; depth += 1) {
    let added = false;
    for (const counterfactualClass of COUNTERFACTUAL_CLASSES) {
      const item = queues[counterfactualClass]?.[depth];
      if (!item) continue;
      const key = `${item.format}:${item.trialIndex}:${item.eventId || item.decisionNumber}:${item.decisionKind || "PICK"}`;
      if (seen.has(key)) continue;
      seen.add(key);
      selected.push(item);
      added = true;
      if (selected.length >= maximum) break;
    }
    if (!added) break;
  }
  return selected;
}

function counterfactualActions(regretCase) {
  if (regretCase.format === "snake") return regretCase.alternativeIds.slice(0, 5).map((playerId) => ({
    label: `PLAYER_${playerId}`,
    override: { kind: "snake-player", decisionNumber: regretCase.decisionNumber, playerId },
  }));
  const eventId = regretCase.eventId || auctionEventId(regretCase.eventIndex);
  const decisionKind = regretCase.decisionKind || (regretCase.nominationIntent === "BID" ? "BID" : "NOMINATION");
  const actions = decisionKind === "BID"
    ? [
        { action: "BID" },
        { action: "PASS" },
        {
          action: "ALTERNATE_CEILING",
          ceiling: Math.max(0, Math.floor(Number(regretCase.alternateCeiling ?? regretCase.evidenceOnlyCeiling ?? 0))),
        },
      ]
    : [
        ...(regretCase.targetId || regretCase.targetId === undefined ? [{ action: "TARGET_NOMINATION" }] : []),
        ...(regretCase.drainId || regretCase.drainId === undefined ? [{ action: "DRAIN_NOMINATION" }] : []),
      ];
  return actions.map(({ action, ceiling }) => ({
    label: action === "ALTERNATE_CEILING" ? `${action}_${ceiling}` : action,
    override: {
      kind: decisionKind === "BID" ? "auction-bid" : "auction-nomination",
      eventId,
      action,
      ...(action === "ALTERNATE_CEILING" ? { ceiling } : {}),
    },
  }));
}

function auditAuctionCounterfactualTrace(baseline, candidate, override) {
  const baselineEvents = baseline.counterfactualTrace?.events || [];
  const candidateEvents = candidate.counterfactualTrace?.events || [];
  const targetIndex = baselineEvents.findIndex((event) => event.eventId === override.eventId);
  if (targetIndex < 0 || candidateEvents[targetIndex]?.eventId !== override.eventId) {
    throw new Error(`COUNTERFACTUAL_EVENT_NOT_STABLE:${override.eventId}`);
  }
  for (let index = 0; index < targetIndex; index += 1) {
    const baselineEvent = baselineEvents[index];
    const candidateEvent = candidateEvents[index];
    if (candidateEvent?.eventId !== baselineEvent.eventId
      || candidateEvent.preStateDigest !== baselineEvent.preStateDigest
      || candidateEvent.outcomeDigest !== baselineEvent.outcomeDigest) {
      throw new Error(`COUNTERFACTUAL_PREFIX_DIVERGED:${override.eventId}:at:${baselineEvent.eventId}`);
    }
  }
  const baselineTarget = baselineEvents[targetIndex];
  const candidateTarget = candidateEvents[targetIndex];
  if (candidateTarget.preStateDigest !== baselineTarget.preStateDigest) {
    throw new Error(`COUNTERFACTUAL_TARGET_PREFIX_DIVERGED:${override.eventId}`);
  }
  for (let index = 0; index < Math.min(baselineEvents.length, candidateEvents.length); index += 1) {
    if (candidateEvents[index].eventId !== baselineEvents[index].eventId
      || candidateEvents[index].exogenousDigest !== baselineEvents[index].exogenousDigest) {
      throw new Error(`COUNTERFACTUAL_EXOGENOUS_PATH_DIVERGED:${override.eventId}:at:${baselineEvents[index].eventId}`);
    }
  }
  if (override.kind === "auction-bid"
    && (candidateTarget.nominatedPlayerId !== baselineTarget.nominatedPlayerId
      || candidateTarget.nominationIntent !== baselineTarget.nominationIntent
      || candidateTarget.openingBid !== baselineTarget.openingBid)) {
    throw new Error(`COUNTERFACTUAL_BID_RETARGETED_NOMINATION:${override.eventId}`);
  }
  const changedEventIds = baselineEvents.flatMap((event, index) => (
    candidateEvents[index]?.eventId === event.eventId
      && candidateEvents[index].outcomeDigest !== event.outcomeDigest
      ? [event.eventId]
      : []
  ));
  if (changedEventIds.length && changedEventIds[0] !== override.eventId) {
    throw new Error(`COUNTERFACTUAL_FIRST_CHANGE_WRONG_EVENT:${override.eventId}:at:${changedEventIds[0]}`);
  }
  const expectedApplication = `${override.kind}:${override.action}`;
  if (candidateTarget.overrideApplied !== expectedApplication) {
    throw new Error(`COUNTERFACTUAL_OVERRIDE_NOT_LOCAL:${override.eventId}`);
  }
  if (override.kind === "auction-bid") {
    const evidenceAction = Number(candidateTarget.controlledCeiling || 0)
      > Number(candidateTarget.controlledProductionCeiling || 0);
    if (Boolean(candidateTarget.evidenceOnlyOverride) !== evidenceAction) {
      throw new Error(`COUNTERFACTUAL_EVIDENCE_AUTHORITY_MISMATCH:${override.eventId}`);
    }
    if (evidenceAction
      && Number(candidateTarget.controlledCeiling || 0) > Number(candidateTarget.evidenceOnlyCeiling || 0)) {
      throw new Error(`COUNTERFACTUAL_EVIDENCE_CEILING_EXCEEDED:${override.eventId}`);
    }
    if (!evidenceAction
      && Number(candidateTarget.controlledCeiling || 0) > Number(candidateTarget.controlledProductionCeiling || 0)) {
      throw new Error(`COUNTERFACTUAL_PRODUCTION_CEILING_EXCEEDED:${override.eventId}`);
    }
  }
  return {
    targetEventId: override.eventId,
    prefixStable: true,
    exogenousPathStable: true,
    nominationIdentityStable: override.kind === "auction-bid",
    evidenceOnly: override.kind === "auction-bid"
      && Number(candidateTarget.controlledCeiling || 0) > Number(candidateTarget.controlledProductionCeiling || 0),
    productionCeiling: candidateTarget.controlledProductionCeiling,
    appliedCeiling: candidateTarget.controlledCeiling,
    evidenceOnlyCeiling: candidateTarget.evidenceOnlyCeiling,
    firstChangedEventId: changedEventIds[0] || null,
    changedEventCount: changedEventIds.length,
  };
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
      captureTrace: regretCase.format === "salary-cap",
    });
    if (regretCase.format === "salary-cap") {
      const eventId = regretCase.eventId || auctionEventId(regretCase.eventIndex);
      const decisionKind = regretCase.decisionKind || (regretCase.nominationIntent === "BID" ? "BID" : "NOMINATION");
      const exactDecision = baseline.counterfactualTrace?.decisions.some((decision) => (
        decision.eventId === eventId && decision.decisionKind === decisionKind
      ));
      if (!exactDecision) throw new Error(`COUNTERFACTUAL_DECISION_NOT_FOUND:${eventId}:${decisionKind}`);
    }
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
          captureTrace: regretCase.format === "salary-cap",
        });
        const traceAudit = regretCase.format === "salary-cap"
          ? auditAuctionCounterfactualTrace(baseline, candidate, action.override)
          : null;
        branches.push({
          action: action.label,
          objectiveDelta: candidate.metrics.objective - baseline.metrics.objective,
          lineupDelta: candidate.metrics.startingLineupProjection - baseline.metrics.startingLineupProjection,
          winProbabilityDelta: candidate.metrics.seasonWinProbability - baseline.metrics.seasonWinProbability,
          strengthPercentileDelta: candidate.metrics.seasonStrengthPercentile - baseline.metrics.seasonStrengthPercentile,
          tailStrengthMarginDelta: candidate.metrics.tailStrengthMargin - baseline.metrics.tailStrengthMargin,
          regretDelta: candidate.metrics.decisionRegret - baseline.metrics.decisionRegret,
          violations: candidate.violations,
          draftDigest: candidate.draftDigest,
          ...(traceAudit ? { traceAudit } : {}),
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
      counterfactualClass: regretCase.counterfactualClass,
      ...(regretCase.format === "salary-cap" ? {
        eventId: regretCase.eventId || auctionEventId(regretCase.eventIndex),
        decisionKind: regretCase.decisionKind || (regretCase.nominationIntent === "BID" ? "BID" : "NOMINATION"),
      } : {}),
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
  if (Object.prototype.hasOwnProperty.call(config, "certificationNow")) {
    throw new Error("MONTE_CARLO_FRESHNESS_CLOCK_NOT_INJECTABLE: runtime certification uses the process clock");
  }
  const formats = config.formats || ["snake", "salary-cap"];
  const phases = config.phases || ["discovery", "validation", "holdout"];
  const configuredCounterfactualCases = Number(config.counterfactualCases ?? 10);
  // Runtime freshness is intentionally sampled from the process clock. It is
  // reporting/certification metadata, not deterministic trial evidence, and a
  // caller must not be able to make an old capture current by injecting a
  // historical evaluation instant through simulation config.
  const sourceRuntimeProofAtStart = config.sourceSnapshot
    ? evaluateCurrentSourceSnapshot(config.sourceSnapshot)
    : null;
  const evidenceIdentity = monteCarloEvidenceIdentity({
    sourceSnapshot: config.sourceSnapshot || null,
    formats,
  });
  const orderedOutcomeHasher = createHash("sha256");
  orderedOutcomeHasher.update(`${stableEvidenceJson({
    domain: "draftforge-ordered-trial-outcomes-v2",
    evidenceIdentityDigest: evidenceIdentity.digest,
  })}\n`);
  const aggregate = new Aggregate();
  const formatAggregates = new Map(formats.map((format) => [format, new Aggregate()]));
  const formatFailures = new Map(formats.map((format) => [format, []]));
  const splitAggregates = new Map();
  const scenarioAggregates = new Map();
  const slotAggregates = new Map();
  const counterfactualQueues = Object.fromEntries(COUNTERFACTUAL_CLASSES.map((counterfactualClass) => [
    counterfactualClass,
    [],
  ]));
  const auctionOutcomeStrata = new Map();
  const failureSeeds = [];
  const sealedHoldoutEvidence = new Map(formats.map((format) => {
    const hasher = createHash("sha256");
    hasher.update(`draftforge-sealed-holdout-v3:${evidenceIdentity.digest}:${format}\n`);
    return [format, { count: 0, hasher }];
  }));
  let completed = 0;
  const selectedTrialCount = Array.from({ length: config.drafts }, (_, trialIndex) => splitForTrial(trialIndex, config.drafts))
    .filter((split) => phases.includes(split)).length;
  const total = selectedTrialCount * formats.length;
  for (const format of formats) {
    for (let trialIndex = 0; trialIndex < config.drafts; trialIndex += 1) {
      const split = splitForTrial(trialIndex, config.drafts);
      if (!phases.includes(split)) continue;
      let completedRecord = null;
      let failedRecord = null;
      try {
        const record = simulateDraft({
          format,
          baseSeed: config.seed,
          trialIndex,
          drafts: config.drafts,
          sourceSnapshot: config.sourceSnapshot,
        });
        record.productionCodeDigest = evidenceIdentity.productionCodeDigest;
        record.evidenceIdentityDigest = evidenceIdentity.digest;
        orderedOutcomeHasher.update(`${stableEvidenceJson({
          ordinal: completed,
          status: "completed",
          outcome: orderedTrialOutcome(record),
        })}\n`);
        if (split !== "holdout" || config.exposeHoldout) {
          aggregate.add(record);
          formatAggregates.get(format).add(record);
        }
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
          for (const counterfactualClass of COUNTERFACTUAL_CLASSES) {
            addTopRegret(
              counterfactualQueues[counterfactualClass],
              record.regretCases?.[counterfactualClass],
              Math.max(20, configuredCounterfactualCases * 2),
            );
          }
          for (const outcome of record.auctionOutcomes || []) addAuctionOutcomeStrata(auctionOutcomeStrata, outcome);
        } else {
          const sealed = sealedHoldoutEvidence.get(format);
          sealed.count += 1;
          sealed.hasher.update(`${stableEvidenceJson(orderedTrialOutcome(record))}\n`);
        }
        completedRecord = record;
      } catch (error) {
        const failure = {
          format,
          trialIndex,
          trialSeed: deriveTrialSeed(config.seed, format, trialIndex),
          split,
          error: error instanceof Error ? error.stack || error.message : String(error),
        };
        orderedOutcomeHasher.update(`${stableEvidenceJson({
          ordinal: completed,
          status: "failed",
          outcome: {
            ...failure,
            error: error instanceof Error ? error.message : String(error),
          },
        })}\n`);
        aggregate.addError(failure);
        formatAggregates.get(format)?.addError(failure);
        formatFailures.get(format)?.push(failure);
        failureSeeds.push(failure);
        failedRecord = failure;
      }
      if (completedRecord) await callbacks.onTrial?.(completedRecord);
      else if (failedRecord) await callbacks.onFailure?.(failedRecord);
      completed += 1;
      if (callbacks.onProgress && (completed % Math.max(1, Number(config.progressEvery || 250)) === 0 || completed === total)) {
        await callbacks.onProgress({ completed, total });
      }
    }
  }
  const counterfactualLimit = configuredCounterfactualCases;
  const publicCounterfactualQueues = Object.fromEntries(COUNTERFACTUAL_CLASSES.map((counterfactualClass) => [
    counterfactualClass,
    counterfactualQueues[counterfactualClass].filter((item) => item.split !== "holdout"),
  ]));
  const eligibleCases = selectCounterfactualCases(publicCounterfactualQueues, counterfactualLimit);
  const counterfactuals = config.skipCounterfactuals ? [] : runCounterfactuals(eligibleCases, config);
  const splitSummary = summarizeBreakdowns(splitAggregates);
  const sealedHoldoutDigests = Object.fromEntries([...sealedHoldoutEvidence.entries()].map(([format, value]) => [
    format,
    { count: value.count, digest: value.hasher.digest("hex") },
  ]));
  if (!config.exposeHoldout) {
    for (const key of Object.keys(splitSummary)) {
      if (key.endsWith(":holdout")) splitSummary[key] = {
        drafts: splitSummary[key].drafts,
        sealed: true,
        digest: sealedHoldoutDigests[key.split(":")[0]].digest,
      };
    }
  }
  const completedDrafts = completed - failureSeeds.length;
  const complete = completedDrafts === total && failureSeeds.length === 0;
  const aggregateSummary = aggregate.summary();
  const byFormat = Object.fromEntries(formats.map((format) => {
    const failures = formatFailures.get(format) || [];
    const formatAggregate = formatAggregates.get(format).summary();
    const formatCompleted = selectedTrialCount - failures.length;
    return [format, {
      ...formatAggregate,
      requestedDrafts: selectedTrialCount,
      completedDrafts: formatCompleted,
      complete: formatCompleted === selectedTrialCount && failures.length === 0,
      failureSeeds: failures,
      safetyPassed: failures.length === 0
        && Object.values(formatAggregate.violations).every((value) => Number(value) === 0),
    }];
  }));
  const sourceRuntimeProof = config.sourceSnapshot
    ? completedRuntimeSourceProof(
        sourceRuntimeProofAtStart,
        evaluateCurrentSourceSnapshot(config.sourceSnapshot),
      )
    : null;
  const capturedSourceEvidence = Boolean(config.sourceSnapshot && evidenceIdentity.source.exactFormat);
  const currentSourceEvidence = Boolean(capturedSourceEvidence && sourceRuntimeProof?.current);
  const certification = {
    evidenceClass: currentSourceEvidence
      ? "current-source-snapshot-v3"
      : capturedSourceEvidence ? "captured-source-snapshot-v3" : "synthetic-mechanics-only",
    currentSource: currentSourceEvidence,
    currentSourceCertificationEligible: currentSourceEvidence,
    status: currentSourceEvidence
      ? "CURRENT_SOURCE_SNAPSHOT_V3"
      : capturedSourceEvidence ? "CAPTURED_SOURCE_SNAPSHOT_V3_NON_CURRENT" : "SYNTHETIC_NON_CERTIFYING",
    blockers: currentSourceEvidence
      ? []
      : capturedSourceEvidence
        ? [sourceRuntimeProof?.blocker || "CURRENT_SOURCE_RUNTIME_PROOF_REQUIRED"]
        : ["CURRENT_SOURCE_FORMAT_EXACT_V3_SNAPSHOT_REQUIRED"],
    runtimeFreshness: sourceRuntimeProof,
  };
  const summary = {
    schemaVersion: MONTE_CARLO_SCHEMA_VERSION,
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
      keeperModel: "deterministic source-backed hidden state for every configured keeper slot",
    },
    sourceFixture: config.sourceSnapshot ? {
      kind: "captured-five-source-snapshot",
      livePlayerData: true,
      capturedAt: config.sourceSnapshot.capturedAt,
      digest: config.sourceSnapshot.digest,
      sourceIds: SOURCE_IDS,
      coverageAtLeastFour: config.sourceSnapshot.validation?.coverageAtLeastFour,
      fullFiveSourceCoverage: config.sourceSnapshot.validation?.fullFiveSourceCoverage,
      currentSourceCertification: currentSourceEvidence,
      note: currentSourceEvidence
        ? "All decisions use runtime-fresh captured player/source truth. Eighty percent preserve the exact authenticated league; twenty percent apply that immutable truth to seeded ESPN-compatible rules variants. Configured keeper slots use deterministic legal source-backed hidden identities and prices."
        : "All decisions replay immutable historical captured player/source truth. Eighty percent preserve the exact authenticated league and twenty percent use seeded ESPN-compatible rules variants; this cannot certify current player/source strategy.",
    } : {
      kind: "seeded-five-source-calibrated-fixture",
      livePlayerData: false,
      sourceIds: SOURCE_IDS,
      currentSourceCertification: false,
      note: "All five signals pass through production mergeConsensus; configured keeper slots use deterministic legal source-backed fixture identities and prices. This fallback validates mechanics but is not current player-specific evidence.",
    },
    certification,
    evidence: {
      schemaVersion: MONTE_CARLO_EVIDENCE_SCHEMA_VERSION,
      identity: evidenceIdentity,
      orderedTrialOutcomeDigest: orderedOutcomeHasher.digest("hex"),
      orderedTrialCount: completed,
      boundedMemory: true,
    },
    aggregate: aggregateSummary,
    byFormat,
    requestedDrafts: total,
    completedDrafts,
    complete,
    splits: splitSummary,
    scenarios: summarizeBreakdowns(scenarioAggregates),
    draftSlots: summarizeBreakdowns(slotAggregates),
    auctionOutcomeStrata: summarizeAuctionOutcomeStrata(auctionOutcomeStrata),
    counterfactualQueues: Object.fromEntries(COUNTERFACTUAL_CLASSES.map((counterfactualClass) => [
      counterfactualClass,
      publicCounterfactualQueues[counterfactualClass].slice(0, 10),
    ])),
    topRegretCases: selectCounterfactualCases(publicCounterfactualQueues, 10),
    topUnderbidCases: publicCounterfactualQueues["auction-underbid"].slice(0, 10),
    counterfactuals,
    failureSeeds,
  };
  summary.determinismDigest = sha256(stableEvidenceJson({
    schemaVersion: MONTE_CARLO_SCHEMA_VERSION,
    evidenceIdentityDigest: summary.evidence.identity.digest,
    orderedTrialOutcomeDigest: summary.evidence.orderedTrialOutcomeDigest,
    config: summary.config,
    counterfactuals: summary.counterfactuals,
  }));
  return summary;
}

export function assertCompleteMonteCarloRun(summary) {
  if (!summary?.complete
    || !Array.isArray(summary?.failureSeeds)
    || summary.failureSeeds.length > 0
    || !Number.isSafeInteger(summary.requestedDrafts)
    || summary.requestedDrafts <= 0
    || summary.completedDrafts !== summary.requestedDrafts) {
    throw new Error(
      `MONTE_CARLO_INCOMPLETE: completed ${Number(summary?.completedDrafts || 0)}/${Number(summary?.requestedDrafts || 0)} requested drafts; failures=${Array.isArray(summary?.failureSeeds) ? summary.failureSeeds.length : "unknown"}`,
    );
  }
  return summary;
}

export function assertCurrentSourceMonteCarloRun(summary, sourceSnapshot) {
  assertCompleteMonteCarloRun(summary);
  const sourceIdentity = summary?.evidence?.identity?.source;
  const runtimeFreshness = summary?.certification?.runtimeFreshness;
  const startedAtMs = Date.parse(runtimeFreshness?.startedAt || "");
  const completedAtMs = Date.parse(runtimeFreshness?.completedAt || "");
  const capturedAtMs = Date.parse(runtimeFreshness?.capturedAt || "");
  const recomputedStartAgeMs = startedAtMs - capturedAtMs;
  const recomputedCompletionAgeMs = completedAtMs - capturedAtMs;
  // A serialized summary is not its own freshness authority. Re-evaluate the
  // separately supplied snapshot against the real wall clock at the gate so
  // editing status/proof fields or replaying a once-current summary cannot
  // forge current-source certification.
  const externalRuntimeFreshness = sourceSnapshot
    ? evaluateCurrentSourceSnapshot(sourceSnapshot)
    : null;
  const externallyEvaluatedAtMs = Date.parse(externalRuntimeFreshness?.evaluatedAt || "");
  const summaryGeneratedAtMs = Date.parse(summary?.generatedAt || "");
  const externalDigest = sourceSnapshot ? sourceSnapshotDigest(sourceSnapshot) : null;
  const externalFormat = (() => {
    try {
      return sourceSnapshot ? sourceSnapshotFormat(sourceSnapshot) : null;
    } catch {
      return null;
    }
  })();
  if (summary?.certification?.currentSource !== true
    || summary?.certification?.currentSourceCertificationEligible !== true
    || summary?.certification?.status !== "CURRENT_SOURCE_SNAPSHOT_V3"
    || summary?.certification?.evidenceClass !== "current-source-snapshot-v3"
    || !Array.isArray(summary?.certification?.blockers)
    || summary.certification.blockers.length !== 0
    || sourceIdentity?.kind !== "captured-five-source-snapshot"
    || sourceIdentity?.schemaVersion !== SOURCE_SNAPSHOT_SCHEMA_VERSION
    || sourceIdentity?.exactFormat !== true
    || !sourceIdentity?.digest
    || summary?.sourceFixture?.livePlayerData !== true
    || summary?.sourceFixture?.digest !== sourceIdentity.digest
    || summary?.config?.sourceSnapshotDigest !== sourceIdentity.digest
    || summary?.config?.formats?.length !== 1
    || summary.config.formats[0] !== sourceIdentity.format
    || runtimeFreshness?.schemaVersion !== MONTE_CARLO_SCHEMA_VERSION
    || runtimeFreshness?.snapshotDigest !== sourceIdentity.digest
    || runtimeFreshness?.capturedAt !== sourceIdentity.capturedAt
    || runtimeFreshness?.capturedAt !== summary.sourceFixture.capturedAt
    || runtimeFreshness?.maxAgeMs !== CURRENT_SOURCE_SNAPSHOT_MAX_AGE_MS
    || runtimeFreshness?.currentAtStart !== true
    || runtimeFreshness?.currentAtCompletion !== true
    || runtimeFreshness?.current !== true
    || runtimeFreshness?.blocker !== null
    || runtimeFreshness?.providerFreshAtStart !== true
    || runtimeFreshness?.providerFreshAtCompletion !== true
    || !Number.isFinite(startedAtMs)
    || !Number.isFinite(completedAtMs)
    || !Number.isFinite(capturedAtMs)
    || completedAtMs < startedAtMs
    || recomputedStartAgeMs < 0
    || recomputedCompletionAgeMs > CURRENT_SOURCE_SNAPSHOT_MAX_AGE_MS
    || runtimeFreshness?.ageAtStartMs !== recomputedStartAgeMs
    || runtimeFreshness?.ageAtCompletionMs !== recomputedCompletionAgeMs) {
    throw new Error("MONTE_CARLO_CURRENT_SOURCE_REQUIRED: runtime-fresh exact-format v3 source evidence is required");
  }
  if (!sourceSnapshot
    || sourceSnapshot.schemaVersion !== SOURCE_SNAPSHOT_SCHEMA_VERSION
    || sourceSnapshot.digest !== externalDigest
    || externalDigest !== sourceIdentity.digest
    || externalFormat !== sourceIdentity.format
    || externalRuntimeFreshness?.current !== true
    || externalRuntimeFreshness?.blocker !== null
    || externalRuntimeFreshness?.providerFreshAtEvaluation !== true
    || externalRuntimeFreshness?.snapshotDigest !== sourceIdentity.digest
    || externalRuntimeFreshness?.capturedAt !== runtimeFreshness.capturedAt
    || !Number.isFinite(externallyEvaluatedAtMs)
    || externallyEvaluatedAtMs < completedAtMs
    || !Number.isFinite(summaryGeneratedAtMs)
    || summaryGeneratedAtMs < completedAtMs) {
    throw new Error("MONTE_CARLO_CURRENT_SOURCE_REQUIRED: external runtime-fresh exact-format v3 source evidence is required");
  }
  return summary;
}

function fixed(value, digits = 2) {
  return Number(value || 0).toFixed(digits);
}

function metricRow(label, metric) {
  if (!metric) return `| ${label} | — | — | — |`;
  return `| ${label} | ${fixed(metric.mean)} | ${fixed(metric.p25)} | ${fixed(metric.ci95?.[0])}–${fixed(metric.ci95?.[1])} |`;
}

function decisionEvaluationLabel(item) {
  if (item.decisionKind === "NOMINATION") return "Nomination proxy";
  if (item.bidOutcome === "PASS") return "Bid pass";
  if (item.bidOutcome === "LOST") return "Lost bid";
  if (item.bidOutcome === "DRAIN_NON_ACTION") return "Drain non-action";
  return "Acquisition";
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
    `Evidence class: **${summary.certification.status}**. ${summary.certification.currentSource
      ? "This run is bound to one runtime-fresh exact format-matched v3 source snapshot."
      : summary.sourceFixture.livePlayerData
        ? "This exact captured-source replay is non-current and cannot certify current player/source strategy."
        : "This synthetic mechanics run is explicitly non-certifying for current player/source strategy."}`,
    "",
    `Production code identity: \`${summary.evidence.identity.productionCodeDigest}\` · ordered outcomes: \`${summary.evidence.orderedTrialOutcomeDigest}\` (${summary.evidence.orderedTrialCount.toLocaleString()} trials, streaming bounded-memory digest).`,
    "",
    summary.sourceFixture.livePlayerData
      ? "The simulation imports DraftForge’s production decision engine. Eighty percent of trials preserve the snapshot’s exact authenticated league, while twenty percent reuse the same immutable captured player truth under seeded ESPN-compatible rules variants. Variant results are labeled separately and do not claim that sources were fetched for those alternate profiles."
      : "The simulation imports DraftForge’s production decision engine. Opponents use seeded non-DraftForge archetypes. Eighty percent of trials use sanitized authenticated-settings fixtures and twenty percent use ESPN-compatible adversarial variants.",
    "",
    summary.sourceFixture.livePlayerData
      ? `Player inputs replay immutable live source snapshot \`${summary.sourceFixture.digest}\` captured at ${summary.sourceFixture.capturedAt}. Source truth is fixed within every decision; seeded uncertainty affects hidden outcomes, not the recommendation inputs.`
      : "Player inputs are a deterministic five-source-calibrated fixture passed through the production consensus merger. This fallback run validates strategy mechanics and robustness, not current player-specific advice.",
    "",
    `Keeper handling: ${summary.config.keeperModel}. Sanitized authenticated settings bind the keeper count exactly; private keeper identities and acquisition prices remain an explicit seeded hidden-state assumption.`,
    "",
    "## Aggregate metrics",
    "",
    "| Metric | Mean | P25 | 95% CI of mean |",
    "| --- | ---: | ---: | ---: |",
    metricRow("Starting-lineup projection", metrics.startingLineupProjection),
    metricRow("Total projection", metrics.totalProjection),
    metricRow("VORP", metrics.vorp),
    metricRow("Season win probability", metrics.seasonWinProbability),
    metricRow("Season strength percentile", metrics.seasonStrengthPercentile),
    metricRow("Upper-quartile strength margin", metrics.tailStrengthMargin),
    metricRow("Decision regret", metrics.decisionRegret),
    metricRow("Missed bid-opportunity regret", metrics.missedBidOpportunityRegret),
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
    "## Format safety breakdown",
    "",
    "| Format | Completed | Failures | Hard violations | Gate |",
    "| --- | ---: | ---: | ---: | --- |",
    ...Object.entries(summary.byFormat).map(([format, value]) => {
      const formatViolations = Object.values(value.violations).reduce((sum, count) => sum + Number(count || 0), 0);
      return `| ${format} | ${value.completedDrafts}/${value.requestedDrafts} | ${value.failureSeeds.length} | ${formatViolations} | ${value.safetyPassed ? "PASS" : "FAIL"} |`;
    }),
    "",
    ...(summary.byFormat["salary-cap"]?.metrics?.auctionBidOpportunities ? [
      `Salary-cap bid evidence (mean per draft): ${fixed(summary.byFormat["salary-cap"].metrics.auctionBidOpportunities.mean)} opportunities · ${fixed(summary.byFormat["salary-cap"].metrics.auctionBidWins.mean)} wins · ${fixed(summary.byFormat["salary-cap"].metrics.auctionBidLosses.mean)} losses · ${fixed(summary.byFormat["salary-cap"].metrics.auctionBidPasses.mean)} passes · ${fixed(summary.byFormat["salary-cap"].metrics.auctionDrainNonActions.mean)} intentional drain non-actions.`,
      "",
    ] : []),
  ];
  if (comparison) {
    lines.push("## Baseline versus final paired metrics", "", comparison, "");
  }
  const auctionStrataRows = Object.entries(summary.auctionOutcomeStrata || {}).flatMap(([dimension, buckets]) => (
    Object.entries(buckets).map(([bucket, value]) => `| ${dimension} | ${bucket} | ${value.opportunities} | ${fixed(value.winRate, 4)} | ${fixed(value.regret.mean)} | ${fixed(value.surplus.mean)} |`)
  ));
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
    "## Salary-cap evidence strata",
    "",
    "| Dimension | Bucket | Opportunities | Win rate | Mean regret | Mean acquired surplus |",
    "| --- | --- | ---: | ---: | ---: | ---: |",
    ...auctionStrataRows,
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
    ...summary.topRegretCases.map((item) => `| ${item.format} | ${item.trialIndex} | ${item.split} | ${item.decisionNumber} | ${decisionEvaluationLabel(item)} | ${fixed(item.regret)} | \`npm run simulate:monte-carlo -- --drafts ${summary.config.draftsPerFormat} --seed ${summary.config.seed} --replay ${item.format}:${item.trialIndex}\` |`),
    "",
    "## Retrospective underbid probes",
    "",
    "| Trial | Event | Production ceiling | Evidence-only ceiling | Price to win | Opportunity regret |",
    "| ---: | --- | ---: | ---: | ---: | ---: |",
    ...summary.topUnderbidCases.map((item) => `| ${item.trialIndex} | ${item.eventId} | $${item.approvedCeiling} | $${item.evidenceOnlyCeiling} | $${item.priceToWin} | ${fixed(item.regret)} |`),
    "",
    "Every legal salary-cap bid opportunity is logged separately. Counterfactuals are sampled from separate snake-pick, acquired-player, underbid, target-nomination, and drain-nomination queues, so deliberate drain nominations cannot crowd out other decision classes. Acquired-player regret is price/acquirability-aware and uses bounded BID, PASS, and alternate-ceiling continuations instead of unrelated raw player ranks. Nomination proxies remain excluded from aggregate regret. Evidence-only higher ceilings never become production maxBid values or live authorization.",
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
    "- Static-roster win probability is a smooth deterministic strength estimate; it excludes waivers, trades, lineup management, and injuries after draft day, which are outside the ESPN-only draft scope.",
    "- Counterfactual branches test complete continuations for bounded high-regret cases; they are evidence for repeated decision classes, not proof of global optimality.",
    "- Quantiles use a bounded deterministic reservoir while means and confidence intervals stream across every completed trial.",
    "",
  );
  return lines.join("\n");
}
