const MATRIX_METRICS = [
  "startingLineupProjection",
  "totalProjection",
  "vorp",
  "seasonWinProbability",
  "decisionRegret",
  "rosterFragility",
  "objective",
];
const LOWER_IS_BETTER = new Set(["decisionRegret", "rosterFragility"]);

function mean(values) {
  return values.length ? values.reduce((sum, value) => sum + Number(value || 0), 0) / values.length : 0;
}

export function aggregateSeedSummaries(seedSummaries) {
  const violations = {};
  const failures = [];
  for (const summary of seedSummaries) {
    for (const [key, value] of Object.entries(summary.aggregate.violations || {})) {
      violations[key] = Number(violations[key] || 0) + Number(value || 0);
    }
    failures.push(...summary.failureSeeds);
  }
  const metrics = Object.fromEntries(MATRIX_METRICS.map((key) => {
    const summaries = seedSummaries.map((summary) => summary.aggregate.metrics[key]);
    const means = summaries.map((metric) => metric.mean);
    const p25s = summaries.map((metric) => metric.p25);
    const lowerIsBetter = LOWER_IS_BETTER.has(key);
    return [key, {
      meanOfMeans: mean(means),
      direction: lowerIsBetter ? "lower-is-better" : "higher-is-better",
      worstSeedMean: lowerIsBetter ? Math.max(...means) : Math.min(...means),
      bestSeedMean: lowerIsBetter ? Math.min(...means) : Math.max(...means),
      worstSeedP25: lowerIsBetter ? Math.max(...p25s) : Math.min(...p25s),
      bestSeedP25: lowerIsBetter ? Math.min(...p25s) : Math.max(...p25s),
    }];
  }));
  return {
    completedDrafts: seedSummaries.reduce((sum, summary) => sum + summary.completedDrafts, 0),
    failures,
    violations,
    metrics,
    safetyPassed: failures.length === 0 && Object.values(violations).every((value) => Number(value) === 0),
  };
}

export function renderSeedMatrixReport(matrix) {
  const rows = Object.entries(matrix.aggregate.metrics).map(([key, metric]) =>
    `| ${key} | ${metric.meanOfMeans.toFixed(4)} | ${metric.worstSeedMean.toFixed(4)} | ${metric.worstSeedP25.toFixed(4)} |`);
  return [
    "# DraftForge independent seed matrix",
    "",
    `Source snapshot: ${matrix.sourceSnapshotDigest ? `\`${matrix.sourceSnapshotDigest}\`` : "synthetic fallback"}`,
    "",
    `Seeds: ${matrix.seeds.map((seed) => `\`${seed}\``).join(", ")} · ${matrix.draftsPerFormat.toLocaleString()} drafts per format per seed · ${matrix.aggregate.completedDrafts.toLocaleString()} completed drafts`,
    "",
    `Safety gates: **${matrix.aggregate.safetyPassed ? "PASS" : "FAIL"}** · failures ${matrix.aggregate.failures.length} · hard violations ${Object.values(matrix.aggregate.violations).reduce((sum, value) => sum + Number(value || 0), 0)}`,
    "",
    "| Metric | Mean of seed means | Worst seed mean | Worst seed P25 |",
    "| --- | ---: | ---: | ---: |",
    ...rows,
    "",
    "## Per-seed replay",
    "",
    ...matrix.runs.map((run) => `- \`${run.seed}\`: ${run.completedDrafts} drafts, digest \`${run.determinismDigest}\`, failures ${run.failures}, violations ${run.violationTotal}`),
    "",
    "The matrix runs seed families sequentially to keep CPU and memory bounded. It reports cross-seed stability; it does not prove global optimality.",
    "",
  ].join("\n");
}
