#!/usr/bin/env node

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { assertCurrentSourceMonteCarloRun, runMonteCarlo } from "../simulation/monte-carlo.mjs";
import { aggregateSeedSummaries, renderSeedMatrixReport } from "../simulation/seed-matrix.mjs";
import {
  evaluateCurrentSourceSnapshot,
  replayConsensusSnapshot,
  sourceSnapshotDigest,
  sourceSnapshotFormat,
  validateSourceSnapshot,
} from "../simulation/source-snapshot.mjs";

const VALUE_ARGUMENTS = new Set(["--drafts", "--seeds", "--formats", "--snapshot", "--output"]);

function parseArguments(argv) {
  const options = {
    drafts: 1_000,
    seeds: [20260814, 18472631, 73190422, 41586703, 96724011],
    formats: ["snake", "salary-cap"],
    formatsExplicit: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--require-current-source") {
      options.requireCurrentSource = true;
      continue;
    }
    const value = argv[index + 1];
    if (VALUE_ARGUMENTS.has(argument) && (value === undefined || value.startsWith("--"))) {
      throw new Error(`${argument} requires a value`);
    }
    if (argument === "--drafts") options.drafts = Number(value);
    else if (argument === "--seeds") options.seeds = value.split(",").map(Number);
    else if (argument === "--formats") {
      options.formats = value.split(",").map((item) => item.trim());
      options.formatsExplicit = true;
    }
    else if (argument === "--snapshot") options.snapshot = value;
    else if (argument === "--output") options.output = value;
    else throw new Error(`unknown argument: ${argument}`);
    index += 1;
  }
  if (!Number.isInteger(options.drafts) || options.drafts < 1) throw new Error("--drafts must be a positive integer");
  if (!options.seeds.length || options.seeds.some((seed) => !Number.isInteger(seed) || seed < 0)) throw new Error("--seeds must be comma-separated non-negative integers");
  if (new Set(options.seeds).size !== options.seeds.length) throw new Error("--seeds must be unique");
  if (!options.formats.length || options.formats.some((format) => !["snake", "salary-cap"].includes(format))) throw new Error("--formats must contain snake and/or salary-cap");
  if (new Set(options.formats).size !== options.formats.length) throw new Error("--formats must be unique");
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
    const capturedFormat = sourceSnapshotFormat(sourceSnapshot);
    if (!options.formatsExplicit) options.formats = [capturedFormat];
    if (options.formats.length !== 1 || options.formats[0] !== capturedFormat) {
      throw new Error(`--snapshot requires exactly --formats ${capturedFormat}`);
    }
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
    if (!summary.complete || summary.completedDrafts !== summary.requestedDrafts) {
      throw new Error(`MONTE_CARLO_MATRIX_INCOMPLETE:${summary.completedDrafts}/${summary.requestedDrafts}`);
    }
    if (options.requireCurrentSource) assertCurrentSourceMonteCarloRun(summary, sourceSnapshot);
    summaries.push(summary);
  }

  const runs = summaries.map((summary) => ({
    seed: summary.config.seed,
    completedDrafts: summary.completedDrafts,
    determinismDigest: summary.determinismDigest,
    failures: summary.failureSeeds.length,
    violationTotal: Object.values(summary.aggregate.violations).reduce((sum, value) => sum + Number(value || 0), 0),
    metrics: summary.aggregate.metrics,
    certification: summary.certification,
    productionCodeDigest: summary.evidence.identity.productionCodeDigest,
    evidenceIdentityDigest: summary.evidence.identity.digest,
    orderedTrialOutcomeDigest: summary.evidence.orderedTrialOutcomeDigest,
    byFormat: Object.fromEntries(Object.entries(summary.byFormat).map(([format, value]) => [format, {
      completedDrafts: value.completedDrafts,
      requestedDrafts: value.requestedDrafts,
      failures: value.failureSeeds.length,
      violations: value.violations,
      safetyPassed: value.safetyPassed,
      metrics: value.metrics,
    }])),
  }));
  const aggregate = aggregateSeedSummaries(summaries);
  const capturedSource = Boolean(sourceSnapshot);
  const matrixRuntimeFreshness = capturedSource ? evaluateCurrentSourceSnapshot(sourceSnapshot) : null;
  const currentSource = summaries.every((summary) => summary.certification.currentSource === true)
    && matrixRuntimeFreshness?.current === true;
  const productionCodeDigests = [...new Set(summaries.map((summary) => summary.evidence.identity.productionCodeDigest))];
  if (productionCodeDigests.length !== 1) {
    throw new Error("MONTE_CARLO_MATRIX_CODE_IDENTITY_CHANGED: every seed must execute the same production code identity");
  }
  const matrix = {
    schemaVersion: 3,
    generatedAt: new Date().toISOString(),
    draftsPerFormat: options.drafts,
    formats: options.formats,
    seeds: options.seeds,
    sourceSnapshotDigest: sourceSnapshot?.digest || null,
    certification: {
      evidenceClass: currentSource
        ? "current-source-snapshot-v3"
        : capturedSource ? "captured-source-snapshot-v3" : "synthetic-mechanics-only",
      currentSource,
      currentSourceCertificationEligible: currentSource,
      status: currentSource
        ? "CURRENT_SOURCE_SNAPSHOT_V3"
        : capturedSource ? "CAPTURED_SOURCE_SNAPSHOT_V3_NON_CURRENT" : "SYNTHETIC_NON_CERTIFYING",
      blockers: currentSource
        ? []
        : capturedSource
          ? [...new Set([
              ...summaries.flatMap((summary) => summary.certification.blockers || []),
              ...(matrixRuntimeFreshness?.blocker ? [matrixRuntimeFreshness.blocker] : []),
            ])]
          : ["CURRENT_SOURCE_FORMAT_EXACT_V3_SNAPSHOT_REQUIRED"],
      runtimeFreshness: matrixRuntimeFreshness,
    },
    evidence: {
      schemaVersion: 2,
      productionCodeDigest: productionCodeDigests.length === 1 ? productionCodeDigests[0] : null,
      productionCodeIdentityConsistent: productionCodeDigests.length === 1,
      orderedRunOutcomeDigests: runs.map((run) => ({
        seed: run.seed,
        digest: run.orderedTrialOutcomeDigest,
      })),
    },
    aggregate,
    runs,
  };
  const output = resolve(options.output || `outputs/monte-carlo/matrix-${options.seeds.length}x${options.drafts}-${sourceSnapshot?.digest?.slice(0, 12) || "synthetic"}`);
  mkdirSync(dirname(`${output}/summary.json`), { recursive: true });
  writeFileSync(`${output}/summary.json`, `${JSON.stringify(matrix, null, 2)}\n`);
  writeFileSync(`${output}/report.md`, renderSeedMatrixReport(matrix));
  process.stdout.write(`Summary: ${output}/summary.json\nReport: ${output}/report.md\n`);
  if (!matrix.certification.currentSource) {
    process.stderr.write(`NON_CURRENT_SOURCE_EVIDENCE:${matrix.certification.status}:${matrix.certification.blockers.join(",")}\n`);
  }
  if (options.requireCurrentSource && !matrix.certification.currentSource) {
    throw new Error("MONTE_CARLO_CURRENT_SOURCE_REQUIRED: source snapshot expired before the matrix completed");
  }
  if (!matrix.aggregate.safetyPassed) process.exitCode = 1;
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack || error.message : String(error)}\n`);
  process.exitCode = 1;
});
