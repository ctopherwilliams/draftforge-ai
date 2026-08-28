#!/usr/bin/env node

import { createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { once } from "node:events";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import {
  assertCompleteMonteCarloRun,
  assertCurrentSourceMonteCarloRun,
  renderMarkdownReport,
  runCounterfactuals,
  runMonteCarlo,
  simulateDraft,
} from "../simulation/monte-carlo.mjs";
import {
  replayConsensusSnapshot,
  sourceSnapshotDigest,
  sourceSnapshotFormat,
  validateSourceSnapshot,
} from "../simulation/source-snapshot.mjs";

const PAIRED_IDENTITY_FIELDS = [
  "format",
  "trialIndex",
  "trialSeed",
  "split",
  "scenario",
  "leagueSize",
  "rosterSize",
  "sourceSnapshotDigest",
  "productionCodeDigest",
  "evidenceIdentityDigest",
];
const VALUE_ARGUMENTS = new Set([
  "--drafts",
  "--seed",
  "--formats",
  "--phases",
  "--output",
  "--label",
  "--compare",
  "--evidence",
  "--replay",
  "--counterfactual-replay",
  "--snapshot",
  "--counterfactual-cases",
  "--progress-every",
]);

function parseArguments(argv) {
  const config = {
    drafts: 10_000,
    seed: 20260814,
    formats: ["snake", "salary-cap"],
    phases: ["discovery", "validation", "holdout"],
    exposeHoldout: false,
    counterfactualCases: 10,
    progressEvery: 250,
    label: "baseline",
    formatsExplicit: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const value = argv[index + 1];
    if (VALUE_ARGUMENTS.has(argument) && (value === undefined || value.startsWith("--"))) {
      throw new Error(`${argument} requires a value`);
    }
    if (argument === "--drafts") {
      config.drafts = Number(value);
      index += 1;
    } else if (argument === "--seed") {
      config.seed = Number(value);
      index += 1;
    } else if (argument === "--formats") {
      config.formats = value.split(",").map((item) => item.trim());
      config.formatsExplicit = true;
      index += 1;
    } else if (argument === "--phases") {
      config.phases = value.split(",").map((item) => item.trim());
      index += 1;
    } else if (argument === "--output") {
      config.output = value;
      index += 1;
    } else if (argument === "--label") {
      config.label = value;
      index += 1;
    } else if (argument === "--compare") {
      config.compare = value;
      index += 1;
    } else if (argument === "--evidence") {
      config.evidence = value;
      index += 1;
    } else if (argument === "--replay") {
      config.replay = value;
      index += 1;
    } else if (argument === "--counterfactual-replay") {
      config.counterfactualReplay = value;
      index += 1;
    } else if (argument === "--snapshot") {
      config.snapshot = value;
      index += 1;
    } else if (argument === "--counterfactual-cases") {
      config.counterfactualCases = Number(value);
      index += 1;
    } else if (argument === "--progress-every") {
      config.progressEvery = Number(value);
      index += 1;
    }
    else if (argument === "--expose-holdout") config.exposeHoldout = true;
    else if (argument === "--skip-counterfactuals") config.skipCounterfactuals = true;
    else if (argument === "--require-current-source") config.requireCurrentSource = true;
    else throw new Error(`unknown argument: ${argument}`);
  }
  if (!Number.isInteger(config.drafts) || config.drafts < 1) throw new Error("--drafts must be a positive integer");
  if (!Number.isInteger(config.seed) || config.seed < 0) throw new Error("--seed must be a non-negative integer");
  if (!config.formats.length || config.formats.some((format) => !["snake", "salary-cap"].includes(format))) {
    throw new Error("--formats must contain snake and/or salary-cap");
  }
  if (new Set(config.formats).size !== config.formats.length) throw new Error("--formats must be unique");
  if (!config.phases.length || config.phases.some((phase) => !["discovery", "validation", "holdout"].includes(phase))) {
    throw new Error("--phases must contain discovery, validation, and/or holdout");
  }
  if (new Set(config.phases).size !== config.phases.length) throw new Error("--phases must be unique");
  if (!Number.isInteger(config.counterfactualCases) || config.counterfactualCases < 0 || config.counterfactualCases > 100) {
    throw new Error("--counterfactual-cases must be an integer from 0 to 100");
  }
  return config;
}

function compactTrialRecord(record) {
  return {
    format: record.format,
    trialIndex: record.trialIndex,
    trialSeed: record.trialSeed,
    split: record.split,
    scenario: record.scenario,
    leagueSize: record.leagueSize,
    rosterSize: record.rosterSize,
    draftSlot: record.draftSlot,
    strategy: record.strategy,
    metrics: record.metrics,
    violations: record.violations,
    draftDigest: record.draftDigest,
    sourceSnapshotDigest: record.sourceSnapshotDigest,
    productionCodeDigest: record.productionCodeDigest,
    evidenceIdentityDigest: record.evidenceIdentityDigest,
  };
}

async function readJsonLines(path, onRecord) {
  if (!existsSync(path)) return;
  const input = createReadStream(path, { encoding: "utf8" });
  const reader = createInterface({ input, crlfDelay: Number.POSITIVE_INFINITY });
  for await (const line of reader) {
    if (line.trim()) onRecord(JSON.parse(line));
  }
}

async function writeJsonLine(stream, value) {
  if (!stream.write(`${JSON.stringify(value)}\n`)) await once(stream, "drain");
}

async function loadBaseline(directory) {
  const records = new Map();
  const add = (record) => {
    const key = `${record?.format}:${record?.trialIndex}`;
    if (records.has(key)) throw new Error(`PAIRED_BASELINE_DUPLICATE_RECORD:${key}`);
    records.set(key, record);
  };
  await readJsonLines(join(directory, "trial-metrics.jsonl"), add);
  await readJsonLines(join(directory, "sealed-holdout.jsonl"), add);
  return records;
}

function pairedIdentityMismatch(current, baseline) {
  return PAIRED_IDENTITY_FIELDS.find((field) => (current?.[field] ?? null) !== (baseline?.[field] ?? null)) || null;
}

function pairedSummary(values) {
  if (!values.length) return { count: 0, meanDelta: 0, p25Delta: 0, ci95: [0, 0] };
  const sum = values.reduce((total, value) => total + value, 0);
  const mean = sum / values.length;
  const variance = values.length > 1
    ? values.reduce((total, value) => total + (value - mean) ** 2, 0) / (values.length - 1)
    : 0;
  const margin = 1.96 * Math.sqrt(variance / values.length);
  const ordered = [...values].sort((left, right) => left - right);
  return {
    count: values.length,
    meanDelta: mean,
    p25Delta: ordered[Math.round((ordered.length - 1) * .25)],
    ci95: [mean - margin, mean + margin],
  };
}

function comparisonMarkdown(comparison) {
  const labels = {
    startingLineupProjection: "Starting lineup",
    totalProjection: "Total projection",
    vorp: "VORP",
    seasonWinProbability: "Season win probability",
    seasonStrengthPercentile: "Season strength percentile",
    tailStrengthMargin: "Upper-quartile strength margin",
    decisionRegret: "Decision regret",
    missedBidOpportunityRegret: "Missed bid-opportunity regret",
    rosterFragility: "Roster fragility",
    objective: "Composite objective",
  };
  return [
    "| Metric | Mean paired delta | P25 paired delta | 95% CI |",
    "| --- | ---: | ---: | ---: |",
    ...Object.entries(comparison.metrics).map(([key, metric]) => `| ${labels[key] || key} | ${metric.meanDelta.toFixed(4)} | ${metric.p25Delta.toFixed(4)} | ${metric.ci95[0].toFixed(4)}–${metric.ci95[1].toFixed(4)} |`),
  ].join("\n");
}

async function main() {
  const config = parseArguments(process.argv.slice(2));
  if (config.snapshot) {
    config.sourceSnapshot = JSON.parse(readFileSync(resolve(config.snapshot), "utf8"));
    if (config.sourceSnapshot.digest !== sourceSnapshotDigest(config.sourceSnapshot)) throw new Error("source snapshot digest mismatch");
    const validation = validateSourceSnapshot(config.sourceSnapshot);
    if (!validation.valid) throw new Error(`source snapshot invalid: ${validation.errors.join(" ")}`);
    replayConsensusSnapshot(config.sourceSnapshot);
    const capturedFormat = sourceSnapshotFormat(config.sourceSnapshot);
    if (!config.formatsExplicit) config.formats = [capturedFormat];
    if (config.formats.length !== 1 || config.formats[0] !== capturedFormat) {
      throw new Error(`--snapshot requires exactly --formats ${capturedFormat}`);
    }
  }
  if (config.replay) {
    const [format, trialValue] = config.replay.split(":");
    const trialIndex = Number(trialValue);
    if (!["snake", "salary-cap"].includes(format) || !Number.isInteger(trialIndex) || trialIndex < 0 || trialIndex >= config.drafts) {
      throw new Error("--replay must be snake:<trial-index> or salary-cap:<trial-index> within --drafts");
    }
    const replay = simulateDraft({ format, baseSeed: config.seed, trialIndex, drafts: config.drafts, sourceSnapshot: config.sourceSnapshot });
    process.stdout.write(`${JSON.stringify(replay, null, 2)}\n`);
    return;
  }
  if (config.counterfactualReplay) {
    const [format, trialValue] = config.counterfactualReplay.split(":");
    const trialIndex = Number(trialValue);
    if (!["snake", "salary-cap"].includes(format) || !Number.isInteger(trialIndex) || trialIndex < 0 || trialIndex >= config.drafts) {
      throw new Error("--counterfactual-replay must be snake:<trial-index> or salary-cap:<trial-index> within --drafts");
    }
    const replay = simulateDraft({ format, baseSeed: config.seed, trialIndex, drafts: config.drafts, sourceSnapshot: config.sourceSnapshot });
    const result = replay.regretCase ? runCounterfactuals([replay.regretCase], config) : [];
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }

  const output = resolve(config.output || join("outputs", "monte-carlo", `${config.label}-seed-${config.seed}-${config.drafts}`));
  const baselineDirectory = config.compare ? resolve(config.compare) : null;
  if (baselineDirectory === output) throw new Error("--compare and --output must be different directories");
  const baseline = baselineDirectory ? await loadBaseline(baselineDirectory) : null;
  if (baseline) {
    const expectedDigest = config.sourceSnapshot?.digest || null;
    const baselineDigests = new Set([...baseline.values()].map((record) => record.sourceSnapshotDigest || null));
    if (baselineDigests.size !== 1 || !baselineDigests.has(expectedDigest)) {
      throw new Error("paired comparison requires the exact same source snapshot digest");
    }
  }
  mkdirSync(output, { recursive: true });
  const publicStream = createWriteStream(join(output, "trial-metrics.jsonl"), { encoding: "utf8" });
  const sealedStream = createWriteStream(join(output, "sealed-holdout.jsonl"), { encoding: "utf8" });
  const failureStream = createWriteStream(join(output, "failed-seeds.jsonl"), { encoding: "utf8" });
  const pairedValues = Object.fromEntries([
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
  ].map((key) => [key, []]));
  const currentPairKeys = new Set();
  const pairingErrors = [];

  const summary = await runMonteCarlo(config, {
    async onTrial(record) {
      const compact = compactTrialRecord(record);
      if (record.split === "holdout" && !config.exposeHoldout) await writeJsonLine(sealedStream, compact);
      else await writeJsonLine(publicStream, compact);
      const baselineRecord = baseline?.get(`${record.format}:${record.trialIndex}`);
      if (baseline) {
        const key = `${record.format}:${record.trialIndex}`;
        if (currentPairKeys.has(key)) pairingErrors.push(`duplicate-current:${key}`);
        currentPairKeys.add(key);
        if (!baselineRecord) pairingErrors.push(`missing-baseline:${key}`);
        const mismatch = baselineRecord ? pairedIdentityMismatch(compact, baselineRecord) : null;
        if (mismatch) pairingErrors.push(`identity-mismatch:${key}:${mismatch}`);
        const invalidMetric = baselineRecord ? Object.keys(pairedValues).find((metric) => (
          !Number.isFinite(Number(record.metrics?.[metric]))
          || !Number.isFinite(Number(baselineRecord.metrics?.[metric]))
        )) : null;
        if (invalidMetric) pairingErrors.push(`invalid-metric:${key}:${invalidMetric}`);
        if (!baselineRecord || mismatch || invalidMetric) return;
        for (const key of Object.keys(pairedValues)) pairedValues[key].push(Number(record.metrics[key]) - Number(baselineRecord.metrics[key]));
      }
    },
    async onFailure(failure) {
      await writeJsonLine(failureStream, failure);
    },
    onProgress({ completed, total }) {
      process.stdout.write(`Monte Carlo progress: ${completed.toLocaleString()}/${total.toLocaleString()} drafts\n`);
    },
  });
  await Promise.all([publicStream, sealedStream, failureStream].map((stream) => new Promise((resolveStream, reject) => {
    stream.on("error", reject);
    stream.end(resolveStream);
  })));

  if (baseline) {
    for (const key of baseline.keys()) {
      if (!currentPairKeys.has(key)) pairingErrors.push(`extra-baseline:${key}`);
    }
    if (!summary.complete || summary.completedDrafts !== summary.requestedDrafts) {
      pairingErrors.push(`current-incomplete:${summary.completedDrafts}/${summary.requestedDrafts}`);
    }
    if (baseline.size !== summary.requestedDrafts || currentPairKeys.size !== summary.requestedDrafts) {
      pairingErrors.push(`coverage:${baseline.size}/${currentPairKeys.size}/${summary.requestedDrafts}`);
    }
    if (Object.values(pairedValues).some((values) => values.length !== summary.requestedDrafts)) {
      pairingErrors.push("paired-metric-coverage");
    }
    if (pairingErrors.length) {
      throw new Error(`PAIRED_COMPARISON_INVALID:${pairingErrors.slice(0, 10).join(",")}`);
    }
  }

  let comparison = null;
  if (baseline) {
    comparison = {
      baselineDirectory,
      metrics: Object.fromEntries(Object.entries(pairedValues).map(([key, values]) => [key, pairedSummary(values)])),
    };
    summary.pairedComparison = comparison;
  }
  summary.codeChanges = config.evidence
    ? JSON.parse(readFileSync(resolve(config.evidence), "utf8"))
    : [];
  const summaryPath = join(output, "summary.json");
  const reportPath = join(output, "report.md");
  writeFileSync(summaryPath, `${JSON.stringify(summary, null, 2)}\n`);
  writeFileSync(reportPath, renderMarkdownReport(summary, comparison ? comparisonMarkdown(comparison) : null));
  writeFileSync(join(output, "replay-seeds.json"), `${JSON.stringify({
    failed: summary.failureSeeds,
    highRegret: summary.topRegretCases.map(({ format, trialIndex, trialSeed, decisionNumber, regret, counterfactualClass }) => ({
      format, trialIndex, trialSeed, decisionNumber, regret, counterfactualClass,
    })),
    underbids: summary.topUnderbidCases.map(({ format, trialIndex, trialSeed, eventId, decisionNumber, regret, approvedCeiling, evidenceOnlyCeiling, priceToWin }) => ({
      format, trialIndex, trialSeed, eventId, decisionNumber, regret, approvedCeiling, evidenceOnlyCeiling, priceToWin,
    })),
  }, null, 2)}\n`);
  process.stdout.write(`Summary: ${summaryPath}\nReport: ${reportPath}\nDigest: ${summary.determinismDigest}\n`);
  if (!summary.certification.currentSource) {
    process.stderr.write(`NON_CURRENT_SOURCE_EVIDENCE:${summary.certification.status}:${summary.certification.blockers.join(",")}\n`);
  }
  if (config.requireCurrentSource) assertCurrentSourceMonteCarloRun(summary, config.sourceSnapshot);
  else assertCompleteMonteCarloRun(summary);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack || error.message : String(error)}\n`);
  process.exitCode = 1;
});
