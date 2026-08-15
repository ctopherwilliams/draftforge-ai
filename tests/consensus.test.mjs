import assert from "node:assert/strict";
import test from "node:test";
import { mergeConsensus, normalizePlayerName } from "../app/lib/consensus.ts";

const espn = [
  { id: 1, name: "Ja'Marr Chase", team: "CIN", pos: "WR", rank: 1, adp: 2, auction: 60, projected: 300 },
  { id: 2, name: "Bijan Robinson Jr.", team: "ATL", pos: "RB", rank: 2, adp: 1, auction: 62, projected: 295 },
];

const sources = [
  { id: "ffc", name: "FFC", kind: "market", weight: .15, status: "ok", updatedAt: null, attribution: "ffc", players: [
    { name: "Bijan Robinson", team: "ATL", pos: "RB", rank: 1, adp: 1 },
    { name: "Jamar Chase", team: "CIN", pos: "WR", rank: 2, adp: 2 },
  ] },
  { id: "gng", name: "GNG", kind: "model", weight: .20, status: "ok", updatedAt: null, attribution: "gng", players: [
    { name: "Bijan Robinson", team: "ATL", pos: "RB", rank: 1 },
    { name: "Ja'Marr Chase", team: "CIN", pos: "WR", rank: 2 },
  ] },
];

test("player names normalize across punctuation and suffixes", () => {
  assert.equal(normalizePlayerName("Bijan Robinson Jr."), normalizePlayerName("Bijan Robinson"));
  assert.equal(normalizePlayerName("Ja’Marr Chase"), normalizePlayerName("Ja'Marr Chase"));
});

test("consensus combines sources deterministically and exposes provenance", () => {
  const first = mergeConsensus(espn, sources);
  const second = mergeConsensus(espn, sources);
  assert.deepEqual(first, second);
  const bijan = first.find((player) => player.id === 2);
  assert.equal(bijan.sourceCount, 3);
  assert.equal(bijan.sourceRanks.espn, 2);
  assert.equal(bijan.sourceRanks.ffc, 1);
  assert.equal(bijan.sourceRanks.gng, 1);
  assert.equal(bijan.consensusRank, 1);
  assert.ok(bijan.sourceAuctions.espn > 0);
  assert.ok(bijan.sourceAuctions.ffc > 0);
  assert.ok(bijan.sourceAuctions.gng > 0);
});

test("every healthy ranking source produces a deterministic league-normalized auction value", () => {
  const league = { size: 8, rosterSize: 16, auctionBudget: 200 };
  const merged = mergeConsensus(espn, sources, league);

  for (const player of merged) {
    assert.ok(Number.isFinite(player.auction));
    assert.ok(player.auction >= 1);
    assert.equal(Object.keys(player.sourceAuctions).length, player.sourceCount);
  }
  assert.deepEqual(merged, mergeConsensus(espn, sources, league));
});

test("consensus separates corroborated model value from market price without adding a sixth source", () => {
  const market = [
    { id: 11, name: "Market Favorite", team: "AAA", pos: "WR", rank: 1, adp: 1, auction: 20, projected: 250 },
    { id: 12, name: "Hidden Value", team: "BBB", pos: "WR", rank: 2, adp: 2, auction: 10, projected: 260 },
  ];
  const ranked = (id, hiddenRank, favoriteRank) => ({
    id,
    name: id.toUpperCase(),
    kind: id === "ffc" || id === "mfl" ? "market" : "model",
    weight: id === "ffc" || id === "mfl" ? .15 : .20,
    status: "ok",
    updatedAt: null,
    attribution: id,
    players: [
      { name: "Market Favorite", team: "AAA", pos: "WR", rank: favoriteRank, adp: id === "ffc" || id === "mfl" ? favoriteRank : undefined },
      { name: "Hidden Value", team: "BBB", pos: "WR", rank: hiddenRank, adp: id === "ffc" || id === "mfl" ? hiddenRank : undefined },
    ],
  });
  const merged = mergeConsensus(market, [
    ranked("ffc", 2, 1),
    ranked("mfl", 2, 1),
    ranked("tradyr", 1, 2),
    ranked("gng", 1, 2),
  ]);
  const hidden = merged.find((player) => player.id === 12);

  assert.equal(hidden.sourceCount, 5);
  assert.equal(hidden.marketSourceCount, 3);
  assert.equal(hidden.modelSourceCount, 2);
  assert.equal(hidden.modelSpread, 0);
  assert.ok(hidden.modelScore > hidden.marketScore);
  assert.ok(hidden.modelMarketEdge > 90);
  assert.deepEqual(merged, mergeConsensus(market, [
    ranked("ffc", 2, 1),
    ranked("mfl", 2, 1),
    ranked("tradyr", 1, 2),
    ranked("gng", 1, 2),
  ]));
});
