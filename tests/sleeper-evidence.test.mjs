import assert from "node:assert/strict";
import test from "node:test";
import { mergeAuthenticatedSleeperEvidence } from "../app/lib/sleeper-evidence.ts";

const candidate = {
  playerId: 42,
  playerName: "Corroborated Sleeper",
  position: "WR",
  adp: 92,
  label: "SLEEPER",
  score: 64,
  modelMarketEdge: 13,
  modelSpread: 4,
  sourceCount: 5,
};

test("authenticated sleeper evidence survives acquisition without weakening its signal", () => {
  const first = mergeAuthenticatedSleeperEvidence({ current: [], observed: [candidate], ownPicks: [], currentPick: 70 });
  const acquired = mergeAuthenticatedSleeperEvidence({
    current: first,
    observed: [],
    ownPicks: [{ playerId: 42, overall: 91, amount: 7 }],
    currentPick: 92,
  });

  assert.deepEqual(acquired, [{
    ...candidate,
    firstSeenPick: 70,
    lastSeenPick: 70,
    acquired: true,
    acquisitionPick: 91,
    acquisitionAmount: 7,
  }]);
  assert.equal(acquired[0].sourceCount, 5);
  assert.equal(acquired[0].modelMarketEdge, 13);
  assert.equal(acquired[0].modelSpread, 4);
});

test("the sleeper ledger is deterministic, bounded, and keeps acquired evidence first", () => {
  const observed = Array.from({ length: 70 }, (_, index) => ({
    ...candidate,
    playerId: index + 1,
    playerName: `Sleeper ${index + 1}`,
    score: 50 + index % 20,
  }));
  const ledger = mergeAuthenticatedSleeperEvidence({
    current: [],
    observed,
    ownPicks: [{ playerId: 1, overall: 100, amount: 0 }],
    currentPick: 80,
  });

  assert.equal(ledger.length, 64);
  assert.equal(ledger[0].playerId, 1);
  assert.equal(ledger[0].acquired, true);
});

test("sleeper evidence never serializes a pre-draft pick zero", () => {
  const [entry] = mergeAuthenticatedSleeperEvidence({
    current: [],
    observed: [{ ...candidate, score: 60 }],
    ownPicks: [],
    currentPick: 0,
  });

  assert.equal(entry.firstSeenPick, 1);
  assert.equal(entry.lastSeenPick, 1);
});
