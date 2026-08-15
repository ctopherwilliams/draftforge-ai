#!/usr/bin/env node

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { runMonteCarlo } from "../simulation/monte-carlo.mjs";
import { aggregateSeedSummaries, renderSeedMatrixReport } from "../simulation/seed-matrix.mjs";
import { replayConsensusSnapshot, sourceSnapshotDigest, validateSourceSnapshot } from "../simulation/source-snapshot.mjs";

function parseArguments(argv) {
  const options = {
    drafts: 1_000,
    seeds: [20260814, 18472631, 73190422, 41586703, 96724011],
    formats: ["snake", "salary-cap"],
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const value = argv[index + 1];
    if (argument === "--drafts") options.drafts = Number(value);
    else if (argument === "--seeds") options.seeds = value.split(",").map(Number);
    else if (argument === "--formats") options.formats = value.split(",").map((item) => item.trim());
    else if (argument === "--snapshot") options.snapshot = value;
    else if (argument === "--output") options.output = value;
    else throw new Error(`unknown argument: ${argument}`);
    index += 1;
  }
  if (!Number.isInteger(options.drafts) || options.drafts < 1) throw new Error("--drafts must be a positive integer");
  if (!options.seeds.length || options.seeds.some((seed) => !Number.isInteger(seed) || seed < 0)) throw new Error("--seeds must be comma-separated non-negative integers");
  if (new Set(options.seeds).size !== options.seeds.length) throw new Error("--seeds must be unique");
  if (!options.formats.length || options.formats.some((format) => !["snake", "salary-cap"].includes(format))) throw new Error("--formats must contain snake and/or salary-cap");
  return options;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  let sourceSnapshot = null;
  if (options.snapshot) {
    sourceSnapshot = JSON.parse(readFileSync(resolve(options.snapshot), "utf8"));
    if (sourceSnapshot.digest !== sourceSnapshotDigest(sourceSnapshot)) throw new Error("source snapshot digest mismatch");
    const validation = validateSourceSnapshot(sourceSnapshot);
    if (!validation.valid) throw new Error(`source snapshot invalid: ${validation.errors.join(" ")}`);
    replayConsensusSnapshot(sourceSnapshot);
  }

  const summaries = [];
  for (const seed of options.seeds) {
    process.stdout.write(`Seed ${seed}: starting ${options.drafts.toLocaleString()} drafts per format\n`);
    const summary = await runMonteCarlo({
      drafts: options.drafts,
      seed,
      formats: options.formats,
      phases: ["discovery", "validation", "holdout"],
      exposeHoldout: true,
      skipCounterfactuals: true,
      sourceSnapshot,
      progressEvery: Math.max(250, Math.floor(options.drafts / 4)),
    }, {
      onProgress({ completed, total }) {
        process.stdout.write(`Seed ${seed}: ${completed.toLocaleString()}/${total.toLocaleString()}\n`);
      },
    });
    summaries.push(summary);
  }

  const runs = summaries.map((summary) => ({
    seed: summary.config.seed,
    completedDrafts: summary.completedDrafts,
    determinismDigest: summary.determinismDigest,
    failures: summary.failureSeeds.length,
    violationTotal: Object.values(summary.aggregate.violations).reduce((sum, value) => sum + Number(value || 0), 0),
    metrics: summary.aggregate.metrics,
  }));
  const matrix = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    draftsPerFormat: options.drafts,
    formats: options.formats,
    seeds: options.seeds,
    sourceSnapshotDigest: sourceSnapshot?.digest || null,
    aggregate: aggregateSeedSummaries(summaries),
    runs,
  };
  const output = resolve(options.output || `outputs/monte-carlo/matrix-${options.seeds.length}x${options.drafts}-${sourceSnapshot?.digest?.slice(0, 12) || "synthetic"}`);
  mkdirSync(dirname(`${output}/summary.json`), { recursive: true });
  writeFileSync(`${output}/summary.json`, `${JSON.stringify(matrix, null, 2)}\n`);
  writeFileSync(`${output}/report.md`, renderSeedMatrixReport(matrix));
  process.stdout.write(`Summary: ${output}/summary.json\nReport: ${output}/report.md\n`);
  if (!matrix.aggregate.safetyPassed) process.exitCode = 1;
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack || error.message : String(error)}\n`);
  process.exitCode = 1;
});
