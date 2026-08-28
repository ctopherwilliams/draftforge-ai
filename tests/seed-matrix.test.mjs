import assert from "node:assert/strict";
import test from "node:test";
import { aggregateSeedSummaries, renderSeedMatrixReport } from "../simulation/seed-matrix.mjs";

function summary(seed, mean, p25, violations = {}, failures = []) {
  const metric = { mean, p25 };
  const aggregate = {
    violations,
    metrics: Object.fromEntries(["startingLineupProjection", "totalProjection", "vorp", "seasonWinProbability", "decisionRegret", "missedBidOpportunityRegret", "rosterFragility", "objective"].map((key) => [key, metric])),
  };
  return {
    config: { seed, formats: ["snake", "salary-cap"] },
    completedDrafts: 40,
    requestedDrafts: 40,
    complete: failures.length === 0,
    determinismDigest: `digest-${seed}`,
    aggregate,
    byFormat: {
      snake: { ...aggregate, completedDrafts: 20, requestedDrafts: 20, complete: true, failureSeeds: [] },
      "salary-cap": { ...aggregate, completedDrafts: 20, requestedDrafts: 20, complete: failures.length === 0, failureSeeds: failures },
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
  assert.equal(failing.byFormat.snake.safetyPassed, false);
  assert.equal(failing.byFormat["salary-cap"].safetyPassed, false);
});

test("per-format matrix gates prevent a strong snake result from hiding a salary-cap regression", () => {
  const candidate = summary(9, 50, 40);
  candidate.aggregate.violations = { reserve: 1 };
  candidate.byFormat.snake = {
    ...candidate.byFormat.snake,
    violations: {},
    metrics: Object.fromEntries(Object.keys(candidate.aggregate.metrics).map((key) => [key, { mean: 100, p25: 90 }])),
  };
  candidate.byFormat["salary-cap"] = {
    ...candidate.byFormat["salary-cap"],
    violations: { reserve: 1 },
    metrics: Object.fromEntries(Object.keys(candidate.aggregate.metrics).map((key) => [key, { mean: 1, p25: 0 }])),
  };
  const aggregate = aggregateSeedSummaries([candidate]);
  assert.equal(aggregate.safetyPassed, false);
  assert.equal(aggregate.byFormat.snake.safetyPassed, true);
  assert.equal(aggregate.byFormat["salary-cap"].safetyPassed, false);
  assert.equal(aggregate.byFormat.snake.metrics.objective.meanOfMeans, 100);
  assert.equal(aggregate.byFormat["salary-cap"].metrics.objective.meanOfMeans, 1);

  const missingFormat = summary(10, 20, 10);
  delete missingFormat.byFormat["salary-cap"];
  const missingAggregate = aggregateSeedSummaries([missingFormat]);
  assert.equal(missingAggregate.safetyPassed, false);
  assert.equal(missingAggregate.byFormat["salary-cap"].missingSeedSummaries, 1);
});

test("seed matrix report is explicit about safety and non-optimality", () => {
  const summaries = [summary(1, 10, 8), summary(2, 14, 7)];
  const matrix = {
    sourceSnapshotDigest: "abc",
    seeds: [1, 2],
    draftsPerFormat: 20,
    certification: { status: "SYNTHETIC_NON_CERTIFYING", currentSource: false },
    aggregate: aggregateSeedSummaries(summaries),
    runs: summaries.map((item) => ({ seed: item.config.seed, completedDrafts: 40, determinismDigest: item.determinismDigest, failures: 0, violationTotal: 0 })),
  };
  const report = renderSeedMatrixReport(matrix);
  assert.match(report, /Safety gates: \*\*PASS\*\*/);
  assert.match(report, /SYNTHETIC_NON_CERTIFYING/);
  assert.match(report, /## Per-format gates/);
  assert.match(report, /does not prove global optimality/);
});
