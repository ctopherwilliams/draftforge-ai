import { createHash } from "node:crypto";
import { intelligenceQuarterbackMode, isIntelligenceSourceFresh, mergeConsensus, normalizePlayerName } from "../app/lib/consensus.ts";
import { openStarterSlots, positionLimitFor, recommendPlayers } from "../app/lib/draft-engine.ts";
import {
  AUTHENTICATED_ESPN_CAPTURE_DIGEST_DOMAIN,
  sanitizeAuthenticatedEspnLeague,
  sanitizeAuthenticatedEspnPlayers,
} from "../app/lib/authenticated-espn-capture.ts";

export const SOURCE_SNAPSHOT_SCHEMA_VERSION = 3;
export const CURRENT_SOURCE_SNAPSHOT_MAX_AGE_MS = 30 * 60 * 1000;
export const PUBLIC_SOURCE_IDS = ["ffc", "mfl", "tradyr", "gng"];
const POSITIONS = ["QB", "RB", "WR", "TE", "K", "DST"];
const REQUIRED_SOURCE_POSITIONS = ["QB", "RB", "WR", "TE"];
const MIN_SOURCE_PLAYER_COVERAGE = 25;
const SPECIALIST_POSITIONS = new Set(["K", "DST"]);

export function sourceSnapshotFormat(snapshot) {
  const draftType = String(snapshot?.league?.draftType || "").trim().toUpperCase();
  if (draftType === "SNAKE") return "snake";
  if (draftType === "AUCTION") return "salary-cap";
  throw new Error("source snapshot draft format invalid");
}

function coverageMetrics(players) {
  const total = players.length;
  const atLeastFourCount = players.filter((player) => Number(player.sourceCount) >= 4).length;
  const fullFiveCount = players.filter((player) => Number(player.sourceCount) === 5).length;
  return {
    total,
    atLeastFourCount,
    atLeastFourRate: total ? atLeastFourCount / total : 0,
    fullFiveCount,
    fullFiveRate: total ? fullFiveCount / total : 0,
  };
}

export function buildCoverageBreakdown(consensus, rosterable) {
  const board = [...consensus]
    .sort((left, right) => Number(left.consensusRank) - Number(right.consensusRank))
    .slice(0, Math.max(0, Number(rosterable || 0)));
  const ranges = [
    { id: "early", first: 1, last: Math.min(48, board.length) },
    { id: "middle", first: 49, last: Math.min(96, board.length) },
    { id: "late", first: 97, last: board.length },
  ].filter((range) => range.first <= range.last);
  return {
    overall: coverageMetrics(board),
    byPosition: Object.fromEntries(POSITIONS.map((position) => [
      position,
      coverageMetrics(board.filter((player) => player.pos === position)),
    ])),
    byDraftRange: Object.fromEntries(ranges.map((range) => [
      range.id,
      {
        first: range.first,
        last: range.last,
        ...coverageMetrics(board.slice(range.first - 1, range.last)),
      },
    ])),
  };
}

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
    provenance: snapshot.provenance,
    parameters: snapshot.parameters,
    league: snapshot.league,
    espnPlayers: snapshot.espnPlayers,
    sources: snapshot.sources,
  };
}

export function sourceSnapshotDigest(snapshot) {
  return createHash("sha256").update(stableSnapshotJson(digestPayload(snapshot))).digest("hex");
}

export function evaluateCurrentSourceSnapshot(snapshot, { now = Date.now() } = {}) {
  const evaluatedAtMs = typeof now === "number" ? now : Date.parse(String(now || ""));
  const capturedAtMs = Date.parse(snapshot?.capturedAt || "");
  const snapshotDigest = sourceSnapshotDigest(snapshot || {});
  const providerFreshAtEvaluation = Number.isFinite(evaluatedAtMs)
    && Array.isArray(snapshot?.sources)
    && snapshot.sources.length === PUBLIC_SOURCE_IDS.length
    && snapshot.sources.every((source) => isIntelligenceSourceFresh(source, new Date(evaluatedAtMs).toISOString()));
  let blocker = null;
  if (!Number.isFinite(evaluatedAtMs)) blocker = "SOURCE_SNAPSHOT_EVALUATION_TIME_INVALID";
  else if (!Number.isFinite(capturedAtMs)) blocker = "SOURCE_SNAPSHOT_CAPTURE_TIME_INVALID";
  else if (capturedAtMs > evaluatedAtMs) blocker = "SOURCE_SNAPSHOT_CAPTURED_IN_FUTURE";
  else if (evaluatedAtMs - capturedAtMs > CURRENT_SOURCE_SNAPSHOT_MAX_AGE_MS) {
    blocker = "SOURCE_SNAPSHOT_CAPTURE_STALE";
  } else if (!providerFreshAtEvaluation) {
    blocker = "SOURCE_SNAPSHOT_PROVIDER_STALE";
  }
  return {
    schemaVersion: 1,
    snapshotDigest,
    capturedAt: snapshot?.capturedAt || null,
    evaluatedAt: Number.isFinite(evaluatedAtMs) ? new Date(evaluatedAtMs).toISOString() : null,
    ageMs: Number.isFinite(evaluatedAtMs) && Number.isFinite(capturedAtMs)
      ? evaluatedAtMs - capturedAtMs
      : null,
    maxAgeMs: CURRENT_SOURCE_SNAPSHOT_MAX_AGE_MS,
    providerFreshAtEvaluation,
    current: blocker === null,
    blocker,
  };
}

export function sanitizeLeagueSettings(league) {
  return sanitizeAuthenticatedEspnLeague(league || {});
}

export function sanitizeEspnPlayers(players) {
  return sanitizeAuthenticatedEspnPlayers(players);
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

function draftableEspnFeasibility(players, league) {
  const available = players.filter((player) => player.unavailable !== true);
  const rosterable = league.size * league.rosterSize;
  const capacityByPosition = Object.fromEntries(POSITIONS.map((position) => {
    const configuredLimit = positionLimitFor(league, position);
    const perTeamLimit = Math.max(0, Math.min(
      league.rosterSize,
      Number.isFinite(configuredLimit) ? configuredLimit : league.rosterSize,
      SPECIALIST_POSITIONS.has(position) ? 1 : league.rosterSize,
    ));
    const availableAtPosition = available.filter((player) => player.pos === position).length;
    return [position, Math.min(availableAtPosition, league.size * perTeamLimit)];
  }));
  const capacityPositions = POSITIONS.flatMap((position) => (
    Array.from({ length: capacityByPosition[position] }, () => position)
  ));
  const aggregateLeague = {
    ...league,
    rosterSize: rosterable,
    lineupSlotCounts: Object.fromEntries(Object.entries(league.lineupSlotCounts || {}).map(([slot, count]) => [
      slot,
      Math.max(0, Math.floor(Number(count) || 0)) * league.size,
    ])),
  };
  return {
    available,
    capacityByPosition,
    totalCapacity: capacityPositions.length,
    openAggregateStarterSlots: openStarterSlots(aggregateLeague, capacityPositions),
  };
}

export function validateSourceSnapshot(snapshot) {
  const errors = [];
  const warnings = [];
  const capturedAtMs = Date.parse(snapshot?.capturedAt || "");
  if (snapshot?.schemaVersion !== SOURCE_SNAPSHOT_SCHEMA_VERSION) errors.push("Unsupported snapshot schema version.");
  if (!Number.isFinite(capturedAtMs)) errors.push("Snapshot capturedAt is invalid.");
  const league = sanitizeLeagueSettings(snapshot?.league || {});
  if (stableSnapshotJson(snapshot?.league) !== stableSnapshotJson(league)) {
    errors.push("Snapshot ESPN league is not in the exact sanitized schema.");
  }
  const provenance = snapshot?.provenance;
  const espnProvenance = provenance?.espnCapture;
  const publicProvenance = provenance?.publicConsensus;
  const fixedWeights = { espn: .30, gng: .20, tradyr: .20, ffc: .15, mfl: .15 };
  if (!provenance || typeof provenance !== "object" || Array.isArray(provenance)
    || !espnProvenance || typeof espnProvenance !== "object" || Array.isArray(espnProvenance)
    || espnProvenance.schemaVersion !== 2
    || espnProvenance.transport !== "draftforge-chrome-companion"
    || espnProvenance.capturedAt !== snapshot?.capturedAt
    || !/^sha256:[a-f0-9]{64}$/.test(String(espnProvenance.digest || ""))
    || espnProvenance.receiptConsumed !== true) {
    errors.push("Snapshot authenticated ESPN capture provenance is invalid.");
  }
  if (!publicProvenance || typeof publicProvenance !== "object" || Array.isArray(publicProvenance)
    || !/^sha256:[a-f0-9]{64}$/.test(String(publicProvenance.sourceSnapshotId || ""))
    || !Number.isFinite(Date.parse(String(publicProvenance.generatedAt || "")))
    || publicProvenance.methodology?.method !== "freshness-gated weighted percentile consensus"
    || stableSnapshotJson(publicProvenance.methodology?.weights) !== stableSnapshotJson(fixedWeights)) {
    errors.push("Snapshot public consensus provenance is invalid.");
  }
  const rulesFingerprint = league.rulesFingerprint;
  if (!rulesFingerprint || typeof rulesFingerprint !== "object" || Array.isArray(rulesFingerprint)
    || Number(rulesFingerprint.secondsPerPick) !== Number(league.secondsPerPick)
    || Number(rulesFingerprint.keeperCount) !== Number(league.keeperCount)
    || stableSnapshotJson(rulesFingerprint.pickOrder) !== stableSnapshotJson(league.pickOrder)
    || stableSnapshotJson(rulesFingerprint.lineupSlotCounts) !== stableSnapshotJson(league.lineupSlotCounts)
    || stableSnapshotJson(rulesFingerprint.positionLimits) !== stableSnapshotJson(league.positionLimits)
    || !Array.isArray(rulesFingerprint.scoringItems)
    || rulesFingerprint.scoringItems.length !== league.scoringRules) {
    errors.push("Snapshot exact ESPN rules fingerprint is invalid.");
  }
  try {
    sourceSnapshotFormat(snapshot);
  } catch {
    errors.push("Snapshot draft format must be SNAKE or AUCTION.");
  }
  const parameterScoring = String(snapshot?.parameters?.scoring || "").trim();
  const parameterTeams = Number(snapshot?.parameters?.teams);
  const parameterSeason = Number(snapshot?.parameters?.season);
  if (!parameterScoring || parameterScoring.toUpperCase() !== league.scoringLabel.trim().toUpperCase()) {
    errors.push("Snapshot scoring parameter does not match ESPN league settings.");
  }
  if (!Number.isSafeInteger(parameterTeams) || parameterTeams !== league.size) {
    errors.push("Snapshot team-count parameter does not match ESPN league settings.");
  }
  if (!Number.isSafeInteger(parameterSeason) || parameterSeason !== league.season) {
    errors.push("Snapshot season parameter does not match ESPN league settings.");
  }
  const quarterbackMode = Number(snapshot?.parameters?.qbs);
  if (![1, 2].includes(quarterbackMode)) errors.push("Snapshot quarterback profile must be one-QB or two-QB.");
  else if (quarterbackMode !== intelligenceQuarterbackMode(league.lineupSlotCounts)) {
    errors.push("Snapshot quarterback profile does not match ESPN starter slots.");
  }
  if (!Number.isInteger(league.size) || league.size < 8 || league.size > 16) errors.push("League size must be ESPN-compatible (8–16)." );
  if (!Number.isInteger(league.rosterSize) || league.rosterSize < 1) errors.push("League roster size is invalid.");
  const espnPlayers = sanitizeEspnPlayers(snapshot?.espnPlayers);
  if (stableSnapshotJson(snapshot?.espnPlayers) !== stableSnapshotJson(espnPlayers)) {
    errors.push("Snapshot ESPN players are not in the exact sanitized schema.");
  }
  const expectedEspnCaptureDigest = `sha256:${createHash("sha256").update(
    `${AUTHENTICATED_ESPN_CAPTURE_DIGEST_DOMAIN}\n${stableSnapshotJson({
      capturedAt: snapshot?.capturedAt,
      league,
      espnPlayers,
    })}`,
  ).digest("hex")}`;
  if (espnProvenance?.digest !== expectedEspnCaptureDigest) {
    errors.push("Snapshot ESPN capture provenance does not bind its exact league and player bytes.");
  }
  const rosterable = league.size * league.rosterSize;
  const draftable = draftableEspnFeasibility(espnPlayers, league);
  if (draftable.available.length < rosterable) {
    errors.push(`ESPN player board has ${draftable.available.length} draftable rows; at least ${rosterable} are required.`);
  }
  if (draftable.totalCapacity < rosterable) {
    errors.push(`ESPN player board has aggregate positional capacity for ${draftable.totalCapacity} roster spots; at least ${rosterable} are required.`);
  }
  if (draftable.openAggregateStarterSlots > 0) {
    errors.push(`ESPN player board cannot fill ${draftable.openAggregateStarterSlots} aggregate mandatory starter slots.`);
  }
  if (new Set(espnPlayers.map((player) => player.id)).size !== espnPlayers.length) errors.push("ESPN player IDs are not unique.");
  for (const position of POSITIONS) {
    if (!draftable.available.some((player) => player.pos === position)) errors.push(`ESPN draftable player board is missing ${position}.`);
  }
  const sources = Array.isArray(snapshot?.sources) ? snapshot.sources : [];
  const sourceIds = sources.map((source) => source.id).sort();
  if (stableSnapshotJson(sourceIds) !== stableSnapshotJson([...PUBLIC_SOURCE_IDS].sort())) {
    errors.push("Snapshot must contain exactly FFC, MFL, Tradyr, and GNG once each.");
  }
  const summaries = sources.map((source) => sourceSummary(source, publicProvenance?.generatedAt || snapshot?.capturedAt));
  for (let index = 0; index < summaries.length; index += 1) {
    const source = summaries[index];
    const capturedSource = sources[index];
    const coveragePlayers = Number(capturedSource?.coverage?.players);
    const corePositions = Array.isArray(capturedSource?.coverage?.corePositions)
      ? [...new Set(capturedSource.coverage.corePositions.map((position) => String(position).toUpperCase()))]
      : [];
    const capturedPlayers = Array.isArray(capturedSource?.players) ? capturedSource.players : [];
    const actualCorePositions = [...new Set(capturedPlayers
      .map((player) => String(player?.pos || "").toUpperCase())
      .filter((position) => REQUIRED_SOURCE_POSITIONS.includes(position)))];
    const identities = capturedPlayers.map((player) => `${String(player?.pos || "").toUpperCase()}|${normalizePlayerName(String(player?.name || ""))}`);
    if (source.status !== "ok") errors.push(`${source.id} capture failed: ${source.error || "unknown error"}.`);
    else if (!source.fresh) errors.push(`${source.id} is stale at snapshot time.`);
    if (source.players <= 0) errors.push(`${source.id} returned no players.`);
    if (!Number.isSafeInteger(coveragePlayers) || coveragePlayers !== source.players) {
      errors.push(`${source.id} coverage metadata does not match its captured player rows.`);
    } else if (coveragePlayers < MIN_SOURCE_PLAYER_COVERAGE) {
      errors.push(`${source.id} coverage is below the minimum player threshold.`);
    }
    if (!REQUIRED_SOURCE_POSITIONS.every((position) => corePositions.includes(position))) {
      errors.push(`${source.id} coverage is missing a required skill position.`);
    }
    if (stableSnapshotJson([...corePositions].sort()) !== stableSnapshotJson([...actualCorePositions].sort())) {
      errors.push(`${source.id} coverage positions do not match its captured player rows.`);
    }
    if (identities.some((identity) => identity.endsWith("|")) || new Set(identities).size !== identities.length) {
      errors.push(`${source.id} contains missing or duplicate player identities.`);
    }
  }
  let consensus = [];
  if (!errors.length) {
    consensus = mergeConsensus(espnPlayers, sources, league, { evaluatedAt: publicProvenance?.generatedAt || snapshot.capturedAt });
    const draftableConsensus = consensus.filter((player) => player.unavailable !== true);
    const top = [...draftableConsensus].sort((left, right) => Number(left.consensusRank) - Number(right.consensusRank)).slice(0, rosterable);
    const coverage = top.length ? top.filter((player) => player.sourceCount >= 4).length / top.length : 0;
    const fullCoverage = top.length ? top.filter((player) => player.sourceCount === 5).length / top.length : 0;
    const completeMarketModelCoverageCount = draftableConsensus.filter((player) => (
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
    const coverageBreakdown = buildCoverageBreakdown(draftableConsensus, rosterable);
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
      draftableEspnPlayers: draftable.available.length,
      rosterablePlayers: rosterable,
      coverageAtLeastFour: coverage,
      fullFiveSourceCoverage: fullCoverage,
      coverageBreakdown,
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
    draftableEspnPlayers: draftable.available.length,
    rosterablePlayers: rosterable,
    coverageAtLeastFour: 0,
    fullFiveSourceCoverage: 0,
    coverageBreakdown: buildCoverageBreakdown([], rosterable),
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

export function createSourceSnapshot({ capturedAt = new Date().toISOString(), league, espnPlayers, intelligence, provenance }) {
  const snapshot = {
    schemaVersion: SOURCE_SNAPSHOT_SCHEMA_VERSION,
    capturedAt,
    provenance,
    parameters: {
      scoring: intelligence?.scoring || league?.scoringLabel || "PPR",
      teams: Number(intelligence?.teams || league?.size || 12),
      season: Number(intelligence?.season || league?.season || 2026),
      qbs: Number(intelligence?.qbs) >= 2 ? 2 : 1,
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
  const league = leagueOverride || snapshot.league;
  if (sourceSnapshotFormat({ league }) !== sourceSnapshotFormat(snapshot)) {
    throw new Error("source snapshot draft format mismatch");
  }
  if (String(snapshot.parameters.scoring || "").trim().toUpperCase()
    !== String(league?.scoringLabel || "").trim().toUpperCase()) {
    throw new Error("source snapshot scoring profile mismatch");
  }
  if (Number(snapshot.parameters.teams) !== Number(league?.size)) {
    throw new Error("source snapshot team-count profile mismatch");
  }
  if (Number(snapshot.parameters.season) !== Number(league?.season)) {
    throw new Error("source snapshot season profile mismatch");
  }
  if (Number(snapshot.parameters.qbs) !== intelligenceQuarterbackMode(league.lineupSlotCounts)) {
    throw new Error("source snapshot quarterback profile mismatch");
  }
  return mergeConsensus(snapshot.espnPlayers, snapshot.sources, league, {
    evaluatedAt: snapshot.provenance.publicConsensus.generatedAt,
  });
}
