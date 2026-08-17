const args = process.argv.slice(2);

function value(name, fallback) {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : fallback;
}

const scoring = value("scoring", "PPR");
const teams = Math.max(8, Math.min(16, Number(value("teams", "12"))));
const season = Math.max(2026, Number(value("season", "2026")));
const origin = value("origin", "http://127.0.0.1:3000");
const url = `${origin}/api/draft-day`;
const started = Date.now();

async function verifyDashboardRuntime() {
  const dashboardResponse = await fetch(`${origin}/`, {
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
    const scriptResponse = await fetch(new URL(path, origin), { signal: AbortSignal.timeout(10_000) });
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
    body: JSON.stringify({ operation: "WARM", profile: { scoring, teams, season } }),
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
const sources = (snapshot.sources || []).map((source) => ({
  id: source.id,
  status: source.status,
  players: Array.isArray(source.players) ? source.players.length : Number(source.players || 0),
  error: source.error || null,
}));
const ready = sources.length === 4 && sources.every((source) => source.status === "ok" && source.players > 0);
const result = {
  ok: ready,
  code: ready ? "FIVE_SOURCE_READY" : "FIVE_SOURCE_SNAPSHOT_NOT_READY",
  sourceCoverage: ready ? 5 : 1,
  scoring,
  teams,
  season,
  elapsedMs: Date.now() - started,
  dashboardScripts,
  generatedAt: snapshot.sourceGeneratedAt || snapshot.generatedAt || null,
  sources,
};
console.log(JSON.stringify(result));
process.exit(ready ? 0 : 1);
