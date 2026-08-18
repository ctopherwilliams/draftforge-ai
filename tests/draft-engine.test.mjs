import assert from "node:assert/strict";
import test from "node:test";
import { auctionBudgetUsage, buildAuctionPlan, buildDraftDecision, buildPlayerPoolIndex, chooseAuctionNomination, openStarterSlots, recommendPlayers, starterNeeds } from "../app/lib/draft-engine.ts";

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
  const later = recommendPlayers(players, picks, league, "BALANCED", 20);
  assert.equal(later.find((player) => player.id === 2).adpValue, 18);
  assert.equal(later.find((player) => player.id === 3).adpValue, 0);
});

test("indexed decisions are identical to the compatibility recommendation path", () => {
  const auctionLeague = { ...league, draftType: "AUCTION" };
  const picks = [{ playerId: 1, teamId: 2, overall: 1, round: 0, amount: 42 }];
  const playerPool = buildPlayerPoolIndex(players, auctionLeague);
  const compatibility = recommendPlayers(players, picks, auctionLeague, "BALANCED", 2);
  const decision = buildDraftDecision(players, picks, auctionLeague, "BALANCED", 2, [], playerPool);

  assert.deepEqual(decision.recommendations, compatibility);
  assert.deepEqual(
    decision.auctionPlan,
    buildAuctionPlan(players, picks, auctionLeague, "BALANCED", [], playerPool),
  );
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
  assert.ok(recommendations.filter((player) => player.maxBid > 0).every((player) => player.maxBid >= 1));
  assert.equal(recommendations.find((player) => player.pos === "K").maxBid, 0);
});

test("custom ESPN specialist projections cannot unlock early K/DST picks or bids", () => {
  const specialistLeague = {
    ...league,
    draftType: "AUCTION",
    rosterSize: 14,
    lineupSlotCounts: { "0": 1, "2": 1, "4": 1, "7": 1, "16": 1, "17": 1, "23": 2, "20": 6 },
  };
  const customScoringPlayers = [
    { id: 501, name: "Elite WR", team: "A", pos: "WR", rank: 1, adp: 4, auction: 55, projected: 340 },
    { id: 502, name: "Custom DST", team: "B", pos: "DST", rank: 90, adp: 90, auction: 5, projected: 500 },
    { id: 503, name: "Custom K", team: "C", pos: "K", rank: 150, adp: 150, auction: 2, projected: 450 },
  ];
  const recommendations = recommendPlayers(customScoringPlayers, [], specialistLeague, "BALANCED");
  assert.equal(recommendations[0].id, 501);
  assert.ok(recommendations.filter((player) => ["K", "DST"].includes(player.pos)).every((player) => player.maxBid === 0));
  assert.ok(recommendations.filter((player) => ["K", "DST"].includes(player.pos)).every((player) => player.score < recommendations[0].score));
});

test("salary-cap ceilings follow source-backed player values instead of ESPN's legal maximum", () => {
  const auctionLeague = {
    ...league,
    draftType: "AUCTION",
    rosterSize: 16,
    lineupSlotCounts: { "0": 1, "2": 2, "4": 2, "6": 1, "23": 1, "16": 1, "17": 1, "20": 7 },
  };
  const auctionPlayers = [
    { id: 101, name: "Elite RB", team: "A", pos: "RB", rank: 1, adp: 1, auction: 45, projected: 300 },
    { id: 102, name: "Elite WR A", team: "B", pos: "WR", rank: 2, adp: 2, auction: 41, projected: 295 },
    { id: 103, name: "Elite WR B", team: "C", pos: "WR", rank: 3, adp: 3, auction: 44, projected: 290 },
    { id: 104, name: "Flex WR", team: "D", pos: "WR", rank: 4, adp: 4, auction: 44, projected: 285 },
  ];
  const picks = [
    { playerId: 101, teamId: 1, overall: 1, round: 0, amount: 45 },
    { playerId: 102, teamId: 1, overall: 2, round: 0, amount: 41 },
    { playerId: 103, teamId: 1, overall: 3, round: 0, amount: 44 },
  ];
  const recommendations = recommendPlayers(auctionPlayers, picks, auctionLeague, "BALANCED");
  const legalMaximum = 200 - 130 - (16 - 3 - 1);

  assert.equal(legalMaximum, 58);
  assert.ok(recommendations[0].maxBid <= auctionPlayers[3].auction);
  assert.ok(recommendations[0].maxBid < legalMaximum);
});

test("salary-cap portfolio budgets prevent one position from consuming the whole roster plan", () => {
  const auctionLeague = {
    ...league,
    draftType: "AUCTION",
    rosterSize: 16,
    lineupSlotCounts: { "0": 1, "2": 2, "4": 2, "6": 1, "23": 1, "16": 1, "17": 1, "20": 7 },
  };
  const planPlayers = [
    { id: 201, name: "WR A", team: "A", pos: "WR", rank: 1, adp: 1, auction: 50, projected: 300 },
    { id: 202, name: "WR B", team: "B", pos: "WR", rank: 2, adp: 2, auction: 45, projected: 290 },
    { id: 203, name: "WR C", team: "C", pos: "WR", rank: 3, adp: 3, auction: 40, projected: 280 },
    { id: 204, name: "WR D", team: "D", pos: "WR", rank: 4, adp: 4, auction: 35, projected: 270 },
    ...players,
  ];
  const wrSpend = [
    { playerId: 201, teamId: 1, overall: 1, round: 0, amount: 50 },
    { playerId: 202, teamId: 1, overall: 2, round: 0, amount: 45 },
  ];
  const plan = buildAuctionPlan(planPlayers, wrSpend, auctionLeague, "BALANCED");
  const recommendations = recommendPlayers(planPlayers, wrSpend, auctionLeague, "BALANCED");

  assert.equal(Object.values(plan.positionBudgets).reduce((sum, amount) => sum + amount, 0), 200);
  assert.equal(plan.spentByPosition.WR, 95);
  assert.ok(recommendations.find((player) => player.id === 203).maxBid <= 1);
  assert.ok(recommendations.find((player) => player.id === 1).maxBid > 1);
});

test("salary-cap planning tracks each opponent's spend and remaining leverage", () => {
  const auctionLeague = {
    ...league,
    draftType: "AUCTION",
    rosterSize: 8,
    teams: [{ id: 1, name: "Us", abbrev: "US" }, { id: 2, name: "Rival", abbrev: "RIV" }],
  };
  const picks = [
    { playerId: 1, teamId: 2, overall: 1, round: 0, amount: 50 },
    { playerId: 2, teamId: 2, overall: 2, round: 0, amount: 40 },
  ];
  const plan = buildAuctionPlan(players, picks, auctionLeague, "BALANCED");
  const rival = plan.opponents.find((team) => team.teamId === 2);

  assert.equal(rival.spent, 90);
  assert.equal(rival.players, 2);
  assert.equal(rival.maxOffer, 105);
  assert.equal(plan.opponentSpend, 90);

  const livePlan = buildAuctionPlan(players, picks, auctionLeague, "BALANCED", [
    { teamName: "Rival", remaining: 73, maxOffer: 66 },
  ]);
  assert.equal(livePlan.opponents.find((team) => team.teamId === 2).spent, 127);
  assert.equal(livePlan.opponents.find((team) => team.teamId === 2).maxOffer, 66);
  assert.equal(livePlan.opponents.find((team) => team.teamId === 2).players, 0);
  assert.equal(livePlan.opponentSpend, 127);

  const fullRosterPlan = buildAuctionPlan(players, picks, auctionLeague, "BALANCED", [
    { teamName: "Rival", remaining: 8, maxOffer: 0 },
  ]);
  assert.equal(fullRosterPlan.opponents.find((team) => team.teamId === 2).players, 8);
  assert.equal(fullRosterPlan.opponents.find((team) => team.teamId === 2).maxOffer, 0);
  assert.ok(Object.values(fullRosterPlan.opponents.find((team) => team.teamId === 2).openStarters).every((count) => count === 0));

  const exhaustedBotPlan = buildAuctionPlan(players, picks, auctionLeague, "BALANCED", [
    { teamName: "Rival", remaining: 0, maxOffer: 0 },
  ]);
  assert.equal(exhaustedBotPlan.opponents.find((team) => team.teamId === 2).players, 2);
  assert.ok(exhaustedBotPlan.opponents.find((team) => team.teamId === 2).openStarters.RB > 0);
});

test("salary-cap room inflation uses complete live spend when ESPN omits late bid amounts", () => {
  const auctionLeague = {
    ...league,
    draftType: "AUCTION",
    size: 2,
    rosterSize: 4,
    teams: [{ id: 1, name: "Us", abbrev: "US" }, { id: 2, name: "Rival", abbrev: "RIV" }],
  };
  const partialPrices = [
    { playerId: 1, teamId: 1, overall: 1, round: 0, amount: 50 },
    { playerId: 2, teamId: 2, overall: 2, round: 0, amount: 0 },
  ];
  const plan = buildAuctionPlan(players, partialPrices, auctionLeague, "BALANCED", [
    { teamName: "Us", remaining: 150, maxOffer: 148 },
    { teamName: "Rival", remaining: 120, maxOffer: 118 },
  ]);

  assert.equal(plan.roomPlayers, 2);
  assert.equal(plan.knownSaleCoverage, .5);
  assert.equal(plan.opponentSpend, 80);
  assert.equal(plan.opponents.find((team) => team.teamId === 2).players, 1);
  assert.notEqual(plan.roomInflation, 1);
});

test("salary-cap position budgets adapt to source-backed league values", () => {
  const auctionLeague = { ...league, draftType: "AUCTION" };
  const baseline = buildAuctionPlan(players, [], auctionLeague, "BALANCED");
  const quarterbackPremium = buildAuctionPlan(players.map((player) => ({
    ...player,
    auction: player.pos === "QB" ? player.auction * 5 : Math.max(1, player.auction / 2),
  })), [], auctionLeague, "BALANCED");

  assert.ok(quarterbackPremium.positionBudgets.QB > baseline.positionBudgets.QB);
  assert.equal(Object.values(quarterbackPremium.positionBudgets).reduce((sum, amount) => sum + amount, 0), 200);
});

test("strategy selection materially changes deterministic scores", () => {
  const hero = recommendPlayers(players, [], league, "HERO_RB");
  const zero = recommendPlayers(players, [], league, "ZERO_RB");
  const heroRb = hero.find((player) => player.id === 1);
  const zeroRb = zero.find((player) => player.id === 1);
  assert.ok(heroRb.score > zeroRb.score);
});

test("late mandatory skill slots soften preset discounts without raising auction ceilings", () => {
  const lateLeague = {
    ...league,
    draftType: "AUCTION",
    rosterSize: 10,
    lineupSlotCounts: { "0": 1, "2": 2, "4": 2, "6": 1, "16": 1, "17": 1, "23": 1, "20": 1 },
  };
  const latePlayers = [
    { id: 801, name: "Needed RB", team: "A", pos: "RB", rank: 20, adp: 70, auction: 12, projected: 260 },
    { id: 802, name: "Depth WR", team: "B", pos: "WR", rank: 21, adp: 71, auction: 12, projected: 260 },
    { id: 803, name: "QB", team: "C", pos: "QB", rank: 1, adp: 1, auction: 30, projected: 360 },
    { id: 804, name: "WR A", team: "D", pos: "WR", rank: 2, adp: 2, auction: 28, projected: 300 },
    { id: 805, name: "WR B", team: "E", pos: "WR", rank: 3, adp: 3, auction: 26, projected: 290 },
    { id: 806, name: "WR C", team: "F", pos: "WR", rank: 4, adp: 4, auction: 20, projected: 275 },
    { id: 807, name: "TE", team: "G", pos: "TE", rank: 5, adp: 5, auction: 18, projected: 230 },
    { id: 808, name: "DST", team: "H", pos: "DST", rank: 90, adp: 140, auction: 1, projected: 140 },
    { id: 809, name: "K", team: "I", pos: "K", rank: 100, adp: 150, auction: 1, projected: 130 },
    { id: 810, name: "RB Two", team: "J", pos: "RB", rank: 22, adp: 72, auction: 11, projected: 255 },
  ];
  const latePicks = [803, 804, 805, 806, 807, 808].map((playerId, index) => ({
    playerId, teamId: 1, overall: index + 1, round: 0, amount: 1,
  }));
  const earlyBalanced = recommendPlayers(latePlayers, [], lateLeague, "BALANCED").find((player) => player.id === 801);
  const earlyZero = recommendPlayers(latePlayers, [], lateLeague, "ZERO_RB").find((player) => player.id === 801);
  const lateBalanced = recommendPlayers(latePlayers, latePicks, lateLeague, "BALANCED").find((player) => player.id === 801);
  const lateZero = recommendPlayers(latePlayers, latePicks, lateLeague, "ZERO_RB").find((player) => player.id === 801);

  assert.ok(earlyBalanced.score - earlyZero.score > lateBalanced.score - lateZero.score);
  assert.ok(lateZero.maxBid <= Math.ceil(lateZero.fairValue * 1.1));
});

test("ESPN multi-position starter slots contribute to every eligible position", () => {
  const needs = starterNeeds({
    ...league,
    lineupSlotCounts: { "3": 1, "5": 1, "7": 1, "23": 2, "20": 6 },
  });
  assert.deepEqual(needs, { QB: .25, RB: .75, WR: 1.25, TE: .75, FLEX: 2 });
});

test("exact OP/FLEX matching releases a cheap QB surplus only after skill starters are filled", () => {
  const flexibleLeague = {
    ...league,
    draftType: "AUCTION",
    rosterSize: 14,
    lineupSlotCounts: { "0": 1, "2": 1, "4": 1, "7": 1, "16": 1, "17": 1, "23": 2, "20": 6 },
  };
  const flexiblePlayers = [
    { id: 401, name: "Anchor WR", team: "A", pos: "WR", rank: 1, adp: 1, auction: 45, projected: 310 },
    { id: 402, name: "Anchor RB", team: "B", pos: "RB", rank: 2, adp: 2, auction: 35, projected: 300 },
    { id: 403, name: "OP TE", team: "C", pos: "TE", rank: 3, adp: 3, auction: 35, projected: 280 },
    { id: 404, name: "Flex RB", team: "D", pos: "RB", rank: 4, adp: 4, auction: 25, projected: 270 },
    { id: 405, name: "Flex WR", team: "E", pos: "WR", rank: 5, adp: 5, auction: 20, projected: 265 },
    { id: 406, name: "Value QB", team: "F", pos: "QB", rank: 6, adp: 60, auction: 8, projected: 330 },
    { id: 407, name: "Depth WR", team: "G", pos: "WR", rank: 7, adp: 70, auction: 12, projected: 255 },
    { id: 408, name: "Backup QB", team: "H", pos: "QB", rank: 8, adp: 80, auction: 15, projected: 320 },
    { id: 409, name: "Kicker", team: "I", pos: "K", rank: 150, adp: 150, auction: 1, projected: 140 },
    { id: 410, name: "Defense", team: "J", pos: "DST", rank: 151, adp: 151, auction: 1, projected: 145 },
  ];
  const picks = [
    { playerId: 401, teamId: 1, overall: 1, round: 0, amount: 46 },
    { playerId: 402, teamId: 1, overall: 2, round: 0, amount: 33 },
    { playerId: 403, teamId: 1, overall: 3, round: 0, amount: 45 },
    { playerId: 404, teamId: 1, overall: 4, round: 0, amount: 23 },
    { playerId: 405, teamId: 1, overall: 5, round: 0, amount: 17 },
    { playerId: 406, teamId: 1, overall: 6, round: 0, amount: 3 },
  ];

  assert.equal(openStarterSlots(flexibleLeague, ["WR", "RB", "TE", "RB", "WR"]), 3);
  assert.equal(openStarterSlots(flexibleLeague, ["WR", "RB", "TE", "RB", "WR", "QB"]), 2);

  const recommendations = recommendPlayers(flexiblePlayers, picks, flexibleLeague, "BALANCED", 75);
  const usage = auctionBudgetUsage(buildAuctionPlan(flexiblePlayers, picks, flexibleLeague, "BALANCED"));
  const depth = recommendations.find((player) => player.id === 407);
  const backup = recommendations.find((player) => player.id === 408);
  assert.equal(depth.fillsMandatoryStarter, false);
  assert.ok(depth.maxBid > 2, "unused QB dollars should become value-depth budget");
  assert.equal(backup.fillsMandatoryStarter, false);
  assert.ok(backup.maxBid <= 3, "a filled OP must not unlock another premium QB bid");
  assert.equal(recommendations.find((player) => player.id === 409).fillsMandatoryStarter, true);
  assert.equal(recommendations.find((player) => player.id === 410).fillsMandatoryStarter, true);
  assert.equal(Object.values(usage.usage).reduce((sum, amount) => sum + amount, 0) + usage.reallocated, 167);
});

test("one-QB leagues penalize backups while core starters are open and reject a third QB bid", () => {
  const oneQbLeague = {
    ...league,
    rosterSize: 16,
    lineupSlotCounts: { "0": 1, "2": 2, "4": 2, "6": 1, "23": 1, "16": 1, "17": 1, "20": 7 },
  };
  const depthPlayers = [
    ...players,
    { id: 7, name: "QB Two", team: "G", pos: "QB", rank: 4, adp: 25, auction: 28, projected: 385 },
    { id: 8, name: "QB Three", team: "H", pos: "QB", rank: 5, adp: 35, auction: 20, projected: 380 },
  ];
  const oneQuarterback = [{ playerId: 3, teamId: 1, overall: 1, round: 1, amount: 30 }];
  const snake = recommendPlayers(depthPlayers, oneQuarterback, oneQbLeague, "BALANCED", 2);
  assert.notEqual(snake[0].pos, "QB");
  assert.ok(snake.find((player) => player.id === 7).score < snake.find((player) => player.id === 2).score);

  const auction = recommendPlayers(depthPlayers, [
    ...oneQuarterback,
    { playerId: 7, teamId: 1, overall: 2, round: 2, amount: 10 },
  ], { ...oneQbLeague, draftType: "AUCTION" }, "BALANCED", 3);
  assert.equal(auction.find((player) => player.id === 8).maxBid, 0);
});

test("a FLEX fraction cannot make a third tight end look like starter depth", () => {
  const oneTeFlexLeague = {
    ...league,
    rosterSize: 16,
    lineupSlotCounts: { "0": 1, "2": 2, "4": 2, "6": 1, "23": 1, "16": 1, "17": 1, "20": 7 },
  };
  const depthPlayers = [
    ...players,
    { id: 7, name: "TE One", team: "G", pos: "TE", rank: 4, adp: 45, auction: 22, projected: 260 },
    { id: 8, name: "TE Two", team: "H", pos: "TE", rank: 5, adp: 75, auction: 12, projected: 240 },
    { id: 9, name: "TE Three", team: "I", pos: "TE", rank: 6, adp: 105, auction: 6, projected: 230 },
    { id: 10, name: "RB Depth", team: "J", pos: "RB", rank: 7, adp: 110, auction: 5, projected: 220 },
  ];
  const twoTightEnds = [
    { playerId: 7, teamId: 1, overall: 1, round: 1, amount: 20 },
    { playerId: 8, teamId: 1, overall: 2, round: 2, amount: 10 },
  ];

  const snake = recommendPlayers(depthPlayers, twoTightEnds, oneTeFlexLeague, "BALANCED", 100);
  assert.ok(snake.find((player) => player.id === 9).score < snake.find((player) => player.id === 10).score);

  const auction = recommendPlayers(depthPlayers, twoTightEnds, { ...oneTeFlexLeague, draftType: "AUCTION" }, "BALANCED", 100);
  assert.equal(auction.find((player) => player.id === 9).maxBid, 0);
});

test("an ESPN QB plus OP lineup rejects a third quarterback", () => {
  const qbOpLeague = {
    ...league,
    draftType: "AUCTION",
    rosterSize: 14,
    lineupSlotCounts: { "0": 1, "2": 1, "4": 1, "7": 1, "16": 1, "17": 1, "20": 8 },
  };
  const qbOpPlayers = [
    ...players,
    { id: 7, name: "QB Two", team: "G", pos: "QB", rank: 4, adp: 25, auction: 28, projected: 385 },
    { id: 8, name: "QB Three", team: "H", pos: "QB", rank: 5, adp: 35, auction: 20, projected: 380 },
  ];
  const recommendations = recommendPlayers(qbOpPlayers, [
    { playerId: 3, teamId: 1, overall: 1, round: 0, amount: 3 },
    { playerId: 7, teamId: 1, overall: 2, round: 0, amount: 2 },
  ], qbOpLeague, "BALANCED", 50);

  assert.equal(recommendations.find((player) => player.id === 8).maxBid, 0);
  assert.ok(recommendations.find((player) => player.id === 8).score < recommendations.find((player) => player.id === 2).score);
});

test("salary-cap rosters cannot hoard scarce kicker or defense inventory", () => {
  const auctionLeague = { ...league, draftType: "AUCTION" };
  const specialistPlayers = [
    ...players,
    { id: 9, name: "K Two", team: "I", pos: "K", rank: 101, adp: 151, auction: 1, projected: 140 },
    { id: 10, name: "DST One", team: "J", pos: "DST", rank: 102, adp: 152, auction: 1, projected: 150 },
    { id: 11, name: "DST Two", team: "K", pos: "DST", rank: 103, adp: 153, auction: 1, projected: 145 },
  ];
  const recommendations = recommendPlayers(specialistPlayers, [
    { playerId: 4, teamId: 1, overall: 1, round: 0, amount: 1 },
    { playerId: 10, teamId: 1, overall: 2, round: 0, amount: 1 },
  ], auctionLeague, "BALANCED", 100);

  assert.equal(recommendations.find((player) => player.id === 9).maxBid, 0);
  assert.equal(recommendations.find((player) => player.id === 11).maxBid, 0);
});

test("snake rosters never recommend a second kicker or defense", () => {
  const specialistLeague = {
    ...league,
    rosterSize: 16,
    lineupSlotCounts: { "0": 1, "2": 2, "4": 2, "6": 1, "23": 1, "16": 1, "17": 1, "20": 7 },
  };
  const specialistPlayers = [
    ...players,
    { id: 10, name: "DST One", team: "J", pos: "DST", rank: 102, adp: 152, auction: 1, projected: 150 },
    { id: 11, name: "DST Two", team: "K", pos: "DST", rank: 103, adp: 153, auction: 1, projected: 145 },
    { id: 12, name: "K Two", team: "L", pos: "K", rank: 104, adp: 154, auction: 1, projected: 140 },
  ];
  const recommendations = recommendPlayers(specialistPlayers, [
    { playerId: 4, teamId: 1, overall: 1, round: 1, amount: 0 },
    { playerId: 10, teamId: 1, overall: 2, round: 2, amount: 0 },
  ], specialistLeague, "BALANCED", 153);

  assert.equal(recommendations.some((player) => player.pos === "K"), false);
  assert.equal(recommendations.some((player) => player.pos === "DST"), false);
  assert.ok(["QB", "RB", "WR", "TE"].includes(recommendations[0].pos));
});

test("the endgame locks onto missing mandatory starters before bench depth", () => {
  const endgameLeague = {
    ...league,
    rosterSize: 16,
    lineupSlotCounts: { "0": 1, "2": 2, "4": 2, "6": 1, "23": 1, "16": 1, "17": 1, "20": 7 },
  };
  const endgamePlayers = [
    { id: 101, name: "QB", team: "A", pos: "QB", rank: 1, adp: 1, auction: 30, projected: 380 },
    ...Array.from({ length: 6 }, (_, index) => ({ id: 110 + index, name: `RB ${index}`, team: "B", pos: "RB", rank: 10 + index, adp: 10 + index, auction: 20, projected: 280 - index * 5 })),
    ...Array.from({ length: 6 }, (_, index) => ({ id: 120 + index, name: `WR ${index}`, team: "C", pos: "WR", rank: 20 + index, adp: 20 + index, auction: 20, projected: 285 - index * 5 })),
    { id: 130, name: "TE", team: "D", pos: "TE", rank: 30, adp: 30, auction: 15, projected: 240 },
    { id: 131, name: "K", team: "E", pos: "K", rank: 150, adp: 150, auction: 1, projected: 140 },
    { id: 132, name: "DST", team: "F", pos: "DST", rank: 151, adp: 151, auction: 1, projected: 145 },
    { id: 133, name: "Depth WR", team: "G", pos: "WR", rank: 40, adp: 40, auction: 10, projected: 250 },
  ];
  const rosterIds = [101, 110, 111, 112, 113, 114, 115, 120, 121, 122, 123, 124, 130];
  const endgamePicks = rosterIds.map((playerId, index) => ({ playerId, teamId: 1, overall: index + 1, round: index + 1, amount: 0 }));
  const endgame = recommendPlayers(endgamePlayers, endgamePicks, endgameLeague, "BALANCED", 100);
  assert.ok(["K", "DST"].includes(endgame[0].pos));
  assert.ok(["K", "DST"].includes(endgame[1].pos));
  assert.ok(endgame.filter((player) => ["K", "DST"].includes(player.pos)).every((player) => player.fillsMandatoryStarter));
  assert.ok(endgame.filter((player) => !["K", "DST"].includes(player.pos)).every((player) => !player.fillsMandatoryStarter));

  const auctionEndgame = recommendPlayers(endgamePlayers, endgamePicks, { ...endgameLeague, draftType: "AUCTION" }, "BALANCED", 100);
  assert.ok(auctionEndgame.filter((player) => !["K", "DST"].includes(player.pos)).every((player) => player.maxBid === 0));
  const auctionEndgamePlan = buildAuctionPlan(endgamePlayers, endgamePicks, { ...endgameLeague, draftType: "AUCTION" }, "BALANCED");
  assert.ok(["K", "DST"].includes(chooseAuctionNomination(auctionEndgame, { ...endgameLeague, draftType: "AUCTION" }, auctionEndgamePlan).player.pos));
});

test("room overpayment deflates remaining values while underpayment inflates them", () => {
  const auctionLeague = {
    ...league,
    draftType: "AUCTION",
    size: 2,
    rosterSize: 3,
    lineupSlotCounts: { "0": 1, "2": 1, "4": 1 },
    teams: [{ id: 1, name: "Us", abbrev: "US" }, { id: 2, name: "Rival", abbrev: "RIV" }],
  };
  const market = [
    { id: 301, name: "Alpha", team: "A", pos: "RB", rank: 1, adp: 1, auction: 80, projected: 300 },
    { id: 302, name: "Beta", team: "B", pos: "WR", rank: 2, adp: 2, auction: 60, projected: 290 },
    { id: 303, name: "Gamma", team: "C", pos: "QB", rank: 3, adp: 3, auction: 40, projected: 380 },
    { id: 304, name: "Delta", team: "D", pos: "RB", rank: 4, adp: 4, auction: 30, projected: 250 },
    { id: 305, name: "Epsilon", team: "E", pos: "WR", rank: 5, adp: 5, auction: 20, projected: 245 },
    { id: 306, name: "Zeta", team: "F", pos: "QB", rank: 6, adp: 6, auction: 10, projected: 340 },
  ];
  const expected = 80 * (auctionLeague.size * auctionLeague.auctionBudget) / 240;
  const overpaid = buildAuctionPlan(market, [{ playerId: 301, teamId: 2, overall: 1, round: 0, amount: Math.ceil(expected + 20) }], auctionLeague, "BALANCED");
  const underpaid = buildAuctionPlan(market, [{ playerId: 301, teamId: 2, overall: 1, round: 0, amount: Math.max(1, Math.floor(expected - 20)) }], auctionLeague, "BALANCED");

  assert.ok(overpaid.roomInflation < 1);
  assert.ok(underpaid.roomInflation > 1);
});

test("auction fair value blends five-source market price with scoring-adjusted VORP", () => {
  const auctionLeague = { ...league, draftType: "AUCTION" };
  const equalMarket = [
    { id: 401, name: "High VORP", team: "A", pos: "RB", rank: 1, adp: 1, auction: 30, projected: 330 },
    { id: 402, name: "Low VORP", team: "B", pos: "RB", rank: 2, adp: 2, auction: 30, projected: 230 },
    ...players.filter((player) => player.pos !== "RB"),
  ];
  const recommendations = recommendPlayers(equalMarket, [], auctionLeague, "BALANCED");

  assert.ok(recommendations.find((player) => player.id === 401).projectionValue > recommendations.find((player) => player.id === 402).projectionValue);
  assert.ok(recommendations.find((player) => player.id === 401).fairValue > recommendations.find((player) => player.id === 402).fairValue);
});

test("sleepers require corroborated model-over-market value and wait for the snake timing window", () => {
  const sleeperPlayers = [
    { id: 701, name: "Corroborated Sleeper", team: "A", pos: "WR", rank: 80, adp: 100, auction: 8, projected: 290, sourceCount: 5, marketSourceCount: 3, modelSourceCount: 2, modelMarketEdge: 20, modelSpread: 2, consensusScore: 72 },
    { id: 702, name: "Single Source Hype", team: "B", pos: "WR", rank: 81, adp: 101, auction: 8, projected: 285, sourceCount: 4, marketSourceCount: 3, modelSourceCount: 1, modelMarketEdge: 25, modelSpread: 0, consensusScore: 72 },
    { id: 703, name: "Injured Upside", team: "C", pos: "WR", rank: 82, adp: 102, auction: 7, projected: 280, injured: true, sourceCount: 5, marketSourceCount: 3, modelSourceCount: 2, modelMarketEdge: 25, modelSpread: 1, consensusScore: 72 },
    { id: 704, name: "Replacement WR", team: "D", pos: "WR", rank: 140, adp: 140, auction: 1, projected: 240, sourceCount: 5, marketSourceCount: 3, modelSourceCount: 2, modelMarketEdge: 0, modelSpread: 2, consensusScore: 35 },
  ];
  const early = recommendPlayers(sleeperPlayers, [], league, "BALANCED", 50);
  const window = recommendPlayers(sleeperPlayers, [], league, "BALANCED", 90);
  const sleeperEarly = early.find((player) => player.id === 701);
  const sleeperWindow = window.find((player) => player.id === 701);

  assert.equal(sleeperEarly.sleeperLabel, "SLEEPER");
  assert.ok(sleeperEarly.sleeperScore >= 55);
  assert.equal(sleeperEarly.sleeperBonus, 0);
  assert.ok(sleeperWindow.sleeperBonus > 0);
  assert.equal(early.find((player) => player.id === 702).sleeperLabel, "NONE");
  assert.equal(early.find((player) => player.id === 703).sleeperLabel, "NONE");
});

test("salary-cap sleeper priority never raises the source-backed walk-away ceiling", () => {
  const auctionLeague = { ...league, draftType: "AUCTION" };
  const sleeperPlayers = [
    { id: 711, name: "Auction Sleeper", team: "A", pos: "RB", rank: 80, adp: 100, auction: 12, projected: 290, sourceCount: 5, marketSourceCount: 3, modelSourceCount: 2, modelMarketEdge: 22, modelSpread: 2, consensusScore: 75 },
    { id: 712, name: "Replacement RB", team: "B", pos: "RB", rank: 140, adp: 140, auction: 1, projected: 230, sourceCount: 5, marketSourceCount: 3, modelSourceCount: 2, modelMarketEdge: 0, modelSpread: 2, consensusScore: 30 },
  ];
  const withSleeper = recommendPlayers(sleeperPlayers, [], auctionLeague, "BALANCED").find((player) => player.id === 711);
  const withoutSleeper = recommendPlayers(sleeperPlayers.map((player) => ({ ...player, modelMarketEdge: 0 })), [], auctionLeague, "BALANCED").find((player) => player.id === 711);

  assert.equal(withSleeper.sleeperLabel, "SLEEPER");
  assert.equal(withSleeper.sleeperBonus, 0);
  assert.equal(withSleeper.maxBid, withoutSleeper.maxBid);
  assert.ok(withSleeper.maxBid <= Math.ceil(withSleeper.fairValue * 1.1));
});

test("salary-cap nominations protect sleepers until the leverage endgame", () => {
  const auctionLeague = {
    ...league,
    draftType: "AUCTION",
    size: 2,
    rosterSize: 4,
    teams: [{ id: 1, name: "Us", abbrev: "US" }, { id: 2, name: "Rival", abbrev: "RIV" }],
  };
  const candidate = (id, name, score, sleeperLabel, need = 0) => ({
    id, name, team: `T${id}`, pos: "RB", rank: id, adp: id, auction: 30, projected: 280,
    score, confidence: 85, vorp: 40, scarcity: 2, need, adpValue: 0, projectionValue: 30,
    fairValue: 30, targetBid: 27, maxBid: 32, fillsMandatoryStarter: Boolean(need), sleeperScore: sleeperLabel === "NONE" ? 0 : 75,
    sleeperLabel, sleeperBonus: 0, reasons: [],
  });
  const recommendations = [
    candidate(721, "Protected Sleeper", 110, "SLEEPER"),
    candidate(722, "Public Target", 100, "NONE", 1),
    candidate(723, "Safe Decoy", 70, "NONE"),
  ];
  const startPlan = buildAuctionPlan(recommendations, [], auctionLeague, "BALANCED");
  const middlePlan = { ...startPlan, roomPlayers: 3 };
  const endPlan = { ...startPlan, roomPlayers: 7 };

  assert.equal(chooseAuctionNomination(recommendations, auctionLeague, startPlan).player.id, 722);
  assert.equal(chooseAuctionNomination(recommendations, auctionLeague, middlePlan).intent, "DRAIN");
  assert.equal(chooseAuctionNomination(recommendations, auctionLeague, middlePlan).player.id, 723);
  assert.equal(chooseAuctionNomination(recommendations, auctionLeague, endPlan).player.id, 721);
});

test("nomination policy buys the first value, drains safely in the middle, and targets the endgame", () => {
  const auctionLeague = {
    ...league,
    draftType: "AUCTION",
    size: 2,
    rosterSize: 4,
    teams: [{ id: 1, name: "Us", abbrev: "US" }, { id: 2, name: "Rival", abbrev: "RIV" }],
  };
  const recommendations = [
    { id: 501, name: "Wanted", team: "A", pos: "RB", rank: 1, adp: 1, auction: 45, projected: 300, score: 100, confidence: 90, vorp: 80, scarcity: 2, need: 1, adpValue: 0, projectionValue: 45, fairValue: 45, targetBid: 41, maxBid: 48, reasons: [] },
    { id: 502, name: "Decoy", team: "B", pos: "QB", rank: 2, adp: 2, auction: 35, projected: 350, score: 70, confidence: 80, vorp: 20, scarcity: 1, need: 0, adpValue: 0, projectionValue: 30, fairValue: 35, targetBid: 30, maxBid: 35, reasons: [] },
  ];
  const startPlan = buildAuctionPlan(recommendations, [], auctionLeague, "BALANCED");
  const middlePlan = buildAuctionPlan(recommendations, [{ playerId: 501, teamId: 2, overall: 1, round: 0, amount: 45 }], auctionLeague, "BALANCED");
  const endPlan = { ...middlePlan, roomPlayers: 7 };

  assert.equal(chooseAuctionNomination(recommendations, auctionLeague, startPlan).intent, "TARGET");
  assert.equal(chooseAuctionNomination(recommendations, auctionLeague, middlePlan).intent, "DRAIN");
  assert.equal(chooseAuctionNomination(recommendations, auctionLeague, middlePlan).openingBid, 1);
  assert.equal(chooseAuctionNomination(recommendations, auctionLeague, endPlan).intent, "TARGET");
});

test("early salary-cap wins are bounded by cumulative pacing guardrails", () => {
  const auctionLeague = { ...league, draftType: "AUCTION", rosterSize: 16 };
  const huge = [{ id: 601, name: "Huge", team: "A", pos: "RB", rank: 1, adp: 1, auction: 180, projected: 500 }, ...players];
  const recommendation = recommendPlayers(huge, [], auctionLeague, "BALANCED").find((player) => player.id === 601);

  assert.ok(recommendation.maxBid <= 70);
});

test("salary-cap scarcity never authorizes a bidding war above market-adjusted source value", () => {
  const auctionLeague = { ...league, draftType: "AUCTION", rosterSize: 16 };
  const recommendations = recommendPlayers(players, [], auctionLeague, "BALANCED");

  assert.ok(recommendations.every((player) => player.maxBid <= Math.ceil(player.fairValue * 1.1)));
});
