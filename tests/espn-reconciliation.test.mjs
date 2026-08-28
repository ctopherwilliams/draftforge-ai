import assert from "node:assert/strict";
import test from "node:test";
import { recommendPlayers } from "../app/lib/draft-engine.ts";
import { liveEspnRecommendations, reconcileEspnPicks, resolveAuctionSales, resolveOwnRoster, resolveSnakeDraftPicks } from "../app/lib/espn-reconciliation.ts";

const players = [
  { id: 1, name: "Our Player", team: "AAA", pos: "QB", rank: 1, adp: 1, auction: 10, projected: 300 },
  { id: 2, name: "Opponent Player", team: "BBB", pos: "RB", rank: 2, adp: 2, auction: 9, projected: 250 },
];

test("ESPN roster reconciliation prefers a known exact player id and bounds name fallback to unmapped ids", () => {
  const rosterPlayers = [
    { ...players[0], id: 11, name: "Shared Name" },
    { ...players[1], id: 12, name: "Shared Name" },
    { id: 13, name: "Ravens D/ST", team: "BAL", pos: "DST", rank: 3, adp: 3, auction: 1, projected: 120 },
  ];
  const context = {
    ownRoster: [
      { playerId: 12, name: "Shared Name", amount: 7 },
      { playerId: 999, name: "Our Player", amount: 3 },
      { playerId: 33, name: "Baltimore Ravens D/ST", amount: 1 },
      { playerId: 404, name: "Unknown Player", amount: 1 },
    ],
  };

  assert.deepEqual(resolveOwnRoster(context, [...rosterPlayers, players[0]]), [
    { playerId: 12, amount: 7, index: 0 },
    { playerId: 1, amount: 3, index: 1 },
    { playerId: 13, amount: 1, index: 2 },
  ]);
});

test("ESPN snake history reconstructs the full board when the practice API returns only our roster", () => {
  const league = {
    id: "practice", name: "Practice", season: 2026, size: 2, teamId: 7, draftType: "SNAKE",
    secondsPerPick: 30, rosterSize: 2, auctionBudget: 200, lineupSlotCounts: { "0": 1, "2": 1 },
    positionLimits: {}, scoringLabel: "Standard", scoringRules: 29, keeperCount: 0, pickOrder: [],
    teams: [{ id: 7, name: "Us", abbrev: "US" }, { id: 9, name: "Rival", abbrev: "RIV" }],
  };
  const context = {
    inDraftRoom: true,
    ownRoster: [{ playerId: 1, name: "Our Player" }],
    snakePicks: [
      { playerName: "Opponent Player", teamName: "Rival", round: 1, roundPick: 1 },
      { playerName: "Our Player", teamName: "Us", round: 1, roundPick: 2 },
    ],
  };

  assert.deepEqual(resolveSnakeDraftPicks(context, league, players), [
    { playerId: 2, teamId: 9, overall: 1, round: 1, amount: 0 },
    { playerId: 1, teamId: 7, overall: 2, round: 1, amount: 0 },
  ]);
  assert.deepEqual(reconcileEspnPicks([], context, league.teamId, players, league), [
    { playerId: 2, teamId: 9, overall: 1, round: 1, amount: 0 },
    { playerId: 1, teamId: 7, overall: 2, round: 1, amount: 0 },
  ]);
});

test("ambiguous snake team names and name-abbreviation collisions stay generic opponents", () => {
  const league = {
    size: 3,
    teamId: 7,
    draftType: "SNAKE",
    teams: [
      { id: 7, name: "Shared Club", abbrev: "Our Code" },
      { id: 9, name: "Shared Club", abbrev: "RIV" },
      { id: 10, name: "Our Code", abbrev: "OTH" },
    ],
  };
  const context = {
    inDraftRoom: true,
    ownRoster: [],
    snakePicks: [
      { playerName: "Our Player", teamName: "Shared Club", round: 1, roundPick: 1 },
      { playerName: "Opponent Player", teamName: "Our-Code", round: 1, roundPick: 2 },
    ],
  };
  const expected = [
    { playerId: 1, teamId: 2_000_000_000, overall: 1, round: 1, amount: 0 },
    { playerId: 2, teamId: 2_000_000_000, overall: 2, round: 1, amount: 0 },
  ];

  assert.deepEqual(resolveSnakeDraftPicks(context, league, players), expected);
  assert.deepEqual(reconcileEspnPicks([], context, league.teamId, players, league), expected);
  assert.equal(expected.some((pick) => pick.teamId === league.teamId), false);
});

test("ambiguous auction team names and name-abbreviation collisions fail closed", () => {
  const league = {
    teams: [
      { id: 7, name: "Shared Club", abbrev: "Our Code" },
      { id: 9, name: "Shared Club", abbrev: "RIV" },
      { id: 10, name: "Our Code", abbrev: "OTH" },
    ],
  };
  const context = {
    inDraftRoom: true,
    auctionSales: [
      { playerId: 1, playerName: "Our Player", teamName: "Shared Club", amount: 5, sequence: 1 },
      { playerId: 2, playerName: "Opponent Player", teamName: "Our.Code", amount: 8, sequence: 2 },
    ],
  };

  assert.deepEqual(resolveAuctionSales(context, league, players), []);
});

test("ESPN completion-state availability cannot erase confirmed sale history", () => {
  const picks = [
    { playerId: 1, teamId: 7, overall: 1, round: 0, amount: 5 },
    { playerId: 2, teamId: 9, overall: 2, round: 0, amount: 8 },
  ];
  const context = {
    ownRoster: [{ playerId: 1, name: "Our Player", amount: 5 }],
    // ESPN can repopulate its player controls after our salary-cap roster is
    // complete. Those controls are not evidence that a confirmed sale vanished.
    availablePlayerIds: [1, 2],
  };

  assert.deepEqual(reconcileEspnPicks(picks, context, 7, players), picks);
});

test("a transient partial ESPN roster cannot demote a previously confirmed own pick", () => {
  const picks = [
    { playerId: 1, teamId: 7, overall: 1, round: 0, amount: 5 },
    { playerId: 2, teamId: 7, overall: 2, round: 0, amount: 8 },
  ];
  const partialContext = {
    inDraftRoom: true,
    // ESPN can virtualize an older row while a newly rendered row remains.
    ownRoster: [{ playerId: 1, name: "Our Player", amount: 5 }],
  };

  assert.deepEqual(reconcileEspnPicks(picks, partialContext, 7, players), picks);
});

test("an exact roster addition is monotonic even when the same frame omits an older row", () => {
  const rosterPlayers = [
    ...players,
    { id: 3, name: "New Player", team: "CCC", pos: "WR", rank: 3, adp: 3, auction: 7, projected: 240 },
  ];
  const picks = [
    { playerId: 1, teamId: 7, overall: 1, round: 0, amount: 5 },
    { playerId: 2, teamId: 9, overall: 2, round: 0, amount: 8 },
  ];
  const partialContext = {
    inDraftRoom: true,
    ownRoster: [{ playerId: 3, name: "New Player", amount: 7 }],
  };

  assert.deepEqual(reconcileEspnPicks(picks, partialContext, 7, rosterPlayers), [
    ...picks,
    { playerId: 3, teamId: 7, overall: 3, round: 0, amount: 7 },
  ]);
});

test("an authoritative opponent attribution remains correct when the player is absent from our roster", () => {
  const authoritative = [
    { playerId: 1, teamId: 9, overall: 1, round: 1, amount: 0 },
  ];
  const context = { inDraftRoom: true, ownRoster: [] };

  assert.deepEqual(reconcileEspnPicks(authoritative, context, 7, players), authoritative);
});

test("ordinary ESPN clubhouse rosters never contaminate pre-draft picks or auction sales", () => {
  const clubhouse = {
    inDraftRoom: false,
    ownRoster: [{ playerId: 1, name: "Our Player", amount: 5 }],
    auctionSales: [{ playerId: 2, playerName: "Opponent Player", teamName: "Rival", amount: 8 }],
  };
  const league = { teams: [{ id: 9, name: "Rival", abbrev: "RIV" }] };
  assert.deepEqual(reconcileEspnPicks([], clubhouse, 7, players), []);
  assert.deepEqual(resolveAuctionSales(clubhouse, league, players), []);
});

test("final ESPN slots recover mandatory players omitted by the virtualized grid", () => {
  const recommendations = [
    { ...players[0], fillsMandatoryStarter: false },
    { id: 3, name: "Ravens D/ST", team: "BAL", pos: "DST", fillsMandatoryStarter: true },
  ];
  const context = {
    inDraftRoom: true,
    // ESPN exposes a readable live pool but virtualizes the final defense out
    // of the rendered rows. The content script can still resolve it by search.
    availablePlayerIds: [1],
    availablePlayerNames: ["Our Player"],
  };

  assert.deepEqual(
    liveEspnRecommendations(recommendations, context, [], 1).map((player) => player.id),
    [3],
  );
  assert.deepEqual(
    liveEspnRecommendations(recommendations, context, [], 3).map((player) => player.id),
    [1],
  );
  assert.deepEqual(liveEspnRecommendations(recommendations, context, [3], 1), []);
});

test("final ESPN slots prefer a visible mandatory player before exact-search fallbacks", () => {
  const recommendations = [
    { id: 4, name: "Texans D/ST", team: "HOU", pos: "DST", fillsMandatoryStarter: true },
    { id: 3, name: "Ravens D/ST", team: "BAL", pos: "DST", fillsMandatoryStarter: true },
  ];
  const context = {
    inDraftRoom: true,
    availablePlayerIds: [3],
    availablePlayerNames: ["Ravens D/ST"],
  };

  assert.deepEqual(
    liveEspnRecommendations(recommendations, context, [], 1).map((player) => player.id),
    [3, 4],
  );
});

test("synchronous ESPN roster reconciliation locks late depth before K/DST can be skipped", () => {
  const league = {
    id: "fast-auction", name: "Fast auction", season: 2026, size: 12, teamId: 7, draftType: "AUCTION",
    secondsPerPick: 30, rosterSize: 14, auctionBudget: 200,
    lineupSlotCounts: { "0": 1, "2": 1, "4": 1, "7": 1, "16": 1, "17": 1, "20": 6, "23": 2 },
    positionLimits: {}, scoringLabel: "PPR", scoringRules: 45, keeperCount: 0, pickOrder: [], teams: [],
  };
  const ownPlayers = Array.from({ length: 12 }, (_, index) => ({
    id: 100 + index,
    name: `Roster Player ${index + 1}`,
    team: `T${index}`,
    pos: index === 0 ? "QB" : index === 1 ? "TE" : index % 2 ? "WR" : "RB",
    rank: index + 1,
    adp: index + 1,
    auction: Math.max(1, 20 - index),
    projected: 300 - index * 5,
  }));
  const kicker = { id: 201, name: "Required Kicker", team: "K", pos: "K", rank: 150, adp: 150, auction: 1, projected: 130 };
  const defense = { id: 202, name: "Required Defense", team: "D", pos: "DST", rank: 151, adp: 151, auction: 1, projected: 140 };
  const depth = { id: 203, name: "Extra Depth", team: "X", pos: "RB", rank: 80, adp: 80, auction: 5, projected: 240 };
  const rawPicks = ownPlayers.slice(0, 10).map((player, index) => ({
    playerId: player.id, teamId: 7, overall: index + 1, round: 0, amount: 1,
  }));
  const context = {
    inDraftRoom: true,
    ownRoster: ownPlayers.map((player) => ({ playerId: player.id, name: player.name, amount: 1 })),
  };
  const allPlayers = [...ownPlayers, kicker, defense, depth];
  const stale = recommendPlayers(allPlayers, rawPicks, league, "BALANCED");
  const reconciled = reconcileEspnPicks(rawPicks, context, league.teamId, allPlayers);
  const live = recommendPlayers(allPlayers, reconciled, league, "BALANCED");

  assert.ok(stale.find((player) => player.id === depth.id).maxBid > 0);
  assert.equal(reconciled.filter((pick) => pick.teamId === league.teamId).length, 12);
  assert.equal(live.find((player) => player.id === depth.id).maxBid, 0);
  assert.ok(live.filter((player) => [kicker.id, defense.id].includes(player.id)).every((player) => player.fillsMandatoryStarter));
});
