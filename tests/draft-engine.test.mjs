import assert from "node:assert/strict";
import test from "node:test";
import { recommendPlayers } from "../app/lib/draft-engine.ts";

const league = {
  id: "1", name: "Test", season: 2026, size: 12, teamId: 1, draftType: "SNAKE",
  secondsPerPick: 90, rosterSize: 8, auctionBudget: 200,
  lineupSlotCounts: { "0": 1, "2": 2, "4": 2, "6": 1, "23": 1, "20": 1 },
  positionLimits: {}, scoringLabel: "PPR", scoringRules: 10, keeperCount: 0, pickOrder: [], teams: [],
};

const players = [
  { id: 1, name: "RB One", team: "A", pos: "RB", rank: 1, adp: 1, auction: 60, projected: 300 },
  { id: 2, name: "WR One", team: "B", pos: "WR", rank: 2, adp: 2, auction: 58, projected: 305 },
  { id: 3, name: "QB One", team: "C", pos: "QB", rank: 3, adp: 20, auction: 35, projected: 390 },
  { id: 4, name: "K One", team: "D", pos: "K", rank: 100, adp: 150, auction: 1, projected: 145 },
  { id: 5, name: "RB Two", team: "E", pos: "RB", rank: 6, adp: 8, auction: 42, projected: 260 },
  { id: 6, name: "WR Two", team: "F", pos: "WR", rank: 7, adp: 9, auction: 40, projected: 265 },
];

test("recommendations are deterministic and remove drafted players", () => {
  const picks = [{ playerId: 1, teamId: 2, overall: 1, round: 1, amount: 0 }];
  const first = recommendPlayers(players, picks, league, "BALANCED");
  const second = recommendPlayers(players, picks, league, "BALANCED");
  assert.deepEqual(first, second);
  assert.equal(first.some((player) => player.id === 1), false);
  assert.notEqual(first[0].pos, "K");
});

test("salary-cap recommendations preserve one dollar for every open slot", () => {
  const auctionLeague = { ...league, draftType: "AUCTION", rosterSize: 8 };
  const picks = [
    { playerId: 5, teamId: 1, overall: 1, round: 0, amount: 80 },
    { playerId: 6, teamId: 1, overall: 2, round: 0, amount: 60 },
  ];
  const recommendations = recommendPlayers(players, picks, auctionLeague, "BALANCED");
  const maximumLegalBid = 200 - 140 - (8 - 2 - 1);
  assert.ok(recommendations.every((player) => player.maxBid <= maximumLegalBid));
  assert.ok(recommendations.every((player) => player.maxBid >= 1));
});

test("strategy selection materially changes deterministic scores", () => {
  const hero = recommendPlayers(players, [], league, "HERO_RB");
  const zero = recommendPlayers(players, [], league, "ZERO_RB");
  const heroRb = hero.find((player) => player.id === 1);
  const zeroRb = zero.find((player) => player.id === 1);
  assert.ok(heroRb.score > zeroRb.score);
});
