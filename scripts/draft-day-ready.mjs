#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { evaluateDraftDayReadiness } from "../app/lib/draft-day-readiness.ts";

const args = process.argv.slice(2);
const valueFor = (name, fallback = "") => {
  const index = args.indexOf(name);
  return index >= 0 ? String(args[index + 1] || fallback) : fallback;
};
const format = valueFor("--format");
const phase = valueFor("--phase", "pre-room");
const origin = valueFor("--origin", "http://127.0.0.1:3000").replace(/\/$/, "");
const maxAgeMs = Number(valueFor("--max-age-ms", "15000"));
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
    body: JSON.stringify({ operation: "WARM", profile: { scoring: expected.scoringLabel, teams: expected.size, season: expected.season } }),
    signal: AbortSignal.timeout(45_000),
  });
  warm = await response.json();
  if (!response.ok || warm?.code !== "FIVE_SOURCE_READY") throw new Error(warm?.code || `HTTP_${response.status}`);
} catch (error) {
  console.error(JSON.stringify({ ok: false, code: "SOURCE_WARMUP_FAILED", format, message: error instanceof Error ? error.message : String(error) }));
  process.exit(1);
}

let audit;
try {
  const response = await fetch(`${origin}/api/draft-day?leagueId=${encodeURIComponent(expected.id)}&teamId=${expected.teamId}`, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(10_000),
  });
  audit = await response.json();
  if (!response.ok || audit?.ok !== true) throw new Error(audit?.code || `HTTP_${response.status}`);
} catch (error) {
  console.error(JSON.stringify({ ok: false, code: "AUDIT_UNAVAILABLE", format, message: error instanceof Error ? error.message : String(error), sourceCoverage: warm?.sourceCoverage || 0 }));
  process.exit(1);
}

const result = evaluateDraftDayReadiness({ snapshot: audit.snapshot, expected, phase, maxAgeMs });
console.log(JSON.stringify({
  ok: result.ready,
  code: result.ready ? "DRAFT_DAY_READY" : "DRAFT_DAY_LOCKED",
  format,
  phase,
  sourceCoverage: warm.sourceCoverage,
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
