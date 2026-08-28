import assert from "node:assert/strict";
import test from "node:test";
import {
  enforceAvailabilityRosterFeasibility,
  evaluateRosterCompletionFeasibility,
} from "../app/lib/roster-completion-feasibility.ts";

function league(draftType) {
  return {
    id: "44050",
    name: "Completion QA",
    season: 2026,
    size: 10,
    teamId: 7,
    draftType,
    secondsPerPick: 30,
    rosterSize: 8,
    auctionBudget: 200,
    lineupSlotCounts: { "0": 1, "2": 1, "4": 1, "6": 1, "16": 1, "17": 1, "20": 2 },
    positionLimits: { QB: 2, RB: 4, WR: 4, TE: 2, DST: 1, K: 1 },
    scoringLabel: "PPR",
    scoringRules: 46,
    keeperCount: 0,
    pickOrder: [7],
    teams: [{ id: 7, name: "Us", abbrev: "US" }],
  };
}

function player(id, pos) {
  return { id, name: `${pos} ${id}`, team: "NFL", pos, rank: id, adp: id, auction: 1, projected: 100 };
}

for (const draftType of ["SNAKE", "AUCTION"]) {
  test(`${draftType} blocks before another acquisition when the sole remaining kicker is vetoed`, () => {
    const result = evaluateRosterCompletionFeasibility({
      league: league(draftType),
      currentRosterCount: 6,
      rosterPositions: ["QB", "RB", "WR", "TE", "DST", "RB"],
      availablePlayers: [player(1, "K"), player(2, "WR"), player(4, "RB")],
      vetoedPlayerIds: [1],
    });
    assert.equal(result.feasible, false);
    assert.equal(result.code, "MANDATORY_STARTERS_UNFILLABLE");
    assert.equal(result.openStarterSlots, 1);

    const gate = enforceAvailabilityRosterFeasibility({
      schemaVersion: "draftforge.availability/v1",
      evaluatedAt: "2026-08-28T02:00:00.000Z",
      artifactGeneratedAt: "2026-08-28T01:59:00.000Z",
      freshUntil: "2026-08-28T02:29:00.000Z",
      digest: "sha256:test",
      armingAllowed: true,
      status: "READY",
      blockingReasons: [],
      validationErrors: [],
      vetoedPlayerIds: [1],
      advisoryPlayerIds: [],
      vetoes: [],
      advisories: [],
      unresolved: [],
    }, result);
    assert.equal(gate.armingAllowed, false);
    assert.equal(gate.status, "BLOCKED");
    assert.deepEqual(gate.blockingReasons, ["AVAILABILITY_ROSTER_INFEASIBLE"]);
  });

  test(`${draftType} accepts an exact completion path and rejects a vetoed sole defense`, () => {
    const exact = evaluateRosterCompletionFeasibility({
      league: league(draftType),
      currentRosterCount: 7,
      rosterPositions: ["QB", "RB", "WR", "TE", "DST", "RB", "WR"],
      availablePlayers: [player(1, "K")],
      vetoedPlayerIds: [],
    });
    assert.equal(exact.feasible, true);
    assert.equal(exact.code, "ROSTER_COMPLETION_FEASIBLE");

    const noDefense = evaluateRosterCompletionFeasibility({
      league: league(draftType),
      currentRosterCount: 7,
      rosterPositions: ["QB", "RB", "WR", "TE", "K", "RB", "WR"],
      availablePlayers: [player(3, "DST")],
      vetoedPlayerIds: [3],
    });
    assert.equal(noDefense.feasible, false);
    assert.equal(noDefense.code, "PLAYER_POOL_DEPLETED");
  });
}
