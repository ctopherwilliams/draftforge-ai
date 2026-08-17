#!/usr/bin/env node

import { createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { once } from "node:events";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { renderMarkdownReport, runCounterfactuals, runMonteCarlo, simulateDraft } from "../simulation/monte-carlo.mjs";
import { replayConsensusSnapshot, sourceSnapshotDigest, validateSourceSnapshot } from "../simulation/source-snapshot.mjs";

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
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const value = argv[index + 1];
    if (argument === "--drafts") {
      config.drafts = Number(value);
      index += 1;
    } else if (argument === "--seed") {
      config.seed = Number(value);
      index += 1;
    } else if (argument === "--formats") {
      config.formats = value.split(",").map((item) => item.trim());
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
    else throw new Error(`unknown argument: ${argument}`);
  }
  if (!Number.isInteger(config.drafts) || config.drafts < 1) throw new Error("--drafts must be a positive integer");
  if (!Number.isInteger(config.seed) || config.seed < 0) throw new Error("--seed must be a non-negative integer");
  if (!config.formats.length || config.formats.some((format) => !["snake", "salary-cap"].includes(format))) {
    throw new Error("--formats must contain snake and/or salary-cap");
  }
  if (!config.phases.length || config.phases.some((phase) => !["discovery", "validation", "holdout"].includes(phase))) {
    throw new Error("--phases must contain discovery, validation, and/or holdout");
  }
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
  const add = (record) => records.set(`${record.format}:${record.trialIndex}`, record);
  await readJsonLines(join(directory, "trial-metrics.jsonl"), add);
  await readJsonLines(join(directory, "sealed-holdout.jsonl"), add);
  return records;
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
    decisionRegret: "Decision regret",
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
  mkdirSync(output, { recursive: true });
  const publicStream = createWriteStream(join(output, "trial-metrics.jsonl"), { encoding: "utf8" });
  const sealedStream = createWriteStream(join(output, "sealed-holdout.jsonl"), { encoding: "utf8" });
  const failureStream = createWriteStream(join(output, "failed-seeds.jsonl"), { encoding: "utf8" });
  const baseline = config.compare ? await loadBaseline(resolve(config.compare)) : null;
  if (baseline) {
    const expectedDigest = config.sourceSnapshot?.digest || null;
    const baselineDigests = new Set([...baseline.values()].map((record) => record.sourceSnapshotDigest || null));
    if (baselineDigests.size !== 1 || !baselineDigests.has(expectedDigest)) {
      throw new Error("paired comparison requires the exact same source snapshot digest");
    }
  }
  const pairedValues = Object.fromEntries([
    "startingLineupProjection",
    "totalProjection",
    "vorp",
    "seasonWinProbability",
    "decisionRegret",
    "rosterFragility",
    "objective",
  ].map((key) => [key, []]));

  const summary = await runMonteCarlo(config, {
    async onTrial(record) {
      const compact = compactTrialRecord(record);
      if (record.split === "holdout" && !config.exposeHoldout) await writeJsonLine(sealedStream, compact);
      else await writeJsonLine(publicStream, compact);
      const baselineRecord = baseline?.get(`${record.format}:${record.trialIndex}`);
      if (baselineRecord) {
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

  let comparison = null;
  if (baseline) {
    comparison = {
      baselineDirectory: resolve(config.compare),
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
    highRegret: summary.topRegretCases.map(({ format, trialIndex, trialSeed, decisionNumber, regret }) => ({ format, trialIndex, trialSeed, decisionNumber, regret })),
  }, null, 2)}\n`);
  process.stdout.write(`Summary: ${summaryPath}\nReport: ${reportPath}\nDigest: ${summary.determinismDigest}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack || error.message : String(error)}\n`);
  process.exitCode = 1;
});
