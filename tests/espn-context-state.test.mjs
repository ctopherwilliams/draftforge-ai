import assert from "node:assert/strict";
import test from "node:test";
import { stabilizeEspnContext } from "../app/lib/espn-context-state.ts";

const base = {
  leagueId: "701",
  tabId: 41,
  remainingSeconds: 30,
  availablePlayerIds: [1, 2],
  availablePlayerNames: ["One", "Two"],
  ownRoster: [{ playerId: 3, name: "Three", amount: 12 }],
  auctionBudgets: [{ teamName: "Us", remaining: 188, maxOffer: 174 }],
  auctionSales: [{ playerId: 3, playerName: "Three", teamName: "Us", amount: 12, sequence: 1 }],
};

test("equivalent ESPN payloads retain the same context identity", () => {
  const result = stabilizeEspnContext(base, structuredClone(base));
  assert.equal(result, base);
});

test("clock ticks retain decision-array identity", () => {
  const result = stabilizeEspnContext(base, { ...structuredClone(base), remainingSeconds: 29 });
  assert.notEqual(result, base);
  assert.equal(result.availablePlayerIds, base.availablePlayerIds);
  assert.equal(result.availablePlayerNames, base.availablePlayerNames);
  assert.equal(result.ownRoster, base.ownRoster);
  assert.equal(result.auctionBudgets, base.auctionBudgets);
  assert.equal(result.auctionSales, base.auctionSales);
});

test("a real budget change advances decision-array identity", () => {
  const result = stabilizeEspnContext(base, {
    ...structuredClone(base),
    auctionBudgets: [{ teamName: "Us", remaining: 187, maxOffer: 173 }],
  });
  assert.notEqual(result.auctionBudgets, base.auctionBudgets);
});
