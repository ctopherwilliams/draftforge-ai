#!/usr/bin/env node

import { createHash } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { evaluateDraftDayDoctor, resolveDraftDayDoctorLeague } from "../app/lib/draft-day-doctor.ts";

const args = process.argv.slice(2);
const valueFor = (name, fallback = "") => {
  const index = args.indexOf(name);
  return index >= 0 ? String(args[index + 1] || fallback) : fallback;
};
const format = valueFor("--format");
const phase = valueFor("--phase", "pre-room");
const origin = valueFor("--origin", "http://127.0.0.1:3000").replace(/\/$/, "");
const startServer = !args.includes("--no-start-server");
const startedAt = Date.now();

if (!new Set(["snake", "salary-cap"]).has(format) || !new Set(["pre-room", "live", "complete"]).has(phase)) {
  console.error(JSON.stringify({ ok: false, code: "USAGE", usage: "npm run draft-day:doctor -- --format snake|salary-cap [--phase pre-room|live|complete] [--league PRACTICE_ROOM_ID --team TEAM_ID --timer SECONDS] [--no-start-server]" }));
  process.exit(2);
}

const leagueConfig = JSON.parse(readFileSync(resolve("config/authenticated-espn-leagues.json"), "utf8"));
const releaseConfig = JSON.parse(readFileSync(resolve("config/draft-day-release.json"), "utf8"));
const profile = leagueConfig?.profiles?.[format];
if (!profile) {
  console.error(JSON.stringify({ ok: false, code: "PROFILE_NOT_FOUND", format }));
  process.exit(2);
}
let expected;
try {
  const roomTeam = valueFor("--team");
  const roomTimer = valueFor("--timer");
  expected = resolveDraftDayDoctorLeague(
    profile,
    valueFor("--league") || undefined,
    roomTeam ? Number(roomTeam) : undefined,
    roomTimer ? Number(roomTimer) : undefined,
  );
} catch (error) {
  console.error(JSON.stringify({ ok: false, code: error instanceof Error ? error.message : "DRAFT_DAY_ROOM_IDENTITY_INVALID" }));
  process.exit(2);
}

function command(commandName, commandArgs = []) {
  return execFileSync(commandName, commandArgs, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function listenerPids() {
  try {
    return [...new Set(command("/usr/sbin/lsof", ["-nP", "-iTCP:3000", "-sTCP:LISTEN", "-t"])
      .split(/\s+/)
      .map(Number)
      .filter(Number.isInteger))];
  } catch {
    return [];
  }
}

async function waitForDashboard() {
  const deadline = Date.now() + 10_000;
  let lastError = "dashboard did not respond";
  do {
    try {
      const response = await fetch(`${origin}/`, { headers: { Accept: "text/html" }, signal: AbortSignal.timeout(2_000) });
      if (response.ok) return response.text();
      lastError = `dashboard returned HTTP ${response.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 200));
  } while (Date.now() < deadline);
  throw new Error(lastError);
}

if (!listenerPids().length && startServer) {
  const child = spawn("npm", ["run", "start"], { cwd: process.cwd(), detached: true, stdio: "ignore" });
  child.unref();
}

let dashboardHtml;
let serverReadyMs;
try {
  dashboardHtml = await waitForDashboard();
  serverReadyMs = Date.now() - startedAt;
} catch (error) {
  console.error(JSON.stringify({ ok: false, code: "DRAFT_DAY_DOCTOR_LOCKED", blockers: ["serverUnavailable"], message: error instanceof Error ? error.message : String(error) }, null, 2));
  process.exit(1);
}

const scriptPaths = [...dashboardHtml.matchAll(/<script[^>]+src="([^"]+)"/g)]
  .map((match) => match[1])
  .filter((path) => path.includes("/_next/static/chunks/"));
if (!scriptPaths.length) {
  console.error(JSON.stringify({ ok: false, code: "DRAFT_DAY_DOCTOR_LOCKED", blockers: ["productionClientBundleMissing"] }, null, 2));
  process.exit(1);
}

const warmStartedAt = Date.now();
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
  console.error(JSON.stringify({ ok: false, code: "DRAFT_DAY_DOCTOR_LOCKED", blockers: ["sourceWarmFailed"], message: error instanceof Error ? error.message : String(error) }, null, 2));
  process.exit(1);
}
const sourceWarmMs = Date.now() - warmStartedAt;

let audit;
try {
  const response = await fetch(`${origin}/api/draft-day?leagueId=${encodeURIComponent(expected.id)}&teamId=${expected.teamId}`, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(10_000),
  });
  audit = await response.json();
  if (!response.ok || audit?.ok !== true) throw new Error(audit?.code || `HTTP_${response.status}`);
} catch (error) {
  console.error(JSON.stringify({ ok: false, code: "DRAFT_DAY_DOCTOR_LOCKED", blockers: ["auditUnavailable"], message: error instanceof Error ? error.message : String(error) }, null, 2));
  process.exit(1);
}

const manifest = JSON.parse(readFileSync(resolve("extension/manifest.json"), "utf8"));
const extensionPackageSha256 = createHash("sha256")
  .update(readFileSync(resolve("public/draftforge-espn-companion.zip")))
  .digest("hex");
let gitClean = false;
let headMatchesRemote = false;
let head = "";
try {
  head = command("git", ["rev-parse", "HEAD"]);
  gitClean = command("git", ["status", "--porcelain"]) === "";
  headMatchesRemote = head === command("git", ["rev-parse", "@{upstream}"]);
} catch { /* fail closed below */ }

const result = evaluateDraftDayDoctor({
  snapshot: audit.snapshot,
  expected,
  phase,
  system: {
    gitClean,
    headMatchesRemote,
    serverListenerCount: listenerPids().length,
    serverReadyMs,
    sourceWarmMs,
    totalCheckMs: Date.now() - startedAt,
    manifestVersion: String(manifest.version || ""),
    expectedExtensionVersion: String(releaseConfig.extensionVersion || ""),
    extensionPackageSha256,
    expectedExtensionPackageSha256: String(releaseConfig.extensionPackageSha256 || ""),
  },
});

console.log(JSON.stringify({
  ok: result.ready,
  code: result.ready ? "DRAFT_DAY_DOCTOR_READY" : "DRAFT_DAY_DOCTOR_LOCKED",
  format,
  phase,
  leagueId: expected.id,
  teamId: expected.teamId,
  revision: head,
  sourceCoverage: warm.sourceCoverage,
  timing: { serverReadyMs, sourceWarmMs, totalCheckMs: Date.now() - startedAt },
  runtime: audit.snapshot.runtime,
  blockers: result.blockers,
  checks: result.checks,
}, null, 2));
process.exit(result.ready ? 0 : 1);
