import assert from "node:assert/strict";
import test from "node:test";
import { buildDraftDayBridgeResult } from "../app/lib/draft-day-bridge.ts";

const players = [
  { id: 1, name: "Alpha Quarterback", team: "A", pos: "QB", rank: 1, adp: 1, auction: 8, projected: 300 },
  { id: 2, name: "Bravo Running Back", team: "B", pos: "RB", rank: 2, adp: 2, auction: 7, projected: 280 },
  { id: 3, name: "Charlie Receiver", team: "C", pos: "WR", rank: 3, adp: 3, auction: 5, projected: 250 },
  { id: 4, name: "Delta Tight End", team: "D", pos: "TE", rank: 4, adp: 4, auction: 3, projected: 210 },
];

function league(draftType = "SNAKE") {
  return {
    id: "44050",
    name: "Test League",
    season: 2026,
    size: 2,
    teamId: 7,
    draftType,
    secondsPerPick: 30,
    rosterSize: 2,
    auctionBudget: 20,
    lineupSlotCounts: { "0": 1, "2": 1 },
    positionLimits: { QB: 1, RB: 1, WR: 1, TE: 1, K: 1, DST: 1 },
    scoringLabel: "PPR",
    scoringRules: 24,
    keeperCount: 0,
    pickOrder: [7, 8],
    teams: [{ id: 7, name: "Us", abbrev: "US" }, { id: 8, name: "Them", abbrev: "THEM" }],
  };
}

function sources() {
  const updatedAt = new Date().toISOString();
  return [
    ["ffc", "market", .15],
    ["mfl", "market", .15],
    ["tradyr", "composite", .20],
    ["gng", "model", .20],
  ].map(([id, kind, weight]) => ({
    id,
    name: String(id).toUpperCase(),
    kind,
    weight,
    status: "ok",
    updatedAt,
    attribution: String(id),
    players: players.map((player, index) => ({
      name: player.name,
      team: player.team,
      pos: player.pos,
      rank: index + 1,
      adp: index + 1,
      auction: player.auction,
    })),
  }));
}

function room(overrides = {}) {
  return {
    leagueId: "44050",
    teamId: 7,
    season: 2026,
    inDraftRoom: true,
    onClock: false,
    remainingSeconds: 20,
    soundMuted: true,
    autopickActive: false,
    actionSurfaceReady: true,
    ownRoster: [],
    availablePlayerIds: players.map((player) => player.id),
    availablePlayerNames: players.map((player) => player.name),
    ...overrides,
  };
}

function result({ draftType = "SNAKE", room: roomOverrides = {}, picks = [] } = {}) {
  return buildDraftDayBridgeResult({
    league: league(draftType),
    espnPlayers: players,
    picks,
    sources: sources(),
    room: room(roomOverrides),
    strategy: "BALANCED",
  });
}

test("chat bridge monitors safely and exposes deterministic five-source coverage", () => {
  const decision = result();
  assert.equal(decision.ok, true);
  assert.equal(decision.code, "MONITORING");
  assert.equal(decision.sourceCoverage, 5);
  assert.deepEqual(decision.sourceIds, ["espn", "ffc", "mfl", "tradyr", "gng"]);
  assert.equal(decision.action, null);
});

test("chat bridge fails closed when sound, team, sources, or ESPN identity are unsafe", () => {
  const muted = result({ room: { soundMuted: false } });
  assert.equal(muted.ok, false);
  assert.equal(muted.code, "ESPN_SOUND_NOT_MUTED");

  const wrongTeam = result({ room: { teamId: 8 } });
  assert.equal(wrongTeam.ok, false);
  assert.ok(wrongTeam.blockers.includes("WRONG_ESPN_TEAM"));

  const wrongSeason = result({ room: { season: 2025 } });
  assert.equal(wrongSeason.ok, false);
  assert.ok(wrongSeason.blockers.includes("WRONG_ESPN_SEASON"));

  const staleSources = sources();
  staleSources[0].updatedAt = "2025-01-01T00:00:00.000Z";
  const stale = buildDraftDayBridgeResult({
    league: league(), espnPlayers: players, picks: [], sources: staleSources, room: room(), strategy: "BALANCED",
  });
  assert.equal(stale.code, "FIVE_SOURCE_SNAPSHOT_NOT_READY");
  assert.equal(stale.action, null);
});

test("snake command is legal, ordered, clock-bound, and exact-pick-bound", () => {
  const decision = result({ room: { onClock: true, currentPick: 9 } });
  assert.equal(decision.code, "SELECT_READY");
  assert.equal(decision.action.operation, "SELECT");
  assert.equal(decision.action.expectedLeagueId, "44050");
  assert.equal(decision.action.expectedTeamId, 7);
  assert.equal(decision.action.expectedSeason, 2026);
  assert.equal(decision.action.expectedPick, 9);
  assert.equal(decision.action.playerId, decision.recommendations[0].id);
  assert.deepEqual(
    decision.action.candidates.map((candidate) => candidate.playerId),
    decision.recommendations.map((player) => player.id),
  );

  const late = result({ room: { onClock: true, currentPick: 9, remainingSeconds: 4 } });
  assert.equal(late.code, "CLOCK_TOO_SHORT");
  assert.equal(late.action, null);
});

test("salary-cap bidding increments by one, respects both ceilings, and never raises our lead", () => {
  const monitoring = result({ draftType: "AUCTION" });
  const nominee = monitoring.recommendations.find((player) => player.maxBid >= 2);
  assert.ok(nominee, "fixture needs a legal salary-cap target");

  const ready = result({
    draftType: "AUCTION",
    room: {
      nominatedPlayer: nominee.name,
      nominatedPlayerId: nominee.id,
      currentBid: 1,
      maxLegalBid: 19,
      leadingBid: false,
    },
  });
  assert.equal(ready.code, "BID_READY");
  assert.equal(ready.action.amount, 2);
  assert.equal(ready.action.maxApprovedBid, Math.min(nominee.maxBid, 19));
  assert.equal(ready.action.expectedTeamId, 7);
  assert.equal(ready.action.expectedSeason, 2026);

  const walk = result({
    draftType: "AUCTION",
    room: {
      nominatedPlayer: nominee.name,
      nominatedPlayerId: nominee.id,
      currentBid: nominee.maxBid,
      maxLegalBid: 19,
      leadingBid: false,
    },
  });
  assert.equal(walk.code, "WALK_AWAY");
  assert.equal(walk.action, null);

  const leading = result({
    draftType: "AUCTION",
    room: {
      nominatedPlayer: nominee.name,
      nominatedPlayerId: nominee.id,
      currentBid: 1,
      maxLegalBid: 19,
      leadingBid: true,
    },
  });
  assert.equal(leading.code, "HOLD_LEADING_BID");
  assert.equal(leading.action, null);

  const mismatchedIdentity = result({
    draftType: "AUCTION",
    room: {
      nominatedPlayer: nominee.name,
      nominatedPlayerId: nominee.id + 1000,
      currentBid: 1,
      maxLegalBid: 19,
      leadingBid: false,
    },
  });
  assert.equal(mismatchedIdentity.code, "PASS_UNRANKED_NOMINEE");
  assert.equal(mismatchedIdentity.action, null);
});

test("salary-cap nomination uses the production strategy and ESPN reserve maximum", () => {
  const ready = result({ draftType: "AUCTION", room: { onClock: true, maxLegalBid: 19 } });
  assert.equal(ready.code, "NOMINATION_READY");
  assert.equal(ready.action.operation, "NOMINATE");
  assert.ok(ready.action.amount >= 1);
  assert.ok(ready.action.amount <= 19);
  assert.equal(ready.action.candidates.length, 1);
  assert.equal(ready.action.candidates[0].playerId, ready.action.playerId);
  assert.ok(["TARGET", "DRAIN"].includes(ready.action.nominationIntent));
  assert.equal(ready.action.expectedTeamId, 7);
  assert.equal(ready.action.expectedSeason, 2026);

  const blocked = result({ draftType: "AUCTION", room: { onClock: true, maxLegalBid: 0 } });
  assert.equal(blocked.code, "BUDGET_RESERVE");
  assert.equal(blocked.action, null);
});

test("salary-cap bridge never bids on its own exact drain nomination", () => {
  const monitoring = result({ draftType: "AUCTION" });
  const nominee = monitoring.recommendations.find((player) => player.maxBid >= 2);
  assert.ok(nominee, "fixture needs a legal salary-cap nominee");

  const drain = result({
    draftType: "AUCTION",
    room: {
      nominatedPlayer: nominee.name,
      nominatedPlayerId: nominee.id,
      currentBid: 1,
      maxLegalBid: 19,
      leadingBid: false,
      ownNominationIntent: "DRAIN",
      ownNominationPlayerId: nominee.id,
    },
  });
  assert.equal(drain.code, "PASS_DRAIN_NOMINEE");
  assert.equal(drain.action, null);

  const unrelatedDrainRecord = result({
    draftType: "AUCTION",
    room: {
      nominatedPlayer: nominee.name,
      nominatedPlayerId: nominee.id,
      currentBid: 1,
      maxLegalBid: 19,
      leadingBid: false,
      ownNominationIntent: "DRAIN",
      ownNominationPlayerId: nominee.id + 100,
    },
  });
  assert.equal(unrelatedDrainRecord.code, "BID_READY");
});

test("duplicate ESPN draft outcomes fail closed before another action", () => {
  const duplicate = result({
    room: { onClock: true, currentPick: 3 },
    picks: [
      { playerId: 1, teamId: 7, overall: 1, round: 1, amount: 0 },
      { playerId: 1, teamId: 8, overall: 2, round: 1, amount: 0 },
    ],
  });
  assert.equal(duplicate.code, "DUPLICATE_ESPN_PLAYER");
  assert.equal(duplicate.action, null);
});

test("production recommendations exclude players that violate ESPN position caps", () => {
  const extraQuarterback = { id: 5, name: "Echo Quarterback", team: "E", pos: "QB", rank: 5, adp: 5, auction: 2, projected: 200 };
  const expandedPlayers = [...players, extraQuarterback];
  const expandedSources = sources().map((source) => ({
    ...source,
    players: [...source.players, {
      name: extraQuarterback.name,
      team: extraQuarterback.team,
      pos: extraQuarterback.pos,
      rank: 5,
      adp: 5,
      auction: 2,
    }],
  }));
  const capped = buildDraftDayBridgeResult({
    league: league(),
    espnPlayers: expandedPlayers,
    picks: [{ playerId: 1, teamId: 7, overall: 1, round: 1, amount: 0 }],
    sources: expandedSources,
    room: room({ onClock: true, currentPick: 2 }),
    strategy: "BALANCED",
  });
  assert.equal(capped.code, "SELECT_READY");
  assert.ok(capped.recommendations.every((player) => player.pos !== "QB"));
});
