import {
  draftDaySourceSnapshotAgeMs,
  isDraftDaySourceSnapshotFresh,
  isDraftDaySourceSnapshotId,
} from "../app/lib/draft-day-doctor.ts";

const args = process.argv.slice(2);
const allowedArguments = new Set(["--scoring", "--teams", "--season", "--qbs", "--origin"]);
const parsedArguments = new Map();

for (let index = 0; index < args.length; index += 2) {
  const argument = args[index];
  const argumentValue = args[index + 1];
  if (!allowedArguments.has(argument)) {
    console.error(JSON.stringify({ ok: false, code: "UNKNOWN_ARGUMENT", argument }));
    process.exit(2);
  }
  if (!argumentValue || argumentValue.startsWith("--")) {
    console.error(JSON.stringify({ ok: false, code: "ARGUMENT_VALUE_REQUIRED", argument }));
    process.exit(2);
  }
  if (parsedArguments.has(argument)) {
    console.error(JSON.stringify({ ok: false, code: "DUPLICATE_ARGUMENT", argument }));
    process.exit(2);
  }
  parsedArguments.set(argument, argumentValue);
}

function value(name, fallback) {
  return parsedArguments.get(`--${name}`) ?? fallback;
}

const scoring = String(value("scoring", "PPR")).trim();
const teams = Number(value("teams", "12"));
const season = Number(value("season", "2026"));
const qbs = Number(value("qbs", "1"));
if (!["PPR", "Half PPR", "Standard"].includes(scoring)
  || !Number.isSafeInteger(teams) || teams < 8 || teams > 16
  || !Number.isSafeInteger(season) || season < 2026 || season > 2100
  || ![1, 2].includes(qbs)) {
  console.error(JSON.stringify({ ok: false, code: "PROFILE_ARGUMENT_INVALID" }));
  process.exit(2);
}
const origin = value("origin", "http://127.0.0.1:3000");
let parsedOrigin;
try {
  parsedOrigin = new URL(origin);
} catch {
  parsedOrigin = null;
}
if (!parsedOrigin || parsedOrigin.protocol !== "http:"
  || !new Set(["127.0.0.1", "localhost", "[::1]"]).has(parsedOrigin.hostname)
  || parsedOrigin.username || parsedOrigin.password || !["", "/"].includes(parsedOrigin.pathname)
  || parsedOrigin.search || parsedOrigin.hash) {
  console.error(JSON.stringify({ ok: false, code: "ORIGIN_MUST_BE_LOOPBACK_HTTP" }));
  process.exit(2);
}
const canonicalOrigin = parsedOrigin.origin;
const url = `${canonicalOrigin}/api/draft-day`;
const started = Date.now();

async function verifyDashboardRuntime() {
  const dashboardResponse = await fetch(`${canonicalOrigin}/`, {
    headers: { Accept: "text/html" },
    signal: AbortSignal.timeout(10_000),
  });
  if (!dashboardResponse.ok) throw new Error(`dashboard returned HTTP ${dashboardResponse.status}`);
  const html = await dashboardResponse.text();
  const scriptPaths = [...html.matchAll(/<script[^>]+src="([^"]+)"/g)]
    .map((match) => match[1])
    .filter((path) => path.includes("/_next/static/chunks/"));
  const uniqueScripts = [...new Set(scriptPaths)];
  if (!uniqueScripts.length) throw new Error("dashboard did not declare a client runtime bundle");
  for (const path of uniqueScripts) {
    const scriptResponse = await fetch(new URL(path, canonicalOrigin), { signal: AbortSignal.timeout(10_000) });
    if (!scriptResponse.ok) throw new Error(`${path} returned HTTP ${scriptResponse.status}`);
    const body = await scriptResponse.text();
    if (body.length < 100) throw new Error(`${path} returned an empty client bundle`);
  }
  return uniqueScripts.length;
}

let dashboardScripts;
try {
  dashboardScripts = await verifyDashboardRuntime();
} catch (error) {
  console.error(JSON.stringify({ ok: false, code: "DASHBOARD_RUNTIME_NOT_READY", message: String(error) }));
  process.exit(1);
}

let response;
try {
  response = await fetch(url, {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify({ operation: "WARM", profile: { scoring, teams, season, qbs } }),
    signal: AbortSignal.timeout(45_000),
  });
} catch (error) {
  console.error(JSON.stringify({ ok: false, code: "DRAFTFORGE_SERVER_UNREACHABLE", message: String(error) }));
  process.exit(1);
}
if (!response.ok) {
  console.error(JSON.stringify({ ok: false, code: `DRAFTFORGE_HTTP_${response.status}`, url }));
  process.exit(1);
}
const snapshot = await response.json();
const exactProfile = snapshot?.profile?.scoring === scoring
  && Number(snapshot?.profile?.teams) === teams
  && Number(snapshot?.profile?.season) === season
  && Number(snapshot?.profile?.qbs) === qbs;
const sources = (snapshot.sources || []).map((source) => ({
  id: source.id,
  status: source.status,
  players: Array.isArray(source.players) ? source.players.length : Number(source.players || 0),
  error: source.error || null,
}));
const sourceSetReady = sources.length === 4
  && sources.every((source) => source.status === "ok" && source.players > 0);
const sourceSnapshotId = typeof snapshot?.sourceSnapshotId === "string"
  ? snapshot.sourceSnapshotId
  : "";
const sourceGeneratedAt = typeof snapshot?.sourceGeneratedAt === "string"
  ? snapshot.sourceGeneratedAt
  : "";
const sourceSnapshotIdentityReady = isDraftDaySourceSnapshotId(sourceSnapshotId);
const sourceSnapshotAgeMs = draftDaySourceSnapshotAgeMs(sourceGeneratedAt);
const sourceSnapshotTimestampReady = Number.isFinite(sourceSnapshotAgeMs);
const sourceSnapshotFresh = isDraftDaySourceSnapshotFresh(sourceGeneratedAt);
const ready = exactProfile
  && sourceSetReady
  && sourceSnapshotIdentityReady
  && sourceSnapshotFresh;
const code = !exactProfile
  ? "SOURCE_PROFILE_MISMATCH"
  : !sourceSetReady
    ? "FIVE_SOURCE_SNAPSHOT_NOT_READY"
    : !sourceSnapshotIdentityReady
      ? "SOURCE_SNAPSHOT_IDENTITY_INVALID"
      : !sourceSnapshotTimestampReady
        ? "SOURCE_SNAPSHOT_TIMESTAMP_INVALID"
        : !sourceSnapshotFresh
          ? "SOURCE_SNAPSHOT_STALE"
          : "FIVE_SOURCE_READY";
const result = {
  ok: ready,
  code,
  sourceCoverage: sourceSetReady ? 5 : 1,
  sourceSnapshotId: sourceSnapshotIdentityReady ? sourceSnapshotId : null,
  sourceGeneratedAt: sourceSnapshotTimestampReady ? sourceGeneratedAt : null,
  sourceSnapshotAgeMs: sourceSnapshotTimestampReady ? sourceSnapshotAgeMs : null,
  scoring,
  teams,
  season,
  qbs,
  elapsedMs: Date.now() - started,
  dashboardScripts,
  generatedAt: sourceSnapshotTimestampReady ? sourceGeneratedAt : null,
  sources,
};
console.log(JSON.stringify(result));
process.exit(ready ? 0 : 1);
