import { createHash } from "node:crypto";
import { isIntelligenceSourceFresh, mergeConsensus } from "../app/lib/consensus.ts";
import { recommendPlayers } from "../app/lib/draft-engine.ts";

export const SOURCE_SNAPSHOT_SCHEMA_VERSION = 1;
export const PUBLIC_SOURCE_IDS = ["ffc", "mfl", "tradyr", "gng"];
const POSITIONS = ["QB", "RB", "WR", "TE", "K", "DST"];

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
}

export function stableSnapshotJson(value) {
  return JSON.stringify(canonicalize(value));
}

function digestPayload(snapshot) {
  return {
    schemaVersion: snapshot.schemaVersion,
    capturedAt: snapshot.capturedAt,
    parameters: snapshot.parameters,
    league: snapshot.league,
    espnPlayers: snapshot.espnPlayers,
    sources: snapshot.sources,
  };
}

export function sourceSnapshotDigest(snapshot) {
  return createHash("sha256").update(stableSnapshotJson(digestPayload(snapshot))).digest("hex");
}

export function sanitizeLeagueSettings(league) {
  const size = Math.max(1, Number(league?.size || 0));
  return {
    id: String(league?.id || "snapshot"),
    name: "Sanitized ESPN snapshot",
    season: Number(league?.season || 0),
    size,
    teamId: Number(league?.teamId || 0) || null,
    draftType: String(league?.draftType || "SNAKE") === "AUCTION" ? "AUCTION" : "SNAKE",
    secondsPerPick: Number(league?.secondsPerPick || 0),
    rosterSize: Number(league?.rosterSize || 0),
    auctionBudget: Number(league?.auctionBudget || 200),
    pickOrder: Array.isArray(league?.pickOrder) ? league.pickOrder.map(Number) : [],
    lineupSlotCounts: Object.fromEntries(Object.entries(league?.lineupSlotCounts || {}).map(([slot, count]) => [slot, Number(count || 0)])),
    positionLimits: Object.fromEntries(Object.entries(league?.positionLimits || {}).map(([position, limit]) => [position, Number(limit || 0)])),
    scoringLabel: String(league?.scoringLabel || "Custom"),
    scoringRules: Number(league?.scoringRules || 0),
    keeperCount: Number(league?.keeperCount || 0),
    teams: Array.from({ length: size }, (_, index) => ({ id: index + 1, name: `Snapshot Team ${index + 1}`, abbrev: `S${index + 1}` })),
  };
}

export function sanitizeEspnPlayers(players) {
  return (Array.isArray(players) ? players : []).flatMap((player) => {
    const id = Number(player?.id);
    const pos = String(player?.pos || "");
    // ESPN uses stable negative IDs for D/ST entities. Only 0 and -1 are
    // placeholders; every other signed integer is a valid draft-pool ID.
    if (!Number.isInteger(id) || id === 0 || id === -1 || !POSITIONS.includes(pos)) return [];
    return [{
      id,
      name: String(player?.name || "").trim(),
      team: String(player?.team || "FA").trim() || "FA",
      pos,
      rank: Number(player?.rank || 999),
      adp: Number(player?.adp || 999),
      auction: Math.max(1, Number(player?.auction || 1)),
      projected: Math.max(0, Number(player?.projected || 0)),
      injured: Boolean(player?.injured),
    }];
  }).sort((left, right) => left.id - right.id);
}

function sourceSummary(source, capturedAt) {
  return {
    id: source.id,
    status: source.status,
    fresh: isIntelligenceSourceFresh(source, capturedAt),
    players: source.players?.length || 0,
    updatedAt: source.updatedAt || null,
    retrievedAt: source.retrievedAt || null,
    sampleSize: Number(source.sampleSize || 0),
    error: source.error || null,
  };
}

export function validateSourceSnapshot(snapshot) {
  const errors = [];
  const warnings = [];
  const capturedAtMs = Date.parse(snapshot?.capturedAt || "");
  if (snapshot?.schemaVersion !== SOURCE_SNAPSHOT_SCHEMA_VERSION) errors.push("Unsupported snapshot schema version.");
  if (!Number.isFinite(capturedAtMs)) errors.push("Snapshot capturedAt is invalid.");
  const league = sanitizeLeagueSettings(snapshot?.league || {});
  if (!Number.isInteger(league.size) || league.size < 8 || league.size > 16) errors.push("League size must be ESPN-compatible (8–16)." );
  if (!Number.isInteger(league.rosterSize) || league.rosterSize < 1) errors.push("League roster size is invalid.");
  const espnPlayers = sanitizeEspnPlayers(snapshot?.espnPlayers);
  const rosterable = league.size * league.rosterSize;
  if (espnPlayers.length < rosterable) errors.push(`ESPN player board has ${espnPlayers.length} rows; at least ${rosterable} are required.`);
  if (new Set(espnPlayers.map((player) => player.id)).size !== espnPlayers.length) errors.push("ESPN player IDs are not unique.");
  for (const position of POSITIONS) {
    if (!espnPlayers.some((player) => player.pos === position)) errors.push(`ESPN player board is missing ${position}.`);
  }
  const sources = Array.isArray(snapshot?.sources) ? snapshot.sources : [];
  const sourceIds = sources.map((source) => source.id).sort();
  if (stableSnapshotJson(sourceIds) !== stableSnapshotJson([...PUBLIC_SOURCE_IDS].sort())) {
    errors.push("Snapshot must contain exactly FFC, MFL, Tradyr, and GNG once each.");
  }
  const summaries = sources.map((source) => sourceSummary(source, snapshot?.capturedAt));
  for (const source of summaries) {
    if (source.status !== "ok") errors.push(`${source.id} capture failed: ${source.error || "unknown error"}.`);
    else if (!source.fresh) errors.push(`${source.id} is stale at snapshot time.`);
    if (source.players <= 0) errors.push(`${source.id} returned no players.`);
  }
  let consensus = [];
  if (!errors.length) {
    consensus = mergeConsensus(espnPlayers, sources, league, { evaluatedAt: snapshot.capturedAt });
    const top = [...consensus].sort((left, right) => Number(left.consensusRank) - Number(right.consensusRank)).slice(0, rosterable);
    const coverage = top.length ? top.filter((player) => player.sourceCount >= 4).length / top.length : 0;
    const fullCoverage = top.length ? top.filter((player) => player.sourceCount === 5).length / top.length : 0;
    const completeMarketModelCoverageCount = consensus.filter((player) => (
      player.modelSourceCount === 2 && player.marketSourceCount === 3
    )).length;
    const recommendations = recommendPlayers(consensus, [], league, "BALANCED");
    const sleeperSignals = recommendations.filter((player) => player.sleeperLabel !== "NONE");
    const positiveSleeperEvidence = recommendations.filter((player) => player.sleeperScore > 0);
    const strongSleeperEdges = positiveSleeperEvidence.filter((player) => player.modelMarketEdge >= 8);
    const scoredSleeperEvidence = strongSleeperEdges.filter((player) => player.sleeperScore >= 50);
    const sleeperSignalCounts = Object.fromEntries(["VALUE", "SLEEPER", "DEEP_STASH"].map((label) => [
      label,
      sleeperSignals.filter((player) => player.sleeperLabel === label).length,
    ]));
    const sleeperCandidates = sleeperSignals.slice(0, 20).map((player) => ({
      id: player.id,
      name: player.name,
      position: player.pos,
      adp: Number(player.adp),
      consensusRank: Number(player.consensusRank),
      label: player.sleeperLabel,
      score: Number(player.sleeperScore),
      modelMarketEdge: Number(player.modelMarketEdge || 0),
      modelSpread: Number(player.modelSpread || 0),
      sourceCount: Number(player.sourceCount || 0),
    }));
    const sourceReach = Object.fromEntries(summaries.map((source) => [source.id, source.players]));
    if (coverage < .5) warnings.push(`Only ${(coverage * 100).toFixed(1)}% of the rosterable board has at least four-source coverage.`);
    if (!completeMarketModelCoverageCount) {
      warnings.push("No player has complete market/model corroboration for sleeper classification.");
    }
    if (!sleeperSignals.length) warnings.push("No player currently qualifies for a production sleeper signal.");
    return {
      valid: true,
      errors,
      warnings,
      sourceSummaries: summaries,
      sourceReach,
      espnPlayers: espnPlayers.length,
      rosterablePlayers: rosterable,
      coverageAtLeastFour: coverage,
      fullFiveSourceCoverage: fullCoverage,
      completeMarketModelCoverageCount,
      corroboratedSleeperCandidateCount: sleeperSignals.length,
      sleeperEvidenceFunnel: {
        completeMarketModelCoverage: completeMarketModelCoverageCount,
        positiveModelEvidence: positiveSleeperEvidence.length,
        modelEdgeAtLeastEight: strongSleeperEdges.length,
        sleeperScoreAtLeastFifty: scoredSleeperEvidence.length,
        productionSignals: sleeperSignals.length,
      },
      sleeperSignalCounts,
      sleeperCandidates,
      consensusDigest: createHash("sha256").update(stableSnapshotJson(consensus)).digest("hex"),
    };
  }
  return {
    valid: false,
    errors,
    warnings,
    sourceSummaries: summaries,
    sourceReach: Object.fromEntries(summaries.map((source) => [source.id, source.players])),
    espnPlayers: espnPlayers.length,
    rosterablePlayers: rosterable,
    coverageAtLeastFour: 0,
    fullFiveSourceCoverage: 0,
    completeMarketModelCoverageCount: 0,
    corroboratedSleeperCandidateCount: 0,
    sleeperEvidenceFunnel: {
      completeMarketModelCoverage: 0,
      positiveModelEvidence: 0,
      modelEdgeAtLeastEight: 0,
      sleeperScoreAtLeastFifty: 0,
      productionSignals: 0,
    },
    sleeperSignalCounts: { VALUE: 0, SLEEPER: 0, DEEP_STASH: 0 },
    sleeperCandidates: [],
    consensusDigest: null,
  };
}

export function createSourceSnapshot({ capturedAt = new Date().toISOString(), league, espnPlayers, intelligence }) {
  const snapshot = {
    schemaVersion: SOURCE_SNAPSHOT_SCHEMA_VERSION,
    capturedAt,
    parameters: {
      scoring: intelligence?.scoring || league?.scoringLabel || "PPR",
      teams: Number(intelligence?.teams || league?.size || 12),
      season: Number(intelligence?.season || league?.season || 2026),
    },
    league: sanitizeLeagueSettings(league),
    espnPlayers: sanitizeEspnPlayers(espnPlayers),
    sources: Array.isArray(intelligence?.sources) ? intelligence.sources : [],
  };
  const validation = validateSourceSnapshot(snapshot);
  const digest = sourceSnapshotDigest(snapshot);
  return { ...snapshot, digest, validation };
}

export function replayConsensusSnapshot(snapshot, leagueOverride) {
  const expectedDigest = sourceSnapshotDigest(snapshot);
  if (snapshot?.digest !== expectedDigest) throw new Error("source snapshot digest mismatch");
  const validation = validateSourceSnapshot(snapshot);
  if (!validation.valid) throw new Error(`source snapshot invalid: ${validation.errors.join(" ")}`);
  return mergeConsensus(snapshot.espnPlayers, snapshot.sources, leagueOverride || snapshot.league, { evaluatedAt: snapshot.capturedAt });
}
