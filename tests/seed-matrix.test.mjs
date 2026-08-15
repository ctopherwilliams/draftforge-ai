import assert from "node:assert/strict";
import test from "node:test";
import { aggregateSeedSummaries, renderSeedMatrixReport } from "../simulation/seed-matrix.mjs";

function summary(seed, mean, p25, violations = {}, failures = []) {
  const metric = { mean, p25 };
  return {
    config: { seed },
    completedDrafts: 40,
    determinismDigest: `digest-${seed}`,
    aggregate: {
      violations,
      metrics: Object.fromEntries(["startingLineupProjection", "totalProjection", "vorp", "seasonWinProbability", "decisionRegret", "rosterFragility", "objective"].map((key) => [key, metric])),
    },
    failureSeeds: failures,
  };
}

test("independent seed aggregation surfaces worst-seed tails and hard failures", () => {
  const passing = aggregateSeedSummaries([summary(1, 10, 8), summary(2, 14, 7)]);
  assert.equal(passing.completedDrafts, 80);
  assert.equal(passing.metrics.objective.meanOfMeans, 12);
  assert.equal(passing.metrics.objective.worstSeedMean, 10);
  assert.equal(passing.metrics.objective.worstSeedP25, 7);
  assert.equal(passing.metrics.decisionRegret.worstSeedMean, 14);
  assert.equal(passing.metrics.decisionRegret.worstSeedP25, 8);
  assert.equal(passing.safetyPassed, true);

  const failing = aggregateSeedSummaries([summary(3, 10, 8, { reserve: 1 })]);
  assert.equal(failing.safetyPassed, false);
});

test("seed matrix report is explicit about safety and non-optimality", () => {
  const summaries = [summary(1, 10, 8), summary(2, 14, 7)];
  const matrix = {
    sourceSnapshotDigest: "abc",
    seeds: [1, 2],
    draftsPerFormat: 20,
    aggregate: aggregateSeedSummaries(summaries),
    runs: summaries.map((item) => ({ seed: item.config.seed, completedDrafts: 40, determinismDigest: item.determinismDigest, failures: 0, violationTotal: 0 })),
  };
  const report = renderSeedMatrixReport(matrix);
  assert.match(report, /Safety gates: \*\*PASS\*\*/);
  assert.match(report, /does not prove global optimality/);
});
