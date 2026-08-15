import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import test from "node:test";
import { buildDraftDecision, buildPlayerPoolIndex } from "../app/lib/draft-engine.ts";
import { mergeConsensus } from "../app/lib/consensus.ts";

const positions = ["QB", "RB", "WR", "TE", "K", "DST"];
const players = Array.from({ length: 500 }, (_, index) => ({
  id: index + 1,
  name: `Player ${index + 1}`,
  team: `NFL${index % 32}`,
  pos: positions[index % positions.length],
  rank: index + 1,
  adp: index + 1,
  auction: Math.max(1, 60 - index / 10),
  projected: Math.max(1, 400 - index / 2),
}));
const league = {
  id: "performance", name: "Performance", season: 2026, size: 12, teamId: 1, draftType: "AUCTION",
  secondsPerPick: 30, rosterSize: 16, auctionBudget: 200,
  lineupSlotCounts: { "0": 1, "2": 2, "4": 2, "6": 1, "23": 1, "16": 1, "17": 1, "20": 7 },
  positionLimits: {}, scoringLabel: "PPR", scoringRules: 19, keeperCount: 0, pickOrder: [],
  teams: Array.from({ length: 12 }, (_, index) => ({ id: index + 1, name: `Team ${index + 1}`, abbrev: `T${index + 1}` })),
};
const picks = players.slice(0, 96).map((player, index) => ({
  playerId: player.id,
  teamId: index % 12 + 1,
  overall: index + 1,
  round: 0,
  amount: 10,
}));
const sources = ["ffc", "mfl", "tradyr", "gng"].map((id, sourceIndex) => ({
  id,
  name: id,
  kind: "market",
  weight: id === "ffc" || id === "mfl" ? .15 : .2,
  status: "ok",
  updatedAt: new Date().toISOString(),
  attribution: id,
  players: players.map((player, index) => ({
    name: player.name,
    team: player.team,
    pos: player.pos,
    rank: index + sourceIndex + 1,
    adp: index + sourceIndex + 1,
    auction: player.auction,
  })),
}));

function percentile95(task, runs = 40) {
  for (let index = 0; index < 5; index += 1) task();
  const samples = [];
  for (let index = 0; index < runs; index += 1) {
    const startedAt = performance.now();
    task();
    samples.push(performance.now() - startedAt);
  }
  samples.sort((left, right) => left - right);
  return samples[Math.floor(samples.length * .95)];
}

test("indexed 500-player decisions stay inside a ten-millisecond p95 budget", (t) => {
  const playerPool = buildPlayerPoolIndex(players, league);
  const p95 = percentile95(() => buildDraftDecision(players, picks, league, "BALANCED", 97, [], playerPool));
  t.diagnostic(`500-player indexed decision p95: ${p95.toFixed(2)}ms`);
  assert.ok(p95 < 10, `decision p95 regressed to ${p95.toFixed(2)}ms`);
});

test("five-source 500-player consensus stays inside a fifteen-millisecond p95 budget", (t) => {
  const p95 = percentile95(() => mergeConsensus(players, sources, league));
  t.diagnostic(`500-player five-source consensus p95: ${p95.toFixed(2)}ms`);
  assert.ok(p95 < 15, `consensus p95 regressed to ${p95.toFixed(2)}ms`);
});
