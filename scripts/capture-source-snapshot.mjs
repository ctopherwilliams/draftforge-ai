#!/usr/bin/env node

import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  AUTHENTICATED_ESPN_CAPTURE_SCHEMA_VERSION,
  AUTHENTICATED_ESPN_CAPTURE_TRANSPORT,
  authenticatedEspnCaptureDigest,
  buildAuthenticatedEspnCaptureProfile,
  canonicalAuthenticatedEspnCaptureJson,
  isAuthenticatedEspnCaptureProof,
  sanitizeAuthenticatedEspnLeague,
  sanitizeAuthenticatedEspnPlayers,
} from "../app/lib/authenticated-espn-capture.ts";
import { fetchIntelligenceSnapshot, normalizeIntelligenceRequest } from "../app/lib/intelligence-sources.ts";
import { intelligenceQuarterbackMode } from "../app/lib/consensus.ts";
import {
  CURRENT_SOURCE_SNAPSHOT_MAX_AGE_MS,
  SOURCE_SNAPSHOT_SCHEMA_VERSION,
  createSourceSnapshot,
  evaluateCurrentSourceSnapshot,
  replayConsensusSnapshot,
  sourceSnapshotDigest,
  validateSourceSnapshot,
} from "../simulation/source-snapshot.mjs";

export {
  AUTHENTICATED_ESPN_CAPTURE_SCHEMA_VERSION,
  AUTHENTICATED_ESPN_CAPTURE_TRANSPORT,
};
export const AUTHENTICATED_ESPN_CAPTURE_MAX_AGE_MS = CURRENT_SOURCE_SNAPSHOT_MAX_AGE_MS;
const AUTHENTICATED_ESPN_CAPTURE_FUTURE_SKEW_MS = 5_000;

export async function verifyAuthenticatedEspnCapture(profile, request, { now = Date.now() } = {}) {
  const league = profile?.league;
  const espnPlayers = profile?.espnPlayers || profile?.players;
  if (!league || !Array.isArray(espnPlayers)) {
    throw new Error("ESPN_ARTIFACT_SHAPE_INVALID: expected sanitized { league, espnPlayers }");
  }
  const exactLeague = sanitizeAuthenticatedEspnLeague(league);
  const exactEspnPlayers = sanitizeAuthenticatedEspnPlayers(espnPlayers);
  if (canonicalAuthenticatedEspnCaptureJson(league) !== canonicalAuthenticatedEspnCaptureJson(exactLeague)) {
    throw new Error("ESPN_ARTIFACT_LEAGUE_NOT_EXACTLY_SANITIZED");
  }
  if (canonicalAuthenticatedEspnCaptureJson(espnPlayers) !== canonicalAuthenticatedEspnCaptureJson(exactEspnPlayers)) {
    throw new Error("ESPN_ARTIFACT_PLAYERS_NOT_EXACTLY_SANITIZED");
  }
  const capturedAt = profile?.capturedAt;
  const capturedAtMs = typeof capturedAt === "string" ? Date.parse(capturedAt) : Number.NaN;
  if (!Number.isFinite(capturedAtMs) || new Date(capturedAtMs).toISOString() !== capturedAt) {
    throw new Error("ESPN_ARTIFACT_CAPTURED_AT_INVALID");
  }
  const nowMs = typeof now === "number" ? now : Date.parse(String(now || ""));
  if (!Number.isFinite(nowMs)) throw new Error("ESPN_ARTIFACT_EVALUATION_TIME_INVALID");
  if (capturedAtMs > nowMs + AUTHENTICATED_ESPN_CAPTURE_FUTURE_SKEW_MS) {
    throw new Error("ESPN_ARTIFACT_CAPTURED_IN_FUTURE");
  }
  if (nowMs - capturedAtMs > AUTHENTICATED_ESPN_CAPTURE_MAX_AGE_MS) {
    throw new Error("ESPN_ARTIFACT_STALE");
  }

  const proof = profile?.authenticatedEspnCapture;
  if (!isAuthenticatedEspnCaptureProof(proof) || proof.capturedAt !== capturedAt) {
    throw new Error("ESPN_ARTIFACT_AUTH_PROOF_REQUIRED");
  }
  const expectedProfile = buildAuthenticatedEspnCaptureProfile({ league: exactLeague, espnPlayers: exactEspnPlayers, request });
  const profileFieldValid = {
    leagueId: /^\d+$/.test(expectedProfile.leagueId),
    teamId: Number.isSafeInteger(expectedProfile.teamId) && expectedProfile.teamId > 0,
    season: Number.isSafeInteger(expectedProfile.season) && expectedProfile.season >= 2026,
    draftType: ["SNAKE", "AUCTION"].includes(expectedProfile.draftType),
    scoringLabel: ["PPR", "Half PPR", "Standard"].includes(expectedProfile.scoringLabel),
    scoringRules: Number.isSafeInteger(expectedProfile.scoringRules) && expectedProfile.scoringRules >= 0,
    teams: Number.isSafeInteger(expectedProfile.teams) && expectedProfile.teams >= 8 && expectedProfile.teams <= 16,
    rosterSize: Number.isSafeInteger(expectedProfile.rosterSize) && expectedProfile.rosterSize > 0,
    auctionBudget: Number.isSafeInteger(expectedProfile.auctionBudget) && expectedProfile.auctionBudget >= 0,
    qbs: [1, 2].includes(expectedProfile.qbs),
    playerCount: Number.isSafeInteger(expectedProfile.playerCount) && expectedProfile.playerCount > 0,
  };
  const invalidProfileField = Object.entries(profileFieldValid).find(([, valid]) => !valid)?.[0];
  if (invalidProfileField) throw new Error(`ESPN_ARTIFACT_PROFILE_INVALID:${invalidProfileField}`);
  const actualProfile = proof.profile;
  if (!actualProfile || typeof actualProfile !== "object" || Array.isArray(actualProfile)) {
    throw new Error("ESPN_ARTIFACT_PROFILE_PROOF_REQUIRED");
  }
  for (const [field, expected] of Object.entries(expectedProfile)) {
    if (actualProfile[field] !== expected) {
      throw new Error(`ESPN_ARTIFACT_PROFILE_MISMATCH:${field}`);
    }
  }
  if (Object.keys(actualProfile).length !== Object.keys(expectedProfile).length) {
    throw new Error("ESPN_ARTIFACT_PROFILE_MISMATCH:unexpected-field");
  }
  const expectedDigest = await authenticatedEspnCaptureDigest({
    capturedAt,
    league: exactLeague,
    espnPlayers: exactEspnPlayers,
  });
  if (proof.digest !== expectedDigest) throw new Error("ESPN_ARTIFACT_DIGEST_MISMATCH");
  return { capturedAt, league: exactLeague, espnPlayers: exactEspnPlayers, authenticatedProfile: expectedProfile, proof };
}

export function normalizeAuthenticatedEspnCaptureOrigin(value = "http://127.0.0.1:3000") {
  let url;
  try { url = new URL(String(value)); }
  catch { throw new Error("ESPN_CAPTURE_ORIGIN_INVALID"); }
  const hostname = url.hostname.toLowerCase();
  if (url.protocol !== "http:"
    || !["127.0.0.1", "localhost", "[::1]"].includes(hostname)
    || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new Error("ESPN_CAPTURE_ORIGIN_INVALID");
  }
  const port = url.port ? Number(url.port) : 80;
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error("ESPN_CAPTURE_ORIGIN_INVALID");
  return url.origin;
}

export async function consumeAuthenticatedEspnCaptureReceipt(
  proof,
  { origin = "http://127.0.0.1:3000", fetchImpl = fetch } = {},
) {
  const exactOrigin = normalizeAuthenticatedEspnCaptureOrigin(origin);
  const response = await fetchImpl(`${exactOrigin}/api/draft-day`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      operation: "CONSUME_ESPN_CAPTURE_RECEIPT",
      authenticatedEspnCapture: proof,
    }),
  });
  const declaredBytes = Number(response.headers?.get?.("content-length") || 0);
  if (Number.isFinite(declaredBytes) && declaredBytes > 16 * 1024) {
    throw new Error("ESPN_CAPTURE_RECEIPT_RESPONSE_TOO_LARGE");
  }
  const text = await response.text();
  if (new TextEncoder().encode(text).byteLength > 16 * 1024) {
    throw new Error("ESPN_CAPTURE_RECEIPT_RESPONSE_TOO_LARGE");
  }
  let payload;
  try { payload = JSON.parse(text); }
  catch { throw new Error("ESPN_CAPTURE_RECEIPT_RESPONSE_INVALID"); }
  if (!response.ok || payload?.ok !== true || payload?.code !== "ESPN_CAPTURE_RECEIPT_CONSUMED") {
    throw new Error(`ESPN_CAPTURE_RECEIPT_REJECTED:${String(payload?.code || response.status)}`);
  }
  return true;
}

function parseArguments(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const value = argv[index + 1];
    if (["--espn", "--validate", "--output", "--scoring", "--teams", "--season", "--origin"].includes(argument)) {
      if (!value || value.startsWith("--")) throw new Error(`${argument} requires a value`);
      options[argument.slice(2)] = value;
      index += 1;
    } else {
      throw new Error(`unknown argument: ${argument}`);
    }
  }
  if (Boolean(options.espn) === Boolean(options.validate)) {
    throw new Error("provide exactly one of --espn <sanitized-profile.json> or --validate <snapshot.json>");
  }
  if (options.origin !== undefined) normalizeAuthenticatedEspnCaptureOrigin(options.origin);
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
    draftableEspnPlayers: validation.draftableEspnPlayers,
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
    qbs: intelligenceQuarterbackMode(league.lineupSlotCounts),
  });
  const authenticatedCapture = await verifyAuthenticatedEspnCapture(profile, request);
  await consumeAuthenticatedEspnCaptureReceipt(authenticatedCapture.proof, { origin: options.origin });
  const intelligence = await fetchIntelligenceSnapshot(request);
  const snapshot = createSourceSnapshot({
    capturedAt: authenticatedCapture.capturedAt,
    league,
    espnPlayers,
    intelligence,
    provenance: {
      espnCapture: {
        schemaVersion: authenticatedCapture.proof.schemaVersion,
        transport: authenticatedCapture.proof.transport,
        capturedAt: authenticatedCapture.proof.capturedAt,
        digest: authenticatedCapture.proof.digest,
        receiptConsumed: true,
      },
      publicConsensus: {
        sourceSnapshotId: intelligence.sourceSnapshotId,
        generatedAt: intelligence.generatedAt,
        methodology: intelligence.methodology,
      },
    },
  });
  printValidation(snapshot, snapshot.validation);
  if (!snapshot.validation.valid) throw new Error("source snapshot capture failed closed");

  const timestamp = snapshot.capturedAt.replaceAll(":", "-").replace(".000Z", "Z");
  const scoring = request.scoring.toLowerCase().replaceAll(" ", "-");
  const output = resolve(options.output || `snapshots/intelligence/source-v${SOURCE_SNAPSHOT_SCHEMA_VERSION}-${timestamp}-${scoring}-${request.teams}t-${snapshot.digest.slice(0, 12)}.json`);
  const current = evaluateCurrentSourceSnapshot(snapshot, { now: Date.now() });
  if (!current.current) throw new Error(`SOURCE_SNAPSHOT_NOT_CURRENT_AFTER_FETCH:${current.blocker}`);
  if (snapshot.digest !== current.snapshotDigest) throw new Error("SOURCE_SNAPSHOT_DIGEST_CHANGED_BEFORE_WRITE");
  const outputDirectory = dirname(output);
  mkdirSync(outputDirectory, { recursive: true });
  const temporary = resolve(outputDirectory, `.${basename(output)}.${process.pid}.tmp`);
  try {
    writeFileSync(temporary, `${JSON.stringify(snapshot, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    renameSync(temporary, output);
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary);
  }
  process.stdout.write(`Snapshot: ${output}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack || error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
