import assert from "node:assert/strict";
import test from "node:test";
import { buildSalaryCapEvidence, observeSalaryCapDecision } from "../app/lib/salary-cap-evidence.ts";

const players = [
  { id: 1, name: "Won Player", team: "A", pos: "RB", rank: 1, adp: 1, auction: 42, projected: 300 },
  { id: 2, name: "Lost Player", team: "B", pos: "WR", rank: 2, adp: 2, auction: 35, projected: 285 },
  { id: 3, name: "Passed Player", team: "C", pos: "TE", rank: 3, adp: 3, auction: 18, projected: 230 },
  { id: 4, name: "Drain Player", team: "D", pos: "QB", rank: 4, adp: 4, auction: 12, projected: 320 },
];

const action = (overrides) => ({
  occurredAt: "2026-08-20T05:00:00.000Z",
  operation: "BID",
  ok: true,
  code: "ACTION_SUBMITTED",
  submitMs: 20,
  roundTripMs: 60,
  clockSeconds: 30,
  automatic: false,
  ...overrides,
});

test("authenticated salary evidence records closing prices and sanitized bid/pass outcomes", () => {
  const observations = new Map([
    [1, { playerId: 1, position: "RB", sourceAuction: 42, fairValue: 40, targetBid: 37, maxApprovedBid: 44, highestObservedBid: 38, nominationIntent: "TARGET" }],
    [2, { playerId: 2, position: "WR", sourceAuction: 35, fairValue: 33, targetBid: 30, maxApprovedBid: 36, highestObservedBid: 36, nominationIntent: null }],
    [3, { playerId: 3, position: "TE", sourceAuction: 18, fairValue: 17, targetBid: 15, maxApprovedBid: 16, highestObservedBid: 20, nominationIntent: null }],
    [4, { playerId: 4, position: "QB", sourceAuction: 12, fairValue: 11, targetBid: 10, maxApprovedBid: 9, highestObservedBid: 1, nominationIntent: "DRAIN" }],
  ]);
  const evidence = buildSalaryCapEvidence({
    sales: [
      { playerId: 1, playerName: "Won Player", teamName: "Private Us", amount: 39, sequence: 1 },
      { playerId: 2, playerName: "Lost Player", teamName: "Private Rival", amount: 37, sequence: 2 },
      { playerId: 3, playerName: "Passed Player", teamName: "Private Rival", amount: 21, sequence: 3 },
      { playerId: 4, playerName: "Drain Player", teamName: "Private Rival", amount: 8, sequence: 4 },
    ],
    playerById: new Map(players.map((player) => [player.id, player])),
    ownPlayerIds: new Set([1]),
    actions: [
      action({ playerId: 1, amount: 39, maxApprovedBid: 44 }),
      action({ playerId: 2, amount: 34, maxApprovedBid: 36 }),
      action({ playerId: 2, amount: 36, maxApprovedBid: 36 }),
      action({ operation: "NOMINATE", playerId: 4, amount: 1, nominationIntent: "DRAIN" }),
    ],
    observations,
  });

  assert.deepEqual(evidence.map(({ playerId, closingPrice, outcome, submittedBidCount, highestSubmittedBid }) => (
    { playerId, closingPrice, outcome, submittedBidCount, highestSubmittedBid }
  )), [
    { playerId: 1, closingPrice: 39, outcome: "WON", submittedBidCount: 1, highestSubmittedBid: 39 },
    { playerId: 2, closingPrice: 37, outcome: "BID_LOST", submittedBidCount: 2, highestSubmittedBid: 36 },
    { playerId: 3, closingPrice: 21, outcome: "PASSED", submittedBidCount: 0, highestSubmittedBid: 0 },
    { playerId: 4, closingPrice: 8, outcome: "DRAINED", submittedBidCount: 0, highestSubmittedBid: 0 },
  ]);
  assert.equal(JSON.stringify(evidence).includes("Private"), false);
  assert.equal(JSON.stringify(evidence).includes("playerName"), false);
});

test("live salary observations retain the highest seen offer and exact source-backed ceiling", () => {
  const recommendation = {
    ...players[0], score: 90, confidence: 80, vorp: 50, scarcity: 12, need: 1, adpValue: 0,
    projectionValue: 38, fairValue: 40, targetBid: 37, maxBid: 44, fillsMandatoryStarter: true,
    sleeperScore: 0, sleeperLabel: "NONE", sleeperBonus: 0, reasons: [],
  };
  const first = observeSalaryCapDecision(undefined, recommendation, 25, "TARGET");
  const second = observeSalaryCapDecision(first, recommendation, 23, null);

  assert.equal(second.highestObservedBid, 25);
  assert.equal(second.maxApprovedBid, 44);
  assert.equal(second.nominationIntent, "TARGET");
});
