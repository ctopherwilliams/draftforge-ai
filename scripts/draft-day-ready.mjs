#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { evaluateDraftDayReadiness } from "../app/lib/draft-day-readiness.ts";
import {
  isDraftDaySourceSnapshotFresh,
  isDraftDaySourceSnapshotId,
} from "../app/lib/draft-day-doctor.ts";
import { intelligenceQuarterbackMode } from "../app/lib/consensus.ts";
import { parseDraftDayReadyArguments } from "./draft-day-cli-lib.mjs";

let cli;
try {
  cli = parseDraftDayReadyArguments(process.argv.slice(2));
} catch (error) {
  console.error(JSON.stringify({
    ok: false,
    code: "USAGE",
    message: error instanceof Error ? error.message : String(error),
  }));
  process.exit(2);
}
const { format, phase, origin, maxAgeMs } = cli;
if (!new Set(["snake", "salary-cap"]).has(format) || !new Set(["pre-room", "live", "complete"]).has(phase)) {
  console.error(JSON.stringify({ ok: false, code: "USAGE", usage: "npm run draft-day:ready -- --format snake|salary-cap [--phase pre-room|live|complete]" }));
  process.exit(2);
}
const config = JSON.parse(readFileSync(resolve("config/authenticated-espn-leagues.json"), "utf8"));
const expected = config?.profiles?.[format];
if (!expected) {
  console.error(JSON.stringify({ ok: false, code: "PROFILE_NOT_FOUND", format }));
  process.exit(2);
}

let warm;
try {
  const response = await fetch(`${origin}/api/draft-day`, {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify({
      operation: "WARM",
      profile: {
        scoring: expected.scoringLabel,
        teams: expected.size,
        season: expected.season,
        qbs: intelligenceQuarterbackMode(expected.lineupSlotCounts),
      },
    }),
    signal: AbortSignal.timeout(45_000),
  });
  warm = await response.json();
  if (!response.ok || warm?.code !== "FIVE_SOURCE_READY") throw new Error(warm?.code || `HTTP_${response.status}`);
} catch (error) {
  const sources = Array.isArray(warm?.sources)
    ? warm.sources.map((source) => ({
        id: String(source?.id || ""),
        status: String(source?.status || "error"),
        players: Number.isSafeInteger(Number(source?.players)) ? Number(source.players) : 0,
        error: source?.error ? String(source.error) : null,
      }))
    : [];
  console.error(JSON.stringify({
    ok: false,
    code: "SOURCE_WARMUP_FAILED",
    format,
    message: error instanceof Error ? error.message : String(error),
    sourceCoverage: Number(warm?.sourceCoverage || 0),
    sources,
  }));
  process.exit(1);
}

const qbs = intelligenceQuarterbackMode(expected.lineupSlotCounts);
async function fetchActiveAudit() {
  const response = await fetch(`${origin}/api/draft-day?leagueId=${encodeURIComponent(expected.id)}&teamId=${expected.teamId}`, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(10_000),
  });
  const body = await response.json();
  if (!response.ok || body?.ok !== true) throw new Error(body?.code || `HTTP_${response.status}`);
  return body;
}

let audit;
try {
  audit = await fetchActiveAudit();
} catch (error) {
  console.error(JSON.stringify({ ok: false, code: "AUDIT_UNAVAILABLE", format, message: error instanceof Error ? error.message : String(error), sourceCoverage: warm?.sourceCoverage || 0 }));
  process.exit(1);
}

const expectedSourceSnapshotId = audit?.snapshot?.safety?.sourceSnapshotId;
const expectedSourceGeneratedAt = audit?.snapshot?.safety?.sourceSnapshotGeneratedAt;
if (!isDraftDaySourceSnapshotId(expectedSourceSnapshotId)
  || !isDraftDaySourceSnapshotFresh(expectedSourceGeneratedAt)) {
  console.error(JSON.stringify({
    ok: false,
    code: "SOURCE_AUDIT_IDENTITY_INVALID",
    format,
    sourceCoverage: Number(audit?.snapshot?.safety?.sourceCoverage || 0),
    message: "Active audit does not carry a fresh canonical source snapshot lease.",
  }));
  process.exit(1);
}

let exactWarm;
try {
  const response = await fetch(`${origin}/api/draft-day`, {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify({
      operation: "WARM",
      profile: {
        scoring: expected.scoringLabel,
        teams: expected.size,
        season: expected.season,
        qbs,
      },
      expectedSourceSnapshotId,
      expectedSourceGeneratedAt,
    }),
    signal: AbortSignal.timeout(10_000),
  });
  exactWarm = await response.json();
  const exactProfile = exactWarm?.profile?.scoring === expected.scoringLabel
    && Number(exactWarm?.profile?.teams) === Number(expected.size)
    && Number(exactWarm?.profile?.season) === Number(expected.season)
    && Number(exactWarm?.profile?.qbs) === qbs;
  if (!response.ok
    || exactWarm?.code !== "FIVE_SOURCE_READY"
    || Number(exactWarm?.sourceCoverage) !== 5
    || exactWarm?.sourceSnapshotId !== expectedSourceSnapshotId
    || exactWarm?.sourceGeneratedAt !== expectedSourceGeneratedAt
    || !exactProfile) {
    throw new Error(exactWarm?.code || `HTTP_${response.status}`);
  }
} catch (error) {
  console.error(JSON.stringify({
    ok: false,
    code: "SOURCE_IDENTITY_RECHECK_FAILED",
    format,
    message: error instanceof Error ? error.message : String(error),
    sourceCoverage: Number(exactWarm?.sourceCoverage || 0),
  }));
  process.exit(1);
}

try {
  audit = await fetchActiveAudit();
} catch (error) {
  console.error(JSON.stringify({ ok: false, code: "AUDIT_RECHECK_UNAVAILABLE", format, message: error instanceof Error ? error.message : String(error), sourceCoverage: 5 }));
  process.exit(1);
}
const reboundSourceSnapshotId = audit?.snapshot?.safety?.sourceSnapshotId;
const reboundSourceGeneratedAt = audit?.snapshot?.safety?.sourceSnapshotGeneratedAt;
if (reboundSourceSnapshotId !== expectedSourceSnapshotId
  || reboundSourceGeneratedAt !== expectedSourceGeneratedAt
  || !isDraftDaySourceSnapshotId(reboundSourceSnapshotId)
  || !isDraftDaySourceSnapshotFresh(reboundSourceGeneratedAt)) {
  console.error(JSON.stringify({
    ok: false,
    code: "SOURCE_AUDIT_IDENTITY_CHANGED",
    format,
    sourceCoverage: Number(audit?.snapshot?.safety?.sourceCoverage || 0),
    message: "Active audit source identity changed during the readiness gate.",
  }));
  process.exit(1);
}

const result = evaluateDraftDayReadiness({ snapshot: audit.snapshot, expected, phase, maxAgeMs });
console.log(JSON.stringify({
  ok: result.ready,
  code: result.ready ? "DRAFT_DAY_READY" : "DRAFT_DAY_LOCKED",
  format,
  phase,
  sourceCoverage: exactWarm.sourceCoverage,
  sourceSnapshotId: expectedSourceSnapshotId,
  sourceGeneratedAt: expectedSourceGeneratedAt,
  ageMs: result.ageMs,
  blockers: result.blockers,
  checks: result.checks,
  telemetry: {
    actionCount: audit.snapshot.telemetry.actions.length,
    lastActionRoundTripMs: audit.snapshot.telemetry.actions.at(-1)?.roundTripMs ?? null,
  },
  sleeperEvidence: audit.snapshot.sleeperEvidence,
}, null, 2));
process.exit(result.ready ? 0 : 1);
