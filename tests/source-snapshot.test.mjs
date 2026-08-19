import assert from "node:assert/strict";
import test from "node:test";
import {
  createSourceSnapshot,
  replayConsensusSnapshot,
  sourceSnapshotDigest,
  validateSourceSnapshot,
} from "../simulation/source-snapshot.mjs";
import { makeCapturedPlayerSnapshot } from "../simulation/monte-carlo.mjs";

const CAPTURED_AT = "2026-08-14T18:00:00.000Z";
const positions = ["QB", "RB", "WR", "TE", "K", "DST"];

function fixture() {
  const espnPlayers = Array.from({ length: 30 }, (_, index) => ({
    id: index + 1,
    name: `Snapshot Player ${index + 1}`,
    team: `T${index % 16}`,
    pos: positions[index % positions.length],
    rank: index + 1,
    adp: index + 1.5,
    auction: Math.max(1, 30 - index),
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
  };
  return { league, espnPlayers, intelligence: { scoring: "PPR", teams: 8, season: 2026, sources } };
}

test("five-source snapshots are sanitized, content-addressed, and deterministically replayable", () => {
  const snapshot = createSourceSnapshot({ capturedAt: CAPTURED_AT, ...fixture() });
  assert.equal(snapshot.validation.valid, true);
  assert.equal(snapshot.league.name, "Sanitized ESPN snapshot");
  assert.equal(snapshot.league.teams[0].name, "Snapshot Team 1");
  assert.equal(snapshot.digest, sourceSnapshotDigest(snapshot));
  const first = replayConsensusSnapshot(snapshot);
  const second = replayConsensusSnapshot(JSON.parse(JSON.stringify(snapshot)));
  assert.deepEqual(second, first);
  assert.equal(first.length, 30);
  assert.ok(first.every((player) => player.sourceCount === 5));
  assert.deepEqual(snapshot.validation.sourceReach, { ffc: 30, mfl: 30, tradyr: 30, gng: 30 });
  assert.equal(snapshot.validation.completeMarketModelCoverageCount, 30);
  assert.equal(snapshot.validation.corroboratedSleeperCandidateCount, 0);
  assert.deepEqual(snapshot.validation.sleeperEvidenceFunnel, {
    completeMarketModelCoverage: 30,
    positiveModelEvidence: 0,
    modelEdgeAtLeastEight: 0,
    sleeperScoreAtLeastFifty: 0,
    productionSignals: 0,
  });
  assert.deepEqual(snapshot.validation.sleeperSignalCounts, { VALUE: 0, SLEEPER: 0, DEEP_STASH: 0 });
});

test("snapshot replay fails closed on tampering or stale captured sources", () => {
  const snapshot = createSourceSnapshot({ capturedAt: CAPTURED_AT, ...fixture() });
  const tampered = structuredClone(snapshot);
  tampered.espnPlayers[0].rank = 999;
  assert.throws(() => replayConsensusSnapshot(tampered), /digest mismatch/);

  const staleInput = fixture();
  staleInput.intelligence.sources[0].updatedAt = "2026-01-01T00:00:00.000Z";
  staleInput.intelligence.sources[0].retrievedAt = "2026-01-01T00:00:00.000Z";
  const stale = createSourceSnapshot({ capturedAt: CAPTURED_AT, ...staleInput });
  const validation = validateSourceSnapshot(stale);
  assert.equal(validation.valid, false);
  assert.match(validation.errors.join(" "), /ffc is stale/);
});

test("freshness is replayed relative to capture time rather than wall-clock time", () => {
  const input = fixture();
  for (const source of input.intelligence.sources) {
    source.updatedAt = "2026-08-02T18:00:00.000Z";
    source.retrievedAt = CAPTURED_AT;
  }
  const snapshot = createSourceSnapshot({ capturedAt: CAPTURED_AT, ...input });
  assert.equal(snapshot.validation.valid, true);
  assert.doesNotThrow(() => replayConsensusSnapshot(snapshot));
});

test("ESPN negative defense IDs survive snapshot sanitization and replay", () => {
  const input = fixture();
  const defense = input.espnPlayers.find((player) => player.pos === "DST");
  const oldId = defense.id;
  defense.id = -16034;
  const snapshot = createSourceSnapshot({ capturedAt: CAPTURED_AT, ...input });
  assert.equal(snapshot.validation.valid, true);
  assert.ok(snapshot.espnPlayers.some((player) => player.id === -16034));
  assert.equal(snapshot.espnPlayers.some((player) => player.id === oldId), false);
  assert.ok(replayConsensusSnapshot(snapshot).some((player) => player.id === -16034));
});

test("captured Monte Carlo decisions replay fixed source truth with seeded hidden outcomes", () => {
  const input = fixture();
  const snapshot = createSourceSnapshot({ capturedAt: CAPTURED_AT, ...input });
  const first = makeCapturedPlayerSnapshot(snapshot, 111, input.league);
  const replay = makeCapturedPlayerSnapshot(snapshot, 111, input.league);
  const alternate = makeCapturedPlayerSnapshot(snapshot, 222, input.league);
  assert.deepEqual(replay, first);
  const sourceTruth = (player) => Object.fromEntries(Object.entries(player).filter(([key]) => key !== "trueProjection"));
  assert.deepEqual(alternate.map(sourceTruth), first.map(sourceTruth));
  assert.notDeepEqual(alternate.map((player) => player.trueProjection), first.map((player) => player.trueProjection));
});
