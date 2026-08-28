const MATRIX_METRICS = [
  "startingLineupProjection",
  "totalProjection",
  "vorp",
  "seasonWinProbability",
  "seasonStrengthPercentile",
  "tailStrengthMargin",
  "decisionRegret",
  "missedBidOpportunityRegret",
  "rosterFragility",
  "objective",
];
const LOWER_IS_BETTER = new Set(["decisionRegret", "missedBidOpportunityRegret", "rosterFragility"]);

function mean(values) {
  return values.length ? values.reduce((sum, value) => sum + Number(value || 0), 0) / values.length : 0;
}

function aggregateEntries(entries) {
  const violations = {};
  const failures = [];
  for (const entry of entries) {
    for (const [key, value] of Object.entries(entry.aggregate.violations || {})) {
      violations[key] = Number(violations[key] || 0) + Number(value || 0);
    }
    failures.push(...(entry.failureSeeds || []));
  }
  const metrics = Object.fromEntries(MATRIX_METRICS.map((key) => {
    const summaries = entries.map((entry) => entry.aggregate.metrics?.[key]).filter(Boolean);
    const means = summaries.map((metric) => metric.mean);
    const p25s = summaries.map((metric) => metric.p25);
    const lowerIsBetter = LOWER_IS_BETTER.has(key);
    return [key, {
      meanOfMeans: mean(means),
      direction: lowerIsBetter ? "lower-is-better" : "higher-is-better",
      worstSeedMean: means.length ? (lowerIsBetter ? Math.max(...means) : Math.min(...means)) : 0,
      bestSeedMean: means.length ? (lowerIsBetter ? Math.min(...means) : Math.max(...means)) : 0,
      worstSeedP25: p25s.length ? (lowerIsBetter ? Math.max(...p25s) : Math.min(...p25s)) : 0,
      bestSeedP25: p25s.length ? (lowerIsBetter ? Math.min(...p25s) : Math.max(...p25s)) : 0,
    }];
  }));
  const completedDrafts = entries.reduce((sum, entry) => sum + Number(entry.completedDrafts || 0), 0);
  const requestedDrafts = entries.reduce((sum, entry) => sum + Number(entry.requestedDrafts ?? entry.completedDrafts ?? 0), 0);
  const complete = entries.every((entry) => entry.complete !== false)
    && completedDrafts === requestedDrafts
    && failures.length === 0;
  return {
    completedDrafts,
    requestedDrafts,
    complete,
    failures,
    violations,
    metrics,
    safetyPassed: complete
      && Object.values(violations).every((value) => Number(value) === 0),
  };
}

export function aggregateSeedSummaries(seedSummaries) {
  const overall = aggregateEntries(seedSummaries.map((summary) => ({
    aggregate: summary.aggregate,
    completedDrafts: summary.completedDrafts,
    requestedDrafts: summary.requestedDrafts ?? summary.completedDrafts,
    complete: summary.complete,
    failureSeeds: summary.failureSeeds,
  })));
  const formats = [...new Set(seedSummaries.flatMap((summary) => [
    ...(summary.config?.formats || []),
    ...Object.keys(summary.byFormat || {}),
  ]))].sort();
  overall.byFormat = Object.fromEntries(formats.map((format) => {
    const entries = seedSummaries.flatMap((summary) => {
      const value = summary.byFormat?.[format];
      if (!value) return [];
      return [{
        aggregate: value,
        completedDrafts: value.completedDrafts,
        requestedDrafts: value.requestedDrafts,
        complete: value.complete,
        failureSeeds: value.failureSeeds,
      }];
    });
    const formatAggregate = aggregateEntries(entries);
    formatAggregate.missingSeedSummaries = seedSummaries.length - entries.length;
    if (formatAggregate.missingSeedSummaries > 0) {
      formatAggregate.complete = false;
      formatAggregate.safetyPassed = false;
    }
    return [format, formatAggregate];
  }));
  overall.safetyPassed = overall.safetyPassed
    && Object.values(overall.byFormat).every((value) => value.safetyPassed);
  return overall;
}

export function renderSeedMatrixReport(matrix) {
  const rows = Object.entries(matrix.aggregate.metrics).map(([key, metric]) =>
    `| ${key} | ${metric.meanOfMeans.toFixed(4)} | ${metric.worstSeedMean.toFixed(4)} | ${metric.worstSeedP25.toFixed(4)} |`);
  return [
    "# DraftForge independent seed matrix",
    "",
    `Evidence class: **${matrix.certification?.status || (matrix.sourceSnapshotDigest ? "CAPTURED_SOURCE_SNAPSHOT_V3_NON_CURRENT" : "SYNTHETIC_NON_CERTIFYING")}**${matrix.certification?.currentSource
      ? ""
      : matrix.sourceSnapshotDigest
        ? " — exact historical replay cannot certify current player/source strategy"
        : " — synthetic mechanics evidence cannot certify current player/source strategy"}.`,
    "",
    `Source snapshot: ${matrix.sourceSnapshotDigest ? `\`${matrix.sourceSnapshotDigest}\`` : "synthetic fallback"}`,
    "",
    ...(matrix.evidence?.productionCodeDigest ? [
      `Production code identity: \`${matrix.evidence.productionCodeDigest}\` · ${matrix.evidence.productionCodeIdentityConsistent ? "consistent across every seed" : "INCONSISTENT"}.`,
      "",
    ] : []),
    `Seeds: ${matrix.seeds.map((seed) => `\`${seed}\``).join(", ")} · ${matrix.draftsPerFormat.toLocaleString()} drafts per format per seed · ${matrix.aggregate.completedDrafts.toLocaleString()} completed drafts`,
    "",
    `Safety gates: **${matrix.aggregate.safetyPassed ? "PASS" : "FAIL"}** · failures ${matrix.aggregate.failures.length} · hard violations ${Object.values(matrix.aggregate.violations).reduce((sum, value) => sum + Number(value || 0), 0)}`,
    "",
    "| Metric | Mean of seed means | Worst seed mean | Worst seed P25 |",
    "| --- | ---: | ---: | ---: |",
    ...rows,
    "",
    "## Per-format gates",
    "",
    ...Object.entries(matrix.aggregate.byFormat || {}).flatMap(([format, value]) => {
      const violationTotal = Object.values(value.violations).reduce((sum, count) => sum + Number(count || 0), 0);
      const metricRows = Object.entries(value.metrics).map(([key, metric]) =>
        `| ${key} | ${metric.meanOfMeans.toFixed(4)} | ${metric.worstSeedMean.toFixed(4)} | ${metric.worstSeedP25.toFixed(4)} |`);
      return [
        `### ${format}`,
        "",
        `Gate: **${value.safetyPassed ? "PASS" : "FAIL"}** · completed ${value.completedDrafts}/${value.requestedDrafts} · failures ${value.failures.length} · hard violations ${violationTotal}`,
        "",
        "| Metric | Mean of seed means | Worst seed mean | Worst seed P25 |",
        "| --- | ---: | ---: | ---: |",
        ...metricRows,
        "",
      ];
    }),
    "## Per-seed replay",
    "",
    ...matrix.runs.map((run) => `- \`${run.seed}\`: ${run.completedDrafts} drafts, digest \`${run.determinismDigest}\`, failures ${run.failures}, violations ${run.violationTotal}`),
    "",
    "The matrix runs seed families sequentially to keep CPU and memory bounded. It reports cross-seed stability; it does not prove global optimality.",
    "",
  ].join("\n");
}
