import assert from "node:assert/strict";
import test from "node:test";
import { resolveEspnNominatedPlayer, resolveLiveBoardDisplayRank, resolveOwnNominationIntent, stabilizeEspnContext } from "../app/lib/espn-context-state.ts";

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

test("live auction nominees resolve by exact ESPN player id before duplicate names", () => {
  const duplicateNamePlayers = [
    { id: 101, name: "Baker Mayfield", consensusRank: 412, maxBid: 8 },
    { id: 202, name: "Baker Mayfield", consensusRank: 37, maxBid: 5 },
  ];
  assert.equal(
    resolveEspnNominatedPlayer(duplicateNamePlayers, {
      nominatedPlayer: "Baker Mayfield",
      nominatedPlayerId: 202,
    }),
    duplicateNamePlayers[1],
  );
});

test("live auction nominee name fallback is used only when the ESPN id is absent and the name is unique", () => {
  const players = [{ id: 202, name: "A.J. Brown" }];
  assert.equal(resolveEspnNominatedPlayer(players, { nominatedPlayer: "AJ Brown" }), players[0]);
  assert.equal(resolveEspnNominatedPlayer(players, { nominatedPlayer: "AJ Brown", nominatedPlayerId: null }), players[0]);
  assert.equal(resolveEspnNominatedPlayer(players, { nominatedPlayer: "AJ Brown", nominatedPlayerId: 999 }), undefined);
  assert.equal(resolveEspnNominatedPlayer([
    { id: 201, name: "A.J. Brown" },
    { id: 202, name: "AJ Brown" },
  ], { nominatedPlayer: "AJ Brown" }), undefined);
});

test("live auction nominees accept exact signed ESPN defense ids before name variants", () => {
  const players = [{ id: -16023, name: "Pittsburgh Steelers D/ST" }];
  assert.equal(resolveEspnNominatedPlayer(players, {
    nominatedPlayer: "Steelers Defense",
    nominatedPlayerId: -16023,
  }), players[0]);
});

test("present but invalid ESPN nominee ids fail closed without name fallback", () => {
  const players = [{ id: -16023, name: "Pittsburgh Steelers D/ST" }];
  for (const nominatedPlayerId of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.equal(resolveEspnNominatedPlayer(players, {
      nominatedPlayer: "Pittsburgh Steelers D/ST",
      nominatedPlayerId,
    }), undefined);
  }
});

test("late content recovery keeps an exact DRAIN nomination as a no-bid veto", () => {
  const nominee = { id: 12345, name: "Exact Player" };
  assert.equal(resolveOwnNominationIntent({
    ownNominationIntent: "DRAIN",
    ownNominationPlayerId: 12345,
  }, nominee, null), "DRAIN");
  assert.equal(resolveOwnNominationIntent({
    ownNominationIntent: "DRAIN",
    ownNominationPlayerId: 99999,
  }, nominee, null), null);
  assert.equal(resolveOwnNominationIntent({}, nominee, {
    playerId: 12345,
    playerName: "Exact Player",
    intent: "DRAIN",
  }), "DRAIN");
});

test("exact live nominee keeps its action object but displays its canonical live-board position", () => {
  const exactNominee = { id: 202, name: "Kyler Murray", pos: "QB", consensusRank: 337, maxBid: 9 };
  const canonicalIdentity = { id: 101, name: "Kyler Murray", pos: "QB", consensusRank: 35, maxBid: 4 };
  const sameNameOtherPosition = { id: 303, name: "Kyler Murray", pos: "WR", consensusRank: 2, maxBid: 30 };
  const players = [canonicalIdentity, exactNominee, sameNameOtherPosition];
  const resolved = resolveEspnNominatedPlayer(players, { nominatedPlayer: "Kyler Murray", nominatedPlayerId: 202 });
  assert.equal(resolved, exactNominee);
  assert.equal(resolved.maxBid, 9);
  assert.equal(resolveLiveBoardDisplayRank(resolved, players), 1);
});
