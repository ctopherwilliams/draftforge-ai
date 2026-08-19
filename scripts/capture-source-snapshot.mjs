#!/usr/bin/env node

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fetchIntelligenceSnapshot, normalizeIntelligenceRequest } from "../app/lib/intelligence-sources.ts";
import {
  createSourceSnapshot,
  replayConsensusSnapshot,
  sourceSnapshotDigest,
  validateSourceSnapshot,
} from "../simulation/source-snapshot.mjs";

function parseArguments(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const value = argv[index + 1];
    if (["--espn", "--validate", "--output", "--scoring", "--teams", "--season"].includes(argument)) {
      if (!value) throw new Error(`${argument} requires a value`);
      options[argument.slice(2)] = value;
      index += 1;
    } else {
      throw new Error(`unknown argument: ${argument}`);
    }
  }
  if (Boolean(options.espn) === Boolean(options.validate)) {
    throw new Error("provide exactly one of --espn <sanitized-profile.json> or --validate <snapshot.json>");
  }
  return options;
}

function printValidation(snapshot, validation) {
  const report = {
    valid: validation.valid,
    digest: sourceSnapshotDigest(snapshot),
    capturedAt: snapshot.capturedAt,
    league: {
      id: snapshot.league.id,
      format: snapshot.league.draftType,
      teams: snapshot.league.size,
      rosterSize: snapshot.league.rosterSize,
      scoring: snapshot.league.scoringLabel,
    },
    espnPlayers: validation.espnPlayers,
    sourceReach: validation.sourceReach,
    coverageAtLeastFour: validation.coverageAtLeastFour,
    fullFiveSourceCoverage: validation.fullFiveSourceCoverage,
    coverageBreakdown: validation.coverageBreakdown,
    completeMarketModelCoverageCount: validation.completeMarketModelCoverageCount,
    corroboratedSleeperCandidateCount: validation.corroboratedSleeperCandidateCount,
    sleeperEvidenceFunnel: validation.sleeperEvidenceFunnel,
    sleeperSignalCounts: validation.sleeperSignalCounts,
    sleeperCandidates: validation.sleeperCandidates,
    sources: validation.sourceSummaries,
    warnings: validation.warnings,
    errors: validation.errors,
  };
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.validate) {
    const snapshot = JSON.parse(readFileSync(resolve(options.validate), "utf8"));
    if (snapshot.digest !== sourceSnapshotDigest(snapshot)) throw new Error("source snapshot digest mismatch");
    const validation = validateSourceSnapshot(snapshot);
    printValidation(snapshot, validation);
    if (!validation.valid) process.exitCode = 1;
    else replayConsensusSnapshot(snapshot);
    return;
  }

  const profile = JSON.parse(readFileSync(resolve(options.espn), "utf8"));
  const league = profile.league;
  const espnPlayers = profile.espnPlayers || profile.players;
  if (!league || !Array.isArray(espnPlayers)) {
    throw new Error("--espn must contain a sanitized { league, espnPlayers } profile");
  }
  const request = normalizeIntelligenceRequest({
    scoring: options.scoring || league.scoringLabel,
    teams: Number(options.teams || league.size),
    season: Number(options.season || league.season),
  });
  const intelligence = await fetchIntelligenceSnapshot(request);
  const snapshot = createSourceSnapshot({ league, espnPlayers, intelligence });
  printValidation(snapshot, snapshot.validation);
  if (!snapshot.validation.valid) throw new Error("source snapshot capture failed closed");

  const timestamp = snapshot.capturedAt.replaceAll(":", "-").replace(".000Z", "Z");
  const scoring = request.scoring.toLowerCase().replaceAll(" ", "-");
  const output = resolve(options.output || `snapshots/intelligence/source-v1-${timestamp}-${scoring}-${request.teams}t-${snapshot.digest.slice(0, 12)}.json`);
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, `${JSON.stringify(snapshot, null, 2)}\n`);
  process.stdout.write(`Snapshot: ${output}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack || error.message : String(error)}\n`);
  process.exitCode = 1;
});
