import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  CURRENT_SOURCE_SNAPSHOT_MAX_AGE_MS,
  createSourceSnapshot,
  evaluateCurrentSourceSnapshot,
  replayConsensusSnapshot,
  sourceSnapshotDigest,
  validateSourceSnapshot,
  stableSnapshotJson,
} from "../simulation/source-snapshot.mjs";
import {
  AUTHENTICATED_ESPN_CAPTURE_DIGEST_DOMAIN,
  sanitizeAuthenticatedEspnLeague,
  sanitizeAuthenticatedEspnPlayers,
} from "../app/lib/authenticated-espn-capture.ts";
import { makeCapturedPlayerSnapshot } from "../simulation/monte-carlo.mjs";

const CAPTURED_AT = "2026-08-14T18:00:00.000Z";
const positions = ["QB", "RB", "WR", "TE", "K", "DST"];

function fixture() {
  const espnPlayers = Array.from({ length: 48 }, (_, index) => ({
    id: index + 1,
    name: `Snapshot Player ${index + 1}`,
    team: `T${index % 16}`,
    pos: positions[index % positions.length],
    rank: index + 1,
    adp: index + 1.5,
    auction: Math.max(1, 48 - index),
    projected: 300 - index * 4,
    injured: false,
  }));
  const sourcePlayers = espnPlayers.map((player, index) => ({
    name: player.name,
    team: player.team,
    pos: player.pos,
    rank: index + 1,
    adp: index + 1.25,
    auction: player.auction,
    projectedPpg: player.projected / 17,
  }));
  const sources = [
    ["ffc", "market", .15],
    ["mfl", "market", .15],
    ["tradyr", "model", .20],
    ["gng", "model", .20],
  ].map(([id, kind, weight]) => ({
    id,
    name: String(id).toUpperCase(),
    kind,
    weight,
    status: "ok",
    updatedAt: CAPTURED_AT,
    retrievedAt: CAPTURED_AT,
    attribution: "test fixture",
    players: sourcePlayers,
    coverage: {
      players: sourcePlayers.length,
      corePositions: ["QB", "RB", "WR", "TE"],
    },
  }));
  const league = {
    id: "44050",
    season: 2026,
    size: 8,
    teamId: 7,
    draftType: "AUCTION",
    secondsPerPick: 60,
    rosterSize: 3,
    auctionBudget: 200,
    lineupSlotCounts: { "0": 1, "2": 1, "20": 1 },
    positionLimits: { QB: 3, RB: 3, WR: 3, TE: 2, K: 1, DST: 1 },
    scoringLabel: "PPR",
    scoringRules: 45,
    keeperCount: 0,
    pickOrder: [7, 1, 2, 3, 4, 5, 6, 8],
    rawSettings: {
      scoringSettings: {
        scoringItems: Array.from({ length: 45 }, (_, index) => ({ statId: index + 1, points: index === 0 ? 1 : 0 })),
      },
    },
  };
  const provenance = {
    espnCapture: {
      schemaVersion: 2,
      transport: "draftforge-chrome-companion",
      capturedAt: CAPTURED_AT,
      digest: `sha256:${createHash("sha256").update(
        `${AUTHENTICATED_ESPN_CAPTURE_DIGEST_DOMAIN}\n${stableSnapshotJson({
          capturedAt: CAPTURED_AT,
          league: sanitizeAuthenticatedEspnLeague(league),
          espnPlayers: sanitizeAuthenticatedEspnPlayers(espnPlayers),
        })}`,
      ).digest("hex")}`,
      receiptConsumed: true,
    },
    publicConsensus: {
      sourceSnapshotId: `sha256:${"b".repeat(64)}`,
      generatedAt: CAPTURED_AT,
      methodology: {
        weights: { espn: .30, gng: .20, tradyr: .20, ffc: .15, mfl: .15 },
        method: "freshness-gated weighted percentile consensus",
      },
    },
  };
  return { league, espnPlayers, intelligence: { scoring: "PPR", teams: 8, season: 2026, qbs: 1, sources }, provenance };
}

function createFixtureSnapshot(input = fixture()) {
  const provenance = structuredClone(input.provenance);
  provenance.espnCapture.digest = `sha256:${createHash("sha256").update(
    `${AUTHENTICATED_ESPN_CAPTURE_DIGEST_DOMAIN}\n${stableSnapshotJson({
      capturedAt: CAPTURED_AT,
      league: sanitizeAuthenticatedEspnLeague(input.league),
      espnPlayers: sanitizeAuthenticatedEspnPlayers(input.espnPlayers),
    })}`,
  ).digest("hex")}`;
  return createSourceSnapshot({ capturedAt: CAPTURED_AT, ...input, provenance });
}

test("five-source snapshots are sanitized, content-addressed, and deterministically replayable", () => {
  const snapshot = createFixtureSnapshot();
  assert.equal(snapshot.validation.valid, true);
  assert.equal(snapshot.league.name, "Sanitized ESPN snapshot");
  assert.equal(snapshot.league.teams[0].name, "Snapshot Team 1");
  assert.equal(snapshot.parameters.qbs, 1);
  assert.equal(snapshot.digest, sourceSnapshotDigest(snapshot));
  const first = replayConsensusSnapshot(snapshot);
  const second = replayConsensusSnapshot(JSON.parse(JSON.stringify(snapshot)));
  assert.deepEqual(second, first);
  assert.equal(first.length, 48);
  assert.ok(first.every((player) => player.sourceCount === 5));
  assert.deepEqual(snapshot.validation.sourceReach, { ffc: 48, mfl: 48, tradyr: 48, gng: 48 });
  assert.deepEqual(snapshot.validation.coverageBreakdown.overall, {
    total: 24,
    atLeastFourCount: 24,
    atLeastFourRate: 1,
    fullFiveCount: 24,
    fullFiveRate: 1,
  });
  assert.deepEqual(snapshot.validation.coverageBreakdown.byDraftRange, {
    early: {
      first: 1,
      last: 24,
      total: 24,
      atLeastFourCount: 24,
      atLeastFourRate: 1,
      fullFiveCount: 24,
      fullFiveRate: 1,
    },
  });
  assert.deepEqual(
    Object.fromEntries(Object.entries(snapshot.validation.coverageBreakdown.byPosition)
      .map(([position, coverage]) => [position, coverage.total])),
    { QB: 4, RB: 4, WR: 4, TE: 4, K: 4, DST: 4 },
  );
  assert.equal(snapshot.validation.completeMarketModelCoverageCount, 48);
  assert.equal(snapshot.validation.corroboratedSleeperCandidateCount, 0);
  assert.deepEqual(snapshot.validation.sleeperEvidenceFunnel, {
    completeMarketModelCoverage: 48,
    positiveModelEvidence: 1,
    modelEdgeAtLeastEight: 0,
    sleeperScoreAtLeastFifty: 0,
    productionSignals: 0,
  });
  assert.deepEqual(snapshot.validation.sleeperSignalCounts, { VALUE: 0, SLEEPER: 0, DEEP_STASH: 0 });
  assert.deepEqual(snapshot.validation.sleeperCandidates, []);
  assert.equal(snapshot.schemaVersion, 3);
  assert.equal(snapshot.provenance.espnCapture.receiptConsumed, true);
  assert.equal(snapshot.provenance.publicConsensus.methodology.weights.espn, .30);
});

test("schema-v3 digest and validation preserve exact capture, rules, and provider provenance", () => {
  const snapshot = createFixtureSnapshot();
  for (const mutate of [
    (candidate) => { candidate.provenance.espnCapture.digest = `sha256:${"f".repeat(64)}`; },
    (candidate) => { candidate.provenance.espnCapture.receiptConsumed = false; },
    (candidate) => { candidate.provenance.publicConsensus.methodology.weights.espn = .31; },
    (candidate) => { candidate.league.secondsPerPick += 1; },
    (candidate) => { candidate.league.rulesFingerprint.scoringItems[0].points = 2; },
  ]) {
    const changed = structuredClone(snapshot);
    mutate(changed);
    assert.notEqual(sourceSnapshotDigest(changed), snapshot.digest);
    changed.digest = sourceSnapshotDigest(changed);
    const validation = validateSourceSnapshot(changed);
    assert.equal(validation.valid, false);
  }
});

test("snapshot replay fails closed on tampering or stale captured sources", () => {
  const snapshot = createFixtureSnapshot();
  const tampered = structuredClone(snapshot);
  tampered.espnPlayers[0].rank = 999;
  assert.throws(() => replayConsensusSnapshot(tampered), /digest mismatch/);

  const staleInput = fixture();
  staleInput.intelligence.sources[0].updatedAt = "2026-01-01T00:00:00.000Z";
  staleInput.intelligence.sources[0].retrievedAt = "2026-01-01T00:00:00.000Z";
  const stale = createFixtureSnapshot(staleInput);
  const validation = validateSourceSnapshot(stale);
  assert.equal(validation.valid, false);
  assert.match(validation.errors.join(" "), /ffc is stale/);
});

test("snapshot certification remains format-exact and rejects every non-v3 schema", () => {
  const snapshot = createFixtureSnapshot();
  assert.equal(snapshot.schemaVersion, 3);

  const legacy = structuredClone(snapshot);
  legacy.schemaVersion = 2;
  legacy.digest = sourceSnapshotDigest(legacy);
  const validation = validateSourceSnapshot(legacy);
  assert.equal(validation.valid, false);
  assert.match(validation.errors.join(" "), /Unsupported snapshot schema version/);
  assert.throws(() => replayConsensusSnapshot(legacy), /Unsupported snapshot schema version/);

  const wrongFormat = structuredClone(snapshot);
  wrongFormat.league.draftType = wrongFormat.league.draftType === "AUCTION" ? "SNAKE" : "AUCTION";
  wrongFormat.digest = sourceSnapshotDigest(wrongFormat);
  assert.throws(() => replayConsensusSnapshot(wrongFormat, snapshot.league), /capture provenance/);
  assert.throws(
    () => replayConsensusSnapshot(snapshot, { ...snapshot.league, draftType: "SNAKE" }),
    /draft format mismatch/,
  );
});

test("freshness is replayed relative to capture time rather than wall-clock time", () => {
  const input = fixture();
  for (const source of input.intelligence.sources) {
    source.updatedAt = "2026-08-02T18:00:00.000Z";
    source.retrievedAt = CAPTURED_AT;
  }
  const snapshot = createFixtureSnapshot(input);
  assert.equal(snapshot.validation.valid, true);
  assert.doesNotThrow(() => replayConsensusSnapshot(snapshot));
});

test("runtime current-source proof is separate, bounded, and injectable without breaking replay", () => {
  const snapshot = createFixtureSnapshot();
  const capturedAtMs = Date.parse(CAPTURED_AT);
  const boundary = evaluateCurrentSourceSnapshot(snapshot, {
    now: capturedAtMs + CURRENT_SOURCE_SNAPSHOT_MAX_AGE_MS,
  });
  assert.equal(boundary.current, true);
  assert.equal(boundary.ageMs, CURRENT_SOURCE_SNAPSHOT_MAX_AGE_MS);
  assert.equal(boundary.snapshotDigest, snapshot.digest);

  const stale = evaluateCurrentSourceSnapshot(snapshot, {
    now: capturedAtMs + CURRENT_SOURCE_SNAPSHOT_MAX_AGE_MS + 1,
  });
  assert.equal(stale.current, false);
  assert.equal(stale.blocker, "SOURCE_SNAPSHOT_CAPTURE_STALE");
  assert.doesNotThrow(() => replayConsensusSnapshot(snapshot), "historical replay remains capture-relative");

  const future = evaluateCurrentSourceSnapshot(snapshot, { now: capturedAtMs - 1 });
  assert.equal(future.current, false);
  assert.equal(future.blocker, "SOURCE_SNAPSHOT_CAPTURED_IN_FUTURE");
  const invalid = evaluateCurrentSourceSnapshot(snapshot, { now: "not-a-timestamp" });
  assert.equal(invalid.current, false);
  assert.equal(invalid.blocker, "SOURCE_SNAPSHOT_EVALUATION_TIME_INVALID");
});

test("ESPN negative defense IDs survive snapshot sanitization and replay", () => {
  const input = fixture();
  const defense = input.espnPlayers.find((player) => player.pos === "DST");
  const oldId = defense.id;
  defense.id = -16034;
  const snapshot = createFixtureSnapshot(input);
  assert.equal(snapshot.validation.valid, true);
  assert.ok(snapshot.espnPlayers.some((player) => player.id === -16034));
  assert.equal(snapshot.espnPlayers.some((player) => player.id === oldId), false);
  assert.ok(replayConsensusSnapshot(snapshot).some((player) => player.id === -16034));
});

test("snapshot validation and replay bind source truth to the ESPN quarterback profile", () => {
  const input = fixture();
  input.league.lineupSlotCounts = { ...input.league.lineupSlotCounts, "7": 1 };
  input.intelligence.qbs = 2;
  const snapshot = createFixtureSnapshot(input);
  assert.equal(snapshot.parameters.qbs, 2);
  assert.equal(snapshot.validation.valid, true);
  assert.doesNotThrow(() => replayConsensusSnapshot(snapshot));

  const oneQbOverride = { ...snapshot.league, lineupSlotCounts: { ...snapshot.league.lineupSlotCounts, "7": 0 } };
  assert.throws(() => replayConsensusSnapshot(snapshot, oneQbOverride), /quarterback profile mismatch/);
  assert.throws(
    () => replayConsensusSnapshot(snapshot, { ...snapshot.league, scoringLabel: "Standard" }),
    /scoring profile mismatch/,
  );
  assert.throws(
    () => replayConsensusSnapshot(snapshot, { ...snapshot.league, size: snapshot.league.size + 1 }),
    /team-count profile mismatch/,
  );
  assert.throws(
    () => replayConsensusSnapshot(snapshot, { ...snapshot.league, season: snapshot.league.season + 1 }),
    /season profile mismatch/,
  );
  assert.throws(
    () => replayConsensusSnapshot(snapshot, { ...snapshot.league, draftType: "SNAKE" }),
    /draft format mismatch/,
  );

  const mismatchedInput = fixture();
  mismatchedInput.intelligence.qbs = 2;
  const mismatched = createFixtureSnapshot(mismatchedInput);
  assert.equal(mismatched.validation.valid, false);
  assert.match(mismatched.validation.errors.join(" "), /quarterback profile does not match/);

  const missingProfile = structuredClone(snapshot);
  delete missingProfile.parameters.qbs;
  const missingValidation = validateSourceSnapshot(missingProfile);
  assert.equal(missingValidation.valid, false);
  assert.match(missingValidation.errors.join(" "), /quarterback profile must be/);
});

test("snapshot validation binds capture parameters and explicit source coverage to ESPN truth", () => {
  const base = createFixtureSnapshot();
  assert.equal(base.validation.valid, true);

  for (const [parameter, value, message] of [
    ["scoring", "Standard", /scoring parameter does not match/],
    ["teams", 12, /team-count parameter does not match/],
    ["season", 2027, /season parameter does not match/],
  ]) {
    const mismatched = structuredClone(base);
    mismatched.parameters[parameter] = value;
    const validation = validateSourceSnapshot(mismatched);
    assert.equal(validation.valid, false);
    assert.match(validation.errors.join(" "), message);
  }

  const missingCoverage = structuredClone(base);
  delete missingCoverage.sources[0].coverage;
  let validation = validateSourceSnapshot(missingCoverage);
  assert.equal(validation.valid, false);
  assert.match(validation.errors.join(" "), /coverage metadata does not match/);

  const forgedCoverage = structuredClone(base);
  forgedCoverage.sources[0].coverage.players = 1;
  validation = validateSourceSnapshot(forgedCoverage);
  assert.equal(validation.valid, false);
  assert.match(validation.errors.join(" "), /coverage metadata does not match/);

  const missingPosition = structuredClone(base);
  missingPosition.sources[0].coverage.corePositions = ["QB", "RB", "WR"];
  validation = validateSourceSnapshot(missingPosition);
  assert.equal(validation.valid, false);
  assert.match(validation.errors.join(" "), /missing a required skill position/);

  const forgedPositions = structuredClone(base);
  forgedPositions.sources[0].players = forgedPositions.sources[0].players.map((player) => ({ ...player, pos: "QB" }));
  forgedPositions.sources[0].coverage.corePositions = ["QB", "RB", "WR", "TE"];
  validation = validateSourceSnapshot(forgedPositions);
  assert.equal(validation.valid, false);
  assert.match(validation.errors.join(" "), /coverage positions do not match/);

  const duplicateIdentity = structuredClone(base);
  duplicateIdentity.sources[0].players[1] = structuredClone(duplicateIdentity.sources[0].players[0]);
  validation = validateSourceSnapshot(duplicateIdentity);
  assert.equal(validation.valid, false);
  assert.match(validation.errors.join(" "), /duplicate player identities/);
});

test("production-shaped coverage preserves unavailable ESPN players without counting them as draftable", () => {
  const input = fixture();
  const unavailable = input.espnPlayers.find((player) => player.pos === "K");
  unavailable.unavailable = true;
  const snapshot = createFixtureSnapshot(input);
  assert.equal(snapshot.validation.valid, true);
  assert.equal(snapshot.validation.draftableEspnPlayers, input.espnPlayers.length - 1);
  assert.deepEqual(snapshot.sources[0].coverage.corePositions, ["QB", "RB", "WR", "TE"]);
  assert.equal(snapshot.espnPlayers.find((player) => player.id === unavailable.id)?.unavailable, true);
  const replay = replayConsensusSnapshot(snapshot);
  assert.equal(replay.find((player) => player.id === unavailable.id)?.unavailable, true);
  const simulated = makeCapturedPlayerSnapshot(snapshot, 111, input.league);
  assert.equal(simulated.find((player) => player.id === unavailable.id)?.unavailable, true);
});

test("snapshot validation rejects insufficient draftable inventory and positional infeasibility", () => {
  const depleted = fixture();
  depleted.espnPlayers.slice(0, 25).forEach((player) => { player.unavailable = true; });
  let snapshot = createFixtureSnapshot(depleted);
  assert.equal(snapshot.validation.valid, false);
  assert.match(snapshot.validation.errors.join(" "), /23 draftable rows; at least 24/);

  const quarterbackShortage = fixture();
  quarterbackShortage.espnPlayers.filter((player) => player.pos === "QB").slice(7)
    .forEach((player) => { player.unavailable = true; });
  snapshot = createFixtureSnapshot(quarterbackShortage);
  assert.equal(snapshot.validation.draftableEspnPlayers, 47);
  assert.equal(snapshot.validation.valid, false);
  assert.match(snapshot.validation.errors.join(" "), /cannot fill 1 aggregate mandatory starter slots/);
});

test("captured Monte Carlo decisions replay fixed source truth with seeded hidden outcomes", () => {
  const input = fixture();
  const snapshot = createFixtureSnapshot(input);
  const first = makeCapturedPlayerSnapshot(snapshot, 111, input.league);
  const replay = makeCapturedPlayerSnapshot(snapshot, 111, input.league);
  assert.throws(
    () => makeCapturedPlayerSnapshot(snapshot, 111, { ...input.league, scoringLabel: "Standard" }),
    /scoring profile mismatch/,
    "a prior valid cache entry must not bypass exact source-profile binding",
  );
  const alternate = makeCapturedPlayerSnapshot(snapshot, 222, input.league);
  assert.deepEqual(replay, first);
  const sourceTruth = (player) => Object.fromEntries(Object.entries(player).filter(([key]) => key !== "trueProjection"));
  assert.deepEqual(alternate.map(sourceTruth), first.map(sourceTruth));
  assert.notDeepEqual(alternate.map((player) => player.trueProjection), first.map((player) => player.trueProjection));
});
