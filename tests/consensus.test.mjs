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
});
